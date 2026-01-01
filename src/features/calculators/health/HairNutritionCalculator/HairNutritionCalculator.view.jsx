// C:\Users\larho\suka-smart-assistant\src\features\calculators\health\HairNutritionCalculator\HairNutritionCalculator.view.jsx

/**
 * HairNutritionCalculator.view.jsx
 *
 * Black Hair Nutrition Calculator UI for Suka Smart Assistant (SSA).
 *
 * How this fits:
 * - Provides a focused UI for estimating protein, healthy fat, and key micronutrient
 *   needs to support Black hair growth and retention.
 * - Delegates all calculation logic to HairNutritionCalculator.shim.js so it can run
 *   safely in background workers, SessionRunner flows, or other orchestrations.
 * - Persists last-used input + result in localStorage so the user can navigate
 *   around SSA and come back to their numbers without losing context.
 *
 * This view:
 * - Renders a form to collect hair + nutrition context.
 * - Calls runHairNutritionCalculatorShim(...) on submit.
 * - Displays rich results and risk flags in a card/grid layout.
 */

import React, { useState, useEffect, useCallback } from "react";
import HairNutritionCalculatorShim, {
  runHairNutritionCalculatorShim,
} from "./HairNutritionCalculator.shim";

const LOCAL_STORAGE_KEY = "ssa.hairNutritionCalculator.state";

/**
 * Build default input values aligned with HairNutritionCalculator.schema.json.
 */
function buildDefaultInput() {
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
 * Attempt to load a previously-saved calculator state.
 */
function loadSavedState() {
  try {
    const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Persist current input + result state to localStorage.
 */
function saveState(input, result) {
  try {
    const payload = { input, result };
    window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore storage errors; never block UI.
  }
}

/**
 * Tag-like renderer for boolean flags.
 */
function FlagPill({ active, label }) {
  const baseClass =
    "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium mr-2 mb-2";
  const activeClass = active
    ? "bg-emerald-100 text-emerald-800"
    : "bg-gray-100 text-gray-500 line-through";
  return <span className={`${baseClass} ${activeClass}`}>{label}</span>;
}

/**
 * HairNutritionCalculatorView
 *
 * @returns {JSX.Element}
 */
export default function HairNutritionCalculatorView() {
  const [input, setInput] = useState(buildDefaultInput);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [exportToHub, setExportToHub] = useState(false);
  const [error, setError] = useState(null);

  // Hydrate from localStorage on mount.
  useEffect(() => {
    const saved = loadSavedState();
    if (saved && saved.input) {
      setInput((prev) => ({ ...prev, ...saved.input }));
      if (saved.result) setResult(saved.result);
    }
  }, []);

  // Save state whenever input or result changes.
  useEffect(() => {
    saveState(input, result);
  }, [input, result]);

  const handleBasicChange = useCallback((field, value) => {
    setInput((prev) => ({ ...prev, [field]: value }));
  }, []);

  const handleNestedChange = useCallback((path, value) => {
    setInput((prev) => {
      const clone = { ...prev };
      let cursor = clone;
      for (let i = 0; i < path.length - 1; i += 1) {
        const key = path[i];
        cursor[key] = cursor[key] ? { ...cursor[key] } : {};
        cursor = cursor[key];
      }
      cursor[path[path.length - 1]] = value;
      return clone;
    });
  }, []);

  const handleCheckboxNested = useCallback((path, checked) => {
    handleNestedChange(path, !!checked);
  }, [handleNestedChange]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const payload = await runHairNutritionCalculatorShim(input, {
        exportToHub,
      });

      setResult(payload);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[HairNutritionCalculator.view] calculation error:", err);
      setError(err?.message || "Something went wrong running the calculator.");
    } finally {
      setLoading(false);
    }
  };

  const handleReset = () => {
    const defaults = buildDefaultInput();
    setInput(defaults);
    setResult(null);
    setError(null);
    saveState(defaults, null);
  };

  const output = result?.output;
  const meta = result?.meta;

  return (
    <div className="ssa-hair-nutrition-page max-w-6xl mx-auto px-4 py-6">
      {/* Header */}
      <header className="mb-6">
        <h1 className="text-2xl font-semibold mb-1">
          Black Hair Nutrition Calculator
        </h1>
        <p className="text-sm text-gray-600">
          Estimate how much protein, healthy fats, and key micronutrients you
          should target daily to support strong, moisturized, breakage-resistant
          Black hair. Results can feed into{" "}
          <strong>Macro Calculator</strong>, <strong>Micronutrient Planner</strong>,{" "}
          <strong>Meal Planner</strong>, and <strong>Storehouse</strong> flows.
        </p>
        {meta && (
          <p className="mt-1 text-xs text-gray-500">
            Last run: <span className="font-mono">{meta.timestamp}</span> ·
            Calculator v{HairNutritionCalculatorShim.CALC_VERSION}
          </p>
        )}
      </header>

      {/* Layout: Form (left) / Results (right) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* FORM CARD */}
        <section className="bg-white shadow-sm rounded-lg border border-gray-100 p-4">
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Basic Info */}
            <div>
              <h2 className="text-sm font-semibold mb-2">1. Basic Info</h2>
              <div className="flex items-center gap-3 mb-3">
                <label className="text-xs font-medium text-gray-700">
                  Unit System
                </label>
                <select
                  className="border rounded px-2 py-1 text-sm"
                  value={input.unitSystem}
                  onChange={(e) =>
                    handleBasicChange("unitSystem", e.target.value)
                  }
                >
                  <option value="imperial">Imperial (lbs)</option>
                  <option value="metric">Metric (kg)</option>
                </select>

                <label className="text-xs font-medium text-gray-700">
                  Body Weight
                </label>
                <input
                  type="number"
                  className="border rounded px-2 py-1 text-sm w-20"
                  value={input.bodyWeight}
                  min={20}
                  max={400}
                  onChange={(e) =>
                    handleBasicChange("bodyWeight", Number(e.target.value) || 0)
                  }
                />
                <span className="text-xs text-gray-500">
                  {input.unitSystem === "imperial" ? "lbs" : "kg"}
                </span>
              </div>

              <div className="flex items-center gap-3">
                <label className="text-xs font-medium text-gray-700">
                  Activity Level
                </label>
                <select
                  className="border rounded px-2 py-1 text-sm"
                  value={input.activityLevel}
                  onChange={(e) =>
                    handleBasicChange("activityLevel", e.target.value)
                  }
                >
                  <option value="sedentary">Sedentary</option>
                  <option value="light">Light</option>
                  <option value="moderate">Moderate</option>
                  <option value="active">Active</option>
                  <option value="athlete">Athlete</option>
                </select>

                <label className="text-xs font-medium text-gray-700">
                  Daily Water (cups)
                </label>
                <input
                  type="number"
                  className="border rounded px-2 py-1 text-sm w-20"
                  value={input.hydrationCupsCurrent}
                  min={0}
                  max={32}
                  onChange={(e) =>
                    handleBasicChange(
                      "hydrationCupsCurrent",
                      Number(e.target.value) || 0
                    )
                  }
                />
              </div>
            </div>

            {/* Hair Profile */}
            <div>
              <h2 className="text-sm font-semibold mb-2">
                2. Hair & Scalp Profile
              </h2>
              <div className="flex flex-wrap gap-3 mb-2">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Curl Pattern
                  </label>
                  <select
                    className="border rounded px-2 py-1 text-sm"
                    value={input.hairTypeProfile.curlPattern}
                    onChange={(e) =>
                      handleNestedChange(
                        ["hairTypeProfile", "curlPattern"],
                        e.target.value
                      )
                    }
                  >
                    <option value="wavy-2">Wavy (2)</option>
                    <option value="curly-3a">Curly 3a</option>
                    <option value="curly-3b">Curly 3b</option>
                    <option value="curly-3c">Curly 3c</option>
                    <option value="coily-4a">Coily 4a</option>
                    <option value="coily-4b">Coily 4b</option>
                    <option value="coily-4c">Coily 4c</option>
                    <option value="locs">Locs</option>
                    <option value="other">Other</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Porosity
                  </label>
                  <select
                    className="border rounded px-2 py-1 text-sm"
                    value={input.hairTypeProfile.porosity}
                    onChange={(e) =>
                      handleNestedChange(
                        ["hairTypeProfile", "porosity"],
                        e.target.value
                      )
                    }
                  >
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="unknown">Unknown</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Scalp Condition
                  </label>
                  <select
                    className="border rounded px-2 py-1 text-sm"
                    value={input.hairTypeProfile.scalpCondition}
                    onChange={(e) =>
                      handleNestedChange(
                        ["hairTypeProfile", "scalpCondition"],
                        e.target.value
                      )
                    }
                  >
                    <option value="normal">Normal</option>
                    <option value="dry">Dry</option>
                    <option value="oily">Oily</option>
                    <option value="itchy">Itchy</option>
                    <option value="flaky">Flaky</option>
                    <option value="inflamed">Inflamed</option>
                    <option value="protective-style-tension">
                      Tension from styles
                    </option>
                    <option value="other">Other</option>
                  </select>
                </div>
              </div>

              <div className="flex flex-wrap gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Chemical History (pick main one)
                  </label>
                  <select
                    className="border rounded px-2 py-1 text-sm"
                    value={input.hairTypeProfile.chemicalHistory[0] || "none"}
                    onChange={(e) =>
                      handleNestedChange(
                        ["hairTypeProfile", "chemicalHistory"],
                        e.target.value === "none" ? [] : [e.target.value]
                      )
                    }
                  >
                    <option value="none">None</option>
                    <option value="relaxer">Relaxer</option>
                    <option value="texturizer">Texturizer</option>
                    <option value="permanent-color">Permanent Color</option>
                    <option value="bleach">Bleach</option>
                    <option value="henna">Henna</option>
                    <option value="keratin-treatment">Keratin Treatment</option>
                    <option value="other">Other</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Protective Style Type
                  </label>
                  <select
                    className="border rounded px-2 py-1 text-sm"
                    value={input.protectiveStylePattern.protectiveStyleType}
                    onChange={(e) =>
                      handleNestedChange(
                        ["protectiveStylePattern", "protectiveStyleType"],
                        e.target.value
                      )
                    }
                  >
                    <option value="none">None</option>
                    <option value="twists">Twists</option>
                    <option value="braids">Braids</option>
                    <option value="cornrows">Cornrows</option>
                    <option value="wigs">Wigs</option>
                    <option value="weaves">Weaves</option>
                    <option value="locs">Locs</option>
                    <option value="other">Other</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Weeks per Style
                  </label>
                  <input
                    type="number"
                    className="border rounded px-2 py-1 text-sm w-20"
                    value={input.protectiveStylePattern.weeksPerStyle}
                    min={0}
                    max={12}
                    onChange={(e) =>
                      handleNestedChange(
                        ["protectiveStylePattern", "weeksPerStyle"],
                        Number(e.target.value) || 0
                      )
                    }
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Install Tension
                  </label>
                  <select
                    className="border rounded px-2 py-1 text-sm"
                    value={input.protectiveStylePattern.installTensionLevel}
                    onChange={(e) =>
                      handleNestedChange(
                        ["protectiveStylePattern", "installTensionLevel"],
                        e.target.value
                      )
                    }
                  >
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="unknown">Unknown</option>
                  </select>
                </div>
              </div>
            </div>

            {/* Goals */}
            <div>
              <h2 className="text-sm font-semibold mb-2">3. Hair Goals</h2>
              <div className="flex flex-wrap gap-3 text-xs">
                {[
                  ["lengthRetention", "Length retention"],
                  ["thickness", "More thickness"],
                  ["sheddingReduction", "Reduce shedding"],
                  ["scalpHealing", "Scalp healing"],
                  ["postpartumSupport", "Postpartum support"],
                ].map(([key, label]) => (
                  <label key={key} className="inline-flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={input.growthGoalFlags[key]}
                      onChange={(e) =>
                        handleCheckboxNested(
                          ["growthGoalFlags", key],
                          e.target.checked
                        )
                      }
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>

            {/* Nutrition Context */}
            <div>
              <h2 className="text-sm font-semibold mb-2">
                4. Nutrition & Budget
              </h2>
              <div className="flex flex-wrap gap-3 mb-2">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Dietary Pattern
                  </label>
                  <select
                    className="border rounded px-2 py-1 text-sm"
                    value={input.dietaryPattern}
                    onChange={(e) =>
                      handleBasicChange("dietaryPattern", e.target.value)
                    }
                  >
                    <option value="omnivore">Omnivore</option>
                    <option value="pescatarian">Pescatarian</option>
                    <option value="lacto-ovo-vegetarian">
                      Lacto-ovo Vegetarian
                    </option>
                    <option value="vegetarian">Vegetarian</option>
                    <option value="vegan">Vegan</option>
                    <option value="other">Other</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Budget
                  </label>
                  <select
                    className="border rounded px-2 py-1 text-sm"
                    value={input.dietaryConstraints.budgetLevel}
                    onChange={(e) =>
                      handleNestedChange(
                        ["dietaryConstraints", "budgetLevel"],
                        e.target.value
                      )
                    }
                  >
                    <option value="very-tight">Very tight</option>
                    <option value="budget-conscious">Budget-conscious</option>
                    <option value="flexible">Flexible</option>
                  </select>
                </div>
              </div>

              <div className="flex flex-wrap gap-3 mb-2 text-xs">
                <div>
                  <label className="block font-medium text-gray-700 mb-1">
                    Macro Targets (optional)
                  </label>
                  <div className="flex gap-2 mb-1">
                    <span className="text-gray-500">Calories</span>
                    <input
                      type="number"
                      className="border rounded px-2 py-0.5 w-20"
                      value={input.macroTargets.calories}
                      onChange={(e) =>
                        handleNestedChange(
                          ["macroTargets", "calories"],
                          Number(e.target.value) || 0
                        )
                      }
                    />
                  </div>
                  <div className="flex gap-2 mb-1">
                    <span className="text-gray-500">Protein</span>
                    <input
                      type="number"
                      className="border rounded px-2 py-0.5 w-20"
                      value={input.macroTargets.proteinGrams}
                      onChange={(e) =>
                        handleNestedChange(
                          ["macroTargets", "proteinGrams"],
                          Number(e.target.value) || 0
                        )
                      }
                    />
                    <span className="text-gray-500">g</span>
                  </div>
                  <div className="flex gap-2 mb-1">
                    <span className="text-gray-500">Fat</span>
                    <input
                      type="number"
                      className="border rounded px-2 py-0.5 w-20"
                      value={input.macroTargets.fatGrams}
                      onChange={(e) =>
                        handleNestedChange(
                          ["macroTargets", "fatGrams"],
                          Number(e.target.value) || 0
                        )
                      }
                    />
                    <span className="text-gray-500">g</span>
                  </div>
                </div>

                <div>
                  <label className="block font-medium text-gray-700 mb-1">
                    Micronutrient Concerns
                  </label>
                  <div className="grid grid-cols-2 gap-1">
                    {[
                      ["ironLowRisk", "Iron"],
                      ["vitaminDLowRisk", "Vitamin D"],
                      ["zincLowRisk", "Zinc"],
                      ["omega3LowRisk", "Omega-3"],
                      ["biotinLowRisk", "Biotin"],
                    ].map(([key, label]) => (
                      <label
                        key={key}
                        className="inline-flex items-center gap-1 text-xs"
                      >
                        <input
                          type="checkbox"
                          checked={input.micronutrientFocusFlags[key]}
                          onChange={(e) =>
                            handleCheckboxNested(
                              ["micronutrientFocusFlags", key],
                              e.target.checked
                            )
                          }
                        />
                        {label} low
                      </label>
                    ))}
                  </div>
                  <label className="inline-flex items-center gap-1 mt-1 text-xs">
                    <input
                      type="checkbox"
                      checked={
                        input.micronutrientFocusFlags
                          .generalMicronutrientConcern
                      }
                      onChange={(e) =>
                        handleCheckboxNested(
                          ["micronutrientFocusFlags", "generalMicronutrientConcern"],
                          e.target.checked
                        )
                      }
                    />
                    General concern
                  </label>
                </div>
              </div>
            </div>

            {/* Hub Export + Actions */}
            <div className="flex items-center justify-between pt-2 border-t border-gray-100">
              <label className="inline-flex items-center gap-2 text-xs text-gray-600">
                <input
                  type="checkbox"
                  checked={exportToHub}
                  onChange={(e) => setExportToHub(e.target.checked)}
                />
                Export results to Family Fund Hub (when enabled)
              </label>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleReset}
                  className="px-3 py-1 rounded border border-gray-300 text-xs text-gray-700 hover:bg-gray-50"
                  disabled={loading}
                >
                  Reset
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 rounded bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700 disabled:opacity-60"
                  disabled={loading}
                >
                  {loading ? "Calculating…" : "Calculate"}
                </button>
              </div>
            </div>

            {error && (
              <p className="mt-2 text-xs text-red-600">
                Error: {error}
              </p>
            )}
          </form>
        </section>

        {/* RESULTS CARD */}
        <section className="bg-white shadow-sm rounded-lg border border-gray-100 p-4">
          <h2 className="text-sm font-semibold mb-3">Results & Focus Areas</h2>

          {!output && (
            <p className="text-xs text-gray-500">
              Fill out the form and click <strong>Calculate</strong> to see your
              daily hair nutrition targets. Your last run will be remembered for
              this device.
            </p>
          )}

          {output && (
            <div className="space-y-4">
              {/* Protein */}
              <div className="border border-emerald-100 bg-emerald-50 rounded-lg p-3">
                <h3 className="text-xs font-semibold text-emerald-800 mb-1">
                  Daily Protein for Hair
                </h3>
                <p className="text-sm font-semibold text-emerald-900">
                  {output.dailyHairProteinTarget.grams} g / day
                </p>
                <p className="text-xs text-emerald-900">
                  ~{output.dailyHairProteinTarget.gramsPerKg} g/kg body weight
                </p>
                <p className="mt-1 text-xs text-emerald-900">
                  Rationale: {output.dailyHairProteinTarget.rationale}
                </p>
              </div>

              {/* Amino Profile */}
              <div className="border rounded-lg p-3">
                <h3 className="text-xs font-semibold mb-2">
                  Key Amino Acid Targets ({output.hairAminoProfile.unit})
                </h3>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  <span>Lysine: {output.hairAminoProfile.lysine} g</span>
                  <span>Methionine: {output.hairAminoProfile.methionine} g</span>
                  <span>Cysteine: {output.hairAminoProfile.cysteine} g</span>
                  <span>Arginine: {output.hairAminoProfile.arginine} g</span>
                  <span>Histidine: {output.hairAminoProfile.histidine} g</span>
                  <span>Tryptophan: {output.hairAminoProfile.tryptophan} g</span>
                </div>
              </div>

              {/* Fats */}
              <div className="border rounded-lg p-3">
                <h3 className="text-xs font-semibold mb-1">
                  Healthy Fats & Omega Balance
                </h3>
                <p className="text-xs">
                  Total fat:{" "}
                  <strong>{output.hairHealthyFatTargets.totalFatGrams} g</strong>{" "}
                  per day
                </p>
                <p className="text-xs">
                  Omega-3:{" "}
                  <strong>{output.hairHealthyFatTargets.omega3Grams} g</strong>,
                  Omega-6:{" "}
                  <strong>{output.hairHealthyFatTargets.omega6Grams} g</strong>
                </p>
                {output.hairHealthyFatTargets.efaRatioHint && (
                  <p className="mt-1 text-xs text-gray-600">
                    {output.hairHealthyFatTargets.efaRatioHint}
                  </p>
                )}
              </div>

              {/* Micronutrients */}
              <div className="border rounded-lg p-3">
                <h3 className="text-xs font-semibold mb-2">
                  Micronutrient Focus Ranges
                </h3>
                <ul className="text-xs space-y-1">
                  <li>
                    Iron: {output.hairMicronutrientTargets.ironMg.min}–
                    {output.hairMicronutrientTargets.ironMg.max} mg
                  </li>
                  <li>
                    Zinc: {output.hairMicronutrientTargets.zincMg.min}–
                    {output.hairMicronutrientTargets.zincMg.max} mg
                  </li>
                  <li>
                    Vitamin D: {output.hairMicronutrientTargets.vitaminDMcg.min}
                    –
                    {output.hairMicronutrientTargets.vitaminDMcg.max} mcg
                  </li>
                  <li>
                    Vitamin A:{" "}
                    {output.hairMicronutrientTargets.vitaminAmcgRAE.min}–
                    {output.hairMicronutrientTargets.vitaminAmcgRAE.max} mcg
                    RAE
                  </li>
                  <li>
                    Vitamin C: {output.hairMicronutrientTargets.vitaminCmg.min}–
                    {output.hairMicronutrientTargets.vitaminCmg.max} mg
                  </li>
                  <li>
                    Biotin: {output.hairMicronutrientTargets.biotinMcg.min}–
                    {output.hairMicronutrientTargets.biotinMcg.max} mcg
                  </li>
                  <li>
                    Folate: {output.hairMicronutrientTargets.folateMcgDFE.min}–
                    {output.hairMicronutrientTargets.folateMcgDFE.max} mcg DFE
                  </li>
                </ul>
              </div>

              {/* Support Flags */}
              <div className="border rounded-lg p-3">
                <h3 className="text-xs font-semibold mb-2">
                  Support Overview
                </h3>
                <div className="mb-2">
                  <FlagPill
                    active={output.hairSupportFlags.proteinOnTrack}
                    label="Protein on track"
                  />
                  <FlagPill
                    active={output.hairSupportFlags.proteinLowRisk}
                    label="Protein low risk"
                  />
                  <FlagPill
                    active={output.hairSupportFlags.ironSupportNeeded}
                    label="Iron support needed"
                  />
                  <FlagPill
                    active={output.hairSupportFlags.vitaminDSupportNeeded}
                    label="Vitamin D support needed"
                  />
                  <FlagPill
                    active={output.hairSupportFlags.omega3SupportNeeded}
                    label="Omega-3 support needed"
                  />
                  <FlagPill
                    active={output.hairSupportFlags.hydrationSupportNeeded}
                    label="Hydration support needed"
                  />
                </div>
                <p className="text-xs text-gray-700">
                  {output.hairSupportFlags.summaryNote}
                </p>
              </div>

              {/* Risk Flags */}
              <div className="border rounded-lg p-3">
                <h3 className="text-xs font-semibold mb-2">
                  Black Hair Risk Flags
                </h3>
                <div className="mb-1 flex flex-wrap">
                  <FlagPill
                    active={output.blackHairRiskFlags.breakageRisk}
                    label="Breakage risk"
                  />
                  <FlagPill
                    active={output.blackHairRiskFlags.sheddingRisk}
                    label="Shedding risk"
                  />
                  <FlagPill
                    active={output.blackHairRiskFlags.drynessRisk}
                    label="Dryness risk"
                  />
                  <FlagPill
                    active={output.blackHairRiskFlags.scalpInflammationRisk}
                    label="Scalp inflammation risk"
                  />
                  <FlagPill
                    active={output.blackHairRiskFlags.protectiveStyleDamageRisk}
                    label="Protective style damage risk"
                  />
                  <FlagPill
                    active={output.blackHairRiskFlags.postpartumRisk}
                    label="Postpartum risk"
                  />
                </div>
                {output.blackHairRiskFlags.notes && (
                  <p className="text-xs text-gray-700">
                    {output.blackHairRiskFlags.notes}
                  </p>
                )}
              </div>

              {/* Water Target */}
              <div className="border rounded-lg p-3">
                <h3 className="text-xs font-semibold mb-1">Hydration Target</h3>
                <p className="text-xs">
                  Aim for{" "}
                  <strong>{output.waterIntakeTargetCups} cups</strong> of water
                  per day.
                  {input.hydrationCupsCurrent > 0 && (
                    <>
                      {" "}
                      You reported ~{input.hydrationCupsCurrent} cups/day, so
                      adjust as needed.
                    </>
                  )}
                </p>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
