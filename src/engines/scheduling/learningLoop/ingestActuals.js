// C:\Users\larho\suka-smart-assistant\src\engines\scheduling\learningLoop\ingestActuals.js
/**
 * SSA Scheduling Learning Loop — Ingest Actuals
 * ---------------------------------------------
 * Purpose:
 *   Persist completed step actuals (time, conditions, outcomes) from executed sessions
 *   and update lightweight aggregates for future planning/estimation.
 *
 * How it fits the SSA pipeline:
 *   imports → intelligence → automation → (optional) hub export
 *   - imports produce normalized plans/sessions with planned durations
 *   - intelligence annotates with prep/setup/cleanup, user prefs, resources
 *   - automation runs the session; when it completes, this module ingests "actuals"
 *   - (optional) hub export mirrors anonymized learning signals to SVFFH when enabled
 *
 * Side-effects:
 *   - Writes rows to local data store (Dexie/SQLite/etc. via dataGateway)
 *   - Updates rolling aggregates per (domain, taskType, equipment)
 *   - Emits eventBus messages with consistent shape: { type, ts, source, data }
 *   - Optionally exports a Hub packet if familyFundMode is on
 *
 * Forward-thinking:
 *   - Domain feature extractors registry to derive taskType keys for aggregation
 *   - Pluggable smoothing strategy (EWMA by default; hooks for quantiles/outlier clipping)
 *   - Storage adapter is abstracted via dataGateway; supports upsert semantics
 */

let eventBus = {
  emit: (...a) =>
    console.debug("[learningLoop:ingestActuals:eventBus.emit]", ...a),
  on: () => () => {},
};
try {
  const eb = require("@/services/events/eventBus");
  eventBus = eb?.default || eb?.eventBus || eventBus;
} catch {
  /* noop for build/tests */
}

let featureFlags = {
  familyFundMode: false,
  learning: { ewmaAlpha: 0.3, outlierIQR: true },
};
try {
  const ff = require("@/config/featureFlags");
  featureFlags = ff?.default || ff || featureFlags;
} catch {
  /* noop */
}

let dataGateway;
try {
  dataGateway = require("@/services/dataGateway");
} catch {
  /* noop; will be validated later */
}

let HubPacketFormatter, FamilyFundConnector;
try {
  HubPacketFormatter = require("@/services/hub/HubPacketFormatter");
  FamilyFundConnector = require("@/services/hub/FamilyFundConnector");
} catch {
  /* optional hub layer */
}

/* ---------------------------------- Types ---------------------------------- */
/**
 * @typedef {Object} StepActual
 * @property {string} stepId
 * @property {string} [taskType]                    // if omitted, derived by feature extractor
 * @property {number} [plannedMinutes]
 * @property {number} [actualMinutes]               // optional if start/end provided
 * @property {string} [startISO]
 * @property {string} [endISO]
 * @property {string[]} [equipmentUsed]             // e.g., ["range.top","pressure.canner"]
 * @property {string[]} [resourcesUsed]             // named locks/resources
 * @property {{ ambientTemp?:number, humidity?:number, weather?:string, note?:string }} [conditions]
 * @property {{ success?:boolean, qualityScore?:number, anomalies?:string[] }} [outcome]
 * @property {string} [actorId]                     // user/operator
 */

/**
 * @typedef {Object} IngestContext
 * @property {string} sessionId
 * @property {("cooking"|"cleaning"|"garden"|"animal"|"preservation"|"storehouse")} domain
 * @property {string} [householdId]
 * @property {string} [recipeId]                    // for cooking
 * @property {string} [taskId]                      // for non-cooking
 * @property {Object}  [meta]                       // free-form metadata (version, app build, etc.)
 */

/* --------------------------------- Exports --------------------------------- */
module.exports = {
  /**
   * Ingest one or more step actuals for a completed/partial session.
   * Writes step rows, updates aggregates, emits events, and optionally exports to Hub.
   *
   * @param {StepActual[]|StepActual} stepActuals
   * @param {IngestContext} ctx
   * @returns {Promise<{ storedCount:number, sessionSummary:object, aggregates:Array<object> }>}
   */
  async ingestActuals(stepActuals, ctx) {
    const ts = new Date().toISOString();
    const source = "engines.scheduling.learningLoop.ingestActuals";

    try {
      // Normalize and validate inputs
      const { safeCtx, items, warnings } = normalizeInputs(stepActuals, ctx);
      if (!items.length) {
        const reason = "no-valid-actuals";
        emit("scheduling.actuals.error", source, {
          sessionId: safeCtx.sessionId,
          domain: safeCtx.domain,
          reason,
          warnings,
        });
        return { storedCount: 0, sessionSummary: {}, aggregates: [] };
      }
      if (!dataGateway) throw new Error("dataGateway not available");

      // Derive taskType & canonical fields per item
      const enriched = items.map((it) => enrichActual(it, safeCtx));

      // Optional: filter outliers (defensive; configurable)
      const filtered = featureFlags?.learning?.outlierIQR
        ? iqrTrim(enriched, "actualMinutes")
        : enriched;

      // Persist step rows (upsert by compound key)
      const storedCount = await upsertMany("actuals.steps", filtered, [
        "sessionId",
        "stepId",
      ]);

      // Compute session-level summary
      const sessionSummary = buildSessionSummary(filtered, safeCtx);

      // Persist/merge session summary
      await upsertMany("actuals.sessions", [sessionSummary], ["sessionId"]);

      // Update aggregates (EWMA per (domain, taskType, equipmentSignature))
      const aggregates = await updateAggregates(filtered, safeCtx);

      // Emit success event
      emit("scheduling.actuals.ingested", source, {
        sessionId: safeCtx.sessionId,
        domain: safeCtx.domain,
        storedCount,
        warnings,
        summary: pick(sessionSummary, [
          "totalPlannedMin",
          "totalActualMin",
          "deltaMin",
          "qualityMean",
          "successRate",
        ]),
        aggregatesPreview: aggregates.slice(0, 3),
      });

      // Optional Hub export (anonymized/rolled-up)
      await exportToHubIfEnabled({
        type: "learning.actuals",
        ts,
        source,
        data: {
          domain: safeCtx.domain,
          sessionId: safeCtx.sessionId,
          householdId: safeCtx.householdId || null,
          aggregates, // safe, statistical
          summary: pick(sessionSummary, [
            "totalActualMin",
            "deltaMin",
            "qualityMean",
            "successRate",
          ]),
          meta: { version: "1.0.0", ...safeCtx.meta },
        },
      });

      return { storedCount, sessionSummary, aggregates };
    } catch (err) {
      emit("scheduling.actuals.error", source, {
        sessionId: ctx?.sessionId || null,
        domain: ctx?.domain || null,
        reason: `exception:${err?.message || "unknown"}`,
      });
      return { storedCount: 0, sessionSummary: {}, aggregates: [] };
    }
  },
};

/* ------------------------------- Normalization ------------------------------ */

function normalizeInputs(stepActuals, ctx) {
  const safeCtx = {
    sessionId: String(ctx?.sessionId || "").trim(),
    domain: String(ctx?.domain || ""),
    householdId: ctx?.householdId || null,
    recipeId: ctx?.recipeId || null,
    taskId: ctx?.taskId || null,
    meta: ctx?.meta || {},
  };

  const warnings = [];
  const arr = Array.isArray(stepActuals) ? stepActuals : [stepActuals];
  const items = [];

  for (const raw of arr) {
    if (!raw || typeof raw !== "object") {
      warnings.push("skip:bad-item");
      continue;
    }
    const base = { ...raw };

    // Defensive: parse and compute times
    const start = parseISOorNull(base.startISO);
    const end = parseISOorNull(base.endISO);
    const derivedMinutes =
      start && end && end > start ? Math.round((end - start) / 60000) : null;
    const actualMinutes = toNonNegInt(base.actualMinutes ?? derivedMinutes);
    const plannedMinutes = toNonNegInt(base.plannedMinutes ?? 0);

    if (!base.stepId || !Number.isFinite(actualMinutes)) {
      warnings.push(`skip:invalid-step:${base.stepId || "unknown"}`);
      continue;
    }

    items.push({
      stepId: String(base.stepId),
      taskType: base.taskType || null,
      plannedMinutes,
      actualMinutes,
      startISO: start ? start.toISOString() : null,
      endISO: end ? end.toISOString() : null,
      equipmentUsed: Array.isArray(base.equipmentUsed)
        ? base.equipmentUsed.filter(Boolean)
        : [],
      resourcesUsed: Array.isArray(base.resourcesUsed)
        ? base.resourcesUsed.filter(Boolean)
        : [],
      conditions: sanitizeConditions(base.conditions),
      outcome: sanitizeOutcome(base.outcome),
      actorId: base.actorId || null,
      sessionId: safeCtx.sessionId,
      domain: safeCtx.domain,
      recipeId: safeCtx.recipeId || null,
      taskId: safeCtx.taskId || null,
      tsIngested: new Date().toISOString(),
    });
  }

  if (!safeCtx.sessionId) warnings.push("missing-sessionId");
  if (!safeCtx.domain) warnings.push("missing-domain");

  return { safeCtx, items, warnings };
}

function sanitizeConditions(c) {
  const out = {};
  if (!c || typeof c !== "object") return out;
  if (isFinite(c.ambientTemp)) out.ambientTemp = Number(c.ambientTemp);
  if (isFinite(c.humidity)) out.humidity = Number(c.humidity);
  if (typeof c.weather === "string") out.weather = c.weather.slice(0, 64);
  if (typeof c.note === "string") out.note = c.note.slice(0, 280);
  return out;
}
function sanitizeOutcome(o) {
  const out = {};
  if (!o || typeof o !== "object") return out;
  if (typeof o.success === "boolean") out.success = o.success;
  if (isFinite(o.qualityScore))
    out.qualityScore = clamp(Number(o.qualityScore), 0, 1);
  if (Array.isArray(o.anomalies))
    out.anomalies = o.anomalies.filter(Boolean).slice(0, 12);
  return out;
}

/* ------------------------------ Enrichment --------------------------------- */

function enrichActual(item, ctx) {
  // Derive a canonical taskType via extractor if missing
  const taskType = item.taskType || extractTaskType(ctx.domain, item);

  // Equipment signature used for bucketing
  const equipmentSig =
    item.equipmentUsed && item.equipmentUsed.length
      ? item.equipmentUsed.slice().sort().join("|")
      : "none";

  const deltaMinutes = Number.isFinite(item.plannedMinutes)
    ? item.actualMinutes - item.plannedMinutes
    : null;

  return {
    ...item,
    taskType,
    equipmentSig,
    deltaMinutes,
  };
}

/* ------------------------------ Aggregations ------------------------------- */

/**
 * Update rolling aggregates for each (domain, taskType, equipmentSig).
 * - EWMA for duration
 * - Success rate (Welford)
 * - Quality mean (Welford)
 * Persists rows into "learning.aggregates" with upsert by (domain,taskType,equipmentSig).
 */
async function updateAggregates(rows, ctx) {
  if (!rows.length) return [];
  const alpha = clamp(
    Number(featureFlags?.learning?.ewmaAlpha ?? 0.3),
    0.01,
    0.95
  );

  // Group by bucket key
  const buckets = new Map();
  for (const r of rows) {
    const key = `${r.domain}::${r.taskType}::${r.equipmentSig}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(r);
  }

  const aggregates = [];
  for (const [key, group] of buckets.entries()) {
    const [domain, taskType, equipmentSig] = key.split("::");

    // Load existing aggregate if present
    const existing =
      (await getOne("learning.aggregates", {
        domain,
        taskType,
        equipmentSig,
      })) || {};

    // Start with existing stats
    let ewma = isFinite(existing.ewmaMinutes)
      ? Number(existing.ewmaMinutes)
      : null;
    let n = toNonNegInt(existing.n || 0);
    let successN = toNonNegInt(existing.successN || 0);
    let qualityMean = isFinite(existing.qualityMean)
      ? Number(existing.qualityMean)
      : 0;

    // Update with each observation
    for (const obs of group) {
      const x = obs.actualMinutes;
      if (Number.isFinite(x)) {
        ewma = ewma == null ? x : alpha * x + (1 - alpha) * ewma;
      }
      // Success rate as running tally
      if (obs?.outcome?.success === true) successN += 1;
      n += 1;
      // Quality mean (simple running mean; keep bounded)
      if (isFinite(obs?.outcome?.qualityScore)) {
        qualityMean =
          (qualityMean * (n - 1) + clamp(obs.outcome.qualityScore, 0, 1)) / n;
      }
    }

    const aggRow = {
      domain,
      taskType,
      equipmentSig,
      ewmaMinutes: Math.round(ewma ?? 0),
      n,
      successN,
      successRate: n ? +(successN / n).toFixed(3) : 0,
      qualityMean: +clamp(qualityMean, 0, 1).toFixed(3),
      updatedAt: new Date().toISOString(),
      // optional references
      lastSessionId: ctx.sessionId || null,
    };

    await upsertMany(
      "learning.aggregates",
      [aggRow],
      ["domain", "taskType", "equipmentSig"]
    );
    aggregates.push(aggRow);
  }

  return aggregates;
}

/* ------------------------------- Summarizers ------------------------------- */

function buildSessionSummary(rows, ctx) {
  const planned = sum(rows.map((r) => toNonNegInt(r.plannedMinutes || 0)));
  const actual = sum(rows.map((r) => toNonNegInt(r.actualMinutes || 0)));
  const deltas = rows.map((r) =>
    Number.isFinite(r.deltaMinutes) ? r.deltaMinutes : 0
  );
  const deltaMin = sum(deltas);
  const quality = rows
    .map((r) =>
      isFinite(r?.outcome?.qualityScore) ? r.outcome.qualityScore : null
    )
    .filter((v) => v != null);
  const successBools = rows.map((r) => r?.outcome?.success === true);

  const qualityMean = quality.length
    ? +(sum(quality) / quality.length).toFixed(3)
    : 0;
  const successRate = successBools.length
    ? +(successBools.filter(Boolean).length / successBools.length).toFixed(3)
    : 0;

  return {
    sessionId: ctx.sessionId,
    domain: ctx.domain,
    householdId: ctx.householdId || null,
    recipeId: ctx.recipeId || null,
    taskId: ctx.taskId || null,
    totalPlannedMin: planned,
    totalActualMin: actual,
    deltaMin,
    qualityMean,
    successRate,
    steps: rows.length,
    updatedAt: new Date().toISOString(),
    meta: ctx.meta || {},
  };
}

/* --------------------------- Domain Extractors ----------------------------- */

/**
 * Pluggable registry for deriving canonical taskType from (domain, step).
 * New domains can be added without altering core logic.
 */
function getTaskTypeExtractors() {
  return {
    cooking: (step) => {
      // prefer explicit taskType → else infer from equipment or keywords
      if (step.taskType) return step.taskType;
      const eq = step.equipmentUsed || [];
      if (eq.includes("pressure.canner")) return "pressure-canning";
      if (eq.includes("oven")) return "bake";
      if (eq.includes("range.top")) return "stovetop";
      return keywordClassify(
        step,
        {
          boil: ["boil", "blanch", "parboil"],
          roast: ["roast", "bake"],
          saute: ["sauté", "saute", "sear"],
          simmer: ["simmer", "braise", "stew"],
          cure: ["cure", "brine"],
        },
        "general"
      );
    },
    cleaning: (step) =>
      step.taskType ||
      keywordClassify(
        step,
        {
          mop: ["mop"],
          sweep: ["sweep", "broom"],
          sanitize: ["sanitize", "disinfect"],
          dust: ["dust", "wipe"],
        },
        "general"
      ),
    garden: (step) =>
      step.taskType ||
      keywordClassify(
        step,
        {
          plant: ["plant", "sow", "transplant"],
          water: ["water", "irrigate"],
          harvest: ["harvest", "pick"],
          weed: ["weed"],
        },
        "general"
      ),
    animal: (step) =>
      step.taskType ||
      keywordClassify(
        step,
        {
          feed: ["feed"],
          water: ["water"],
          butcher: ["butcher", "process"],
          milk: ["milk"],
        },
        "general"
      ),
    preservation: (step) =>
      step.taskType ||
      keywordClassify(
        step,
        {
          canning: ["water bath", "pressure can"],
          dehydrate: ["dehydrate"],
          freeze: ["flash freeze", "freeze"],
          cure: ["cure", "smoke"],
        },
        "general"
      ),
    storehouse: (step) => step.taskType || "store-op",
  };
}

function extractTaskType(domain, step) {
  const reg = getTaskTypeExtractors();
  const fn = reg[domain] || (() => step.taskType || "general");
  return fn(step);
}

function keywordClassify(step, dict, fallback) {
  const text = [step?.conditions?.note || ""].join(" ").toLowerCase();

  for (const [klass, words] of Object.entries(dict)) {
    if (words.some((w) => text.includes(w))) return klass;
  }
  return fallback;
}

/* --------------------------------- Storage --------------------------------- */

/**
 * Upsert many rows into a logical table using any available adapter methods.
 * Tries common method names for maximum compatibility with the project's dataGateway.
 */
async function upsertMany(table, rows, keyFields) {
  if (!dataGateway) throw new Error("dataGateway unavailable");
  const safeRows = Array.isArray(rows) ? rows : [];

  // Attempt common shapes (the project can implement any of these)
  if (typeof dataGateway.upsertMany === "function") {
    return await dataGateway.upsertMany(table, safeRows, keyFields);
  }
  if (typeof dataGateway.writeMany === "function") {
    return await dataGateway.writeMany({
      table,
      rows: safeRows,
      keyFields,
      mode: "upsert",
    });
  }
  if (typeof dataGateway.putMany === "function") {
    // emulate upsert: rely on putMany semantics
    await dataGateway.putMany(table, safeRows);
    return safeRows.length;
  }
  if (typeof dataGateway.put === "function") {
    let n = 0;
    for (const r of safeRows) {
      await dataGateway.put(table, r);
      n++;
    }
    return n;
  }

  throw new Error("dataGateway has no upsert-capable method");
}

async function getOne(table, query) {
  if (!dataGateway) return null;
  if (typeof dataGateway.getOne === "function") {
    return await dataGateway.getOne(table, query);
  }
  if (typeof dataGateway.findOne === "function") {
    return await dataGateway.findOne(table, query);
  }
  // Fallback: naive scan (not ideal; only for tiny tables)
  if (typeof dataGateway.scan === "function") {
    const rows = await dataGateway.scan(table, query);
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  }
  return null;
}

/* --------------------------------- Helpers --------------------------------- */

function emit(type, source, data) {
  eventBus.emit({ type, ts: new Date().toISOString(), source, data });
}

function parseISOorNull(s) {
  if (!s || typeof s !== "string") return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t);
}
function toNonNegInt(n) {
  const v = Math.floor(Number(n) || 0);
  return v < 0 ? 0 : v;
}
function clamp(n, lo, hi) {
  const x = Number(n);
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}
function sum(arr) {
  return arr.reduce((a, b) => a + (Number(b) || 0), 0);
}
function pick(obj, keys) {
  const o = {};
  for (const k of keys)
    if (Object.prototype.hasOwnProperty.call(obj, k)) o[k] = obj[k];
  return o;
}

/**
 * Trim outliers using IQR on a numeric field.
 * Keeps rows where value within [Q1 - 1.5*IQR, Q3 + 1.5*IQR].
 */
function iqrTrim(rows, field) {
  const vals = rows
    .map((r) => Number(r[field]))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (vals.length < 8) return rows; // not enough data to justify trimming
  const q1 = quantile(vals, 0.25);
  const q3 = quantile(vals, 0.75);
  const iqr = q3 - q1;
  const lo = q1 - 1.5 * iqr;
  const hi = q3 + 1.5 * iqr;
  return rows.filter((r) => {
    const v = Number(r[field]);
    return !Number.isFinite(v) || (v >= lo && v <= hi);
  });
}
function quantile(sorted, p) {
  const pos = (sorted.length - 1) * p;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  } else {
    return sorted[base];
  }
}

/* --------------------------- Optional Hub Export --------------------------- */

async function exportToHubIfEnabled(payload) {
  try {
    if (!featureFlags?.familyFundMode) return;
    if (!HubPacketFormatter || !FamilyFundConnector) return;
    const packet = HubPacketFormatter.format(payload);
    await FamilyFundConnector.send(packet);
  } catch {
    // fail silently by contract
  }
}
