// C:\Users\larho\suka-smart-assistant\src\pages\calculators\storehouseMeals\batch-yield.jsx

/**
 * Batch Yield Calculator Route
 *
 * How this fits:
 * - Hosts the BatchYieldCalculator UI so SSA can:
 *   • estimate servings / meals per batch,
 *   • map batches into storehouse days of coverage,
 *   • link yields to grocery + preservation planning.
 * - Uses the shared calculatorRunner so execution is consistent,
 *   event-driven, and easy to hook into Planning Graph + SessionRunner.
 * - Emits events so automation can:
 *   • suggest batch cooking sessions,
 *   • update or propose storehouse goals,
 *   • connect yields into stability recommendations.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import eventBus from "@/services/events/eventBus";
import { familyFundMode } from "@/config/featureFlags";
import { runCalculator } from "@/services/calculators/calculatorRunner";
import BatchYieldCalculatorView from "@/features/calculators/storehouseMeals/BatchYieldCalculator.view.jsx";

const CALCULATOR_ID = "storehouseMeals.batchYield";

/**
 * @typedef {Object} BatchYieldResult
 * @property {number} batchSize             - size of the batch (e.g. pots, pans, weight)
 * @property {number} servingsPerBatch      - total servings produced
 * @property {number} mealsPerBatch         - total meals produced (per household defaults)
 * @property {number} daysOfCoverage        - estimated days of storehouse/meal coverage
 * @property {number} [perServingCost]      - optional cost per serving
 * @property {number} [perMealCost]         - optional cost per meal
 * @property {string} densityCategory       - "snack" | "light-meal" | "full-meal" | "preservation"
 * @property {string[]} [notes]             - planner hints / comments
 * @property {Object<string, any>} [meta]
 */

/**
 * Emit that the batch yield has been calculated.
 *
 * @param {BatchYieldResult} result
 */
function emitBatchYieldCalculated(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.batchYield.completed",
      ts: new Date().toISOString(),
      source: "pages.calculators.storehouseMeals.batch-yield",
      data: {
        calculatorId: CALCULATOR_ID,
        result,
        familyFundMode: !!familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[batch-yield.jsx] Failed to emit calculator.batchYield.completed",
      err
    );
  }
}

/**
 * Emit a request for a batch cooking / preservation session so that
 * SessionRunner and the planner can convert yields into a real workflow.
 *
 * @param {BatchYieldResult} result
 */
function requestBatchSession(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.batchYield.session.requested",
      ts: new Date().toISOString(),
      source: "pages.calculators.storehouseMeals.batch-yield",
      data: {
        calculatorId: CALCULATOR_ID,
        domain: "cooking", // batch sessions mainly live in cooking/preservation
        result,
        familyFundMode: !!familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[batch-yield.jsx] Failed to emit calculator.batchYield.session.requested",
      err
    );
  }
}

/**
 * Summary card that turns the numeric result into something visual and
 * “actionable” for storehouse + session planning.
 */
function BatchYieldSummaryCard({ result, onUseInSession }) {
  if (!result) return null;

  const densityLabel = useMemo(() => {
    switch (result.densityCategory) {
      case "snack":
        return "Snack / Light Bite";
      case "light-meal":
        return "Light Meal";
      case "full-meal":
        return "Full Meal";
      case "preservation":
        return "Preservation Batch";
      default:
        return "General Batch";
    }
  }, [result.densityCategory]);

  const daysLabel = useMemo(() => {
    const days = Number(result.daysOfCoverage || 0);
    if (!days || Number.isNaN(days)) return "No coverage estimated";
    if (days < 1) return "< 1 day of coverage";
    if (days === 1) return "Covers ~1 day";
    if (days <= 7) return `Covers about ${days.toFixed(1)} days`;
    return `Covers ~${Math.round(days)} days`;
  }, [result.daysOfCoverage]);

  return (
    <section className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-4 space-y-3">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">
            Batch Yield Snapshot
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Use this to decide if one pot, two pans, or a full preservation run
            best fits your storehouse and meal rhythm.
          </p>
        </div>
        <span className="text-[10px] px-2 py-1 rounded-full bg-slate-900 border border-slate-700 text-slate-200 whitespace-nowrap">
          {densityLabel}
        </span>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Servings / Batch</span>
          <span className="text-slate-50 font-semibold">
            {Math.round(result.servingsPerBatch || 0)}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Meals / Batch</span>
          <span className="text-slate-50 font-semibold">
            {Math.round(result.mealsPerBatch || 0)}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Storehouse Coverage</span>
          <span className="text-slate-50 font-semibold">{daysLabel}</span>
        </div>
        {typeof result.perServingCost === "number" && (
          <div className="flex flex-col">
            <span className="text-slate-400 mb-0.5">Cost / Serving</span>
            <span className="text-slate-50 font-semibold">
              ${result.perServingCost.toFixed(2)}
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
          Tip: SSA can blend batches into your meal planner, storehouse goals,
          and preservation schedule so you&apos;re cooking once and eating many
          times.
        </p>
        <button
          type="button"
          onClick={() => onUseInSession && onUseInSession(result)}
          className="inline-flex items-center justify-center rounded-xl px-4 py-2.5 text-xs font-semibold bg-amber-400 hover:bg-amber-300 text-slate-950 shadow-md shadow-amber-500/30 transition"
        >
          Start a Batch Cooking Session
        </button>
      </div>
    </section>
  );
}

/**
 * Route component: Batch Yield Calculator + summary.
 */
export default function BatchYieldCalculatorPage() {
  /** @type {[BatchYieldResult|null, React.Dispatch<React.SetStateAction<BatchYieldResult|null>>]} */
  const [result, setResult] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    document.title = "Batch Yield Calculator | Suka Smart Assistant";
  }, []);

  /**
   * Handler passed to BatchYieldCalculatorView.
   *
   * @param {Object} input - Calculator input from view.
   */
  const handleCalculate = useCallback(async (input) => {
    setIsRunning(true);
    setError(null);

    try {
      const { result: calcResult } = await runCalculator(CALCULATOR_ID, input, {
        source: "pages.calculators.storehouseMeals.batch-yield",
        emitEvents: true,
      });

      if (!calcResult || typeof calcResult !== "object") {
        throw new Error(
          "Batch yield calculator did not return a result object."
        );
      }

      /** @type {BatchYieldResult} */
      const normalized = {
        batchSize: Number(calcResult.batchSize ?? 0),
        servingsPerBatch: Number(calcResult.servingsPerBatch ?? 0),
        mealsPerBatch: Number(
          calcResult.mealsPerBatch ?? calcResult.estimatedMeals ?? 0
        ),
        daysOfCoverage: Number(calcResult.daysOfCoverage ?? 0),
        perServingCost:
          typeof calcResult.perServingCost === "number"
            ? calcResult.perServingCost
            : undefined,
        perMealCost:
          typeof calcResult.perMealCost === "number"
            ? calcResult.perMealCost
            : undefined,
        densityCategory:
          typeof calcResult.densityCategory === "string"
            ? calcResult.densityCategory
            : "full-meal",
        notes: Array.isArray(calcResult.notes) ? calcResult.notes : [],
        meta: calcResult.meta || {},
      };

      setResult(normalized);
      emitBatchYieldCalculated(normalized);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[batch-yield.jsx] Batch yield calculator error", err);
      setError(
        err && err.message
          ? err.message
          : "There was a problem running the batch yield calculator."
      );
    } finally {
      setIsRunning(false);
    }
  }, []);

  const handleUseInSession = useCallback((batchResult) => {
    if (!batchResult) return;
    requestBatchSession(batchResult);
  }, []);

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-slate-950/90 text-slate-50">
      <div className="mx-auto max-w-5xl px-4 py-6 lg:py-8">
        {/* Header */}
        <header className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-50">
              Batch Yield Calculator
            </h1>
            <p className="mt-1 text-sm text-slate-400 max-w-2xl">
              Estimate how many servings, meals, and days of coverage each batch
              provides. SSA will use this to shape storehouse goals, shopping
              lists, and batch cooking sessions that fit your household rhythm.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-900/80 px-3 py-1 border border-slate-700">
              <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
              Linked to Storehouse & Meals
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-900/80 px-3 py-1 border border-slate-700">
              <span className="h-2 w-2 rounded-full bg-indigo-400" />
              SessionRunner Ready
            </span>
          </div>
        </header>

        {/* Main card */}
        <main className="bg-slate-900/70 border border-slate-700 rounded-2xl shadow-xl p-4 lg:p-6">
          <BatchYieldCalculatorView
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

          <BatchYieldSummaryCard
            result={result}
            onUseInSession={handleUseInSession}
          />
        </main>
      </div>
    </div>
  );
}
