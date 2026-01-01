/**
 * File: src/layers/resolvers/LeanOptimizer.js
 * Purpose: Use Lean lexicon signals + KPIs + complaints to recommend improvements.
 *
 * NEVER silently rewrites user plans.
 * Output is recommendations and (optionally) an applyPlan that requires explicit opt-in.
 *
 * Inputs:
 *  - logs: Array<{ ts, domain, message, signals?: Array<{ id, waste, severity, tags?:string[] }> }>
 *  - complaints: Array<string> (user notes)
 *  - kpiSnapshot: object (latest measured KPIs)
 *  - opts: { optedIn?: boolean, allowAutoApply?: boolean }
 *  - leanCatalogs: { wasteMaps: object, standardWork: object, valueStreams: object, taktModel: object } (optional)
 *
 * Outputs:
 *  - {
 *      recommendations: {
 *        patternAdjustments: Array<{ type:"boost"|"downrank", patternId, amount, reason }>,
 *        countermeasureHints: Array<{ hintTag, reason, refs?: string[] }>,
 *        kpiTargets: Array<{ kpi, targetDirection, targetValue?, notes? }>,
 *        trackingPlan: Array<{ what, frequency, how }>,
 *        standardWorkRefs: string[],
 *        valueStreamRefs: string[],
 *      },
 *      applyPlan: null | { adjustments: ... }  // only when opts.allowAutoApply && opts.optedIn
 *      debug: object
 *    }
 */

import { clamp, normalizeText, safeArray, uniq } from "./_resolverUtils.js";

const WASTE_SEVERITY_WEIGHT = { low: 0.5, medium: 1.0, high: 1.5 };

function aggregateSignals(logs = [], complaints = []) {
  const agg = {
    wasteCounts: {},
    tokens: new Set(),
    maxSeverity: {},
  };

  for (const msg of safeArray(complaints)) {
    for (const tok of normalizeText(msg).split(/\s+/g)) {
      if (tok) agg.tokens.add(tok);
    }
  }

  for (const row of safeArray(logs)) {
    const signals = safeArray(row?.signals);
    for (const s of signals) {
      const waste = String(s?.waste || "unknown");
      const sev = String(s?.severity || "medium");
      agg.wasteCounts[waste] = (agg.wasteCounts[waste] || 0) + (WASTE_SEVERITY_WEIGHT[sev] || 1.0);
      agg.maxSeverity[waste] = agg.maxSeverity[waste] || sev;
      for (const t of safeArray(s?.tags)) agg.tokens.add(normalizeText(t));
    }
    const m = normalizeText(row?.message);
    for (const tok of m.split(/\s+/g)) if (tok) agg.tokens.add(tok);
  }

  return agg;
}

function recommendFromWaste(agg, kpiSnapshot = {}) {
  const recs = {
    patternAdjustments: [],
    countermeasureHints: [],
    kpiTargets: [],
    trackingPlan: [],
    standardWorkRefs: [],
    valueStreamRefs: [],
  };

  const wc = agg.wasteCounts || {};
  const total = Object.values(wc).reduce((a, b) => a + b, 0) || 1;

  const top = Object.entries(wc)
    .map(([w, v]) => ({ waste: w, weight: v / total }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3);

  for (const w of top) {
    if (w.waste === "waiting") {
      recs.countermeasureHints.push({ hintTag: "prestageTools", reason: "High waiting signals → stage tools and start preheats earlier.", refs: ["lean.wm.cooking"] });
      recs.patternAdjustments.push({ type: "boost", patternId: "pat.meals.weekly_batch", amount: 0.06, reason: "Batch sessions reduce waiting via staging + sequence." });
      recs.standardWorkRefs.push("lean.sw.weekly_meal_cycle");
      recs.valueStreamRefs.push("lean.vs.meal_to_storehouse");
      recs.kpiTargets.push({ kpi: "timeToFirstPlate", targetDirection: "down", notes: "Track average minutes from start to first plated meal." });
    }
    if (w.waste === "motion") {
      recs.countermeasureHints.push({ hintTag: "stagingStation", reason: "High motion signals → set a dedicated staging station.", refs: ["lean.wm.cooking", "lean.wm.storage"] });
      recs.patternAdjustments.push({ type: "boost", patternId: "pat.storehouse.weekly_restock", amount: 0.05, reason: "Weekly restock + zone grouping reduces trips." });
      recs.kpiTargets.push({ kpi: "tripsPerWeek", targetDirection: "down", notes: "Count trips to pantry/store per week." });
    }
    if (w.waste === "inventory") {
      recs.countermeasureHints.push({ hintTag: "needsInventorySnapshot", reason: "Inventory waste signals → refresh inventory truth before planning.", refs: ["lean.wm.storage"] });
      recs.patternAdjustments.push({ type: "boost", patternId: "pat.storehouse.monthly_cycle_count", amount: 0.08, reason: "Cycle counts reduce duplicate buys and stockouts." });
      recs.standardWorkRefs.push("lean.sw.monthly_storehouse_check");
      recs.kpiTargets.push({ kpi: "stockouts", targetDirection: "down" });
      recs.kpiTargets.push({ kpi: "overstocks", targetDirection: "down" });
    }
    if (w.waste === "defects") {
      recs.countermeasureHints.push({ hintTag: "donenessChecks", reason: "Defects signals → add doneness checkpoints and safety checklist.", refs: ["lean.wm.cooking"] });
      recs.kpiTargets.push({ kpi: "reworkRate", targetDirection: "down" });
    }
    if (w.waste === "overprocessing") {
      recs.countermeasureHints.push({ hintTag: "limitNewRecipes", reason: "Overprocessing → limit new recipes and standardize core meals.", refs: ["lean.wm.cooking"] });
      recs.patternAdjustments.push({ type: "boost", patternId: "pat.meals.daily_fresh", amount: -0.03, reason: "Reduce complexity by simplifying daily choices." });
      recs.kpiTargets.push({ kpi: "newRecipesPerWeek", targetDirection: "down" });
    }
    if (w.waste === "transport") {
      recs.countermeasureHints.push({ hintTag: "groupShoppingByZone", reason: "Transport waste → group shopping list by zones/aisles.", refs: ["lean.wm.storage"] });
      recs.kpiTargets.push({ kpi: "trips", targetDirection: "down" });
    }
  }

  recs.standardWorkRefs = uniq(recs.standardWorkRefs);
  recs.valueStreamRefs = uniq(recs.valueStreamRefs);
  recs.kpiTargets = uniq(recs.kpiTargets.map(x => JSON.stringify(x))).map(s => JSON.parse(s));
  return recs;
}

export class LeanOptimizer {
  optimize(logs = [], complaints = [], kpiSnapshot = {}, opts = {}) {
    const optedIn = !!opts.optedIn;
    const allowAutoApply = !!opts.allowAutoApply;

    const agg = aggregateSignals(logs, complaints);
    const recommendations = recommendFromWaste(agg, kpiSnapshot);

    // tracking plan defaults
    recommendations.trackingPlan = [
      { what: "timeToPlan", frequency: "weekly", how: "measure minutes from start planning to plan committed" },
      { what: "spoilageRate", frequency: "weekly", how: "count spoiled items / total perishable items" },
      { what: "tripsPerWeek", frequency: "weekly", how: "count pantry/store trips logged" },
    ];

    const applyPlan = (optedIn && allowAutoApply)
      ? { adjustments: recommendations.patternAdjustments, notes: "Applied only because user opted-in to auto-apply." }
      : null;

    return { recommendations, applyPlan, debug: { optedIn, allowAutoApply, agg } };
  }
}

export default LeanOptimizer;
