// C:\Users\larho\suka-smart-assistant\src\services\farmToTable\PreferenceResolver.js
/* eslint-disable no-console */
/**
 * SSA • Farm-to-Table / Homestead PreferenceResolver
 * -----------------------------------------------------------------------------
 * Deterministic resolver that merges:
 *  - household preferences (global defaults)
 *  - optional person/user preferences (overrides)
 *  - cuisine profile defaults (rotation-driven)
 *  - ad-hoc session overrides (one-off)
 *
 * Produces:
 *  - resolved preferences (final merged object)
 *  - constraints (hard excludes)
 *  - scoring signals (soft preferences)
 *  - explainability trace (why a decision was made)
 *
 * This supports the Homestead Planner pages:
 *  - cuisines.jsx (cuisine selection + rotation)
 *  - preferences.jsx (taste cards, constraints)
 *  - targets.jsx, garden-targets.jsx, animal-targets.jsx (derived decisions)
 *  - batches.jsx (suggest methods + workload matching)
 *
 * Public API:
 *  - resolvePreferences(input) -> { resolved, constraints, scoring, trace }
 *  - scoreItem(item, resolvedPack) -> { score, reasons, excluded, excludeReasons }
 *  - pickTop(items, resolvedPack, opts) -> { picked, ranked, excluded }
 *  - explain(resolvedPack) -> string[] summaries
 *
 * Notes
 *  - No AI: deterministic and stable. (Optional AI can be added later behind feature flags.)
 *  - Browser safe: no Node imports.
 */

const SOURCE = "services/farmToTable/PreferenceResolver";

const DEFAULTS = {
  weights: {
    // taste cards
    heat: 1.2,
    sweet: 0.7,
    sour: 0.7,
    salt: 0.9,
    smoke: 0.6,
    aromatics: 0.6,

    // operational
    time: 1.0, // prefer low time if household says time scarce
    budget: 0.9,
    simplicity: 0.8, // fewer steps/tools/ingredients
    freshness: 0.4, // preference for fresh vs preserved (if specified)
    preservation: 0.6, // preference for preservation methods alignment

    // tags
    likedTag: 0.9,
    dislikedTag: 1.2,
  },

  // If a taste axis is missing, use 0.
  tasteAxes: ["heat", "sweet", "sour", "salt", "smoke", "aromatics"],

  // How to interpret taste preference values:
  //  -1..+1 typical; can be -2..+2 for strong preferences
  tasteClamp: { min: -2, max: 2 },

  // Hard constraints keys we support
  hardConstraintKeys: [
    "allergens",
    "dislikes",
    "excludedIngredients",
    "diet",
    "forbiddenTags",
  ],

  // Known dietary patterns (can be expanded)
  diets: {
    vegan: {
      forbiddenTags: ["meat", "fish", "dairy", "eggs", "animal_product"],
    },
    vegetarian: { forbiddenTags: ["meat", "fish"] },
    pescatarian: { forbiddenTags: ["meat"] },
    dairy_free: { forbiddenTags: ["dairy"] },
    gluten_free: { forbiddenTags: ["gluten"] },
  },
};

/* -----------------------------------------------------------------------------
 * Public API
 * --------------------------------------------------------------------------- */

export const PreferenceResolver = {
  resolvePreferences,
  scoreItem,
  pickTop,
  explain,
};

/**
 * Resolve preferences from multiple layers.
 *
 * input:
 *  {
 *    household: { ... },
 *    user: { ... }, // optional per-person overrides
 *    cuisine: { ... }, // cuisine defaults/rotation profile
 *    overrides: { ... }, // ad-hoc (session) overrides
 *    context: { ... } // optional context: season, feastDay, timeBudget, etc.
 *  }
 */
export function resolvePreferences(input = {}) {
  const household = input.household || {};
  const user = input.user || {};
  const cuisine = input.cuisine || {};
  const overrides = input.overrides || {};
  const context = input.context || {};

  const trace = [];

  // 1) Merge base -> household -> cuisine -> user -> overrides
  const merged = deepMerge({}, normalizePrefsBase(trace));
  deepMergeInto(merged, normalizePrefs(household, "household", trace));
  deepMergeInto(merged, normalizePrefs(cuisine, "cuisine", trace));
  deepMergeInto(merged, normalizePrefs(user, "user", trace));
  deepMergeInto(merged, normalizePrefs(overrides, "overrides", trace));

  // 2) Expand diet presets into forbiddenTags (hard constraint)
  const constraints = buildConstraints(merged, context, trace);

  // 3) Build scoring signals from merged (soft)
  const scoring = buildScoring(merged, context, trace);

  const resolvedPack = {
    resolved: merged,
    constraints,
    scoring,
    trace,
    source: SOURCE,
    computedAt: new Date().toISOString(),
  };

  return resolvedPack;
}

/**
 * Score an item (catalog component/method/recipe-like object) against resolved preferences.
 *
 * item format can be flexible:
 *  {
 *    id, name, tags: string[],
 *    allergens: string[] (optional),
 *    ingredients: string[] (optional),
 *    taste: { heat, sweet, ... } (optional),
 *    costLevel: 0..2 (optional), // 0=low,1=mid,2=high
 *    timeMinutes: number (optional),
 *    stepsCount: number (optional),
 *    tools: string[] (optional),
 *    preservationMethods: string[] (optional),
 *  }
 */
export function scoreItem(item, resolvedPack) {
  const pack = resolvedPack || resolvePreferences({});
  const prefs = pack.resolved || {};
  const constraints = pack.constraints || {};
  const scoring = pack.scoring || {};

  const excludeReasons = [];
  const reasons = [];
  const tags = normalizeStringArray(item?.tags).map(toLower);

  // 1) Hard excludes
  if (isExcludedByConstraints(item, constraints, excludeReasons)) {
    return { score: -Infinity, reasons: [], excluded: true, excludeReasons };
  }

  // 2) Soft scoring
  let score = 0;

  // 2a) Taste match
  const tasteScore = scoreTaste(
    item?.taste,
    scoring.tasteTarget,
    scoring.weights,
    reasons
  );
  score += tasteScore;

  // 2b) Time match
  score += scoreTime(item?.timeMinutes, scoring, reasons);

  // 2c) Budget match
  score += scoreBudget(item?.costLevel, scoring, reasons);

  // 2d) Simplicity (steps/tools/ingredients)
  score += scoreSimplicity(item, scoring, reasons);

  // 2e) Tag affinity
  score += scoreTagAffinity(tags, scoring, reasons);

  // 2f) Preservation method affinity
  score += scorePreservationAffinity(
    item?.preservationMethods,
    scoring,
    reasons
  );

  // Clamp score to a reasonable range (for UI)
  score = clamp(score, -50, 50);

  return { score, reasons, excluded: false, excludeReasons: [] };
}

/**
 * Pick top items from a list using scoreItem.
 */
export function pickTop(items = [], resolvedPack, opts = {}) {
  const limit = Number.isFinite(opts.limit) ? opts.limit : 10;

  const ranked = [];
  const excluded = [];

  for (const it of items || []) {
    const s = scoreItem(it, resolvedPack);
    if (s.excluded) excluded.push({ item: it, ...s });
    else ranked.push({ item: it, ...s });
  }

  ranked.sort((a, b) => b.score - a.score);

  return {
    picked: ranked.slice(0, limit),
    ranked,
    excluded,
  };
}

/**
 * Turn a resolved pack into human-friendly bullet explanations.
 */
export function explain(resolvedPack) {
  const pack = resolvedPack || resolvePreferences({});
  const prefs = pack.resolved || {};
  const constraints = pack.constraints || {};
  const scoring = pack.scoring || {};

  const out = [];

  if (prefs.cuisine?.activeCuisineIds?.length) {
    out.push(`Cuisine rotation: ${prefs.cuisine.activeCuisineIds.join(", ")}`);
  }
  if (prefs.taste?.cards) {
    const cards = prefs.taste.cards;
    const parts = DEFAULTS.tasteAxes
      .map((k) => {
        const v = cards[k];
        if (v == null) return null;
        return `${k}:${Number(v).toFixed(1)}`;
      })
      .filter(Boolean);
    if (parts.length) out.push(`Taste cards: ${parts.join(" • ")}`);
  }
  if (constraints.allergens?.length)
    out.push(`Allergen excludes: ${constraints.allergens.join(", ")}`);
  if (constraints.dislikes?.length)
    out.push(`Dislikes excludes: ${constraints.dislikes.join(", ")}`);
  if (constraints.forbiddenTags?.length)
    out.push(`Forbidden tags: ${constraints.forbiddenTags.join(", ")}`);

  if (scoring.timePreference)
    out.push(`Time preference: ${scoring.timePreference}`);
  if (scoring.budgetPreference)
    out.push(`Budget preference: ${scoring.budgetPreference}`);

  if (scoring.likedTags?.length)
    out.push(`Prefer tags: ${scoring.likedTags.join(", ")}`);
  if (scoring.dislikedTags?.length)
    out.push(`Avoid tags: ${scoring.dislikedTags.join(", ")}`);

  return out;
}

/* -----------------------------------------------------------------------------
 * Normalization
 * --------------------------------------------------------------------------- */

function normalizePrefsBase(trace) {
  trace?.push({
    layer: "base",
    message: "Applied base defaults.",
    at: new Date().toISOString(),
  });

  return {
    taste: {
      cards: {
        heat: 0,
        sweet: 0,
        sour: 0,
        salt: 0,
        smoke: 0,
        aromatics: 0,
      },
    },

    constraints: {
      allergens: [],
      dislikes: [],
      excludedIngredients: [],
      forbiddenTags: [],
      diet: null,
    },

    operations: {
      // time / budget preferences can be:
      // "low" | "medium" | "high" (preference for low time/cost, etc.)
      timePreference: "medium",
      budgetPreference: "medium",
      simplicityPreference: "medium",
      freshnessPreference: "mixed", // "fresh" | "preserved" | "mixed"
    },

    tags: {
      liked: [],
      disliked: [],
    },

    cuisine: {
      activeCuisineIds: [],
      rotationMode: "manual", // manual | weekly | monthly | feast_overrides
      weights: {
        // optional additional weights for cuisine-aligned tags/methods
        preferMethods: [],
        preferTags: [],
      },
    },
  };
}

function normalizePrefs(raw, layerName, trace) {
  const p = raw && typeof raw === "object" ? raw : {};
  trace?.push({
    layer: layerName,
    message: "Merged preference layer.",
    keys: Object.keys(p || {}),
    at: new Date().toISOString(),
  });

  // Return a shallow-structured object that can deepMerge cleanly.
  // We do not enforce full schema here; we normalize in buildConstraints/buildScoring.
  return p;
}

/* -----------------------------------------------------------------------------
 * Constraints + scoring signals
 * --------------------------------------------------------------------------- */

function buildConstraints(prefs, context, trace) {
  const c = prefs?.constraints || {};
  const out = {
    allergens: uniqLower(normalizeStringArray(c.allergens)),
    dislikes: uniqLower(normalizeStringArray(c.dislikes)),
    excludedIngredients: uniqLower(normalizeStringArray(c.excludedIngredients)),
    forbiddenTags: uniqLower(normalizeStringArray(c.forbiddenTags)),
    diet: c.diet ? String(c.diet).trim() : null,
  };

  // Diet expansion
  if (out.diet) {
    const key = toLower(out.diet);
    const preset = DEFAULTS.diets[key];
    if (preset?.forbiddenTags?.length) {
      const before = out.forbiddenTags.slice();
      out.forbiddenTags = uniqLower(
        out.forbiddenTags.concat(preset.forbiddenTags)
      );
      trace?.push({
        layer: "constraints",
        message: `Expanded diet "${out.diet}" into forbiddenTags.`,
        before,
        after: out.forbiddenTags,
      });
    } else {
      trace?.push({
        layer: "constraints",
        message: `Diet "${out.diet}" has no preset expansion (ok).`,
      });
    }
  }

  // Context-based hard rules (optional)
  // Example: feast-day overrides could add/remove tags
  if (context?.forbiddenTags?.length) {
    const before = out.forbiddenTags.slice();
    out.forbiddenTags = uniqLower(
      out.forbiddenTags.concat(context.forbiddenTags)
    );
    trace?.push({
      layer: "constraints",
      message: "Applied context.forbiddenTags.",
      before,
      after: out.forbiddenTags,
    });
  }

  // Sanity trim
  out.allergens = out.allergens.filter(Boolean);
  out.dislikes = out.dislikes.filter(Boolean);
  out.excludedIngredients = out.excludedIngredients.filter(Boolean);
  out.forbiddenTags = out.forbiddenTags.filter(Boolean);

  return out;
}

function buildScoring(prefs, context, trace) {
  const ops = prefs?.operations || {};
  const tags = prefs?.tags || {};
  const cuisine = prefs?.cuisine || {};
  const tasteCards = prefs?.taste?.cards || {};

  // Taste target vector
  const tasteTarget = {};
  for (const axis of DEFAULTS.tasteAxes) {
    tasteTarget[axis] = clampNum(
      tasteCards[axis] ?? 0,
      DEFAULTS.tasteClamp.min,
      DEFAULTS.tasteClamp.max
    );
  }

  // Operations preferences normalized
  const timePreference = normalizeTriLevel(ops.timePreference, "medium");
  const budgetPreference = normalizeTriLevel(ops.budgetPreference, "medium");
  const simplicityPreference = normalizeTriLevel(
    ops.simplicityPreference,
    "medium"
  );
  const freshnessPreference = normalizeFreshness(
    ops.freshnessPreference,
    "mixed"
  );

  // Tag affinity
  const likedTags = uniqLower(normalizeStringArray(tags.liked));
  const dislikedTags = uniqLower(normalizeStringArray(tags.disliked));

  // Cuisine influences (soft)
  const cuisinePreferTags = uniqLower(
    normalizeStringArray(cuisine?.weights?.preferTags)
  );
  const cuisinePreferMethods = uniqLower(
    normalizeStringArray(cuisine?.weights?.preferMethods)
  );
  const activeCuisineIds = normalizeStringArray(cuisine.activeCuisineIds);

  // Context could add extra weights
  const extraLikedTags = uniqLower(normalizeStringArray(context?.likedTags));
  const extraPreferMethods = uniqLower(
    normalizeStringArray(context?.preferMethods)
  );

  const finalLikedTags = uniqLower(
    likedTags.concat(cuisinePreferTags, extraLikedTags)
  );
  const finalPreferMethods = uniqLower(
    cuisinePreferMethods.concat(extraPreferMethods)
  );

  const scoring = {
    tasteTarget,
    timePreference,
    budgetPreference,
    simplicityPreference,
    freshnessPreference,

    likedTags: finalLikedTags,
    dislikedTags,

    preferMethods: finalPreferMethods,

    // Weights
    weights: { ...DEFAULTS.weights, ...(prefs?.weights || {}) },

    // Derived: a numeric pressure for time/budget
    timePressure: triPressure(timePreference), // -1..+1 (positive = prefers quick)
    budgetPressure: triPressure(budgetPreference), // positive = prefers cheap
    simplicityPressure: triPressure(simplicityPreference),
    activeCuisineIds,

    context: context || {},
  };

  trace?.push({
    layer: "scoring",
    message: "Built scoring signals.",
    timePreference,
    budgetPreference,
    simplicityPreference,
    freshnessPreference,
    likedTags: finalLikedTags,
    dislikedTags,
    preferMethods: finalPreferMethods,
  });

  return scoring;
}

/* -----------------------------------------------------------------------------
 * Hard constraint matching
 * --------------------------------------------------------------------------- */

function isExcludedByConstraints(item, constraints, excludeReasons) {
  const c = constraints || {};
  const tags = normalizeStringArray(item?.tags).map(toLower);

  // Allergens: if item lists allergens OR tags imply them
  const itemAllergens = uniqLower(normalizeStringArray(item?.allergens));
  const itemIngredients = uniqLower(normalizeStringArray(item?.ingredients));
  const itemName = toLower(item?.name || "");

  for (const a of c.allergens || []) {
    if (!a) continue;
    const hit =
      itemAllergens.includes(a) ||
      tags.includes(a) ||
      itemIngredients.includes(a) ||
      itemName.includes(a);
    if (hit) excludeReasons.push(`Allergen excluded: ${a}`);
  }

  // Dislikes/excluded ingredients (hard)
  for (const d of c.dislikes || []) {
    if (!d) continue;
    const hit =
      tags.includes(d) || itemIngredients.includes(d) || itemName.includes(d);
    if (hit) excludeReasons.push(`Disliked: ${d}`);
  }

  for (const ex of c.excludedIngredients || []) {
    if (!ex) continue;
    const hit =
      tags.includes(ex) ||
      itemIngredients.includes(ex) ||
      itemName.includes(ex);
    if (hit) excludeReasons.push(`Excluded ingredient: ${ex}`);
  }

  // Forbidden tags (hard)
  for (const ft of c.forbiddenTags || []) {
    if (!ft) continue;
    if (tags.includes(ft)) excludeReasons.push(`Forbidden tag: ${ft}`);
  }

  return excludeReasons.length > 0;
}

/* -----------------------------------------------------------------------------
 * Scoring helpers
 * --------------------------------------------------------------------------- */

function scoreTaste(itemTaste, tasteTarget, weights, reasons) {
  if (!tasteTarget) return 0;
  const t = itemTaste && typeof itemTaste === "object" ? itemTaste : null;
  if (!t) return 0;

  let s = 0;
  for (const axis of DEFAULTS.tasteAxes) {
    const target = tasteTarget[axis] ?? 0;
    const actual = clampNum(
      t[axis] ?? 0,
      DEFAULTS.tasteClamp.min,
      DEFAULTS.tasteClamp.max
    );

    // Similarity: 1 - normalized distance (0..1), then centered -> (-1..+1)
    const dist = Math.abs(target - actual);
    const sim = 1 - dist / (DEFAULTS.tasteClamp.max - DEFAULTS.tasteClamp.min); // 0..1
    const centered = (sim - 0.5) * 2; // -1..+1

    const w = Number(weights?.[axis] ?? 0);
    if (w) s += centered * w;

    if (w && dist > 1.2) {
      reasons?.push(
        `Taste mismatch on ${axis} (wanted ~${target}, got ~${actual})`
      );
    } else if (w && dist <= 0.5 && Math.abs(target) > 0.6) {
      reasons?.push(`Taste match on ${axis}`);
    }
  }
  return s;
}

function scoreTime(timeMinutes, scoring, reasons) {
  const m = Number(timeMinutes);
  if (!Number.isFinite(m)) return 0;

  // Interpret:
  //  low timePreference => prefers quick => higher score for low minutes
  //  high timePreference => okay with long => smaller penalty
  const pressure = scoring.timePressure ?? 0; // positive = wants quick
  if (pressure === 0) return 0;

  // Map minutes into 0..1 (0=0min, 1=180min+)
  const norm = clamp(m / 180, 0, 1);
  // If wants quick, penalize higher norm. If okay with long, less penalty.
  const delta = (0.5 - norm) * 2; // +1 for quick, -1 for long

  const w = Number(scoring.weights?.time ?? 1);
  const s = delta * w * pressure;

  if (pressure > 0.2 && m > 90)
    reasons?.push("Time cost is high for current time preference");
  if (pressure > 0.2 && m <= 45)
    reasons?.push("Quick for current time preference");
  return s;
}

function scoreBudget(costLevel, scoring, reasons) {
  const c = Number(costLevel);
  if (!Number.isFinite(c)) return 0;

  // costLevel: 0 low, 1 mid, 2 high
  const pressure = scoring.budgetPressure ?? 0; // positive wants cheap
  if (pressure === 0) return 0;

  const norm = clamp(c / 2, 0, 1); // 0..1
  const delta = (0.5 - norm) * 2; // +1 cheaper, -1 expensive

  const w = Number(scoring.weights?.budget ?? 1);
  const s = delta * w * pressure;

  if (pressure > 0.2 && c >= 2)
    reasons?.push("Cost is high for current budget preference");
  if (pressure > 0.2 && c <= 0)
    reasons?.push("Low-cost for current budget preference");
  return s;
}

function scoreSimplicity(item, scoring, reasons) {
  const pressure = scoring.simplicityPressure ?? 0; // positive wants simple
  if (pressure === 0) return 0;

  const steps = Number(item?.stepsCount);
  const toolsCount = normalizeStringArray(item?.tools).length;
  const ingredientsCount = normalizeStringArray(item?.ingredients).length;

  // If unknown, skip
  const hasAny =
    Number.isFinite(steps) ||
    Number.isFinite(toolsCount) ||
    Number.isFinite(ingredientsCount);
  if (!hasAny) return 0;

  // Normalize each to 0..1 scale
  const stepsN = Number.isFinite(steps) ? clamp(steps / 12, 0, 1) : 0.5;
  const toolsN = clamp(toolsCount / 10, 0, 1);
  const ingrN = clamp(ingredientsCount / 18, 0, 1);

  // Higher norm means more complex; prefer low norms when pressure positive
  const complexity = stepsN * 0.5 + toolsN * 0.25 + ingrN * 0.25; // 0..1
  const delta = (0.5 - complexity) * 2; // +1 simpler, -1 complex

  const w = Number(scoring.weights?.simplicity ?? 1);
  const s = delta * w * pressure;

  if (pressure > 0.2 && complexity > 0.65)
    reasons?.push("Complexity is high for simplicity preference");
  if (pressure > 0.2 && complexity < 0.35)
    reasons?.push("Simple for current preference");
  return s;
}

function scoreTagAffinity(tagsLower, scoring, reasons) {
  const liked = scoring.likedTags || [];
  const disliked = scoring.dislikedTags || [];
  const wLike = Number(scoring.weights?.likedTag ?? 1);
  const wDis = Number(scoring.weights?.dislikedTag ?? 1);

  let s = 0;

  for (const t of liked) {
    if (tagsLower.includes(t)) {
      s += wLike;
      reasons?.push(`Matches preferred tag: ${t}`);
    }
  }
  for (const t of disliked) {
    if (tagsLower.includes(t)) {
      s -= wDis;
      reasons?.push(`Has avoided tag: ${t}`);
    }
  }
  return s;
}

function scorePreservationAffinity(methodIds, scoring, reasons) {
  const prefer = scoring.preferMethods || [];
  if (!prefer.length) return 0;

  const mids = normalizeStringArray(methodIds).map(toLower);
  if (!mids.length) return 0;

  let s = 0;
  const w = Number(scoring.weights?.preservation ?? 0.6);

  for (const pm of prefer) {
    if (mids.includes(pm)) {
      s += w;
      reasons?.push(`Uses preferred preservation method: ${pm}`);
    }
  }
  return s;
}

/* -----------------------------------------------------------------------------
 * Utility / merge helpers
 * --------------------------------------------------------------------------- */

function deepMerge(target, source) {
  const out = target && typeof target === "object" ? target : {};
  deepMergeInto(out, source);
  return out;
}

function deepMergeInto(target, source) {
  if (!source || typeof source !== "object") return target;
  for (const k of Object.keys(source)) {
    const sv = source[k];
    const tv = target[k];

    if (Array.isArray(sv)) {
      // Arrays: concat then dedupe for known list fields (tags, constraints)
      if (!Array.isArray(tv)) target[k] = sv.slice();
      else target[k] = tv.concat(sv);
      continue;
    }

    if (sv && typeof sv === "object") {
      if (!tv || typeof tv !== "object" || Array.isArray(tv)) target[k] = {};
      deepMergeInto(target[k], sv);
      continue;
    }

    target[k] = sv;
  }
  return target;
}

function normalizeTriLevel(v, fallback) {
  const s = toLower(v || "");
  if (s === "low" || s === "l") return "low";
  if (s === "high" || s === "h") return "high";
  if (s === "medium" || s === "med" || s === "m") return "medium";
  return fallback;
}

function normalizeFreshness(v, fallback) {
  const s = toLower(v || "");
  if (s === "fresh") return "fresh";
  if (s === "preserved") return "preserved";
  if (s === "mixed") return "mixed";
  return fallback;
}

/**
 * Convert tri-level preference into pressure:
 *  low   => +1 (wants low time/cost/simplicity complexity)
 *  medium=>  0
 *  high  => -0.25 (more tolerant of higher time/cost/complexity)
 */
function triPressure(level) {
  if (level === "low") return 1;
  if (level === "high") return -0.25;
  return 0;
}

function clamp(n, min, max) {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function clampNum(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(min, Math.min(max, x));
}

function toLower(s) {
  return (typeof s === "string" ? s : s == null ? "" : String(s))
    .trim()
    .toLowerCase();
}

function normalizeStringArray(raw) {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map((x) => (x == null ? "" : String(x)).trim()).filter(Boolean);
}

function uniqLower(arr) {
  const out = [];
  const seen = new Set();
  for (const a of arr || []) {
    const k = toLower(a);
    if (!k) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}
