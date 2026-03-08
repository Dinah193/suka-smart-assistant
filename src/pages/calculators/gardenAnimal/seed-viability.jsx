// C:\Users\larho\suka-smart-assistant\src\pages\calculators\gardenAnimal\seed-viability.jsx

/**
 * Seed Viability Calculator Route
 *
 * How this fits SSA:
 * - Wraps SeedViabilityCalculatorView with:
 *   • calculatorRunner wiring so viability logic lives in one place
 *   • eventBus emissions so Garden Planner, Storehouse (seed inventory),
 *     and Price/Ordering tools can react
 *   • a summary card surfacing viability %, oversow factor, and
 *     “plant this season or replace” guidance
 *   • CTAs to:
 *       - sync to Garden Planner (adjust sowing density & plan)
 *       - sync to Storehouse/Seed Inventory
 *       - nudge ordering / pricebook if replacement is recommended
 *
 * Typical graph flow:
 *   - FROM: seed lot data (crop, year, storage), optional test result
 *   - TO:   garden planting plans, seed inventory priorities,
 *           and seed replacement / ordering suggestions.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import eventBus from "@/services/events/eventBus";
import { familyFundMode } from "@/config/featureFlags";
import { runCalculator } from "@/services/calculators/calculatorRunner";
import SeedViabilityCalculatorView from "@/features/calculators/gardenAnimal/SeedViabilityCalculator.view.jsx";

const CALCULATOR_ID = "garden.seedViability";

/**
 * @typedef {Object} SeedLotInfo
 * @property {string} id
 * @property {string} cropName
 * @property {string} [variety]
 * @property {number} [harvestYear]
 * @property {number} [ageYears]
 * @property {string} [storageNotes]
 * @property {string} [sourceLabel] // e.g. "Saved", "Seed Co", etc.
 */

/**
 * @typedef {Object} SeedViabilityResult
 * @property {SeedLotInfo} [seedLot]
 * @property {number} [testedSeeds]           // seeds in test
 * @property {number} [germinatedSeeds]       // germinated in test
 * @property {number} [viabilityPercent]      // 0..100
 * @property {string} [viabilityClass]        // "excellent"|"good"|"marginal"|"poor"|"unknown"
 * @property {number} [recommendedOversow]    // e.g. 1.0, 1.25, 1.5, 2.0
 * @property {number} [expectedGerminationPer10] // expected germination per 10 seeds
 * @property {string} [recommendedUseWindow]  // e.g. "Use this season", "Retire"
 * @property {string} [recommendedAction]     // short text for CTA
 * @property {string[]} [warnings]
 * @property {string[]} [notes]
 * @property {string} [suggestedPlannerLabel] // label for garden planner link
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
 * @param {SeedViabilityResult} result
 */
function emitSeedViabilityCompleted(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.seedViability.completed",
      ts: new Date().toISOString(),
      source: "pages.calculators.gardenAnimal.seed-viability",
      data: {
        calculatorId: CALCULATOR_ID,
        result,
        familyFundMode: !!familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[seed-viability.jsx] Failed to emit calculator.seedViability.completed",
      err
    );
  }
}

/**
 * Ask Garden Planner to update sowing densities and priorities.
 * @param {SeedViabilityResult} result
 */
function requestGardenPlannerSync(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.seedViability.gardenPlannerSync.requested",
      ts: new Date().toISOString(),
      source: "pages.calculators.gardenAnimal.seed-viability",
      data: {
        calculatorId: CALCULATOR_ID,
        result,
        familyFundMode: !!familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[seed-viability.jsx] Failed to emit calculator.seedViability.gardenPlannerSync.requested",
      err
    );
  }
}

/**
 * Ask Storehouse to update seed inventory stats.
 * @param {SeedViabilityResult} result
 */
function requestStorehouseSync(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.seedViability.storehouseSync.requested",
      ts: new Date().toISOString(),
      source: "pages.calculators.gardenAnimal.seed-viability",
      data: {
        calculatorId: CALCULATOR_ID,
        result,
        familyFundMode: !!familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[seed-viability.jsx] Failed to emit calculator.seedViability.storehouseSync.requested",
      err
    );
  }
}

/**
 * Ask Pricebook / ordering system to mark for replacement / re-order.
 * @param {SeedViabilityResult} result
 */
function requestReplacementPlanning(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.seedViability.replacementPlanning.requested",
      ts: new Date().toISOString(),
      source: "pages.calculators.gardenAnimal.seed-viability",
      data: {
        calculatorId: CALCULATOR_ID,
        result,
        familyFundMode: !!familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[seed-viability.jsx] Failed to emit calculator.seedViability.replacementPlanning.requested",
      err
    );
  }
}

/**
 * Summary card for seed viability output & next steps.
 *
 * @param {{
 *   result: SeedViabilityResult | null,
 *   onGardenPlannerSync: (r: SeedViabilityResult) => void,
 *   onStorehouseSync: (r: SeedViabilityResult) => void,
 *   onReplacementPlanning: (r: SeedViabilityResult) => void
 * }} props
 */
function SeedViabilitySummaryCard({
  result,
  onGardenPlannerSync,
  onStorehouseSync,
  onReplacementPlanning,
}) {
  if (!result) return null;

  const {
    seedLot,
    testedSeeds,
    germinatedSeeds,
    viabilityPercent,
    viabilityClass,
    recommendedOversow,
    expectedGerminationPer10,
    recommendedUseWindow,
    recommendedAction,
    warnings,
    notes,
    suggestedPlannerLabel,
  } = result;

  const cropLabel = useMemo(() => {
    if (!seedLot) return "Seed lot";
    if (seedLot.variety) {
      return `${seedLot.cropName} · ${seedLot.variety}`;
    }
    return seedLot.cropName || "Seed lot";
  }, [seedLot]);

  const sourceLabel = useMemo(() => {
    if (!seedLot) return "";
    const parts = [];
    if (seedLot.sourceLabel) parts.push(seedLot.sourceLabel);
    if (seedLot.harvestYear) parts.push(`Harvest ${seedLot.harvestYear}`);
    if (typeof seedLot.ageYears === "number") {
      parts.push(`${safeNumber(seedLot.ageYears, 1)} yrs old`);
    }
    return parts.join(" · ");
  }, [seedLot]);

  const viabilityBadge = useMemo(() => {
    switch (viabilityClass) {
      case "excellent":
        return {
          text: "Excellent viability",
          className:
            "bg-emerald-500/15 border-emerald-400 text-emerald-200 shadow-emerald-500/30",
        };
      case "good":
        return {
          text: "Good viability",
          className:
            "bg-sky-500/15 border-sky-400 text-sky-200 shadow-sky-500/30",
        };
      case "marginal":
        return {
          text: "Marginal viability – oversow",
          className:
            "bg-amber-500/15 border-amber-400 text-amber-100 shadow-amber-500/30",
        };
      case "poor":
        return {
          text: "Poor viability – plan replacement",
          className:
            "bg-rose-500/15 border-rose-400 text-rose-100 shadow-rose-500/30",
        };
      default:
        return {
          text: "Viability not classified",
          className:
            "bg-slate-600/15 border-slate-400 text-slate-200 shadow-slate-600/30",
        };
    }
  }, [viabilityClass]);

  return (
    <section className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/75 px-4 py-4 space-y-3">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">
            Seed Viability Summary &amp; Next Steps
          </h2>
          <p className="text-xs text-slate-400 mt-0.5 max-w-xl">
            SSA evaluates how many of your seeds are likely to sprout, how
            heavily to oversow, and whether this lot should be prioritized this
            season or replaced in the storehouse.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1 text-[10px] text-slate-300">
          <span className="px-2 py-1 rounded-full bg-slate-900 border border-slate-700 whitespace-nowrap">
            {cropLabel}
          </span>
          {sourceLabel && (
            <span className="px-2 py-1 rounded-full bg-slate-900 border border-slate-700 whitespace-nowrap">
              {sourceLabel}
            </span>
          )}
        </div>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Test Result</span>
          <span className="text-slate-50 font-semibold">
            {safeNumber(germinatedSeeds, 0)}/{safeNumber(testedSeeds, 0)} seeds
          </span>
          <span className="text-slate-500">
            Direct germination from your test batch.
          </span>
        </div>

        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Viability</span>
          <span className="text-slate-50 font-semibold">
            {safeNumber(viabilityPercent, 1)}%
          </span>
          <span className="text-slate-500">
            Expected sprouting rate under decent conditions.
          </span>
        </div>

        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Oversow Factor</span>
          <span className="text-slate-50 font-semibold">
            ×{safeNumber(recommendedOversow || 1, 2)}
          </span>
          <span className="text-slate-500">
            Multiply your usual sow rate by this amount.
          </span>
        </div>

        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Per 10 Seeds</span>
          <span className="text-slate-50 font-semibold">
            {safeNumber(expectedGerminationPer10 || 0, 1)} expected sprouts
          </span>
          <span className="text-slate-500">
            Quick way to visualize effective seed strength.
          </span>
        </div>
      </div>

      <div
        className={`text-[11px] rounded-xl border px-3 py-2 shadow-sm ${viabilityBadge.className}`}
      >
        <p className="font-medium mb-0.5">{viabilityBadge.text}</p>
        <p className="leading-snug">
          {recommendedUseWindow
            ? recommendedUseWindow
            : "Use this information to decide if this lot should be prioritized, mixed, or retired."}
        </p>
        {recommendedAction && (
          <p className="mt-0.5 text-[10px] opacity-90">{recommendedAction}</p>
        )}
      </div>

      {Array.isArray(warnings) && warnings.length > 0 && (
        <div className="mt-1 rounded-xl border border-amber-500/70 bg-amber-950/60 px-3 py-2 text-[11px] text-amber-100">
          <p className="font-medium mb-0.5">Warnings &amp; Considerations</p>
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
          Tip: Seed lots with marginal viability can still be useful if you
          oversow or use them for dense nursery beds. SSA can pull this data
          into Garden Planner and seed ordering so you don&apos;t waste money or
          space.
        </p>
        <div className="flex flex-wrap gap-2 justify-end">
          <button
            type="button"
            onClick={() =>
              result && onGardenPlannerSync && onGardenPlannerSync(result)
            }
            className="inline-flex items-center justify-center rounded-xl px-3.5 py-2 text-[11px] font-semibold bg-indigo-400 hover:bg-indigo-300 text-slate-950 shadow-md shadow-indigo-500/30 transition"
          >
            {suggestedPlannerLabel || "Sync with Garden Planner"}
          </button>
          <button
            type="button"
            onClick={() =>
              result && onStorehouseSync && onStorehouseSync(result)
            }
            className="inline-flex items-center justify-center rounded-xl px-3.5 py-2 text-[11px] font-semibold bg-sky-400 hover:bg-sky-300 text-slate-950 shadow-md shadow-sky-500/30 transition"
          >
            Update Seed Inventory
          </button>
          <button
            type="button"
            onClick={() =>
              result && onReplacementPlanning && onReplacementPlanning(result)
            }
            className="inline-flex items-center justify-center rounded-xl px-3.5 py-2 text-[11px] font-semibold bg-rose-400 hover:bg-rose-300 text-slate-950 shadow-md shadow-rose-500/30 transition"
          >
            Plan Replacement / Ordering
          </button>
        </div>
      </div>
    </section>
  );
}

/**
 * Route component for Seed Viability Calculator.
 */
export default function SeedViabilityCalculatorPage() {
  /** @type {[SeedViabilityResult|null, React.Dispatch<React.SetStateAction<SeedViabilityResult|null>>]} */
  const [result, setResult] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    document.title = "Seed Viability Calculator | Suka Smart Assistant";
  }, []);

  /**
   * Handler passed to SeedViabilityCalculatorView.
   * @param {Object} input - Calculator input (seed lot data, test result, etc.)
   */
  const handleCalculate = useCallback(async (input) => {
    setIsRunning(true);
    setError(null);

    try {
      const { result: calcResult } = await runCalculator(CALCULATOR_ID, input, {
        source: "pages.calculators.gardenAnimal.seed-viability",
        emitEvents: true,
      });

      if (!calcResult || typeof calcResult !== "object") {
        throw new Error(
          "Seed Viability calculator did not return a result object."
        );
      }

      /** @type {SeedViabilityResult} */
      const normalized = {
        seedLot: calcResult.seedLot || null,
        testedSeeds:
          typeof calcResult.testedSeeds === "number"
            ? calcResult.testedSeeds
            : undefined,
        germinatedSeeds:
          typeof calcResult.germinatedSeeds === "number"
            ? calcResult.germinatedSeeds
            : undefined,
        viabilityPercent:
          typeof calcResult.viabilityPercent === "number"
            ? calcResult.viabilityPercent
            : undefined,
        viabilityClass:
          typeof calcResult.viabilityClass === "string"
            ? calcResult.viabilityClass
            : "unknown",
        recommendedOversow:
          typeof calcResult.recommendedOversow === "number"
            ? calcResult.recommendedOversow
            : 1,
        expectedGerminationPer10:
          typeof calcResult.expectedGerminationPer10 === "number"
            ? calcResult.expectedGerminationPer10
            : undefined,
        recommendedUseWindow:
          typeof calcResult.recommendedUseWindow === "string"
            ? calcResult.recommendedUseWindow
            : undefined,
        recommendedAction:
          typeof calcResult.recommendedAction === "string"
            ? calcResult.recommendedAction
            : undefined,
        warnings: Array.isArray(calcResult.warnings) ? calcResult.warnings : [],
        notes: Array.isArray(calcResult.notes) ? calcResult.notes : [],
        suggestedPlannerLabel:
          typeof calcResult.suggestedPlannerLabel === "string"
            ? calcResult.suggestedPlannerLabel
            : undefined,
        meta: calcResult.meta || {},
      };

      setResult(normalized);
      emitSeedViabilityCompleted(normalized);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        "[seed-viability.jsx] Seed Viability calculator error",
        err
      );
      setError(
        err && err.message
          ? err.message
          : "There was a problem running the Seed Viability calculator."
      );
    } finally {
      setIsRunning(false);
    }
  }, []);

  const handleGardenPlannerSync = useCallback((svResult) => {
    if (!svResult) return;
    requestGardenPlannerSync(svResult);
  }, []);

  const handleStorehouseSync = useCallback((svResult) => {
    if (!svResult) return;
    requestStorehouseSync(svResult);
  }, []);

  const handleReplacementPlanning = useCallback((svResult) => {
    if (!svResult) return;
    requestReplacementPlanning(svResult);
  }, []);

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-slate-950/90 text-slate-50">
      <div className="mx-auto max-w-5xl px-4 py-6 lg:py-8">
        {/* Header */}
        <header className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-50">
              Seed Viability Calculator
            </h1>
            <p className="mt-1 text-sm text-slate-400 max-w-2xl">
              Log a quick germination test or estimated viability for each seed
              lot. SSA turns that into oversow guidance, use-or-retire
              decisions, and hooks for Garden Planner, seed inventory, and
              ordering.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-900/80 px-3 py-1 border border-slate-700">
              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
              Feeds Garden Planner
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-900/80 px-3 py-1 border border-slate-700">
              <span className="h-2 w-2 rounded-full bg-sky-400" />
              Storehouse &amp; Seed Inventory
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-900/80 px-3 py-1 border border-slate-700">
              <span className="h-2 w-2 rounded-full bg-rose-400" />
              Replacement / Ordering Hints
            </span>
          </div>
        </header>

        {/* Main card */}
        <main className="bg-slate-900/70 border border-slate-700 rounded-2xl shadow-xl p-4 lg:p-6">
          <SeedViabilityCalculatorView
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

          <SeedViabilitySummaryCard
            result={result}
            onGardenPlannerSync={handleGardenPlannerSync}
            onStorehouseSync={handleStorehouseSync}
            onReplacementPlanning={handleReplacementPlanning}
          />
        </main>
      </div>
    </div>
  );
}
