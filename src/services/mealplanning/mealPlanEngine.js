// src/services/mealplanning/mealPlanEngine.js
// Dynamic, event-driven meal plan generator for Suka Smart Assistant.
// – West African–forward but adaptive to Household Favorites
// – Rhythm-based weekly planning with inventory-aware picks
// – Sabbath-safe scheduling windows
// – Batch Session Drafts + Multi-timer scaffolding
// – Next Best Action (NBA) suggestions
// – Undo patches and diff hooks
// – Agents-friendly (shimsClient) and Automation runtime emit

/* ----------------------------------------------------------------------------
   Imports (kept defensive – gracefully degrade if optional deps missing)
---------------------------------------------------------------------------- */
import { eventBus } from "@/services/events/eventBus";
import { automation, emitProgress } from "@/services/automation/runtime";
import { sabbathGuard } from "@/services/guardrails/sabbathGuard";

import { usePreferencesStore } from "@/store/PreferencesStore"; // contains flavor rhythms, diet prefs
import { useFoodStore } from "@/store/FoodStore"; // nutrition refs (USDA/custom)
import { MealPlans } from "@/store/MealPlanStore"; // persist/fetch meal plans
import { Inventory } from "@/store/InventoryStore"; // inventory & locations (root cellar, freezer)
import { CalendarSync } from "@/services/calendar/CalendarSync"; // sync plan to calendar
import { Recipes } from "@/store/RecipeStore"; // Recipe Library + Recipe Vault
import { BatchDrafts } from "@/store/BatchDraftStore"; // batch cooking session drafts
import { logger } from "@/utils/logger";
import { uid, deepClone } from "@/utils/obj";
import { startOfWeek, addDays, formatISO, isSameDay } from "@/utils/dates";
import { classNames as cx } from "@/utils/css"; // (not used here but kept for parity)
import { seededShuffle } from "@/utils/rand";
import { calcMacrosForRecipe, sumMacros } from "@/utils/nutrition";
import { cuisineWeights } from "@/services/mealplanning/recommenders/cuisineWeights";
import { seasonality } from "@/services/mealplanning/recommenders/seasonality";
import { recipeRanker } from "@/services/mealplanning/recommenders/recipeRanker";
import { shimsClient } from "@/agents/shimsClient";
// Optional: local diff util (your errors were in mealPlanDiff.js – this file just calls it)
import { diffPlans } from "@/services/mealplanning/mealPlanDiff"; // keep this import stable

/* ----------------------------------------------------------------------------
   Constants
---------------------------------------------------------------------------- */
const MEALS = ["breakfast", "lunch", "dinner", "snack"];
const DEFAULT_SERVINGS = 1; // per person scaling will adjust

// Cuisine emphasis: West African primary, but adaptive to household favorites & street/food-truck mode
const DEFAULT_CUISINE_PRIORITY = [
  { tag: "west-african", weight: 2.0 },
  { tag: "street-food", weight: 1.3 }, // kebabs, wraps, bowls, fritters
  { tag: "food-truck", weight: 1.2 }, // menu-scale, handheld, fast-serve
  { tag: "fusion", weight: 1.1 }, // e.g., Indian curry × German döner lamb fusion
];

/* ----------------------------------------------------------------------------
   Types (JSDoc for IDEs)
---------------------------------------------------------------------------- */
/**
 * @typedef {Object} PlanOptions
 * @property {string} householdId
 * @property {string} [weekStartISO] - Monday by default; pass specific start
 * @property {number} [numDays] - default 7
 * @property {"auto"|"guided"|"manual"} [strategy] - auto uses agents & rankers
 * @property {boolean} [sabbathSafe] - default true
 * @property {boolean} [createBatchDrafts] - default true (for weekend batch)
 * @property {boolean} [calendarSync] - default false (user confirms in UI)
 * @property {boolean} [respectInventory] - default true
 * @property {boolean} [balanceMacros] - default true
 * @property {boolean} [prioritizeFavorites] - default true
 * @property {string[]} [avoidIngredients] - health or Passover constraints
 * @property {Object} [targets] - custom macros/Calories targets per day
 */

/**
 * @typedef {Object} DayPlan
 * @property {string} dateISO
 * @property {Record<"breakfast"|"lunch"|"dinner"|"snack", MealSlot>} meals
 * @property {Object} nutrition - totals for the day
 */

/**
 * @typedef {Object} MealSlot
 * @property {string|null} recipeId
 * @property {string[]} tags
 * @property {number} servings
 * @property {Object} timers - parsed timers for cooking
 * @property {Object} macros - per-slot macros
 * @property {boolean} locked
 */

/**
 * @typedef {Object} MealPlan
 * @property {string} id
 * @property {string} householdId
 * @property {string} weekStartISO
 * @property {DayPlan[]} days
 * @property {Object} meta - version, createdBy, strategy
 * @property {Object} shopping - items to buy vs inventory deltas
 * @property {Object[]} actions - Next Best Actions (NBA toolbar)
 * @property {Object[]} undoPatch
 */

/* ----------------------------------------------------------------------------
   Public API
---------------------------------------------------------------------------- */
export const mealPlanEngine = {
  /**
   * Generate a weekly plan.
   * Returns { plan, diff, actions, undoPatch }
   * Emits events for UI and Automation runtime.
   * */
  async planWeek(opts /** @type {PlanOptions} */) {
    const options = normalizeOptions(opts);
    logger.info("[mealPlanEngine] planWeek", options);
    emitProgress("mealPlanEngine:begin", { options });

    const context = await buildContext(options);

    // 1) Create empty scaffold
    let draft = emptyPlan(context);

    // 2) Fill by rhythm, cuisine weights, seasonality, inventory, favorites
    draft = await fillPlan(context, draft);

    // 3) Nutrition pass (balance macros if requested)
    if (options.balanceMacros) {
      draft = await optimizeNutrition(context, draft);
    }

    // 4) Sabbath-safe scheduling (avoid long cook windows in Sabbath)
    if (options.sabbathSafe) {
      draft = ensureSabbathSafety(context, draft);
    }

    // 5) Inventory mapping + shopping deltas
    const shopping = computeShoppingList(context, draft);

    // 6) Batch Session Drafts
    let batchDraft = null;
    if (options.createBatchDrafts) {
      batchDraft = await createBatchSessionDraft(context, draft);
    }

    // 7) Actions (NBA)
    const actions = buildNextBestActions(
      context,
      draft,
      shopping,
      batchDraft,
      options
    );

    // 8) Persist
    const plan = await persistPlan(context, { ...draft, shopping, actions });

    // 9) Optional: Calendar Sync (user may toggle confirm in UI)
    if (options.calendarSync) {
      await CalendarSync.pushMealPlan(plan);
    }

    // 10) Diff from previous (for Undo Toast & Confirm Bar)
    const prev = await MealPlans.getPrevious(
      context.householdId,
      plan.weekStartISO
    );
    const diff = diffPlans(prev, plan);

    // 11) Undo patch (simple inverse ops placeholder)
    const undoPatch = buildUndoPatch(prev, plan);

    // Emit for UI listeners:
    eventBus.emit("mealplan:created", { planId: plan.id, diff });
    emitProgress("mealPlanEngine:done", { planId: plan.id });

    return { plan, diff, actions, undoPatch };
  },

  /** Regenerate day (keeps locked slots; re-fills unlocked). */
  async regenerateDay({ planId, dateISO, keepLocked = true }) {
    const plan = await MealPlans.getById(planId);
    if (!plan) throw new Error("Plan not found");
    const options = {
      householdId: plan.householdId,
      weekStartISO: plan.weekStartISO,
    };
    const context = await buildContext(options);

    const day = plan.days.find((d) => d.dateISO === dateISO);
    if (!day) throw new Error("Day not found in plan");

    const refilled = await refillDay(context, day, { keepLocked });
    const updated = replaceDay(plan, refilled);

    const diff = diffPlans(plan, updated);
    const undoPatch = buildUndoPatch(plan, updated);

    const saved = await MealPlans.update(updated);
    eventBus.emit("mealplan:updated", { planId: saved.id, diff });

    return { plan: saved, diff, undoPatch };
  },

  /** Suggest healthier or Passover-safe substitutes for a slot. */
  async suggestSubstitutions({ planId, dateISO, mealKey, constraints = {} }) {
    const plan = await MealPlans.getById(planId);
    if (!plan) throw new Error("Plan not found");
    const options = {
      householdId: plan.householdId,
      weekStartISO: plan.weekStartISO,
    };
    const context = await buildContext(options);

    const day = plan.days.find((d) => d.dateISO === dateISO);
    const slot = day?.meals?.[mealKey];
    if (!slot?.recipeId) return [];

    const avoid = new Set(
      constraints.avoidIngredients || context.prefs.avoidIngredients || []
    );
    const picks = await findSubstituteRecipes(context, slot, { avoid });

    return picks.slice(0, 12); // small curated list
  },

  /** Lightweight NBA recompute – call after user edits. */
  async recomputeActions(planId) {
    const plan = await MealPlans.getById(planId);
    if (!plan) throw new Error("Plan not found");
    const context = await buildContext({
      householdId: plan.householdId,
      weekStartISO: plan.weekStartISO,
    });
    const actions = buildNextBestActions(context, plan, plan.shopping, null, {
      calendarSync: false,
      createBatchDrafts: false,
    });
    await MealPlans.update({ ...plan, actions });
    eventBus.emit("mealplan:actions", { planId, actions });
    return actions;
  },
};

/* ----------------------------------------------------------------------------
   Normalize & Context
---------------------------------------------------------------------------- */
function normalizeOptions(opts) {
  const weekStart =
    opts.weekStartISO ||
    formatISO(startOfWeek(new Date(), { weekStartsOn: 1 })); // Monday
  return {
    strategy: "auto",
    numDays: 7,
    sabbathSafe: true,
    createBatchDrafts: true,
    calendarSync: false,
    respectInventory: true,
    balanceMacros: true,
    prioritizeFavorites: true,
    avoidIngredients: [],
    targets: null,
    ...opts,
    weekStartISO: weekStart,
  };
}

async function buildContext(options) {
  const prefs = usePreferencesStore.getState?.() || {};
  const food = useFoodStore.getState?.() || {};
  const household = prefs?.households?.[options.householdId] || {};

  const recipes = await Recipes.all(); // expect tags, nutrition, prep steps
  const inventory = await Inventory.snapshot(options.householdId);
  const prevPlan = await MealPlans.getPrevious(
    options.householdId,
    options.weekStartISO
  );

  const cuisineBias = cuisineWeights.merge(
    DEFAULT_CUISINE_PRIORITY,
    household?.cuisineBias
  );
  const rhythm = household?.mealRhythm || defaultRhythm();
  const targets =
    options.targets || household?.nutritionTargets || food?.defaultTargets;

  const season = seasonality.current(new Date());
  const sabbath = sabbathGuard?.window?.() || null;

  return {
    ...options,
    prefs,
    food,
    household,
    recipes,
    inventory,
    prevPlan,
    cuisineBias,
    rhythm,
    targets,
    season,
    sabbath,
  };
}

function defaultRhythm() {
  return {
    // Example: protein/technique/flavor by weekday & meal
    // User can edit in FoodSettingsPage and MealPlannerShell
    weekdays: {
      0: { dinner: ["soup|stew", "goat|lamb", "greens"] },
      1: { dinner: ["stir-fry|saute", "beef|fish", "pepper|onion"] },
      2: { dinner: ["grill|rotisserie", "lamb|goat", "street-food"] },
      3: { dinner: ["braise|smoke", "beef|lamb", "roots|tubers"] },
      4: { dinner: ["curry|sauce", "goat|fish", "fusion"] },
      5: { dinner: ["batch|bulk", "lamb|goat", "party|feast"] },
      6: { dinner: ["leftovers|simple", "fish|eggs", "salad|grains"] },
    },
  };
}

/* ----------------------------------------------------------------------------
   Plan Scaffolding
---------------------------------------------------------------------------- */
function emptyPlan(ctx) {
  const days = Array.from({ length: ctx.numDays }).map((_, i) => {
    const dateISO = formatISO(addDays(new Date(ctx.weekStartISO), i), {
      representation: "date",
    });
    return {
      dateISO,
      meals: {
        breakfast: newEmptySlot(),
        lunch: newEmptySlot(),
        dinner: newEmptySlot(),
        snack: newEmptySlot(),
      },
      nutrition: { Calories: 0, Protein: 0, Carbs: 0, Fat: 0, Fiber: 0 },
    };
  });

  return {
    id: `plan_${uid(8)}`,
    householdId: ctx.householdId,
    weekStartISO: ctx.weekStartISO,
    days,
    shopping: { need: [], deltas: [], byLocation: {} },
    meta: {
      version: 1,
      createdAt: new Date().toISOString(),
      createdBy: "mealPlanEngine",
      strategy: ctx.strategy,
    },
    actions: [],
    undoPatch: [],
  };
}

function newEmptySlot() {
  return {
    recipeId: null,
    tags: [],
    servings: DEFAULT_SERVINGS,
    timers: {},
    macros: {},
    locked: false,
  };
}

/* ----------------------------------------------------------------------------
   Fill Plan
---------------------------------------------------------------------------- */
async function fillPlan(ctx, draft) {
  let out = deepClone(draft);

  // Strategy dispatch (more strategies can be added)
  if (ctx.strategy === "manual") return out;

  for (const day of out.days) {
    for (const mealKey of MEALS) {
      // skip if already locked/filled
      if (day.meals[mealKey]?.locked || day.meals[mealKey]?.recipeId) continue;

      const picks = await rankRecipesForSlot(ctx, day, mealKey);
      const chosen = picks[0] || null;

      if (chosen) {
        day.meals[mealKey] = attachRecipeToSlot(
          ctx,
          chosen,
          day.meals[mealKey]
        );
      }
    }

    // compute day nutrition
    day.nutrition = computeDayNutrition(ctx, day);
  }

  return out;
}

async function rankRecipesForSlot(ctx, day, mealKey) {
  const weekday = new Date(day.dateISO).getDay();
  const rhythmHints = ctx.rhythm?.weekdays?.[weekday]?.[mealKey] || [];
  const avoid = new Set(ctx.avoidIngredients || []);
  const hasInventory = buildInventoryMap(ctx.inventory);

  // Use recipeRanker to combine weights: cuisine, rhythm, favorites, seasonality, inventory
  let ranked = recipeRanker.rank(ctx.recipes, {
    mealKey,
    rhythmHints,
    cuisineBias: ctx.cuisineBias,
    season: ctx.season,
    favorites: ctx.household?.favorites || {},
    avoidIngredients: avoid,
    respectInventory: ctx.respectInventory,
    inventoryMap: hasInventory,
    passoverMode: ctx.prefs?.calendar?.passoverMode || false,
  });

  // Deterministic shuffle per day to avoid same pattern every run while staying stable per plan
  ranked = seededShuffle(ranked, seedForDay(ctx, day));

  return ranked.slice(0, 12);
}

function seedForDay(ctx, day) {
  return `${ctx.householdId}:${ctx.weekStartISO}:${day.dateISO}`;
}

function attachRecipeToSlot(ctx, recipe, slot) {
  const timers = parseTimers(recipe);
  const macros = calcMacrosForRecipe(
    recipe,
    slot.servings,
    ctx.food?.macroRefs
  );
  const tags = [...new Set([...(slot.tags || []), ...(recipe.tags || [])])];
  return { ...slot, recipeId: recipe.id, timers, macros, tags };
}

/* ----------------------------------------------------------------------------
   Nutrition Optimization
---------------------------------------------------------------------------- */
async function optimizeNutrition(ctx, draft) {
  const out = deepClone(draft);
  for (const day of out.days) {
    // Simple pass: if Calories deviate >15% from target, attempt a swap on snack/lunch
    if (!ctx.targets?.Calories) continue;
    const target = ctx.targets.Calories;
    const dev = day.nutrition.Calories - target;

    if (Math.abs(dev) / target > 0.15) {
      const mealKey = dev > 0 ? "snack" : "lunch"; // trim or boost
      const picks = await rankRecipesForSlot(ctx, day, mealKey);

      const better = picks.find((r) => {
        const m = calcMacrosForRecipe(
          r,
          day.meals[mealKey].servings,
          ctx.food?.macroRefs
        );
        if (dev > 0) return m.Calories < day.meals[mealKey].macros?.Calories; // lower cal
        return m.Calories > day.meals[mealKey].macros?.Calories; // higher cal
      });

      if (better) {
        day.meals[mealKey] = attachRecipeToSlot(ctx, better, {
          ...day.meals[mealKey],
          locked: false,
        });
        day.nutrition = computeDayNutrition(ctx, day);
      }
    }
  }
  return out;
}

function computeDayNutrition(ctx, day) {
  const totals = { Calories: 0, Protein: 0, Carbs: 0, Fat: 0, Fiber: 0 };
  for (const key of MEALS) {
    const m = day.meals[key]?.macros || {};
    totals.Calories += m.Calories || 0;
    totals.Protein += m.Protein || 0;
    totals.Carbs += m.Carbs || 0;
    totals.Fat += m.Fat || 0;
    totals.Fiber += m.Fiber || 0;
  }
  return totals;
}

/* ----------------------------------------------------------------------------
   Sabbath Guard
---------------------------------------------------------------------------- */
function ensureSabbathSafety(ctx, draft) {
  if (!ctx.sabbath) return draft;
  const out = deepClone(draft);
  for (const day of out.days) {
    if (
      !isSameDay(new Date(day.dateISO), ctx.sabbath.from) &&
      !isSameDay(new Date(day.dateISO), ctx.sabbath.to)
    ) {
      continue;
    }
    // Replace long-cook dinner with ready/leftovers if timers exceed threshold
    const dinner = day.meals.dinner;
    const longCook = totalActiveTime(dinner?.timers) > 45; // minutes
    if (longCook && !dinner.locked) {
      const quick = quickSwapCandidate(ctx, day, "dinner");
      if (quick) {
        day.meals.dinner = attachRecipeToSlot(ctx, quick, {
          ...dinner,
          locked: false,
        });
        day.nutrition = computeDayNutrition(ctx, day);
      }
    }
  }
  return out;
}

function totalActiveTime(timers) {
  if (!timers) return 0;
  return Object.values(timers).reduce((sum, t) => sum + (t?.minutes || 0), 0);
}

function quickSwapCandidate(ctx, day, mealKey) {
  const ranked = recipeRanker.rank(ctx.recipes, {
    mealKey,
    rhythmHints: [],
    cuisineBias: ctx.cuisineBias,
    season: ctx.season,
    favorites: ctx.household?.favorites || {},
    avoidIngredients: new Set(ctx.avoidIngredients || []),
    respectInventory: ctx.respectInventory,
    preferQuick: true,
  });
  return ranked.find((r) => (parseTimers(r)?.totalMinutes || 0) <= 30) || null;
}

/* ----------------------------------------------------------------------------
   Inventory Mapping & Shopping
---------------------------------------------------------------------------- */
function buildInventoryMap(inventory) {
  const map = new Map();
  (inventory?.items || []).forEach((item) => {
    map.set(item.slug || item.name?.toLowerCase(), item.qty || 0);
  });
  return map;
}

function computeShoppingList(ctx, draft) {
  const need = [];
  const deltas = [];
  const byLocation = {};

  for (const day of draft.days) {
    for (const key of MEALS) {
      const slot = day.meals[key];
      if (!slot.recipeId) continue;
      const recipe = ctx.recipes.find((r) => r.id === slot.recipeId);
      if (!recipe?.ingredients) continue;

      for (const ing of recipe.ingredients) {
        const slug = (ing.slug || ing.name || "").toLowerCase();
        const invItem = ctx.inventory?.items?.find(
          (i) => (i.slug || i.name?.toLowerCase()) === slug
        );
        const have = invItem?.qty || 0;
        const needQty = (ing.qty || 0) * slot.servings;

        if (have >= needQty) {
          deltas.push({
            type: "reserve",
            slug,
            qty: needQty,
            day: day.dateISO,
          });
          byLocation[invItem?.location || "pantry"] =
            (byLocation[invItem?.location || "pantry"] || 0) + 1;
        } else {
          need.push({
            slug,
            qty: needQty - have,
            day: day.dateISO,
            aisle: ing.aisle || null,
          });
        }
      }
    }
  }
  return { need, deltas, byLocation };
}

/* ----------------------------------------------------------------------------
   Batch Session Drafts (for Weekend bulk cooking)
---------------------------------------------------------------------------- */
async function createBatchSessionDraft(ctx, draft) {
  // Heuristic: aggregate Sat/Sun dinners + a few lunches with overlapping ingredients
  const weekend = draft.days.filter((d) => {
    const dow = new Date(d.dateISO).getDay();
    return dow === 6 || dow === 0; // Saturday (6) & Sunday (0) depending locale
  });

  const recipeIds = [];
  for (const day of weekend) {
    for (const key of ["dinner", "lunch"]) {
      const id = day.meals[key]?.recipeId;
      if (id) recipeIds.push(id);
    }
  }

  const unique = [...new Set(recipeIds)];
  if (!unique.length) return null;

  const recipes = unique
    .map((id) => ctx.recipes.find((r) => r.id === id))
    .filter(Boolean);

  const multiTimers = buildMultiTimerPayload(recipes);

  const draftObj = {
    id: `batch_${uid(8)}`,
    householdId: ctx.householdId,
    title: "Weekend Batch Session",
    dateSuggested: weekend?.[0]?.dateISO || ctx.weekStartISO,
    recipes: unique,
    timers: multiTimers,
    labels: ["batch", "weekend", "auto"],
    createdAt: new Date().toISOString(),
  };

  await BatchDrafts.save(draftObj);
  eventBus.emit("batch:draftCreated", draftObj);
  return draftObj;
}

function buildMultiTimerPayload(recipes) {
  // Flatten each recipe timers into a multi-timer plan the UI can parse
  return recipes.map((r) => ({
    recipeId: r.id,
    steps: (r.steps || []).map((s, i) => ({
      id: `${r.id}_s${i}`,
      label: s.label || `Step ${i + 1}`,
      minutes: s.minutes || 0,
      // Voice step support: BatchCookingAssistant will TTS & start timers
      voice: s.voice || s.label || null,
    })),
  }));
}

/* ----------------------------------------------------------------------------
   Actions (NBA toolbar)
---------------------------------------------------------------------------- */
function buildNextBestActions(ctx, plan, shopping, batchDraft, options) {
  const actions = [];

  if (shopping?.need?.length) {
    actions.push({
      id: "shopping_list_generate",
      label: "Generate Grocery List",
      icon: "shopping-bag",
      intent: "generate-shopping",
      payload: { planId: plan.id },
    });
  }
  if (batchDraft) {
    actions.push({
      id: "open_batch_draft",
      label: "Review Weekend Batch Draft",
      icon: "timer",
      intent: "open-batch-draft",
      payload: { draftId: batchDraft.id },
    });
  }
  if (!options.calendarSync) {
    actions.push({
      id: "calendar_sync_preview",
      label: "Preview Calendar Sync",
      icon: "calendar",
      intent: "calendar-sync",
      payload: { planId: plan.id },
    });
  }
  // Health scan (ingredient risk → safer substitutes)
  actions.push({
    id: "health_scan",
    label: "Scan for Non-Earth Ingredients",
    icon: "stethoscope",
    intent: "health-scan",
    payload: { planId: plan.id },
  });

  // Preservation queue (if plan includes bulk meats/produce)
  actions.push({
    id: "queue_preservation",
    label: "Queue Preservation Tasks",
    icon: "jar",
    intent: "preservation-queue",
    payload: { planId: plan.id },
  });

  // Cooking session generator
  actions.push({
    id: "start_cooking_session",
    label: "Start Cooking Session",
    icon: "chef-hat",
    intent: "start-cooking",
    payload: { planId: plan.id },
  });

  return actions;
}

/* ----------------------------------------------------------------------------
   Persistence & Undo
---------------------------------------------------------------------------- */
async function persistPlan(ctx, plan) {
  const saved = await MealPlans.save(plan);
  // Fire automation hooks (non-blocking)
  automation.queue?.("onMealPlanCreated", {
    planId: saved.id,
    householdId: saved.householdId,
  });
  return saved;
}

function buildUndoPatch(prev, next) {
  // Minimalist inverse patch: replace plan with prev snapshot
  // Your UndoToast can accept this and wire to MealPlans.overwrite(id, snapshot)
  return [{ op: "replace_plan", fromPlanId: next?.id, snapshot: prev || null }];
}

/* ----------------------------------------------------------------------------
   Refill Day
---------------------------------------------------------------------------- */
async function refillDay(ctx, day, { keepLocked }) {
  const out = deepClone(day);
  for (const key of MEALS) {
    const slot = out.meals[key];
    if (keepLocked && slot.locked) continue;
    const picks = await rankRecipesForSlot(ctx, out, key);
    const chosen = picks[0] || null;
    out.meals[key] = chosen
      ? attachRecipeToSlot(ctx, chosen, { ...slot, locked: false })
      : { ...slot, recipeId: null };
  }
  out.nutrition = computeDayNutrition(ctx, out);
  return out;
}

function replaceDay(plan, newDay) {
  const out = deepClone(plan);
  out.days = out.days.map((d) => (d.dateISO === newDay.dateISO ? newDay : d));
  return out;
}

/* ----------------------------------------------------------------------------
   Substitutions
---------------------------------------------------------------------------- */
async function findSubstituteRecipes(ctx, slot, { avoid }) {
  const base = ctx.recipes.filter((r) => r.id !== slot.recipeId);
  const ranked = recipeRanker.rank(base, {
    mealKey: inferMealKeyFromSlot(slot),
    cuisineBias: ctx.cuisineBias,
    season: ctx.season,
    favorites: ctx.household?.favorites || {},
    avoidIngredients: avoid,
    respectInventory: ctx.respectInventory,
    preferQuick: true,
  });
  return ranked;
}

function inferMealKeyFromSlot(slot) {
  // simple heuristic based on tags or macros
  if (slot?.tags?.includes("breakfast")) return "breakfast";
  if (slot?.tags?.includes("snack")) return "snack";
  return "dinner"; // default
}

/* ----------------------------------------------------------------------------
   Timers Parser
---------------------------------------------------------------------------- */
function parseTimers(recipe) {
  // Expect recipe.steps = [{label, minutes, active?}, ...]
  if (!recipe?.steps?.length) return { totalMinutes: 0, steps: [] };
  const steps = recipe.steps.map((s, i) => ({
    id: `${recipe.id}_t${i}`,
    label: s.label || `Step ${i + 1}`,
    minutes: s.minutes || 0,
    active: s.active ?? true,
  }));
  const totalMinutes = steps.reduce((a, b) => a + (b.minutes || 0), 0);
  return { totalMinutes, steps };
}

/* ----------------------------------------------------------------------------
   Agents Hooks (Optional, failsafe)
---------------------------------------------------------------------------- */
// Example: ask AI to propose a “fusion” variant if rankings tie
async function maybeAskAgentForFusion(ctx, candidates, day, mealKey) {
  try {
    if (!shimsClient?.generateFusionVariant) return null;
    if (!candidates?.length) return null;
    const top = candidates
      .slice(0, 3)
      .map((r) => ({ id: r.id, tags: r.tags || [] }));
    const fusion = await shimsClient.generateFusionVariant({
      cuisineBias: ctx.cuisineBias,
      day: day.dateISO,
      mealKey,
      candidates: top,
    });
    if (!fusion?.id) return null;
    const recipe = ctx.recipes.find((r) => r.id === fusion.id);
    return recipe || null;
  } catch (e) {
    logger.warn("[mealPlanEngine] fusion agent failed – continue locally", e);
    return null;
  }
}

/* ----------------------------------------------------------------------------
   Exports for testing
---------------------------------------------------------------------------- */
export default mealPlanEngine;
export {
  normalizeOptions,
  buildContext,
  emptyPlan,
  fillPlan,
  optimizeNutrition,
  ensureSabbathSafety,
  computeShoppingList,
  createBatchSessionDraft,
  buildNextBestActions,
};
