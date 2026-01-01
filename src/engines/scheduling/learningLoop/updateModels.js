// C:\Users\larho\suka-smart-assistant\src\engines\scheduling\learningLoop\updateModels.js
/**
 * SSA Scheduling Learning Loop — Nightly Model Updater
 * ----------------------------------------------------
 * Purpose:
 *   Recompute correction factors and recommended buffers from recent execution "actuals"
 *   and rolling aggregates, then upsert planning models used by estimators/schedulers.
 *
 * How it fits the SSA pipeline:
 *   imports → intelligence → automation → (optional) hub export
 *   - imports + intelligence produce session plans with estimated durations
 *   - automation executes sessions and records actuals via ingestActuals.js
 *   - THIS MODULE (nightly) reads actuals/aggregates ⇒ updates model rows that
 *     planning/feasibility/options engines consume for more accurate estimates.
 *   - Optionally mirrors anonymized model rollups to the Hub when familyFundMode is on.
 *
 * Events:
 *   Emits `{ type, ts, source, data }`:
 *     - scheduling.models.updated
 *     - scheduling.models.none
 *     - scheduling.models.error
 *
 * Forward-thinking:
 *   - Robust stats: median, IQR, MAD, Q95. Avoids skew from outliers/spikes.
 *   - Per-bucket modeling: (domain, taskType, equipmentSig)
 *   - Service level buffers (e.g., 85th/95th percentile) configurable by domain/task
 *   - Extensible decay + floor/ceiling guards to prevent wild swings
 *   - Storage adapter abstracted via dataGateway
 */

let eventBus = {
  emit: (...a) => console.debug("[learningLoop:updateModels:eventBus.emit]", ...a),
  on: () => () => {},
};
try {
  const eb = require("@/services/eventBus");
  eventBus = eb?.default || eb?.eventBus || eventBus;
} catch { /* noop */ }

let featureFlags = {
  familyFundMode: false,
  learning: {
    ewmaAlpha: 0.3,
    modelUpdate: {
      lookbackDays: 30,
      minObservations: 5,
      serviceLevelDefault: 0.85, // Q85 buffer
      serviceLevelByDomain: {
        preservation: 0.95, // canning/food safety prefers higher service level
      },
      maxAdjustmentPct: 0.35, // cap nightly correction change to ±35%
      bufferFloorMin: 2,      // at least 2 minutes for any bucket
      bufferCapMin: 60,       // cap recommended buffer
      decay: 0.05,            // blend new stats 5% with previous model to avoid jumps
    },
  },
};
try {
  const ff = require("@/config/featureFlags");
  featureFlags = ff?.default || ff || featureFlags;
} catch { /* noop */ }

let dataGateway;
try { dataGateway = require("@/services/dataGateway"); } catch {}

let HubPacketFormatter, FamilyFundConnector;
try {
  HubPacketFormatter = require("@/services/hub/HubPacketFormatter");
  FamilyFundConnector = require("@/services/hub/FamilyFundConnector");
} catch { /* optional */ }

/* ---------------------------------- Types ---------------------------------- */
/**
 * @typedef {Object} UpdateOptions
 * @property {number} [lookbackDays]               // default featureFlags.learning.modelUpdate.lookbackDays
 * @property {number} [minObservations]            // minimum rows per bucket to update model
 * @property {number} [serviceLevelDefault]        // default percentile for buffer (0..1)
 * @property {Object<string, number>} [serviceLevelByDomain] // domain→percentile
 * @property {number} [maxAdjustmentPct]           // cap change per run (0..1)
 * @property {number} [bufferFloorMin]
 * @property {number} [bufferCapMin]
 * @property {number} [decay]                      // 0..1 newWeight
 * @property {Date}   [now]
 */

/* --------------------------------- Exports --------------------------------- */
module.exports = {
  /**
   * Nightly model update. Reads recent actuals & aggregates and upserts planning models:
   *   planning.models key = (domain, taskType, equipmentSig)
   *   fields: cf (correction factor), bufferMin, q95Duration, nBasis
   *
   * @param {UpdateOptions} options
   * @returns {Promise<{updated:number, skipped:number, window:{from:string,to:string}, preview?:Array<object>}>}
   */
  async nightlyUpdate(options = {}) {
    const ts = new Date().toISOString();
    const source = "engines.scheduling.learningLoop.updateModels";
    try {
      if (!dataGateway) throw new Error("dataGateway not available");

      const cfg = resolveConfig(options);
      const to = options.now instanceof Date ? options.now : new Date();
      const from = new Date(to.getTime() - cfg.lookbackDays * 24 * 60 * 60 * 1000);

      // Pull recent actuals (windowed) and current aggregates
      const recentActuals = await fetchRecentActuals(from, to);
      const aggregates = await fetchAggregates();

      // Group actuals into buckets
      const buckets = groupByBucket(recentActuals);

      let updated = 0, skipped = 0;
      const preview = [];

      for (const [key, rows] of buckets.entries()) {
        if (rows.length < cfg.minObservations) { skipped++; continue; }

        const [domain, taskType, equipmentSig] = key.split("::");
        const serviceLevel = cfg.serviceLevelByDomain[domain] ?? cfg.serviceLevelDefault;

        // Robust per-bucket stats
        const stats = calcStats(rows);

        // Determine reference estimate: prefer aggregate EWMA; fall back to median actual
        const aggKey = `${domain}::${taskType}::${equipmentSig}`;
        const agg = aggregates.get(aggKey);
        const ref = Number.isFinite(agg?.ewmaMinutes) && agg.ewmaMinutes > 0
          ? agg.ewmaMinutes
          : Math.max(1, stats.medianActual);

        // Correction factor (cf) = median(actual)/ref, bounded by cap change vs previous model
        const proposedCfRaw = stats.medianActual / Math.max(1, ref);
        const prevModel = await getModelRow(domain, taskType, equipmentSig);
        const cf = boundedCorrection(prevModel?.cf ?? 1, proposedCfRaw, cfg.maxAdjustmentPct);

        // Buffer based on percentile over (actual - ref*cf) residuals OR simply service-level quantile gap
        const residuals = rows
          .map(r => r.actualMinutes - ref * cf)
          .filter(Number.isFinite)
          .sort((a, b) => a - b);

        const qSL = quantile(residuals, serviceLevel);
        let bufferMin = Math.round(clamp(qSL, cfg.bufferFloorMin, cfg.bufferCapMin));
        if (!Number.isFinite(bufferMin)) {
          // fallback: MAD-based
          bufferMin = Math.round(clamp(stats.mad || cfg.bufferFloorMin, cfg.bufferFloorMin, cfg.bufferCapMin));
        }

        // Blend with previous model to avoid jumps (decay)
        const blended = blendModel(prevModel, { cf, bufferMin }, cfg.decay);

        // Convenience q95 duration (for reporting / debug)
        const q95Dur = quantile(rows.map(r => r.actualMinutes).sort((a, b) => a - b), 0.95);
        const modelRow = {
          domain, taskType, equipmentSig,
          cf: round2(blended.cf),
          bufferMin: blended.bufferMin,
          q95Duration: Math.round(q95Dur || stats.medianActual),
          nBasis: rows.length,
          windowFromISO: from.toISOString(),
          windowToISO: to.toISOString(),
          updatedAt: new Date().toISOString(),
        };

        await upsertMany("planning.models", [modelRow], ["domain", "taskType", "equipmentSig"]);
        updated++;
        if (preview.length < 6) preview.push(modelRow);
      }

      const payload = {
        window: { from: from.toISOString(), to: to.toISOString() },
        updated, skipped,
        sample: preview,
      };

      eventBus.emit({
        type: updated ? "scheduling.models.updated" : "scheduling.models.none",
        ts,
        source,
        data: payload,
      });

      // Optional Hub export (share aggregated model deltas; anonymized)
      await exportToHubIfEnabled({
        type: "learning.models.updated",
        ts,
        source,
        data: {
          window: payload.window,
          updated,
          skipped,
          sample: preview.map(p => ({
            domain: p.domain, taskType: p.taskType, equipmentSig: p.equipmentSig,
            cf: p.cf, bufferMin: p.bufferMin, q95Duration: p.q95Duration, nBasis: p.nBasis,
          })),
        },
      });

      return { updated, skipped, window: payload.window, preview };
    } catch (err) {
      eventBus.emit({
        type: "scheduling.models.error",
        ts: new Date().toISOString(),
        source,
        data: { reason: err?.message || "unknown" },
      });
      return { updated: 0, skipped: 0, window: null, error: err?.message || "unknown" };
    }
  },
};

/* ---------------------------------- Fetchers -------------------------------- */

async function fetchRecentActuals(from, to) {
  // Expectation: dataGateway.scan(table, query) or dataGateway.find where supported.
  // Query shape is adapter-defined; provide a best-effort filter.
  if (!dataGateway) return [];
  if (typeof dataGateway.scan === "function") {
    return await dataGateway.scan("actuals.steps", {
      startISO: { $gte: from.toISOString() },
      endISO: { $lte: to.toISOString() },
    });
  }
  if (typeof dataGateway.find === "function") {
    return await dataGateway.find("actuals.steps", { between: ["tsIngested", from.toISOString(), to.toISOString()] });
  }
  // Fallback: read-all + filter (acceptable only for tiny datasets)
  if (typeof dataGateway.all === "function") {
    const all = await dataGateway.all("actuals.steps");
    return (all || []).filter(r => {
      const t = Date.parse(r.tsIngested || r.endISO || r.startISO || 0);
      return Number.isFinite(t) && t >= +from && t <= +to;
    });
  }
  return [];
}

async function fetchAggregates() {
  const map = new Map();
  if (!dataGateway) return map;
  let rows = [];
  if (typeof dataGateway.all === "function") {
    rows = await dataGateway.all("learning.aggregates");
  } else if (typeof dataGateway.scan === "function") {
    rows = await dataGateway.scan("learning.aggregates", {});
  }
  for (const r of rows || []) {
    const key = `${r.domain}::${r.taskType}::${r.equipmentSig}`;
    map.set(key, r);
  }
  return map;
}

async function getModelRow(domain, taskType, equipmentSig) {
  if (!dataGateway) return null;
  if (typeof dataGateway.getOne === "function") {
    return await dataGateway.getOne("planning.models", { domain, taskType, equipmentSig });
  }
  if (typeof dataGateway.findOne === "function") {
    return await dataGateway.findOne("planning.models", { domain, taskType, equipmentSig });
  }
  return null;
}

/* --------------------------------- Stats/Logic ------------------------------ */

function groupByBucket(rows) {
  const map = new Map();
  for (const r of rows || []) {
    const domain = r.domain || "unknown";
    const taskType = r.taskType || "general";
    const equipmentSig = r.equipmentSig || (
      Array.isArray(r.equipmentUsed) && r.equipmentUsed.length
        ? r.equipmentUsed.slice().sort().join("|")
        : "none"
    );
    const actual = toPosInt(r.actualMinutes ?? deriveMinutes(r));
    if (!actual) continue;

    const planned = toNonNegInt(r.plannedMinutes ?? 0);
    const row = { domain, taskType, equipmentSig, actualMinutes: actual, plannedMinutes: planned };

    const key = `${domain}::${taskType}::${equipmentSig}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

function calcStats(rows) {
  const actuals = rows.map(r => r.actualMinutes).filter(Number.isFinite).sort((a, b) => a - b);
  const planned = rows.map(r => r.plannedMinutes).filter(Number.isFinite).sort((a, b) => a - b);
  const medA = median(actuals);
  const madA = mad(actuals);
  const q85 = quantile(actuals, 0.85);
  const q95 = quantile(actuals, 0.95);
  const medP = median(planned) || medA;
  return {
    n: rows.length,
    medianActual: medA,
    medianPlanned: medP,
    mad: madA,
    q85, q95,
  };
}

function boundedCorrection(prev, proposed, maxAdjPct) {
  // limit nightly delta vs previous
  const prevCf = Number.isFinite(prev) ? prev : 1;
  const raw = Number.isFinite(proposed) && proposed > 0 ? proposed : 1;
  const maxUp = prevCf * (1 + maxAdjPct);
  const maxDown = prevCf * (1 - maxAdjPct);
  return clamp(raw, maxDown, maxUp);
}

function blendModel(prev, next, newWeight) {
  if (!prev) return { cf: next.cf, bufferMin: next.bufferMin };
  const w = clamp(newWeight, 0, 1);
  return {
    cf: round4(prev.cf * (1 - w) + next.cf * w),
    bufferMin: Math.round(prev.bufferMin * (1 - w) + next.bufferMin * w),
  };
}

/* --------------------------------- Storage --------------------------------- */

async function upsertMany(table, rows, keyFields) {
  if (!dataGateway) throw new Error("dataGateway unavailable");
  const safeRows = Array.isArray(rows) ? rows : [];

  if (typeof dataGateway.upsertMany === "function") {
    return await dataGateway.upsertMany(table, safeRows, keyFields);
  }
  if (typeof dataGateway.writeMany === "function") {
    return await dataGateway.writeMany({ table, rows: safeRows, keyFields, mode: "upsert" });
  }
  if (typeof dataGateway.putMany === "function") {
    await dataGateway.putMany(table, safeRows);
    return safeRows.length;
  }
  if (typeof dataGateway.put === "function") {
    let n = 0; for (const r of safeRows) { await dataGateway.put(table, r); n++; } return n;
  }
  throw new Error("dataGateway has no upsert-capable method");
}

/* --------------------------------- Helpers --------------------------------- */

function emit(type, data) {
  eventBus.emit({ type, ts: new Date().toISOString(), source: "engines.scheduling.learningLoop.updateModels", data });
}

function resolveConfig(opts) {
  const base = featureFlags?.learning?.modelUpdate || {};
  return {
    lookbackDays: toPosInt(opts.lookbackDays ?? base.lookbackDays ?? 30),
    minObservations: toPosInt(opts.minObservations ?? base.minObservations ?? 5),
    serviceLevelDefault: clamp(Number(opts.serviceLevelDefault ?? base.serviceLevelDefault ?? 0.85), 0.5, 0.99),
    serviceLevelByDomain: { ...(base.serviceLevelByDomain || {}), ...(opts.serviceLevelByDomain || {}) },
    maxAdjustmentPct: clamp(Number(opts.maxAdjustmentPct ?? base.maxAdjustmentPct ?? 0.35), 0.05, 0.9),
    bufferFloorMin: toPosInt(opts.bufferFloorMin ?? base.bufferFloorMin ?? 2),
    bufferCapMin: toPosInt(opts.bufferCapMin ?? base.bufferCapMin ?? 60),
    decay: clamp(Number(opts.decay ?? base.decay ?? 0.05), 0, 1),
  };
}

function deriveMinutes(r) {
  const s = Date.parse(r.startISO || 0);
  const e = Date.parse(r.endISO || 0);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return null;
  return Math.round((e - s) / 60000);
}

function toPosInt(n) { const v = Math.floor(Number(n) || 0); return v > 0 ? v : 0; }
function toNonNegInt(n) { const v = Math.floor(Number(n) || 0); return v < 0 ? 0 : v; }
function clamp(n, lo, hi) { const x = Number(n); return Math.max(lo, Math.min(hi, Number.isFinite(x) ? x : lo)); }
function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }

function median(sorted) {
  if (!sorted?.length) return 0;
  const a = [...sorted].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function quantile(sorted, p) {
  const a = [...sorted].filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length || p == null) return NaN;
  const pos = (a.length - 1) * p;
  const base = Math.floor(pos);
  const rest = pos - base;
  return a[base + 1] !== undefined ? a[base] + rest * (a[base + 1] - a[base]) : a[base];
}

function mad(sorted) {
  const a = [...sorted].filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return 0;
  const med = median(a);
  const dev = a.map(x => Math.abs(x - med)).sort((x, y) => x - y);
  // 1.4826 scales MAD to approximate stddev for normal distributions
  return 1.4826 * median(dev);
}

/* --------------------------- Optional Hub Export --------------------------- */

async function exportToHubIfEnabled(payload) {
  try {
    if (!featureFlags?.familyFundMode) return;
    if (!HubPacketFormatter || !FamilyFundConnector) return;
    const packet = HubPacketFormatter.format(payload);
    await FamilyFundConnector.send(packet);
  } catch { /* fail silently by contract */ }
}
