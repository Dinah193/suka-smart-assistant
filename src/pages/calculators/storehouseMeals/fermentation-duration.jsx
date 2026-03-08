// C:\Users\larho\suka-smart-assistant\src\pages\calculators\storehouseMeals\fermentation-duration.jsx

/**
 * Fermentation Duration Calculator Route
 *
 * How this fits:
 * - Wraps FermentationDurationCalculatorView with:
 *   • calculatorRunner wiring for consistent execution and logging,
 *   • eventBus emissions so the Planning Graph & automation runtime can react,
 *   • a summary card that highlights recommended duration, target dates,
 *     temperature ranges, and risk flags,
 *   • CTAs to:
 *       - create a preservation SessionRunner flow (domain: "preservation"),
 *       - push the batch into Storehouse & Calendar tracking.
 *
 * This node naturally connects:
 *   - FROM: recipe imports, storehouse ingredients, homestead planner goals
 *   - TO: preservation sessions (ferments), storehouse jars, calendar reminders
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import eventBus from "@/services/events/eventBus";
import { familyFundMode } from "@/config/featureFlags";
import { runCalculator } from "@/services/calculators/calculatorRunner";
import FermentationDurationCalculatorView from "@/features/calculators/storehouseMeals/FermentationDurationCalculator.view.jsx";

const CALCULATOR_ID = "storehouseMeals.fermentationDuration";

/**
 * @typedef {Object} FermentationDurationResult
 * @property {string} [batchName]            // "Kimchi #3", "Honey garlic", etc.
 * @property {string} [fermentType]          // "lacto", "vinegar", "koji", "yeast", etc.
 * @property {string} [vesselType]           // "crock", "masonJar", "fermentationLid"
 * @property {number} [batchSize]            // e.g. 1.5
 * @property {string} [batchSizeUnit]        // "qt", "L", "gal"
 * @property {string} [startDateISO]         // recommended start date (ISO)
 * @property {string} [targetDateISO]        // estimated "optimal ready" date (ISO)
 * @property {string} [safeWindowStartISO]   // earliest safe date to start eating
 * @property {string} [safeWindowEndISO]     // last recommended date before quality drops
 * @property {number} [recommendedDays]      // baseline days until "ready"
 * @property {number} [minDays]              // min recommended days
 * @property {number} [maxDays]              // max recommended days
 * @property {{minF?: number, maxF?: number}} [tempRangeF]
 * @property {string[]} [burpScheduleHints]  // human-readable hints: "Daily for first 5 days"
 * @property {string[]} [monitoringTips]     // "Check for kahm yeast", etc.
 * @property {("tempTooLow"|"tempTooHigh"|"saltLow"|"saltHigh"|"headspaceLow"|"unknown")[]} [riskFlags]
 * @property {string[]} [warnings]
 * @property {string[]} [notes]
 * @property {Object<string, any>} [meta]
 */

/**
 * Utility: safe date formatting in the user’s locale.
 * Falls back gracefully if the string is invalid.
 *
 * @param {string | undefined | null} iso
 * @returns {string}
 */
function formatDate(iso) {
  if (!iso || typeof iso !== "string") return "Not set";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "Not set";
  return parsed.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Emit completion event so analytics & automation can listen.
 *
 * @param {FermentationDurationResult} result
 */
function emitFermentationDurationCompleted(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.fermentationDuration.completed",
      ts: new Date().toISOString(),
      source: "pages.calculators.storehouseMeals.fermentation-duration",
      data: {
        calculatorId: CALCULATOR_ID,
        result,
        familyFundMode: !!familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[fermentation-duration.jsx] Failed to emit calculator.fermentationDuration.completed",
      err
    );
  }
}

/**
 * Ask the automation/runtime to:
 *  - create a preservation SessionRunner flow for this ferment,
 *  - set up step reminders for burping, checking, and moving to cold storage.
 *
 * @param {FermentationDurationResult} result
 */
function requestFermentationSession(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;

    eventBus.emit({
      type: "calculator.fermentationDuration.session.requested",
      ts: new Date().toISOString(),
      source: "pages.calculators.storehouseMeals.fermentation-duration",
      data: {
        calculatorId: CALCULATOR_ID,
        domain: "preservation",
        result,
        familyFundMode: !!familyFundMode,
        sessionHint: {
          title:
            result?.batchName || result?.fermentType || "Fermentation Session",
          suggestedDomain: "preservation",
          tags: ["fermentation", "burpSchedule", "storehouse"],
        },
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[fermentation-duration.jsx] Failed to emit calculator.fermentationDuration.session.requested",
      err
    );
  }
}

/**
 * Ask Storehouse & Calendar modules to track this batch.
 *
 * @param {FermentationDurationResult} result
 */
function requestStorehouseCalendarLink(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;

    eventBus.emit({
      type: "calculator.fermentationDuration.storehouseCalendar.requested",
      ts: new Date().toISOString(),
      source: "pages.calculators.storehouseMeals.fermentation-duration",
      data: {
        calculatorId: CALCULATOR_ID,
        result,
        familyFundMode: !!familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[fermentation-duration.jsx] Failed to emit calculator.fermentationDuration.storehouseCalendar.requested",
      err
    );
  }
}

/**
 * Summary card showing key timing and safety details.
 *
 * @param {{
 *   result: FermentationDurationResult | null,
 *   onStartSession: (r: FermentationDurationResult) => void,
 *   onStorehouseCalendar: (r: FermentationDurationResult) => void
 * }} props
 */
function FermentationSummaryCard({
  result,
  onStartSession,
  onStorehouseCalendar,
}) {
  if (!result) return null;

  const {
    batchName,
    fermentType,
    startDateISO,
    targetDateISO,
    safeWindowStartISO,
    safeWindowEndISO,
    recommendedDays,
    minDays,
    maxDays,
    tempRangeF,
    burpScheduleHints,
    monitoringTips,
    riskFlags,
    warnings,
    notes,
    batchSize,
    batchSizeUnit,
    vesselType,
  } = result;

  const label =
    batchName ||
    (fermentType
      ? `${fermentType.charAt(0).toUpperCase()}${fermentType.slice(1)} ferment`
      : "This batch");

  const riskText = useMemo(() => {
    if (!Array.isArray(riskFlags) || riskFlags.length === 0) return null;
    const map = {
      tempTooLow:
        "Ambient temperature is on the low side — expect slower fermentation.",
      tempTooHigh:
        "Ambient temperature is on the high side — watch closely for over-fermentation.",
      saltLow:
        "Salt concentration may be low — higher spoilage risk. Monitor carefully.",
      saltHigh:
        "Salt concentration is on the high side — fermentation may be slower but safer.",
      headspaceLow:
        "Headspace is low — watch for brine overflow and keep everything submerged.",
      unknown:
        "Some parameters are unusual — rely heavily on smell, look, and taste.",
    };
    return riskFlags.map((f) => map[f] || "Check your parameters carefully.");
  }, [riskFlags]);

  return (
    <section className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/75 px-4 py-4 space-y-3">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">
            Fermentation Plan Summary
          </h2>
          <p className="text-xs text-slate-400 mt-0.5 max-w-xl">
            {label} will be tracked from start to &quot;ready&quot; day with
            temperature guidance and check-in reminders so you can build a
            reliable ferments routine.
          </p>
        </div>
        <span className="text-[10px] px-2 py-1 rounded-full bg-slate-900 border border-slate-700 text-slate-200 whitespace-nowrap">
          Ready for Calendar + Session
        </span>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Estimated Duration</span>
          <span className="text-slate-50 font-semibold">
            {recommendedDays != null ? `${recommendedDays} days` : "Not set"}
          </span>
          <span className="text-slate-500">
            {minDays != null && maxDays != null
              ? `Range: ${minDays}-${maxDays} days`
              : "Range not set"}
          </span>
        </div>

        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Timeline</span>
          <span className="text-slate-50 font-semibold">
            Start: {formatDate(startDateISO)}
          </span>
          <span className="text-slate-500">
            Ready: {formatDate(targetDateISO)}
          </span>
        </div>

        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Safe Eating Window</span>
          <span className="text-slate-50 font-semibold">
            From {formatDate(safeWindowStartISO)}
          </span>
          <span className="text-slate-500">
            To {formatDate(safeWindowEndISO)}
          </span>
        </div>

        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Temperature Lane</span>
          <span className="text-slate-50 font-semibold">
            {tempRangeF?.minF != null && tempRangeF?.maxF != null
              ? `${tempRangeF.minF.toFixed(0)}–${tempRangeF.maxF.toFixed(0)}°F`
              : "Not set"}
          </span>
          <span className="text-slate-500">
            {vesselType
              ? `${vesselType} · ${batchSize || "?"} ${batchSizeUnit || "?"}`
              : batchSize
              ? `${batchSize} ${batchSizeUnit || ""}`.trim()
              : "Vessel/batch size not set"}
          </span>
        </div>
      </div>

      {Array.isArray(burpScheduleHints) && burpScheduleHints.length > 0 && (
        <div className="mt-1 text-[11px] text-slate-300">
          <p className="font-medium text-slate-100 mb-0.5">
            Gas &amp; Burp Schedule
          </p>
          <ul className="list-disc list-inside space-y-0.5">
            {burpScheduleHints.map((h, idx) => (
              <li key={idx}>{h}</li>
            ))}
          </ul>
        </div>
      )}

      {Array.isArray(monitoringTips) && monitoringTips.length > 0 && (
        <div className="mt-1 text-[11px] text-slate-300">
          <p className="font-medium text-slate-100 mb-0.5">
            Monitoring &amp; Quality Tips
          </p>
          <ul className="list-disc list-inside space-y-0.5">
            {monitoringTips.map((t, idx) => (
              <li key={idx}>{t}</li>
            ))}
          </ul>
        </div>
      )}

      {riskText && riskText.length > 0 && (
        <div className="mt-2 rounded-xl border border-amber-500/70 bg-amber-950/40 px-3 py-2 text-[11px] text-amber-50">
          <p className="font-medium mb-0.5">Risk &amp; Caution Notes</p>
          <ul className="list-disc list-inside space-y-0.5">
            {riskText.map((t, idx) => (
              <li key={idx}>{t}</li>
            ))}
          </ul>
        </div>
      )}

      {Array.isArray(warnings) && warnings.length > 0 && (
        <div className="mt-2 rounded-xl border border-red-500/70 bg-red-950/50 px-3 py-2 text-[11px] text-red-50">
          <p className="font-medium mb-0.5">Warnings</p>
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
          Tip: Let SSA add this batch to your Storehouse and calendar and turn
          the schedule into a guided preservation session with step-by-step
          prompts in the SessionRunner.
        </p>
        <div className="flex flex-wrap gap-2 justify-end">
          <button
            type="button"
            onClick={() =>
              result && onStorehouseCalendar && onStorehouseCalendar(result)
            }
            className="inline-flex items-center justify-center rounded-xl px-3.5 py-2 text-[11px] font-semibold bg-sky-400 hover:bg-sky-300 text-slate-950 shadow-md shadow-sky-500/30 transition"
          >
            Storehouse + Calendar
          </button>
          <button
            type="button"
            onClick={() => result && onStartSession && onStartSession(result)}
            className="inline-flex items-center justify-center rounded-xl px-3.5 py-2 text-[11px] font-semibold bg-emerald-400 hover:bg-emerald-300 text-slate-950 shadow-md shadow-emerald-500/30 transition"
          >
            Start Fermentation Session
          </button>
        </div>
      </div>
    </section>
  );
}

/**
 * Route component for Fermentation Duration Calculator.
 */
export default function FermentationDurationCalculatorPage() {
  /** @type {[FermentationDurationResult|null, React.Dispatch<React.SetStateAction<FermentationDurationResult|null>>]} */
  const [result, setResult] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    document.title = "Fermentation Duration Calculator | Suka Smart Assistant";
  }, []);

  /**
   * Handler passed to FermentationDurationCalculatorView.
   *
   * @param {Object} input - Calculator input data (salt %, ambient temp, style, etc.)
   */
  const handleCalculate = useCallback(async (input) => {
    setIsRunning(true);
    setError(null);

    try {
      const { result: calcResult } = await runCalculator(CALCULATOR_ID, input, {
        source: "pages.calculators.storehouseMeals.fermentation-duration",
        emitEvents: true,
      });

      if (!calcResult || typeof calcResult !== "object") {
        throw new Error(
          "Fermentation Duration calculator did not return a result object."
        );
      }

      /** @type {FermentationDurationResult} */
      const normalized = {
        batchName:
          typeof calcResult.batchName === "string"
            ? calcResult.batchName
            : undefined,
        fermentType:
          typeof calcResult.fermentType === "string"
            ? calcResult.fermentType
            : undefined,
        vesselType:
          typeof calcResult.vesselType === "string"
            ? calcResult.vesselType
            : undefined,
        batchSize:
          typeof calcResult.batchSize === "number"
            ? calcResult.batchSize
            : undefined,
        batchSizeUnit:
          typeof calcResult.batchSizeUnit === "string"
            ? calcResult.batchSizeUnit
            : undefined,
        startDateISO:
          typeof calcResult.startDateISO === "string"
            ? calcResult.startDateISO
            : undefined,
        targetDateISO:
          typeof calcResult.targetDateISO === "string"
            ? calcResult.targetDateISO
            : undefined,
        safeWindowStartISO:
          typeof calcResult.safeWindowStartISO === "string"
            ? calcResult.safeWindowStartISO
            : undefined,
        safeWindowEndISO:
          typeof calcResult.safeWindowEndISO === "string"
            ? calcResult.safeWindowEndISO
            : undefined,
        recommendedDays:
          typeof calcResult.recommendedDays === "number"
            ? calcResult.recommendedDays
            : undefined,
        minDays:
          typeof calcResult.minDays === "number"
            ? calcResult.minDays
            : undefined,
        maxDays:
          typeof calcResult.maxDays === "number"
            ? calcResult.maxDays
            : undefined,
        tempRangeF:
          calcResult.tempRangeF && typeof calcResult.tempRangeF === "object"
            ? {
                minF:
                  typeof calcResult.tempRangeF.minF === "number"
                    ? calcResult.tempRangeF.minF
                    : undefined,
                maxF:
                  typeof calcResult.tempRangeF.maxF === "number"
                    ? calcResult.tempRangeF.maxF
                    : undefined,
              }
            : undefined,
        burpScheduleHints: Array.isArray(calcResult.burpScheduleHints)
          ? calcResult.burpScheduleHints
          : [],
        monitoringTips: Array.isArray(calcResult.monitoringTips)
          ? calcResult.monitoringTips
          : [],
        riskFlags: Array.isArray(calcResult.riskFlags)
          ? calcResult.riskFlags
          : [],
        warnings: Array.isArray(calcResult.warnings) ? calcResult.warnings : [],
        notes: Array.isArray(calcResult.notes) ? calcResult.notes : [],
        meta: calcResult.meta || {},
      };

      setResult(normalized);
      emitFermentationDurationCompleted(normalized);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        "[fermentation-duration.jsx] Fermentation Duration calculator error",
        err
      );
      setError(
        err && err.message
          ? err.message
          : "There was a problem running the Fermentation Duration calculator."
      );
    } finally {
      setIsRunning(false);
    }
  }, []);

  const handleStartSession = useCallback((fermentResult) => {
    if (!fermentResult) return;
    requestFermentationSession(fermentResult);
  }, []);

  const handleStorehouseCalendar = useCallback((fermentResult) => {
    if (!fermentResult) return;
    requestStorehouseCalendarLink(fermentResult);
  }, []);

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-slate-950/90 text-slate-50">
      <div className="mx-auto max-w-5xl px-4 py-6 lg:py-8">
        {/* Header */}
        <header className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-50">
              Fermentation Duration Calculator
            </h1>
            <p className="mt-1 text-sm text-slate-400 max-w-2xl">
              Use your salt percentage, ambient temperature, and ferment style
              to estimate when a batch will be ready, how long it will stay in
              the ideal window, and when SSA should nudge you to burp, taste,
              and move it to cold storage.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-900/80 px-3 py-1 border border-slate-700">
              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
              Feeds Preservation Sessions
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-900/80 px-3 py-1 border border-slate-700">
              <span className="h-2 w-2 rounded-full bg-indigo-400" />
              Storehouse + Calendar Link
            </span>
          </div>
        </header>

        {/* Main card */}
        <main className="bg-slate-900/70 border border-slate-700 rounded-2xl shadow-xl p-4 lg:p-6">
          <FermentationDurationCalculatorView
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

          <FermentationSummaryCard
            result={result}
            onStartSession={handleStartSession}
            onStorehouseCalendar={handleStorehouseCalendar}
          />
        </main>
      </div>
    </div>
  );
}
