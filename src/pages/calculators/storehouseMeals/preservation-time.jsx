// C:\Users\larho\suka-smart-assistant\src\pages\calculators\storehouseMeals\preservation-time.jsx

/**
 * Preservation Time Calculator Route
 *
 * How this fits:
 * - Wraps PreservationTimeCalculatorView with:
 *   • calculatorRunner wiring for consistent calculator execution,
 *   • eventBus emissions so the automation/runtime can react,
 *   • a summary card that highlights safe windows and risk levels,
 *   • a CTA to turn the result into a preservation session
 *     (e.g., schedule canning/dehydrating as a runnable SessionRunner flow).
 *
 * This page is part of the Storehouse / Preservation lane of the Planning Graph.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import eventBus from "@/services/events/eventBus";
import { familyFundMode } from "@/config/featureFlags";
import { runCalculator } from "@/services/calculators/calculatorRunner";
import PreservationTimeCalculatorView from "@/features/calculators/storehouseMeals/PreservationTimeCalculator/PreservationTimeCalculator.view.jsx";

const CALCULATOR_ID = "storehouseMeals.preservationTime";

/**
 * @typedef {Object} PreservationMethodWindow
 * @property {string} id
 * @property {"canning"|"fermenting"|"freezing"|"dehydrating"|"curing"|"pickling"|"other"} method
 * @property {string} name                 // "Pressure canning (low-acid veg)"
 * @property {number} minHours
 * @property {number} maxHours
 * @property {"low"|"medium"|"high"} riskLevel
 * @property {string} [notes]
 */

/**
 * @typedef {Object} PreservationTimeResult
 * @property {string} [productLabel]       // "Tomato sauce", "Chicken stock", etc.
 * @property {string} [category]           // "low-acid", "high-acid", "meat", etc.
 * @property {PreservationMethodWindow[]} [windows]
 * @property {string[]} [warnings]
 * @property {string[]} [notes]
 * @property {Object<string, any>} [meta]
 */

/**
 * Emit calculator completion for analytics & automation.
 *
 * @param {PreservationTimeResult} result
 */
function emitPreservationTimeCompleted(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.preservationTime.completed",
      ts: new Date().toISOString(),
      source: "pages.calculators.storehouseMeals.preservation-time",
      data: {
        calculatorId: CALCULATOR_ID,
        result,
        familyFundMode: !!familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[preservation-time.jsx] Failed to emit calculator.preservationTime.completed",
      err
    );
  }
}

/**
 * Ask the automation/runtime to create a preservation session from this result.
 *
 * @param {PreservationTimeResult} result
 */
function requestPreservationSession(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;

    eventBus.emit({
      type: "calculator.preservationTime.session.requested",
      ts: new Date().toISOString(),
      source: "pages.calculators.storehouseMeals.preservation-time",
      data: {
        calculatorId: CALCULATOR_ID,
        domain: "preservation",
        result,
        familyFundMode: !!familyFundMode,
        // Hint to the automation engine that this should become a runnable session.
        sessionHint: {
          title:
            result?.productLabel ||
            "Preservation Session (from Preservation Time Calculator)",
        },
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[preservation-time.jsx] Failed to emit calculator.preservationTime.session.requested",
      err
    );
  }
}

/**
 * Summary card: shows best window & risk for quick decisions.
 *
 * @param {{ result: PreservationTimeResult | null, onStartSession: (r: PreservationTimeResult) => void }} props
 */
function PreservationTimeSummaryCard({ result, onStartSession }) {
  if (!result) return null;

  const windows = Array.isArray(result.windows) ? result.windows : [];

  const sortedWindows = useMemo(() => {
    if (!windows.length) return [];
    const riskScore = { low: 1, medium: 2, high: 3 };
    return [...windows].sort((a, b) => {
      const ra = riskScore[a.riskLevel] || 99;
      const rb = riskScore[b.riskLevel] || 99;
      if (ra !== rb) return ra - rb;
      const aMid = (a.minHours + a.maxHours) / 2;
      const bMid = (b.minHours + b.maxHours) / 2;
      return aMid - bMid;
    });
  }, [windows]);

  const bestWindow = sortedWindows[0] || null;

  const productLabel =
    result.productLabel || result.category || "This food/product";

  return (
    <section className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-4 space-y-3">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">
            Preservation Time Summary
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            See safe time windows by method so you can choose when and how to
            preserve {productLabel.toLowerCase()} without guessing or risking
            quality.
          </p>
        </div>
        {bestWindow && (
          <span className="text-[10px] px-2 py-1 rounded-full bg-slate-900 border border-slate-700 text-slate-200 whitespace-nowrap">
            Best option: {bestWindow.name}
          </span>
        )}
      </header>

      {bestWindow ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
          <div className="flex flex-col">
            <span className="text-slate-400 mb-0.5">Recommended Method</span>
            <span className="text-slate-50 font-semibold">
              {bestWindow.name}
            </span>
          </div>
          <div className="flex flex-col">
            <span className="text-slate-400 mb-0.5">Time Window</span>
            <span className="text-slate-50 font-semibold">
              {bestWindow.minHours.toFixed(1)}–{bestWindow.maxHours.toFixed(1)}{" "}
              hrs
            </span>
          </div>
          <div className="flex flex-col">
            <span className="text-slate-400 mb-0.5">Risk Level</span>
            <span className="text-slate-50 font-semibold capitalize">
              {bestWindow.riskLevel}
            </span>
          </div>
          <div className="flex flex-col">
            <span className="text-slate-400 mb-0.5">Category</span>
            <span className="text-slate-50 font-semibold capitalize">
              {result.category || "Not specified"}
            </span>
          </div>
        </div>
      ) : (
        <p className="text-xs text-slate-400">
          No preservation windows were returned. Try adjusting your inputs, or
          double-check that you’ve selected a supported preservation method and
          product type.
        </p>
      )}

      {sortedWindows.length > 1 && (
        <div className="mt-2 rounded-xl border border-slate-800 bg-slate-950/80 px-3 py-2 text-[11px]">
          <p className="font-medium text-slate-200 mb-1">
            Other available methods
          </p>
          <ul className="space-y-0.5">
            {sortedWindows.slice(1, 6).map((w) => (
              <li
                key={w.id}
                className="flex items-center justify-between gap-3"
              >
                <span className="truncate">
                  {w.name}{" "}
                  <span className="text-slate-500">
                    ({w.minHours.toFixed(1)}–{w.maxHours.toFixed(1)} hrs)
                  </span>
                </span>
                <span className="text-slate-300 capitalize text-[10px] px-2 py-0.5 rounded-full border border-slate-700">
                  {w.riskLevel} risk
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {Array.isArray(result.warnings) && result.warnings.length > 0 && (
        <div className="mt-1 rounded-xl border border-amber-500/60 bg-amber-950/40 px-3 py-2 text-[11px] text-amber-50">
          <p className="font-medium mb-0.5">Safety cautions</p>
          <ul className="list-disc list-inside space-y-0.5">
            {result.warnings.map((w, idx) => (
              <li key={idx}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {Array.isArray(result.notes) && result.notes.length > 0 && (
        <p className="text-[11px] text-slate-400 leading-snug">
          Notes:&nbsp;
          <span className="text-slate-200">{result.notes.join(" • ")}</span>
        </p>
      )}

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-1">
        <p className="text-[11px] text-slate-500 leading-snug max-w-md">
          Tip: Once you’re happy with the method and timing, let SSA turn this
          into a real preservation session with timers, safety checks, and
          checklists you can run in the SessionRunner.
        </p>
        <button
          type="button"
          onClick={() => result && onStartSession && onStartSession(result)}
          className="inline-flex items-center justify-center rounded-xl px-4 py-2.5 text-xs font-semibold bg-emerald-400 hover:bg-emerald-300 text-slate-950 shadow-md shadow-emerald-500/30 transition"
        >
          Start Preservation Session Now
        </button>
      </div>
    </section>
  );
}

/**
 * Route component: Preservation Time Calculator + summary/actions.
 */
export default function PreservationTimeCalculatorPage() {
  /** @type {[PreservationTimeResult|null, React.Dispatch<React.SetStateAction<PreservationTimeResult|null>>]} */
  const [result, setResult] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    document.title = "Preservation Time Calculator | Suka Smart Assistant";
  }, []);

  /**
   * Handler passed down to PreservationTimeCalculatorView.
   *
   * @param {Object} input - Calculator input (product type, pH clues, altitude, method hints, etc.)
   */
  const handleCalculate = useCallback(async (input) => {
    setIsRunning(true);
    setError(null);

    try {
      const { result: calcResult } = await runCalculator(CALCULATOR_ID, input, {
        source: "pages.calculators.storehouseMeals.preservation-time",
        emitEvents: true,
      });

      if (!calcResult || typeof calcResult !== "object") {
        throw new Error(
          "Preservation Time calculator did not return a result object."
        );
      }

      /** @type {PreservationTimeResult} */
      const normalized = {
        productLabel:
          typeof calcResult.productLabel === "string"
            ? calcResult.productLabel
            : undefined,
        category:
          typeof calcResult.category === "string"
            ? calcResult.category
            : undefined,
        windows: Array.isArray(calcResult.windows) ? calcResult.windows : [],
        warnings: Array.isArray(calcResult.warnings) ? calcResult.warnings : [],
        notes: Array.isArray(calcResult.notes) ? calcResult.notes : [],
        meta: calcResult.meta || {},
      };

      setResult(normalized);
      emitPreservationTimeCompleted(normalized);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        "[preservation-time.jsx] Preservation Time calculator error",
        err
      );
      setError(
        err && err.message
          ? err.message
          : "There was a problem running the Preservation Time calculator."
      );
    } finally {
      setIsRunning(false);
    }
  }, []);

  const handleStartSession = useCallback((presResult) => {
    if (!presResult) return;
    requestPreservationSession(presResult);
  }, []);

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-slate-950/90 text-slate-50">
      <div className="mx-auto max-w-5xl px-4 py-6 lg:py-8">
        {/* Header */}
        <header className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-50">
              Preservation Time Calculator
            </h1>
            <p className="mt-1 text-sm text-slate-400 max-w-2xl">
              Enter what you&apos;re preserving, your method, and basic safety
              details. SSA estimates safe time windows so you can plan canning,
              freezing, fermenting, and other preservation tasks confidently.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-900/80 px-3 py-1 border border-slate-700">
              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
              Feeds Preservation Sessions
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-900/80 px-3 py-1 border border-slate-700">
              <span className="h-2 w-2 rounded-full bg-indigo-400" />
              Planning Graph Node
            </span>
          </div>
        </header>

        {/* Main card */}
        <main className="bg-slate-900/70 border border-slate-700 rounded-2xl shadow-xl p-4 lg:p-6">
          <PreservationTimeCalculatorView
            calculatorId={CALCULATOR_ID}
            onCalculate={handleCalculate}
            isRunning={isRunning}
            lastResult={result}
          />

          {error && (
            <div className="mt-4 rounded-xl border border-red-500/60 bg-red-950/60 px-3 py-2 text-xs text-red-100">
              {error}
            </div>
          )}

          <PreservationTimeSummaryCard
            result={result}
            onStartSession={handleStartSession}
          />
        </main>
      </div>
    </div>
  );
}
