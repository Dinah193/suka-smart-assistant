// src/reasoner/cache/keys.js
function stableStringify(obj) {
  try {
    return JSON.stringify(obj, Object.keys(obj || {}).sort());
  } catch {
    return String(obj);
  }
}

export function buildCleaningMemoKey(ctx = {}) {
  // A deterministic key: same inputs => same key
  const shape = {
    domain: ctx.domain || "cleaning",
    room: ctx.room || "generic",
    soilLevel: ctx.soilLevel ?? 2,
    areaSqft: ctx.areaSqft ?? null,
    methodKey: ctx.methodKey ?? null,
    intent: ctx.intent || "cleaning",
    text: (ctx.text || "").slice(0, 200), // bound key size
  };
  return `cleaning:${stableStringify(shape)}`;
}

/**
 * Deterministic memo key for cooking/batch-cooking shims.
 * Expected by batchCookingShim:
 *   import { buildCookingMemoKey } from "@/reasoner/cache/keys";
 *
 * Keep tolerant and compact (bounded arrays + bounded text).
 */
export function buildCookingMemoKey(ctx = {}) {
  const shape = {
    domain: ctx.domain || "cooking",
    intent: ctx.intent || "batch_cooking",

    householdId: ctx.householdId ?? ctx.household?.id ?? null,
    userId: ctx.userId ?? null,

    // Session / batch identifiers
    sessionId:
      ctx.sessionId ?? ctx.session_id ?? ctx.batchId ?? ctx.batch_id ?? null,
    planId:
      ctx.planId ?? ctx.plan_id ?? ctx.mealPlanId ?? ctx.meal_plan_id ?? null,

    // Location / station hint
    location:
      ctx.location ?? ctx.kitchen ?? ctx.station ?? ctx.zone ?? "kitchen",

    // Recipe signatures (bounded)
    recipeIds: Array.isArray(ctx.recipeIds)
      ? ctx.recipeIds.slice(0, 50)
      : Array.isArray(ctx.recipes)
      ? ctx.recipes
          .map((r) =>
            typeof r === "string"
              ? r
              : r?.id || r?.recipeId || r?.recipe_id || null
          )
          .filter(Boolean)
          .slice(0, 50)
      : null,

    recipeCount:
      typeof ctx.recipeCount === "number"
        ? ctx.recipeCount
        : Array.isArray(ctx.recipes)
        ? ctx.recipes.length
        : null,

    // Preferences / constraints fingerprints (don’t include huge objects)
    dietStyle: ctx.dietStyle ?? ctx.diet ?? null,
    prefsVersion: ctx.prefsVersion ?? ctx.mealPrefsVersion ?? null,

    // Prompt slice
    text: (ctx.text || ctx.prompt || "").slice(0, 200),

    // Optional mode knobs
    mode: ctx.mode ?? null,
    model: ctx.model ?? null,
  };

  return `cooking:${stableStringify(shape)}`;
}

export function mealPlanningShimKey(ctx = {}) {
  // Deterministic memo key for the meal planning agent shim (same inputs => same key)
  const shape = {
    domain: ctx.domain || "mealplanning",
    intent: ctx.intent || "meal_planning",
    // Keep these generic so the shim can pass whatever it has without breaking the key builder
    householdId: ctx.householdId ?? ctx.household?.id ?? null,
    groupId: ctx.groupId ?? null,
    // Planning window / target dates
    startISO: ctx.startISO ?? ctx.startDateISO ?? ctx.range?.startISO ?? null,
    endISO: ctx.endISO ?? ctx.endDateISO ?? ctx.range?.endISO ?? null,
    // Preferences / constraints fingerprints (keep compact + deterministic)
    prefsVersion: ctx.prefsVersion ?? ctx.mealPrefsVersion ?? null,
    dietStyle: ctx.dietStyle ?? ctx.diet ?? null,
    caloriesTarget: ctx.caloriesTarget ?? null,
    macros: ctx.macros ?? null,
    // If the shim sends a payload object, include a bounded slice for stability
    text: (ctx.text || ctx.prompt || "").slice(0, 200),
    // If specific recipes/meals are being forced into rotation, include a stable signature
    recipeIds: Array.isArray(ctx.recipeIds) ? ctx.recipeIds.slice(0, 50) : null,
    // Optional mode knobs
    mode: ctx.mode ?? null,
    model: ctx.model ?? null,
  };

  return `mealplanning:${stableStringify(shape)}`;
}

/**
 * Deterministic memo key for the meal bundle shim (mealBundleShim).
 * Expected by mealBundleShim:
 *   import { mealBundleShimKey } from "@/reasoner/cache/keys";
 *
 * Keep tolerant and compact (bounded arrays + bounded text).
 */
export function mealBundleShimKey(ctx = {}) {
  const shape = {
    domain: ctx.domain || "mealbundle",
    intent: ctx.intent || "meal_bundle",

    householdId: ctx.householdId ?? ctx.household?.id ?? null,
    groupId: ctx.groupId ?? null,
    userId: ctx.userId ?? null,

    // Bundle identifiers (optional)
    bundleId: ctx.bundleId ?? ctx.bundle_id ?? ctx.id ?? null,
    planId:
      ctx.planId ?? ctx.plan_id ?? ctx.mealPlanId ?? ctx.meal_plan_id ?? null,
    sessionId:
      ctx.sessionId ?? ctx.session_id ?? ctx.batchId ?? ctx.batch_id ?? null,

    // Planning window / target dates
    startISO: ctx.startISO ?? ctx.startDateISO ?? ctx.range?.startISO ?? null,
    endISO: ctx.endISO ?? ctx.endDateISO ?? ctx.range?.endISO ?? null,
    date: ctx.date ?? ctx.dayKey ?? ctx.dayISO ?? null,

    // Recipe signatures (bounded)
    recipeIds: Array.isArray(ctx.recipeIds)
      ? ctx.recipeIds.slice(0, 75)
      : Array.isArray(ctx.recipes)
      ? ctx.recipes
          .map((r) =>
            typeof r === "string"
              ? r
              : r?.id || r?.recipeId || r?.recipe_id || null
          )
          .filter(Boolean)
          .slice(0, 75)
      : null,

    recipeCount:
      typeof ctx.recipeCount === "number"
        ? ctx.recipeCount
        : Array.isArray(ctx.recipeIds)
        ? ctx.recipeIds.length
        : Array.isArray(ctx.recipes)
        ? ctx.recipes.length
        : null,

    // Preferences / constraints fingerprints
    prefsVersion: ctx.prefsVersion ?? ctx.mealPrefsVersion ?? null,
    dietStyle: ctx.dietStyle ?? ctx.diet ?? null,

    // Optional scope hints
    location: ctx.location ?? ctx.kitchen ?? ctx.station ?? ctx.zone ?? null,

    // Prompt slice
    text: (ctx.text || ctx.prompt || "").slice(0, 200),

    // Optional mode knobs
    mode: ctx.mode ?? null,
    model: ctx.model ?? null,
  };

  return `mealbundle:${stableStringify(shape)}`;
}

/**
 * Deterministic memo key for the garden planning shim (same inputs => same key)
 * NOTE: Keep this tolerant—garden contexts evolve and may come from selectors.
 */
export function gardenShimKey(ctx = {}) {
  const shape = {
    domain: ctx.domain || "garden",
    intent: ctx.intent || "garden_planning",
    householdId: ctx.householdId ?? ctx.household?.id ?? null,
    groupId: ctx.groupId ?? null,

    // Planning window (if provided)
    startISO: ctx.startISO ?? ctx.startDateISO ?? ctx.range?.startISO ?? null,
    endISO: ctx.endISO ?? ctx.endDateISO ?? ctx.range?.endISO ?? null,

    // Date anchor / dayKey commonly used by garden selectors
    date: ctx.date ?? ctx.dayKey ?? null,

    // Light fingerprints to keep the key stable but not huge
    season: ctx.season ?? ctx.seasonTag ?? null,
    zone: ctx.zone ?? ctx.growingZone ?? null,

    // If crops/beds/tasks are provided, include bounded signatures
    cropIds: Array.isArray(ctx.cropIds) ? ctx.cropIds.slice(0, 50) : null,
    bedIds: Array.isArray(ctx.bedIds) ? ctx.bedIds.slice(0, 50) : null,
    taskIds: Array.isArray(ctx.taskIds) ? ctx.taskIds.slice(0, 50) : null,

    // If the shim sends a prompt-like payload, include a bounded slice
    text: (ctx.text || ctx.prompt || "").slice(0, 200),

    mode: ctx.mode ?? null,
    model: ctx.model ?? null,
  };

  return `garden:${stableStringify(shape)}`;
}

/**
 * Back-compat export expected by companionPlantingShim:
 *   import { buildGardenMemoKey } from "@/reasoner/cache/keys";
 *
 * Alias for gardenShimKey (same ctx shape).
 */
export function buildGardenMemoKey(ctx = {}) {
  return gardenShimKey(ctx);
}

/**
 * Deterministic memo key for preservation shims (curing/smoking/canning/etc.).
 * Expected by cureCalcShim:
 *   import { buildPreservationMemoKey } from "@/reasoner/cache/keys";
 *
 * Keep tolerant and compact (bounded arrays + bounded text).
 */
export function preservationShimKey(ctx = {}) {
  const shape = {
    domain: ctx.domain || "preservation",
    intent: ctx.intent || "preservation",

    householdId: ctx.householdId ?? ctx.household?.id ?? null,
    userId: ctx.userId ?? null,

    // Method/process hints
    methodKey:
      ctx.methodKey ??
      ctx.methodId ??
      ctx.method_id ??
      ctx.process ??
      ctx.technique ??
      null,

    // What’s being preserved
    itemType:
      ctx.itemType ??
      ctx.foodType ??
      ctx.category ??
      ctx.kind ??
      ctx.productType ??
      null,

    // Common numeric parameters for calculators
    weight:
      ctx.weight ??
      ctx.weightLbs ??
      ctx.weight_lbs ??
      ctx.weightKg ??
      ctx.weight_kg ??
      null,

    units: ctx.units ?? ctx.unit ?? null,

    // Planning window / anchor date
    date: ctx.date ?? ctx.dayKey ?? null,
    startISO: ctx.startISO ?? ctx.startDateISO ?? ctx.range?.startISO ?? null,
    endISO: ctx.endISO ?? ctx.endDateISO ?? ctx.range?.endISO ?? null,

    // Optional facility/location hints
    location:
      ctx.location ??
      ctx.station ??
      ctx.zone ??
      ctx.room ??
      ctx.kitchen ??
      null,

    // Prompt slice
    text: (ctx.text || ctx.prompt || "").slice(0, 200),

    // Optional mode knobs
    mode: ctx.mode ?? null,
    model: ctx.model ?? null,
  };

  return `preservation:${stableStringify(shape)}`;
}

/**
 * Back-compat export expected by cureCalcShim:
 *   import { buildPreservationMemoKey } from "@/reasoner/cache/keys";
 *
 * Alias for preservationShimKey (same ctx shape).
 */
export function buildPreservationMemoKey(ctx = {}) {
  return preservationShimKey(ctx);
}

/**
 * Deterministic memo key for feed optimization shims.
 * Expected by feedOptimizerShim:
 *   import { buildAnimalsFeedMemoKey } from "@/reasoner/cache/keys";
 *
 * Keep tolerant and compact.
 */
export function buildAnimalsFeedMemoKey(ctx = {}) {
  const shape = {
    domain: ctx.domain || "animals",
    intent: ctx.intent || "feed_optimization",

    householdId: ctx.householdId ?? ctx.household?.id ?? null,
    userId: ctx.userId ?? null,

    // Target references (singular or group)
    animalId: ctx.animalId ?? ctx.animal_id ?? ctx.profileId ?? ctx.id ?? null,
    herdId: ctx.herdId ?? ctx.herd_id ?? ctx.flockId ?? ctx.groupId ?? null,

    // Multi-animal signature (bounded)
    animalIds: Array.isArray(ctx.animalIds)
      ? ctx.animalIds.slice(0, 50)
      : Array.isArray(ctx.animals)
      ? ctx.animals
          .map((a) =>
            typeof a === "string"
              ? a
              : a?.id || a?.animalId || a?.animal_id || null
          )
          .filter(Boolean)
          .slice(0, 50)
      : null,

    animalCount:
      typeof ctx.animalCount === "number"
        ? ctx.animalCount
        : Array.isArray(ctx.animalIds)
        ? ctx.animalIds.length
        : Array.isArray(ctx.animals)
        ? ctx.animals.length
        : null,

    // Nutrition/feed context (light fingerprints)
    species: ctx.species ?? ctx.animalType ?? ctx.type ?? null,
    stage: ctx.stage ?? ctx.lifeStage ?? ctx.ageStage ?? null,

    dietStyle: ctx.dietStyle ?? ctx.diet ?? null,
    feedType: ctx.feedType ?? ctx.rationType ?? ctx.ration ?? null,

    // Planning window / anchor date
    date: ctx.date ?? ctx.dayKey ?? null,
    startISO: ctx.startISO ?? ctx.startDateISO ?? ctx.range?.startISO ?? null,
    endISO: ctx.endISO ?? ctx.endDateISO ?? ctx.range?.endISO ?? null,

    // Prompt slice
    text: (ctx.text || ctx.prompt || "").slice(0, 200),

    // Optional mode knobs
    mode: ctx.mode ?? null,
    model: ctx.model ?? null,
  };

  return `animals_feed:${stableStringify(shape)}`;
}

/**
 * Deterministic memo key for the animal care / animal planner shim.
 * Expected by animalShim:
 *   import { buildAnimalMemoKey } from "@/reasoner/cache/keys";
 *
 * Keep tolerant and compact (bounded arrays + bounded text).
 */
export function buildAnimalMemoKey(ctx = {}) {
  const shape = {
    domain: ctx.domain || "animals",
    intent: ctx.intent || "animal_care",

    householdId: ctx.householdId ?? ctx.household?.id ?? null,
    userId: ctx.userId ?? null,

    // Target references
    animalId: ctx.animalId ?? ctx.animal_id ?? ctx.profileId ?? ctx.id ?? null,
    herdId: ctx.herdId ?? ctx.herd_id ?? ctx.flockId ?? ctx.groupId ?? null,

    // Common animal fields
    species: ctx.species ?? ctx.animalType ?? ctx.type ?? null,
    stage: ctx.stage ?? ctx.lifeStage ?? ctx.ageStage ?? null,
    location: ctx.location ?? ctx.pen ?? ctx.stall ?? ctx.pasture ?? null,

    // If multiple animals are involved
    animalIds: Array.isArray(ctx.animalIds) ? ctx.animalIds.slice(0, 50) : null,

    // Date anchor / planning window (if any)
    date: ctx.date ?? ctx.dayKey ?? null,
    startISO: ctx.startISO ?? ctx.startDateISO ?? ctx.range?.startISO ?? null,
    endISO: ctx.endISO ?? ctx.endDateISO ?? ctx.range?.endISO ?? null,

    // Prompt slice
    text: (ctx.text || ctx.prompt || "").slice(0, 200),

    // Optional mode knobs
    mode: ctx.mode ?? null,
    model: ctx.model ?? null,
  };

  return `animals:${stableStringify(shape)}`;
}

/**
 * Back-compat export expected by breedingAndButcheringShim:
 *   import { buildAnimalsMemoKey } from "@/reasoner/cache/keys";
 *
 * This is a plural alias to the singular builder. It accepts the same ctx shape.
 */
export function buildAnimalsMemoKey(ctx = {}) {
  return buildAnimalMemoKey(ctx);
}

/**
 * Deterministic memo key for inventory shims.
 * Expected by inventoryShim:
 *   import { inventoryShimKey } from "@/reasoner/cache/keys";
 *
 * Keep tolerant and compact (bounded arrays + bounded text).
 */
export function inventoryShimKey(ctx = {}) {
  const shape = {
    domain: ctx.domain || "inventory",
    intent: ctx.intent || "inventory",

    householdId: ctx.householdId ?? ctx.household?.id ?? null,
    groupId: ctx.groupId ?? null,
    userId: ctx.userId ?? null,

    // Inventory scope hints
    location: ctx.location ?? ctx.storageLocation ?? ctx.zone ?? null,
    category: ctx.category ?? ctx.group ?? ctx.type ?? null,

    // Bounded signatures for referenced items
    itemIds: Array.isArray(ctx.itemIds)
      ? ctx.itemIds.slice(0, 50)
      : Array.isArray(ctx.items)
      ? ctx.items
          .map((it) =>
            typeof it === "string"
              ? it
              : it?.id || it?._id || it?.key || it?.uuid || null
          )
          .filter(Boolean)
          .slice(0, 50)
      : null,

    // Query / filters
    query: ctx.query ?? ctx.q ?? null,
    tags: Array.isArray(ctx.tags) ? ctx.tags.slice(0, 20) : null,

    // Planning window / anchor date (if any)
    date: ctx.date ?? ctx.dayKey ?? null,
    startISO: ctx.startISO ?? ctx.startDateISO ?? ctx.range?.startISO ?? null,
    endISO: ctx.endISO ?? ctx.endDateISO ?? ctx.range?.endISO ?? null,

    // Prompt slice
    text: (ctx.text || ctx.prompt || "").slice(0, 200),

    // Optional mode knobs
    mode: ctx.mode ?? null,
    model: ctx.model ?? null,
  };

  return `inventory:${stableStringify(shape)}`;
}

/**
 * Optional alias some callers may prefer.
 */
export function buildInventoryMemoKey(ctx = {}) {
  return inventoryShimKey(ctx);
}

/**
 * buildCacheKey(ctx)
 * -----------------------------------------------------------------------------
 * Compatibility export expected by some shims:
 *   import { buildCacheKey } from "@/reasoner/cache/keys";
 *
 * It routes to the most appropriate deterministic key builder based on ctx.domain/ctx.intent.
 */
export function buildCacheKey(ctx = {}) {
  const d = String(ctx.domain || "").toLowerCase();
  const i = String(ctx.intent || "").toLowerCase();
  const hint = `${d} ${i}`.trim();

  if (hint.includes("clean")) return buildCleaningMemoKey(ctx);
  if (hint.includes("bundle")) return mealBundleShimKey(ctx);
  if (hint.includes("cook") || hint.includes("batch"))
    return buildCookingMemoKey(ctx);
  if (hint.includes("meal")) return mealPlanningShimKey(ctx);
  if (hint.includes("inventory") || hint.includes("storehouse"))
    return inventoryShimKey(ctx);
  if (
    hint.includes("garden") ||
    hint.includes("plant") ||
    hint.includes("harvest")
  )
    return gardenShimKey(ctx);
  if (
    hint.includes("preserv") ||
    hint.includes("cure") ||
    hint.includes("smoke") ||
    hint.includes("can") ||
    hint.includes("dehydrat") ||
    hint.includes("ferment")
  ) {
    return preservationShimKey(ctx);
  }
  if (
    hint.includes("animal") ||
    hint.includes("livestock") ||
    hint.includes("herd")
  )
    return buildAnimalMemoKey(ctx);

  // Generic fallback (bounded + deterministic)
  const shape = {
    domain: ctx.domain || "generic",
    intent: ctx.intent || null,
    householdId: ctx.householdId ?? ctx.household?.id ?? null,
    userId: ctx.userId ?? null,
    groupId: ctx.groupId ?? null,
    startISO: ctx.startISO ?? ctx.startDateISO ?? ctx.range?.startISO ?? null,
    endISO: ctx.endISO ?? ctx.endDateISO ?? ctx.range?.endISO ?? null,
    date: ctx.date ?? ctx.dayKey ?? null,
    text: (ctx.text || ctx.prompt || "").slice(0, 200),
    mode: ctx.mode ?? null,
    model: ctx.model ?? null,
  };

  return `generic:${stableStringify(shape)}`;
}

export default {
  buildCleaningMemoKey,
  buildCookingMemoKey,
  mealPlanningShimKey,
  mealBundleShimKey,
  inventoryShimKey,
  buildInventoryMemoKey,
  gardenShimKey,
  buildGardenMemoKey,
  preservationShimKey,
  buildPreservationMemoKey,
  buildAnimalsFeedMemoKey,
  buildAnimalMemoKey,
  buildAnimalsMemoKey,
  buildCacheKey,
};
