/* eslint-disable no-console */
// src/managers/MealPlanEngine.js
// “Plan Meal” bridge — builds draft/final plans from pantry+prefs+signals,
// writes schedules, supports user-owned favorites, and emits canonical events.
//
// Style: ES2015-safe, dependency-light, DI via factory. All deps optional (safe noops).
//
// Key guarantees:
// - User favorites & schedules are first-class (separate from system templates)
// - Sabbath guard + quiet hours respected when emitting/scheduling
// - Emits domain-aware events for downstream agents (grocery, coupons, inventory, garden)
// - Defensive persistence (Dexie optional), pure core logic w/ injectable adapters
//
// Tables used when Dexie is present (all optional):
// - DexieDB.mealPlans:       { id, status:'draft'|'final', title, range:{start,end}, days[], meta{} }
// - DexieDB.mealFavorites:   { id, owner:'user'|'system', title, planSnapshot{}, tags[], createdAt }
// - DexieDB.mealSessions:    { id, planId, schedule:{calendarId?, blocks[]}, owner:'user', createdAt }
// - DexieDB.schedules:       { id, domain:'meals', title, rrule?, tz?, blocks[], owner:'user'|'system' }
//
// Canonical events (subset):
// - mealplan.draft.requested -> mealplan.draft.created
// - mealplan.finalized -> grocerylist.generated (downstream), coupons.checked (downstream)
// - schedule.saved, session.saved.favorite
// - inventory.synced (downstream), nba.suggested
//
// Suggested deps (all optional, can be stubs):
// - DexieDB         : { tables? }
// - eventBus        : { emit(evt, payload) }
// - analytics       : { track(evt, payload) }
// - config          : { get(path, fb?), sabbathGuard?, quietHours? }
// - automation      : { scheduleBlocks(blocks, options) } // your runtime
// - recipeResolver  : { findCandidates(ctx), hydrate(ids) }
// - inventory       : { getPantry(), reserve(items), suggestSubstitutions(items) }
// - coupons         : { priceSignals({ storeIds?, brands? }), bestStacksFor(items) }
// - pricing         : { priceFor(skuOrRef, opts) }
// - calendar        : { nextFreeBlock({duration, after, window}) }
// - gardenBridge    : { suggestPlantingsFromMeals(plan) } // optional hook for seed→meal loop
//
// This module exposes a factory: createMealPlanEngine(deps)

const NULL_NOOP = Object.freeze({
  emit: () => {},
  track: () => {},
  get: (_path, fb) => (fb !== undefined ? fb : undefined),
});

const isBrowser = typeof window !== "undefined";
const now = () => new Date();

const clampHour = (d, quietHours) => {
  if (!quietHours) return d;
  const out = new Date(d);
  const [startH = 22, endH = 7] = quietHours; // default 10pm-7am
  const h = out.getHours();
  // If inside quiet window [startH..23] U [0..endH)
  const inside =
    (startH <= h && h <= 23) || (0 <= h && h < endH);
  if (inside) {
    out.setHours(endH, 5, 0, 0); // bump to quiet end + 5m
  }
  return out;
};

const withinSabbath = (d, sabbathGuard) => {
  // sabbathGuard: { enabled, start:'Fri 18:00', end:'Sat 20:00' } (example)
  if (!sabbathGuard?.enabled) return false;
  // Heuristic: if day is Friday evening → Saturday evening
  const dow = d.getDay(); // 0=Sun..6=Sat
  const hr = d.getHours();
  if (dow === 5 && hr >= 16) return true; // Fri after 4pm
  if (dow === 6 && hr < 21) return true;  // Sat before 9pm
  return false;
};

const safeJSON = {
  parse: (s, fb = null) => {
    try { return JSON.parse(s); } catch { return fb; }
  },
  stringify: (v) => {
    try { return JSON.stringify(v); } catch { return "{}"; }
  }
};

/** Utility: dedupe by key */
const dedupeBy = (arr, keyFn) => {
  const seen = new Set();
  return arr.filter((x) => {
    const k = keyFn(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

/** Formatters for UI & voice */
const UIFormatter = {
  toCards(plan) {
    const days = plan?.days || [];
    return days.map((d) => ({
      date: d.date,
      meals: (d.meals || []).map((m) => ({
        slot: m.slot, // breakfast/lunch/dinner/snack
        title: m.title,
        recipeId: m.recipeId,
        time: m.scheduledAt || null,
        badges: [
          ...(m.flags?.vegetarian ? ["Vegetarian"] : []),
          ...(m.flags?.lowCarb ? ["Low-carb"] : []),
          ...(m.coupon?.hasStack ? ["Stackable"] : []),
          ...(m.inventory?.allOnHand ? ["On-hand"] : []),
        ],
        sources: m.sources || [], // which providers informed this
      })),
    }));
  },
  toVoice(plan) {
    const parts = [];
    (plan?.days || []).forEach((d) => {
      const dateStr = new Date(d.date).toDateString();
      const items = (d.meals || []).map((m) => m.title).filter(Boolean);
      if (items.length) parts.push(`${dateStr}: ${items.join(", ")}`);
    });
    return parts.join(". ");
  },
};

function defaultScoring() {
  // Combine prefs, pricing, coupons, pantry fit, prep time, rotation variety
  return function scoreCandidate(ctx) {
    const {
      candidate,
      prefs = {},
      pantryFit = 0,
      priceScore = 0,
      couponScore = 0,
      rotationPenalty = 0,
      timeFit = 0,
      nutritionFit = 0
    } = ctx;

    let s = 0;
    s += pantryFit * 2.0;
    s += priceScore * 1.2;
    s += couponScore * 1.4;
    s += timeFit * 1.1;
    s += nutritionFit * 0.8;
    s -= rotationPenalty; // avoid repeats
    // Preference boosts
    if (prefs?.avoid?.includes(candidate?.id)) s -= 3.0;
    if (prefs?.favorites?.includes(candidate?.id)) s += 1.5;

    return s;
  };
}

/** Core planner */
function planWeek({ start, end, slotsPerDay, rankedRecipes, calendar, config }) {
  const sabbathGuard = config?.sabbathGuard;
  const quietHours = config?.quietHours;

  const days = [];
  const dayMs = 24 * 60 * 60 * 1000;

  const slots = slotsPerDay || ["breakfast", "lunch", "dinner"];
  let cursor = new Date(start).setHours(9, 0, 0, 0); // default morning

  for (let t = new Date(start).setHours(0, 0, 0, 0); t <= new Date(end).setHours(23, 59, 59, 999); t += dayMs) {
    const date = new Date(t);
    const meals = [];

    slots.forEach((slot, idx) => {
      const pick = rankedRecipes.shift(); // greedy take; ranked by score
      if (!pick) return;

      // propose a time for the slot
      const base = new Date(cursor);
      base.setHours(8 + idx * 4, 0, 0, 0); // 8, 12, 16 …

      // enforce quiet hours & sabbath
      let scheduled = clampHour(base, quietHours);
      if (withinSabbath(scheduled, sabbathGuard)) {
        // push to sabbath end (coarse)
        const bumped = new Date(scheduled);
        bumped.setDate(bumped.getDate() + ((6 - bumped.getDay() + 7) % 7)); // to next Sat
        bumped.setHours(21, 0, 0, 0);
        scheduled = bumped;
      }

      // ask calendar for next free block if available
      if (calendar?.nextFreeBlock) {
        const blk = calendar.nextFreeBlock({
          duration: pick.estimated?.cookMinutes ? pick.estimated.cookMinutes + 10 : 45,
          after: scheduled,
          window: { day: date }
        });
        if (blk?.start) scheduled = new Date(blk.start);
      }

      meals.push({
        slot,
        title: pick.title,
        recipeId: pick.id,
        scheduledAt: scheduled.toISOString(),
        inventory: pick.inventory || { allOnHand: false, missing: [] },
        coupon: pick.coupon || { hasStack: false },
        flags: pick.flags || {},
        sources: dedupeBy(
          [ ...(pick.sources || []), "planner.core" ],
          (x) => x
        ),
      });
    });

    days.push({ date: new Date(date).toISOString(), meals });
    // advance cursor 1 day
    cursor = new Date(cursor + dayMs);
  }
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString(), days };
}

export function createMealPlanEngine(deps = {}) {
  const DexieDB       = deps.DexieDB || null;
  const eventBus      = deps.eventBus || NULL_NOOP;
  const analytics     = deps.analytics || NULL_NOOP;
  const config        = deps.config || NULL_NOOP;
  const automation    = deps.automation || null;
  const recipeResolver= deps.recipeResolver || null;
  const inventory     = deps.inventory || null;
  const coupons       = deps.coupons || null;
  const pricing       = deps.pricing || null;
  const calendar      = deps.calendar || null;
  const gardenBridge  = deps.gardenBridge || null;

  const sabbathGuard  = config?.sabbathGuard || config?.get("sabbathGuard", { enabled: false });
  const quietHours    = config?.quietHours || config?.get("quietHours", [22, 7]);
  const scoreFn       = deps.scoreFn || defaultScoring();

  /** ———————————————————————— helpers: persistence (defensive) ———————————————————————— */
  async function savePlanDoc(doc) {
    if (!DexieDB?.mealPlans) return doc; // no storage, just echo
    const id = await DexieDB.mealPlans.put({ ...doc, updatedAt: now().toISOString() });
    return { ...doc, id };
  }
  async function saveFavoriteDoc(doc) {
    if (!DexieDB?.mealFavorites) return doc;
    const id = await DexieDB.mealFavorites.put({ ...doc, createdAt: now().toISOString() });
    return { ...doc, id };
  }
  async function saveSessionDoc(doc) {
    if (!DexieDB?.mealSessions) return doc;
    const id = await DexieDB.mealSessions.put({ ...doc, createdAt: now().toISOString() });
    return { ...doc, id };
  }

  async function listFavorites({ owner = "user" } = {}) {
    if (!DexieDB?.mealFavorites) return [];
    return DexieDB.mealFavorites.where("owner").equals(owner).reverse().toArray();
  }

  /** ————————————————————————— core: candidate discovery + scoring ————————————————————————— */
  async function buildCandidatePool(ctx) {
    // ctx: { range, prefs, constraints, storeIds?, timeBudget?, nutrition?, rotation? }
    const pantry = (await inventory?.getPantry?.()) || [];
    const storeIds = ctx.storeIds || [];
    const prefs = ctx.prefs || {};

    // 1) find recipes (resolver can use tags, pantry, time, nutrition)
    const candidates = (await recipeResolver?.findCandidates?.({
      pantry,
      prefs,
      constraints: ctx.constraints,
      timeBudget: ctx.timeBudget,
      nutrition: ctx.nutrition
    })) || [];

    // 2) hydrate basics
    const full = (await recipeResolver?.hydrate?.(candidates.map(c => c.id))) || candidates;

    // 3) compute pantryFit / missing lists
    full.forEach((r) => {
      const required = r.ingredients || [];
      const have = [];
      const missing = [];
      required.forEach((ing) => {
        const p = pantry.find((p) => (p.sku && p.sku === ing.sku) || p.name?.toLowerCase() === ing.name?.toLowerCase());
        if (p && p.quantity && p.quantity >= (ing.qty || 1)) have.push(ing);
        else missing.push(ing);
      });
      r.inventory = { allOnHand: missing.length === 0, missing };
    });

    // 4) price + coupon signals
    let priceIndex = {};
    if (pricing?.priceFor) {
      for (const r of full) {
        let agg = 0; let count = 0;
        for (const ing of (r.ingredients || [])) {
          const p = await pricing.priceFor(ing.sku || ing.name, { storeIds });
          if (p?.price) { agg += p.price * (ing.qty || 1); count += 1; }
        }
        r.estimated = r.estimated || {};
        if (count > 0) r.estimated.cost = agg;
      }
    }
    if (coupons?.bestStacksFor) {
      for (const r of full) {
        const best = await coupons.bestStacksFor(r.inventory?.missing || []);
        r.coupon = { hasStack: Array.isArray(best) && best.length > 0, stacks: best || [] };
      }
    }

    return full;
  }

  function rankCandidates(pool, ctx) {
    const prefs = ctx?.prefs || {};
    const rotation = ctx?.rotation || {};
    const results = pool.map((candidate) => {
      const pantryFit = candidate.inventory?.allOnHand ? 1 : Math.max(0, 1 - (candidate.inventory?.missing?.length || 0) / ((candidate.ingredients?.length || 1)));
      const priceScore = candidate.estimated?.cost ? Math.max(0, 1 / (1 + candidate.estimated.cost / 20)) : 0.2; // heuristic
      const couponScore = candidate.coupon?.hasStack ? 0.6 : 0;
      const timeFit = (() => {
        const m = candidate.estimated?.cookMinutes || 30;
        // prefer 20-45 min for dinner typical
        if (m >= 20 && m <= 45) return 1;
        if (m <= 15) return 0.8;
        if (m <= 60) return 0.7;
        return 0.4;
      })();
      const nutritionFit = candidate.flags?.highProtein ? 0.5 : 0.2;

      const rotationPenalty = rotation?.recentIds?.includes(candidate.id) ? 0.8 : 0;

      const score = scoreFn({
        candidate,
        prefs,
        pantryFit,
        priceScore,
        couponScore,
        rotationPenalty,
        timeFit,
        nutritionFit
      });

      return { ...candidate, _score: score };
    });

    results.sort((a, b) => b._score - a._score);
    return results;
  }

  /** —————————————————————————————— public API —————————————————————————————— */

  /**
   * Create a draft plan (non-destructive). Emits mealplan.draft.* and returns persisted doc if DB present.
   */
  async function draftPlan(options = {}) {
    const {
      title = "Draft Meal Plan",
      range = {},
      prefs = {},
      constraints = {},
      rotation = {},
      timeBudget,
      nutrition,
      storeIds = [],
      slotsPerDay = ["breakfast", "lunch", "dinner"],
    } = options;

    const start = range.start ? new Date(range.start) : now();
    const end   = range.end ? new Date(range.end) : new Date(start.getTime() + 6 * 24 * 60 * 60 * 1000);

    eventBus.emit("mealplan.draft.requested", { title, start, end, prefs, constraints, storeIds });
    analytics.track?.("mealplan_draft_requested", { start, end, slots: slotsPerDay.length });

    // Candidate pool + ranking
    const pool = await buildCandidatePool({ range: { start, end }, prefs, constraints, timeBudget, nutrition, storeIds, rotation });
    const ranked = rankCandidates(pool, { prefs, rotation });

    // Build plan grid
    const grid = planWeek({ start, end, slotsPerDay, rankedRecipes: ranked.slice(0, 7 * slotsPerDay.length), calendar, config: { sabbathGuard, quietHours } });

    const planDoc = {
      id: undefined,
      status: "draft",
      title,
      range: { start: grid.start, end: grid.end },
      days: grid.days,
      meta: {
        createdAt: now().toISOString(),
        prefs,
        constraints,
        sources: ["recipeResolver", "inventory", "pricing", "coupons"].filter((k) => !!deps[k]),
      },
    };

    const persisted = await savePlanDoc(planDoc);

    // Optional side-hook: suggest garden plantings from this week’s plan (seed → meal loop)
    if (gardenBridge?.suggestPlantingsFromMeals) {
      try {
        gardenBridge.suggestPlantingsFromMeals(persisted);
      } catch (e) {
        console.warn("[MealPlanEngine] gardenBridge.suggestPlantingsFromMeals failed:", e);
      }
    }

    eventBus.emit("mealplan.draft.created", { plan: persisted });
    analytics.track?.("mealplan_draft_created", { planId: persisted.id, days: persisted.days?.length || 0 });

    return persisted;
  }

  /**
   * Finalize a draft plan: reserves inventory (optional), triggers grocery + coupon checks.
   */
  async function finalizePlan(draft, opts = {}) {
    const { reserveInventory = false } = opts;
    const plan = { ...draft, status: "final" };

    // Optionally reserve missing ingredients (or create grocery tasks)
    const needItems = [];
    (plan.days || []).forEach((d) => {
      (d.meals || []).forEach((m) => {
        (m.inventory?.missing || []).forEach((ing) => needItems.push(ing));
      });
    });

    if (reserveInventory && inventory?.reserve) {
      try {
        await inventory.reserve(needItems);
        eventBus.emit("inventory.synced", { scope: "meals", items: needItems });
      } catch (e) {
        console.warn("[MealPlanEngine] inventory.reserve failed", e);
      }
    }

    eventBus.emit("mealplan.finalized", { plan });
    analytics.track?.("mealplan_finalized", { planId: plan.id, missing: needItems.length });

    // Downstream triggers (your agents listen to these)
    eventBus.emit("grocerylist.generate.requested", { planId: plan.id, items: needItems });
    eventBus.emit("coupons.check.requested", { planId: plan.id, items: needItems });

    // Persist final status
    const persisted = await savePlanDoc(plan);
    return persisted;
  }

  /**
   * Save a snapshot of a plan as a user favorite (distinct from system templates).
   */
  async function saveFavoritePlan(plan, { title, tags = [] } = {}) {
    const doc = await saveFavoriteDoc({
      owner: "user",
      title: title || plan.title || "Favorite Meal Plan",
      planSnapshot: {
        range: plan.range, days: plan.days, meta: plan.meta,
      },
      tags,
    });

    eventBus.emit("session.saved.favorite", { type: "meal-plan", favoriteId: doc.id });
    analytics.track?.("favorite_plan_saved", { favoriteId: doc.id, days: plan.days?.length || 0 });
    return doc;
  }

  /**
   * Create and save a session + schedule blocks to automation/calendar.
   * blocks: [{ start, end, title, note, ref:{type:'recipe', id} }]
   */
  async function saveSessionSchedule(plan, { title = "Meal Session", blocks = [], calendarId } = {}) {
    const safeBlocks = (blocks || []).map((b) => {
      const s = clampHour(new Date(b.start), quietHours);
      return withinSabbath(s, sabbathGuard) ? { ...b, start: new Date(s).toISOString(), note: (b.note || "") + " (auto-shifted for Sabbath/quiet hours)" } : { ...b, start: s.toISOString() };
    });

    // Persist session
    const sessionDoc = await saveSessionDoc({
      owner: "user",
      planId: plan.id,
      schedule: { calendarId: calendarId || "primary", blocks: safeBlocks },
      title,
    });

    // Send to automation runtime if present
    if (automation?.scheduleBlocks) {
      try {
        await automation.scheduleBlocks(safeBlocks, { calendarId: calendarId || "primary", domain: "meals" });
      } catch (e) {
        console.warn("[MealPlanEngine] automation.scheduleBlocks failed:", e);
      }
    }

    eventBus.emit("schedule.saved", { domain: "meals", sessionId: sessionDoc.id, blocks: safeBlocks });
    analytics.track?.("schedule_saved", { sessionId: sessionDoc.id, blocks: safeBlocks.length });

    return sessionDoc;
  }

  /**
   * Convenience: turn a favorite into a new draft (user-owned flow)
   */
  async function draftFromFavorite(favoriteId, { title, range } = {}) {
    let fav = null;
    if (DexieDB?.mealFavorites) {
      fav = await DexieDB.mealFavorites.get(favoriteId);
    }
    if (!fav?.planSnapshot) throw new Error("Favorite not found or missing snapshot");

    const snap = fav.planSnapshot;
    const shifted = shiftPlanRange(snap, range); // simple date shift
    return draftPlan({
      title: title || fav.title || "Draft from Favorite",
      range: shifted.range,
      prefs: (snap.meta && snap.meta.prefs) || {},
      constraints: (snap.meta && snap.meta.constraints) || {},
      slotsPerDay: deriveSlots(shifted.days),
    });
  }

  /** Format for UI cards */
  function formatForUI(plan) {
    return UIFormatter.toCards(plan);
  }

  /** Format for TTS / announcements */
  function formatForVoice(plan) {
    return UIFormatter.toVoice(plan);
  }

  /** Surfacing Next Best Action suggestions for shell UI */
  function nextBestActions(plan) {
    const actions = [];
    const needs = [];
    (plan.days || []).forEach((d) => (d.meals || []).forEach((m) => {
      (m.inventory?.missing || []).forEach((ing) => needs.push(ing));
    }));

    if (needs.length) {
      actions.push({ key: "generate_grocery_list", label: "Generate Grocery List", event: "grocerylist.generate.requested", payload: { planId: plan.id } });
      actions.push({ key: "check_coupons", label: "Check Coupons & Stacks", event: "coupons.check.requested", payload: { planId: plan.id } });
    } else {
      actions.push({ key: "start_cooking_session", label: "Start Cooking Session", event: "cooking.session.start.requested", payload: { planId: plan.id } });
    }

    actions.push({ key: "save_favorite", label: "Save as Favorite", event: "favorite.save.requested", payload: { planId: plan.id } });

    eventBus.emit("nba.suggested", { domain: "meals", planId: plan.id, actions });
    return actions;
  }

  /** ———————————————————————— utilities ———————————————————————— */

  function deriveSlots(days = []) {
    const set = new Set();
    days.forEach((d) => (d.meals || []).forEach((m) => set.add(m.slot)));
    const result = Array.from(set);
    return result.length ? result : ["breakfast", "lunch", "dinner"];
  }

  function shiftPlanRange(snapshot, newRange) {
    if (!newRange?.start || !newRange?.end) return { ...snapshot };
    const startOld = new Date(snapshot.range.start);
    const startNew = new Date(newRange.start);
    const delta = startNew.getTime() - startOld.getTime();

    const days = (snapshot.days || []).map((d) => {
      const nd = new Date(new Date(d.date).getTime() + delta);
      const meals = (d.meals || []).map((m) => {
        const t = m.scheduledAt ? new Date(m.scheduledAt) : null;
        const nt = t ? new Date(t.getTime() + delta) : null;
        return { ...m, scheduledAt: nt ? nt.toISOString() : null };
      });
      return { ...d, date: nd.toISOString(), meals };
    });

    return {
      range: { start: new Date(newRange.start).toISOString(), end: new Date(newRange.end).toISOString() },
      days
    };
  }

  /** ———————————————————————— public surface ———————————————————————— */
  return Object.freeze({
    // planning
    draftPlan,
    finalizePlan,
    // favorites
    saveFavoritePlan,
    listFavorites,
    draftFromFavorite,
    // sessions & schedules
    saveSessionSchedule,
    // formatting
    formatForUI,
    formatForVoice,
    nextBestActions,
  });
}

// Default export for convenience
export default { createMealPlanEngine };
