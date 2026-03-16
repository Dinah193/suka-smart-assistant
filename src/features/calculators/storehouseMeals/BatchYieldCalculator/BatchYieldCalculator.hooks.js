// C:\Users\larho\suka-smart-assistant\src\features\calculators\storehouseMeals\BatchYieldCalculator\BatchYieldCalculator.hooks.js
/**
 * BatchYieldCalculator.hooks
 *
 * HOW THIS FITS:
 * - Thin React hook wrapper around the BatchYieldCalculator shim.
 * - Responsibilities:
 *   • Accept structured input (recipe + scaling + portioning).
 *   • Call the shim to compute batch yield / container plan / inventory deltas.
 *   • Track loading, error, lastInput, and lastResult for the UI.
 *   • Emit calculator events on the SSA event bus.
 *   • Provide helpers to:
 *       - Build a draft Session object for SessionRunner.
 *       - Emit a freezer-planning suggestion event.
 *
 * - This is a “shim-style” hook: logic is UI-agnostic and safe to reuse
 *   across views/pages. It assumes the rest of SSA will:
 *     • Persist any Session drafts into Dexie,
 *     • Hand Session objects to SessionBuilder / SessionRunner,
 *     • Wire freezer events into your freezer-planning tools.
 */

import { useState, useCallback } from "react";
import { emit } from "@/services/events/eventBus";
import featureFlags from "@/config/featureFlags.json";
import { HubPacketFormatter, FamilyFundConnector } from "@/services/hub";
import { runBatchYieldCalculation } from "./BatchYieldCalculator.shim";
import batchYieldConfig from "./BatchYieldCalculator.config.json";

const familyFundMode = !!featureFlags?.familyFundMode;

/**
 * @typedef {Object} BatchYieldCalculatorInput
 * @property {"imperial"|"metric"} unitSystem
 * @property {Object} recipeDefinition
 * @property {string} recipeDefinition.title
 * @property {{ servings: number, servingSizeGrams: number }} recipeDefinition.baseYield
 * @property {Array<Object>} [recipeDefinition.ingredients]
 * @property {string} [recipeDefinition.notes]
 * @property {Object} batchScalingTarget
 * @property {"scaleFactor"|"servings"|"containers"} batchScalingTarget.mode
 * @property {number} [batchScalingTarget.scaleFactor]
 * @property {number} [batchScalingTarget.targetServings]
 * @property {Array<{ containerTypeId: string, count: number }>} [batchScalingTarget.targetContainers]
 * @property {Object} portioningPreferences
 * @property {"floor"|"nearest"|"ceil"} portioningPreferences.portionRoundingMode
 * @property {number} [portioningPreferences.defaultServingSizeGrams]
 * @property {{ readyToEatServings?: number, preservedServings?: number }} [portioningPreferences.portionDistribution]
 * @property {Array<Object>} containerCatalog
 * @property {Object|null} [macroTargets]
 * @property {Object|null} [hairSupportTargets]
 */

/**
 * @typedef {Object} BatchYieldCalculatorResult
 * @property {BatchYieldCalculatorInput} input
 * @property {Object} output
 * @property {{
 *   calculatorNodeId: string,
 *   recipeId?: string|null,
 *   recipeTitle?: string,
 *   createdAt: string
 * }} meta
 */

/**
 * Core hook used by BatchYieldCalculator views & orchestrators.
 *
 * @returns {{
 *   loading: boolean,
 *   error: string|null,
 *   lastInput: BatchYieldCalculatorInput|null,
 *   lastResult: BatchYieldCalculatorResult|null,
 *   runCalculation: (input: BatchYieldCalculatorInput) => Promise<BatchYieldCalculatorResult|null>,
 *   buildBatchSessionDraft: () => import("@/types").Session | null,
 *   emitFreezerPlanSuggestion: () => void
 * }}
 */
export function useBatchYieldCalculator() {
  const [loading, setLoading] = useState(false);
  const [lastInput, setLastInput] = useState(null);
  const [lastResult, setLastResult] = useState(null);
  const [error, setError] = useState(null);

  /**
   * Run the batch yield calculation via shim.
   * Emits calculator.* events and optionally exports to Hub.
   *
   * @param {BatchYieldCalculatorInput} input
   * @returns {Promise<BatchYieldCalculatorResult|null>}
   */
  const runCalculation = useCallback(async (input) => {
    const ts = new Date().toISOString();
    setLoading(true);
    setError(null);

    try {
      // Defensive checks
      if (!input || typeof input !== "object") {
        throw new Error("Batch yield calculator input is missing.");
      }
      if (!input.recipeDefinition || !input.recipeDefinition.baseYield) {
        throw new Error("Recipe definition with baseYield is required.");
      }

      emit({
        type: "calculator.batchYield.requested",
        ts,
        source: "calculators/storehouseMeals/BatchYieldCalculator.hooks",
        data: { input },
      });

      const result = await runBatchYieldCalculation(input, {
        nodeId: batchYieldConfig.nodeId,
      });

      if (!result || !result.output) {
        throw new Error("Batch yield calculation returned no output.");
      }

      setLastInput(input);
      setLastResult(result);

      emit({
        type: "calculator.batchYield.calculated",
        ts: new Date().toISOString(),
        source: "calculators/storehouseMeals/BatchYieldCalculator.hooks",
        data: {
          calculatorNodeId: batchYieldConfig.nodeId,
          input,
          output: result.output,
          meta: result.meta,
        },
      });

      // Optional Hub export when Family Fund mode is enabled
      if (familyFundMode && FamilyFundConnector?.isReady?.()) {
        try {
          const packet = HubPacketFormatter?.fromCalculatorResult?.({
            calculatorNodeId: batchYieldConfig.nodeId,
            kind: "batchYield",
            input,
            output: result.output,
            meta: result.meta,
          });

          if (packet) {
            await FamilyFundConnector.send(packet);

            emit({
              type: "session.exported",
              ts: new Date().toISOString(),
              source: "calculators/storehouseMeals/BatchYieldCalculator.hooks",
              data: {
                calculatorNodeId: batchYieldConfig.nodeId,
                hubPacketMeta: packet?.meta || null,
              },
            });
          }
        } catch (hubErr) {
          // Silently fail but log for debugging in dev tools
          if (typeof console !== "undefined") {
            // eslint-disable-next-line no-console
            console.warn("[BatchYieldCalculator] Hub export failed", hubErr);
          }
        }
      }

      return result;
    } catch (err) {
      const message =
        err && typeof err.message === "string"
          ? err.message
          : "Batch yield calculation failed.";

      setError(message);

      emit({
        type: "calculator.batchYield.error",
        ts: new Date().toISOString(),
        source: "calculators/storehouseMeals/BatchYieldCalculator.hooks",
        data: {
          message,
          input: input || null,
        },
      });

      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Build a draft Session object suitable for SessionRunner.
   * You are expected to:
   *  - Save this Session into Dexie,
   *  - Pass it into your SessionBuilder/SessionRunner,
   *  - Let the global SessionRunner handle wake-lock, PiP, etc.
   *
   * @returns {import("@/types").Session | null}
   */
  const buildBatchSessionDraft = useCallback(() => {
    if (!lastResult || !lastResult.output) return null;

    const now = new Date().toISOString();
    const tempId = `batch-${now}`;

    const timeEstimate =
      lastResult.output.batchTimeEstimate || lastResult.output.time || {};
    const totalDurationSec = Number(
      timeEstimate.totalDurationSec || timeEstimate.estimatedTotalSec || 0
    );

    const fallbackTitle =
      lastResult.meta?.recipeTitle ||
      lastResult.output.batchLabelingHints?.labelLines?.[0] ||
      "Batch Session";

    const sessionSteps =
      Array.isArray(lastResult.output.sessionSteps) &&
      lastResult.output.sessionSteps.length > 0
        ? lastResult.output.sessionSteps
        : [
            {
              id: `${tempId}-step-1`,
              title: "Prepare ingredients & equipment",
              desc: "Gather all ingredients, containers, and equipment for this batch.",
              durationSec: Math.round(totalDurationSec * 0.2) || 600,
              blockers: ["inventory", "equipment"],
              metadata: {
                tempTargetF: 0,
                donenessCue: "timer",
                cueNotes:
                  "Check you have jars/pans labeled and ready for filling.",
              },
            },
            {
              id: `${tempId}-step-2`,
              title: "Cook batch",
              desc: "Follow your batch recipe, monitoring doneness and safety cues.",
              durationSec: Math.round(totalDurationSec * 0.5) || 1800,
              blockers: ["inventory", "equipment", "quietHours"],
              metadata: {
                tempTargetF: 0,
                donenessCue: "smell",
                cueNotes: "Use your usual doneness checks for this recipe.",
              },
            },
            {
              id: `${tempId}-step-3`,
              title: "Portion & label",
              desc: "Fill containers, label with date and contents, and store in the right zone.",
              durationSec: Math.max(Math.round(totalDurationSec * 0.3), 900),
              blockers: ["equipment"],
              metadata: {
                tempTargetF: 0,
                donenessCue: "timer",
                cueNotes:
                  "Respect cooling guidelines before refrigerating or freezing.",
              },
            },
          ];

    /** @type {import("@/types").Session} */
    const draftSession = {
      id: tempId,
      domain: "cooking",
      title: `Batch: ${fallbackTitle}`,
      source: {
        type: "recipe",
        refId: lastResult.meta?.recipeId || null,
      },
      steps: sessionSteps,
      prefs: {
        voiceGuidance: true,
        haptic: true,
        autoAdvance: false,
      },
      status: "pending",
      progress: {
        currentStepIndex: 0,
        elapsedSec: 0,
        startedAt: null,
        pausedAt: null,
      },
      analytics: {
        skippedSteps: [],
        adjustments: [],
      },
      createdAt: now,
      updatedAt: now,
    };

    return draftSession;
  }, [lastResult]);

  /**
   * Emit a freezer-planning suggestion event using the most recent result.
   * SSA's freezer planner can subscribe and surface this as a suggested
   * batch to schedule for cooking/preservation.
   */
  const emitFreezerPlanSuggestion = useCallback(() => {
    if (!lastResult || !lastResult.output) return;

    const ts = new Date().toISOString();
    emit({
      type: "planner.freezer.batchYield.suggested",
      ts,
      source: "calculators/storehouseMeals/BatchYieldCalculator.hooks",
      data: {
        calculatorNodeId: batchYieldConfig.nodeId,
        batchPortionYield: lastResult.output.batchPortionYield,
        batchContainerPlan: lastResult.output.batchContainerPlan,
        batchInventoryDelta: lastResult.output.batchInventoryDelta,
        labelingHints: lastResult.output.batchLabelingHints,
        meta: lastResult.meta,
      },
    });
  }, [lastResult]);

  return {
    loading,
    error,
    lastInput,
    lastResult,
    runCalculation,
    buildBatchSessionDraft,
    emitFreezerPlanSuggestion,
  };
}

export default useBatchYieldCalculator;
