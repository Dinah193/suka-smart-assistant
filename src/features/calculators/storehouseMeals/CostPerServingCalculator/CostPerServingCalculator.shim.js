/**
 * CostPerServingCalculator.shim.js
 *
 * HOW THIS FITS
 * -------------
 * This shim runs the "Cost Per Serving" calculator as a background-friendly,
 * side-effect-aware module in Suka Smart Assistant (SSA).
 *
 * - It accepts structured input validated by CostPerServingCalculator.schema.json.
 * - Computes:
 *   - pricePerUnit (normalized per package unit),
 *   - pricePerServing for each item,
 *   - summary stats (totalSpending, avgPricePerServing).
 * - Optionally computes a "hair-focused nutrient value per dollar" score
 *   when nutrient metadata is present (for Black hair nutrition insights).
 * - Emits an event on the SSA event bus with full results.
 * - Optionally exports to the Family Fund Hub when familyFundMode === true.
 *
 * Because this is a shim (pure logic module, no UI), it:
 * - Can be invoked from React components, workers, or background schedulers.
 * - Is idempotent (same input → same output).
 * - Can be re-run safely even if the user navigates away and returns later.
 */

import { emit } from "@/services/eventBus"; // Adjust import if your eventBus exports differently
import { familyFundMode } from "@/services/featureFlags";
import { HubPacketFormatter, FamilyFundConnector } from "@/services/hub";

/**
 * Safely export a payload to the Hub when familyFundMode is enabled.
 * Fails silently if anything goes wrong (offline, network error, etc.).
 *
 * @param {string} calculatorId
 * @param {any} result
 * @returns {Promise<void>}
 */
async function exportToHubIfEnabled(calculatorId, result) {
  if (!familyFundMode) return;

  try {
    const packet = HubPacketFormatter.format({
      type: "planner.costPerServing",
      source: "calculators/storehouseMeals/CostPerServingCalculator.shim",
      createdAt: new Date().toISOString(),
      payload: {
        calculatorId: calculatorId || null,
        result,
      },
    });

    await FamilyFundConnector.send(packet);

    emit({
      type: "session.exported",
      ts: new Date().toISOString(),
      source: "calculators/storehouseMeals/CostPerServingCalculator.shim",
      data: {
        domain: "storehouse",
        calculator: "costPerServing",
        calculatorId,
        exported: true,
      },
    });
  } catch (err) {
    // Silent failure by design, but we still emit a debug-style event
    emit({
      type: "planner.costPerServing.export.failed",
      ts: new Date().toISOString(),
      source: "calculators/storehouseMeals/CostPerServingCalculator.shim",
      data: {
        calculatorId,
        error: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

/**
 * Compute a "hair-focused nutrient value per dollar" score.
 *
 * This is deliberately simple and explainable:
 * - Expects meta.nutrients.{proteinMg, ironMg, zincMg, vitaminDMcgs, biotinMcgs}.
 * - Uses a weighted sum per serving, then divides by pricePerServing.
 *
 * If nutrient data is missing or invalid, returns null.
 *
 * @param {object} item - A single calculator item with meta & nutrients.
 * @param {number} pricePerServing - Price per serving for this item.
 * @returns {number|null}
 */
function computeHairNutrientScorePerDollar(item, pricePerServing) {
  if (!item || typeof item !== "object") return null;
  if (!item.meta || typeof item.meta !== "object") return null;
  const nutrients = item.meta.nutrients;
  if (!nutrients || typeof nutrients !== "object") return null;
  if (!pricePerServing || pricePerServing <= 0) return null;

  const proteinMg = Number(nutrients.proteinMg ?? 0);
  const ironMg = Number(nutrients.ironMg ?? 0);
  const zincMg = Number(nutrients.zincMg ?? 0);
  const vitaminDMcgs = Number(nutrients.vitaminDMcgs ?? 0);
  const biotinMcgs = Number(nutrients.biotinMcgs ?? 0);

  const hasAny =
    proteinMg > 0 ||
    ironMg > 0 ||
    zincMg > 0 ||
    vitaminDMcgs > 0 ||
    biotinMcgs > 0;

  if (!hasAny) return null;

  // Simple weighted score per serving (unitless)
  const hairScorePerServing =
    proteinMg * 0.4 +
    ironMg * 0.2 +
    zincMg * 0.2 +
    vitaminDMcgs * 0.1 +
    biotinMcgs * 0.1;

  if (hairScorePerServing <= 0) return null;

  // Higher = more hair-supportive nutrients per dollar spent
  return hairScorePerServing / pricePerServing;
}

/**
 * Normalize price per unit.
 *
 * For now we keep it straightforward: pricePerUnit = packagePrice / packageSize.
 * The unit is whatever packageUnit the user provided. If needed, you can expand
 * this later to truly normalize into a base unit (e.g., g, ml).
 *
 * @param {number} packagePrice
 * @param {number} packageSize
 * @returns {number|null}
 */
function computePricePerUnit(packagePrice, packageSize) {
  const price = Number(packagePrice);
  const size = Number(packageSize);
  if (!Number.isFinite(price) || !Number.isFinite(size) || size <= 0) {
    return null;
  }
  return price / size;
}

/**
 * Compute price per serving from packagePrice and servingsFromPackage.
 *
 * @param {number} packagePrice
 * @param {number} servingsFromPackage
 * @returns {number|null}
 */
function computePricePerServing(packagePrice, servingsFromPackage) {
  const price = Number(packagePrice);
  const servings = Number(servingsFromPackage);
  if (!Number.isFinite(price) || !Number.isFinite(servings) || servings <= 0) {
    return null;
  }
  return price / servings;
}

/**
 * Validate a single item from the input payload in a defensive way.
 *
 * This does NOT replace JSON Schema validation; it adds runtime safety and
 * friendly fallbacks.
 *
 * @param {any} rawItem
 * @returns {object|null} normalized item or null if irrecoverably invalid
 */
function normalizeItem(rawItem) {
  if (!rawItem || typeof rawItem !== "object") return null;

  const id = String(rawItem.id ?? "");
  const name = String(rawItem.name ?? "").trim();
  const packagePrice = Number(rawItem.packagePrice ?? 0);
  const packageSize = Number(rawItem.packageSize ?? 0);
  const packageUnit = String(rawItem.packageUnit ?? "").trim();
  const servingsFromPackage = Number(rawItem.servingsFromPackage ?? 0);

  if (!id && !name) {
    // We need at least some identity for merging and display
    return null;
  }

  return {
    ...rawItem,
    id: id || name,
    name: name || id,
    packagePrice,
    packageSize,
    packageUnit,
    servingsFromPackage,
    meta: {
      ...(rawItem.meta || {}),
    },
  };
}

/**
 * Core runner for the Cost Per Serving calculator.
 *
 * @typedef {object} CostPerServingInput
 * @property {string} [calculatorId]
 * @property {string} [version]
 * @property {string} [currency]
 * @property {string} [householdProfileId]
 * @property {Array<object>} items
 *
 * @typedef {object} CostPerServingResult
 * @property {Array<object>} items
 * @property {object} summary
 *
 * @param {CostPerServingInput} payload
 * @returns {Promise<CostPerServingResult>}
 */
export async function runCostPerServingCalculation(payload) {
  const ts = new Date().toISOString();

  if (!payload || typeof payload !== "object") {
    throw new Error("CostPerServingCalculator: payload must be an object.");
  }

  const {
    calculatorId = null,
    version = "1.0.0",
    currency = "USD",
    householdProfileId = null,
    items: rawItems,
  } = payload;

  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new Error("CostPerServingCalculator: payload.items must be a non-empty array.");
  }

  const normalizedItems = [];
  let totalSpending = 0;
  let weightedPricePerServingSum = 0;
  let totalServingsCount = 0;

  for (const raw of rawItems) {
    const item = normalizeItem(raw);
    if (!item) {
      emit({
        type: "planner.costPerServing.item.skipped",
        ts,
        source: "calculators/storehouseMeals/CostPerServingCalculator.shim",
        data: {
          reason: "invalid_item",
          raw: raw ?? null,
        },
      });
      continue;
    }

    const pricePerUnit = computePricePerUnit(item.packagePrice, item.packageSize);
    const pricePerServing = computePricePerServing(
      item.packagePrice,
      item.servingsFromPackage
    );

    // Update meta with computed values
    const meta = {
      ...(item.meta || {}),
      pricePerUnit: pricePerUnit ?? item.meta?.pricePerUnit ?? null,
      pricePerServing: pricePerServing ?? item.meta?.pricePerServing ?? null,
      currency: currency || item.meta?.currency || "USD",
    };

    const hairScorePerDollar =
      pricePerServing && pricePerServing > 0
        ? computeHairNutrientScorePerDollar({ ...item, meta }, pricePerServing)
        : null;

    if (hairScorePerDollar !== null) {
      meta.hairNutrientScorePerDollar = hairScorePerDollar;
    }

    const computedItem = {
      ...item,
      meta,
    };

    normalizedItems.push(computedItem);

    if (Number.isFinite(item.packagePrice) && item.packagePrice > 0) {
      totalSpending += item.packagePrice;
    }
    if (
      Number.isFinite(pricePerServing) &&
      pricePerServing > 0 &&
      Number.isFinite(item.servingsFromPackage) &&
      item.servingsFromPackage > 0
    ) {
      weightedPricePerServingSum += pricePerServing * item.servingsFromPackage;
      totalServingsCount += item.servingsFromPackage;
    }
  }

  const avgPricePerServing =
    totalServingsCount > 0 ? weightedPricePerServingSum / totalServingsCount : 0;

  const summary = {
    totalItems: normalizedItems.length,
    totalSpending,
    avgPricePerServing,
    createdAt: ts,
    currency,
    version,
    householdProfileId,
  };

  const result = {
    items: normalizedItems,
    summary,
  };

  // Emit calculator-completed style event
  emit({
    type: "planner.costPerServing.completed",
    ts,
    source: "calculators/storehouseMeals/CostPerServingCalculator.shim",
    data: {
      calculatorId,
      summary,
      itemCount: normalizedItems.length,
    },
  });

  // Optional export to Hub (Fire-and-forget)
  void exportToHubIfEnabled(calculatorId, result);

  return result;
}

export default {
  runCostPerServingCalculation,
};
