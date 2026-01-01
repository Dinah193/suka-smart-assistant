// C:\Users\larho\suka-smart-assistant\src\pages\calculators\gardenAnimal\garden-planting-calendar.jsx

/**
 * Garden Planting Calendar Calculator Route
 *
 * How this fits SSA:
 * - Wraps GardenPlantingCalendarCalculatorView with:
 *   • calculatorRunner wiring for consistent execution + logging
 *   • eventBus emissions so Planning Graph & automation can react
 *   • a summary card that surfaces planting windows, zones, and
 *     what should be started indoors vs. direct-sown
 *   • CTAs to:
 *       - push recommended dates into Garden Planner / Calendar
 *       - request a SessionRunner flow to guide planting day
 *
 * Typical graph flow:
 *   - FROM: macro/micro calculators, storehouse goals, seed viability
 *   - TO:   garden planning, animal feed planning, harvest logging, sessions
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import eventBus from "@/services/eventBus";
import { familyFundMode } from "@/services/featureFlags";
import { runCalculator } from "@/services/calculators/calculatorRunner";
import GardenPlantingCalendarCalculatorView from "@/features/calculators/gardenAnimal/GardenPlantingCalendarCalculator.view";

const CALCULATOR_ID = "garden.plantingCalendar";

/**
 * @typedef {Object} PlantingWindow
 * @property {string} cropId
 * @property {string} cropName
 * @property {string} method         // "directSow" | "transplant" | "succession" | string
 * @property {string} startDate      // ISO date
 * @property {string} endDate        // ISO date
 * @property {string} [notes]
 * @property {number} [priority]     // higher = more important/urgent
 */

/**
 * @typedef {Object} PlantingCalendarResult
 * @property {string} [zone]                  // USDA/other planting zone
 * @property {string} [locationLabel]        // Human-readable location
 * @property {string} [frostLastDate]        // ISO date
 * @property {string} [frostFirstDate]       // ISO date
 * @property {string} [seasonLabel]          // "Spring 2026", etc.
 * @property {PlantingWindow[]} [windows]
 * @property {string[]} [indoorStarts]       // Crop names best started indoors
 * @property {string[]} [directSow]          // Crop names best direct sown
 * @property {string[]} [successionCrops]    // Crop names with multiple plantings
 * @property {string[]} [warnings]
 * @property {string[]} [notes]
 * @property {string} [suggestedSessionTitle]
 * @property {Object<string, any>} [meta]
 */

/**
 * Small helper – safe label formatting.
 * @param {string | undefined | null} value
 * @returns {string}
 */
function safeLabel(value) {
  if (!value || typeof value !== "string") return "Not set";
  return value;
}

/**
 * Emit completion event so analytics & automation can listen.
 * @param {PlantingCalendarResult} result
 */
function emitPlantingCalendarCompleted(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.gardenPlantingCalendar.completed",
      ts: new Date().toISOString(),
      source: "pages.calculators.gardenAnimal.garden-planting-calendar",
      data: {
        calculatorId: CALCULATOR_ID,
        result,
        familyFundMode: !!familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[garden-planting-calendar.jsx] Failed to emit calculator.gardenPlantingCalendar.completed",
      err
    );
  }
}

/**
 * Ask automation/runtime to create a planting SessionRunner flow.
 * @param {PlantingCalendarResult} result
 */
function requestPlantingSession(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;

    eventBus.emit({
      type: "calculator.gardenPlantingCalendar.session.requested",
      ts: new Date().toISOString(),
      source: "pages.calculators.gardenAnimal.garden-planting-calendar",
      data: {
        calculatorId: CALCULATOR_ID,
        domain: "garden",
        result,
        familyFundMode: !!familyFundMode,
        sessionHint: {
          title:
            result?.suggestedSessionTitle ||
            (result?.seasonLabel
              ? `Planting session for ${result.seasonLabel}`
              : "Garden planting session"),
          suggestedDomain: "garden",
          tags: ["garden", "planting", "calendar"],
        },
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[garden-planting-calendar.jsx] Failed to emit calculator.gardenPlantingCalendar.session.requested",
      err
    );
  }
}

/**
 * Ask Garden Planner / Calendar to sync the recommended windows.
 * @param {PlantingCalendarResult} result
 */
function requestGardenPlannerSync(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;

    eventBus.emit({
      type: "calculator.gardenPlantingCalendar.gardenPlannerSync.requested",
      ts: new Date().toISOString(),
      source: "pages.calculators.gardenAnimal.garden-planting-calendar",
      data: {
        calculatorId: CALCULATOR_ID,
        result,
        familyFundMode: !!familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[garden-planting-calendar.jsx] Failed to emit calculator.gardenPlantingCalendar.gardenPlannerSync.requested",
      err
    );
  }
}

/**
 * Summary card for planting windows and quick next steps.
 *
 * @param {{
 *   result: PlantingCalendarResult | null,
 *   onStartSession: (r: PlantingCalendarResult) => void,
 *   onGardenPlannerSync: (r: PlantingCalendarResult) => void
 * }} props
 */
function PlantingSummaryCard({ result, onStartSession, onGardenPlannerSync }) {
  if (!result) return null;

  const {
    zone,
    locationLabel,
    frostLastDate,
    frostFirstDate,
    seasonLabel,
    windows,
    indoorStarts,
    directSow,
    successionCrops,
    warnings,
    notes,
  } = result;

  const totalCrops = useMemo(() => {
    if (!Array.isArray(windows)) return 0;
    const set = new Set(windows.map((w) => w.cropId || w.cropName));
    return set.size;
  }, [windows]);

  const upcomingWindows = useMemo(() => {
    if (!Array.isArray(windows)) return [];
    const today = new Date().toISOString().slice(0, 10);
    return windows
      .filter((w) => w.startDate && w.startDate >= today)
      .sort((a, b) => (a.startDate || "").localeCompare(b.startDate || ""))
      .slice(0, 5);
  }, [windows]);

  return (
    <section className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/75 px-4 py-4 space-y-3">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">
            Season Snapshot &amp; Next Plantings
          </h2>
          <p className="text-xs text-slate-400 mt-0.5 max-w-xl">
            SSA combined your location, zone, and frost dates to map out when
            to start seeds indoors and when to direct sow outside. Use this
            summary to schedule real planting sessions and sync with your
            Garden Planner.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1 text-[10px] text-slate-300">
          <span className="px-2 py-1 rounded-full bg-slate-900 border border-slate-700 whitespace-nowrap">
            {safeLabel(seasonLabel)}
          </span>
          <span className="px-2 py-1 rounded-full bg-slate-900 border border-slate-700 whitespace-nowrap">
            Zone {safeLabel(zone)} · {safeLabel(locationLabel)}
          </span>
        </div>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Frost Dates</span>
          <span className="text-slate-50 font-semibold">
            Last: {safeLabel(frostLastDate)}
          </span>
          <span className="text-slate-50 font-semibold">
            First: {safeLabel(frostFirstDate)}
          </span>
        </div>

        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Crops in Plan</span>
          <span className="text-slate-50 font-semibold">{totalCrops}</span>
          <span className="text-slate-500">
            Structured planting calendar, not just dates.
          </span>
        </div>

        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Indoor Starts</span>
          <span className="text-slate-50 font-semibold">
            {Array.isArray(indoorStarts) ? indoorStarts.length : 0}
          </span>
          <span className="text-slate-500">
            Great for seed-starting sessions and grow lights.
          </span>
        </div>

        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Succession Crops</span>
          <span className="text-slate-50 font-semibold">
            {Array.isArray(successionCrops) ? successionCrops.length : 0}
          </span>
          <span className="text-slate-500">
            Multiple sowings for steady harvests.
          </span>
        </div>
      </div>

      {Array.isArray(upcomingWindows) && upcomingWindows.length > 0 && (
        <div className="mt-1 text-[11px] text-slate-300">
          <p className="font-medium text-slate-100 mb-0.5">
            Upcoming Planting Windows
          </p>
          <div className="grid gap-2 md:grid-cols-2">
            {upcomingWindows.map((w) => (
              <div
                key={`${w.cropId || w.cropName}-${w.startDate}-${w.method}`}
                className="rounded-xl border border-slate-800 bg-slate-900/80 px-3 py-2"
              >
                <p className="text-slate-100 font-semibold text-[11px]">
                  {w.cropName}{" "}
                  <span className="text-slate-400">
                    ({w.method === "directSow"
                      ? "Direct sow"
                      : w.method === "transplant"
                      ? "Transplant"
                      : w.method === "succession"
                      ? "Succession"
                      : w.method || "Plant"})
                  </span>
                </p>
                <p className="text-slate-400 text-[11px]">
                  {w.startDate} → {w.endDate}
                </p>
                {w.notes && (
                  <p className="mt-1 text-[10px] text-slate-400">{w.notes}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {Array.isArray(directSow) && directSow.length > 0 && (
        <div className="mt-1 text-[11px] text-slate-300">
          <p className="font-medium text-slate-100 mb-0.5">Direct-Sow Focus</p>
          <p className="text-slate-400">
            These crops prefer being sown where they will grow:&nbsp;
            <span className="text-slate-200">{directSow.join(", ")}</span>
          </p>
        </div>
      )}

      {Array.isArray(warnings) && warnings.length > 0 && (
        <div className="mt-2 rounded-xl border border-amber-500/70 bg-amber-950/60 px-3 py-2 text-[11px] text-amber-100">
          <p className="font-medium mb-0.5">Warnings &amp; Risk Notes</p>
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
          Tip: Once this calendar feels right, push it into your Garden Planner
          and let SSA schedule actual planting sessions on good-weather days
          that don&apos;t clash with your other household work.
        </p>
        <div className="flex flex-wrap gap-2 justify-end">
          <button
            type="button"
            onClick={() =>
              result && onGardenPlannerSync && onGardenPlannerSync(result)
            }
            className="inline-flex items-center justify-center rounded-xl px-3.5 py-2 text-[11px] font-semibold bg-sky-400 hover:bg-sky-300 text-slate-950 shadow-md shadow-sky-500/30 transition"
          >
            Send to Garden Planner
          </button>
          <button
            type="button"
            onClick={() => result && onStartSession && onStartSession(result)}
            className="inline-flex items-center justify-center rounded-xl px-3.5 py-2 text-[11px] font-semibold bg-emerald-400 hover:bg-emerald-300 text-slate-950 shadow-md shadow-emerald-500/30 transition"
          >
            Plan Planting Session
          </button>
        </div>
      </div>
    </section>
  );
}

/**
 * Route component for Garden Planting Calendar Calculator.
 */
export default function GardenPlantingCalendarCalculatorPage() {
  /** @type {[PlantingCalendarResult|null, React.Dispatch<React.SetStateAction<PlantingCalendarResult|null>>]} */
  const [result, setResult] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    document.title =
      "Garden Planting Calendar Calculator | Suka Smart Assistant";
  }, []);

  /**
   * Handler passed to GardenPlantingCalendarCalculatorView.
   * @param {Object} input - Calculator input (zone, location, crops, etc.)
   */
  const handleCalculate = useCallback(async (input) => {
    setIsRunning(true);
    setError(null);

    try {
      const { result: calcResult } = await runCalculator(
        CALCULATOR_ID,
        input,
        {
          source:
            "pages.calculators.gardenAnimal.garden-planting-calendar",
          emitEvents: true,
        }
      );

      if (!calcResult || typeof calcResult !== "object") {
        throw new Error(
          "Garden Planting Calendar calculator did not return a result object."
        );
      }

      /** @type {PlantingCalendarResult} */
      const normalized = {
        zone:
          typeof calcResult.zone === "string" ? calcResult.zone : undefined,
        locationLabel:
          typeof calcResult.locationLabel === "string"
            ? calcResult.locationLabel
            : undefined,
        frostLastDate:
          typeof calcResult.frostLastDate === "string"
            ? calcResult.frostLastDate
            : undefined,
        frostFirstDate:
          typeof calcResult.frostFirstDate === "string"
            ? calcResult.frostFirstDate
            : undefined,
        seasonLabel:
          typeof calcResult.seasonLabel === "string"
            ? calcResult.seasonLabel
            : undefined,
        windows: Array.isArray(calcResult.windows)
          ? calcResult.windows
          : [],
        indoorStarts: Array.isArray(calcResult.indoorStarts)
          ? calcResult.indoorStarts
          : [],
        directSow: Array.isArray(calcResult.directSow)
          ? calcResult.directSow
          : [],
        successionCrops: Array.isArray(calcResult.successionCrops)
          ? calcResult.successionCrops
          : [],
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
      emitPlantingCalendarCompleted(normalized);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        "[garden-planting-calendar.jsx] Garden Planting Calendar calculator error",
        err
      );
      setError(
        err && err.message
          ? err.message
          : "There was a problem running the Garden Planting Calendar calculator."
      );
    } finally {
      setIsRunning(false);
    }
  }, []);

  const handleStartSession = useCallback((plantingResult) => {
    if (!plantingResult) return;
    requestPlantingSession(plantingResult);
  }, []);

  const handleGardenPlannerSync = useCallback((plantingResult) => {
    if (!plantingResult) return;
    requestGardenPlannerSync(plantingResult);
  }, []);

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-slate-950/90 text-slate-50">
      <div className="mx-auto max-w-5xl px-4 py-6 lg:py-8">
        {/* Header */}
        <header className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-50">
              Garden Planting Calendar
            </h1>
            <p className="mt-1 text-sm text-slate-400 max-w-2xl">
              Turn your zip code, zone, and crop list into a living planting
              calendar. SSA maps out indoor starts, direct-sow dates, and
              succession plantings so you can match garden work with the rest
              of your household schedule.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-900/80 px-3 py-1 border border-slate-700">
              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
              Feeds Garden Planner &amp; Calendar
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-900/80 px-3 py-1 border border-slate-700">
              <span className="h-2 w-2 rounded-full bg-sky-400" />
              Planting Sessions
            </span>
          </div>
        </header>

        {/* Main card */}
        <main className="bg-slate-900/70 border border-slate-700 rounded-2xl shadow-xl p-4 lg:p-6">
          <GardenPlantingCalendarCalculatorView
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

          <PlantingSummaryCard
            result={result}
            onStartSession={handleStartSession}
            onGardenPlannerSync={handleGardenPlannerSync}
          />
        </main>
      </div>
    </div>
  );
}
