// C:\Users\larho\suka-smart-assistant\src\pages\calculators\gardenAnimal\garden-yield.jsx

/**
 * Garden Yield Calculator Route
 *
 * How this fits SSA:
 * - Wraps GardenYieldCalculatorView with:
 *   • calculatorRunner wiring for consistent execution + logging
 *   • eventBus emissions so Planning Graph & automation can react
 *   • a summary card surfacing total yield, calories, and per-crop stats
 *   • CTAs to:
 *       - push yield expectations into Storehouse / Goals / Inventory
 *       - request a SessionRunner flow for harvest / processing
 *
 * Typical graph flow:
 *   - FROM: garden planting calendar, seed viability, storehouse goals
 *   - TO:   storehouse stock planning, preservation sessions,
 *           batch cooking planning, animal feed planning
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import eventBus from "@/services/eventBus";
import { familyFundMode } from "@/services/featureFlags";
import { runCalculator } from "@/services/calculators/calculatorRunner";
import GardenYieldCalculatorView from "@/features/calculators/gardenAnimal/GardenYieldCalculator.view";

const CALCULATOR_ID = "garden.yield";

/**
 * @typedef {Object} GardenYieldCropResult
 * @property {string} cropId
 * @property {string} cropName
 * @property {number} areaSqFt
 * @property {number} yieldLb
 * @property {number} [yieldKg]
 * @property {number} [caloriesTotal]
 * @property {number} [servingsTotal]
 * @property {string} [harvestWindowStart] // ISO date
 * @property {string} [harvestWindowEnd]   // ISO date
 * @property {string[]} [notes]
 */

/**
 * @typedef {Object} GardenYieldResult
 * @property {string} [seasonLabel]
 * @property {string} [locationLabel]
 * @property {string} [zone]
 * @property {number} [totalAreaSqFt]
 * @property {number} [totalYieldLb]
 * @property {number} [totalYieldKg]
 * @property {number} [totalCalories]
 * @property {number} [totalServings]
 * @property {GardenYieldCropResult[]} [crops]
 * @property {string[]} [warnings]
 * @property {string[]} [notes]
 * @property {string} [suggestedSessionTitle]
 * @property {Object<string, any>} [meta]
 */

/**
 * Safe numeric formatting helper.
 * @param {number | undefined | null} value
 * @param {number} [digits]
 * @returns {string}
 */
function safeNumber(value, digits = 1) {
  if (typeof value !== "number" || Number.isNaN(value)) return "0";
  return value.toFixed(digits);
}

/**
 * Emit completion event so analytics & automation can listen.
 * @param {GardenYieldResult} result
 */
function emitGardenYieldCompleted(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.gardenYield.completed",
      ts: new Date().toISOString(),
      source: "pages.calculators.gardenAnimal.garden-yield",
      data: {
        calculatorId: CALCULATOR_ID,
        result,
        familyFundMode: !!familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[garden-yield.jsx] Failed to emit calculator.gardenYield.completed",
      err
    );
  }
}

/**
 * Ask automation/runtime to create a harvest/processing SessionRunner flow.
 * @param {GardenYieldResult} result
 */
function requestHarvestSession(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;

    eventBus.emit({
      type: "calculator.gardenYield.session.requested",
      ts: new Date().toISOString(),
      source: "pages.calculators.gardenAnimal.garden-yield",
      data: {
        calculatorId: CALCULATOR_ID,
        domain: "garden",
        result,
        familyFundMode: !!familyFundMode,
        sessionHint: {
          title:
            result?.suggestedSessionTitle ||
            (result?.seasonLabel
              ? `Harvest & processing session for ${result.seasonLabel}`
              : "Garden harvest & processing session"),
          suggestedDomain: "garden",
          tags: ["garden", "harvest", "yield", "preservation"],
        },
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[garden-yield.jsx] Failed to emit calculator.gardenYield.session.requested",
      err
    );
  }
}

/**
 * Ask Storehouse / Goals planner to sync expected yields.
 * @param {GardenYieldResult} result
 */
function requestStorehouseSync(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;

    eventBus.emit({
      type: "calculator.gardenYield.storehouseSync.requested",
      ts: new Date().toISOString(),
      source: "pages.calculators.gardenAnimal.garden-yield",
      data: {
        calculatorId: CALCULATOR_ID,
        result,
        familyFundMode: !!familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[garden-yield.jsx] Failed to emit calculator.gardenYield.storehouseSync.requested",
      err
    );
  }
}

/**
 * Summary card for yield and storehouse-oriented next steps.
 *
 * @param {{
 *   result: GardenYieldResult | null,
 *   onStartSession: (r: GardenYieldResult) => void,
 *   onStorehouseSync: (r: GardenYieldResult) => void
 * }} props
 */
function GardenYieldSummaryCard({ result, onStartSession, onStorehouseSync }) {
  if (!result) return null;

  const {
    seasonLabel,
    locationLabel,
    zone,
    totalAreaSqFt,
    totalYieldLb,
    totalYieldKg,
    totalCalories,
    totalServings,
    crops,
    warnings,
    notes,
  } = result;

  const cropCount = Array.isArray(crops) ? crops.length : 0;

  const topCrops = useMemo(() => {
    if (!Array.isArray(crops)) return [];
    return [...crops]
      .sort((a, b) => (b.yieldLb || 0) - (a.yieldLb || 0))
      .slice(0, 4);
  }, [crops]);

  const labelSeason = seasonLabel || "Season not set";
  const labelLocation =
    locationLabel && zone ? `${locationLabel} · Zone ${zone}` : locationLabel || (zone ? `Zone ${zone}` : "Location not set");

  return (
    <section className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/75 px-4 py-4 space-y-3">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">
            Garden Yield Snapshot &amp; Storehouse Impact
          </h2>
          <p className="text-xs text-slate-400 mt-0.5 max-w-xl">
            SSA uses your beds, spacing, and varieties to estimate total yield,
            calories, and servings so you can see how far this season&apos;s
            garden will carry your household and where you may want extra
            plantings or purchases.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1 text-[10px] text-slate-300">
          <span className="px-2 py-1 rounded-full bg-slate-900 border border-slate-700 whitespace-nowrap">
            {labelSeason}
          </span>
          <span className="px-2 py-1 rounded-full bg-slate-900 border border-slate-700 whitespace-nowrap">
            {labelLocation}
          </span>
        </div>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Total Garden Area</span>
          <span className="text-slate-50 font-semibold">
            {safeNumber(totalAreaSqFt, 0)} sq ft
          </span>
          <span className="text-slate-500">
            Beds and spacing combined across all crops.
          </span>
        </div>

        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Total Yield</span>
          <span className="text-slate-50 font-semibold">
            {safeNumber(totalYieldLb, 1)} lb
            {typeof totalYieldKg === "number"
              ? ` · ${safeNumber(totalYieldKg, 1)} kg`
              : ""}
          </span>
          <span className="text-slate-500">
            Use this to plan freezer, canning, and cold storage.
          </span>
        </div>

        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Calories &amp; Servings</span>
          <span className="text-slate-50 font-semibold">
            {safeNumber(totalCalories || 0, 0)} kcal
          </span>
          <span className="text-slate-500">
            ≈ {safeNumber(totalServings || 0, 0)} servings of food.
          </span>
        </div>

        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Crops Tracked</span>
          <span className="text-slate-50 font-semibold">{cropCount}</span>
          <span className="text-slate-500">
            SSA keeps yields per crop for future seasons.
          </span>
        </div>
      </div>

      {Array.isArray(topCrops) && topCrops.length > 0 && (
        <div className="mt-1 text-[11px] text-slate-300">
          <p className="font-medium text-slate-100 mb-0.5">
            Top Yield Crops (by weight)
          </p>
          <div className="grid gap-2 md:grid-cols-2">
            {topCrops.map((c) => (
              <div
                key={c.cropId || c.cropName}
                className="rounded-xl border border-slate-800 bg-slate-900/80 px-3 py-2"
              >
                <p className="text-slate-100 font-semibold text-[11px]">
                  {c.cropName}
                </p>
                <p className="text-slate-400 text-[11px]">
                  {safeNumber(c.yieldLb, 1)} lb
                  {typeof c.yieldKg === "number"
                    ? ` · ${safeNumber(c.yieldKg, 1)} kg`
                    : ""}{" "}
                  from {safeNumber(c.areaSqFt, 0)} sq ft
                </p>
                {Array.isArray(c.notes) && c.notes.length > 0 && (
                  <p className="mt-1 text-[10px] text-slate-400">
                    {c.notes.join(" • ")}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {Array.isArray(warnings) && warnings.length > 0 && (
        <div className="mt-2 rounded-xl border border-amber-500/70 bg-amber-950/60 px-3 py-2 text-[11px] text-amber-100">
          <p className="font-medium mb-0.5">Warnings &amp; Uncertainties</p>
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
          Tip: Sync this yield plan to your Storehouse goals to find gaps, then
          schedule harvest and preservation sessions so peak harvests don&apos;t
          overwhelm your kitchen.
        </p>
        <div className="flex flex-wrap gap-2 justify-end">
          <button
            type="button"
            onClick={() =>
              result && onStorehouseSync && onStorehouseSync(result)
            }
            className="inline-flex items-center justify-center rounded-xl px-3.5 py-2 text-[11px] font-semibold bg-sky-400 hover:bg-sky-300 text-slate-950 shadow-md shadow-sky-500/30 transition"
          >
            Send to Storehouse Planner
          </button>
          <button
            type="button"
            onClick={() => result && onStartSession && onStartSession(result)}
            className="inline-flex items-center justify-center rounded-xl px-3.5 py-2 text-[11px] font-semibold bg-emerald-400 hover:bg-emerald-300 text-slate-950 shadow-md shadow-emerald-500/30 transition"
          >
            Plan Harvest Session
          </button>
        </div>
      </div>
    </section>
  );
}

/**
 * Route component for Garden Yield Calculator.
 */
export default function GardenYieldCalculatorPage() {
  /** @type {[GardenYieldResult|null, React.Dispatch<React.SetStateAction<GardenYieldResult|null>>]} */
  const [result, setResult] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    document.title = "Garden Yield Calculator | Suka Smart Assistant";
  }, []);

  /**
   * Handler passed to GardenYieldCalculatorView.
   * @param {Object} input - Calculator input (beds, crops, spacing, etc.)
   */
  const handleCalculate = useCallback(async (input) => {
    setIsRunning(true);
    setError(null);

    try {
      const { result: calcResult } = await runCalculator(
        CALCULATOR_ID,
        input,
        {
          source: "pages.calculators.gardenAnimal.garden-yield",
          emitEvents: true,
        }
      );

      if (!calcResult || typeof calcResult !== "object") {
        throw new Error(
          "Garden Yield calculator did not return a result object."
        );
      }

      /** @type {GardenYieldResult} */
      const normalized = {
        seasonLabel:
          typeof calcResult.seasonLabel === "string"
            ? calcResult.seasonLabel
            : undefined,
        locationLabel:
          typeof calcResult.locationLabel === "string"
            ? calcResult.locationLabel
            : undefined,
        zone:
          typeof calcResult.zone === "string" ? calcResult.zone : undefined,
        totalAreaSqFt:
          typeof calcResult.totalAreaSqFt === "number"
            ? calcResult.totalAreaSqFt
            : undefined,
        totalYieldLb:
          typeof calcResult.totalYieldLb === "number"
            ? calcResult.totalYieldLb
            : undefined,
        totalYieldKg:
          typeof calcResult.totalYieldKg === "number"
            ? calcResult.totalYieldKg
            : undefined,
        totalCalories:
          typeof calcResult.totalCalories === "number"
            ? calcResult.totalCalories
            : undefined,
        totalServings:
          typeof calcResult.totalServings === "number"
            ? calcResult.totalServings
            : undefined,
        crops: Array.isArray(calcResult.crops) ? calcResult.crops : [],
        warnings: Array.isArray(calcResult.warnings)
          ? calcResult.warnings
          : [],
        notes: Array.isArray(calcResult.notes) ? calcResult.notes : [],
        suggestedSessionTitle:
          typeof calcResult.suggestedSessionTitle === "string"
            ? calcResult.suggestedSessionTitle
            : undefined,
        meta: calcResult.meta || {},
      };

      setResult(normalized);
      emitGardenYieldCompleted(normalized);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        "[garden-yield.jsx] Garden Yield calculator error",
        err
      );
      setError(
        err && err.message
          ? err.message
          : "There was a problem running the Garden Yield calculator."
      );
    } finally {
      setIsRunning(false);
    }
  }, []);

  const handleStartSession = useCallback((yieldResult) => {
    if (!yieldResult) return;
    requestHarvestSession(yieldResult);
  }, []);

  const handleStorehouseSync = useCallback((yieldResult) => {
    if (!yieldResult) return;
    requestStorehouseSync(yieldResult);
  }, []);

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-slate-950/90 text-slate-50">
      <div className="mx-auto max-w-5xl px-4 py-6 lg:py-8">
        {/* Header */}
        <header className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-50">
              Garden Yield Calculator
            </h1>
            <p className="mt-1 text-sm text-slate-400 max-w-2xl">
              Estimate how much food your garden will actually produce this
              season. SSA converts beds and spacing into harvest weight,
              calories, and servings so you can balance garden plans with
              storehouse goals and preservation capacity.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-900/80 px-3 py-1 border border-slate-700">
              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
              Feeds Storehouse &amp; Preservation Planning
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-900/80 px-3 py-1 border border-slate-700">
              <span className="h-2 w-2 rounded-full bg-sky-400" />
              Harvest Sessions
            </span>
          </div>
        </header>

        {/* Main card */}
        <main className="bg-slate-900/70 border border-slate-700 rounded-2xl shadow-xl p-4 lg:p-6">
          <GardenYieldCalculatorView
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

          <GardenYieldSummaryCard
            result={result}
            onStartSession={handleStartSession}
            onStorehouseSync={handleStorehouseSync}
          />
        </main>
      </div>
    </div>
  );
}
