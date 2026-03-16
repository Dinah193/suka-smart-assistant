// C:\Users\larho\suka-smart-assistant\src\features\calculators\gardenAnimal\GardenYieldCalculator\GardenYieldCalculator.hooks.js

import { useState, useCallback, useMemo, useEffect } from "react";
import { runGardenYieldCalculatorShim } from "./GardenYieldCalculator.shim";
import eventBus from "@/services/events/eventBus";

/**
 * useGardenYieldCalculatorState
 *
 * Core hook that owns payload/result state for the Garden Yield Calculator.
 * It runs the shim, emits calculator events, and exposes a recalculate()
 * function that views can wire to buttons.
 *
 * Options:
 * - initialPayload?: { context, inputs, outputs }
 * - featureFlags?: { familyFundMode?: boolean }
 * - bus?: { emit: Function } (defaults to global eventBus)
 * - onResult?: (payloadWithOutputs) => void
 * - onPayloadChange?: (payload) => void
 */
export function useGardenYieldCalculatorState(options = {}) {
  const {
    initialPayload,
    featureFlags,
    bus = eventBus,
    onResult,
    onPayloadChange,
  } = options;

  const [payload, setPayload] = useState(() =>
    initialPayload && typeof initialPayload === "object"
      ? initialPayload
      : buildDefaultYieldPayload()
  );

  const [result, setResult] = useState(() =>
    initialPayload && initialPayload.outputs ? initialPayload : null
  );

  const [isComputing, setIsComputing] = useState(false);
  const [error, setError] = useState("");

  const inputs = payload.inputs || {};
  const outputs = (result && result.outputs) || null;

  const recalculate = useCallback(
    async (overridePayload) => {
      const effectivePayload =
        overridePayload && typeof overridePayload === "object"
          ? overridePayload
          : payload;

      if (!effectivePayload || !effectivePayload.inputs) {
        setError("Yield calculator missing inputs.");
        return null;
      }

      setIsComputing(true);
      setError("");

      const ts = new Date().toISOString();

      safeEmit(bus, {
        type: "calculator.garden.yield.requested",
        ts,
        source: "calculators/garden/GardenYieldCalculator.hooks",
        data: {
          payload: effectivePayload,
        },
      });

      try {
        const next = await runGardenYieldCalculatorShim(effectivePayload, {
          eventBus: bus,
          featureFlags: {
            familyFundMode:
              featureFlags && typeof featureFlags.familyFundMode === "boolean"
                ? featureFlags.familyFundMode
                : false,
          },
        });

        setResult(next);
        setPayload(next);

        if (typeof onResult === "function") onResult(next);
        if (typeof onPayloadChange === "function") onPayloadChange(next);

        safeEmit(bus, {
          type: "calculator.garden.yield.completed",
          ts: new Date().toISOString(),
          source: "calculators/garden/GardenYieldCalculator.hooks",
          data: {
            payload: next,
          },
        });

        return next;
      } catch (err) {
        console.error("[useGardenYieldCalculatorState] error:", err);
        setError("Unable to recompute garden yields. Please verify inputs.");

        safeEmit(bus, {
          type: "calculator.garden.yield.failed",
          ts: new Date().toISOString(),
          source: "calculators/garden/GardenYieldCalculator.hooks",
          data: {
            error: String(err),
          },
        });

        return null;
      } finally {
        setIsComputing(false);
      }
    },
    [payload, bus, featureFlags, onResult, onPayloadChange]
  );

  const summary = useMemo(() => {
    if (!outputs || !outputs.summary) return null;
    return outputs.summary;
  }, [outputs]);

  return {
    payload,
    setPayload,
    inputs,
    outputs,
    summary,
    result,
    isComputing,
    error,
    recalculate,
  };
}

/**
 * useStorehouseTargetsFromYield
 *
 * Hook to derive or refine storehouse target suggestions from yield outputs.
 * This acts as a bridge between the Garden Yield node and storehouse planning.
 *
 * It does NOT mutate Dexie directly; instead it:
 * - exposes a derived "storehouseSuggestions" array, and
 * - optionally emits "storehouse.targets.suggested" for the rest of SSA.
 *
 * Options:
 * - yieldOutputs: payload.outputs from the yield calculator
 * - householdProfile?: { peopleCount?: number, monthsTarget?: number }
 * - bus?: eventBus-like
 * - autoEmit?: boolean (default true)
 */
export function useStorehouseTargetsFromYield(options = {}) {
  const {
    yieldOutputs,
    householdProfile,
    bus = eventBus,
    autoEmit = true,
  } = options;

  const yieldEstimates = (yieldOutputs && yieldOutputs.yieldEstimates) || [];
  const storehouseCoverage =
    (yieldOutputs && yieldOutputs.storehouseCoverage) || [];

  const profile = householdProfile || {};
  const peopleCount = profile.peopleCount || 0;
  const monthsTarget = profile.monthsTarget || 0;

  const suggestions = useMemo(() => {
    if (!Array.isArray(yieldEstimates) || yieldEstimates.length === 0) {
      return [];
    }

    const out = [];

    for (const est of yieldEstimates) {
      const coverage =
        Array.isArray(storehouseCoverage) &&
        storehouseCoverage.find(
          (c) =>
            c.cropId && est.cropId && String(c.cropId) === String(est.cropId)
        );

      const unit = est.yieldUnit || "lbs";
      const expectedPreserved =
        coverage && typeof coverage.expectedPreservedAmount === "number"
          ? coverage.expectedPreservedAmount
          : est.forPreservation || 0;

      const perPersonPerMonth =
        peopleCount > 0 && monthsTarget > 0
          ? expectedPreserved / (peopleCount * monthsTarget)
          : null;

      out.push({
        cropId: est.cropId || est.cropName,
        cropName: est.cropName,
        unit,
        expectedPreserved,
        perPersonPerMonth,
        peopleCount,
        monthsTarget,
        coverageStatus: coverage ? coverage.status : "unknown",
        coveragePercent: coverage ? coverage.coveragePercent : null,
      });
    }

    return out;
  }, [yieldEstimates, storehouseCoverage, peopleCount, monthsTarget]);

  useEffect(() => {
    if (!autoEmit || suggestions.length === 0) return;

    const ts = new Date().toISOString();

    safeEmit(bus, {
      type: "storehouse.targets.suggested",
      ts,
      source: "calculators/garden/GardenYieldCalculator.hooks",
      data: {
        suggestions,
        householdProfile: profile,
      },
    });
  }, [autoEmit, bus, suggestions, profile]);

  return {
    storehouseSuggestions: suggestions,
  };
}

/**
 * useYieldToBatchAndPreservationBridge
 *
 * Hook that listens to yield calculator outputs and emits batch/preservation
 * planning events based on the "preservationLoad" and "harvestLoadByWeek"
 * outputs from the shim.
 *
 * It does not schedule sessions directly; instead, it:
 * - emits "preservation.batches.suggested" with the load groups
 * - emits "garden.harvestLoad.summarized" with weekly harvest buckets
 *
 * Options:
 * - yieldOutputs
 * - bus?: eventBus-like
 * - autoEmit?: boolean (default true)
 * - tag?: string (optional tag to help downstream filter events)
 */
export function useYieldToBatchAndPreservationBridge(options = {}) {
  const { yieldOutputs, bus = eventBus, autoEmit = true, tag } = options;

  const preservationLoad =
    (yieldOutputs && yieldOutputs.preservationLoad) || [];
  const harvestLoadByWeek =
    (yieldOutputs && yieldOutputs.harvestLoadByWeek) || [];

  const hasData = preservationLoad.length > 0 || harvestLoadByWeek.length > 0;

  useEffect(() => {
    if (!autoEmit || !hasData) return;

    const ts = new Date().toISOString();

    if (preservationLoad.length > 0) {
      safeEmit(bus, {
        type: "preservation.batches.suggested",
        ts,
        source: "calculators/garden/GardenYieldCalculator.hooks",
        data: {
          groups: preservationLoad,
          tag: tag || null,
        },
      });
    }

    if (harvestLoadByWeek.length > 0) {
      safeEmit(bus, {
        type: "garden.harvestLoad.summarized",
        ts,
        source: "calculators/garden/GardenYieldCalculator.hooks",
        data: {
          weeks: harvestLoadByWeek,
          tag: tag || null,
        },
      });
    }
  }, [autoEmit, bus, harvestLoadByWeek, preservationLoad, hasData, tag]);

  return {
    hasYieldBridges: hasData,
    preservationLoad,
    harvestLoadByWeek,
  };
}

/**
 * Build a default garden yield payload.
 * Kept small so views and tests can share the same baseline.
 */
function buildDefaultYieldPayload() {
  const now = new Date();
  return {
    context: {
      nodeKey: "gardenYield",
      version: "1.0.0",
    },
    inputs: {
      crops: [],
      plantingWindows: [],
      harvestWindows: [],
      storehouseTargets: {
        year: now.getFullYear(),
        targetsByCrop: [],
      },
      assumptions: {
        lossFactor: 0.15,
        laborHoursPerUnit: 0.25,
        batchSizeDefaults: {
          canning: 10,
          freezing: 10,
          dehydrating: 8,
          fermenting: 8,
          rootCellar: 12,
          unit: "lbs",
        },
      },
    },
    outputs: null,
  };
}

/**
 * Safe event bus emit wrapper.
 */
function safeEmit(bus, payload) {
  try {
    if (!bus || typeof bus.emit !== "function") return;
    bus.emit(payload);
  } catch (err) {
    console.warn("[GardenYieldCalculator.hooks] emit failed:", err);
  }
}

export default {
  useGardenYieldCalculatorState,
  useStorehouseTargetsFromYield,
  useYieldToBatchAndPreservationBridge,
};
