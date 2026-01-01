// C:\Users\larho\suka-smart-assistant\src\features\calculators\storehouseMeals\FermentationDurationCalculator\FermentationDurationCalculator.hooks.js

/**
 * FermentationDurationCalculator.hooks.js
 *
 * HOW THIS FITS:
 * - These hooks sit on top of the FermentationDurationCalculator shim output
 *   and connect ferments to:
 *     1) Feast day windows (for planning when ferments are “featured dishes”).
 *     2) Storehouse / inventory availability (ready window → meal planner).
 *
 * - They DO NOT render UI and DO NOT directly run sessions. Instead they:
 *     • compute alignment between ferment ready windows and feast days,
 *     • emit calendar/storehouse events into the SSA eventBus,
 *     • expose simple return values and action callbacks for UI components.
 *
 * - SessionRunner integration:
 *     • This file does not open SessionRunner directly, but it emits
 *       calendar/storehouse events that other orchestration layers and
 *       planner pages can use to schedule SessionRunner-backed sessions
 *       ahead of feasts (e.g., “move ferments to cold storage before Feast X”).
 */

import { useEffect, useMemo, useState } from "react";
import { emit as emitEvent } from "@/services/eventBus";

/**
 * @typedef {Object} FeastDay
 * @property {string} id        - Unique id (e.g. "FEAST_UNLEAVENED_BREAD_2026").
 * @property {string} name      - Human-readable name (e.g. "Feast of Unleavened Bread").
 * @property {string} date      - Central anchor date as ISO string.
 * @property {string} [windowStart] - Optional: start of feast window (ISO).
 * @property {string} [windowEnd]   - Optional: end of feast window (ISO).
 */

/**
 * @typedef {Object} FermentationCalculatorResult
 * @property {Object} data
 * @property {Object} data.inputs
 * @property {Object} data.outputs
 * @property {{ start: string, end: string }} [data.outputs.targetReadyWindow]
 * @property {Array<Object>} [data.outputs.inventoryHints]
 */

/**
 * Hook: align a ferment’s ready window with upcoming feast days.
 *
 * Usage:
 *   const { alignedFeasts, bestMatch } = useFermentationFeastAlignment({
 *     calculatorResult,
 *     feastDays
 *   });
 *
 * - `calculatorResult` is the object returned by runFermentationDurationCalculator.
 * - `feastDays` is an array of FeastDay objects (pulled from your feast/calendar module).
 *
 * The hook:
 *   • computes overlap/offset between ferment ready window and feast windows,
 *   • returns all candidates + the best match,
 *   • optionally emits `calendar.ferment.feastAlignment.computed`.
 *
 * It does not mutate calendar or inventory directly; it only emits events and
 * provides data for UI / planners to act on.
 *
 * @param {Object} params
 * @param {FermentationCalculatorResult|null} params.calculatorResult
 * @param {FeastDay[]} params.feastDays
 * @param {number} [params.toleranceDays=7]    - How far from a feast we still consider “nearby”.
 * @param {boolean} [params.autoEmit=true]     - Whether to emit an alignment event.
 */
export function useFermentationFeastAlignment({
  calculatorResult,
  feastDays,
  toleranceDays = 7,
  autoEmit = true
}) {
  const [lastEmittedKey, setLastEmittedKey] = useState(null);

  const readyWindow = calculatorResult?.data?.outputs?.targetReadyWindow || null;

  const alignedFeasts = useMemo(() => {
    if (!readyWindow || !feastDays || !feastDays.length) return [];

    const rwStart = parseIsoSafe(readyWindow.start);
    const rwEnd = parseIsoSafe(readyWindow.end);
    if (!rwStart || !rwEnd) return [];

    return feastDays
      .map((feast) => {
        const central = parseIsoSafe(feast.date);
        if (!central) return null;

        const windowStart = parseIsoSafe(feast.windowStart) || central;
        const windowEnd = parseIsoSafe(feast.windowEnd) || central;

        const overlap = getDateRangeOverlap(rwStart, rwEnd, windowStart, windowEnd);
        const overlapDays = overlap ? diffInDays(overlap.start, overlap.end) + 1 : 0;

        const offsetToStart = diffInDays(rwStart, windowStart); // + means ready starts after feast window start
        const distanceToFeastCenter = Math.abs(diffInDays(central, rwStart));

        // Classify alignment type
        let alignmentType = "none";
        if (overlapDays > 0) {
          alignmentType = "inside";
        } else if (distanceToFeastCenter <= toleranceDays) {
          alignmentType = rwStart < central ? "before" : "after";
        }

        const withinTolerance = alignmentType !== "none";

        return {
          feast,
          alignmentType,
          overlapDays,
          distanceToFeastCenter,
          withinTolerance,
          offsetToStart,
          readyWindow
        };
      })
      .filter(Boolean)
      .sort((a, b) => {
        // Prioritize:
        // 1) inside > before/after > none
        // 2) more overlapDays
        // 3) smaller distanceToFeastCenter
        const ranking = { inside: 3, before: 2, after: 2, none: 1 };
        const ra = ranking[a.alignmentType] || 0;
        const rb = ranking[b.alignmentType] || 0;

        if (ra !== rb) return rb - ra;
        if (a.overlapDays !== b.overlapDays) return b.overlapDays - a.overlapDays;
        return a.distanceToFeastCenter - b.distanceToFeastCenter;
      });
  }, [readyWindow, feastDays, toleranceDays]);

  const bestMatch = alignedFeasts.length ? alignedFeasts[0] : null;

  // Auto-emit an event whenever alignment changes meaningfully.
  useEffect(() => {
    if (!autoEmit || !readyWindow) return;

    const key = JSON.stringify({
      rw: readyWindow,
      feastIds: (feastDays || []).map((f) => f.id),
      bestFeastId: bestMatch?.feast?.id || null
    });

    if (key === lastEmittedKey) return;

    setLastEmittedKey(key);

    emitEvent({
      type: "calendar.ferment.feastAlignment.computed",
      ts: new Date().toISOString(),
      source: "hooks/FermentationDurationCalculator.useFermentationFeastAlignment",
      data: {
        readyWindow,
        alignedFeasts,
        bestMatch
      }
    });
  }, [autoEmit, readyWindow, alignedFeasts, bestMatch, feastDays, lastEmittedKey]);

  return { alignedFeasts, bestMatch };
}

/**
 * Hook: sync ferment ready window + inventory hints into the storehouse.
 *
 * Usage:
 *   const { syncStatus, syncToStorehouse } = useFermentationStorehouseSync({
 *     calculatorResult,
 *     autoSync: true
 *   });
 *
 * Behavior:
 *   • Computes a normalized payload from the calculator output:
 *       - readyWindow
 *       - inventoryHints
 *       - basic product info
 *   • Emits `storehouse.inventory.ferment.readyWindow.updated` when `syncToStorehouse`
 *     is called (or automatically if `autoSync === true`).
 *
 * The actual storehouse/inventory module is expected to listen for this event.
 *
 * @param {Object} params
 * @param {FermentationCalculatorResult|null} params.calculatorResult
 * @param {boolean} [params.autoSync=false]
 */
export function useFermentationStorehouseSync({ calculatorResult, autoSync = false }) {
  const [syncStatus, setSyncStatus] = useState(
    /** @type {"idle"|"pending"|"synced"|"error"} */ ("idle")
  );
  const [lastError, setLastError] = useState("");

  const readyWindow = calculatorResult?.data?.outputs?.targetReadyWindow || null;
  const inventoryHints = calculatorResult?.data?.outputs?.inventoryHints || [];
  const product = calculatorResult?.data?.inputs?.product || {};
  const meta = calculatorResult?.data?.meta || {};

  const normalizedPayload = useMemo(() => {
    if (!readyWindow || !product || !inventoryHints.length) return null;

    return {
      readyWindow,
      inventoryHints,
      product: {
        type: product.type,
        batchSize: product.batchSize,
        unit: product.unit,
        householdId: product.householdId || meta.householdId || null,
        projectId: product.projectId || meta.projectId || null,
        label: product.label || null
      },
      calculator: {
        id: "FermentationDurationCalculator",
        requestedAt: meta.requestedAt || null,
        sourceNode: meta.sourceNode || null
      }
    };
  }, [readyWindow, inventoryHints, product, meta]);

  /**
   * Imperative sync helper exposed to UI.
   */
  function syncToStorehouse() {
    if (!normalizedPayload) {
      setSyncStatus("error");
      setLastError(
        "FermentationStorehouseSync: missing ready window, product, or inventory hints."
      );
      return;
    }

    try {
      setSyncStatus("pending");
      setLastError("");

      emitEvent({
        type: "storehouse.inventory.ferment.readyWindow.updated",
        ts: new Date().toISOString(),
        source: "hooks/FermentationDurationCalculator.useFermentationStorehouseSync",
        data: normalizedPayload
      });

      setSyncStatus("synced");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setSyncStatus("error");
      setLastError(message);
    }
  }

  // Optional auto-sync when a fresh calculator result appears.
  useEffect(() => {
    if (!autoSync || !normalizedPayload) return;

    // Avoid re-syncing identical payloads by using a simple hash key
    const key = JSON.stringify(normalizedPayload);
    // We keep this per-instance memory with closure-scoped variable:
    // React hook rules discourage extra hooks, so we store on module-level map or just re-sync,
    // but to keep it simple & deterministic, we sync whenever autoSync & payload changes.
    syncToStorehouse();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSync, normalizedPayload]);

  return { syncStatus, lastError, syncToStorehouse, normalizedPayload };
}

/**
 * Combined hook: bridge ferment → feast days → storehouse.
 *
 * This is a convenience wrapper if you want both behaviors from a single call.
 *
 * Usage:
 *   const {
 *     alignedFeasts,
 *     bestMatch,
 *     syncStatus,
 *     syncToStorehouse
 *   } = useFermentationFeastAndStorehouseBridge({
 *     calculatorResult,
 *     feastDays,
 *     autoEmitAlignment: true,
 *     autoSyncStorehouse: false
 *   });
 *
 * @param {Object} params
 * @param {FermentationCalculatorResult|null} params.calculatorResult
 * @param {FeastDay[]} params.feastDays
 * @param {boolean} [params.autoEmitAlignment=true]
 * @param {boolean} [params.autoSyncStorehouse=false]
 */
export function useFermentationFeastAndStorehouseBridge({
  calculatorResult,
  feastDays,
  autoEmitAlignment = true,
  autoSyncStorehouse = false
}) {
  const { alignedFeasts, bestMatch } = useFermentationFeastAlignment({
    calculatorResult,
    feastDays,
    autoEmit: autoEmitAlignment
  });

  const {
    syncStatus,
    lastError,
    syncToStorehouse,
    normalizedPayload
  } = useFermentationStorehouseSync({
    calculatorResult,
    autoSync: autoSyncStorehouse
  });

  return {
    alignedFeasts,
    bestMatch,
    syncStatus,
    lastError,
    syncToStorehouse,
    storehousePayload: normalizedPayload
  };
}

/* -------------------------------------------------------------------------- */
/*                            Helper functions                                */
/* -------------------------------------------------------------------------- */

/**
 * Parse ISO string safely; returns Date or null.
 *
 * @param {string|undefined|null} value
 * @returns {Date|null}
 */
function parseIsoSafe(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Get overlap between two date ranges.
 *
 * @param {Date} aStart
 * @param {Date} aEnd
 * @param {Date} bStart
 * @param {Date} bEnd
 * @returns {{ start: Date, end: Date }|null}
 */
function getDateRangeOverlap(aStart, aEnd, bStart, bEnd) {
  const start = aStart > bStart ? aStart : bStart;
  const end = aEnd < bEnd ? aEnd : bEnd;
  return start <= end ? { start, end } : null;
}

/**
 * Difference in days between two dates (rounded towards zero).
 *
 * @param {Date} a
 * @param {Date} b
 * @returns {number}
 */
function diffInDays(a, b) {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((a.getTime() - b.getTime()) / msPerDay);
}
