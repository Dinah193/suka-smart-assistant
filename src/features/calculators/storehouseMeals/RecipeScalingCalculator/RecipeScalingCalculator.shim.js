/**
 * RecipeScalingCalculator.shim.js
 *
 * How this fits:
 * - Pure “shim” logic module for the Recipe Scaling Calculator node in the SSA Planning Graph.
 * - Accepts a payload (validated via RecipeScalingCalculator.schema.json) and an optional baseRecipe.
 * - Computes a safe scale factor, scaled servings, and scaled ingredient quantities.
 * - Emits SSA calculator events via eventBus and optionally exports analytics to the Hub when familyFundMode is enabled.
 * - Designed to be safe to call from UI, workers, or background flows (no React / DOM assumptions).
 */

import { emit as emitEvent } from "@/services/eventBus";
import { familyFundMode } from "@/services/featureFlags";
import { HubPacketFormatter, FamilyFundConnector } from "@/services/hub";

/**
 * @typedef {Object} RecipeScalingInput
 * @property {string|null} [recipeId]
 * @property {string|null} [recipeName]
 * @property {number} baseServings
 * @property {number|null} [targetServings]
 * @property {number|null} [scaleFactor]
 * @property {"none"|"friendlyKitchen"|"storePackage"|"fractionQuarter"} [roundingMode]
 * @property {number|null} [maxScaleFactor]
 * @property {number|null} [minScaleFactor]
 * @property {boolean} [respectInventory]
 * @property {boolean} [respectEquipmentLimits]
 * @property {boolean} [respectTimeConstraints]
 * @property {Object|null} [inventorySnapshot]
 * @property {Object|null} [equipmentConstraints]
 * @property {Object|null} [timeConstraints]
 * @property {Object|null} [householdContext]
 */

/**
 * @typedef {Object} BaseIngredient
 * @property {string|null} [ingredientId]
 * @property {string} name
 * @property {number} quantity
 * @property {string} unit
 * @property {string|null} [storehouseItemId]
 */

/**
 * @typedef {Object} BaseRecipe
 * @property {string|null} [id]
 * @property {string|null} [name]
 * @property {BaseIngredient[]} ingredients
 */

/**
 * @typedef {Object} RecipeScalingPayload
 * @property {RecipeScalingInput} input
 * @property {Object} [meta]
 * @property {BaseRecipe} [baseRecipe] - Optional; if omitted, ingredients array will be empty and a warning added.
 */

/**
 * Main entry point for the Recipe Scaling Calculator shim.
 *
 * @param {RecipeScalingPayload} payload
 * @returns {Promise<{
 *   input: RecipeScalingInput,
 *   output: {
 *     scaledServings: number,
 *     appliedScaleFactor: number,
 *     ingredients: Array<{
 *       ingredientId: string|null,
 *       name: string,
 *       baseQuantity: number,
 *       baseUnit: string,
 *       scaledQuantity: number,
 *       scaledUnit: string,
 *       storehouseItemId: string|null,
 *       inventoryStatus: "unknown"|"sufficient"|"low"|"shortage",
 *       inventoryDelta: number|null,
 *       warnings: string[]
 *     }>,
 *     scalingWarnings: string[],
 *     sessionsHints: {
 *       recommendedBatchCount: number|null,
 *       estimatedTotalCookMinutes: number|null
 *     }
 *   },
 *   meta: {
 *     calculatorVersion: string,
 *     invokedAt: string,
 *     householdId: string|null
 *   }
 * }>}
 */
export async function calculateRecipeScaling(payload) {
  const ts = nowIso();

  // Defensive guard: ensure we have an input object
  if (!payload || typeof payload !== "object" || !payload.input) {
    const errorMessage = "RecipeScalingCalculator: payload.input is required.";
    emitCalculatorEvent("calculator.error", {
      calculator: "RecipeScalingCalculator",
      reason: "missing_input",
      ts
    });
    throw new Error(errorMessage);
  }

  const input = normalizeInput(payload.input);
  const baseRecipe = normalizeBaseRecipe(payload.baseRecipe);
  const meta = buildMeta(payload.meta, input);

  emitCalculatorEvent("calculator.invoked", {
    calculator: "RecipeScalingCalculator",
    inputSummary: {
      recipeId: input.recipeId || baseRecipe.id || null,
      recipeName: input.recipeName || baseRecipe.name || null,
      baseServings: input.baseServings,
      targetServings: input.targetServings,
      scaleFactor: input.scaleFactor
    },
    ts
  });

  const scalingWarnings = [];

  // Compute initial scale factor
  let scaleFactor = computeScaleFactor(input, scalingWarnings);

  // Clamp to min/max if provided
  scaleFactor = clampScaleFactor(scaleFactor, input, scalingWarnings);

  // Compute scaled servings
  const scaledServings = Number(
    (input.baseServings * scaleFactor).toFixed(3)
  );

  // Scale ingredients
  const inventoryLookup = buildInventoryLookup(input.inventorySnapshot);
  const ingredients = baseRecipe.ingredients.map((ing) =>
    scaleIngredient(
      ing,
      scaleFactor,
      input.roundingMode,
      inventoryLookup,
      scalingWarnings
    )
  );

  // Equipment/time hints (very lightweight, extension point for later)
  const sessionsHints = buildSessionsHints(
    input,
    scaledServings,
    baseRecipe,
    scaleFactor
  );

  const output = {
    scaledServings,
    appliedScaleFactor: scaleFactor,
    ingredients,
    scalingWarnings,
    sessionsHints
  };

  const result = {
    input,
    output,
    meta
  };

  emitCalculatorEvent("calculator.completed", {
    calculator: "RecipeScalingCalculator",
    resultSummary: {
      scaledServings,
      appliedScaleFactor: scaleFactor,
      ingredientCount: ingredients.length,
      hasWarnings: scalingWarnings.length > 0
    },
    ts: nowIso()
  });

  // Optional Hub export if enabled
  exportToHubIfEnabled(result).catch(() => {
    // Fail silently per spec
  });

  return result;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * @returns {string} ISO 8601 timestamp
 */
function nowIso() {
  return new Date().toISOString();
}

/**
 * Emit calculator-related events through the shared SSA event bus.
 *
 * @param {string} type
 * @param {Object} data
 */
function emitCalculatorEvent(type, data) {
  try {
    emitEvent({
      type,
      ts: nowIso(),
      source: "features/calculators/storehouseMeals/RecipeScalingCalculator",
      data
    });
  } catch (err) {
    // Event bus issues should never crash calculations
    // eslint-disable-next-line no-console
    console.warn("[RecipeScalingCalculator] Failed to emit event:", err);
  }
}

/**
 * Normalize and fill defaults for the input object.
 *
 * @param {RecipeScalingInput} raw
 * @returns {RecipeScalingInput}
 */
function normalizeInput(raw) {
  const input = { ...raw };

  if (typeof input.baseServings !== "number" || input.baseServings <= 0) {
    throw new Error(
      "RecipeScalingCalculator: baseServings must be a positive number."
    );
  }

  if (!input.roundingMode) {
    input.roundingMode = "friendlyKitchen";
  }

  if (typeof input.respectInventory !== "boolean") {
    input.respectInventory = true;
  }
  if (typeof input.respectEquipmentLimits !== "boolean") {
    input.respectEquipmentLimits = true;
  }
  if (typeof input.respectTimeConstraints !== "boolean") {
    input.respectTimeConstraints = false;
  }

  return input;
}

/**
 * Normalize base recipe structure and ensure ingredients array.
 *
 * @param {BaseRecipe|undefined} baseRecipe
 * @returns {BaseRecipe}
 */
function normalizeBaseRecipe(baseRecipe) {
  if (!baseRecipe || typeof baseRecipe !== "object") {
    return {
      id: null,
      name: null,
      ingredients: []
    };
  }

  const ingredients = Array.isArray(baseRecipe.ingredients)
    ? baseRecipe.ingredients
    : [];

  return {
    id: baseRecipe.id || null,
    name: baseRecipe.name || null,
    ingredients: ingredients
      .filter((ing) => ing && typeof ing.name === "string")
      .map((ing) => ({
        ingredientId: ing.ingredientId || null,
        name: ing.name,
        quantity: typeof ing.quantity === "number" ? ing.quantity : 0,
        unit: ing.unit || "",
        storehouseItemId: ing.storehouseItemId || null
      }))
  };
}

/**
 * Compute initial scale factor from input; precedence:
 * - explicit scaleFactor (if provided)
 * - derived from targetServings / baseServings
 *
 * @param {RecipeScalingInput} input
 * @param {string[]} scalingWarnings
 * @returns {number}
 */
function computeScaleFactor(input, scalingWarnings) {
  if (typeof input.scaleFactor === "number" && input.scaleFactor > 0) {
    return input.scaleFactor;
  }

  if (
    typeof input.targetServings === "number" &&
    input.targetServings > 0
  ) {
    const factor = input.targetServings / input.baseServings;
    if (!isFinite(factor) || factor <= 0) {
      scalingWarnings.push(
        "Derived scale factor from targetServings was invalid; defaulting to 1."
      );
      return 1;
    }
    return factor;
  }

  scalingWarnings.push(
    "No targetServings or scaleFactor provided; using scale factor = 1 (no scaling)."
  );
  return 1;
}

/**
 * Clamp scale factor to configured min/max if present.
 *
 * @param {number} factor
 * @param {RecipeScalingInput} input
 * @param {string[]} scalingWarnings
 * @returns {number}
 */
function clampScaleFactor(factor, input, scalingWarnings) {
  let result = factor;

  if (typeof input.minScaleFactor === "number") {
    if (result < input.minScaleFactor) {
      scalingWarnings.push(
        `Scale factor ${result.toFixed(
          3
        )} increased to minScaleFactor ${input.minScaleFactor.toFixed(3)}.`
      );
      result = input.minScaleFactor;
    }
  }

  if (typeof input.maxScaleFactor === "number") {
    if (result > input.maxScaleFactor) {
      scalingWarnings.push(
        `Scale factor ${result.toFixed(
          3
        )} reduced to maxScaleFactor ${input.maxScaleFactor.toFixed(3)}.`
      );
      result = input.maxScaleFactor;
    }
  }

  return result;
}

/**
 * Build a lookup map for inventory quantities by storehouseItemId.
 *
 * @param {Object|null|undefined} snapshot
 * @returns {Record<string, { quantityAvailable: number, unit: string }>}
 */
function buildInventoryLookup(snapshot) {
  const lookup = {};

  if (!snapshot || !Array.isArray(snapshot.items)) {
    return lookup;
  }

  snapshot.items.forEach((item) => {
    if (!item || !item.storehouseItemId) return;
    lookup[item.storehouseItemId] = {
      quantityAvailable:
        typeof item.quantityAvailable === "number"
          ? item.quantityAvailable
          : 0,
      unit: item.unit || ""
    };
  });

  return lookup;
}

/**
 * Scale a single ingredient and derive inventory status.
 *
 * @param {BaseIngredient} ing
 * @param {number} factor
 * @param {"none"|"friendlyKitchen"|"storePackage"|"fractionQuarter"} roundingMode
 * @param {Record<string, {quantityAvailable:number, unit:string}>} inventoryLookup
 * @param {string[]} globalWarnings
 * @returns {{
 *   ingredientId: string|null,
 *   name: string,
 *   baseQuantity: number,
 *   baseUnit: string,
 *   scaledQuantity: number,
 *   scaledUnit: string,
 *   storehouseItemId: string|null,
 *   inventoryStatus: "unknown"|"sufficient"|"low"|"shortage",
 *   inventoryDelta: number|null,
 *   warnings: string[]
 * }}
 */
function scaleIngredient(
  ing,
  factor,
  roundingMode,
  inventoryLookup,
  globalWarnings
) {
  const warnings = [];
  const baseQuantity =
    typeof ing.quantity === "number" && ing.quantity >= 0
      ? ing.quantity
      : 0;

  const exactScaled = baseQuantity * factor;
  const scaledQuantity = applyRounding(exactScaled, roundingMode);

  const scaledUnit = ing.unit || "";
  let inventoryStatus = "unknown";
  let inventoryDelta = null;

  if (ing.storehouseItemId && inventoryLookup[ing.storehouseItemId]) {
    const inv = inventoryLookup[ing.storehouseItemId];
    // For now, assume units match. More advanced unit conversion can be
    // added later; if units differ, mark status as unknown and warn.
    if (inv.unit && scaledUnit && inv.unit !== scaledUnit) {
      warnings.push(
        `Inventory unit (${inv.unit}) differs from recipe unit (${scaledUnit}); inventory status not computed.`
      );
      inventoryStatus = "unknown";
    } else {
      inventoryDelta = -scaledQuantity;
      if (inv.quantityAvailable >= scaledQuantity) {
        inventoryStatus = "sufficient";
      } else if (inv.quantityAvailable > 0) {
        inventoryStatus = "low";
        warnings.push(
          `Inventory low for ${ing.name}: need ${scaledQuantity} ${scaledUnit}, but only ${inv.quantityAvailable} available.`
        );
        globalWarnings.push(
          `Low inventory for ingredient: ${ing.name}.`
        );
      } else {
        inventoryStatus = "shortage";
        warnings.push(
          `Inventory shortage for ${ing.name}: need ${scaledQuantity} ${scaledUnit}, but none available.`
        );
        globalWarnings.push(
          `Inventory shortage for ingredient: ${ing.name}.`
        );
      }
    }
  }

  return {
    ingredientId: ing.ingredientId || null,
    name: ing.name,
    baseQuantity,
    baseUnit: ing.unit || "",
    scaledQuantity,
    scaledUnit,
    storehouseItemId: ing.storehouseItemId || null,
    inventoryStatus,
    inventoryDelta,
    warnings
  };
}

/**
 * Apply rounding strategy to a numeric quantity.
 *
 * NOTE: This is intentionally simple; can be replaced with
 * more advanced kitchen-unit logic later.
 *
 * @param {number} value
 * @param {"none"|"friendlyKitchen"|"storePackage"|"fractionQuarter"} roundingMode
 * @returns {number}
 */
function applyRounding(value, roundingMode) {
  if (!isFinite(value)) return 0;

  switch (roundingMode) {
    case "none":
      return value;

    case "fractionQuarter":
      return Math.round(value * 4) / 4;

    case "storePackage":
      // Approximate to nearest 0.5 as a proxy for common package sizes
      return Math.round(value * 2) / 2;

    case "friendlyKitchen":
    default:
      // Approximate to nearest 0.25 for user-friendly fractional units
      return Math.round(value * 4) / 4;
  }
}

/**
 * Build lightweight session hints for downstream SessionRunner and
 * BatchYieldCalculator.
 *
 * @param {RecipeScalingInput} input
 * @param {number} scaledServings
 * @param {BaseRecipe} baseRecipe
 * @param {number} scaleFactor
 * @returns {{ recommendedBatchCount: number|null, estimatedTotalCookMinutes: number|null }}
 */
function buildSessionsHints(
  input,
  scaledServings,
  baseRecipe,
  scaleFactor
) {
  let recommendedBatchCount = null;
  let estimatedTotalCookMinutes = null;

  // Very simple heuristic: if timeConstraints exist, suggest splitting
  // when scaleFactor is large. This is an extension point for more
  // detailed session planning later.
  if (
    input.timeConstraints &&
    typeof input.timeConstraints.totalMinutesAvailable === "number"
  ) {
    const approxBaseMinutes = 45; // default base assumption per recipe
    const estimated = approxBaseMinutes * scaleFactor;
    estimatedTotalCookMinutes = estimated;

    const available = input.timeConstraints.totalMinutesAvailable;
    if (estimated > available && available > 0) {
      recommendedBatchCount = Math.ceil(estimated / available);
    }
  }

  return {
    recommendedBatchCount,
    estimatedTotalCookMinutes
  };
}

/**
 * Build meta block for result.
 *
 * @param {Object|undefined} meta
 * @param {RecipeScalingInput} input
 * @returns {{calculatorVersion:string, invokedAt:string, householdId:string|null}}
 */
function buildMeta(meta, input) {
  const invokedAt = nowIso();
  const householdId =
    (meta && meta.householdId) ||
    (input.householdContext && input.householdContext.householdId) ||
    null;

  return {
    calculatorVersion: "1.0.0",
    invokedAt,
    householdId
  };
}

/**
 * Export calculator result to the Hub if familyFundMode is enabled.
 *
 * @param {Object} result
 * @returns {Promise<void>}
 */
async function exportToHubIfEnabled(result) {
  if (!familyFundMode) return;

  try {
    const packet = HubPacketFormatter.formatCalculatorResult({
      calculator: "RecipeScalingCalculator",
      result
    });

    await FamilyFundConnector.send(packet);

    emitCalculatorEvent("session.exported", {
      calculator: "RecipeScalingCalculator",
      success: true
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[RecipeScalingCalculator] Hub export failed (non-fatal):",
      err
    );
  }
}

export default {
  calculateRecipeScaling
};
