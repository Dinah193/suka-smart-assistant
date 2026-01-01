// C:\Users\larho\suka-smart-assistant\src\features\calculators\health\MovementIntensityCalculator\MovementIntensityCalculator.view.jsx

/**
 * MovementIntensityCalculator.view.jsx
 *
 * UI interface to:
 * - Log simple movement inputs (weight, age, step/activity patterns, risk flags).
 * - Call the MovementIntensityCalculator shim.
 * - Display movement intensity score, calorie estimates, and suggested sessions.
 *
 * How this fits into SSA:
 * - This is a view-layer wrapper around MovementIntensityCalculator.shim.js.
 * - The shim handles:
 *    - Pure calculation logic.
 *    - Event emission (calculator.movementIntensity.calculated / .error).
 *    - Optional Family Fund Hub export.
 * - This component:
 *    - Manages form state and local persistence (localStorage).
 *    - Allows the user to compute results on demand.
 *    - Surfaces movement session templates that can be passed into SessionRunner
 *      from other orchestration layers (e.g., movement planner / “Now” CTA).
 *
 * Notes:
 * - This file is intentionally UI-focused and does not depend on SessionRunner
 *   details; it only exposes the data needed to build sessions elsewhere.
 */

import React, { useEffect, useMemo, useState } from "react";
import MovementIntensityCalculatorShim, {
  runMovementIntensityCalculatorShim,
  NODE_ID,
} from "./MovementIntensityCalculator.shim";

const STORAGE_KEY = "ssa.movementIntensityCalculator.state";

/**
 * Build a safe default input object that matches MovementIntensityCalculator.schema.json `input` shape.
 * This is used as the base for the form state.
 */
function buildDefaultInput() {
  return {
    unitSystem: "imperial",
    bodyWeight: 180,
    age: 35,
    sex: "unspecified",
    restingHeartRate: 70,
    maxHeartRateEstimate: 0, // 0 = let shim infer from age
    baselineStepGoalPerDay: 8000,
    movementPreferences: {
      preferredSessionBlockMinutes: 20,
      maxSessionsPerDay: 3,
      indoorOnly: false,
    },
    // Simple "summary style" step history; UI will fan this into 7 days
    stepHistory: [],
    sessionHistory: [],
    healthRiskFlags: {
      cardioRisk: false,
      jointPainRisk: false,
      fatigueRisk: false,
    },
    sleepQualityFlags: {
      sleepDebtHigh: false,
      sleepFragmented: false,
      restedFeeling: true,
    },
    // Extra UI-only helpers (not in schema, we map into stepHistory)
    uiAggregate: {
      avgStepsPerDayLast7: 6000,
      weeklyLightMinutes: 90,
      weeklyModerateMinutes: 60,
      weeklyVigorousMinutes: 20,
    },
  };
}

/**
 * Safely load persisted state from localStorage.
 * Returns { input, result } or null.
 */
function loadPersistedState() {
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
 * Persist calculator state to localStorage.
 * @param {object} state
 */
function persistState(state) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Non-fatal if storage is unavailable
  }
}

/**
 * Convert the UI aggregate fields into a 7-day stepHistory array.
 * This keeps the form simple while still feeding the shim the full shape it expects.
 *
 * @param {object} input
 * @returns {object[]} stepHistory for the last 7 days
 */
function buildStepHistoryFromUiAggregate(input) {
  const { uiAggregate } = input;
  const avgSteps = Number(uiAggregate?.avgStepsPerDayLast7 || 0);
  const weeklyLight = Number(uiAggregate?.weeklyLightMinutes || 0);
  const weeklyModerate = Number(uiAggregate?.weeklyModerateMinutes || 0);
  const weeklyVigorous = Number(uiAggregate?.weeklyVigorousMinutes || 0);

  const days = 7;
  const perDayLight = weeklyLight / days;
  const perDayModerate = weeklyModerate / days;
  const perDayVigorous = weeklyVigorous / days;

  const today = new Date();
  const history = [];

  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);

    history.push({
      date: dateStr,
      steps: Math.round(avgSteps),
      distance: 0, // not required; shim tolerates 0
      activeMinutesLight: Math.round(perDayLight),
      activeMinutesModerate: Math.round(perDayModerate),
      activeMinutesVigorous: Math.round(perDayVigorous),
      avgHeartRate: input.restingHeartRate || 70,
    });
  }

  return history;
}

/**
 * Main React view component for Movement Intensity Calculator.
 */
export default function MovementIntensityCalculatorView() {
  const [input, setInput] = useState(() => {
    if (typeof window === "undefined") return buildDefaultInput();
    const persisted = loadPersistedState();
    if (persisted && persisted.input) {
      return {
        ...buildDefaultInput(),
        ...persisted.input,
      };
    }
    return buildDefaultInput();
  });

  const [result, setResult] = useState(() => {
    if (typeof window === "undefined") return null;
    const persisted = loadPersistedState();
    return persisted?.result || null;
  });

  const [status, setStatus] = useState("idle"); // "idle" | "running" | "success" | "error"
  const [error, setError] = useState(null);
  const [exportToHub, setExportToHub] = useState(false);

  // Persist on change
  useEffect(() => {
    if (typeof window === "undefined") return;
    persistState({ input, result });
  }, [input, result]);

  const movementSummary = useMemo(() => {
    if (!result || !result.output) return null;
    const { output } = result;
    return {
      intensityScore: output.movementIntensityScore,
      intensityCategory: output.movementIntensityCategory,
      weeklyCalories: output.calorieAndLoadEstimates
        ?.estimatedWeeklyActivityCalories,
      dailyCalories: output.calorieAndLoadEstimates
        ?.estimatedDailyActivityCalories,
      movementTargets: output.movementMinutesTargets,
      recoveryFlags: output.recoveryLoadFlags,
      templates: output.movementSessionTemplates || [],
    };
  }, [result]);

  /**
   * Handle simple input updates.
   * @param {string} path e.g. "bodyWeight" or "healthRiskFlags.cardioRisk"
   * @param {any} value
   */
  function updateInput(path, value) {
    setInput((prev) => {
      const next = { ...prev };
      const segments = path.split(".");
      let cursor = next;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const key = segments[i];
        if (cursor[key] == null || typeof cursor[key] !== "object") {
          cursor[key] = {};
        }
        cursor = cursor[key];
      }
      cursor[segments[segments.length - 1]] = value;
      return next;
    });
  }

  /**
   * Run the movement calculator shim using the current input state.
   */
  async function handleCalculate(e) {
    if (e && typeof e.preventDefault === "function") {
      e.preventDefault();
    }

    setStatus("running");
    setError(null);

    try {
      const preparedInput = {
        ...input,
        stepHistory: buildStepHistoryFromUiAggregate(input),
        // For now we pass an empty sessionHistory; later this can be fed from SessionRunner.
        sessionHistory: Array.isArray(input.sessionHistory)
          ? input.sessionHistory
          : [],
      };

      const payload = await runMovementIntensityCalculatorShim(
        preparedInput,
        {
          exportToHub,
        }
      );

      setResult(payload);
      setStatus("success");
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        "[MovementIntensityCalculator.view] calculation failed",
        err
      );
      setError(
        err && err.message
          ? err.message
          : "Something went wrong running the movement calculator."
      );
      setStatus("error");
    }
  }

  /**
   * Reset input & result to defaults while preserving export preference.
   */
  function handleReset() {
    const fresh = buildDefaultInput();
    setInput(fresh);
    setResult(null);
    setStatus("idle");
    setError(null);
  }

  return (
    <div className="ssa-calculator ssa-calculator--movement-intensity">
      <header className="ssa-calculator__header">
        <h1 className="ssa-calculator__title">
          Movement Intensity &amp; Load
        </h1>
        <p className="ssa-calculator__subtitle">
          Turn your steps and simple activity patterns into clear intensity
          categories, weekly movement targets, calorie estimates, and
          SessionRunner-friendly movement session templates.
        </p>
      </header>

      <form
        className="ssa-calculator__grid"
        onSubmit={handleCalculate}
        noValidate
      >
        {/* LEFT: INPUTS */}
        <section className="ssa-calculator__panel ssa-calculator__panel--inputs">
          <h2 className="ssa-calculator__panel-title">Inputs</h2>

          {/* Basics */}
          <div className="ssa-field-group">
            <h3 className="ssa-field-group__title">Body &amp; Basics</h3>
            <div className="ssa-field-row">
              <label className="ssa-field">
                <span>Unit system</span>
                <select
                  value={input.unitSystem}
                  onChange={(e) =>
                    updateInput("unitSystem", e.target.value)
                  }
                >
                  <option value="imperial">Imperial (lbs, miles)</option>
                  <option value="metric">Metric (kg, km)</option>
                </select>
              </label>

              <label className="ssa-field">
                <span>Body weight ({input.unitSystem === "imperial"
                  ? "lbs"
                  : "kg"}
                )</span>
                <input
                  type="number"
                  min="20"
                  max="400"
                  value={input.bodyWeight}
                  onChange={(e) =>
                    updateInput("bodyWeight", Number(e.target.value || 0))
                  }
                />
              </label>
            </div>

            <div className="ssa-field-row">
              <label className="ssa-field">
                <span>Age (years)</span>
                <input
                  type="number"
                  min="5"
                  max="100"
                  value={input.age}
                  onChange={(e) =>
                    updateInput("age", Number(e.target.value || 0))
                  }
                />
              </label>

              <label className="ssa-field">
                <span>Resting heart rate (bpm)</span>
                <input
                  type="number"
                  min="30"
                  max="110"
                  value={input.restingHeartRate}
                  onChange={(e) =>
                    updateInput(
                      "restingHeartRate",
                      Number(e.target.value || 0)
                    )
                  }
                />
              </label>
            </div>

            <div className="ssa-field-row">
              <label className="ssa-field">
                <span>Daily step goal</span>
                <input
                  type="number"
                  min="1000"
                  max="30000"
                  value={input.baselineStepGoalPerDay}
                  onChange={(e) =>
                    updateInput(
                      "baselineStepGoalPerDay",
                      Number(e.target.value || 0)
                    )
                  }
                />
              </label>
            </div>
          </div>

          {/* Aggregated 7-day movement summary */}
          <div className="ssa-field-group">
            <h3 className="ssa-field-group__title">
              Last 7 Days – Simple Movement Summary
            </h3>
            <p className="ssa-field-group__hint">
              You don&apos;t have to remember every day. Just estimate your
              average steps per day and how many minutes you spent in each
              intensity bucket over the last week.
            </p>
            <div className="ssa-field-row">
              <label className="ssa-field">
                <span>Average steps per day (last 7 days)</span>
                <input
                  type="number"
                  min="0"
                  value={input.uiAggregate.avgStepsPerDayLast7}
                  onChange={(e) =>
                    updateInput(
                      "uiAggregate.avgStepsPerDayLast7",
                      Number(e.target.value || 0)
                    )
                  }
                />
              </label>
            </div>
            <div className="ssa-field-row">
              <label className="ssa-field">
                <span>Light activity minutes (per week)</span>
                <input
                  type="number"
                  min="0"
                  value={input.uiAggregate.weeklyLightMinutes}
                  onChange={(e) =>
                    updateInput(
                      "uiAggregate.weeklyLightMinutes",
                      Number(e.target.value || 0)
                    )
                  }
                />
              </label>
            </div>
            <div className="ssa-field-row">
              <label className="ssa-field">
                <span>Moderate activity minutes (per week)</span>
                <input
                  type="number"
                  min="0"
                  value={input.uiAggregate.weeklyModerateMinutes}
                  onChange={(e) =>
                    updateInput(
                      "uiAggregate.weeklyModerateMinutes",
                      Number(e.target.value || 0)
                    )
                  }
                />
              </label>
            </div>
            <div className="ssa-field-row">
              <label className="ssa-field">
                <span>Vigorous activity minutes (per week)</span>
                <input
                  type="number"
                  min="0"
                  value={input.uiAggregate.weeklyVigorousMinutes}
                  onChange={(e) =>
                    updateInput(
                      "uiAggregate.weeklyVigorousMinutes",
                      Number(e.target.value || 0)
                    )
                  }
                />
              </label>
            </div>
          </div>

          {/* Risk & sleep flags */}
          <div className="ssa-field-group">
            <h3 className="ssa-field-group__title">
              Health &amp; Sleep Flags
            </h3>
            <div className="ssa-field-row ssa-field-row--checkboxes">
              <label className="ssa-checkbox">
                <input
                  type="checkbox"
                  checked={input.healthRiskFlags.cardioRisk}
                  onChange={(e) =>
                    updateInput(
                      "healthRiskFlags.cardioRisk",
                      e.target.checked
                    )
                  }
                />
                <span>Cardio risk / doctor cautions</span>
              </label>
              <label className="ssa-checkbox">
                <input
                  type="checkbox"
                  checked={input.healthRiskFlags.jointPainRisk}
                  onChange={(e) =>
                    updateInput(
                      "healthRiskFlags.jointPainRisk",
                      e.target.checked
                    )
                  }
                />
                <span>Joint pain or mobility issues</span>
              </label>
              <label className="ssa-checkbox">
                <input
                  type="checkbox"
                  checked={input.healthRiskFlags.fatigueRisk}
                  onChange={(e) =>
                    updateInput(
                      "healthRiskFlags.fatigueRisk",
                      e.target.checked
                    )
                  }
                />
                <span>Chronic fatigue / low energy</span>
              </label>
            </div>
            <div className="ssa-field-row ssa-field-row--checkboxes">
              <label className="ssa-checkbox">
                <input
                  type="checkbox"
                  checked={input.sleepQualityFlags.sleepDebtHigh}
                  onChange={(e) =>
                    updateInput(
                      "sleepQualityFlags.sleepDebtHigh",
                      e.target.checked
                    )
                  }
                />
                <span>High sleep debt (often tired)</span>
              </label>
              <label className="ssa-checkbox">
                <input
                  type="checkbox"
                  checked={input.sleepQualityFlags.sleepFragmented}
                  onChange={(e) =>
                    updateInput(
                      "sleepQualityFlags.sleepFragmented",
                      e.target.checked
                    )
                  }
                />
                <span>Fragmented or poor-quality sleep</span>
              </label>
              <label className="ssa-checkbox">
                <input
                  type="checkbox"
                  checked={input.sleepQualityFlags.restedFeeling}
                  onChange={(e) =>
                    updateInput(
                      "sleepQualityFlags.restedFeeling",
                      e.target.checked
                    )
                  }
                />
                <span>Generally feel rested</span>
              </label>
            </div>
          </div>

          {/* Preferences */}
          <div className="ssa-field-group">
            <h3 className="ssa-field-group__title">
              Movement Preferences
            </h3>
            <div className="ssa-field-row">
              <label className="ssa-field">
                <span>Preferred session length (minutes)</span>
                <input
                  type="number"
                  min="5"
                  max="120"
                  value={
                    input.movementPreferences
                      .preferredSessionBlockMinutes
                  }
                  onChange={(e) =>
                    updateInput(
                      "movementPreferences.preferredSessionBlockMinutes",
                      Number(e.target.value || 0)
                    )
                  }
                />
              </label>
              <label className="ssa-field">
                <span>Max sessions per day</span>
                <input
                  type="number"
                  min="1"
                  max="8"
                  value={input.movementPreferences.maxSessionsPerDay}
                  onChange={(e) =>
                    updateInput(
                      "movementPreferences.maxSessionsPerDay",
                      Number(e.target.value || 0)
                    )
                  }
                />
              </label>
            </div>
            <div className="ssa-field-row ssa-field-row--checkboxes">
              <label className="ssa-checkbox">
                <input
                  type="checkbox"
                  checked={input.movementPreferences.indoorOnly}
                  onChange={(e) =>
                    updateInput(
                      "movementPreferences.indoorOnly",
                      e.target.checked
                    )
                  }
                />
                <span>Prefer indoor-only sessions (bad weather / safety)</span>
              </label>
            </div>
          </div>

          {/* Export toggle */}
          <div className="ssa-field-group">
            <h3 className="ssa-field-group__title">
              Sharing &amp; Export
            </h3>
            <div className="ssa-field-row ssa-field-row--checkboxes">
              <label className="ssa-checkbox">
                <input
                  type="checkbox"
                  checked={exportToHub}
                  onChange={(e) => setExportToHub(e.target.checked)}
                />
                <span>
                  Export results to Family Fund Hub (when{" "}
                  <code>familyFundMode</code> is enabled)
                </span>
              </label>
            </div>
          </div>

          {/* Actions */}
          <div className="ssa-calculator__actions">
            <button
              type="submit"
              className="ssa-button ssa-button--primary"
              disabled={status === "running"}
            >
              {status === "running"
                ? "Calculating…"
                : "Calculate Movement Intensity"}
            </button>
            <button
              type="button"
              className="ssa-button ssa-button--ghost"
              onClick={handleReset}
              disabled={status === "running"}
            >
              Reset
            </button>
          </div>

          {error && (
            <div className="ssa-alert ssa-alert--error">
              <strong>Error:</strong> {error}
            </div>
          )}
        </section>

        {/* RIGHT: RESULTS */}
        <section className="ssa-calculator__panel ssa-calculator__panel--results">
          <h2 className="ssa-calculator__panel-title">Results</h2>

          {!movementSummary && (
            <p className="ssa-calculator__placeholder">
              Fill in your info and run the calculator to see your
              movement intensity, calorie estimates, and suggested
              sessions.
            </p>
          )}

          {movementSummary && (
            <>
              {/* Top summary */}
              <div className="ssa-result-card ssa-result-card--highlight">
                <div className="ssa-result-card__main">
                  <div>
                    <div className="ssa-result-card__label">
                      Intensity score
                    </div>
                    <div className="ssa-result-card__value">
                      {Math.round(movementSummary.intensityScore)} / 100
                    </div>
                  </div>
                  <div>
                    <div className="ssa-result-card__label">
                      Category
                    </div>
                    <div className="ssa-result-card__pill">
                      {movementSummary.intensityCategory}
                    </div>
                  </div>
                </div>
                <div className="ssa-result-card__meta">
                  <div>
                    <span className="ssa-result-card__meta-label">
                      Daily activity calories (est.)
                    </span>
                    <span className="ssa-result-card__meta-value">
                      {movementSummary.dailyCalories
                        ? Math.round(
                            movementSummary.dailyCalories
                          )
                        : "—"}{" "}
                      kcal/day
                    </span>
                  </div>
                  <div>
                    <span className="ssa-result-card__meta-label">
                      Weekly activity calories (est.)
                    </span>
                    <span className="ssa-result-card__meta-value">
                      {movementSummary.weeklyCalories
                        ? Math.round(
                            movementSummary.weeklyCalories
                          )
                        : "—"}{" "}
                      kcal/week
                    </span>
                  </div>
                </div>
              </div>

              {/* Movement targets */}
              {movementSummary.movementTargets && (
                <div className="ssa-result-card">
                  <h3 className="ssa-result-card__title">
                    Weekly Movement Targets
                  </h3>
                  <ul className="ssa-list ssa-list--targets">
                    <li>
                      <span>Light activity:</span>
                      <strong>
                        {" "}
                        {
                          movementSummary.movementTargets
                            .lightMinutesPerWeek
                        }{" "}
                        min/week
                      </strong>
                    </li>
                    <li>
                      <span>Moderate activity:</span>
                      <strong>
                        {" "}
                        {
                          movementSummary.movementTargets
                            .moderateMinutesPerWeek
                        }{" "}
                        min/week
                      </strong>
                    </li>
                    <li>
                      <span>Vigorous activity:</span>
                      <strong>
                        {" "}
                        {
                          movementSummary.movementTargets
                            .vigorousMinutesPerWeek
                        }{" "}
                        min/week
                      </strong>
                    </li>
                    <li>
                      <span>Guideline-equivalent minutes (est.):</span>
                      <strong>
                        {" "}
                        {
                          movementSummary.movementTargets
                            .combinedGuidelineEquivalentMinutesPerWeek
                        }{" "}
                        min/week
                      </strong>
                    </li>
                    <li>
                      <span>Gap to guideline (positive = below target):</span>
                      <strong>
                        {" "}
                        {
                          movementSummary.movementTargets
                            .deficitToGuidelineMinutes
                        }{" "}
                        min/week
                      </strong>
                    </li>
                  </ul>
                </div>
              )}

              {/* Recovery & load */}
              {movementSummary.recoveryFlags && (
                <div className="ssa-result-card">
                  <h3 className="ssa-result-card__title">
                    Recovery &amp; Load
                  </h3>
                  <ul className="ssa-list ssa-list--flags">
                    <li>
                      <span>Overreaching risk:</span>
                      <strong>
                        {" "}
                        {movementSummary.recoveryFlags.overreachingRisk
                          ? "Yes"
                          : "No"}
                      </strong>
                    </li>
                    <li>
                      <span>Undertraining risk:</span>
                      <strong>
                        {" "}
                        {movementSummary.recoveryFlags.undertrainingRisk
                          ? "Yes"
                          : "No"}
                      </strong>
                    </li>
                    <li>
                      <span>Recovery day recommended:</span>
                      <strong>
                        {" "}
                        {movementSummary.recoveryFlags
                          .recoveryDayRecommended
                          ? "Yes"
                          : "No"}
                      </strong>
                    </li>
                  </ul>
                  {movementSummary.recoveryFlags.notes && (
                    <p className="ssa-result-card__note">
                      {movementSummary.recoveryFlags.notes}
                    </p>
                  )}
                </div>
              )}

              {/* Session templates */}
              {movementSummary.templates &&
                movementSummary.templates.length > 0 && (
                  <div className="ssa-result-card">
                    <h3 className="ssa-result-card__title">
                      Suggested Movement Sessions
                    </h3>
                    <p className="ssa-result-card__subtitle">
                      These templates can be turned into SessionRunner
                      sessions by your movement planner or automation
                      flows.
                    </p>
                    <div className="ssa-template-grid">
                      {movementSummary.templates.map((tpl) => (
                        <div
                          key={tpl.templateId}
                          className="ssa-template-card"
                        >
                          <div className="ssa-template-card__header">
                            <h4>{tpl.title}</h4>
                            <span className="ssa-template-card__badge">
                              {tpl.intensityCategory}
                            </span>
                          </div>
                          <div className="ssa-template-card__body">
                            <p>
                              Duration:{" "}
                              <strong>
                                {tpl.durationMinutes} min
                              </strong>
                            </p>
                            <p>
                              Recommended per week:{" "}
                              <strong>
                                {tpl.recommendedPerWeek}x
                              </strong>
                            </p>
                          </div>
                          <div className="ssa-template-card__footer">
                            {/* NOTE: The actual “Start Now” wiring into SessionRunner
                                should be handled by the movement planner / session
                                creation layer. This button can be wired later using
                                your existing SessionBuilder + SessionRunner logic. */}
                            <button
                              type="button"
                              className="ssa-button ssa-button--secondary ssa-button--small"
                              disabled
                              title="SessionRunner integration to be wired by the movement planner."
                            >
                              Start via Movement Planner
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
            </>
          )}
        </section>
      </form>
    </div>
  );
}
