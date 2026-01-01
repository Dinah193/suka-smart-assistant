// C:\Users\larho\suka-smart-assistant\src\features\calculators\health\MovementIntensityCalculator\MovementIntensityCalculator.shim.js

/**
 * MovementIntensityCalculator.shim.js
 *
 * Pure logic shim for converting household tasks + movement history
 * (steps, heart rate, sessions) into energy expenditure and intensity metrics.
 *
 * How this fits into SSA:
 * - Accepts a structured `input` payload (validated by MovementIntensityCalculator.schema.json).
 * - Computes:
 *    - Movement intensity score + category.
 *    - Weekly movement minute targets (light/moderate/vigorous).
 *    - Zone breakdown (for mixing intensities).
 *    - Approximate energy expenditure and training load.
 *    - Recovery/load flags.
 *    - Movement session templates suitable for SessionRunner sessions.
 * - Emits calculator events via the SSA event bus:
 *    - calculator.movementIntensity.calculated
 *    - calculator.movementIntensity.error
 * - Optionally exports results to the Suka Village Family Fund Hub when
 *   `familyFundMode === true`, via HubPacketFormatter + FamilyFundConnector.
 *
 * This file is UI-free and safe to run:
 * - In Web Workers.
 * - As part of nightly/automation passes.
 * - From SessionRunner prep flows.
 */

import { emit } from "@/services/eventBus";
import { familyFundMode } from "@/services/featureFlags";
import HubPacketFormatter from "@/services/hub/HubPacketFormatter";
import FamilyFundConnector from "@/services/hub/FamilyFundConnector";

export const NODE_ID = "health.movementIntensityCalculator";
export const CALC_VERSION = "1.0.0";

/**
 * Safely coerce a value to a finite number, or 0.
 * @param {unknown} v
 * @returns {number}
 */
function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Clamp a number between [min, max].
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Compute an approximate metabolic equivalent (MET) for each activity tier.
 * These are simple, conservative approximations for household planning use.
 */
const MET_LIGHT = 2.5; // easy walking / household chores
const MET_MODERATE = 4.5; // brisk walking, moderate chores
const MET_VIGOROUS = 7.5; // running, intense cardio

/**
 * Convert MET-minutes to calories using the standard formula:
 * kcal = (MET * 3.5 * weightKg / 200) * minutes
 *
 * @param {number} met
 * @param {number} minutes
 * @param {number} weightKg
 * @returns {number}
 */
function metMinutesToCalories(met, minutes, weightKg) {
  if (!minutes || !weightKg || minutes <= 0 || weightKg <= 0) return 0;
  const mins = Math.max(0, minutes);
  return (met * 3.5 * weightKg * mins) / 200;
}

/**
 * Estimate equivalent guideline minutes:
 * - moderateMinutes + 2 * vigorousMinutes
 * This is a common heuristic for combining intensities.
 *
 * @param {number} moderateMinutes
 * @param {number} vigorousMinutes
 * @returns {number}
 */
function toGuidelineEquivalentMinutes(moderateMinutes, vigorousMinutes) {
  return toNum(moderateMinutes) + 2 * toNum(vigorousMinutes);
}

/**
 * Determine movement intensity category from composite score.
 * Score is 0–100, but this helper does not enforce that; it assumes caller clamps.
 *
 * @param {number} score
 * @returns {"very-low"|"low"|"moderate"|"high"|"athlete"}
 */
function categorizeIntensity(score) {
  if (score < 20) return "very-low";
  if (score < 40) return "low";
  if (score < 65) return "moderate";
  if (score < 85) return "high";
  return "athlete";
}

/**
 * Infer training load trend from two 7-day windows of guideline-equivalent minutes.
 *
 * @param {number} prev7
 * @param {number} last7
 * @returns {"decreasing"|"stable"|"increasing"|"spiking"}
 */
function inferTrainingLoadTrend(prev7, last7) {
  const p = toNum(prev7);
  const l = toNum(last7);
  if (p <= 0 && l <= 0) return "stable";
  if (p <= 0 && l > 0) return "increasing";

  const ratio = l / p;

  if (ratio < 0.8) return "decreasing";
  if (ratio <= 1.2) return "stable";
  if (ratio <= 1.6) return "increasing";
  return "spiking";
}

/**
 * Export results to the Family Fund Hub if feature flag is on.
 *
 * @param {object} payload - { meta, input, output }
 * @returns {Promise<void>}
 */
async function exportToHubIfEnabled(payload) {
  if (!familyFundMode) return;
  try {
    const packet = HubPacketFormatter.formatCalculatorResult({
      nodeId: NODE_ID,
      calculator: "movementIntensity",
      meta: payload.meta,
      input: payload.input,
      output: payload.output,
    });

    await FamilyFundConnector.send(packet);

    emit({
      type: "session.exported",
      ts: new Date().toISOString(),
      source:
        "features/calculators/health/MovementIntensityCalculator/MovementIntensityCalculator.shim",
      data: {
        nodeId: NODE_ID,
        meta: payload.meta,
        kind: "calculator.movementIntensity",
      },
    });
  } catch (err) {
    // Hub export failure should never break household-local flows
    // eslint-disable-next-line no-console
    console.warn(
      "[MovementIntensityCalculator.shim] Hub export failed (non-fatal):",
      err
    );
  }
}

/**
 * Core calculation function for movement intensity.
 *
 * @param {object} rawInput - Input object matching MovementIntensityCalculator.schema.json's `input` shape.
 * @param {object} [options]
 * @param {boolean} [options.exportToHub=false] - Whether to attempt Family Fund Hub export (still gated by familyFundMode).
 *
 * @returns {Promise<{ meta: object, input: object, output: object }>}
 */
export async function runMovementIntensityCalculatorShim(
  rawInput,
  options = {}
) {
  const ts = new Date().toISOString();

  // Defensive input guard
  if (!rawInput || typeof rawInput !== "object") {
    const errMsg = "[MovementIntensityCalculator.shim] input must be a non-null object.";
    emit({
      type: "calculator.movementIntensity.error",
      ts,
      source:
        "features/calculators/health/MovementIntensityCalculator/MovementIntensityCalculator.shim",
      data: {
        nodeId: NODE_ID,
        error: errMsg,
        input: null,
      },
    });
    throw new Error(errMsg);
  }

  const input = { ...rawInput };

  const unitSystem = input.unitSystem === "metric" ? "metric" : "imperial";
  const bodyWeight = toNum(input.bodyWeight);
  const age = toNum(input.age);
  const baselineStepGoalPerDay = toNum(
    input.baselineStepGoalPerDay || 8000
  );

  const stepHistory = Array.isArray(input.stepHistory)
    ? input.stepHistory
    : [];

  const sessionHistory = Array.isArray(input.sessionHistory)
    ? input.sessionHistory
    : [];

  // Convert weight to kg for energy formulas
  const weightKg =
    unitSystem === "imperial" ? bodyWeight * 0.45359237 : bodyWeight;

  // ---------------------------------------------------------------------------
  // Aggregate recent movement from stepHistory
  // ---------------------------------------------------------------------------
  const daysCount = stepHistory.length;
  let totalSteps7 = 0;
  let totalLightMin7 = 0;
  let totalModerateMin7 = 0;
  let totalVigorousMin7 = 0;
  let totalEqMin7 = 0;

  let totalStepsAll = 0;
  let totalLightMinAll = 0;
  let totalModerateMinAll = 0;
  let totalVigorousMinAll = 0;
  let totalEqMinAll = 0;

  // Keep last 14 days guideline-equivalent minutes to compute trend
  const guidelineSeries = [];

  stepHistory
    .slice()
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""))
    .forEach((day) => {
      const steps = toNum(day.steps);
      const light = toNum(day.activeMinutesLight);
      const moderate = toNum(day.activeMinutesModerate);
      const vigorous = toNum(day.activeMinutesVigorous);

      totalStepsAll += steps;
      totalLightMinAll += light;
      totalModerateMinAll += moderate;
      totalVigorousMinAll += vigorous;

      const eqMin = toGuidelineEquivalentMinutes(moderate, vigorous);
      totalEqMinAll += eqMin;
      guidelineSeries.push(eqMin);
    });

  // Focus on last 7 days for core metrics
  const last7 = guidelineSeries.slice(-7);
  const prev7 = guidelineSeries.slice(-14, -7);

  last7.forEach((eqMin) => (totalEqMin7 += toNum(eqMin)));

  // For minutes, also slice last 7 days, using stepHistory ordering
  const last7Days = stepHistory
    .slice()
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""))
    .slice(-7);

  last7Days.forEach((day) => {
    const light = toNum(day.activeMinutesLight);
    const moderate = toNum(day.activeMinutesModerate);
    const vigorous = toNum(day.activeMinutesVigorous);
    const steps = toNum(day.steps);

    totalSteps7 += steps;
    totalLightMin7 += light;
    totalModerateMin7 += moderate;
    totalVigorousMin7 += vigorous;
  });

  const avgStepsPerDay7 =
    last7Days.length > 0 ? totalSteps7 / last7Days.length : 0;

  // ---------------------------------------------------------------------------
  // Guideline targets & deficit
  // ---------------------------------------------------------------------------
  const targetModerateMinutesPerWeek = 150; // baseline guideline
  const targetVigorousMinutesPerWeek = 75; // common guideline pair

  const guidelineEquivalentTarget = targetModerateMinutesPerWeek; // we treat as 150 eq-min baseline

  const combinedGuidelineEquivalentMinutesPerWeek = totalEqMin7;
  const deficitToGuidelineMinutes =
    guidelineEquivalentTarget - combinedGuidelineEquivalentMinutesPerWeek;

  // ---------------------------------------------------------------------------
  // Intensity score & category
  // ---------------------------------------------------------------------------
  // Combine ratio to step goal + guideline minutes + simple age weighting
  let scoreComponents = 0;
  let scoreWeightSum = 0;

  const stepGoalRatio =
    baselineStepGoalPerDay > 0
      ? clamp(avgStepsPerDay7 / baselineStepGoalPerDay, 0, 2)
      : 0;

  // Steps component (0–50)
  const stepsScore = clamp(stepGoalRatio * 50, 0, 50);
  scoreComponents += stepsScore;
  scoreWeightSum += 1;

  // Guideline minutes component (0–40)
  const guidelineRatio = clamp(
    combinedGuidelineEquivalentMinutesPerWeek / guidelineEquivalentTarget,
    0,
    2
  );
  const guidelineScore = clamp(guidelineRatio * 40, 0, 40);
  scoreComponents += guidelineScore;
  scoreWeightSum += 1;

  // Age weighting (older ages bias slightly toward lower intensity for same load)
  // Simple gentle adjustment: reduce score for advanced age if intensity is high.
  let ageAdjustment = 0;
  if (age > 60 && guidelineRatio > 1) {
    ageAdjustment = -5;
  } else if (age < 30 && guidelineRatio < 1) {
    ageAdjustment = 5;
  }

  let movementIntensityScore =
    scoreWeightSum > 0 ? scoreComponents / scoreWeightSum + ageAdjustment : 0;
  movementIntensityScore = clamp(movementIntensityScore, 0, 100);
  const movementIntensityCategory = categorizeIntensity(
    movementIntensityScore
  );

  // ---------------------------------------------------------------------------
  // Zone breakdown (simple mapping from light/moderate/vigorous)
  // ---------------------------------------------------------------------------
  // Map:
  //   light   -> mostly Zone 1–2
  //   moderate-> Zone 3
  //   vigorous-> Zone 4–5 split
  const zoneModel = "rpe-5z";

  const zone1 = Math.round(totalLightMin7 * 0.6);
  const zone2 = Math.max(0, totalLightMin7 - zone1);
  const zone3 = totalModerateMin7;
  const zone4 = Math.round(totalVigorousMin7 * 0.6);
  const zone5 = Math.max(0, totalVigorousMin7 - zone4);

  const weeklyMinutesByZone = {
    zone1: toNum(zone1),
    zone2: toNum(zone2),
    zone3: toNum(zone3),
    zone4: toNum(zone4),
    zone5: toNum(zone5),
  };

  // ---------------------------------------------------------------------------
  // Calorie & load estimates
  // ---------------------------------------------------------------------------
  // Use weekly minutes from step history; we assume the majority of
  // 'movement' is captured by these light/moderate/vigorous buckets.
  const activityCaloriesFromSteps7 =
    metMinutesToCalories(MET_LIGHT, totalLightMin7, weightKg) +
    metMinutesToCalories(MET_MODERATE, totalModerateMin7, weightKg) +
    metMinutesToCalories(MET_VIGOROUS, totalVigorousMin7, weightKg);

  // Include sessionHistory contributions if they have explicit calories,
  // otherwise approximate based on intensityTag and duration.
  let sessionCalories7 = 0;
  let trainingLoadScore7d = 0;

  const sevenDaysAgo = last7Days.length
    ? last7Days[0].date // earliest date in the last7 window
    : null;

  sessionHistory.forEach((sess) => {
    if (!sess || !sess.dateTime) return;
    const sessDate = new Date(sess.dateTime);

    // Only count sessions in the last 7-ish days window
    if (sevenDaysAgo && sessDate.toISOString().slice(0, 10) < sevenDaysAgo) {
      return;
    }

    const duration = toNum(sess.durationMinutes);
    const intensityTag = sess.intensityTag || "light";

    const explicitCalories = toNum(sess.caloriesEstimated);
    if (explicitCalories > 0) {
      sessionCalories7 += explicitCalories;
    } else {
      let met = MET_LIGHT;
      let loadMultiplier = 0.5;
      switch (intensityTag) {
        case "very-light":
          met = MET_LIGHT * 0.7;
          loadMultiplier = 0.3;
          break;
        case "light":
          met = MET_LIGHT;
          loadMultiplier = 0.5;
          break;
        case "moderate":
          met = MET_MODERATE;
          loadMultiplier = 1;
          break;
        case "vigorous":
          met = MET_VIGOROUS;
          loadMultiplier = 1.7;
          break;
        case "maximal":
          met = MET_VIGOROUS * 1.2;
          loadMultiplier = 2.2;
          break;
        default:
          break;
      }

      sessionCalories7 += metMinutesToCalories(met, duration, weightKg);
      trainingLoadScore7d += duration * loadMultiplier;
    }
  });

  const estimatedWeeklyActivityCalories =
    activityCaloriesFromSteps7 + sessionCalories7;

  const estimatedDailyActivityCalories =
    last7Days.length > 0
      ? estimatedWeeklyActivityCalories / last7Days.length
      : 0;

  // Approximate NEAT as a fraction of light minutes
  const nonExerciseActivityCaloriesPerDay =
    last7Days.length > 0
      ? metMinutesToCalories(
          MET_LIGHT,
          totalLightMin7 / last7Days.length,
          weightKg
        )
      : 0;

  // If we have at least some guideline history, refine training load score using guideline minutes
  if (totalEqMin7 > 0) {
    trainingLoadScore7d += totalEqMin7;
  }

  const prev7Sum = prev7.reduce((sum, eqmin) => sum + toNum(eqmin), 0);
  const trainingLoadTrend = inferTrainingLoadTrend(prev7Sum, totalEqMin7);

  const calorieAndLoadEstimates = {
    estimatedDailyActivityCalories,
    estimatedWeeklyActivityCalories,
    nonExerciseActivityCaloriesPerDay,
    trainingLoadScore7d,
    trainingLoadTrend,
  };

  // ---------------------------------------------------------------------------
  // Recovery & load flags
  // ---------------------------------------------------------------------------
  const healthRiskFlags = input.healthRiskFlags || {};
  const sleepQualityFlags = input.sleepQualityFlags || {};

  const overreachingRisk =
    trainingLoadTrend === "spiking" &&
    (healthRiskFlags.cardioRisk ||
      sleepQualityFlags.sleepDebtHigh ||
      sleepQualityFlags.sleepFragmented);

  const undertrainingRisk =
    combinedGuidelineEquivalentMinutesPerWeek <
    guidelineEquivalentTarget * 0.5;

  const zone4And5 = weeklyMinutesByZone.zone4 + weeklyMinutesByZone.zone5;
  const recoveryDayRecommended =
    overreachingRisk || zone4And5 > 60 || sleepQualityFlags.sleepDebtHigh;

  let recoveryNotes = "";
  if (overreachingRisk) {
    recoveryNotes =
      "Recent movement load jumped quickly. Consider a lower-intensity day and extra sleep.";
  } else if (undertrainingRisk) {
    recoveryNotes =
      "Movement levels are well below guideline suggestions. Gentle, consistent sessions may help.";
  } else if (recoveryDayRecommended) {
    recoveryNotes =
      "You may benefit from a low-intensity or recovery day before heavy movement.";
  } else {
    recoveryNotes =
      "Your movement and recovery look balanced based on recent trends.";
  }

  const recoveryLoadFlags = {
    overreachingRisk,
    undertrainingRisk,
    recoveryDayRecommended,
    notes: recoveryNotes,
  };

  // ---------------------------------------------------------------------------
  // Movement minute targets (light/moderate/vigorous)
  // ---------------------------------------------------------------------------
  // Start from baseline guidelines but allow gentle scaling based on risks.
  let lightMinutesPerWeek = 60; // "incidental" movement
  let moderateMinutesPerWeek = targetModerateMinutesPerWeek;
  let vigorousMinutesPerWeek = targetVigorousMinutesPerWeek;

  if (healthRiskFlags.cardioRisk) {
    // More conservative if cardio risk flagged
    moderateMinutesPerWeek = Math.round(targetModerateMinutesPerWeek * 0.75);
    vigorousMinutesPerWeek = Math.round(targetVigorousMinutesPerWeek * 0.5);
    lightMinutesPerWeek += 30;
  }

  if (undertrainingRisk) {
    // Suggest a gentle ramp if they are far below guidelines
    moderateMinutesPerWeek = Math.round(targetModerateMinutesPerWeek * 0.7);
    vigorousMinutesPerWeek = Math.round(targetVigorousMinutesPerWeek * 0.5);
    lightMinutesPerWeek += 30;
  }

  if (!undertrainingRisk && !healthRiskFlags.cardioRisk) {
    // If they are around or above guidelines and not high-risk, allow a slight
    // bump for users with "high" or "athlete" scores.
    if (movementIntensityCategory === "high") {
      moderateMinutesPerWeek = Math.round(
        targetModerateMinutesPerWeek * 1.1
      );
    } else if (movementIntensityCategory === "athlete") {
      moderateMinutesPerWeek = Math.round(
        targetModerateMinutesPerWeek * 1.3
      );
      vigorousMinutesPerWeek = Math.round(
        targetVigorousMinutesPerWeek * 1.3
      );
    }
  }

  const movementMinutesTargets = {
    lightMinutesPerWeek,
    moderateMinutesPerWeek,
    vigorousMinutesPerWeek,
    combinedGuidelineEquivalentMinutesPerWeek,
    deficitToGuidelineMinutes,
  };

  // ---------------------------------------------------------------------------
  // Movement Session Templates for SessionRunner
  // ---------------------------------------------------------------------------
  const movementPreferences = input.movementPreferences || {};
  const preferredBlock =
    toNum(movementPreferences.preferredSessionBlockMinutes) || 20;

  const templates = [];

  // 1) Easy walk / low-intensity option
  templates.push({
    templateId: "movement.easy-walk-20",
    title: "20-min Easy Walk",
    recommendedPerWeek: undertrainingRisk ? 5 : 3,
    durationMinutes: clamp(preferredBlock, 10, 30),
    intensityCategory: "light",
    domain: "movement",
    source: {
      type: "movementPlan",
      refId: null,
    },
  });

  // 2) Mixed moderate block
  templates.push({
    templateId: "movement.mixed-moderate-30",
    title: "30-min Mixed Moderate Block",
    recommendedPerWeek:
      movementIntensityCategory === "very-low" ||
      movementIntensityCategory === "low"
        ? 2
        : 3,
    durationMinutes: clamp(preferredBlock + 10, 20, 40),
    intensityCategory: "moderate",
    domain: "movement",
    source: {
      type: "movementPlan",
      refId: null,
    },
  });

  // 3) Higher-intensity block only for non-high-risk users
  if (!healthRiskFlags.cardioRisk && !healthRiskFlags.jointPainRisk) {
    templates.push({
      templateId: "movement.vigorous-interval-20",
      title: "20-min Vigorous Intervals",
      recommendedPerWeek:
        movementIntensityCategory === "athlete" ? 2 : 1,
      durationMinutes: clamp(preferredBlock, 15, 30),
      intensityCategory: "vigorous",
      domain: "movement",
      source: {
        type: "movementPlan",
        refId: null,
      },
    });
  }

  const output = {
    movementIntensityScore,
    movementIntensityCategory,
    movementMinutesTargets,
    movementZoneBreakdown: {
      zoneModel,
      weeklyMinutesByZone,
    },
    calorieAndLoadEstimates,
    recoveryLoadFlags,
    movementSessionTemplates: templates,
  };

  const meta = {
    nodeId: NODE_ID,
    calculationVersion: CALC_VERSION,
    timestamp: ts,
  };

  const payload = {
    meta,
    input,
    output,
  };

  // Emit calculator success event
  emit({
    type: "calculator.movementIntensity.calculated",
    ts,
    source:
      "features/calculators/health/MovementIntensityCalculator/MovementIntensityCalculator.shim",
    data: {
      nodeId: NODE_ID,
      meta,
      input,
      output,
    },
  });

  // Optionally export to Hub (non-blocking failure)
  if (options.exportToHub) {
    // Fire and forget; no await needed for the caller, but we keep async signature
    exportToHubIfEnabled(payload).catch(() => {});
  }

  return payload;
}

/**
 * Default export for shim-style usage.
 * Allows a consistent pattern across all SSA calculators:
 *
 * import MovementIntensityCalculatorShim from "./MovementIntensityCalculator.shim";
 * const payload = await MovementIntensityCalculatorShim.run(input, { exportToHub: true });
 */
const MovementIntensityCalculatorShim = {
  NODE_ID,
  CALC_VERSION,
  /**
   * Run the movement intensity calculator.
   * @param {object} input
   * @param {object} [options]
   * @returns {Promise<{ meta: object, input: object, output: object }>}
   */
  async run(input, options) {
    return runMovementIntensityCalculatorShim(input, options);
  },
};

export default MovementIntensityCalculatorShim;
