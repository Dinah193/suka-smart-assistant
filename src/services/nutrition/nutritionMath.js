// src/services/nutrition/nutritionMath.js
// Nutrition math utilities for Suka Smart Assistant
// - Unit conversion (US + metric), density-aware grams estimation
// - Macro/micro per-ingredient & per-recipe calculations
// - Daily totals, %DV, target comparison (USDA or custom)
// - BMI, BMR (Mifflin-St Jeor), TDEE
// - Passover (chametz) detection, additive/ultra-processed risk scoring
// - West-African staples aliases & densities
//
// Pure functions. No external deps. Defensive fallbacks.

// Optional logger (defensive import)
let logger = { info: () => {}, warn: () => {}, error: () => {} };
try { ({ logger } = await import("@/utils/logger")); } catch {}

// ---------------------------------------------------------------------------
// Constants & Reference Data
// ---------------------------------------------------------------------------

export const MACRO_KEYS = ["Calories", "Protein", "Carbs", "Fat", "Fiber"];
export const MICRO_KEYS = [
  "Sugar", "Sodium", "SatFat",
  "Potassium", "Calcium", "Iron", "VitaminC", "VitaminA"
];

const DEFAULT_TARGETS = {
  Calories: 2000, Protein: 100, Carbs: 250, Fat: 67, Fiber: 30,
  Sugar: 50, Sodium: 2000, SatFat: 20
};

// Simple DV (Daily Value) reference (adult), rounded
const DAILY_VALUES = {
  Calories: 2000, Protein: 50, Carbs: 275, Fiber: 28, Sugar: 50, Fat: 78,
  SatFat: 20, Sodium: 2300, Potassium: 4700, Calcium: 1300, Iron: 18,
  VitaminC: 90, VitaminA: 900
};

// Density map (g per cup) for common staples; adjustable via options
const DENSITY_G_PER_CUP = {
  // grains/starches
  "rice cooked": 195, "jollof rice": 195, "brown rice cooked": 195, "quinoa cooked": 170,
  "millet cooked": 174, "oats dry": 80, "oats cooked": 234, "fufu": 250, "eba": 240, "garri hydrated": 240,
  "cassava (grated)": 150, "yam boiled chunks": 150, "plantain fried slices": 130,
  // legumes
  "beans cooked": 175, "lentils cooked": 198, "chickpeas cooked": 164,
  // veg
  "tomato chopped": 180, "onion chopped": 160, "spinach cooked": 180, "greens cooked": 200,
  "okra sliced": 160, "egusi ground": 120,
  // fats
  "palm oil": 218, "olive oil": 218,
  // protein
  "lamb cooked diced": 150, "goat cooked diced": 150, "beef cooked diced": 150, "fish cooked": 145, "egg whole": 50,
  // dairy alt
  "yogurt": 245
};

// Unit conversion maps
const MASS_TO_G = {
  g: 1, gram: 1, grams: 1,
  kg: 1000, kilogram: 1000, kilograms: 1000,
  mg: 0.001, milligram: 0.001, milligrams: 0.001,
  lb: 453.592, lbs: 453.592, pound: 453.592, pounds: 453.592,
  oz: 28.3495, ounce: 28.3495, ounces: 28.3495,
};

const VOL_TO_ML = {
  ml: 1, milliliter: 1, milliliters: 1,
  l: 1000, liter: 1000, liters: 1000,
  tsp: 4.92892, teaspoon: 4.92892, teaspoons: 4.92892,
  tbsp: 14.7868, tablespoon: 14.7868, tablespoons: 14.7868,
  cup: 240, cups: 240,
  floz: 29.5735, "fl oz": 29.5735, fluidounce: 29.5735,
};

const CHAMETZ_TAGS = new Set(["chametz", "leaven", "leavening-agent", "bread", "pasta", "beer", "waffle", "pancake"]);
const LEAVEN_INGREDIENTS = new Set(["yeast","baking powder","baking soda","sourdough starter"]);
const NON_EARTH_ADDITIVES = new Set([
  "artificial color","artificial flavour","artificial flavor","red 40","yellow 5","blue 1","caramel color",
  "sodium nitrite","sodium benzoate","potassium sorbate","bht","bha","tbhq","sucralose","aspartame","acesulfame k",
  "polysorbate 80","propylene glycol","monosodium glutamate","msg","disodium inosinate","disodium guanylate"
]);

// Some synonym aliases for density lookup
const ALIASES = [
  ["jollof rice","rice cooked"], ["eba","garri hydrated"], ["greens cooked","spinach cooked"],
  ["lamb cooked cubes","lamb cooked diced"], ["goat cooked cubes","goat cooked diced"]
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const toLower = (s) => (s || "").toString().trim().toLowerCase();

export function roundN(x, n = 1) {
  if (!Number.isFinite(x)) return 0;
  const p = Math.pow(10, n);
  return Math.round(x * p) / p;
}

export function safeNum(x, fallback = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : fallback;
}

export function mergeTargets(base = {}, override = {}) {
  const out = { ...base };
  for (const k of Object.keys(override || {})) {
    if (override[k] != null) out[k] = override[k];
  }
  return out;
}

// Map a food name to a density key
function normalizeDensityKey(name) {
  const key = toLower(name);
  if (DENSITY_G_PER_CUP[key]) return key;
  for (const [a, b] of ALIASES) {
    if (key.includes(a)) return b;
  }
  // try partial matches
  for (const k of Object.keys(DENSITY_G_PER_CUP)) {
    if (key.includes(k)) return k;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Unit Conversion
// ---------------------------------------------------------------------------

export function toGrams({ qty = 0, unit, name, densityGPerCup }) {
  const q = safeNum(qty, 0);
  const u = toLower(unit);

  if (MASS_TO_G[u]) return q * MASS_TO_G[u];

  // handle volume with density
  const ml = VOL_TO_ML[u] ? q * VOL_TO_ML[u] : 0;
  if (ml > 0) {
    // Use density per cup (240ml)
    const densKey = normalizeDensityKey(name);
    const dens = densityGPerCup || (densKey ? DENSITY_G_PER_CUP[densKey] : null);
    if (dens) return (ml / 240) * dens;

    // Fallback heuristics
    // oils ~ 0.92 g/ml; water-ish ~1 g/ml
    const liquidGuess = u === "tbsp" || u === "tsp" || u === "cup" || u === "ml" || u === "l" || u === "floz" || u === "fl oz";
    return liquidGuess ? ml * 0.98 : 0; // nearly water
  }

  // piece-based (e.g., eggs): try simple approximations
  if (["piece","pcs","pc","egg","eggs"].includes(u)) {
    const n = q;
    const key = normalizeDensityKey(name);
    if (key && /egg/.test(key)) return n * 50;
    // else unknown piece weight
    return n * 50; // generic fallback
  }

  return 0;
}

export function parseQty(q) {
  if (q == null) return 0;
  if (typeof q === "number") return q;
  const s = q.toString().trim();
  // handle vulgar fractions like "1 1/2"
  const parts = s.split(" ");
  let total = 0;
  for (const p of parts) {
    if (p.includes("/")) {
      const [a, b] = p.split("/").map(Number);
      if (Number.isFinite(a) && Number.isFinite(b) && b !== 0) total += a / b;
    } else {
      const n = Number(p);
      if (Number.isFinite(n)) total += n;
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Ingredient & Recipe Nutrition
// ---------------------------------------------------------------------------

/**
 * Ingredient model expectations (flexible):
 * {
 *  name, qty, unit,
 *  nutritionPer: "100g" | "serving" | "piece" | undefined,
 *  servingGrams: number,
 *  grams: number,
 *  nutrition: { Calories, Protein, Carbs, Fat, Fiber, Sugar, Sodium, SatFat, ... }
 *  tags: string[]
 * }
 */

// normalize to grams and per-gram nutrition
export function normalizeIngredient(ing) {
  const out = { ...(ing || {}) };
  out.name = out.name || "";
  const qty = parseQty(out.qty);
  const grams = out.grams != null ? out.grams : toGrams({
    qty, unit: out.unit, name: out.name, densityGPerCup: out.densityGPerCup
  });

  out.grams = grams;

  // Determine the scale factor to one gram
  let perGram = null;
  const n = out.nutrition || {};
  const np = toLower(out.nutritionPer);

  if (n && Object.keys(n).length) {
    if (np === "100g") perGram = scaleMap(n, 1 / 100);
    else if (np === "serving" && out.servingGrams) perGram = scaleMap(n, 1 / out.servingGrams);
    else if (np === "piece" && out.pieceGrams) perGram = scaleMap(n, 1 / out.pieceGrams);
    else if (out.servingGrams) perGram = scaleMap(n, 1 / out.servingGrams);
    else if (out.pieceGrams) perGram = scaleMap(n, 1 / out.pieceGrams);
    else if (grams > 0) perGram = scaleMap(n, 1 / grams);
  }

  return { ...out, perGramNutrition: perGram };
}

function scaleMap(obj, k) {
  const out = {};
  for (const [key, val] of Object.entries(obj || {})) {
    out[key] = safeNum(val) * k;
  }
  return out;
}

export function macrosForIngredient(ing) {
  const n = normalizeIngredient(ing);
  const grams = safeNum(n.grams, 0);
  const per = n.perGramNutrition || {};
  const vals = scaleMap(per, grams);

  // Ensure all keys exist
  const out = {
    Calories: safeNum(vals.Calories),
    Protein: safeNum(vals.Protein),
    Carbs: safeNum(vals.Carbs),
    Fat: safeNum(vals.Fat),
    Fiber: safeNum(vals.Fiber),
    Sugar: safeNum(vals.Sugar),
    Sodium: safeNum(vals.Sodium),
    SatFat: safeNum(vals.SatFat),
  };
  return out;
}

export function sumMacros(list = []) {
  const total = {
    Calories: 0, Protein: 0, Carbs: 0, Fat: 0, Fiber: 0,
    Sugar: 0, Sodium: 0, SatFat: 0
  };
  for (const m of list) {
    if (!m) continue;
    for (const k of Object.keys(total)) total[k] += safeNum(m[k], 0);
  }
  return total;
}

/**
 * Recipe shape expectation:
 * {
 *   id, title, servings (default 1),
 *   ingredients: [ { ...ing } ],
 *   steps: [ { label, minutes, active } ],
 *   tags: [ ... ],
 *   nutritionOverridePerServing?: { ... } // optional explicit per-serving macros
 * }
 */
export function calcMacrosForRecipe(recipe, servings = 1, macroRefs = {}) {
  if (!recipe) return emptyMacros();
  const s = Math.max(1, safeNum(servings || recipe.servings || 1, 1));

  if (recipe.nutritionOverridePerServing) {
    const per = recipe.nutritionOverridePerServing;
    return {
      Calories: safeNum(per.Calories) * s,
      Protein: safeNum(per.Protein) * s,
      Carbs: safeNum(per.Carbs) * s,
      Fat: safeNum(per.Fat) * s,
      Fiber: safeNum(per.Fiber) * s,
      Sugar: safeNum(per.Sugar) * s,
      Sodium: safeNum(per.Sodium) * s,
      SatFat: safeNum(per.SatFat) * s,
    };
  }

  const items = (recipe.ingredients || []).map(macrosForIngredient);
  const totals = sumMacros(items);

  // scale to selected servings if recipe quantities modeled per serving
  // Assume ingredients quantities are for 1 serving unless recipe.servings > 1 is explicitly marked
  const baseServings = Math.max(1, safeNum(recipe.servings, 1));
  const scale = s / baseServings;

  const out = mapVals(totals, (v) => v * scale);

  // Optionally map energy from macros if Calories missing
  if (!out.Calories || out.Calories === 0) {
    out.Calories = roundN(out.Protein * 4 + out.Carbs * 4 + out.Fat * 9, 0);
  }

  return out;
}

function mapVals(obj, fn) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = fn(v, k);
  return out;
}

function emptyMacros() {
  return { Calories: 0, Protein: 0, Carbs: 0, Fat: 0, Fiber: 0, Sugar: 0, Sodium: 0, SatFat: 0 };
}

// Day totals from slots { breakfast, lunch, dinner, snack }
export function totalsForDay(day) {
  const totals = emptyMacros();
  if (!day?.meals) return totals;
  for (const k of ["breakfast","lunch","dinner","snack"]) {
    const m = day.meals[k]?.macros || {};
    for (const key of Object.keys(totals)) totals[key] += safeNum(m[key], 0);
  }
  return totals;
}

// % of targets
export function percentOfTarget(totals, targets = DEFAULT_TARGETS) {
  const out = {};
  for (const [k, v] of Object.entries(targets)) {
    const denom = safeNum(v, 0);
    out[k] = denom > 0 ? roundN((safeNum(totals[k], 0) / denom) * 100, 0) : 0;
  }
  return out;
}

// %DV (Nutrition label style)
export function percentDV(totals) {
  const out = {};
  for (const [k, dv] of Object.entries(DAILY_VALUES)) {
    const val = safeNum(totals[k], 0);
    out[k] = dv > 0 ? roundN((val / dv) * 100, 0) : 0;
  }
  return out;
}

// Simple glycemic load estimate from grams carbs and a GI guess (0-100)
export function glycemicLoad(carbsG, gi = 55) {
  return roundN((safeNum(carbsG,0) * safeNum(gi,55)) / 100, 1);
}

// ---------------------------------------------------------------------------
// Health Flags & Scorers
// ---------------------------------------------------------------------------

// Detect likely chametz/leaven restrictions for Passover mode
export function isPassoverRestrictedIngredient(ing = {}) {
  const name = toLower(ing.name);
  const tags = new Set((ing.tags || []).map(toLower));
  for (const t of tags) if (CHAMETZ_TAGS.has(t)) return true;
  if ([...LEAVEN_INGREDIENTS].some(x => name.includes(x))) return true;
  // heuristics for wheat/barley/rye-based unless tagged unleavened
  if (/(bread|pasta|barley|wheat|rye|beer)/.test(name) && !tags.has("unleavened")) return true;
  return false;
}

export function additiveRiskScore(ing = {}) {
  const name = toLower(ing.name);
  const tags = (ing.tags || []).map(toLower);
  let score = 0;

  // count additive tags
  for (const t of tags) {
    if (NON_EARTH_ADDITIVES.has(t)) score += 2;
    if (/e[0-9]{3,4}/.test(t)) score += 1; // E numbers
    if (/(artificial|synthetic)/.test(t)) score += 1.5;
    if (/(preservative|color|colour|stabilizer|stabiliser|emulsifier)/.test(t)) score += 1;
  }
  // name heuristics
  if (/(color|colour|nitrite|benzoate|sorbate|bht|bha|tbhq|aspartame|sucralose|acesulfame|polysorbate|propylene glycol|msg)/.test(name))
    score += 2;

  // scale 0–10
  return Math.max(0, Math.min(10, score));
}

// Nova-esque ultra processed proxy (very rough)
export function ultraProcessedIndex(ingredientList = []) {
  if (!Array.isArray(ingredientList)) return 0;
  let total = 0;
  for (const ing of ingredientList) total += additiveRiskScore(ing);
  const avg = ingredientList.length ? total / ingredientList.length : 0;
  // map 0–10 to 0–100
  return roundN(avg * 10, 0);
}

// ---------------------------------------------------------------------------
// Profiles: BMI / BMR / TDEE & Target Recommendations
// ---------------------------------------------------------------------------

export function bmi({ heightCm, weightKg }) {
  const h = safeNum(heightCm, 0) / 100;
  const w = safeNum(weightKg, 0);
  if (h <= 0 || w <= 0) return 0;
  return roundN(w / (h * h), 1);
}

// Mifflin St Jeor
export function bmr({ gender = "female", heightCm, weightKg, age }) {
  const w = safeNum(weightKg, 0);
  const h = safeNum(heightCm, 0);
  const a = safeNum(age, 0);
  if (w <= 0 || h <= 0 || a <= 0) return 0;
  const base = 10 * w + 6.25 * h - 5 * a + (gender === "male" ? 5 : -161);
  return roundN(base, 0);
}

// TDEE factor (activity 1.2–1.9)
export function tdee({ bmrValue, activity = 1.4 }) {
  const b = safeNum(bmrValue, 0);
  const f = Math.min(1.9, Math.max(1.2, safeNum(activity, 1.4)));
  return roundN(b * f, 0);
}

// Recommend macro targets given profile/goals
export function recommendTargets({ profile = {}, goals = [] } = {}) {
  const g = new Set(goals);
  const baseCal = tdee({ bmrValue: bmr(profile), activity: profile.activity || 1.4 }) || 2000;

  let calories = baseCal;
  if (g.has("fat-loss")) calories -= 300;
  if (g.has("muscle-gain")) calories += 200;

  // protein: 1.6–2.2 g/kg
  const protPerKg = g.has("muscle-gain") ? 2.0 : g.has("fat-loss") ? 2.0 : 1.6;
  const protein_g = roundN((profile.weightKg || 70) * protPerKg, 0);

  // fats: 25–30% kcal
  const fat_kcal = calories * 0.28;
  const fat_g = roundN(fat_kcal / 9, 0);

  // carbs: remainder
  const carb_kcal = Math.max(0, calories - protein_g * 4 - fat_g * 9);
  const carbs_g = roundN(carb_kcal / 4, 0);

  const out = {
    Calories: roundN(calories, 0),
    Protein: protein_g,
    Carbs: carbs_g,
    Fat: fat_g,
    Fiber: 30,
    Sugar: 50,
    Sodium: 2000,
    SatFat: 20
  };
  return out;
}

// ---------------------------------------------------------------------------
// Nutrition Labels & Render Helpers
// ---------------------------------------------------------------------------

export function nutritionLabel(perServingMacros = {}) {
  // returns data suitable for your NutritionPanel component
  const dv = percentDV(perServingMacros);
  const fields = [
    { key: "Calories", unit: "kcal", value: roundN(perServingMacros.Calories, 0) },
    { key: "Protein", unit: "g", value: roundN(perServingMacros.Protein, 0), dv: dv.Protein },
    { key: "Carbs", unit: "g", value: roundN(perServingMacros.Carbs, 0), dv: dv.Carbs },
    { key: "Fiber", unit: "g", value: roundN(perServingMacros.Fiber, 0), dv: dv.Fiber },
    { key: "Sugar", unit: "g", value: roundN(perServingMacros.Sugar, 0), dv: dv.Sugar },
    { key: "Fat", unit: "g", value: roundN(perServingMacros.Fat, 0), dv: dv.Fat },
    { key: "SatFat", unit: "g", value: roundN(perServingMacros.SatFat, 0), dv: dv.SatFat },
    { key: "Sodium", unit: "mg", value: roundN(perServingMacros.Sodium, 0), dv: dv.Sodium },
  ];
  return { fields, dv };
}

// Flag high sodium / sat fat
export function riskFlags(macros = {}, targets = DEFAULT_TARGETS) {
  const flags = [];
  const pct = percentOfTarget(macros, targets);
  if (pct.Sodium >= 80) flags.push({ key: "Sodium", level: "warn", pct: pct.Sodium });
  if (pct.SatFat >= 80) flags.push({ key: "SatFat", level: "warn", pct: pct.SatFat });
  if (pct.Sugar >= 80) flags.push({ key: "Sugar", level: "note", pct: pct.Sugar });
  return flags;
}

// ---------------------------------------------------------------------------
// Public API to integrate with your Meal Planner, Vault, and Exports
// ---------------------------------------------------------------------------

export const nutritionMath = {
  MACRO_KEYS, MICRO_KEYS, DEFAULT_TARGETS, DAILY_VALUES,
  toGrams, parseQty, normalizeIngredient, macrosForIngredient,
  calcMacrosForRecipe, sumMacros, totalsForDay, percentOfTarget, percentDV,
  glycemicLoad, isPassoverRestrictedIngredient, additiveRiskScore, ultraProcessedIndex,
  bmi, bmr, tdee, recommendTargets, nutritionLabel, riskFlags, mergeTargets, roundN, safeNum
};

export default nutritionMath;
