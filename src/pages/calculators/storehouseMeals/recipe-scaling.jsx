// C:\Users\larho\suka-smart-assistant\src\pages\calculators\storehouseMeals\recipe-scaling.jsx

/**
 * Recipe Scaling Calculator Route
 *
 * How this fits:
 * - Hosts the RecipeScalingCalculator UI so SSA can:
 *   • scale recipes up/down for different household sizes,
 *   • keep original vs scaled servings in sync with storehouse + meals,
 *   • suggest batch sessions or preservation runs at the right scale.
 * - Uses the shared calculatorRunner so execution is consistent,
 *   event-driven, and easy to hook into Planning Graph + SessionRunner.
 * - Emits events so automation can:
 *   • propose scaled sessions,
 *   • push scaled recipes into meal plans or batch queues,
 *   • align grocery quantities with scaled ingredient lists.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import eventBus from "@/services/eventBus";
import { familyFundMode } from "@/services/featureFlags";
import { runCalculator } from "@/services/calculators/calculatorRunner";
import RecipeScalingCalculatorView from "@/features/calculators/storehouseMeals/RecipeScalingCalculator.view";

const CALCULATOR_ID = "storehouseMeals.recipeScaling";

/**
 * @typedef {Object} RecipeScalingResult
 * @property {number} originalServings
 * @property {number} targetServings
 * @property {number} scaleFactor
 * @property {number} [roundedScaleFactor]
 * @property {number} [totalIngredients]
 * @property {number} [ingredientsAdjusted]
 * @property {string[]} [warnings]
 * @property {string[]} [notes]
 * @property {Object<string, any>} [meta]
 */

/**
 * Emit that the recipe scaling has completed.
 *
 * @param {RecipeScalingResult} result
 */
function emitRecipeScalingCompleted(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.recipeScaling.completed",
      ts: new Date().toISOString(),
      source: "pages.calculators.storehouseMeals.recipe-scaling",
      data: {
        calculatorId: CALCULATOR_ID,
        result,
        familyFundMode: !!familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[recipe-scaling.jsx] Failed to emit calculator.recipeScaling.completed",
      err
    );
  }
}

/**
 * Emit a request to apply the scaling to a session (cooking/preservation)
 * or planner so that SessionRunner can turn it into a real workflow.
 *
 * @param {RecipeScalingResult} result
 */
function requestScaledSession(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.recipeScaling.session.requested",
      ts: new Date().toISOString(),
      source: "pages.calculators.storehouseMeals.recipe-scaling",
      data: {
        calculatorId: CALCULATOR_ID,
        domain: "cooking",
        result,
        familyFundMode: !!familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[recipe-scaling.jsx] Failed to emit calculator.recipeScaling.session.requested",
      err
    );
  }
}

/**
 * Summary card that makes the scaling result readable and actionable.
 */
function RecipeScalingSummaryCard({ result, onUseInSession }) {
  if (!result) return null;

  const factorLabel = useMemo(() => {
    const factor = Number(result.scaleFactor || 0);
    if (!factor || Number.isNaN(factor)) return "No scaling applied";
    if (factor === 1) return "Same size as original recipe";
    if (factor > 1) return `Scaled up ×${factor.toFixed(2)}`;
    return `Scaled down ×${factor.toFixed(2)}`;
  }, [result.scaleFactor]);

  const coverageNote = useMemo(() => {
    const original = Number(result.originalServings || 0);
    const target = Number(result.targetServings || 0);
    if (!original || !target) return "Adjust servings to match your household.";
    if (target > original) {
      return "Great for leftovers, batch cooking, or freezing portions.";
    }
    if (target < original) {
      return "Useful when ingredients are limited or for small households.";
    }
    return "Use this as your baseline recipe size.";
  }, [result.originalServings, result.targetServings]);

  return (
    <section className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-4 space-y-3">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">
            Scaling Summary
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Keep your recipe aligned with real household size, storehouse
            goals, and batch cooking plans.
          </p>
        </div>
        <span className="text-[10px] px-2 py-1 rounded-full bg-slate-900 border border-slate-700 text-slate-200 whitespace-nowrap">
          {factorLabel}
        </span>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Original Servings</span>
          <span className="text-slate-50 font-semibold">
            {Math.round(result.originalServings || 0)}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Target Servings</span>
          <span className="text-slate-50 font-semibold">
            {Math.round(result.targetServings || 0)}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Scale Factor</span>
          <span className="text-slate-50 font-semibold">
            {result.roundedScaleFactor != null
              ? result.roundedScaleFactor.toFixed(2)
              : (result.scaleFactor || 0).toFixed(2)}
          </span>
        </div>
        {typeof result.totalIngredients === "number" && (
          <div className="flex flex-col">
            <span className="text-slate-400 mb-0.5">Ingredients Adjusted</span>
            <span className="text-slate-50 font-semibold">
              {result.ingredientsAdjusted ?? result.totalIngredients} /{" "}
              {result.totalIngredients}
            </span>
          </div>
        )}
      </div>

      {Array.isArray(result.warnings) && result.warnings.length > 0 && (
        <div className="mt-1 rounded-xl border border-amber-500/60 bg-amber-950/40 px-3 py-2 text-[11px] text-amber-50">
          <p className="font-medium mb-0.5">Caution zones:</p>
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
          Tip: Once you like this size, save it as your &quot;household
          default&quot; so SSA uses it in meal plans, batch sessions, and
          storehouse projections.
        </p>
        <button
          type="button"
          onClick={() => onUseInSession && onUseInSession(result)}
          className="inline-flex items-center justify-center rounded-xl px-4 py-2.5 text-xs font-semibold bg-emerald-400 hover:bg-emerald-300 text-slate-950 shadow-md shadow-emerald-500/30 transition"
        >
          Use Scaled Recipe in a Session
        </button>
      </div>
    </section>
  );
}

/**
 * Route component: Recipe Scaling Calculator + summary panel.
 */
export default function RecipeScalingCalculatorPage() {
  /** @type {[RecipeScalingResult|null, React.Dispatch<React.SetStateAction<RecipeScalingResult|null>>]} */
  const [result, setResult] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    document.title = "Recipe Scaling Calculator | Suka Smart Assistant";
  }, []);

  /**
   * Handler passed to RecipeScalingCalculatorView.
   *
   * @param {Object} input - Calculator input from view.
   */
  const handleCalculate = useCallback(async (input) => {
    setIsRunning(true);
    setError(null);

    try {
      const { result: calcResult } = await runCalculator(
        CALCULATOR_ID,
        input,
        {
          source: "pages.calculators.storehouseMeals.recipe-scaling",
          emitEvents: true,
        }
      );

      if (!calcResult || typeof calcResult !== "object") {
        throw new Error(
          "Recipe scaling calculator did not return a result object."
        );
      }

      /** @type {RecipeScalingResult} */
      const normalized = {
        originalServings: Number(calcResult.originalServings ?? 0),
        targetServings: Number(calcResult.targetServings ?? 0),
        scaleFactor: Number(calcResult.scaleFactor ?? 1),
        roundedScaleFactor:
          typeof calcResult.roundedScaleFactor === "number"
            ? calcResult.roundedScaleFactor
            : undefined,
        totalIngredients:
          typeof calcResult.totalIngredients === "number"
            ? calcResult.totalIngredients
            : undefined,
        ingredientsAdjusted:
          typeof calcResult.ingredientsAdjusted === "number"
            ? calcResult.ingredientsAdjusted
            : undefined,
        warnings: Array.isArray(calcResult.warnings)
          ? calcResult.warnings
          : [],
        notes: Array.isArray(calcResult.notes) ? calcResult.notes : [],
        meta: calcResult.meta || {},
      };

      setResult(normalized);
      emitRecipeScalingCompleted(normalized);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        "[recipe-scaling.jsx] Recipe scaling calculator error",
        err
      );
      setError(
        err && err.message
          ? err.message
          : "There was a problem running the recipe scaling calculator."
      );
    } finally {
      setIsRunning(false);
    }
  }, []);

  const handleUseInSession = useCallback((scalingResult) => {
    if (!scalingResult) return;
    requestScaledSession(scalingResult);
  }, []);

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-slate-950/90 text-slate-50">
      <div className="mx-auto max-w-5xl px-4 py-6 lg:py-8">
        {/* Header */}
        <header className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-50">
              Recipe Scaling Calculator
            </h1>
            <p className="mt-1 text-sm text-slate-400 max-w-2xl">
              Scale recipes up or down to match your real household size,
              batch goals, and storehouse plans. SSA will keep the math,
              ingredients, and sessions aligned behind the scenes.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-900/80 px-3 py-1 border border-slate-700">
              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
              Links to Meal Planner
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-900/80 px-3 py-1 border border-slate-700">
              <span className="h-2 w-2 rounded-full bg-indigo-400" />
              SessionRunner Ready
            </span>
          </div>
        </header>

        {/* Main card */}
        <main className="bg-slate-900/70 border border-slate-700 rounded-2xl shadow-xl p-4 lg:p-6">
          <RecipeScalingCalculatorView
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

          <RecipeScalingSummaryCard
            result={result}
            onUseInSession={handleUseInSession}
          />
        </main>
      </div>
    </div>
  );
}
