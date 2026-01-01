// C:\Users\larho\suka-smart-assistant\src\pages\calculators\calendar\feast-alignment.jsx

/**
 * Feast Day Alignment Calculator Route
 *
 * How this fits SSA:
 * - Wraps FeastDayAlignmentCalculatorView and:
 *   • centralizes calculation via calculatorRunner
 *   • broadcasts alignment results to:
 *       - Hebrew Calendar engine
 *       - Feast Planner (holy days dashboard)
 *       - Meal Planner (special menus & prep)
 *       - Storehouse & Inventory (pulls for feasts)
 *       - Session Planner (prep & observance sessions)
 *
 * Planning Graph links:
 *   FROM:
 *     - HebrewMonthStartCalculator (month/year anchor)
 *     - Household location/timezone
 *     - Rule set (which moedim / feast set)
 *   TO:
 *     - Calendar overlays (holy days, prep days)
 *     - Feast Planner boards
 *     - Meal plans & storehouse goals
 *     - SessionRunner sessions for prep / observance
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import eventBus from "@/services/eventBus";
import { familyFundMode } from "@/services/featureFlags";
import { runCalculator } from "@/services/calculators/calculatorRunner";
import FeastDayAlignmentCalculatorView from "@/features/calculators/calendar/FeastDayAlignmentCalculator.view";

const CALCULATOR_ID = "calendar.feastAlignment";

/**
 * @typedef {Object} FeastDay
 * @property {string} id
 * @property {string} name                    // e.g., "Passover", "Unleavened Bread: Day 1"
 * @property {string} hebrewDate              // "YYYY-MM-DD" in your Hebrew layout
 * @property {string} gregorianDate           // "YYYY-MM-DD"
 * @property {string} category                // "weeklySabbath"|"highSabbath"|"appointedTime"|"preparationDay"|"intermediateDay"
 * @property {string[]} [scripturalRefs]      // e.g., ["Leviticus 23:5-6"]
 * @property {boolean} [isFasting]
 * @property {boolean} [isCookingAllowed]
 * @property {string} [calendarTag]           // e.g., "HouseholdFeast"|"CommunityFeast"
 * @property {string[]} [notes]
 */

/**
 * @typedef {Object} FeastDayAlignmentResult
 * @property {string} ruleId
 * @property {string} ruleLabel
 * @property {string} feastSetId              // e.g., "lev23-core", "user-custom"
 * @property {string} feastSetLabel           // "Leviticus 23 Moedim", "User Custom Set"
 * @property {string} timezone
 * @property {string} locationLabel
 * @property {{
 *   monthNumber: number,
 *   monthName: string,
 *   yearNumber: number,
 *   startHebrewDate: string,
 *   startGregorianDate: string
 * }} anchorMonth
 * @property {FeastDay[]} feastDays
 * @property {string} reasoningSummary
 * @property {string[]} [warnings]
 * @property {string[]} [notes]
 * @property {Object<string, any>} [meta]
 */

/**
 * Emit completion event so Calendar, Feast Planner, Meal Planner, and
 * Storehouse logic can listen and update downstream data.
 * @param {FeastDayAlignmentResult} result
 */
function emitFeastAlignmentCompleted(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.feastAlignment.completed",
      ts: new Date().toISOString(),
      source: "pages.calculators.calendar.feast-alignment",
      data: {
        calculatorId: CALCULATOR_ID,
        result,
        familyFundMode: !!familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[feast-alignment.jsx] Failed to emit calculator.feastAlignment.completed",
      err
    );
  }
}

/**
 * Ask Calendar engine to add/update feast overlays.
 * @param {FeastDayAlignmentResult} result
 */
function requestCalendarSync(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.feastAlignment.calendarSync.requested",
      ts: new Date().toISOString(),
      source: "pages.calculators.calendar.feast-alignment",
      data: {
        calculatorId: CALCULATOR_ID,
        result,
        familyFundMode: !!familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[feast-alignment.jsx] Failed to emit calendarSync.requested",
      err
    );
  }
}

/**
 * Ask Feast Planner board to sync with these dates.
 * @param {FeastDayAlignmentResult} result
 */
function requestFeastPlannerSync(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.feastAlignment.feastPlannerSync.requested",
      ts: new Date().toISOString(),
      source: "pages.calculators.calendar.feast-alignment",
      data: {
        calculatorId: CALCULATOR_ID,
        result,
        familyFundMode: !!familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[feast-alignment.jsx] Failed to emit feastPlannerSync.requested",
      err
    );
  }
}

/**
 * Ask Meal Planner to pre-seed special menus & prep days.
 * @param {FeastDayAlignmentResult} result
 */
function requestMealPlannerSync(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.feastAlignment.mealPlannerSync.requested",
      ts: new Date().toISOString(),
      source: "pages.calculators.calendar.feast-alignment",
      data: {
        calculatorId: CALCULATOR_ID,
        result,
        familyFundMode: !!familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[feast-alignment.jsx] Failed to emit mealPlannerSync.requested",
      err
    );
  }
}

/**
 * Ask Storehouse & Inventory to align pulls and stock goals.
 * @param {FeastDayAlignmentResult} result
 */
function requestStorehouseSync(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.feastAlignment.storehouseSync.requested",
      ts: new Date().toISOString(),
      source: "pages.calculators.calendar.feast-alignment",
      data: {
        calculatorId: CALCULATOR_ID,
        result,
        familyFundMode: !!familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[feast-alignment.jsx] Failed to emit storehouseSync.requested",
      err
    );
  }
}

/**
 * Ask Session Planner to generate prep + observance sessions around each feast.
 * @param {FeastDayAlignmentResult} result
 */
function requestSessionPlannerSync(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.feastAlignment.sessionPlannerSync.requested",
      ts: new Date().toISOString(),
      source: "pages.calculators.calendar.feast-alignment",
      data: {
        calculatorId: CALCULATOR_ID,
        result,
        familyFundMode: !!familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[feast-alignment.jsx] Failed to emit sessionPlannerSync.requested",
      err
    );
  }
}

/**
 * Decide small header label from result.
 * @param {FeastDayAlignmentResult|null} result
 */
function buildHeaderLabel(result) {
  if (!result) return "Choose feast set and anchor, then calculate.";
  const pieces = [];
  if (result.feastSetLabel) pieces.push(result.feastSetLabel);
  if (result.locationLabel) pieces.push(result.locationLabel);
  if (result.timezone) pieces.push(result.timezone);
  return pieces.join(" • ");
}

/**
 * Lightweight pill for category.
 * @param {{category: string}} props
 */
function CategoryPill({ category }) {
  const labelMap = {
    weeklySabbath: "Weekly Sabbath",
    highSabbath: "High Sabbath",
    appointedTime: "Appointed Time",
    preparationDay: "Preparation Day",
    intermediateDay: "Intermediate Day",
  };

  const colorMap = {
    weeklySabbath: "bg-sky-500/20 text-sky-200 border-sky-400/70",
    highSabbath: "bg-emerald-500/20 text-emerald-200 border-emerald-400/70",
    appointedTime: "bg-indigo-500/20 text-indigo-200 border-indigo-400/70",
    preparationDay: "bg-amber-500/20 text-amber-200 border-amber-400/70",
    intermediateDay: "bg-slate-500/20 text-slate-200 border-slate-400/70",
  };

  const base =
    "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold border";
  const cls = colorMap[category] || "bg-slate-600/20 text-slate-200 border-slate-400/70";

  return <span className={`${base} ${cls}`}>{labelMap[category] || category}</span>;
}

/**
 * Condensed table of aligned feast days.
 * @param {{feastDays: FeastDay[]}} props
 */
function FeastDayTable({ feastDays }) {
  if (!Array.isArray(feastDays) || feastDays.length === 0) return null;

  return (
    <div className="mt-3 rounded-xl border border-slate-700 bg-slate-900/80 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700">
        <p className="text-[11px] font-medium text-slate-100">
          Aligned feast days &amp; key dates
        </p>
        <p className="text-[11px] text-slate-400">
          SSA will reuse these dates in the calendar, feast planner, and
          storehouse planning.
        </p>
      </div>
      <div className="max-h-64 overflow-y-auto">
        <table className="min-w-full divide-y divide-slate-800 text-[11px]">
          <thead className="bg-slate-900/90 sticky top-0 z-10">
            <tr>
              <th className="px-3 py-2 text-left font-semibold text-slate-300">
                Feast / Day
              </th>
              <th className="px-3 py-2 text-left font-semibold text-slate-300">
                Hebrew
              </th>
              <th className="px-3 py-2 text-left font-semibold text-slate-300">
                Gregorian
              </th>
              <th className="px-3 py-2 text-left font-semibold text-slate-300">
                Category
              </th>
              <th className="px-3 py-2 text-left font-semibold text-slate-300">
                Notes
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {feastDays.map((d) => (
              <tr key={d.id}>
                <td className="px-3 py-2 text-slate-50 whitespace-nowrap">
                  {d.name}
                </td>
                <td className="px-3 py-2 text-slate-200 whitespace-nowrap">
                  {d.hebrewDate}
                </td>
                <td className="px-3 py-2 text-slate-200 whitespace-nowrap">
                  {d.gregorianDate}
                </td>
                <td className="px-3 py-2 text-slate-200 whitespace-nowrap">
                  <CategoryPill category={d.category} />
                </td>
                <td className="px-3 py-2 text-slate-400">
                  {Array.isArray(d.notes) && d.notes.length > 0
                    ? d.notes.join(" • ")
                    : ""}
                  {d.isFasting && (
                    <span className="ml-1 text-rose-300">
                      (Fast / restrain)
                    </span>
                  )}
                  {d.isCookingAllowed === false && (
                    <span className="ml-1 text-amber-300">
                      (No cooking)
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Summary and next actions for Feast Day alignment.
 *
 * @param {{
 *   result: FeastDayAlignmentResult|null,
 *   onCalendarSync: (r: FeastDayAlignmentResult) => void,
 *   onFeastPlannerSync: (r: FeastDayAlignmentResult) => void,
 *   onMealPlannerSync: (r: FeastDayAlignmentResult) => void,
 *   onStorehouseSync: (r: FeastDayAlignmentResult) => void,
 *   onSessionPlannerSync: (r: FeastDayAlignmentResult) => void
 * }} props
 */
function FeastAlignmentSummaryCard({
  result,
  onCalendarSync,
  onFeastPlannerSync,
  onMealPlannerSync,
  onStorehouseSync,
  onSessionPlannerSync,
}) {
  if (!result) {
    return (
      <section className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/75 px-4 py-4 text-xs text-slate-400">
        Once you calculate, SSA will list all aligned feast days for the
        selected month/year and let you apply them to your Hebrew calendar,
        feast planner, meal planner, storehouse targets, and prep sessions.
      </section>
    );
  }

  const {
    ruleLabel,
    feastSetLabel,
    anchorMonth,
    feastDays,
    reasoningSummary,
    warnings,
    notes,
  } = result;

  const headerLabel = useMemo(
    () => buildHeaderLabel(result),
    [result]
  );

  const totalHighSabbaths = Array.isArray(feastDays)
    ? feastDays.filter((d) => d.category === "highSabbath").length
    : 0;
  const totalPrepDays = Array.isArray(feastDays)
    ? feastDays.filter((d) => d.category === "preparationDay").length
    : 0;

  return (
    <section className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/75 px-4 py-4 space-y-3">
      <header className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">
            Feast Day Alignment Summary &amp; Next Steps
          </h2>
          <p className="text-xs text-slate-400 max-w-xl">
            Review the aligned feast dates for this anchored month/year, see
            how they cluster by type, and then push them out to your calendar,
            feast planner, meal planning, and storehouse goals.
          </p>
        </div>
        <div className="text-[11px] text-right text-slate-300">
          <p className="px-3 py-1 rounded-full bg-slate-900 border border-slate-700 inline-block">
            {headerLabel}
          </p>
          <p className="text-slate-500 mt-1">
            {anchorMonth?.monthName || "Month"}{" "}
            {anchorMonth?.monthNumber != null ? anchorMonth.monthNumber : ""} ·
            Year {anchorMonth?.yearNumber || ""}
          </p>
        </div>
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Feast set</span>
          <span className="text-slate-50 font-semibold">
            {feastSetLabel || "Selected feast set"}
          </span>
          <span className="text-slate-500">
            Rule:{" "}
            <span className="text-slate-100">
              {ruleLabel || "Selected rule"}
            </span>
          </span>
          <span className="text-slate-500 mt-0.5">
            Month anchored at:{" "}
            <span className="text-slate-100">
              {anchorMonth?.startGregorianDate || "—"}
            </span>{" "}
            (Hebrew:{" "}
            <span className="text-slate-100">
              {anchorMonth?.startHebrewDate || "—"}
            </span>
            )
          </span>
        </div>

        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Counts</span>
          <span className="text-slate-50 font-semibold">
            {Array.isArray(feastDays) ? feastDays.length : 0} key dates
          </span>
          <span className="text-slate-500">
            High Sabbaths:{" "}
            <span className="text-slate-100">{totalHighSabbaths}</span>
          </span>
          <span className="text-slate-500">
            Prep days:{" "}
            <span className="text-slate-100">{totalPrepDays}</span>
          </span>
        </div>

        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Household impact</span>
          <span className="text-slate-50 font-semibold">
            Calendar · Meals · Storehouse · Sessions
          </span>
          <span className="text-slate-500">
            SSA will propagate these dates into your routine while respecting
            quiet hours, Sabbath rules, and inventory blockers via the
            SessionRunner.
          </span>
        </div>
      </div>

      <div className="text-[11px] rounded-xl border border-sky-500/60 bg-sky-950/50 px-3 py-2">
        <p className="font-medium text-sky-100 mb-0.5">Reasoning summary</p>
        <p className="text-sky-50 leading-snug">
          {reasoningSummary ||
            "The calculator applied your rule set to the anchored Hebrew month to determine feast days, high Sabbaths, and preparation days, aligning each with Gregorian dates for your location."}
        </p>
      </div>

      <FeastDayTable feastDays={feastDays || []} />

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
          Tip: After syncing, you can fine-tune individual dates in the
          Calendar, Feast Planner, or Meal Planner modules. SSA will keep your
          underlying calculations and Sessions in sync when you re-run this
          calculator.
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
              result && onMealPlannerSync && onMealPlannerSync(result)
            }
            className="inline-flex items-center justify-center rounded-xl px-3.5 py-2 text-[11px] font-semibold bg-indigo-400 hover:bg-indigo-300 text-slate-950 shadow-md shadow-indigo-500/30 transition"
          >
            Seed Meal Planner
          </button>
          <button
            type="button"
            onClick={() => result && onStorehouseSync && onStorehouseSync(result)}
            className="inline-flex items-center justify-center rounded-xl px-3.5 py-2 text-[11px] font-semibold bg-amber-400 hover:bg-amber-300 text-slate-950 shadow-md shadow-amber-500/30 transition"
          >
            Align Storehouse
          </button>
          <button
            type="button"
            onClick={() =>
              result && onSessionPlannerSync && onSessionPlannerSync(result)
            }
            className="inline-flex items-center justify-center rounded-xl px-3.5 py-2 text-[11px] font-semibold bg-fuchsia-400 hover:bg-fuchsia-300 text-slate-950 shadow-md shadow-fuchsia-500/30 transition"
          >
            Plan Prep Sessions
          </button>
        </div>
      </div>
    </section>
  );
}

/**
 * Route component for Feast Day Alignment Calculator.
 */
export default function FeastDayAlignmentCalculatorPage() {
  /** @type {[FeastDayAlignmentResult|null, React.Dispatch<React.SetStateAction<FeastDayAlignmentResult|null>>]} */
  const [result, setResult] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    document.title =
      "Feast Day Alignment Calculator | Suka Smart Assistant";
  }, []);

  /**
   * Handler passed to FeastDayAlignmentCalculatorView.
   * @param {Object} input - Calculator input (feast set, month anchor, etc.)
   */
  const handleCalculate = useCallback(async (input) => {
    setIsRunning(true);
    setError(null);

    try {
      const { result: calcResult } = await runCalculator(
        CALCULATOR_ID,
        input,
        {
          source: "pages.calculators.calendar.feast-alignment",
          emitEvents: true,
        }
      );

      if (!calcResult || typeof calcResult !== "object") {
        throw new Error(
          "Feast Alignment calculator did not return a result object."
        );
      }

      /** @type {FeastDayAlignmentResult} */
      const normalized = {
        ruleId:
          typeof calcResult.ruleId === "string"
            ? calcResult.ruleId
            : (input?.ruleId || "unknown-rule"),
        ruleLabel:
          typeof calcResult.ruleLabel === "string"
            ? calcResult.ruleLabel
            : "Selected rule",
        feastSetId:
          typeof calcResult.feastSetId === "string"
            ? calcResult.feastSetId
            : (input?.feastSetId || "custom-set"),
        feastSetLabel:
          typeof calcResult.feastSetLabel === "string"
            ? calcResult.feastSetLabel
            : (input?.feastSetLabel || "Selected feast set"),
        timezone:
          typeof calcResult.timezone === "string"
            ? calcResult.timezone
            : input?.timezone || "",
        locationLabel:
          typeof calcResult.locationLabel === "string"
            ? calcResult.locationLabel
            : input?.locationLabel || "",
        anchorMonth:
          calcResult.anchorMonth && typeof calcResult.anchorMonth === "object"
            ? calcResult.anchorMonth
            : {
                monthNumber: input?.monthNumber || 1,
                monthName: input?.monthName || "Month 1",
                yearNumber: input?.yearNumber || 1,
                startHebrewDate: input?.startHebrewDate || "",
                startGregorianDate: input?.startGregorianDate || "",
              },
        feastDays: Array.isArray(calcResult.feastDays)
          ? calcResult.feastDays
          : [],
        reasoningSummary:
          typeof calcResult.reasoningSummary === "string"
            ? calcResult.reasoningSummary
            : "",
        warnings: Array.isArray(calcResult.warnings)
          ? calcResult.warnings
          : [],
        notes: Array.isArray(calcResult.notes) ? calcResult.notes : [],
        meta: calcResult.meta || {},
      };

      setResult(normalized);
      emitFeastAlignmentCompleted(normalized);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        "[feast-alignment.jsx] Feast Day Alignment calculator error",
        err
      );
      setError(
        err && err.message
          ? err.message
          : "There was a problem running the Feast Day Alignment calculator."
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

  const handleMealPlannerSync = useCallback((res) => {
    if (!res) return;
    requestMealPlannerSync(res);
  }, []);

  const handleStorehouseSync = useCallback((res) => {
    if (!res) return;
    requestStorehouseSync(res);
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
              Feast Day Alignment Calculator
            </h1>
            <p className="mt-1 text-sm text-slate-400 max-w-2xl">
              Align your appointed times, high Sabbaths, and preparation days
              with your anchored Hebrew month and real-world Gregorian dates.
              SSA will then sync your calendar, feast planner, meals,
              storehouse pulls, and prep sessions around these dates.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-900/80 px-3 py-1 border border-slate-700">
              <span className="h-2 w-2 rounded-full bg-sky-400" />
              Calendar overlays
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-900/80 px-3 py-1 border border-slate-700">
              <span className="h-2 w-2 rounded-full bg-emerald-400" />
              Feast &amp; Meal planning
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-900/80 px-3 py-1 border border-slate-700">
              <span className="h-2 w-2 rounded-full bg-amber-400" />
              Storehouse &amp; Sessions
            </span>
          </div>
        </header>

        {/* Main card */}
        <main className="bg-slate-900/70 border border-slate-700 rounded-2xl shadow-xl p-4 lg:p-6">
          <FeastDayAlignmentCalculatorView
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

          <FeastAlignmentSummaryCard
            result={result}
            onCalendarSync={handleCalendarSync}
            onFeastPlannerSync={handleFeastPlannerSync}
            onMealPlannerSync={handleMealPlannerSync}
            onStorehouseSync={handleStorehouseSync}
            onSessionPlannerSync={handleSessionPlannerSync}
          />
        </main>
      </div>
    </div>
  );
}
