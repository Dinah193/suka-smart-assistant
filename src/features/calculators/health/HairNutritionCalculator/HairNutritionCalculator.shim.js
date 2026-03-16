/**
 * HairNutritionCalculator.shim.js
 *
 * Shim module for the Black Hair Nutrition Calculator in Suka Smart Assistant (SSA).
 *
 * How this fits:
 * - Pure, deterministic calculation logic (safe to run in Web Workers / background).
 * - Consumes structured input matching HairNutritionCalculator.schema.json "input".
 * - Produces structured output matching HairNutritionCalculator.schema.json "output".
 * - Emits SSA events via the shared eventBus.
 * - Optionally exports results to the Family Fund Hub when familyFundMode === true.
 *
 * This shim does NOT touch UI directly. It is orchestration-friendly and can be
 * invoked from background pipelines, SessionRunner flows, or on-demand calculator pages.
 */

import { emit } from "@/services/events/eventBus";
import { familyFundMode } from "@/config/featureFlags";
import { HubPacketFormatter, FamilyFundConnector } from "@/services/hub";

/** CONSTANTS & DEFAULTS *****************************************************/

const NODE_ID = "health.hairNutritionCalculator";
const CALC_VERSION = "1.0.0";

// These should match HairNutritionCalculator.config.json defaults.
const BASE_PROTEIN_PER_KG = 1.2;
const HAIR_FOCUS_MULTIPLIER = 1.15;
const MIN_DAILY_PROTEIN_GRAMS = 50;
const MAX_DAILY_PROTEIN_GRAMS = 200;

const MIN_OMEGA3_GRAMS = 1.1;
const BASE_WATER_CUPS = 8;
const MAX_WATER_CUPS = 32;

/**
 * Approximate amino acid contribution ratios for hair-focused protein profile.
 * These are simple heuristic splits of total protein grams.
 */
const AMINO_RATIOS = {
  lysine: 0.08,
  methionine: 0.02,
  cysteine: 0.02,
  arginine: 0.08,
  histidine: 0.015,
  tryptophan: 0.01,
};

/** HELPER: safe ISO timestamp ************************************************/

/**
 * @returns {string}
 */
function nowIso() {
  return new Date().toISOString();
}

/** HELPER: clamp *************************************************************/

/**
 * Clamp a number between min and max.
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** HELPER: emit events *******************************************************/

/**
 * Emit a calculator event via the SSA event bus.
 *
 * @param {string} type - event type string (e.g., "calculator.hairNutrition.calculated")
 * @param {object} data - payload to send with the event
 */
function emitCalculatorEvent(type, data) {
  try {
    emit({
      type,
      ts: nowIso(),
      source: "features/calculators/health/HairNutritionCalculator.shim",
      data,
    });
  } catch (err) {
    // Fail silently; calculators should never crash the app due to event issues.
    // eslint-disable-next-line no-console
    console.error("[HairNutritionCalculator.shim] Event emit failed:", err);
  }
}

/** HELPER: Hub export ********************************************************/

/**
 * Export calculator result to the Family Fund Hub when enabled.
 *
 * @param {object} meta - meta block (nodeId, calculationVersion, timestamp)
 * @param {object} input - raw calculator input
 * @param {object} output - calculator output
 * @returns {Promise<void>}
 */
async function exportToHubIfEnabled(meta, input, output) {
  if (!familyFundMode) return;

  try {
    const packet = HubPacketFormatter.formatCalculatorResult({
      nodeId: NODE_ID,
      calculationVersion: CALC_VERSION,
      kind: "hair-nutrition",
      meta,
      input,
      output,
    });

    await FamilyFundConnector.send(packet);

    emitCalculatorEvent("session.exported", {
      nodeId: NODE_ID,
      kind: "calculator",
      meta,
    });
  } catch (err) {
    // Hub export should fail silently from the user's perspective.
    // eslint-disable-next-line no-console
    console.warn("[HairNutritionCalculator.shim] Hub export failed:", err);
  }
}

/** CORE CALC HELPERS *********************************************************/

/**
 * Convert body weight to kg if necessary.
 *
 * @param {"imperial"|"metric"} unitSystem
 * @param {number} bodyWeight
 * @returns {number} weightKg
 */
function toKg(unitSystem, bodyWeight) {
  if (unitSystem === "imperial") {
    return bodyWeight * 0.45359237;
  }
  return bodyWeight;
}

/**
 * Calculate daily protein target for hair.
 *
 * @param {object} input
 * @param {"imperial"|"metric"} input.unitSystem
 * @param {number} input.bodyWeight
 * @param {string} [input.activityLevel]
 * @returns {{ grams: number, gramsPerKg: number, rationale: string }}
 */
function calculateProteinTarget(input) {
  const { unitSystem, bodyWeight, activityLevel = "sedentary" } = input;

  const weightKg = toKg(unitSystem, bodyWeight);

  // Activity multiplier tweak.
  let activityBump = 0;
  switch (activityLevel) {
    case "light":
      activityBump = 0.1;
      break;
    case "moderate":
      activityBump = 0.2;
      break;
    case "active":
    case "athlete":
      activityBump = 0.3;
      break;
    default:
      activityBump = 0;
  }

  const gramsPerKg =
    BASE_PROTEIN_PER_KG * HAIR_FOCUS_MULTIPLIER * (1 + activityBump);
  const rawGrams = gramsPerKg * weightKg;
  const grams = clamp(
    rawGrams,
    MIN_DAILY_PROTEIN_GRAMS,
    MAX_DAILY_PROTEIN_GRAMS
  );

  const rationale = [
    `Base ${BASE_PROTEIN_PER_KG.toFixed(2)} g/kg`,
    `hair focus x${HAIR_FOCUS_MULTIPLIER.toFixed(2)}`,
    activityBump > 0
      ? `activity bump +${(activityBump * 100).toFixed(0)}%`
      : null,
  ]
    .filter(Boolean)
    .join(", ");

  return {
    grams: Math.round(grams),
    gramsPerKg: parseFloat(gramsPerKg.toFixed(2)),
    rationale,
  };
}

/**
 * Calculate amino acid profile from daily protein target.
 *
 * @param {number} proteinGrams
 * @returns {{ unit: "grams-per-day", lysine:number, methionine:number, cysteine:number, arginine:number, histidine:number, tryptophan:number }}
 */
function calculateAminoProfile(proteinGrams) {
  const round2 = (v) => parseFloat(v.toFixed(2));

  return {
    unit: "grams-per-day",
    lysine: round2(proteinGrams * AMINO_RATIOS.lysine),
    methionine: round2(proteinGrams * AMINO_RATIOS.methionine),
    cysteine: round2(proteinGrams * AMINO_RATIOS.cysteine),
    arginine: round2(proteinGrams * AMINO_RATIOS.arginine),
    histidine: round2(proteinGrams * AMINO_RATIOS.histidine),
    tryptophan: round2(proteinGrams * AMINO_RATIOS.tryptophan),
  };
}

/**
 * Calculate healthy fat targets for hair and scalp support.
 *
 * @param {object} input
 * @param {object} [input.macroTargets]
 * @param {number} [input.macroTargets.fatGrams]
 * @param {number} [input.macroTargets.calories]
 * @returns {{ totalFatGrams:number, omega3Grams:number, omega6Grams:number, efaRatioHint?:string }}
 */
function calculateHealthyFatTargets(input) {
  const { macroTargets = {} } = input;
  let totalFatGrams = 0;

  if (typeof macroTargets.fatGrams === "number" && macroTargets.fatGrams > 0) {
    // Use macro planner output as the main anchor if available.
    totalFatGrams = macroTargets.fatGrams;
  } else if (
    typeof macroTargets.calories === "number" &&
    macroTargets.calories > 0
  ) {
    // Fallback: assume ~30% of calories from fat / 9 kcal per gram.
    totalFatGrams = (macroTargets.calories * 0.3) / 9;
  } else {
    // Very rough fallback: 0.8 g/kg for hair and hormone support.
    const weightKg = toKg(input.unitSystem, input.bodyWeight);
    totalFatGrams = weightKg * 0.8;
  }

  totalFatGrams = clamp(totalFatGrams, 10, 200);

  // Bias toward better omega-3 intake for scalp and inflammation support.
  const omega3Grams = clamp(totalFatGrams * 0.08, MIN_OMEGA3_GRAMS, 10);
  const omega6Grams = clamp(totalFatGrams * 0.2, 0, 30);

  let efaRatioHint = "";
  const ratio = omega6Grams / (omega3Grams || 1);
  if (ratio > 10) {
    efaRatioHint =
      "Omega-6 is high relative to omega-3. Add more omega-3 rich foods.";
  } else if (ratio < 4) {
    efaRatioHint =
      "Balanced or omega-3 favored profile; maintain with steady intake.";
  } else {
    efaRatioHint =
      "Reasonable omega-3 to omega-6 balance. Keep including omega-3 sources.";
  }

  return {
    totalFatGrams: Math.round(totalFatGrams),
    omega3Grams: parseFloat(omega3Grams.toFixed(2)),
    omega6Grams: parseFloat(omega6Grams.toFixed(2)),
    efaRatioHint,
  };
}

/**
 * Build micronutrient target ranges tuned for hair support.
 * Ranges are heuristic but anchored near common RDA/AI values.
 *
 * @param {object} input
 * @param {object} [input.micronutrientFocusFlags]
 * @param {object} [input.growthGoalFlags]
 * @returns {object}
 */
function calculateMicronutrientTargets(input) {
  const { micronutrientFocusFlags = {}, growthGoalFlags = {} } = input;

  const riskBump = (flag, baseMin, baseMax) => {
    if (micronutrientFocusFlags[flag]) {
      // Slightly elevated upper range for risk flags.
      return { min: baseMin, max: baseMax * 1.2 };
    }
    return { min: baseMin, max: baseMax };
  };

  const postpartumBoost = growthGoalFlags.postpartumSupport ? 1.15 : 1;

  return {
    ironMg: riskBump("ironLowRisk", 14 * postpartumBoost, 27 * postpartumBoost),
    zincMg: riskBump("zincLowRisk", 8, 12),
    vitaminDMcg: riskBump("vitaminDLowRisk", 15, 50),
    vitaminAmcgRAE: { min: 700, max: 1200 },
    vitaminCmg: { min: 75, max: 120 },
    biotinMcg: { min: 30, max: 45 },
    folateMcgDFE: { min: 400, max: 800 },
  };
}

/**
 * Determine high-level support flags from protein, hydration, and risk hints.
 *
 * @param {object} outputPartial
 * @param {object} outputPartial.dailyHairProteinTarget
 * @param {object} input
 * @returns {object}
 */
function buildHairSupportFlags(outputPartial, input) {
  const { dailyHairProteinTarget } = outputPartial;
  const { micronutrientFocusFlags = {}, hydrationCupsCurrent = 0 } = input;

  const proteinOnTrack =
    dailyHairProteinTarget.grams >= MIN_DAILY_PROTEIN_GRAMS;
  const proteinLowRisk =
    proteinOnTrack && !micronutrientFocusFlags.generalMicronutrientConcern;

  const ironSupportNeeded = !!micronutrientFocusFlags.ironLowRisk;
  const vitaminDSupportNeeded = !!micronutrientFocusFlags.vitaminDLowRisk;
  const omega3SupportNeeded = !!micronutrientFocusFlags.omega3LowRisk;
  const hydrationSupportNeeded = hydrationCupsCurrent < BASE_WATER_CUPS;

  const focusAreas = [];
  if (!proteinOnTrack) focusAreas.push("increase complete protein intake");
  if (ironSupportNeeded) focusAreas.push("add iron-rich foods");
  if (vitaminDSupportNeeded) focusAreas.push("support vitamin D intake");
  if (omega3SupportNeeded) focusAreas.push("add omega-3 rich fats");
  if (hydrationSupportNeeded) focusAreas.push("increase daily water intake");

  const summaryNote =
    focusAreas.length === 0
      ? "Your hair nutrition targets look generally supportive. Maintain these patterns consistently."
      : `Top focus areas: ${focusAreas.join(", ")}.`;

  return {
    proteinOnTrack,
    proteinLowRisk,
    ironSupportNeeded,
    vitaminDSupportNeeded,
    omega3SupportNeeded,
    hydrationSupportNeeded,
    summaryNote,
  };
}

/**
 * Build Black hair specific risk flags.
 *
 * @param {object} input
 * @returns {object}
 */
function buildBlackHairRiskFlags(input) {
  const {
    hairTypeProfile = {},
    growthGoalFlags = {},
    protectiveStylePattern = {},
    micronutrientFocusFlags = {},
    hydrationCupsCurrent = 0,
  } = input;

  const { porosity, scalpCondition, chemicalHistory = [] } = hairTypeProfile;
  const { installTensionLevel, weeksPerStyle = 0 } = protectiveStylePattern;

  const denseCoily =
    hairTypeProfile.curlPattern &&
    ["coily-4a", "coily-4b", "coily-4c", "locs"].includes(
      hairTypeProfile.curlPattern
    );

  const highChemicalHistory =
    Array.isArray(chemicalHistory) &&
    chemicalHistory.some((c) =>
      ["relaxer", "permanent-color", "bleach"].includes(c)
    );

  const drynessRisk =
    scalpCondition === "dry" ||
    scalpCondition === "flaky" ||
    porosity === "high" ||
    hydrationCupsCurrent < BASE_WATER_CUPS;

  const sheddingRisk =
    micronutrientFocusFlags.ironLowRisk ||
    micronutrientFocusFlags.generalMicronutrientConcern ||
    growthGoalFlags.sheddingReduction;

  const breakageRisk =
    denseCoily ||
    highChemicalHistory ||
    growthGoalFlags.lengthRetention ||
    growthGoalFlags.thickness;

  const protectiveStyleDamageRisk =
    installTensionLevel === "high" || (weeksPerStyle && weeksPerStyle > 8);

  const scalpInflammationRisk =
    scalpCondition === "inflamed" || scalpCondition === "itchy";

  const postpartumRisk = !!growthGoalFlags.postpartumSupport;

  const notes = [];
  if (breakageRisk)
    notes.push(
      "Prioritize steady protein and gentle handling to reduce breakage."
    );
  if (sheddingRisk)
    notes.push("Support iron and overall micronutrients to address shedding.");
  if (drynessRisk)
    notes.push(
      "Increase hydration and include healthy fats for moisture retention."
    );
  if (protectiveStyleDamageRisk)
    notes.push("Reduce style tension or duration to protect edges and roots.");
  if (scalpInflammationRisk)
    notes.push("Support anti-inflammatory fats and gentle scalp care.");
  if (postpartumRisk)
    notes.push(
      "Postpartum shedding is common; stay consistent with nutrition."
    );

  return {
    breakageRisk,
    sheddingRisk,
    drynessRisk,
    scalpInflammationRisk,
    protectiveStyleDamageRisk,
    postpartumRisk,
    notes: notes.join(" "),
  };
}

/**
 * Calculate water intake target in cups.
 *
 * @param {object} input
 * @returns {number}
 */
function calculateWaterIntakeTargetCups(input) {
  const { hydrationCupsCurrent = 0, hairTypeProfile = {} } = input;
  const { scalpCondition, porosity } = hairTypeProfile;

  let target = BASE_WATER_CUPS;

  if (
    scalpCondition === "dry" ||
    scalpCondition === "flaky" ||
    porosity === "high"
  ) {
    target += 2;
  }

  if (hydrationCupsCurrent >= target) {
    // User is already at/above base; maintain or gently increase if dryness shows.
    target = Math.max(target, hydrationCupsCurrent);
  }

  return clamp(target, 4, MAX_WATER_CUPS);
}

/** MAIN SHIM API *************************************************************/

/**
 * @typedef {import("./HairNutritionCalculator.schema.json")} HairNutritionSchema
 * (This typedef is conceptual; actual import may require a TS/JS tooling step.
 *  The shim is written to align with that schema's "input" and "output" structure.)
 */

/**
 * Run the Black Hair Nutrition calculation.
 *
 * This is the main entry point the rest of SSA should call.
 * It is pure (no UI) and safe to invoke from background workers or React hooks.
 *
 * @param {object} rawInput - matches HairNutritionCalculator.schema.json "input"
 * @param {object} [options]
 * @param {boolean} [options.exportToHub=false] - force Hub export (familyFundMode must still be true)
 * @returns {Promise<{ meta: object, input: object, output: object }>}
 */
export async function runHairNutritionCalculatorShim(rawInput, options = {}) {
  const { exportToHub = false } = options;

  // Defensive input checks.
  if (!rawInput || typeof rawInput !== "object") {
    const error = new Error(
      "HairNutritionCalculator requires a non-null input object."
    );
    emitCalculatorEvent("calculator.hairNutrition.error", {
      error: error.message,
    });
    throw error;
  }

  const { unitSystem, bodyWeight } = rawInput;

  if (!unitSystem || (unitSystem !== "imperial" && unitSystem !== "metric")) {
    const error = new Error(
      'HairNutritionCalculator input.unitSystem must be "imperial" or "metric".'
    );
    emitCalculatorEvent("calculator.hairNutrition.error", {
      error: error.message,
    });
    throw error;
  }

  if (typeof bodyWeight !== "number" || bodyWeight <= 0) {
    const error = new Error(
      "HairNutritionCalculator input.bodyWeight must be a positive number."
    );
    emitCalculatorEvent("calculator.hairNutrition.error", {
      error: error.message,
    });
    throw error;
  }

  const meta = {
    nodeId: NODE_ID,
    calculationVersion: CALC_VERSION,
    timestamp: nowIso(),
  };

  // CORE CALC PIPELINE ///////////////////////////////////////////////////////

  const dailyHairProteinTarget = calculateProteinTarget(rawInput);
  const hairAminoProfile = calculateAminoProfile(dailyHairProteinTarget.grams);
  const hairHealthyFatTargets = calculateHealthyFatTargets(rawInput);
  const hairMicronutrientTargets = calculateMicronutrientTargets(rawInput);

  const partialOutput = {
    dailyHairProteinTarget,
    hairAminoProfile,
    hairHealthyFatTargets,
    hairMicronutrientTargets,
  };

  const hairSupportFlags = buildHairSupportFlags(partialOutput, rawInput);
  const blackHairRiskFlags = buildBlackHairRiskFlags(rawInput);
  const waterIntakeTargetCups = calculateWaterIntakeTargetCups(rawInput);

  const output = {
    dailyHairProteinTarget,
    hairAminoProfile,
    hairHealthyFatTargets,
    hairMicronutrientTargets,
    hairSupportFlags,
    blackHairRiskFlags,
    waterIntakeTargetCups,
  };

  const payload = { meta, input: rawInput, output };

  // Emit success event.
  emitCalculatorEvent("calculator.hairNutrition.calculated", payload);

  // Optional Hub export (still gated by familyFundMode).
  if (exportToHub) {
    await exportToHubIfEnabled(meta, rawInput, output);
  }

  return payload;
}

/**
 * Default export: a small wrapper object for convenience and future extension.
 */
const HairNutritionCalculatorShim = {
  NODE_ID,
  CALC_VERSION,
  run: runHairNutritionCalculatorShim,
};

export default HairNutritionCalculatorShim;
