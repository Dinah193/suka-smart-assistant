// File: src/services/mealplanning/recommenders/recipeRanker.js
/**
 * recipeRanker.js (SSA)
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Deterministic, explainable ranking engine for SSA meal planning.
 *  - Ranks recipe candidates for a given "slot" (breakfast/lunch/dinner/snack),
 *    respecting:
 *      • user/household preferences (MealPrefsStore via caller payload)
 *      • cuisine weights (cuisineWeights.js)
 *      • seasonality bias (seasonality.js)
 *      • protein/meat rhythm constraints (fixed meats + pseudo-random meals)
 *      • variety / rotation (avoid repeats, cooldowns)
 *      • inventory / storehouse readiness (best-effort signals)
 *      • nutrition macro targets (best-effort signals)
 *      • difficulty/time windows
 *      • leftovers strategy (soup & sandwich / prep-ahead)
 *
 * Design goals
 *  - "Little to no AI": scoring is rule-based and transparent.
 *  - Browser-safe: no Node imports.
 *  - Production ready: stable defaults, defensive input parsing, rich explanations.
 *
 * Integration points (caller provides these)
 *  - recipes: array of recipe objects (library)
 *  - slot: { kind, dateISO, mealTime, rules, ... }
 *  - prefs: user/household preferences (cuisines, meats, allergens, etc.)
 *  - context:
 *      • history: recent planned meals
 *      • inventory: on-hand items / shortages
 *      • nutrition: macro targets + current day summary
 *      • seasonalityCtx: { hemisphere, latitude, frostDates, monthIndex, season }
 *      • cuisineCtx: computed cuisine weights (or raw prefs)
 *
 * Output
 *  - { ranked: [ { recipe, score, reasons, breakdown } ... ], meta }
 *
 * NOTE
 *  - This module does not fetch stores. It’s pure and caller-driven.
 */

import { isPlainObject, isArr, isStr, isNum } from "@/utils/obj";
import { toISODate, parseISODate, diffDays } from "@/utils/dates";
import { computeCuisineWeightForRecipe } from "@/services/mealplanning/recommenders/cuisineWeights";
import { computeSeasonalityBiasForRecipe } from "@/services/mealplanning/recommenders/seasonality";

/* -------------------------------- Constants -------------------------------- */

const SOURCE = "mealplanning.recipeRanker";

const DEFAULTS = Object.freeze({
  limit: 25,
  // If two candidates are within this delta, shuffle within bucket for pseudo-randomness
  bucketDelta: 0.03,
  // Hard excludes
  excludes: {
    requireImages: false, // if UI wants photogenic recipes
    blockOnAllergenMatch: true,
  },
  weights: Object.freeze({
    cuisine: 0.18,
    seasonality: 0.1,
    rotation: 0.18,
    proteinRhythm: 0.2,
    inventory: 0.14,
    nutrition: 0.1,
    time: 0.06,
    difficulty: 0.04,
  }),
  cooldown: {
    // days to downrank repeated recipes
    recipeDays: 14,
    cuisineDays: 5,
    cuisinePenaltyMax: 0.22,
    recipePenaltyMax: 0.35,
  },
  time: {
    // minute targets per slot kind (default)
    breakfast: 20,
    lunch: 25,
    dinner: 45,
    snack: 10,
  },
  difficulty: {
    // 0..1 preference: lower means prefer easy
    preference: 0.45,
  },
  inventory: {
    // heuristic thresholds for coverage
    fullCoverageBonus: 0.2,
    partialCoverageBonus: 0.1,
    missingPenaltyMax: 0.28,
  },
  nutrition: {
    // how strongly to align macros
    macroTolerance: 0.15, // fraction tolerance
    alignBonusMax: 0.22,
    misalignPenaltyMax: 0.18,
  },
  randomness: {
    // deterministic seed inputs
    seedSalt: "ssa.recipeRanker.v1",
    // if true, stable shuffle within bucket by seed
    stableShuffle: true,
  },
});

/* -------------------------------- Public API -------------------------------- */

export function rankRecipes(input = {}) {
  const t0 = Date.now();
  const req = normalizeRequest(input);

  const { recipes, slot, prefs, context, options } = req;

  const hard = compileHardConstraints(slot, prefs, options);

  const scored = [];
  for (const raw of recipes) {
    const recipe = normalizeRecipe(raw);
    if (!recipe) continue;

    const hardResult = evaluateHardConstraints(recipe, hard, req);
    if (!hardResult.ok) continue;

    const { score, reasons, breakdown } = scoreRecipe(recipe, req);

    scored.push({
      recipe,
      score,
      reasons,
      breakdown,
    });
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Bucketize and shuffle within close buckets for "random-like" variety
  const ranked = bucketAndShuffle(scored, req);

  // Limit
  const limited = ranked.slice(0, options.limit);

  return {
    ranked: limited,
    meta: {
      source: SOURCE,
      totalInput: recipes.length,
      totalScored: scored.length,
      returned: limited.length,
      slot: slotSummary(slot),
      ms: Date.now() - t0,
    },
  };
}

/**
 * Convenience: return just top recipe objects
 */
export function pickTopRecipes(input = {}) {
  const res = rankRecipes(input);
  return res.ranked.map((x) => x.recipe);
}

/**
 * Explain a specific recipe against a request without ranking all.
 */
export function explainRecipe(recipe, input = {}) {
  const req = normalizeRequest({ ...input, recipes: [recipe] });
  const r = normalizeRecipe(recipe);
  if (!r) return { ok: false, error: "Bad recipe" };

  const hard = compileHardConstraints(req.slot, req.prefs, req.options);
  const hardResult = evaluateHardConstraints(r, hard, req);
  if (!hardResult.ok)
    return { ok: false, excluded: true, reason: hardResult.reason };

  const out = scoreRecipe(r, req);
  return { ok: true, ...out };
}

/* ------------------------------ Normalization ------------------------------ */

function normalizeRequest(input) {
  const opts = isPlainObject(input.options) ? input.options : {};
  const options = deepMergeLite(DEFAULTS, opts);

  const recipes = isArr(input.recipes) ? input.recipes : [];
  const slot = normalizeSlot(input.slot, input, options);
  const prefs = normalizePrefs(input.prefs);
  const context = normalizeContext(input.context);

  return { recipes, slot, prefs, context, options };
}

function normalizeSlot(slot, input, options) {
  const s = isPlainObject(slot) ? slot : {};
  const dateISO =
    toISODate(s.dateISO || input.dateISO || null) || toISODate(new Date());
  const kind = normKey(s.kind || s.meal || s.slot || "dinner") || "dinner";

  return {
    id: s.id ? String(s.id) : `slot_${kind}_${dateISO}`,
    kind,
    dateISO,
    // "protein plan" (fixed meats): caller can pass required proteins
    requiredProteins: normalizeList(
      s.requiredProteins || s.requiredProtein || null
    ),
    blockedProteins: normalizeList(s.blockedProteins || null),
    // caller-defined rule knobs
    maxTimeMin: isNum(s.maxTimeMin)
      ? Math.max(1, Math.floor(Number(s.maxTimeMin)))
      : null,
    preferLeftovers: !!s.preferLeftovers,
    allowSoup: s.allowSoup !== false, // soups for dinner supported by default
    allowSandwich: s.allowSandwich !== false, // soup & sandwich lunch supported
    tags: normalizeList(s.tags),
    meta: isPlainObject(s.meta) ? s.meta : {},
    // defaults per kind
    targetTimeMin: options.time[kind] || options.time.dinner,
  };
}

function normalizePrefs(prefs) {
  const p = isPlainObject(prefs) ? prefs : {};

  return {
    // cuisines user likes/dislikes: arrays of cuisine keys
    cuisines: normalizeList(p.cuisines || p.preferredCuisines),
    avoidCuisines: normalizeList(p.avoidCuisines || p.dislikedCuisines),
    // proteins / meats (SSA fixed rhythm)
    proteins: normalizeList(p.proteins || p.meats || p.fixedMeats),
    avoidProteins: normalizeList(p.avoidProteins || p.noMeats),
    // allergens
    allergens: normalizeList(p.allergens || p.avoidAllergens),
    // dietary styles
    dietStyle: normKey(p.dietStyle || p.diet || ""),
    // constraints
    maxDifficulty: isNum(p.maxDifficulty)
      ? clamp01(Number(p.maxDifficulty))
      : null,
    preferEasy: p.preferEasy !== undefined ? !!p.preferEasy : true,
    // variety knobs
    variety: {
      preferNew: p.variety?.preferNew === true,
      repeatOkay: p.variety?.repeatOkay === true,
    },
  };
}

function normalizeContext(ctx) {
  const c = isPlainObject(ctx) ? ctx : {};
  return {
    history: isArr(c.history) ? c.history : [], // [{ recipeId, cuisine, dateISO, kind }]
    inventory: isPlainObject(c.inventory) ? c.inventory : null, // { coverageByRecipeId, onHandSet, missingByRecipeId }
    nutrition: isPlainObject(c.nutrition) ? c.nutrition : null, // { targets, today, mode }
    seasonalityCtx: isPlainObject(c.seasonalityCtx) ? c.seasonalityCtx : {},
    cuisineCtx: isPlainObject(c.cuisineCtx) ? c.cuisineCtx : {},
    // optional stable seed context (household/day)
    seed: isStr(c.seed) ? c.seed : null,
  };
}

function normalizeRecipe(raw) {
  if (!raw) return null;

  // tolerate minimal strings
  if (isStr(raw)) {
    const name = raw.trim();
    if (!name) return null;
    const id = normKey(name);
    return {
      id,
      name,
      cuisines: [],
      tags: [],
      proteins: [],
      timeMin: null,
      difficulty: 0.5,
      ingredients: [],
      isSoup: false,
      isSandwich: false,
      hasImage: false,
      nutrition: null,
      meta: {},
      _raw: raw,
    };
  }

  if (!isPlainObject(raw)) return null;

  const name = String(raw.name || raw.title || raw.label || "").trim();
  const id = String(raw.id || raw.key || normKey(name) || "").trim();
  if (!id) return null;

  const cuisines = normalizeList(
    raw.cuisines || raw.cuisine || raw.cuisineTags
  );
  const tags = normalizeList(raw.tags);
  const proteins = normalizeList(
    raw.proteins || raw.meats || raw.protein || raw.primaryProtein
  );

  const timeMin = isNum(raw.timeMin)
    ? Math.max(1, Math.floor(Number(raw.timeMin)))
    : isNum(raw.totalTimeMin)
    ? Math.max(1, Math.floor(Number(raw.totalTimeMin)))
    : null;

  const difficulty = isNum(raw.difficulty)
    ? clamp01(Number(raw.difficulty))
    : isNum(raw.skill)
    ? clamp01(Number(raw.skill))
    : 0.5;

  const ingredients = normalizeIngredients(
    raw.ingredients || raw.items || raw.ingredientsList
  );

  const isSoup = !!raw.isSoup || tags.includes("soup");
  const isSandwich = !!raw.isSandwich || tags.includes("sandwich");
  const hasImage =
    !!raw.image || !!raw.imageUrl || !!raw.photo || !!raw.hasImage;

  // nutrition subshape is caller-defined; keep as-is if object
  const nutrition = isPlainObject(raw.nutrition) ? raw.nutrition : null;

  return {
    ...raw,
    id,
    name: name || id,
    cuisines,
    tags,
    proteins,
    timeMin,
    difficulty,
    ingredients,
    isSoup,
    isSandwich,
    hasImage,
    nutrition,
    meta: isPlainObject(raw.meta) ? raw.meta : {},
    _raw: raw,
  };
}

function normalizeIngredients(x) {
  const arr = isArr(x) ? x : x ? [x] : [];
  return arr
    .map((it) => {
      if (isStr(it)) return { name: it.trim() };
      if (isPlainObject(it)) {
        const name = String(it.name || it.item || it.label || "").trim();
        if (!name) return null;
        return { ...it, name };
      }
      return null;
    })
    .filter(Boolean);
}

/* ------------------------------ Hard Constraints ----------------------------- */

function compileHardConstraints(slot, prefs, options) {
  const hard = {
    requireImages: !!options.excludes.requireImages,
    allergens: prefs.allergens,
    avoidCuisines: prefs.avoidCuisines,
    avoidProteins: prefs.avoidProteins,
    blockedProteins: slot.blockedProteins,
    requiredProteins: slot.requiredProteins,
    maxDifficulty: prefs.maxDifficulty,
    allowSoup: slot.allowSoup,
    allowSandwich: slot.allowSandwich,
    dietStyle: prefs.dietStyle,
  };
  return hard;
}

function evaluateHardConstraints(recipe, hard, req) {
  // images
  if (hard.requireImages && !recipe.hasImage) {
    return { ok: false, reason: "missing_image" };
  }

  // allergens
  if (hard.allergens.length) {
    const hit =
      intersects(recipe.tags, hard.allergens) ||
      intersects(
        recipe.ingredients.map((i) => normKey(i.name)),
        hard.allergens
      );
    if (hit) {
      if (req.options.excludes.blockOnAllergenMatch)
        return { ok: false, reason: "allergen" };
    }
  }

  // avoid cuisines
  if (
    hard.avoidCuisines.length &&
    intersects(recipe.cuisines, hard.avoidCuisines)
  ) {
    return { ok: false, reason: "avoid_cuisine" };
  }

  // avoid proteins
  if (
    hard.avoidProteins.length &&
    intersects(recipe.proteins, hard.avoidProteins)
  ) {
    return { ok: false, reason: "avoid_protein" };
  }
  if (
    hard.blockedProteins.length &&
    intersects(recipe.proteins, hard.blockedProteins)
  ) {
    return { ok: false, reason: "blocked_protein" };
  }

  // required protein (slot fixed meat)
  if (hard.requiredProteins.length) {
    const ok = intersects(recipe.proteins, hard.requiredProteins);
    if (!ok) return { ok: false, reason: "missing_required_protein" };
  }

  // soup/sandwich allowances
  if (!hard.allowSoup && recipe.isSoup)
    return { ok: false, reason: "soup_blocked" };
  if (!hard.allowSandwich && recipe.isSandwich)
    return { ok: false, reason: "sandwich_blocked" };

  // max difficulty
  if (hard.maxDifficulty != null && recipe.difficulty > hard.maxDifficulty) {
    return { ok: false, reason: "too_hard" };
  }

  // diet style compatibility (caller may tag recipes like "keto","carnivore","vegetarian")
  if (hard.dietStyle) {
    const compat = dietCompatible(recipe, hard.dietStyle);
    if (!compat) return { ok: false, reason: "diet_incompatible" };
  }

  return { ok: true };
}

function dietCompatible(recipe, dietStyle) {
  const d = normKey(dietStyle);
  if (!d) return true;

  const tags = new Set(recipe.tags.map(normKey));

  // basic rules: if recipe explicitly contradicts, reject
  // These are conservative; caller can pass better metadata.
  if (d === "keto") {
    if (tags.has("high_carb") || tags.has("pasta") || tags.has("bread_heavy"))
      return false;
    return true;
  }
  if (d === "carnivore") {
    // must be meat-centric; allow "eggs" etc.
    if (tags.has("vegetarian") || tags.has("vegan")) return false;
    // heuristic: require protein tag or known meat
    const hasMeat =
      recipe.proteins.length > 0 ||
      tags.has("meat") ||
      tags.has("animal_based");
    return hasMeat;
  }
  if (d === "vegetarian") {
    if (
      recipe.proteins.length &&
      recipe.proteins.some((p) => !["eggs", "dairy"].includes(normKey(p)))
    )
      return false;
    if (
      tags.has("meat") ||
      tags.has("beef") ||
      tags.has("chicken") ||
      tags.has("lamb") ||
      tags.has("goat") ||
      tags.has("pork")
    )
      return false;
    return true;
  }
  if (d === "vegan") {
    if (
      tags.has("meat") ||
      tags.has("dairy") ||
      tags.has("eggs") ||
      tags.has("animal_based")
    )
      return false;
    return true;
  }
  return true;
}

/* --------------------------------- Scoring --------------------------------- */

function scoreRecipe(recipe, req) {
  const { slot, prefs, context, options } = req;

  const breakdown = {};
  const reasons = [];

  // 1) Cuisine weight
  const cuisine = scoreCuisine(recipe, req);
  breakdown.cuisine = cuisine;
  reasons.push(...cuisine.reasons);

  // 2) Seasonality
  const seasonality = scoreSeasonality(recipe, req);
  breakdown.seasonality = seasonality;
  reasons.push(...seasonality.reasons);

  // 3) Rotation / variety
  const rotation = scoreRotation(recipe, req);
  breakdown.rotation = rotation;
  reasons.push(...rotation.reasons);

  // 4) Protein rhythm (fixed meats)
  const rhythm = scoreProteinRhythm(recipe, req);
  breakdown.proteinRhythm = rhythm;
  reasons.push(...rhythm.reasons);

  // 5) Inventory readiness
  const inv = scoreInventory(recipe, req);
  breakdown.inventory = inv;
  reasons.push(...inv.reasons);

  // 6) Nutrition macro alignment
  const nut = scoreNutrition(recipe, req);
  breakdown.nutrition = nut;
  reasons.push(...nut.reasons);

  // 7) Time fit
  const time = scoreTime(recipe, req);
  breakdown.time = time;
  reasons.push(...time.reasons);

  // 8) Difficulty fit
  const diff = scoreDifficulty(recipe, req);
  breakdown.difficulty = diff;
  reasons.push(...diff.reasons);

  // Weighted sum
  const w = options.weights;
  const raw =
    cuisine.value * w.cuisine +
    seasonality.value * w.seasonality +
    rotation.value * w.rotation +
    rhythm.value * w.proteinRhythm +
    inv.value * w.inventory +
    nut.value * w.nutrition +
    time.value * w.time +
    diff.value * w.difficulty;

  // Clamp
  const score = clamp01(raw);

  // Prefer leftovers if slot says so (small boost)
  if (
    slot.preferLeftovers &&
    (recipe.tags.includes("leftovers") ||
      recipe.tags.includes("batch_friendly"))
  ) {
    reasons.push(
      mkReason(
        "boost",
        "leftovers",
        0.04,
        "Slot prefers leftovers / batch-friendly"
      )
    );
  }

  // Keep reasons concise but informative
  const finalReasons = reasons
    .filter(Boolean)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 10);

  return { score, reasons: finalReasons, breakdown };
}

/* --------------------------- Individual Score Terms -------------------------- */

function scoreCuisine(recipe, req) {
  const { context } = req;
  const w = computeCuisineWeightForRecipe(recipe, {
    prefs: req.prefs,
    cuisineCtx: context.cuisineCtx,
    dateISO: req.slot.dateISO,
    seed: context.seed,
  });

  // expected: { weight:0..1, reasons:[...] }
  const value = clamp01(safeNum(w?.weight, 0.5));
  const reasons = (isArr(w?.reasons) ? w.reasons : []).map((r) =>
    mkReason("term", "cuisine", safeNum(r?.delta, 0), r?.note || "Cuisine bias")
  );

  return { value, reasons, raw: w };
}

function scoreSeasonality(recipe, req) {
  const { context, slot } = req;
  const s = computeSeasonalityBiasForRecipe(recipe, {
    dateISO: slot.dateISO,
    seasonalityCtx: context.seasonalityCtx,
    prefs: req.prefs,
  });

  const value = clamp01(safeNum(s?.bias, 0.5));
  const reasons = (isArr(s?.reasons) ? s.reasons : []).map((r) =>
    mkReason(
      "term",
      "seasonality",
      safeNum(r?.delta, 0),
      r?.note || "Seasonality bias"
    )
  );

  return { value, reasons, raw: s };
}

function scoreRotation(recipe, req) {
  const { context, slot, options } = req;
  const hist = isArr(context.history) ? context.history : [];

  // Recipe cooldown penalty
  const recipePenalty = computeCooldownPenalty(hist, {
    key: recipe.id,
    keyField: "recipeId",
    days: options.cooldown.recipeDays,
    maxPenalty: options.cooldown.recipePenaltyMax,
    dateISO: slot.dateISO,
  });

  // Cuisine cooldown penalty
  const cuisineKey = primaryCuisine(recipe);
  const cuisinePenalty = cuisineKey
    ? computeCooldownPenalty(hist, {
        key: cuisineKey,
        keyField: "cuisine",
        days: options.cooldown.cuisineDays,
        maxPenalty: options.cooldown.cuisinePenaltyMax,
        dateISO: slot.dateISO,
      })
    : 0;

  // Prefer new recipes if requested
  const seen = hist.some((h) => normKey(h.recipeId) === normKey(recipe.id));
  let newBonus = 0;
  if (req.prefs.variety.preferNew && !seen) newBonus = 0.18;

  const value = clamp01(0.6 + newBonus - recipePenalty - cuisinePenalty);

  const reasons = [];
  if (recipePenalty > 0)
    reasons.push(
      mkReason(
        "penalty",
        "rotation",
        -recipePenalty,
        "Recently used recipe (cooldown)"
      )
    );
  if (cuisinePenalty > 0)
    reasons.push(
      mkReason(
        "penalty",
        "rotation",
        -cuisinePenalty,
        "Recently used cuisine (cooldown)"
      )
    );
  if (newBonus > 0)
    reasons.push(mkReason("boost", "rotation", newBonus, "Prefer new recipes"));

  return { value, reasons, recipePenalty, cuisinePenalty, newBonus };
}

function scoreProteinRhythm(recipe, req) {
  const { slot } = req;
  const reasons = [];

  // If slot has required protein (fixed meat), we already hard-filtered.
  // Here we *reward* matching exactly and *downrank* ambiguous proteinless recipes.
  const required = slot.requiredProteins;
  const proteins = recipe.proteins.map(normKey);

  let value = 0.55;

  if (required.length) {
    const match = intersects(proteins, required);
    value = match ? 0.95 : 0.05;
    reasons.push(
      mkReason(
        "term",
        "proteinRhythm",
        match ? 0.18 : -0.18,
        match ? "Matches required protein" : "Missing required protein"
      )
    );
  } else {
    // No required protein: reward having a protein that fits prefs, but don't force
    if (proteins.length) {
      value += 0.18;
      reasons.push(
        mkReason("boost", "proteinRhythm", 0.08, "Has defined protein")
      );
    } else {
      value -= 0.12;
      reasons.push(
        mkReason(
          "penalty",
          "proteinRhythm",
          -0.06,
          "No clear protein (may disrupt meat rhythm)"
        )
      );
    }
  }

  // Soup at dinner: often ok; slight boost if allowed and recipe is soup
  if (slot.kind === "dinner" && slot.allowSoup && recipe.isSoup) {
    value += 0.08;
    reasons.push(
      mkReason("boost", "proteinRhythm", 0.03, "Soup dinner friendly")
    );
  }

  // Lunch soup & sandwich: slight boost if lunch and is sandwich or soup
  if (slot.kind === "lunch" && (recipe.isSoup || recipe.isSandwich)) {
    value += 0.06;
    reasons.push(
      mkReason("boost", "proteinRhythm", 0.02, "Lunch soup/sandwich option")
    );
  }

  return { value: clamp01(value), reasons };
}

function scoreInventory(recipe, req) {
  const { context, options } = req;
  const inv = context.inventory;

  // If no inventory context, neutral
  if (!inv)
    return {
      value: 0.5,
      reasons: [mkReason("term", "inventory", 0, "No inventory signals")],
    };

  // Support different shapes:
  // inv.coverageByRecipeId[recipeId] = 0..1
  // inv.missingByRecipeId[recipeId] = ["item1",...]
  // inv.onHandSet = Set or array
  const coverage = safeNum(inv.coverageByRecipeId?.[recipe.id], null);

  let value = 0.5;
  const reasons = [];

  if (coverage != null) {
    if (coverage >= 0.95) {
      value = 0.5 + options.inventory.fullCoverageBonus;
      reasons.push(
        mkReason("boost", "inventory", 0.08, "All/most ingredients on hand")
      );
    } else if (coverage >= 0.7) {
      value = 0.5 + options.inventory.partialCoverageBonus;
      reasons.push(
        mkReason("boost", "inventory", 0.04, "Many ingredients on hand")
      );
    } else {
      const missPenalty = Math.min(
        options.inventory.missingPenaltyMax,
        (0.7 - coverage) * 0.4
      );
      value = 0.5 - missPenalty;
      reasons.push(
        mkReason("penalty", "inventory", -missPenalty, "Low inventory coverage")
      );
    }
    return { value: clamp01(value), reasons, coverage };
  }

  // If no explicit coverage, try a simple heuristic using onHandSet + ingredient names.
  const onHand = normalizeOnHand(inv.onHandSet || inv.onHand || []);
  if (onHand.size && recipe.ingredients.length) {
    let hit = 0;
    let total = 0;
    for (const ing of recipe.ingredients) {
      const k = normKey(ing.name);
      if (!k) continue;
      total += 1;
      if (onHand.has(k)) hit += 1;
    }
    const cov = total ? hit / total : 0;
    const missPenalty =
      cov < 0.7
        ? Math.min(options.inventory.missingPenaltyMax, (0.7 - cov) * 0.35)
        : 0;
    const bonus =
      cov >= 0.95
        ? options.inventory.fullCoverageBonus
        : cov >= 0.7
        ? options.inventory.partialCoverageBonus
        : 0;

    value = clamp01(0.5 + bonus - missPenalty);

    reasons.push(
      mkReason(
        bonus > 0 ? "boost" : missPenalty > 0 ? "penalty" : "term",
        "inventory",
        bonus > 0 ? bonus : missPenalty > 0 ? -missPenalty : 0,
        `Inventory coverage ~${Math.round(cov * 100)}%`
      )
    );

    return { value, reasons, coverage: cov };
  }

  return {
    value: 0.5,
    reasons: [mkReason("term", "inventory", 0, "Inventory unknown")],
  };
}

function scoreNutrition(recipe, req) {
  const { context, options } = req;
  const nut = context.nutrition;
  if (!nut)
    return {
      value: 0.5,
      reasons: [mkReason("term", "nutrition", 0, "No nutrition context")],
    };

  const targets = nut.targets || nut.macroTargets || null;
  const rNut = recipe.nutrition || null;
  if (!targets || !isPlainObject(targets) || !rNut || !isPlainObject(rNut)) {
    return {
      value: 0.5,
      reasons: [
        mkReason(
          "term",
          "nutrition",
          0,
          "Missing nutrition targets/recipe macros"
        ),
      ],
    };
  }

  // Expect macros in grams: protein_g, carbs_g, fat_g (tolerant keys)
  const tP = safeNum(targets.protein_g ?? targets.protein ?? targets.p, null);
  const tC = safeNum(targets.carbs_g ?? targets.carbs ?? targets.c, null);
  const tF = safeNum(targets.fat_g ?? targets.fat ?? targets.f, null);

  const rP = safeNum(rNut.protein_g ?? rNut.protein ?? rNut.p, null);
  const rC = safeNum(rNut.carbs_g ?? rNut.carbs ?? rNut.c, null);
  const rF = safeNum(rNut.fat_g ?? rNut.fat ?? rNut.f, null);

  if ([tP, tC, tF, rP, rC, rF].some((x) => x == null)) {
    return {
      value: 0.5,
      reasons: [mkReason("term", "nutrition", 0, "Incomplete macro data")],
    };
  }

  // Measure alignment by relative difference; smaller is better
  const tol = Math.max(0.05, safeNum(options.nutrition.macroTolerance, 0.15));
  const dp = relDiff(rP, tP);
  const dc = relDiff(rC, tC);
  const df = relDiff(rF, tF);

  const avg = (dp + dc + df) / 3;

  // Convert to score: within tolerance => bonus, otherwise slight penalty
  let value = 0.55;
  const reasons = [];

  if (avg <= tol) {
    const bonus = Math.min(
      options.nutrition.alignBonusMax,
      (tol - avg) * 0.9 + 0.08
    );
    value = clamp01(value + bonus);
    reasons.push(
      mkReason("boost", "nutrition", bonus, "Macros align with targets")
    );
  } else {
    const penalty = Math.min(
      options.nutrition.misalignPenaltyMax,
      (avg - tol) * 0.6
    );
    value = clamp01(value - penalty);
    reasons.push(
      mkReason(
        "penalty",
        "nutrition",
        -penalty,
        "Macros less aligned with targets"
      )
    );
  }

  return { value, reasons, diffs: { dp, dc, df, avg, tol } };
}

function scoreTime(recipe, req) {
  const { slot } = req;
  const reasons = [];

  const target = safeNum(slot.targetTimeMin, 45);
  const max = slot.maxTimeMin != null ? safeNum(slot.maxTimeMin, target) : null;
  const t = recipe.timeMin;

  // Unknown time => neutral
  if (!Number.isFinite(t))
    return {
      value: 0.5,
      reasons: [mkReason("term", "time", 0, "No time estimate")],
    };

  // Hard-ish downrank if exceeds explicit max
  if (max != null && t > max) {
    const over = Math.min(1, (t - max) / Math.max(10, max));
    const value = clamp01(0.45 - over * 0.35);
    reasons.push(
      mkReason("penalty", "time", -0.14, `Exceeds time cap (${t} > ${max} min)`)
    );
    return { value, reasons, timeMin: t, targetMin: target, maxTimeMin: max };
  }

  // Fit curve: closer to target => higher
  const diff = Math.abs(t - target);
  const norm = Math.min(1, diff / Math.max(15, target));
  const value = clamp01(0.85 - norm * 0.55);

  if (t <= target)
    reasons.push(mkReason("boost", "time", 0.04, `Fits time (${t} min)`));
  else reasons.push(mkReason("term", "time", 0, `Longer cook (${t} min)`));

  return { value, reasons, timeMin: t, targetMin: target, maxTimeMin: max };
}

function scoreDifficulty(recipe, req) {
  const { prefs, options } = req;
  const reasons = [];

  const d = clamp01(safeNum(recipe.difficulty, 0.5));
  const pref = clamp01(safeNum(options.difficulty.preference, 0.45));

  // If user prefers easy, reward lower difficulty
  let value = 0.5;
  if (prefs.preferEasy) {
    const delta = pref - d; // positive if easier than preference
    value = clamp01(0.55 + delta * 0.8);
    reasons.push(
      mkReason(
        delta >= 0 ? "boost" : "penalty",
        "difficulty",
        delta >= 0 ? 0.03 : -0.03,
        delta >= 0 ? "Easier recipe" : "Harder recipe"
      )
    );
  } else {
    // Neutral
    value = 0.5;
  }

  return { value, reasons, difficulty: d, preference: pref };
}

/* ---------------------------- Bucket & Shuffle ------------------------------ */

function bucketAndShuffle(scored, req) {
  const delta = req.options.bucketDelta;
  if (!delta || scored.length <= 2) return scored;

  const buckets = [];
  let current = [];
  let anchor = scored[0]?.score ?? 0;

  for (const item of scored) {
    if (Math.abs(item.score - anchor) <= delta) {
      current.push(item);
    } else {
      buckets.push(current);
      current = [item];
      anchor = item.score;
    }
  }
  if (current.length) buckets.push(current);

  // Shuffle each bucket to mimic randomness but remain deterministic by seed
  const seed = computeSeed(req);
  const shuffled = [];
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i];
    if (b.length <= 1) {
      shuffled.push(...b);
      continue;
    }
    const sb = req.options.randomness.stableShuffle
      ? stableShuffle(b, `${seed}|bucket:${i}`)
      : b.slice().sort(() => Math.random() - 0.5);
    shuffled.push(...sb);
  }

  return shuffled;
}

/* -------------------------------- Utilities -------------------------------- */

function slotSummary(slot) {
  return {
    id: slot.id,
    kind: slot.kind,
    dateISO: slot.dateISO,
    requiredProteins: slot.requiredProteins,
    preferLeftovers: slot.preferLeftovers,
  };
}

function computeSeed(req) {
  const s = req.context.seed || "";
  const base = `${req.options.randomness.seedSalt}|${req.slot.dateISO}|${req.slot.kind}|${s}`;
  return base;
}

function stableShuffle(arr, seed) {
  const a = arr.slice();
  // Schwartzian transform using seeded hash
  return a
    .map((x, i) => ({ x, k: hashToUnit(`${seed}|${x.recipe?.id || i}`) }))
    .sort((A, B) => A.k - B.k)
    .map((o) => o.x);
}

function hashToUnit(str) {
  // FNV-1a like
  let h = 2166136261;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // convert to [0,1)
  return ((h >>> 0) % 1_000_000) / 1_000_000;
}

function computeCooldownPenalty(
  history,
  { key, keyField, days, maxPenalty, dateISO }
) {
  const k = normKey(key);
  if (!k) return 0;
  const today = parseISODate(dateISO) || new Date();
  const within = [];

  for (const h of history) {
    const hv = normKey(h?.[keyField]);
    if (!hv || hv !== k) continue;
    const d = parseISODate(h?.dateISO || h?.date);
    if (!d) continue;
    const dd = Math.abs(diffDays(toISODate(today), toISODate(d)));
    if (dd <= days) within.push(dd);
  }

  if (!within.length) return 0;

  // nearest repeat gets biggest penalty
  const nearest = Math.min(...within);
  const factor = 1 - nearest / Math.max(1, days); // 1 near, 0 far
  return Math.min(maxPenalty, factor * maxPenalty);
}

function primaryCuisine(recipe) {
  const c =
    recipe.cuisines && recipe.cuisines.length
      ? normKey(recipe.cuisines[0])
      : "";
  return c || "";
}

function intersects(a, b) {
  const A = new Set((isArr(a) ? a : []).map(normKey).filter(Boolean));
  for (const x of isArr(b) ? b : []) {
    const k = normKey(x);
    if (k && A.has(k)) return true;
  }
  return false;
}

function normalizeOnHand(x) {
  if (!x) return new Set();
  if (x instanceof Set)
    return new Set(Array.from(x).map(normKey).filter(Boolean));
  const arr = isArr(x) ? x : [x];
  return new Set(arr.map(normKey).filter(Boolean));
}

function normalizeList(x) {
  const arr = isArr(x) ? x : x ? [x] : [];
  return arr.map((v) => normKey(v)).filter(Boolean);
}

function normKey(x) {
  return String(x || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function clamp01(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

function safeNum(n, fallback = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

function relDiff(a, b) {
  const aa = Math.max(0.0001, safeNum(a, 0));
  const bb = Math.max(0.0001, safeNum(b, 0));
  return Math.abs(aa - bb) / bb;
}

function mkReason(kind, term, delta, note) {
  return {
    kind,
    term,
    delta: safeNum(delta, 0),
    note: String(note || ""),
  };
}

/**
 * Small deep merge for options only (objects/arrays)
 * - arrays overwrite (not concat) to avoid surprising weights
 */
function deepMergeLite(base, patch) {
  if (!isPlainObject(base)) return isPlainObject(patch) ? { ...patch } : base;
  if (!isPlainObject(patch)) return { ...base };

  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (isArr(v)) out[k] = v.slice();
    else if (isPlainObject(v)) out[k] = deepMergeLite(out[k] || {}, v);
    else out[k] = v;
  }
  return out;
}

/* ------------------------------- Named exports ------------------------------ */

export const __RECIPE_RANKER__ = Object.freeze({
  SOURCE,
  DEFAULTS,
});

/**
 * ✅ Compatibility export expected by mealPlanEngine.js:
 *   import { recipeRanker } from "@/services/mealplanning/recommenders/recipeRanker"
 */
export const recipeRanker = Object.freeze({
  source: SOURCE,
  defaults: DEFAULTS,
  rankRecipes,
  pickTopRecipes,
  explainRecipe,
});
