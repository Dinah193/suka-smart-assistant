// src/reasoner/selectors.js
export function selectCleaningContext(input = {}) {
  // Normalize the cleaning context used by shims/reasoner.
  const i = input || {};
  return {
    domain: "cleaning",
    room: i.room || i.roomType || i.space || "generic",
    soilLevel: i.soilLevel ?? i.soil ?? 2,
    areaSqft: i.areaSqft ?? i.sqft ?? null,
    methodKey: i.methodKey || i.methodId || null,
    intent: i.intent || "cleaning",
    text: i.text || i.prompt || "",
    userId: i.userId || i.user_id || null,
    householdId: i.householdId || i.household_id || null,
    ts: i.ts || new Date().toISOString(),
    raw: i,
  };
}

/**
 * Back-compat export expected by batchCookingShim:
 * - batchCookingShim imports { selectCookingContext } from "@/reasoner/selectors"
 *
 * This selector is deliberately schema-tolerant. It accepts whatever batch/session
 * planners/shims have available (recipes, queue, plan, constraints, etc.) and
 * reduces it to a stable context object for caching + mode selection.
 */
export function selectCookingContext(input = {}) {
  const i = input || {};

  const intent =
    i.intent ||
    i.taskIntent ||
    i.taskType ||
    i.action ||
    i.mode ||
    "batch_cooking";

  const domain = "cooking";

  // Common identifiers that might be present in SSA cooking flows
  const sessionId =
    i.sessionId || i.session_id || i.batchId || i.batch_id || null;

  // Accept a variety of shapes for recipes/queue
  const recipes =
    i.recipes ||
    i.recipeIds ||
    i.recipe_ids ||
    i.queue ||
    i.batchQueue ||
    i.items ||
    null;

  // Lightweight counts for memo keys / heuristics (avoid hashing huge objects)
  let recipeCount = null;
  if (Array.isArray(recipes)) recipeCount = recipes.length;
  else if (recipes && typeof recipes === "object") {
    // if map-like
    try {
      recipeCount = Array.isArray(recipes.items)
        ? recipes.items.length
        : Array.isArray(recipes.recipes)
        ? recipes.recipes.length
        : null;
    } catch {
      recipeCount = null;
    }
  }

  // Meal-plan / calendar anchors if provided
  const planId =
    i.planId || i.plan_id || i.mealPlanId || i.meal_plan_id || null;

  // Optional facility/location hints
  const location =
    i.location || i.kitchen || i.station || i.zone || i.room || "kitchen";

  // Preferences/constraints buckets (keto/carnivore/sabbath aware, etc.)
  const prefs = i.prefs || i.preferences || i.mealPrefs || null;
  const constraints = i.constraints || i.rules || i.diet || null;

  const text = i.text || i.prompt || i.notes || "";

  return {
    domain,
    intent,
    sessionId,
    planId,
    location,
    recipeCount,
    // Provide ids for caching / personalization if available
    userId: i.userId || i.user_id || null,
    householdId: i.householdId || i.household_id || null,
    ts: i.ts || new Date().toISOString(),
    // Keep original references available to downstream code
    recipes,
    prefs,
    constraints,
    text,
    raw: i,
  };
}

/**
 * Back-compat export expected by animalShim:
 * - animalShim imports { selectAnimalContext } from "@/reasoner/selectors"
 *
 * This selector is deliberately schema-tolerant: it accepts whatever the animal
 * planners/shims have available (animalId, herdId, species, taskType, etc.) and
 * reduces it to a stable context object for caching + mode selection.
 */
export function selectAnimalContext(input = {}) {
  const i = input || {};

  // Accept a few common "intent" / task keys
  const intent =
    i.intent ||
    i.taskIntent ||
    i.taskType ||
    i.action ||
    i.mode ||
    "animal_care";

  // If you have a more formal domain naming elsewhere, keep this stable here.
  const domain = "animals";

  // Identify the "target" animal or group if present
  const animalId =
    i.animalId || i.animal_id || i.profileId || i.profile_id || i.id || null;

  const herdId =
    i.herdId ||
    i.herd_id ||
    i.flockId ||
    i.flock_id ||
    i.groupId ||
    i.group_id ||
    null;

  const species =
    i.species || i.animalType || i.type || i.kind || i.livestockType || null;

  const stage =
    i.stage ||
    i.lifeStage ||
    i.ageStage ||
    i.breedingStage ||
    i.productionStage ||
    null;

  // Optional environment/facility references
  const location =
    i.location || i.pen || i.stall || i.pasture || i.barn || i.zone || null;

  // Free text prompt / notes
  const text = i.text || i.prompt || i.notes || "";

  return {
    domain,
    intent,
    animalId,
    herdId,
    species,
    stage,
    location,
    // Provide ids for caching / personalization if available
    userId: i.userId || i.user_id || null,
    householdId: i.householdId || i.household_id || null,
    ts: i.ts || new Date().toISOString(),
    raw: i,
  };
}

/**
 * Back-compat export expected by breedingAndButcheringShim:
 * - breedingAndButcheringShim imports { selectAnimalsContext } from "@/reasoner/selectors"
 *
 * Alias/wrapper around selectAnimalContext that:
 * - Accepts plural naming used by some shims
 * - Preserves any extra breeding/butchering specific fields in `raw`
 */
export function selectAnimalsContext(input = {}) {
  // Keep behavior identical to selectAnimalContext, but tolerate plural naming.
  const i = input || {};
  const ctx = selectAnimalContext(i);

  // If a shim passes an "animals" list, keep a bounded signature for later use.
  const animals =
    i.animals || i.animalIds || i.animal_ids || i.profiles || i.herd || null;

  let animalCount = null;
  if (Array.isArray(animals)) animalCount = animals.length;

  return {
    ...ctx,
    // Optional extras (non-breaking)
    animalIds: Array.isArray(i.animalIds || i.animal_ids)
      ? (i.animalIds || i.animal_ids).slice(0, 50)
      : Array.isArray(animals)
      ? animals
          .map((a) =>
            typeof a === "string"
              ? a
              : a?.id || a?.animalId || a?.animal_id || null
          )
          .filter(Boolean)
          .slice(0, 50)
      : null,
    animalCount,
    // Breeding/butchering hints if present (kept tolerant)
    breeding: i.breeding ?? null,
    butchering: i.butchering ?? null,
    task: i.task ?? i.taskType ?? i.action ?? null,
    raw: i,
  };
}

/**
 * Back-compat export expected by companionPlantingShim:
 * - companionPlantingShim imports { selectGardenContext } from "@/reasoner/selectors"
 *
 * This selector is deliberately schema-tolerant for garden planning contexts
 * (beds, crops, season, zone, date anchors, prompts, etc.).
 */
export function selectGardenContext(input = {}) {
  const i = input || {};

  const intent =
    i.intent ||
    i.taskIntent ||
    i.taskType ||
    i.action ||
    i.mode ||
    "garden_planning";

  const domain = "garden";

  // Common identifiers / anchors
  const planId =
    i.planId || i.plan_id || i.gardenPlanId || i.garden_plan_id || null;

  const date = i.date || i.dayKey || i.day_key || null;

  // Bed/crop references (keep bounded + tolerant)
  const bedIds = Array.isArray(i.bedIds || i.bed_ids)
    ? (i.bedIds || i.bed_ids).slice(0, 50)
    : Array.isArray(i.beds)
    ? i.beds
        .map((b) => (typeof b === "string" ? b : b?.id || b?.bedId || null))
        .filter(Boolean)
        .slice(0, 50)
    : null;

  const cropIds = Array.isArray(i.cropIds || i.crop_ids)
    ? (i.cropIds || i.crop_ids).slice(0, 50)
    : Array.isArray(i.crops)
    ? i.crops
        .map((c) => (typeof c === "string" ? c : c?.id || c?.cropId || null))
        .filter(Boolean)
        .slice(0, 50)
    : null;

  // Zone/season hints
  const zone = i.zone || i.growingZone || i.zoneTag || null;
  const season = i.season || i.seasonTag || i.season_key || null;

  // Planning window if present
  const startISO = i.startISO ?? i.startDateISO ?? i.range?.startISO ?? null;
  const endISO = i.endISO ?? i.endDateISO ?? i.range?.endISO ?? null;

  const text = i.text || i.prompt || i.notes || "";

  return {
    domain,
    intent,
    planId,
    date,
    bedIds,
    cropIds,
    zone,
    season,
    startISO,
    endISO,
    // Provide ids for caching / personalization if available
    userId: i.userId || i.user_id || null,
    householdId: i.householdId || i.household_id || null,
    ts: i.ts || new Date().toISOString(),
    raw: i,
    text,
  };
}

/**
 * Back-compat export expected by cureCalcShim (and other preservation shims):
 * - cureCalcShim imports { selectPreservationContext } from "@/reasoner/selectors"
 *
 * This selector is deliberately schema-tolerant for preservation contexts
 * (curing, smoking, dehydrating, canning, fermenting, etc.).
 */
export function selectPreservationContext(input = {}) {
  const i = input || {};

  const intent =
    i.intent ||
    i.taskIntent ||
    i.taskType ||
    i.action ||
    i.mode ||
    "preservation";

  const domain = "preservation";

  // Method/process hints
  const methodKey =
    i.methodKey ||
    i.methodId ||
    i.method_id ||
    i.process ||
    i.technique ||
    null;

  // What’s being preserved (meat/veg/dairy/etc.)
  const itemType =
    i.itemType || i.foodType || i.category || i.kind || i.productType || null;

  // Common numeric parameters for calculators (salt %, weight, etc.)
  const weight =
    i.weight ??
    i.weightLbs ??
    i.weight_lbs ??
    i.weightKg ??
    i.weight_kg ??
    null;

  const units = i.units || i.unit || null;

  // Planning window / anchor date
  const date = i.date || i.dayKey || i.day_key || null;
  const startISO = i.startISO ?? i.startDateISO ?? i.range?.startISO ?? null;
  const endISO = i.endISO ?? i.endDateISO ?? i.range?.endISO ?? null;

  const location =
    i.location || i.station || i.zone || i.room || i.kitchen || null;

  const text = i.text || i.prompt || i.notes || "";

  return {
    domain,
    intent,
    methodKey,
    itemType,
    weight,
    units,
    date,
    startISO,
    endISO,
    location,
    // Provide ids for caching / personalization if available
    userId: i.userId || i.user_id || null,
    householdId: i.householdId || i.household_id || null,
    ts: i.ts || new Date().toISOString(),
    raw: i,
    text,
  };
}

export default {
  selectCleaningContext,
  selectCookingContext,
  selectAnimalContext,
  selectAnimalsContext,
  selectGardenContext,
  selectPreservationContext,
};
