// C:\Users\larho\suka-smart-assistant\src\db\repositories\TelemetryRepo.js
/* eslint-disable no-console */

/**
 * TelemetryRepo
 * -----------------------------------------------------------------------------
 * Role in pipeline:
 * - Imports → Intelligence → Automation → (optional) Hub export
 * - Telemetry is the runtime exhaust produced while SSA executes work.
 *   This includes step actuals (start/pause/resume/end, timer pings) and
 *   fine-grained metrics (thermometer readings, humidity, RPM, wattage,
 *   user doneness checks, etc.). Engines and the automation runtime write
 *   here; analytics & UI read from here.
 *
 * Tables expected (Dexie):
 *  - db.telemetry           : discrete "actual events" tied to steps/sessions
 *      { id, kind, ts, stepId, sessionId, domain, resourceId, deviceId, data, createdAt }
 *  - db.metrics             : timeseries metrics
 *      { id, ts, key, value, unit, stepId?, sessionId?, domain?, resourceId?, deviceId?, labels, createdAt }
 *
 * Events:
 *  - Emits consistent event payloads { type, ts, source, data } on any write.
 *  - Because telemetry does not *change* inventory or sessions, Hub export
 *    is optional — but supported for observability (silent best-effort).
 *
 * Forward-thinking:
 *  - Domain-agnostic fields (cooking/cleaning/garden/animal/preservation).
 *  - Flexible "kind" for actuals and "key" for metrics.
 *  - Pluggable aggregation/summarization helpers.
 */

let db = null;
try {
  const mod = require("@/db");
  db = mod?.default || mod?.db || mod;
} catch {}

let eventBus = { emit: () => {}, on: () => () => {} };
try {
  const eb = require("@/services/eventBus");
  eventBus = eb?.default || eb?.eventBus || eventBus;
} catch {}

let featureFlags = { familyFundMode: false };
try {
  featureFlags = require("@/config/featureFlags.json");
} catch {}

let HubPacketFormatter = null;
try {
  const mod = require("@/services/hub/HubPacketFormatter");
  HubPacketFormatter = mod?.default || mod;
} catch {}

let FamilyFundConnector = null;
try {
  const mod = require("@/services/hub/FamilyFundConnector");
  FamilyFundConnector = mod?.default || mod;
} catch {}

const SOURCE = "db/TelemetryRepo";

/* ----------------------------------------------------------------------------
 * Utilities
 * -------------------------------------------------------------------------- */

function isoNow() {
  return new Date().toISOString();
}

function uuid(prefix = "tlm") {
  try {
    return globalThis?.crypto?.randomUUID?.() || `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  } catch {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
}

function emit(type, data) {
  try {
    eventBus.emit({ type, ts: isoNow(), source: SOURCE, data });
  } catch (err) {
    console.warn("[TelemetryRepo] event emit failed:", err);
  }
}

async function exportToHubIfEnabled(payload) {
  // Telemetry is optional to export, but supported.
  if (!featureFlags?.familyFundMode || !HubPacketFormatter || !FamilyFundConnector) return;
  try {
    const packet = HubPacketFormatter.formatTelemetryChange?.(payload) || payload;
    await FamilyFundConnector.send?.(packet);
  } catch (err) {
    console.warn("[TelemetryRepo] Hub export failed (silent):", err?.message || err);
  }
}

function ensureDB() {
  const ok =
    db &&
    typeof db === "object" &&
    db.telemetry &&
    db.metrics &&
    typeof db.telemetry === "object" &&
    typeof db.metrics === "object";
  if (!ok) {
    throw new Error("Dexie tables 'telemetry' and 'metrics' are required. Ensure '@/db' defines them.");
  }
}

function saneNumber(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

/* ----------------------------------------------------------------------------
 * Normalizers
 * -------------------------------------------------------------------------- */

/**
 * normalizeActualEvent
 * kind:
 *  - "step.start" | "step.pause" | "step.resume" | "step.end"
 *  - "timer.fire" | "note" | "sensor.snapshot"
 * data:
 *  - free-form object (e.g., { reason, tempC, humidity, doneness:"medium" })
 */
function normalizeActualEvent(input = {}) {
  if (!input || typeof input !== "object") return { ok: false, error: "Invalid telemetry payload." };

  const now = isoNow();
  const allowed = new Set([
    "step.start",
    "step.pause",
    "step.resume",
    "step.end",
    "timer.fire",
    "note",
    "sensor.snapshot",
  ]);
  const kind = String(input.kind || "").trim();
  if (!allowed.has(kind)) {
    return { ok: false, error: `Unsupported telemetry kind '${kind}'.` };
  }

  const ts = input.ts ? new Date(input.ts).toISOString() : now;

  const record = {
    id: input.id || uuid("act"),
    kind,
    ts,
    stepId: input.stepId || null,
    sessionId: input.sessionId || null,
    domain: input.domain || null, // e.g., "cooking"
    resourceId: input.resourceId || null, // person/room/device resource linkage
    deviceId: input.deviceId || null, // explicit device id if available
    data: input.data && typeof input.data === "object" ? input.data : {},
    createdAt: input.createdAt || now,
  };

  if (!record.stepId && !record.sessionId) {
    // Allow free-floating notes, but warn for developer visibility.
    // console.warn("[TelemetryRepo.normalizeActualEvent] Missing stepId/sessionId");
  }

  return { ok: true, record };
}

/**
 * normalizeMetric
 * key: dot-path metric name, e.g., "temp.c", "probe.core.c", "power.w", "ui.tap"
 * value: number | string | boolean (numbers preferred for aggregation)
 * unit: optional (e.g., "C", "F", "W", "ppm")
 * labels: free-form tagging for later aggregations
 */
function normalizeMetric(input = {}) {
  if (!input || typeof input !== "object") return { ok: false, error: "Invalid metric payload." };

  const now = isoNow();
  const key = String(input.key || "").trim();
  if (!key) return { ok: false, error: "Metric 'key' is required." };

  const record = {
    id: input.id || uuid("met"),
    ts: input.ts ? new Date(input.ts).toISOString() : now,
    key,
    value: input.value, // store raw; aggregators can coerce
    unit: input.unit || null,

    stepId: input.stepId || null,
    sessionId: input.sessionId || null,
    domain: input.domain || null,
    resourceId: input.resourceId || null,
    deviceId: input.deviceId || null,

    labels: input.labels && typeof input.labels === "object" ? input.labels : {},
    createdAt: input.createdAt || now,
  };

  return { ok: true, record };
}

/* ----------------------------------------------------------------------------
 * Repository
 * -------------------------------------------------------------------------- */

const TelemetryRepo = {
  /* --------------------------------- Actuals --------------------------------- */

  /**
   * recordActual(event)
   * Write one actual event (start/pause/resume/end/timer.fire/note/sensor.snapshot)
   */
  async recordActual(event) {
    ensureDB();
    const res = normalizeActualEvent(event);
    if (!res.ok) return { ok: false, error: res.error };

    const rec = res.record;
    try {
      await db.telemetry.put(rec);
      const payload = { action: "actual.record", actual: rec };
      emit("telemetry.actual_recorded", payload);
      await exportToHubIfEnabled(payload);
      return { ok: true, data: rec };
    } catch (err) {
      console.error("[TelemetryRepo.recordActual] failed:", err);
      return { ok: false, error: err?.message || String(err) };
    }
  },

  /**
   * recordActuals(events[])
   * Efficient multi-insert of actual events.
   */
  async recordActuals(list = []) {
    ensureDB();
    if (!Array.isArray(list) || !list.length) return { ok: false, error: "Nothing to record." };
    const ready = [];
    for (const e of list) {
      const res = normalizeActualEvent(e);
      if (res.ok) ready.push(res.record);
    }
    if (!ready.length) return { ok: false, error: "No valid events." };

    try {
      const ids = await db.telemetry.bulkPut(ready);
      const payload = { action: "actual.bulkRecord", count: ready.length, ids: ready.map(r => r.id) };
      emit("telemetry.actuals_bulk_recorded", payload);
      await exportToHubIfEnabled(payload);
      return { ok: true, data: Array.isArray(ids) ? ids : ready.map(r => r.id) };
    } catch (err) {
      console.error("[TelemetryRepo.recordActuals] failed:", err);
      return { ok: false, error: err?.message || String(err) };
    }
  },

  /**
   * getActuals({ stepId?, sessionId?, kind?, from?, to?, limit?, offset? })
   */
  async getActuals(opts = {}) {
    ensureDB();
    const {
      stepId = null,
      sessionId = null,
      kind = null,
      from = null,
      to = null,
      limit = 1000,
      offset = 0,
    } = opts;

    try {
      let coll = db.telemetry.toCollection();

      if (stepId) coll = coll.and(r => r.stepId === stepId);
      if (sessionId) coll = coll.and(r => r.sessionId === sessionId);
      if (kind) {
        const set = new Set(Array.isArray(kind) ? kind : [kind]);
        coll = coll.and(r => set.has(r.kind));
      }
      if (from || to) {
        const fromT = from ? new Date(from).getTime() : null;
        const toT = to ? new Date(to).getTime() : null;
        coll = coll.and(r => {
          const t = new Date(r.ts).getTime();
          if (fromT && t < fromT) return false;
          if (toT && t >= toT) return false;
          return true;
        });
      }

      const arr = await coll.sortBy("ts");
      const slice = arr.slice(offset, offset + limit);
      return { ok: true, data: { total: arr.length, items: slice, offset, limit } };
    } catch (err) {
      console.error("[TelemetryRepo.getActuals] failed:", err);
      return { ok: false, error: err?.message || String(err) };
    }
  },

  /**
   * removeActual(id)
   */
  async removeActual(id) {
    ensureDB();
    if (!id) return { ok: false, error: "Missing id." };
    try {
      const curr = await db.telemetry.get(id);
      if (!curr) return { ok: false, error: "Not found." };

      await db.telemetry.delete(id);
      const payload = { action: "actual.delete", id, actual: curr };
      emit("telemetry.actual_deleted", payload);
      await exportToHubIfEnabled(payload);
      return { ok: true, data: { id } };
    } catch (err) {
      console.error("[TelemetryRepo.removeActual] failed:", err);
      return { ok: false, error: err?.message || String(err) };
    }
  },

  /**
   * clearActualsForStep(stepId)
   */
  async clearActualsForStep(stepId) {
    ensureDB();
    if (!stepId) return { ok: false, error: "Missing stepId." };
    try {
      await db.telemetry.where("stepId").equals(stepId).delete();
      const payload = { action: "actual.clear_step", stepId };
      emit("telemetry.actuals_cleared_for_step", payload);
      await exportToHubIfEnabled(payload);
      return { ok: true, data: { stepId } };
    } catch (err) {
      console.error("[TelemetryRepo.clearActualsForStep] failed:", err);
      return { ok: false, error: err?.message || String(err) };
    }
  },

  /* --------------------------------- Metrics --------------------------------- */

  /**
   * logMetric(metric)
   * Example:
   *  logMetric({ key:"temp.c", value:64.2, unit:"C", stepId, sessionId, domain:"cooking", labels:{ probe:"center" } })
   */
  async logMetric(metric) {
    ensureDB();
    const res = normalizeMetric(metric);
    if (!res.ok) return { ok: false, error: res.error };

    const rec = res.record;
    try {
      await db.metrics.put(rec);
      const payload = { action: "metric.log", metric: rec };
      emit("telemetry.metric_logged", payload);
      await exportToHubIfEnabled(payload);
      return { ok: true, data: rec };
    } catch (err) {
      console.error("[TelemetryRepo.logMetric] failed:", err);
      return { ok: false, error: err?.message || String(err) };
    }
  },

  /**
   * logMetrics(metrics[])
   */
  async logMetrics(list = []) {
    ensureDB();
    if (!Array.isArray(list) || !list.length) return { ok: false, error: "Nothing to log." };
    const ready = [];
    for (const m of list) {
      const res = normalizeMetric(m);
      if (res.ok) ready.push(res.record);
    }
    if (!ready.length) return { ok: false, error: "No valid metrics." };

    try {
      const ids = await db.metrics.bulkPut(ready);
      const payload = { action: "metric.bulkLog", count: ready.length, ids: ready.map(r => r.id) };
      emit("telemetry.metrics_bulk_logged", payload);
      await exportToHubIfEnabled(payload);
      return { ok: true, data: Array.isArray(ids) ? ids : ready.map(r => r.id) };
    } catch (err) {
      console.error("[TelemetryRepo.logMetrics] failed:", err);
      return { ok: false, error: err?.message || String(err) };
    }
  },

  /**
   * getMetrics({ key?, stepId?, sessionId?, domain?, from?, to?, limit?, offset? })
   */
  async getMetrics(opts = {}) {
    ensureDB();
    const {
      key = null,
      stepId = null,
      sessionId = null,
      domain = null,
      from = null,
      to = null,
      limit = 2000,
      offset = 0,
    } = opts;

    try {
      let coll = db.metrics.toCollection();

      if (key) {
        const set = new Set(Array.isArray(key) ? key : [key]);
        coll = coll.and(r => set.has(r.key));
      }
      if (stepId) coll = coll.and(r => r.stepId === stepId);
      if (sessionId) coll = coll.and(r => r.sessionId === sessionId);
      if (domain) coll = coll.and(r => r.domain === domain);
      if (from || to) {
        const fromT = from ? new Date(from).getTime() : null;
        const toT = to ? new Date(to).getTime() : null;
        coll = coll.and(r => {
          const t = new Date(r.ts).getTime();
          if (fromT && t < fromT) return false;
          if (toT && t >= toT) return false;
          return true;
        });
      }

      const arr = await coll.sortBy("ts");
      const slice = arr.slice(offset, offset + limit);
      return { ok: true, data: { total: arr.length, items: slice, offset, limit } };
    } catch (err) {
      console.error("[TelemetryRepo.getMetrics] failed:", err);
      return { ok: false, error: err?.message || String(err) };
    }
  },

  /**
   * removeMetric(id)
   */
  async removeMetric(id) {
    ensureDB();
    if (!id) return { ok: false, error: "Missing id." };
    try {
      const curr = await db.metrics.get(id);
      if (!curr) return { ok: false, error: "Not found." };

      await db.metrics.delete(id);
      const payload = { action: "metric.delete", id, metric: curr };
      emit("telemetry.metric_deleted", payload);
      await exportToHubIfEnabled(payload);
      return { ok: true, data: { id } };
    } catch (err) {
      console.error("[TelemetryRepo.removeMetric] failed:", err);
      return { ok: false, error: err?.message || String(err) };
    }
  },

  /**
   * prune({ beforeISO, tables?:["telemetry"|"metrics"], limit?: n })
   * Deletes old telemetry/metrics to control local storage size.
   */
  async prune({ beforeISO, tables = ["telemetry", "metrics"], limit = 10000 } = {}) {
    ensureDB();
    if (!beforeISO) return { ok: false, error: "beforeISO is required." };
    const cutoff = new Date(beforeISO).getTime();
    if (!Number.isFinite(cutoff)) return { ok: false, error: "Invalid beforeISO." };

    try {
      let deleted = 0;
      await db.transaction("rw", db.telemetry, db.metrics, async () => {
        if (tables.includes("telemetry")) {
          const items = await db.telemetry
            .toCollection()
            .and(r => new Date(r.ts).getTime() < cutoff)
            .limit(limit)
            .primaryKeys();
          if (items.length) {
            await db.telemetry.bulkDelete(items);
            deleted += items.length;
          }
        }
        if (tables.includes("metrics")) {
          const items = await db.metrics
            .toCollection()
            .and(r => new Date(r.ts).getTime() < cutoff)
            .limit(limit)
            .primaryKeys();
          if (items.length) {
            await db.metrics.bulkDelete(items);
            deleted += items.length;
          }
        }
      });

      const payload = { action: "prune", beforeISO, tables, deleted };
      emit("telemetry.pruned", payload);
      // Typically no need to export pruning to Hub; omit on purpose.
      return { ok: true, data: { deleted } };
    } catch (err) {
      console.error("[TelemetryRepo.prune] failed:", err);
      return { ok: false, error: err?.message || String(err) };
    }
  },

  /* ------------------------------ Convenience API ----------------------------- */

  /**
   * markStart({ stepId, sessionId, domain, resourceId, deviceId, data })
   */
  async markStart({ stepId, sessionId = null, domain = null, resourceId = null, deviceId = null, data = {} } = {}) {
    if (!stepId) return { ok: false, error: "stepId required." };
    return this.recordActual({ kind: "step.start", stepId, sessionId, domain, resourceId, deviceId, data });
  },

  async markPause(stepId, data = {}) {
    if (!stepId) return { ok: false, error: "stepId required." };
    return this.recordActual({ kind: "step.pause", stepId, data });
  },

  async markResume(stepId, data = {}) {
    if (!stepId) return { ok: false, error: "stepId required." };
    return this.recordActual({ kind: "step.resume", stepId, data });
  },

  /**
   * markEnd({ stepId, sessionId? , data? })
   * Optionally computes a duration using first start and this end.
   * Adds durationSec into 'data' if not provided.
   */
  async markEnd({ stepId, sessionId = null, data = {} } = {}) {
    if (!stepId) return { ok: false, error: "stepId required." };
    const nowISO = isoNow();
    const startRes = await this.getActuals({ stepId, kind: "step.start", limit: 1 });
    let durationSec = saneNumber(data?.durationSec, 0);
    if (startRes.ok && startRes.data.items.length) {
      const startISO = startRes.data.items[0].ts;
      durationSec = durationSec || computeDurationSec(startISO, nowISO);
    }
    const payload = { ...data, durationSec };
    return this.recordActual({ kind: "step.end", stepId, sessionId, data: payload });
  },

  /**
   * note(stepId, text, extra?)
   */
  async note(stepId, text, extra = {}) {
    if (!stepId) return { ok: false, error: "stepId required." };
    return this.recordActual({ kind: "note", stepId, data: { text: String(text || ""), ...extra } });
  },

  /**
   * sensorSnapshot({ stepId?, sessionId?, keyVals: { tempC, humidityPct, ... }, deviceId?, resourceId? })
   */
  async sensorSnapshot({ stepId = null, sessionId = null, keyVals = {}, deviceId = null, resourceId = null } = {}) {
    return this.recordActual({
      kind: "sensor.snapshot",
      stepId,
      sessionId,
      deviceId,
      resourceId,
      data: keyVals && typeof keyVals === "object" ? keyVals : {},
    });
  },

  /**
   * summarizeStep(stepId)
   * Returns naive aggregates over metrics + actuals for a single step.
   */
  async summarizeStep(stepId) {
    if (!stepId) return { ok: false, error: "stepId required." };
    const [acts, mets] = await Promise.all([
      this.getActuals({ stepId, limit: 10000 }),
      this.getMetrics({ stepId, limit: 10000 }),
    ]);
    if (!acts.ok) return acts;
    if (!mets.ok) return mets;

    const starts = acts.data.items.filter(a => a.kind === "step.start").map(a => a.ts);
    const ends = acts.data.items.filter(a => a.kind === "step.end").map(a => a.ts);
    const firstStart = starts.length ? new Date(starts[0]).toISOString() : null;
    const lastEnd = ends.length ? new Date(ends[ends.length - 1]).toISOString() : null;

    let durationSec = 0;
    if (firstStart && lastEnd) durationSec = computeDurationSec(firstStart, lastEnd);

    // Example aggregates: min/max/avg for numeric metrics by key
    const byKey = new Map();
    for (const m of mets.data.items) {
      if (typeof m.value !== "number") continue;
      const k = m.key;
      if (!byKey.has(k)) byKey.set(k, { min: m.value, max: m.value, sum: m.value, n: 1, unit: m.unit || null });
      else {
        const agg = byKey.get(k);
        agg.min = Math.min(agg.min, m.value);
        agg.max = Math.max(agg.max, m.value);
        agg.sum += m.value;
        agg.n += 1;
      }
    }
    const metrics = {};
    for (const [k, v] of byKey.entries()) {
      metrics[k] = { min: v.min, max: v.max, avg: v.sum / v.n, unit: v.unit };
    }

    const summary = { stepId, firstStart, lastEnd, durationSec, metricsCount: mets.data.items.length, metrics };
    return { ok: true, data: summary };
  },
};

/* ----------------------------------------------------------------------------
 * Helpers
 * -------------------------------------------------------------------------- */

function computeDurationSec(startISO, endISO) {
  try {
    const s = new Date(startISO).getTime();
    const e = new Date(endISO).getTime();
    if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return 0;
    return Math.round((e - s) / 1000);
  } catch {
    return 0;
  }
}

export default TelemetryRepo;
