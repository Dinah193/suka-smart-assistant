// C:\Users\larho\suka-smart-assistant\src\engines\scheduling\planner\dag.js
/**
 * Scheduling Planner — DAG Builder & Critical Path
 * ------------------------------------------------------------
 * Role in pipeline:
 *  imports → intelligence (estimators/calibration) → automation (sessions via DAG planner) → (optional) hub export
 *
 * What this file does:
 *  - Builds a domain-agnostic Directed Acyclic Graph (DAG) of tasks.
 *  - Validates input (tasks & links), detects cycles, and returns a topological order.
 *  - Computes Early Start/Finish (ES/EF), Late Start/Finish (LS/LF), and slack.
 *  - Finds the Critical Path (max-duration path) across the plan.
 *  - Emits structured planning events to the shared eventBus.
 *  - Optionally exports generated session plans to the Family Fund Hub when enabled.
 *
 * Domains supported:
 *  - cooking, cleaning, garden, animals, preservation, storehouse, generic (extensible).
 *
 * Event payload shape:
 *  { type, ts, source, data }
 *
 * Emitted events:
 *  - scheduling.dag.built
 *  - scheduling.dag.cycleDetected
 *  - scheduling.dag.criticalPath.computed
 *  - scheduling.plan.generated (when opts.export === true)
 */

"use strict";

/* --------------------------------- Imports --------------------------------- */

let eventBus = {
  emit: (...a) => console.debug("[planner:dag:eventBus.emit]", ...a),
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

/* ------------------------------ Local Helpers ------------------------------ */

const nowISO = () => new Date().toISOString();
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
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

/* --------------------------------- Types -----------------------------------
Task (input):
{
  id: string,
  title?: string,
  domain?: "cooking"|"cleaning"|"garden"|"animals"|"preservation"|"storehouse"|"generic",
  duration?: number,                // minutes — if missing, avg(durationMin, durationMax)
  durationMin?: number,
  durationMax?: number,
  effortScore?: number,
  resources?: { [name:string]: number },
  requires?: string[]               // optional inline dependencies (task ids)
}

Link (input):
{
  from: string,   // predecessor task id
  to: string,     // successor task id
  type?: "FS"|"SS"|"FF"|"SF", // default "FS" (Finish→Start); others supported as zero-lag for now
  lag?: number    // minutes; positive or zero; default 0
}

Node (internal):
{
  ...task,
  duration: number,     // resolved minutes
  predecessors: Array<{ id, type, lag }>,
  successors: Array<{ id, type, lag }>
}

Schedule (output per task):
{
  id,
  es, ef, ls, lf, slack, // minutes from plan start (0)
  level,                 // topological rank
  critical: boolean
}
------------------------------------------------------------------------------*/

/* ------------------------------ Public API --------------------------------- */

/**
 * Builds a normalized graph from tasks + links.
 * - Merges inline `requires` into links.
 * - Validates task ids, dedupes, and sets resolved duration.
 * - Returns { nodesById, order, roots } where `order` is topologically sorted or null if cycle.
 */
function buildGraph(tasks = [], links = []) {
  const source = "engines/scheduling/planner/dag.buildGraph";

  // Defensive copies
  const taskList = Array.isArray(tasks) ? tasks.map(clone) : [];
  const linkList = Array.isArray(links) ? links.map(clone) : [];

  // Index tasks
  const nodesById = new Map();
  for (const t of taskList) {
    if (!t || typeof t.id !== "string" || !t.id.trim()) continue;
    const id = t.id.trim();
    if (nodesById.has(id)) {
      // Prefer first, merge some metadata (no throw)
      const existing = nodesById.get(id);
      nodesById.set(id, { ...existing, ...t });
    } else {
      nodesById.set(id, t);
    }
  }

  // Early exit
  if (nodesById.size === 0) {
    const payload = { nodes: 0, links: 0 };
    emit("scheduling.dag.built", source, payload);
    return { nodesById: new Map(), order: [], roots: [] };
  }

  // Normalize durations and adjacency lists
  for (const [id, t] of nodesById) {
    const d = resolveDuration(t);
    t.duration = d >= 0 ? d : 0;
    t.predecessors = [];
    t.successors = [];
  }

  // Merge inline requires -> links
  for (const [, t] of nodesById) {
    if (Array.isArray(t.requires)) {
      for (const predIdRaw of t.requires) {
        const predId = String(predIdRaw || "").trim();
        if (!predId || !nodesById.has(predId)) continue;
        linkList.push({ from: predId, to: t.id, type: "FS", lag: 0 });
      }
    }
  }

  // Normalize links and populate adjacency
  const dedup = new Set();
  for (const L of linkList) {
    if (!L || !L.from || !L.to) continue;
    const from = String(L.from).trim();
    const to = String(L.to).trim();
    if (!nodesById.has(from) || !nodesById.has(to)) continue;
    const type = normalizeLinkType(L.type);
    const lag = isNum(L.lag) ? Math.max(0, L.lag) : 0;
    const key = `${from}→${to}(${type})@${lag}`;
    if (dedup.has(key)) continue;
    dedup.add(key);

    nodesById.get(from).successors.push({ id: to, type, lag });
    nodesById.get(to).predecessors.push({ id: from, type, lag });
  }

  // Identify roots (no predecessors)
  const roots = [];
  for (const [id, t] of nodesById) {
    if (!t.predecessors || t.predecessors.length === 0) {
      roots.push(id);
    }
  }

  // Topological sort (Kahn)
  const { order, cycle } = topoOrder(nodesById);
  if (cycle) {
    emit("scheduling.dag.cycleDetected", source, {
      message: "Cycle detected in task graph.",
      cycle,
    });
    return { nodesById, order: null, roots };
  }

  emit("scheduling.dag.built", source, {
    nodes: nodesById.size,
    edges: dedup.size,
    roots,
    order,
  });

  return { nodesById, order, roots };
}

/**
 * Computes ES/EF forward pass and LS/LF backward pass + slack.
 * Assumes acyclic graph & valid topological order.
 * Supports FS/SS/FF/SF with non-negative lag. (Lag applied per constraint conservatively.)
 */
function computeTimes(nodesById, order) {
  // Forward: ES/EF
  const sched = new Map();
  for (const id of order) {
    const node = nodesById.get(id);
    const dur = Math.max(0, node.duration || 0);

    let es = 0;
    if (Array.isArray(node.predecessors) && node.predecessors.length) {
      es = node.predecessors.reduce((acc, p) => {
        const pred = sched.get(p.id);
        if (!pred) return acc;

        const predDur = Math.max(0, nodesById.get(p.id)?.duration || 0);
        // Constraint translation (simplified, zero-negative lag):
        //  FS: start >= pred.finish + lag         -> esCand = pred.ef + lag
        //  SS: start >= pred.start + lag          -> esCand = pred.es + lag
        //  FF: finish >= pred.finish + lag        -> esCand = pred.ef + lag - dur
        //  SF: finish >= pred.start + lag         -> esCand = pred.es + lag - dur
        const lag = Math.max(0, p.lag || 0);
        let esCand = 0;
        switch (p.type) {
          case "SS":
            esCand = pred.es + lag;
            break;
          case "FF":
            esCand = pred.ef + lag - dur;
            break;
          case "SF":
            esCand = pred.es + lag - dur;
            break;
          case "FS":
          default:
            esCand = pred.ef + lag;
            break;
        }
        return Math.max(acc, esCand);
      }, 0);
    }

    const ef = es + dur;
    sched.set(id, {
      id,
      es,
      ef,
      ls: Infinity,
      lf: Infinity,
      slack: 0,
      level: 0,
      critical: false,
    });
  }

  // Assign levels (longest distance in edges count from roots)
  for (const id of order) {
    const node = nodesById.get(id);
    const entry = sched.get(id);
    if (!entry) continue;
    let level = 0;
    if (Array.isArray(node.predecessors) && node.predecessors.length) {
      level =
        node.predecessors.reduce((acc, p) => {
          const pred = sched.get(p.id);
          return Math.max(acc, (pred?.level ?? 0) + 1);
        }, 0) || 0;
    }
    entry.level = level;
  }

  // Project makespan
  const makespan = Math.max(...Array.from(sched.values(), (r) => r.ef));

  // Backward: LS/LF
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    const node = nodesById.get(id);
    const entry = sched.get(id);
    const dur = Math.max(0, node.duration || 0);

    if (!node.successors || node.successors.length === 0) {
      // For terminal nodes: LF = makespan, LS = LF - dur
      entry.lf = makespan;
      entry.ls = makespan - dur;
    } else {
      // For non-terminal: derive LF from successor constraints (conservative)
      const lfCand = node.successors.reduce((acc, s) => {
        const succ = sched.get(s.id);
        if (!succ) return acc;
        const lag = Math.max(0, s.lag || 0);
        // Inverse of forward constraints:
        //  FS: pred.finish <= succ.start - lag -> lfCand = min(lfCand, succ.ls - lag)
        //  SS: pred.start <= succ.start - lag  -> lsCand = min(lsCand, succ.ls - lag); then lf = ls + dur
        //  FF: pred.finish <= succ.finish - lag-> lfCand = min(lfCand, succ.lf - lag)
        //  SF: pred.start <= succ.finish - lag -> lsCand = min(lsCand, succ.lf - lag); then lf = ls + dur
        let lfC = acc;
        switch (s.type) {
          case "SS":
            lfC = Math.min(acc, succ.ls - lag + dur); // derive via ls then back to lf
            break;
          case "FF":
            lfC = Math.min(acc, succ.lf - lag);
            break;
          case "SF":
            lfC = Math.min(acc, succ.lf - lag + dur);
            break;
          case "FS":
          default:
            lfC = Math.min(acc, succ.ls - lag);
            break;
        }
        return lfC;
      }, Infinity);

      entry.lf = isFinite(lfCand) ? lfCand : makespan;
      entry.ls = entry.lf - dur;
    }

    entry.slack = Math.max(0, entry.ls - entry.es);
  }

  return { schedule: sched, makespan };
}

/**
 * Finds the critical path (all tasks with zero slack), returns ordered array of ids.
 * If multiple critical chains exist, returns one of the longest by EF progression.
 */
function findCriticalPath(nodesById, order, schedule) {
  const zeroSlack = order.filter((id) => {
    const r = schedule.get(id);
    return r && Math.abs(r.slack) < 1e-6;
  });

  if (zeroSlack.length === 0) return [];

  // Build adjacency restricted to zero-slack edges that respect ES/EF continuity
  const nexts = new Map();
  for (const id of zeroSlack) {
    nexts.set(id, []);
  }
  for (const id of zeroSlack) {
    const node = nodesById.get(id);
    const r = schedule.get(id);
    for (const s of node.successors || []) {
      if (!nexts.has(s.id)) continue;
      const rs = schedule.get(s.id);
      // On a pure FS chain, EF(id) == ES(s) for critical tasks; for other types,
      // use conservative check: successor.es ≈ predecessor.ef (+/- 1e-6 window).
      if (Math.abs((r?.ef || 0) - (rs?.es || 0)) < 1e-6) {
        nexts.get(id).push(s.id);
      }
    }
  }

  // Find the longest chain by EF accumulation
  let bestPath = [];
  const memo = new Map();

  function dfs(u) {
    if (memo.has(u)) return memo.get(u);
    const children = nexts.get(u) || [];
    if (children.length === 0) {
      memo.set(u, [u]);
      return [u];
    }
    let best = [u];
    let bestVal = schedule.get(u)?.ef || 0;
    for (const v of children) {
      const sub = dfs(v);
      const val = schedule.get(v)?.ef || 0;
      if (val >= bestVal) {
        bestVal = val;
        best = [u, ...sub];
      }
    }
    memo.set(u, best);
    return best;
  }

  for (const id of zeroSlack) {
    const path = dfs(id);
    if (path.length > bestPath.length) bestPath = path;
  }

  // Mark critical
  for (const id of bestPath) {
    const r = schedule.get(id);
    if (r) r.critical = true;
  }

  return bestPath;
}

/**
 * Convenience: Build DAG, compute schedule, find critical path.
 * @param {Array} tasks
 * @param {Array} links
 * @param {Object} opts { export?: boolean, planMeta?: object }
 * @returns {Object} { order, schedule: Map, criticalPath: string[], makespan, graph }
 */
async function planSchedule(tasks = [], links = [], opts = {}) {
  const source = "engines/scheduling/planner/dag.planSchedule";

  const graph = buildGraph(tasks, links);
  if (!graph.order) {
    // cycle event already emitted by buildGraph
    return {
      order: null,
      schedule: null,
      criticalPath: [],
      makespan: 0,
      graph,
    };
  }

  const { schedule, makespan } = computeTimes(graph.nodesById, graph.order);
  const criticalPath = findCriticalPath(graph.nodesById, graph.order, schedule);

  const payload = {
    nodes: graph.nodesById.size,
    edges: countEdges(graph.nodesById),
    order: graph.order,
    makespan,
    criticalPath,
    planMeta: opts.planMeta || {},
    schedule: serializeSchedule(schedule), // shallow numeric snapshot
  };

  emit("scheduling.dag.criticalPath.computed", source, payload);

  // If caller indicates this constitutes a generated plan for execution,
  // emit a plan-generated event and optionally export to hub.
  if (opts.export === true) {
    emit("scheduling.plan.generated", source, payload);
    await exportToHubIfEnabled({ action: "plan.generated", ...payload });
  }

  return { order: graph.order, schedule, criticalPath, makespan, graph };
}

/* -------------------------------- Internals -------------------------------- */

function normalizeLinkType(t) {
  const s = String(t || "FS").toUpperCase();
  return s === "SS" || s === "FF" || s === "SF" ? s : "FS";
}

function resolveDuration(task) {
  if (isNum(task.duration)) return Math.max(0, task.duration);
  const a = isNum(task.durationMin) ? task.durationMin : null;
  const b = isNum(task.durationMax) ? task.durationMax : null;
  if (a != null && b != null) return Math.max(0, (a + b) / 2);
  if (a != null) return Math.max(0, a);
  if (b != null) return Math.max(0, b);
  return 0;
}

/**
 * Kahn's algorithm for topological sort; returns cycle nodes if found.
 */
function topoOrder(nodesById) {
  const indeg = new Map();
  const q = [];

  for (const [id, n] of nodesById) {
    const deg = (n.predecessors || []).length;
    indeg.set(id, deg);
    if (deg === 0) q.push(id);
  }

  const order = [];
  while (q.length) {
    const u = q.shift();
    order.push(u);
    for (const s of nodesById.get(u).successors || []) {
      const v = s.id;
      indeg.set(v, (indeg.get(v) || 0) - 1);
      if (indeg.get(v) === 0) q.push(v);
    }
  }

  if (order.length !== nodesById.size) {
    // cycle suspected; return remaining nodes as a hint
    const cycle = [];
    for (const [id, deg] of indeg) {
      if (deg > 0) cycle.push(id);
    }
    return { order: null, cycle };
  }

  return { order, cycle: null };
}

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
    });
  }
  return arr;
}

/* --------------------------------- Exports ---------------------------------- */
module.exports = {
  buildGraph,
  computeTimes,
  findCriticalPath,
  planSchedule,
};
