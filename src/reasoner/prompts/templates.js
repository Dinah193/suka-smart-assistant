// src/reasoner/prompts/templates.js

export function buildCleaningPrompt(ctx = {}) {
  // Deterministic “prompt” string used for transparency / optional AI later.
  const lines = [];
  lines.push(`domain: cleaning`);
  lines.push(`room: ${ctx.room || "generic"}`);
  lines.push(`soilLevel: ${ctx.soilLevel ?? 2}`);
  if (ctx.areaSqft != null) lines.push(`areaSqft: ${ctx.areaSqft}`);
  if (ctx.methodKey) lines.push(`methodKey: ${ctx.methodKey}`);
  if (ctx.intent) lines.push(`intent: ${ctx.intent}`);
  if (ctx.text) lines.push(`text: ${ctx.text}`);
  return lines.join("\n");
}

/**
 * Deterministic “prompt” string for the cooking domain.
 * Expected by batchCookingShim:
 *   import { buildCookingPrompt } from "@/reasoner/prompts/templates";
 */
export function buildCookingPrompt(ctx = {}) {
  const lines = [];
  lines.push(`domain: cooking`);
  if (ctx.intent) lines.push(`intent: ${ctx.intent}`);
  if (ctx.householdId) lines.push(`householdId: ${ctx.householdId}`);
  if (ctx.userId) lines.push(`userId: ${ctx.userId}`);

  // Session / batch identifiers
  if (ctx.sessionId || ctx.batchId)
    lines.push(`sessionId: ${ctx.sessionId ?? ctx.batchId}`);
  if (ctx.planId || ctx.mealPlanId)
    lines.push(`planId: ${ctx.planId ?? ctx.mealPlanId}`);

  // Recipe signatures (bounded)
  const recipeIds = Array.isArray(ctx.recipeIds)
    ? ctx.recipeIds
    : Array.isArray(ctx.recipes)
    ? ctx.recipes
        .map((r) =>
          typeof r === "string"
            ? r
            : r?.id || r?.recipeId || r?.recipe_id || null
        )
        .filter(Boolean)
    : null;

  if (recipeIds && recipeIds.length)
    lines.push(`recipeIds: ${recipeIds.slice(0, 50).join(", ")}`);

  // Planning window / anchor date
  if (ctx.date || ctx.dayKey) lines.push(`date: ${ctx.date ?? ctx.dayKey}`);
  if (ctx.startISO) lines.push(`startISO: ${ctx.startISO}`);
  if (ctx.endISO) lines.push(`endISO: ${ctx.endISO}`);

  // Optional mode knobs
  if (ctx.mode) lines.push(`mode: ${ctx.mode}`);

  // Free text
  if (ctx.text) lines.push(`text: ${ctx.text}`);

  return lines.join("\n");
}

/**
 * Deterministic “prompt” string for the garden domain.
 * Expected by companionPlantingShim:
 *   import { buildGardenPrompt } from "@/reasoner/prompts/templates";
 */
export function buildGardenPrompt(ctx = {}) {
  const lines = [];
  lines.push(`domain: garden`);
  if (ctx.intent) lines.push(`intent: ${ctx.intent}`);
  if (ctx.householdId) lines.push(`householdId: ${ctx.householdId}`);
  if (ctx.userId) lines.push(`userId: ${ctx.userId}`);
  if (ctx.groupId) lines.push(`groupId: ${ctx.groupId}`);

  // Planning window / anchor date
  if (ctx.date || ctx.dayKey) lines.push(`date: ${ctx.date ?? ctx.dayKey}`);
  if (ctx.startISO) lines.push(`startISO: ${ctx.startISO}`);
  if (ctx.endISO) lines.push(`endISO: ${ctx.endISO}`);

  // Light fingerprints
  if (ctx.season) lines.push(`season: ${ctx.season}`);
  if (ctx.zone) lines.push(`zone: ${ctx.zone}`);

  // Bounded signatures if provided
  const cropIds = Array.isArray(ctx.cropIds) ? ctx.cropIds : null;
  const bedIds = Array.isArray(ctx.bedIds) ? ctx.bedIds : null;
  const taskIds = Array.isArray(ctx.taskIds) ? ctx.taskIds : null;

  if (cropIds && cropIds.length)
    lines.push(`cropIds: ${cropIds.slice(0, 50).join(", ")}`);
  if (bedIds && bedIds.length)
    lines.push(`bedIds: ${bedIds.slice(0, 50).join(", ")}`);
  if (taskIds && taskIds.length)
    lines.push(`taskIds: ${taskIds.slice(0, 50).join(", ")}`);

  // Optional mode knobs
  if (ctx.mode) lines.push(`mode: ${ctx.mode}`);

  // Free text
  if (ctx.text) lines.push(`text: ${ctx.text}`);

  return lines.join("\n");
}

/**
 * Deterministic “prompt” string for the preservation domain (curing/smoking/canning/etc.).
 * Expected by cureCalcShim:
 *   import { buildPreservationPrompt } from "@/reasoner/prompts/templates";
 *
 * Keep tolerant and compact (bounded arrays + bounded text).
 */
export function buildPreservationPrompt(ctx = {}) {
  const lines = [];
  lines.push(`domain: preservation`);
  if (ctx.intent) lines.push(`intent: ${ctx.intent}`);
  if (ctx.householdId) lines.push(`householdId: ${ctx.householdId}`);
  if (ctx.userId) lines.push(`userId: ${ctx.userId}`);
  if (ctx.groupId) lines.push(`groupId: ${ctx.groupId}`);

  // What process/method
  const methodKey =
    ctx.methodKey ??
    ctx.methodId ??
    ctx.method_id ??
    ctx.process ??
    ctx.technique ??
    null;
  if (methodKey) lines.push(`methodKey: ${methodKey}`);

  // What item
  const itemType =
    ctx.itemType ??
    ctx.foodType ??
    ctx.category ??
    ctx.kind ??
    ctx.productType ??
    null;
  if (itemType) lines.push(`itemType: ${itemType}`);

  // Common numeric parameters for cure calculators
  const weight =
    ctx.weight ??
    ctx.weightLbs ??
    ctx.weight_lbs ??
    ctx.weightKg ??
    ctx.weight_kg ??
    null;
  if (weight != null) lines.push(`weight: ${weight}`);
  if (ctx.units || ctx.unit) lines.push(`units: ${ctx.units ?? ctx.unit}`);

  // Planning window / anchor date
  if (ctx.date || ctx.dayKey) lines.push(`date: ${ctx.date ?? ctx.dayKey}`);
  if (ctx.startISO) lines.push(`startISO: ${ctx.startISO}`);
  if (ctx.endISO) lines.push(`endISO: ${ctx.endISO}`);

  // Optional facility/location hints
  const location =
    ctx.location ?? ctx.station ?? ctx.zone ?? ctx.room ?? ctx.kitchen ?? null;
  if (location) lines.push(`location: ${location}`);

  // Optional mode knobs
  if (ctx.mode) lines.push(`mode: ${ctx.mode}`);

  // Free text
  if (ctx.text) lines.push(`text: ${ctx.text}`);

  return lines.join("\n");
}

/**
 * Back-compat alias (some shims may use slightly different naming).
 */
export function buildCuringPrompt(ctx = {}) {
  return buildPreservationPrompt(ctx);
}

/**
 * Deterministic “prompt” string for the animals domain.
 * Expected by animalShim:
 *   import { buildAnimalPrompt } from "@/reasoner/prompts/templates";
 */
export function buildAnimalPrompt(ctx = {}) {
  const lines = [];
  lines.push(`domain: animals`);
  if (ctx.intent) lines.push(`intent: ${ctx.intent}`);
  if (ctx.householdId) lines.push(`householdId: ${ctx.householdId}`);
  if (ctx.userId) lines.push(`userId: ${ctx.userId}`);

  // Common identifiers / grouping
  if (ctx.animalId || ctx.profileId || ctx.id)
    lines.push(`animalId: ${ctx.animalId ?? ctx.profileId ?? ctx.id}`);
  if (ctx.herdId || ctx.flockId || ctx.groupId)
    lines.push(`herdId: ${ctx.herdId ?? ctx.flockId ?? ctx.groupId}`);

  // Common animal fields
  if (ctx.species || ctx.animalType || ctx.type)
    lines.push(`species: ${ctx.species ?? ctx.animalType ?? ctx.type}`);
  if (ctx.stage || ctx.lifeStage || ctx.ageStage)
    lines.push(`stage: ${ctx.stage ?? ctx.lifeStage ?? ctx.ageStage}`);
  if (ctx.location || ctx.pen || ctx.stall || ctx.pasture)
    lines.push(
      `location: ${ctx.location ?? ctx.pen ?? ctx.stall ?? ctx.pasture}`
    );

  // Planning window / anchor date
  if (ctx.date || ctx.dayKey) lines.push(`date: ${ctx.date ?? ctx.dayKey}`);
  if (ctx.startISO) lines.push(`startISO: ${ctx.startISO}`);
  if (ctx.endISO) lines.push(`endISO: ${ctx.endISO}`);

  // Optional mode knobs
  if (ctx.mode) lines.push(`mode: ${ctx.mode}`);

  // Free text
  if (ctx.text) lines.push(`text: ${ctx.text}`);

  return lines.join("\n");
}

/**
 * Back-compat plural alias expected by breedingAndButcheringShim:
 *   import { buildAnimalsPrompt } from "@/reasoner/prompts/templates";
 *
 * This is a plural alias to the singular animals prompt builder.
 */
export function buildAnimalsPrompt(ctx = {}) {
  return buildAnimalPrompt(ctx);
}

/**
 * Back-compat export expected by agent shims (e.g., mealPlanningShim).
 * A "template prompt" is the deterministic, domain+intent scoped prompt string.
 */
export function buildTemplatePrompt(ctx = {}) {
  const domain = (ctx.domain || ctx.intentDomain || "")
    .toString()
    .toLowerCase();

  if (domain === "cleaning") return buildCleaningPrompt(ctx);
  if (domain === "cooking" || domain === "meal" || domain === "mealplanning")
    return buildCookingPrompt(ctx);
  if (domain === "garden") return buildGardenPrompt(ctx);
  if (domain === "preservation" || domain === "cure" || domain === "curing")
    return buildPreservationPrompt(ctx);
  if (domain === "animals" || domain === "animal")
    return buildAnimalPrompt(ctx);

  // Generic deterministic template prompt (safe for any domain).
  const lines = [];
  lines.push(`domain: ${ctx.domain || "generic"}`);
  if (ctx.intent) lines.push(`intent: ${ctx.intent}`);
  if (ctx.mode) lines.push(`mode: ${ctx.mode}`);
  if (ctx.text) lines.push(`text: ${ctx.text}`);
  if (ctx.startISO) lines.push(`startISO: ${ctx.startISO}`);
  if (ctx.endISO) lines.push(`endISO: ${ctx.endISO}`);
  if (ctx.householdId) lines.push(`householdId: ${ctx.householdId}`);
  if (ctx.groupId) lines.push(`groupId: ${ctx.groupId}`);

  return lines.join("\n");
}

export function invokeReasonerTemplatePayload(ctx = {}) {
  const domain = (ctx.domain || "").toString().toLowerCase();
  const prompt =
    domain === "animals"
      ? buildAnimalPrompt(ctx)
      : domain === "garden"
      ? buildGardenPrompt(ctx)
      : domain === "preservation" || domain === "cure" || domain === "curing"
      ? buildPreservationPrompt(ctx)
      : domain === "cooking" || domain === "meal" || domain === "mealplanning"
      ? buildCookingPrompt(ctx)
      : buildCleaningPrompt(ctx);

  return {
    system: "SSA Reasoner System (deterministic)",
    input: ctx,
    prompt,
  };
}

export default {
  buildCleaningPrompt,
  buildCookingPrompt,
  buildGardenPrompt,
  buildPreservationPrompt,
  buildCuringPrompt,
  buildAnimalPrompt,
  buildAnimalsPrompt,
  buildTemplatePrompt,
  invokeReasonerTemplatePayload,
};
