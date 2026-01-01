// C:\Users\larho\suka-smart-assistant\src\features\calculators\calendar\BiblicalOfferingCalculator\BiblicalOfferingCalculator.view.jsx

/**
 * BiblicalOfferingCalculator.view.jsx
 *
 * How this fits:
 * - UI wrapper for BiblicalOfferingCalculator shim logic.
 * - Lets the user choose an offering type, optional scriptures, and context,
 *   then calls the shim to get structured output (animals, grain/drink, prompts).
 * - Provides a “Start Study Session Now” CTA that emits a session object to
 *   the SSA event bus so the global SessionRunner can pick it up and run
 *   independently of this view.
 *
 * Notes:
 * - Pure React; no direct Dexie or SessionRunner imports here.
 * - Uses eventBus to emit a `session.created` event with a storehouse-domain
 *   Session object built from the calculator output.
 */

import React, { useState } from "react";
import { runBiblicalOfferingCalculatorShim } from "./BiblicalOfferingCalculator.shim";
import { emit as emitEvent } from "@/services/eventBus";

/**
 * @typedef {import("./BiblicalOfferingCalculator.shim").BiblicalOfferingCalculatorInput} BiblicalOfferingCalculatorInput
 * @typedef {import("./BiblicalOfferingCalculator.shim").BiblicalOfferingCalculatorOutput} BiblicalOfferingCalculatorOutput
 */

/**
 * @param {{
 *  isOpen?: boolean;
 *  onClose?: () => void;
 *  initialInput?: Partial<BiblicalOfferingCalculatorInput>;
 * }} props
 */
export default function BiblicalOfferingCalculatorView(props) {
  const { isOpen = true, onClose, initialInput } = props || {};

  /** @type {[BiblicalOfferingCalculatorInput, Function]} */
  const [input, setInput] = useState(() => ({
    offeringType: initialInput?.offeringType || "burnt",
    scriptureRefs: initialInput?.scriptureRefs || [],
    includeAnimals:
      typeof initialInput?.includeAnimals === "boolean"
        ? initialInput.includeAnimals
        : true,
    includeGrainDrink:
      typeof initialInput?.includeGrainDrink === "boolean"
        ? initialInput.includeGrainDrink
        : true,
    householdContext: initialInput?.householdContext || "study-only"
  }));

  /** @type {[BiblicalOfferingCalculatorOutput|null, Function]} */
  const [result, setResult] = useState(null);
  const [scriptureText, setScriptureText] = useState(
    (initialInput?.scriptureRefs || []).join(", ")
  );
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState("");

  if (!isOpen) {
    return null;
  }

  const handleChangeOfferingType = (e) => {
    const value = e.target.value;
    setInput((prev) => ({ ...prev, offeringType: value }));
  };

  const handleToggleIncludeAnimals = (e) => {
    setInput((prev) => ({ ...prev, includeAnimals: e.target.checked }));
  };

  const handleToggleIncludeGrainDrink = (e) => {
    setInput((prev) => ({ ...prev, includeGrainDrink: e.target.checked }));
  };

  const handleHouseholdContextChange = (e) => {
    const value = e.target.value;
    setInput((prev) => ({ ...prev, householdContext: value }));
  };

  const handleScriptureBlur = () => {
    const refs = scriptureText
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    setInput((prev) => ({ ...prev, scriptureRefs: refs }));
  };

  const handleCalculate = async () => {
    setIsBusy(true);
    setError("");
    try {
      const shimRequest = {
        calculatorId: "biblical-offering-calculator",
        nodeKey: "biblical-offering-calculator",
        input
      };

      const response = await runBiblicalOfferingCalculatorShim(shimRequest);

      if (!response.ok || !response.output) {
        setError(response.error || "Calculation failed for unknown reasons.");
        setResult(null);
        setIsBusy(false);
        return;
      }

      setResult(response.output);
    } catch (err) {
      /* eslint-disable no-console */
      console.error("[BiblicalOfferingCalculatorView] Calculation error:", err);
      /* eslint-enable no-console */
      setError("An error occurred while calculating. Please try again.");
      setResult(null);
    } finally {
      setIsBusy(false);
    }
  };

  const handleCreateStudySessionNow = () => {
    if (!result) return;

    const nowIso = new Date().toISOString();
    const sessionId = createEphemeralId("offering");

    const steps = buildStudySessionStepsFromResult(result);

    const session = {
      id: sessionId,
      domain: "storehouse", // knowledge / scripture storehouse domain
      title: result.canonicalSummary?.label || "Offering Study Session",
      source: {
        type: "manual",
        refId: null
      },
      steps,
      prefs: {
        voiceGuidance: true,
        haptic: false,
        autoAdvance: false
      },
      status: "pending",
      progress: {
        currentStepIndex: 0,
        elapsedSec: 0,
        startedAt: null,
        pausedAt: null
      },
      analytics: {
        skippedSteps: [],
        adjustments: []
      },
      createdAt: nowIso,
      updatedAt: nowIso
    };

    try {
      emitEvent({
        type: "session.created",
        ts: nowIso,
        source: "calculators/calendar/BiblicalOfferingCalculator",
        data: { session }
      });
    } catch (err) {
      /* eslint-disable no-console */
      console.warn("[BiblicalOfferingCalculatorView] Failed to emit session.created:", err);
      /* eslint-enable no-console */
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40">
      <div className="relative flex h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl bg-slate-900 text-slate-50 shadow-2xl">
        {/* Header */}
        <header className="flex items-center justify-between border-b border-slate-800 px-4 py-3 sm:px-6">
          <div>
            <h2 className="text-lg font-semibold sm:text-xl">
              Biblical Offering Explorer
            </h2>
            <p className="text-xs text-slate-300 sm:text-sm">
              Choose an offering type, review associated animals and grain/drink patterns,
              and turn it into a guided household study session.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleCreateStudySessionNow}
              disabled={!result}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold uppercase tracking-wide sm:px-4 sm:py-2 sm:text-sm ${
                result
                  ? "bg-emerald-500 text-emerald-950 hover:bg-emerald-400"
                  : "cursor-not-allowed bg-slate-700 text-slate-400"
              }`}
            >
              Start Study Session Now
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-full bg-slate-800 px-2 py-1 text-xs font-medium text-slate-200 hover:bg-slate-700 sm:px-3 sm:text-sm"
            >
              Close
            </button>
          </div>
        </header>

        {/* Body layout */}
        <div className="flex flex-1 flex-col divide-y divide-slate-800 sm:flex-row sm:divide-x sm:divide-y-0">
          {/* Left: Form */}
          <section className="w-full max-w-md shrink-0 overflow-y-auto px-4 py-3 sm:px-5 sm:py-4">
            <h3 className="mb-2 text-sm font-semibold text-slate-200">
              Offering Selection
            </h3>

            {/* Offering type */}
            <label className="mb-3 block text-xs font-medium uppercase tracking-wide text-slate-300">
              Offering Type
              <select
                value={input.offeringType}
                onChange={handleChangeOfferingType}
                className="mt-1 w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-50 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              >
                <option value="burnt">Burnt (Olah)</option>
                <option value="peace">Peace / Fellowship</option>
                <option value="sin">Sin</option>
                <option value="guilt">Guilt / Trespass</option>
                <option value="grain">Grain / Meal</option>
                <option value="drink">Drink</option>
                <option value="votive">Votive / Vow</option>
                <option value="freewill">Freewill</option>
                <option value="purification">Purification / Cleansing</option>
                <option value="ordination">Ordination / Consecration</option>
              </select>
            </label>

            {/* Scripture refs */}
            <label className="mb-3 block text-xs font-medium uppercase tracking-wide text-slate-300">
              Scripture References
              <textarea
                value={scriptureText}
                onChange={(e) => setScriptureText(e.target.value)}
                onBlur={handleScriptureBlur}
                placeholder="Leviticus 1; Leviticus 6:8–13"
                rows={3}
                className="mt-1 w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-50 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
              <span className="mt-1 block text-[0.7rem] text-slate-400">
                Separate references with commas or semicolons. When left empty, the calculator
                will use standard passages for the selected offering.
              </span>
            </label>

            {/* Toggles */}
            <div className="mb-3 flex flex-col gap-2">
              <label className="flex items-center justify-between rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-200">
                <span>Include animal patterns</span>
                <input
                  type="checkbox"
                  checked={input.includeAnimals}
                  onChange={handleToggleIncludeAnimals}
                  className="h-4 w-4 rounded border-slate-600 bg-slate-800 text-emerald-500 focus:ring-emerald-500"
                />
              </label>
              <label className="flex items-center justify-between rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-200">
                <span>Include grain / drink patterns</span>
                <input
                  type="checkbox"
                  checked={input.includeGrainDrink}
                  onChange={handleToggleIncludeGrainDrink}
                  className="h-4 w-4 rounded border-slate-600 bg-slate-800 text-emerald-500 focus:ring-emerald-500"
                />
              </label>
            </div>

            {/* Context */}
            <label className="mb-4 block text-xs font-medium uppercase tracking-wide text-slate-300">
              Household Context
              <select
                value={input.householdContext}
                onChange={handleHouseholdContextChange}
                className="mt-1 w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-50 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              >
                <option value="study-only">Study only (notes / journaling)</option>
                <option value="storytelling">Storytelling with family</option>
                <option value="curriculum">Curriculum / lesson planning</option>
                <option value="household-ritual">Household remembrance pattern</option>
              </select>
            </label>

            {/* Actions */}
            {error && (
              <div className="mb-2 rounded-md border border-red-500/60 bg-red-500/10 px-3 py-2 text-xs text-red-200">
                {error}
              </div>
            )}

            <button
              type="button"
              onClick={handleCalculate}
              disabled={isBusy}
              className={`w-full rounded-md px-3 py-2 text-sm font-semibold ${
                isBusy
                  ? "cursor-wait bg-slate-700 text-slate-300"
                  : "bg-emerald-500 text-emerald-950 hover:bg-emerald-400"
              }`}
            >
              {isBusy ? "Calculating…" : "Calculate Offering Pattern"}
            </button>

            <p className="mt-2 text-[0.7rem] text-slate-400">
              When an output is available, use{" "}
              <span className="font-semibold text-emerald-300">
                Start Study Session Now
              </span>{" "}
              at the top to hand this over to the global SessionRunner.
            </p>
          </section>

          {/* Right: Results */}
          <section className="flex-1 overflow-y-auto bg-slate-950/60 px-4 py-3 sm:px-5 sm:py-4">
            {!result && (
              <div className="flex h-full flex-col items-center justify-center text-center text-slate-400">
                <div className="mb-3 h-12 w-12 rounded-full border border-dashed border-slate-700" />
                <p className="text-sm font-medium text-slate-200">
                  No offering pattern yet.
                </p>
                <p className="mt-1 max-w-md text-xs text-slate-400">
                  Choose an offering type and calculate. You’ll see canonical summaries,
                  animal patterns, grain/drink elements, and study prompts here.
                </p>
              </div>
            )}

            {result && (
              <div className="space-y-4">
                {/* Canonical Summary */}
                <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-3 sm:p-4">
                  <h3 className="text-sm font-semibold text-emerald-300">
                    Canonical Summary
                  </h3>
                  <p className="mt-1 text-sm font-medium text-slate-50">
                    {result.canonicalSummary?.label || "Offering"}
                  </p>
                  {result.canonicalSummary?.briefExplanation && (
                    <p className="mt-1 text-xs text-slate-200">
                      {result.canonicalSummary.briefExplanation}
                    </p>
                  )}
                  {Array.isArray(result.canonicalSummary?.coreScriptures) &&
                    result.canonicalSummary.coreScriptures.length > 0 && (
                      <div className="mt-2">
                        <div className="text-[0.7rem] font-semibold uppercase tracking-wide text-slate-400">
                          Anchor passages
                        </div>
                        <ul className="mt-1 flex flex-wrap gap-1">
                          {result.canonicalSummary.coreScriptures.map((ref) => (
                            <li
                              key={ref}
                              className="rounded-full bg-slate-800 px-2 py-0.5 text-[0.7rem] text-slate-100"
                            >
                              {ref}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                </div>

                {/* Animal Patterns */}
                {Array.isArray(result.animalPatterns) &&
                  result.animalPatterns.length > 0 && (
                    <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-3 sm:p-4">
                      <div className="flex items-center justify-between">
                        <h3 className="text-sm font-semibold text-sky-300">
                          Animal Patterns
                        </h3>
                        <span className="text-[0.7rem] text-slate-400">
                          Ideal for curriculum, animal husbandry study, or meat planning.
                        </span>
                      </div>
                      <div className="mt-2 overflow-x-auto">
                        <table className="min-w-full border-collapse text-xs">
                          <thead>
                            <tr className="border-b border-slate-800 text-[0.7rem] uppercase tracking-wide text-slate-400">
                              <th className="py-1 pr-2 text-left">Species</th>
                              <th className="py-1 px-2 text-left">Age pattern</th>
                              <th className="py-1 px-2 text-left">Sex pattern</th>
                              <th className="py-1 pl-2 text-left">Defect rule</th>
                            </tr>
                          </thead>
                          <tbody>
                            {result.animalPatterns.map((a, idx) => (
                              <tr
                                key={`${a.species}-${idx}`}
                                className="border-b border-slate-900/60 align-top"
                              >
                                <td className="py-1 pr-2 text-slate-100">
                                  {capitalize(a.species)}
                                </td>
                                <td className="py-1 px-2 text-slate-200">
                                  {a.agePattern}
                                </td>
                                <td className="py-1 px-2 text-slate-200">
                                  {formatSexPattern(a.sexPattern)}
                                </td>
                                <td className="py-1 pl-2 text-slate-200">
                                  {a.defectRule}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                {/* Grain / Drink Patterns */}
                {Array.isArray(result.grainDrinkPatterns) &&
                  result.grainDrinkPatterns.length > 0 && (
                    <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-3 sm:p-4">
                      <div className="flex items-center justify-between">
                        <h3 className="text-sm font-semibold text-amber-300">
                          Grain &amp; Drink Elements
                        </h3>
                        <span className="text-[0.7rem] text-slate-400">
                          Connect to breadmaking, wine study, and daily provision.
                        </span>
                      </div>
                      <ul className="mt-2 space-y-1 text-xs text-slate-200">
                        {result.grainDrinkPatterns.map((g, idx) => (
                          <li
                            key={`${g.elementType}-${idx}`}
                            className="flex gap-2 rounded-md bg-slate-950/40 px-2 py-1"
                          >
                            <span className="mt-[1px] inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-800 text-[0.65rem] font-semibold uppercase text-slate-50">
                              {g.elementType.slice(0, 2)}
                            </span>
                            <div className="flex-1">
                              <div className="text-[0.7rem] font-semibold uppercase tracking-wide text-slate-300">
                                {capitalize(g.elementType)}
                              </div>
                              <div className="text-xs text-slate-200">
                                {g.details}
                              </div>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                {/* Study prompts */}
                {Array.isArray(result.studyPrompts) &&
                  result.studyPrompts.length > 0 && (
                    <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-3 sm:p-4">
                      <div className="flex items-center justify-between">
                        <h3 className="text-sm font-semibold text-violet-300">
                          Study Prompts
                        </h3>
                        <span className="text-[0.7rem] text-slate-400">
                          Use for journaling, family discussions, or class assignments.
                        </span>
                      </div>
                      <ol className="mt-2 space-y-1 text-xs text-slate-200">
                        {result.studyPrompts.map((p, idx) => (
                          <li
                            key={`${p.focus}-${idx}`}
                            className="flex gap-2 rounded-md bg-slate-950/40 px-2 py-1"
                          >
                            <span className="mt-0.5 text-[0.7rem] font-semibold text-slate-400">
                              {idx + 1}.
                            </span>
                            <div className="flex-1">
                              <p className="text-xs text-slate-100">{p.question}</p>
                              <p className="mt-0.5 text-[0.65rem] uppercase tracking-wide text-slate-500">
                                Focus: {capitalize(p.focus)}
                              </p>
                            </div>
                          </li>
                        ))}
                      </ol>
                      <div className="mt-3 flex items-center justify-between">
                        <button
                          type="button"
                          onClick={handleCreateStudySessionNow}
                          className="rounded-full bg-emerald-500 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-emerald-950 hover:bg-emerald-400"
                        >
                          Start Study Session Now
                        </button>
                        <p className="text-[0.65rem] text-slate-400">
                          This sends a study session to the global SessionRunner so you
                          can move around the app while studying.
                        </p>
                      </div>
                    </div>
                  )}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Very light ID helper – enough for ephemeral sessions.
 * @param {string} prefix
 * @returns {string}
 */
function createEphemeralId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

/**
 * @param {string} value
 * @returns {string}
 */
function capitalize(value) {
  if (!value || typeof value !== "string") return "";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * @param {"male-only"|"female-only"|"either"|"not-specified"} sexPattern
 * @returns {string}
 */
function formatSexPattern(sexPattern) {
  switch (sexPattern) {
    case "male-only":
      return "Male only";
    case "female-only":
      return "Female only";
    case "either":
      return "Either male or female";
    case "not-specified":
    default:
      return "Not specified";
  }
}
