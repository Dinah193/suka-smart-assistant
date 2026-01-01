// C:\Users\larho\suka-smart-assistant\src\features\calculators\health\BMICalculator\BMICalculator.shim.js

/**
 * BMICalculator.shim.js
 *
 * HOW THIS FITS:
 *  - Pure calculation logic: no React, no DOM, no eventBus.
 *  - Used by:
 *      • BMICalculator.view.jsx (UI)
 *      • BMICalculator.hooks.js (if/when you add hooks)
 *      • Planning Graph / automation runtimes that need BMI values.
 *  - All side effects (events, Dexie, SessionRunner) happen OUTSIDE this file.
 *
 * CONTRACT:
 *  - Matches BMICalculator.schema.json:
 *      input:  BMICalculatorInput
 *      output: BMICalculatorOutput
 *
 *  - Helper exports:
 *      computeBMI(input) → { input, output, meta }
 *      getBMIOnly(input) → { bmi, category, categoryLabel }
 */

/**
 * @typedef {Object} BMIHeight
 * @property {number} value
 * @property {"in"|"cm"} unit
 */

/**
 * @typedef {Object} BMIWeight
 * @property {number} value
 * @property {"lb"|"kg"} unit
 */

/**
 * @typedef {Object} BMIRoundingPreferences
 * @property {number} [bmiDecimals]
 * @property {number} [weightDecimals]
 */

/**
 * @typedef {Object} BMISSAIntegrationHints
 * @property {boolean} [autosaveProfile]
 * @property {boolean} [allowLinkToMacroCalculator]
 */

/**
 * @typedef {Object} BMICalculatorInput
 * @property {BMIHeight} height
 * @property {BMIWeight} weight
 * @property {"female"|"male"|"other"|"unspecified"} [sex]
 * @property {number} [ageYears]
 * @property {"imperial"|"metric"|"mixed"} [unitSystem]
 * @property {BMIRoundingPreferences} [rounding]
 * @property {BMISSAIntegrationHints} [ssaIntegration]
 */

/**
 * @typedef {Object} RecommendedWeightRange
 * @property {number} min
 * @property {number} max
 * @property {"lb"|"kg"} unit
 */

/**
 * @typedef {Object} BMICalculatorOutput
 * @property {number} bmi
 * @property {string} category
 * @property {string} [categoryLabel]
 * @property {RecommendedWeightRange} [recommendedWeightRange]
 * @property {string[]} [warnings]
 * @property {string[]} [notes]
 */

/**
 * @typedef {Object} BMICalculatorMeta
 * @property {string} [calculatorId]
 * @property {"pg.health.bmiCalculator"} [nodeId]
 * @property {string} [generatedAt] ISO timestamp
 */

/**
 * @typedef {Object} BMICalculatorResult
 * @property {BMICalculatorInput} input
 * @property {BMICalculatorOutput} output
 * @property {BMICalculatorMeta} meta
 */

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_ROUNDING = {
  bmiDecimals: 1,
  weightDecimals: 1
};

const DEFAULT_UNIT_SYSTEM = "imperial";

// WHO-ish BMI categories (adults)
const BMI_CATEGORY_THRESHOLDS = [
  { max: 18.5, key: "underweight", label: "Underweight" },
  { max: 25, key: "normal", label: "Normal weight" },
  { max: 30, key: "overweight", label: "Overweight" },
  { max: 35, key: "obeseClass1", label: "Obesity Class I" },
  { max: 40, key: "obeseClass2", label: "Obesity Class II" },
  { max: Infinity, key: "obeseClass3", label: "Obesity Class III" }
];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Safe number check.
 * @param {any} value
 * @returns {boolean}
 */
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Round a number to a given number of decimals.
 * @param {number} value
 * @param {number} decimals
 * @returns {number}
 */
function roundTo(value, decimals) {
  if (!isFiniteNumber(value)) return value;
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

/**
 * Convert height to meters.
 * @param {BMIHeight} height
 * @returns {number|null} height in meters or null on invalid
 */
function normalizeHeightToMeters(height) {
  if (!height || !isFiniteNumber(height.value)) return null;
  if (height.unit === "cm") {
    return height.value / 100;
  }
  if (height.unit === "in") {
    return height.value * 0.0254;
  }
  return null;
}

/**
 * Convert weight to kilograms.
 * @param {BMIWeight} weight
 * @returns {number|null} weight in kilograms or null on invalid
 */
function normalizeWeightToKg(weight) {
  if (!weight || !isFiniteNumber(weight.value)) return null;
  if (weight.unit === "kg") {
    return weight.value;
  }
  if (weight.unit === "lb") {
    return weight.value * 0.45359237;
  }
  return null;
}

/**
 * Convert weight in kg to target output unit.
 * @param {number} kg
 * @param {"lb"|"kg"} unit
 * @returns {number}
 */
function convertKgToUnit(kg, unit) {
  if (!isFiniteNumber(kg)) return kg;
  if (unit === "lb") return kg / 0.45359237;
  return kg;
}

/**
 * Determine BMI category key + label from numeric BMI.
 * @param {number} bmi
 * @returns {{ key: string, label: string }}
 */
function resolveBMICategory(bmi) {
  if (!isFiniteNumber(bmi)) {
    return { key: "unknown", label: "Unknown" };
  }
  for (const cfg of BMI_CATEGORY_THRESHOLDS) {
    if (bmi < cfg.max) {
      return { key: cfg.key, label: cfg.label };
    }
  }
  // Should never hit; fallback:
  return { key: "unknown", label: "Unknown" };
}

/**
 * Get output unit for weight range based on user's unitSystem & weight.unit.
 * @param {BMICalculatorInput} input
 * @returns {"lb"|"kg"}
 */
function resolveWeightOutputUnit(input) {
  const sys = input.unitSystem || DEFAULT_UNIT_SYSTEM;

  if (sys === "metric") return "kg";
  if (sys === "imperial") return "lb";

  // mixed → follow input.weight.unit if valid, else fallback
  if (input.weight && (input.weight.unit === "lb" || input.weight.unit === "kg")) {
    return input.weight.unit;
  }
  return "lb";
}

/**
 * Compute the recommended weight range for BMI 18.5–24.9 at a given height.
 * @param {number} heightM
 * @param {"lb"|"kg"} outUnit
 * @returns {RecommendedWeightRange | null}
 */
function computeRecommendedWeightRange(heightM, outUnit) {
  if (!isFiniteNumber(heightM) || heightM <= 0) return null;

  const minKg = 18.5 * Math.pow(heightM, 2);
  const maxKg = 24.9 * Math.pow(heightM, 2);

  return {
    min: convertKgToUnit(minKg, outUnit),
    max: convertKgToUnit(maxKg, outUnit),
    unit: outUnit
  };
}

/**
 * Generate warnings & notes based on BMI, age, sex.
 * @param {BMICalculatorInput} input
 * @param {number} bmi
 * @param {string} categoryKey
 * @returns {{ warnings: string[], notes: string[] }}
 */
function buildWarningsAndNotes(input, bmi, categoryKey) {
  const warnings = [];
  const notes = [];

  // General BMI limitation notes:
  notes.push(
    "BMI is a screening tool and does not directly measure body fat or health.",
    "Muscle mass, bone density, and fat distribution can affect how BMI reflects true health status."
  );

  if (input.ageYears && (input.ageYears < 18 || input.ageYears > 65)) {
    warnings.push(
      "BMI ranges were primarily developed for adults; interpretation may differ for children, teens, and older adults."
    );
  }

  if (input.sex === "female") {
    notes.push(
      "Hormonal changes, pregnancy, and menopause can influence body composition beyond what BMI shows."
    );
  }

  if (categoryKey === "underweight") {
    warnings.push(
      "Underweight BMI may be associated with nutritional deficits or other health issues. Consider discussing with a healthcare professional."
    );
  }

  if (
    categoryKey === "obeseClass2" ||
    categoryKey === "obeseClass3"
  ) {
    warnings.push(
      "Higher BMI classes can be associated with increased health risks. Consider a comprehensive assessment with a healthcare professional."
    );
  }

  if (bmi < 5 || bmi > 90) {
    warnings.push(
      "BMI value is outside the typical range used for adults; double-check height and weight entries."
    );
  }

  return { warnings, notes };
}

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

/**
 * Compute BMI and related metadata from input.
 *
 * @param {BMICalculatorInput} inputRaw
 * @returns {BMICalculatorResult}
 */
export function computeBMI(inputRaw) {
  const nowIso = new Date().toISOString();

  const input = normalizeInput(inputRaw);
  const rounding = {
    bmiDecimals:
      input.rounding && isFiniteNumber(input.rounding.bmiDecimals)
        ? input.rounding.bmiDecimals
        : DEFAULT_ROUNDING.bmiDecimals,
    weightDecimals:
      input.rounding && isFiniteNumber(input.rounding.weightDecimals)
        ? input.rounding.weightDecimals
        : DEFAULT_ROUNDING.weightDecimals
  };

  const heightM = normalizeHeightToMeters(input.height);
  const weightKg = normalizeWeightToKg(input.weight);

  let bmi = NaN;
  if (isFiniteNumber(heightM) && heightM > 0 && isFiniteNumber(weightKg) && weightKg > 0) {
    bmi = weightKg / Math.pow(heightM, 2);
  }

  const roundedBMI = isFiniteNumber(bmi) ? roundTo(bmi, rounding.bmiDecimals) : NaN;

  const { key: categoryKey, label: categoryLabel } = resolveBMICategory(roundedBMI);

  const outWeightUnit = resolveWeightOutputUnit(input);
  const weightRange = computeRecommendedWeightRange(heightM, outWeightUnit);

  const recRange =
    weightRange && isFiniteNumber(weightRange.min) && isFiniteNumber(weightRange.max)
      ? {
          min: roundTo(weightRange.min, rounding.weightDecimals),
          max: roundTo(weightRange.max, rounding.weightDecimals),
          unit: weightRange.unit
        }
      : undefined;

  const { warnings, notes } = buildWarningsAndNotes(input, roundedBMI, categoryKey);

  /** @type {BMICalculatorOutput} */
  const output = {
    bmi: roundedBMI,
    category: categoryKey,
    categoryLabel,
    recommendedWeightRange: recRange,
    warnings,
    notes
  };

  /** @type {BMICalculatorMeta} */
  const meta = {
    nodeId: "pg.health.bmiCalculator",
    generatedAt: nowIso
  };

  return {
    input,
    output,
    meta
  };
}

/**
 * Convenience helper when callers only care about BMI and category.
 *
 * @param {BMICalculatorInput} input
 * @returns {{ bmi: number; category: string; categoryLabel: string }}
 */
export function getBMIOnly(input) {
  const res = computeBMI(input);
  return {
    bmi: res.output.bmi,
    category: res.output.category,
    categoryLabel: res.output.categoryLabel || res.output.category
  };
}

// ---------------------------------------------------------------------------
// Input normalization
// ---------------------------------------------------------------------------

/**
 * Apply safe defaults for nullable fields so callers can be less strict.
 * DOES NOT mutate the original input.
 *
 * @param {BMICalculatorInput} input
 * @returns {BMICalculatorInput}
 */
function normalizeInput(input) {
  const safe = input || /** @type {any} */ ({});

  const height = safe.height || { value: 0, unit: "in" };
  const weight = safe.weight || { value: 0, unit: "lb" };

  const unitSystem =
    safe.unitSystem === "imperial" ||
    safe.unitSystem === "metric" ||
    safe.unitSystem === "mixed"
      ? safe.unitSystem
      : DEFAULT_UNIT_SYSTEM;

  /** @type {BMICalculatorInput} */
  const normalized = {
    height: {
      value: Number(height.value) || 0,
      unit: height.unit === "cm" ? "cm" : "in"
    },
    weight: {
      value: Number(weight.value) || 0,
      unit: weight.unit === "kg" ? "kg" : "lb"
    },
    sex:
      safe.sex === "female" ||
      safe.sex === "male" ||
      safe.sex === "other" ||
      safe.sex === "unspecified"
        ? safe.sex
        : "unspecified",
    ageYears: safe.ageYears != null ? Number(safe.ageYears) : undefined,
    unitSystem,
    rounding: {
      bmiDecimals:
        safe.rounding && isFiniteNumber(safe.rounding.bmiDecimals)
          ? safe.rounding.bmiDecimals
          : DEFAULT_ROUNDING.bmiDecimals,
      weightDecimals:
        safe.rounding && isFiniteNumber(safe.rounding.weightDecimals)
          ? safe.rounding.weightDecimals
          : DEFAULT_ROUNDING.weightDecimals
    },
    ssaIntegration: {
      autosaveProfile:
        safe.ssaIntegration && typeof safe.ssaIntegration.autosaveProfile === "boolean"
          ? safe.ssaIntegration.autosaveProfile
          : true,
      allowLinkToMacroCalculator:
        safe.ssaIntegration && typeof safe.ssaIntegration.allowLinkToMacroCalculator === "boolean"
          ? safe.ssaIntegration.allowLinkToMacroCalculator
          : true
    }
  };

  return normalized;
}

// ---------------------------------------------------------------------------
// Default export
// ---------------------------------------------------------------------------

const BMICalculatorShim = {
  computeBMI,
  getBMIOnly
};

export default BMICalculatorShim;
