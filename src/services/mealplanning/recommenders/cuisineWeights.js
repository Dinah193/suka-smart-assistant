// File: src/services/mealplanning/recommenders/cuisineWeights.js
/**
 * cuisineWeights.js (SSA)
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Deterministic, non-AI cuisine weighting + scoring helpers for SSA meal planning.
 *  - Supports your "fixed calendar rhythm that mimics randomness" approach by:
 *      • giving each cuisine a baseline weight
 *      • adjusting weights by user preferences, pantry readiness, season, and constraints
 *      • producing stable pseudo-randomized results (seeded) for repeatable plans
 *
 * Design goals
 *  - No network, no DB, no stores (pure functions).
 *  - Safe in browser builds.
 *  - Tolerant of partial/unknown inputs.
 *  - Extensible: add cuisines, synonyms, and rule hooks without breaking callers.
 *
 * Concepts
 *  - A "cuisine profile" is a stable ID (e.g., "west_african") with:
 *      • displayName
 *      • baseline weight
 *      • tags (spice profile, techniques, ingredients affinity)
 *      • optional seasonality, pantry affinity, and diet affinity
 *
 *  - A "weight context" is a single object containing the knobs SSA planners use:
 *      • user prefs: cuisine likes/dislikes, novelty slider, avoid list
 *      • household constraints: diet style, allergies/avoidances, Torah constraints
 *      • pantry readiness: what’s on-hand and what’s low
 *      • schedule rhythm: day-of-week, meal slot, rotation history
 *
 * Output
 *  - buildCuisineWeights(ctx) -> { weightsByCuisineId, ranked, debug }
 *  - scoreCuisine(cuisineId, ctx) -> { score, reasons }
 *  - pickCuisine(seed, ctx, { topN }) -> chosen cuisineId (deterministic)
 *  - computeCuisineWeightForRecipe(recipe, ctx) -> number (0..1-ish, normalized)
 *
 * Compatibility exports
 *  - mealPlanEngine.js imports: { cuisineWeights } from "./cuisineWeights"
 *    -> We provide a named export `cuisineWeights` as a stable namespace alias.
 */

import { stableRand01, hashStringToSeed } from "@/utils/rand";
import { isPlainObject, isArr, isStr, isNum } from "@/utils/obj";

/* --------------------------------- Defaults -------------------------------- */

export const CUISINE_IDS = Object.freeze({
  // Core set (expand freely; keep IDs stable)
  AAI_SOUTHERN: "aai_southern", // African-American Israelite Southern
  MEDITERRANEAN: "mediterranean",
  WEST_AFRICAN: "west_african",
  SEPHARDIC: "sephardic",
  LEVANTINE: "levantine",
  NORTH_AFRICAN: "north_african",
  CARIBBEAN: "caribbean",
  INDIAN: "indian",
  EAST_AFRICAN: "east_african",
  ETHIOPIAN: "ethiopian",
  ARABIAN_GULF: "arabian_gulf",
  PERSIAN: "persian",
  TURKISH: "turkish",
  CAJUN_CREOLE: "cajun_creole",
  LATIN: "latin",
  ASIAN_FUSION: "asian_fusion",
  AMERICAN_CLASSIC: "american_classic",
  SOUP_STEW: "soup_stew", // slot-friendly cuisine-like stream
});

/**
 * Baseline cuisine catalog.
 * - weights are relative (not percent). Final distribution is normalized.
 * - tags are for rule matching (pantry/technique/spice).
 */
export const DEFAULT_CUISINE_CATALOG = Object.freeze([
  {
    id: CUISINE_IDS.AAI_SOUTHERN,
    displayName: "AAI Southern",
    weight: 1.25,
    tags: [
      "southern",
      "comfort",
      "smoke",
      "bbq",
      "cast_iron",
      "grits",
      "greens",
    ],
    dietAffinity: {
      keto: 0.95,
      carnivore: 1.05,
      vegetarian: 0.65,
      balanced: 1.1,
    },
    seasonality: { winter: 1.15, spring: 1.0, summer: 0.95, fall: 1.1 },
  },
  {
    id: CUISINE_IDS.MEDITERRANEAN,
    displayName: "Mediterranean",
    weight: 1.15,
    tags: [
      "olive_oil",
      "herbs",
      "grill",
      "salad",
      "seafood",
      "lemon",
      "garlic",
    ],
    dietAffinity: {
      keto: 0.9,
      carnivore: 0.9,
      vegetarian: 1.1,
      balanced: 1.15,
    },
    seasonality: { winter: 0.95, spring: 1.1, summer: 1.2, fall: 1.05 },
  },
  {
    id: CUISINE_IDS.WEST_AFRICAN,
    displayName: "West African",
    weight: 1.05,
    tags: ["stew", "pepper", "groundnut", "suya", "jollof", "leafy_greens"],
    dietAffinity: {
      keto: 0.85,
      carnivore: 0.95,
      vegetarian: 1.0,
      balanced: 1.05,
    },
    seasonality: { winter: 1.05, spring: 1.0, summer: 1.0, fall: 1.1 },
  },
  {
    id: CUISINE_IDS.SEPHARDIC,
    displayName: "Sephardic Stream",
    weight: 0.95,
    tags: ["braise", "herbs", "citrus", "rice", "eggplant", "spice_blend"],
    dietAffinity: {
      keto: 0.85,
      carnivore: 0.9,
      vegetarian: 1.05,
      balanced: 1.05,
    },
    seasonality: { winter: 1.0, spring: 1.05, summer: 1.05, fall: 1.0 },
  },
  {
    id: CUISINE_IDS.LEVANTINE,
    displayName: "Levantine",
    weight: 1.0,
    tags: ["shawarma", "garlic", "lemon", "yogurt", "grill", "mezze"],
    dietAffinity: {
      keto: 0.9,
      carnivore: 0.95,
      vegetarian: 1.05,
      balanced: 1.05,
    },
    seasonality: { winter: 1.0, spring: 1.05, summer: 1.05, fall: 1.0 },
  },
  {
    id: CUISINE_IDS.NORTH_AFRICAN,
    displayName: "North African",
    weight: 0.9,
    tags: ["tagine", "cumin", "coriander", "harissa", "preserved_lemon"],
    dietAffinity: {
      keto: 0.9,
      carnivore: 0.95,
      vegetarian: 1.0,
      balanced: 1.0,
    },
    seasonality: { winter: 1.1, spring: 1.0, summer: 0.95, fall: 1.1 },
  },
  {
    id: CUISINE_IDS.CARIBBEAN,
    displayName: "Caribbean",
    weight: 1.0,
    tags: ["jerk", "coconut", "plantain", "stew", "cabbage", "spice"],
    dietAffinity: {
      keto: 0.85,
      carnivore: 0.9,
      vegetarian: 1.0,
      balanced: 1.0,
    },
    seasonality: { winter: 0.95, spring: 1.0, summer: 1.15, fall: 1.0 },
  },
  {
    id: CUISINE_IDS.INDIAN,
    displayName: "Indian",
    weight: 1.05,
    tags: ["curry", "tandoor", "ghee", "masala", "dal", "spice"],
    dietAffinity: {
      keto: 0.9,
      carnivore: 0.85,
      vegetarian: 1.2,
      balanced: 1.05,
    },
    seasonality: { winter: 1.1, spring: 1.0, summer: 0.95, fall: 1.05 },
  },
  {
    id: CUISINE_IDS.CAJUN_CREOLE,
    displayName: "Cajun/Creole",
    weight: 0.85,
    tags: ["roux", "stew", "smoke", "spice", "rice", "seafood"],
    dietAffinity: {
      keto: 0.9,
      carnivore: 1.0,
      vegetarian: 0.7,
      balanced: 0.95,
    },
    seasonality: { winter: 1.15, spring: 1.0, summer: 0.95, fall: 1.1 },
  },
  {
    id: CUISINE_IDS.AMERICAN_CLASSIC,
    displayName: "American Classic",
    weight: 0.75,
    tags: ["simple", "bake", "roast", "skillet", "comfort"],
    dietAffinity: {
      keto: 0.9,
      carnivore: 1.05,
      vegetarian: 0.75,
      balanced: 0.95,
    },
    seasonality: { winter: 1.05, spring: 1.0, summer: 1.0, fall: 1.05 },
  },
  {
    id: CUISINE_IDS.SOUP_STEW,
    displayName: "Soup & Stew Stream",
    weight: 0.85,
    tags: ["soup", "stew", "batch", "leftovers", "one_pot"],
    dietAffinity: { keto: 1.0, carnivore: 1.0, vegetarian: 1.0, balanced: 1.0 },
    seasonality: { winter: 1.25, spring: 1.05, summer: 0.8, fall: 1.2 },
  },
]);

/**
 * Synonyms -> cuisine IDs (used when user types freeform).
 */
export const CUISINE_SYNONYMS = Object.freeze({
  "african american": CUISINE_IDS.AAI_SOUTHERN,
  southern: CUISINE_IDS.AAI_SOUTHERN,
  soulfood: CUISINE_IDS.AAI_SOUTHERN,
  "soul food": CUISINE_IDS.AAI_SOUTHERN,
  mediterranean: CUISINE_IDS.MEDITERRANEAN,
  "west african": CUISINE_IDS.WEST_AFRICAN,
  nigerian: CUISINE_IDS.WEST_AFRICAN,
  ghanaian: CUISINE_IDS.WEST_AFRICAN,
  "north african": CUISINE_IDS.NORTH_AFRICAN,
  moroccan: CUISINE_IDS.NORTH_AFRICAN,
  tunisian: CUISINE_IDS.NORTH_AFRICAN,
  "middle eastern": CUISINE_IDS.LEVANTINE,
  levantine: CUISINE_IDS.LEVANTINE,
  shawarma: CUISINE_IDS.LEVANTINE,
  sephardic: CUISINE_IDS.SEPHARDIC,
  caribbean: CUISINE_IDS.CARIBBEAN,
  jamaican: CUISINE_IDS.CARIBBEAN,
  trini: CUISINE_IDS.CARIBBEAN,
  trinidad: CUISINE_IDS.CARIBBEAN,
  indian: CUISINE_IDS.INDIAN,
  curry: CUISINE_IDS.INDIAN,
  cajun: CUISINE_IDS.CAJUN_CREOLE,
  creole: CUISINE_IDS.CAJUN_CREOLE,
  soup: CUISINE_IDS.SOUP_STEW,
  stew: CUISINE_IDS.SOUP_STEW,
});

/* -------------------------------- Public API -------------------------------- */

export function buildCuisineWeights(ctx = {}) {
  const catalog = getCatalog(ctx);
  const weightsByCuisineId = {};
  const debug = ctx?.debug
    ? { reasons: {}, inputs: sanitizeCtxForDebug(ctx) }
    : null;

  for (const c of catalog) {
    const { score, reasons } = scoreCuisine(c.id, ctx, { catalog });
    weightsByCuisineId[c.id] = score;
    if (debug) debug.reasons[c.id] = reasons;
  }

  // Normalize and rank
  const ranked = Object.entries(weightsByCuisineId)
    .map(([id, w]) => ({ id, weight: safeNum(w, 0) }))
    .filter((x) => x.weight > 0)
    .sort((a, b) => b.weight - a.weight);

  const normalized = normalizeWeights(
    Object.fromEntries(ranked.map((r) => [r.id, r.weight]))
  );

  return {
    weightsByCuisineId: normalized,
    ranked: ranked.map((r) => ({ ...r, weight: normalized[r.id] ?? 0 })),
    ...(debug ? { debug } : {}),
  };
}

export function scoreCuisine(cuisineId, ctx = {}, { catalog = null } = {}) {
  const c = findCuisine(cuisineId, catalog || getCatalog(ctx));
  if (!c)
    return { score: 0, reasons: [`Unknown cuisine: ${String(cuisineId)}`] };

  const reasons = [];
  let w = safeNum(c.weight, 1);

  // Hard include/exclude controls
  const hardInclude = normalizeCuisineList(ctx?.overrides?.hardInclude);
  if (hardInclude.length && !hardInclude.includes(c.id)) {
    return { score: 0, reasons: ["Excluded by overrides.hardInclude"] };
  }

  const avoidList = normalizeCuisineList(ctx?.userPrefs?.avoidCuisines);
  if (avoidList.includes(c.id)) {
    return { score: 0, reasons: ["Excluded by userPrefs.avoidCuisines"] };
  }

  // Diet affinity multiplier
  const dietStyle = normalizeDietStyle(ctx?.constraints?.dietStyle);
  const dietMult = getDietAffinityMultiplier(c, dietStyle);
  w *= dietMult;
  if (dietMult !== 1)
    reasons.push(`Diet affinity (${dietStyle}): x${round3(dietMult)}`);

  // Seasonality multiplier
  const season = normalizeSeason(ctx?.rhythm?.season);
  const seasonMult = getSeasonMultiplier(c, season);
  w *= seasonMult;
  if (seasonMult !== 1)
    reasons.push(`Seasonality (${season}): x${round3(seasonMult)}`);

  // Pantry readiness based on tags
  const pantryMult = getPantryMultiplier(c, ctx?.pantry);
  w *= pantryMult.multiplier;
  if (pantryMult.notes.length) reasons.push(...pantryMult.notes);

  // User likes/dislikes
  const prefMult = getPreferenceMultiplier(c, ctx?.userPrefs);
  w *= prefMult.multiplier;
  if (prefMult.notes.length) reasons.push(...prefMult.notes);

  // Tag constraints: avoidTags / requiredTags
  const tagGate = applyTagConstraints(c, ctx?.constraints);
  w *= tagGate.multiplier;
  if (tagGate.notes.length) reasons.push(...tagGate.notes);
  if (w <= 0) return { score: 0, reasons };

  // Repeat penalty based on recent history
  const rep = getRepeatPenalty(c, ctx?.rhythm, ctx?.userPrefs);
  w *= rep.multiplier;
  if (rep.notes.length) reasons.push(...rep.notes);

  // Novelty bias: encourage variety across cuisines (still deterministic)
  const novelty = clamp01(safeNum(ctx?.userPrefs?.novelty, 0.35));
  if (novelty > 0) {
    const seed = makeSeed(ctx, `novelty:${c.id}`);
    const r = stableRand01(seed); // 0..1
    // bias: (1 - novelty) to (1 + novelty) around 1.0
    const nMult = 1 + (r - 0.5) * 2 * novelty; // range [1-novelty, 1+novelty]
    w *= nMult;
    reasons.push(`Novelty (${round2(novelty)}): x${round3(nMult)}`);
  }

  // Final safety clamp (prevent tiny negative/NaN)
  const score = Math.max(0, safeNum(w, 0));
  return { score, reasons };
}

export function pickCuisine(seed, ctx = {}, { topN = null } = {}) {
  const built = buildCuisineWeights(ctx);
  const ranked = built.ranked;

  const pool =
    Number.isFinite(Number(topN)) && Number(topN) > 0
      ? ranked.slice(0, Number(topN))
      : ranked;
  if (!pool.length) return null;

  const weights = {};
  for (const r of pool) weights[r.id] = r.weight;

  const normalized = normalizeWeights(weights);
  const roll = stableRand01(String(seed ?? makeSeed(ctx, "pickCuisine")));
  return weightedPick(normalized, roll);
}

export function normalizeCuisineId(input) {
  if (!input) return "";
  const s = String(input).trim();
  if (!s) return "";
  const key = s.toLowerCase().replace(/\s+/g, " ").trim();
  if (CUISINE_SYNONYMS[key]) return CUISINE_SYNONYMS[key];
  // also accept already-canonical IDs
  return s.toLowerCase().replace(/\s+/g, "_");
}

/**
 * computeCuisineWeightForRecipe (SSA)
 * -----------------------------------------------------------------------------
 * Expected by recipeRanker.js:
 *   import { computeCuisineWeightForRecipe } from "./cuisineWeights"
 *
 * Returns a normalized weight (0..1) representing how well this recipe's
 * cuisine(s) align with the current context weights.
 */
export function computeCuisineWeightForRecipe(recipe, ctx = {}, opts = {}) {
  const r = isPlainObject(recipe) ? recipe : {};
  const built = buildCuisineWeights(ctx);
  const map = isPlainObject(built?.weightsByCuisineId)
    ? built.weightsByCuisineId
    : {};

  const ids = extractRecipeCuisineIds(r, ctx, opts);
  if (!ids.length) {
    // If recipe doesn't declare cuisine, don't punish harshly:
    // return neutral-ish weight (average of available weights).
    const vals = Object.values(map).filter((v) => isNum(v) && v > 0);
    if (!vals.length) return 0;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  }

  // If multiple cuisines, average their weights (or max if opts.multiMode="max")
  const mode = String(opts.multiMode || "avg").toLowerCase();
  const weights = ids
    .map((id) => map[normalizeCuisineId(id)])
    .map((v) => (isNum(v) ? Number(v) : 0))
    .filter((v) => v > 0);

  if (!weights.length) return 0;

  if (mode === "max") return Math.max(...weights);
  if (mode === "min") return Math.min(...weights);
  return weights.reduce((a, b) => a + b, 0) / weights.length;
}

/* ------------------------------- Internals ---------------------------------- */

function getCatalog(ctx) {
  const custom = ctx?.overrides?.catalog;
  if (isArr(custom) && custom.length) {
    return custom
      .filter((x) => isPlainObject(x) && isStr(x.id))
      .map((x) => ({
        ...x,
        id: String(x.id),
        displayName: isStr(x.displayName) ? x.displayName : String(x.id),
        weight: safeNum(x.weight, 1),
        tags: normalizeTags(x.tags),
        dietAffinity: isPlainObject(x.dietAffinity) ? x.dietAffinity : {},
        seasonality: isPlainObject(x.seasonality) ? x.seasonality : {},
      }));
  }
  return DEFAULT_CUISINE_CATALOG.map((x) => ({
    ...x,
    tags: normalizeTags(x.tags),
  }));
}

function findCuisine(id, catalog) {
  const cid = normalizeCuisineId(id);
  const list = isArr(catalog) ? catalog : [];
  return list.find((c) => normalizeCuisineId(c.id) === cid) || null;
}

function normalizeTags(tags) {
  const arr = isArr(tags) ? tags : isStr(tags) ? [tags] : [];
  return Array.from(
    new Set(
      arr
        .map((t) => String(t).toLowerCase().trim())
        .filter(Boolean)
        .map((t) => t.replace(/\s+/g, "_"))
    )
  );
}

function normalizeCuisineList(list) {
  const arr = isArr(list) ? list : isStr(list) ? [list] : [];
  const ids = arr
    .map((x) => normalizeCuisineId(x))
    .filter(Boolean)
    .map((x) => x.toLowerCase());
  return Array.from(new Set(ids));
}

function normalizeSeason(season) {
  const s = String(season || "")
    .toLowerCase()
    .trim();
  if (s === "winter" || s === "spring" || s === "summer" || s === "fall")
    return s;
  return "winter"; // safe default; planner can override
}

function normalizeDietStyle(dietStyle) {
  const s = String(dietStyle || "")
    .toLowerCase()
    .trim();
  if (!s) return "balanced";
  if (
    [
      "balanced",
      "keto",
      "carnivore",
      "vegetarian",
      "pescatarian",
      "omad",
    ].includes(s)
  )
    return s;
  return s; // keep custom; affinity resolver will fall back
}

function getDietAffinityMultiplier(cuisine, dietStyle) {
  const aff = cuisine?.dietAffinity;
  if (!isPlainObject(aff)) return 1;
  const v = aff[dietStyle];
  if (isNum(v)) return clamp(Number(v), 0, 2.5);
  if (isNum(aff.balanced)) return clamp(Number(aff.balanced), 0, 2.5);
  return 1;
}

function getSeasonMultiplier(cuisine, season) {
  const s = cuisine?.seasonality;
  if (!isPlainObject(s)) return 1;
  const v = s[season];
  if (isNum(v)) return clamp(Number(v), 0, 2.5);
  return 1;
}

function getPantryMultiplier(cuisine, pantry) {
  const notes = [];
  let mult = 1;

  const readinessByTag = isPlainObject(pantry?.readinessByTag)
    ? pantry.readinessByTag
    : {};
  const lowTags = normalizeTags(pantry?.lowTags);

  const tags = normalizeTags(cuisine?.tags);

  const readyVals = [];
  for (const t of tags) {
    const v = readinessByTag[t];
    if (isNum(v)) readyVals.push(clamp01(Number(v)));
  }
  if (readyVals.length) {
    const avg = readyVals.reduce((a, b) => a + b, 0) / readyVals.length;
    const m = 0.8 + avg * 0.4;
    mult *= m;
    notes.push(`Pantry readiness: x${round3(m)}`);
  }

  if (lowTags.length && tags.length) {
    const matches = tags.filter((t) => lowTags.includes(t));
    if (matches.length) {
      const penalty = clamp(matches.length * 0.1, 0.05, 0.4); // 5%..40%
      const m = 1 - penalty;
      mult *= m;
      notes.push(
        `Low pantry tags (${matches.slice(0, 3).join(", ")}): x${round3(m)}`
      );
    }
  }

  return { multiplier: clamp(mult, 0, 3), notes };
}

function getPreferenceMultiplier(cuisine, userPrefs) {
  const notes = [];
  let mult = 1;

  const likes = normalizePrefMap(userPrefs?.cuisineLikes);
  const dislikes = normalizePrefMap(userPrefs?.cuisineDislikes);

  const like = likes[cuisine.id];
  const dislike = dislikes[cuisine.id];

  if (isNum(like)) {
    const m = 1 + clamp01(like) * 0.6;
    mult *= m;
    notes.push(`User like (${round2(like)}): x${round3(m)}`);
  }

  if (isNum(dislike)) {
    const m = 1 - clamp01(dislike) * 0.8;
    mult *= m;
    notes.push(`User dislike (${round2(dislike)}): x${round3(m)}`);
  }

  return { multiplier: clamp(mult, 0, 3), notes };
}

function normalizePrefMap(map) {
  const out = {};
  if (!isPlainObject(map)) return out;

  for (const [k, v] of Object.entries(map)) {
    const id = normalizeCuisineId(k);
    if (!id) continue;
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    out[id] = clamp01(n);
  }
  return out;
}

function applyTagConstraints(cuisine, constraints) {
  const notes = [];
  let mult = 1;

  const avoidTags = normalizeTags(constraints?.avoidTags);
  const requiredTags = normalizeTags(constraints?.requiredTags);
  const tags = normalizeTags(cuisine?.tags);

  if (avoidTags.length) {
    const bad = tags.filter((t) => avoidTags.includes(t));
    if (bad.length) {
      const m = 0.25;
      mult *= m;
      notes.push(
        `Avoid tags hit (${bad.slice(0, 3).join(", ")}): x${round3(m)}`
      );
    }
  }

  if (requiredTags.length) {
    const hasAny = requiredTags.some((t) => tags.includes(t));
    if (!hasAny) {
      return { multiplier: 0, notes: ["Blocked (missing requiredTags)"] };
    }
    notes.push("Matches requiredTags");
  }

  return { multiplier: clamp(mult, 0, 3), notes };
}

function getRepeatPenalty(cuisine, rhythm, userPrefs) {
  const notes = [];
  let mult = 1;

  const history = isArr(rhythm?.history) ? rhythm.history : [];
  if (!history.length) return { multiplier: 1, notes };

  const repeatPenalty = clamp01(safeNum(userPrefs?.repeatPenalty, 0.5)); // 0..1
  if (repeatPenalty <= 0) return { multiplier: 1, notes };

  const last = history
    .slice()
    .reverse()
    .slice(0, 7)
    .map((h, idx) => ({ id: normalizeCuisineId(h?.cuisineId), idx }))
    .filter((x) => !!x.id);

  const hits = last.filter((x) => x.id === normalizeCuisineId(cuisine.id));
  if (!hits.length) return { multiplier: 1, notes };

  let p = 0;
  for (const h of hits) {
    const recency = 1 - clamp01(h.idx / 6); // 1..0
    p += recency * 0.35; // each hit contributes up to 35%
  }
  p = clamp(p, 0.05, 0.75) * repeatPenalty;
  mult *= 1 - p;

  notes.push(`Repeat penalty: x${round3(mult)} (p=${round3(p)})`);
  return { multiplier: clamp(mult, 0, 3), notes };
}

/* ----------------------------- Weighted utilities ---------------------------- */

export function normalizeWeights(weightsById) {
  const w = isPlainObject(weightsById) ? weightsById : {};
  const keys = Object.keys(w);
  if (!keys.length) return {};

  const cleaned = {};
  let sum = 0;

  for (const k of keys) {
    const v = Number(w[k]);
    const n = Number.isFinite(v) && v > 0 ? v : 0;
    cleaned[k] = n;
    sum += n;
  }

  if (sum <= 0) {
    const u = 1 / keys.length;
    const out = {};
    for (const k of keys) out[k] = u;
    return out;
  }

  const out = {};
  for (const k of keys) out[k] = cleaned[k] / sum;
  return out;
}

export function weightedPick(normalizedWeightsById, roll01) {
  const w = isPlainObject(normalizedWeightsById) ? normalizedWeightsById : {};
  const keys = Object.keys(w);
  if (!keys.length) return null;

  const r = clamp01(Number(roll01));
  let acc = 0;

  // deterministic order for stability
  keys.sort();

  for (const k of keys) {
    const v = safeNum(w[k], 0);
    if (v <= 0) continue;
    acc += v;
    if (r <= acc) return k;
  }
  return keys[keys.length - 1] || null;
}

/* ------------------------------ Seed utilities ------------------------------- */

function makeSeed(ctx, salt) {
  const dayKey =
    (isStr(ctx?.rhythm?.dayKey) && ctx.rhythm.dayKey) ||
    (isStr(ctx?.rhythm?.dateKey) && ctx.rhythm.dateKey) ||
    "";

  const active = isStr(ctx?.activeHouseholdId) ? ctx.activeHouseholdId : "";
  const diet = isStr(ctx?.constraints?.dietStyle)
    ? ctx.constraints.dietStyle
    : "";
  const s = `${dayKey}|${active}|${diet}|${String(salt || "")}`;
  return String(hashStringToSeed(s));
}

/* ------------------------------ Recipe helpers ------------------------------ */

function extractRecipeCuisineIds(recipe, ctx, opts) {
  const out = [];

  const direct =
    recipe?.cuisineId ??
    recipe?.cuisine ??
    recipe?.primaryCuisine ??
    recipe?.meta?.cuisineId ??
    recipe?.meta?.cuisine ??
    null;

  if (isStr(direct) && direct.trim()) out.push(normalizeCuisineId(direct));

  const listish =
    recipe?.cuisines ??
    recipe?.cuisineIds ??
    recipe?.meta?.cuisines ??
    recipe?.meta?.cuisineIds ??
    null;

  if (isArr(listish)) {
    for (const x of listish) {
      if (isStr(x) && x.trim()) out.push(normalizeCuisineId(x));
    }
  } else if (isStr(listish) && listish.trim()) {
    // allow comma-separated
    const parts = listish
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const p of parts) out.push(normalizeCuisineId(p));
  }

  // Optional inference from tags
  const infer =
    opts?.inferFromTags ?? ctx?.constraints?.inferCuisineFromTags ?? true; // default true
  if (infer) {
    const tags = normalizeTags(
      recipe?.cuisineTags ??
        recipe?.tags ??
        recipe?.meta?.tags ??
        recipe?.meta?.cuisineTags ??
        []
    );

    // map common tags to cuisines
    for (const t of tags) {
      const maybe = CUISINE_SYNONYMS[String(t).replace(/_/g, " ")] || null;
      if (maybe) out.push(normalizeCuisineId(maybe));
    }

    // Also attempt direct match if tag equals a cuisine id
    for (const t of tags) {
      const idish = normalizeCuisineId(t);
      if (idish && Object.values(CUISINE_IDS).includes(idish)) out.push(idish);
    }
  }

  // de-dupe
  return Array.from(new Set(out.filter(Boolean)));
}

/* -------------------------------- Debug ------------------------------------- */

function sanitizeCtxForDebug(ctx) {
  return {
    userPrefs: {
      novelty: ctx?.userPrefs?.novelty,
      repeatPenalty: ctx?.userPrefs?.repeatPenalty,
      avoidCuisines: normalizeCuisineList(ctx?.userPrefs?.avoidCuisines),
      cuisineLikes: ctx?.userPrefs?.cuisineLikes
        ? Object.keys(ctx.userPrefs.cuisineLikes).length
        : 0,
      cuisineDislikes: ctx?.userPrefs?.cuisineDislikes
        ? Object.keys(ctx.userPrefs.cuisineDislikes).length
        : 0,
    },
    constraints: {
      dietStyle: ctx?.constraints?.dietStyle,
      avoidTags: normalizeTags(ctx?.constraints?.avoidTags),
      requiredTags: normalizeTags(ctx?.constraints?.requiredTags),
    },
    pantry: {
      readinessByTag: ctx?.pantry?.readinessByTag
        ? Object.keys(ctx.pantry.readinessByTag).length
        : 0,
      lowTags: normalizeTags(ctx?.pantry?.lowTags),
    },
    rhythm: {
      season: ctx?.rhythm?.season,
      dayKey: ctx?.rhythm?.dayKey,
      historyCount: isArr(ctx?.rhythm?.history) ? ctx.rhythm.history.length : 0,
    },
    overrides: {
      hardInclude: normalizeCuisineList(ctx?.overrides?.hardInclude),
      catalogCustom: isArr(ctx?.overrides?.catalog)
        ? ctx.overrides.catalog.length
        : 0,
    },
  };
}

/* --------------------------------- Math ------------------------------------- */

function clamp01(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}
function clamp(n, lo, hi) {
  const x = Number(n);
  const a = Number(lo);
  const b = Number(hi);
  if (!Number.isFinite(x)) return Number.isFinite(a) ? a : 0;
  const low = Number.isFinite(a) ? a : 0;
  const high = Number.isFinite(b) ? b : low;
  return Math.min(high, Math.max(low, x));
}
function safeNum(n, fallback) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}
function round2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}
function round3(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 1000) / 1000;
}

/* -------------------------------------------------------------------------- */
/* ✅ Namespace export expected by mealPlanEngine.js                            */
/* -------------------------------------------------------------------------- */
/**
 * mealPlanEngine.js imports:
 *   import { cuisineWeights } from "@/services/mealplanning/recommenders/cuisineWeights";
 *
 * Provide a stable namespace object while keeping the existing named exports.
 */
export const cuisineWeights = {
  // constants/catalog
  CUISINE_IDS,
  DEFAULT_CUISINE_CATALOG,
  CUISINE_SYNONYMS,

  // core API
  buildCuisineWeights,
  scoreCuisine,
  pickCuisine,
  normalizeCuisineId,
  computeCuisineWeightForRecipe,

  // utilities
  normalizeWeights,
  weightedPick,
};
