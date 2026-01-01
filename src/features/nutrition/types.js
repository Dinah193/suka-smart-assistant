// src/features/nutrition/types.js
// Centralized shapes, guards, constants, and small helpers for the Nutrition feature.
// This file is pure JS with rich JSDoc types for great IDE support in JS or TS projects.

/* -----------------------------------------------------------------------------
 * Versioning
 * -------------------------------------------------------------------------- */
export const NUTRITION_TYPES_VERSION = "1.1.0"; // synced with MacroPercentCalculator/NutritionImportBridge updates

/* -----------------------------------------------------------------------------
 * Event Names (cross-module orchestration)
 * -------------------------------------------------------------------------- */
export const EVENTS = Object.freeze({
  RECIPES_IMPORTED: "suka:recipesImported",
  INVENTORY_UPSERT: "suka:inventoryUpsert",
  GROCERY_MERGE: "suka:groceryListMerge",
  MACRO_PLAN_APPLIED: "suka:macroPlanApplied",
  MEAL_PLAN_GENERATED: "suka:mealPlanGenerated",
  MEAL_PLAN_NEEDS_GROCERY_REFRESH: "suka:mealPlanNeedsGroceryRefresh",
  BATCH_QUEUE_ADD: "suka:batchQueueAdd",
  NUTRITION_RESOLVED: "suka:nutritionResolved",
  NUTRITION_ERROR: "suka:nutritionError",
});

/* -----------------------------------------------------------------------------
 * Storage Keys (kept consistent across components)
 * -------------------------------------------------------------------------- */
export const STORAGE_KEYS = Object.freeze({
  MACRO_CALC: "macroCalc:v1",
  IMPORT_BRIDGE: "nutritionImportBridge:v1",
  MEAL_PLAN_CACHE: "mealPlanMap:last",
  NUTRITION_CACHE: "nutritionLookup:v1",
});

/* -----------------------------------------------------------------------------
 * Units & Conversions (lightweight; nutritionLookupService has extended hints)
 * -------------------------------------------------------------------------- */
export const UNITS = Object.freeze({
  g: "g",
  kg: "kg",
  mg: "mg",
  lb: "lb",
  oz: "oz",
  tbsp: "tbsp",
  tsp: "tsp",
  cup: "cup",
  piece: "piece",
});

export const UNIT_ALIASES = Object.freeze({
  g: ["g", "gram", "grams"],
  kg: ["kg", "kilogram", "kilograms"],
  mg: ["mg", "milligram", "milligrams"],
  lb: ["lb", "lbs", "pound", "pounds"],
  oz: ["oz", "ounce", "ounces"],
  tbsp: ["tbsp", "tablespoon", "tablespoons"],
  tsp: ["tsp", "teaspoon", "teaspoons"],
  cup: ["cup", "cups"],
  piece: ["piece", "pieces", "pc", "pcs", "egg", "eggs"], // piece-like
});

export const UNIT_TO_G = Object.freeze({
  g: 1,
  kg: 1000,
  mg: 0.001,
  lb: 453.592,
  oz: 28.3495,
  tbsp: 14, // generic fallback (exact per ingredient handled via hints)
  tsp: 5,
  cup: 240,
  piece: 50, // generic fallback (eggs etc. refine via hints)
});

/** Minimal density hints to keep this file lean (full set lives in nutritionLookupService) */
export const DENSITY_HINTS = Object.freeze([
  { match: /(olive\s*oil|oil)/i, unitG: { tbsp: 13.5, tsp: 4.5, cup: 216 } },
  { match: /(water|broth|stock|milk)/i, unitG: { tbsp: 15, tsp: 5, cup: 240 } },
  { match: /(flour|millet|oat)/i, unitG: { tbsp: 8, tsp: 2.6, cup: 120 } },
  { match: /(sugar|salt)/i, unitG: { tbsp: 12.5, tsp: 4.2, cup: 200 } },
  { match: /(spinach)/i, unitG: { cup: 30 } },
  { match: /(egg)/i, unitG: { piece: 50 } },
  { match: /(beef|lamb|goat|chicken|salmon)/i, unitG: { oz: 28.3495, lb: 453.592 } },
]);

/** Canonicalize a unit string into one of UNITS or null */
export function canonicalUnit(u) {
  if (!u) return null;
  const s = String(u).trim().toLowerCase();
  for (const [canon, variants] of Object.entries(UNIT_ALIASES)) {
    if (variants.includes(s)) return canon;
  }
  return null;
}

/** Convert (name, qty, unit) → grams using hints or generic conversion */
export function unitToGrams(name, qty, unit) {
  const c = canonicalUnit(unit);
  if (!c || !qty) return null;

  for (const hint of DENSITY_HINTS) {
    if (hint.match.test(name)) {
      const map = hint.unitG || {};
      if (map[c] != null) return qty * map[c];
    }
  }
  return UNIT_TO_G[c] != null ? qty * UNIT_TO_G[c] : null;
}

/* -----------------------------------------------------------------------------
 * Macro Presets (mirrors MacroPercentCalculator)
 * -------------------------------------------------------------------------- */
export const MACRO_PRESETS = Object.freeze({
  balanced: { key: "balanced", label: "Balanced 30/30/40", protein: 30, fat: 30, carbs: 40 },
  highprotein: { key: "highprotein", label: "High-Protein 40/30/30", protein: 40, fat: 30, carbs: 30 },
  lowcarb: { key: "lowcarb", label: "Low-Carb 35/40/25", protein: 35, fat: 40, carbs: 25 },
  keto: { key: "keto", label: "Keto 20/70/10", protein: 20, fat: 70, carbs: 10 },
  custom: { key: "custom", label: "Custom", protein: 30, fat: 30, carbs: 40 },
});

/* -----------------------------------------------------------------------------
 * Typedefs (JSDoc): Use these across your codebase for safety + intellisense
 * -------------------------------------------------------------------------- */
/**
 * @typedef {Object} MacroPercents
 * @property {number} protein - percentage 0–100
 * @property {number} fat - percentage 0–100
 * @property {number} carbs - percentage 0–100
 */

/**
 * @typedef {Object} MacroGrams
 * @property {number} protein - grams per day
 * @property {number} fat - grams per day
 * @property {number} carbs - grams per day
 */

/**
 * @typedef {Object} MacroTargets
 * @property {number} calories
 * @property {MacroPercents} macrosPct
 * @property {MacroGrams} macrosG
 * @property {number} mealsPerDay
 */

/**
 * @typedef {Object} MacroPlanMeta
 * @property {string} [source]
 * @property {string} [timestamp]
 * @property {string} [preset]
 */

/**
 * @typedef {Object} MacroPlan
 * @property {MacroTargets} targets
 * @property {MacroPlanMeta} [meta]
 * @property {Object} [user] - optional body stats snapshot
 * @property {Object} [rules] - proteinByWeight, proteinPerLb/Kg, etc.
 * @property {Object} [intents] - downstream module hints
 */

/**
 * @typedef {Object} NutritionFacts
 * @property {number} kcal
 * @property {number} protein
 * @property {number} fat
 * @property {number} carbs
 * @property {number} [fiber]
 * @property {number} [sugar]
 * @property {number} [sodium_mg]
 * @property {number} [zinc_mg]
 * @property {number} [magnesium_mg]
 * @property {number} [iron_mg]
 * @property {number} [omega3_g]
 */

/**
 * @typedef {Object} Recipe
 * @property {string} id
 * @property {string} title
 * @property {string[]} ingredients
 * @property {string[]} [steps]
 * @property {string[]} [tags]
 * @property {NutritionFacts|{protein:number,fat:number,carbs:number,kcal?:number}} [macros] - per serving/recipe (your app treats it as one portion per slot unless specified)
 */

/**
 * @typedef {Object} InventoryItem
 * @property {string} id
 * @property {string} name
 * @property {number} qty
 * @property {string} unit
 * @property {string} [location]
 * @property {string} [category]
 * @property {number} [gramsDefault]
 * @property {NutritionFacts} [nutrition]
 * @property {{torahAllowed?: boolean}} [flags]
 */

/**
 * @typedef {Object} GroceryItem
 * @property {string} name
 * @property {string} unit
 * @property {number} qty
 */

/**
 * @typedef {Object} MealSlot
 * @property {number} mealIndex
 * @property {string|null} recipeId
 * @property {string} title
 * @property {{protein:number,fat:number,carbs:number,kcal:number}} macros
 */

/**
 * @typedef {Object} MealDay
 * @property {string} id
 * @property {number} index
 * @property {MealSlot[]} meals
 */

/**
 * @typedef {Object} MealPlan
 * @property {string} id
 * @property {number} days
 * @property {number} mealsPerDay
 * @property {{protein:number,fat:number,carbs:number,kcal:number}} perMealTargets
 * @property {MacroGrams} dailyTargets
 * @property {number} targetCalories
 * @property {MealDay[]} schedule
 * @property {{protein:number,fat:number,carbs:number,kcal:number}} totals
 * @property {{need:GroceryItem[],missing:GroceryItem[]}} grocery
 * @property {{source:string,createdAt:string}} context
 */

/**
 * @typedef {Object} ImportPayload
 * @property {Recipe[]} [recipes]
 * @property {InventoryItem[]} [items]
 * @property {MacroPlan|null} [macroPlan]
 * @property {{routeRecipesToLibrary:boolean,routeItemsToInventory:boolean,alsoQueueBatch:boolean,mergeGroceryList:boolean,applyMacroPlan:boolean}} [routes]
 * @property {{name?:string,url?:string,detected?:string}} [source]
 * @property {string} [timestamp]
 */

/**
 * @typedef {Object} NutritionResolvedInventoryDetail
 * @property {"inventory"} type
 * @property {InventoryItem[]} items
 */

/**
 * @typedef {Object} NutritionResolvedRecipeDetail
 * @property {"recipe"} type
 * @property {string} recipeId
 * @property {{lines:Array, totals:NutritionFacts, flags?:Object, scores?:Object}} nutrition
 */

/**
 * @typedef {NutritionResolvedInventoryDetail|NutritionResolvedRecipeDetail} NutritionResolvedDetail
 */

/* -----------------------------------------------------------------------------
 * Guards / Validators (lightweight runtime checks)
 * -------------------------------------------------------------------------- */
export const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/** @param {any} x @returns {x is Recipe} */
export function isRecipe(x) {
  return isObject(x) && typeof x.id === "string" && typeof x.title === "string" && Array.isArray(x.ingredients);
}

/** @param {any} x @returns {x is InventoryItem} */
export function isInventoryItem(x) {
  return isObject(x) && typeof x.id === "string" && typeof x.name === "string";
}

/** @param {any} x @returns {x is MacroPlan} */
export function isMacroPlan(x) {
  // Accept both full MacroPlan and shorthand with {calories, macrosPct|macrosG}
  if (!isObject(x)) return false;
  if (isObject(x.targets)) {
    const t = x.targets;
    return typeof t.calories === "number" && (isObject(t.macrosG) || isObject(t.macrosPct));
  }
  return typeof x.calories === "number" && (isObject(x.macrosG) || isObject(x.macrosPct));
}

/** @param {any} e @returns {e is CustomEvent<NutritionResolvedDetail>} */
export function isNutritionResolvedEvent(e) {
  const d = e?.detail;
  if (!d) return false;
  if (d.type === "inventory" && Array.isArray(d.items)) return true;
  if (d.type === "recipe" && typeof d.recipeId === "string" && isObject(d.nutrition)) return true;
  return false;
}

/* -----------------------------------------------------------------------------
 * Normalizers (kept tiny; NutritionImportBridge has richer variants)
 * -------------------------------------------------------------------------- */
/** @param {any} r @returns {Recipe} */
export function normalizeRecipe(r) {
  const id = String(r?.id || r?._id || cryptoSafeUid());
  const title = String(r?.title || r?.name || r?.recipe || "Untitled Recipe");
  const ingredients = Array.isArray(r?.ingredients)
    ? r.ingredients
    : typeof r?.ingredients === "string"
    ? r.ingredients.split(/[\n;]+/).map((s) => s.trim()).filter(Boolean)
    : [];
  const steps = Array.isArray(r?.steps)
    ? r.steps
    : typeof r?.steps === "string"
    ? r.steps.split(/[\n;]+/).map((s) => s.trim()).filter(Boolean)
    : [];
  const tags = Array.isArray(r?.tags)
    ? r.tags
    : typeof r?.category === "string"
    ? [r.category]
    : Array.isArray(r?.category)
    ? r.category
    : [];
  const macros = r?.macros || r?.nutrition || null;
  return { id, title, ingredients, steps, tags, macros };
}

/** @param {any} it @returns {InventoryItem} */
export function normalizeItem(it) {
  const id = String(it?.id || it?._id || cryptoSafeUid());
  const name = String(it?.name || it?.item || it?.ingredient || it?.food || "Unnamed Item");
  const qty = Number(it?.qty ?? it?.quantity ?? it?.count ?? 1) || 1;
  const unit = String(it?.unit || it?.units || "");
  const location = it?.location || it?.store || it?.pantry || "";
  const category = it?.category || it?.group || "";
  return { id, name, qty, unit, location, category };
}

/** @param {any} src @returns {MacroPlan|null} */
export function normalizeMacroPlan(src) {
  if (!src) return null;
  if (isMacroPlan(src)) {
    // already looks like MacroPlan (either full or shorthand)
    if (src.targets) return /** @type {MacroPlan} */ (src);
    // wrap shorthand into MacroPlan
    return { targets: {
      calories: src.calories,
      macrosPct: src.macrosPct || { protein: 30, fat: 30, carbs: 40 },
      macrosG: src.macrosG || null,
      mealsPerDay: src.mealsPerDay || 3,
    }};
  }
  if (isObject(src?.macroPlan)) return normalizeMacroPlan(src.macroPlan);
  return null;
}

/* -----------------------------------------------------------------------------
 * Misc helpers
 * -------------------------------------------------------------------------- */
export const clamp = (n, a, b) => Math.min(b, Math.max(a, Number.isFinite(n) ? n : 0));
export const round0 = (n) => Math.round(Number(n) || 0);
export const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;

/** Safe uid across environments (falls back to Math.random if crypto unavailable) */
export function cryptoSafeUid() {
  try {
    // @ts-ignore
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      const arr = new Uint32Array(2);
      crypto.getRandomValues(arr);
      return (arr[0].toString(36) + arr[1].toString(36)).slice(0, 12);
    }
  } catch {}
  return Math.random().toString(36).slice(2, 14);
}

/** Simple Torah filter used in multiple places */
export function isTorahAllowedText(text = "") {
  const ban = /(pork|bacon|ham|prosciutto|shrimp|lobster|crab|oyster|clam|mussel|scallop|catfish)/i;
  return !ban.test(String(text));
}

/** Minimal ingredient line parser (kept in sync with nutritionLookupService) */
export function parseIngredientLine(line) {
  const s = String(line || "").trim();
  if (!s) return { name: "", qty: 1, unit: "", grams: 0 };

  // mixed fraction "1 1/2"
  const mfrac = s.match(/(\d+)\s+(\d+)\/(\d+)/);
  let qty = 1;
  let rest = s;

  if (mfrac) {
    qty = Number(mfrac[1]) + Number(mfrac[2]) / Math.max(1, Number(mfrac[3]));
    rest = s.replace(/(\d+)\s+(\d+)\/(\d+)/, "").trim();
  } else {
    const mnum = s.match(/^(\d+(\.\d+)?)\s+(.*)$/);
    if (mnum) {
      qty = Number(mnum[1]);
      rest = mnum[3];
    }
  }

  // detect unit
  const parts = rest.split(/\s+/);
  let unit = "";
  let name = rest;

  if (parts.length > 1) {
    const maybe = canonicalUnit(parts[0]);
    if (maybe) {
      unit = maybe;
      name = parts.slice(1).join(" ");
    } else if (/^eggs?$/i.test(parts[0])) {
      unit = UNITS.piece;
      name = parts.slice(1).join(" ");
    }
  }

  if (!unit && /\beggs?\b/i.test(rest)) {
    unit = UNITS.piece;
    name = rest.replace(/\beggs?\b/i, "").trim() || "egg";
  }

  const grams = unitToGrams(name, qty, unit) ?? 0;
  return { name: name.trim(), qty, unit, grams };
}
