/**
 * StorehouseRefillCalculator.shim.js
 *
 * HOW THIS FITS
 * -------------
 * This shim encapsulates the core refill logic for the Storehouse Refill Calculator
 * in Suka Smart Assistant (SSA). It:
 * - Accepts a well-structured input that matches StorehouseRefillCalculator.schema.json
 * - Computes per-item refill quantities, urgency, baskets, and summary metrics
 * - Emits a calculator event on the SSA event bus
 * - Optionally prepares a Hub export payload and sends it when familyFundMode is enabled
 *
 * The shim is pure and background-friendly: it has a small, single entry point
 * (`runStorehouseRefillCalculation`) that you can call from:
 * - UI components
 * - Web workers
 * - Automation flows / Planning Graph edges
 *
 * NOTE: This does not start a SessionRunner directly. Instead, it feeds data
 * into storehouse, shopping, or session builders, which can then create
 * preservation / cooking / shopping sessions as needed.
 */

import { emit } from "@/services/events/eventBus";
import { familyFundMode } from "@/config/featureFlags";
// Adjust paths to match your actual hub helper locations.
import { HubPacketFormatter, FamilyFundConnector } from "@/services/hub";

/**
 * @typedef {import("./StorehouseRefillCalculator.schema.json")} StorehouseRefillSchema
 */

/**
 * @typedef {StorehouseRefillSchema["definitions"]["StorehouseRefillInput"]} StorehouseRefillInput
 * @typedef {StorehouseRefillSchema["definitions"]["StorehouseRefillOutput"]} StorehouseRefillOutput
 */

/**
 * Safely checks if a value is a finite number.
 * @param {unknown} value
 * @returns {boolean}
 */
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Small helper to get an ISO timestamp.
 * @returns {string}
 */
function isoNow() {
  return new Date().toISOString();
}

/**
 * Derive the effective par/target quantity for an item, considering:
 * - Per-item override from minimumParLevels (if provided)
 * - Item's own parLevel
 * - Safety stock rules (very conservative, uses 1 unit = 1 day fallback)
 *
 * @param {import("./StorehouseRefillCalculator.schema.json").definitions.StorehouseItemLevel} item
 * @param {Record<string, number>} minimumParLevels
 * @param {Array<import("./StorehouseRefillCalculator.schema.json").definitions.SafetyStockRule>} safetyStockRules
 * @returns {number}
 */
function deriveTargetQty(item, minimumParLevels, safetyStockRules) {
  const overridePar = isFiniteNumber(minimumParLevels[item.itemId])
    ? minimumParLevels[item.itemId]
    : undefined;

  let target = isFiniteNumber(overridePar)
    ? overridePar
    : isFiniteNumber(item.parLevel)
    ? item.parLevel
    : 0;

  if (target < 0) target = 0;

  if (Array.isArray(safetyStockRules) && safetyStockRules.length > 0) {
    for (const rule of safetyStockRules) {
      if (!rule || typeof rule !== "object") continue;
      const appliesTo = rule.appliesTo;

      if (appliesTo === "all") {
        if (isFiniteNumber(rule.minDaysOfCover)) {
          target = Math.max(target, rule.minDaysOfCover);
        }
      } else if (
        appliesTo === "category" &&
        rule.category &&
        item.category === rule.category
      ) {
        if (isFiniteNumber(rule.minDaysOfCover)) {
          target = Math.max(target, rule.minDaysOfCover);
        }
      } else if (
        appliesTo === "item" &&
        rule.itemId &&
        item.itemId === rule.itemId
      ) {
        if (isFiniteNumber(rule.minDaysOfCover)) {
          target = Math.max(target, rule.minDaysOfCover);
        }
      }
    }
  }

  return target;
}

/**
 * Round a refill quantity according to an item's reorderMultiple, if provided.
 * @param {number} refillQty
 * @param {number | undefined} reorderMultiple
 * @returns {number}
 */
function applyReorderMultiple(refillQty, reorderMultiple) {
  if (!isFiniteNumber(refillQty) || refillQty <= 0) return 0;
  if (!isFiniteNumber(reorderMultiple) || reorderMultiple <= 0) {
    return Math.max(refillQty, 0);
  }

  const rounded = Math.ceil(refillQty / reorderMultiple) * reorderMultiple;
  return rounded < 0 ? 0 : rounded;
}

/**
 * Determine urgency label based on current and target quantities.
 * @param {number} currentQtyEffective
 * @param {number} targetQty
 * @returns {"low"|"medium"|"high"|"critical"}
 */
function deriveUrgency(currentQtyEffective, targetQty) {
  if (!isFiniteNumber(targetQty) || targetQty <= 0) {
    return "low";
  }
  const ratio = currentQtyEffective / targetQty;

  if (ratio <= 0) return "critical";
  if (ratio < 0.25) return "critical";
  if (ratio < 0.5) return "high";
  if (ratio < 0.75) return "medium";
  return "low";
}

/**
 * Pick a cheapest pricebook entry for an item to estimate cost and basket store.
 * @param {string} itemId
 * @param {Array<import("./StorehouseRefillCalculator.schema.json").definitions.PriceBookEntryRef>} priceBookSnapshot
 * @returns {import("./StorehouseRefillCalculator.schema.json").definitions.PriceBookEntryRef | null}
 */
function selectBestPriceEntry(itemId, priceBookSnapshot) {
  if (!Array.isArray(priceBookSnapshot) || !itemId) return null;

  let best = null;
  for (const entry of priceBookSnapshot) {
    if (!entry || entry.itemId !== itemId) continue;
    if (!isFiniteNumber(entry.unitPrice)) continue;

    if (!best || entry.unitPrice < best.unitPrice) {
      best = entry;
    }
  }
  return best;
}

/**
 * Build a minimal hub export payload for this calculator result.
 * This keeps the envelope consistent with other SSA exports.
 *
 * @param {StorehouseRefillInput} input
 * @param {StorehouseRefillOutput} output
 * @returns {Record<string, any>}
 */
function buildHubExportPayload(input, output) {
  const ts = isoNow();

  const basePacket = {
    module: "calculators/storehouseMeals/storehouseRefill",
    kind: "storehouse.refill.plan",
    ts,
    householdId: input.householdId || null,
    planningHorizonDays: input.planningHorizonDays,
    summary: {
      totalLines:
        output.aggregatedRefillSummary?.totalLines ?? output.refillLines.length,
      totalEstimatedCost:
        output.aggregatedRefillSummary?.totalEstimatedCost ?? null,
      highUrgencyCount:
        output.aggregatedRefillSummary?.highUrgencyCount ?? null,
    },
    context: {
      familyPreferences: input.familyPreferences || null,
    },
    payload: {
      refillLines: output.refillLines,
      priorityBaskets: output.priorityBaskets,
      timelineHints: output.timelineHints,
    },
  };

  try {
    if (HubPacketFormatter && typeof HubPacketFormatter.format === "function") {
      return HubPacketFormatter.format(basePacket);
    }
  } catch {
    // If HubPacketFormatter fails for any reason, just return the basePacket.
  }

  return basePacket;
}

/**
 * Try to export the refill plan to the Hub when familyFundMode is enabled.
 * Errors are swallowed by design.
 *
 * @param {Record<string, any>} hubPayload
 * @returns {Promise<void>}
 */
async function exportToHubIfEnabled(hubPayload) {
  if (!familyFundMode || !hubPayload) return;

  try {
    if (FamilyFundConnector && typeof FamilyFundConnector.send === "function") {
      await FamilyFundConnector.send(hubPayload);
      emit({
        type: "session.exported",
        ts: isoNow(),
        source: "calculators/storehouseMeals/StorehouseRefillCalculator.shim",
        data: {
          module: "storehouseRefill",
          success: true,
        },
      });
    }
  } catch {
    // Fail silently – Hub is optional.
  }
}

/**
 * Core refill logic. Pure, deterministic, no side effects.
 *
 * @param {StorehouseRefillInput} input
 * @returns {StorehouseRefillOutput}
 */
export function computeStorehouseRefillPlan(input) {
  const {
    storehouseSnapshot,
    minimumParLevels = {},
    safetyStockRules = [],
    priceBookSnapshot = [],
  } = input || {};

  const refillLines = [];
  /** @type {import("./StorehouseRefillCalculator.schema.json").definitions.StorehouseRefillSummary} */
  const summary = {
    totalLines: 0,
    totalRefillQty: 0,
    totalEstimatedCost: 0,
    highUrgencyCount: 0,
    stockoutRiskCount: 0,
  };

  /** @type {Record<string, import("./StorehouseRefillCalculator.schema.json").definitions.RefillBasket>} */
  const basketsByStore = {};
  const timelineHints = [];

  if (!Array.isArray(storehouseSnapshot) || storehouseSnapshot.length === 0) {
    return {
      refillLines,
      aggregatedRefillSummary: summary,
      priorityBaskets: [],
      timelineHints: [],
      hubExportPayload: null,
    };
  }

  for (const item of storehouseSnapshot) {
    if (!item || typeof item !== "object") continue;
    const currentQty = isFiniteNumber(item.currentQty) ? item.currentQty : 0;
    const reservedQty = isFiniteNumber(item.reservedQty) ? item.reservedQty : 0;
    const effectiveAvailable = Math.max(currentQty - reservedQty, 0);

    const targetQty = deriveTargetQty(item, minimumParLevels, safetyStockRules);
    if (targetQty <= 0) {
      // Nothing to maintain here; skip.
      continue;
    }

    const rawRefillQty = Math.max(targetQty - effectiveAvailable, 0);
    const refillQty = applyReorderMultiple(rawRefillQty, item.reorderMultiple);

    if (refillQty <= 0) {
      // No refill needed.
      continue;
    }

    const urgency = deriveUrgency(effectiveAvailable, targetQty);

    /** @type {import("./StorehouseRefillCalculator.schema.json").definitions.RefillLine} */
    const line = {
      itemId: item.itemId,
      label: item.label,
      category: item.category || "",
      location: item.location || "",
      uom: item.uom,
      currentQty,
      targetQty,
      refillQty,
      urgency,
      reasonCodes: ["belowPar"],
      notes: item.notes || "",
    };

    if (reservedQty > 0) {
      line.reasonCodes.push("mealPlanDemand");
    }

    // Summary metrics
    summary.totalLines += 1;
    summary.totalRefillQty += refillQty;
    if (urgency === "high" || urgency === "critical") {
      summary.highUrgencyCount += 1;
    }
    if (urgency === "critical") {
      summary.stockoutRiskCount += 1;
    }

    // Cost estimate + basket grouping
    const bestPrice = selectBestPriceEntry(item.itemId, priceBookSnapshot);
    if (bestPrice) {
      const lineCost = bestPrice.unitPrice * refillQty;
      summary.totalEstimatedCost += lineCost;

      const storeKey = bestPrice.storeId || "unknown-store";
      if (!basketsByStore[storeKey]) {
        basketsByStore[storeKey] = {
          basketId: storeKey,
          label: `Refill @ ${storeKey}`,
          priority: "medium",
          storeId: storeKey,
          lines: [],
          estimatedCost: 0,
        };
      }

      basketsByStore[storeKey].lines.push({
        itemId: item.itemId,
        refillQty,
      });

      basketsByStore[storeKey].estimatedCost += lineCost;
    }

    // Timeline hints: for items with lead time and high/critical urgency
    if (
      (urgency === "high" || urgency === "critical") &&
      isFiniteNumber(item.leadTimeDays) &&
      item.leadTimeDays > 0
    ) {
      const days = Math.max(1, item.leadTimeDays / 2);
      const shouldBuyBy = new Date(
        Date.now() + days * 24 * 60 * 60 * 1000
      ).toISOString();

      timelineHints.push({
        itemId: item.itemId,
        label: item.label,
        shouldBuyBy,
        riskIfDelayed:
          urgency === "critical"
            ? "High risk of stockout if purchase is delayed."
            : "Moderate risk of stockout if purchase is delayed.",
      });
    }

    // Black hair nutrition awareness: gently annotate candidate items with helpful note.
    if (
      input.familyPreferences?.prioritizeHairNutritionItems &&
      typeof line.notes === "string" &&
      line.category &&
      /oils|butters|beans|grains|nuts|seeds|greens|fruits|vegetables|meats/i.test(
        line.category
      )
    ) {
      const hairNote =
        "This item can support Black hair + scalp health when used in a balanced nutrition plan.";
      line.notes = line.notes ? `${line.notes} ${hairNote}` : hairNote;
    }

    refillLines.push(line);
  }

  const priorityBaskets = Object.values(basketsByStore).map((basket) => {
    const highRisk = basket.lines.length > 0 && summary.highUrgencyCount > 0;
    return {
      ...basket,
      priority: highRisk ? "high" : basket.priority,
    };
  });

  /** @type {StorehouseRefillOutput} */
  const output = {
    refillLines,
    aggregatedRefillSummary: summary,
    priorityBaskets,
    timelineHints,
    hubExportPayload: null,
  };

  return output;
}

/**
 * Shim entry point. This is the function you should call from UI, workers,
 * or Planning Graph edges. It:
 * - Validates basic shape
 * - Computes refill plan
 * - Emits a calculator event
 * - Prepares and (optionally) sends a Hub export payload
 *
 * @param {StorehouseRefillInput} input
 * @returns {Promise<StorehouseRefillOutput>}
 */
export async function runStorehouseRefillCalculation(input) {
  if (!input || typeof input !== "object") {
    throw new Error(
      "[StorehouseRefillCalculator] Invalid input: expected an object matching StorehouseRefillInput."
    );
  }

  const output = computeStorehouseRefillPlan(input);

  // Build hub payload & assign onto output (even if Hub is disabled)
  const hubPayload = buildHubExportPayload(input, output);
  output.hubExportPayload = hubPayload;

  // Emit calculator event to SSA event bus
  emit({
    type: "calculator.storehouseRefill.executed",
    ts: isoNow(),
    source: "calculators/storehouseMeals/StorehouseRefillCalculator.shim",
    data: {
      inputMeta: {
        householdId: input.householdId || null,
        planningHorizonDays: input.planningHorizonDays,
      },
      summary: output.aggregatedRefillSummary,
    },
  });

  // Optionally export to Hub (fire-and-forget)
  // No need to await in caller; we await here to prevent unhandled rejection.
  await exportToHubIfEnabled(hubPayload);

  return output;
}

export default {
  computeStorehouseRefillPlan,
  runStorehouseRefillCalculation,
};
