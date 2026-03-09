// C:\Users\larho\suka-smart-assistant\src\engines\scheduling\planner\backplanner.js
/**
 * Scheduling Planner — Backplanner
 * ------------------------------------------------------------
 * Role in pipeline:
 *  imports → intelligence (estimators/calibration) → automation (sessions via planners) → (optional) hub export
 *
 * What this file does:
 *  - Works backward from a fixed deadline to compute latest-feasible start times.
 *  - Uses the DAG planner for topology & time windows, then anchors to a deadline.
 *  - Supports FS/SS/FF/SF dependencies with non-negative lag (minutes).
 *  - Emits structured planning events to the shared eventBus.
 *  - Optionally exports generated session plans to the Family Fund Hub when enabled.
 *
 * Domains supported (forward-compatible):
 *  - cooking, cleaning, garden, animals, preservation, storehouse, generic (extensible).
 *
 * Event payload shape:
 *  { type, ts, source, data }
 *
 * Emitted events:
 *  - scheduling.backplan.computed
 *  - scheduling.backplan.error
 *  - scheduling.plan.generated (when opts.export === true)
 *
 * Notes:
 *  - We compute a forward schedule (ES/EF/LS/LF) in relative minutes from plan start (0).
 *  - Given a deadline (absolute Date/ISO or relative minutes), we set planEnd = deadline.
 *  - Backplanning assigns each task a planned start/finish, typically at Latest Start (LS) to meet the deadline.
 *  - Caller can choose strategy: "latest" (default) or "earliest" to consume or preserve slack.
 */

"use strict";

/* --------------------------------- Imports --------------------------------- */

let eventBus = {
  emit: (...a) => console.debug("[planner:backplanner:eventBus.emit]", ...a),
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

// We depend on the DAG module for graph build & time windows.
let dag = null;
try {
  dag = require("./dag.js"); // same folder
  dag = dag?.default || dag;
} catch {}

/* ------------------------------ Local Helpers ------------------------------ */

const nowISO = () => new Date().toISOString();
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isStr = (v) => typeof v === "string";
const clone = (obj) =>
  obj && typeof obj === "object" ? JSON.parse(JSON.stringify(obj)) : obj;

function emit(type, source, data) {
  eventBus.emit({ type, ts: nowISO(), source, data });
}

/**
 * Optional hub export: only when opts.export === true AND featureFlags.familyFundMode
 * Silent failure by requirement.
 */
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

/** Parse a deadline that may be:
 *  - Date
 *  - ISO string
 *  - number (epoch ms)
 *  - { iso?: string, epoch?: number, date?: Date }
 * Returns millis since epoch, or null on failure.
 */
function parseDeadline(deadline) {
  if (!deadline && deadline !== 0) return null;
  if (deadline instanceof Date) {
    const t = deadline.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (isStr(deadline)) {
    const t = Date.parse(deadline);
    return Number.isFinite(t) ? t : null;
  }
  if (isNum(deadline)) {
    return deadline; // assume epoch ms
  }
  if (deadline && typeof deadline === "object") {
    if (deadline.date instanceof Date) return parseDeadline(deadline.date);
    if (isStr(deadline.iso)) return parseDeadline(deadline.iso);
    if (isNum(deadline.epoch)) return deadline.epoch;
  }
  return null;
}

/** Add minutes (can be negative) to an epoch millis */
function addMinutes(epochMs, minutes) {
  if (!isNum(epochMs) || !isNum(minutes)) return null;
  return epochMs + Math.round(minutes * 60 * 1000);
}

/** Convert minutes offset (from plan start) into absolute ms using planStartMs */
function toAbsolute(epochStartMs, minutes) {
  if (!isNum(epochStartMs) || !isNum(minutes)) return null;
  return addMinutes(epochStartMs, minutes);
}

/** Serialize a Date from epoch millis in ISO */
function toISO(epochMs) {
  try {
    return new Date(epochMs).toISOString();
  } catch {
    return null;
  }
}

/* --------------------------------- Public API ------------------------------- */
/**
 * Backplan a schedule from a fixed deadline.
 *
 * @param {Array} tasks - task array (see dag.js typedef for Task)
 * @param {Array} links - link array (see dag.js typedef for Link)
 * @param {Object} opts
 *   - deadline: Date | ISO string | epoch ms | { iso|epoch|date } (required)
 *   - anchor?: "latest" | "earliest"  // choose LS (default) or ES as planned start
 *   - export?: boolean                 // when true, emit scheduling.plan.generated and export to Hub if enabled
 *   - planMeta?: object                // metadata for analytics/export
 *   - tzOffsetMinutes?: number         // optional: if provided, annotate times with this tz offset (no conversion done here)
 *
 * @returns {Promise<{
 *   order: string[] | null,
 *   schedule: Map<string, {
 *     id: string,
 *     es: number, ef: number, ls: number, lf: number, slack: number,
 *     level: number, critical: boolean,
 *     plannedStartMin: number, plannedFinishMin: number,
 *     plannedStartISO?: string, plannedFinishISO?: string
 *   }> | null,
 *   criticalPath: string[],
 *   makespan: number,
 *   planStartISO?: string,
 *   planEndISO?: string,
 *   graph: any
 * }>}
 */
async function backplanSchedule(tasks = [], links = [], opts = {}) {
  const source = "engines/scheduling/planner/backplanner.backplanSchedule";
  const { deadline, anchor = "latest" } = opts;

  // Defensive checks
  if (!dag || !dag.planSchedule) {
    emit("scheduling.backplan.error", source, {
      message: "DAG planner unavailable.",
    });
    return {
      order: null,
      schedule: null,
      criticalPath: [],
      makespan: 0,
      graph: null,
    };
  }
  const deadlineMs = parseDeadline(deadline);
  if (deadlineMs == null) {
    emit("scheduling.backplan.error", source, {
      message: "Invalid or missing deadline.",
    });
    return {
      order: null,
      schedule: null,
      criticalPath: [],
      makespan: 0,
      graph: null,
    };
  }

  // Build DAG & compute windows (relative minutes)
  const graph = dag.buildGraph(tasks, links);
  if (!graph.order) {
    // cycle event already emitted
    emit("scheduling.backplan.error", source, {
      message: "Cycle detected; cannot backplan.",
    });
    return {
      order: null,
      schedule: null,
      criticalPath: [],
      makespan: 0,
      graph,
    };
  }
  const { schedule, makespan } = dag.computeTimes(graph.nodesById, graph.order);
  const criticalPath = dag.findCriticalPath(
    graph.nodesById,
    graph.order,
    schedule
  );

  // Anchor plan: planEnd is the given deadline; planStart is deadline - makespan
  const planEndMs = deadlineMs;
  const planStartMs = addMinutes(planEndMs, -makespan);

  // Decide planned starts:
  //  - "latest": use LS (latest start) so you start as late as possible and still finish by deadline
  //  - "earliest": use ES (earliest start) to maximize buffer before deadline
  const useLatest = String(anchor).toLowerCase() !== "earliest";

  // Materialize an augmented schedule (Map) with planned absolute times
  const augmented = new Map();
  for (const [id, row] of schedule) {
    const plannedStartMin = useLatest ? row.ls : row.es;
    const plannedFinishMin = useLatest ? row.lf : row.ef;

    const absStartMs = toAbsolute(planStartMs, plannedStartMin);
    const absFinishMs = toAbsolute(planStartMs, plannedFinishMin);

    augmented.set(id, {
      ...row,
      plannedStartMin,
      plannedFinishMin,
      plannedStartISO: absStartMs != null ? toISO(absStartMs) : undefined,
      plannedFinishISO: absFinishMs != null ? toISO(absFinishMs) : undefined,
    });
  }

  const payload = {
    nodes: graph.nodesById.size,
    edges: countEdges(graph.nodesById),
    order: graph.order,
    makespan,
    criticalPath,
    planMeta: opts.planMeta || {},
    planStartISO: toISO(planStartMs),
    planEndISO: toISO(planEndMs),
    anchor: useLatest ? "latest" : "earliest",
    schedule: serializeSchedule(augmented),
    tzOffsetMinutes: isNum(opts.tzOffsetMinutes)
      ? opts.tzOffsetMinutes
      : undefined,
  };

  emit("scheduling.backplan.computed", source, payload);

  // If caller indicates this constitutes a generated plan for execution,
  // emit a plan-generated event and optionally export to hub.
  if (opts.export === true) {
    emit("scheduling.plan.generated", source, payload);
    await exportToHubIfEnabled({ action: "plan.generated", ...payload });
  }

  return {
    order: graph.order,
    schedule: augmented,
    criticalPath,
    makespan,
    planStartISO: payload.planStartISO,
    planEndISO: payload.planEndISO,
    graph,
  };
}

/* -------------------------------- Internals -------------------------------- */

function countEdges(nodesById) {
  let edges = 0;
  for (const [, n] of nodesById) {
    edges += (n.successors || []).length;
  }
  return edges;
}

function serializeSchedule(schedMap) {
  const arr = [];
  for (const [id, r] of schedMap) {
    arr.push({
      id,
      es: r.es,
      ef: r.ef,
      ls: r.ls,
      lf: r.lf,
      slack: r.slack,
      level: r.level,
      critical: r.critical,
      plannedStartMin: r.plannedStartMin,
      plannedFinishMin: r.plannedFinishMin,
      plannedStartISO: r.plannedStartISO,
      plannedFinishISO: r.plannedFinishISO,
    });
  }
  return arr;
}

/* --------------------------------- Exports ---------------------------------- */
module.exports = {
  backplanSchedule,
};
