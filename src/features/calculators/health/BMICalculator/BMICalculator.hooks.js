// C:\Users\larho\suka-smart-assistant\src\features\calculators\health\BMICalculator\BMICalculator.hooks.js

/**
 * BMICalculator.hooks.js
 *
 * HOW THIS FITS:
 *  - Provides React hooks for:
 *      • Managing BMI calculator form state
 *      • Running BMI computations via BMICalculator.shim
 *      • Emitting SSA events for orchestration and Planning Graph flows
 *
 *  - Hooks DO NOT:
 *      • Talk directly to SessionRunner
 *      • Touch Dexie or the Hub
 *
 *  - Instead they emit clean, semantic events that other layers react to:
 *      • health.bmi.calculated
 *      • health.bmi.appliedNow
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import BMICalculatorShim, { computeBMI, getBMIOnly as shimGetBMIOnly } from "./BMICalculator.shim";
import { emit as emitEvent } from "@/services/eventBus";

/**
 * @typedef {import("./BMICalculator.shim").BMICalculatorInput} BMICalculatorInput
 * @typedef {import("./BMICalculator.shim").BMICalculatorResult} BMICalculatorResult
 */

/* -------------------------------------------------------------------------- */
/* Defaults (mirror BMICalculator.config.json & BMICalculator.view.jsx)       */
/* -------------------------------------------------------------------------- */

/** @type {BMICalculatorInput} */
export const BMI_DEFAULT_INPUT = {
  height: {
    value: 66,
    unit: "in"
  },
  weight: {
    value: 180,
    unit: "lb"
  },
  sex: "unspecified",
  ageYears: 35,
  unitSystem: "imperial",
  rounding: {
    bmiDecimals: 1,
    weightDecimals: 1
  },
  ssaIntegration: {
    autosaveProfile: true,
    allowLinkToMacroCalculator: true
  }
};

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Safe event emitter wrapper namespaced for BMI.
 *
 * @param {string} type
 * @param {any} data
 */
function emitBMIEvent(type, data) {
  try {
    emitEvent({
      type,
      ts: new Date().toISOString(),
      source: "features/calculators/health/BMICalculator.hooks",
      data
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[BMICalculator.hooks] Failed to emit event", type, err);
  }
}

/**
 * Translate raw form values (string | number) to proper numeric inputs.
 *
 * @param {BMICalculatorInput} form
 * @returns {BMICalculatorInput}
 */
function normalizeFormToInput(form) {
  const safe = form || /** @type {any} */ ({});
  return {
    ...safe,
    height: {
      value: Number(safe.height?.value) || 0,
      unit: safe.height?.unit === "cm" ? "cm" : "in"
    },
    weight: {
      value: Number(safe.weight?.value) || 0,
      unit: safe.weight?.unit === "kg" ? "kg" : "lb"
    }
  };
}

/* -------------------------------------------------------------------------- */
/* useBMICalculator – full-feature hook                                       */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} UseBMICalculatorOptions
 * @property {BMICalculatorInput} [initialInput]    Optional initial input (defaults to BMI_DEFAULT_INPUT).
 * @property {boolean} [autoRecalcDefault]         Whether to auto-recompute when form changes (default true).
 * @property {boolean} [emitEvents]                Whether to emit health.bmi.* events (default true).
 */

/**
 * Main hook for BMI Calculator form + result state.
 *
 * HOW TO USE:
 *  - Use this in your BMI calculator page (or any embedded BMI widget)
 *  - Wire the returned state/handlers into your UI controls
 *
 * EVENTS:
 *  - When computeOnce / autoRecalc runs and emitEvents=true:
 *      • health.bmi.calculated
 *  - When applyNow() is called and emitEvents=true:
 *      • health.bmi.appliedNow
 *
 * @param {UseBMICalculatorOptions} [options]
 */
export function useBMICalculator(options = {}) {
  const {
    initialInput = BMI_DEFAULT_INPUT,
    autoRecalcDefault = true,
    emitEvents = true
  } = options;

  /** @type {[BMICalculatorInput, Function]} */
  const [form, setForm] = useState(initialInput);
  /** @type {[BMICalculatorResult|null, Function]} */
  const [result, setResult] = useState(null);
  const [autoRecalc, setAutoRecalc] = useState(Boolean(autoRecalcDefault));
  const [isDirty, setIsDirty] = useState(false);

  const bmiOutput = useMemo(() => (result ? result.output : null), [result]);

  // ------------------------------------------------------------------------
  // Form updates
  // ------------------------------------------------------------------------

  /**
   * Shallow update of top-level fields (e.g., 'sex', 'ageYears', 'unitSystem').
   *
   * @param {keyof BMICalculatorInput} field
   * @param {any} value
   */
  const updateField = useCallback((field, value) => {
    setForm((prev) => ({
      ...(prev || {}),
      [field]: value
    }));
    setIsDirty(true);
  }, []);

  /**
   * Update nested fields via simple "a.b.c" string paths.
   * E.g., updateNestedField("height.value", 65)
   *
   * @param {string} path
   * @param {any} value
   */
  const updateNestedField = useCallback((path, value) => {
    const segments = path.split(".");
    setForm((prev) => {
      const base = prev ? { ...prev } : {};
      let target = base;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const key = segments[i];
        target[key] = { ...(target[key] || {}) };
        target = target[key];
      }
      const last = segments[segments.length - 1];
      target[last] = value;
      return /** @type {BMICalculatorInput} */ (base);
    });
    setIsDirty(true);
  }, []);

  /**
   * Reset form to the default input object.
   */
  const resetForm = useCallback(() => {
    setForm(initialInput);
    setIsDirty(false);
  }, [initialInput]);

  // ------------------------------------------------------------------------
  // Computation
  // ------------------------------------------------------------------------

  /**
   * Compute BMI once with current form state.
   *
   * @param {{ emitEvent?: boolean; autoRecalc?: boolean }} [opts]
   */
  const computeOnce = useCallback(
    (opts = {}) => {
      const { emitEvent = emitEvents, autoRecalc: fromAuto = false } = opts;

      const input = normalizeFormToInput(form);
      const res = computeBMI(input);
      setResult(res);

      if (emitEvent) {
        emitBMIEvent("health.bmi.calculated", {
          input: res.input,
          output: res.output,
          uiContext: {
            autoRecalc: Boolean(fromAuto),
            source: "BMICalculator.hook"
          }
        });
      }
    },
    [emitEvents, form]
  );

  // Auto-recalc effect: runs whenever form changes if enabled
  useEffect(() => {
    if (!autoRecalc) return;
    computeOnce({ emitEvent: true, autoRecalc: true });
  }, [autoRecalc, form, computeOnce]);

  // Initial compute (optional; keep it consistent with autoRecalc)
  useEffect(() => {
    if (autoRecalc) {
      computeOnce({ emitEvent: true, autoRecalc: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ------------------------------------------------------------------------
  // “Use BMI in Plans” handler
  // ------------------------------------------------------------------------

  /**
   * Semantic "Now" action – call this when the user wants to use BMI in other planners.
   * Typically wired to a "Use BMI in Plans" button.
   */
  const applyNow = useCallback(() => {
    if (!emitEvents) return;
    if (!result) {
      // Optionally compute first if there is no result yet
      const input = normalizeFormToInput(form);
      const res = computeBMI(input);
      setResult(res);

      emitBMIEvent("health.bmi.appliedNow", {
        input: res.input,
        output: res.output,
        uiContext: {
          nowClicked: true,
          source: "BMICalculator.hook",
          computedJustInTime: true
        }
      });
      return;
    }

    emitBMIEvent("health.bmi.appliedNow", {
      input: result.input,
      output: result.output,
      uiContext: {
        nowClicked: true,
        source: "BMICalculator.hook",
        computedJustInTime: false
      }
    });
  }, [emitEvents, form, result]);

  // ------------------------------------------------------------------------
  // Return shape
  // ------------------------------------------------------------------------

  return {
    // State
    form,
    result,
    bmiOutput,
    autoRecalc,
    isDirty,

    // Mutators
    setForm,
    setAutoRecalc,
    updateField,
    updateNestedField,
    resetForm,

    // Actions
    computeOnce,
    applyNow
  };
}

/* -------------------------------------------------------------------------- */
/* useBMIOnly – lightweight numeric-only hook                                 */
/* -------------------------------------------------------------------------- */

/**
 * OPTIONS for useBMIOnly
 * @typedef {Object} UseBMIOnlyOptions
 * @property {BMICalculatorInput} [baseInput]   Base input to merge with overrides.
 * @property {boolean} [skipIfInvalid]          If true, skip when height/weight missing and return null.
 */

/**
 * Lightweight hook when a component only cares about numeric BMI and category,
 * without needing full event orchestration or form state.
 *
 * This hook DOES NOT emit events.
 *
 * EXAMPLE:
 *  const bmi = useBMIOnly({
 *    baseInput: profile.bmiInput,
 *    overrides: { weight: { value: newWeight, unit: "lb" } }
 *  });
 *
 * @param {BMICalculatorInput} input
 * @param {UseBMIOnlyOptions} [options]
 * @returns {{ bmi: number; category: string; categoryLabel: string } | null}
 */
export function useBMIOnly(input, options = {}) {
  const { baseInput, skipIfInvalid = false } = options;

  const merged = useMemo(() => {
    const base = baseInput || BMI_DEFAULT_INPUT;
    return /** @type {BMICalculatorInput} */ ({
      ...base,
      ...(input || {}),
      height: {
        ...(base.height || {}),
        ...(input?.height || {})
      },
      weight: {
        ...(base.weight || {}),
        ...(input?.weight || {})
      }
    });
  }, [baseInput, input]);

  const normalized = useMemo(() => normalizeFormToInput(merged), [merged]);

  const output = useMemo(() => {
    if (skipIfInvalid) {
      const h = normalized.height;
      const w = normalized.weight;
      if (!h || !w || !h.value || !w.value) return null;
    }
    return shimGetBMIOnly(normalized);
  }, [normalized, skipIfInvalid]);

  return output;
}

/* -------------------------------------------------------------------------- */
/* Convenience re-export (optional)                                           */
/* -------------------------------------------------------------------------- */

export const BMICalculatorHooks = {
  useBMICalculator,
  useBMIOnly
};

export default BMICalculatorHooks;
