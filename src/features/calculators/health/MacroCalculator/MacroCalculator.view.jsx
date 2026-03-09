// C:\Users\larho\suka-smart-assistant\src\features\calculators\health\MacroCalculator\MacroCalculator.view.jsx

/**
 * MacroCalculator.view.jsx
 *
 * HOW THIS FITS:
 *  - React UI for the Macro Calculator.
 *  - Wraps the pure shim logic (MacroCalculator.shim.js) to:
 *      • Render an SSA-styled calculator form.
 *      • Compute daily + per-meal macro targets.
 *      • Emit a planning event so Meal Planner, Grocery Planner, and Animal Planner
 *        can pick up the new macro pattern.
 *  - Uses SSA eventBus to broadcast result updates (no direct SessionRunner calls here).
 *
 * EVENT EMISSION:
 *  - health.macroPlan.calculated
 *  - health.macroPlan.appliedNow
 *
 * These events carry:
 *  {
 *    macroPlan: MacroCalculatorOutput,
 *    input: MacroCalculatorInput,
 *    ts: ISOString,
 *    uiContext: { nowClicked?: boolean }
 *  }
 *
 * The Session/Automation runtime can listen and decide whether to turn this
 * into a storehouse / meals session and then open SessionRunner.
 */

import React, { useMemo, useState } from "react";
import MacroCalculatorShim, { computeMacroPlan } from "./MacroCalculator.shim";
import { emit as emitEvent } from "@/services/events/eventBus";

/**
 * @typedef {import("./MacroCalculator.shim").MacroCalculatorResult} MacroCalculatorResult
 */

// ---------------------------------------------------------------------------
// Defaults (mirrors MacroCalculator.config.json)
// ---------------------------------------------------------------------------

const DEFAULT_INPUT = {
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

// ---------------------------------------------------------------------------
// Small Helpers
// ---------------------------------------------------------------------------

/**
 * Safe wrapper around eventBus.emit
 * @param {string} type
 * @param {any} data
 */
function emitMacroEvent(type, data) {
  try {
    emitEvent({
      type,
      ts: new Date().toISOString(),
      source: "features/calculators/health/MacroCalculator.view",
      data,
    });
  } catch (err) {
    // Fail soft; calculator should never crash on event issues.
    // eslint-disable-next-line no-console
    console.warn("[MacroCalculator] Failed to emit event", type, err);
  }
}

/**
 * Builds the options object passed into the shim.
 * For now we only support an optional profileIdSeed (can be user id or profile id).
 * @returns {{ profileIdSeed: string|null }}
 */
function buildShimOptions() {
  // Placeholder for injecting user id/profile id later.
  // Can be wired to auth/user context if desired.
  return {
    profileIdSeed: null,
  };
}

// ---------------------------------------------------------------------------
// React Component
// ---------------------------------------------------------------------------

/**
 * Main Macro Calculator view component.
 */
export default function MacroCalculatorView() {
  const [form, setForm] = useState(DEFAULT_INPUT);
  const [autoRecalc, setAutoRecalc] = useState(true);
  const [lastResult, setLastResult] = useState(
    /** @type {MacroCalculatorResult | null} */ (null)
  );

  const shimOptions = useMemo(() => buildShimOptions(), []);

  const result = useMemo(() => {
    if (!autoRecalc && !lastResult) return null;
    const input = autoRecalc ? form : lastResult?.input || form;
    const res = computeMacroPlan(input, shimOptions);
    if (autoRecalc) {
      setLastResult(res);
      emitMacroEvent("health.macroPlan.calculated", {
        input: res.input,
        macroPlan: res.output,
        uiContext: { autoRecalc: true },
      });
    }
    return res;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, autoRecalc]); // intentionally not tracking lastResult, shimOptions to keep behavior predictable

  const displayed = lastResult || result;

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  function handleInputChange(field, value) {
    setForm((prev) => ({
      ...prev,
      [field]: value,
    }));
  }

  function handleNestedChange(path, value) {
    // path like "height.value" or "healthFlags.diabetesOrPreDiabetes"
    setForm((prev) => {
      const clone = { ...prev };
      const steps = path.split(".");
      let target = clone;
      for (let i = 0; i < steps.length - 1; i += 1) {
        const key = steps[i];
        target[key] = { ...(target[key] || {}) };
        target = target[key];
      }
      target[steps[steps.length - 1]] = value;
      return clone;
    });
  }

  function handleGranularityToggle(key) {
    setForm((prev) => {
      const set = new Set(prev.outputGranularity || []);
      if (set.has(key)) {
        set.delete(key);
      } else {
        set.add(key);
      }
      return {
        ...prev,
        outputGranularity: Array.from(set),
      };
    });
  }

  function handleSubmit(e) {
    e.preventDefault();
    const res = computeMacroPlan(form, shimOptions);
    setLastResult(res);
    emitMacroEvent("health.macroPlan.calculated", {
      input: res.input,
      macroPlan: res.output,
      uiContext: { autoRecalc: false },
    });
  }

  function handleApplyNow() {
    if (!displayed) return;
    const payload = {
      input: displayed.input,
      macroPlan: displayed.output,
      uiContext: {
        appliedFrom: "MacroCalculator",
        nowClicked: true,
      },
    };

    emitMacroEvent("health.macroPlan.appliedNow", payload);
    // At this point, a higher-level automation layer can:
    //  - create a "storehouse" session to sync Meal Planner & Grocery Planner
    //  - open SessionRunner with a pre-built "Apply Macro Targets" flow
  }

  // -------------------------------------------------------------------------
  // Rendering helpers
  // -------------------------------------------------------------------------

  function renderWarningBadges(warnings) {
    if (!warnings || !warnings.length) return null;
    return (
      <div className="mt-3 space-y-1">
        {warnings.map((w, idx) => (
          <div
            key={idx}
            className="rounded-md border border-amber-500/60 bg-amber-50 px-3 py-2 text-xs text-amber-900"
          >
            ⚠️ {w}
          </div>
        ))}
      </div>
    );
  }

  function renderNotes(notes) {
    if (!notes || !notes.length) return null;
    return (
      <ul className="mt-2 space-y-1 text-xs text-slate-500">
        {notes.map((n, idx) => (
          <li key={idx}>• {n}</li>
        ))}
      </ul>
    );
  }

  function renderPerMealTable(perMeal) {
    if (!perMeal || !perMeal.entries?.length) return null;

    return (
      <div className="mt-4 rounded-xl border border-slate-100 bg-slate-50/70 p-3">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-800">
            Per-Meal & Snack Breakdown
          </h3>
          <p className="text-xs text-slate-500">
            {perMeal.totalMeals} meals
            {perMeal.totalSnacks > 0 ? ` • ${perMeal.totalSnacks} snacks` : ""}
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-[10px] uppercase tracking-wide text-slate-500">
                <th className="px-2 py-1">Slot</th>
                <th className="px-2 py-1">Type</th>
                <th className="px-2 py-1">Calories</th>
                <th className="px-2 py-1">Protein (g)</th>
                <th className="px-2 py-1">Fat (g)</th>
                <th className="px-2 py-1">Carbs (g)</th>
              </tr>
            </thead>
            <tbody>
              {perMeal.entries.map((slot) => (
                <tr
                  key={slot.index}
                  className="border-b border-slate-100 last:border-0"
                >
                  <td className="px-2 py-1 text-slate-700">
                    #{slot.index + 1}
                  </td>
                  <td className="px-2 py-1 capitalize text-slate-600">
                    {slot.type}
                  </td>
                  <td className="px-2 py-1 text-slate-800">
                    {Math.round(slot.calories)}
                  </td>
                  <td className="px-2 py-1">{Math.round(slot.proteinGrams)}</td>
                  <td className="px-2 py-1">{Math.round(slot.fatGrams)}</td>
                  <td className="px-2 py-1">{Math.round(slot.carbGrams)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  const macroOutput = displayed?.output;

  // -------------------------------------------------------------------------
  // JSX
  // -------------------------------------------------------------------------

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 rounded-3xl border border-slate-200 bg-white/90 p-6 shadow-sm sm:p-8">
      <header className="flex flex-col gap-3 border-b border-slate-100 pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">
            Macro Calculator
          </h1>
          <p className="mt-1 text-xs text-slate-500 sm:text-sm">
            Set your daily protein, fat, and carb targets so SSA can build
            meals, grocery lists, and animal plans that match your body goals.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600">
            <span>Auto-recalculate</span>
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
              checked={autoRecalc}
              onChange={(e) => setAutoRecalc(e.target.checked)}
            />
          </label>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        {/* FORM SIDE */}
        <form
          onSubmit={handleSubmit}
          className="space-y-5 rounded-2xl border border-slate-100 bg-slate-50/60 p-4 sm:p-5"
        >
          {/* Basic profile */}
          <section className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-700">
                Sex
              </label>
              <select
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                value={form.sex}
                onChange={(e) => handleInputChange("sex", e.target.value)}
              >
                <option value="female">Female</option>
                <option value="male">Male</option>
                <option value="other">Other</option>
                <option value="unspecified">Prefer not to say</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-700">
                Age (years)
              </label>
              <input
                type="number"
                min={12}
                max={120}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                value={form.ageYears}
                onChange={(e) =>
                  handleInputChange("ageYears", Number(e.target.value) || 0)
                }
              />
            </div>
          </section>

          {/* Height + Weight */}
          <section className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-700">
                Height
              </label>
              <div className="flex gap-2">
                <input
                  type="number"
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  value={form.height.value}
                  onChange={(e) =>
                    handleNestedChange(
                      "height.value",
                      Number(e.target.value) || 0
                    )
                  }
                />
                <select
                  className="w-22 rounded-lg border border-slate-200 bg-white px-2 py-2 text-xs text-slate-800 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  value={form.height.unit}
                  onChange={(e) =>
                    handleNestedChange("height.unit", e.target.value)
                  }
                >
                  <option value="in">in</option>
                  <option value="cm">cm</option>
                </select>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-700">
                Weight
              </label>
              <div className="flex gap-2">
                <input
                  type="number"
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  value={form.weight.value}
                  onChange={(e) =>
                    handleNestedChange(
                      "weight.value",
                      Number(e.target.value) || 0
                    )
                  }
                />
                <select
                  className="w-22 rounded-lg border border-slate-200 bg-white px-2 py-2 text-xs text-slate-800 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  value={form.weight.unit}
                  onChange={(e) =>
                    handleNestedChange("weight.unit", e.target.value)
                  }
                >
                  <option value="lb">lb</option>
                  <option value="kg">kg</option>
                </select>
              </div>
            </div>
          </section>

          {/* Activity + Goal */}
          <section className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-700">
                Activity Level
              </label>
              <select
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                value={form.activityLevel}
                onChange={(e) =>
                  handleInputChange("activityLevel", e.target.value)
                }
              >
                <option value="sedentary">Sedentary</option>
                <option value="lightlyActive">Lightly active</option>
                <option value="moderatelyActive">Moderately active</option>
                <option value="veryActive">Very active</option>
                <option value="athlete">Athlete</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-700">
                Goal
              </label>
              <select
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                value={form.goal}
                onChange={(e) => handleInputChange("goal", e.target.value)}
              >
                <option value="fatLoss">Fat loss</option>
                <option value="maintenance">Maintenance</option>
                <option value="recomposition">Recomposition</option>
                <option value="muscleGain">Muscle gain</option>
              </select>
            </div>
          </section>

          {/* Calories */}
          <section className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-700">
                Calorie Source
              </label>
              <select
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                value={form.calorieSource}
                onChange={(e) =>
                  handleInputChange("calorieSource", e.target.value)
                }
              >
                <option value="autoFromTDEE">
                  Auto (estimate from TDEE / profile)
                </option>
                <option value="manual">Manual</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-700">
                Manual Calories (per day)
              </label>
              <input
                type="number"
                min={800}
                max={6000}
                disabled={form.calorieSource !== "manual"}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 disabled:bg-slate-100 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                value={form.manualCalories ?? ""}
                onChange={(e) =>
                  handleInputChange(
                    "manualCalories",
                    e.target.value ? Number(e.target.value) : null
                  )
                }
              />
            </div>
          </section>

          {/* Meals / Snacks & Granularity */}
          <section className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-700">
                Meals / Snacks per Day
              </label>
              <div className="flex gap-2">
                <div className="flex-1">
                  <span className="block text-[11px] text-slate-500">
                    Meals
                  </span>
                  <input
                    type="number"
                    min={1}
                    max={8}
                    className="mt-0.5 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    value={form.mealsPerDay}
                    onChange={(e) =>
                      handleInputChange(
                        "mealsPerDay",
                        Number(e.target.value) || 0
                      )
                    }
                  />
                </div>
                <div className="flex-1">
                  <span className="block text-[11px] text-slate-500">
                    Snacks
                  </span>
                  <input
                    type="number"
                    min={0}
                    max={6}
                    className="mt-0.5 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    value={form.snacksPerDay}
                    onChange={(e) =>
                      handleInputChange(
                        "snacksPerDay",
                        Number(e.target.value) || 0
                      )
                    }
                  />
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-700">
                Output Breakdown
              </label>
              <div className="flex flex-wrap gap-2 text-xs text-slate-600">
                <label className="inline-flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={form.outputGranularity.includes("perDay")}
                    onChange={() => handleGranularityToggle("perDay")}
                  />
                  <span>Per day</span>
                </label>
                <label className="inline-flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={form.outputGranularity.includes("perMeal")}
                    onChange={() => handleGranularityToggle("perMeal")}
                  />
                  <span>Per meal</span>
                </label>
                <label className="inline-flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={form.outputGranularity.includes("perSnack")}
                    onChange={() => handleGranularityToggle("perSnack")}
                  />
                  <span>Per snack</span>
                </label>
              </div>
            </div>
          </section>

          {/* Health Flags */}
          <section className="space-y-2">
            <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
              Health Context (optional)
            </p>
            <div className="flex flex-wrap gap-3 text-xs text-slate-600">
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.healthFlags.diabetesOrPreDiabetes}
                  onChange={(e) =>
                    handleNestedChange(
                      "healthFlags.diabetesOrPreDiabetes",
                      e.target.checked
                    )
                  }
                />
                <span>Diabetes / pre-diabetes</span>
              </label>
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.healthFlags.kidneyIssues}
                  onChange={(e) =>
                    handleNestedChange(
                      "healthFlags.kidneyIssues",
                      e.target.checked
                    )
                  }
                />
                <span>Kidney issues</span>
              </label>
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.healthFlags.pregnantOrBreastfeeding}
                  onChange={(e) =>
                    handleNestedChange(
                      "healthFlags.pregnantOrBreastfeeding",
                      e.target.checked
                    )
                  }
                />
                <span>Pregnant / breastfeeding</span>
              </label>
            </div>
          </section>

          {/* SSA Integration Flags (minimal) */}
          <section className="space-y-2 border-t border-slate-200 pt-3">
            <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
              Suka Smart Assistant Links
            </p>
            <div className="flex flex-wrap gap-3 text-xs text-slate-600">
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={
                    form.ssaIntegration.allowAutoLinkToMealPlanner ?? true
                  }
                  onChange={(e) =>
                    handleNestedChange(
                      "ssaIntegration.allowAutoLinkToMealPlanner",
                      e.target.checked
                    )
                  }
                />
                <span>Link to Meal Planner</span>
              </label>
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={
                    form.ssaIntegration.allowAutoLinkToGroceryPlanner ?? true
                  }
                  onChange={(e) =>
                    handleNestedChange(
                      "ssaIntegration.allowAutoLinkToGroceryPlanner",
                      e.target.checked
                    )
                  }
                />
                <span>Link to Grocery Planner</span>
              </label>
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={
                    form.ssaIntegration.allowAutoLinkToAnimalPlanner ?? true
                  }
                  onChange={(e) =>
                    handleNestedChange(
                      "ssaIntegration.allowAutoLinkToAnimalPlanner",
                      e.target.checked
                    )
                  }
                />
                <span>Link to Animal Planner</span>
              </label>
            </div>
          </section>

          {/* Actions */}
          <section className="flex flex-wrap items-center gap-3 pt-1">
            <button
              type="submit"
              className="inline-flex items-center justify-center rounded-full bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-1"
            >
              Calculate Macros
            </button>
            <span className="text-[11px] text-slate-500">
              Results update automatically when Auto-recalculate is on.
            </span>
          </section>
        </form>

        {/* RESULTS SIDE */}
        <aside className="space-y-4">
          <div className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm sm:p-5">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-slate-900 sm:text-base">
                  Daily Macro Targets
                </h2>
                <p className="text-xs text-slate-500">
                  SSA will use these targets to shape meals, grocery lists, and
                  animal plans.
                </p>
              </div>
              <button
                type="button"
                onClick={handleApplyNow}
                disabled={!macroOutput}
                className="inline-flex items-center justify-center rounded-full bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-emerald-300"
              >
                Use These Macros Now
              </button>
            </div>

            {!macroOutput ? (
              <p className="mt-4 text-xs text-slate-500">
                Fill in your details and click{" "}
                <span className="font-semibold">Calculate Macros</span> to see
                your plan.
              </p>
            ) : (
              <>
                <div className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                  <div className="rounded-xl bg-slate-50 px-3 py-2">
                    <p className="text-[11px] uppercase tracking-wide text-slate-500">
                      Calories
                    </p>
                    <p className="text-base font-semibold text-slate-900">
                      {Math.round(macroOutput.caloriesPerDay)}{" "}
                      <span className="text-xs font-normal text-slate-500">
                        /day
                      </span>
                    </p>
                  </div>
                  <div className="rounded-xl bg-slate-50 px-3 py-2">
                    <p className="text-[11px] uppercase tracking-wide text-slate-500">
                      Protein
                    </p>
                    <p className="text-base font-semibold text-slate-900">
                      {Math.round(macroOutput.proteinGramsPerDay)}{" "}
                      <span className="text-xs font-normal text-slate-500">
                        g/day
                      </span>
                    </p>
                  </div>
                  <div className="rounded-xl bg-slate-50 px-3 py-2">
                    <p className="text-[11px] uppercase tracking-wide text-slate-500">
                      Fat
                    </p>
                    <p className="text-base font-semibold text-slate-900">
                      {Math.round(macroOutput.fatGramsPerDay)}{" "}
                      <span className="text-xs font-normal text-slate-500">
                        g/day
                      </span>
                    </p>
                  </div>
                  <div className="rounded-xl bg-slate-50 px-3 py-2">
                    <p className="text-[11px] uppercase tracking-wide text-slate-500">
                      Carbs
                    </p>
                    <p className="text-base font-semibold text-slate-900">
                      {Math.round(macroOutput.carbGramsPerDay)}{" "}
                      <span className="text-xs font-normal text-slate-500">
                        g/day
                      </span>
                    </p>
                  </div>
                </div>

                {renderWarningBadges(macroOutput.warnings)}
                {renderNotes(macroOutput.notes)}
              </>
            )}
          </div>

          {macroOutput && renderPerMealTable(macroOutput.perMealBreakdown)}
        </aside>
      </div>
    </div>
  );
}
