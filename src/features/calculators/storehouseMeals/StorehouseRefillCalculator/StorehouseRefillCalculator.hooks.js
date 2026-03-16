// C:\Users\larho\suka-smart-assistant\src\features\calculators\storehouseMeals\StorehouseRefillCalculator\StorehouseRefillCalculator.hooks.js

/**
 * StorehouseRefillCalculator.hooks.js
 *
 * HOW THIS FITS
 * -------------
 * These hooks connect the Storehouse Refill shim to the rest of SSA:
 *
 * - useStorehouseRefillPlanner:
 *   Small wrapper around runStorehouseRefillCalculation that is React-friendly,
 *   resilient, and emits planning events. Useful for pages, sidebars, and
 *   SessionRunner-adjacent UIs that want to ask:
 *     "Given this snapshot, what should we restock?"
 *
 * - useRefillToShoppingSession:
 *   Turns a StorehouseRefillOutput into a structured "shopping session"
 *   object that the SessionRunner or shopping flows can use. Emits an
 *   event so background workers or the Planning Graph can pick it up and
 *   persist or schedule it.
 *
 * - useRefillInventorySync:
 *   Produces a set of patch-like operations for the inventory module,
 *   so that "refill was completed" can reconcile back into the storehouse.
 *   The persistence details are intentionally left to the caller.
 *
 * Background-safe:
 * - The heavy calculation logic remains in StorehouseRefillCalculator.shim.js.
 * - That shim can be called directly from a Web Worker or SSA runtime.
 * - These hooks are only a React convenience layer; if the user navigates
 *   away, background workers can keep running, emit events, and resume
 *   via Dexie + SessionRunner.
 */

import { useCallback, useMemo, useState } from "react";
import { runStorehouseRefillCalculation } from "./StorehouseRefillCalculator.shim";
import { emit } from "@/services/events/eventBus";

/**
 * @typedef {import("./StorehouseRefillCalculator.schema.json").definitions.StorehouseRefillInput} StorehouseRefillInput
 * @typedef {import("./StorehouseRefillCalculator.schema.json").definitions.StorehouseRefillOutput} StorehouseRefillOutput
 */

/**
 * React-friendly wrapper around the Storehouse Refill shim.
 *
 * - Handles basic loading + error state.
 * - Emits planning events when a plan is computed or fails.
 * - Returns the latest result and a stable `run` callback.
 *
 * Example:
 *   const {
 *     input,
 *     setInput,
 *     result,
 *     isRunning,
 *     error,
 *     lastRunAt,
 *     run
 *   } = useStorehouseRefillPlanner(initialInput, { source: "storehouse-page" });
 *
 * @param {StorehouseRefillInput | null} initialInput
 * @param {{
 *   source?: string;
 *   autoEmitEvents?: boolean;
 * }} [options]
 */
export function useStorehouseRefillPlanner(initialInput, options = {}) {
  const { source = "calculators/storehouseRefill", autoEmitEvents = true } =
    options;

  const [input, setInput] = useState(
    /** @type {StorehouseRefillInput | null} */ (initialInput || null)
  );
  const [result, setResult] = useState(
    /** @type {StorehouseRefillOutput | null} */ (null)
  );
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState("");
  const [lastRunAt, setLastRunAt] = useState(
    /** @type {string | null} */ (null)
  );

  /**
   * Run the refill planner for the current input.
   *
   * @type {() => Promise<StorehouseRefillOutput | null>}
   */
  const run = useCallback(async () => {
    if (!input) {
      setError(
        "No storehouse input. Please provide a snapshot before running."
      );
      return null;
    }

    setIsRunning(true);
    setError("");
    const ts = new Date().toISOString();

    if (autoEmitEvents) {
      emit({
        type: "planning.storehouseRefill.requested",
        ts,
        source,
        data: { input },
      });
    }

    try {
      const output = await runStorehouseRefillCalculation(input);
      setResult(output);
      setLastRunAt(ts);

      if (autoEmitEvents) {
        emit({
          type: "planning.storehouseRefill.completed",
          ts: new Date().toISOString(),
          source,
          data: { input, output },
        });
      }

      return output;
    } catch (err) {
      console.error("[useStorehouseRefillPlanner] calculation failed:", err);
      const msg = "Unable to compute refill suggestions. Please try again.";
      setError(msg);

      if (autoEmitEvents) {
        emit({
          type: "planning.storehouseRefill.failed",
          ts: new Date().toISOString(),
          source,
          data: {
            input,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }

      return null;
    } finally {
      setIsRunning(false);
    }
  }, [input, autoEmitEvents, source]);

  return {
    input,
    setInput,
    result,
    isRunning,
    error,
    lastRunAt,
    run,
  };
}

/**
 * Derive a "shopping session" payload from a StorehouseRefillOutput.
 *
 * This does NOT persist or schedule anything by itself.
 * It:
 * - Normalizes the data into a shopping-session-like object.
 * - Emits a planning event so other parts of SSA can listen.
 *
 * The caller can:
 * - Hand the returned session off to SessionRunner.
 * - Store it in Dexie.
 * - Convert to a printable / shareable list.
 *
 * Example:
 *   const { buildShoppingSession } = useRefillToShoppingSession();
 *   const session = buildShoppingSession(refillOutput, { labelOverride: "Aldi run" });
 *
 * @param {{
 *   source?: string;
 *   autoEmitEvents?: boolean;
 * }} [options]
 */
export function useRefillToShoppingSession(options = {}) {
  const { source = "calculators/storehouseRefill", autoEmitEvents = true } =
    options;

  /**
   * @param {StorehouseRefillOutput | null} refill
   * @param {{
   *   labelOverride?: string;
   *   householdId?: string;
   *   preferredStoreIds?: string[];
   * }} [opts]
   */
  const buildShoppingSession = useCallback(
    (refill, opts = {}) => {
      if (!refill) return null;

      const { labelOverride, householdId, preferredStoreIds = [] } = opts;

      const ts = new Date().toISOString();

      const lines = Array.isArray(refill.refillLines) ? refill.refillLines : [];

      const session = {
        id: `shopping-${ts}`,
        domain: "storehouse",
        title: labelOverride || "Storehouse Refill Shopping Session",
        source: {
          type: "import",
          refId: refill.runContext?.sourceRefId || null,
        },
        meta: {
          kind: "shopping",
          householdId: householdId || refill.runContext?.householdId || null,
          planningHorizonDays: refill.runContext?.planningHorizonDays || null,
          preferredStoreIds,
          aggregatedRefillSummary: refill.aggregatedRefillSummary || null,
        },
        lines: lines.map((line) => ({
          itemId: line.itemId,
          label: line.label,
          category: line.category || null,
          location: line.location || null,
          currentQty: line.currentQty,
          uom: line.uom,
          targetQty: line.targetQty,
          refillQty: line.refillQty,
          urgency: line.urgency,
          notes: line.notes || null,
        })),
        createdAt: ts,
        updatedAt: ts,
      };

      if (autoEmitEvents) {
        emit({
          type: "planning.storehouseRefill.shoppingSession.created",
          ts,
          source,
          data: { refill, session },
        });
      }

      return session;
    },
    [autoEmitEvents, source]
  );

  return { buildShoppingSession };
}

/**
 * Helper to create inventory patch operations from a StorehouseRefillOutput.
 *
 * This keeps inventory persistence concerns OUT of the calculator.
 * You get back an array of operations like:
 *   [
 *     { itemId: "rice_5lb", type: "increment", amount: 2, uom: "bag" },
 *     { itemId: "olive_oil_1L", type: "set", newQty: 3, uom: "bottle" }
 *   ]
 *
 * The caller decides how to:
 *   - Apply these in Dexie / remote DB
 *   - Attach them to a SessionRunner "completed shopping" event
 *
 * Example:
 *   const { deriveInventoryPatches } = useRefillInventorySync();
 *   const patches = deriveInventoryPatches(refillOutput, { mode: "increment" });
 *
 * @param {{
 *   source?: string;
 *   autoEmitEvents?: boolean;
 * }} [options]
 */
export function useRefillInventorySync(options = {}) {
  const { source = "calculators/storehouseRefill", autoEmitEvents = true } =
    options;

  /**
   * @param {StorehouseRefillOutput | null} refill
   * @param {{
   *   mode?: "increment" | "set";
   * }} [opts]
   */
  const deriveInventoryPatches = useCallback(
    (refill, opts = {}) => {
      if (!refill || !Array.isArray(refill.refillLines)) return [];

      const { mode = "increment" } = opts;

      const patches = refill.refillLines
        .filter((line) => line.refillQty > 0)
        .map((line) => {
          if (mode === "set") {
            return {
              type: "set",
              itemId: line.itemId,
              newQty: line.targetQty,
              uom: line.uom,
            };
          }

          // default: increment mode
          return {
            type: "increment",
            itemId: line.itemId,
            amount: line.refillQty,
            uom: line.uom,
          };
        });

      if (autoEmitEvents && patches.length > 0) {
        emit({
          type: "planning.storehouseRefill.inventoryPatches.derived",
          ts: new Date().toISOString(),
          source,
          data: { refill, patches, mode },
        });
      }

      return patches;
    },
    [autoEmitEvents, source]
  );

  const deriveHairNutritionSubset = useCallback(
    /**
     * Subset of patches that look like hair + scalp nutrition items based on notes/category.
     *
     * @param {StorehouseRefillOutput | null} refill
     * @returns {StorehouseRefillOutput["refillLines"]}
     */
    (refill) => {
      if (!refill || !Array.isArray(refill.refillLines)) return [];

      return refill.refillLines.filter((line) => {
        const cat = (line.category || "").toLowerCase();
        const notes = (line.notes || "").toLowerCase();
        if (/hair/.test(cat)) return true;
        if (/hair|scalp|collagen|biotin|omega-3/.test(notes)) return true;
        return false;
      });
    },
    []
  );

  return useMemo(
    () => ({
      deriveInventoryPatches,
      deriveHairNutritionSubset,
    }),
    [deriveInventoryPatches, deriveHairNutritionSubset]
  );
}
