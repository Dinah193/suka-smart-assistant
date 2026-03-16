// C:\Users\larho\suka-smart-assistant\src\features\calculators\stability\HouseholdStabilityCalculator\HouseholdStabilityCalculator.shim.js

/**
 * HouseholdStabilityCalculator Shim
 *
 * How this fits:
 * - This shim is the pure logic layer for the HouseholdStabilityCalculator node
 *   in the Planning Graph.
 * - It accepts an `input` payload that matches HouseholdStabilityCalculator.schema.json
 *   and returns an `output` object with a stability index, band, subscores,
 *   alerts, and next-best-action recommendations.
 * - Domain planners (storehouse, meals, cleaning, garden, etc.) and the
 *   SessionRunner can use `output.recommendations` to suggest or spawn sessions.
 *
 * Integration:
 * - Called by the central Reasoner / PlanningGraph runtime.
 * - Emits a `stability.calculated` event on the eventBus for observability.
 * - Designed to be side-effect-light and easy to unit test.
 */

/* -------------------------------------------------------------------------- */
/*  Optional imports (safe if missing at build/test time)                     */
/* -------------------------------------------------------------------------- */

let emitEvent = null;

try {
  // eslint-disable-next-line import/no-unresolved
  const bus = require("@/services/events/eventBus");
  emitEvent = typeof bus.emit === "function" ? bus.emit : null;
} catch (err) {
  // In tests or isolated builds, eventBus may not be available.
  emitEvent = null;
}

/* -------------------------------------------------------------------------- */
/*  Types (JSDoc)                                                             */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} StabilityMetrics
 * @property {number} storehouseMonthsCovered
 * @property {number} mealReadinessScore
 * @property {number} cleaningCoverageScore
 * @property {number} gardenSupportScore
 * @property {number} preservationCapacityScore
 * @property {number} financialMarginScore
 * @property {number} routineConsistencyScore
 * @property {number} healthBaselineScore
 * @property {number} relationshipSupportScore
 * @property {number} crisisLoadScore
 * @property {number} sabbathProtectionScore
 */

/**
 * @typedef {Object} StabilityFlags
 * @property {boolean} [sabbathGuardRespected]
 * @property {boolean} [quietHoursRespected]
 * @property {boolean} [feastCalendarAligned]
 */

/**
 * @typedef {Object} StabilityInput
 * @property {{ yearLabel?: string; startDate: string; endDate: string }} period
 * @property {StabilityMetrics} metrics
 * @property {StabilityFlags} [flags]
 * @property {string} [notes]
 */

/**
 * @typedef {Object} StabilitySubScores
 * @property {number} food
 * @property {number} calendar
 * @property {number} routine
 * @property {number} health
 * @property {number} finance
 * @property {number} relationships
 */

/**
 * @typedef {"critical"|"fragile"|"developing"|"stable"|"thriving"} StabilityBand
 */

/**
 * @typedef {"info"|"warning"|"critical"} AlertLevel
 */

/**
 * @typedef {Object} StabilityAlert
 * @property {string} code
 * @property {AlertLevel} level
 * @property {string} message
 */

/**
 * @typedef {"low"|"medium"|"high"|"critical"} RecommendationPriority
 */

/**
 * @typedef {Object} StabilityRecommendation
 * @property {string} id
 * @property {string} label
 * @property {"cooking"|"cleaning"|"garden"|"animals"|"preservation"|"storehouse"|"stability"} domain
 * @property {string} [sessionTemplateKey]
 * @property {RecommendationPriority} [priority]
 */

/**
 * @typedef {Object} StabilityOutput
 * @property {number} stabilityIndex
 * @property {StabilityBand} band
 * @property {StabilitySubScores} [subScores]
 * @property {string} [statusSummary]
 * @property {StabilityAlert[]} [alerts]
 * @property {StabilityRecommendation[]} [recommendations]
 * @property {string} [generatedAt]
 * @property {string} [version]
 */

/**
 * @typedef {Object} ShimRequest
 * @property {string} [nodeKey]    - PlanningGraph node key (e.g., "household-stability")
 * @property {{ input?: StabilityInput }} payload
 * @property {Object} [context]    - Optional contextual data from PlanningGraph/Reasoner.
 */

/**
 * @typedef {Object} ShimResponse
 * @property {string} nodeKey
 * @property {StabilityInput} input
 * @property {StabilityOutput} output
 */

/* -------------------------------------------------------------------------- */
/*  Small helpers                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Safely coerce a value into a number, with bounds and fallback.
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} [min]
 * @param {number} [max]
 * @returns {number}
 */
function toBoundedNumber(value, fallback, min, max) {
  let n;

  if (typeof value === "number" && !Number.isNaN(value)) {
    n = value;
  } else if (
    typeof value === "string" &&
    value.trim() !== "" &&
    !Number.isNaN(Number(value))
  ) {
    n = Number(value);
  } else {
    n = fallback;
  }

  if (typeof min === "number" && n < min) n = min;
  if (typeof max === "number" && n > max) n = max;

  return n;
}

/**
 * Map months of storehouse coverage to 0–100 score.
 * @param {number} months
 * @returns {number}
 */
function toStorehouseScore(months) {
  if (months <= 0) return 0;
  // 0–12 months → 0–100, clamp
  const ratio = Math.min(months, 12) / 12;
  return Math.round(ratio * 100);
}

/**
 * Convert a crisis load score (0–100, higher = worse) into a stability
 * score (0–100, higher = better).
 * @param {number} crisisLoadScore
 * @returns {number}
 */
function toCrisisStabilityScore(crisisLoadScore) {
  const bounded = toBoundedNumber(crisisLoadScore, 50, 0, 100);
  return 100 - bounded;
}

/**
 * Convert a boolean-ish flag to a bonus score (0 or 100).
 * @param {boolean|undefined} flag
 * @returns {number}
 */
function flagToScore(flag) {
  return flag ? 100 : 0;
}

/**
 * Compute a simple average, ignoring undefined values.
 * @param {Array<number|undefined>} nums
 * @returns {number}
 */
function safeAverage(nums) {
  const filtered = nums.filter(
    (n) => typeof n === "number" && !Number.isNaN(n)
  );
  if (!filtered.length) return 0;
  const total = filtered.reduce((sum, n) => sum + n, 0);
  return total / filtered.length;
}

/**
 * Determine the stability band given an index 0–100.
 * @param {number} index
 * @returns {StabilityBand}
 */
function classifyBand(index) {
  if (index >= 80) return "thriving";
  if (index >= 65) return "stable";
  if (index >= 50) return "developing";
  if (index >= 35) return "fragile";
  return "critical";
}

/* -------------------------------------------------------------------------- */
/*  Core calculator logic                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Pure function: compute output from input (no side effects).
 *
 * @param {StabilityInput} input
 * @returns {StabilityOutput}
 */
function computeStability(input) {
  const metrics = input?.metrics || {};
  const flags = input?.flags || {};

  const storehouseMonths = toBoundedNumber(
    metrics.storehouseMonthsCovered,
    0,
    0
  );
  const storehouseScore = toStorehouseScore(storehouseMonths);

  const mealReadinessScore = toBoundedNumber(
    metrics.mealReadinessScore,
    50,
    0,
    100
  );
  const cleaningCoverageScore = toBoundedNumber(
    metrics.cleaningCoverageScore,
    50,
    0,
    100
  );
  const gardenSupportScore = toBoundedNumber(
    metrics.gardenSupportScore,
    50,
    0,
    100
  );
  const preservationCapacityScore = toBoundedNumber(
    metrics.preservationCapacityScore,
    50,
    0,
    100
  );
  const financialMarginScore = toBoundedNumber(
    metrics.financialMarginScore,
    50,
    0,
    100
  );
  const routineConsistencyScore = toBoundedNumber(
    metrics.routineConsistencyScore,
    50,
    0,
    100
  );
  const healthBaselineScore = toBoundedNumber(
    metrics.healthBaselineScore,
    50,
    0,
    100
  );
  const relationshipSupportScore = toBoundedNumber(
    metrics.relationshipSupportScore,
    50,
    0,
    100
  );
  const crisisLoadScore = toBoundedNumber(metrics.crisisLoadScore, 50, 0, 100);
  const sabbathProtectionScore = toBoundedNumber(
    metrics.sabbathProtectionScore,
    50,
    0,
    100
  );

  const crisisStabilityScore = toCrisisStabilityScore(crisisLoadScore);

  // Flags → bonus scores
  const feastCalendarScore = flagToScore(flags.feastCalendarAligned);
  const quietHoursScore = flagToScore(flags.quietHoursRespected);
  const sabbathGuardRespectedScore = flagToScore(flags.sabbathGuardRespected);

  // Subscores
  /** @type {StabilitySubScores} */
  const subScores = {
    food: safeAverage([
      storehouseScore * 1.5,
      mealReadinessScore * 1.5,
      preservationCapacityScore,
      gardenSupportScore,
    ]),

    calendar: safeAverage([
      feastCalendarScore * 1.2,
      sabbathProtectionScore * 1.2,
      routineConsistencyScore,
      crisisStabilityScore * 0.5,
    ]),

    routine: safeAverage([
      cleaningCoverageScore * 1.3,
      routineConsistencyScore * 1.3,
      sabbathGuardRespectedScore,
      quietHoursScore,
    ]),

    health: safeAverage([
      healthBaselineScore * 1.2,
      crisisStabilityScore,
      sabbathProtectionScore * 0.5,
    ]),

    finance: safeAverage([financialMarginScore * 1.5, storehouseScore * 0.7]),

    relationships: safeAverage([
      relationshipSupportScore * 1.2,
      crisisStabilityScore * 0.8,
    ]),
  };

  // Overall stability index – weighted blend of subscores.
  const stabilityIndex = safeAverage([
    subScores.food * 1.5,
    subScores.calendar,
    subScores.routine * 1.2,
    subScores.health,
    subScores.finance,
    subScores.relationships,
  ]);

  const band = classifyBand(stabilityIndex);

  // Alerts
  /** @type {StabilityAlert[]} */
  const alerts = [];

  if (storehouseMonths < 1) {
    alerts.push({
      code: "LOW_STOREHOUSE_CRITICAL",
      level: "critical",
      message:
        "Storehouse coverage is below 1 month. Prioritize staple restocking.",
    });
  } else if (storehouseMonths < 3) {
    alerts.push({
      code: "LOW_STOREHOUSE",
      level: "warning",
      message:
        "Storehouse coverage is under 3 months. Plan a restocking session soon.",
    });
  }

  if (mealReadinessScore < 60) {
    alerts.push({
      code: "MEAL_READINESS_LOW",
      level: "warning",
      message:
        "Meal readiness is low. Consider batch cooking or a simple menu reset.",
    });
  }

  if (cleaningCoverageScore < 50) {
    alerts.push({
      code: "CLEANING_COVERAGE_LOW",
      level: "warning",
      message:
        "Cleaning routines are falling behind. A reset session can restore order.",
    });
  }

  if (crisisLoadScore > 70) {
    alerts.push({
      code: "CRISIS_LOAD_HIGH",
      level: "critical",
      message:
        "Crisis/chaos load is high. Reduce extra tasks and protect rest windows.",
    });
  }

  if (financialMarginScore < 40) {
    alerts.push({
      code: "FINANCIAL_MARGIN_LOW",
      level: "warning",
      message:
        "Financial margin is tight. Consider a budget and storehouse-first planning session.",
    });
  }

  if (sabbathProtectionScore < 60) {
    alerts.push({
      code: "SABBATH_WEAK",
      level: "info",
      message:
        "Sabbath protection is weak. Strengthening it may improve overall stability.",
    });
  }

  // Recommendations / Next-best actions
  /** @type {StabilityRecommendation[]} */
  const recommendations = [];

  if (storehouseMonths < 3) {
    recommendations.push({
      id: "rebuild-storehouse-3m",
      label: "Plan a 3-month staple restock session",
      domain: "storehouse",
      sessionTemplateKey: "storehouse.restock-3-month",
      priority: storehouseMonths < 1 ? "critical" : "high",
    });
  }

  if (mealReadinessScore < 70) {
    recommendations.push({
      id: "batch-cooking-basics",
      label: "Schedule a batch cooking basics session for everyday meals",
      domain: "cooking",
      sessionTemplateKey: "cooking.batch-basics",
      priority: "high",
    });
  }

  if (cleaningCoverageScore < 70 || routineConsistencyScore < 70) {
    recommendations.push({
      id: "reset-cleaning-routines",
      label: "Run a weekly cleaning + routine reset session",
      domain: "cleaning",
      sessionTemplateKey: "cleaning.weekly-reset",
      priority: "medium",
    });
  }

  if (gardenSupportScore < 60) {
    recommendations.push({
      id: "align-garden-to-seasons",
      label: "Align garden sowing/harvest to the scriptural seasons",
      domain: "garden",
      sessionTemplateKey: "garden.seasonal-alignment",
      priority: "medium",
    });
  }

  if (preservationCapacityScore < 60 && storehouseMonths >= 3) {
    recommendations.push({
      id: "boost-preservation",
      label:
        "Plan a preservation training session (canning, dehydrating, freezing)",
      domain: "preservation",
      sessionTemplateKey: "preservation.training-overview",
      priority: "medium",
    });
  }

  if (relationshipSupportScore < 65) {
    recommendations.push({
      id: "relationship-reset",
      label: "Schedule a simple home gathering or family check-in night",
      domain: "stability",
      sessionTemplateKey: "stability.relationship-checkin",
      priority: "medium",
    });
  }

  if (!flags.sabbathGuardRespected || sabbathProtectionScore < 60) {
    recommendations.push({
      id: "protect-sabbath-rhythm",
      label: "Protect Sabbath windows and reduce non-essential tasks",
      domain: "stability",
      sessionTemplateKey: "stability.sabbath-protection",
      priority: "high",
    });
  }

  // Status summary text
  const periodLabel =
    input?.period?.yearLabel ||
    `${input?.period?.startDate || ""} – ${
      input?.period?.endDate || ""
    }`.trim();
  const statusSummary = [
    periodLabel
      ? `Stability for ${periodLabel}: ${band.toUpperCase()}.`
      : `Stability band: ${band.toUpperCase()}.`,
    `Overall index is ${Math.round(
      stabilityIndex
    )}. Storehouse coverage is ~${storehouseMonths.toFixed(
      1
    )} months and meal readiness is ${Math.round(mealReadinessScore)}.`,
    alerts.length
      ? `There are ${alerts.length} alert(s) to review and ${recommendations.length} suggested next step(s).`
      : `No major alerts detected. Consider the recommended next steps to keep building stability.`,
  ].join(" ");

  return {
    stabilityIndex: Math.round(stabilityIndex),
    band,
    subScores: {
      food: Math.round(subScores.food),
      calendar: Math.round(subScores.calendar),
      routine: Math.round(subScores.routine),
      health: Math.round(subScores.health),
      finance: Math.round(subScores.finance),
      relationships: Math.round(subScores.relationships),
    },
    statusSummary,
    alerts,
    recommendations,
    generatedAt: new Date().toISOString(),
    version: "1.0.0",
  };
}

/* -------------------------------------------------------------------------- */
/*  Shim entrypoint                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Shim entrypoint used by the Reasoner / PlanningGraph runtime.
 *
 * @param {ShimRequest} request
 * @returns {Promise<ShimResponse>}
 */
async function runHouseholdStabilityCalculatorShim(request) {
  const nodeKey = request?.nodeKey || "household-stability";
  const rawInput = request?.payload?.input;

  if (!rawInput || typeof rawInput !== "object") {
    const error = new Error(
      "HouseholdStabilityCalculatorShim: missing or invalid `payload.input`."
    );
    // We keep errors local to the shim; callers can catch if needed.
    throw error;
  }

  /** @type {StabilityInput} */
  const input = rawInput;

  const output = computeStability(input);

  const response = {
    nodeKey,
    input,
    output,
  };

  // Emit an event for observability / downstream listeners.
  if (emitEvent) {
    try {
      emitEvent({
        type: "stability.calculated",
        ts: new Date().toISOString(),
        source: "calculators/stability/HouseholdStabilityCalculator",
        data: response,
      });
    } catch (err) {
      // Swallow to avoid breaking the shim if eventBus fails.
      // eslint-disable-next-line no-console
      console.warn(
        "HouseholdStabilityCalculatorShim: failed to emit event",
        err
      );
    }
  }

  return response;
}

/* -------------------------------------------------------------------------- */
/*  Exports                                                                   */
/* -------------------------------------------------------------------------- */

module.exports = {
  id: "HouseholdStabilityCalculatorShim",
  label: "Household Stability Calculator Shim",
  kind: "calculator-shim",
  run: runHouseholdStabilityCalculatorShim,
};

export const run = runHouseholdStabilityCalculatorShim;

export default {
  id: "HouseholdStabilityCalculatorShim",
  label: "Household Stability Calculator Shim",
  kind: "calculator-shim",
  run,
};
