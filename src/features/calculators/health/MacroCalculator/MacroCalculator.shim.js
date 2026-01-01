// C:\Users\larho\suka-smart-assistant\src\features\calculators\health\MacroCalculator\MacroCalculator.shim.js

/**
 * MacroCalculator.shim.js
 *
 * HOW THIS FITS:
 *  - Pure calculation logic for the Macro Calculator.
 *  - Consumed by:
 *      • MacroCalculator UI component(s) for on-page calculations.
 *      • Automation / Planning Graph runtime to derive macro targets
 *        for Meal Planner, Grocery Planner, Animal Planner, etc.
 *  - No React, no DOM, no side-effects. Pure functions only.
 *
 * INPUT CONTRACT (high level):
 *  - Matches MacroCalculator.schema.json "input" shape.
 *
 * OUTPUT CONTRACT (high level):
 *  - { caloriesPerDay, proteinGramsPerDay, fatGramsPerDay, carbGramsPerDay,
 *      perMealBreakdown, profileMacroPresetId, warnings[], notes[] }
 *
 * EXTENSION POINTS:
 *  - New macro strategies (e.g. "keto", "highCarb") → extend resolveMacroStrategy().
 *  - Additional health flags → adapt applyHealthFlagHints().
 */

/* -------------------------------------------------------------------------- */
/* JSDoc Type Definitions                                                     */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} HeightInput
 * @property {number} value
 * @property {"in"|"cm"} unit
 */

/**
 * @typedef {Object} WeightInput
 * @property {number} value
 * @property {"lb"|"kg"} unit
 */

/**
 * @typedef {Object} MacroComponentConfig
 * @property {"gPerKg"|"gPerLb"|"percentOfCalories"|"fixedGrams"|"remainder"|undefined} [mode]
 * @property {number} [gPerKg]
 * @property {number} [gPerLb]
 * @property {number} [percentOfCalories]
 * @property {number} [fixedGrams]
 * @property {number} [percent]
 * @property {number} [minGPerDay]
 */

/**
 * @typedef {Object} HealthFlags
 * @property {boolean} [diabetesOrPreDiabetes]
 * @property {boolean} [kidneyIssues]
 * @property {boolean} [pregnantOrBreastfeeding]
 */

/**
 * @typedef {Object} SSAIntegrationFlags
 * @property {boolean} [allowAutoLinkToMealPlanner]
 * @property {boolean} [allowAutoLinkToGroceryPlanner]
 * @property {boolean} [allowAutoLinkToAnimalPlanner]
 * @property {"imperial"|"metric"|"mixed"} [preferredUnitSystem]
 * @property {boolean} [autosaveProfile]
 */

/**
 * @typedef {Object} MacroCalculatorInput
 * @property {"female"|"male"|"other"|"unspecified"} sex
 * @property {number} ageYears
 * @property {HeightInput} height
 * @property {WeightInput} weight
 * @property {number|null} [bodyFatPercent]
 * @property {"sedentary"|"lightlyActive"|"moderatelyActive"|"veryActive"|"athlete"} activityLevel
 * @property {"fatLoss"|"maintenance"|"recomposition"|"muscleGain"} goal
 * @property {"autoFromTDEE"|"manual"} calorieSource
 * @property {number|null} [manualCalories]
 * @property {"percentOfCalories"|"proteinFocused"|"lowCarb"|"custom"} macroStrategy
 * @property {MacroComponentConfig} [protein]
 * @property {MacroComponentConfig} [fat]
 * @property {MacroComponentConfig} [carbs]
 * @property {{ macroGrams?: number, calories?: number }} [rounding]
 * @property {number} mealsPerDay
 * @property {number} snacksPerDay
 * @property {Array<"perDay"|"perMeal"|"perSnack">} outputGranularity
 * @property {HealthFlags} [healthFlags]
 * @property {SSAIntegrationFlags} [ssaIntegration]
 */

/**
 * @typedef {Object} PerMealEntry
 * @property {number} index
 * @property {"meal"|"snack"} type
 * @property {number} calories
 * @property {number} proteinGrams
 * @property {number} fatGrams
 * @property {number} carbGrams
 */

/**
 * @typedef {Object} PerMealBreakdown
 * @property {PerMealEntry[]} entries
 * @property {number} totalMeals
 * @property {number} totalSnacks
 */

/**
 * @typedef {Object} MacroCalculatorOutput
 * @property {number} caloriesPerDay
 * @property {number} proteinGramsPerDay
 * @property {number} fatGramsPerDay
 * @property {number} carbGramsPerDay
 * @property {PerMealBreakdown|null} perMealBreakdown
 * @property {string|null} profileMacroPresetId
 * @property {string[]} warnings
 * @property {string[]} notes
 */

/**
 * @typedef {Object} MacroCalculatorOptions
 * @property {number|null} [tdee] - Optional TDEE value from another node.
 * @property {number|null} [bmr]  - Optional BMR value for notes/context.
 * @property {string|null} [profileIdSeed] - Optional user profile or person id used to derive preset id.
 */

/**
 * @typedef {Object} MacroCalculatorResult
 * @property {MacroCalculatorInput} input
 * @property {MacroCalculatorOutput} output
 */

/* -------------------------------------------------------------------------- */
/* Simple Helpers                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Safely clone a plain object (for guarding against mutation).
 * @template T
 * @param {T} value
 * @returns {T}
 */
function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

/**
 * @param {number} value
 * @param {number} step
 * @returns {number}
 */
function roundToStep(value, step) {
  if (!Number.isFinite(value) || step <= 0) return value;
  return Math.round(value / step) * step;
}

/**
 * @param {number} lb
 * @returns {number}
 */
function lbToKg(lb) {
  return lb * 0.45359237;
}

/**
 * @param {number} kg
 * @returns {number}
 */
function kgToLb(kg) {
  return kg / 0.45359237;
}

/**
 * @param {number} inches
 * @returns {number}
 */
function inToCm(inches) {
  return inches * 2.54;
}

/**
 * @param {number} cm
 * @returns {number}
 */
function cmToIn(cm) {
  return cm / 2.54;
}

/**
 * @param {"sedentary"|"lightlyActive"|"moderatelyActive"|"veryActive"|"athlete"} level
 * @returns {number}
 */
function activityMultiplier(level) {
  switch (level) {
    case "sedentary":
      return 1.2;
    case "lightlyActive":
      return 1.375;
    case "moderatelyActive":
      return 1.55;
    case "veryActive":
      return 1.725;
    case "athlete":
      return 1.9;
    default:
      return 1.2;
  }
}

/**
 * Very simple Mifflin-St Jeor estimate for fallback when TDEE/BMR not provided.
 * @param {MacroCalculatorInput} input
 * @returns {{ bmr: number, tdee: number }}
 */
function estimateEnergyFromAnthro(input) {
  const heightCm =
    input.height.unit === "cm"
      ? input.height.value
      : inToCm(input.height.value);
  const weightKg =
    input.weight.unit === "kg"
      ? input.weight.value
      : lbToKg(input.weight.value);
  const age = input.ageYears;

  let bmr;
  if (input.sex === "female") {
    bmr = 10 * weightKg + 6.25 * heightCm - 5 * age - 161;
  } else if (input.sex === "male") {
    bmr = 10 * weightKg + 6.25 * heightCm - 5 * age + 5;
  } else {
    // Unspecific: average of male/female adjustments
    bmr = 10 * weightKg + 6.25 * heightCm - 5 * age - 78;
  }

  const tdee = bmr * activityMultiplier(input.activityLevel);
  return { bmr, tdee };
}

/**
 * @param {MacroCalculatorInput} input
 * @param {MacroCalculatorOptions} [options]
 * @returns {{ calorieTarget: number, sourceLabel: string, sourceDetails: string[] }}
 */
function resolveCalorieTarget(input, options = {}) {
  const { tdee = null, bmr = null } = options;
  const details = [];
  let baseCal = 0;
  let sourceLabel = "";

  if (input.calorieSource === "manual" && input.manualCalories) {
    baseCal = input.manualCalories;
    sourceLabel = "manual";
    details.push(`Manual calories: ${Math.round(baseCal)} kcal`);
  } else if (typeof tdee === "number" && tdee > 0) {
    baseCal = tdee;
    sourceLabel = "tdee";
    details.push(`Using TDEE from upstream: ${Math.round(tdee)} kcal`);
  } else {
    const est = estimateEnergyFromAnthro(input);
    baseCal = est.tdee;
    sourceLabel = "estimated";
    details.push(
      `TDEE estimated from Mifflin-St Jeor: ${Math.round(
        est.tdee
      )} kcal (BMR ${Math.round(est.bmr)} kcal)`
    );
  }

  // Adjust by goal
  let goalFactor = 1;
  switch (input.goal) {
    case "fatLoss":
      goalFactor = 0.8;
      details.push("Goal: fat loss (~20% calorie reduction).");
      break;
    case "recomposition":
      goalFactor = 0.95;
      details.push("Goal: recomposition (~5% calorie reduction).");
      break;
    case "maintenance":
      goalFactor = 1;
      details.push("Goal: maintenance (no calorie change).");
      break;
    case "muscleGain":
      goalFactor = 1.1;
      details.push("Goal: muscle gain (~10% surplus).");
      break;
    default:
      goalFactor = 1;
      break;
  }

  const target = Math.max(800, baseCal * goalFactor);

  return {
    calorieTarget: target,
    sourceLabel,
    sourceDetails: details
  };
}

/* -------------------------------------------------------------------------- */
/* Macro Strategy Resolution                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Resolve protein grams per day.
 * @param {MacroCalculatorInput} input
 * @param {number} calorieTarget
 * @returns {{ grams: number, notes: string[] }}
 */
function resolveProtein(input, calorieTarget) {
  const notes = [];
  const cfg = input.protein || {};
  const weightKg =
    input.weight.unit === "kg"
      ? input.weight.value
      : lbToKg(input.weight.value);
  const weightLb =
    input.weight.unit === "lb"
      ? input.weight.value
      : kgToLb(input.weight.value);

  let grams = 0;
  const mode = cfg.mode || "gPerKg";

  if (mode === "gPerKg") {
    const gPerKg = cfg.gPerKg || 1.8;
    grams = gPerKg * weightKg;
    notes.push(`Protein set at ${gPerKg.toFixed(2)} g/kg.`);
  } else if (mode === "gPerLb") {
    const gPerLb = cfg.gPerLb || 0.8;
    grams = gPerLb * weightLb;
    notes.push(`Protein set at ${gPerLb.toFixed(2)} g/lb.`);
  } else if (mode === "percentOfCalories") {
    const pct = cfg.percentOfCalories || cfg.percent || 25;
    grams = (pct / 100) * calorieTarget / 4;
    notes.push(`Protein set at ${pct}% of calories.`);
  } else if (mode === "fixedGrams") {
    grams = cfg.fixedGrams || 100;
    notes.push(`Protein fixed at ${grams.toFixed(0)} g.`);
  } else {
    // Fallback
    grams = 1.8 * weightKg;
    notes.push("Protein fallback: 1.8 g/kg.");
  }

  if (typeof cfg.minGPerDay === "number" && grams < cfg.minGPerDay) {
    notes.push(
      `Protein raised to minimum safeguard of ${cfg.minGPerDay.toFixed(0)} g/day.`
    );
    grams = cfg.minGPerDay;
  }

  return { grams, notes };
}

/**
 * Resolve fat grams per day.
 * @param {MacroCalculatorInput} input
 * @param {number} calorieTarget
 * @returns {{ grams: number, notes: string[] }}
 */
function resolveFat(input, calorieTarget) {
  const notes = [];
  const cfg = input.fat || {};
  const weightKg =
    input.weight.unit === "kg"
      ? input.weight.value
      : lbToKg(input.weight.value);

  let grams = 0;
  const mode = cfg.mode || "percentOfCalories";

  if (mode === "percentOfCalories") {
    const pct = typeof cfg.percent === "number" ? cfg.percent : 30;
    grams = (pct / 100) * calorieTarget / 9;
    notes.push(`Fat set at ${pct}% of calories.`);
  } else if (mode === "gPerKg") {
    const gPerKg = cfg.gPerKg || 0.8;
    grams = gPerKg * weightKg;
    notes.push(`Fat set at ${gPerKg.toFixed(2)} g/kg.`);
  } else if (mode === "fixedGrams") {
    grams = cfg.fixedGrams || 60;
    notes.push(`Fat fixed at ${grams.toFixed(0)} g.`);
  } else {
    // Fallback
    const pct = 30;
    grams = (pct / 100) * calorieTarget / 9;
    notes.push(`Fat fallback at ${pct}% of calories.`);
  }

  if (typeof cfg.minGPerDay === "number" && grams < cfg.minGPerDay) {
    notes.push(
      `Fat raised to minimum safeguard of ${cfg.minGPerDay.toFixed(0)} g/day.`
    );
    grams = cfg.minGPerDay;
  }

  return { grams, notes };
}

/**
 * Resolve carb grams per day as "remainder" or configured mode.
 * @param {MacroCalculatorInput} input
 * @param {number} calorieTarget
 * @param {number} proteinGrams
 * @param {number} fatGrams
 * @returns {{ grams: number, notes: string[] }}
 */
function resolveCarbs(input, calorieTarget, proteinGrams, fatGrams) {
  const notes = [];
  const cfg = input.carbs || {};
  const weightKg =
    input.weight.unit === "kg"
      ? input.weight.value
      : lbToKg(input.weight.value);

  const mode = cfg.mode || "remainder";
  let grams = 0;

  if (mode === "remainder") {
    const usedCalories = proteinGrams * 4 + fatGrams * 9;
    const remaining = Math.max(0, calorieTarget - usedCalories);
    grams = remaining / 4;
    notes.push("Carbs set as remainder calories after protein and fat.");
  } else if (mode === "percentOfCalories") {
    const pct = typeof cfg.percent === "number" ? cfg.percent : 45;
    grams = (pct / 100) * calorieTarget / 4;
    notes.push(`Carbs set at ${pct}% of calories.`);
  } else if (mode === "gPerKg") {
    const gPerKg = cfg.gPerKg || 3;
    grams = gPerKg * weightKg;
    notes.push(`Carbs set at ${gPerKg.toFixed(2)} g/kg.`);
  } else if (mode === "fixedGrams") {
    grams = cfg.fixedGrams || 150;
    notes.push(`Carbs fixed at ${grams.toFixed(0)} g.`);
  } else {
    // Fallback to remainder
    const usedCalories = proteinGrams * 4 + fatGrams * 9;
    const remaining = Math.max(0, calorieTarget - usedCalories);
    grams = remaining / 4;
    notes.push("Carbs fallback: remainder calories after protein & fat.");
  }

  if (typeof cfg.minGPerDay === "number" && grams < cfg.minGPerDay) {
    notes.push(
      `Carbs raised to minimum safeguard of ${cfg.minGPerDay.toFixed(0)} g/day.`
    );
    grams = cfg.minGPerDay;
  }

  return { grams, notes };
}

/**
 * Apply adjustments or notes based on health flags.
 * Keeps the grams unchanged for now, but appends warnings/notes so UI / doctor
 * can be consulted by the user.
 *
 * @param {MacroCalculatorInput} input
 * @param {{ protein: number, fat: number, carbs: number }} grams
 * @returns {{ protein: number, fat: number, carbs: number, warnings: string[], notes: string[] }}
 */
function applyHealthFlagHints(input, grams) {
  const health = input.healthFlags || {};
  const warnings = [];
  const notes = [];

  if (health.diabetesOrPreDiabetes) {
    notes.push(
      "Flag: diabetes/pre-diabetes — consider moderating carbs and pairing them with protein and fat."
    );
  }

  if (health.kidneyIssues) {
    warnings.push(
      "Flag: kidney issues — high protein intakes may not be appropriate. Confirm targets with a medical professional."
    );
  }

  if (health.pregnantOrBreastfeeding) {
    notes.push(
      "Flag: pregnant/breastfeeding — may require extra calories and micronutrients beyond these macro targets."
    );
  }

  return {
    protein: grams.protein,
    fat: grams.fat,
    carbs: grams.carbs,
    warnings,
    notes
  };
}

/* -------------------------------------------------------------------------- */
/* Per-Meal Distribution                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Distribute daily macros evenly across meals and snacks.
 * Simple equal-split strategy for now; can be upgraded later per user prefs.
 *
 * @param {number} caloriesPerDay
 * @param {number} proteinPerDay
 * @param {number} fatPerDay
 * @param {number} carbsPerDay
 * @param {number} mealsPerDay
 * @param {number} snacksPerDay
 * @returns {PerMealBreakdown|null}
 */
function buildPerMealBreakdown(
  caloriesPerDay,
  proteinPerDay,
  fatPerDay,
  carbsPerDay,
  mealsPerDay,
  snacksPerDay
) {
  if (
    !Number.isFinite(caloriesPerDay) ||
    caloriesPerDay <= 0 ||
    mealsPerDay <= 0
  ) {
    return null;
  }

  const totalSlots = mealsPerDay + Math.max(0, snacksPerDay);
  if (totalSlots <= 0) return null;

  const caloriesPerSlot = caloriesPerDay / totalSlots;
  const proteinPerSlot = proteinPerDay / totalSlots;
  const fatPerSlot = fatPerDay / totalSlots;
  const carbsPerSlot = carbsPerDay / totalSlots;

  /** @type {PerMealEntry[]} */
  const entries = [];

  for (let i = 0; i < mealsPerDay; i += 1) {
    entries.push({
      index: i,
      type: "meal",
      calories: caloriesPerSlot,
      proteinGrams: proteinPerSlot,
      fatGrams: fatPerSlot,
      carbGrams: carbsPerSlot
    });
  }

  for (let j = 0; j < snacksPerDay; j += 1) {
    const idx = mealsPerDay + j;
    entries.push({
      index: idx,
      type: "snack",
      calories: caloriesPerSlot,
      proteinGrams: proteinPerSlot,
      fatGrams: fatPerSlot,
      carbGrams: carbsPerSlot
    });
  }

  return {
    entries,
    totalMeals: mealsPerDay,
    totalSnacks: Math.max(0, snacksPerDay)
  };
}

/* -------------------------------------------------------------------------- */
/* Validation Light-Touch Guard                                              */
/* -------------------------------------------------------------------------- */

/**
 * Very light runtime guard; full validation should use MacroCalculator.schema.json.
 * This function is intentionally minimal and defensive.
 *
 * @param {Partial<MacroCalculatorInput>} raw
 * @returns {string[]} errors (empty if "looks okay enough" to compute)
 */
function shallowValidateInput(raw) {
  const errors = [];
  if (!raw) {
    errors.push("Input is missing.");
    return errors;
  }

  if (
    !raw.height ||
    typeof raw.height.value !== "number" ||
    !raw.height.unit
  ) {
    errors.push("Height is required with numeric value and unit.");
  }
  if (
    !raw.weight ||
    typeof raw.weight.value !== "number" ||
    !raw.weight.unit
  ) {
    errors.push("Weight is required with numeric value and unit.");
  }
  if (
    typeof raw.ageYears !== "number" ||
    raw.ageYears < 12 ||
    raw.ageYears > 120
  ) {
    errors.push("Age must be between 12 and 120 years.");
  }
  if (!raw.activityLevel) {
    errors.push("Activity level is required.");
  }
  if (!raw.goal) {
    errors.push("Goal is required.");
  }

  return errors;
}

/* -------------------------------------------------------------------------- */
/* Main Public API                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Compute macro plan from input+options.
 *
 * This is the primary entry point for UI components and automation runtimes.
 *
 * @param {MacroCalculatorInput} rawInput
 * @param {MacroCalculatorOptions} [options]
 * @returns {MacroCalculatorResult}
 */
export function computeMacroPlan(rawInput, options = {}) {
  const input = clone(rawInput);
  const validationErrors = shallowValidateInput(input);
  /** @type {string[]} warnings = */
  const warnings = [...validationErrors];

  if (validationErrors.length > 0) {
    // We still attempt a best-effort calculation; UI can show warnings.
  }

  const roundingStepMacros = input.rounding?.macroGrams || 5;
  const roundingStepCalories = input.rounding?.calories || 10;

  // 1. Calorie target
  const { calorieTarget, sourceLabel, sourceDetails } = resolveCalorieTarget(
    input,
    options
  );

  // 2. Macro grams
  const proteinRes = resolveProtein(input, calorieTarget);
  const fatRes = resolveFat(input, calorieTarget);
  const carbRes = resolveCarbs(
    input,
    calorieTarget,
    proteinRes.grams,
    fatRes.grams
  );

  let proteinGrams = proteinRes.grams;
  let fatGrams = fatRes.grams;
  let carbGrams = carbRes.grams;

  // 3. Health flag notes/warnings
  const healthAdjusted = applyHealthFlagHints(input, {
    protein: proteinGrams,
    fat: fatGrams,
    carbs: carbGrams
  });

  proteinGrams = healthAdjusted.protein;
  fatGrams = healthAdjusted.fat;
  carbGrams = healthAdjusted.carbs;
  warnings.push(...healthAdjusted.warnings);

  // 4. Recompute calories from macros (macro calories only)
  const macroCalories =
    proteinGrams * 4 + fatGrams * 9 + carbGrams * 4;

  /** @type {string[]} notes */
  const notes = [
    `Calorie source: ${sourceLabel}.`,
    ...sourceDetails,
    ...proteinRes.notes,
    ...fatRes.notes,
    ...carbRes.notes,
    ...healthAdjusted.notes
  ];

  if (Math.abs(macroCalories - calorieTarget) > calorieTarget * 0.15) {
    warnings.push(
      "Macro calories differ significantly from target calories; adjust macro percentages or fixed grams if desired."
    );
  }

  // 5. Rounding
  const roundedCalories = roundToStep(macroCalories, roundingStepCalories);
  const roundedProtein = roundToStep(proteinGrams, roundingStepMacros);
  const roundedFat = roundToStep(fatGrams, roundingStepMacros);
  const roundedCarbs = roundToStep(carbGrams, roundingStepMacros);

  // 6. Per-meal breakdown (if requested)
  const wantsPerMeal = input.outputGranularity?.includes("perMeal");
  const wantsPerSnack = input.outputGranularity?.includes("perSnack");
  const mealsPerDay = input.mealsPerDay || 3;
  const snacksPerDay = wantsPerSnack ? input.snacksPerDay || 0 : 0;

  const perMealBreakdown = wantsPerMeal
    ? buildPerMealBreakdown(
        roundedCalories,
        roundedProtein,
        roundedFat,
        roundedCarbs,
        mealsPerDay,
        snacksPerDay
      )
    : null;

  // 7. Profile/preset id (optional)
  const profileMacroPresetId =
    input.ssaIntegration?.autosaveProfile && options.profileIdSeed
      ? `macros:${options.profileIdSeed}:${Date.now()}`
      : null;

  /** @type {MacroCalculatorOutput} */
  const output = {
    caloriesPerDay: roundedCalories,
    proteinGramsPerDay: roundedProtein,
    fatGramsPerDay: roundedFat,
    carbGramsPerDay: roundedCarbs,
    perMealBreakdown,
    profileMacroPresetId,
    warnings,
    notes
  };

  return {
    input,
    output
  };
}

/**
 * Quick helper for consumers that only need numeric macro targets.
 *
 * @param {MacroCalculatorInput} input
 * @param {MacroCalculatorOptions} [options]
 * @returns {{ calories: number, protein: number, fat: number, carbs: number }}
 */
export function getMacroTargets(input, options = {}) {
  const res = computeMacroPlan(input, options);
  return {
    calories: res.output.caloriesPerDay,
    protein: res.output.proteinGramsPerDay,
    fat: res.output.fatGramsPerDay,
    carbs: res.output.carbGramsPerDay
  };
}

/**
 * Default export: bundle of helpers for easier importing.
 */
const MacroCalculatorShim = {
  computeMacroPlan,
  getMacroTargets
};

export default MacroCalculatorShim;
