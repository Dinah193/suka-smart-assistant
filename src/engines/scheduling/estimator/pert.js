// C:\Users\larho\suka-smart-assistant\src\engines\scheduling\estimator\pert.js
// PERT math: O/M/P → Expected (E) & σ; step and path estimation
// -----------------------------------------------------------------------------
// ROLE IN PIPELINE
// imports → intelligence → automation → (optional) hub export
//                               └─ this module turns step-level estimates
//                                  (optimistic / most likely / pessimistic)
//                                  into schedule-ready statistics used by
//                                  the session planner & calendar writer.
//
// What this module does
// ---------------------
// • Pure PERT helpers:  estimateStepPERT, estimateStepsPERT, estimatePathPERT
// • Graph (DAG) critical path by expected minutes (CPM on PERT means)
// • Aggregation of variance across a path (σ_path = sqrt(sum σ_i^2))
// • Confidence bands using normal approx (E + z·σ) for 50/68/80/85/90/95%
// • Event glue:
//     - respond("estimator/pert/estimateStep")   → { ok, stat }
//     - respond("estimator/pert/estimateSteps")  → { ok, stat }
//     - respond("estimator/pert/estimatePath")   → { ok, stat }
//     - on("session/draftReady")                 → emits "session/estimateReady"
//                                                 with canonical payload.
// NOTES
// -----
// • This module does not change household data → no Hub export from here.
// • Inputs are minutes. If hours provided, we convert defensively.
// • Missing O/M/P? We infer using sane heuristics from `estMin` or `M`.
// -----------------------------------------------------------------------------

/* --------------------------------- Imports --------------------------------- */
let eventBus, Events;
try {
  const eb = require("@/services/events/eventBus.js");
  eventBus = eb;
  Events = eb.Events || {};
} catch {
  try {
    const eb = require("@/services/events/eventBus.js");
    eventBus = eb;
    Events = eb.Events || {};
  } catch {
    eventBus = { emit: () => {}, on: () => () => {}, respond: () => () => {} };
    Events = {};
  }
}

/* -------------------------------- Constants -------------------------------- */
const SOURCE = "estimator.pert";
// z-scores for one-tailed completion by probability (Normal approx)
const Z = Object.freeze({
  0.5: 0.0, // median ~ mean for symmetric approx
  0.68: 0.468, // P(T<=E+zσ)≈0.84 two-tailed band center → use half-band for ETA
  0.8: 0.842,
  0.85: 1.036,
  0.9: 1.282,
  0.95: 1.645,
});

/* ------------------------------- Public API -------------------------------- */
/**
 * Estimate a single step via PERT.
 * Input shape (minutes): { o, m, p } OR { optimistic, mostLikely, pessimistic }.
 * Falls back to { estMin } or { minutes } with heuristics.
 */
export function estimateStepPERT(step = {}) {
  const { o, m, p } = coerceOMP(step);
  if (!(isFinitePos(o) && isFinitePos(m) && isFinitePos(p))) {
    return { ok: false, error: "Invalid O/M/P for step", input: small(step) };
  }
  const E = (o + 4 * m + p) / 6;
  const variance = Math.pow((p - o) / 6, 2);
  const sigma = Math.sqrt(variance);
  return {
    ok: true,
    stat: { o, m, p, E, variance, sigma },
  };
}

/**
 * Estimate an ordered list of steps (independent, serial).
 * Steps may include { o,m,p } or { estMin } or { minutes }.
 * Returns aggregate + per-step stats.
 */
export function estimateStepsPERT(steps = []) {
  if (!Array.isArray(steps)) return { ok: false, error: "steps must be array" };
  const per = [];
  let sumE = 0,
    sumVar = 0;

  for (let idx = 0; idx < steps.length; idx++) {
    const s = steps[idx] || {};
    const r = estimateStepPERT(s);
    if (!r.ok) return { ok: false, error: `step[${idx}]: ${r.error}` };
    per.push({
      idx: idx + 1,
      label: String(s.label || `Step ${idx + 1}`),
      ...r.stat,
    });
    sumE += r.stat.E;
    sumVar += r.stat.variance;
  }
  const sigma = Math.sqrt(sumVar);
  return {
    ok: true,
    stat: {
      E: sumE,
      variance: sumVar,
      sigma,
      steps: per,
      bands: confidenceBands(sumE, sigma),
    },
  };
}

/**
 * Estimate a path on a DAG (critical path by E).
 * nodes: [{ id, label?, o?, m?, p?, estMin? }]
 * edges: [{ from, to }]
 *
 * Returns critical path ordered node ids, expected minutes, σ, variance,
 * and per-node stats. Cycles are rejected.
 */
export function estimatePathPERT({ nodes = [], edges = [] } = {}) {
  if (!Array.isArray(nodes) || !Array.isArray(edges)) {
    return { ok: false, error: "nodes and edges must be arrays" };
  }
  const idToNode = new Map(nodes.map((n) => [String(n.id), n]));
  // Per-node PERT stats
  const sMap = new Map();
  for (const n of nodes) {
    const r = estimateStepPERT(n);
    if (!r.ok) return { ok: false, error: `node "${n.id}": ${r.error}` };
    sMap.set(String(n.id), r.stat);
  }

  // Build adjacency and indegree
  const adj = new Map();
  const indeg = new Map();
  for (const n of nodes) {
    adj.set(String(n.id), []);
    indeg.set(String(n.id), 0);
  }
  for (const e of edges) {
    const u = String(e.from),
      v = String(e.to);
    if (!adj.has(u) || !adj.has(v))
      return { ok: false, error: `edge references unknown node (${u}→${v})` };
    adj.get(u).push(v);
    indeg.set(v, (indeg.get(v) || 0) + 1);
  }

  // Topological order (Kahn); detect cycles
  const q = [];
  for (const [id, d] of indeg) if (d === 0) q.push(id);
  const topo = [];
  while (q.length) {
    const id = q.shift();
    topo.push(id);
    for (const v of adj.get(id)) {
      indeg.set(v, indeg.get(v) - 1);
      if (indeg.get(v) === 0) q.push(v);
    }
  }
  if (topo.length !== nodes.length)
    return { ok: false, error: "graph contains a cycle" };

  // Longest path by expected time; accumulate variance along chosen path only
  const bestE = new Map(); // id -> max expected path E to this node
  const bestVar = new Map(); // id -> matching path variance
  const prev = new Map(); // id -> predecessor id on best path

  for (const id of topo) {
    const { E, variance } = sMap.get(id);
    // Initialize with node's own E,Var
    if (!bestE.has(id)) {
      bestE.set(id, E);
      bestVar.set(id, variance);
    } else {
      bestE.set(id, bestE.get(id) + E);
      bestVar.set(id, bestVar.get(id) + variance);
    }
    // Relax edges
    for (const v of adj.get(id)) {
      const candE = bestE.get(id) + sMap.get(v).E;
      const candVar = bestVar.get(id) + sMap.get(v).variance;
      if (!bestE.has(v) || candE > bestE.get(v)) {
        bestE.set(v, candE);
        bestVar.set(v, candVar);
        prev.set(v, id);
      }
    }
  }

  // Sink with largest E
  let sink = null,
    maxE = -Infinity;
  for (const id of topo) {
    if ((adj.get(id) || []).length === 0) {
      const e = bestE.get(id) ?? sMap.get(id).E;
      if (e > maxE) {
        maxE = e;
        sink = id;
      }
    }
  }
  if (!sink) sink = topo[topo.length - 1];

  // Reconstruct critical path
  const pathIds = [];
  let cur = sink;
  while (cur) {
    pathIds.push(cur);
    cur = prev.get(cur);
  }
  pathIds.reverse();

  // Aggregate stats along critical path only
  let E_sum = 0,
    Var_sum = 0;
  const per = [];
  for (const id of pathIds) {
    const n = idToNode.get(id);
    const st = sMap.get(id);
    per.push({ id, label: String(n?.label || id), ...st });
    E_sum += st.E;
    Var_sum += st.variance;
  }
  const sigma = Math.sqrt(Var_sum);

  return {
    ok: true,
    stat: {
      path: pathIds,
      E: E_sum,
      variance: Var_sum,
      sigma,
      steps: per,
      bands: confidenceBands(E_sum, sigma),
    },
  };
}

/**
 * Convenience: Estimate a session draft (serial steps) and emit a bus signal.
 * Accepts the SSA canonical session draft shape (id, steps[], durationMin?…).
 */
export function estimateSessionDraft(session = {}) {
  const steps = Array.isArray(session?.steps) ? session.steps : [];
  const est = estimateStepsPERT(steps);
  if (!est.ok) return est;
  const result = {
    sessionId: String(session?.id || ""),
    domain: String(session?.domain || "general"),
    title: String(session?.title || ""),
    ...est.stat,
  };
  emit("session/estimateReady", result, { sticky: true });
  return { ok: true, stat: result };
}

/* --------------------------------- Glue (bus) ------------------------------- */
export function initPERT() {
  // RPCs
  eventBus.respond?.("estimator/pert/estimateStep", async (payload) => {
    const r = estimateStepPERT(payload || {});
    return r.ok ? r : { ok: false, error: r.error };
  });
  eventBus.respond?.("estimator/pert/estimateSteps", async (payload) => {
    const r = estimateStepsPERT(payload?.steps || payload || []);
    return r.ok ? r : { ok: false, error: r.error };
  });
  eventBus.respond?.("estimator/pert/estimatePath", async (payload) => {
    const r = estimatePathPERT(payload || {});
    return r.ok ? r : { ok: false, error: r.error };
  });

  // Auto-estimate when a draft is produced (adapters already emit draftReady)
  eventBus.on?.(
    Events?.SESSION_DRAFT_READY || "session/draftReady",
    ({ data }) => {
      try {
        estimateSessionDraft(data?.draft || data);
      } catch {}
    },
    { priority: -2 }
  );
}

/* --------------------------------- Helpers --------------------------------- */
function coerceOMP(s) {
  // Accept step fields in a few shapes. Prefer minutes.
  const O = pickNum(
    s.o,
    s.optimistic,
    hoursToMin(s.o_h),
    scaleAround(s.estMin, 0.8),
    scaleAround(s.minutes, 0.8)
  );
  const M = pickNum(s.m, s.mostLikely, hoursToMin(s.m_h), s.estMin, s.minutes);
  const P = pickNum(
    s.p,
    s.pessimistic,
    hoursToMin(s.p_h),
    scaleAround(s.estMin, 1.25),
    scaleAround(s.minutes, 1.25)
  );
  // Ensure sane ordering: O ≤ M ≤ P (nudged if needed)
  let o = clampPos(O),
    m = clampPos(M),
    p = clampPos(P);
  if (o > m) m = o;
  if (m > p) p = m;
  return { o, m, p };
}
function hoursToMin(h) {
  return isFinitePos(h) ? h * 60 : undefined;
}
function scaleAround(n, f) {
  return isFinitePos(n) ? n * f : undefined;
}
function pickNum(...vals) {
  for (const v of vals) if (isFinitePos(v)) return +v;
  return undefined;
}
function clampPos(n) {
  return isFinitePos(n) ? Math.max(0.1, +n) : undefined;
}
function isFinitePos(n) {
  return Number.isFinite(+n) && +n > 0;
}
function small(x) {
  try {
    const s = JSON.stringify(x);
    return s.length > 400 ? s.slice(0, 400) + "…" : s;
  } catch {
    return "[unserializable]";
  }
}

function confidenceBands(E, sigma) {
  const out = {};
  for (const k of Object.keys(Z)) {
    const p = Number(k);
    out[k] = E + Z[k] * sigma;
  }
  return out; // minutes
}

function emit(type, data, opts) {
  eventBus.emit?.(type, data, { source: SOURCE, ...(opts || {}) });
}

/* ---------------------------------- Exports -------------------------------- */
export default {
  // init glue
  initPERT,
  // primitives
  estimateStepPERT,
  estimateStepsPERT,
  estimatePathPERT,
  estimateSessionDraft,
};
