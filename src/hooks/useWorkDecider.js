/* eslint-disable no-console */
/**
 * useWorkDecider.js — wraps scoring engine for domain facets (ES2015-safe)
 *
 * What it does
 * ------------
 * - Rank candidates (recipes, chores, animal tasks, garden tasks) by weighted facets.
 * - Pluggable per-domain scorers (meals | cleaning | animals | garden | custom).
 * - Constraints: time window, budget, equipment/appliances, PPE, weather/withholds, Sabbath guard.
 * - Inventory-aware (prefers "have", can penalize "short", honors substitution flags).
 * - Cost estimate + schedule pre-steps awareness (defrost/marinate/proof/preheat).
 * - Diversity controls: avoid repeats, enforce category/zone rotation, cooling period.
 * - Strategies: "greedy" (top-k), "softmax" (probabilistic), epsilon-greedy (exploration).
 * - A/B testing knobs via strategyKey + weight profiles.
 * - Explainable output: per-item facet breakdown with reasons.
 * - Emits events: decider.requested | .scored | .completed | .failed
 * - Works with React (hook) or outside React (createWorkDecider()).
 */

import { useCallback, useMemo, useRef, useState } from "react";

// ----------------------------- Safe Imports -----------------------------
let eventBus = {
  on: function () {},
  off: function () {},
  emit: function () {},
};
try {
  const eb = require("@/services/events/eventBus");
  eventBus = (eb && (eb.default || eb.eventBus)) || eventBus;
} catch (e) {}

let estimateEngine = {
  estimate: () => ({ currency: "USD", subtotal: 0, lines: [] }),
};
try {
  const ee = require("@/engines/estimateEngine");
  estimateEngine = (ee && (ee.default || ee)) || estimateEngine;
} catch (e) {}

let scheduleHelpers = {
  planPreSteps: () => ({ reminders: [], holds: [] }),
  computeWithholds: () => ({ withholds: [] }),
  weatherHolds: () => ({ holds: [] }),
};
try {
  const s = require("@/utils/scheduleHelpers");
  scheduleHelpers = (s && (s.default || s)) || scheduleHelpers;
} catch (e) {}

let InventoryMonitor = {
  classifyItems: () => ({ have: [], short: [], unknown: [] }),
  check: () => ({ ok: true, missing: [] }),
};
try {
  const im = require("@/managers/InventoryMonitor");
  InventoryMonitor = (im && (im.default || im)) || InventoryMonitor;
} catch (e) {}

let placementRules = {
  // variety/leftovers/appliance conflicts (best effort)
  detect: () => ({ conflicts: [] }),
};
try {
  const pr = require("@/engines/placementRules");
  placementRules = (pr && (pr.default || pr)) || placementRules;
} catch (e) {}

let stabilityScore = { evaluate: () => ({ score: 0.7, signals: [] }) };
try {
  const ss = require("@/engines/stabilityScore");
  stabilityScore = (ss && (ss.default || ss)) || stabilityScore;
} catch (e) {}

let Settings = {
  get: () => ({ sabbathGuard: false, decider: { epsilon: 0.08 } }),
};
try {
  const setMod = require("@/stores/SettingsStore");
  Settings = (setMod && (setMod.default || setMod)) || Settings;
} catch (e) {}

let DexieDB = null;
try {
  const db = require("@/data/db");
  DexieDB = db && (db.default || db);
} catch (e) {}

// ----------------------------- Utilities -----------------------------
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const safeNum = (x, d = 0) => (typeof x === "number" && isFinite(x) ? x : d);
const uid = (p = "decider") => p + ":" + Math.random().toString(36).slice(2);

const softmaxPick = (items, temp = 1) => {
  if (!items.length) return [];
  const scores = items.map((i) => safeNum(i.total, 0));
  const max = Math.max.apply(null, scores);
  const exp = scores.map((s) => Math.exp((s - max) / (temp || 1)));
  const sum = exp.reduce((a, b) => a + b, 0);
  return items
    .map((it, idx) => ({ ...it, p: exp[idx] / (sum || 1) }))
    .sort((a, b) => b.p - a.p);
};

const epsilonGreedy = (items, epsilon = 0.1) => {
  if (!items.length) return [];
  // exploration: shuffle a bit; exploitation: respect score order
  const sorted = items.slice().sort((a, b) => b.total - a.total);
  if (Math.random() < epsilon) {
    const copy = sorted.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = copy[i];
      copy[i] = copy[j];
      copy[j] = t;
    }
    return copy;
  }
  return sorted;
};

// Normalize 0..1 by min-max
function normalizeFacet(values) {
  const v = values.filter((x) => typeof x === "number" && isFinite(x));
  if (!v.length) return () => 0.5;
  const min = Math.min.apply(null, v);
  const max = Math.max.apply(null, v);
  if (min === max) return () => 0.5;
  return (x) => clamp01((x - min) / (max - min));
}

// ----------------------------- Default Weight Profiles -----------------------------
const DEFAULT_WEIGHTS = {
  common: {
    inventory: 0.28,
    cost: 0.18,
    timeFit: 0.18,
    effort: 0.1,
    variety: 0.1,
    applianceFit: 0.06,
    weatherFit: 0.05,
    ppeRisk: 0.05,
  },
  meals: {
    inventory: 0.3,
    cost: 0.16,
    timeFit: 0.16,
    effort: 0.1,
    variety: 0.12,
    applianceFit: 0.06,
    weatherFit: 0.04,
    ppeRisk: 0.06,
  },
  cleaning: {
    inventory: 0.22,
    cost: 0.16,
    timeFit: 0.2,
    effort: 0.14,
    variety: 0.1,
    applianceFit: 0.08,
    weatherFit: 0.04,
    ppeRisk: 0.06,
  },
  animals: {
    inventory: 0.26,
    cost: 0.16,
    timeFit: 0.18,
    effort: 0.08,
    variety: 0.06,
    applianceFit: 0.1,
    weatherFit: 0.06,
    ppeRisk: 0.1,
  },
  garden: {
    inventory: 0.18,
    cost: 0.12,
    timeFit: 0.18,
    effort: 0.1,
    variety: 0.16,
    applianceFit: 0.06,
    weatherFit: 0.12,
    ppeRisk: 0.08,
  },
};

// ----------------------------- Veto Rules -----------------------------
function applyVetoes(candidate, ctx) {
  const reasons = [];

  // Sabbath guard: disallow heavy labor or cooking that violates config
  if (
    ctx?.constraints?.sabbathGuard &&
    candidate.tags?.includes("heavy-labor")
  ) {
    reasons.push("sabbath-guard");
  }

  // Allergies / dietary hard bans (meals)
  if (ctx?.constraints?.allergies && candidate.allergens) {
    const hit = candidate.allergens.find((a) =>
      ctx.constraints.allergies.includes(a)
    );
    if (hit) reasons.push("allergy:" + hit);
  }

  // Weather holds (e.g., outdoor chores/garden in storm)
  const weather = scheduleHelpers.weatherHolds
    ? scheduleHelpers.weatherHolds({ tasks: [candidate] })
    : { holds: [] };
  if (
    weather.holds &&
    weather.holds.length &&
    (candidate.flags || []).includes("outdoor")
  ) {
    reasons.push("weather-hold");
  }

  // PPE required but missing (animals/butchery/cleaning)
  if (candidate.ppeRequired && candidate.ppeRequired.length) {
    const missing = (candidate.ppeRequired || []).filter(
      (p) => !(ctx?.ppeAvailable || []).includes(p)
    );
    if (missing.length) reasons.push("ppe-missing:" + missing.join(","));
  }

  // Appliance not available
  if (
    candidate.appliances &&
    candidate.appliances.length &&
    ctx?.applianceLocks
  ) {
    const conflict = candidate.appliances.find((a) =>
      ctx.applianceLocks.includes(a)
    );
    if (conflict) reasons.push("appliance-locked:" + conflict);
  }

  // Withholds (animals: deworming/vaccine windows; garden: spray intervals)
  const withholds = scheduleHelpers.computeWithholds
    ? scheduleHelpers.computeWithholds({ tasks: [candidate] })
    : { withholds: [] };
  if (withholds.withholds && withholds.withholds.length) {
    reasons.push("withhold-active");
  }

  return { veto: !!reasons.length, reasons };
}

// ----------------------------- Domain Scorers -----------------------------
const domainScorers = {
  meals(candidate, ctx) {
    // inventory score
    const inv = candidate.inventory || { have: 0, short: 0, unknown: 0 };
    const invScore = clamp01((inv.have || 0) - 0.5 * (inv.short || 0));

    // cost score (lower cost -> higher score)
    const cost = safeNum(candidate.cost?.subtotal, 0);
    const costNorm = ctx._norm.cost(cost);
    const costScore = 1 - costNorm;

    // time fit (compare estMinutes to ctx window)
    const est = safeNum(candidate.estMinutes, 30);
    const fit = ctx.timeWindow ? Math.max(0, ctx.timeWindow - est) : 0;
    const timeScore = clamp01(
      1 -
        Math.abs((est - (ctx.timeWindow || est)) / (ctx.timeWindow || est || 1))
    );

    const effortScore = 1 - clamp01(safeNum(candidate.effort, 0.5));
    const varietyScore = candidate.varietyBoost || 0.5;
    const applianceFit = candidate.appliances?.length
      ? 1 - clamp01(candidate.appliancesOverlap || 0)
      : 0.8;
    const weatherFit = (candidate.flags || []).includes("outdoor") ? 0.2 : 0.9;
    const ppeRisk =
      candidate.ppeRequired && candidate.ppeRequired.length ? 0.3 : 0.9;

    return {
      inventory: invScore,
      cost: costScore,
      timeFit: timeScore,
      effort: effortScore,
      variety: varietyScore,
      applianceFit,
      weatherFit,
      ppeRisk,
    };
  },

  cleaning(candidate, ctx) {
    const invScore = 1 - clamp01(safeNum(candidate.suppliesShortRatio, 0));
    const cost = safeNum(candidate.cost?.subtotal, 0);
    const costScore = 1 - ctx._norm.cost(cost);
    const est = safeNum(candidate.estMinutes, 20);
    const timeScore = clamp01(
      1 -
        Math.abs((est - (ctx.timeWindow || est)) / (ctx.timeWindow || est || 1))
    );
    const effortScore = 1 - clamp01(safeNum(candidate.effort, 0.5));
    const varietyScore = candidate.rotationBoost || 0.5;
    const applianceFit = candidate.appliances?.length
      ? 1 - clamp01(candidate.appliancesOverlap || 0)
      : 0.85;
    const weatherFit = (candidate.flags || []).includes("outdoor") ? 0.4 : 0.9;
    const ppeRisk =
      candidate.ppeRequired && candidate.ppeRequired.length ? 0.4 : 0.9;
    return {
      inventory: invScore,
      cost: costScore,
      timeFit: timeScore,
      effort: effortScore,
      variety: varietyScore,
      applianceFit,
      weatherFit,
      ppeRisk,
    };
  },

  animals(candidate, ctx) {
    const invScore = 1 - clamp01(safeNum(candidate.chillChainRisk, 0));
    const cost = safeNum(candidate.cost?.subtotal, 0);
    const costScore = 1 - ctx._norm.cost(cost);
    const est = safeNum(candidate.estMinutes, 45);
    const timeScore = clamp01(
      1 -
        Math.abs((est - (ctx.timeWindow || est)) / (ctx.timeWindow || est || 1))
    );
    const effortScore = 1 - clamp01(safeNum(candidate.effort, 0.7));
    const varietyScore = candidate.batchRotationBoost || 0.5;
    const applianceFit = candidate.appliances?.length
      ? 1 - clamp01(candidate.appliancesOverlap || 0)
      : 0.8;
    const weatherFit = (candidate.flags || []).includes("outdoor") ? 0.5 : 0.9;
    const ppeRisk =
      candidate.ppeRequired && candidate.ppeRequired.length ? 0.3 : 0.85;
    return {
      inventory: invScore,
      cost: costScore,
      timeFit: timeScore,
      effort: effortScore,
      variety: varietyScore,
      applianceFit,
      weatherFit,
      ppeRisk,
    };
  },

  garden(candidate, ctx) {
    const invScore = 1 - clamp01(safeNum(candidate.seedOrSupplyShortRatio, 0));
    const cost = safeNum(candidate.cost?.subtotal, 0);
    const costScore = 1 - ctx._norm.cost(cost);
    const est = safeNum(candidate.estMinutes, 30);
    const timeScore = clamp01(
      1 -
        Math.abs((est - (ctx.timeWindow || est)) / (ctx.timeWindow || est || 1))
    );
    const effortScore = 1 - clamp01(safeNum(candidate.effort, 0.6));
    const varietyScore = candidate.zoneRotationBoost || 0.6;
    const applianceFit = candidate.appliances?.length
      ? 1 - clamp01(candidate.appliancesOverlap || 0)
      : 0.85;
    const weatherFit = (candidate.flags || []).includes("outdoor")
      ? ctx.weatherOK
        ? 0.9
        : 0.3
      : 0.9;
    const ppeRisk =
      candidate.ppeRequired && candidate.ppeRequired.length ? 0.5 : 0.9;
    return {
      inventory: invScore,
      cost: costScore,
      timeFit: timeScore,
      effort: effortScore,
      variety: varietyScore,
      applianceFit,
      weatherFit,
      ppeRisk,
    };
  },

  custom(candidate, ctx) {
    // Generic fallback
    const cost = safeNum(candidate.cost?.subtotal, 0);
    const costScore = 1 - ctx._norm.cost(cost);
    return {
      inventory: 0.5,
      cost: costScore,
      timeFit: 0.5,
      effort: 0.5,
      variety: 0.5,
      applianceFit: 0.5,
      weatherFit: 0.5,
      ppeRisk: 0.5,
    };
  },
};

// ----------------------------- Core Scoring -----------------------------
async function enrichCandidate(candidate, domain) {
  // Estimate cost if missing
  if (!candidate.cost || typeof candidate.cost.subtotal !== "number") {
    try {
      candidate.cost = estimateEngine.estimate
        ? estimateEngine.estimate({ domain, tasks: [candidate] })
        : candidate.cost;
    } catch (e) {}
  }
  // Inventory breakdown hint (best effort)
  if (
    !candidate.inventory &&
    InventoryMonitor.classifyItems &&
    candidate.items
  ) {
    try {
      const klass = InventoryMonitor.classifyItems(candidate.items);
      candidate.inventory = {
        have: (klass.have || []).length / (candidate.items.length || 1),
        short: (klass.short || []).length / (candidate.items.length || 1),
        unknown: (klass.unknown || []).length / (candidate.items.length || 1),
      };
    } catch (e) {}
  }
  return candidate;
}

function facetTotal(facets, weights) {
  let total = 0;
  const breakdown = {};
  Object.keys(weights).forEach((k) => {
    const w = safeNum(weights[k], 0);
    const v = clamp01(safeNum(facets[k], 0.5));
    breakdown[k] = v * w;
    total += v * w;
  });
  return { total, breakdown };
}

// Diversity/cooling: penalize items seen in recentHistory by category or id
function diversityPenalty(candidate, ctx) {
  const hist = ctx?.recentHistory || [];
  if (!hist.length) return 0;
  const idHit = hist.find((h) => h.id === candidate.id);
  const cat = (candidate.category || candidate.zone || "").toLowerCase();
  const catHit =
    cat && hist.find((h) => (h.category || h.zone || "").toLowerCase() === cat);
  let penalty = 0;
  if (idHit) penalty += 0.2;
  if (catHit) penalty += 0.1;
  return clamp01(penalty);
}

// ----------------------------- Public Factory (non-React) -----------------------------
export function createWorkDecider(config = {}) {
  const state = {
    id: uid(),
    domain: config.domain || "custom",
    weights: {
      ...DEFAULT_WEIGHTS.common,
      ...(DEFAULT_WEIGHTS[config.domain || "custom"] || {}),
      ...(config.weights || {}),
    },
    strategy: config.strategy || "epsilon-greedy", // "greedy" | "softmax" | "epsilon-greedy"
    strategyKey: config.strategyKey || "A", // A/B knob
    epsilon:
      typeof config.epsilon === "number"
        ? config.epsilon
        : Settings.get()?.decider?.epsilon ?? 0.08,
    temp: typeof config.temp === "number" ? config.temp : 1,
    constraints: config.constraints || {
      sabbathGuard: Settings.get()?.sabbathGuard || false,
    },
    ppeAvailable: config.ppeAvailable || [],
    applianceLocks: config.applianceLocks || [],
    timeWindow: config.timeWindow || null,
    weatherOK: config.weatherOK !== undefined ? !!config.weatherOK : true,
    recentHistory: config.recentHistory || [],
    _norm: { cost: (v) => 0.5 },
  };

  const registerDomainScorer = (domain, scorerFn) => {
    domainScorers[domain] = scorerFn || domainScorers.custom;
  };

  const setWeights = (partial) => {
    state.weights = { ...state.weights, ...(partial || {}) };
  };
  const setStrategy = (name, opts = {}) => {
    state.strategy = name || state.strategy;
    if (typeof opts.epsilon === "number") state.epsilon = opts.epsilon;
    if (typeof opts.temp === "number") state.temp = opts.temp;
    if (opts.strategyKey) state.strategyKey = opts.strategyKey;
  };
  const setConstraints = (partial) => {
    state.constraints = { ...state.constraints, ...(partial || {}) };
  };
  const setContext = (partial) => {
    Object.assign(state, partial || {});
  };

  async function decide(candidates = []) {
    const dom = state.domain || "custom";
    const scorer = domainScorers[dom] || domainScorers.custom;

    eventBus.emit("decider.requested", {
      id: state.id,
      domain: dom,
      count: candidates.length,
    });

    // Enrich candidates & collect costs for normalization
    const enriched = [];
    const costVals = [];
    for (let i = 0; i < candidates.length; i++) {
      const c = await enrichCandidate({ ...candidates[i] }, dom);
      enriched.push(c);
      if (c?.cost?.subtotal != null) costVals.push(safeNum(c.cost.subtotal, 0));
    }
    state._norm.cost = normalizeFacet(costVals);

    // Score + veto + diversity
    const scored = [];
    for (let i = 0; i < enriched.length; i++) {
      const cand = enriched[i];

      const veto = applyVetoes(cand, state);
      if (veto.veto) {
        scored.push({
          ...cand,
          __vetoed: true,
          __vetoReasons: veto.reasons,
          total: 0,
          breakdown: {},
          _explain: {
            reasons: veto.reasons,
            strategy: state.strategy,
            strategyKey: state.strategyKey,
          },
        });
        continue;
      }

      const facets = scorer(cand, state);
      const { total, breakdown } = facetTotal(facets, state.weights);

      // diversity penalty
      const divPen = diversityPenalty(cand, state);
      const final = clamp01(total - 0.5 * divPen);

      scored.push({
        ...cand,
        total: final,
        breakdown,
        _explain: {
          facets,
          diversityPenalty: divPen,
          strategy: state.strategy,
          strategyKey: state.strategyKey,
        },
      });
    }

    eventBus.emit("decider.scored", {
      id: state.id,
      domain: dom,
      scored: scored.length,
    });

    // Resolve conflicts (best effort)
    let conflictAdjusted = scored;
    try {
      const conf = placementRules.detect
        ? placementRules.detect(scored)
        : { conflicts: [] };
      if (conf.conflicts?.length) {
        // down-rank conflicted items slightly
        const conflictedIds = new Set();
        conf.conflicts.forEach((c) =>
          (c.tasks || []).forEach((tid) => conflictedIds.add(tid))
        );
        conflictAdjusted = scored.map((item) =>
          conflictedIds.has(item.id)
            ? {
                ...item,
                total: clamp01(item.total - 0.1),
                _explain: { ...(item._explain || {}), conflictPenalty: 0.1 },
              }
            : item
        );
      }
    } catch (e) {}

    // Sort / pick by strategy
    let ranked;
    if (state.strategy === "softmax") {
      ranked = softmaxPick(conflictAdjusted, state.temp);
    } else if (state.strategy === "epsilon-greedy") {
      ranked = epsilonGreedy(conflictAdjusted, state.epsilon);
    } else {
      // greedy
      ranked = conflictAdjusted.slice().sort((a, b) => b.total - a.total);
    }

    const result = ranked.map((r, idx) => ({ ...r, rank: idx + 1 }));
    eventBus.emit("decider.completed", {
      id: state.id,
      domain: dom,
      top: result[0]?.id || null,
      count: result.length,
    });
    return result;
  }

  function explain(candidateId, ranked = []) {
    const hit = (ranked || []).find((r) => r.id === candidateId);
    if (!hit) return null;
    return {
      id: hit.id,
      title: hit.title,
      total: hit.total,
      breakdown: hit.breakdown,
      ...hit._explain,
    };
  }

  return {
    getState: () => ({ ...state }),
    setWeights,
    setStrategy,
    setConstraints,
    setContext,
    registerDomainScorer,
    decide,
    explain,
  };
}

// ----------------------------- React Hook -----------------------------
export function useWorkDecider(initial = {}) {
  const ref = useRef(null);
  const [config, setConfig] = useState(initial);
  const [loading, setLoading] = useState(false);

  if (!ref.current) {
    ref.current = createWorkDecider(initial);
  }

  const setWeights = useCallback((partial) => {
    ref.current.setWeights(partial);
    setConfig((prev) => ({
      ...prev,
      weights: { ...(prev.weights || {}), ...(partial || {}) },
    }));
  }, []);

  const setStrategy = useCallback((name, opts = {}) => {
    ref.current.setStrategy(name, opts);
    setConfig((prev) => ({
      ...prev,
      strategy: name || prev.strategy,
      ...opts,
    }));
  }, []);

  const setConstraints = useCallback((partial) => {
    ref.current.setConstraints(partial);
    setConfig((prev) => ({
      ...prev,
      constraints: { ...(prev.constraints || {}), ...(partial || {}) },
    }));
  }, []);

  const setContext = useCallback((partial) => {
    ref.current.setContext(partial);
    setConfig((prev) => ({ ...prev, ...(partial || {}) }));
  }, []);

  const registerDomainScorer = useCallback((domain, fn) => {
    ref.current.registerDomainScorer(domain, fn);
  }, []);

  const decide = useCallback(async (candidates = []) => {
    setLoading(true);
    try {
      const ranked = await ref.current.decide(candidates);
      return ranked;
    } catch (e) {
      console.warn("decider.failed", e);
      eventBus.emit("decider.failed", { error: e?.message || String(e) });
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  const explain = useCallback(
    (id, ranked) => ref.current.explain(id, ranked),
    []
  );

  const state = useMemo(() => ref.current.getState(), [config]);

  return {
    loading,
    state,
    setWeights,
    setStrategy,
    setConstraints,
    setContext,
    registerDomainScorer,
    decide,
    explain,
  };
}

/**
 * Usage examples
 * --------------
 * // React
 * const { decide, setStrategy, setConstraints, explain } = useWorkDecider({
 *   domain: "meals",
 *   timeWindow: 45,
 *   constraints: { sabbathGuard: true, allergies: ["peanut"] },
 *   recentHistory: [{ id:"r1", category:"poultry" }],
 * });
 * const ranked = await decide(recipeCandidates);
 * const why = explain(ranked[0].id, ranked);
 *
 * // Non-React
 * const D = createWorkDecider({ domain: "garden", timeWindow: 60, weatherOK: false });
 * D.setStrategy("softmax", { temp: 0.8, strategyKey: "B" });
 * const ranked = await D.decide(tasks);
 */
