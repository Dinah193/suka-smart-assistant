// C:\Users\larho\suka-smart-assistant\src\engines\scheduling\estimator\calibration.js
/**
 * Scheduling Estimator — Calibration Engine
 * ------------------------------------------------------------
 * Role in pipeline:
 *  imports → intelligence (estimators) → automation (sessions) → (optional) hub export
 *
 * This module learns from execution feedback to correct future estimates.
 * It applies AND updates correction factors (multiplicative/additive) for:
 *  - duration (minutes)
 *  - effortScore (1–5 or arbitrary numeric)
 *  - resource usage (generic numeric fields, e.g., waterLiters, kWh, fuel, bags, etc.)
 *
 * Domains supported (explicit & extendable):
 *  - cooking, cleaning, garden, animals, preservation, storehouse
 *  - plus "generic" as a safe fallback
 *
 * Events (via src/services/events/eventBus.js) — payload: { type, ts, source, data }
 *  - scheduling.calibration.applied
 *  - scheduling.calibration.updated
 *  - scheduling.calibration.error
 *
 * Hub export (only when featureFlags.familyFundMode === true):
 *  - exportToHubIfEnabled(payload) uses HubPacketFormatter + FamilyFundConnector.
 */

"use strict";

/* -------------------------------- Constants -------------------------------- */

const DOMAINS = /** @type {const} */ ([
  "cooking",
  "cleaning",
  "garden",
  "animals",
  "preservation",
  "storehouse",
  "generic",
]);

/**
 * Optional per-domain priors & resource hints.
 *  - priors.alpha: default learning rate per domain
 *  - resources: common resource keys this domain may report (purely hints; learning is generic)
 * Extend this object freely as new domains land.
 */
const DOMAIN_HINTS = {
  cooking: {
    priors: { alpha: 0.2 },
    resources: [
      "waterLiters",
      "kWh",
      "BTU",
      "gasUnits",
      "washLoads",
      "pansUsed",
    ],
  },
  cleaning: {
    priors: { alpha: 0.25 },
    resources: [
      "waterLiters",
      "kWh",
      "mlDetergent",
      "padsUsed",
      "bags",
      "disinfectMinutes",
    ],
  },
  garden: {
    priors: { alpha: 0.3 },
    resources: [
      "waterLiters",
      "fertilizerGrams",
      "compostKg",
      "mulchBags",
      "kWh",
      "fuelLiters",
    ],
  },
  animals: {
    priors: { alpha: 0.3 },
    resources: [
      "feedKg",
      "waterLiters",
      "beddingKg",
      "medDoseMl",
      "kWh",
      "fuelLiters",
    ],
  },
  preservation: {
    priors: { alpha: 0.22 },
    resources: [
      "jars",
      "lids",
      "kWh",
      "BTU",
      "saltGrams",
      "vinegarMl",
      "smokeHours",
    ],
  },
  storehouse: {
    priors: { alpha: 0.18 },
    resources: ["boxes", "bins", "labels", "kWh", "shelfMeters", "bags"],
  },
  generic: {
    priors: { alpha: 0.25 },
    resources: [],
  },
};

/* --------------------------------- Imports --------------------------------- */

let eventBus = {
  emit: (...a) => console.debug("[calibration:eventBus.emit]", ...a),
  on: () => () => {},
};
try {
  const eb = require("@/services/events/eventBus");
  eventBus = eb?.default || eb?.eventBus || eventBus;
} catch {}

let featureFlags = { familyFundMode: false };
try {
  featureFlags = require("@/featureFlags.json");
} catch {}

/** Optional data gateway (Dexie/IndexedDB/etc.). Falls back to in-memory cache. */
let dataGateway = null;
try {
  dataGateway = require("@/services/dataGateway");
  dataGateway = dataGateway?.default || dataGateway;
} catch {}

/* ------------------------------ Local Fallbacks ----------------------------- */

const MEM_CACHE = new Map(); // key -> calibration record

/* --------------------------------- Helpers --------------------------------- */

/** @returns {string} ISO timestamp */
const nowISO = () => new Date().toISOString();

/** Safe number check */
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** Clamp to a min */
const clampMin = (v, min = 0) => (isNum(v) ? Math.max(v, min) : min);

/** Shallow clone plain object */
const clone = (obj) => (obj && typeof obj === "object" ? { ...obj } : obj);

/** Emit a structured event */
function emit(type, source, data) {
  eventBus.emit({ type, ts: nowISO(), source, data });
}

/** Ensure domain is one of our supported values; else map to 'generic' */
function normalizeDomain(domain) {
  const d = String(domain || "")
    .toLowerCase()
    .trim();
  return DOMAINS.includes(d) ? d : "generic";
}

/**
 * Build a calibration bucket key.
 * Stable, evolvable: add fields as needed.
 */
function buildKey({
  domain,
  taskType,
  equipment = [],
  householdId = "default",
}) {
  const d = normalizeDomain(domain);
  const equip = Array.isArray(equipment)
    ? equipment.slice().sort().join("|")
    : String(equipment || "");
  return [d, String(taskType || "any"), equip, String(householdId)].join("::");
}

/**
 * Storage adapter (dataGateway if available; else in-mem).
 * We purposely use a simple KV pattern under the "calibrations" namespace.
 */
const store = {
  /** @returns {Promise<any|null>} */
  async get(key) {
    try {
      if (dataGateway?.kv?.get) {
        return await dataGateway.kv.get("calibrations", key);
      }
      return MEM_CACHE.get(key) || null;
    } catch (err) {
      console.warn("[calibration.store.get] fallback to MEM", err);
      return MEM_CACHE.get(key) || null;
    }
  },
  /** @returns {Promise<void>} */
  async set(key, value) {
    try {
      if (dataGateway?.kv?.set) {
        await dataGateway.kv.set("calibrations", key, value);
      } else {
        MEM_CACHE.set(key, value);
      }
    } catch (err) {
      console.warn("[calibration.store.set] fallback MEM", err);
      MEM_CACHE.set(key, value);
    }
  },
};

/**
 * Hub export helper — silent failure by design.
 * Only called when we materially change household learning data.
 */
async function exportToHubIfEnabled(payload) {
  try {
    if (!featureFlags?.familyFundMode) return;
    const HubPacketFormatter = require("@/services/hub/HubPacketFormatter");
    const FamilyFundConnector = require("@/services/hub/FamilyFundConnector");
    const formatter = HubPacketFormatter?.default || HubPacketFormatter;
    const connector = FamilyFundConnector?.default || FamilyFundConnector;
    const packet = formatter.format("scheduling.calibration", payload);
    await connector.send(packet);
  } catch {
    // Silent by requirement
  }
}

/* ---------------------------- Calibration Model ---------------------------- */
/**
 * Model shape (per key):
 * {
 *   key: string,
 *   meta: { domain, taskType, equipment: string[], householdId, createdAt, updatedAt },
 *   samples: number,            // count of updates ingested
 *   alpha: number,              // EWMA learning rate (0..1)
 *   duration: { mult: number, add: number },
 *   effort:   { mult: number, add: number },
 *   resources: { [resourceName]: { mult: number, add: number } }
 * }
 */
const DEFAULT_ALPHA = 0.25;
const DEFAULT_CAL = (domain = "generic") => {
  const d = normalizeDomain(domain);
  const priors = DOMAIN_HINTS[d]?.priors || {};
  return {
    samples: 0,
    alpha: isNum(priors.alpha) ? priors.alpha : DEFAULT_ALPHA,
    duration: { mult: 1.0, add: 0.0 },
    effort: { mult: 1.0, add: 0.0 },
    resources: {},
  };
};

/**
 * Get or initialize a calibration record.
 */
async function getOrCreateCalibration(key, meta = {}) {
  let rec = await store.get(key);
  if (!rec) {
    const domain = normalizeDomain(meta.domain);
    rec = {
      key,
      meta: {
        domain,
        taskType: meta.taskType || "any",
        equipment: Array.isArray(meta.equipment)
          ? meta.equipment.slice().sort()
          : [],
        householdId: meta.householdId || "default",
        createdAt: nowISO(),
        updatedAt: nowISO(),
      },
      ...DEFAULT_CAL(domain),
    };
    await store.set(key, rec);
  }
  return rec;
}

/**
 * Persist calibration record.
 */
async function saveCalibration(rec) {
  rec.meta.updatedAt = nowISO();
  await store.set(rec.key, rec);
}

/* ------------------------- Public: Apply Calibration ------------------------ */
/**
 * Apply calibration corrections to a raw estimator output.
 * @param {Object} rawEstimate - e.g., { durationMin, durationMax, effortScore, resources: { waterLiters, kWh } }
 * @param {Object} ctx - { domain, taskType, equipment?, householdId? }
 * @returns {Promise<Object>} adjusted estimate + metadata
 */
async function applyCalibration(rawEstimate, ctx = {}) {
  const source = "engines/scheduling/estimator/calibration.apply";
  const estimate = clone(rawEstimate) || {};
  const key = buildKey(ctx);
  const cal = await getOrCreateCalibration(key, ctx);

  // Prepare adjusted structure
  const adjusted = clone(estimate);
  const durationFields = deriveDuration(estimate);

  // Duration
  if (durationFields.hasAny) {
    const durEst =
      durationFields.center || durationFields.min || durationFields.max || 0;
    const corrected = clampMin(
      durEst * cal.duration.mult + cal.duration.add,
      0
    );
    // Re-project corrected center back to min/max if provided
    if (isNum(durationFields.min) && isNum(durationFields.max)) {
      const span = Math.max(1, durationFields.max - durationFields.min);
      const center = (durationFields.min + durationFields.max) / 2;
      const factor = center ? corrected / center : cal.duration.mult;
      adjusted.durationMin = Math.round(
        clampMin(durationFields.min * factor + cal.duration.add, 0)
      );
      adjusted.durationMax = Math.round(
        clampMin(durationFields.max * factor + cal.duration.add, 0)
      );
      adjusted.durationSpan = Math.round(
        adjusted.durationMax - adjusted.durationMin
      );
      adjusted.duration = Math.round(
        (adjusted.durationMin + adjusted.durationMax) / 2
      );
    } else if (isNum(estimate.durationMin)) {
      adjusted.durationMin = Math.round(
        clampMin(estimate.durationMin * cal.duration.mult + cal.duration.add, 0)
      );
    } else if (isNum(estimate.durationMax)) {
      adjusted.durationMax = Math.round(
        clampMin(estimate.durationMax * cal.duration.mult + cal.duration.add, 0)
      );
    } else if (isNum(estimate.duration)) {
      adjusted.duration = Math.round(corrected);
    }
  }

  // Effort
  if (isNum(estimate.effortScore)) {
    adjusted.effortScore = clampMin(
      estimate.effortScore * cal.effort.mult + cal.effort.add,
      0
    );
  }

  // Resources (generic; hints are advisory only)
  adjusted.resources = clone(estimate.resources) || {};
  if (adjusted.resources && typeof adjusted.resources === "object") {
    for (const [name, val] of Object.entries(adjusted.resources)) {
      if (!isNum(val)) continue;
      const r = cal.resources?.[name] || { mult: 1.0, add: 0.0 };
      adjusted.resources[name] = clampMin(val * r.mult + r.add, 0);
    }
  }

  const payload = {
    raw: estimate,
    adjusted,
    domain: normalizeDomain(ctx.domain),
    calibrationKey: key,
    calibrationSnapshot: snapshotForEmit(cal),
    context: { ...ctx, domain: normalizeDomain(ctx.domain) },
  };
  emit("scheduling.calibration.applied", source, payload);
  return adjusted;
}

/* ------------------------- Public: Update Calibration ----------------------- */
/**
 * Update calibration using realized feedback from an executed session.
 *
 * @param {Object} args
 *  - ctx: { domain, taskType, equipment?, householdId? }
 *  - originalEstimate: { durationMin?, durationMax?, duration?, effortScore?, resources? }
 *  - actuals: { durationMinutes?, effortScore?, resources? } // resources mirror names used in estimate
 *  - options?: { alpha?, protect?: boolean } // protect=true => limit extreme changes
 *
 * @returns {Promise<Object|null>} updated calibration snapshot
 */
async function updateCalibration(args = {}) {
  const source = "engines/scheduling/estimator/calibration.update";
  try {
    const {
      ctx = {},
      originalEstimate = {},
      actuals = {},
      options = {},
    } = args;
    const domain = normalizeDomain(ctx.domain);
    const key = buildKey({ ...ctx, domain });
    const cal = await getOrCreateCalibration(key, { ...ctx, domain });

    // prefer domain default alpha if none specified and record still young
    const domainAlpha = DOMAIN_HINTS[domain]?.priors?.alpha;
    const chosenAlpha =
      options.alpha ??
      (cal.samples < 3 && isNum(domainAlpha)
        ? domainAlpha
        : cal.alpha ?? DEFAULT_ALPHA);

    const alpha = boundAlpha(chosenAlpha);
    const protect = options.protect !== false; // default true

    // Duration learning
    const estDur = pickEstimatedDuration(originalEstimate);
    const actDur = isNum(actuals.durationMinutes)
      ? actuals.durationMinutes
      : null;
    if (isNum(estDur) && isNum(actDur) && estDur > 0) {
      const ratio = clampRatio(actDur / estDur, protect);
      // EWMA on multiplicative factor; light additive correction on average bias
      cal.duration.mult = ewma(cal.duration.mult, ratio, alpha);
      const bias = actDur - estDur * cal.duration.mult;
      cal.duration.add = ewma(cal.duration.add, bias, alpha * 0.5);
    }

    // Effort learning
    if (
      isNum(originalEstimate.effortScore) &&
      isNum(actuals.effortScore) &&
      originalEstimate.effortScore > 0
    ) {
      const eratio = clampRatio(
        actuals.effortScore / originalEstimate.effortScore,
        protect
      );
      cal.effort.mult = ewma(cal.effort.mult, eratio, alpha);
      const ebias =
        actuals.effortScore - originalEstimate.effortScore * cal.effort.mult;
      cal.effort.add = ewma(cal.effort.add, ebias, alpha * 0.5);
    }

    // Resource learning (generic)
    const estRes = originalEstimate.resources || {};
    const actRes = actuals.resources || {};
    for (const [name, estVal] of Object.entries(estRes)) {
      if (!isNum(estVal) || estVal <= 0) continue;
      const actVal = actRes?.[name];
      if (!isNum(actVal)) continue;
      const r = cal.resources[name] || { mult: 1.0, add: 0.0 };
      const rratio = clampRatio(actVal / estVal, protect);
      r.mult = ewma(r.mult, rratio, alpha);
      const rbias = actVal - estVal * r.mult;
      r.add = ewma(r.add, rbias, alpha * 0.5);
      cal.resources[name] = r;
    }

    cal.samples += 1;
    cal.alpha = alpha; // persist possibly updated alpha
    await saveCalibration(cal);

    const snapshot = snapshotForEmit(cal);
    const payload = {
      calibrationKey: key,
      snapshot,
      context: { ...ctx, domain },
    };
    emit("scheduling.calibration.updated", source, payload);
    // Optional hub export (learning data is “household data” by spec)
    await exportToHubIfEnabled({ action: "calibration.updated", ...payload });
    return snapshot;
  } catch (err) {
    emit(
      "scheduling.calibration.error",
      "engines/scheduling/estimator/calibration.update",
      {
        message: String(err?.message || err),
      }
    );
    return null;
  }
}

/* ----------------------------- Public: Snapshot ----------------------------- */
/**
 * Retrieve a read-only snapshot for analytics or debugging.
 * @param {Object} ctx - { domain, taskType, equipment?, householdId? }
 */
async function getCalibrationSnapshot(ctx = {}) {
  const domain = normalizeDomain(ctx.domain);
  const key = buildKey({ ...ctx, domain });
  const rec = await getOrCreateCalibration(key, { ...ctx, domain });
  return snapshotForEmit(rec);
}

/* --------------------------------- Internals -------------------------------- */

/** Derive duration fields from estimate */
function deriveDuration(estimate) {
  const min = isNum(estimate.durationMin) ? estimate.durationMin : null;
  const max = isNum(estimate.durationMax) ? estimate.durationMax : null;
  const single = isNum(estimate.duration) ? estimate.duration : null;
  const center = isNum(min) && isNum(max) ? (min + max) / 2 : single;
  return {
    min,
    max,
    center,
    hasAny: isNum(min) || isNum(max) || isNum(single),
  };
}

/** Pick single estimated duration for learning */
function pickEstimatedDuration(estimate) {
  const d = deriveDuration(estimate);
  if (isNum(d.center)) return d.center;
  if (isNum(d.min)) return d.min;
  if (isNum(d.max)) return d.max;
  if (isNum(estimate.duration)) return estimate.duration;
  return null;
}

/** Exponentially Weighted Moving Average */
function ewma(prev, obs, alpha) {
  prev = isNum(prev) ? prev : 0;
  obs = isNum(obs) ? obs : 0;
  alpha = boundAlpha(alpha);
  return (1 - alpha) * prev + alpha * obs;
}

/** Bound alpha to sane values */
function boundAlpha(a) {
  if (!isNum(a)) return DEFAULT_ALPHA;
  if (a < 0.01) return 0.01;
  if (a > 0.9) return 0.9;
  return a;
}

/** Bound ratios to avoid runaway learning when protect=true */
function clampRatio(ratio, protect) {
  if (!protect) return ratio;
  if (!isNum(ratio) || ratio <= 0) return 1;
  // Allow 5× over/under at most per update
  return Math.max(1 / 5, Math.min(5, ratio));
}

/** Produce a clean snapshot for events/analytics */
function snapshotForEmit(rec) {
  return {
    key: rec.key,
    meta: clone(rec.meta),
    samples: rec.samples,
    alpha: rec.alpha,
    duration: clone(rec.duration),
    effort: clone(rec.effort),
    resources: clone(rec.resources),
    ts: nowISO(),
  };
}

/* --------------------------------- Exports ---------------------------------- */
module.exports = {
  DOMAINS,
  DOMAIN_HINTS,
  applyCalibration,
  updateCalibration,
  getCalibrationSnapshot,
};
