// C:\Users\larho\suka-smart-assistant\src\engines\scheduling\estimator\monteCarlo.js
// Monte Carlo sampling for schedule confidence (p50 / p80 / p95)
// -----------------------------------------------------------------------------
// ROLE IN PIPELINE
// imports → intelligence → automation → (optional) hub export
//                               └─ this module simulates session durations
//                                  using Monte Carlo sampling over O/M/P step
//                                  estimates to produce confidence bands used
//                                  by the planner and calendar writer.
//
// What this module does
// ---------------------
// • Triangular & (modified) PERT-beta sampling from O/M/P per step
// • Serial steps simulation: total minutes distribution -> p50/p80/p95
// • DAG critical-path simulation (CPM with random durations)
// • Deterministic seeding for reproducible planning (Mulberry32 PRNG)
// • Event glue:
//     - respond("estimator/monte/runSteps") → { ok, stat }
//     - respond("estimator/monte/runPath")  → { ok, stat }
//     - on("session/draftReady")            → emits "session/monteReady"
// • Defensive: clamps inputs; falls back if O/M/P missing
//
// Notes
// -----
// • This module does not directly change household data; no Hub export here.
// • Inputs and outputs are in minutes.
// -----------------------------------------------------------------------------

/* --------------------------------- Imports --------------------------------- */
let eventBus, Events;
try {
  const eb = require("@/services/events/eventBus.js");
  eventBus = eb;
  Events = eb.Events || {};
} catch {
  try {
    const eb = require("@/services/eventBus.js");
    eventBus = eb;
    Events = eb.Events || {};
  } catch {
    eventBus = { emit: () => {}, on: () => () => {}, respond: () => () => {} };
    Events = {};
  }
}

/* -------------------------------- Constants -------------------------------- */
const SOURCE = "estimator.monte";
const DEFAULT_RUNS = 5000;     // good trade-off speed/accuracy
const MAX_RUNS = 200000;       // guardrail
const PERT_LAMBDA = 4;         // modified-pert shape (β-mean closer to M)

/* ------------------------------- Public API -------------------------------- */
/**
 * Run Monte Carlo for a serial list of steps.
 * Each step can be:
 *   { o, m, p } or { optimistic, mostLikely, pessimistic } or { estMin|minutes }
 * options: { runs?:number, dist?:"pert"|"tri", lambda?:number, seed?:number }
 */
export function runStepsMonteCarlo(steps = [], options = {}) {
  if (!Array.isArray(steps)) return { ok: false, error: "steps must be array" };
  const { runs, dist, lambda, seed } = normalizeOptions(options);
  const rng = mulberry32(seed);
  const sampler = buildSampler(dist, lambda);

  // Pre-coerce O/M/P for performance
  const omp = steps.map((s, i) => coerceOMP(s, i));

  // Simulate
  const totals = new Float64Array(runs);
  for (let r = 0; r < runs; r++) {
    let sum = 0;
    for (let i = 0; i < omp.length; i++) {
      const { o, m, p } = omp[i];
      sum += sampler(rng, o, m, p);
    }
    totals[r] = sum;
  }

  const stat = summarizeSamples(totals);
  return { ok: true, stat: { ...stat, runs, dist: dist || "pert", lambda: lambda ?? PERT_LAMBDA } };
}

/**
 * Run Monte Carlo for a DAG path (critical path distribution).
 * graph: { nodes:[{id,label?,o?,m?,p?,estMin?}], edges:[{from,to}] }
 * options: { runs?:number, dist?:"pert"|"tri", lambda?:number, seed?:number }
 */
export function runPathMonteCarlo(graph = {}, options = {}) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  if (!nodes.length) return { ok: false, error: "graph.nodes required" };

  // topo sort + validate edges
  const { ok, error, topo, adj, indeg } = topoSort(nodes, edges);
  if (!ok) return { ok, error };

  const { runs, dist, lambda, seed } = normalizeOptions(options);
  const rng = mulberry32(seed);
  const sampler = buildSampler(dist, lambda);

  // Map: id -> OMP sampler inputs
  const omp = new Map(nodes.map(n => [String(n.id), coerceOMP(n)]));

  // Simulate critical path duration
  const totals = new Float64Array(runs);
  for (let r = 0; r < runs; r++) {
    // draw durations for all nodes this run
    const dur = new Map(); // id -> minutes
    for (const id of topo) {
      const { o, m, p } = omp.get(id);
      dur.set(id, sampler(rng, o, m, p));
    }
    // CPM longest-path over DAG (expected → sampled per run)
    const longest = new Map(); // id -> max finish time
    for (const id of topo) {
      // compute start time = max of predecessors' finish; derive from edges^-1
      let startT = 0;
      for (const k of indeg.keys()) {} // NOOP, using reverse scan below
      // We don't have reverse adjacency; compute from incoming edges quickly:
      // Build incoming adjacency one-time from 'edges'
    }
  }

  // Build incoming adjacency once (outside loop)
  const incoming = new Map();
  for (const n of nodes) incoming.set(String(n.id), []);
  for (const e of edges) incoming.get(String(e.to)).push(String(e.from));

  for (let r = 0; r < runs; r++) {
    const dur = new Map();
    for (const id of topo) {
      const { o, m, p } = omp.get(id);
      dur.set(id, sampler(rng, o, m, p));
    }
    const finish = new Map();
    for (const id of topo) {
      const preds = incoming.get(id) || [];
      let start = 0;
      for (const u of preds) {
        start = Math.max(start, finish.get(u) || 0);
      }
      finish.set(id, start + (dur.get(id) || 0));
    }
    // project duration = max finish of sinks
    let total = 0;
    for (const id of topo) {
      // sink if not in any incoming list of others (i.e., no outgoing)
      if (!adj.get(id)?.length) total = Math.max(total, finish.get(id) || 0);
    }
    totals[r] = total;
  }

  const stat = summarizeSamples(totals);
  return { ok: true, stat: { ...stat, runs, dist: dist || "pert", lambda: lambda ?? PERT_LAMBDA } };
}

/**
 * Convenience: Simulate a session draft (serial steps) and emit a bus signal.
 */
export function simulateSessionDraft(session = {}, options = {}) {
  const steps = Array.isArray(session?.steps) ? session.steps : [];
  const res = runStepsMonteCarlo(steps, options);
  if (!res.ok) return res;
  const out = {
    sessionId: String(session?.id || ""),
    domain: String(session?.domain || "general"),
    title: String(session?.title || ""),
    ...res.stat,
  };
  emit("session/monteReady", out, { sticky: true });
  return { ok: true, stat: out };
}

/* --------------------------------- Glue (bus) ------------------------------- */
export function initMonteCarlo() {
  // RPCs
  eventBus.respond?.("estimator/monte/runSteps", async (payload) => {
    const { steps, options } = payload?.steps ? payload : { steps: payload };
    const r = runStepsMonteCarlo(steps || [], options || {});
    return r.ok ? r : { ok: false, error: r.error };
  });
  eventBus.respond?.("estimator/monte/runPath", async (payload) => {
    const r = runPathMonteCarlo(payload || {});
    return r.ok ? r : { ok: false, error: r.error };
  });

  // Auto-simulate when a draft is produced
  eventBus.on?.(Events?.SESSION_DRAFT_READY || "session/draftReady", ({ data }) => {
    try { simulateSessionDraft(data?.draft || data, { runs: 3000 }); } catch {}
  }, { priority: -3 });
}

/* --------------------------------- Internals -------------------------------- */
// --- Options / RNG ---
function normalizeOptions({ runs = DEFAULT_RUNS, dist = "pert", lambda = PERT_LAMBDA, seed } = {}) {
  const n = clampInt(runs, 100, MAX_RUNS);
  return { runs: n, dist, lambda, seed: seed != null ? seed|0 : hashSeed(`${Date.now()}`) };
}
function mulberry32(seed) {
  let t = (seed | 0) >>> 0;
  return function rand() {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296; // [0,1)
  };
}
function hashSeed(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// --- Samplers ---
function buildSampler(dist = "pert", lambda = PERT_LAMBDA) {
  if (dist === "tri" || dist === "triangular") {
    return (rng, o, m, p) => sampleTriangular(rng, o, m, p);
  }
  // default: modified PERT (beta over [o,p] with α,β from m & lambda)
  return (rng, o, m, p) => samplePERT(rng, o, m, p, lambda);
}

function sampleTriangular(rng, a, c, b) {
  // a=o, c=m, b=p
  if (!(a <= c && c <= b)) { c = clamp(c, a, b); }
  const u = rng();
  const F = (c - a) / (b - a || 1e-9);
  if (u < F) return a + Math.sqrt(u * (b - a) * (c - a));
  return b - Math.sqrt((1 - u) * (b - a) * (b - c));
}

function samplePERT(rng, o, m, p, lambda = PERT_LAMBDA) {
  // Modified PERT: mean = (o + lambda*m + p) / (lambda + 2)
  if (!(o <= m && m <= p)) { m = clamp(m, o, p); }
  const mean = (o + lambda * m + p) / (lambda + 2);
  const range = p - o;
  const alpha = 1 + ((lambda * (mean - o)) / (range || 1e-9));
  const beta = 1 + ((lambda * (p - mean)) / (range || 1e-9));
  const x = sampleBeta(rng, Math.max(1e-6, alpha), Math.max(1e-6, beta)); // in (0,1)
  return o + x * range;
}

function sampleBeta(rng, a, b) {
  // Marsaglia & Tsang Gamma sampler; Beta(a,b) = G(a,1)/(G(a,1)+G(b,1))
  const x = sampleGamma(rng, a);
  const y = sampleGamma(rng, b);
  return x / (x + y);
}

function sampleGamma(rng, k) {
  // k > 0, θ=1
  if (k < 1) {
    // Johnk's generator: Gamma(k) = Gamma(k+1)*U^(1/k)
    const u = rng();
    return sampleGamma(rng, k + 1) * Math.pow(u, 1 / k);
  }
  // Marsaglia-Tsang for k >= 1
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x, v;
    do {
      // Standard normal via Box-Muller
      const u1 = rng() || 1e-12, u2 = rng() || 1e-12;
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

// --- Inputs ---
function coerceOMP(s = {}, idx = 0) {
  // Accept fields in multiple shapes; prefer minutes
  const O = firstNum(s.o, s.optimistic, hoursToMin(s.o_h), scaleAround(s.estMin, 0.8), scaleAround(s.minutes, 0.8), 1);
  const M = firstNum(s.m, s.mostLikely, hoursToMin(s.m_h), s.estMin, s.minutes, O * 1.25);
  const P = firstNum(s.p, s.pessimistic, hoursToMin(s.p_h), scaleAround(s.estMin, 1.6), scaleAround(s.minutes, 1.6), M * 1.5);

  let o = clampPos(O), m = clampPos(M), p = clampPos(P);
  if (!(o <= m && m <= p)) {
    // nudge into order
    m = Math.max(o, Math.min(m, p));
    p = Math.max(m, p);
  }
  // Very small spread is non-informative; widen slightly for stability
  if (p - o < 0.5) { o = Math.max(0.1, o - 0.25); p = p + 0.25; }
  return { o, m, p, label: String(s.label || `Step ${idx + 1}`) };
}

function hoursToMin(h) { return isFinite(h) ? h * 60 : undefined; }
function scaleAround(n, f) { return isFinite(n) ? n * f : undefined; }
function firstNum(...vals) { for (const v of vals) if (isFinite(v)) return +v; return undefined; }
function isFinite(n) { return Number.isFinite(+n); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function clampPos(n) { return isFinite(n) ? Math.max(0.1, +n) : 1; }
function small(x) { try { const s = JSON.stringify(x); return s.length > 400 ? s.slice(0, 400) + "…" : s; } catch { return "[unserializable]"; } }
function clampInt(n, lo, hi) {
  const v = Math.round(+n || 0);
  return Math.max(lo, Math.min(hi, v));
}

// --- Graph utils ---
function topoSort(nodes, edges) {
  const idSet = new Set(nodes.map(n => String(n.id)));
  const adj = new Map(); const indeg = new Map();
  for (const n of nodes) { adj.set(String(n.id), []); indeg.set(String(n.id), 0); }
  for (const e of edges) {
    const u = String(e.from), v = String(e.to);
    if (!idSet.has(u) || !idSet.has(v)) return { ok: false, error: `edge references unknown node (${u}→${v})` };
    adj.get(u).push(v);
    indeg.set(v, (indeg.get(v) || 0) + 1);
  }
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
  if (topo.length !== nodes.length) return { ok: false, error: "graph contains a cycle" };
  return { ok: true, topo, adj, indeg };
}

// --- Stats ---
function summarizeSamples(arr /* Float64Array */) {
  const n = arr.length;
  // mean & stddev (one-pass Welford)
  let mean = 0, M2 = 0;
  for (let i = 0; i < n; i++) {
    const x = arr[i];
    const d = x - mean;
    mean += d / (i + 1);
    M2 += d * (x - mean);
  }
  const variance = n > 1 ? M2 / (n - 1) : 0;
  const sigma = Math.sqrt(variance);

  // approximate percentiles: copy + nth_element-ish; for n<=20k we can sort
  const sorted = Array.from(arr).sort((a, b) => a - b);
  const pct = (p) => sorted[Math.max(0, Math.min(n - 1, Math.floor(p * (n - 1))))];
  const p50 = pct(0.50), p80 = pct(0.80), p90 = pct(0.90), p95 = pct(0.95);

  // small histogram (sparks): 9 buckets
  const hist = histogram(sorted, 9);

  return {
    mean,
    sigma,
    variance,
    p50, p80, p90, p95,
    min: sorted[0],
    max: sorted[n - 1],
    histogram: hist,
  };
}

function histogram(sorted, buckets = 9) {
  const n = sorted.length;
  const lo = sorted[0], hi = sorted[n - 1] || lo;
  if (hi <= lo) return [{ from: lo, to: hi, n }];
  const w = (hi - lo) / buckets;
  const out = [];
  let j = 0;
  for (let b = 0; b < buckets; b++) {
    const from = lo + b * w;
    const to = b === buckets - 1 ? hi : lo + (b + 1) * w;
    let c = 0;
    while (j < n && sorted[j] <= to) { c++; j++; }
    out.push({ from, to, n: c });
  }
  return out;
}

function emit(type, data, opts) {
  eventBus.emit?.(type, data, { source: SOURCE, ...(opts || {}) });
}

/* --------------------------------- Exports --------------------------------- */
export default {
  initMonteCarlo,
  runStepsMonteCarlo,
  runPathMonteCarlo,
  simulateSessionDraft,
};
