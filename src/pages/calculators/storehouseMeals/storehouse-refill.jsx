// C:\Users\larho\suka-smart-assistant\src\pages\calculators\storehouseMeals\storehouse-refill.jsx

/**
 * Storehouse Refill Calculator Route
 *
 * How this fits:
 * - Hosts the StorehouseRefillCalculator UI so SSA can:
 *   • compare current storehouse levels vs. goals,
 *   • calculate refill gaps by item/category,
 *   • translate deficits into concrete refill actions (shopping, batch-cooking,
 *     preservation runs, or intra-family transfers).
 * - Uses the shared calculatorRunner for consistent execution and event flows.
 * - Emits events so Planning Graph + SessionRunner + Storehouse modules can:
 *   • propose refill sessions (shopping, batch prep),
 *   • update storehouse targets and watch-lists,
 *   • feed into homestead/seasonal planning.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import eventBus from "@/services/events/eventBus";
import { familyFundMode } from "@/config/featureFlags";
import { runCalculator } from "@/services/calculators/calculatorRunner";
import StorehouseRefillCalculatorView from "@/features/calculators/storehouseMeals/StorehouseRefillCalculator/StorehouseRefillCalculator.view.jsx";

const CALCULATOR_ID = "storehouseMeals.storehouseRefill";

/**
 * @typedef {Object} RefillItem
 * @property {string} id
 * @property {string} name
 * @property {string} [category]
 * @property {number} currentQty
 * @property {number} targetQty
 * @property {number} deficitQty
 * @property {string} [unit]
 * @property {"low"|"medium"|"high"} [priority]
 * @property {number} [daysCoverage]
 */

/**
 * @typedef {Object} StorehouseRefillResult
 * @property {number} [totalItems]
 * @property {number} [itemsNeedingRefill]
 * @property {number} [totalDeficitUnits]
 * @property {number} [estimatedDaysCoverageAfterRefill]
 * @property {"low"|"medium"|"high"|"critical"} [overallPriority]
 * @property {RefillItem[]} [items]
 * @property {string[]} [warnings]
 * @property {string[]} [notes]
 * @property {Object<string, any>} [meta]
 */

/**
 * Emit that the storehouse refill calculator has completed.
 *
 * @param {StorehouseRefillResult} result
 */
function emitStorehouseRefillCompleted(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.storehouseRefill.completed",
      ts: new Date().toISOString(),
      source: "pages.calculators.storehouseMeals.storehouse-refill",
      data: {
        calculatorId: CALCULATOR_ID,
        result,
        familyFundMode: !!familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[storehouse-refill.jsx] Failed to emit calculator.storehouseRefill.completed",
      err
    );
  }
}

/**
 * Emit a request to turn the refill gaps into a concrete plan/session.
 *
 * @param {StorehouseRefillResult} result
 */
function requestRefillPlan(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.storehouseRefill.plan.requested",
      ts: new Date().toISOString(),
      source: "pages.calculators.storehouseMeals.storehouse-refill",
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
      "[storehouse-refill.jsx] Failed to emit calculator.storehouseRefill.plan.requested",
      err
    );
  }
}

/**
 * Summary card to make refill recommendations clear and actionable.
 */
function StorehouseRefillSummaryCard({ result, onCreatePlan }) {
  if (!result) return null;

  const priorityLabel = useMemo(() => {
    switch (result.overallPriority) {
      case "critical":
        return "Critical – refill ASAP";
      case "high":
        return "High priority refill";
      case "medium":
        return "Medium priority";
      case "low":
        return "Low priority – top-up when convenient";
      default:
        return "Review suggested refills";
    }
  }, [result.overallPriority]);

  const coverageLabel = useMemo(() => {
    const days = Number(result.estimatedDaysCoverageAfterRefill || 0);
    if (!days) return "Coverage after refill: to be estimated.";
    if (days < 7)
      return `Only about ${days} days of coverage even after refill.`;
    if (days < 30) return `Roughly ${days} days of coverage after refill.`;
    return `About ${days} days of coverage after refill – great buffer.`;
  }, [result.estimatedDaysCoverageAfterRefill]);

  const itemsNeedingRefill = Number(result.itemsNeedingRefill || 0);
  const totalItems = Number(result.totalItems || 0);

  /** @type {RefillItem[]} */
  const topPriorityItems = useMemo(() => {
    if (!Array.isArray(result.items)) return [];
    // naive: sort by priority & deficit, take first 5
    const priorityRank = { critical: 3, high: 2, medium: 1, low: 0 };
    return [...result.items]
      .sort((a, b) => {
        const pa =
          priorityRank[a.priority] ??
          (a.priority === "high" ? 2 : a.priority === "medium" ? 1 : 0);
        const pb =
          priorityRank[b.priority] ??
          (b.priority === "high" ? 2 : b.priority === "medium" ? 1 : 0);
        if (pb !== pa) return pb - pa;
        return (b.deficitQty || 0) - (a.deficitQty || 0);
      })
      .slice(0, 5);
  }, [result.items]);

  return (
    <section className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-4 space-y-3">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">
            Storehouse Refill Summary
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            See what&apos;s running low, where the biggest gaps are, and turn
            those deficits into a concrete refill plan.
          </p>
        </div>
        <span className="text-[10px] px-2 py-1 rounded-full bg-slate-900 border border-slate-700 text-slate-200 whitespace-nowrap">
          {priorityLabel}
        </span>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Total Items</span>
          <span className="text-slate-50 font-semibold">
            {totalItems || "—"}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Need Refill</span>
          <span className="text-slate-50 font-semibold">
            {itemsNeedingRefill || 0}
            {totalItems ? ` / ${totalItems}` : ""}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Total Deficit</span>
          <span className="text-slate-50 font-semibold">
            {typeof result.totalDeficitUnits === "number"
              ? result.totalDeficitUnits.toFixed(1)
              : "—"}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Coverage After Refill</span>
          <span className="text-slate-50 font-semibold">
            {result.estimatedDaysCoverageAfterRefill != null
              ? `${Math.round(result.estimatedDaysCoverageAfterRefill)} days`
              : "TBD"}
          </span>
        </div>
      </div>

      {Array.isArray(result.warnings) && result.warnings.length > 0 && (
        <div className="mt-1 rounded-xl border border-amber-500/60 bg-amber-950/40 px-3 py-2 text-[11px] text-amber-50">
          <p className="font-medium mb-0.5">Watch these areas:</p>
          <ul className="list-disc list-inside space-y-0.5">
            {result.warnings.map((w, idx) => (
              <li key={idx}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {topPriorityItems.length > 0 && (
        <div className="mt-1 rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2 text-[11px] text-slate-100 space-y-1.5">
          <p className="font-medium text-slate-200">
            Top refill priorities (first 5):
          </p>
          <ul className="space-y-0.5">
            {topPriorityItems.map((item) => (
              <li
                key={item.id}
                className="flex justify-between gap-3 text-[11px]"
              >
                <span className="truncate">
                  {item.name}
                  {item.category ? (
                    <span className="text-slate-500"> · {item.category}</span>
                  ) : null}
                </span>
                <span className="whitespace-nowrap text-slate-300">
                  Need{" "}
                  <span className="font-semibold">
                    {item.deficitQty} {item.unit || ""}
                  </span>
                </span>
              </li>
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
          Tip: Convert these deficits into a refill plan so SSA can schedule
          shopping, batch cooking, or preservation tasks instead of letting
          shortages sneak up on you.
        </p>
        <button
          type="button"
          onClick={() => onCreatePlan && onCreatePlan(result)}
          className="inline-flex items-center justify-center rounded-xl px-4 py-2.5 text-xs font-semibold bg-cyan-400 hover:bg-cyan-300 text-slate-950 shadow-md shadow-cyan-500/30 transition"
        >
          Create Storehouse Refill Plan
        </button>
      </div>
    </section>
  );
}

/**
 * Route component: Storehouse Refill Calculator + summary/actions panel.
 */
export default function StorehouseRefillCalculatorPage() {
  /** @type {[StorehouseRefillResult|null, React.Dispatch<React.SetStateAction<StorehouseRefillResult|null>>]} */
  const [result, setResult] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    document.title = "Storehouse Refill Calculator | Suka Smart Assistant";
  }, []);

  /**
   * Handler passed into StorehouseRefillCalculatorView.
   *
   * @param {Object} input - Calculator input from the view.
   */
  const handleCalculate = useCallback(async (input) => {
    setIsRunning(true);
    setError(null);

    try {
      const { result: calcResult } = await runCalculator(CALCULATOR_ID, input, {
        source: "pages.calculators.storehouseMeals.storehouse-refill",
        emitEvents: true,
      });

      if (!calcResult || typeof calcResult !== "object") {
        throw new Error(
          "Storehouse refill calculator did not return a result object."
        );
      }

      /** @type {StorehouseRefillResult} */
      const normalized = {
        totalItems:
          typeof calcResult.totalItems === "number"
            ? calcResult.totalItems
            : undefined,
        itemsNeedingRefill:
          typeof calcResult.itemsNeedingRefill === "number"
            ? calcResult.itemsNeedingRefill
            : undefined,
        totalDeficitUnits:
          typeof calcResult.totalDeficitUnits === "number"
            ? calcResult.totalDeficitUnits
            : undefined,
        estimatedDaysCoverageAfterRefill:
          typeof calcResult.estimatedDaysCoverageAfterRefill === "number"
            ? calcResult.estimatedDaysCoverageAfterRefill
            : undefined,
        overallPriority: calcResult.overallPriority,
        items: Array.isArray(calcResult.items) ? calcResult.items : [],
        warnings: Array.isArray(calcResult.warnings) ? calcResult.warnings : [],
        notes: Array.isArray(calcResult.notes) ? calcResult.notes : [],
        meta: calcResult.meta || {},
      };

      setResult(normalized);
      emitStorehouseRefillCompleted(normalized);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        "[storehouse-refill.jsx] Storehouse refill calculator error",
        err
      );
      setError(
        err && err.message
          ? err.message
          : "There was a problem running the storehouse refill calculator."
      );
    } finally {
      setIsRunning(false);
    }
  }, []);

  const handleCreatePlan = useCallback((refillResult) => {
    if (!refillResult) return;
    requestRefillPlan(refillResult);
  }, []);

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-slate-950/90 text-slate-50">
      <div className="mx-auto max-w-5xl px-4 py-6 lg:py-8">
        {/* Header */}
        <header className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-50">
              Storehouse Refill Calculator
            </h1>
            <p className="mt-1 text-sm text-slate-400 max-w-2xl">
              Compare your current storehouse levels with your household goals,
              identify shortages, and turn the gaps into smart refill plans that
              sync with meals, preservation, and seasonal planning.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-900/80 px-3 py-1 border border-slate-700">
              <span className="h-2 w-2 rounded-full bg-cyan-400 animate-pulse" />
              Feeds Storehouse & Meals
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-900/80 px-3 py-1 border border-slate-700">
              <span className="h-2 w-2 rounded-full bg-indigo-400" />
              SessionRunner Ready
            </span>
          </div>
        </header>

        {/* Main card */}
        <main className="bg-slate-900/70 border border-slate-700 rounded-2xl shadow-xl p-4 lg:p-6">
          <StorehouseRefillCalculatorView
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

          <StorehouseRefillSummaryCard
            result={result}
            onCreatePlan={handleCreatePlan}
          />
        </main>
      </div>
    </div>
  );
}
