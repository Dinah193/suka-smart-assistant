// C:\Users\larho\suka-smart-assistant\src\features\calculators\health\MicronutrientCalculator\MicronutrientCalculator.shim.js

/**
 * MicronutrientCalculator.shim.js
 * --------------------------------
 * Core micronutrient calculation logic for SSA.
 *
 * HOW THIS FITS:
 * - This file is a pure logic "shim" used by:
 *   • Health → Micronutrient Calculator UI
 *   • Meals/Recipes → to align meals with micronutrient targets
 *   • Garden → to highlight crops that help close micronutrient gaps
 *   • Animal/Butchery → to surface nutrient-dense animal products (offal, bone broth, etc.)
 * - It consumes an `input` object that matches `MicronutrientCalculator.schema.json` and
 *   returns `{ input, output, meta }`:
 *   • `input`  = normalized copy of caller input
 *   • `output` = micronutrient targets compatible with the schema
 *   • `meta`   = calculatorId / nodeId / version / timestamps for Planning Graph usage
 *
 * IMPORTANT:
 * - No direct DOM, React, or Dexie operations here.
 * - No eventBus, no Hub exports. This stays pure so it can be reused anywhere
 *   (UI components, automation runtime, background workers).
 * - All IO, persistence, and event emission should happen in the caller.
 */

/**
 * Static baseline table for micronutrients.
 * Values are intentionally approximate and can be refined later.
 *
 * Each entry acts as a “base template”. The calculator applies
 * profile-based multipliers and health-focus / constraint tweaks on top.
 *
 * NOTE: All amounts are expressed as daily targets for a typical adult
 *       female ~30 years, non-pregnant, non-lactating by default.
 */
const BASE_MICRONUTRIENTS = {
  "vitamin-d": {
    nutrientId: "vitamin-d",
    label: "Vitamin D",
    group: "vitamin",
    unit: "IU",
    amount: 800,
    recommendedRange: { min: 600, max: 2000 },
    upperLimit: 4000,
    sourceStandard: "approx-RDA",
    tags: ["boneHealth", "immuneSupport"],
    basePriority: 85,
  },
  calcium: {
    nutrientId: "calcium",
    label: "Calcium",
    group: "mineral",
    unit: "mg",
    amount: 1000,
    recommendedRange: { min: 1000, max: 1300 },
    upperLimit: 2500,
    sourceStandard: "approx-RDA",
    tags: ["boneHealth"],
    basePriority: 90,
  },
  magnesium: {
    nutrientId: "magnesium",
    label: "Magnesium",
    group: "mineral",
    unit: "mg",
    amount: 320,
    recommendedRange: { min: 300, max: 400 },
    upperLimit: 700,
    sourceStandard: "approx-RDA",
    tags: ["boneHealth", "metabolicHealth", "nerve"],
    basePriority: 75,
  },
  "vitamin-k": {
    nutrientId: "vitamin-k",
    label: "Vitamin K",
    group: "vitamin",
    unit: "mcg",
    amount: 90,
    recommendedRange: { min: 90, max: 120 },
    upperLimit: 0, // not well-defined; 0 means “no explicit UL”
    sourceStandard: "approx-AI",
    tags: ["boneHealth", "bloodHealth"],
    basePriority: 65,
  },
  iron: {
    nutrientId: "iron",
    label: "Iron",
    group: "mineral",
    unit: "mg",
    amount: 18,
    recommendedRange: { min: 8, max: 18 },
    upperLimit: 45,
    sourceStandard: "approx-RDA",
    tags: ["bloodHealth"],
    basePriority: 80,
  },
  "vitamin-b12": {
    nutrientId: "vitamin-b12",
    label: "Vitamin B12",
    group: "vitamin",
    unit: "mcg",
    amount: 2.4,
    recommendedRange: { min: 2.4, max: 6 },
    upperLimit: 0,
    sourceStandard: "approx-RDA",
    tags: ["bloodHealth", "brainHealth"],
    basePriority: 70,
  },
  folate: {
    nutrientId: "folate",
    label: "Folate (DFE)",
    group: "vitamin",
    unit: "mcg",
    amount: 400,
    recommendedRange: { min: 400, max: 1000 },
    upperLimit: 1000,
    sourceStandard: "approx-RDA",
    tags: ["bloodHealth", "pregnancy"],
    basePriority: 80,
  },
  "vitamin-c": {
    nutrientId: "vitamin-c",
    label: "Vitamin C",
    group: "vitamin",
    unit: "mg",
    amount: 75,
    recommendedRange: { min: 75, max: 200 },
    upperLimit: 2000,
    sourceStandard: "approx-RDA",
    tags: ["immuneSupport"],
    basePriority: 70,
  },
  zinc: {
    nutrientId: "zinc",
    label: "Zinc",
    group: "traceElement",
    unit: "mg",
    amount: 8,
    recommendedRange: { min: 8, max: 40 },
    upperLimit: 40,
    sourceStandard: "approx-RDA",
    tags: ["immuneSupport", "metabolicHealth"],
    basePriority: 65,
  },
  "omega-3": {
    nutrientId: "omega-3",
    label: "Omega-3 (EPA + DHA + ALA)",
    group: "other",
    unit: "g",
    amount: 1.1,
    recommendedRange: { min: 0.8, max: 3 },
    upperLimit: 0,
    sourceStandard: "approx-AI",
    tags: ["heartHealth", "brainHealth"],
    basePriority: 60,
  },
};

/**
 * Utility: deep clone via structuredClone if available, fallback to JSON.
 * Keeps our shim free from accidental shared references.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepClone(value) {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

/**
 * Normalize and guard the incoming input object.
 * Ensures required fields exist and fills defaults where appropriate.
 *
 * @param {import("./MicronutrientCalculator.schema.json")["$defs"]["MicronutrientCalculatorInput"] | any} rawInput
 * @returns {any} normalized input matching MicronutrientCalculatorInput shape
 */
export function normalizeMicronutrientInput(rawInput) {
  const input = deepClone(rawInput || {});

  const profile = input.profile || {};
  const healthFocus = input.healthFocus || {};
  const constraints = input.constraints || {};
  const rounding = input.rounding || {};
  const ssaIntegration = input.ssaIntegration || {};
  const unitSystem = input.unitSystem || "imperial";

  return {
    profile: {
      name: profile.name || "",
      sex: profile.sex || "unspecified",
      ageYears: typeof profile.ageYears === "number" ? profile.ageYears : 30,
      weight: profile.weight || null,
      height: profile.height || null,
      pregnancyStatus: profile.pregnancyStatus || "none",
      lactationStatus: profile.lactationStatus || "none",
      isElderly:
        typeof profile.isElderly === "boolean"
          ? profile.isElderly
          : profile.ageYears >= 60,
    },
    unitSystem,
    dietaryPattern: input.dietaryPattern || {
      primaryPattern: "omnivore",
      avoidsPork: true,
      avoidsShellfish: true,
      avoidsDairy: false,
      avoidsGluten: false,
      otherRestrictions: [],
    },
    healthFocus: {
      boneHealth: !!healthFocus.boneHealth,
      bloodHealth: !!healthFocus.bloodHealth,
      immuneSupport: !!healthFocus.immuneSupport,
      heartHealth: !!healthFocus.heartHealth,
      brainHealth: !!healthFocus.brainHealth,
      metabolicHealth: !!healthFocus.metabolicHealth,
    },
    constraints: {
      limitSodium: !!constraints.limitSodium,
      limitAddedSugar: !!constraints.limitAddedSugar,
      limitSaturatedFat: !!constraints.limitSaturatedFat,
      kidneyIssues: !!constraints.kidneyIssues,
      liverIssues: !!constraints.liverIssues,
      medicationInteractions: Array.isArray(constraints.medicationInteractions)
        ? constraints.medicationInteractions
        : [],
    },
    rounding: {
      gramsDecimals:
        typeof rounding.gramsDecimals === "number" ? rounding.gramsDecimals : 1,
      milligramsDecimals:
        typeof rounding.milligramsDecimals === "number"
          ? rounding.milligramsDecimals
          : 0,
      microgramsDecimals:
        typeof rounding.microgramsDecimals === "number"
          ? rounding.microgramsDecimals
          : 0,
    },
    ssaIntegration: {
      autosaveProfile:
        typeof ssaIntegration.autosaveProfile === "boolean"
          ? ssaIntegration.autosaveProfile
          : true,
      allowLinkToMealPlanner:
        typeof ssaIntegration.allowLinkToMealPlanner === "boolean"
          ? ssaIntegration.allowLinkToMealPlanner
          : true,
      allowLinkToInventoryGaps:
        typeof ssaIntegration.allowLinkToInventoryGaps === "boolean"
          ? ssaIntegration.allowLinkToInventoryGaps
          : true,
    },
  };
}

/**
 * Apply baseline profile rules (sex, age, pregnancy, lactation, elderly).
 * Returns a map of nutrientId → target object (still rough targets).
 *
 * @param {any} profile normalized PersonProfile
 * @returns {Record<string, any>}
 */
function resolveProfileAdjustedTargets(profile) {
  const targets = {};

  Object.values(BASE_MICRONUTRIENTS).forEach((base) => {
    const clone = deepClone(base);
    let amount = clone.amount;
    let priority = clone.basePriority;
    const emphasisReasons = [];

    const sex = profile.sex || "unspecified";
    const age = profile.ageYears || 30;
    const pregnant =
      profile.pregnancyStatus && profile.pregnancyStatus !== "none";
    const lactating =
      profile.lactationStatus && profile.lactationStatus !== "none";
    const isChild = age < 18;
    const isElderly = !!profile.isElderly || age >= 60;

    // Example adjustments:
    if (clone.nutrientId === "iron") {
      if (sex === "female" && !pregnant && !lactating && !isElderly) {
        amount = 18;
        emphasisReasons.push("higher iron for menstruating adult female");
      } else if (pregnant) {
        amount = 27;
        emphasisReasons.push("pregnancy increases iron needs");
      } else {
        amount = 8;
      }
    }

    if (clone.nutrientId === "calcium") {
      if (isChild || isElderly) {
        amount = 1200;
        emphasisReasons.push("bone health during growth or aging");
      }
    }

    if (clone.nutrientId === "vitamin-d") {
      if (isElderly) {
        amount = 1000;
        emphasisReasons.push("increased vitamin D support for elderly");
      }
    }

    if (clone.nutrientId === "folate") {
      if (pregnant) {
        amount = 600;
        emphasisReasons.push("pregnancy increases folate needs");
      } else if (lactating) {
        amount = 500;
        emphasisReasons.push("lactation increases folate needs");
      }
    }

    if (clone.nutrientId === "vitamin-b12" && isElderly) {
      priority += 10;
      emphasisReasons.push("higher B12 priority in elderly");
    }

    // Update clone
    clone.amount = amount;
    clone.priority = Math.min(100, Math.max(0, priority));
    clone.emphasisReasons = emphasisReasons;

    targets[clone.nutrientId] = clone;
  });

  return targets;
}

/**
 * Apply health-focus adjustments to nutrient priorities and amounts.
 *
 * @param {Record<string, any>} targets
 * @param {any} healthFocus
 * @returns {Record<string, any>}
 */
function applyHealthFocusAdjustments(targets, healthFocus) {
  const adjusted = deepClone(targets);

  Object.values(adjusted).forEach((t) => {
    const reasons = t.emphasisReasons || [];
    let amount = t.amount;
    let priority = typeof t.priority === "number" ? t.priority : t.basePriority;

    if (healthFocus.boneHealth) {
      if (
        ["calcium", "vitamin-d", "magnesium", "vitamin-k"].includes(
          t.nutrientId
        )
      ) {
        amount *= 1.1;
        priority += 15;
        reasons.push("bone health focus");
      }
    }

    if (healthFocus.bloodHealth) {
      if (["iron", "vitamin-b12", "folate"].includes(t.nutrientId)) {
        amount *= 1.05;
        priority += 10;
        reasons.push("blood health focus");
      }
    }

    if (healthFocus.immuneSupport) {
      if (["vitamin-c", "vitamin-d", "zinc"].includes(t.nutrientId)) {
        amount *= 1.05;
        priority += 10;
        reasons.push("immune support focus");
      }
    }

    if (healthFocus.heartHealth) {
      if (["omega-3", "magnesium"].includes(t.nutrientId)) {
        amount *= 1.05;
        priority += 8;
        reasons.push("heart health focus");
      }
    }

    if (healthFocus.brainHealth) {
      if (["omega-3", "vitamin-b12", "folate"].includes(t.nutrientId)) {
        amount *= 1.05;
        priority += 8;
        reasons.push("brain health focus");
      }
    }

    if (healthFocus.metabolicHealth) {
      if (["magnesium", "zinc"].includes(t.nutrientId)) {
        amount *= 1.05;
        priority += 8;
        reasons.push("metabolic health focus");
      }
    }

    t.amount = amount;
    t.priority = Math.min(100, Math.max(0, priority));
    t.emphasisReasons = reasons;
  });

  return adjusted;
}

/**
 * Apply constraint-based adjustments (e.g. kidney issues, liver issues).
 * This primarily lowers amounts or adds caution notes.
 *
 * @param {Record<string, any>} targets
 * @param {any} constraints
 * @returns {{ targets: Record<string, any>, cautionNotes: string[] }}
 */
function applyConstraintAdjustments(targets, constraints) {
  const adjusted = deepClone(targets);
  const cautionNotes = [];

  const { kidneyIssues, liverIssues } = constraints || {};

  if (kidneyIssues) {
    ["magnesium", "calcium", "zinc"].forEach((id) => {
      const t = adjusted[id];
      if (!t) return;
      t.amount *= 0.9;
      t.emphasisReasons = t.emphasisReasons || [];
      t.emphasisReasons.push("kidneyIssues: conservative mineral targets");
    });
    cautionNotes.push(
      "Kidney-related constraints: mineral targets slightly reduced. Consult a qualified professional for personalized limits."
    );
  }

  if (liverIssues) {
    const vitD = adjusted["vitamin-d"];
    if (vitD) {
      vitD.amount *= 0.9;
      vitD.emphasisReasons = vitD.emphasisReasons || [];
      vitD.emphasisReasons.push(
        "liverIssues: conservative fat-soluble vitamin target"
      );
    }
    cautionNotes.push(
      "Liver-related constraints: fat-soluble vitamin targets slightly reduced."
    );
  }

  return { targets: adjusted, cautionNotes };
}

/**
 * Apply rounding rules based on the unit type.
 *
 * @param {Record<string, any>} targets
 * @param {any} rounding
 * @returns {Record<string, any>}
 */
function applyRounding(targets, rounding) {
  const adjusted = deepClone(targets);

  Object.values(adjusted).forEach((t) => {
    let decimals = 0;
    switch (t.unit) {
      case "g":
        decimals = rounding.gramsDecimals;
        break;
      case "mg":
        decimals = rounding.milligramsDecimals;
        break;
      case "mcg":
        decimals = rounding.microgramsDecimals;
        break;
      default:
        decimals = 1;
        break;
    }
    const factor = Math.pow(10, decimals);
    t.amount = Math.round(t.amount * factor) / factor;

    if (t.recommendedRange) {
      if (typeof t.recommendedRange.min === "number") {
        t.recommendedRange.min =
          Math.round(t.recommendedRange.min * factor) / factor;
      }
      if (typeof t.recommendedRange.max === "number") {
        t.recommendedRange.max =
          Math.round(t.recommendedRange.max * factor) / factor;
      }
    }
  });

  return adjusted;
}

/**
 * Build aggregate summary compatible with MicronutrientCalculator.schema.json.
 *
 * @param {Record<string, any>} targets
 * @param {any} healthFocus
 * @param {string[]} cautionNotes
 * @returns {any}
 */
function buildAggregateSummary(targets, healthFocus, cautionNotes) {
  const totalMicronutrientsTracked = Object.keys(targets).length;
  const emphasisAreas = Object.entries(healthFocus || {})
    .filter(([, v]) => !!v)
    .map(([k]) => k);

  return {
    totalMicronutrientsTracked,
    emphasisAreas,
    cautionNotes,
    bmiCategoryHint: null, // can be filled in by BMI integration if available
  };
}

/**
 * Main runner used by UI and automation runtime.
 *
 * @param {any} rawInput  - object matching MicronutrientCalculatorInput (loosely)
 * @param {Object} [options]
 * @param {string} [options.calculatorId="health.micronutrients"]
 * @param {string} [options.nodeId="pg.health.micronutrientCalculator"]
 * @param {string} [options.version="1.0.0"]
 * @returns {{
 *   input: any,
 *   output: any,
 *   meta: {
 *     calculatorId: string,
 *     nodeId: string,
 *     generatedAt: string,
 *     version: string,
 *     source?: string
 *   }
 * }}
 */
export function runMicronutrientCalculator(rawInput, options = {}) {
  const calculatorId = options.calculatorId || "health.micronutrients";
  const nodeId = options.nodeId || "pg.health.micronutrientCalculator";
  const version = options.version || "1.0.0";

  const input = normalizeMicronutrientInput(rawInput || {});
  const profile = input.profile;
  const healthFocus = input.healthFocus;
  const constraints = input.constraints;
  const rounding = input.rounding;

  // 1. Profile baseline
  let targets = resolveProfileAdjustedTargets(profile);

  // 2. Health focus adjustments
  targets = applyHealthFocusAdjustments(targets, healthFocus);

  // 3. Constraints
  const constraintResult = applyConstraintAdjustments(targets, constraints);
  targets = constraintResult.targets;
  const cautionNotes = constraintResult.cautionNotes;

  // 4. Rounding
  targets = applyRounding(targets, rounding);

  // 5. Build dailyTargets array & aggregate
  const dailyTargets = Object.values(targets).map((t) => ({
    nutrientId: t.nutrientId,
    label: t.label,
    group: t.group,
    unit: t.unit,
    amount: t.amount,
    recommendedRange: t.recommendedRange || null,
    upperLimit: t.upperLimit || 0,
    priority: typeof t.priority === "number" ? t.priority : t.basePriority,
    sourceStandard: t.sourceStandard || "approx",
    emphasisReasons: t.emphasisReasons || [],
    tags: t.tags || [],
    notes: t.notes || [],
  }));

  const aggregate = buildAggregateSummary(targets, healthFocus, cautionNotes);

  const output = {
    unitSystem: input.unitSystem,
    dailyTargets,
    aggregate,
    warnings: cautionNotes,
    notes: [],
  };

  const meta = {
    calculatorId,
    nodeId,
    generatedAt: new Date().toISOString(),
    version,
  };

  return { input, output, meta };
}

/**
 * Compatibility export:
 * Hooks import `calculateMicronutrientTargets` from this shim.
 *
 * This returns the `output` payload (dailyTargets + aggregate + warnings/notes),
 * which is typically what UIs mean by "targets".
 *
 * @param {any} rawInput
 * @param {Object} [options]
 * @returns {any} output (targets) shape
 */
export function calculateMicronutrientTargets(rawInput, options = {}) {
  return runMicronutrientCalculator(rawInput, options).output;
}

/**
 * Convenience helper: quick access to the list of supported micronutrients.
 *
 * @returns {Array<{ nutrientId: string, label: string, group: string, unit: string }>}
 */
export function listSupportedMicronutrients() {
  return Object.values(BASE_MICRONUTRIENTS).map((n) => ({
    nutrientId: n.nutrientId,
    label: n.label,
    group: n.group,
    unit: n.unit,
  }));
}

/**
 * Convenience helper: build a reasonable default input object.
 * Callers can shallow-merge this into their own state to avoid null checks.
 *
 * @param {Partial<any>} [overrides]
 * @returns {any}
 */
export function buildDefaultMicronutrientInput(overrides = {}) {
  const base = {
    profile: {
      name: "",
      sex: "female",
      ageYears: 35,
      weight: null,
      height: null,
      pregnancyStatus: "none",
      lactationStatus: "none",
      isElderly: false,
    },
    unitSystem: "imperial",
    dietaryPattern: {
      primaryPattern: "omnivore",
      avoidsPork: true,
      avoidsShellfish: true,
      avoidsDairy: false,
      avoidsGluten: false,
      otherRestrictions: [],
    },
    healthFocus: {
      boneHealth: true,
      bloodHealth: true,
      immuneSupport: true,
      heartHealth: false,
      brainHealth: false,
      metabolicHealth: false,
    },
    constraints: {
      limitSodium: false,
      limitAddedSugar: false,
      limitSaturatedFat: false,
      kidneyIssues: false,
      liverIssues: false,
      medicationInteractions: [],
    },
    rounding: {
      gramsDecimals: 1,
      milligramsDecimals: 0,
      microgramsDecimals: 0,
    },
    ssaIntegration: {
      autosaveProfile: true,
      allowLinkToMealPlanner: true,
      allowLinkToInventoryGaps: true,
    },
  };

  return deepClone({
    ...base,
    ...(overrides || {}),
    profile: {
      ...base.profile,
      ...(overrides.profile || {}),
    },
    healthFocus: {
      ...base.healthFocus,
      ...(overrides.healthFocus || {}),
    },
    constraints: {
      ...base.constraints,
      ...(overrides.constraints || {}),
    },
    rounding: {
      ...base.rounding,
      ...(overrides.rounding || {}),
    },
    ssaIntegration: {
      ...base.ssaIntegration,
      ...(overrides.ssaIntegration || {}),
    },
  });
}

export default {
  runMicronutrientCalculator,
  calculateMicronutrientTargets,
  normalizeMicronutrientInput,
  listSupportedMicronutrients,
  buildDefaultMicronutrientInput,
};
