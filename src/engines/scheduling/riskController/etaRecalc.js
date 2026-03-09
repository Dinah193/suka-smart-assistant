// C:\Users\larho\suka-smart-assistant\src\engines\scheduling\riskController\etaRecalc.js
/**
 * Scheduling Risk Controller — ETA Recalculation
 * -----------------------------------------------------------------------------
 * Role in pipeline:
 *   imports → intelligence (estimators/calibration) → automation (plans/resources)
 *   → gatekeeper (checks/contingencies) → risk controller (ETA, drift, replans)
 *   → (optional) hub export
 *
 * What this file does:
 *   - Recomputes ETAs for in-flight plan windows (tasks) based on live step progress.
 *   - Propagates delays across the plan order (predecessor → successor).
 *   - Updates the persisted plan snapshot with etaISO/status/delayMin fields.
 *   - Emits structured events to the shared eventBus and can export to the Hub.
 *
 * Progress input (per window/task):
 *   {
 *     id: string,                 // window id
 *     startedAt?: string|Date,    // ISO or Date, optional
 *     completedAt?: string|Date,  // ISO or Date, optional
 *     percent?: number,           // 0..1, optional
 *     remainingMinutes?: number,  // if provided, overrides estimation
 *     notes?: string
 *   }
 *
 * Stored plan snapshot (from compilePlan.js) will be read and updated.
 * Any writes to plan data will also (optionally) export to the Hub.
 */

"use strict";

/* --------------------------------- Imports --------------------------------- */

let eventBus = {
  emit: (...a) => console.debug("[etaRecalc:eventBus.emit]", ...a),
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

/** Optional data gateway (Dexie/IndexedDB/etc.). Falls back to in-memory. */
let dataGateway = null;
try {
  dataGateway = require("@/services/dataGateway");
  dataGateway = dataGateway?.default || dataGateway;
} catch {}

let dag = null;
try {
  dag = require("../scheduling/planner/dag.js");
  dag = dag?.default || dag;
} catch {}

/* ------------------------------ Local Fallbacks ----------------------------- */

const MEM_PLANS = new Map(); // planId -> snapshot (as produced by compilePlan)
const MEM_PROGRESS = new Map(); // planId -> { [windowId]: lastProgress }

/* --------------------------------- Helpers --------------------------------- */

const nowISO = () => new Date().toISOString();
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isStr = (v) => typeof v === "string";
const clamp01 = (x) => (isNum(x) ? Math.max(0, Math.min(1, x)) : 0);
const max = Math.max;
const min = Math.min;

function toMs(isoOrDate) {
  if (isoOrDate instanceof Date) return isoOrDate.getTime();
  if (isStr(isoOrDate)) {
    const t = Date.parse(isoOrDate);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}
function toISO(ms) {
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}
function addMin(ms, m) {
  if (!isNum(ms) || !isNum(m)) return null;
  return ms + Math.round(m * 60000);
}
function emit(type, source, data) {
  eventBus.emit({ type, ts: nowISO(), source, data });
}

/** Optional hub export (silent failure by requirement) */
async function exportToHubIfEnabled(payload) {
  try {
    if (!featureFlags?.familyFundMode) return;
    const HubPacketFormatter = require("@/services/hub/HubPacketFormatter");
    const FamilyFundConnector = require("@/services/hub/FamilyFundConnector");
    const formatter = HubPacketFormatter?.default || HubPacketFormatter;
    const connector = FamilyFundConnector?.default || FamilyFundConnector;
    const packet = formatter.format("scheduling.eta", payload);
    await connector.send(packet);
  } catch {
    // swallow
  }
}

/* --------------------------------- Storage ---------------------------------- */

const store = {
  async getPlan(planId) {
    try {
      if (dataGateway?.kv?.get) {
        return (await dataGateway.kv.get("plans", planId)) || null;
      }
      return MEM_PLANS.get(planId) || null;
    } catch {
      return MEM_PLANS.get(planId) || null;
    }
  },
  async putPlan(planId, snapshot) {
    try {
      if (dataGateway?.kv?.set) {
        await dataGateway.kv.set("plans", planId, snapshot);
      } else {
        MEM_PLANS.set(planId, snapshot);
      }
    } catch (err) {
      console.warn("[etaRecalc.store.putPlan] fallback MEM", err);
      MEM_PLANS.set(planId, snapshot);
    }
  },
  async putProgress(planId, progressMap) {
    try {
      if (dataGateway?.kv?.set) {
        await dataGateway.kv.set("progress", planId, progressMap);
      } else {
        MEM_PROGRESS.set(planId, progressMap);
      }
    } catch (err) {
      console.warn("[etaRecalc.store.putProgress] fallback MEM", err);
      MEM_PROGRESS.set(planId, progressMap);
    }
  },
  async getProgress(planId) {
    try {
      if (dataGateway?.kv?.get) {
        return (await dataGateway.kv.get("progress", planId)) || {};
      }
      return MEM_PROGRESS.get(planId) || {};
    } catch {
      return MEM_PROGRESS.get(planId) || {};
    }
  },
};

/* --------------------------- ETA Estimation Kernel -------------------------- */
/**
 * Estimate remaining minutes for a window given planned duration, timestamps,
 * and a percent complete. Uses a velocity-based estimator if possible, with a
 * small EWMA smoothing on velocity to avoid jitter.
 */
function estimateRemainingMinutes(args) {
  const {
    plannedMinutes, // number
    startISO, // may be null
    endISO, // planned end (for context)
    nowMs, // now in ms
    percent, // 0..1
    remainingOverride, // optional number
    prevVelMinPerUnit, // optional previous velocity (min per pct-unit)
  } = args;

  if (isNum(remainingOverride)) {
    return max(0, Math.round(remainingOverride));
  }

  const p = clamp01(percent);
  const planned = max(0, plannedMinutes || 0);

  // If not started, use full planned duration
  const startMs = toMs(startISO);
  if (startMs == null || p === 0) {
    return planned;
  }

  // If completed, remaining = 0
  if (p >= 1) {
    return 0;
  }

  const elapsedMin = max(0, Math.round((nowMs - startMs) / 60000));
  // Raw velocity in min per % (0..100 scale simplified as 1 unit == 100%)
  const rawVel = p > 0 ? elapsedMin / p : planned;
  // Smooth with EWMA toward previous velocity if given
  const alpha = 0.3;
  const vel = isNum(prevVelMinPerUnit)
    ? (1 - alpha) * prevVelMinPerUnit + alpha * rawVel
    : rawVel;

  const remainingPct = max(0, 1 - p);
  const remain = remainingPct * vel;

  // Guardrails: Remaining can't exceed 3× planned (stuck detection) or be less than 0.
  return max(0, min(Math.round(remain), planned * 3));
}

/* ------------------------------- Public API -------------------------------- */
/**
 * Recompute ETAs for a plan based on step progress, persist and emit changes.
 *
 * @param {Object} req
 *  - planId: string (required)
 *  - updates: Array<ProgressInput> (see header)
 *  - export?: boolean
 *
 * @returns {Promise<{
 *   planId: string,
 *   planETAISO: string|null,
 *   windows: Array<{ id, etaISO, delayMin, status }>,
 *   driftMin: number, // plan level delay vs. previous ETA or planned end
 *   ts: string
 * }>}
 */
async function recalcETA(req = {}) {
  const source = "engines/scheduling/riskController/etaRecalc.recalcETA";
  try {
    const planId = String(req.planId || "").trim();
    if (!planId) {
      emit("scheduling.eta.error", source, { message: "Missing planId" });
      return {
        planId: "",
        planETAISO: null,
        windows: [],
        driftMin: 0,
        ts: nowISO(),
      };
    }

    const snap = await store.getPlan(planId);
    if (
      !snap ||
      !Array.isArray(snap.windows) ||
      !Array.isArray(snap.schedule)
    ) {
      emit("scheduling.eta.error", source, {
        message: "Plan not found or invalid",
        planId,
      });
      return {
        planId,
        planETAISO: null,
        windows: [],
        driftMin: 0,
        ts: nowISO(),
      };
    }

    // Merge progress updates into progress map
    const prevProgress = await store.getProgress(planId);
    const updates = Array.isArray(req.updates) ? req.updates : [];
    const mergedProgress = { ...(prevProgress || {}) };
    for (const u of updates) {
      if (!u || !u.id) continue;
      const prev = mergedProgress[u.id] || {};
      mergedProgress[u.id] = {
        ...prev,
        ...normalizeProgress(u),
        updatedAt: nowISO(),
      };
    }
    await store.putProgress(planId, mergedProgress);

    // Build useful indices
    const byId = new Map(snap.windows.map((w) => [w.id, w]));
    const schedIdx = new Map((snap.schedule || []).map((r) => [r.id, r]));
    const nowMs = Date.now();

    // Recompute ETA per window
    const windowETAs = [];
    const etaById = new Map();
    const statusById = new Map();
    const delayById = new Map();

    for (const w of snap.windows) {
      const row = schedIdx.get(w.id) || {};
      const plannedStart = toMs(w.startISO);
      const plannedEnd = toMs(w.endISO);
      const plannedDurMin =
        isNum(row?.ef) && isNum(row?.es)
          ? row.ef - row.es
          : max(1, Math.round((plannedEnd - plannedStart) / 60000));

      const prog = mergedProgress[w.id] || {};
      let etaMs;
      let status = "planned"; // planned | in_progress | done | late
      let delayMin = 0;

      if (prog.completedAt) {
        // Completed: ETA is the completion time
        etaMs = toMs(prog.completedAt);
        status = "done";
      } else if (prog.startedAt || nowMs >= plannedStart) {
        // In progress or should have started
        const startedAt = prog.startedAt ? prog.startedAt : toISO(nowMs); // if it should have started by now, assume start now
        const remainMin = estimateRemainingMinutes({
          plannedMinutes: plannedDurMin,
          startISO: startedAt,
          endISO: w.endISO,
          nowMs,
          percent: isNum(prog.percent) ? prog.percent : 0,
          remainingOverride: isNum(prog.remainingMinutes)
            ? prog.remainingMinutes
            : undefined,
          prevVelMinPerUnit: isNum(prog.prevVel) ? prog.prevVel : undefined,
        });
        etaMs = addMin(nowMs, remainMin);
        status = "in_progress";
      } else {
        // Not started yet: ETA defaults to planned end
        etaMs = plannedEnd;
        status = "planned";
      }

      // Delay vs planned end
      const dMin = Math.round(((etaMs || plannedEnd) - plannedEnd) / 60000);
      delayMin = dMin;
      if (status !== "done" && dMin > 0 && nowMs > plannedEnd) {
        status = "late";
      }

      const etaISO = toISO(etaMs);
      etaById.set(w.id, etaISO);
      statusById.set(w.id, status);
      delayById.set(w.id, delayMin);
      windowETAs.push({ id: w.id, etaISO, delayMin, status });
    }

    // Propagate to successors using DAG order if available
    // We try to rebuild a local graph from schedule order if dag is not available.
    // Successors start can't be earlier than ETAs of predecessors.
    // NOTE: we don't shift absolute start times here; we only recompute ETAs by pushing downstream.
    try {
      if (dag?.buildGraph) {
        const planTasks = snap.windows.map((w) => ({
          id: w.id,
          duration: max(
            1,
            Math.round((toMs(w.endISO) - toMs(w.startISO)) / 60000)
          ),
        }));
        const links = inferLinksFromSchedule(snap.schedule);
        const g = dag.buildGraph(planTasks, links);
        if (g.order) {
          for (const id of g.order) {
            const preds = g.nodesById.get(id)?.predecessors || [];
            if (!preds.length) continue;
            const predMaxETAms = preds.reduce((acc, p) => {
              const eISO = etaById.get(p.id);
              const ems = toMs(eISO);
              return isNum(ems) ? max(acc, ems) : acc;
            }, 0);
            // If predecessor eta pushes beyond this window planned/eta start, we extend this window's eta accordingly
            const myPlannedEnd = toMs(byId.get(id)?.endISO);
            const myEtaMs = toMs(etaById.get(id));
            const adjEta = max(myEtaMs || 0, predMaxETAms);
            if (isNum(adjEta) && adjEta > (myEtaMs || 0)) {
              etaById.set(id, toISO(adjEta));
              const dMin = Math.round((adjEta - myPlannedEnd) / 60000);
              delayById.set(id, dMin);
              // keep existing status unless we need to mark 'late'
              const st = statusById.get(id);
              if (st !== "done" && Date.now() > myPlannedEnd && dMin > 0) {
                statusById.set(id, "late");
              }
            }
          }
        }
      }
    } catch (e) {
      // Non-fatal; keep local ETAs
      console.warn("[etaRecalc] DAG propagation failed:", e);
    }

    // Update snapshot windows with eta/status/delay
    const updatedWindows = snap.windows.map((w) => ({
      ...w,
      etaISO: etaById.get(w.id) || w.endISO,
      status: statusById.get(w.id) || w.status || "planned",
      delayMin: isNum(delayById.get(w.id)) ? delayById.get(w.id) : 0,
    }));

    // Plan-level ETA is max of window ETAs
    const planETAms = updatedWindows.reduce(
      (acc, w) => max(acc, toMs(w.etaISO) || 0),
      0
    );
    const planETAISO = planETAms ? toISO(planETAms) : snap.planEndISO || null;

    const prevPlanEnd = toMs(snap.planEndISO);
    const driftMin = isNum(prevPlanEnd)
      ? Math.round((planETAms - prevPlanEnd) / 60000)
      : 0;

    const updatedSnap = {
      ...snap,
      windows: updatedWindows,
      planEndISO: planETAISO, // keep plan end in sync with ETA (acts as "expected finish")
      ts: nowISO(),
    };

    await store.putPlan(planId, updatedSnap);

    const payload = {
      planId,
      planETAISO,
      driftMin,
      windows: updatedWindows.map((w) => ({
        id: w.id,
        etaISO: w.etaISO,
        delayMin: w.delayMin,
        status: w.status,
      })),
      planMeta: snap.planMeta || {},
    };

    emit("scheduling.eta.recalculated", source, payload);
    if (req.export === true) {
      await exportToHubIfEnabled({ action: "eta.recalculated", ...payload });
    }

    return {
      planId,
      planETAISO,
      windows: payload.windows,
      driftMin,
      ts: nowISO(),
    };
  } catch (err) {
    emit(
      "scheduling.eta.error",
      "engines/scheduling/riskController/etaRecalc.recalcETA",
      {
        message: String(err?.message || err),
      }
    );
    return {
      planId: String(req?.planId || ""),
      planETAISO: null,
      windows: [],
      driftMin: 0,
      ts: nowISO(),
    };
  }
}

/* -------------------------------- Internals -------------------------------- */

function normalizeProgress(p) {
  const out = {};
  if (p.startedAt)
    out.startedAt = isStr(p.startedAt)
      ? p.startedAt
      : p.startedAt instanceof Date
      ? p.startedAt.toISOString()
      : undefined;
  if (p.completedAt)
    out.completedAt = isStr(p.completedAt)
      ? p.completedAt
      : p.completedAt instanceof Date
      ? p.completedAt.toISOString()
      : undefined;
  if (isNum(p.percent)) out.percent = clamp01(p.percent);
  if (isNum(p.remainingMinutes))
    out.remainingMinutes = max(0, Math.round(p.remainingMinutes));
  if (isNum(p.prevVel)) out.prevVel = max(0.1, p.prevVel);
  if (isStr(p.notes)) out.notes = p.notes;
  return out;
}

/**
 * Infer a minimal link set from schedule rows (best-effort).
 * If EF(u) == ES(v) relationship exists in schedule, treat it as FS edge u→v.
 */
function inferLinksFromSchedule(scheduleRows) {
  const rows = Array.isArray(scheduleRows) ? scheduleRows.slice() : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const links = [];
  const idxByES = new Map();
  for (const r of rows) {
    if (!isNum(r.es)) continue;
    const k = `${r.es}`;
    if (!idxByES.has(k)) idxByES.set(k, []);
    idxByES.get(k).push(r.id);
  }
  for (const r of rows) {
    if (!isNum(r.ef)) continue;
    const succs = idxByES.get(`${r.ef}`) || [];
    for (const sId of succs) {
      if (sId === r.id) continue;
      links.push({ from: r.id, to: sId, type: "FS", lag: 0 });
    }
  }
  return links;
}

/* --------------------------------- Exports ---------------------------------- */
module.exports = {
  recalcETA,
  // for tests/ext
  _internals: {
    estimateRemainingMinutes,
    inferLinksFromSchedule,
  },
};
