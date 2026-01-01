// C:\Users\larho\suka-smart-assistant\src\features\calculators\health\MicronutrientCalculator\MicronutrientCalculator.view.jsx

import React from "react";
// This hook will encapsulate state + calls into MicronutrientCalculator.shim.js
// and any SSA wiring (events, Planning Graph, etc.).
// Implement in: MicronutrientCalculator.hooks.js to match this API.
import { useMicronutrientCalculator } from "./MicronutrientCalculator.hooks";

/**
 * MicronutrientCalculatorView
 * ---------------------------
 * UI for entering person/profile data and viewing micronutrient recommendations.
 *
 * HOW THIS FITS:
 * - Pure React view component — no Dexie, no eventBus, no Hub in here.
 * - Uses `useMicronutrientCalculator` for:
 *   • local state
 *   • validation + calls into MicronutrientCalculator.shim.js
 *   • Planning Graph integration (optional, inside hook)
 * - Intended to live under a Health/Calculators route and be embedded in
 *   SSA pages that may also surface "Next Steps" CTAs (meal planning,
 *   garden planning, animal nutrient mapping, etc.).
 */

const MicronutrientCalculatorView = () => {
  const {
    input,
    result,
    isCalculating,
    hasResult,
    errors,
    handleChange,
    handleToggle,
    handleSubmit,
    handleReset,
    handleNextStepsClick
  } = useMicronutrientCalculator();

  const profile = input.profile || {};
  const healthFocus = input.healthFocus || {};
  const constraints = input.constraints || {};
  const dietaryPattern = input.dietaryPattern || {};
  const rounding = input.rounding || {};
  const integration = input.ssaIntegration || {};

  const dailyTargets = result?.output?.dailyTargets || [];
  const aggregate = result?.output?.aggregate || {};
  const warnings = result?.output?.warnings || [];

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 space-y-6">
      {/* Header */}
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-50">
            Micronutrient Daily Targets
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            Capture your profile and focus areas to generate a daily micronutrient
            blueprint SSA can use for meals, garden planning, and animal products.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleReset}
            className="inline-flex items-center rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
          >
            Reset
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={isCalculating}
            className="inline-flex items-center rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-emerald-400"
          >
            {isCalculating ? "Calculating…" : "Calculate Targets"}
          </button>
          <button
            type="button"
            onClick={handleNextStepsClick}
            disabled={!hasResult}
            className="inline-flex items-center rounded-md bg-sky-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-sky-700 disabled:cursor-not-allowed disabled:bg-sky-400"
          >
            Use in Meal / Garden Planner
          </button>
        </div>
      </header>

      {/* Layout: Left form / Right results */}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1.5fr)]">
        {/* LEFT COLUMN – INPUT FORM */}
        <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
          {/* Profile */}
          <div className="space-y-2">
            <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
              Person Profile
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Age, sex, and pregnancy status help approximate nutrient needs. SSA
              does not replace a qualified healthcare provider.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-200">
                  Name (optional)
                </label>
                <input
                  type="text"
                  value={profile.name || ""}
                  onChange={(e) => handleChange("profile.name", e.target.value)}
                  className="block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
                  placeholder="e.g., Rhonda"
                />
              </div>

              <div className="space-y-1">
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-200">
                  Sex
                </label>
                <select
                  value={profile.sex || "unspecified"}
                  onChange={(e) => handleChange("profile.sex", e.target.value)}
                  className="block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
                >
                  <option value="unspecified">Unspecified</option>
                  <option value="female">Female</option>
                  <option value="male">Male</option>
                </select>
              </div>

              <div className="space-y-1">
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-200">
                  Age (years)
                </label>
                <input
                  type="number"
                  min={1}
                  max={120}
                  value={profile.ageYears ?? ""}
                  onChange={(e) =>
                    handleChange(
                      "profile.ageYears",
                      e.target.value === "" ? "" : Number(e.target.value)
                    )
                  }
                  className="block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
                  placeholder="e.g., 35"
                />
              </div>

              <div className="space-y-1">
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-200">
                  Unit System
                </label>
                <select
                  value={input.unitSystem || "imperial"}
                  onChange={(e) => handleChange("unitSystem", e.target.value)}
                  className="block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
                >
                  <option value="imperial">Imperial (lb, in)</option>
                  <option value="metric">Metric (kg, cm)</option>
                </select>
              </div>

              <div className="space-y-1">
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-200">
                  Pregnancy status
                </label>
                <select
                  value={profile.pregnancyStatus || "none"}
                  onChange={(e) =>
                    handleChange("profile.pregnancyStatus", e.target.value)
                  }
                  className="block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
                >
                  <option value="none">Not pregnant</option>
                  <option value="trimester1">Pregnant – 1st trimester</option>
                  <option value="trimester2">Pregnant – 2nd trimester</option>
                  <option value="trimester3">Pregnant – 3rd trimester</option>
                </select>
              </div>

              <div className="space-y-1">
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-200">
                  Lactation status
                </label>
                <select
                  value={profile.lactationStatus || "none"}
                  onChange={(e) =>
                    handleChange("profile.lactationStatus", e.target.value)
                  }
                  className="block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
                >
                  <option value="none">Not lactating</option>
                  <option value="lactating0to6m">Lactation 0–6 months</option>
                  <option value="lactating7to12m">Lactation 7–12 months</option>
                </select>
              </div>
            </div>
          </div>

          {/* Dietary pattern */}
          <div className="border-t border-dashed border-slate-200 pt-3 dark:border-slate-700">
            <h2 className="mb-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
              Dietary Pattern
            </h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-200">
                  Primary pattern
                </label>
                <select
                  value={dietaryPattern.primaryPattern || "omnivore"}
                  onChange={(e) =>
                    handleChange("dietaryPattern.primaryPattern", e.target.value)
                  }
                  className="block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
                >
                  <option value="omnivore">Omnivore</option>
                  <option value="pescatarian">Pescatarian</option>
                  <option value="vegetarian">Vegetarian</option>
                  <option value="vegan">Vegan</option>
                </select>
              </div>

              <fieldset className="space-y-1">
                <legend className="block text-xs font-medium text-slate-700 dark:text-slate-200">
                  Avoids
                </legend>
                <div className="flex flex-wrap gap-3 text-xs">
                  <label className="inline-flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={!!dietaryPattern.avoidsPork}
                      onChange={() =>
                        handleToggle("dietaryPattern.avoidsPork")
                      }
                      className="h-3 w-3 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                    />
                    <span>Pork</span>
                  </label>
                  <label className="inline-flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={!!dietaryPattern.avoidsShellfish}
                      onChange={() =>
                        handleToggle("dietaryPattern.avoidsShellfish")
                      }
                      className="h-3 w-3 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                    />
                    <span>Shellfish</span>
                  </label>
                  <label className="inline-flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={!!dietaryPattern.avoidsDairy}
                      onChange={() =>
                        handleToggle("dietaryPattern.avoidsDairy")
                      }
                      className="h-3 w-3 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                    />
                    <span>Dairy</span>
                  </label>
                  <label className="inline-flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={!!dietaryPattern.avoidsGluten}
                      onChange={() =>
                        handleToggle("dietaryPattern.avoidsGluten")
                      }
                      className="h-3 w-3 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                    />
                    <span>Gluten</span>
                  </label>
                </div>
              </fieldset>
            </div>
          </div>

          {/* Health focus */}
          <div className="border-t border-dashed border-slate-200 pt-3 dark:border-slate-700">
            <h2 className="mb-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
              Health Focus (boost priority)
            </h2>
            <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
              {[
                ["boneHealth", "Bone health"],
                ["bloodHealth", "Blood health"],
                ["immuneSupport", "Immune support"],
                ["heartHealth", "Heart health"],
                ["brainHealth", "Brain health"],
                ["metabolicHealth", "Metabolic health"]
              ].map(([key, label]) => (
                <label
                  key={key}
                  className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700"
                >
                  <input
                    type="checkbox"
                    checked={!!healthFocus[key]}
                    onChange={() => handleToggle(`healthFocus.${key}`)}
                    className="h-3 w-3 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                  />
                  <span className="truncate">{label}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Constraints */}
          <div className="border-t border-dashed border-slate-200 pt-3 dark:border-slate-700">
            <h2 className="mb-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
              Health Constraints (soft adjustments)
            </h2>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <label className="inline-flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={!!constraints.kidneyIssues}
                  onChange={() => handleToggle("constraints.kidneyIssues")}
                  className="h-3 w-3 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                />
                <span>Kidney-related issues</span>
              </label>
              <label className="inline-flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={!!constraints.liverIssues}
                  onChange={() => handleToggle("constraints.liverIssues")}
                  className="h-3 w-3 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                />
                <span>Liver-related issues</span>
              </label>
              <label className="inline-flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={!!constraints.limitSodium}
                  onChange={() => handleToggle("constraints.limitSodium")}
                  className="h-3 w-3 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                />
                <span>Limit sodium</span>
              </label>
              <label className="inline-flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={!!constraints.limitAddedSugar}
                  onChange={() => handleToggle("constraints.limitAddedSugar")}
                  className="h-3 w-3 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                />
                <span>Limit added sugar</span>
              </label>
              <label className="inline-flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={!!constraints.limitSaturatedFat}
                  onChange={() =>
                    handleToggle("constraints.limitSaturatedFat")
                  }
                  className="h-3 w-3 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                />
                <span>Limit saturated fat</span>
              </label>
            </div>
          </div>

          {/* Rounding + SSA integration flags (advanced) */}
          <div className="border-t border-dashed border-slate-200 pt-3 text-xs dark:border-slate-700">
            <details className="group">
              <summary className="flex cursor-pointer items-center justify-between">
                <span className="font-semibold text-slate-800 dark:text-slate-100">
                  Advanced: Rounding & SSA integration
                </span>
                <span className="text-slate-400 group-open:hidden">+</span>
                <span className="hidden text-slate-400 group-open:inline">
                  −
                </span>
              </summary>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-200">
                    Gram decimals
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={3}
                    value={rounding.gramsDecimals ?? 1}
                    onChange={(e) =>
                      handleChange(
                        "rounding.gramsDecimals",
                        e.target.value === "" ? "" : Number(e.target.value)
                      )
                    }
                    className="block w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-200">
                    Milligram decimals
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={1}
                    value={rounding.milligramsDecimals ?? 0}
                    onChange={(e) =>
                      handleChange(
                        "rounding.milligramsDecimals",
                        e.target.value === "" ? "" : Number(e.target.value)
                      )
                    }
                    className="block w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-200">
                    Microgram decimals
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={1}
                    value={rounding.microgramsDecimals ?? 0}
                    onChange={(e) =>
                      handleChange(
                        "rounding.microgramsDecimals",
                        e.target.value === "" ? "" : Number(e.target.value)
                      )
                    }
                    className="block w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
                  />
                </div>

                <div className="space-y-1">
                  <span className="block text-xs font-medium text-slate-700 dark:text-slate-200">
                    SSA Integration
                  </span>
                  <div className="mt-1 flex flex-col gap-1">
                    <label className="inline-flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={!!integration.autosaveProfile}
                        onChange={() =>
                          handleToggle("ssaIntegration.autosaveProfile")
                        }
                        className="h-3 w-3 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                      />
                      <span>Autosave profile to Health</span>
                    </label>
                    <label className="inline-flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={!!integration.allowLinkToMealPlanner}
                        onChange={() =>
                          handleToggle("ssaIntegration.allowLinkToMealPlanner")
                        }
                        className="h-3 w-3 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                      />
                      <span>Suggest meals from gaps</span>
                    </label>
                    <label className="inline-flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={!!integration.allowLinkToInventoryGaps}
                        onChange={() =>
                          handleToggle("ssaIntegration.allowLinkToInventoryGaps")
                        }
                        className="h-3 w-3 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                      />
                      <span>Highlight storehouse/garden gaps</span>
                    </label>
                  </div>
                </div>
              </div>
            </details>
          </div>

          {/* Inline errors, if any */}
          {errors && Object.keys(errors).length > 0 && (
            <div className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-100">
              <p className="font-semibold">Please review:</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {Object.entries(errors).map(([key, msg]) => (
                  <li key={key}>{String(msg)}</li>
                ))}
              </ul>
            </div>
          )}
        </section>

        {/* RIGHT COLUMN – RESULTS */}
        <section className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
          {/* Summary */}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                Daily Micronutrient Blueprint
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Targets are approximate and tuned by age, sex, pregnancy, and
                focus areas. SSA uses these as a guide for meals, garden crops, and
                animal products.
              </p>
            </div>
            <div className="text-right text-xs text-slate-500 dark:text-slate-400">
              {hasResult && (
                <>
                  <div>
                    Nutrients tracked:{" "}
                    <span className="font-semibold">
                      {aggregate.totalMicronutrientsTracked ?? dailyTargets.length}
                    </span>
                  </div>
                  {aggregate.emphasisAreas && aggregate.emphasisAreas.length > 0 && (
                    <div className="mt-0.5">
                      Focus:{" "}
                      <span className="font-semibold">
                        {aggregate.emphasisAreas.join(", ")}
                      </span>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {/* If no result yet */}
          {!hasResult && (
            <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-400">
              <div>
                <p className="font-medium text-slate-700 dark:text-slate-200">
                  No targets calculated yet.
                </p>
                <p className="mt-1 text-xs">
                  Adjust your profile and health focus on the left, then click{" "}
                  <span className="font-semibold">“Calculate Targets”</span>.
                </p>
              </div>
            </div>
          )}

          {/* Results table */}
          {hasResult && (
            <div className="flex-1 overflow-hidden rounded-lg border border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-900/50">
              <div className="max-h-80 overflow-auto">
                <table className="min-w-full border-collapse text-xs">
                  <thead className="bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                    <tr>
                      <th className="sticky top-0 z-10 border-b border-slate-200 px-3 py-2 text-left font-semibold">
                        Nutrient
                      </th>
                      <th className="sticky top-0 z-10 border-b border-slate-200 px-3 py-2 text-left font-semibold">
                        Target
                      </th>
                      <th className="sticky top-0 z-10 border-b border-slate-200 px-3 py-2 text-left font-semibold">
                        Range
                      </th>
                      <th className="sticky top-0 z-10 border-b border-slate-200 px-3 py-2 text-left font-semibold">
                        Priority
                      </th>
                      <th className="sticky top-0 z-10 border-b border-slate-200 px-3 py-2 text-left font-semibold">
                        Notes
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
                    {dailyTargets
                      .slice()
                      .sort((a, b) => (b.priority || 0) - (a.priority || 0))
                      .map((t) => (
                        <tr key={t.nutrientId}>
                          <td className="px-3 py-2 align-top text-slate-800 dark:text-slate-100">
                            <div className="font-semibold">{t.label}</div>
                            <div className="text-[11px] text-slate-500 dark:text-slate-400">
                              {t.nutrientId}
                            </div>
                          </td>
                          <td className="px-3 py-2 align-top text-slate-800 dark:text-slate-100">
                            {t.amount} {t.unit}
                          </td>
                          <td className="px-3 py-2 align-top text-slate-700 dark:text-slate-200">
                            {t.recommendedRange?.min != null &&
                            t.recommendedRange?.max != null
                              ? `${t.recommendedRange.min}–${t.recommendedRange.max} ${t.unit}`
                              : "n/a"}
                          </td>
                          <td className="px-3 py-2 align-top text-slate-700 dark:text-slate-200">
                            <div className="flex items-center gap-2">
                              <span>{t.priority ?? 0}</span>
                              <div className="h-1.5 flex-1 rounded-full bg-slate-200 dark:bg-slate-700">
                                <div
                                  className="h-1.5 rounded-full bg-emerald-500"
                                  style={{
                                    width: `${Math.min(100, t.priority ?? 0)}%`
                                  }}
                                />
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-2 align-top text-[11px] text-slate-600 dark:text-slate-300">
                            {t.emphasisReasons && t.emphasisReasons.length > 0 ? (
                              <ul className="space-y-0.5">
                                {t.emphasisReasons.map((reason, idx) => (
                                  <li key={idx}>• {reason}</li>
                                ))}
                              </ul>
                            ) : (
                              <span className="text-slate-400 dark:text-slate-500">
                                —
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Warnings & guidance */}
          {hasResult && (
            <div className="space-y-2">
              {warnings.length > 0 && (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
                  <p className="font-semibold">Caution / Notes</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4">
                    {warnings.map((w, idx) => (
                      <li key={idx}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                These are educational estimates, not medical advice. Use them to
                guide storehouse planning, meal building, and garden/animal
                planning in SSA — then confirm details with trustworthy health
                resources when needed.
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};

export default MicronutrientCalculatorView;
