// C:\Users\larho\suka-smart-assistant\src\features\calculators\health\MacroCalculator\MacroCalculator.hooks.js

/**
 * MacroCalculator.hooks.js
 *
 * HOW THIS FITS:
 *  - Shared React hooks that wrap the Macro Calculator shim logic.
 *  - Centralizes:
 *      • Form state for macro inputs.
 *      • Auto-recalculation behavior.
 *      • Result caching for UI + automation runtime.
 *      • EventBus emissions when a macro plan is calculated or “applied now”.
 *  - Can be used by:
 *      • MacroCalculator.view.jsx
 *      • Other SSA pages that want to quietly compute macros in the background
 *        (e.g., onboarding wizard, “Quick Health Setup” wizard, etc.).
 *
 * EVENTS:
 *  - health.macroPlan.calculated
 *  - health.macroPlan.appliedNow
 *
 * These events carry:
 *  {
 *    input: MacroCalculatorInput,
 *    macroPlan: MacroCalculatorOutput,
 *    uiContext: { autoRecalc?: boolean, nowClicked?: boolean, source?: string }
 *  }
 *
 * The Session/Automation layer can listen and decide whether to:
 *  - spin up a “storehouse” session,
 *  - pre-fill Meal Planner / Grocery Planner,
 *  - and/or open SessionRunner.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import MacroCalculatorShim, { computeMacroPlan } from "./MacroCalculator.shim";
import { emit as emitEvent } from "@/services/events/eventBus";

/**
 * @typedef {import("./MacroCalculator.shim").MacroCalculatorResult} MacroCalculatorResult
 */

/* -------------------------------------------------------------------------- */
/* Shared Defaults (mirror config)                                            */
/* -------------------------------------------------------------------------- */

export const MACRO_DEFAULT_INPUT = {
  sex: "female",
  ageYears: 35,
  height: { value: 66, unit: "in" },
  weight: { value: 180, unit: "lb" },
  bodyFatPercent: null,
  activityLevel: "moderatelyActive",
  goal: "recomposition",
  calorieSource: "autoFromTDEE",
  manualCalories: null,
  macroStrategy: "percentOfCalories",
  protein: {
    mode: "gPerKg",
    gPerKg: 1.8,
    minGPerDay: 80,
  },
  fat: {
    mode: "percentOfCalories",
    percent: 30,
    minGPerDay: 40,
  },
  carbs: {
    mode: "remainder",
    percent: null,
    minGPerDay: 75,
  },
  rounding: {
    macroGrams: 5,
    calories: 10,
  },
  mealsPerDay: 3,
  snacksPerDay: 1,
  outputGranularity: ["perDay", "perMeal"],
  healthFlags: {
    diabetesOrPreDiabetes: false,
    kidneyIssues: false,
    pregnantOrBreastfeeding: false,
  },
  ssaIntegration: {
    allowAutoLinkToMealPlanner: true,
    allowAutoLinkToGroceryPlanner: true,
    allowAutoLinkToAnimalPlanner: true,
    preferredUnitSystem: "imperial",
    autosaveProfile: true,
  },
};

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Safe event emitter wrapper so calculator never crashes from bus errors.
 * @param {string} type
 * @param {any} data
 */
function emitMacroEvent(type, data) {
  try {
    emitEvent({
      type,
      ts: new Date().toISOString(),
      source: "features/calculators/health/MacroCalculator.hooks",
      data,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[MacroCalculator.hooks] Failed to emit event", type, err);
  }
}

/**
 * Build shim options from caller-provided options.
 *
 * @param {{ tdee?: number|null, bmr?: number|null, profileIdSeed?: string|null }|undefined} opts
 */
function buildShimOptions(opts) {
  const safe = opts || {};
  return {
    tdee: typeof safe.tdee === "number" ? safe.tdee : null,
    bmr: typeof safe.bmr === "number" ? safe.bmr : null,
    profileIdSeed: safe.profileIdSeed || null,
  };
}

/* -------------------------------------------------------------------------- */
/* Hook: useMacroCalculator                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Core hook that wraps the macro calculator shim.
 *
 * @param {object} [params]
 * @param {object} [params.initialInput] - Optional starting input; defaults to MACRO_DEFAULT_INPUT.
 * @param {boolean} [params.initialAutoRecalc=true] - Whether to auto-recalc on mount & change.
 * @param {{ tdee?: number|null, bmr?: number|null, profileIdSeed?: string|null }} [params.shimOptions] - Optional upstream TDEE/BMR and profile id seed.
 * @param {string} [params.uiSource="MacroCalculator"] - Optional label identifying the UI using this hook.
 *
 * @returns {{
 *   form: any,
 *   setForm: React.Dispatch<React.SetStateAction<any>>,
 *   autoRecalc: boolean,
 *   setAutoRecalc: React.Dispatch<React.SetStateAction<boolean>>,
 *   result: MacroCalculatorResult | null,
 *   macroOutput: MacroCalculatorResult["output"] | null,
 *   isDirty: boolean,
 *   computeOnce: (payload?: { emitEvent?: boolean }) => void,
 *   applyNow: () => void,
 *   updateField: (field: string, value: any) => void,
 *   updateNestedField: (path: string, value: any) => void,
 *   toggleGranularity: (key: "perDay"|"perMeal"|"perSnack") => void,
 *   resetForm: () => void
 * }}
 */
export function useMacroCalculator(params = {}) {
  const {
    initialInput = MACRO_DEFAULT_INPUT,
    initialAutoRecalc = true,
    shimOptions: shimOptionsRaw,
    uiSource = "MacroCalculator",
  } = params;

  const shimOptions = useMemo(
    () => buildShimOptions(shimOptionsRaw),
    [shimOptionsRaw]
  );

  const [form, setForm] = useState(initialInput);
  const [autoRecalc, setAutoRecalc] = useState(Boolean(initialAutoRecalc));

  // Last explicit result (from submit or auto-recalc).
  const [result, setResult] = useState(
    /** @type {MacroCalculatorResult | null} */ (null)
  );

  // Track if user has edited input since initialInput.
  const [isDirty, setIsDirty] = useState(false);

  // ------------------------------------------------------------------------
  // State mutation helpers
  // ------------------------------------------------------------------------

  const updateField = useCallback((field, value) => {
    setForm((prev) => {
      if (!prev || typeof prev !== "object") return { [field]: value };
      if (prev[field] === value) return prev;
      return { ...prev, [field]: value };
    });
    setIsDirty(true);
  }, []);

  const updateNestedField = useCallback((path, value) => {
    const segments = path.split(".");
    setForm((prev) => {
      const base = prev && typeof prev === "object" ? { ...prev } : {};
      let target = base;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const key = segments[i];
        target[key] = { ...(target[key] || {}) };
        target = target[key];
      }
      const lastKey = segments[segments.length - 1];
      target[lastKey] = value;
      return base;
    });
    setIsDirty(true);
  }, []);

  const toggleGranularity = useCallback((key) => {
    setForm((prev) => {
      const current = prev?.outputGranularity || [];
      const set = new Set(current);
      if (set.has(key)) {
        set.delete(key);
      } else {
        set.add(key);
      }
      return {
        ...(prev || {}),
        outputGranularity: Array.from(set),
      };
    });
    setIsDirty(true);
  }, []);

  const resetForm = useCallback(() => {
    setForm(initialInput);
    setIsDirty(false);
  }, [initialInput]);

  // ------------------------------------------------------------------------
  // Core computation
  // ------------------------------------------------------------------------

  const doCompute = useCallback(
    (payload = { emitEvent: true }) => {
      const res = computeMacroPlan(form, shimOptions);
      setResult(res);

      if (payload.emitEvent) {
        emitMacroEvent("health.macroPlan.calculated", {
          input: res.input,
          macroPlan: res.output,
          uiContext: {
            autoRecalc: false,
            source: uiSource,
          },
        });
      }
    },
    [form, shimOptions, uiSource]
  );

  // Auto-recalculate when enabled and form changes.
  useEffect(() => {
    if (!autoRecalc) return;

    const res = computeMacroPlan(form, shimOptions);
    setResult(res);

    emitMacroEvent("health.macroPlan.calculated", {
      input: res.input,
      macroPlan: res.output,
      uiContext: {
        autoRecalc: true,
        source: uiSource,
      },
    });
  }, [autoRecalc, form, shimOptions, uiSource]);

  // Macro output convenience accessor
  const macroOutput = result ? result.output : null;

  // ------------------------------------------------------------------------
  // Apply Now → event only (Session/Automation decides what to do)
  // ------------------------------------------------------------------------

  const applyNow = useCallback(() => {
    if (!result) return;
    emitMacroEvent("health.macroPlan.appliedNow", {
      input: result.input,
      macroPlan: result.output,
      uiContext: {
        nowClicked: true,
        source: uiSource,
      },
    });
  }, [result, uiSource]);

  return {
    form,
    setForm,
    autoRecalc,
    setAutoRecalc,
    result,
    macroOutput,
    isDirty,
    computeOnce: doCompute,
    applyNow,
    updateField,
    updateNestedField,
    toggleGranularity,
    resetForm,
  };
}

/* -------------------------------------------------------------------------- */
/* Convenience hook: useMacroTargetsOnly                                      */
/* -------------------------------------------------------------------------- */

/**
 * A lighter hook for callers that only care about numeric targets, not full
 * macro plan metadata or events.
 *
 * NOTE: This does NOT emit events; it is a purely local calculator.
 *
 * @param {any} input
 * @param {{ tdee?: number|null, bmr?: number|null, profileIdSeed?: string|null }} [options]
 * @returns {{
 *   calories: number,
 *   protein: number,
 *   fat: number,
 *   carbs: number
 * }}
 */
export function useMacroTargetsOnly(input, options = {}) {
  const shimOptions = useMemo(() => buildShimOptions(options), [options]);

  return useMemo(() => {
    const res = MacroCalculatorShim.getMacroTargets(input, shimOptions);
    return res;
  }, [input, shimOptions]);
}

/**
 * Default export: bundle of hooks + defaults for easier imports.
 */
const MacroCalculatorHooks = {
  useMacroCalculator,
  useMacroTargetsOnly,
  MACRO_DEFAULT_INPUT,
};

export default MacroCalculatorHooks;
