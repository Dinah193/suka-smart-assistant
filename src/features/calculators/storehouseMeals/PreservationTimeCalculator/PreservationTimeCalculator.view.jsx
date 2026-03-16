/* eslint-disable no-console */
/**
 * PreservationTimeCalculator.view.jsx
 *
 * UI for the Preservation Time Calculator in SSA.
 *
 * HOW THIS FITS:
 * - Collects user inputs (method, volume, altitude, ambient conditions, risk level).
 * - Calls PreservationTimeCalculator.shim.js to compute:
 *   - recommendedProcessingTimeMinutes
 *   - recommendedStorageTimeDays + label
 *   - riskBand + warnings
 *   - sessionTemplateOverride (planning-only steps for SessionRunner)
 * - Shows a planning modal (styled similarly to your SSA modals) with:
 *   - Input controls on the left
 *   - Duration & storage summary on the right
 *   - “Start Preservation Session” button that emits a session object
 *     for the global SessionRunner to pick up and run.
 *
 * BACKGROUND / NAVIGATION:
 * - This component does NOT itself keep timers running in the background.
 *   Instead, it emits a fully-formed session object to the event bus.
 * - Your root-level SessionRunner listener can then:
 *   - persist the session in Dexie,
 *   - open the global SessionRunner modal,
 *   - keep timers and wake-lock running across route changes.
 */

import React, { useState, useEffect } from "react";
import { emit } from "@/services/events/eventBus";
import { runPreservationTimeCalculator } from "./PreservationTimeCalculator.shim";

/**
 * @typedef {"pressureCanning"|"waterBathCanning"|"dehydration"|"curing"|"fermentation"|"freezing"|"refrigeration"|"other"} PreservationMethod
 */

/**
 * Default input state (aligned with PreservationTimeCalculator.schema.json).
 */
const DEFAULT_INPUT = {
  foodType: "",
  preservationMethod: "pressureCanning",
  containerVolume: 1,
  containerVolumeUnit: "quart",
  altitudeMeters: null,
  ambientTemperatureC: 20,
  ambientHumidityPercent: 50,
  householdRiskTolerance: "low",
};

/**
 * Small helper to create ISO timestamp.
 * @returns {string}
 */
function nowISO() {
  return new Date().toISOString();
}

/**
 * Build a session object from calculator output + sessionTemplateOverride
 * that matches the shared SessionRunner contract.
 *
 * @param {object} calculatorResult
 * @returns {object|null}
 */
function buildSessionFromResult(calculatorResult) {
  if (!calculatorResult || !calculatorResult.output) return null;
  const { output } = calculatorResult;
  const override = output.sessionTemplateOverride;
  if (
    !override ||
    !Array.isArray(override.steps) ||
    override.steps.length === 0
  ) {
    return null;
  }

  const createdAt = nowISO();

  return {
    id: `preservation-${Date.now()}`,
    domain: "preservation",
    title: override.title || "Preservation session",
    source: {
      type: "manual",
      refId: null,
    },
    steps: override.steps.map((step, index) => ({
      id: step.id || `step-${index + 1}`,
      title: step.title || `Step ${index + 1}`,
      desc: step.desc || "",
      durationSec: typeof step.durationSec === "number" ? step.durationSec : 0,
      blockers: Array.isArray(step.blockers) ? step.blockers : ["inventory"],
      metadata: step.metadata || {
        tempTargetF: 0,
        donenessCue: "timer",
        cueNotes: "",
      },
    })),
    prefs: {
      voiceGuidance: true,
      haptic: true,
      autoAdvance: false,
    },
    status: "pending",
    progress: {
      currentStepIndex: 0,
      elapsedSec: 0,
      startedAt: null,
      pausedAt: null,
    },
    analytics: {
      skippedSteps: [],
      adjustments: [],
    },
    createdAt,
    updatedAt: createdAt,
  };
}

/**
 * PreservationTimeCalculatorView
 *
 * Main React view responsible for:
 * - rendering the page panel,
 * - showing a planning modal,
 * - triggering the preservation time shim,
 * - emitting a session object for the SessionRunner.
 */
const PreservationTimeCalculatorView = () => {
  const [input, setInput] = useState(DEFAULT_INPUT);
  const [result, setResult] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const [showModal, setShowModal] = useState(true);

  // Hydrate last used input from localStorage (simple persistence).
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(
        "ssa.preservationTimeCalculator.input"
      );
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          setInput((prev) => ({ ...prev, ...parsed }));
        }
      }
    } catch (err) {
      console.warn(
        "[PreservationTimeCalculatorView] Failed to restore input from localStorage",
        err
      );
    }
  }, []);

  // Persist input whenever it changes (so user doesn’t lose setup).
  useEffect(() => {
    try {
      window.localStorage.setItem(
        "ssa.preservationTimeCalculator.input",
        JSON.stringify(input)
      );
    } catch (err) {
      console.warn(
        "[PreservationTimeCalculatorView] Failed to persist input to localStorage",
        err
      );
    }
  }, [input]);

  /**
   * Generic change handler for text/number/radio/select.
   * @param {React.ChangeEvent<HTMLInputElement|HTMLSelectElement>} e
   */
  const handleChange = (e) => {
    const { name, value } = e.target;

    // Fields that should be numeric
    if (
      name === "containerVolume" ||
      name === "altitudeMeters" ||
      name === "ambientTemperatureC" ||
      name === "ambientHumidityPercent"
    ) {
      const num = value === "" ? null : Number(value);
      setInput((prev) => ({ ...prev, [name]: Number.isNaN(num) ? null : num }));
      return;
    }

    setInput((prev) => ({ ...prev, [name]: value }));
  };

  /**
   * Execute the calculator shim with current inputs.
   */
  const handleRunCalculator = async () => {
    setIsRunning(true);
    try {
      const calcResult = await runPreservationTimeCalculator({
        input,
        source: "ui",
      });
      setResult(calcResult);
    } catch (err) {
      console.error("[PreservationTimeCalculatorView] Calculation failed", err);
    } finally {
      setIsRunning(false);
    }
  };

  /**
   * Request a SessionRunner session based on the calculator result.
   */
  const handleStartSession = () => {
    const session = buildSessionFromResult(result);
    if (!session) {
      console.warn(
        "[PreservationTimeCalculatorView] Cannot start session; missing sessionTemplateOverride."
      );
      return;
    }

    try {
      emit({
        type: "session.requested",
        ts: nowISO(),
        source: "PreservationTimeCalculatorView",
        data: { session },
      });
      setShowModal(false);
    } catch (err) {
      console.warn(
        "[PreservationTimeCalculatorView] Failed to emit session.requested",
        err
      );
    }
  };

  const output = result?.output;
  const hasResult = !!output;

  return (
    <div className="relative w-full h-full">
      {/* Simple page header / launcher (so this can live on a regular route) */}
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Preservation Time Planner</h1>
          <p className="text-sm text-gray-500">
            Estimate processing and storage times for canning, dehydrating,
            curing, and more, then launch a preservation session in the SSA
            SessionRunner.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowModal(true)}
          className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium shadow-sm hover:bg-gray-50"
        >
          Open Planner
        </button>
      </div>

      {/* Full-screen modal styled similarly to SSA session modals */}
      {showModal && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50">
          <div className="relative flex h-[80vh] w-[90vw] max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
            {/* Modal header */}
            <div className="flex items-center justify-between border-b px-5 py-3">
              <div>
                <h2 className="text-lg font-semibold">
                  Plan a Preservation Session
                </h2>
                <p className="text-xs text-gray-500">
                  Adjust your inputs, review estimated durations and storage
                  windows, then start a session that the SessionRunner can track
                  across the app.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowModal(false)}
                className="rounded-full border border-gray-300 p-1 text-gray-500 hover:bg-gray-100"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            {/* Modal body: two columns */}
            <div className="flex flex-1 flex-col gap-4 px-5 py-4 md:flex-row">
              {/* Left column: inputs */}
              <div className="flex-1 space-y-4 overflow-y-auto pr-1">
                <section>
                  <h3 className="text-sm font-semibold text-gray-700">
                    Food & Method
                  </h3>
                  <div className="mt-2 space-y-3">
                    <div>
                      <label className="block text-xs font-medium text-gray-600">
                        Food type / product
                      </label>
                      <input
                        type="text"
                        name="foodType"
                        value={input.foodType}
                        onChange={handleChange}
                        placeholder="Example: green beans, lamb stew, strawberry jam"
                        className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-gray-600">
                        Preservation method
                      </label>
                      <select
                        name="preservationMethod"
                        value={input.preservationMethod}
                        onChange={handleChange}
                        className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                      >
                        <option value="pressureCanning">
                          Pressure canning
                        </option>
                        <option value="waterBathCanning">
                          Water bath canning
                        </option>
                        <option value="dehydration">Dehydration</option>
                        <option value="curing">Curing</option>
                        <option value="fermentation">Fermentation</option>
                        <option value="freezing">Freezing</option>
                        <option value="refrigeration">Refrigeration</option>
                        <option value="other">Other / planning only</option>
                      </select>
                    </div>
                  </div>
                </section>

                <section>
                  <h3 className="text-sm font-semibold text-gray-700">
                    Container & Conditions
                  </h3>
                  <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-2">
                    <div>
                      <label className="block text-xs font-medium text-gray-600">
                        Container volume
                      </label>
                      <div className="mt-1 flex gap-2">
                        <input
                          type="number"
                          name="containerVolume"
                          value={input.containerVolume ?? ""}
                          onChange={handleChange}
                          min="0"
                          step="0.1"
                          className="w-2/3 rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                        />
                        <select
                          name="containerVolumeUnit"
                          value={input.containerVolumeUnit}
                          onChange={handleChange}
                          className="w-1/3 rounded-lg border border-gray-300 px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500"
                        >
                          <option value="quart">quart</option>
                          <option value="pint">pint</option>
                          <option value="cup">cup</option>
                          <option value="ml">ml</option>
                          <option value="liter">liter</option>
                          <option value="gallon">gallon</option>
                        </select>
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-gray-600">
                        Altitude (meters)
                      </label>
                      <input
                        type="number"
                        name="altitudeMeters"
                        value={input.altitudeMeters ?? ""}
                        onChange={handleChange}
                        min="0"
                        step="10"
                        placeholder="Optional"
                        className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                      />
                      <p className="mt-1 text-[10px] text-gray-400">
                        Used to roughly adjust boiling-based methods for
                        altitude.
                      </p>
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-gray-600">
                        Ambient temperature (°C)
                      </label>
                      <input
                        type="number"
                        name="ambientTemperatureC"
                        value={input.ambientTemperatureC ?? ""}
                        onChange={handleChange}
                        step="1"
                        className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-gray-600">
                        Ambient humidity (%)
                      </label>
                      <input
                        type="number"
                        name="ambientHumidityPercent"
                        value={input.ambientHumidityPercent ?? ""}
                        onChange={handleChange}
                        step="1"
                        min="0"
                        max="100"
                        className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                      />
                    </div>
                  </div>
                </section>

                <section>
                  <h3 className="text-sm font-semibold text-gray-700">
                    Household Risk Tolerance
                  </h3>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {["veryLow", "low", "moderate", "high"].map((level) => (
                      <button
                        key={level}
                        type="button"
                        onClick={() =>
                          setInput((prev) => ({
                            ...prev,
                            householdRiskTolerance: level,
                          }))
                        }
                        className={`rounded-full px-3 py-1 text-xs font-medium border ${
                          input.householdRiskTolerance === level
                            ? "border-emerald-500 bg-emerald-50 text-emerald-700"
                            : "border-gray-300 text-gray-600 hover:bg-gray-50"
                        }`}
                      >
                        {level === "veryLow"
                          ? "Very low"
                          : level[0].toUpperCase() + level.slice(1)}
                      </button>
                    ))}
                  </div>
                  <p className="mt-1 text-[10px] text-gray-400">
                    Lower tolerance = more conservative storage windows.
                  </p>
                </section>
              </div>

              {/* Right column: results + session preview */}
              <div className="flex-1 rounded-xl border border-gray-200 bg-gray-50/60 p-3 md:p-4">
                <h3 className="text-sm font-semibold text-gray-700">
                  Estimated Durations
                </h3>

                {!hasResult && (
                  <div className="mt-3 rounded-lg border border-dashed border-gray-300 bg-white p-3 text-xs text-gray-500">
                    Run the calculator to see estimated processing and storage
                    times.
                  </div>
                )}

                {hasResult && (
                  <div className="mt-3 space-y-3 text-sm">
                    <div className="rounded-lg bg-white p-3 shadow-sm">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-gray-500">
                          Processing time (planning estimate)
                        </span>
                        <span className="text-sm font-semibold text-gray-900">
                          {output.recommendedProcessingTimeMinutes} min
                        </span>
                      </div>
                      <p className="mt-1 text-[11px] text-gray-500">
                        Always base real processing time on a tested recipe for
                        this exact food, jar size, and altitude.
                      </p>
                    </div>

                    <div className="rounded-lg bg-white p-3 shadow-sm">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-gray-500">
                          Storage window (planning)
                        </span>
                        <span className="text-sm font-semibold text-gray-900">
                          {output.recommendedStorageTimeLabel}
                        </span>
                      </div>
                      <p className="mt-1 text-[11px] text-gray-500">
                        Approx. {output.recommendedStorageTimeDays} days, risk
                        band:{" "}
                        <span className="font-semibold">{output.riskBand}</span>
                        .
                      </p>
                    </div>

                    {Array.isArray(output.warnings) &&
                      output.warnings.length > 0 && (
                        <div className="rounded-lg bg-white p-3 shadow-inner">
                          <p className="text-xs font-semibold text-amber-700">
                            Safety & planning notes
                          </p>
                          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] text-amber-800">
                            {output.warnings.slice(0, 5).map((w, idx) => (
                              <li key={idx}>{w}</li>
                            ))}
                            {output.warnings.length > 5 && (
                              <li>
                                + {output.warnings.length - 5} more internal
                                notes…
                              </li>
                            )}
                          </ul>
                        </div>
                      )}

                    {output.sessionTemplateOverride && (
                      <div className="rounded-lg bg-white p-3 shadow-sm">
                        <p className="text-xs font-semibold text-gray-700">
                          Session preview (for SessionRunner)
                        </p>
                        <p className="mt-1 text-[11px] text-gray-500">
                          {output.sessionTemplateOverride.title ||
                            "Run a preservation session with prep, processing, and cool/store steps."}
                        </p>
                        <ol className="mt-2 space-y-1 text-[11px] text-gray-600">
                          {output.sessionTemplateOverride.steps
                            .slice(0, 3)
                            .map((step, idx) => (
                              <li
                                key={step.id || idx}
                                className="flex justify-between gap-2"
                              >
                                <span className="font-medium">
                                  {idx + 1}. {step.title}
                                </span>
                                <span className="text-gray-400">
                                  {Math.round((step.durationSec || 0) / 60)} min
                                </span>
                              </li>
                            ))}
                        </ol>
                      </div>
                    )}
                  </div>
                )}

                {/* Footer actions */}
                <div className="mt-4 flex flex-col gap-2 border-t border-gray-200 pt-3 md:flex-row md:items-center md:justify-between">
                  <div className="text-[11px] text-gray-400">
                    This is a planning tool only. Always follow tested guidance
                    for safe preservation.
                  </div>

                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={handleRunCalculator}
                      disabled={isRunning}
                      className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-emerald-300"
                    >
                      {isRunning ? "Calculating…" : "Calculate times"}
                    </button>

                    <button
                      type="button"
                      onClick={handleStartSession}
                      disabled={
                        !hasResult || !result?.output?.sessionTemplateOverride
                      }
                      className="rounded-lg border border-emerald-600 px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:border-gray-300 disabled:text-gray-400"
                    >
                      Start preservation session
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Optional subtle bottom bar mimicking SessionRunner's persistent feel */}
            <div className="flex items-center justify-between border-t bg-gray-50 px-5 py-2 text-[11px] text-gray-500">
              <span>
                This planner will hand off a session to the global SessionRunner
                so it can keep running while you navigate.
              </span>
              <span className="hidden md:inline">
                Tip: You can keep this modal open while you prepare your
                workspace.
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default PreservationTimeCalculatorView;
