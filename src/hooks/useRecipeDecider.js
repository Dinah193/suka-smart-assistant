// useRecipeDecider.js
// [NEW] wraps scoring engine + explainability + variety controls + constraints
// ES2015-safe, dependency-light, with DI factory and a React hook wrapper

import { useCallback, useMemo, useRef, useState } from "react";

/**
 * createRecipeDecider
 * Optional DI to keep things resilient and testable.
 *
 * @param {Object} deps
 *  - clock: { now(): Date }
 *  - config: {
 *      get(path, fallback): any,
 *      sabbathGuard?: { enabled:boolean, start?:string, end?:string }
 *    }
 *  - analytics: { track(evt, payload):void }
 *  - eventBus:  { emit(evt, payload):void }
 *  - inventory: {
 *      estimateShortage?(skuIdOrName, needQty): { have:number, short:number },
 *      has?(skuIdOrName): boolean
 *    }
 *  - cost: { estimate?(recipe): { total:number, perServing:number, currency:string } }
 *  - macroFit: {
 *      match?(recipe, targets): { score:number, gaps:{cal:number, protein:number, carbs:number, fat:number} }
 *    }
 *  - timeFit: {
 *      fit?(recipe, window): { score:number, reason?:string } // window={availableMinutes, start?, end?}
 *    }
 *  - applianceFit: { score?(recipe, availableAppliances:string[]): { score:number, missing?:string[] } }
 *  - allergen: { detect?(recipe): string[] } // returns allergen tags present
 *  - leftovers: { value?(recipe, planContext): { score:number, servings:number } }
 *  - userPref: {
 *      preferenceScore?(recipe, profile): number,  // cuisine/course/effort flags, personal likes
 *      cooldownPenalty?(recipe, recentHistory): number, // repeat penalty
 *      noveltyBoost?(recipe, history): number
 *    }
 *  - gardenLink: { coverage?(recipe): { percent:number, items:string[] } } // % from garden/animals/storehouse
 *  - scheduler: {
 *      nextWindows?(context): Array<{id:string, label:string, minutes:number, startISO?:string}>,
 *      detectConflicts?(recipe, context): string[] // e.g., "Sabbath", "Overlaps deep clean"
 *    }
 *  - estimateEngine: { // optional richer cost breakdown per ingredient (used if provided)
 *      cost?(recipe): { total:number, currency:string, perServing:number, items?:Array<{name,cost}> }
 *    }
 */
export function createRecipeDecider(deps = {}) {
  const clock     = deps.clock || { now: function () { return new Date(); } };
  const config    = deps.config || { get: function (_p, fb) { return fb; }, sabbathGuard: { enabled:false } };
  const analytics = deps.analytics || { track: function () {} };
  const eventBus  = deps.eventBus  || { emit: function () {} };

  const inventory   = deps.inventory   || { estimateShortage: function () { return { have:0, short:0 }; }, has: function () { return false; } };
  const cost        = deps.cost        || { estimate: function () { return null; } };
  const macroFit    = deps.macroFit    || { match: function () { return { score: 0.5, gaps: { cal:0, protein:0, carbs:0, fat:0 } }; } };
  const timeFit     = deps.timeFit     || { fit: function () { return { score: 0.5, reason: "" }; } };
  const applianceFit= deps.applianceFit|| { score: function () { return { score: 0.6, missing: [] }; } };
  const allergen    = deps.allergen    || { detect: function () { return []; } };
  const leftovers   = deps.leftovers   || { value: function () { return { score: 0, servings: 0 }; } };
  const userPref    = deps.userPref    || {
    preferenceScore: function () { return 0.5; },
    cooldownPenalty: function () { return 0; },
    noveltyBoost: function () { return 0.05; }
  };
  const gardenLink  = deps.gardenLink  || { coverage: function () { return { percent: 0, items: [] }; } };
  const scheduler   = deps.scheduler   || {
    nextWindows: function () { return [{ id:"now", label:"Now", minutes: 45 }]; },
    detectConflicts: function () { return []; }
  };
  const estimateEngine = deps.estimateEngine || { cost: function () { return null; } };

  // ---------- Helpers ---------------------------------------------------------

  function toLower(x){ return String(x||"").toLowerCase(); }
  function safeNum(x, fb){ var n = Number(x); return isFinite(n) ? n : (fb||0); }

  function isSabbathGuardActive() {
    var sg = config.sabbathGuard || (config.get && config.get("sabbath.guard", { enabled:false }));
    if (!sg || !sg.enabled) return false;
    try {
      var now = clock.now();
      var day = now.getDay();
      var start = sg.start || "Fri 18:00";
      var end   = sg.end   || "Sat 19:00";
      function parseBoundary(s) {
        var parts = s.split(" "); var wday = parts[0]; var hm = parts[1];
        var map = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };
        var targetD = map[wday];
        var base = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0,0,0,0);
        var delta = targetD - day;
        var target = new Date(base.getTime() + delta*24*60*60*1000);
        var hmParts = hm.split(":");
        target.setHours(Number(hmParts[0]||0));
        target.setMinutes(Number(hmParts[1]||0));
        return target;
      }
      var s = parseBoundary(start); var e = parseBoundary(end);
      if (e < s) e = new Date(e.getTime() + 7*24*60*60*1000);
      return (now >= s && now <= e);
    } catch (_e) { return false; }
  }

  function shortageRatio(recipe) {
    // quick heuristic: if ingredients array available, count missing vs all
    var ings = (recipe && recipe.ingredients) || [];
    if (!ings.length) return 0;
    var missing = 0;
    for (var i=0;i<ings.length;i++){
      var name = "ing/" + toLower(ings[i].name || "");
      var has = false;
      try { has = inventory.has(name); } catch (_e) { has = false; }
      if (!has) missing++;
    }
    return missing / ings.length; // 0..1
  }

  function computeCost(recipe) {
    try {
      var c = estimateEngine.cost(recipe) || cost.estimate(recipe);
      if (c) return { total: safeNum(c.total, 0), perServing: safeNum(c.perServing, 0), currency: c.currency || "USD" };
    } catch (_e) {}
    return null;
  }

  // ---------- Scoring ---------------------------------------------------------

  /**
   * scoreRecipe(recipe, context) -> { score: number [0..1], reasons:[], facets:{} }
   * context: {
   *   profile, targets:{cal,protein,carbs,fat}, budget:{perMeal?:number, perDay?:number}, recentHistory:[],
   *   timeWindow:{availableMinutes:number, startISO?, endISO?},
   *   appliances:string[], avoidAllergens?:string[], cuisineDiversity?:{cooldownDays:number},
   *   planContext?, daypart? ("breakfast"|"lunch"|"dinner"), variety?:{avoidSameCuisine:boolean},
   *   sabbathGuardOverride?: boolean
   * }
   */
  function scoreRecipe(recipe, context = {}) {
    var reasons = [];
    var facets  = {};
    var hardBlocks = [];

    // Sabbath guard (if cooking forbidden by user's rule)
    var sabbathActive = isSabbathGuardActive();
    if (sabbathActive && !context.sabbathGuardOverride) {
      hardBlocks.push("Sabbath guard active");
    }

    // Allergen check
    var presentAllergens = [];
    try { presentAllergens = allergen.detect(recipe) || []; } catch (_e) { presentAllergens = []; }
    var avoid = (context.avoidAllergens || []).map(toLower);
    var allergenHit = presentAllergens.some(function (a){ return avoid.indexOf(toLower(a))>=0; });
    if (allergenHit) hardBlocks.push("Allergen conflict");

    // Conflicts from scheduler (e.g., overlaps)
    var conflicts = [];
    try { conflicts = scheduler.detectConflicts(recipe, context) || []; } catch (_e) { conflicts = []; }
    if (conflicts && conflicts.length) hardBlocks.push("Schedule conflict: " + conflicts.join(", "));

    // Base preference score
    var pref = 0.5;
    try { pref = userPref.preferenceScore(recipe, context.profile) || 0.5; } catch (_e) {}
    facets.preference = pref; if (pref >= 0.65) reasons.push("Matches taste/preferences");

    // Time fit
    var tf = { score: 0.5 };
    try { tf = timeFit.fit(recipe, context.timeWindow || {}) || { score: 0.5 }; } catch (_e) {}
    facets.time = tf.score; if (tf.reason) reasons.push("Time: " + tf.reason);

    // Appliance fit
    var af = { score: 0.6, missing: [] };
    try { af = applianceFit.score(recipe, context.appliances || []) || af; } catch (_e) {}
    facets.appliances = af.score;
    if (af.missing && af.missing.length) reasons.push("Missing appliance: " + af.missing.join(", "));

    // Macro fit
    var mf = { score: 0.5, gaps: { cal:0, protein:0, carbs:0, fat:0 } };
    try { mf = macroFit.match(recipe, context.targets || {}) || mf; } catch (_e) {}
    facets.macros = mf.score;
    if (mf.score >= 0.65) reasons.push("Macro-friendly");
    else reasons.push("Macro gaps: " + ["cal","protein","carbs","fat"].map(function (k){ return k+":"+Math.round(mf.gaps[k]); }).join(" "));

    // Cost & budget
    var cst = computeCost(recipe);
    if (cst) {
      facets.cost = Math.max(0, 1 - (cst.perServing / Math.max(1, (context.budget && context.budget.perMeal) || 8))); // normalize by perMeal budget
      reasons.push("Cost est: " + (cst.currency || "USD") + " " + (cst.perServing || cst.total));
    } else {
      facets.cost = 0.5;
    }

    // Inventory coverage & shortage
    var shortR = shortageRatio(recipe);
    facets.inventory = Math.max(0, 1 - shortR); // full coverage -> 1; all missing -> 0
    if (shortR > 0) reasons.push("Missing ~" + Math.round(shortR * 100) + "% ingredients");

    // Garden/storehouse coverage
    var g = { percent: 0, items: [] };
    try { g = gardenLink.coverage(recipe) || g; } catch (_e) {}
    facets.garden = Math.min(1, (g.percent || 0) / 100);
    if (g.percent >= 30) reasons.push("Garden/Storehouse covers " + g.percent + "%");

    // Leftovers value (batch efficiency)
    var lo = { score: 0, servings: 0 };
    try { lo = leftovers.value(recipe, context.planContext) || lo; } catch (_e) {}
    facets.leftovers = lo.score;
    if (lo.servings > 0) reasons.push("Creates leftovers (" + lo.servings + ")");

    // Variety & cooldowns
    var cooldown = 0;
    var novelty = 0;
    try { cooldown = userPref.cooldownPenalty(recipe, context.recentHistory || []); } catch (_e) {}
    try { novelty  = userPref.noveltyBoost(recipe, context.recentHistory || []); } catch (_e) {}
    facets.variety = Math.max(0, 0.5 + novelty - Math.max(0, cooldown));
    if (cooldown > 0) reasons.push("Recently made — applying cooldown");
    if (novelty > 0.04) reasons.push("Novelty boost");

    // Aggregate with weights; tuneable per daypart
    var weights = (function () {
      var w = { preference:0.18, time:0.14, appliances:0.08, macros:0.18, cost:0.12, inventory:0.10, garden:0.07, leftovers:0.08, variety:0.05 };
      var dp = toLower(context.daypart || "");
      if (dp === "breakfast") w.time += 0.06;
      if (dp === "dinner")   w.leftovers += 0.04; // next-day lunch
      return w;
    })();

    var score =
      weights.preference * facets.preference +
      weights.time       * facets.time +
      weights.appliances * facets.appliances +
      weights.macros     * facets.macros +
      weights.cost       * facets.cost +
      weights.inventory  * facets.inventory +
      weights.garden     * facets.garden +
      weights.leftovers  * facets.leftovers +
      weights.variety    * facets.variety;

    // Hard blocks force zero score but keep reasons so UI can explain
    if (hardBlocks.length) {
      reasons.unshift("Blocked: " + hardBlocks.join("; "));
      score = 0;
    }

    // Normalize sanity
    score = Math.max(0, Math.min(1, score));

    return {
      score: Number(score.toFixed(4)),
      reasons: reasons,
      facets: facets,
      blocks: hardBlocks,
      cost: cst || null,
      meta: {
        sabbathActive,
        allergens: presentAllergens
      }
    };
  }

  // ---------- Explainability --------------------------------------------------

  function explain(recipe, context, scored) {
    var s = scored || scoreRecipe(recipe, context);
    var bullets = [];

    // Top drivers
    var facets = s.facets || {};
    var top = Object.keys(facets).map(function (k){ return { k:k, v:facets[k] }; })
      .sort(function (a,b){ return b.v - a.v; })
      .slice(0, 3);

    bullets.push("Top drivers: " + top.map(function (t){ return t.k + " " + Math.round(t.v*100) + "%"; }).join(" • "));

    // Why it works (positive cues)
    var positives = [];
    if (facets.preference >= 0.65) positives.push("fits your taste");
    if (facets.macros >= 0.65)     positives.push("macro-aligned");
    if (facets.inventory >= 0.7)   positives.push("mostly on hand");
    if (facets.garden >= 0.4)      positives.push("uses garden/storehouse");
    if (facets.leftovers >= 0.5)   positives.push("good leftovers");
    if (positives.length) bullets.push("Why it’s good: " + positives.join(", "));

    // Risks / blockers
    if (s.blocks && s.blocks.length) bullets.push("Blocked by: " + s.blocks.join("; "));
    var negs = [];
    if (facets.time < 0.45)       negs.push("tight on time");
    if (facets.cost < 0.45)       negs.push("over budget per serving");
    if (facets.inventory < 0.5)   negs.push("several items missing");
    if (negs.length) bullets.push("Concerns: " + negs.join(", "));

    // Counterfactuals (actionable improvements)
    var tips = [];
    if (facets.inventory < 0.7) tips.push("toggle substitutes or switch brand size");
    if (facets.cost < 0.55)     tips.push("swap premium cuts for budget option");
    if (facets.macros < 0.6)    tips.push("add side to close macro gaps");
    if (facets.time < 0.55)     tips.push("pre-chop or pick quick-cook variation");
    if (facets.leftovers < 0.5 && recipe && recipe.yield && recipe.yield >= 4) tips.push("double batch for lunches");
    if (tips.length) bullets.push("To improve: " + tips.join("; "));

    return {
      summary: bullets.join(" • "),
      bullets: bullets,
      facets: s.facets,
      reasons: s.reasons,
      blocks: s.blocks,
      cost: s.cost,
      meta: s.meta
    };
  }

  /**
   * decide(recipes[], context, opts) -> ranked list with explanations
   * opts: { topK?: number, diversity?: { by?: "cuisine"|"course", cooldown?: number } }
   */
  function decide(recipes, context = {}, opts = {}) {
    var out = [];
    var byKeySeen = {};
    var by = (opts.diversity && opts.diversity.by) || "cuisine";
    var cooldownN = (opts.diversity && opts.diversity.cooldown) || 1;

    for (var i=0;i<(recipes||[]).length;i++){
      var r = recipes[i];
      var scored = scoreRecipe(r, context);
      var exp = explain(r, context, scored);

      // Diversity throttle: avoid clustering same cuisine/course at the very top
      var key = toLower((by === "course" ? (r.course || r.tags && r.tags.course) : (r.cuisine || r.tags && r.tags.cuisine)) || "");
      var penalty = 0;
      if (key) {
        var seen = byKeySeen[key] || 0;
        if (seen >= cooldownN) penalty = 0.05 * seen; // gentle penalty
      }
      var finalScore = Math.max(0, scored.score - penalty);

      out.push({
        recipe: r,
        score: Number(finalScore.toFixed(4)),
        rawScore: scored.score,
        penalty,
        explain: exp
      });

      // Increment "seen" after adding
      if (key) byKeySeen[key] = (byKeySeen[key] || 0) + 1;
    }

    out.sort(function (a,b){ return b.score - a.score; });

    // Emit top candidate to NBA
    try {
      if (out.length) {
        eventBus.emit("decider:top-candidate", {
          recipeId: out[0].recipe && out[0].recipe.id,
          title: out[0].recipe && out[0].recipe.title,
          score: out[0].score,
          summary: out[0].explain && out[0].explain.summary
        });
      }
      analytics.track("decider/run", { count: (recipes||[]).length, topScore: out[0] ? out[0].score : 0 });
    } catch (_e) {}

    return out;
  }

  // Utility: generate NBA next steps for a chosen recipe
  function nextBestActions(chosen, context = {}) {
    if (!chosen || !chosen.recipe) return [];
    var r = chosen.recipe;
    var tips = [];
    // dwell/preheat hints via scheduler windows
    try {
      var wins = scheduler.nextWindows(context) || [];
      if (wins.length) tips.push({ type:"schedule", label:"Schedule cook", windowId:wins[0].id, minutes:wins[0].minutes });
    } catch (_e) {}
    // ingredient mapping / grocery
    if (chosen.explain && chosen.explain.facets && chosen.explain.facets.inventory < 0.7) {
      tips.push({ type:"mapping", label:"Map missing ingredients" });
      tips.push({ type:"grocery", label:"Add to Grocery List" });
    }
    // batch / leftovers
    if (r.leftoverPolicy && r.leftoverPolicy.predictsLeftovers) {
      tips.push({ type:"batch", label:"Batch cook & label containers" });
    }
    // prep consolidation candidates (marinade, defrost inferred by tags)
    var flags = (r.flags || []);
    if (flags.indexOf && (flags.indexOf("needs-marinade")>=0 || flags.indexOf("needs-defrost")>=0)) {
      tips.push({ type:"prep", label:"Schedule marinade/defrost step" });
    }
    return tips;
  }

  return { scoreRecipe, explain, decide, nextBestActions };
}

// ---------------- React Hook wrapper ------------------------------------------

/**
 * useRecipeDecider
 * State + helpers for UI:
 * - rank(recipes, context, opts)
 * - pick(recipeId) -> stores selection, returns NBA next steps
 * - reject(recipeId, reason)
 * - diversity mode toggles and view: top, runnersUp, blocked
 */
export default function useRecipeDecider(deps = {}) {
  const engineRef = useRef(null);
  if (!engineRef.current) engineRef.current = createRecipeDecider(deps);

  const [ranked, setRanked] = useState([]); // [{recipe, score, rawScore, penalty, explain}]
  const [selection, setSelection] = useState(null); // {recipeId, at, score}
  const [blocked, setBlocked] = useState([]); // subset of ranked with score 0

  const rank = useCallback((recipes, context = {}, opts = {}) => {
    const res = engineRef.current.decide(recipes, context, opts);
    setRanked(res);
    setBlocked(res.filter((x) => x.explain && x.explain.blocks && x.explain.blocks.length));
    return res;
  }, []);

  const pick = useCallback((recipeId, context = {}) => {
    const found = ranked.find((r) => (r.recipe && (r.recipe.id === recipeId)));
    if (!found) return null;
    setSelection({ recipeId, at: new Date().toISOString(), score: found.score });

    // Emit NBA candidates for the chosen one
    let nba = [];
    try { nba = engineRef.current.nextBestActions(found, context) || []; } catch (_e) {}

    // Lightweight emit so surrounding UI can open drawers
    try {
      if (deps && deps.eventBus && deps.eventBus.emit) {
        deps.eventBus.emit("decider:selected", {
          recipeId,
          score: found.score,
          nba
        });
      }
      if (deps && deps.analytics && deps.analytics.track) {
        deps.analytics.track("decider/selected", { recipeId, score: found.score, nbaCount: nba.length });
      }
    } catch (_e) {}

    return { selected: found, nba };
  }, [ranked, deps]);

  const reject = useCallback((recipeId, reason) => {
    try {
      if (deps && deps.eventBus && deps.eventBus.emit) {
        deps.eventBus.emit("decider:rejected", { recipeId, reason: reason || "user" });
      }
      if (deps && deps.analytics && deps.analytics.track) {
        deps.analytics.track("decider/rejected", { recipeId, reason: reason || "user" });
      }
    } catch (_e) {}
    return true;
  }, [deps]);

  // Views
  const top = useMemo(() => ranked[0] || null, [ranked]);
  const runnersUp = useMemo(() => ranked.slice(1, 6), [ranked]); // show a compact grid like well-executed sites
  const explainTop = useMemo(() => (top ? top.explain : null), [top]);

  return {
    // actions
    rank,
    pick,
    reject,
    // state & views
    ranked,
    top,
    runnersUp,
    explainTop,
    selection,
    blocked
  };
}
