// C:\Users\larho\suka-smart-assistant\src\features\calculators\health\HairNutritionCalculator\HairNutritionCalculator.hooks.js

/**
 * HairNutritionCalculator.hooks.js
 *
 * React hooks for the Black Hair Nutrition Calculator in Suka Smart Assistant (SSA).
 *
 * How this fits:
 * - Wraps the pure shim logic (HairNutritionCalculator.shim.js) in React-friendly hooks.
 * - Keeps calculator input/result state resilient while the user navigates around SSA.
 * - Persists last-used input + result so the user can return later without losing context.
 * - Emits consistent events that Planning Graph, Meal Planner, and Storehouse flows
 *   can subscribe to via the SSA eventBus.
 *
 * Design notes:
 * - All heavy logic lives in the shim (runHairNutritionCalculatorShim).
 * - Hooks are “UI helpers” that:
 *   - manage input state,
 *   - handle loading / error states,
 *   - bridge results into SSA’s Planning Graph via eventBus.
 * - Safe to call from any calculator view component; does not assume a specific route.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { emit } from "@/services/events/eventBus";
import HairNutritionCalculatorShim, {
  runHairNutritionCalculatorShim,
} from "./HairNutritionCalculator.shim";

const STORAGE_KEY = "ssa.hairNutritionCalculator.state";

/**
 * Load previously saved calculator state (input + result) from localStorage.
 * Returns null on any error.
 * @returns {{ input: object, result: object } | null}
 */
function loadPersistedState() {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Persist calculator state (input + result) to localStorage.
 * @param {object} input
 * @param {object|null} result
 */
function persistState(input, result) {
  if (typeof window === "undefined") return;
  try {
    const payload = { input, result };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore storage errors; never block UX.
  }
}

/**
 * Build sensible default input values.
 * This mirrors the defaults in HairNutritionCalculator.view.jsx but is centralized
 * so future views (e.g., mobile, SessionRunner overlays) can reuse it.
 */
export function buildDefaultHairNutritionInput() {
  return {
    unitSystem: "imperial",
    bodyWeight: 180,
    activityLevel: "sedentary",

    hairTypeProfile: {
      curlPattern: "coily-4c",
      porosity: "high",
      density: "high",
      scalpCondition: "dry",
      chemicalHistory: [],
    },

    growthGoalFlags: {
      lengthRetention: true,
      thickness: true,
      sheddingReduction: false,
      scalpHealing: false,
      postpartumSupport: false,
    },

    protectiveStylePattern: {
      protectiveStyleType: "twists",
      weeksPerStyle: 6,
      installTensionLevel: "medium",
    },

    macroTargets: {
      calories: 2000,
      proteinGrams: 90,
      fatGrams: 70,
      carbGrams: 220,
    },

    micronutrientFocusFlags: {
      ironLowRisk: false,
      vitaminDLowRisk: true,
      zincLowRisk: false,
      omega3LowRisk: true,
      biotinLowRisk: false,
      generalMicronutrientConcern: false,
    },

    dietaryPattern: "omnivore",
    dietaryConstraints: {
      allergies: [],
      avoids: [],
      budgetLevel: "budget-conscious",
    },

    hydrationCupsCurrent: 6,
  };
}

/**
 * useHairNutritionCalculatorState
 *
 * Manages hair nutrition calculator input + last result, with persistence.
 *
 * Responsibilities:
 * - Initialize from localStorage if available, otherwise from defaults.
 * - Keep input/result in sync with localStorage so navigating away and back
 *   does not lose the user’s progress.
 *
 * @returns {{
 *   input: object,
 *   setInput: (updater: object | ((prev: object) => object)) => void,
 *   result: object | null,
 *   setResult: (val: object | null) => void,
 *   reset: () => void
 * }}
 */
export function useHairNutritionCalculatorState() {
  const [input, setInputState] = useState(() => {
    const persisted = loadPersistedState();
    if (persisted && persisted.input) {
      // Merge persisted input over defaults to keep schema evolution safe.
      return { ...buildDefaultHairNutritionInput(), ...persisted.input };
    }
    return buildDefaultHairNutritionInput();
  });

  const [result, setResultState] = useState(() => {
    const persisted = loadPersistedState();
    return persisted ? persisted.result || null : null;
  });

  // Persist whenever input or result changes.
  useEffect(() => {
    persistState(input, result);
  }, [input, result]);

  const setInput = useCallback((next) => {
    setInputState((prev) => {
      const value = typeof next === "function" ? next(prev) : next;
      return value;
    });
  }, []);

  const setResult = useCallback((next) => {
    setResultState(next);
  }, []);

  const reset = useCallback(() => {
    const defaults = buildDefaultHairNutritionInput();
    setInputState(defaults);
    setResultState(null);
    persistState(defaults, null);
  }, []);

  return { input, setInput, result, setResult, reset };
}

/**
 * useHairNutritionCalculatorRunner
 *
 * Runs the Black Hair Nutrition Calculator shim and tracks loading/error status.
 *
 * How this helps:
 * - Centralizes async handling and race-protection for calculator calls.
 * - Makes it easy to integrate the calculator into multiple views or flows,
 *   including background-driven “Planning Graph” or SessionRunner prep.
 * - Optionally triggers a “bridge” event into the Planning Graph.
 *
 * @param {object} [options]
 * @param {boolean} [options.autoRunOnMount=false] - if true, runs once with current input when mounted
 * @param {boolean} [options.exportToHub=false] - request Hub export from shim (still gated by familyFundMode)
 * @param {boolean} [options.emitPlanningGraphEvent=true] - emit an event when calculation succeeds
 *
 * @returns {{
 *   run: (input: object) => Promise<{ meta: object, input: object, output: object } | null>,
 *   status: "idle" | "running" | "success" | "error",
 *   error: string | null,
 *   lastPayload: { meta: object, input: object, output: object } | null
 * }}
 */
export function useHairNutritionCalculatorRunner(options = {}) {
  const {
    autoRunOnMount = false,
    exportToHub = false,
    emitPlanningGraphEvent = true,
  } = options;

  const [status, setStatus] = useState(
    /** @type {"idle"|"running"|"success"|"error"} */ "idle"
  );
  const [error, setError] = useState(null);
  const [lastPayload, setLastPayload] = useState(null);

  // A ref token to prevent race conditions between overlapping runs.
  const runTokenRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /**
   * Emit an integration event so Planning Graph / other calculators
   * can react to new hair nutrition outputs.
   *
   * @param {object} payload
   */
  const emitPlanningGraphBridgeEvent = useCallback(
    (payload) => {
      if (!emitPlanningGraphEvent) return;

      try {
        emit({
          type: "planningGraph.node.hairNutrition.updated",
          ts: new Date().toISOString(),
          source:
            "features/calculators/health/HairNutritionCalculator.hooks/useHairNutritionCalculatorRunner",
          data: {
            nodeId: HairNutritionCalculatorShim.NODE_ID,
            meta: payload.meta,
            input: payload.input,
            output: payload.output,
            provides: {
              // Match config.graph.provides keys
              dailyHairProteinTarget: payload.output.dailyHairProteinTarget,
              hairAminoProfile: payload.output.hairAminoProfile,
              hairSupportFlags: payload.output.hairSupportFlags,
              hairMicronutrientTargets: payload.output.hairMicronutrientTargets,
              hairHealthyFatTargets: payload.output.hairHealthyFatTargets,
              blackHairRiskFlags: payload.output.blackHairRiskFlags,
            },
          },
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          "[useHairNutritionCalculatorRunner] Failed to emit planningGraph bridge event:",
          err
        );
      }
    },
    [emitPlanningGraphEvent]
  );

  /**
   * Run the calculator with a given input object.
   *
   * Notes:
   * - Uses a token to ignore stale results from older calls.
   * - Safe to call multiple times; latest call wins.
   *
   * @param {object} input
   * @returns {Promise<{ meta: object, input: object, output: object } | null>}
   */
  const run = useCallback(
    async (input) => {
      if (!input || typeof input !== "object") {
        setError(
          "HairNutritionCalculator.run requires a non-null input object."
        );
        setStatus("error");
        return null;
      }

      const token = ++runTokenRef.current;
      setStatus("running");
      setError(null);

      try {
        const payload = await runHairNutritionCalculatorShim(input, {
          exportToHub,
        });

        // If another run started after this one, ignore this result.
        if (!mountedRef.current || token !== runTokenRef.current) {
          return null;
        }

        setStatus("success");
        setLastPayload(payload);
        emitPlanningGraphBridgeEvent(payload);
        return payload;
      } catch (err) {
        if (!mountedRef.current || token !== runTokenRef.current) {
          return null;
        }
        // eslint-disable-next-line no-console
        console.error(
          "[useHairNutritionCalculatorRunner] shim run error:",
          err
        );
        setStatus("error");
        setError(err?.message || "Calculator error.");
        return null;
      }
    },
    [exportToHub, emitPlanningGraphBridgeEvent]
  );

  // Optional auto-run on mount (e.g. for background/automation flows).
  useEffect(() => {
    if (!autoRunOnMount) return;
    // We do NOT know the input here; caller should trigger run() manually with the
    // correct input, so this is just a hook-in point for future extension.
    // Keeping this for parity with other calculator hooks.
  }, [autoRunOnMount]);

  return {
    run,
    status,
    error,
    lastPayload,
  };
}

/**
 * useHairNutritionCalculator
 *
 * Convenience hook combining:
 * - input/result state management, and
 * - runner logic.
 *
 * Useful for most UI views that just want:
 *   const { input, setInput, result, status, error, run } = useHairNutritionCalculator();
 *
 * @param {object} [options] - forwarded to useHairNutritionCalculatorRunner
 */
export function useHairNutritionCalculator(options = {}) {
  const { input, setInput, result, setResult, reset } =
    useHairNutritionCalculatorState();

  const { run, status, error, lastPayload } =
    useHairNutritionCalculatorRunner(options);

  /**
   * Run the calculator using the current input state.
   */
  const runWithCurrentInput = useCallback(async () => {
    const payload = await run(input);
    if (payload) {
      setResult(payload);
    }
    return payload;
  }, [run, input, setResult]);

  return {
    input,
    setInput,
    result: result || lastPayload,
    status,
    error,
    run: runWithCurrentInput,
    reset,
  };
}
