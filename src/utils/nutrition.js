// File: src/utils/nutrition.js
/**
 * nutrition.js (SSA)
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Browser-safe nutrition utilities used across SSA (meal planning, recipe
 *    scaling, inventory nutrition, macro calculators, label parsing, etc.)
 *
 * Scope
 *  - Normalize + scale nutrient maps (per serving / per 100g / per recipe).
 *  - Compute macro calories, net carbs, macro splits.
 *  - Lightweight BMR/TDEE helpers (for planning math; not medical advice).
 *  - Unit conversion + label-friendly formatting.
 *
 * Design goals
 *  - Never throw; return null/empty/fallback.
 *  - Tolerant of mixed schemas from scrapers, APIs, user input.
 *  - Avoid coupling: no external libraries, no DB, no stores.
 *
 * IMPORTANT
 *  - This module provides calculations and normalization helpers only.
 *  - It does not diagnose, treat, or prescribe. SSA policies belong elsewhere.
 */

import { isPlainObject, isArr, isStr, isNum, isNil } from "@/utils/obj";

/* --------------------------------- Constants -------------------------------- */

export const MACROS = Object.freeze({
  kcal: "kcal",
  protein_g: "protein_g",
  fat_g: "fat_g",
  carbs_g: "carbs_g",
  fiber_g: "fiber_g",
  sugar_g: "sugar_g",
  alcohol_g: "alcohol_g",
});

export const NUTRIENT_UNITS = Object.freeze({
  // energy
  kcal: "kcal",
  kJ: "kJ",

  // mass
  g: "g",
  mg: "mg",
  mcg: "mcg",
  µg: "mcg", // alias

  // volume (used sometimes by labels; not reliably convertible without density)
  ml: "ml",
  l: "l",
  tsp: "tsp",
  tbsp: "tbsp",
  cup: "cup",

  // international units (for some vitamins)
  IU: "IU",
});

/**
 * Canonical nutrient IDs SSA will prefer internally.
 * (You can expand as needed—keep stable IDs.)
 */
export const NUTRIENTS = Object.freeze({
  // Energy + macros
  ...MACROS,

  // Common macros/label fields
  sat_fat_g: "sat_fat_g",
  trans_fat_g: "trans_fat_g",
  mono_fat_g: "mono_fat_g",
  poly_fat_g: "poly_fat_g",
  cholesterol_mg: "cholesterol_mg",
  sodium_mg: "sodium_mg",
  potassium_mg: "potassium_mg",

  // Micronutrients (subset; expand in your catalogs)
  calcium_mg: "calcium_mg",
  iron_mg: "iron_mg",
  magnesium_mg: "magnesium_mg",
  zinc_mg: "zinc_mg",

  vit_a_mcg: "vit_a_mcg",
  vit_c_mg: "vit_c_mg",
  vit_d_mcg: "vit_d_mcg",
  vit_e_mg: "vit_e_mg",
  vit_k_mcg: "vit_k_mcg",

  thiamin_mg: "thiamin_mg", // B1
  riboflavin_mg: "riboflavin_mg", // B2
  niacin_mg: "niacin_mg", // B3
  vit_b6_mg: "vit_b6_mg",
  folate_mcg: "folate_mcg",
  vit_b12_mcg: "vit_b12_mcg",

  // Other common
  caffeine_mg: "caffeine_mg",
});

/**
 * Common alias mapping -> canonical nutrient ID.
 * This helps reconcile different sources: USDA-like, label-like, user-like.
 */
export const NUTRIENT_ALIASES = Object.freeze({
  calories: NUTRIENTS.kcal,
  calorie: NUTRIENTS.kcal,
  kcal: NUTRIENTS.kcal,
  energy: NUTRIENTS.kcal,
  energy_kcal: NUTRIENTS.kcal,

  protein: NUTRIENTS.protein_g,
  protein_g: NUTRIENTS.protein_g,

  fat: NUTRIENTS.fat_g,
  total_fat: NUTRIENTS.fat_g,
  fat_g: NUTRIENTS.fat_g,

  carbs: NUTRIENTS.carbs_g,
  carbohydrate: NUTRIENTS.carbs_g,
  total_carbohydrate: NUTRIENTS.carbs_g,
  carbohydrate_g: NUTRIENTS.carbs_g,
  carbs_g: NUTRIENTS.carbs_g,

  fiber: NUTRIENTS.fiber_g,
  dietary_fiber: NUTRIENTS.fiber_g,
  fiber_g: NUTRIENTS.fiber_g,

  sugar: NUTRIENTS.sugar_g,
  sugars: NUTRIENTS.sugar_g,
  total_sugars: NUTRIENTS.sugar_g,
  sugar_g: NUTRIENTS.sugar_g,

  alcohol: NUTRIENTS.alcohol_g,
  alcohol_g: NUTRIENTS.alcohol_g,

  saturated_fat: NUTRIENTS.sat_fat_g,
  sat_fat: NUTRIENTS.sat_fat_g,
  saturated_fat_g: NUTRIENTS.sat_fat_g,
  sat_fat_g: NUTRIENTS.sat_fat_g,

  trans_fat: NUTRIENTS.trans_fat_g,
  trans_fat_g: NUTRIENTS.trans_fat_g,

  cholesterol: NUTRIENTS.cholesterol_mg,
  cholesterol_mg: NUTRIENTS.cholesterol_mg,

  sodium: NUTRIENTS.sodium_mg,
  sodium_mg: NUTRIENTS.sodium_mg,

  potassium: NUTRIENTS.potassium_mg,
  potassium_mg: NUTRIENTS.potassium_mg,

  calcium: NUTRIENTS.calcium_mg,
  calcium_mg: NUTRIENTS.calcium_mg,

  iron: NUTRIENTS.iron_mg,
  iron_mg: NUTRIENTS.iron_mg,

  magnesium: NUTRIENTS.magnesium_mg,
  magnesium_mg: NUTRIENTS.magnesium_mg,

  zinc: NUTRIENTS.zinc_mg,
  zinc_mg: NUTRIENTS.zinc_mg,

  vitamin_a: NUTRIENTS.vit_a_mcg,
  vit_a: NUTRIENTS.vit_a_mcg,
  vit_a_mcg: NUTRIENTS.vit_a_mcg,

  vitamin_c: NUTRIENTS.vit_c_mg,
  vit_c: NUTRIENTS.vit_c_mg,
  vit_c_mg: NUTRIENTS.vit_c_mg,

  vitamin_d: NUTRIENTS.vit_d_mcg,
  vit_d: NUTRIENTS.vit_d_mcg,
  vit_d_mcg: NUTRIENTS.vit_d_mcg,

  vitamin_e: NUTRIENTS.vit_e_mg,
  vit_e: NUTRIENTS.vit_e_mg,
  vit_e_mg: NUTRIENTS.vit_e_mg,

  vitamin_k: NUTRIENTS.vit_k_mcg,
  vit_k: NUTRIENTS.vit_k_mcg,
  vit_k_mcg: NUTRIENTS.vit_k_mcg,

  thiamin: NUTRIENTS.thiamin_mg,
  vitamin_b1: NUTRIENTS.thiamin_mg,
  riboflavin: NUTRIENTS.riboflavin_mg,
  vitamin_b2: NUTRIENTS.riboflavin_mg,
  niacin: NUTRIENTS.niacin_mg,
  vitamin_b3: NUTRIENTS.niacin_mg,

  vitamin_b6: NUTRIENTS.vit_b6_mg,
  vit_b6: NUTRIENTS.vit_b6_mg,

  folate: NUTRIENTS.folate_mcg,
  folic_acid: NUTRIENTS.folate_mcg,

  vitamin_b12: NUTRIENTS.vit_b12_mcg,
  vit_b12: NUTRIENTS.vit_b12_mcg,

  caffeine: NUTRIENTS.caffeine_mg,
  caffeine_mg: NUTRIENTS.caffeine_mg,
});

/**
 * Energy conversion:
 * - 1 kcal = 4.184 kJ
 */
export const ENERGY = Object.freeze({
  KCAL_TO_KJ: 4.184,
  KJ_TO_KCAL: 1 / 4.184,
});

/**
 * Atwater factors (general):
 * - protein: 4 kcal/g
 * - carbs:   4 kcal/g (total carbs)
 * - fat:     9 kcal/g
 * - alcohol: 7 kcal/g
 *
 * Notes:
 * - Fiber is sometimes partially fermentable; many labels count fiber as part of
 *   total carbs. For "net carbs", we subtract fiber grams from total carbs.
 */
export const ATWATER = Object.freeze({
  protein: 4,
  carbs: 4,
  fat: 9,
  alcohol: 7,
});

/* ------------------------------ Unit Conversion ------------------------------ */

const MASS_TO_G = Object.freeze({
  g: 1,
  mg: 1 / 1000,
  mcg: 1 / 1_000_000,
  µg: 1 / 1_000_000,
});

function normUnit(u) {
  const s = String(u || "").trim();
  if (!s) return "";
  // normalize micro symbol to mcg
  if (s === "µg") return "mcg";
  return s.toLowerCase() === "iu" ? "IU" : s.toLowerCase();
}

/**
 * Convert mass units among g/mg/mcg. Returns null if units not supported.
 */
export function convertMass(value, fromUnit, toUnit) {
  const v = Number(value);
  if (!Number.isFinite(v)) return null;

  const from = normUnit(fromUnit);
  const to = normUnit(toUnit);

  if (!MASS_TO_G[from] || !MASS_TO_G[to]) return null;

  const g = v * MASS_TO_G[from];
  const out = g / MASS_TO_G[to];
  return out;
}

/**
 * Convert energy between kcal and kJ. Returns null if unsupported.
 */
export function convertEnergy(value, fromUnit, toUnit) {
  const v = Number(value);
  if (!Number.isFinite(v)) return null;

  const from = String(fromUnit || "").toLowerCase();
  const to = String(toUnit || "").toLowerCase();

  if (from === to) return v;

  if (from === "kcal" && to === "kj") return v * ENERGY.KCAL_TO_KJ;
  if (from === "kj" && to === "kcal") return v * ENERGY.KJ_TO_KCAL;

  return null;
}

/* ------------------------------ Normalization -------------------------------- */

export function normalizeNutrientKey(key) {
  const k = String(key || "").trim();
  if (!k) return "";
  const lowered = k.toLowerCase().replace(/\s+/g, "_");
  return NUTRIENT_ALIASES[lowered] || lowered;
}

/**
 * Normalize a nutrient map into canonical keys.
 * Input can be:
 *  - { protein: 30, fat: 10, carbs: 20 }
 *  - { nutrients: { ... } }
 *  - [{ id, value, unit }, ...]  (common from APIs)
 */
export function normalizeNutrients(input, { defaultUnitByKey } = {}) {
  const out = {};

  const setVal = (k, v, unit) => {
    const key = normalizeNutrientKey(k);
    if (
      !key ||
      key === "__proto__" ||
      key === "constructor" ||
      key === "prototype"
    )
      return;

    const num = Number(v);
    if (!Number.isFinite(num)) return;

    const u = unit ? String(unit) : defaultUnitByKey?.[key];
    // store as number if unit unknown; else store as {value,unit}
    if (u) out[key] = { value: num, unit: u };
    else out[key] = num;
  };

  if (isArr(input)) {
    for (const item of input) {
      if (!isPlainObject(item)) continue;
      setVal(item.id || item.key || item.name, item.value, item.unit);
    }
    return out;
  }

  const obj = isPlainObject(input)
    ? input.nutrients && isPlainObject(input.nutrients)
      ? input.nutrients
      : input
    : null;

  if (!obj) return out;

  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (isPlainObject(v) && isNum(v.value) && v.unit)
      setVal(k, v.value, v.unit);
    else setVal(k, v, undefined);
  }

  return out;
}

export function getNutrientValue(nutrients, key, { unit } = {}) {
  if (!nutrients || !key) return null;
  const k = normalizeNutrientKey(key);
  const v = nutrients[k];
  if (v == null) return null;

  if (isPlainObject(v) && isNum(v.value)) {
    if (!unit || !v.unit) return v.value;
    // try convert energy or mass if applicable
    const fromU = normUnit(v.unit);
    const toU = normUnit(unit);

    const mass = convertMass(v.value, fromU, toU);
    if (mass != null) return mass;

    const energy = convertEnergy(v.value, fromU, toU);
    if (energy != null) return energy;

    // unknown conversion; return raw value
    return v.value;
  }

  // plain number
  if (isNum(v)) return v;

  return null;
}

/* ------------------------------ Scaling / Summing --------------------------- */

/**
 * Scale nutrient map by factor.
 * - Preserves units when present.
 */
export function scaleNutrients(nutrients, factor) {
  const f = Number(factor);
  if (!Number.isFinite(f)) return normalizeNutrients(nutrients);
  const src = normalizeNutrients(nutrients);
  const out = {};

  for (const k of Object.keys(src)) {
    const v = src[k];
    if (isPlainObject(v) && isNum(v.value)) {
      out[k] = { value: v.value * f, unit: v.unit };
    } else if (isNum(v)) {
      out[k] = v * f;
    }
  }
  return out;
}

/**
 * Sum multiple nutrient maps.
 * - Units: if both have unit and match, sums. If mismatch but convertible in mass/energy,
 *   converts to the first seen unit for that key.
 */
export function sumNutrients(list) {
  const arr = isArr(list) ? list : [];
  const out = {};
  const unitByKey = {};

  for (const item of arr) {
    const src = normalizeNutrients(item);
    for (const k of Object.keys(src)) {
      const v = src[k];

      if (isPlainObject(v) && isNum(v.value) && v.unit) {
        const unit = String(v.unit);
        if (!hasOwn(out, k)) {
          out[k] = { value: v.value, unit };
          unitByKey[k] = unit;
          continue;
        }
        const cur = out[k];
        if (isPlainObject(cur) && isNum(cur.value) && cur.unit) {
          if (String(cur.unit) === unit) {
            cur.value += v.value;
          } else {
            // attempt conversion into existing unit
            const mass = convertMass(
              v.value,
              normUnit(unit),
              normUnit(cur.unit)
            );
            if (mass != null) cur.value += mass;
            else {
              const energy = convertEnergy(
                v.value,
                normUnit(unit),
                normUnit(cur.unit)
              );
              if (energy != null) cur.value += energy;
              else {
                // cannot convert; degrade by storing as number sum without unit
                out[k] = (Number(cur.value) || 0) + v.value;
                delete unitByKey[k];
              }
            }
          }
        } else if (isNum(cur)) {
          out[k] = cur + v.value;
        } else {
          out[k] = { value: v.value, unit };
          unitByKey[k] = unit;
        }
      } else if (isNum(v)) {
        if (!hasOwn(out, k)) out[k] = v;
        else if (isPlainObject(out[k]) && isNum(out[k].value))
          out[k].value += v;
        else if (isNum(out[k])) out[k] += v;
      }
    }
  }

  return out;
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/* ------------------------------ Macro Math ---------------------------------- */

export function computeNetCarbs(carbsG, fiberG) {
  const c = Number(carbsG);
  const f = Number(fiberG);
  if (!Number.isFinite(c)) return null;
  if (!Number.isFinite(f)) return Math.max(0, c);
  return Math.max(0, c - f);
}

/**
 * Compute calories from macros (Atwater).
 * Input can be nutrient map or explicit numbers.
 *
 * Options:
 *  - treatFiberAsCarbCalories: if true, counts fiber grams as carbs for calories.
 *    Default false (many people treat fiber as 0 or reduced calories).
 */
export function computeMacroCalories(input, opts = {}) {
  const { treatFiberAsCarbCalories = false, factors = ATWATER } = opts || {};

  const n = isPlainObject(input) ? normalizeNutrients(input) : {};

  const protein = getNumberLike(n, NUTRIENTS.protein_g, input?.protein_g);
  const fat = getNumberLike(n, NUTRIENTS.fat_g, input?.fat_g);
  const carbs = getNumberLike(n, NUTRIENTS.carbs_g, input?.carbs_g);
  const fiber = getNumberLike(n, NUTRIENTS.fiber_g, input?.fiber_g);
  const alcohol = getNumberLike(n, NUTRIENTS.alcohol_g, input?.alcohol_g);

  const p = Number.isFinite(protein) ? protein : 0;
  const f = Number.isFinite(fat) ? fat : 0;
  const c = Number.isFinite(carbs) ? carbs : 0;
  const fi = Number.isFinite(fiber) ? fiber : 0;
  const a = Number.isFinite(alcohol) ? alcohol : 0;

  const carbForCalories = treatFiberAsCarbCalories ? c : Math.max(0, c - fi);

  const kcalProtein = p * (Number(factors?.protein) || ATWATER.protein);
  const kcalFat = f * (Number(factors?.fat) || ATWATER.fat);
  const kcalCarbs = carbForCalories * (Number(factors?.carbs) || ATWATER.carbs);
  const kcalAlcohol = a * (Number(factors?.alcohol) || ATWATER.alcohol);

  const total = kcalProtein + kcalFat + kcalCarbs + kcalAlcohol;

  return {
    totalKcal: round1(total),
    kcalProtein: round1(kcalProtein),
    kcalFat: round1(kcalFat),
    kcalCarbs: round1(kcalCarbs),
    kcalAlcohol: round1(kcalAlcohol),
    grams: {
      protein_g: round1(p),
      fat_g: round1(f),
      carbs_g: round1(c),
      fiber_g: round1(fi),
      net_carbs_g: round1(computeNetCarbs(c, fi) ?? 0),
      alcohol_g: round1(a),
    },
  };
}

export function computeMacroPercents(input, opts = {}) {
  const cals = computeMacroCalories(input, opts);
  const t = Number(cals.totalKcal) || 0;
  if (t <= 0) {
    return { ...cals, percents: { protein: 0, fat: 0, carbs: 0, alcohol: 0 } };
  }
  return {
    ...cals,
    percents: {
      protein: round1((cals.kcalProtein / t) * 100),
      fat: round1((cals.kcalFat / t) * 100),
      carbs: round1((cals.kcalCarbs / t) * 100),
      alcohol: round1((cals.kcalAlcohol / t) * 100),
    },
  };
}

function getNumberLike(nutrients, key, fallback) {
  const v = getNutrientValue(nutrients, key);
  if (Number.isFinite(v)) return v;
  const f = Number(fallback);
  return Number.isFinite(f) ? f : null;
}

/* ------------------------------ Targets / Splits ---------------------------- */

/**
 * Macro split presets (ratios by calories).
 * You can expand/override in user prefs/catalogs.
 */
export const MACRO_SPLITS = Object.freeze({
  balanced: { protein: 0.25, fat: 0.3, carbs: 0.45 },
  keto: { protein: 0.25, fat: 0.7, carbs: 0.05 },
  lowCarb: { protein: 0.3, fat: 0.45, carbs: 0.25 },
  highProtein: { protein: 0.35, fat: 0.3, carbs: 0.35 },
  carnivoreLike: { protein: 0.4, fat: 0.6, carbs: 0.0 }, // planning math only
});

/**
 * Compute macro gram targets given daily calories and a split.
 * - Returns grams for protein/fat/carbs, plus netCarb target if you pass fiber assumption.
 */
export function macroTargetsFromCalories(
  dailyKcal,
  split = MACRO_SPLITS.balanced,
  opts = {}
) {
  const kcal = Number(dailyKcal);
  if (!Number.isFinite(kcal) || kcal <= 0) return null;

  const s = isPlainObject(split) ? split : MACRO_SPLITS.balanced;
  const pR = clamp01(Number(s.protein));
  const fR = clamp01(Number(s.fat));
  const cR = clamp01(Number(s.carbs));

  // normalize if sums not 1
  const sum = pR + fR + cR;
  const p = sum > 0 ? pR / sum : 0.25;
  const f = sum > 0 ? fR / sum : 0.3;
  const c = sum > 0 ? cR / sum : 0.45;

  const proteinG = (kcal * p) / ATWATER.protein;
  const fatG = (kcal * f) / ATWATER.fat;
  const carbsG = (kcal * c) / ATWATER.carbs;

  const fiberAssumptionG = Number(opts.fiberAssumptionG);
  const netCarbsG = Number.isFinite(fiberAssumptionG)
    ? computeNetCarbs(carbsG, fiberAssumptionG)
    : null;

  return {
    kcal: round1(kcal),
    split: { protein: round3(p), fat: round3(f), carbs: round3(c) },
    grams: {
      protein_g: round1(proteinG),
      fat_g: round1(fatG),
      carbs_g: round1(carbsG),
      ...(netCarbsG != null ? { net_carbs_g: round1(netCarbsG) } : {}),
    },
  };
}

/* ------------------------------ Serving / Density ---------------------------- */

/**
 * Scale a per-serving nutrient map to a different serving size.
 * - If you know grams per serving, you can scale by weight ratio.
 */
export function scaleByServingWeight(nutrientsPerServing, fromGrams, toGrams) {
  const a = Number(fromGrams);
  const b = Number(toGrams);
  if (!Number.isFinite(a) || a <= 0)
    return normalizeNutrients(nutrientsPerServing);
  if (!Number.isFinite(b) || b <= 0)
    return normalizeNutrients(nutrientsPerServing);
  return scaleNutrients(nutrientsPerServing, b / a);
}

/**
 * Convert per-serving nutrition to per-100g nutrition.
 */
export function toPer100g(nutrientsPerServing, servingGrams) {
  const g = Number(servingGrams);
  if (!Number.isFinite(g) || g <= 0) return null;
  return scaleByServingWeight(nutrientsPerServing, g, 100);
}

/**
 * Convert per-100g nutrition to per-serving nutrition.
 */
export function fromPer100g(nutrientsPer100g, servingGrams) {
  const g = Number(servingGrams);
  if (!Number.isFinite(g) || g <= 0) return null;
  return scaleNutrients(nutrientsPer100g, g / 100);
}

/* ------------------------------ Label Parsing -------------------------------- */

/**
 * Parse a "nutrition label-like" object into a canonical packet:
 * {
 *   serving: { amount, unit, grams? },
 *   nutrients: { protein_g: 12, sodium_mg: {value: 200, unit:"mg"}, ... },
 *   meta: { source, ... }
 * }
 *
 * Accepts many shapes:
 *  - { servingSize: "2 tbsp (32g)", calories: 190, totalFat: "16g", ... }
 *  - { serving: { grams: 32 }, nutrients: {...} }
 */
export function parseNutritionLabel(label, opts = {}) {
  const x = isPlainObject(label) ? label : {};
  const out = {
    serving: normalizeServing(
      x.serving || x.servingSize || x.serving_size || null
    ),
    nutrients: {},
    meta: {
      source: x.source || opts.source || "label",
      raw: opts.keepRaw ? x : undefined,
    },
  };

  // If already in SSA shape:
  if (x.nutrients && isPlainObject(x.nutrients)) {
    out.nutrients = normalizeNutrients(x.nutrients, {
      defaultUnitByKey: opts.defaultUnitByKey,
    });
    return out;
  }

  // Try to pull known fields (super tolerant)
  const candidates = {
    kcal: x.kcal ?? x.calories ?? x.energy ?? x.energyKcal ?? x.energy_kcal,
    protein_g: x.protein ?? x.protein_g,
    fat_g: x.totalFat ?? x.fat ?? x.fat_g,
    carbs_g: x.totalCarbohydrate ?? x.carbs ?? x.carbohydrate ?? x.carbs_g,
    fiber_g: x.dietaryFiber ?? x.fiber ?? x.fiber_g,
    sugar_g: x.totalSugars ?? x.sugars ?? x.sugar ?? x.sugar_g,
    sat_fat_g: x.saturatedFat ?? x.satFat ?? x.sat_fat_g,
    trans_fat_g: x.transFat ?? x.trans_fat_g,
    cholesterol_mg: x.cholesterol ?? x.cholesterol_mg,
    sodium_mg: x.sodium ?? x.sodium_mg,
    potassium_mg: x.potassium ?? x.potassium_mg,
    calcium_mg: x.calcium ?? x.calcium_mg,
    iron_mg: x.iron ?? x.iron_mg,
    vit_d_mcg: x.vitaminD ?? x.vit_d ?? x.vit_d_mcg,
  };

  for (const [k, raw] of Object.entries(candidates)) {
    const parsed = parseNutrientAmount(raw, inferUnitForKey(k));
    if (!parsed) continue;
    // store numeric if unit-less, else {value,unit}
    out.nutrients[normalizeNutrientKey(k)] = parsed.unit
      ? parsed
      : parsed.value;
  }

  // Also merge any numeric keys directly present
  // e.g. label may include { "protein (g)": 12 }
  if (opts.scanExtraKeys) {
    const extras = scanLabelExtras(x);
    out.nutrients = { ...out.nutrients, ...extras };
  }

  return out;
}

function inferUnitForKey(key) {
  const k = normalizeNutrientKey(key);
  if (k === NUTRIENTS.kcal) return "kcal";
  if (k.endsWith("_g")) return "g";
  if (k.endsWith("_mg")) return "mg";
  if (k.endsWith("_mcg")) return "mcg";
  return "";
}

/**
 * Parses nutrient-like amounts:
 *  - "12g" -> {value:12, unit:"g"}
 *  - "200 mg" -> {value:200, unit:"mg"}
 *  - 190 -> {value:190, unit:""} (unless defaultUnit provided)
 */
export function parseNutrientAmount(raw, defaultUnit = "") {
  if (raw == null) return null;

  if (isPlainObject(raw) && isNum(raw.value)) {
    const unit = raw.unit
      ? String(raw.unit)
      : defaultUnit
      ? String(defaultUnit)
      : "";
    return { value: Number(raw.value), unit };
  }

  if (typeof raw === "number") {
    const unit = defaultUnit ? String(defaultUnit) : "";
    return { value: raw, unit };
  }

  const s = String(raw).trim();
  if (!s) return null;

  // Match "12g", "12 g", "200mg", "0.5 mcg", "1,000 mg"
  const m = /^([+-]?\d[\d,]*(?:\.\d+)?)(?:\s*([a-zA-Zµ]+))?$/.exec(s);
  if (!m) return null;

  const num = Number(String(m[1]).replace(/,/g, ""));
  if (!Number.isFinite(num)) return null;

  const unit = m[2]
    ? String(m[2]).replace("µg", "mcg")
    : defaultUnit
    ? String(defaultUnit)
    : "";
  return { value: num, unit };
}

/**
 * Parse serving size from strings like:
 *  - "2 tbsp (32g)"
 *  - "1 cup (240 ml)"
 *  - { grams: 32 }
 */
export function normalizeServing(serving) {
  if (serving == null) return { amount: 1, unit: "serving" };

  if (isPlainObject(serving)) {
    const grams = Number(serving.grams ?? serving.g);
    const amount = Number(serving.amount ?? 1);
    const unit = String(serving.unit ?? "serving");
    return {
      amount: Number.isFinite(amount) && amount > 0 ? amount : 1,
      unit: unit || "serving",
      ...(Number.isFinite(grams) && grams > 0 ? { grams } : {}),
      ...(serving.ml != null && Number.isFinite(Number(serving.ml))
        ? { ml: Number(serving.ml) }
        : {}),
      ...(serving.label ? { label: String(serving.label) } : {}),
    };
  }

  const s = String(serving).trim();
  if (!s) return { amount: 1, unit: "serving" };

  // extract parenthetical grams if present
  // e.g. "2 tbsp (32g)" -> amount=2 unit=tbsp grams=32
  const paren = /\(([^)]+)\)/.exec(s);
  let grams = null;
  let ml = null;

  if (paren?.[1]) {
    const inner = paren[1].trim();
    const g = /(\d[\d,]*(?:\.\d+)?)\s*g\b/i.exec(inner);
    if (g?.[1]) {
      const num = Number(g[1].replace(/,/g, ""));
      if (Number.isFinite(num) && num > 0) grams = num;
    }
    const m = /(\d[\d,]*(?:\.\d+)?)\s*ml\b/i.exec(inner);
    if (m?.[1]) {
      const num = Number(m[1].replace(/,/g, ""));
      if (Number.isFinite(num) && num > 0) ml = num;
    }
  }

  const main = s.replace(/\([^)]*\)/g, "").trim(); // remove parentheses
  const mm = /^([+-]?\d[\d,]*(?:\.\d+)?)\s*(.*)$/.exec(main);
  if (!mm)
    return {
      amount: 1,
      unit: "serving",
      ...(grams ? { grams } : {}),
      ...(ml ? { ml } : {}),
    };

  const amount = Number(mm[1].replace(/,/g, ""));
  const unit = String(mm[2] || "serving").trim() || "serving";

  return {
    amount: Number.isFinite(amount) && amount > 0 ? amount : 1,
    unit,
    ...(grams ? { grams } : {}),
    ...(ml ? { ml } : {}),
    label: s,
  };
}

/**
 * Attempt to scan unknown label keys and normalize them (optional).
 * This is conservative: only keys with obvious unit suffixes.
 */
export function scanLabelExtras(labelObj) {
  const x = isPlainObject(labelObj) ? labelObj : {};
  const out = {};

  for (const [k, v] of Object.entries(x)) {
    if (v == null) continue;

    // Skip known containers
    if (
      k === "nutrients" ||
      k === "serving" ||
      k === "servingSize" ||
      k === "meta"
    )
      continue;

    const key = String(k).toLowerCase().trim();
    if (!key) continue;

    // heuristic: keys containing "(g)" "(mg)" "(mcg)" or ending with "_g" etc.
    let unit = "";
    if (/\(g\)/.test(key) || /_g\b/.test(key)) unit = "g";
    else if (/\(mg\)/.test(key) || /_mg\b/.test(key)) unit = "mg";
    else if (/\(mcg\)/.test(key) || /_mcg\b/.test(key) || /\(µg\)/.test(key))
      unit = "mcg";
    else if (key.includes("calorie") || key.includes("kcal")) unit = "kcal";

    if (!unit) continue;

    const parsed = parseNutrientAmount(v, unit);
    if (!parsed) continue;

    const canonical = normalizeNutrientKey(
      key
        .replace(/\(.*?\)/g, "")
        .trim()
        .replace(/\s+/g, "_")
    );
    out[canonical] = parsed.unit ? parsed : parsed.value;
  }

  return out;
}

/* ------------------------------ Formatting / Rounding ------------------------ */

export function roundN(value, n = 0) {
  const v = Number(value);
  const d = Math.max(0, Math.min(6, Math.trunc(Number(n) || 0)));
  if (!Number.isFinite(v)) return null;
  const p = 10 ** d;
  return Math.round(v * p) / p;
}

export function round1(v) {
  return roundN(v, 1) ?? 0;
}

export function round3(v) {
  const r = roundN(v, 3);
  return r == null ? 0 : r;
}

/**
 * Label-friendly formatting:
 * - If unit is mass or energy, tries to keep simple.
 */
export function formatNutrient(
  value,
  unit,
  { decimals, trimZeros = true } = {}
) {
  if (value == null) return "";
  const v = Number(value);
  if (!Number.isFinite(v)) return "";

  const u = unit ? String(unit) : "";
  const d =
    decimals != null
      ? Math.max(0, Math.min(6, Math.trunc(Number(decimals))))
      : guessDecimals(u, v);

  let s = v.toFixed(d);
  if (trimZeros && d > 0) s = s.replace(/\.?0+$/, "");
  return u ? `${s} ${u}` : s;
}

function guessDecimals(unit, value) {
  const u = normUnit(unit);
  const v = Number(value);
  if (!Number.isFinite(v)) return 0;
  if (u === "kcal" || u === "kj") return 0;
  if (u === "g") return v < 1 ? 1 : 0;
  if (u === "mg") return v < 10 ? 0 : 0;
  if (u === "mcg") return 0;
  return 0;
}

/* ------------------------------ BMR / TDEE ---------------------------------- */

/**
 * Mifflin-St Jeor BMR estimate (planning math).
 * Inputs:
 *  - sex: "female" | "male" | "unknown"
 *  - ageYears
 *  - heightCm
 *  - weightKg
 *
 * Returns kcal/day or null.
 */
export function estimateBMR({ sex, ageYears, heightCm, weightKg } = {}) {
  const a = Number(ageYears);
  const h = Number(heightCm);
  const w = Number(weightKg);

  if (!Number.isFinite(a) || a <= 0) return null;
  if (!Number.isFinite(h) || h <= 0) return null;
  if (!Number.isFinite(w) || w <= 0) return null;

  const s = String(sex || "").toLowerCase();
  const base = 10 * w + 6.25 * h - 5 * a;
  if (s === "male" || s === "m") return round1(base + 5);
  if (s === "female" || s === "f") return round1(base - 161);

  // unknown: return midpoint (planning only)
  return round1(base - 78);
}

/**
 * TDEE estimate: BMR * activity factor.
 * activity:
 *  - "sedentary" (1.2)
 *  - "light" (1.375)
 *  - "moderate" (1.55)
 *  - "active" (1.725)
 *  - "very_active" (1.9)
 */
export const ACTIVITY_FACTORS = Object.freeze({
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9,
});

export function estimateTDEE(bmrKcal, activity = "sedentary") {
  const bmr = Number(bmrKcal);
  if (!Number.isFinite(bmr) || bmr <= 0) return null;
  const f = Number(
    ACTIVITY_FACTORS[String(activity || "").toLowerCase()] ||
      ACTIVITY_FACTORS.sedentary
  );
  return round1(bmr * f);
}

/* ------------------------------ DV / %DV (Optional) -------------------------- */

/**
 * Daily Value map (optional). Keep these in a catalog if you prefer.
 * This module provides helpers; you can inject your own DV map from SSA catalogs.
 */
export const DEFAULT_DV = Object.freeze({
  sodium_mg: 2300,
  cholesterol_mg: 300,
  fiber_g: 28,
  calcium_mg: 1300,
  iron_mg: 18,
  potassium_mg: 4700,
  vit_d_mcg: 20,
  vit_c_mg: 90,
});

export function percentDV(nutrients, key, dvMap = DEFAULT_DV) {
  const k = normalizeNutrientKey(key);
  const dv = dvMap?.[k];
  if (!Number.isFinite(Number(dv)) || Number(dv) <= 0) return null;

  // dvMap keys imply unit suffix; try to align
  let unit = "";
  if (k.endsWith("_g")) unit = "g";
  else if (k.endsWith("_mg")) unit = "mg";
  else if (k.endsWith("_mcg")) unit = "mcg";
  else if (k === "kcal") unit = "kcal";

  const v = getNutrientValue(normalizeNutrients(nutrients), k, { unit });
  if (!Number.isFinite(Number(v))) return null;

  return round1((Number(v) / Number(dv)) * 100);
}

/* ------------------------------ Composition Helpers -------------------------- */

/**
 * Merge two nutrition packets with preference for "better" values.
 * - If patch has non-null, takes it. Otherwise keeps base.
 * - Units are preserved from patch when present.
 */
export function mergeNutrients(base, patch) {
  const a = normalizeNutrients(base);
  const b = normalizeNutrients(patch);
  const out = { ...a };

  for (const k of Object.keys(b)) {
    const v = b[k];
    if (v == null) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Create a minimal "nutrition packet" SSA can store on ingredients/recipes:
 * {
 *   basis: "perServing" | "per100g" | "perRecipe",
 *   serving?: { amount, unit, grams? },
 *   nutrients: {...}
 * }
 */
export function makeNutritionPacket({
  basis = "perServing",
  serving = null,
  nutrients = {},
  meta = {},
} = {}) {
  const pkt = {
    basis: String(basis || "perServing"),
    ...(serving ? { serving: normalizeServing(serving) } : {}),
    nutrients: normalizeNutrients(nutrients),
    meta: isPlainObject(meta) ? { ...meta } : {},
  };

  // convenience: if basis is perServing and serving has grams, compute per100g
  if (pkt.basis === "perServing" && pkt.serving?.grams) {
    const per100g = toPer100g(pkt.nutrients, pkt.serving.grams);
    if (per100g) pkt.meta.per100g = per100g;
  }

  return pkt;
}

/* ------------------------------ Compatibility -------------------------------- */

/**
 * ✅ calcMacrosForRecipe (SSA)
 * -----------------------------------------------------------------------------
 * Compatibility export expected by mealPlanEngine.js:
 *   import { calcMacrosForRecipe, sumMacros } from "@/utils/nutrition";
 *
 * Goal:
 *  - Provide a tolerant "recipe -> macro summary" helper for planners/rankers.
 *  - Never throws; returns a stable macro object with numbers (grams + kcal).
 *
 * Supports recipe shapes:
 *  - recipe.nutrition: { nutrients: {...}, basis, serving, ... }
 *  - recipe.nutrition: nutrient map directly
 *  - recipe.macros: { protein_g, carbs_g, fat_g, kcal, ... }
 *  - recipe: { protein_g, carbs_g, fat_g, kcal } (loose)
 *
 * Options:
 *  - perServing (default true): if recipe looks like "perRecipe" and has servings,
 *    divide by servings for per-serving macros.
 *  - servingsFallback (default 1): used if servings missing/invalid.
 */
export function calcMacrosForRecipe(recipe, opts = {}) {
  try {
    const r = isPlainObject(recipe) ? recipe : {};
    const options = isPlainObject(opts) ? opts : {};
    const perServing = options.perServing !== false; // default true
    const servingsFallback = Number.isFinite(Number(options.servingsFallback))
      ? Math.max(1, Math.floor(Number(options.servingsFallback)))
      : 1;

    // 1) Pull a candidate nutrient map (very tolerant)
    const maybePkt = r.nutrition;
    const maybeMacros = r.macros;

    // Prefer explicit macros if present
    let nMap = null;

    if (isPlainObject(maybeMacros)) {
      nMap = maybeMacros;
    } else if (isPlainObject(maybePkt) && isPlainObject(maybePkt.nutrients)) {
      nMap = maybePkt.nutrients;
    } else if (isPlainObject(maybePkt)) {
      // could already be a nutrient map
      nMap = maybePkt;
    } else {
      // loose direct fields on recipe
      nMap = {
        kcal: r.kcal ?? r.calories ?? r.energy_kcal ?? r.energyKcal,
        protein_g: r.protein_g ?? r.protein,
        carbs_g: r.carbs_g ?? r.carbs ?? r.carbohydrate_g ?? r.carbohydrate,
        fat_g: r.fat_g ?? r.fat ?? r.total_fat,
        fiber_g: r.fiber_g ?? r.fiber,
        sugar_g: r.sugar_g ?? r.sugar,
        alcohol_g: r.alcohol_g ?? r.alcohol,
      };
    }

    const n = normalizeNutrients(nMap);

    // 2) Macro grams
    const protein_g = Number(getNutrientValue(n, NUTRIENTS.protein_g)) || 0;
    const carbs_g = Number(getNutrientValue(n, NUTRIENTS.carbs_g)) || 0;
    const fat_g = Number(getNutrientValue(n, NUTRIENTS.fat_g)) || 0;
    const fiber_g = Number(getNutrientValue(n, NUTRIENTS.fiber_g)) || 0;
    const sugar_g = Number(getNutrientValue(n, NUTRIENTS.sugar_g)) || 0;
    const alcohol_g = Number(getNutrientValue(n, NUTRIENTS.alcohol_g)) || 0;

    // 3) kcal (prefer explicit kcal, else compute)
    let kcal = getNutrientValue(n, NUTRIENTS.kcal);
    if (!Number.isFinite(Number(kcal))) {
      kcal = computeMacroCalories({
        protein_g,
        carbs_g,
        fat_g,
        fiber_g,
        alcohol_g,
      })?.totalKcal;
    }
    kcal = Number.isFinite(Number(kcal)) ? Number(kcal) : 0;

    // 4) If recipe appears to be total/perRecipe, optionally divide by servings
    const basis = isPlainObject(maybePkt) ? String(maybePkt.basis || "") : "";
    const servingsRaw =
      r.servings ??
      r.yieldServings ??
      r.servingCount ??
      (isPlainObject(maybePkt) ? maybePkt.servings : null);

    const servings =
      Number.isFinite(Number(servingsRaw)) && Number(servingsRaw) > 0
        ? Number(servingsRaw)
        : servingsFallback;

    const shouldDivide =
      perServing &&
      (basis.toLowerCase() === "perrecipe" ||
        basis.toLowerCase() === "total" ||
        basis.toLowerCase() === "per_recipe");

    const div = shouldDivide ? Math.max(1, servings) : 1;

    const out = {
      kcal: round1(kcal / div),
      protein_g: round1(protein_g / div),
      carbs_g: round1(carbs_g / div),
      fat_g: round1(fat_g / div),
      fiber_g: round1(fiber_g / div),
      sugar_g: round1(sugar_g / div),
      alcohol_g: round1(alcohol_g / div),
    };

    out.net_carbs_g = round1(computeNetCarbs(out.carbs_g, out.fiber_g) ?? 0);

    return out;
  } catch {
    // never throw
    return {
      kcal: 0,
      protein_g: 0,
      carbs_g: 0,
      fat_g: 0,
      fiber_g: 0,
      sugar_g: 0,
      alcohol_g: 0,
      net_carbs_g: 0,
    };
  }
}

/**
 * ✅ sumMacros (SSA)
 * -----------------------------------------------------------------------------
 * Sums macro packets (or nutrient maps) and returns a flat macro object:
 *  { kcal, protein_g, carbs_g, fat_g, fiber_g, sugar_g, alcohol_g, net_carbs_g }
 *
 * Accepts:
 *  - array of macro objects
 *  - array of nutrient maps
 *  - array of nutrition packets { nutrients: {...} }
 *  - array of recipes (best-effort) if you pass opts.coerceRecipes = true
 */
export function sumMacros(list, opts = {}) {
  const options = isPlainObject(opts) ? opts : {};
  const arr = isArr(list) ? list : [];

  if (!arr.length) {
    return {
      kcal: 0,
      protein_g: 0,
      carbs_g: 0,
      fat_g: 0,
      fiber_g: 0,
      sugar_g: 0,
      alcohol_g: 0,
      net_carbs_g: 0,
    };
  }

  // If asked, allow passing recipes directly.
  if (options.coerceRecipes) {
    const parts = arr.map((x) => calcMacrosForRecipe(x, options.recipeOpts));
    return sumMacros(parts, { coerceRecipes: false });
  }

  // Convert each item into a nutrient map compatible with sumNutrients
  const maps = arr.map((x) => {
    if (x == null) return {};
    if (isPlainObject(x) && isPlainObject(x.nutrients)) return x.nutrients; // packet
    return x; // macro object or nutrient map
  });

  const summed = sumNutrients(maps);
  const n = normalizeNutrients(summed);

  const protein_g = Number(getNutrientValue(n, NUTRIENTS.protein_g)) || 0;
  const carbs_g = Number(getNutrientValue(n, NUTRIENTS.carbs_g)) || 0;
  const fat_g = Number(getNutrientValue(n, NUTRIENTS.fat_g)) || 0;
  const fiber_g = Number(getNutrientValue(n, NUTRIENTS.fiber_g)) || 0;
  const sugar_g = Number(getNutrientValue(n, NUTRIENTS.sugar_g)) || 0;
  const alcohol_g = Number(getNutrientValue(n, NUTRIENTS.alcohol_g)) || 0;

  let kcal = getNutrientValue(n, NUTRIENTS.kcal);
  if (!Number.isFinite(Number(kcal))) {
    kcal = computeMacroCalories({
      protein_g,
      carbs_g,
      fat_g,
      fiber_g,
      alcohol_g,
    })?.totalKcal;
  }
  kcal = Number.isFinite(Number(kcal)) ? Number(kcal) : 0;

  const out = {
    kcal: round1(kcal),
    protein_g: round1(protein_g),
    carbs_g: round1(carbs_g),
    fat_g: round1(fat_g),
    fiber_g: round1(fiber_g),
    sugar_g: round1(sugar_g),
    alcohol_g: round1(alcohol_g),
  };

  out.net_carbs_g = round1(computeNetCarbs(out.carbs_g, out.fiber_g) ?? 0);

  return out;
}

/* ------------------------------ Small locals -------------------------------- */

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}
