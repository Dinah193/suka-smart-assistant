// useMealPlanDraft.js
// [NEW] Manage a meal-plan draft with apply/swap/fill-open-slots helpers.
// ES2015-safe, dependency-light, DI-friendly.

import { useCallback, useMemo, useRef, useState } from "react";

/**
 * Slot shape (in draft):
 * {
 *   id: string, dateISO: "2025-10-20", daypart: "breakfast"|"lunch"|"dinner",
 *   recipeId?: string, recipe?: object, servings?: number,
 *   locked?: boolean, notes?: string,
 *   leftoversFrom?: { recipeId, servings },
 *   createdAtISO: string, updatedAtISO: string
 * }
 */

/**
 * createMealPlanDraft
 * Optional DI to keep it resilient and testable.
 *
 * @param {Object} deps
 *  - clock: { now(): Date }
 *  - config: { get(path, fallback): any, sabbathGuard?: { enabled:boolean, start?:string, end?:string } }
 *  - analytics: { track(evt, payload):void }
 *  - eventBus:  { emit(evt, payload):void }
 *  - inventory: {
 *      estimateShortage?(skuIdOrName, needQty): { have:number, short:number },
 *      has?(skuIdOrName): boolean
 *    }
 *  - estimateEngine: { cost?(recipe): { total:number, currency:string, perServing:number } }
 *  - nutrition: { estimate(recipe): { calories:number, protein:number, carbs:number, fat:number, servings:number } }
 *  - decider: { decide(recipes, context, opts): Array<{recipe, score, explain}> }
 *  - recipeStore: { byId?(id): object|null }
 *  - mapping: { // optional – quick missing count
 *      shortageRatio?(recipe): number // 0..1 missing fraction
 *    }
 *  - scheduler: {
 *      windowsForDay?(dateISO): Array<{id,label,minutes,startISO?,endISO?}>,
 *      scheduleCook?(recipe, dateISO, windowId): void
 *    }
 *  - leftovers: {
 *      predict?(recipe): { servings:number } // quick predictor if not in recipe.leftoverPolicy
 *    }
 */
export function createMealPlanDraft(deps = {}) {
  const clock     = deps.clock     || { now: function () { return new Date(); } };
  const config    = deps.config    || { get: function (_p, fb) { return fb; }, sabbathGuard: { enabled:false } };
  const analytics = deps.analytics || { track: function () {} };
  const eventBus  = deps.eventBus  || { emit: function () {} };
  const estimateEngine = deps.estimateEngine || { cost: function () { return null; } };
  const nutrition = deps.nutrition || { estimate: function () { return null; } };
  const decider   = deps.decider   || { decide: function () { return []; } };
  const recipeStore = deps.recipeStore || { byId: function () { return null; } };
  const mapping   = deps.mapping   || { shortageRatio: function () { return 0; } };
  const scheduler = deps.scheduler || { windowsForDay: function () { return []; }, scheduleCook: function () {} };
  const leftovers = deps.leftovers || { predict: function () { return { servings: 0 }; } };
  const inventory = deps.inventory || { estimateShortage: function () { return { have:0, short:0 }; }, has: function () { return false; } };

  // ------- helpers ------------------------------------------------------------

  function uuid(prefix){ return (prefix||"id") + "-" + Math.random().toString(36).slice(2, 10); }
  function safeNum(x, fb){ var n = Number(x); return isFinite(n) ? n : (fb||0); }
  function toLower(x){ return String(x||"").toLowerCase(); }

  function isSabbathGuardActive() {
    var sg = config.sabbathGuard || (config.get && config.get("sabbath.guard", { enabled:false }));
    if (!sg || !sg.enabled) return false;
    try {
      var now = clock.now(); var day = now.getDay();
      var start = sg.start || "Fri 18:00"; var end = sg.end || "Sat 19:00";
      function parseBoundary(s) {
        var parts = s.split(" "); var wday = parts[0]; var hm = parts[1];
        var map = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };
        var targetD = map[wday];
        var base = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0,0,0,0);
        var delta = targetD - day;
        var target = new Date(base.getTime() + delta*24*60*60*1000);
        var hmParts = hm.split(":"); target.setHours(Number(hmParts[0]||0)); target.setMinutes(Number(hmParts[1]||0));
        return target;
      }
      var s = parseBoundary(start); var e = parseBoundary(end);
      if (e < s) e = new Date(e.getTime() + 7*24*60*60*1000);
      return (now >= s && now <= e);
    } catch (_e) { return false; }
  }

  function enrichRecipe(recipe) {
    // cost & nutrition are optional
    var est = null; try { est = estimateEngine.cost(recipe) || null; } catch (_e) {}
    var nut = null; try { nut = nutrition.estimate(recipe) || null; } catch (_e) {}
    var lo = 0;
    try {
      if (recipe && recipe.leftoverPolicy && recipe.leftoverPolicy.predictsLeftovers) {
        lo = safeNum(recipe.leftoverPolicy.leftoverServings, 0);
      } else {
        lo = safeNum(leftovers.predict(recipe).servings, 0);
      }
    } catch (_e) {}
    return { cost: est, nutrition: nut, leftoverServings: lo };
  }

  function summarizeDay(slots) {
    var costTotal = 0; var ccy = "USD";
    var macros = { calories:0, protein:0, carbs:0, fat:0 };
    for (var i=0;i<slots.length;i++){
      var r = slots[i].recipe;
      if (!r) continue;
      var enr = enrichRecipe(r);
      if (enr.cost && isFinite(enr.cost.perServing)) {
        var servings = safeNum(slots[i].servings || r.yield || 1, 1);
        costTotal += (enr.cost.perServing * servings);
        ccy = enr.cost.currency || ccy;
      }
      if (enr.nutrition) {
        var s = safeNum(slots[i].servings || enr.nutrition.servings || 1, 1);
        macros.calories += (safeNum(enr.nutrition.calories, 0) * s);
        macros.protein  += (safeNum(enr.nutrition.protein, 0) * s);
        macros.carbs    += (safeNum(enr.nutrition.carbs, 0) * s);
        macros.fat      += (safeNum(enr.nutrition.fat, 0) * s);
      }
    }
    return { cost: { total: costTotal, currency: ccy }, macros };
  }

  function shortageRatio(recipe) {
    try { return mapping.shortageRatio(recipe); } catch (_e) { return 0; }
  }

  function slotKey(dISO, daypart){ return dISO + "::" + toLower(daypart||""); }

  // ------- core API (non-hook) -----------------------------------------------

  /**
   * buildDraft({ startISO, days=7, dayparts=["breakfast","lunch","dinner"] })
   */
  function buildDraft(opts = {}) {
    var start = opts.startISO || new Date(clock.now().getFullYear(), clock.now().getMonth(), clock.now().getDate()).toISOString().slice(0,10);
    var days = safeNum(opts.days, 7);
    var dayparts = opts.dayparts || ["breakfast","lunch","dinner"];
    var slots = [];
    for (var d=0; d<days; d++){
      var dt = new Date(start); dt.setDate(dt.getDate() + d);
      var dISO = dt.toISOString().slice(0,10);
      for (var p=0; p<dayparts.length; p++){
        var id = uuid("slot");
        slots.push({
          id: id,
          dateISO: dISO,
          daypart: dayparts[p],
          servings: 1,
          createdAtISO: clock.now().toISOString(),
          updatedAtISO: clock.now().toISOString()
        });
      }
    }
    var draft = {
      id: uuid("draft"),
      createdAtISO: clock.now().toISOString(),
      updatedAtISO: clock.now().toISOString(),
      slots: slots,
      guards: { sabbathActive: isSabbathGuardActive() },
      meta: { startISO: start, days: days, dayparts: dayparts.slice(0) }
    };
    return draft;
  }

  /**
   * applyRecipe(draft, { slotId?, dateISO?, daypart? }, recipeOrId, { servings?, lock?, scheduleWindowId? })
   */
  function applyRecipe(draft, where, recipeOrId, opts = {}) {
    if (!draft || !draft.slots) return draft;

    var recipe = recipeOrId && (typeof recipeOrId === "string" ? (recipeStore.byId(recipeOrId) || null) : recipeOrId);
    if (!recipe) return draft;

    var slotIdx = -1;
    if (where && where.slotId) {
      slotIdx = draft.slots.findIndex(function (s){ return s.id === where.slotId; });
    } else if (where && where.dateISO && where.daypart) {
      slotIdx = draft.slots.findIndex(function (s){ return s.dateISO === where.dateISO && toLower(s.daypart) === toLower(where.daypart); });
    }
    if (slotIdx < 0) return draft;

    var slot = Object.assign({}, draft.slots[slotIdx]);
    slot.recipeId = recipe.id || uuid("r");
    slot.recipe   = recipe;
    slot.servings = safeNum(opts.servings, slot.servings || recipe.yield || 1);
    slot.locked   = !!opts.lock;
    slot.updatedAtISO = clock.now().toISOString();
    slot.leftoversFrom = null;

    var nextSlots = draft.slots.slice(0);
    nextSlots[slotIdx] = slot;

    var next = Object.assign({}, draft, { slots: nextSlots, updatedAtISO: clock.now().toISOString() });

    // emit orchestration
    try {
      eventBus.emit("mealplan:apply", {
        draftId: draft.id, slotId: slot.id, dateISO: slot.dateISO, daypart: slot.daypart,
        recipeId: slot.recipeId, servings: slot.servings
      });
      analytics.track("mealplan/apply", { daypart: slot.daypart, haveShortageRatio: shortageRatio(recipe) });
    } catch (_e) {}

    // optional scheduling hint
    try {
      if (opts.scheduleWindowId) { scheduler.scheduleCook(recipe, slot.dateISO, opts.scheduleWindowId); }
    } catch (_e) {}

    return next;
  }

  /**
   * removeFromSlot(draft, slotId)
   */
  function removeFromSlot(draft, slotId) {
    var idx = draft.slots.findIndex(function (s){ return s.id === slotId; });
    if (idx < 0) return draft;
    var slot = Object.assign({}, draft.slots[idx]);
    if (slot.locked) return draft; // respect locks
    delete slot.recipeId; delete slot.recipe;
    slot.leftoversFrom = null;
    slot.updatedAtISO = clock.now().toISOString();
    var next = draft.slots.slice(0); next[idx] = slot;
    var out = Object.assign({}, draft, { slots: next, updatedAtISO: clock.now().toISOString() });

    try {
      eventBus.emit("mealplan:remove", { draftId: draft.id, slotId: slotId });
      analytics.track("mealplan/remove", {});
    } catch (_e) {}

    return out;
  }

  /**
   * swap(draft, slotIdA, slotIdB) — respecting locks
   */
  function swap(draft, a, b) {
    var i = draft.slots.findIndex(function (s){ return s.id === a; });
    var j = draft.slots.findIndex(function (s){ return s.id === b; });
    if (i < 0 || j < 0) return draft;
    var A = draft.slots[i], B = draft.slots[j];
    if (A.locked || B.locked) return draft;

    var NA = Object.assign({}, B, { id: A.id, dateISO: A.dateISO, daypart: A.daypart, updatedAtISO: clock.now().toISOString() });
    var NB = Object.assign({}, A, { id: B.id, dateISO: B.dateISO, daypart: B.daypart, updatedAtISO: clock.now().toISOString() });

    var next = draft.slots.slice(0);
    next[i] = NA; next[j] = NB;
    var out = Object.assign({}, draft, { slots: next, updatedAtISO: clock.now().toISOString() });

    try { eventBus.emit("mealplan:swap", { draftId: draft.id, a: A.id, b: B.id }); analytics.track("mealplan/swap", {}); } catch (_e) {}
    return out;
  }

  /**
   * fillOpenSlots(draft, candidates, context, opts)
   * - candidates: array of recipe objects to consider (already filtered by season, etc.)
   * - context: pass through to decider (time windows, budget, appliances, allergens, etc.)
   * - opts: { diversity?:{by:"cuisine"|"course",cooldown?:number}, perDayBudget?:number }
   */
  function fillOpenSlots(draft, candidates, context = {}, opts = {}) {
    if (!draft || !draft.slots || !candidates || !candidates.length) return { draft, suggestions: {} };

    var suggestionsBySlot = {};

    // Build per-day windows for time awareness
    var windowsCache = {};
    for (var s=0; s<draft.slots.length; s++){
      var sl = draft.slots[s];
      if (!windowsCache[sl.dateISO]) {
        try { windowsCache[sl.dateISO] = scheduler.windowsForDay(sl.dateISO) || []; } catch (_e) { windowsCache[sl.dateISO] = []; }
      }
    }

    // For each open slot, rank recipes and keep top 3 suggestions
    var nextDraft = Object.assign({}, draft);
    var slotsCopy = draft.slots.slice(0);

    for (var i=0; i<slotsCopy.length; i++){
      var slot = slotsCopy[i];
      if (slot.locked) continue;
      if (slot.recipeId) continue; // already filled

      var dayWin = windowsCache[slot.dateISO] || [];
      var minutes = (dayWin[0] && dayWin[0].minutes) || (slot.daypart === "breakfast" ? 20 : slot.daypart === "lunch" ? 35 : 60);

      var ctx = Object.assign({}, context, { timeWindow: { availableMinutes: minutes }, daypart: slot.daypart });
      var ranked = [];
      try { ranked = decider.decide(candidates, ctx, { diversity: opts.diversity || { by: "cuisine", cooldown: 1 } }) || []; } catch (_e) { ranked = []; }

      var top3 = ranked.slice(0, 3);
      suggestionsBySlot[slot.id] = top3;

      // Auto-apply best if confident and budget/time OK
      var auto = top3[0];
      if (auto && auto.score >= 0.65) {
        // per-day budget quick gating
        if (opts.perDayBudget) {
          var tmp = applyRecipe(nextDraft, { slotId: slot.id }, auto.recipe, { servings: slot.servings });
          var daySlots = tmp.slots.filter(function (x){ return x.dateISO === slot.dateISO; });
          var sum = summarizeDay(daySlots);
          if (sum.cost.total <= opts.perDayBudget) {
            nextDraft = tmp;
          }
        } else {
          nextDraft = applyRecipe(nextDraft, { slotId: slot.id }, auto.recipe, { servings: slot.servings });
        }
      }
    }

    try {
      eventBus.emit("mealplan:fill", { draftId: draft.id, suggestedSlots: Object.keys(suggestionsBySlot).length });
      analytics.track("mealplan/fill", { suggestedSlots: Object.keys(suggestionsBySlot).length });
    } catch (_e) {}

    return { draft: nextDraft, suggestions: suggestionsBySlot };
  }

  /**
   * linkLeftovers(draft)
   * - If a dinner yields leftovers, auto-attach to next day's lunch open slot.
   */
  function linkLeftovers(draft) {
    var slots = draft.slots.slice(0);
    for (var i=0; i<slots.length; i++){
      var s = slots[i];
      if (toLower(s.daypart) !== "dinner" || !s.recipe) continue;
      var enr = enrichRecipe(s.recipe);
      var remain = safeNum(enr.leftoverServings, 0);
      if (!remain) continue;

      // find next day's lunch
      var d = new Date(s.dateISO); d.setDate(d.getDate()+1);
      var nextISO = d.toISOString().slice(0,10);
      var lunchIdx = slots.findIndex(function (x){ return x.dateISO === nextISO && toLower(x.daypart) === "lunch"; });
      if (lunchIdx >= 0) {
        var L = Object.assign({}, slots[lunchIdx]);
        if (!L.recipeId && !L.locked) {
          L.leftoversFrom = { recipeId: s.recipeId, servings: remain };
          L.notes = (L.notes ? L.notes + " • " : "") + "Leftovers from " + (s.recipe.title || "dinner");
          L.updatedAtISO = clock.now().toISOString();
          slots[lunchIdx] = L;
        }
      }
    }
    var out = Object.assign({}, draft, { slots: slots, updatedAtISO: clock.now().toISOString() });
    try { eventBus.emit("mealplan:leftovers:linked", { draftId: draft.id }); } catch (_e) {}
    return out;
  }

  /**
   * finalize(draft) -> { plan, deltas }
   * - Locks the draft into a plan payload (without writing to calendar here).
   * - Computes cost + macro totals and a light "shortage" signal for grocery.
   */
  function finalize(draft) {
    var days = {};
    for (var i=0; i<draft.slots.length; i++){
      var s = draft.slots[i];
      if (!days[s.dateISO]) days[s.dateISO] = [];
      days[s.dateISO].push(s);
    }

    var perDay = {};
    var totalCost = 0; var currency = "USD";
    var macrosTot = { calories:0, protein:0, carbs:0, fat:0 };
    var grocerySignal = { missingFrac: 0 };

    var missingSum = 0; var counted = 0;

    var dates = Object.keys(days).sort();
    for (var d=0; d<dates.length; d++){
      var arr = days[dates[d]];
      var sum = summarizeDay(arr);
      perDay[dates[d]] = sum;
      totalCost += sum.cost.total;
      currency = sum.cost.currency || currency;
      macrosTot.calories += sum.macros.calories;
      macrosTot.protein  += sum.macros.protein;
      macrosTot.carbs    += sum.macros.carbs;
      macrosTot.fat      += sum.macros.fat;

      for (var k=0; k<arr.length; k++){
        if (arr[k].recipe) { missingSum += shortageRatio(arr[k].recipe); counted++; }
      }
    }
    grocerySignal.missingFrac = counted ? (missingSum / counted) : 0;

    var plan = {
      id: uuid("plan"),
      createdAtISO: clock.now().toISOString(),
      fromDraftId: draft.id,
      slots: draft.slots.map(function (s){
        return {
          id: s.id, dateISO: s.dateISO, daypart: s.daypart,
          recipeId: s.recipeId || null, servings: s.servings || 1,
          leftoversFrom: s.leftoversFrom || null, notes: s.notes || null
        };
      }),
      totals: {
        cost: { total: totalCost, currency: currency },
        macros: macrosTot
      },
      grocerySignal // quick hint for grocery builder UI
    };

    try {
      eventBus.emit("mealplan:finalize", { draftId: draft.id, planId: plan.id, missingFrac: grocerySignal.missingFrac });
      analytics.track("mealplan/finalize", { planId: plan.id, totalCost, missingFrac: grocerySignal.missingFrac });
    } catch (_e) {}

    return { plan, deltas: { perDay } };
  }

  return {
    buildDraft,
    applyRecipe,
    removeFromSlot,
    swap,
    fillOpenSlots,
    linkLeftovers,
    finalize
  };
}

// ---------------- React Hook wrapper ------------------------------------------

/**
 * useMealPlanDraft
 * UI-friendly state + helpers:
 * - newDraft(opts)
 * - apply(where, recipeOrId, opts)
 * - swap(a,b), remove(slotId)
 * - fill(candidates, context, opts) -> populates suggestions & optionally auto-applies
 * - linkLeftovers()
 * - commit() -> { plan, deltas }, abandon()
 * - derived: openSlots, perDayTotals, grocerySignal, suggestions map
 */
export default function useMealPlanDraft(deps = {}) {
  const engineRef = useRef(null);
  if (!engineRef.current) engineRef.current = createMealPlanDraft(deps);

  const [draft, setDraft] = useState(null);
  const [suggestions, setSuggestions] = useState({}); // slotId -> [{recipe, score, explain}]

  const newDraft = useCallback((opts = {}) => {
    const d = engineRef.current.buildDraft(opts);
    setDraft(d);
    setSuggestions({});
    return d;
  }, []);

  const apply = useCallback((where, recipeOrId, opts = {}) => {
    if (!draft) return null;
    const next = engineRef.current.applyRecipe(draft, where, recipeOrId, opts);
    setDraft(next);
    return next;
  }, [draft]);

  const remove = useCallback((slotId) => {
    if (!draft) return null;
    const next = engineRef.current.removeFromSlot(draft, slotId);
    setDraft(next);
    return next;
  }, [draft]);

  const swap = useCallback((a, b) => {
    if (!draft) return null;
    const next = engineRef.current.swap(draft, a, b);
    setDraft(next);
    return next;
  }, [draft]);

  const fill = useCallback((candidates, context = {}, opts = {}) => {
    if (!draft) return { draft: null, suggestions: {} };
    const { draft: nd, suggestions: sug } = engineRef.current.fillOpenSlots(draft, candidates, context, opts);
    setDraft(nd);
    setSuggestions(Object.assign({}, suggestions, sug));
    return { draft: nd, suggestions: sug };
  }, [draft, suggestions]);

  const linkLeftovers = useCallback(() => {
    if (!draft) return null;
    const next = engineRef.current.linkLeftovers(draft);
    setDraft(next);
    return next;
  }, [draft]);

  const commit = useCallback(() => {
    if (!draft) return null;
    const res = engineRef.current.finalize(draft);
    // keep draft in state; upstream may clear after save
    return res;
  }, [draft]);

  const abandon = useCallback(() => {
    setDraft(null);
    setSuggestions({});
    return true;
  }, []);

  // -------- derived views -----------------------------------------------------

  const openSlots = useMemo(() => {
    if (!draft) return [];
    return draft.slots.filter((s) => !s.recipeId);
  }, [draft]);

  const perDayTotals = useMemo(() => {
    if (!draft) return {};
    const days = {};
    for (let i=0; i<draft.slots.length; i++){
      const s = draft.slots[i];
      if (!days[s.dateISO]) days[s.dateISO] = [];
      days[s.dateISO].push(s);
    }
    const out = {};
    const engine = engineRef.current;
    for (const dISO in days) {
      const sum = (function summarizeDay(slots, engine, draft) {
        var costTotal = 0; var ccy = "USD";
        var macros = { calories:0, protein:0, carbs:0, fat:0 };
        for (var i=0;i<slots.length;i++){
          var r = slots[i].recipe;
          if (!r) continue;
          var enr = (function enrich(recipe){
            var est = null; try { est = deps.estimateEngine ? deps.estimateEngine.cost(recipe) : null; } catch (_e) {}
            var nut = null; try { nut = deps.nutrition ? deps.nutrition.estimate(recipe) : null; } catch (_e) {}
            return { cost: est, nutrition: nut };
          })(r);
          if (enr.cost && isFinite(enr.cost.perServing)) {
            var servings = Number(slots[i].servings || r.yield || 1) || 1;
            costTotal += (enr.cost.perServing * servings);
            ccy = enr.cost.currency || ccy;
          }
          if (enr.nutrition) {
            var s = Number(slots[i].servings || enr.nutrition.servings || 1) || 1;
            macros.calories += (Number(enr.nutrition.calories||0) * s);
            macros.protein  += (Number(enr.nutrition.protein ||0) * s);
            macros.carbs    += (Number(enr.nutrition.carbs   ||0) * s);
            macros.fat      += (Number(enr.nutrition.fat     ||0) * s);
          }
        }
        return { cost: { total: costTotal, currency: ccy }, macros };
      })(days[dISO], engine, draft);
      out[dISO] = sum;
    }
    return out;
  }, [draft, deps]);

  const grocerySignal = useMemo(() => {
    if (!draft) return { missingFrac: 0 };
    let missingSum = 0, counted = 0;
    for (let i=0; i<draft.slots.length; i++){
      const s = draft.slots[i];
      if (s.recipe) {
        try { missingSum += deps.mapping ? deps.mapping.shortageRatio(s.recipe) : 0; } catch (_e) {}
        counted++;
      }
    }
    return { missingFrac: counted ? (missingSum / counted) : 0 };
  }, [draft, deps]);

  return {
    // actions
    newDraft,
    apply,
    remove,
    swap,
    fill,
    linkLeftovers,
    commit,
    abandon,
    // state & views
    draft,
    suggestions,
    openSlots,
    perDayTotals,
    grocerySignal
  };
}
