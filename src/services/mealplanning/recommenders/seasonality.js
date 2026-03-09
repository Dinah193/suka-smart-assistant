// File: src/services/mealplanning/recommenders/seasonality.js
/**
 * seasonality.js (SSA)
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Deterministic, non-AI seasonality scoring + helpers for SSA meal planning.
 *  - Provides:
 *      • season resolution (from date, hemisphere, optional weather)
 *      • ingredient season scoring (produce + herbs)
 *      • cuisine season scoring hooks (if cuisines declare seasonality profiles)
 *      • meal slot seasonal suggestions (soups in winter, grills in summer, etc.)
 *
 * Design goals
 *  - Pure functions (no DB, no stores, no network).
 *  - Browser-safe.
 *  - Tolerant of partial inputs.
 *  - Works with "fixed calendar rhythm" and "mimic randomness" layers.
 *
 * Typical usage
 *  - const season = resolveSeason({ dateISO, hemisphere, latitude })
 *  - const score = scoreIngredientsSeasonality(ingredients, { season })
 *  - const slotBias = getMealSlotSeasonBias({ season, slot: "dinner" })
 *
 * Compatibility exports
 *  - mealPlanEngine.js imports: { seasonality } from "./seasonality"
 *    -> We provide a named export `seasonality` as a stable namespace alias.
 */

import { isPlainObject, isArr, isStr, isNum } from "@/utils/obj";

const SOURCE = "mealplanning.recommenders.seasonality";

/* --------------------------------- Fallbacks -------------------------------- */

function _clamp01(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}
// IMPORTANT: do NOT import clamp01 from "@/utils/rand" to avoid build-time export coupling.
// If you later add/export clamp01 in rand.js, this local clamp remains safe and deterministic.
const c01 = _clamp01;

function safeNum(n, fallback = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}
function normStr(s) {
  return String(s || "")
    .trim()
    .toLowerCase();
}
function uniq(arr) {
  return Array.from(new Set(arr));
}

/* -------------------------------- Seasons ----------------------------------- */

export const SEASONS = Object.freeze(["winter", "spring", "summer", "fall"]);

/**
 * Resolve season from date and/or hemisphere.
 * - If latitude is provided, hemisphere inferred if hemisphere missing.
 * - If weather hints are provided (e.g. freezing temps), it can nudge output,
 *   but never fully override the date-based season (keeps deterministic).
 *
 * opts:
 *  {
 *    dateISO?: string|Date,
 *    hemisphere?: "north"|"south",
 *    latitude?: number,
 *    weatherHint?: {
 *      avgTempF?: number, // optional nudges
 *      avgTempC?: number,
 *      frostRisk?: 0..1
 *    }
 *  }
 */
export function resolveSeason(opts = {}) {
  const d = resolveDate(opts.dateISO);
  const month = d.getUTCMonth() + 1; // 1..12

  const hemi = resolveHemisphere(opts.hemisphere, opts.latitude);

  // meteorological seasons (simpler + stable)
  // North:
  //  - winter: Dec-Feb
  //  - spring: Mar-May
  //  - summer: Jun-Aug
  //  - fall:   Sep-Nov
  const northSeason =
    month === 12 || month === 1 || month === 2
      ? "winter"
      : month >= 3 && month <= 5
      ? "spring"
      : month >= 6 && month <= 8
      ? "summer"
      : "fall";

  const base = hemi === "south" ? invertSeason(northSeason) : northSeason;

  // Optional weather nudges (small, deterministic)
  // If it’s “summer” by date but avg temp is freezing, nudge toward spring/fall.
  const nudged = nudgeByWeather(base, opts.weatherHint);

  return nudged;
}

function resolveDate(dateISO) {
  if (dateISO instanceof Date && !Number.isNaN(dateISO.getTime()))
    return dateISO;
  if (isStr(dateISO) && dateISO.trim()) {
    const t = Date.parse(dateISO);
    if (Number.isFinite(t)) return new Date(t);
  }
  return new Date(); // fallback: "now"
}

function resolveHemisphere(hemisphere, latitude) {
  const h = normStr(hemisphere);
  if (h === "north" || h === "northern") return "north";
  if (h === "south" || h === "southern") return "south";
  const lat = Number(latitude);
  if (Number.isFinite(lat)) return lat < 0 ? "south" : "north";
  return "north";
}

function invertSeason(season) {
  switch (season) {
    case "winter":
      return "summer";
    case "summer":
      return "winter";
    case "spring":
      return "fall";
    case "fall":
      return "spring";
    default:
      return "winter";
  }
}

function nudgeByWeather(baseSeason, hint) {
  if (!isPlainObject(hint)) return baseSeason;

  const avgTempF = isNum(hint.avgTempF)
    ? Number(hint.avgTempF)
    : isNum(hint.avgTempC)
    ? Number(hint.avgTempC) * (9 / 5) + 32
    : null;

  const frostRisk = isNum(hint.frostRisk) ? c01(hint.frostRisk) : null;

  // Simple nudges:
  // - If "summer" but avgTempF < 45 and/or frostRisk high -> fall
  // - If "winter" but avgTempF > 60 and frostRisk low -> spring
  // - If "spring" and avgTempF very hot -> summer
  // - If "fall" and avgTempF very cold -> winter
  const t = avgTempF;

  if (baseSeason === "summer") {
    if ((t != null && t < 45) || (frostRisk != null && frostRisk > 0.6))
      return "fall";
  }
  if (baseSeason === "winter") {
    if (t != null && t > 60 && (frostRisk == null || frostRisk < 0.3))
      return "spring";
  }
  if (baseSeason === "spring") {
    if (t != null && t > 85) return "summer";
  }
  if (baseSeason === "fall") {
    if (t != null && t < 35) return "winter";
  }

  return baseSeason;
}

/* -------------------------- Ingredient season profiles ----------------------- */

/**
 * Ingredient season map.
 * Values are preferred seasons for freshness/availability.
 * - This is a "starter matrix" meant to be extended in SSA catalogs.
 *
 * Notes
 *  - Score is a bias, not a rule. Frozen/canned items still work year-round.
 *  - This is for "fresh produce" priority and garden planning hints.
 */
export const INGREDIENT_SEASONS = Object.freeze({
  // Greens
  spinach: ["spring", "fall"],
  kale: ["fall", "winter"],
  collards: ["fall", "winter"],
  mustard_greens: ["fall", "winter"],
  turnip_greens: ["fall", "winter"],
  cabbage: ["fall", "winter"],
  lettuce: ["spring", "fall"],

  // Roots
  carrot: ["fall", "winter"],
  beet: ["fall", "winter"],
  turnip: ["fall", "winter"],
  radish: ["spring", "fall"],
  potato: ["fall", "winter"],
  sweet_potato: ["fall", "winter"],
  onion: ["summer", "fall"],
  garlic: ["summer", "fall"],

  // Summer veg
  tomato: ["summer"],
  cucumber: ["summer"],
  zucchini: ["summer"],
  squash: ["summer", "fall"],
  okra: ["summer"],
  eggplant: ["summer"],
  green_beans: ["summer"],
  corn: ["summer"],

  // Peppers
  bell_pepper: ["summer"],
  hot_pepper: ["summer"],
  jalapeno: ["summer"],
  habanero: ["summer"],

  // Fruits
  apple: ["fall"],
  pear: ["fall"],
  grape: ["fall"],
  citrus: ["winter"],
  lemon: ["winter"],
  lime: ["winter"],
  orange: ["winter"],
  berry: ["spring", "summer"],
  strawberry: ["spring"],
  blueberry: ["summer"],
  watermelon: ["summer"],
  peach: ["summer"],
  mango: ["summer"],

  // Herbs (many are year-round indoors, but fresh peaks)
  basil: ["summer"],
  cilantro: ["spring", "fall"],
  parsley: ["spring", "fall"],
  dill: ["spring", "summer"],
  rosemary: ["winter", "spring"],
  thyme: ["winter", "spring"],
  mint: ["spring", "summer"],
});

/**
 * Normalize an ingredient token into a season-map key.
 * - Safe for freeform ingredient strings:
 *     "Red Bell Pepper" -> "bell_pepper"
 *     "Baby Spinach" -> "spinach"
 */
export function normalizeIngredientKey(name) {
  const s = normStr(name).replace(/[^a-z0-9\s_-]/g, " ");
  const words = s.split(/\s+/).filter(Boolean);

  if (!words.length) return "";

  // Heuristic normalization rules
  const joined = words.join("_");

  // Common mappings
  if (joined.includes("bell_pepper") || joined.includes("sweet_pepper"))
    return "bell_pepper";
  if (
    joined.includes("hot_pepper") ||
    joined.includes("chili") ||
    joined.includes("chile")
  )
    return "hot_pepper";
  if (joined.includes("mustard") && joined.includes("greens"))
    return "mustard_greens";
  if (joined.includes("turnip") && joined.includes("greens"))
    return "turnip_greens";

  // Single-word roots
  if (words.includes("spinach")) return "spinach";
  if (words.includes("kale")) return "kale";
  if (
    words.includes("collards") ||
    (words.includes("collard") && words.includes("greens"))
  )
    return "collards";
  if (words.includes("cabbage")) return "cabbage";
  if (words.includes("lettuce")) return "lettuce";

  if (words.includes("carrot") || words.includes("carrots")) return "carrot";
  if (words.includes("beet") || words.includes("beets")) return "beet";
  if (words.includes("radish") || words.includes("radishes")) return "radish";
  if (words.includes("potato") || words.includes("potatoes")) return "potato";
  if (
    words.includes("sweet") &&
    (words.includes("potato") || words.includes("potatoes"))
  )
    return "sweet_potato";

  if (words.includes("onion") || words.includes("onions")) return "onion";
  if (words.includes("garlic")) return "garlic";

  if (words.includes("tomato") || words.includes("tomatoes")) return "tomato";
  if (words.includes("cucumber") || words.includes("cucumbers"))
    return "cucumber";
  if (words.includes("zucchini")) return "zucchini";
  if (words.includes("okra")) return "okra";
  if (words.includes("eggplant")) return "eggplant";
  if (words.includes("corn")) return "corn";
  if (words.includes("squash")) return "squash";
  if (words.includes("bean") || words.includes("beans")) return "green_beans";

  if (words.includes("apple") || words.includes("apples")) return "apple";
  if (words.includes("pear") || words.includes("pears")) return "pear";
  if (words.includes("grape") || words.includes("grapes")) return "grape";
  if (words.includes("lemon") || words.includes("lemons")) return "lemon";
  if (words.includes("lime") || words.includes("limes")) return "lime";
  if (words.includes("orange") || words.includes("oranges")) return "orange";
  if (words.includes("citrus")) return "citrus";
  if (words.includes("berry") || words.includes("berries")) return "berry";
  if (words.includes("strawberry") || words.includes("strawberries"))
    return "strawberry";
  if (words.includes("blueberry") || words.includes("blueberries"))
    return "blueberry";
  if (words.includes("watermelon")) return "watermelon";
  if (words.includes("peach") || words.includes("peaches")) return "peach";
  if (words.includes("mango") || words.includes("mangoes")) return "mango";

  if (words.includes("basil")) return "basil";
  if (words.includes("cilantro")) return "cilantro";
  if (words.includes("parsley")) return "parsley";
  if (words.includes("dill")) return "dill";
  if (words.includes("rosemary")) return "rosemary";
  if (words.includes("thyme")) return "thyme";
  if (words.includes("mint")) return "mint";

  // fall back to joined
  return joined;
}

/**
 * Score ingredient seasonality for a list of ingredients.
 * ingredients can be:
 *  - strings
 *  - objects: { name, ingredient, title }
 *
 * Returns:
 *  {
 *    score01: 0..1,
 *    matched: [{ key, seasons, match: true/false }],
 *    notes: [...]
 *  }
 */
export function scoreIngredientsSeasonality(ingredients, opts = {}) {
  const season = normalizeSeason(opts.season || resolveSeason(opts));
  const list = normalizeIngredientList(ingredients);
  if (!list.length) {
    return {
      score01: 0.5,
      matched: [],
      notes: ["No ingredients provided; neutral seasonality."],
    };
  }

  let known = 0;
  let hits = 0;
  const matched = [];

  for (const name of list) {
    const key = normalizeIngredientKey(name);
    const seasons = INGREDIENT_SEASONS[key];
    if (!seasons) {
      matched.push({ key, seasons: null, match: null });
      continue;
    }
    known += 1;
    const ok = seasons.includes(season);
    if (ok) hits += 1;
    matched.push({ key, seasons, match: ok });
  }

  if (known === 0) {
    return {
      score01: 0.5,
      matched,
      notes: ["No season-mapped ingredients; neutral seasonality."],
    };
  }

  const ratio = hits / known; // 0..1
  // bias toward mild effects: map ratio to [0.35..0.85]
  const score01 = 0.35 + ratio * 0.5;

  return {
    score01: c01(score01),
    matched,
    notes: [
      `Season=${season}; known=${known}; in-season=${hits}; ratio=${Math.round(
        ratio * 100
      )}%`,
    ],
  };
}

/* ------------------------------ Cuisine season bias -------------------------- */

/**
 * Compute a cuisine season multiplier.
 * - If cuisine has a seasonality object: { winter:1.1, summer:0.9, ... }, use it.
 * - Otherwise, infer a bias from tags and meal slot.
 *
 * Returns:
 *  { multiplier, notes[] }
 */
export function scoreCuisineSeasonality(cuisine, opts = {}) {
  const season = normalizeSeason(opts.season || resolveSeason(opts));
  const slot = normalizeSlot(opts.slot);
  const notes = [];
  let mult = 1;

  if (
    isPlainObject(cuisine?.seasonality) &&
    isNum(cuisine.seasonality[season])
  ) {
    mult *= clampMult(Number(cuisine.seasonality[season]));
    notes.push(`Cuisine seasonality profile: x${round3(mult)}`);
    // still apply slot bias lightly (optional)
    const slotBias = getMealSlotSeasonBias({ season, slot });
    mult *= slotBias.multiplier;
    if (slotBias.notes.length) notes.push(...slotBias.notes);
    return { multiplier: clampMult(mult), notes };
  }

  // Tag-inferred bias (light)
  const tags = normalizeTags(cuisine?.tags);
  const inferred = inferBiasFromTags(tags, season);
  mult *= inferred.multiplier;
  if (inferred.notes.length) notes.push(...inferred.notes);

  // Slot bias (soups in winter, grills in summer)
  const slotBias = getMealSlotSeasonBias({ season, slot, tags });
  mult *= slotBias.multiplier;
  if (slotBias.notes.length) notes.push(...slotBias.notes);

  return { multiplier: clampMult(mult), notes };
}

function inferBiasFromTags(tags, season) {
  const notes = [];
  let mult = 1;

  const has = (t) => tags.includes(t);

  // Winter comfort/batch
  if (season === "winter") {
    if (
      has("soup") ||
      has("stew") ||
      has("braise") ||
      has("one_pot") ||
      has("batch")
    ) {
      mult *= 1.15;
      notes.push("Tag bias (winter comfort): x1.15");
    }
    if (has("salad") || has("fresh")) {
      mult *= 0.95;
      notes.push("Tag bias (winter fresh): x0.95");
    }
  }

  // Summer grill/fresh
  if (season === "summer") {
    if (has("grill") || has("bbq")) {
      mult *= 1.12;
      notes.push("Tag bias (summer grill): x1.12");
    }
    if (has("soup") || has("stew")) {
      mult *= 0.9;
      notes.push("Tag bias (summer soup): x0.90");
    }
  }

  // Spring: bright herbs
  if (season === "spring") {
    if (has("herbs") || has("lemon") || has("citrus") || has("salad")) {
      mult *= 1.08;
      notes.push("Tag bias (spring bright): x1.08");
    }
  }

  // Fall: harvest + roasts
  if (season === "fall") {
    if (has("roast") || has("bake") || has("braise") || has("stew")) {
      mult *= 1.1;
      notes.push("Tag bias (fall harvest): x1.10");
    }
  }

  return { multiplier: clampMult(mult), notes };
}

/**
 * Meal-slot season bias:
 * - helps your “soups as dinner” and “soup & sandwich lunch” logic without AI.
 *
 * opts: { season, slot, tags }
 * slot: breakfast | lunch | dinner | snack
 */
export function getMealSlotSeasonBias(opts = {}) {
  const season = normalizeSeason(opts.season);
  const slot = normalizeSlot(opts.slot);
  const tags = normalizeTags(opts.tags);

  const notes = [];
  let mult = 1;

  const has = (t) => tags.includes(t);

  // Dinner biases
  if (slot === "dinner") {
    if (season === "winter" || season === "fall") {
      // encourage soups/stews/braises for dinner
      if (has("soup") || has("stew") || has("braise") || has("one_pot")) {
        mult *= 1.15;
        notes.push("Slot bias (winter/fall dinner comfort): x1.15");
      }
    }
    if (season === "summer") {
      if (has("grill") || has("bbq") || has("salad")) {
        mult *= 1.08;
        notes.push("Slot bias (summer dinner fresh/grill): x1.08");
      }
    }
  }

  // Lunch biases (soup & sandwich)
  if (slot === "lunch") {
    // Encourage soup stream in colder months, but keep lighter in summer
    if (season === "winter") {
      if (has("soup") || has("stew")) {
        mult *= 1.12;
        notes.push("Slot bias (winter lunch soup): x1.12");
      }
    }
    if (season === "summer") {
      if (has("soup") || has("stew")) {
        mult *= 0.92;
        notes.push("Slot bias (summer lunch soup): x0.92");
      }
      if (has("salad") || has("fresh")) {
        mult *= 1.08;
        notes.push("Slot bias (summer lunch fresh): x1.08");
      }
    }
  }

  // Breakfast biases (minimal)
  if (slot === "breakfast") {
    if (season === "winter" && (has("comfort") || has("bake"))) {
      mult *= 1.05;
      notes.push("Slot bias (winter breakfast warm): x1.05");
    }
  }

  return { multiplier: clampMult(mult), notes };
}

/* ------------------------ Recipe-facing seasonality API ---------------------- */

/**
 * computeSeasonalityBiasForRecipe (SSA)
 * -----------------------------------------------------------------------------
 * Expected by recipeRanker.js:
 *   import { computeSeasonalityBiasForRecipe } from "./seasonality"
 *
 * Returns a single multiplier (typically ~0.8..1.2) expressing how season-appropriate
 * the recipe is given ctx + optional overrides.
 */
export function computeSeasonalityBiasForRecipe(recipe, ctx = {}, opts = {}) {
  const r = isPlainObject(recipe) ? recipe : {};

  const season =
    normalizeSeason(opts.season) ||
    normalizeSeason(ctx?.rhythm?.season) ||
    resolveSeason({
      dateISO: opts.dateISO || ctx?.rhythm?.dateISO || ctx?.rhythm?.dateKey,
      hemisphere: opts.hemisphere || ctx?.location?.hemisphere,
      latitude: opts.latitude ?? ctx?.location?.latitude,
      weatherHint:
        opts.weatherHint || ctx?.weatherHint || ctx?.rhythm?.weatherHint,
    });

  const slot =
    normalizeSlot(opts.slot) || normalizeSlot(ctx?.rhythm?.slot) || "dinner";

  const ingredients =
    r.ingredients ??
    r.ingredientList ??
    r.items ??
    r.meta?.ingredients ??
    r.meta?.ingredientList ??
    [];

  const ingScore = scoreIngredientsSeasonality(ingredients, { season });

  // Map ingredient score01 (0..1) -> multiplier (0.85..1.15)
  // Keep it mild so it nudges ranking without becoming a rule.
  const ingMult = 0.85 + c01(ingScore.score01) * 0.3; // 0.85..1.15

  // Include slot bias using tags/techniques (helps soups in winter, grills in summer)
  const tags = normalizeTags(
    r.tags ??
      r.techniques ??
      r.cuisineTags ??
      r.meta?.tags ??
      r.meta?.techniques ??
      r.meta?.cuisineTags ??
      []
  );

  const slotBias = getMealSlotSeasonBias({ season, slot, tags });

  // Optional extra technique bias if recipe declares a primary technique
  const techniqueKey =
    normStr(r.technique || r.primaryTechnique || r.meta?.technique || "")
      .replace(/\s+/g, "_")
      .trim() || "";
  const techMult = techniqueKey
    ? getTechniqueSeasonMultiplier(season, techniqueKey)
    : 1;

  const mult = clampMult(ingMult * slotBias.multiplier * techMult);
  return mult;
}

/* ------------------------------ Produce helpers ------------------------------ */

/**
 * Given ingredient strings/objects, return "in season" and "out of season" lists.
 */
export function partitionIngredientsBySeason(ingredients, opts = {}) {
  const season = normalizeSeason(opts.season || resolveSeason(opts));
  const list = normalizeIngredientList(ingredients);

  const inSeason = [];
  const outOfSeason = [];
  const unknown = [];

  for (const name of list) {
    const key = normalizeIngredientKey(name);
    const seasons = INGREDIENT_SEASONS[key];
    if (!seasons) {
      unknown.push({ name, key });
      continue;
    }
    if (seasons.includes(season)) inSeason.push({ name, key, seasons });
    else outOfSeason.push({ name, key, seasons });
  }

  return { season, inSeason, outOfSeason, unknown };
}

/* ---------------------------------- Utils ----------------------------------- */

function normalizeIngredientList(ingredients) {
  const arr = isArr(ingredients)
    ? ingredients
    : ingredients
    ? [ingredients]
    : [];
  const out = [];

  for (const it of arr) {
    if (isStr(it)) {
      const s = it.trim();
      if (s) out.push(s);
      continue;
    }
    if (isPlainObject(it)) {
      const s = (it.name || it.ingredient || it.title || "").toString().trim();
      if (s) out.push(s);
    }
  }

  return uniq(out);
}

function normalizeSeason(season) {
  const s = normStr(season);
  if (SEASONS.includes(s)) return s;
  return "";
}

function normalizeSlot(slot) {
  const s = normStr(slot);
  if (!s) return "";
  if (["breakfast", "lunch", "dinner", "snack"].includes(s)) return s;
  return "";
}

function normalizeTags(tags) {
  const arr = isArr(tags) ? tags : isStr(tags) ? [tags] : [];
  return uniq(
    arr
      .map((t) => String(t).toLowerCase().trim())
      .filter(Boolean)
      .map((t) => t.replace(/\s+/g, "_"))
  );
}

function clampMult(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 1;
  return Math.min(2.5, Math.max(0, n));
}

function round3(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 1000) / 1000;
}

/* ----------------------------- Optional export: bias presets ----------------- */

/**
 * Default seasonal technique biases (optional utility).
 * You can use these as "technique weights" elsewhere.
 */
export const SEASON_TECHNIQUE_BIASES = Object.freeze({
  winter: {
    soup: 1.25,
    stew: 1.2,
    braise: 1.15,
    roast: 1.1,
    grill: 0.95,
    salad: 0.9,
  },
  spring: {
    soup: 1.05,
    stew: 1.0,
    braise: 1.0,
    roast: 1.0,
    grill: 1.05,
    salad: 1.1,
  },
  summer: {
    soup: 0.85,
    stew: 0.9,
    braise: 0.95,
    roast: 0.95,
    grill: 1.2,
    salad: 1.2,
  },
  fall: {
    soup: 1.2,
    stew: 1.15,
    braise: 1.1,
    roast: 1.15,
    grill: 0.98,
    salad: 0.95,
  },
});

/**
 * Resolve a technique multiplier given season and technique key.
 * techniqueKey examples: "soup", "stew", "grill", "salad", "roast"
 */
export function getTechniqueSeasonMultiplier(season, techniqueKey) {
  const s = normalizeSeason(season) || "winter";
  const t = normStr(techniqueKey).replace(/\s+/g, "_");
  const m = SEASON_TECHNIQUE_BIASES[s]?.[t];
  return isNum(m) ? clampMult(m) : 1;
}

export { SOURCE as SEASONALITY_SOURCE };

/* -------------------------------------------------------------------------- */
/* ✅ Namespace export expected by mealPlanEngine.js                            */
/* -------------------------------------------------------------------------- */
/**
 * mealPlanEngine.js imports:
 *   import { seasonality } from "@/services/mealplanning/recommenders/seasonality";
 *
 * Provide a stable namespace object while keeping the existing named exports.
 */
export const seasonality = {
  // constants/maps
  SEASONS,
  INGREDIENT_SEASONS,
  SEASON_TECHNIQUE_BIASES,
  SEASONALITY_SOURCE: SOURCE,

  // season resolution
  resolveSeason,

  // ingredient helpers
  normalizeIngredientKey,
  scoreIngredientsSeasonality,
  partitionIngredientsBySeason,

  // cuisine/slot helpers
  scoreCuisineSeasonality,
  getMealSlotSeasonBias,

  // recipe helper
  computeSeasonalityBiasForRecipe,

  // technique helper
  getTechniqueSeasonMultiplier,
};
