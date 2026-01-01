// C:\Users\larho\suka-smart-assistant\src\pages\calculators\storehouseMeals\cost-per-serving.jsx

/**
 * Cost Per Serving Calculator Route
 *
 * How this fits:
 * - Wraps the CostPerServingCalculator view with:
 *   • shared calculatorRunner integration,
 *   • eventBus emissions for analytics & automation,
 *   • a summary card that encourages follow-up actions
 *     (optimize meal plans, adjust storehouse targets, etc.).
 * - Helps SSA link pricing + storehouse + meal planning:
 *   • understand which meals are expensive,
 *   • spot high-cost ingredients,
 *   • push suggestions into meal planning and storehouse goals.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import eventBus from "@/services/eventBus";
import { familyFundMode } from "@/services/featureFlags";
import { runCalculator } from "@/services/calculators/calculatorRunner";
import CostPerServingCalculatorView from "@/features/calculators/storehouseMeals/CostPerServingCalculator.view";

const CALCULATOR_ID = "storehouseMeals.costPerServing";

/**
 * @typedef {Object} MealCostItem
 * @property {string} id
 * @property {string} name
 * @property {number} servings
 * @property {number} totalCost
 * @property {number} costPerServing
 * @property {string[]} [tags]
 */

/**
 * @typedef {Object} IngredientCostItem
 * @property {string} id
 * @property {string} name
 * @property {number} totalCost
 * @property {number} usageCount
 * @property {"low"|"medium"|"high"} [impact]  // how much this ingredient drives cost
 */

/**
 * @typedef {Object} CostPerServingResult
 * @property {number} [averageCostPerServing]
 * @property {number} [medianCostPerServing]
 * @property {number} [minCostPerServing]
 * @property {number} [maxCostPerServing]
 * @property {number} [totalServings]
 * @property {number} [totalCost]
 * @property {MealCostItem[]} [meals]
 * @property {IngredientCostItem[]} [ingredients]
 * @property {string[]} [warnings]
 * @property {string[]} [notes]
 * @property {Object<string, any>} [meta]
 */

/**
 * Emit calculator completion for analytics/automation.
 *
 * @param {CostPerServingResult} result
 */
function emitCostPerServingCompleted(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.costPerServing.completed",
      ts: new Date().toISOString(),
      source: "pages.calculators.storehouseMeals.cost-per-serving",
      data: {
        calculatorId: CALCULATOR_ID,
        result,
        familyFundMode: !!familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[cost-per-serving.jsx] Failed to emit calculator.costPerServing.completed",
      err
    );
  }
}

/**
 * Request that the system turn this cost insight into a plan:
 * - e.g. suggest cheaper alternates,
 * - rebalance meal plan for budget,
 * - adjust storehouse targets.
 *
 * @param {CostPerServingResult} result
 */
function requestCostOptimizationPlan(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.costPerServing.plan.requested",
      ts: new Date().toISOString(),
      source: "pages.calculators.storehouseMeals.cost-per-serving",
      data: {
        calculatorId: CALCULATOR_ID,
        domain: "storehouse",
        result,
        familyFundMode: !!familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[cost-per-serving.jsx] Failed to emit calculator.costPerServing.plan.requested",
      err
    );
  }
}

/**
 * Summary card: highlight key cost metrics and top expensive meals/ingredients.
 */
function CostPerServingSummaryCard({ result, onCreatePlan }) {
  if (!result) return null;

  const avg = Number(result.averageCostPerServing || 0);
  const max = Number(result.maxCostPerServing || 0);
  const min = Number(result.minCostPerServing || 0);

  const budgetLabel = useMemo(() => {
    if (!avg) return "Review your cost per serving.";
    if (avg < 1.5) return "Very budget-friendly meals overall.";
    if (avg < 3) return "Moderate cost per serving.";
    return "On the higher side – room to optimize.";
  }, [avg]);

  /** @type {MealCostItem[]} */
  const topExpensiveMeals = useMemo(() => {
    if (!Array.isArray(result.meals)) return [];
    return [...result.meals]
      .sort((a, b) => (b.costPerServing || 0) - (a.costPerServing || 0))
      .slice(0, 5);
  }, [result.meals]);

  /** @type {IngredientCostItem[]} */
  const topCostIngredients = useMemo(() => {
    if (!Array.isArray(result.ingredients)) return [];
    return [...result.ingredients]
      .sort((a, b) => (b.totalCost || 0) - (a.totalCost || 0))
      .slice(0, 5);
  }, [result.ingredients]);

  return (
    <section className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-4 space-y-3">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">
            Cost Per Serving Summary
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            See how much your meals actually cost per serving, which dishes are
            driving your budget up, and which ingredients matter most.
          </p>
        </div>
        <span className="text-[10px] px-2 py-1 rounded-full bg-slate-900 border border-slate-700 text-slate-200 whitespace-nowrap">
          {budgetLabel}
        </span>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Avg Cost / Serving</span>
          <span className="text-slate-50 font-semibold">
            {avg ? `$${avg.toFixed(2)}` : "—"}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Total Cost</span>
          <span className="text-slate-50 font-semibold">
            {typeof result.totalCost === "number"
              ? `$${result.totalCost.toFixed(2)}`
              : "—"}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Total Servings</span>
          <span className="text-slate-50 font-semibold">
            {typeof result.totalServings === "number"
              ? result.totalServings
              : "—"}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Range (min → max)</span>
          <span className="text-slate-50 font-semibold">
            {min || max
              ? `$${min.toFixed(2)} → $${max.toFixed(2)}`
              : "—"}
          </span>
        </div>
      </div>

      {Array.isArray(result.warnings) && result.warnings.length > 0 && (
        <div className="mt-1 rounded-xl border border-amber-500/60 bg-amber-950/40 px-3 py-2 text-[11px] text-amber-50">
          <p className="font-medium mb-0.5">Things to watch:</p>
          <ul className="list-disc list-inside space-y-0.5">
            {result.warnings.map((w, idx) => (
              <li key={idx}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {(topExpensiveMeals.length > 0 || topCostIngredients.length > 0) && (
        <div className="grid gap-3 md:grid-cols-2 text-[11px]">
          {topExpensiveMeals.length > 0 && (
            <div className="rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2">
              <p className="font-medium text-slate-200 mb-1.5">
                Most expensive meals (per serving)
              </p>
              <ul className="space-y-0.5">
                {topExpensiveMeals.map((meal) => (
                  <li
                    key={meal.id}
                    className="flex justify-between gap-3 text-[11px]"
                  >
                    <span className="truncate">
                      {meal.name}
                      {Array.isArray(meal.tags) && meal.tags.length > 0 && (
                        <span className="text-slate-500">
                          {" "}
                          · {meal.tags.join(", ")}
                        </span>
                      )}
                    </span>
                    <span className="whitespace-nowrap text-slate-300">
                      <span className="font-semibold">
                        ${meal.costPerServing.toFixed(2)}
                      </span>{" "}
                      / serving
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {topCostIngredients.length > 0 && (
            <div className="rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2">
              <p className="font-medium text-slate-200 mb-1.5">
                Ingredients driving cost
              </p>
              <ul className="space-y-0.5">
                {topCostIngredients.map((ing) => (
                  <li
                    key={ing.id}
                    className="flex justify-between gap-3 text-[11px]"
                  >
                    <span className="truncate">
                      {ing.name}
                      {typeof ing.usageCount === "number" && (
                        <span className="text-slate-500">
                          {" "}
                          · used in {ing.usageCount} meal
                          {ing.usageCount === 1 ? "" : "s"}
                        </span>
                      )}
                    </span>
                    <span className="whitespace-nowrap text-slate-300">
                      <span className="font-semibold">
                        ${ing.totalCost.toFixed(2)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
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
          Tip: Use these insights to build a balanced meal rotation that keeps
          your food exciting but still kind to your budget. SSA can help propose
          swaps and batch plans automatically.
        </p>
        <button
          type="button"
          onClick={() => onCreatePlan && onCreatePlan(result)}
          className="inline-flex items-center justify-center rounded-xl px-4 py-2.5 text-xs font-semibold bg-emerald-400 hover:bg-emerald-300 text-slate-950 shadow-md shadow-emerald-500/30 transition"
        >
          Create Budget-Friendly Meal Plan
        </button>
      </div>
    </section>
  );
}

/**
 * Route component: Cost Per Serving Calculator + summary/actions panel.
 */
export default function CostPerServingCalculatorPage() {
  /** @type {[CostPerServingResult|null, React.Dispatch<React.SetStateAction<CostPerServingResult|null>>]} */
  const [result, setResult] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    document.title = "Cost Per Serving Calculator | Suka Smart Assistant";
  }, []);

  /**
   * Handler passed down to CostPerServingCalculatorView.
   *
   * @param {Object} input - Calculator input (meals, ingredients, prices, etc).
   */
  const handleCalculate = useCallback(async (input) => {
    setIsRunning(true);
    setError(null);

    try {
      const { result: calcResult } = await runCalculator(
        CALCULATOR_ID,
        input,
        {
          source: "pages.calculators.storehouseMeals.cost-per-serving",
          emitEvents: true,
        }
      );

      if (!calcResult || typeof calcResult !== "object") {
        throw new Error(
          "Cost per serving calculator did not return a result object."
        );
      }

      /** @type {CostPerServingResult} */
      const normalized = {
        averageCostPerServing:
          typeof calcResult.averageCostPerServing === "number"
            ? calcResult.averageCostPerServing
            : undefined,
        medianCostPerServing:
          typeof calcResult.medianCostPerServing === "number"
            ? calcResult.medianCostPerServing
            : undefined,
        minCostPerServing:
          typeof calcResult.minCostPerServing === "number"
            ? calcResult.minCostPerServing
            : undefined,
        maxCostPerServing:
          typeof calcResult.maxCostPerServing === "number"
            ? calcResult.maxCostPerServing
            : undefined,
        totalServings:
          typeof calcResult.totalServings === "number"
            ? calcResult.totalServings
            : undefined,
        totalCost:
          typeof calcResult.totalCost === "number"
            ? calcResult.totalCost
            : undefined,
        meals: Array.isArray(calcResult.meals) ? calcResult.meals : [],
        ingredients: Array.isArray(calcResult.ingredients)
          ? calcResult.ingredients
          : [],
        warnings: Array.isArray(calcResult.warnings)
          ? calcResult.warnings
          : [],
        notes: Array.isArray(calcResult.notes) ? calcResult.notes : [],
        meta: calcResult.meta || {},
      };

      setResult(normalized);
      emitCostPerServingCompleted(normalized);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        "[cost-per-serving.jsx] Cost per serving calculator error",
        err
      );
      setError(
        err && err.message
          ? err.message
          : "There was a problem running the cost per serving calculator."
      );
    } finally {
      setIsRunning(false);
    }
  }, []);

  const handleCreatePlan = useCallback((costResult) => {
    if (!costResult) return;
    requestCostOptimizationPlan(costResult);
  }, []);

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-slate-950/90 text-slate-50">
      <div className="mx-auto max-w-5xl px-4 py-6 lg:py-8">
        {/* Header */}
        <header className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-50">
              Cost Per Serving Calculator
            </h1>
            <p className="mt-1 text-sm text-slate-400 max-w-2xl">
              Enter your recipes, ingredient prices, and serving counts to see
              what each meal really costs per serving, then let SSA help you
              build budget-smart storehouse and meal plans.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-900/80 px-3 py-1 border border-slate-700">
              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
              Feeds Storehouse & Budget
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-900/80 px-3 py-1 border border-slate-700">
              <span className="h-2 w-2 rounded-full bg-indigo-400" />
              Planning Graph Node
            </span>
          </div>
        </header>

        {/* Main card */}
        <main className="bg-slate-900/70 border border-slate-700 rounded-2xl shadow-xl p-4 lg:p-6">
          <CostPerServingCalculatorView
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

          <CostPerServingSummaryCard
            result={result}
            onCreatePlan={handleCreatePlan}
          />
        </main>
      </div>
    </div>
  );
}
