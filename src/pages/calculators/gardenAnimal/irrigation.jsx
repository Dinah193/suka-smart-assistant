// C:\Users\larho\suka-smart-assistant\src\pages\calculators\gardenAnimal\irrigation.jsx

/**
 * Irrigation Calculator Route
 *
 * How this fits SSA:
 * - Wraps IrrigationCalculatorView with:
 *   • calculatorRunner wiring so irrigation logic lives in one place
 *   • eventBus emissions so Garden Planner & Storehouse can react
 *   • a summary card surfacing per-zone runtime, gallons/day & schedule
 *   • CTAs to:
 *       - push schedule into Garden Planner (calendar/tasks)
 *       - sync water demand to Storehouse / utility planning
 *       - request a SessionRunner flow for “Water Garden Now”
 *
 * Typical graph flow:
 *   - FROM: garden layout, crop water needs, weather/ET data, soil type
 *   - TO:   watering sessions, calendar tasks, storehouse (hoses, timers),
 *           and power/water load planning for the homestead.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import eventBus from "@/services/events/eventBus";
import { familyFundMode } from "@/config/featureFlags";
import { runCalculator } from "@/services/calculators/calculatorRunner";
import IrrigationCalculatorView from "@/features/calculators/gardenAnimal/IrrigationCalculator.view.jsx";

const CALCULATOR_ID = "garden.irrigation";

/**
 * @typedef {Object} IrrigationZone
 * @property {string} id
 * @property {string} name
 * @property {number} areaSqFt
 * @property {number} [flowRateGpm]     // gallons per minute for this zone
 * @property {number} [minutesPerDay]   // suggested runtime per day
 * @property {number} [minutesPerRun]   // runtime per run if split
 * @property {number} [runsPerDay]
 * @property {string[]} [crops]         // labels, not IDs
 * @property {string[]} [notes]
 */

/**
 * @typedef {Object} IrrigationResult
 * @property {string} [seasonLabel]
 * @property {string} [locationLabel]
 * @property {string} [zoneLabel]           // e.g. USDA zone
 * @property {number} [totalAreaSqFt]
 * @property {number} [dailyInches]         // inches of water per day
 * @property {number} [weeklyInches]        // inches of water per week
 * @property {number} [dailyGallons]
 * @property {number} [weeklyGallons]
 * @property {IrrigationZone[]} [zones]
 * @property {string} [scheduleSummary]     // e.g. "2 runs/day, early AM + dusk"
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
 * @param {IrrigationResult} result
 */
function emitIrrigationCompleted(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.irrigation.completed",
      ts: new Date().toISOString(),
      source: "pages.calculators.gardenAnimal.irrigation",
      data: {
        calculatorId: CALCULATOR_ID,
        result,
        familyFundMode: !!familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[irrigation.jsx] Failed to emit calculator.irrigation.completed",
      err
    );
  }
}

/**
 * Request a SessionRunner watering session.
 * @param {IrrigationResult} result
 */
function requestIrrigationSession(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.irrigation.session.requested",
      ts: new Date().toISOString(),
      source: "pages.calculators.gardenAnimal.irrigation",
      data: {
        calculatorId: CALCULATOR_ID,
        domain: "garden",
        result,
        familyFundMode: !!familyFundMode,
        sessionHint: {
          title:
            result?.suggestedSessionTitle ||
            "Water garden zones according to schedule",
          suggestedDomain: "garden",
          tags: ["garden", "irrigation", "watering"],
        },
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[irrigation.jsx] Failed to emit calculator.irrigation.session.requested",
      err
    );
  }
}

/**
 * Ask Storehouse / utility planner to sync water + hardware needs.
 * @param {IrrigationResult} result
 */
function requestStorehouseSync(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.irrigation.storehouseSync.requested",
      ts: new Date().toISOString(),
      source: "pages.calculators.gardenAnimal.irrigation",
      data: {
        calculatorId: CALCULATOR_ID,
        result,
        familyFundMode: !!familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[irrigation.jsx] Failed to emit calculator.irrigation.storehouseSync.requested",
      err
    );
  }
}

/**
 * Ask Garden Planner to attach irrigation schedule to beds/zones.
 * @param {IrrigationResult} result
 */
function requestGardenPlannerSync(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.irrigation.gardenPlannerSync.requested",
      ts: new Date().toISOString(),
      source: "pages.calculators.gardenAnimal.irrigation",
      data: {
        calculatorId: CALCULATOR_ID,
        result,
        familyFundMode: !!familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[irrigation.jsx] Failed to emit calculator.irrigation.gardenPlannerSync.requested",
      err
    );
  }
}

/**
 * Summary card for irrigation results & next steps.
 *
 * @param {{
 *   result: IrrigationResult | null,
 *   onStartSession: (r: IrrigationResult) => void,
 *   onStorehouseSync: (r: IrrigationResult) => void,
 *   onGardenPlannerSync: (r: IrrigationResult) => void
 * }} props
 */
function IrrigationSummaryCard({
  result,
  onStartSession,
  onStorehouseSync,
  onGardenPlannerSync,
}) {
  if (!result) return null;

  const {
    seasonLabel,
    locationLabel,
    zoneLabel,
    totalAreaSqFt,
    dailyInches,
    weeklyInches,
    dailyGallons,
    weeklyGallons,
    zones,
    scheduleSummary,
    warnings,
    notes,
  } = result;

  const labelSeason = seasonLabel || "Season not set";
  const labelLocation =
    locationLabel && zoneLabel
      ? `${locationLabel} · Zone ${zoneLabel}`
      : locationLabel || (zoneLabel ? `Zone ${zoneLabel}` : "Location not set");

  const zoneCount = Array.isArray(zones) ? zones.length : 0;
  const topZones = useMemo(() => {
    if (!Array.isArray(zones)) return [];
    return [...zones].slice(0, 4);
  }, [zones]);

  return (
    <section className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/75 px-4 py-4 space-y-3">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">
            Irrigation Summary &amp; Next Steps
          </h2>
          <p className="text-xs text-slate-400 mt-0.5 max-w-xl">
            SSA translates plant water needs, soil type, and flow-rates into a
            simple runtime schedule per zone so you know how long to water, how
            often, and roughly how many gallons you&apos;re using each week.
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
          <span className="text-slate-400 mb-0.5">Total Area Covered</span>
          <span className="text-slate-50 font-semibold">
            {safeNumber(totalAreaSqFt, 0)} sq ft
          </span>
          <span className="text-slate-500">
            Sum of all zones included in this schedule.
          </span>
        </div>

        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Water Depth</span>
          <span className="text-slate-50 font-semibold">
            {safeNumber(dailyInches)} in/day · {safeNumber(weeklyInches)} in/wk
          </span>
          <span className="text-slate-500">
            Based on crop type, climate and soil.
          </span>
        </div>

        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Water Volume</span>
          <span className="text-slate-50 font-semibold">
            {safeNumber(dailyGallons, 0)} gal/day ·{" "}
            {safeNumber(weeklyGallons, 0)} gal/wk
          </span>
          <span className="text-slate-500">
            Useful for water budget &amp; storage planning.
          </span>
        </div>

        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Zones Scheduled</span>
          <span className="text-slate-50 font-semibold">{zoneCount}</span>
          <span className="text-slate-500">
            Drip lines, beds, or sprinkler sections.
          </span>
        </div>
      </div>

      {scheduleSummary && (
        <div className="text-[11px] text-emerald-100 rounded-xl border border-emerald-500/60 bg-emerald-950/60 px-3 py-2">
          <p className="font-medium mb-0.5">Recommended Schedule</p>
          <p className="leading-snug">{scheduleSummary}</p>
        </div>
      )}

      {topZones && topZones.length > 0 && (
        <div className="mt-1 text-[11px] text-slate-300">
          <p className="font-medium text-slate-100 mb-0.5">
            Per-Zone Runtime Highlights
          </p>
          <div className="grid gap-2 md:grid-cols-2">
            {topZones.map((z) => (
              <div
                key={z.id || z.name}
                className="rounded-xl border border-slate-800 bg-slate-900/80 px-3 py-2"
              >
                <p className="text-slate-100 font-semibold text-[11px]">
                  {z.name}
                </p>
                <p className="text-slate-400 text-[11px]">
                  {safeNumber(z.areaSqFt, 0)} sq ft ·{" "}
                  {safeNumber(z.flowRateGpm || 0, 1)} gpm
                </p>
                <p className="text-slate-400 text-[11px] mt-0.5">
                  {safeNumber(z.minutesPerDay || 0, 1)} min/day
                  {typeof z.runsPerDay === "number" &&
                    typeof z.minutesPerRun === "number" &&
                    ` (${safeNumber(z.runsPerDay, 1)} runs × ${safeNumber(
                      z.minutesPerRun,
                      1
                    )} min)`}
                </p>
                {Array.isArray(z.crops) && z.crops.length > 0 && (
                  <p className="mt-0.5 text-[10px] text-slate-400">
                    Crops: {z.crops.join(", ")}
                  </p>
                )}
                {Array.isArray(z.notes) && z.notes.length > 0 && (
                  <p className="mt-1 text-[10px] text-slate-400">
                    {z.notes.join(" • ")}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {Array.isArray(warnings) && warnings.length > 0 && (
        <div className="mt-2 rounded-xl border border-amber-500/70 bg-amber-950/60 px-3 py-2 text-[11px] text-amber-100">
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
          Tip: Once this schedule is synced to your Garden Planner, SSA can
          suggest “Water Now” sessions based on weather, evapotranspiration,
          quiet hours, and Sabbath/household rhythms.
        </p>
        <div className="flex flex-wrap gap-2 justify-end">
          <button
            type="button"
            onClick={() =>
              result && onGardenPlannerSync && onGardenPlannerSync(result)
            }
            className="inline-flex items-center justify-center rounded-xl px-3.5 py-2 text-[11px] font-semibold bg-indigo-400 hover:bg-indigo-300 text-slate-950 shadow-md shadow-indigo-500/30 transition"
          >
            Attach to Garden Planner
          </button>
          <button
            type="button"
            onClick={() =>
              result && onStorehouseSync && onStorehouseSync(result)
            }
            className="inline-flex items-center justify-center rounded-xl px-3.5 py-2 text-[11px] font-semibold bg-sky-400 hover:bg-sky-300 text-slate-950 shadow-md shadow-sky-500/30 transition"
          >
            Send to Storehouse / Water Budget
          </button>
          <button
            type="button"
            onClick={() => result && onStartSession && onStartSession(result)}
            className="inline-flex items-center justify-center rounded-xl px-3.5 py-2 text-[11px] font-semibold bg-emerald-400 hover:bg-emerald-300 text-slate-950 shadow-md shadow-emerald-500/30 transition"
          >
            Plan Watering Session
          </button>
        </div>
      </div>
    </section>
  );
}

/**
 * Route component for Irrigation Calculator.
 */
export default function IrrigationCalculatorPage() {
  /** @type {[IrrigationResult|null, React.Dispatch<React.SetStateAction<IrrigationResult|null>>]} */
  const [result, setResult] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    document.title = "Irrigation Calculator | Suka Smart Assistant";
  }, []);

  /**
   * Handler passed to IrrigationCalculatorView.
   * @param {Object} input - Calculator input (zones, crops, climate, etc.)
   */
  const handleCalculate = useCallback(async (input) => {
    setIsRunning(true);
    setError(null);

    try {
      const { result: calcResult } = await runCalculator(CALCULATOR_ID, input, {
        source: "pages.calculators.gardenAnimal.irrigation",
        emitEvents: true,
      });

      if (!calcResult || typeof calcResult !== "object") {
        throw new Error(
          "Irrigation calculator did not return a result object."
        );
      }

      /** @type {IrrigationResult} */
      const normalized = {
        seasonLabel:
          typeof calcResult.seasonLabel === "string"
            ? calcResult.seasonLabel
            : undefined,
        locationLabel:
          typeof calcResult.locationLabel === "string"
            ? calcResult.locationLabel
            : undefined,
        zoneLabel:
          typeof calcResult.zoneLabel === "string"
            ? calcResult.zoneLabel
            : undefined,
        totalAreaSqFt:
          typeof calcResult.totalAreaSqFt === "number"
            ? calcResult.totalAreaSqFt
            : undefined,
        dailyInches:
          typeof calcResult.dailyInches === "number"
            ? calcResult.dailyInches
            : undefined,
        weeklyInches:
          typeof calcResult.weeklyInches === "number"
            ? calcResult.weeklyInches
            : undefined,
        dailyGallons:
          typeof calcResult.dailyGallons === "number"
            ? calcResult.dailyGallons
            : undefined,
        weeklyGallons:
          typeof calcResult.weeklyGallons === "number"
            ? calcResult.weeklyGallons
            : undefined,
        zones: Array.isArray(calcResult.zones) ? calcResult.zones : [],
        scheduleSummary:
          typeof calcResult.scheduleSummary === "string"
            ? calcResult.scheduleSummary
            : undefined,
        warnings: Array.isArray(calcResult.warnings) ? calcResult.warnings : [],
        notes: Array.isArray(calcResult.notes) ? calcResult.notes : [],
        suggestedSessionTitle:
          typeof calcResult.suggestedSessionTitle === "string"
            ? calcResult.suggestedSessionTitle
            : undefined,
        meta: calcResult.meta || {},
      };

      setResult(normalized);
      emitIrrigationCompleted(normalized);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[irrigation.jsx] Irrigation calculator error", err);
      setError(
        err && err.message
          ? err.message
          : "There was a problem running the Irrigation calculator."
      );
    } finally {
      setIsRunning(false);
    }
  }, []);

  const handleStartSession = useCallback((irrResult) => {
    if (!irrResult) return;
    requestIrrigationSession(irrResult);
  }, []);

  const handleStorehouseSync = useCallback((irrResult) => {
    if (!irrResult) return;
    requestStorehouseSync(irrResult);
  }, []);

  const handleGardenPlannerSync = useCallback((irrResult) => {
    if (!irrResult) return;
    requestGardenPlannerSync(irrResult);
  }, []);

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-slate-950/90 text-slate-50">
      <div className="mx-auto max-w-5xl px-4 py-6 lg:py-8">
        {/* Header */}
        <header className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-50">
              Irrigation Calculator
            </h1>
            <p className="mt-1 text-sm text-slate-400 max-w-2xl">
              Design a practical watering schedule for each garden zone. SSA
              uses crop needs, soil, and climate assumptions to estimate inches
              of water, gallons per day/week, and per-zone runtime you can feed
              into Garden Planner, Storehouse, and SessionRunner.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-900/80 px-3 py-1 border border-slate-700">
              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
              Feeds Garden Planner &amp; Water Sessions
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-900/80 px-3 py-1 border border-slate-700">
              <span className="h-2 w-2 rounded-full bg-sky-400" />
              Storehouse &amp; Water Budget
            </span>
          </div>
        </header>

        {/* Main card */}
        <main className="bg-slate-900/70 border border-slate-700 rounded-2xl shadow-xl p-4 lg:p-6">
          <IrrigationCalculatorView
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

          <IrrigationSummaryCard
            result={result}
            onStartSession={handleStartSession}
            onStorehouseSync={handleStorehouseSync}
            onGardenPlannerSync={handleGardenPlannerSync}
          />
        </main>
      </div>
    </div>
  );
}
