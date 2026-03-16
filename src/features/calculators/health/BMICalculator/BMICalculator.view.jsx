// C:\Users\larho\suka-smart-assistant\src\features\calculators\health\BMICalculator\BMICalculator.view.jsx

import React, { useCallback, useEffect, useMemo, useState } from "react";
import BMICalculatorShim, { computeBMI } from "./BMICalculator.shim";
import { emit as emitEvent } from "@/services/events/eventBus";

/**
 * BMICalculator.view.jsx
 *
 * HOW THIS FITS:
 *  - React UI for the BMI Calculator page.
 *  - Uses BMICalculator.shim (pure logic) for all calculations.
 *  - Emits semantic events for SSA orchestration:
 *      • health.bmi.calculated
 *      • health.bmi.appliedNow
 *  - Planning Graph + automation can listen for these events and decide:
 *      • how to show BMI on dashboards
 *      • whether to nudge users toward Macro Calculator or other health flows
 *      • whether to spin up a SessionRunner session using node mappings
 *
 * NOTE:
 *  - This component does NOT talk directly to SessionRunner.
 *  - It only emits events with clean payloads (input, output, uiContext).
 */

/* -------------------------------------------------------------------------- */
/* Defaults (align with BMICalculator.config.json)                            */
/* -------------------------------------------------------------------------- */

const DEFAULT_BMI_INPUT = {
  height: {
    value: 66,
    unit: "in",
  },
  weight: {
    value: 180,
    unit: "lb",
  },
  sex: "unspecified",
  ageYears: 35,
  unitSystem: "imperial",
  rounding: {
    bmiDecimals: 1,
    weightDecimals: 1,
  },
  ssaIntegration: {
    autosaveProfile: true,
    allowLinkToMacroCalculator: true,
  },
};

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Safe event emitter wrapper for this view.
 * @param {string} type
 * @param {any} data
 */
function emitBMIEvent(type, data) {
  try {
    emitEvent({
      type,
      ts: new Date().toISOString(),
      source: "features/calculators/health/BMICalculator.view",
      data,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[BMICalculator.view] Failed to emit event", type, err);
  }
}

/**
 * Utility to parse numeric inputs safely.
 * @param {string|number} value
 * @returns {number}
 */
function toNumberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/* -------------------------------------------------------------------------- */
/* Component                                                                  */
/* -------------------------------------------------------------------------- */

const BMICalculatorView = () => {
  const [form, setForm] = useState(DEFAULT_BMI_INPUT);
  const [autoRecalc, setAutoRecalc] = useState(true);
  const [result, setResult] = useState(null);
  const [isDirty, setIsDirty] = useState(false);

  const bmiOutput = useMemo(() => (result ? result.output : null), [result]);

  // ------------------------------------------------------------------------
  // Form updates
  // ------------------------------------------------------------------------

  const updateField = useCallback((field, value) => {
    setForm((prev) => ({
      ...prev,
      [field]: value,
    }));
    setIsDirty(true);
  }, []);

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
      return base;
    });
    setIsDirty(true);
  }, []);

  const resetForm = useCallback(() => {
    setForm(DEFAULT_BMI_INPUT);
    setIsDirty(false);
  }, []);

  // ------------------------------------------------------------------------
  // Computation
  // ------------------------------------------------------------------------

  const doCompute = useCallback(
    (opts = { emitEvent: true, autoRecalc: false }) => {
      const input = {
        ...form,
        height: {
          ...form.height,
          value: toNumberOrZero(form.height?.value),
        },
        weight: {
          ...form.weight,
          value: toNumberOrZero(form.weight?.value),
        },
      };

      const res = computeBMI(input);
      setResult(res);

      if (opts.emitEvent) {
        emitBMIEvent("health.bmi.calculated", {
          input: res.input,
          output: res.output,
          uiContext: {
            autoRecalc: Boolean(opts.autoRecalc),
            source: "BMICalculator",
          },
        });
      }
    },
    [form]
  );

  // Auto-recalc when enabled & form changes
  useEffect(() => {
    if (!autoRecalc) return;
    doCompute({ emitEvent: true, autoRecalc: true });
  }, [autoRecalc, form, doCompute]);

  // Initial calculation
  useEffect(() => {
    doCompute({ emitEvent: true, autoRecalc: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ------------------------------------------------------------------------
  // “Use BMI in Plans” handler
  // ------------------------------------------------------------------------

  const handleApplyNow = useCallback(() => {
    if (!result) return;
    emitBMIEvent("health.bmi.appliedNow", {
      input: result.input,
      output: result.output,
      uiContext: {
        nowClicked: true,
        source: "BMICalculator",
      },
    });
  }, [result]);

  // ------------------------------------------------------------------------
  // Render helpers
  // ------------------------------------------------------------------------

  const renderWarnings = () => {
    if (!bmiOutput?.warnings || bmiOutput.warnings.length === 0) return null;
    return (
      <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
        <div className="font-semibold mb-1">Important notes</div>
        <ul className="list-disc list-inside space-y-1">
          {bmiOutput.warnings.map((w, idx) => (
            <li key={idx}>{w}</li>
          ))}
        </ul>
      </div>
    );
  };

  const renderNotes = () => {
    if (!bmiOutput?.notes || bmiOutput.notes.length === 0) return null;
    return (
      <div className="mt-3 text-xs text-slate-600 space-y-1">
        {bmiOutput.notes.map((n, idx) => (
          <p key={idx}>{n}</p>
        ))}
      </div>
    );
  };

  const recommendedRange = bmiOutput?.recommendedWeightRange;

  // ------------------------------------------------------------------------
  // JSX
  // ------------------------------------------------------------------------

  return (
    <div className="w-full h-full flex flex-col gap-4 md:gap-6 px-4 py-4 md:px-6 md:py-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
        <div>
          <h1 className="text-xl md:text-2xl font-semibold text-slate-900">
            BMI Calculator
          </h1>
          <p className="text-sm text-slate-600">
            Quick screening tool to estimate Body Mass Index and weight
            category. Use it as context for macro planning, not as a diagnosis.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs md:text-sm text-slate-700">
            <input
              type="checkbox"
              className="rounded border-slate-300"
              checked={autoRecalc}
              onChange={(e) => setAutoRecalc(e.target.checked)}
            />
            Auto-recalculate
          </label>
          <button
            type="button"
            onClick={resetForm}
            className="inline-flex items-center rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs md:text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Reset
          </button>
        </div>
      </div>

      {/* Layout: form + results */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 md:gap-6">
        {/* Left: Inputs */}
        <section className="rounded-xl border border-slate-200 bg-white p-4 md:p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-800 mb-3">
            Enter your details
          </h2>

          <div className="space-y-4">
            {/* Height */}
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Height
              </label>
              <div className="flex gap-2">
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  value={form.height.value}
                  onChange={(e) =>
                    updateNestedField("height.value", e.target.value)
                  }
                  className="flex-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
                <select
                  value={form.height.unit}
                  onChange={(e) =>
                    updateNestedField("height.unit", e.target.value)
                  }
                  className="w-24 rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500"
                >
                  <option value="in">in</option>
                  <option value="cm">cm</option>
                </select>
              </div>
            </div>

            {/* Weight */}
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Weight
              </label>
              <div className="flex gap-2">
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  value={form.weight.value}
                  onChange={(e) =>
                    updateNestedField("weight.value", e.target.value)
                  }
                  className="flex-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
                <select
                  value={form.weight.unit}
                  onChange={(e) =>
                    updateNestedField("weight.unit", e.target.value)
                  }
                  className="w-24 rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500"
                >
                  <option value="lb">lb</option>
                  <option value="kg">kg</option>
                </select>
              </div>
            </div>

            {/* Sex / Age (optional context) */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Sex (optional)
                </label>
                <select
                  value={form.sex}
                  onChange={(e) => updateField("sex", e.target.value)}
                  className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500"
                >
                  <option value="unspecified">Prefer not to say</option>
                  <option value="female">Female</option>
                  <option value="male">Male</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Age (optional)
                </label>
                <input
                  type="number"
                  min="5"
                  max="120"
                  step="1"
                  value={form.ageYears ?? ""}
                  onChange={(e) =>
                    updateField(
                      "ageYears",
                      e.target.value === "" ? undefined : Number(e.target.value)
                    )
                  }
                  className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
              </div>
            </div>

            {/* Unit system & rounding */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Display units
                </label>
                <select
                  value={form.unitSystem}
                  onChange={(e) => updateField("unitSystem", e.target.value)}
                  className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500"
                >
                  <option value="imperial">Imperial (lb/in)</option>
                  <option value="metric">Metric (kg/cm)</option>
                  <option value="mixed">Mixed</option>
                </select>
              </div>
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    BMI decimals
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="4"
                    step="1"
                    value={form.rounding?.bmiDecimals ?? 1}
                    onChange={(e) =>
                      updateNestedField(
                        "rounding.bmiDecimals",
                        Number(e.target.value)
                      )
                    }
                    className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </div>
                <div className="flex-1">
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Weight decimals
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="3"
                    step="1"
                    value={form.rounding?.weightDecimals ?? 1}
                    onChange={(e) =>
                      updateNestedField(
                        "rounding.weightDecimals",
                        Number(e.target.value)
                      )
                    }
                    className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() =>
                  doCompute({ emitEvent: true, autoRecalc: false })
                }
                className="inline-flex items-center rounded-md bg-indigo-600 px-4 py-2 text-xs md:text-sm font-medium text-white shadow-sm hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-1"
              >
                Calculate BMI
              </button>
              <span className="text-xs text-slate-500">
                {isDirty
                  ? "Inputs changed since last load."
                  : "Using default profile values."}
              </span>
            </div>
          </div>
        </section>

        {/* Right: Results */}
        <section className="rounded-xl border border-slate-200 bg-white p-4 md:p-5 shadow-sm flex flex-col">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-slate-800">
                Your BMI Result
              </h2>
              <p className="text-xs text-slate-500">
                SSA uses this as context for other health planners (macros,
                micronutrients, and more).
              </p>
            </div>
            <button
              type="button"
              onClick={handleApplyNow}
              disabled={!bmiOutput}
              className={`inline-flex items-center rounded-md px-3 py-1.5 text-xs md:text-sm font-medium shadow-sm focus:outline-none focus:ring-2 focus:ring-offset-1 ${
                bmiOutput
                  ? "bg-emerald-600 text-white hover:bg-emerald-700 focus:ring-emerald-500"
                  : "bg-slate-200 text-slate-500 cursor-not-allowed"
              }`}
            >
              Use BMI in Plans
            </button>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-4">
            <div className="rounded-lg bg-slate-50 px-3 py-3 flex flex-col gap-1">
              <span className="text-xs font-medium text-slate-600">BMI</span>
              <span className="text-2xl font-semibold text-slate-900">
                {bmiOutput?.bmi ?? "—"}
              </span>
            </div>
            <div className="rounded-lg bg-slate-50 px-3 py-3 flex flex-col gap-1">
              <span className="text-xs font-medium text-slate-600">
                Category
              </span>
              <span className="text-sm font-semibold text-slate-900">
                {bmiOutput?.categoryLabel ?? "—"}
              </span>
              {bmiOutput?.category && (
                <span className="text-[11px] uppercase tracking-wide text-slate-500">
                  key: {bmiOutput.category}
                </span>
              )}
            </div>
          </div>

          {/* Recommended weight range */}
          <div className="mt-4 rounded-lg border border-slate-100 bg-slate-50 px-3 py-3">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium text-slate-700">
                Recommended weight range (BMI 18.5–24.9)
              </span>
            </div>
            {recommendedRange ? (
              <div className="flex items-baseline gap-2 text-sm text-slate-800">
                <span className="font-semibold">
                  {recommendedRange.min}–{recommendedRange.max}
                </span>
                <span className="text-xs uppercase tracking-wide text-slate-500">
                  {recommendedRange.unit}
                </span>
              </div>
            ) : (
              <p className="text-xs text-slate-500">
                Enter a valid height and weight to see the suggested range for a
                &ldquo;normal&rdquo; BMI.
              </p>
            )}
          </div>

          {renderWarnings()}

          {renderNotes()}
        </section>
      </div>
    </div>
  );
};

export default BMICalculatorView;
