// C:\Users\larho\suka-smart-assistant\src\features\calculators\calendar\HebrewMonthStartCalendar\HebrewMonthStartCalendar.view.jsx

/**
 * HebrewMonthStartCalendar.view.jsx
 *
 * How this fits:
 * - UI wrapper for the Hebrew Month Start calculator shim.
 * - Lets the user choose:
 *   - A month-start rule (full moon, new moon, etc.)
 *   - Location (lat, lon, timezone)
 *   - Gregorian year (and optional custom window)
 * - Calls HebrewMonthStartCalendar.shim.js to compute month start dates.
 * - Renders:
 *   - Summary card of the rule + first/last month
 *   - Table of months with flags/notes
 *   - "Plan Feast Sessions Now" CTA that hands results to the session/planning layer
 *
 * This does NOT do any heavy astronomy; that’s done (approximated) in the shim.
 * It only orchestrates inputs/outputs, UX, and emits events for SSA.
 */

import React, { useCallback, useMemo, useState } from "react";
import runHebrewMonthStartCalendarShim from "./HebrewMonthStartCalendar.shim";
import { emit } from "@/services/eventBus";

/**
 * @typedef {import("./HebrewMonthStartCalendar.shim").ShimRequest} ShimRequest
 * @typedef {import("./HebrewMonthStartCalendar.shim").ShimResponse} ShimResponse
 */

/**
 * @typedef {Object} HebrewMonthStartCalendarViewProps
 * @property {number} [defaultYear]
 * @property {string} [defaultTimezone]
 * @property {{ lat: number, lon: number }|null} [defaultLocation]
 * @property {(result: ShimResponse) => void} [onResult]
 */

/**
 * Main UI component for the Hebrew Month Start Calculator.
 *
 * @param {HebrewMonthStartCalendarViewProps} props
 */
export default function HebrewMonthStartCalendarView({
  defaultYear,
  defaultTimezone,
  defaultLocation,
  onResult
}) {
  const now = useMemo(() => new Date(), []);
  const [rulePresetId, setRulePresetId] = useState(
    /** @type {"fullMoon"|"newMoonAstronomical"|"firstVisibleCrescent"|"noMeridianCrossing"} */
    ("fullMoon")
  );
  const [year, setYear] = useState(
    typeof defaultYear === "number" ? defaultYear : now.getFullYear()
  );
  const [lat, setLat] = useState(
    defaultLocation && typeof defaultLocation.lat === "number"
      ? String(defaultLocation.lat)
      : "33.4484" // default-ish: Birmingham, AL-ish latitude (SSA context)
  );
  const [lon, setLon] = useState(
    defaultLocation && typeof defaultLocation.lon === "number"
      ? String(defaultLocation.lon)
      : "-86.7990"
  );
  const [tz, setTz] = useState(defaultTimezone || "America/Chicago");
  const [epochStartDate, setEpochStartDate] = useState("");
  const [epochEndDate, setEpochEndDate] = useState("");

  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState(/** @type {ShimResponse|null} */ (null));
  const [lastError, setLastError] = useState("");

  const ruleOptions = useMemo(
    () => [
      {
        value: "fullMoon",
        label: "Full Moon",
        description: "Month begins at/near the full moon (SSA default)."
      },
      {
        value: "newMoonAstronomical",
        label: "New Moon (Astronomical)",
        description: "Month begins at the astronomical new moon conjunction."
      },
      {
        value: "firstVisibleCrescent",
        label: "First Visible Crescent",
        description: "Month begins when the first crescent is visible after sunset."
      },
      {
        value: "noMeridianCrossing",
        label: "Moon Does Not Cross Meridian",
        description:
          "Month begins if the moon fails to cross the meridian during the night (guard-rail rule)."
      }
    ],
    []
  );

  const handleUseBrowserTimezone = useCallback(() => {
    try {
      const intlTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (intlTz) {
        setTz(intlTz);
      }
    } catch {
      // If it fails, silently ignore.
    }
  }, []);

  const handleCalculate = useCallback(async () => {
    setIsLoading(true);
    setLastError("");

    try {
      const parsedLat = parseFloat(lat);
      const parsedLon = parseFloat(lon);

      if (Number.isNaN(parsedLat) || Number.isNaN(parsedLon)) {
        throw new Error("Latitude and longitude must be valid numbers.");
      }

      const inputs = {
        rulePresetId,
        location: {
          lat: parsedLat,
          lon: parsedLon,
          tz
        },
        gregorianYear: Number(year),
        epochStartDate: epochStartDate || undefined,
        epochEndDate: epochEndDate || undefined,
        options: {
          allowThirteenthMonth: true,
          includeStarCheck: true,
          maxMonthCount: 13
        }
      };

      /** @type {ShimRequest} */
      const shimRequest = {
        calculatorId: "calendar.hebrewMonthStart",
        nodeKey: "calendar.hebrewMonthStart",
        inputs,
        context: {
          invokedBy: "calendar.ui",
          source: "HebrewMonthStartCalendar.view",
          debug: false
        }
      };

      const shimResult = await runHebrewMonthStartCalendarShim(shimRequest);
      setResult(shimResult);

      emitSafe("planningGraph.calculator.ui.completed", {
        calculatorId: shimRequest.calculatorId,
        nodeKey: shimRequest.nodeKey,
        inputs,
        outputs: shimResult.outputs,
        metadata: shimResult.metadata
      });

      if (!shimResult.ok && shimResult.error) {
        setLastError(shimResult.error.message || "Calculation failed.");
      }

      if (onResult) {
        onResult(shimResult);
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unexpected error while calculating month starts.";
      setLastError(message);

      emitSafe("planningGraph.calculator.ui.error", {
        calculatorId: "calendar.hebrewMonthStart",
        nodeKey: "calendar.hebrewMonthStart",
        error: { message }
      });
    } finally {
      setIsLoading(false);
    }
  }, [
    lat,
    lon,
    tz,
    year,
    rulePresetId,
    epochStartDate,
    epochEndDate,
    onResult
  ]);

  const handlePlanSessionsNow = useCallback(() => {
    if (!result || !result.ok || !result.outputs) return;

    emitSafe("session.builder.requested", {
      domain: "storehouse",
      reason: "hebrewMonthStartCalendar",
      months: result.outputs.months,
      summary: result.outputs.summary,
      calendarRule: result.inputs.rulePresetId,
      gregorianYear: result.inputs.gregorianYear
    });
  }, [result]);

  const activeRule = useMemo(
    () => ruleOptions.find((r) => r.value === rulePresetId),
    [ruleOptions, rulePresetId]
  );

  const months = result && result.outputs ? result.outputs.months : [];
  const summary = result && result.outputs ? result.outputs.summary : null;
  const metadataWarnings =
    result && result.metadata && Array.isArray(result.metadata.warnings)
      ? result.metadata.warnings
      : [];

  return (
    <div className="ssa-panel ssa-calendar-panel max-w-6xl mx-auto p-4 sm:p-6 space-y-6">
      {/* Header */}
      <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">
            Hebrew Month Start Calendar
          </h2>
          <p className="text-sm text-slate-600">
            Choose a month-start method, set your location, and generate approximated
            Hebrew month start dates for SSA planning and feast scheduling.
          </p>
        </div>
        <button
          type="button"
          onClick={handlePlanSessionsNow}
          disabled={!result || !result.ok || !result.outputs}
          className="inline-flex items-center justify-center rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white shadow-sm disabled:opacity-40 disabled:cursor-not-allowed hover:bg-emerald-700 transition-colors"
        >
          {/* "Now" CTA into session/planning flows */}
          Plan Feast Sessions Now
        </button>
      </header>

      {/* Inputs */}
      <section className="bg-white rounded-lg shadow-sm border border-slate-200 p-4 sm:p-5 space-y-4">
        <h3 className="text-sm font-semibold text-slate-800">
          1. Month Start Rule & Year
        </h3>
        <div className="grid gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          {/* Rule selector */}
          <div className="space-y-3">
            <label className="block text-xs font-medium text-slate-700">
              Month Start Method
            </label>
            <div className="grid gap-2 sm:grid-cols-2">
              {ruleOptions.map((rule) => (
                <button
                  key={rule.value}
                  type="button"
                  onClick={() =>
                    setRulePresetId(
                      /** @type {"fullMoon"|"newMoonAstronomical"|"firstVisibleCrescent"|"noMeridianCrossing"} */ (
                        rule.value
                      )
                    )
                  }
                  className={[
                    "text-left border rounded-md px-3 py-2 text-xs transition-colors",
                    rulePresetId === rule.value
                      ? "border-emerald-500 bg-emerald-50"
                      : "border-slate-200 hover:border-emerald-400"
                  ].join(" ")}
                >
                  <div className="font-semibold text-slate-900">{rule.label}</div>
                  <div className="text-[11px] text-slate-600">{rule.description}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Year input */}
          <div className="space-y-3">
            <label className="block text-xs font-medium text-slate-700">
              Gregorian Year
            </label>
            <input
              type="number"
              className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500"
              value={year}
              min={1900}
              max={2500}
              onChange={(e) => setYear(Number(e.target.value) || year)}
            />
            <p className="text-[11px] text-slate-500">
              This is the Gregorian year whose Hebrew months you want to approximate.
            </p>
          </div>
        </div>

        {/* Location & window */}
        <div className="grid gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1.4fr)] mt-2">
          {/* Location */}
          <div className="space-y-2">
            <h4 className="text-xs font-semibold text-slate-800">Location</h4>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-medium text-slate-600">
                  Latitude
                </label>
                <input
                  type="number"
                  step="0.0001"
                  className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500"
                  value={lat}
                  onChange={(e) => setLat(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600">
                  Longitude
                </label>
                <input
                  type="number"
                  step="0.0001"
                  className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500"
                  value={lon}
                  onChange={(e) => setLon(e.target.value)}
                />
              </div>
            </div>
            <div className="mt-2 space-y-1">
              <label className="block text-[11px] font-medium text-slate-600">
                Timezone
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  className="flex-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500"
                  value={tz}
                  onChange={(e) => setTz(e.target.value)}
                />
                <button
                  type="button"
                  onClick={handleUseBrowserTimezone}
                  className="inline-flex items-center rounded-md border border-slate-300 px-2 py-1.5 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
                >
                  Use Browser
                </button>
              </div>
              <p className="text-[11px] text-slate-500">
                Example: <code className="text-[11px]">America/Chicago</code>
              </p>
            </div>
          </div>

          {/* Optional epoch window */}
          <div className="space-y-2">
            <h4 className="text-xs font-semibold text-slate-800">
              Optional Date Window
            </h4>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-medium text-slate-600">
                  Start (YYYY-MM-DD)
                </label>
                <input
                  type="date"
                  className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500"
                  value={epochStartDate}
                  onChange={(e) => setEpochStartDate(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600">
                  End (YYYY-MM-DD)
                </label>
                <input
                  type="date"
                  className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500"
                  value={epochEndDate}
                  onChange={(e) => setEpochEndDate(e.target.value)}
                />
              </div>
            </div>
            <p className="text-[11px] text-slate-500">
              Leave blank to use the entire Gregorian year window.
            </p>
          </div>
        </div>

        {/* Calculate button */}
        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={handleCalculate}
            disabled={isLoading}
            className="inline-flex items-center rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isLoading ? "Calculating…" : "Generate Month Start Dates"}
          </button>
          {activeRule && (
            <p className="text-[11px] text-slate-500">
              Using method: <span className="font-semibold">{activeRule.label}</span>
            </p>
          )}
        </div>

        {/* Errors / warnings */}
        {(lastError || metadataWarnings.length > 0) && (
          <div className="mt-3 space-y-2">
            {lastError && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                {lastError}
              </div>
            )}
            {metadataWarnings.length > 0 && (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 space-y-1">
                <div className="font-semibold">Warnings</div>
                <ul className="list-disc pl-4 space-y-0.5">
                  {metadataWarnings.map((w, idx) => (
                    <li key={idx}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Results */}
      {result && result.ok && result.outputs && (
        <section className="space-y-4">
          {/* Summary */}
          <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div>
              <h3 className="text-sm font-semibold text-slate-800">
                2. Generated Hebrew Month Start Summary
              </h3>
              <p className="text-xs text-slate-600">
                Approximate month starts for the selected year, location, and rule.
              </p>
            </div>
            {summary && (
              <div className="flex flex-wrap gap-3 text-xs text-slate-800">
                <div className="flex flex-col">
                  <span className="text-[11px] text-slate-500">First Month</span>
                  <span className="font-semibold">
                    {summary.firstMonthIndex ?? "—"} •{" "}
                    {summary.firstGregorianDate ?? "—"}
                  </span>
                </div>
                <div className="flex flex-col">
                  <span className="text-[11px] text-slate-500">Last Month</span>
                  <span className="font-semibold">
                    {summary.lastMonthIndex ?? "—"} •{" "}
                    {summary.lastGregorianDate ?? "—"}
                  </span>
                </div>
                <div className="flex flex-col">
                  <span className="text-[11px] text-slate-500">Rule</span>
                  <span className="font-semibold capitalize">
                    {(summary.rulePresetId || rulePresetId).replace(/([A-Z])/g, " $1")}
                  </span>
                </div>
                <div className="flex flex-col">
                  <span className="text-[11px] text-slate-500">Total Months</span>
                  <span className="font-semibold">{months.length}</span>
                </div>
              </div>
            )}
          </div>

          {/* Table */}
          <div className="bg-white rounded-lg shadow-sm border border-slate-200 overflow-hidden">
            <div className="max-h-[420px] overflow-auto">
              <table className="min-w-full text-xs">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold text-slate-700">
                      #
                    </th>
                    <th className="px-3 py-2 text-left font-semibold text-slate-700">
                      Gregorian Start Date
                    </th>
                    <th className="px-3 py-2 text-left font-semibold text-slate-700">
                      Flags
                    </th>
                    <th className="px-3 py-2 text-left font-semibold text-slate-700">
                      Notes
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {months.map((m) => (
                    <tr
                      key={m.monthIndex}
                      className="border-b border-slate-100 hover:bg-slate-50/60"
                    >
                      <td className="px-3 py-2 text-slate-800">{m.monthIndex}</td>
                      <td className="px-3 py-2 text-slate-800">
                        {m.gregorianStartDate}
                      </td>
                      <td className="px-3 py-2 text-slate-700">
                        {m.flags && m.flags.length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {m.flags.map((f, idx) => (
                              <span
                                key={idx}
                                className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-700"
                              >
                                {f}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-slate-700">
                        {m.notes || <span className="text-slate-400">—</span>}
                      </td>
                    </tr>
                  ))}
                  {months.length === 0 && (
                    <tr>
                      <td
                        className="px-3 py-4 text-center text-slate-500"
                        colSpan={4}
                      >
                        No months generated for this configuration.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="px-3 py-2 border-t border-slate-200 text-[11px] text-slate-500">
              These month starts are approximations for planning and visual calendar
              building inside SSA. When a full astronomical module is added, this view
              will automatically benefit without changing the UI.
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

/**
 * Small helper to safely emit an SSA event.
 *
 * @param {string} type
 * @param {any} data
 */
function emitSafe(type, data) {
  try {
    emit({
      type,
      ts: new Date().toISOString(),
      source: "features/calculators/calendar/HebrewMonthStartCalendar.view",
      data
    });
  } catch {
    // Never block the UI if telemetry/eventing fails.
  }
}
