// C:\Users\larho\suka-smart-assistant\src\pages\calculators\calendar\scriptural-year-length.jsx
// -----------------------------------------------------------------------------
// ScripturalYearLengthCalculator Route
//
// How this fits the SSA system:
// - Lives under the calculators/calendar namespace.
// - Helps users estimate the length of a “scriptural year” (lunar / observed)
//   and compare it to a Gregorian year for planning storehouse, garden,
//   feast-day scheduling, and long-term drift.
// - Exposes a “Now” CTA that emits an event asking the global SessionRunner
//   to open the next runnable session (e.g., a storehouse or garden planning
//   session) without hard-wiring any SessionRunner UI into this file.
// - Uses the shared eventBus contract (emit payload: { type, ts, source, data }).
// - Reads featureFlags.familyFundMode to lightly adapt messaging / context.
//
// NOTE: This file does NOT implement the SessionRunner modal itself.
//       It only *requests* a session via the eventBus. The root-level
//       SessionRunner listener is responsible for:
//         • keeping the modal mounted across navigation,
//         • wake-lock, notifications, workers, PiP, etc.
// -----------------------------------------------------------------------------

import React, { useMemo, useState, useCallback } from "react";
import { familyFundMode } from "@/config/featureFlags";
import { emitEvent } from "@/services/events/eventBus";

/**
 * @typedef {Object} ScripturalYearConfig
 * @property {number} anchorYear        Gregorian year used as reference
 * @property {number} monthCount        Number of months in the scriptural year (12 or 13)
 * @property {number} avgMonthLength    Average days per month (e.g., 29.53)
 * @property {"average"|"custom"} mode  Calculation mode
 * @property {number[]} customMonths    Optional explicit month lengths when mode === "custom"
 * @property {number} driftYears        Years to project drift out
 */

/**
 * Check if a Gregorian year is a leap year.
 * @param {number} year
 * @returns {boolean}
 */
function isLeapYear(year) {
  if (!Number.isFinite(year)) return false;
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Compute the scriptural year statistics based on config.
 * Defensive: falls back gracefully if inputs are invalid.
 *
 * @param {ScripturalYearConfig} config
 */
function computeYearStats(config) {
  const {
    anchorYear,
    monthCount,
    avgMonthLength,
    mode,
    customMonths,
    driftYears,
  } = config;

  const safeMonthCount = Number.isFinite(monthCount) ? monthCount : 12;
  const safeAvgMonthLength =
    Number.isFinite(avgMonthLength) && avgMonthLength > 0
      ? avgMonthLength
      : 29.53;

  let scripturalYearDays;

  if (mode === "custom" && Array.isArray(customMonths) && customMonths.length) {
    // Avoid letting users accidentally enter 0 or negative month lengths.
    const filtered = customMonths.filter((d) => Number.isFinite(d) && d > 0);
    const sum = filtered.reduce((acc, d) => acc + d, 0);
    scripturalYearDays = filtered.length
      ? sum
      : safeMonthCount * safeAvgMonthLength;
  } else {
    scripturalYearDays = safeMonthCount * safeAvgMonthLength;
  }

  const gregorianYearDays = isLeapYear(anchorYear) ? 366 : 365;
  const diffPerYear = scripturalYearDays - gregorianYearDays;
  const projectedDrift =
    diffPerYear * (Number.isFinite(driftYears) ? driftYears : 7);

  return {
    scripturalYearDays,
    gregorianYearDays,
    diffPerYear,
    projectedDrift,
  };
}

/**
 * Emit a “play the next runnable session now” request.
 *
 * We don't know which domain the user will tie this calculator into, but
 * for planning purposes "storehouse" and "garden" are good hints. The
 * SessionRunner (listening at the app root) should:
 *   - resolve to the next runnable session using domainHint,
 *   - if multiple sessions match, open its own selector,
 *   - then mount the SessionRunner modal.
 *
 * @param {("storehouse"|"garden"|"cooking"|"cleaning"|"animals"|"preservation")[]} domainHints
 */
function requestNextSession(domainHints) {
  try {
    const ts = new Date().toISOString();
    emitEvent({
      type: "session.requestNext",
      ts,
      source: "ScripturalYearLengthCalculator",
      data: {
        domainHints,
        reason: "calendar-planning",
        // This context can be used by the SessionRunner analytics layer
        // or Hub exporter to understand where the request came from.
        meta: {
          page: "calculators/calendar/scriptural-year-length",
        },
      },
    });
  } catch (err) {
    // Fails gracefully if eventBus is not wired yet.
    // eslint-disable-next-line no-console
    console.error(
      "[ScripturalYearLength] Failed to emit session.requestNext",
      err
    );
  }
}

function ScripturalYearLengthCalculatorPage() {
  const currentYear = new Date().getFullYear();

  const [anchorYear, setAnchorYear] = useState(currentYear);
  const [monthCount, setMonthCount] = useState(12);
  const [avgMonthLength, setAvgMonthLength] = useState(29.53);
  const [mode, setMode] = useState("average"); // "average" | "custom"
  const [driftYears, setDriftYears] = useState(7);

  // Simple 13-month default when user switches to custom mode.
  const [customMonths, setCustomMonths] = useState(
    Array.from({ length: 13 }, () => 29.5)
  );

  const handleCustomMonthChange = useCallback((index, value) => {
    setCustomMonths((prev) => {
      const next = [...prev];
      const parsed = parseFloat(value);
      next[index] = Number.isFinite(parsed) ? parsed : 0;
      return next;
    });
  }, []);

  const stats = useMemo(
    () =>
      computeYearStats({
        anchorYear: Number(anchorYear) || currentYear,
        monthCount: Number(monthCount) || 12,
        avgMonthLength: Number(avgMonthLength) || 29.53,
        mode,
        customMonths:
          mode === "custom" ? customMonths.slice(0, monthCount) : [],
        driftYears: Number(driftYears) || 7,
      }),
    [
      anchorYear,
      monthCount,
      avgMonthLength,
      mode,
      customMonths,
      driftYears,
      currentYear,
    ]
  );

  const handleNowClick = useCallback(() => {
    requestNextSession(["storehouse", "garden"]);
  }, []);

  const driftDirection =
    stats.diffPerYear > 0
      ? "longer"
      : stats.diffPerYear < 0
      ? "shorter"
      : "aligned";

  return (
    <div className="min-h-screen w-full bg-slate-950 text-slate-50 flex flex-col">
      {/* Page header */}
      <header className="border-b border-slate-800 bg-slate-900/60 backdrop-blur-sm">
        <div className="mx-auto max-w-6xl px-4 py-4 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl md:text-2xl font-semibold tracking-tight">
              Scriptural Year Length Calculator
            </h1>
            <p className="text-sm text-slate-400 max-w-2xl">
              Estimate the length of a scriptural (lunar/observed) year, compare
              it to the Gregorian year, and see how drift accumulates over time
              for feast days, storehouse planning, and garden cycles.
            </p>
          </div>

          {/* “Now” CTA → SessionRunner */}
          <div className="flex flex-col items-end gap-1">
            <button
              type="button"
              onClick={handleNowClick}
              className="inline-flex items-center gap-2 rounded-full bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950 shadow-md shadow-emerald-500/30 hover:bg-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-300 focus:ring-offset-2 focus:ring-offset-slate-950 transition"
            >
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-900 animate-pulse" />
              <span>Play Next Planning Session Now</span>
            </button>
            <p className="text-[11px] text-slate-500">
              Opens the next runnable{" "}
              <span className="font-semibold text-slate-300">
                storehouse / garden
              </span>{" "}
              session in the SessionRunner.
            </p>
          </div>
        </div>
      </header>

      {/* Optional Family Fund banner */}
      {familyFundMode && (
        <div className="bg-amber-500/10 border-b border-amber-500/40">
          <div className="mx-auto max-w-6xl px-4 py-2 text-xs text-amber-100 flex items-center gap-2">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-300" />
            <span className="font-semibold">Family Fund Mode is ON.</span>
            <span className="text-amber-200/80">
              Scriptural year outputs can be exported via the Hub when used
              inside a planning session.
            </span>
          </div>
        </div>
      )}

      {/* Main content */}
      <main className="flex-1">
        <div className="mx-auto max-w-6xl px-4 py-6 grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1.4fr)]">
          {/* Left: Inputs */}
          <section className="space-y-4">
            {/* Basic configuration card */}
            <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 md:p-5 shadow-lg shadow-slate-950/40">
              <h2 className="text-sm font-semibold text-slate-100 mb-3">
                1. Basic configuration
              </h2>
              <div className="grid gap-4 md:grid-cols-3">
                {/* Anchor year */}
                <div className="space-y-1">
                  <label
                    htmlFor="anchorYear"
                    className="block text-xs font-medium text-slate-300"
                  >
                    Anchor Gregorian year
                  </label>
                  <input
                    id="anchorYear"
                    type="number"
                    inputMode="numeric"
                    min="1"
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-50 outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400"
                    value={anchorYear}
                    onChange={(e) => setAnchorYear(e.target.value)}
                  />
                  <p className="text-[11px] text-slate-500">
                    Used to pick 365 vs 366 days for the comparison year.
                  </p>
                </div>

                {/* Month count */}
                <div className="space-y-1">
                  <label
                    htmlFor="monthCount"
                    className="block text-xs font-medium text-slate-300"
                  >
                    Months in scriptural year
                  </label>
                  <select
                    id="monthCount"
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-50 outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400"
                    value={monthCount}
                    onChange={(e) =>
                      setMonthCount(parseInt(e.target.value, 10))
                    }
                  >
                    <option value={12}>12 months (non-leap)</option>
                    <option value={13}>13 months (intercalated leap)</option>
                  </select>
                  <p className="text-[11px] text-slate-500">
                    Toggle when you add an intercalated month.
                  </p>
                </div>

                {/* Mode selector */}
                <div className="space-y-1">
                  <span className="block text-xs font-medium text-slate-300">
                    Month length mode
                  </span>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setMode("average")}
                      className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium ${
                        mode === "average"
                          ? "border-emerald-400 bg-emerald-500/10 text-emerald-200"
                          : "border-slate-700 bg-slate-900 text-slate-300 hover:border-slate-500"
                      }`}
                    >
                      Average
                    </button>
                    <button
                      type="button"
                      onClick={() => setMode("custom")}
                      className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium ${
                        mode === "custom"
                          ? "border-emerald-400 bg-emerald-500/10 text-emerald-200"
                          : "border-slate-700 bg-slate-900 text-slate-300 hover:border-slate-500"
                      }`}
                    >
                      Custom
                    </button>
                  </div>
                  <p className="text-[11px] text-slate-500">
                    Average: use a uniform month length. Custom: enter each
                    month&apos;s observed days.
                  </p>
                </div>
              </div>
            </div>

            {/* Month lengths card */}
            <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 md:p-5 shadow-lg shadow-slate-950/40">
              <h2 className="text-sm font-semibold text-slate-100 mb-3">
                2. Month length details
              </h2>

              {mode === "average" ? (
                <div className="grid gap-4 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] items-start">
                  <div className="space-y-2">
                    <label
                      htmlFor="avgMonthLength"
                      className="block text-xs font-medium text-slate-300"
                    >
                      Average month length (days)
                    </label>
                    <input
                      id="avgMonthLength"
                      type="number"
                      step="0.01"
                      min="1"
                      className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-50 outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400"
                      value={avgMonthLength}
                      onChange={(e) => setAvgMonthLength(e.target.value)}
                    />
                    <p className="text-[11px] text-slate-500">
                      The average synodic lunar month is about{" "}
                      <span className="font-semibold text-slate-300">
                        29.53 days
                      </span>
                      .
                    </p>
                  </div>
                  <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3 text-[11px] text-slate-400 space-y-1.5">
                    <p className="font-semibold text-slate-200">
                      Tip: alternating pattern
                    </p>
                    <p>
                      A common pattern is alternating 30 / 29 day months to stay
                      near 29.5 days on average. This calculator lets you tune
                      the average for your own observation rules.
                    </p>
                    <p>
                      Use the <span className="text-emerald-300">Custom</span>{" "}
                      mode if you track each month separately.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-[11px] text-slate-400">
                    Enter the observed day counts for each scriptural month.
                    Only the first{" "}
                    <span className="font-semibold">{monthCount}</span> months
                    will be used.
                  </p>
                  <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
                    {Array.from({ length: monthCount }).map((_, index) => (
                      <div key={index} className="space-y-1">
                        <label
                          htmlFor={`m-${index}`}
                          className="block text-[10px] font-medium text-slate-400"
                        >
                          Month {index + 1}
                        </label>
                        <input
                          id={`m-${index}`}
                          type="number"
                          min="1"
                          className="w-full rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-50 outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400"
                          value={customMonths[index] ?? ""}
                          onChange={(e) =>
                            handleCustomMonthChange(index, e.target.value)
                          }
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Drift configuration card */}
            <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 md:p-5 shadow-lg shadow-slate-950/40">
              <h2 className="text-sm font-semibold text-slate-100 mb-3">
                3. Drift projection
              </h2>
              <div className="grid gap-4 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1.5fr)] items-start">
                <div className="space-y-2">
                  <label
                    htmlFor="driftYears"
                    className="block text-xs font-medium text-slate-300"
                  >
                    Project drift over (years)
                  </label>
                  <input
                    id="driftYears"
                    type="number"
                    min="1"
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-50 outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400"
                    value={driftYears}
                    onChange={(e) => setDriftYears(e.target.value)}
                  />
                  <p className="text-[11px] text-slate-500">
                    Common checkpoints: 7 years, 19 years, 50 years (Jubilee).
                  </p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3 text-[11px] text-slate-400 space-y-1.5">
                  <p className="font-semibold text-slate-200">
                    Why drift matters
                  </p>
                  <ul className="list-disc list-inside space-y-1">
                    <li>Feast days can slide through the seasons.</li>
                    <li>
                      Planting windows may slowly move on the civil calendar.
                    </li>
                    <li>Storehouse targets may need adjustments each cycle.</li>
                  </ul>
                  <p>
                    Use this projection to decide when to intercalate an extra
                    month or adjust your rules.
                  </p>
                </div>
              </div>
            </div>
          </section>

          {/* Right: Results & integration tips */}
          <section className="space-y-4">
            {/* Results summary card */}
            <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4 md:p-5 shadow-xl shadow-slate-950/50">
              <h2 className="text-sm font-semibold text-slate-100 mb-3 flex items-center justify-between gap-2">
                <span>Year length summary</span>
                <span className="text-[11px] rounded-full bg-slate-950/70 px-2 py-0.5 border border-slate-700 text-slate-300">
                  Reference: {anchorYear}
                </span>
              </h2>

              <div className="grid gap-4">
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                    <p className="text-[11px] text-slate-400 mb-1">
                      Scriptural year length
                    </p>
                    <p className="text-lg font-semibold text-emerald-300">
                      {stats.scripturalYearDays.toFixed(2)}{" "}
                      <span className="text-xs text-slate-400">days</span>
                    </p>
                    <p className="text-[11px] text-slate-500 mt-1">
                      Based on {monthCount} months (
                      {mode === "average" ? "average mode" : "custom mode"}).
                    </p>
                  </div>

                  <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                    <p className="text-[11px] text-slate-400 mb-1">
                      Gregorian year length
                    </p>
                    <p className="text-lg font-semibold text-sky-300">
                      {stats.gregorianYearDays.toFixed(0)}{" "}
                      <span className="text-xs text-slate-400">days</span>
                    </p>
                    <p className="text-[11px] text-slate-500 mt-1">
                      {isLeapYear(anchorYear)
                        ? "Leap year (Feb 29 present)."
                        : "Common year."}
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                    <p className="text-[11px] text-slate-400 mb-1">
                      Difference per year
                    </p>
                    <p className="text-lg font-semibold text-amber-300">
                      {stats.diffPerYear >= 0 ? "+" : "-"}
                      {Math.abs(stats.diffPerYear).toFixed(2)}{" "}
                      <span className="text-xs text-slate-400">days</span>
                    </p>
                    <p className="text-[11px] text-slate-500 mt-1">
                      Your scriptural year is{" "}
                      <span className="font-semibold text-slate-200">
                        {driftDirection}
                      </span>{" "}
                      than the civil year.
                    </p>
                  </div>

                  <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                    <p className="text-[11px] text-slate-400 mb-1">
                      Projected drift over {driftYears || 0} years
                    </p>
                    <p className="text-lg font-semibold text-fuchsia-300">
                      {stats.projectedDrift >= 0 ? "+" : "-"}
                      {Math.abs(stats.projectedDrift).toFixed(2)}{" "}
                      <span className="text-xs text-slate-400">days</span>
                    </p>
                    <p className="text-[11px] text-slate-500 mt-1">
                      Roughly{" "}
                      <span className="font-semibold text-slate-200">
                        {(stats.projectedDrift / 7).toFixed(1)}
                      </span>{" "}
                      weeks of shift compared to a fixed civil date.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Integration with SSA card */}
            <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 md:p-5 shadow-lg shadow-slate-950/40">
              <h2 className="text-sm font-semibold text-slate-100 mb-3">
                How to use this inside Suka Smart Assistant
              </h2>
              <ul className="space-y-2 text-[11px] text-slate-300">
                <li className="flex gap-2">
                  <span className="mt-[3px] inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  <span>
                    <span className="font-semibold">Storehouse planning:</span>{" "}
                    use the year length and drift projection to set how many
                    cycles of grain, oil, and preserved foods you want ready
                    before key feast days.
                  </span>
                </li>
                <li className="flex gap-2">
                  <span className="mt-[3px] inline-block h-1.5 w-1.5 rounded-full bg-sky-400" />
                  <span>
                    <span className="font-semibold">Garden planning:</span> map
                    planting windows by scriptural month and watch how they move
                    across the civil calendar over decades.
                  </span>
                </li>
                <li className="flex gap-2">
                  <span className="mt-[3px] inline-block h-1.5 w-1.5 rounded-full bg-fuchsia-400" />
                  <span>
                    <span className="font-semibold">
                      Feast & sabbath calendar:
                    </span>{" "}
                    line up appointed times with your chosen year rules and
                    decide when to intercalate an extra month to keep seasons
                    aligned.
                  </span>
                </li>
                {familyFundMode && (
                  <li className="flex gap-2">
                    <span className="mt-[3px] inline-block h-1.5 w-1.5 rounded-full bg-amber-400" />
                    <span>
                      <span className="font-semibold">Family Fund Hub:</span>{" "}
                      when you launch a storehouse or garden session from this
                      page, completion analytics can be exported to the Hub to
                      show how your household plans time, food, and resources
                      over each scriptural cycle.
                    </span>
                  </li>
                )}
              </ul>

              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={handleNowClick}
                  className="inline-flex items-center gap-2 rounded-full border border-emerald-400/70 bg-emerald-500/10 px-3 py-1.5 text-[11px] font-medium text-emerald-200 hover:bg-emerald-500/15 focus:outline-none focus:ring-1 focus:ring-emerald-400"
                >
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-300" />
                  Start planning session with these numbers
                </button>
                <span className="text-[11px] text-slate-500">
                  The SessionRunner will stay active if you navigate to other
                  pages.
                </span>
              </div>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}

export default ScripturalYearLengthCalculatorPage;
