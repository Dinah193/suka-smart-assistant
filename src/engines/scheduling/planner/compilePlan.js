// C:\Users\larho\suka-smart-assistant\src\engines\scheduling\planner\compilePlan.js
/**
 * Scheduling Planner — Main Entry: compilePlan
 * ------------------------------------------------------------
 * Role in pipeline:
 *  imports → intelligence (estimators + calibration) → automation (DAG/backplanner) → resource allocation → (optional) hub export
 *
 * What this file does:
 *  - Takes ad-hoc or daily plan requests with tasks/links and optional deadline or start time.
 *  - Applies calibration to raw estimates (duration/effort/resources) per domain (cooking, cleaning, garden, animals, preservation, storehouse).
 *  - Builds a DAG and computes a schedule (forward or backward from deadline).
 *  - Anchors to real time (ISO) and produces executable task windows.
 *  - Optionally reserves devices/people and resolves conflicts.
 *  - Emits consistent events to the shared eventBus and (optionally) exports change sets to the Hub.
 *
 * Events emitted (payload shape: { type, ts, source, data }):
 *  - scheduling.plan.compiled
 *  - scheduling.plan.error
 *  - scheduling.plan.partial (when we can produce a plan but with conflicts)
 *  - scheduling.resources.allocated / .conflict (emitted by resourceAllocator)
 *
 * Hub export:
 *  - On successful compile (and when requested), exportToHubIfEnabled(payload) is invoked (silent failure if Hub unavailable).
 *
 * Forward-thinking:
 *  - Domain-agnostic with extension points for new domains and import types.
 *  - Optional allocation strategy and external resource catalogs.
 *  - Persisted snapshots for analytics and re-planning.
 */

"use strict";

/* --------------------------------- Imports --------------------------------- */

let eventBus = {
  emit: (...a) => console.debug("[planner:compilePlan:eventBus.emit]", ...a),
  on: () => () => {},
};
try {
  const eb = require("@/services/eventBus");
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
  dag = require("./dag.js");
  dag = dag?.default || dag;
} catch {}

let backplanner = null;
try {
  backplanner = require("./backplanner.js");
  backplanner = backplanner?.default || backplanner;
} catch {}

let calibration = null;
try {
  calibration = require("../estimator/calibration.js");
  calibration = calibration?.default || calibration;
} catch {}

let allocator = null;
try {
  allocator = require("./resourceAllocator.js");
  allocator = allocator?.default || allocator;
} catch {}

/* ------------------------------ Local Fallbacks ----------------------------- */

const MEM_PLANS = new Map(); // planId -> snapshot

/* --------------------------------- Helpers --------------------------------- */

const nowISO = () => new Date().toISOString();
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isStr = (v) => typeof v === "string";
const clone = (obj) => (obj && typeof obj === "object" ? JSON.parse(JSON.stringify(obj)) : obj);
const toMs = (isoOrDate) => {
  if (isoOrDate instanceof Date) return isoOrDate.getTime();
  if (isStr(isoOrDate)) {
    const t = Date.parse(isoOrDate);
    return Number.isFinite(t) ? t : null;
  }
  return null;
};
const addMinutes = (epochMs, minutes) => (isNum(epochMs) && isNum(minutes) ? epochMs + Math.round(minutes * 60000) : null);
const toISO = (epochMs) => {
  try {
    return new Date(epochMs).toISOString();
  } catch {
    return null;
  }
};

function emit(type, source, data) {
  eventBus.emit({ type, ts: nowISO(), source, data });
}

/** Optional hub export — silent failure. */
async function exportToHubIfEnabled(payload) {
  try {
    if (!featureFlags?.familyFundMode) return;
    const HubPacketFormatter = require("@/services/hub/HubPacketFormatter");
    const FamilyFundConnector = require("@/services/hub/FamilyFundConnector");
    const formatter = HubPacketFormatter?.default || HubPacketFormatter;
    const connector = FamilyFundConnector?.default || FamilyFundConnector;
    const packet = formatter.format("scheduling.plan", payload);
    await connector.send(packet);
  } catch {
    // swallow
  }
}

/* ------------------------------- Data Access -------------------------------- */

const store = {
  /** Persist plan snapshot. */
  async putPlan(planId, snapshot) {
    try {
      if (dataGateway?.kv?.set) {
        await dataGateway.kv.set("plans", planId, snapshot);
      } else {
        MEM_PLANS.set(planId, snapshot);
      }
    } catch (err) {
      console.warn("[compilePlan.store.putPlan] fallback MEM", err);
      MEM_PLANS.set(planId, snapshot);
    }
  },
  /** Fetch plan snapshot. */
  async getPlan(planId) {
    try {
      if (dataGateway?.kv?.get) {
        return (await dataGateway.kv.get("plans", planId)) || null;
      }
      return MEM_PLANS.get(planId) || null;
    } catch (err) {
      console.warn("[compilePlan.store.getPlan] fallback MEM", err);
      return MEM_PLANS.get(planId) || null;
    }
  },
};

/* ----------------------------- Calibration pass ----------------------------- */

/**
 * Adjust a task's estimate fields using calibration engine (domain-aware).
 * Accepts estimate fields on the task:
 *  - { durationMin?, durationMax?, duration?, effortScore?, resources? }
 * Returns a normalized task with resolved numeric duration (minutes) for planning.
 */
async function applyCalibrationToTask(task) {
  if (!calibration?.applyCalibration) return task;

  const ctx = {
    domain: String(task.domain || "generic").toLowerCase(),
    taskType: task.taskType || task.type || "any",
    equipment: task.equipment || task.tools || [],
    householdId: task.householdId || "default",
  };

  const estimate = {
    durationMin: isNum(task.durationMin) ? task.durationMin : undefined,
    durationMax: isNum(task.durationMax) ? task.durationMax : undefined,
    duration: isNum(task.duration) ? task.duration : undefined,
    effortScore: isNum(task.effortScore) ? task.effortScore : undefined,
    resources: task.resources && typeof task.resources === "object" ? { ...task.resources } : undefined,
  };

  const adjusted = await calibration.applyCalibration(estimate, ctx);
  const withDuration =
    isNum(adjusted.duration)
      ? adjusted.duration
      : isNum(adjusted.durationMin) && isNum(adjusted.durationMax)
        ? Math.round((adjusted.durationMin + adjusted.durationMax) / 2)
        : isNum(adjusted.durationMin)
          ? adjusted.durationMin
          : isNum(adjusted.durationMax)
            ? adjusted.durationMax
            : 0;

  return {
    ...task,
    duration: Math.max(0, withDuration),
    effortScore: isNum(adjusted.effortScore) ? adjusted.effortScore : task.effortScore,
    resources: adjusted.resources || task.resources,
  };
}

/* ------------------------------ Windows builder ----------------------------- */

function serializeScheduleMap(schedMap) {
  const arr = [];
  for (const [id, r] of schedMap) {
    arr.push({
      id,
      es: r.es, ef: r.ef, ls: r.ls, lf: r.lf, slack: r.slack,
      level: r.level, critical: !!r.critical,
      plannedStartMin: r.plannedStartMin,
      plannedFinishMin: r.plannedFinishMin,
      plannedStartISO: r.plannedStartISO,
      plannedFinishISO: r.plannedFinishISO,
    });
  }
  return arr;
}

function planIdOrDefault(planId) {
  return planId || `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/* ------------------------------- Public API -------------------------------- */
/**
 * Compile a daily or ad-hoc session plan.
 *
 * @param {Object} req
 *  - planId?: string
 *  - planMeta?: object
 *  - tasks: Array<{
 *      id: string, title?: string, domain?: string,
 *      durationMin?, durationMax?, duration?, effortScore?, resources?,
 *      priority?: number, requirements?: Requirement[], equipment?: string[],
 *      taskType?: string
 *    }>
 *  - links?: Array<{ from: string, to: string, type?: "FS"|"SS"|"FF"|"SF", lag?: number }>
 *  - deadline?: ISO | Date | epoch-ms        // if present → backplanning
 *  - startAt?: ISO | Date                    // forward planning anchor (default: now)
 *  - anchor?: "latest" | "earliest"          // for forward planning, default "earliest"
 *  - allocate?: boolean                       // default true
 *  - allocationStrategy?: string              // "greedy" (default) – see resourceAllocator
 *  - resources?: Array<Resource>              // optional resource catalog; can be empty
 *  - export?: boolean                         // emit hub packet when enabled
 *
 * @returns {Promise<{
 *    planId: string,
 *    order: string[] | null,
 *    criticalPath: string[],
 *    makespan: number,
 *    windows: Array<{ id, startISO, endISO, domain?, priority?, requirements? }>,
 *    reservations?: Array,
 *    conflicts?: Array,
 *    schedule: Array, // numeric snapshot for UI/analytics
 *    planStartISO?: string,
 *    planEndISO?: string,
 * }>}
 */
async function compilePlan(req = {}) {
  const source = "engines/scheduling/planner/compilePlan.compilePlan";
  try {
    // --------- 1) Validate & normalize inputs ----------
    if (!Array.isArray(req.tasks) || req.tasks.length === 0) {
      const message = "No tasks provided.";
      emit("scheduling.plan.error", source, { message });
      return { planId: planIdOrDefault(req.planId), order: null, criticalPath: [], makespan: 0, windows: [], schedule: [] };
    }

    const planId = planIdOrDefault(req.planId);
    const links = Array.isArray(req.links) ? req.links.slice() : [];
    const allocate = req.allocate !== false;
    const resources = Array.isArray(req.resources) ? req.resources.map(clone) : [];

    // --------- 2) Calibration pass (imports → intelligence) ----------
    const calibratedTasks = [];
    for (const t of req.tasks) {
      const safeTask = t && t.id ? t : null;
      if (!safeTask) continue;
      const adjusted = await applyCalibrationToTask(safeTask);
      calibratedTasks.push(adjusted);
    }
    if (calibratedTasks.length === 0) {
      const message = "No valid tasks after calibration.";
      emit("scheduling.plan.error", source, { message });
      return { planId, order: null, criticalPath: [], makespan: 0, windows: [], schedule: [] };
    }

    // Prepare DAG tasks (must carry resolved duration)
    const dagTasks = calibratedTasks.map((t) => ({
      id: t.id,
      title: t.title,
      domain: t.domain || "generic",
      duration: isNum(t.duration) ? t.duration : 0,
      durationMin: t.durationMin,
      durationMax: t.durationMax,
      effortScore: t.effortScore,
      resources: t.resources,
      requires: Array.isArray(t.requires) ? t.requires : undefined,
      priority: isNum(t.priority) ? t.priority : 0,
      requirements: Array.isArray(t.requirements) ? t.requirements : [],
    }));

    // --------- 3) Scheduling (intelligence → automation) ----------
    let order = null;
    let criticalPath = [];
    let makespan = 0;
    let scheduleMap = null;
    let planStartISO = null;
    let planEndISO = null;

    if (req.deadline && backplanner?.backplanSchedule) {
      // Backward from deadline
      const { order: o, schedule, criticalPath: cp, makespan: ms, planStartISO: ps, planEndISO: pe, graph } =
        await backplanner.backplanSchedule(dagTasks, links, {
          deadline: req.deadline,
          anchor: "latest", // backplanner decides LS/ES based on opts; we pick "latest" to hit the deadline tightly
          export: false,
          planMeta: req.planMeta || { mode: "backplan" },
        });
      order = o;
      scheduleMap = schedule;
      criticalPath = cp || [];
      makespan = ms || 0;
      planStartISO = ps || null;
      planEndISO = pe || null;

      if (!order) {
        emit("scheduling.plan.error", source, { message: "Cycle detected; cannot compile plan." });
        return { planId, order: null, criticalPath: [], makespan: 0, windows: [], schedule: [] };
      }
    } else if (dag?.planSchedule) {
      // Forward plan, anchor to startAt (default now), choose ES or LS per anchor
      const startAtISO = req.startAt ? (req.startAt instanceof Date ? req.startAt.toISOString() : String(req.startAt)) : nowISO();
      const startMs = toMs(startAtISO) ?? Date.now();
      const anchor = String(req.anchor || "earliest").toLowerCase(); // "earliest" uses ES; "latest" uses LS

      const { order: o, schedule, criticalPath: cp, makespan: ms, graph } =
        await dag.planSchedule(dagTasks, links, { export: false, planMeta: req.planMeta || { mode: "forward" } });

      if (!o) {
        emit("scheduling.plan.error", source, { message: "Cycle detected; cannot compile plan." });
        return { planId, order: null, criticalPath: [], makespan: 0, windows: [], schedule: [] };
      }

      order = o;
      scheduleMap = schedule;
      criticalPath = cp || [];
      makespan = ms || 0;
      planStartISO = startAtISO;
      planEndISO = toISO(addMinutes(startMs, makespan));

      // Materialize absolute times from relative minutes
      for (const [id, row] of scheduleMap) {
        const startMin = anchor === "latest" ? row.ls : row.es;
        const endMin = anchor === "latest" ? row.lf : row.ef;
        const sAbs = addMinutes(startMs, startMin);
        const eAbs = addMinutes(startMs, endMin);
        row.plannedStartMin = startMin;
        row.plannedFinishMin = endMin;
        row.plannedStartISO = toISO(sAbs);
        row.plannedFinishISO = toISO(eAbs);
      }
    } else {
      const message = "Planner modules are unavailable.";
      emit("scheduling.plan.error", source, { message });
      return { planId, order: null, criticalPath: [], makespan: 0, windows: [], schedule: [] };
    }

    // --------- 4) Build executable windows (automation) ----------
    // Join user task metadata back onto the plan rows
    const byId = new Map(calibratedTasks.map((t) => [t.id, t]));
    const windows = [];
    for (const [id, row] of scheduleMap) {
      const t = byId.get(id) || {};
      if (!row.plannedStartISO || !row.plannedFinishISO) continue; // defensive
      windows.push({
        id,
        title: t.title,
        domain: t.domain || "generic",
        startISO: row.plannedStartISO,
        endISO: row.plannedFinishISO,
        priority: isNum(t.priority) ? t.priority : 0,
        requirements: Array.isArray(t.requirements) ? t.requirements : [],
      });
    }

    // --------- 5) Optional resource allocation ----------
    let reservations = [];
    let conflicts = [];
    if (allocate && allocator?.reserveResources) {
      const result = await allocator.reserveResources(windows, resources, {
        planId,
        strategy: req.allocationStrategy || "greedy",
        export: false, // we export once at the end
        planMeta: req.planMeta || {},
      });
      reservations = result.reservations || [];
      conflicts = result.conflicts || [];
    }

    // --------- 6) Persist snapshot ----------
    const scheduleSnapshot = serializeScheduleMap(scheduleMap);
    const snapshot = {
      planId,
      planMeta: req.planMeta || {},
      order,
      criticalPath,
      makespan,
      schedule: scheduleSnapshot,
      windows,
      reservations,
      conflicts,
      planStartISO,
      planEndISO,
      ts: nowISO(),
    };
    await store.putPlan(planId, snapshot);

    // --------- 7) Emit & optional Hub export ----------
    const eventPayload = { planId, ...snapshot };
    if (conflicts.length) {
      emit("scheduling.plan.partial", "engines/scheduling/planner/compilePlan", eventPayload);
    }
    emit("scheduling.plan.compiled", "engines/scheduling/planner/compilePlan", eventPayload);

    if (req.export === true) {
      await exportToHubIfEnabled({ action: "plan.compiled", ...eventPayload });
    }

    return {
      planId,
      order,
      criticalPath,
      makespan,
      windows,
      reservations,
      conflicts,
      schedule: scheduleSnapshot,
      planStartISO,
      planEndISO,
    };
  } catch (err) {
    emit("scheduling.plan.error", "engines/scheduling/planner/compilePlan", { message: String(err?.message || err) });
    return {
      planId: planIdOrDefault(req?.planId),
      order: null,
      criticalPath: [],
      makespan: 0,
      windows: [],
      reservations: [],
      conflicts: [{ type: "internalError", message: String(err?.message || err) }],
      schedule: [],
    };
  }
}

/* --------------------------------- Exports ---------------------------------- */
module.exports = {
  compilePlan,
  // for diagnostics
  _internals: {
    applyCalibrationToTask,
    serializeScheduleMap,
  },
};
