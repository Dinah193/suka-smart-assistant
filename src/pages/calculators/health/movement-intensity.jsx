// C:\Users\larho\suka-smart-assistant\src\pages\calculators\health\movement-intensity.jsx

/**
 * Movement Intensity Calculator Route
 *
 * How this fits:
 * - Hosts the MovementIntensityCalculator UI so SSA can understand how
 *   “hard” and how often the household is moving:
 *   • walking vs. vigorous exercise,
 *   • chores & homestead work vs. workouts,
 *   • weekly time at each intensity.
 * - Uses the shared calculatorRunner to keep all calculator executions
 *   consistent and event-driven.
 * - Emits events via eventBus so automation can:
 *   • nudge movement-aware session suggestions (cleaning bursts, garden tasks,
 *     brisk walks, etc.),
 *   • connect results into the Planning Graph for stability/health.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import eventBus from "@/services/events/eventBus";
import { familyFundMode } from "@/config/featureFlags";
import { runCalculator } from "@/services/calculators/calculatorRunner";
import MovementIntensityCalculatorView from "@/features/calculators/health/MovementIntensityCalculator/MovementIntensityCalculator.view.jsx";

const CALCULATOR_ID = "movement-intensity";

/**
 * @typedef {Object} MovementIntensityResult
 * @property {number} targetMinutesPerWeek  - total weekly movement target
 * @property {number} [lightMinutes]        - suggested light minutes / week
 * @property {number} [moderateMinutes]     - suggested moderate minutes / week
 * @property {number} [vigorousMinutes]     - suggested vigorous minutes / week
 * @property {string} status                - "low" | "ok" | "high" | "unknown"
 * @property {string[]} [notes]             - any planner hints
 * @property {Object<string, any>} [meta]
 */

/**
 * Emit that movement intensity has been calculated.
 *
 * @param {MovementIntensityResult} result
 */
function emitMovementCalculated(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.movementIntensity.completed",
      ts: new Date().toISOString(),
      source: "pages.calculators.health.movement-intensity",
      data: {
        calculatorId: CALCULATOR_ID,
        result,
        familyFundMode: !!familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[movement-intensity.jsx] Failed to emit calculator.movementIntensity.completed",
      err
    );
  }
}

/**
 * Emit a light-touch session request so automation/SessionRunner can convert
 * movement insights into runnable sessions (e.g., “15 minute brisk walk while
 * stock is simmering” or “10 minutes of stretching after batch cooking”).
 *
 * @param {MovementIntensityResult} result
 */
function requestMovementSession(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.movementIntensity.session.requested",
      ts: new Date().toISOString(),
      source: "pages.calculators.health.movement-intensity",
      data: {
        calculatorId: CALCULATOR_ID,
        domain: "storehouse", // health/stability flows will fan out from here
        result,
        familyFundMode: !!familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[movement-intensity.jsx] Failed to emit calculator.movementIntensity.session.requested",
      err
    );
  }
}

/**
 * Small card summarizing movement result & inviting the user to convert that
 * into sessions.
 */
function MovementSummaryCard({ result, onUseInSession }) {
  if (!result) return null;

  const statusLabel = useMemo(() => {
    switch (result.status) {
      case "low":
        return "Low (Needs More Movement)";
      case "ok":
        return "OK (On Track)";
      case "high":
        return "High (Monitor Recovery)";
      case "borderline":
        return "Borderline (Can Improve)";
      default:
        return "Unknown (Use as a gentle guide)";
    }
  }, [result.status]);

  return (
    <section className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-4 space-y-3">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">
            Weekly Movement Snapshot
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            SSA can blend this with chores, garden work, and cooking sessions so
            your body moves more while you care for your home.
          </p>
        </div>
        <span className="text-[10px] px-2 py-1 rounded-full bg-slate-900 border border-slate-700 text-slate-200 whitespace-nowrap">
          {statusLabel}
        </span>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Target / Week</span>
          <span className="text-slate-50 font-semibold">
            {Math.round(result.targetMinutesPerWeek || 0)} min
          </span>
        </div>
        {typeof result.moderateMinutes === "number" && (
          <div className="flex flex-col">
            <span className="text-slate-400 mb-0.5">Moderate</span>
            <span className="text-slate-50 font-semibold">
              {Math.round(result.moderateMinutes)} min
            </span>
          </div>
        )}
        {typeof result.vigorousMinutes === "number" && (
          <div className="flex flex-col">
            <span className="text-slate-400 mb-0.5">Vigorous</span>
            <span className="text-slate-50 font-semibold">
              {Math.round(result.vigorousMinutes)} min
            </span>
          </div>
        )}
        {typeof result.lightMinutes === "number" && (
          <div className="flex flex-col">
            <span className="text-slate-400 mb-0.5">Light</span>
            <span className="text-slate-50 font-semibold">
              {Math.round(result.lightMinutes)} min
            </span>
          </div>
        )}
      </div>

      {Array.isArray(result.notes) && result.notes.length > 0 && (
        <p className="text-[11px] text-slate-400 leading-snug">
          Notes:&nbsp;
          <span className="text-slate-200">{result.notes.join(" • ")}</span>
        </p>
      )}

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-1">
        <p className="text-[11px] text-slate-500 leading-snug max-w-md">
          Tip: Movement doesn’t have to be “gym time.” SSA can nudge short
          bursts—like a 10-minute sweep, a garden round, or stretching while
          food is in the oven.
        </p>
        <button
          type="button"
          onClick={() => onUseInSession && onUseInSession(result)}
          className="inline-flex items-center justify-center rounded-xl px-4 py-2.5 text-xs font-semibold bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-md shadow-emerald-500/30 transition"
        >
          Use This Movement Plan in a Session
        </button>
      </div>
    </section>
  );
}

/**
 * Route component: Movement Intensity Calculator + summary.
 */
export default function MovementIntensityCalculatorPage() {
  /** @type {[MovementIntensityResult|null, React.Dispatch<React.SetStateAction<MovementIntensityResult|null>>]} */
  const [result, setResult] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    document.title = "Movement Intensity Calculator | Suka Smart Assistant";
  }, []);

  /**
   * Handler passed to MovementIntensityCalculatorView.
   *
   * @param {Object} input - Calculator input from view.
   */
  const handleCalculate = useCallback(async (input) => {
    setIsRunning(true);
    setError(null);

    try {
      const { result: calcResult } = await runCalculator(CALCULATOR_ID, input, {
        source: "pages.calculators.health.movement-intensity",
        emitEvents: true,
      });

      if (!calcResult || typeof calcResult !== "object") {
        throw new Error(
          "Movement intensity calculator did not return a result object."
        );
      }

      /** @type {MovementIntensityResult} */
      const normalized = {
        targetMinutesPerWeek: Number(
          calcResult.targetMinutesPerWeek ??
            calcResult.recommendedMinutesPerWeek ??
            0
        ),
        lightMinutes:
          typeof calcResult.lightMinutes === "number"
            ? calcResult.lightMinutes
            : undefined,
        moderateMinutes:
          typeof calcResult.moderateMinutes === "number"
            ? calcResult.moderateMinutes
            : undefined,
        vigorousMinutes:
          typeof calcResult.vigorousMinutes === "number"
            ? calcResult.vigorousMinutes
            : undefined,
        status:
          typeof calcResult.status === "string" ? calcResult.status : "unknown",
        notes: Array.isArray(calcResult.notes) ? calcResult.notes : [],
        meta: calcResult.meta || {},
      };

      setResult(normalized);
      emitMovementCalculated(normalized);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        "[movement-intensity.jsx] Movement intensity calculator error",
        err
      );
      setError(
        err && err.message
          ? err.message
          : "There was a problem running the movement intensity calculator."
      );
    } finally {
      setIsRunning(false);
    }
  }, []);

  const handleUseInSession = useCallback((movementResult) => {
    if (!movementResult) return;
    requestMovementSession(movementResult);
  }, []);

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-slate-950/90 text-slate-50">
      <div className="mx-auto max-w-5xl px-4 py-6 lg:py-8">
        {/* Header */}
        <header className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-50">
              Movement Intensity Calculator
            </h1>
            <p className="mt-1 text-sm text-slate-400 max-w-2xl">
              Map out how much—and how hard—you&apos;re moving each week. SSA
              will blend this with cooking, cleaning, garden, and animal
              sessions so movement becomes part of your household rhythm, not
              another chore on your list.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-900/80 px-3 py-1 border border-slate-700">
              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
              Linked to SessionRunner
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-900/80 px-3 py-1 border border-slate-700">
              <span className="h-2 w-2 rounded-full bg-indigo-400" />
              Supports Stability & Health Planning
            </span>
          </div>
        </header>

        {/* Main card */}
        <main className="bg-slate-900/70 border border-slate-700 rounded-2xl shadow-xl p-4 lg:p-6">
          <MovementIntensityCalculatorView
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

          <MovementSummaryCard
            result={result}
            onUseInSession={handleUseInSession}
          />
        </main>
      </div>
    </div>
  );
}
