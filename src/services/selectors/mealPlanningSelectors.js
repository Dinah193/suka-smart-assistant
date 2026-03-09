// C:\Users\larho\suka-smart-assistant\src\services\selectors\mealPlanningSelectors.js
/**
 * mealPlanningSelectors
 * -----------------------------------------------------------------------------
 * PURPOSE
 * - Provide pure selector utilities for Meal Planning state/data in SSA.
 * - These selectors are SAFE to use in UI, engines, and shims.
 * - They should NOT mutate DB, and should be resilient when tables are missing.
 *
 * DESIGN
 * - Works with either:
 *    A) Dexie database instance passed in (preferred), OR
 *    B) Plain JS “state-like” objects (for tests or in-memory stores).
 *
 * NOTES
 * - Because your project has been evolving, table names may vary by branch.
 *   This file uses "duck typing" and defensive lookups to avoid crashes.
 * - If you want stricter behavior, flip `STRICT` to true.
 */

const STRICT = false;

/* -------------------------------------------------------------------------- */
/* Small utilities                                                            */
/* -------------------------------------------------------------------------- */

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

function asArray(v) {
  return Array.isArray(v) ? v : v ? [v] : [];
}

function toNum(v, fallback = 0) {
  const n = typeof v === "string" && v.trim() === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function isoDay(d = new Date()) {
  // YYYY-MM-DD in local time
  const dt = new Date(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const day = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function safeLower(s) {
  return String(s || "").toLowerCase();
}

function uniqBy(arr, keyFn) {
  const out = [];
  const seen = new Set();
  for (const item of asArray(arr)) {
    const k = keyFn(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

/**
 * Try to locate a Dexie table by common names.
 * @param {object} db Dexie instance
 * @param {string[]} names candidate property names
 */
function pickTable(db, names) {
  if (!db || !isObj(db)) return null;
  for (const n of names) {
    if (db[n] && typeof db[n].toArray === "function") return db[n];
  }
  return null;
}

async function safeToArray(table, { where, limit } = {}) {
  try {
    if (!table) return [];
    let q = table;
    if (where && typeof q.where === "function") {
      q = q.where(where.field)[where.op || "equals"](where.value);
    }
    if (limit && typeof q.limit === "function") q = q.limit(limit);
    if (typeof q.toArray === "function") return await q.toArray();
    return [];
  } catch (err) {
    if (STRICT) throw err;
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/* Canonical shapes (lightweight)                                             */
/* -------------------------------------------------------------------------- */

/**
 * Normalize a meal plan entry into:
 *  {
 *    id, dayKey, mealType, recipeId, recipeTitle,
 *    servings, notes, source
 *  }
 */
function normalizePlanEntry(e) {
  if (!e || !isObj(e)) return null;

  const id =
    e.id ||
    e._id ||
    e.key ||
    `${e.dayKey || e.date || ""}:${e.mealType || e.meal || ""}:${
      e.recipeId || e.recipe?.id || ""
    }`;

  const dayKey = e.dayKey || e.date || e.day || e.isoDay || e.dayISO || null;
  const mealType =
    e.mealType ||
    e.meal ||
    e.type ||
    (e.slot && e.slot.type) ||
    (e.slot && e.slot.mealType) ||
    null;

  const recipeId =
    e.recipeId ||
    (e.recipe && (e.recipe.id || e.recipe.recipeId)) ||
    e.recipe_id ||
    null;

  const recipeTitle =
    e.recipeTitle ||
    (e.recipe && (e.recipe.title || e.recipe.name)) ||
    e.title ||
    e.name ||
    null;

  const servings = e.servings ?? e.portions ?? e.people ?? null;
  const notes = e.notes || e.note || null;

  return {
    id,
    dayKey,
    mealType,
    recipeId,
    recipeTitle,
    servings: servings == null ? null : toNum(servings, null),
    notes,
    source: e.source || e.origin || "unknown",
    raw: e,
  };
}

/**
 * Normalize a recipe into:
 * { id, title, tags[], macros?, ingredients[]? }
 */
function normalizeRecipe(r) {
  if (!r || !isObj(r)) return null;
  const id = r.id || r.recipeId || r._id || r.key || null;
  const title = r.title || r.name || r.recipeTitle || null;

  const tags = Array.isArray(r.tags)
    ? r.tags
    : Array.isArray(r.tagIds)
    ? r.tagIds
    : typeof r.tags === "string"
    ? r.tags
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
    : [];

  const macros = r.macros || r.macroTotals || r.nutrition || null;
  const ingredients = Array.isArray(r.ingredients) ? r.ingredients : [];

  return { id, title, tags, macros, ingredients, raw: r };
}

/* -------------------------------------------------------------------------- */
/* Public selectors (Dexie-first)                                             */
/* -------------------------------------------------------------------------- */

/**
 * Load meal plan entries for a date range (inclusive).
 *
 * EXPECTED TABLES (best effort):
 * - db.meal_plans
 * - db.mealPlans
 * - db.mealPlanEntries
 * - db.plans_meals
 *
 * @param {object} args
 * @param {object} [args.db] Dexie db instance (preferred)
 * @param {string} args.startDay YYYY-MM-DD
 * @param {string} args.endDay YYYY-MM-DD
 * @param {string[]} [args.mealTypes] filter (e.g., ["breakfast","lunch","dinner"])
 * @returns {Promise<Array<Object>>} normalized entries
 */
export async function selectMealPlanRange({
  db,
  startDay,
  endDay,
  mealTypes,
} = {}) {
  const start = startDay || isoDay(new Date());
  const end = endDay || start;

  const table = pickTable(db, [
    "meal_plans",
    "mealPlans",
    "mealPlanEntries",
    "plans_meals",
    "mealplans",
  ]);

  const rows = await safeToArray(table);

  const allowedTypes = mealTypes ? new Set(mealTypes.map(safeLower)) : null;

  const out = [];
  for (const r of rows) {
    const n = normalizePlanEntry(r);
    if (!n) continue;

    // Range filter (string compare works for YYYY-MM-DD)
    if (n.dayKey && (n.dayKey < start || n.dayKey > end)) continue;

    if (allowedTypes) {
      const mt = safeLower(n.mealType);
      if (!allowedTypes.has(mt)) continue;
    }

    out.push(n);
  }

  // Sort by day then mealType for stable UI
  out.sort((a, b) => {
    const ad = a.dayKey || "";
    const bd = b.dayKey || "";
    if (ad !== bd) return ad < bd ? -1 : 1;
    const am = safeLower(a.mealType);
    const bm = safeLower(b.mealType);
    if (am !== bm) return am < bm ? -1 : 1;
    return String(a.id).localeCompare(String(b.id));
  });

  return out;
}

/**
 * Load all planned entries for a given dayKey.
 *
 * @param {object} args
 * @param {object} [args.db]
 * @param {string} args.dayKey YYYY-MM-DD
 * @returns {Promise<Array<Object>>}
 */
export async function selectMealPlanForDay({ db, dayKey } = {}) {
  const day = dayKey || isoDay(new Date());
  const all = await selectMealPlanRange({ db, startDay: day, endDay: day });
  return all;
}

/**
 * Load recipes referenced by a set of plan entries.
 *
 * EXPECTED TABLES (best effort):
 * - db.recipes
 * - db.recipeLibrary
 * - db.recipe_library
 * - db.recipeVault
 *
 * @param {object} args
 * @param {object} [args.db]
 * @param {Array<Object>} args.planEntries normalized plan entries
 * @returns {Promise<Map<string, Object>>} recipeId -> normalized recipe
 */
export async function selectRecipesForPlanEntries({ db, planEntries } = {}) {
  const ids = uniqBy(
    asArray(planEntries)
      .map((e) => e && e.recipeId)
      .filter(Boolean),
    (x) => String(x)
  );

  const recipeTable = pickTable(db, [
    "recipes",
    "recipeLibrary",
    "recipe_library",
    "recipeVault",
    "recipe_vault",
  ]);

  const allRecipes = await safeToArray(recipeTable);
  const byId = new Map();

  const want = new Set(ids.map((x) => String(x)));
  for (const r of allRecipes) {
    const nr = normalizeRecipe(r);
    if (!nr || !nr.id) continue;
    if (!want.has(String(nr.id))) continue;
    byId.set(String(nr.id)), nr;
  }

  return byId;
}

/**
 * Build a per-day summary (counts per mealType, unique recipes, etc.)
 *
 * @param {object} args
 * @param {Array<Object>} args.planEntries normalized plan entries
 * @returns {Object} summary keyed by dayKey
 */
export function summarizeMealPlanByDay({ planEntries } = {}) {
  const entries = asArray(planEntries);
  const byDay = {};

  for (const e of entries) {
    if (!e) continue;
    const dayKey = e.dayKey || "unknown";
    const mealType = safeLower(e.mealType || "unknown");
    if (!byDay[dayKey]) {
      byDay[dayKey] = {
        dayKey,
        totalEntries: 0,
        mealTypeCounts: {},
        uniqueRecipes: new Set(),
        servingsPlanned: 0,
      };
    }
    const d = byDay[dayKey];
    d.totalEntries += 1;
    d.mealTypeCounts[mealType] = (d.mealTypeCounts[mealType] || 0) + 1;

    if (e.recipeId) d.uniqueRecipes.add(String(e.recipeId));

    if (typeof e.servings === "number" && Number.isFinite(e.servings)) {
      d.servingsPlanned += e.servings;
    }
  }

  // finalize sets to counts
  for (const k of Object.keys(byDay)) {
    const d = byDay[k];
    d.uniqueRecipeCount = d.uniqueRecipes.size;
    d.uniqueRecipes = Array.from(d.uniqueRecipes);
  }

  return byDay;
}

/* -------------------------------------------------------------------------- */
/* Inventory-aware helpers (optional)                                         */
/* -------------------------------------------------------------------------- */

/**
 * Estimate grocery needs from plan entries + recipes.
 * This is intentionally conservative: it aggregates ingredient lines as strings
 * unless your recipe schema provides structured inventoryItemIds.
 *
 * EXPECTED RECIPE INGREDIENT SHAPE (best effort):
 * - { inventoryItemId, name/label, quantity, unit }
 *
 * @param {object} args
 * @param {Array<Object>} args.planEntries normalized plan entries
 * @param {Map<string, Object>} args.recipesById normalized recipes by id
 * @returns {Object} { lines: Array<{key,label,quantity,unit,inventoryItemId,recipeIds:[]}> }
 */
export function estimateIngredientsForPlan({ planEntries, recipesById } = {}) {
  const entries = asArray(planEntries);
  const byId = recipesById instanceof Map ? recipesById : new Map();

  const agg = new Map(); // key -> aggregated line

  for (const e of entries) {
    if (!e || !e.recipeId) continue;
    const r = byId.get(String(e.recipeId));
    if (!r) continue;

    const ings = Array.isArray(r.ingredients) ? r.ingredients : [];
    for (const ing of ings) {
      if (!ing) continue;
      const inventoryItemId = ing.inventoryItemId || ing.itemId || null;
      const label = ing.label || ing.name || ing.title || "Ingredient";
      const unit = ing.unit || "";
      const qty = toNum(ing.quantity ?? ing.qty, NaN);

      // If inventoryItemId exists, use that as stable key; otherwise fall back to label+unit
      const key = inventoryItemId
        ? `inv:${inventoryItemId}`
        : `txt:${safeLower(label)}|${safeLower(unit)}`;

      if (!agg.has(key)) {
        agg.set(key, {
          key,
          label,
          quantity: Number.isFinite(qty) ? qty : null,
          unit,
          inventoryItemId: inventoryItemId || null,
          recipeIds: new Set([String(e.recipeId)]),
        });
      } else {
        const row = agg.get(key);
        row.recipeIds.add(String(e.recipeId));
        // only sum quantities if both are numeric
        if (Number.isFinite(qty) && Number.isFinite(row.quantity)) {
          row.quantity += qty;
        } else if (Number.isFinite(qty) && row.quantity == null) {
          row.quantity = qty;
        }
      }
    }
  }

  const lines = Array.from(agg.values()).map((x) => ({
    ...x,
    recipeIds: Array.from(x.recipeIds),
  }));

  // stable sort: inventory first, then label
  lines.sort((a, b) => {
    const ai = a.inventoryItemId ? 0 : 1;
    const bi = b.inventoryItemId ? 0 : 1;
    if (ai !== bi) return ai - bi;
    return String(a.label).localeCompare(String(b.label));
  });

  return { lines };
}

/* -------------------------------------------------------------------------- */
/* State-object fallbacks (non-Dexie)                                         */
/* -------------------------------------------------------------------------- */

/**
 * If you have meal planning stored in a Zustand store or plain state object,
 * you can use these helpers.
 *
 * Expected shapes (flexible):
 * - state.mealPlans[] OR state.meal_plans[] OR state.plans_meals[]
 */
export function selectMealPlanRangeFromState({
  state,
  startDay,
  endDay,
  mealTypes,
} = {}) {
  const start = startDay || isoDay(new Date());
  const end = endDay || start;

  const list =
    (state && (state.mealPlans || state.meal_plans || state.plans_meals)) || [];

  const allowedTypes = mealTypes ? new Set(mealTypes.map(safeLower)) : null;

  const out = [];
  for (const r of asArray(list)) {
    const n = normalizePlanEntry(r);
    if (!n) continue;
    if (n.dayKey && (n.dayKey < start || n.dayKey > end)) continue;
    if (allowedTypes && !allowedTypes.has(safeLower(n.mealType))) continue;
    out.push(n);
  }

  out.sort((a, b) => {
    const ad = a.dayKey || "";
    const bd = b.dayKey || "";
    if (ad !== bd) return ad < bd ? -1 : 1;
    const am = safeLower(a.mealType);
    const bm = safeLower(b.mealType);
    if (am !== bm) return am < bm ? -1 : 1;
    return String(a.id).localeCompare(String(b.id));
  });

  return out;
}

/* -------------------------------------------------------------------------- */
/* Context selector (shim-friendly)                                           */
/* -------------------------------------------------------------------------- */

/**
 * selectMealPlanningContext
 * -----------------------------------------------------------------------------
 * Shim-friendly “context bundle” builder.
 * - This is PURE: it only reads from db/state and returns a computed object.
 * - Designed to be resilient even if tables vary by branch.
 *
 * @param {object} args
 * @param {object} [args.db] Dexie instance
 * @param {object} [args.state] plain JS fallback (optional)
 * @param {string} [args.startDay] YYYY-MM-DD
 * @param {string} [args.endDay] YYYY-MM-DD
 * @param {string[]} [args.mealTypes] filter
 * @param {boolean} [args.includeRecipes=true]
 * @param {boolean} [args.includeSummary=true]
 * @param {boolean} [args.includeIngredients=true]
 * @returns {Promise<object>}
 */
export async function selectMealPlanningContext({
  db,
  state,
  startDay,
  endDay,
  mealTypes,
  includeRecipes = true,
  includeSummary = true,
  includeIngredients = true,
} = {}) {
  const start = startDay || isoDay(new Date());
  const end = endDay || start;

  const planEntries = db
    ? await selectMealPlanRange({ db, startDay: start, endDay: end, mealTypes })
    : selectMealPlanRangeFromState({
        state,
        startDay: start,
        endDay: end,
        mealTypes,
      });

  const ctx = {
    startDay: start,
    endDay: end,
    mealTypes: mealTypes || null,
    planEntries,
    counts: {
      totalEntries: Array.isArray(planEntries) ? planEntries.length : 0,
    },
  };

  if (includeRecipes) {
    try {
      const recipesById = db
        ? await selectRecipesForPlanEntries({ db, planEntries })
        : new Map();
      ctx.recipesById = recipesById;
      ctx.counts.uniqueRecipes =
        recipesById && typeof recipesById.size === "number"
          ? recipesById.size
          : 0;
    } catch (err) {
      if (STRICT) throw err;
      ctx.recipesById = new Map();
      ctx.counts.uniqueRecipes = 0;
    }
  }

  if (includeSummary) {
    try {
      ctx.summaryByDay = summarizeMealPlanByDay({ planEntries });
    } catch (err) {
      if (STRICT) throw err;
      ctx.summaryByDay = {};
    }
  }

  if (includeIngredients) {
    try {
      const recipesById =
        ctx.recipesById instanceof Map ? ctx.recipesById : null;
      ctx.ingredientEstimate = estimateIngredientsForPlan({
        planEntries,
        recipesById: recipesById || new Map(),
      });
    } catch (err) {
      if (STRICT) throw err;
      ctx.ingredientEstimate = { lines: [] };
    }
  }

  return ctx;
}

/* -------------------------------------------------------------------------- */
/* Convenience exports                                                        */
/* -------------------------------------------------------------------------- */

export const MealPlanningSelectors = {
  selectMealPlanRange,
  selectMealPlanForDay,
  selectRecipesForPlanEntries,
  summarizeMealPlanByDay,
  estimateIngredientsForPlan,
  selectMealPlanRangeFromState,
  selectMealPlanningContext,
};

export default MealPlanningSelectors;
