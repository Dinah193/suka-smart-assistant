// C:\Users\larho\suka-smart-assistant\src\pages\calculators\gardenAnimal\animal-feed.jsx

/**
 * Animal Feed Calculator Route
 *
 * How this fits SSA:
 * - Wraps AnimalFeedCalculatorView and:
 *   • sends all calculations through calculatorRunner so logic stays centralized
 *   • emits events for Animal Planner, Storehouse Feed Inventory,
 *     and Procurement / Pricebook planning
 *   • exposes a summary card showing daily & monthly feed needs,
 *     pasture vs purchased share, and any shortfalls
 *
 * Planning Graph links:
 *   FROM:
 *     - Animal inventory (species, counts, weights, life stage)
 *     - Pasture capacity and season
 *   TO:
 *     - Animal Planner (feeding sessions, pasture rotation)
 *     - Storehouse (feed inventory targets & depletion)
 *     - Cost / procurement planning (pricebook, bulk orders)
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import eventBus from "@/services/eventBus";
import { familyFundMode } from "@/services/featureFlags";
import { runCalculator } from "@/services/calculators/calculatorRunner";
import AnimalFeedCalculatorView from "@/features/calculators/gardenAnimal/AnimalFeedCalculator.view";

const CALCULATOR_ID = "gardenAnimal.animalFeed";

/**
 * @typedef {Object} HerdAnimal
 * @property {string} id
 * @property {string} species          // e.g. "sheep", "goat", "cow", "chicken"
 * @property {string} [breed]
 * @property {number} count
 * @property {number} [avgWeightLb]
 * @property {string} [lifeStage]      // "growing" | "maintenance" | "lactating" | etc.
 */

/**
 * @typedef {Object} AnimalFeedResult
 * @property {HerdAnimal[]} [herd]
 * @property {number} [dailyDryMatterLb]      // total dry matter per day (lb)
 * @property {number} [dailyAsFedLb]         // total as-fed feed per day (lb)
 * @property {number} [monthlyAsFedLb]       // 30-day as-fed feed (lb)
 * @property {number} [pastureSharePercent]  // 0..100 % of needs from pasture/forage
 * @property {number} [purchasedSharePercent]// 0..100 % from purchased feed
 * @property {number} [dailyCost]            // per day cost (currency-neutral)
 * @property {number} [monthlyCost]          // per 30 days cost
 * @property {number} [storehouseDaysCovered]// days current feed inventory covers
 * @property {number} [shortfallDays]        // days of shortfall for chosen planning window
 * @property {number} [planningWindowDays]   // days user planned for (e.g. 30, 90, 180)
 * @property {string} [recommendedAction]    // short summary of what to do next
 * @property {string} [feedMixLabel]         // e.g. "60% pasture / 40% purchased"
 * @property {string[]} [warnings]
 * @property {string[]} [notes]
 * @property {string} [suggestedPlannerLabel]
 * @property {Object<string, any>} [meta]
 */

/**
 * Safe number formatting.
 * @param {number | undefined | null} value
 * @param {number} [digits]
 * @returns {string}
 */
function safeNumber(value, digits = 0) {
  if (typeof value !== "number" || Number.isNaN(value)) return "0";
  return value.toFixed(digits);
}

/**
 * Emit completion event so analytics & automation can listen.
 * @param {AnimalFeedResult} result
 */
function emitAnimalFeedCompleted(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.animalFeed.completed",
      ts: new Date().toISOString(),
      source: "pages.calculators.gardenAnimal.animal-feed",
      data: {
        calculatorId: CALCULATOR_ID,
        result,
        familyFundMode: !!familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[animal-feed.jsx] Failed to emit calculator.animalFeed.completed",
      err
    );
  }
}

/**
 * Ask Animal Planner to incorporate feeding schedule / pasture rotation.
 * @param {AnimalFeedResult} result
 */
function requestAnimalPlannerSync(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.animalFeed.animalPlannerSync.requested",
      ts: new Date().toISOString(),
      source: "pages.calculators.gardenAnimal.animal-feed",
      data: {
        calculatorId: CALCULATOR_ID,
        result,
        familyFundMode: !!familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[animal-feed.jsx] Failed to emit calculator.animalFeed.animalPlannerSync.requested",
      err
    );
  }
}

/**
 * Ask Storehouse / feed inventory to update coverage & targets.
 * @param {AnimalFeedResult} result
 */
function requestStorehouseSync(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.animalFeed.storehouseSync.requested",
      ts: new Date().toISOString(),
      source: "pages.calculators.gardenAnimal.animal-feed",
      data: {
        calculatorId: CALCULATOR_ID,
        result,
        familyFundMode: !!familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[animal-feed.jsx] Failed to emit calculator.animalFeed.storehouseSync.requested",
      err
    );
  }
}

/**
 * Ask procurement / pricebook to plan bulk feed purchases.
 * @param {AnimalFeedResult} result
 */
function requestProcurementPlanning(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.animalFeed.procurementPlanning.requested",
      ts: new Date().toISOString(),
      source: "pages.calculators.gardenAnimal.animal-feed",
      data: {
        calculatorId: CALCULATOR_ID,
        result,
        familyFundMode: !!familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[animal-feed.jsx] Failed to emit calculator.animalFeed.procurementPlanning.requested",
      err
    );
  }
}

/**
 * Build a compact herd label for header.
 * @param {HerdAnimal[] | undefined} herd
 */
function buildHerdLabel(herd) {
  if (!Array.isArray(herd) || herd.length === 0) return "Your herd";
  const bySpecies = herd.reduce((acc, h) => {
    if (!h || !h.species) return acc;
    const key = h.species.toLowerCase();
    acc[key] = (acc[key] || 0) + (h.count || 0);
    return acc;
  }, {});
  const parts = Object.entries(bySpecies).map(([species, count]) => {
    return `${count}× ${species}`;
  });
  return parts.join(" · ");
}

/**
 * Summary card for Animal Feed calculations & next steps.
 *
 * @param {{
 *   result: AnimalFeedResult | null,
 *   onAnimalPlannerSync: (r: AnimalFeedResult) => void,
 *   onStorehouseSync: (r: AnimalFeedResult) => void,
 *   onProcurementPlanning: (r: AnimalFeedResult) => void
 * }} props
 */
function AnimalFeedSummaryCard({
  result,
  onAnimalPlannerSync,
  onStorehouseSync,
  onProcurementPlanning,
}) {
  if (!result) return null;

  const {
    herd,
    dailyDryMatterLb,
    dailyAsFedLb,
    monthlyAsFedLb,
    pastureSharePercent,
    purchasedSharePercent,
    dailyCost,
    monthlyCost,
    storehouseDaysCovered,
    shortfallDays,
    planningWindowDays,
    recommendedAction,
    feedMixLabel,
    warnings,
    notes,
    suggestedPlannerLabel,
  } = result;

  const herdLabel = useMemo(() => buildHerdLabel(herd), [herd]);

  const coverageBadge = useMemo(() => {
    if (typeof shortfallDays === "number" && shortfallDays > 0) {
      return {
        text: `Short by ~${safeNumber(shortfallDays, 0)} days`,
        className:
          "bg-rose-500/15 border-rose-400 text-rose-100 shadow-rose-500/30",
      };
    }
    if (
      typeof storehouseDaysCovered === "number" &&
      typeof planningWindowDays === "number" &&
      storehouseDaysCovered >= planningWindowDays
    ) {
      return {
        text: "Feed fully covered for this window",
        className:
          "bg-emerald-500/15 border-emerald-400 text-emerald-200 shadow-emerald-500/30",
      };
    }
    return {
      text: "Feed coverage estimate",
      className:
        "bg-slate-600/15 border-slate-400 text-slate-200 shadow-slate-600/30",
    };
  }, [shortfallDays, storehouseDaysCovered, planningWindowDays]);

  const windowLabel = useMemo(() => {
    if (!planningWindowDays || planningWindowDays <= 0) return "Planning window";
    if (planningWindowDays === 30) return "30-day window";
    if (planningWindowDays === 90) return "90-day window";
    if (planningWindowDays === 180) return "6-month window";
    if (planningWindowDays === 365) return "1-year window";
    return `${planningWindowDays}-day window`;
  }, [planningWindowDays]);

  return (
    <section className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/75 px-4 py-4 space-y-3">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">
            Feed Needs Summary &amp; Next Steps
          </h2>
          <p className="text-xs text-slate-400 mt-0.5 max-w-xl">
            SSA estimates how much feed your herd needs per day and per month,
            how much pasture can cover, and where your storehouse feed runs out
            so you can plan rotations and bulk purchases calmly.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1 text-[10px] text-slate-300">
          <span className="px-2 py-1 rounded-full bg-slate-900 border border-slate-700 whitespace-nowrap">
            {herdLabel}
          </span>
          {feedMixLabel && (
            <span className="px-2 py-1 rounded-full bg-slate-900 border border-slate-700 whitespace-nowrap">
              {feedMixLabel}
            </span>
          )}
        </div>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Daily Feed (as-fed)</span>
          <span className="text-slate-50 font-semibold">
            {safeNumber(dailyAsFedLb, 1)} lb / day
          </span>
          <span className="text-slate-500">
            Total as-fed feed for the herd, including concentrates &amp; forage.
          </span>
        </div>

        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Monthly Feed (as-fed)</span>
          <span className="text-slate-50 font-semibold">
            {safeNumber(monthlyAsFedLb, 1)} lb / 30 days
          </span>
          <span className="text-slate-500">
            Helps you size bins, totes, and delivery intervals.
          </span>
        </div>

        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Pasture vs Purchased</span>
          <span className="text-slate-50 font-semibold">
            {safeNumber(pastureSharePercent, 0)}% pasture ·{" "}
            {safeNumber(purchasedSharePercent, 0)}% purchased
          </span>
          <span className="text-slate-500">
            Balanced based on your settings and season assumptions.
          </span>
        </div>

        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Cost Estimate</span>
          <span className="text-slate-50 font-semibold">
            {safeNumber(dailyCost, 2)}/day · {safeNumber(monthlyCost, 2)}/30d
          </span>
          <span className="text-slate-500">
            Very rough — refine by attaching actual pricebook items.
          </span>
        </div>
      </div>

      <div
        className={`text-[11px] rounded-xl border px-3 py-2 shadow-sm ${coverageBadge.className}`}
      >
        <p className="font-medium mb-0.5">
          {coverageBadge.text} ({windowLabel})
        </p>
        <p className="leading-snug">
          {typeof storehouseDaysCovered === "number"
            ? `Current feed inventory covers approximately ${safeNumber(
                storehouseDaysCovered,
                0
              )} days for this herd.`
            : "SSA will track how many days of feed you have on hand once this calculation is linked to Storehouse inventory."}
        </p>
        {recommendedAction && (
          <p className="mt-0.5 text-[10px] opacity-90">{recommendedAction}</p>
        )}
      </div>

      {typeof dailyDryMatterLb === "number" && (
        <p className="text-[11px] text-slate-400 leading-snug">
          Dry matter basis:&nbsp;
          <span className="text-slate-200">
            {safeNumber(dailyDryMatterLb, 1)} lb/day
          </span>
          . SSA keeps this separate so you can swap feed types without losing
          nutritional intent.
        </p>
      )}

      {Array.isArray(warnings) && warnings.length > 0 && (
        <div className="mt-1 rounded-xl border border-amber-500/70 bg-amber-950/60 px-3 py-2 text-[11px] text-amber-100">
          <p className="font-medium mb-0.5">Warnings &amp; Constraints</p>
          <ul className="list-disc list-inside space-y-0.5">
            {warnings.map((w, idx) => (
              <li key={idx}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {Array.isArray(notes) && notes.length > 0 && (
        <p className="text-[11px] text-slate-400 leading-snug">
          Notes:&nbsp;
          <span className="text-slate-200">{notes.join(" • ")}</span>
        </p>
      )}

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-1">
        <p className="text-[11px] text-slate-500 leading-snug max-w-md">
          Tip: Once this calculator is wired into Storehouse feed inventory and
          Animal Planner, SSA can auto-suggest bulk orders, feed-making
          sessions, and grazing blocks that match your herd&apos;s appetite.
        </p>
        <div className="flex flex-wrap gap-2 justify-end">
          <button
            type="button"
            onClick={() =>
              result && onAnimalPlannerSync && onAnimalPlannerSync(result)
            }
            className="inline-flex items-center justify-center rounded-xl px-3.5 py-2 text-[11px] font-semibold bg-indigo-400 hover:bg-indigo-300 text-slate-950 shadow-md shadow-indigo-500/30 transition"
          >
            {suggestedPlannerLabel || "Sync with Animal Planner"}
          </button>
          <button
            type="button"
            onClick={() =>
              result && onStorehouseSync && onStorehouseSync(result)
            }
            className="inline-flex items-center justify-center rounded-xl px-3.5 py-2 text-[11px] font-semibold bg-sky-400 hover:bg-sky-300 text-slate-950 shadow-md shadow-sky-500/30 transition"
          >
            Update Feed Inventory
          </button>
          <button
            type="button"
            onClick={() =>
              result &&
              onProcurementPlanning &&
              onProcurementPlanning(result)
            }
            className="inline-flex items-center justify-center rounded-xl px-3.5 py-2 text-[11px] font-semibold bg-emerald-400 hover:bg-emerald-300 text-slate-950 shadow-md shadow-emerald-500/30 transition"
          >
            Plan Bulk Feed Purchases
          </button>
        </div>
      </div>
    </section>
  );
}

/**
 * Route component for Animal Feed Calculator.
 */
export default function AnimalFeedCalculatorPage() {
  /** @type {[AnimalFeedResult|null, React.Dispatch<React.SetStateAction<AnimalFeedResult|null>>]} */
  const [result, setResult] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    document.title = "Animal Feed Calculator | Suka Smart Assistant";
  }, []);

  /**
   * Handler passed to AnimalFeedCalculatorView.
   * @param {Object} input - Calculator input (herd, feed types, pasture capacity, etc.)
   */
  const handleCalculate = useCallback(async (input) => {
    setIsRunning(true);
    setError(null);

    try {
      const { result: calcResult } = await runCalculator(
        CALCULATOR_ID,
        input,
        {
          source: "pages.calculators.gardenAnimal.animal-feed",
          emitEvents: true,
        }
      );

      if (!calcResult || typeof calcResult !== "object") {
        throw new Error("Animal Feed calculator did not return a result object.");
      }

      /** @type {AnimalFeedResult} */
      const normalized = {
        herd: Array.isArray(calcResult.herd) ? calcResult.herd : [],
        dailyDryMatterLb:
          typeof calcResult.dailyDryMatterLb === "number"
            ? calcResult.dailyDryMatterLb
            : undefined,
        dailyAsFedLb:
          typeof calcResult.dailyAsFedLb === "number"
            ? calcResult.dailyAsFedLb
            : undefined,
        monthlyAsFedLb:
          typeof calcResult.monthlyAsFedLb === "number"
            ? calcResult.monthlyAsFedLb
            : undefined,
        pastureSharePercent:
          typeof calcResult.pastureSharePercent === "number"
            ? calcResult.pastureSharePercent
            : undefined,
        purchasedSharePercent:
          typeof calcResult.purchasedSharePercent === "number"
            ? calcResult.purchasedSharePercent
            : undefined,
        dailyCost:
          typeof calcResult.dailyCost === "number"
            ? calcResult.dailyCost
            : undefined,
        monthlyCost:
          typeof calcResult.monthlyCost === "number"
            ? calcResult.monthlyCost
            : undefined,
        storehouseDaysCovered:
          typeof calcResult.storehouseDaysCovered === "number"
            ? calcResult.storehouseDaysCovered
            : undefined,
        shortfallDays:
          typeof calcResult.shortfallDays === "number"
            ? calcResult.shortfallDays
            : undefined,
        planningWindowDays:
          typeof calcResult.planningWindowDays === "number"
            ? calcResult.planningWindowDays
            : undefined,
        recommendedAction:
          typeof calcResult.recommendedAction === "string"
            ? calcResult.recommendedAction
            : undefined,
        feedMixLabel:
          typeof calcResult.feedMixLabel === "string"
            ? calcResult.feedMixLabel
            : undefined,
        warnings: Array.isArray(calcResult.warnings)
          ? calcResult.warnings
          : [],
        notes: Array.isArray(calcResult.notes) ? calcResult.notes : [],
        suggestedPlannerLabel:
          typeof calcResult.suggestedPlannerLabel === "string"
            ? calcResult.suggestedPlannerLabel
            : undefined,
        meta: calcResult.meta || {},
      };

      setResult(normalized);
      emitAnimalFeedCompleted(normalized);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[animal-feed.jsx] Animal Feed calculator error", err);
      setError(
        err && err.message
          ? err.message
          : "There was a problem running the Animal Feed calculator."
      );
    } finally {
      setIsRunning(false);
    }
  }, []);

  const handleAnimalPlannerSync = useCallback((afResult) => {
    if (!afResult) return;
    requestAnimalPlannerSync(afResult);
  }, []);

  const handleStorehouseSync = useCallback((afResult) => {
    if (!afResult) return;
    requestStorehouseSync(afResult);
  }, []);

  const handleProcurementPlanning = useCallback((afResult) => {
    if (!afResult) return;
    requestProcurementPlanning(afResult);
  }, []);

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-slate-950/90 text-slate-50">
      <div className="mx-auto max-w-5xl px-4 py-6 lg:py-8">
        {/* Header */}
        <header className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-50">
              Animal Feed Calculator
            </h1>
            <p className="mt-1 text-sm text-slate-400 max-w-2xl">
              Estimate daily and seasonal feed needs for your herd, balance
              pasture vs purchased feed, and see how long your current
              storehouse feed will last so you can plan rotations and bulk
              orders with confidence.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-900/80 px-3 py-1 border border-slate-700">
              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
              Feeds Animal Planner
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-900/80 px-3 py-1 border border-slate-700">
              <span className="h-2 w-2 rounded-full bg-sky-400" />
              Storehouse Feed Inventory
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-900/80 px-3 py-1 border border-slate-700">
              <span className="h-2 w-2 rounded-full bg-amber-400" />
              Procurement &amp; Pricebook
            </span>
          </div>
        </header>

        {/* Main card */}
        <main className="bg-slate-900/70 border border-slate-700 rounded-2xl shadow-xl p-4 lg:p-6">
          <AnimalFeedCalculatorView
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

          <AnimalFeedSummaryCard
            result={result}
            onAnimalPlannerSync={handleAnimalPlannerSync}
            onStorehouseSync={handleStorehouseSync}
            onProcurementPlanning={handleProcurementPlanning}
          />
        </main>
      </div>
    </div>
  );
}
