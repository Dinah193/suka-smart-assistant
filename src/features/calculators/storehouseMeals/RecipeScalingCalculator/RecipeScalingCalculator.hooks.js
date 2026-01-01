// C:\Users\larho\suka-smart-assistant\src\features\calculators\storehouseMeals\RecipeScalingCalculator\RecipeScalingCalculator.hooks.js

/**
 * RecipeScalingCalculator.hooks.js
 *
 * How this fits:
 * - React hooks for wiring RecipeScalingCalculator into SSA flows:
 *   - Scaling from UI and storing the last result
 *   - Turning a scaled recipe into a batch cooking session draft
 *   - Turning a scaled recipe into a freezer plan (portions + containers)
 *
 * - These hooks do not own any UI. They are meant to be used by:
 *   - RecipeScalingCalculator.view.jsx
 *   - BatchYieldCalculator view/hooks
 *   - Storehouse / Freezer planning pages
 *
 * - All cross-module communication uses the SSA eventBus and the
 *   standard Session object contract where relevant.
 */

import { useState, useCallback } from "react";
import { calculateRecipeScaling } from "./RecipeScalingCalculator.shim";
import { emit as emitEvent } from "@/services/eventBus";
import { familyFundMode } from "@/services/featureFlags";
// Optional Hub helper: safe to import even if not wired yet.
import { exportToHubIfEnabled } from "@/services/hub/exportToHubIfEnabled";

/**
 * @typedef {import("./RecipeScalingCalculator.shim").RecipeScalingInput} RecipeScalingInput
 * @typedef {import("./RecipeScalingCalculator.shim").RecipeScalingPayload} RecipeScalingPayload
 * @typedef {import("./RecipeScalingCalculator.shim").RecipeScalingResult} RecipeScalingResult
 */

/**
 * useRecipeScalingCalculator
 *
 * High-level hook that wraps the shim:
 * - accepts a base recipe and household context
 * - exposes scaleRecipe(inputOverrides) → calls shim and stores result
 * - emits calculator and planning graph events
 *
 * @param {{
 *   baseRecipe?: {
 *     id?: string|null,
 *     name?: string|null,
 *     ingredients?: { ingredientId?:string|null, name:string, quantity:number, unit:string, storehouseItemId?:string|null }[]
 *   },
 *   householdId?: string|null
 * }} params
 */
export function useRecipeScalingCalculator(params = {}) {
  const { baseRecipe, householdId = null } = params;

  /** @type {[RecipeScalingResult|null, Function]} */
  const [lastResult, setLastResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  /**
   * Core action: run the scaling shim
   * @param {Partial<RecipeScalingInput>} inputOverrides
   * @returns {Promise<RecipeScalingResult|null>}
   */
  const scaleRecipe = useCallback(
    async (inputOverrides = {}) => {
      setError("");
      setLoading(true);

      try {
        const payload = buildScalingPayload({
          baseRecipe,
          householdId,
          inputOverrides
        });

        const result = await calculateRecipeScaling(payload);
        setLastResult(result);

        emitEvent({
          type: "calculator.scaling.completed",
          ts: new Date().toISOString(),
          source:
            "features/calculators/storehouseMeals/RecipeScalingCalculator/hooks",
          data: {
            recipeId: result.input.recipeId,
            baseServings: result.input.baseServings,
            scaledServings: result.output.scaledServings,
            appliedScaleFactor: result.output.appliedScaleFactor,
            warnings: result.output.scalingWarnings
          }
        });

        if (familyFundMode) {
          // Non-blocking, fail-silent Hub export
          exportToHubIfEnabled({
            kind: "calculator.scaling",
            createdAt: new Date().toISOString(),
            payload: result
          }).catch(() => {
            // eslint-disable-next-line no-console
            console.warn(
              "[RecipeScalingCalculator.hooks] Hub export failed (ignored)"
            );
          });
        }

        return result;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[useRecipeScalingCalculator] Error:", err);
        setError(
          err && err.message
            ? err.message
            : "Something went wrong while scaling this recipe."
        );
        return null;
      } finally {
        setLoading(false);
      }
    },
    [baseRecipe, householdId]
  );

  return {
    loading,
    error,
    lastResult,
    scaleRecipe
  };
}

/**
 * useScalingToBatchSession
 *
 * Hook to convert a RecipeScalingResult into a Session draft
 * (domain: cooking) that can be handed off to the SessionRunner.
 *
 * Note:
 * - This does not persist or start the session.
 * - It just builds a draft and emits planning events.
 *
 * @returns {{
 *   buildBatchSessionFromScaling: (args: {
 *     scalingResult: RecipeScalingResult,
 *     options?: {
 *       sessionTitle?: string,
 *       householdId?: string|null
 *     }
 *   }) => import("@/types").Session | null
 * }}
 */
export function useScalingToBatchSession() {
  /**
   * @param {{
   *   scalingResult: RecipeScalingResult,
   *   options?: {
   *     sessionTitle?: string,
   *     householdId?: string|null
   *   }
   * }} args
   * @returns {import("@/types").Session | null}
   */
  const buildBatchSessionFromScaling = useCallback((args) => {
    const { scalingResult, options } = args || {};
    if (!scalingResult || !scalingResult.output) {
      return null;
    }

    const {
      input: { recipeId, recipeName },
      output: { scaledServings, appliedScaleFactor, ingredients, sessionsHints }
    } = scalingResult;

    const nowIso = new Date().toISOString();

    /** @type {import("@/types").Session} */
    const sessionDraft = {
      id: `session_${recipeId || "recipe"}_${nowIso}`,
      domain: "cooking",
      title:
        options?.sessionTitle ||
        `Cook: ${recipeName || "Batch"} x${appliedScaleFactor.toFixed(2)}`,
      source: {
        type: "recipe",
        refId: recipeId || null
      },
      steps: buildSessionStepsFromIngredients(ingredients, sessionsHints),
      prefs: {
        voiceGuidance: true,
        haptic: true,
        autoAdvance: false
      },
      status: "pending",
      progress: {
        currentStepIndex: 0,
        elapsedSec: 0,
        startedAt: null,
        pausedAt: null
      },
      analytics: {
        skippedSteps: [],
        adjustments: []
      },
      createdAt: nowIso,
      updatedAt: nowIso
    };

    emitEvent({
      type: "calculator.scaling.toSession.draft",
      ts: nowIso,
      source:
        "features/calculators/storehouseMeals/RecipeScalingCalculator/hooks",
      data: {
        sessionId: sessionDraft.id,
        domain: sessionDraft.domain,
        recipeId,
        scaledServings,
        appliedScaleFactor,
        estimatedSteps: sessionDraft.steps.length
      }
    });

    if (familyFundMode) {
      exportToHubIfEnabled({
        kind: "session.draft.cooking",
        createdAt: nowIso,
        payload: {
          session: sessionDraft,
          scalingResult
        }
      }).catch(() => {
        // eslint-disable-next-line no-console
        console.warn(
          "[RecipeScalingCalculator.hooks] Hub export (session draft) failed (ignored)"
        );
      });
    }

    return sessionDraft;
  }, []);

  return {
    buildBatchSessionFromScaling
  };
}

/**
 * useScalingToFreezerPlan
 *
 * Hook that converts a scaling result into a freezer plan
 * (total portions, container counts, label suggestions).
 *
 * This can feed into:
 * - Freezer inventory planner
 * - Label printer / batch label generator
 *
 * @returns {{
 *   buildFreezerPlanFromScaling: (args: {
 *     scalingResult: RecipeScalingResult,
 *     options?: {
 *       portionSizeGrams?: number,
 *       labelBase?: string,
 *       householdId?: string|null
 *     }
 *   }) => {
 *     planId: string,
 *     householdId: string|null,
 *     recipeId: string|null,
 *     recipeName: string|null,
 *     scaledServings: number,
 *     portions: number,
 *     estimatedContainers: number,
 *     suggestedLabel: string,
 *     createdAt: string
 *   } | null
 * }}
 */
export function useScalingToFreezerPlan() {
  /**
   * @param {{
   *   scalingResult: RecipeScalingResult,
   *   options?: {
   *     portionSizeGrams?: number,
   *     labelBase?: string,
   *     householdId?: string|null
   *   }
   * }} args
   */
  const buildFreezerPlanFromScaling = useCallback((args) => {
    const { scalingResult, options } = args || {};
    if (!scalingResult || !scalingResult.output) {
      return null;
    }

    const {
      input: { recipeId, recipeName },
      output: { scaledServings }
    } = scalingResult;

    const nowIso = new Date().toISOString();
    const householdId = options?.householdId || null;

    // Basic heuristic: each "serving" becomes one portion,
    // but we keep this open for future refinement.
    const portions = Math.max(1, Math.round(scaledServings));

    // Very simple estimate for containers; can be improved using density/yield.
    const estimatedContainers = Math.max(
      1,
      Math.ceil(portions / 4) // 4 servings per container as a default
    );

    const labelBase =
      options?.labelBase ||
      recipeName ||
      "Batch Meal";

    const suggestedLabel = `${labelBase} – ${portions} portions`;

    const plan = {
      planId: `freezerPlan_${recipeId || "recipe"}_${nowIso}`,
      householdId,
      recipeId: recipeId || null,
      recipeName: recipeName || null,
      scaledServings,
      portions,
      estimatedContainers,
      suggestedLabel,
      createdAt: nowIso
    };

    emitEvent({
      type: "storehouse.freezer.plan.created",
      ts: nowIso,
      source:
        "features/calculators/storehouseMeals/RecipeScalingCalculator/hooks",
      data: {
        planId: plan.planId,
        recipeId: plan.recipeId,
        scaledServings: plan.scaledServings,
        portions: plan.portions,
        estimatedContainers: plan.estimatedContainers
      }
    });

    if (familyFundMode) {
      exportToHubIfEnabled({
        kind: "storehouse.freezer.plan",
        createdAt: nowIso,
        payload: plan
      }).catch(() => {
        // eslint-disable-next-line no-console
        console.warn(
          "[RecipeScalingCalculator.hooks] Hub export (freezer plan) failed (ignored)"
        );
      });
    }

    return plan;
  }, []);

  return {
    buildFreezerPlanFromScaling
  };
}

/* ------------------------------------------------------------------------- */
/* Internal helpers                                                          */
/* ------------------------------------------------------------------------- */

/**
 * Build the payload for the scaling shim from UI/graph inputs.
 *
 * @param {{
 *   baseRecipe?: {
 *     id?: string|null,
 *     name?: string|null,
 *     ingredients?: { ingredientId?:string|null, name:string, quantity:number, unit:string, storehouseItemId?:string|null }[]
 *   },
 *   householdId?: string|null,
 *   inputOverrides?: Partial<RecipeScalingInput>
 * }} params
 * @returns {RecipeScalingPayload}
 */
function buildScalingPayload(params) {
  const { baseRecipe, householdId = null, inputOverrides = {} } = params;

  const baseServings =
    typeof inputOverrides.baseServings === "number" &&
    inputOverrides.baseServings > 0
      ? inputOverrides.baseServings
      : 4;

  /** @type {RecipeScalingInput} */
  const input = {
    recipeId: baseRecipe?.id || null,
    recipeName: baseRecipe?.name || null,
    baseServings,
    targetServings:
      typeof inputOverrides.targetServings === "number" &&
      inputOverrides.targetServings > 0
        ? inputOverrides.targetServings
        : null,
    scaleFactor:
      typeof inputOverrides.scaleFactor === "number" &&
      inputOverrides.scaleFactor > 0
        ? inputOverrides.scaleFactor
        : null,
    roundingMode: inputOverrides.roundingMode || "friendlyKitchen",
    minScaleFactor:
      typeof inputOverrides.minScaleFactor === "number" &&
      inputOverrides.minScaleFactor > 0
        ? inputOverrides.minScaleFactor
        : null,
    maxScaleFactor:
      typeof inputOverrides.maxScaleFactor === "number" &&
      inputOverrides.maxScaleFactor > 0
        ? inputOverrides.maxScaleFactor
        : null,
    respectInventory:
      typeof inputOverrides.respectInventory === "boolean"
        ? inputOverrides.respectInventory
        : true,
    respectEquipmentLimits:
      typeof inputOverrides.respectEquipmentLimits === "boolean"
        ? inputOverrides.respectEquipmentLimits
        : true,
    respectTimeConstraints:
      typeof inputOverrides.respectTimeConstraints === "boolean"
        ? inputOverrides.respectTimeConstraints
        : false,
    inventorySnapshot: inputOverrides.inventorySnapshot || null,
    equipmentConstraints: inputOverrides.equipmentConstraints || null,
    timeConstraints: inputOverrides.timeConstraints || null,
    householdContext: householdId ? { householdId } : null
  };

  return {
    input,
    baseRecipe: baseRecipe
      ? {
          id: baseRecipe.id || null,
          name: baseRecipe.name || null,
          ingredients: baseRecipe.ingredients || []
        }
      : undefined,
    meta: {
      householdId,
      origin: "RecipeScalingCalculator.hooks"
    }
  };
}

/**
 * Map scaled ingredients into a minimal set of Session steps.
 *
 * This keeps things simple:
 * - One prep step
 * - One cook step
 * - One portion/store step
 *
 * More complex multi-step templates can replace this helper later.
 *
 * @param {RecipeScalingResult["output"]["ingredients"]} ingredients
 * @param {RecipeScalingResult["output"]["sessionsHints"]} sessionsHints
 * @returns {import("@/types").Session["steps"]}
 */
function buildSessionStepsFromIngredients(ingredients, sessionsHints) {
  const steps = [];

  const prepDuration =
    sessionsHints?.estimatedPrepMinutes != null
      ? Math.round(sessionsHints.estimatedPrepMinutes * 60)
      : 15 * 60; // default 15 min

  const cookDuration =
    sessionsHints?.estimatedTotalCookMinutes != null
      ? Math.round(sessionsHints.estimatedTotalCookMinutes * 60)
      : 30 * 60; // default 30 min

  const portionDuration =
    sessionsHints?.estimatedPortionMinutes != null
      ? Math.round(sessionsHints.estimatedPortionMinutes * 60)
      : 10 * 60; // default 10 min

  steps.push({
    id: "prep",
    title: "Prep ingredients",
    desc: "Gather and prepare all ingredients for this scaled batch.",
    durationSec: prepDuration,
    blockers: ["inventory", "equipment"],
    metadata: {
      tempTargetF: 0,
      donenessCue: "timer",
      cueNotes:
        "Chop, measure, and pre-portion everything before you start cooking."
    }
  });

  steps.push({
    id: "cook",
    title: "Cook batch",
    desc:
      "Cook the scaled recipe according to your method, adjusting time and pan size as needed.",
    durationSec: cookDuration,
    blockers: ["equipment", "quietHours", "sabbath"],
    metadata: {
      tempTargetF: 0,
      donenessCue: "smell",
      cueNotes:
        "Use the original recipe cues for doneness; watch color, texture, and aroma."
    }
  });

  steps.push({
    id: "portion",
    title: "Portion, cool, and store",
    desc:
      "Divide into freezer or fridge containers, label, and update your storehouse inventory.",
    durationSec: portionDuration,
    blockers: ["inventory", "equipment"],
    metadata: {
      tempTargetF: 40,
      donenessCue: "probeTemp",
      cueNotes:
        "Cool to safe temperature before placing in the fridge or freezer."
    }
  });

  return steps;
}
