// src/services/recipes/battleRhythmResolver.js
// Applies user battle rhythm transforms to normalized recipe candidates.

import { findSubstitutions } from "../../agents/skills/cooking/substitutions.js";

function asArray(v) {
  return Array.isArray(v) ? v : v ? [v] : [];
}

function toNum(v, fallback = NaN) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function safeLower(v) {
  return String(v || "").toLowerCase();
}

function deepClone(v) {
  return JSON.parse(JSON.stringify(v));
}

function deepMerge(a, b) {
  if (!a || typeof a !== "object") return deepClone(b || {});
  if (!b || typeof b !== "object") return deepClone(a || {});
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = deepMerge(out[k] && typeof out[k] === "object" ? out[k] : {}, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function normalizeRule(rule) {
  if (!rule || typeof rule !== "object") return null;
  const match = String(rule.match || rule.from || "").trim();
  const replaceWith = String(rule.replaceWith || rule.to || "").trim();
  if (!match || !replaceWith) return null;

  return {
    match: safeLower(match),
    replaceWith,
    ratio: Number.isFinite(toNum(rule.ratio)) ? toNum(rule.ratio) : 1,
    priority: Number.isFinite(toNum(rule.priority)) ? toNum(rule.priority) : 0,
  };
}

function normalizeIngredientTokens(list = []) {
  return new Set(
    asArray(list)
      .map((x) => safeLower(String(x || "").trim()))
      .filter(Boolean)
  );
}

function detectProfileWarningsAndConflicts(ingredients, rhythmProfile) {
  const warnings = [];
  const conflicts = [];

  const avoid = normalizeIngredientTokens(rhythmProfile?.ingredientRules?.avoid);
  const boost = normalizeIngredientTokens(rhythmProfile?.ingredientRules?.boost);

  for (const token of avoid) {
    if (boost.has(token)) {
      conflicts.push({
        type: "ingredient_rule_conflict",
        ingredient: token,
        reason: "Ingredient appears in both avoid and boost lists.",
      });
    }
  }

  for (const ing of asArray(ingredients)) {
    const name = safeLower(extractIngredientName(ing));
    if (!name) continue;
    for (const token of avoid) {
      if (name.includes(token)) {
        warnings.push({
          type: "ingredient_avoid_match",
          ingredient: name,
          rule: token,
          reason: "Ingredient matches battle rhythm avoid list.",
        });
      }
    }
  }

  return { warnings, conflicts };
}

function extractIngredientName(ing) {
  if (!ing || typeof ing !== "object") return "";
  return String(ing.label || ing.name || ing.id || "").trim();
}

function setIngredientName(ing, nextName) {
  if (!ing || typeof ing !== "object" || !nextName) return;
  if (typeof ing.label === "string" && ing.label.trim()) {
    ing.label = nextName;
  }
  if (typeof ing.name === "string" && ing.name.trim()) {
    ing.name = nextName;
  }
  if ((!ing.label || !String(ing.label).trim()) && (!ing.name || !String(ing.name).trim())) {
    ing.label = nextName;
  }
}

function scaleIngredientAmount(ing, factor) {
  const ratio = Number.isFinite(toNum(factor)) ? toNum(factor) : 1;
  if (!ing || typeof ing !== "object" || ratio === 1) return false;

  let changed = false;

  if (ing.amount && typeof ing.amount === "object") {
    const v = toNum(ing.amount.value);
    if (Number.isFinite(v)) {
      ing.amount.value = Number((v * ratio).toFixed(4));
      changed = true;
    }
  }

  const qty = toNum(ing.qty);
  if (Number.isFinite(qty)) {
    ing.qty = Number((qty * ratio).toFixed(4));
    changed = true;
  }

  const quantity = toNum(ing.quantity);
  if (Number.isFinite(quantity)) {
    ing.quantity = Number((quantity * ratio).toFixed(4));
    changed = true;
  }

  return changed;
}

function applySubstitutionTransforms(ingredients, battleRhythm) {
  const rules = asArray(battleRhythm?.substitutions)
    .map(normalizeRule)
    .filter(Boolean)
    .sort((a, b) => b.priority - a.priority);

  if (!rules.length) return { ingredients, applied: [] };

  const nextIngredients = asArray(ingredients).map((ing) => deepClone(ing));
  const applied = [];

  for (const ing of nextIngredients) {
    const name = extractIngredientName(ing);
    if (!name) continue;

    const lower = safeLower(name);
    const matched = rules.find((r) => lower.includes(r.match));
    if (!matched) continue;

    const before = name;
    setIngredientName(ing, matched.replaceWith);
    scaleIngredientAmount(ing, matched.ratio);

    applied.push({
      type: "substitution",
      from: before,
      to: matched.replaceWith,
      ratio: matched.ratio,
      rule: matched.match,
    });
  }

  return { ingredients: nextIngredients, applied };
}

async function applyCanonicalSubstitutionTransforms(ingredients, battleRhythm, context) {
  const nextIngredients = asArray(ingredients).map((ing) => deepClone(ing));
  const applied = [];

  if (!nextIngredients.length) return { ingredients: nextIngredients, applied };

  const useCanonicalSubstitutions = context?.useCanonicalSubstitutions !== false;
  if (!useCanonicalSubstitutions) return { ingredients: nextIngredients, applied };

  const torahSafe = context?.torahSafe !== false;

  for (const ing of nextIngredients) {
    const currentName = extractIngredientName(ing);
    if (!currentName) continue;

    const suggestions = await findSubstitutions(
      currentName,
      {
        torahSafe,
        measureBias: "weight",
      },
      {
        useReasoner: false,
        minLocalCount: 1,
        minLocalConfidence: 0.2,
      }
    );

    if (!Array.isArray(suggestions) || !suggestions.length) continue;
    const first = suggestions[0];
    const substituteName = String(first?.substitute?.name || "").trim();
    if (!substituteName) continue;

    const before = currentName;
    if (safeLower(before) === safeLower(substituteName)) continue;

    setIngredientName(ing, substituteName);
    const ratio = typeof first?.ratio === "number" ? first.ratio : 1;
    scaleIngredientAmount(ing, ratio);

    applied.push({
      type: "substitution",
      from: before,
      to: substituteName,
      ratio,
      reason: "canonical-substitutions",
      confidence: Number.isFinite(toNum(first?.confidence))
        ? toNum(first?.confidence)
        : null,
    });
  }

  return { ingredients: nextIngredients, applied };
}

function applySeasoningTransforms(ingredients, battleRhythm) {
  const saltFactor = clamp(toNum(battleRhythm?.seasoning?.saltFactor, 1), 0.1, 3);
  const sugarFactor = clamp(toNum(battleRhythm?.seasoning?.sugarFactor, 1), 0.1, 3);

  const nextIngredients = asArray(ingredients).map((ing) => deepClone(ing));
  const applied = [];

  for (const ing of nextIngredients) {
    const name = safeLower(extractIngredientName(ing));
    if (!name) continue;

    if (name.includes("salt") && saltFactor !== 1) {
      if (scaleIngredientAmount(ing, saltFactor)) {
        applied.push({ type: "seasoning", target: "salt", factor: saltFactor });
      }
      continue;
    }

    if (name.includes("sugar") && sugarFactor !== 1) {
      if (scaleIngredientAmount(ing, sugarFactor)) {
        applied.push({ type: "seasoning", target: "sugar", factor: sugarFactor });
      }
    }
  }

  return { ingredients: nextIngredients, applied };
}

function withTechniqueSeasoningAdjustments(battleRhythm) {
  const next = deepClone(battleRhythm || {});
  const techniques = next?.techniques || {};
  const seasoning = next?.seasoning && typeof next.seasoning === "object"
    ? next.seasoning
    : {};

  if (techniques.lowSodium) {
    seasoning.saltFactor = Math.min(toNum(seasoning.saltFactor, 1), 0.7);
  }

  if (techniques.lessSugar) {
    seasoning.sugarFactor = Math.min(toNum(seasoning.sugarFactor, 1), 0.75);
  }

  next.seasoning = seasoning;
  return next;
}

function isWeekend(dayKey) {
  if (!dayKey) return false;
  const d = new Date(`${dayKey}T12:00:00`);
  if (Number.isNaN(d.getTime())) return false;
  const dow = d.getDay();
  return dow === 0 || dow === 6;
}

function scaleTimeValue(obj, key, factor) {
  if (!obj || typeof obj !== "object") return false;
  const value = toNum(obj[key]);
  if (!Number.isFinite(value)) return false;
  obj[key] = Math.max(1, Math.round(value * factor));
  return true;
}

function applyTimingTransforms(recipe, context, battleRhythm) {
  const weeknightFactor = clamp(
    toNum(battleRhythm?.timing?.weeknightTimeFactor, 0.9),
    0.2,
    2
  );
  const weekendFactor = clamp(
    toNum(battleRhythm?.timing?.weekendTimeFactor, 1),
    0.2,
    2
  );
  const quickNightMaxMins = Math.max(10, toNum(battleRhythm?.timing?.quickNightMaxMins, 45));

  const dayKey = context?.dayKey || null;
  const weekend = isWeekend(dayKey);
  const factor = weekend ? weekendFactor : weeknightFactor;

  const out = deepClone(recipe);
  const applied = [];

  if (out.time && typeof out.time === "object") {
    const touched =
      scaleTimeValue(out.time, "totalMins", factor) ||
      scaleTimeValue(out.time, "total", factor) ||
      false;

    scaleTimeValue(out.time, "activeMins", factor);
    scaleTimeValue(out.time, "handsOffMins", factor);

    if (touched) {
      const k = Number.isFinite(toNum(out.time.totalMins)) ? "totalMins" : "total";
      const cur = toNum(out.time[k]);
      if (!weekend && Number.isFinite(cur) && cur > quickNightMaxMins) {
        out.time[k] = quickNightMaxMins;
      }
      applied.push({
        type: "timing",
        factor,
        weekend,
        quickNightMaxMins: weekend ? null : quickNightMaxMins,
      });
    }
  }

  if (scaleTimeValue(out, "totalTimeMin", factor)) {
    if (!weekend && out.totalTimeMin > quickNightMaxMins) {
      out.totalTimeMin = quickNightMaxMins;
    }
    applied.push({
      type: "timing",
      field: "totalTimeMin",
      factor,
      weekend,
      quickNightMaxMins: weekend ? null : quickNightMaxMins,
    });
  }

  return { recipe: out, applied };
}

function ingredientSnapshot(ing) {
  if (!ing || typeof ing !== "object") return null;
  return {
    id: ing.id || null,
    name: extractIngredientName(ing) || null,
    qty: Number.isFinite(toNum(ing.qty)) ? toNum(ing.qty) : null,
    quantity: Number.isFinite(toNum(ing.quantity)) ? toNum(ing.quantity) : null,
    amountValue:
      ing.amount && Number.isFinite(toNum(ing.amount.value))
        ? toNum(ing.amount.value)
        : null,
    amountUnit: ing.amount?.unit || null,
    unit: ing.unit || null,
  };
}

function recipeTimeSnapshot(recipe) {
  if (!recipe || typeof recipe !== "object") return null;
  const t = recipe.time && typeof recipe.time === "object" ? recipe.time : null;
  return {
    totalMins: Number.isFinite(toNum(t?.totalMins)) ? toNum(t.totalMins) : null,
    activeMins: Number.isFinite(toNum(t?.activeMins)) ? toNum(t.activeMins) : null,
    handsOffMins: Number.isFinite(toNum(t?.handsOffMins)) ? toNum(t.handsOffMins) : null,
    total: Number.isFinite(toNum(t?.total)) ? toNum(t.total) : null,
    totalTimeMin: Number.isFinite(toNum(recipe.totalTimeMin))
      ? toNum(recipe.totalTimeMin)
      : null,
  };
}

function countByType(trace = [], type) {
  return asArray(trace).filter((x) => x?.type === type).length;
}

export function buildBattleRhythmPreview(recipe, options = {}) {
  const original = recipe && typeof recipe === "object" ? deepClone(recipe) : null;
  if (!original) return null;

  const variant = applyBattleRhythmToRecipe(original, options);
  const trace = asArray(variant?.battleRhythm?.trace);

  return {
    recipeId: String(variant?.id || original?.id || ""),
    title: String(variant?.title || variant?.name || original?.title || original?.name || "Untitled Recipe"),
    source: variant?.source || original?.source || "unknown",
    original: {
      ingredients: asArray(original?.ingredients).map(ingredientSnapshot).filter(Boolean),
      time: recipeTimeSnapshot(original),
    },
    variant: {
      ingredients: asArray(variant?.ingredients).map(ingredientSnapshot).filter(Boolean),
      time: recipeTimeSnapshot(variant),
      tags: asArray(variant?.tags),
    },
    summary: {
      totalChanges: trace.length,
      substitutions: countByType(trace, "substitution"),
      seasoningAdjustments: countByType(trace, "seasoning"),
      timingAdjustments: countByType(trace, "timing"),
      applied: Boolean(variant?.battleRhythm?.applied),
    },
    trace,
  };
}

export function buildBattleRhythmPreviewList(recipePool = [], options = {}) {
  const items = asArray(recipePool)
    .map((recipe) => buildBattleRhythmPreview(recipe, options))
    .filter(Boolean);

  return {
    items,
    count: items.length,
    enabled: Boolean(options?.battleRhythm?.enabled),
  };
}

export function applyBattleRhythmToRecipe(recipe, options = {}) {
  const battleRhythm = options?.battleRhythm || {};
  if (!battleRhythm?.enabled) return recipe;
  if (!recipe || typeof recipe !== "object") return recipe;

  const tunedRhythm = withTechniqueSeasoningAdjustments(battleRhythm);
  const base = deepClone(recipe);
  const traces = [];
  const { warnings, conflicts } = detectProfileWarningsAndConflicts(
    base.ingredients,
    tunedRhythm
  );

  const sub = applySubstitutionTransforms(base.ingredients, tunedRhythm);
  base.ingredients = sub.ingredients;
  if (sub.applied.length) traces.push(...sub.applied);

  const seasoning = applySeasoningTransforms(base.ingredients, tunedRhythm);
  base.ingredients = seasoning.ingredients;
  if (seasoning.applied.length) traces.push(...seasoning.applied);

  const timed = applyTimingTransforms(base, options, tunedRhythm);
  const resolved = timed.recipe;
  if (timed.applied.length) traces.push(...timed.applied);

  const existingTags = Array.isArray(resolved.tags) ? resolved.tags : [];
  resolved.tags = Array.from(new Set([...existingTags, "battle-rhythm-applied"]));

  resolved.battleRhythm = {
    applied: traces.length > 0,
    trace: traces,
    warnings,
    conflicts,
    provenance: {
      sources: ["profile-substitutions", "seasoning", "timing"],
      context: {
        dayKey: options?.dayKey || null,
        mealType: options?.mealType || null,
      },
    },
  };

  return resolved;
}

export async function applyBattleRhythm(recipe, rhythm = {}, overrides = {}, context = {}) {
  if (!recipe || typeof recipe !== "object") {
    return {
      recipe,
      appliedSubstitutions: [],
      warnings: [],
      conflicts: [],
      provenance: { sources: [], context: { ...(context || {}) } },
      trace: [],
    };
  }

  if (!rhythm?.enabled) {
    return {
      recipe,
      appliedSubstitutions: [],
      warnings: [],
      conflicts: [],
      provenance: { sources: ["disabled"], context: { ...(context || {}) } },
      trace: [],
    };
  }

  const mergedRhythm = withTechniqueSeasoningAdjustments(
    deepMerge(rhythm || {}, overrides || {})
  );
  const base = deepClone(recipe);
  const trace = [];
  const provenanceSources = [];

  const signalCheck = detectProfileWarningsAndConflicts(base.ingredients, mergedRhythm);
  const warnings = [...signalCheck.warnings];
  const conflicts = [...signalCheck.conflicts];

  const profileSub = applySubstitutionTransforms(base.ingredients, mergedRhythm);
  base.ingredients = profileSub.ingredients;
  if (profileSub.applied.length) {
    provenanceSources.push("profile-substitutions");
    trace.push(
      ...profileSub.applied.map((x) => ({ ...x, reason: x.reason || "profile-rule" }))
    );
  }

  const canonicalSub = await applyCanonicalSubstitutionTransforms(
    base.ingredients,
    mergedRhythm,
    context
  );
  base.ingredients = canonicalSub.ingredients;
  if (canonicalSub.applied.length) {
    provenanceSources.push("canonical-substitutions");
    trace.push(...canonicalSub.applied);
  }

  const seasoning = applySeasoningTransforms(base.ingredients, mergedRhythm);
  base.ingredients = seasoning.ingredients;
  if (seasoning.applied.length) {
    provenanceSources.push("seasoning");
    trace.push(...seasoning.applied);
  }

  const timed = applyTimingTransforms(base, context, mergedRhythm);
  const resolved = timed.recipe;
  if (timed.applied.length) {
    provenanceSources.push("timing");
    trace.push(...timed.applied);
  }

  const existingTags = Array.isArray(resolved.tags) ? resolved.tags : [];
  resolved.tags = Array.from(new Set([...existingTags, "battle-rhythm-applied"]));

  const provenance = {
    sources: Array.from(new Set(provenanceSources)),
    context: {
      dayKey: context?.dayKey || null,
      dayType: context?.dayType || null,
      mealType: context?.mealType || null,
      season: context?.season || null,
      macroPatternId: context?.macroPattern?.id || null,
      inventoryProvided: Boolean(context?.inventory),
      recipeId: recipe?.id || null,
      fingerprint: context?.fingerprint || recipe?.fingerprint || recipe?.meta?.fingerprint || null,
    },
    overridesApplied: Boolean(overrides && Object.keys(overrides).length),
  };

  resolved.battleRhythm = {
    applied: trace.length > 0,
    trace,
    warnings,
    conflicts,
    provenance,
  };

  return {
    recipe: resolved,
    appliedSubstitutions: trace.filter((x) => x?.type === "substitution"),
    warnings,
    conflicts,
    provenance,
    trace,
  };
}

export async function resolveRecipePoolWithBattleRhythm(recipePool = [], options = {}) {
  const battleRhythm = options?.battleRhythm || {};
  if (!battleRhythm?.enabled) {
    return {
      recipes: asArray(recipePool),
      meta: { enabled: false, total: asArray(recipePool).length, transformed: 0 },
    };
  }

  const overridesByRecipeId =
    options?.overridesByRecipeId && typeof options.overridesByRecipeId === "object"
      ? options.overridesByRecipeId
      : {};
  const overridesByFingerprint =
    options?.overridesByFingerprint && typeof options.overridesByFingerprint === "object"
      ? options.overridesByFingerprint
      : {};

  const recipes = [];
  const warnings = [];
  const conflicts = [];
  const provenanceTrail = [];

  for (const recipe of asArray(recipePool)) {
    const rid = String(recipe?.id || "");
    const fingerprint = String(
      recipe?.fingerprint || recipe?.meta?.fingerprint || ""
    );
    const override =
      (rid && overridesByRecipeId[rid]) ||
      (fingerprint && overridesByFingerprint[fingerprint]) ||
      null;

    const applied = await applyBattleRhythm(recipe, battleRhythm, override || {}, {
      ...options,
      fingerprint: fingerprint || null,
      recipeId: rid || null,
      dayKey: options?.dayKey || null,
      mealType: options?.mealType || null,
    });

    recipes.push(applied.recipe);
    if (Array.isArray(applied.warnings) && applied.warnings.length) {
      warnings.push(...applied.warnings.map((w) => ({ ...w, recipeId: rid || null })));
    }
    if (Array.isArray(applied.conflicts) && applied.conflicts.length) {
      conflicts.push(...applied.conflicts.map((c) => ({ ...c, recipeId: rid || null })));
    }
    if (applied.provenance) {
      provenanceTrail.push(applied.provenance);
    }
  }

  const transformed = recipes.filter((r) => r?.battleRhythm?.applied).length;

  return {
    recipes,
    meta: {
      enabled: true,
      total: recipes.length,
      transformed,
      substitutionsConfigured: asArray(battleRhythm?.substitutions).length,
      warningCount: warnings.length,
      conflictCount: conflicts.length,
      warnings,
      conflicts,
      provenanceTrail,
    },
  };
}

export default {
  applyBattleRhythm,
  applyBattleRhythmToRecipe,
  resolveRecipePoolWithBattleRhythm,
  buildBattleRhythmPreview,
  buildBattleRhythmPreviewList,
};
