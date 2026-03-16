// C:\Users\larho\suka-smart-assistant\src\features\calculators\storehouseMeals\BatchYieldCalculator\BatchYieldCalculator.shim.js
/**
 * BatchYieldCalculator Shim
 *
 * HOW THIS FITS:
 * - This shim is the pure logic + orchestration layer for the Batch Yield Calculator node
 *   in the SSA Planning Graph.
 * - It receives normalized input (see BatchYieldCalculator.schema.json), computes:
 *   - batchPortionYield
 *   - batchContainerPlan
 *   - batchInventoryDelta
 *   - batchLabelingHints
 *   - batchNutritionPerPortion (rough estimates / hooks)
 * - It then:
 *   - emits calculator.batchYield.calculated|calculator.batchYield.error via eventBus
 *   - optionally exports a summary to the Hub when familyFundMode is enabled
 *
 * RUNTIME:
 * - Designed to run in a Web Worker or background task as a pure function of input.
 * - No direct DOM usage; safe to call while SessionRunner or other flows are active.
 */

import { emit } from "@/services/events/eventBus";
import { familyFundMode } from "@/config/featureFlags";
import { HubPacketFormatter, FamilyFundConnector } from "@/services/hub";

/**
 * @typedef {import("./BatchYieldCalculator.schema.json")} BatchYieldSchema
 */

/**
 * Safely get a numeric value or null.
 * @param {unknown} v
 * @returns {number|null}
 */
function toNumberOrNull(v) {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && !Number.isNaN(n) ? n : null;
}

/**
 * Compute a scale factor for the batch based on the scaling target and base yield.
 *
 * @param {object} baseYield
 * @param {object} batchScalingTarget
 * @param {object} portioningPreferences
 * @param {Array<object>} containerCatalog
 * @returns {{ scaleFactor: number, modeUsed: string }}
 */
function computeScaleFactor(
  baseYield,
  batchScalingTarget,
  portioningPreferences,
  containerCatalog
) {
  const baseServings = toNumberOrNull(baseYield?.servings) || 1;
  const baseServingGrams = toNumberOrNull(baseYield?.servingSizeGrams) || 250;

  if (!batchScalingTarget || !batchScalingTarget.mode) {
    return { scaleFactor: 1, modeUsed: "default" };
  }

  const mode = batchScalingTarget.mode;

  if (mode === "scaleFactor") {
    const sf = toNumberOrNull(batchScalingTarget.scaleFactor);
    return { scaleFactor: sf && sf > 0 ? sf : 1, modeUsed: "scaleFactor" };
  }

  if (mode === "servings") {
    const targetServings = toNumberOrNull(batchScalingTarget.targetServings);
    if (!targetServings || targetServings <= 0) {
      return { scaleFactor: 1, modeUsed: "fallback.servings.invalid" };
    }
    return {
      scaleFactor: targetServings / baseServings,
      modeUsed: "servings",
    };
  }

  if (mode === "containers") {
    const targetContainers = Array.isArray(batchScalingTarget.targetContainers)
      ? batchScalingTarget.targetContainers
      : [];

    if (!targetContainers.length || !Array.isArray(containerCatalog)) {
      return { scaleFactor: 1, modeUsed: "fallback.containers.invalid" };
    }

    const catalogById = new Map(
      containerCatalog.map((c) => [c.containerTypeId, c])
    );

    let totalBatchGramsTarget = 0;
    for (const tc of targetContainers) {
      const container = catalogById.get(tc.containerTypeId);
      if (!container) continue;
      const count = toNumberOrNull(tc.count) || 0;
      const approxWeight =
        toNumberOrNull(container.approxFoodWeightGrams) ||
        toNumberOrNull(container.approxVolumeMl) ||
        baseServingGrams * 2;
      totalBatchGramsTarget += count * approxWeight;
    }

    if (totalBatchGramsTarget <= 0) {
      return { scaleFactor: 1, modeUsed: "fallback.containers.zeroWeight" };
    }

    const baseTotalGrams = baseServings * baseServingGrams || 1;
    const sf = totalBatchGramsTarget / baseTotalGrams;
    return { scaleFactor: sf > 0 ? sf : 1, modeUsed: "containers" };
  }

  return { scaleFactor: 1, modeUsed: "fallback.unknownMode" };
}

/**
 * Compute portion yield (servings and grams) for the scaled batch.
 *
 * @param {object} baseYield
 * @param {number} scaleFactor
 * @param {object} portioningPreferences
 * @returns {object}
 */
function computeBatchPortionYield(
  baseYield,
  scaleFactor,
  portioningPreferences
) {
  const baseServings = toNumberOrNull(baseYield?.servings) || 1;
  const baseServingGrams = toNumberOrNull(baseYield?.servingSizeGrams) || 250;

  const totalServingsRaw = baseServings * (scaleFactor || 1);
  const rounding = portioningPreferences?.portionRoundingMode || "floor";

  let totalServings;
  if (rounding === "ceil") {
    totalServings = Math.ceil(totalServingsRaw);
  } else if (rounding === "nearest") {
    totalServings = Math.round(totalServingsRaw);
  } else {
    totalServings = Math.floor(totalServingsRaw);
  }

  if (totalServings < 1) totalServings = 1;

  const servingSizeGrams =
    toNumberOrNull(portioningPreferences?.defaultServingSizeGrams) ||
    baseServingGrams;

  const dist = portioningPreferences?.portionDistribution || {};
  let readyToEatServings = toNumberOrNull(dist.readyToEatServings);
  let preservedServings = toNumberOrNull(dist.preservedServings);

  if (readyToEatServings == null && preservedServings == null) {
    readyToEatServings = Math.min(4, totalServings);
    preservedServings = Math.max(0, totalServings - readyToEatServings);
  } else {
    if (readyToEatServings == null) {
      readyToEatServings = Math.max(
        0,
        totalServings - (preservedServings || 0)
      );
    }
    if (preservedServings == null) {
      preservedServings = Math.max(
        0,
        totalServings - (readyToEatServings || 0)
      );
    }

    const sum = readyToEatServings + preservedServings;
    if (sum > totalServings && sum > 0) {
      const factor = totalServings / sum;
      readyToEatServings = Math.round(readyToEatServings * factor);
      preservedServings = Math.max(0, totalServings - readyToEatServings);
    }
  }

  return {
    totalServings,
    servingSizeGrams,
    readyToEatServings,
    preservedServings,
  };
}

/**
 * Compute a container plan based on total servings and containerCatalog.
 *
 * @param {object} batchPortionYield
 * @param {Array<object>} containerCatalog
 * @param {object} batchScalingTarget
 * @returns {Array<object>}
 */
function computeBatchContainerPlan(
  batchPortionYield,
  containerCatalog,
  batchScalingTarget
) {
  if (!Array.isArray(containerCatalog) || containerCatalog.length === 0) {
    return [];
  }

  const totalServings =
    toNumberOrNull(batchPortionYield?.preservedServings) ||
    toNumberOrNull(batchPortionYield?.totalServings) ||
    0;

  if (totalServings <= 0) {
    return [];
  }

  // If containers were explicitly requested, honor those counts.
  if (
    batchScalingTarget?.mode === "containers" &&
    Array.isArray(batchScalingTarget.targetContainers) &&
    batchScalingTarget.targetContainers.length > 0
  ) {
    const catalogById = new Map(
      containerCatalog.map((c) => [c.containerTypeId, c])
    );

    const portionsPerContainer =
      totalServings /
      batchScalingTarget.targetContainers.reduce(
        (sum, tc) => sum + (toNumberOrNull(tc.count) || 0),
        1
      );

    return batchScalingTarget.targetContainers
      .map((tc) => {
        const container = catalogById.get(tc.containerTypeId);
        if (!container) return null;

        const count = toNumberOrNull(tc.count) || 0;
        if (count <= 0) return null;

        return {
          containerTypeId: container.containerTypeId,
          label: container.label,
          count,
          estimatedServingsPerContainer: portionsPerContainer,
          fillFraction:
            typeof container.maxFillFraction === "number"
              ? container.maxFillFraction
              : 0.9,
          preservationMethod:
            container.preferredPreservationMethod || "unspecified",
          storageLocation: container.storageLocation || "unspecified",
        };
      })
      .filter(Boolean);
  }

  // Simple greedy fill of preserved servings across containers.
  const plan = [];
  let remainingServings = totalServings;

  const sorted = [...containerCatalog].sort(
    (a, b) =>
      (toNumberOrNull(a.approxFoodWeightGrams) || 0) -
      (toNumberOrNull(b.approxFoodWeightGrams) || 0)
  );

  for (const container of sorted) {
    if (remainingServings <= 0) break;

    const approxWeight = toNumberOrNull(container.approxFoodWeightGrams) || 0;
    const servingSizeGrams =
      toNumberOrNull(batchPortionYield?.servingSizeGrams) || 250;
    const approxServingsPerContainer = approxWeight
      ? approxWeight / servingSizeGrams
      : 2;

    const count = Math.floor(remainingServings / approxServingsPerContainer);
    if (count <= 0) continue;

    plan.push({
      containerTypeId: container.containerTypeId,
      label: container.label,
      count,
      estimatedServingsPerContainer: approxServingsPerContainer,
      fillFraction:
        typeof container.maxFillFraction === "number"
          ? container.maxFillFraction
          : 0.9,
      preservationMethod:
        container.preferredPreservationMethod || "unspecified",
      storageLocation: container.storageLocation || "unspecified",
    });

    remainingServings -= count * approxServingsPerContainer;
  }

  return plan;
}

/**
 * Compute inventory deltas from ingredients and container plan.
 *
 * @param {Array<object>} ingredients
 * @param {number} scaleFactor
 * @param {Array<object>} containerPlan
 * @returns {{ ingredientsConsumed: Array<object>, itemsProduced: Array<object> }}
 */
function computeInventoryDelta(ingredients, scaleFactor, containerPlan) {
  const ingredientsConsumed = Array.isArray(ingredients)
    ? ingredients
        .filter((ing) => ing.inventoryItemId)
        .map((ing) => ({
          inventoryItemId: ing.inventoryItemId,
          label: ing.name,
          quantityChange: -(
            (toNumberOrNull(ing.quantity) || 0) * (scaleFactor || 1)
          ),
          unit: ing.unit || "unit",
        }))
        .filter((l) => l.quantityChange !== 0)
    : [];

  const itemsProduced = Array.isArray(containerPlan)
    ? containerPlan.map((cp, index) => ({
        inventoryItemId: cp.containerTypeId || `batch-container-${index}`,
        label: cp.label || "Batch Container",
        quantityChange: cp.count || 0,
        unit: "container",
        location: cp.storageLocation || "unspecified",
      }))
    : [];

  return { ingredientsConsumed, itemsProduced };
}

/**
 * Compute labeling hints for labels / printer.
 *
 * @param {object} recipeDefinition
 * @param {object} batchPortionYield
 * @returns {object}
 */
function computeLabelingHints(recipeDefinition, batchPortionYield) {
  const title = recipeDefinition?.title || "Batch";
  const now = new Date();

  const preparedOn = now.toISOString();
  const useByDate = new Date(
    now.getTime() + 90 * 24 * 60 * 60 * 1000
  ).toISOString();

  const lines = [
    title,
    `Servings: ${batchPortionYield?.totalServings || "?"}`,
    `Prepared: ${now.toLocaleDateString()}`,
  ];

  return {
    primaryLabel: title,
    secondaryLabel: recipeDefinition?.variant || "",
    preparedOn,
    useByDate,
    labelLines: lines,
    notes: recipeDefinition?.notes || "",
  };
}

/**
 * Compute rough per-portion nutrition hooks. This is intentionally light and
 * designed to be refined later when full nutrition data is available.
 *
 * @param {object} macroTargets
 * @param {object} hairSupportTargets
 * @param {object} batchPortionYield
 * @returns {object}
 */
function computeBatchNutritionPerPortion(
  macroTargets,
  hairSupportTargets,
  batchPortionYield
) {
  const totalServings = toNumberOrNull(batchPortionYield?.totalServings) || 1;
  const caloriesPerDay = toNumberOrNull(macroTargets?.caloriesPerDay);
  const proteinPerDay = toNumberOrNull(macroTargets?.proteinGramsPerDay);

  const caloriesPerServing = caloriesPerDay
    ? +(caloriesPerDay / 3).toFixed(0)
    : null;
  const proteinGramsPerServing = proteinPerDay
    ? +(proteinPerDay / 3).toFixed(1)
    : null;

  const hairTarget = toNumberOrNull(hairSupportTargets?.hairSupportScoreTarget);
  const hairSupportScorePerServing = hairTarget
    ? Math.min(100, Math.max(0, hairTarget / totalServings))
    : null;

  const flags = [];
  if (proteinGramsPerServing != null && proteinGramsPerServing >= 20) {
    flags.push("high-protein-serving");
  }
  if (hairSupportScorePerServing != null && hairSupportScorePerServing >= 10) {
    flags.push("hair-supportive-serving");
  }

  return {
    caloriesPerServing,
    proteinGramsPerServing,
    fatGramsPerServing: null,
    carbGramsPerServing: null,
    hairSupportScorePerServing,
    flags,
  };
}

/**
 * Export calculator result to the Hub (if familyFundMode is enabled).
 *
 * @param {object} payload
 * @returns {Promise<void>}
 */
async function exportToHubIfEnabled(payload) {
  if (!familyFundMode) return;

  try {
    const packet = HubPacketFormatter.fromCalculatorResult({
      nodeId: "storehouseMeals.batchYieldCalculator",
      kind: "batchYield",
      payload,
    });

    await FamilyFundConnector.send(packet);
    emit({
      type: "session.exported",
      ts: new Date().toISOString(),
      source: "calculators/storehouseMeals/BatchYieldCalculator",
      data: { nodeId: "storehouseMeals.batchYieldCalculator" },
    });
  } catch (err) {
    // Fail silent per contract, but log for local diagnostics.
    // eslint-disable-next-line no-console
    console.warn(
      "[BatchYieldCalculator] Hub export failed, continuing offline.",
      err
    );
  }
}

/**
 * Core pure function: run the batch yield calculation from input to output.
 *
 * @param {object} input
 * @returns {object} output
 */
export function calculateBatchYield(input) {
  const safeInput = input || {};
  const unitSystem = safeInput.unitSystem || "imperial";
  const recipeDefinition = safeInput.recipeDefinition || {};
  const batchScalingTarget = safeInput.batchScalingTarget || {};
  const portioningPreferences = safeInput.portioningPreferences || {};
  const containerCatalog = safeInput.containerCatalog || [];
  const macroTargets = safeInput.macroTargets || null;
  const hairSupportTargets = safeInput.hairSupportTargets || null;

  const baseYield = recipeDefinition.baseYield || {};

  const { scaleFactor, modeUsed } = computeScaleFactor(
    baseYield,
    batchScalingTarget,
    portioningPreferences,
    containerCatalog
  );

  const batchPortionYield = computeBatchPortionYield(
    baseYield,
    scaleFactor,
    portioningPreferences
  );

  const batchContainerPlan = computeBatchContainerPlan(
    batchPortionYield,
    containerCatalog,
    batchScalingTarget
  );

  const { ingredientsConsumed, itemsProduced } = computeInventoryDelta(
    recipeDefinition.ingredients || [],
    scaleFactor,
    batchContainerPlan
  );

  const batchInventoryDelta = {
    ingredientsConsumed,
    itemsProduced,
  };

  const batchLabelingHints = computeLabelingHints(
    recipeDefinition,
    batchPortionYield
  );

  const batchNutritionPerPortion = computeBatchNutritionPerPortion(
    macroTargets,
    hairSupportTargets,
    batchPortionYield
  );

  return {
    unitSystem,
    scaleFactor,
    scaleModeUsed: modeUsed,
    batchPortionYield,
    batchContainerPlan,
    batchInventoryDelta,
    batchLabelingHints,
    batchNutritionPerPortion,
  };
}

/**
 * High-level shim entrypoint.
 *
 * SSA Reasoner / calculators runtime should call this function with a payload of:
 * {
 *   input: { ... },   // matches BatchYieldCalculator.schema.json > input
 *   meta?: {
 *     traceId?: string
 *     sourceNodeId?: string
 *     userId?: string
 *   }
 * }
 *
 * @param {object} payload
 * @returns {Promise<object>} full result { input, output, meta }
 */
export async function runBatchYieldCalculator(payload) {
  const ts = new Date().toISOString();
  const safePayload = payload || {};
  const input = safePayload.input || {};
  const meta = safePayload.meta || {};

  const traceId =
    meta.traceId ||
    `batch-yield-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;

  try {
    const output = calculateBatchYield(input);

    const resultEnvelope = {
      nodeId: "storehouseMeals.batchYieldCalculator",
      kind: "calculatorResult",
      traceId,
      ts,
      input,
      output,
      meta,
    };

    emit({
      type: "calculator.batchYield.calculated",
      ts,
      source: "calculators/storehouseMeals/BatchYieldCalculator",
      data: {
        traceId,
        nodeId: "storehouseMeals.batchYieldCalculator",
        outputSummary: {
          totalServings: output.batchPortionYield.totalServings,
          preservedServings: output.batchPortionYield.preservedServings,
          containerCount: output.batchContainerPlan.length,
        },
      },
    });

    await exportToHubIfEnabled(resultEnvelope);

    return resultEnvelope;
  } catch (error) {
    emit({
      type: "calculator.batchYield.error",
      ts,
      source: "calculators/storehouseMeals/BatchYieldCalculator",
      data: {
        traceId,
        message: error?.message || "Unknown batch yield error",
      },
    });

    // eslint-disable-next-line no-console
    console.error("[BatchYieldCalculator] Error computing batch yield:", error);

    throw error;
  }
}

/**
 * Back-compat export:
 * Some callers import `runBatchYieldCalculation` (older name).
 * Keep this alias so builds don't break.
 */
export const runBatchYieldCalculation = runBatchYieldCalculator;

export default {
  run: runBatchYieldCalculator,
  // back-compat (default export surface)
  runBatchYieldCalculation,
  calculate: calculateBatchYield,
};
