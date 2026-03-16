// C:\Users\larho\suka-smart-assistant\src\pages\calculators\calendar\hebrew-month-start.jsx

/**
 * Hebrew Month Start Calculator Route
 *
 * How this fits SSA:
 * - Wraps HebrewMonthStartCalculatorView and:
 *   • centralizes computation through calculatorRunner
 *   • emits events that inform the Calendar engine, Feast Planner,
 *     Storehouse targets, and Session planning
 *   • shows a clear reasoning summary of why a given Gregorian date
 *     is treated as Hebrew Month Day 1 under a chosen rule
 *
 * Planning Graph links:
 *   FROM:
 *     - Location/timezone (household profile)
 *     - Astronomical data imports (TimeAndDate, etc.)
 *     - User-selected rule: full-moon, first crescent, no meridian pass, etc.
 *   TO:
 *     - Hebrew Calendar layout (month grid)
 *     - Feast Planner & Meal Planner
 *     - Storehouse Goal Calculator (days-of-food per cycle)
 *     - Session Planner (holy day prep sessions)
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import eventBus from "@/services/events/eventBus";

// ✅ FIX: your flags live at src/config/featureFlags.json (not a JS module)
// IMPORTANT: JSON has a default export object (no named exports)
import featureFlags from "@/config/featureFlags.json";

import { runCalculator } from "@/services/calculators/calculatorRunner";
import HebrewMonthStartCalculatorView from "@/features/calculators/calendar/HebrewMonthStartCalculator.view.jsx";

const CALCULATOR_ID = "calendar.hebrewMonthStart";

// ✅ Derive this safely from JSON (supports either boolean or {enabled:true} shapes)
const familyFundMode = !!(
  featureFlags?.familyFundMode === true ||
  featureFlags?.familyFundMode?.enabled === true
);

/**
 * @typedef {Object} CandidateStartDate
 * @property {string} gregorianDate   // "YYYY-MM-DD"
 * @property {string} hebrewDate      // "YYYY-MM-DD" in your Hebrew layout
 * @property {string} [reason]        // short explanation
 * @property {boolean} [isPreferred]
 */

/**
 * @typedef {Object} HebrewMonthStartResult
 * @property {string} ruleId
 * @property {string} ruleLabel
 * @property {string} timezone
 * @property {string} locationLabel
 * @property {string} anchorGregorianDate   // reference date for the rule (e.g., full moon)
 * @property {string} anchorHebrewDate      // Hebrew date assigned to anchor (if applicable)
 * @property {number} monthNumber           // e.g. 1..13 based on your schema
 * @property {string} monthName             // "Aviv", "Zif", etc.
 * @property {number} yearNumber            // Hebrew year value
 * @property {boolean} isLeapYear
 * @property {string} [moladTime]           // optional molad description
 * @property {string} [moonPhaseName]       // "Full", "First Crescent", etc.
 * @property {string} [sunriseTs]
 * @property {string} [sunsetTs]
 * @property {boolean} [meridianPassOk]
 * @property {CandidateStartDate[]} candidateStartDates
 * @property {CandidateStartDate|null} chosenStartDate
 * @property {string} reasoningSummary
 * @property {string[]} [warnings]
 * @property {string[]} [notes]
 * @property {Object<string, any>} [meta]
 */

/**
 * Emit completion event so Calendar, Feast Planner, and Storehouse
 * can listen and update downstream calculations.
 * @param {HebrewMonthStartResult} result
 */
function emitHebrewMonthStartCompleted(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.hebrewMonthStart.completed",
      ts: new Date().toISOString(),
      source: "pages.calculators.calendar.hebrew-month-start",
      data: {
        calculatorId: CALCULATOR_ID,
        result,
        familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[hebrew-month-start.jsx] Failed to emit calculator.hebrewMonthStart.completed",
      err
    );
  }
}

/**
 * Ask the Hebrew Calendar engine to re-compute month layout.
 * @param {HebrewMonthStartResult} result
 */
function requestCalendarSync(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.hebrewMonthStart.calendarSync.requested",
      ts: new Date().toISOString(),
      source: "pages.calculators.calendar.hebrew-month-start",
      data: {
        calculatorId: CALCULATOR_ID,
        result,
        familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[hebrew-month-start.jsx] Failed to emit calendarSync.requested",
      err
    );
  }
}

/**
 * Ask Feast Planner to align appointed times with this start date.
 * @param {HebrewMonthStartResult} result
 */
function requestFeastPlannerSync(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.hebrewMonthStart.feastPlannerSync.requested",
      ts: new Date().toISOString(),
      source: "pages.calculators.calendar.hebrew-month-start",
      data: {
        calculatorId: CALCULATOR_ID,
        result,
        familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[hebrew-month-start.jsx] Failed to emit feastPlannerSync.requested",
      err
    );
  }
}

/**
 * Ask Storehouse Goal logic to update cycle lengths.
 * @param {HebrewMonthStartResult} result
 */
function requestStorehouseGoalSync(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.hebrewMonthStart.storehouseGoalSync.requested",
      ts: new Date().toISOString(),
      source: "pages.calculators.calendar.hebrew-month-start",
      data: {
        calculatorId: CALCULATOR_ID,
        result,
        familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[hebrew-month-start.jsx] Failed to emit storehouseGoalSync.requested",
      err
    );
  }
}

/**
 * Ask Session Planner to schedule holy day prep sessions
 * relative to the chosen Month 1 start.
 * @param {HebrewMonthStartResult} result
 */
function requestSessionPlannerSync(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.hebrewMonthStart.sessionPlannerSync.requested",
      ts: new Date().toISOString(),
      source: "pages.calculators.calendar.hebrew-month-start",
      data: {
        calculatorId: CALCULATOR_ID,
        result,
        familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[hebrew-month-start.jsx] Failed to emit sessionPlannerSync.requested",
      err
    );
  }
}

/**
 * Compact label for rule + location.
 * @param {HebrewMonthStartResult|null} result
 */
function buildHeaderLabel(result) {
  if (!result) return "Choose rule and location, then calculate.";
  const pieces = [];
  if (result.ruleLabel) pieces.push(result.ruleLabel);
  if (result.locationLabel) pieces.push(result.locationLabel);
  if (result.timezone) pieces.push(result.timezone);
  return pieces.join(" • ");
}

/**
 * Highlight the chosen start date in a small table of candidates.
 * @param {{ candidates: CandidateStartDate[], chosen: CandidateStartDate|null }} props
 */
function CandidateList({ candidates, chosen }) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const chosenKey = chosen ? chosen.gregorianDate : null;

  return (
    <div className="mt-2 rounded-xl border border-slate-700 bg-slate-900/80 text-[11px] overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700">
        <p className="font-medium text-slate-100">Candidate start dates</p>
        <p className="text-slate-400">
          SSA highlights the one that best satisfies your rule.
        </p>
      </div>
      <div className="divide-y divide-slate-800">
        {candidates.map((c) => {
          const isChosen = c.gregorianDate === chosenKey;
          return (
            <div
              key={`${c.gregorianDate}-${c.hebrewDate}`}
              className={`flex flex-col sm:flex-row sm:items-center sm:justify-between px-3 py-2 ${
                isChosen
                  ? "bg-emerald-950/60 border-l-2 border-emerald-400"
                  : ""
              }`}
            >
              <div className="flex flex-col">
                <span className="text-slate-100 font-semibold">
                  {c.gregorianDate}
                  {isChosen && (
                    <span className="ml-2 inline-flex items-center rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-semibold text-emerald-200 border border-emerald-400/70">
                      Chosen
                    </span>
                  )}
                </span>
                <span className="text-slate-400">
                  Hebrew: <span className="text-slate-100">{c.hebrewDate}</span>
                </span>
              </div>
              {c.reason && (
                <p className="mt-1 sm:mt-0 text-slate-400 text-[10px] sm:max-w-xs">
                  {c.reason}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Summary and follow-up actions for Hebrew Month Start.
 *
 * @param {{
 *   result: HebrewMonthStartResult|null,
 *   onCalendarSync: (r: HebrewMonthStartResult) => void,
 *   onFeastPlannerSync: (r: HebrewMonthStartResult) => void,
 *   onStorehouseGoalSync: (r: HebrewMonthStartResult) => void,
 *   onSessionPlannerSync: (r: HebrewMonthStartResult) => void
 * }} props
 */
function HebrewMonthStartSummaryCard({
  result,
  onCalendarSync,
  onFeastPlannerSync,
  onStorehouseGoalSync,
  onSessionPlannerSync,
}) {
  // ✅ Hooks must be unconditional (React rule of hooks)
  const headerLabel = useMemo(() => buildHeaderLabel(result), [result]);

  if (!result) {
    return (
      <section className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/75 px-4 py-4 text-xs text-slate-400">
        Once you calculate, SSA will show the chosen Month 1 start date and let
        you apply it to the household calendar, feast planner, storehouse
        targets, and session planning.
      </section>
    );
  }

  const {
    ruleLabel,
    monthName,
    monthNumber,
    yearNumber,
    isLeapYear,
    anchorGregorianDate,
    anchorHebrewDate,
    chosenStartDate,
    moonPhaseName,
    moladTime,
    sunriseTs,
    sunsetTs,
    meridianPassOk,
    candidateStartDates,
    reasoningSummary,
    warnings,
    notes,
  } = result;

  return (
    <section className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/75 px-4 py-4 space-y-3">
      <header className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">
            Hebrew Month Start Summary &amp; Next Steps
          </h2>
          <p className="text-xs text-slate-400 max-w-xl">
            See how your selected rule and astronomy data translate into
            &quot;Day&nbsp;1&quot; of the Hebrew month for your household&apos;s
            location, then push that into your calendar, feast planner, and
            storehouse goals.
          </p>
        </div>
        <div className="text-[11px] text-right text-slate-300">
          <p className="px-3 py-1 rounded-full bg-slate-900 border border-slate-700 inline-block">
            {headerLabel}
          </p>
          <p className="text-slate-500 mt-1">
            {monthName} (Month {monthNumber}) · Year {yearNumber}
            {isLeapYear ? " · Leap Year" : ""}
          </p>
        </div>
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Anchor (astronomy)</span>
          <span className="text-slate-50 font-semibold">
            {anchorGregorianDate || "—"}
          </span>
          <span className="text-slate-500">
            Hebrew anchor:{" "}
            <span className="text-slate-100">{anchorHebrewDate || "—"}</span>
          </span>
          <span className="text-slate-500 mt-0.5">
            Rule: <span className="text-slate-100">{ruleLabel}</span>
          </span>
        </div>

        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">
            Chosen Month Start (Day 1)
          </span>
          <span className="text-slate-50 font-semibold">
            {chosenStartDate?.gregorianDate || "—"}
          </span>
          <span className="text-slate-500">
            Hebrew:{" "}
            <span className="text-slate-100">
              {chosenStartDate?.hebrewDate || "—"}
            </span>
          </span>
          <span className="text-[11px] text-emerald-300 mt-0.5">
            This date will drive all upcoming feast days and count-up/down
            trackers.
          </span>
        </div>

        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">
            Astronomy snapshot (local)
          </span>
          <span className="text-slate-50 font-semibold">
            {moonPhaseName || "Moon phase"}{" "}
            {moladTime ? `· Molad ${moladTime}` : ""}
          </span>
          <span className="text-slate-500">
            Sunrise: <span className="text-slate-100">{sunriseTs || "—"}</span>{" "}
            · Sunset: <span className="text-slate-100">{sunsetTs || "—"}</span>
          </span>
          <span className="text-slate-500 mt-0.5">
            Meridian pass:{" "}
            <span
              className={
                meridianPassOk === false ? "text-amber-300" : "text-emerald-300"
              }
            >
              {meridianPassOk === false ? "Not satisfied" : "OK / not required"}
            </span>
          </span>
        </div>
      </div>

      <div className="text-[11px] rounded-xl border border-sky-500/60 bg-sky-950/50 px-3 py-2">
        <p className="font-medium text-sky-100 mb-0.5">Reasoning summary</p>
        <p className="text-sky-50 leading-snug">
          {reasoningSummary ||
            "The calculator compared candidate dates against your rule and astronomy data to select a Month 1 start that best satisfies your criteria."}
        </p>
      </div>

      <CandidateList
        candidates={candidateStartDates || []}
        chosen={chosenStartDate || null}
      />

      {Array.isArray(warnings) && warnings.length > 0 && (
        <div className="rounded-xl border border-amber-500/70 bg-amber-950/60 px-3 py-2 text-[11px] text-amber-100">
          <p className="font-medium mb-0.5">Warnings &amp; edge cases</p>
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

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-2">
        <p className="text-[11px] text-slate-500 leading-snug max-w-md">
          Tip: Once Month 1 is anchored, SSA can map your entire year&apos;s
          appointed times, count days for omer-like observances, and drive
          storehouse &amp; meal planning cycles that stay in sync with your
          actual sky and location.
        </p>
        <div className="flex flex-wrap gap-2 justify-end">
          <button
            type="button"
            onClick={() => result && onCalendarSync && onCalendarSync(result)}
            className="inline-flex items-center justify-center rounded-xl px-3.5 py-2 text-[11px] font-semibold bg-sky-400 hover:bg-sky-300 text-slate-950 shadow-md shadow-sky-500/30 transition"
          >
            Apply to Calendar
          </button>
          <button
            type="button"
            onClick={() =>
              result && onFeastPlannerSync && onFeastPlannerSync(result)
            }
            className="inline-flex items-center justify-center rounded-xl px-3.5 py-2 text-[11px] font-semibold bg-emerald-400 hover:bg-emerald-300 text-slate-950 shadow-md shadow-emerald-500/30 transition"
          >
            Sync Feast Planner
          </button>
          <button
            type="button"
            onClick={() =>
              result && onStorehouseGoalSync && onStorehouseGoalSync(result)
            }
            className="inline-flex items-center justify-center rounded-xl px-3.5 py-2 text-[11px] font-semibold bg-indigo-400 hover:bg-indigo-300 text-slate-950 shadow-md shadow-indigo-500/30 transition"
          >
            Update Storehouse Cycle
          </button>
          <button
            type="button"
            onClick={() =>
              result && onSessionPlannerSync && onSessionPlannerSync(result)
            }
            className="inline-flex items-center justify-center rounded-xl px-3.5 py-2 text-[11px] font-semibold bg-amber-400 hover:bg-amber-300 text-slate-950 shadow-md shadow-amber-500/30 transition"
          >
            Plan Holy Day Sessions
          </button>
        </div>
      </div>
    </section>
  );
}

/**
 * Route component for Hebrew Month Start Calculator.
 */
export default function HebrewMonthStartCalculatorPage() {
  /** @type {[HebrewMonthStartResult|null, React.Dispatch<React.SetStateAction<HebrewMonthStartResult|null>>]} */
  const [result, setResult] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    document.title = "Hebrew Month Start Calculator | Suka Smart Assistant";
  }, []);

  /**
   * Handler passed to HebrewMonthStartCalculatorView.
   * @param {Object} input - Calculator input (rule, location, anchor date, etc.)
   */
  const handleCalculate = useCallback(async (input) => {
    setIsRunning(true);
    setError(null);

    try {
      const { result: calcResult } = await runCalculator(CALCULATOR_ID, input, {
        source: "pages.calculators.calendar.hebrew-month-start",
        emitEvents: true,
      });

      if (!calcResult || typeof calcResult !== "object") {
        throw new Error(
          "Hebrew Month Start calculator did not return a result object."
        );
      }

      /** @type {HebrewMonthStartResult} */
      const normalized = {
        ruleId:
          typeof calcResult.ruleId === "string"
            ? calcResult.ruleId
            : input?.ruleId || "unknown-rule",
        ruleLabel:
          typeof calcResult.ruleLabel === "string"
            ? calcResult.ruleLabel
            : "Selected rule",
        timezone:
          typeof calcResult.timezone === "string"
            ? calcResult.timezone
            : input?.timezone || "",
        locationLabel:
          typeof calcResult.locationLabel === "string"
            ? calcResult.locationLabel
            : input?.locationLabel || "",
        anchorGregorianDate:
          typeof calcResult.anchorGregorianDate === "string"
            ? calcResult.anchorGregorianDate
            : input?.anchorGregorianDate || "",
        anchorHebrewDate:
          typeof calcResult.anchorHebrewDate === "string"
            ? calcResult.anchorHebrewDate
            : "",
        monthNumber:
          typeof calcResult.monthNumber === "number"
            ? calcResult.monthNumber
            : input?.monthNumber || 1,
        monthName:
          typeof calcResult.monthName === "string"
            ? calcResult.monthName
            : input?.monthName || "Month 1",
        yearNumber:
          typeof calcResult.yearNumber === "number"
            ? calcResult.yearNumber
            : input?.yearNumber || 1,
        isLeapYear:
          typeof calcResult.isLeapYear === "boolean"
            ? calcResult.isLeapYear
            : !!input?.isLeapYear,
        moladTime:
          typeof calcResult.moladTime === "string"
            ? calcResult.moladTime
            : undefined,
        moonPhaseName:
          typeof calcResult.moonPhaseName === "string"
            ? calcResult.moonPhaseName
            : undefined,
        sunriseTs:
          typeof calcResult.sunriseTs === "string"
            ? calcResult.sunriseTs
            : undefined,
        sunsetTs:
          typeof calcResult.sunsetTs === "string"
            ? calcResult.sunsetTs
            : undefined,
        meridianPassOk:
          typeof calcResult.meridianPassOk === "boolean"
            ? calcResult.meridianPassOk
            : undefined,
        candidateStartDates: Array.isArray(calcResult.candidateStartDates)
          ? calcResult.candidateStartDates
          : [],
        chosenStartDate:
          calcResult.chosenStartDate &&
          typeof calcResult.chosenStartDate === "object"
            ? calcResult.chosenStartDate
            : (Array.isArray(calcResult.candidateStartDates) &&
                calcResult.candidateStartDates[0]) ||
              null,
        reasoningSummary:
          typeof calcResult.reasoningSummary === "string"
            ? calcResult.reasoningSummary
            : "",
        warnings: Array.isArray(calcResult.warnings) ? calcResult.warnings : [],
        notes: Array.isArray(calcResult.notes) ? calcResult.notes : [],
        meta: calcResult.meta || {},
      };

      setResult(normalized);
      emitHebrewMonthStartCompleted(normalized);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        "[hebrew-month-start.jsx] Hebrew Month Start calculator error",
        err
      );
      setError(
        err && err.message
          ? err.message
          : "There was a problem running the Hebrew Month Start calculator."
      );
    } finally {
      setIsRunning(false);
    }
  }, []);

  const handleCalendarSync = useCallback((res) => {
    if (!res) return;
    requestCalendarSync(res);
  }, []);

  const handleFeastPlannerSync = useCallback((res) => {
    if (!res) return;
    requestFeastPlannerSync(res);
  }, []);

  const handleStorehouseGoalSync = useCallback((res) => {
    if (!res) return;
    requestStorehouseGoalSync(res);
  }, []);

  const handleSessionPlannerSync = useCallback((res) => {
    if (!res) return;
    requestSessionPlannerSync(res);
  }, []);

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-slate-950/90 text-slate-50">
      <div className="mx-auto max-w-5xl px-4 py-6 lg:py-8">
        {/* Header */}
        <header className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-50">
              Hebrew Month Start Calculator
            </h1>
            <p className="mt-1 text-sm text-slate-400 max-w-2xl">
              Anchor your Hebrew Month 1 start date based on your chosen rule
              (full moon, first crescent, meridian pass, etc.), your location,
              and real-world astronomy data. SSA will then map your appointed
              times and cycles around this anchor.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-900/80 px-3 py-1 border border-slate-700">
              <span className="h-2 w-2 rounded-full bg-sky-400" />
              Feeds Hebrew Calendar &amp; Feast Planner
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-900/80 px-3 py-1 border border-slate-700">
              <span className="h-2 w-2 rounded-full bg-emerald-400" />
              Storehouse &amp; Meal Cycles
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-900/80 px-3 py-1 border border-slate-700">
              <span className="h-2 w-2 rounded-full bg-amber-400" />
              Holy Day Sessions &amp; Prep
            </span>
          </div>
        </header>

        {/* Main card */}
        <main className="bg-slate-900/70 border border-slate-700 rounded-2xl shadow-xl p-4 lg:p-6">
          <HebrewMonthStartCalculatorView
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

          <HebrewMonthStartSummaryCard
            result={result}
            onCalendarSync={handleCalendarSync}
            onFeastPlannerSync={handleFeastPlannerSync}
            onStorehouseGoalSync={handleStorehouseGoalSync}
            onSessionPlannerSync={handleSessionPlannerSync}
          />
        </main>
      </div>
    </div>
  );
}
