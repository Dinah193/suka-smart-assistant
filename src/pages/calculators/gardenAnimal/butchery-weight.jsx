// C:\Users\larho\suka-smart-assistant\src\pages\calculators\gardenAnimal\butchery-weight.jsx

/**
 * Butchery Weight Calculator Route
 *
 * How this fits SSA:
 * - Wraps ButcheryWeightCalculatorView and:
 *   • centralizes computation through calculatorRunner
 *   • emits events for Meat Breakdown, Storehouse Meat Inventory,
 *     Freezer Space, and Cost-per-Serving planning
 *   • surfaces a clear yield summary card for one or more animals
 *
 * Planning Graph links:
 *   FROM:
 *     - Animal inventory (species, live weight, count)
 *     - Selected butchery profile (bone-in vs boneless, trim level)
 *   TO:
 *     - StorehouseMeat: meat-breakdown, freezer-space, cost-per-serving
 *     - Animal Planner: harvest scheduling & replenishment
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import eventBus from "@/services/events/eventBus";
import { familyFundMode } from "@/config/featureFlags";
import { runCalculator } from "@/services/calculators/calculatorRunner";
import ButcheryWeightCalculatorView from "@/features/calculators/gardenAnimal/ButcheryWeightCalculator/ButcheryWeightCalculator.view.jsx";

const CALCULATOR_ID = "gardenAnimal.butcheryWeight";

/**
 * @typedef {Object} AnimalCarcassInput
 * @property {string} id
 * @property {string} species         // "lamb" | "goat" | "beef" | "hog" | "poultry" | etc.
 * @property {number} liveWeightLb
 * @property {number} [count]
 * @property {string} [butcheryProfile] // "bone-in", "boneless", "grind-heavy", etc.
 */

/**
 * @typedef {Object} YieldByCut
 * @property {string} cutId
 * @property {string} label
 * @property {number} weightLb
 * @property {number} percentOfCarcass // 0..100
 * @property {string} [storageLocation] // e.g. "Freezer A | Shelf 2"
 * @property {string} [useCase]         // "roast", "ground", "stew", etc.
 */

/**
 * @typedef {Object} ButcheryWeightResult
 * @property {AnimalCarcassInput[]} [animals]
 * @property {number} [totalLiveWeightLb]
 * @property {number} [dressingPercent]
 * @property {number} [hangingWeightLb]
 * @property {number} [cutoutPercent]
 * @property {number} [packagedWeightLb]
 * @property {number} [boneWeightLb]
 * @property {number} [fatTrimWeightLb]
 * @property {YieldByCut[]} [yieldByCut]
 * @property {number} [avgYieldPercentPerAnimal]
 * @property {number} [animalsCounted]
 * @property {string} [profileLabel]
 * @property {string} [recommendedAction]
 * @property {string[]} [warnings]
 * @property {string[]} [notes]
 * @property {Object<string, any>} [meta]
 */

/**
 * Safe number formatting helper.
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
 * @param {ButcheryWeightResult} result
 */
function emitButcheryWeightCompleted(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.butcheryWeight.completed",
      ts: new Date().toISOString(),
      source: "pages.calculators.gardenAnimal.butchery-weight",
      data: {
        calculatorId: CALCULATOR_ID,
        result,
        familyFundMode: !!familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[butchery-weight.jsx] Failed to emit calculator.butcheryWeight.completed",
      err
    );
  }
}

/**
 * Ask Storehouse / meat inventory to record packaged weights by cut.
 * @param {ButcheryWeightResult} result
 */
function requestStorehouseMeatSync(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.butcheryWeight.storehouseMeatSync.requested",
      ts: new Date().toISOString(),
      source: "pages.calculators.gardenAnimal.butchery-weight",
      data: {
        calculatorId: CALCULATOR_ID,
        result,
        familyFundMode: !!familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[butchery-weight.jsx] Failed to emit calculator.butcheryWeight.storehouseMeatSync.requested",
      err
    );
  }
}

/**
 * Ask Freezer Space planning to update used/available capacity.
 * @param {ButcheryWeightResult} result
 */
function requestFreezerSpaceSync(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.butcheryWeight.freezerSpaceSync.requested",
      ts: new Date().toISOString(),
      source: "pages.calculators.gardenAnimal.butchery-weight",
      data: {
        calculatorId: CALCULATOR_ID,
        result,
        familyFundMode: !!familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[butchery-weight.jsx] Failed to emit calculator.butcheryWeight.freezerSpaceSync.requested",
      err
    );
  }
}

/**
 * Ask Cost-per-Serving calculator to map these yields to meals.
 * @param {ButcheryWeightResult} result
 */
function requestCostPerServingSync(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.butcheryWeight.costPerServingSync.requested",
      ts: new Date().toISOString(),
      source: "pages.calculators.gardenAnimal.butchery-weight",
      data: {
        calculatorId: CALCULATOR_ID,
        result,
        familyFundMode: !!familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[butchery-weight.jsx] Failed to emit calculator.butcheryWeight.costPerServingSync.requested",
      err
    );
  }
}

/**
 * Ask batch / session planner to schedule butchery & packaging sessions.
 * @param {ButcheryWeightResult} result
 */
function requestSessionPlannerSync(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.butcheryWeight.sessionPlannerSync.requested",
      ts: new Date().toISOString(),
      source: "pages.calculators.gardenAnimal.butchery-weight",
      data: {
        calculatorId: CALCULATOR_ID,
        result,
        familyFundMode: !!familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[butchery-weight.jsx] Failed to emit calculator.butcheryWeight.sessionPlannerSync.requested",
      err
    );
  }
}

/**
 * Build a compact animal summary label for header.
 * @param {AnimalCarcassInput[] | undefined} animals
 */
function buildAnimalLabel(animals) {
  if (!Array.isArray(animals) || animals.length === 0)
    return "Selected animals";
  const bySpecies = animals.reduce((acc, a) => {
    if (!a || !a.species) return acc;
    const key = a.species.toLowerCase();
    const count = a.count && a.count > 0 ? a.count : 1;
    acc[key] = (acc[key] || 0) + count;
    return acc;
  }, {});
  const parts = Object.entries(bySpecies).map(([species, count]) => {
    return `${count}× ${species}`;
  });
  return parts.join(" · ");
}

/**
 * Summary card for Butchery Weight results & follow-ups.
 *
 * @param {{
 *   result: ButcheryWeightResult | null,
 *   onStorehouseSync: (r: ButcheryWeightResult) => void,
 *   onFreezerSpaceSync: (r: ButcheryWeightResult) => void,
 *   onCostPerServingSync: (r: ButcheryWeightResult) => void,
 *   onSessionPlannerSync: (r: ButcheryWeightResult) => void
 * }} props
 */
function ButcheryWeightSummaryCard({
  result,
  onStorehouseSync,
  onFreezerSpaceSync,
  onCostPerServingSync,
  onSessionPlannerSync,
}) {
  if (!result) return null;

  const {
    animals,
    totalLiveWeightLb,
    dressingPercent,
    hangingWeightLb,
    cutoutPercent,
    packagedWeightLb,
    boneWeightLb,
    fatTrimWeightLb,
    yieldByCut,
    avgYieldPercentPerAnimal,
    animalsCounted,
    profileLabel,
    recommendedAction,
    warnings,
    notes,
  } = result;

  const herdLabel = useMemo(() => buildAnimalLabel(animals), [animals]);

  const yieldBadge = useMemo(() => {
    if (typeof cutoutPercent === "number" && cutoutPercent > 0) {
      let tone =
        "bg-emerald-500/15 border-emerald-400 text-emerald-200 shadow-emerald-500/30";
      if (cutoutPercent < 45) {
        tone =
          "bg-amber-500/15 border-amber-400 text-amber-100 shadow-amber-500/30";
      }
      if (cutoutPercent < 38) {
        tone =
          "bg-rose-500/15 border-rose-400 text-rose-100 shadow-rose-500/30";
      }
      return {
        text: `Overall yield: ${safeNumber(cutoutPercent, 1)}% packaged`,
        className: tone,
      };
    }
    return {
      text: "Overall yield estimate",
      className:
        "bg-slate-600/15 border-slate-400 text-slate-200 shadow-slate-600/30",
    };
  }, [cutoutPercent]);

  const animalsSummary = useMemo(() => {
    if (!animalsCounted && !animals?.length) return "Animals in batch";
    return `${animalsCounted || animals?.length || 0} animals in this batch`;
  }, [animals, animalsCounted]);

  const topCuts =
    Array.isArray(yieldByCut) && yieldByCut.length > 0
      ? yieldByCut
          .slice()
          .sort((a, b) => (b.weightLb || 0) - (a.weightLb || 0))
          .slice(0, 3)
      : [];

  return (
    <section className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/75 px-4 py-4 space-y-3">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">
            Butchery Yield Summary &amp; Next Steps
          </h2>
          <p className="text-xs text-slate-400 mt-0.5 max-w-xl">
            SSA shows how your live weight translates into hanging and packaged
            weights so you can label cuts, update the storehouse, and plan
            freezer space and meals without guesswork.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1 text-[10px] text-slate-300">
          <span className="px-2 py-1 rounded-full bg-slate-900 border border-slate-700 whitespace-nowrap">
            {herdLabel}
          </span>
          {profileLabel && (
            <span className="px-2 py-1 rounded-full bg-slate-900 border border-slate-700 whitespace-nowrap">
              {profileLabel}
            </span>
          )}
        </div>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Total Live Weight</span>
          <span className="text-slate-50 font-semibold">
            {safeNumber(totalLiveWeightLb, 1)} lb
          </span>
          <span className="text-slate-500">{animalsSummary}</span>
        </div>

        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">
            Hanging &amp; Packaged Weight
          </span>
          <span className="text-slate-50 font-semibold">
            {safeNumber(hangingWeightLb, 1)} lb hanging ·{" "}
            {safeNumber(packagedWeightLb, 1)} lb packaged
          </span>
          <span className="text-slate-500">
            Dressing: {safeNumber(dressingPercent, 1)}% · Cutout:{" "}
            {safeNumber(cutoutPercent, 1)}%
          </span>
        </div>

        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Bone &amp; Fat Trim</span>
          <span className="text-slate-50 font-semibold">
            {safeNumber(boneWeightLb, 1)} lb bone ·{" "}
            {safeNumber(fatTrimWeightLb, 1)} lb fat/trim
          </span>
          <span className="text-slate-500">
            Keep, render, or compost based on your preferences.
          </span>
        </div>

        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">
            Avg Yield per Animal (packaged)
          </span>
          <span className="text-slate-50 font-semibold">
            {safeNumber(avgYieldPercentPerAnimal, 1)}%
          </span>
          <span className="text-slate-500">
            Compare different breeds, feeding plans, and butchery profiles.
          </span>
        </div>
      </div>

      <div
        className={`text-[11px] rounded-xl border px-3 py-2 shadow-sm ${yieldBadge.className}`}
      >
        <p className="font-medium mb-0.5">{yieldBadge.text}</p>
        <p className="leading-snug">
          This is the ratio of packaged meat to live weight across the entire
          batch. Use it as a quick gut-check for future planning and to refine
          your expectations for upcoming harvests.
        </p>
        {recommendedAction && (
          <p className="mt-0.5 text-[10px] opacity-90">{recommendedAction}</p>
        )}
      </div>

      {topCuts.length > 0 && (
        <div className="mt-1 text-[11px] text-slate-300">
          <p className="font-medium mb-0.5">Top yielding cuts in this batch</p>
          <div className="flex flex-wrap gap-2">
            {topCuts.map((cut) => (
              <div
                key={cut.cutId}
                className="px-2 py-1 rounded-lg bg-slate-900 border border-slate-700"
              >
                <span className="font-semibold">{cut.label}</span>
                <span className="mx-1 text-slate-500">·</span>
                <span>
                  {safeNumber(cut.weightLb, 1)} lb (
                  {safeNumber(cut.percentOfCarcass, 1)}%)
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {Array.isArray(warnings) && warnings.length > 0 && (
        <div className="mt-1 rounded-xl border border-amber-500/70 bg-amber-950/60 px-3 py-2 text-[11px] text-amber-100">
          <p className="font-medium mb-0.5">Warnings &amp; Notes</p>
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
          Tip: Once these yields are pushed into Storehouse and Freezer Space,
          SSA can auto-suggest batch cooking sessions and cost-per-serving
          breakdowns that fully respect what&apos;s actually on your shelves.
        </p>
        <div className="flex flex-wrap gap-2 justify-end">
          <button
            type="button"
            onClick={() =>
              result && onStorehouseSync && onStorehouseSync(result)
            }
            className="inline-flex items-center justify-center rounded-xl px-3.5 py-2 text-[11px] font-semibold bg-sky-400 hover:bg-sky-300 text-slate-950 shadow-md shadow-sky-500/30 transition"
          >
            Update Meat Inventory
          </button>
          <button
            type="button"
            onClick={() =>
              result && onFreezerSpaceSync && onFreezerSpaceSync(result)
            }
            className="inline-flex items-center justify-center rounded-xl px-3.5 py-2 text-[11px] font-semibold bg-indigo-400 hover:bg-indigo-300 text-slate-950 shadow-md shadow-indigo-500/30 transition"
          >
            Sync Freezer Space
          </button>
          <button
            type="button"
            onClick={() =>
              result && onCostPerServingSync && onCostPerServingSync(result)
            }
            className="inline-flex items-center justify-center rounded-xl px-3.5 py-2 text-[11px] font-semibold bg-emerald-400 hover:bg-emerald-300 text-slate-950 shadow-md shadow-emerald-500/30 transition"
          >
            Link to Cost-Per-Serving
          </button>
          <button
            type="button"
            onClick={() =>
              result && onSessionPlannerSync && onSessionPlannerSync(result)
            }
            className="inline-flex items-center justify-center rounded-xl px-3.5 py-2 text-[11px] font-semibold bg-amber-400 hover:bg-amber-300 text-slate-950 shadow-md shadow-amber-500/30 transition"
          >
            Plan Butchery Sessions
          </button>
        </div>
      </div>
    </section>
  );
}

/**
 * Route component for Butchery Weight Calculator.
 */
export default function ButcheryWeightCalculatorPage() {
  /** @type {[ButcheryWeightResult|null, React.Dispatch<React.SetStateAction<ButcheryWeightResult|null>>]} */
  const [result, setResult] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    document.title = "Butchery Weight Calculator | Suka Smart Assistant";
  }, []);

  /**
   * Handler passed to ButcheryWeightCalculatorView.
   * @param {Object} input - Calculator input (animals, weights, profiles, etc.)
   */
  const handleCalculate = useCallback(async (input) => {
    setIsRunning(true);
    setError(null);

    try {
      const { result: calcResult } = await runCalculator(CALCULATOR_ID, input, {
        source: "pages.calculators.gardenAnimal.butchery-weight",
        emitEvents: true,
      });

      if (!calcResult || typeof calcResult !== "object") {
        throw new Error(
          "Butchery Weight calculator did not return a result object."
        );
      }

      /** @type {ButcheryWeightResult} */
      const normalized = {
        animals: Array.isArray(calcResult.animals) ? calcResult.animals : [],
        totalLiveWeightLb:
          typeof calcResult.totalLiveWeightLb === "number"
            ? calcResult.totalLiveWeightLb
            : undefined,
        dressingPercent:
          typeof calcResult.dressingPercent === "number"
            ? calcResult.dressingPercent
            : undefined,
        hangingWeightLb:
          typeof calcResult.hangingWeightLb === "number"
            ? calcResult.hangingWeightLb
            : undefined,
        cutoutPercent:
          typeof calcResult.cutoutPercent === "number"
            ? calcResult.cutoutPercent
            : undefined,
        packagedWeightLb:
          typeof calcResult.packagedWeightLb === "number"
            ? calcResult.packagedWeightLb
            : undefined,
        boneWeightLb:
          typeof calcResult.boneWeightLb === "number"
            ? calcResult.boneWeightLb
            : undefined,
        fatTrimWeightLb:
          typeof calcResult.fatTrimWeightLb === "number"
            ? calcResult.fatTrimWeightLb
            : undefined,
        yieldByCut: Array.isArray(calcResult.yieldByCut)
          ? calcResult.yieldByCut
          : [],
        avgYieldPercentPerAnimal:
          typeof calcResult.avgYieldPercentPerAnimal === "number"
            ? calcResult.avgYieldPercentPerAnimal
            : undefined,
        animalsCounted:
          typeof calcResult.animalsCounted === "number"
            ? calcResult.animalsCounted
            : undefined,
        profileLabel:
          typeof calcResult.profileLabel === "string"
            ? calcResult.profileLabel
            : undefined,
        recommendedAction:
          typeof calcResult.recommendedAction === "string"
            ? calcResult.recommendedAction
            : undefined,
        warnings: Array.isArray(calcResult.warnings) ? calcResult.warnings : [],
        notes: Array.isArray(calcResult.notes) ? calcResult.notes : [],
        meta: calcResult.meta || {},
      };

      setResult(normalized);
      emitButcheryWeightCompleted(normalized);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        "[butchery-weight.jsx] Butchery Weight calculator error",
        err
      );
      setError(
        err && err.message
          ? err.message
          : "There was a problem running the Butchery Weight calculator."
      );
    } finally {
      setIsRunning(false);
    }
  }, []);

  const handleStorehouseSync = useCallback((bwResult) => {
    if (!bwResult) return;
    requestStorehouseMeatSync(bwResult);
  }, []);

  const handleFreezerSpaceSync = useCallback((bwResult) => {
    if (!bwResult) return;
    requestFreezerSpaceSync(bwResult);
  }, []);

  const handleCostPerServingSync = useCallback((bwResult) => {
    if (!bwResult) return;
    requestCostPerServingSync(bwResult);
  }, []);

  const handleSessionPlannerSync = useCallback((bwResult) => {
    if (!bwResult) return;
    requestSessionPlannerSync(bwResult);
  }, []);

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-slate-950/90 text-slate-50">
      <div className="mx-auto max-w-5xl px-4 py-6 lg:py-8">
        {/* Header */}
        <header className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-50">
              Butchery Weight Calculator
            </h1>
            <p className="mt-1 text-sm text-slate-400 max-w-2xl">
              Convert live animal weights into realistic hanging and packaged
              yields for each batch so you can label cuts, update meat
              inventory, plan freezer space, and estimate meal counts with
              confidence.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-900/80 px-3 py-1 border border-slate-700">
              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
              Feeds Meat Breakdown &amp; Storehouse
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-900/80 px-3 py-1 border border-slate-700">
              <span className="h-2 w-2 rounded-full bg-sky-400" />
              Freezer Space Planner
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-900/80 px-3 py-1 border border-slate-700">
              <span className="h-2 w-2 rounded-full bg-amber-400" />
              Cost-Per-Serving &amp; Batch Sessions
            </span>
          </div>
        </header>

        {/* Main card */}
        <main className="bg-slate-900/70 border border-slate-700 rounded-2xl shadow-xl p-4 lg:p-6">
          <ButcheryWeightCalculatorView
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

          <ButcheryWeightSummaryCard
            result={result}
            onStorehouseSync={handleStorehouseSync}
            onFreezerSpaceSync={handleFreezerSpaceSync}
            onCostPerServingSync={handleCostPerServingSync}
            onSessionPlannerSync={handleSessionPlannerSync}
          />
        </main>
      </div>
    </div>
  );
}
