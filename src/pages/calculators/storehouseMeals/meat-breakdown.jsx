// C:\Users\larho\suka-smart-assistant\src\pages\calculators\storehouseMeals\meat-breakdown.jsx

/**
 * Meat Breakdown Calculator Route
 *
 * How this fits:
 * - Wraps MeatBreakdownCalculatorView with:
 *   • calculatorRunner wiring for consistent calculator execution,
 *   • eventBus emissions so the automation/runtime can react,
 *   • a summary card that highlights total yield and main cut categories,
 *   • CTAs to:
 *       - push the breakdown into Storehouse inventory updates
 *       - spawn a butchery / processing SessionRunner flow (domain: "animals").
 *
 * This page lives in the StorehouseMeals lane but directly touches the
 * Animal Planner / Butchery Planning nodes of the Planning Graph.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import eventBus from "@/services/events/eventBus";
import { familyFundMode } from "@/config/featureFlags";
import { runCalculator } from "@/services/calculators/calculatorRunner";
import MeatBreakdownCalculatorView from "@/features/calculators/storehouseMeals/MeatBreakdownCalculator.view.jsx";

const CALCULATOR_ID = "storehouseMeals.meatBreakdown";

/**
 * @typedef {Object} MeatCutBreakdown
 * @property {string} id
 * @property {string} name                 // "Chuck roast", "Ground", "Stew meat"
 * @property {"roast"|"steak"|"ground"|"stew"|"offal"|"bones"|"trim"|"other"} type
 * @property {number} weightLb
 * @property {number} percentOfCarcass
 * @property {boolean} [edible]
 * @property {string} [storehouseSection]  // "freezer:roasts", "freezer:ground", etc.
 * @property {string} [notes]
 */

/**
 * @typedef {Object} MeatBreakdownResult
 * @property {string} [animalType]         // "lamb", "goat", "beef", "deer", etc.
 * @property {string} [sourceLabel]        // "Whole lamb #3", "Half beef", etc.
 * @property {number} [liveWeightLb]
 * @property {number} [carcassWeightLb]
 * @property {number} [hangingLossPercent]
 * @property {number} [totalEdibleLb]
 * @property {number} [totalEdiblePercent]
 * @property {number} [totalBoneLb]
 * @property {number} [totalBonePercent]
 * @property {number} [totalTrimLossLb]
 * @property {number} [totalTrimLossPercent]
 * @property {MeatCutBreakdown[]} [cuts]
 * @property {string[]} [warnings]
 * @property {string[]} [notes]
 * @property {Object<string, any>} [meta]
 */

/**
 * Emit completion event so analytics & automation can listen.
 *
 * @param {MeatBreakdownResult} result
 */
function emitMeatBreakdownCompleted(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.meatBreakdown.completed",
      ts: new Date().toISOString(),
      source: "pages.calculators.storehouseMeals.meat-breakdown",
      data: {
        calculatorId: CALCULATOR_ID,
        result,
        familyFundMode: !!familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[meat-breakdown.jsx] Failed to emit calculator.meatBreakdown.completed",
      err
    );
  }
}

/**
 * Ask the automation/runtime to:
 *  - create a butchery/processing session (domain: "animals")
 *  - and/or push prefilled inventory updates into Storehouse.
 *
 * @param {MeatBreakdownResult} result
 */
function requestMeatBreakdownSession(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;

    eventBus.emit({
      type: "calculator.meatBreakdown.session.requested",
      ts: new Date().toISOString(),
      source: "pages.calculators.storehouseMeals.meat-breakdown",
      data: {
        calculatorId: CALCULATOR_ID,
        domain: "animals",
        result,
        familyFundMode: !!familyFundMode,
        sessionHint: {
          title:
            result?.sourceLabel ||
            result?.animalType ||
            "Meat Breakdown Session",
          suggestedDomain: "animals",
          tags: ["butchery", "storehouse", "yield"],
        },
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[meat-breakdown.jsx] Failed to emit calculator.meatBreakdown.session.requested",
      err
    );
  }
}

/**
 * Ask Storehouse to create/update entries for resulting cuts.
 *
 * @param {MeatBreakdownResult} result
 */
function requestStorehouseUpdate(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;

    eventBus.emit({
      type: "calculator.meatBreakdown.storehouseUpdate.requested",
      ts: new Date().toISOString(),
      source: "pages.calculators.storehouseMeals.meat-breakdown",
      data: {
        calculatorId: CALCULATOR_ID,
        result,
        familyFundMode: !!familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[meat-breakdown.jsx] Failed to emit calculator.meatBreakdown.storehouseUpdate.requested",
      err
    );
  }
}

/**
 * Compact summary card highlighting yields & next steps.
 *
 * @param {{
 *   result: MeatBreakdownResult | null,
 *   onStartSession: (r: MeatBreakdownResult) => void,
 *   onStorehouseUpdate: (r: MeatBreakdownResult) => void
 * }} props
 */
function MeatBreakdownSummaryCard({
  result,
  onStartSession,
  onStorehouseUpdate,
}) {
  if (!result) return null;

  const cuts = Array.isArray(result.cuts) ? result.cuts : [];

  const grouped = useMemo(() => {
    if (!cuts.length) return null;

    const accumulator = {
      roast: 0,
      steak: 0,
      ground: 0,
      stew: 0,
      offal: 0,
      bones: 0,
      trim: 0,
      other: 0,
    };

    cuts.forEach((c) => {
      const key = accumulator[c.type] !== undefined ? c.type : "other";
      accumulator[key] += c.weightLb || 0;
    });

    return accumulator;
  }, [cuts]);

  const animalLabel =
    result.sourceLabel ||
    (result.animalType
      ? `${result.animalType.charAt(0).toUpperCase()}${result.animalType.slice(
          1
        )}`
      : "This animal");

  const totalEdibleLb = result.totalEdibleLb || 0;
  const totalEdiblePercent = result.totalEdiblePercent || 0;
  const totalBonePercent = result.totalBonePercent || 0;
  const liveWeightLb = result.liveWeightLb || null;
  const carcassWeightLb = result.carcassWeightLb || null;

  return (
    <section className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-4 space-y-3">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">
            Meat Breakdown Summary
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            See how {animalLabel.toLowerCase()} converts into usable cuts,
            bones, and trim so you can plan meals, storehouse space, and future
            processing sessions.
          </p>
        </div>
        <span className="text-[10px] px-2 py-1 rounded-full bg-slate-900 border border-slate-700 text-slate-200 whitespace-nowrap">
          Ready for Storehouse + Sessions
        </span>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Edible Yield</span>
          <span className="text-slate-50 font-semibold">
            {totalEdibleLb.toFixed(1)} lb
          </span>
          <span className="text-slate-500">
            {totalEdiblePercent.toFixed(1)}% of carcass
          </span>
        </div>

        {carcassWeightLb !== null && (
          <div className="flex flex-col">
            <span className="text-slate-400 mb-0.5">Carcass Weight</span>
            <span className="text-slate-50 font-semibold">
              {carcassWeightLb.toFixed(1)} lb
            </span>
            {liveWeightLb && (
              <span className="text-slate-500">
                Live: {liveWeightLb.toFixed(1)} lb
              </span>
            )}
          </div>
        )}

        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Bone & Trim</span>
          <span className="text-slate-50 font-semibold">
            {totalBonePercent.toFixed(1)}% bone
          </span>
          <span className="text-slate-500">
            {result.totalTrimLossPercent
              ? `${result.totalTrimLossPercent.toFixed(1)}% trim/loss`
              : "Trim/loss % not set"}
          </span>
        </div>

        {grouped && (
          <div className="flex flex-col">
            <span className="text-slate-400 mb-0.5">Key Cut Types (lb)</span>
            <span className="text-slate-50 font-semibold">
              R {grouped.roast.toFixed(1)} · G {grouped.ground.toFixed(1)} · S{" "}
              {grouped.steak.toFixed(1)}
            </span>
            <span className="text-slate-500">
              Stew {grouped.stew.toFixed(1)} · Offal {grouped.offal.toFixed(1)}
            </span>
          </div>
        )}
      </div>

      {Array.isArray(result.warnings) && result.warnings.length > 0 && (
        <div className="mt-2 rounded-xl border border-amber-500/60 bg-amber-950/40 px-3 py-2 text-[11px] text-amber-50">
          <p className="font-medium mb-0.5">Cautions & Notes</p>
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
          Tip: Let SSA push these cuts into your Storehouse inventory and turn
          them into a butchery session with timers and checklists you can run
          through the SessionRunner.
        </p>
        <div className="flex flex-wrap gap-2 justify-end">
          <button
            type="button"
            onClick={() =>
              result && onStorehouseUpdate && onStorehouseUpdate(result)
            }
            className="inline-flex items-center justify-center rounded-xl px-3.5 py-2 text-[11px] font-semibold bg-sky-400 hover:bg-sky-300 text-slate-950 shadow-md shadow-sky-500/30 transition"
          >
            Send to Storehouse
          </button>
          <button
            type="button"
            onClick={() => result && onStartSession && onStartSession(result)}
            className="inline-flex items-center justify-center rounded-xl px-3.5 py-2 text-[11px] font-semibold bg-emerald-400 hover:bg-emerald-300 text-slate-950 shadow-md shadow-emerald-500/30 transition"
          >
            Start Butchery Session
          </button>
        </div>
      </div>
    </section>
  );
}

/**
 * Route component for Meat Breakdown Calculator.
 */
export default function MeatBreakdownCalculatorPage() {
  /** @type {[MeatBreakdownResult|null, React.Dispatch<React.SetStateAction<MeatBreakdownResult|null>>]} */
  const [result, setResult] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    document.title = "Meat Breakdown Calculator | Suka Smart Assistant";
  }, []);

  /**
   * Handler passed to MeatBreakdownCalculatorView.
   *
   * @param {Object} input - Calculator input data (animal type, weights, target cut ratios, etc.)
   */
  const handleCalculate = useCallback(async (input) => {
    setIsRunning(true);
    setError(null);

    try {
      const { result: calcResult } = await runCalculator(CALCULATOR_ID, input, {
        source: "pages.calculators.storehouseMeals.meat-breakdown",
        emitEvents: true,
      });

      if (!calcResult || typeof calcResult !== "object") {
        throw new Error(
          "Meat Breakdown calculator did not return a result object."
        );
      }

      /** @type {MeatBreakdownResult} */
      const normalized = {
        animalType:
          typeof calcResult.animalType === "string"
            ? calcResult.animalType
            : undefined,
        sourceLabel:
          typeof calcResult.sourceLabel === "string"
            ? calcResult.sourceLabel
            : undefined,
        liveWeightLb:
          typeof calcResult.liveWeightLb === "number"
            ? calcResult.liveWeightLb
            : undefined,
        carcassWeightLb:
          typeof calcResult.carcassWeightLb === "number"
            ? calcResult.carcassWeightLb
            : undefined,
        hangingLossPercent:
          typeof calcResult.hangingLossPercent === "number"
            ? calcResult.hangingLossPercent
            : undefined,
        totalEdibleLb:
          typeof calcResult.totalEdibleLb === "number"
            ? calcResult.totalEdibleLb
            : 0,
        totalEdiblePercent:
          typeof calcResult.totalEdiblePercent === "number"
            ? calcResult.totalEdiblePercent
            : 0,
        totalBoneLb:
          typeof calcResult.totalBoneLb === "number"
            ? calcResult.totalBoneLb
            : 0,
        totalBonePercent:
          typeof calcResult.totalBonePercent === "number"
            ? calcResult.totalBonePercent
            : 0,
        totalTrimLossLb:
          typeof calcResult.totalTrimLossLb === "number"
            ? calcResult.totalTrimLossLb
            : 0,
        totalTrimLossPercent:
          typeof calcResult.totalTrimLossPercent === "number"
            ? calcResult.totalTrimLossPercent
            : 0,
        cuts: Array.isArray(calcResult.cuts) ? calcResult.cuts : [],
        warnings: Array.isArray(calcResult.warnings) ? calcResult.warnings : [],
        notes: Array.isArray(calcResult.notes) ? calcResult.notes : [],
        meta: calcResult.meta || {},
      };

      setResult(normalized);
      emitMeatBreakdownCompleted(normalized);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        "[meat-breakdown.jsx] Meat Breakdown calculator error",
        err
      );
      setError(
        err && err.message
          ? err.message
          : "There was a problem running the Meat Breakdown calculator."
      );
    } finally {
      setIsRunning(false);
    }
  }, []);

  const handleStartSession = useCallback((breakdownResult) => {
    if (!breakdownResult) return;
    requestMeatBreakdownSession(breakdownResult);
  }, []);

  const handleStorehouseUpdate = useCallback((breakdownResult) => {
    if (!breakdownResult) return;
    requestStorehouseUpdate(breakdownResult);
  }, []);

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-slate-950/90 text-slate-50">
      <div className="mx-auto max-w-5xl px-4 py-6 lg:py-8">
        {/* Header */}
        <header className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-50">
              Meat Breakdown Calculator
            </h1>
            <p className="mt-1 text-sm text-slate-400 max-w-2xl">
              Plug in live weight, carcass weight, and your target cut ratios.
              SSA estimates how many pounds of each cut you&apos;ll bring into
              the storehouse so you can plan freezer space, meals, and future
              butchery sessions.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-900/80 px-3 py-1 border border-slate-700">
              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
              Feeds Storehouse &amp; Sessions
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-900/80 px-3 py-1 border border-slate-700">
              <span className="h-2 w-2 rounded-full bg-indigo-400" />
              Planning Graph Node
            </span>
          </div>
        </header>

        {/* Main card */}
        <main className="bg-slate-900/70 border border-slate-700 rounded-2xl shadow-xl p-4 lg:p-6">
          <MeatBreakdownCalculatorView
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

          <MeatBreakdownSummaryCard
            result={result}
            onStartSession={handleStartSession}
            onStorehouseUpdate={handleStorehouseUpdate}
          />
        </main>
      </div>
    </div>
  );
}
