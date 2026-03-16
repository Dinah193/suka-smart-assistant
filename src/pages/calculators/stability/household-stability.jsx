// C:\Users\larho\suka-smart-assistant\src\pages\calculators\stability\household-stability.jsx
// -----------------------------------------------------------------------------
// HouseholdStabilityCalculator Route + Stability Dashboard
//
// How this fits the SSA system:
// - Lives under calculators/stability, giving a high-level picture of
//   household “stability” across domains SSA already serves:
//   • Storehouse / food readiness
//   • Cleaning & environment
//   • Garden & animals
//   • Time & schedule
//   • Money & obligations
// - Outputs a set of normalized scores (0–100) and simple categories that
//   other modules (or a future Planning Graph node) can reuse.
// - Exposes a “Now” CTA that emits a `session.requestNext` event so the
//   root-level SessionRunner can:
//     • resolve “the next runnable session” across cooking/cleaning/garden/
//       animals/preservation/storehouse based on hints,
//     • open the global SessionRunner modal (mounted in App.jsx),
//     • keep that runner alive across navigation with wake-lock, workers,
//       notifications, PiP, etc. (implemented elsewhere).
//
// Contracts used here:
// - eventBus.emitEvent({ type, ts, source, data })
// - featureFlags.familyFundMode (boolean)
//
// NOTE: This file does NOT implement the SessionRunner modal itself.
//       It only requests a session via the event bus and shows a local
//       informational modal specific to this calculator.
// -----------------------------------------------------------------------------

import React, { useCallback, useMemo, useState } from "react";
import { emitEvent } from "@/services/events/eventBus";
import { familyFundMode } from "@/config/featureFlags";

/**
 * @typedef {Object} StabilityInputs
 * @property {number} foodMonths          Months of staple food on hand
 * @property {number} waterDays          Days of safe water on hand
 * @property {number} cleaningScore      Self-rated cleaning routine (0–10)
 * @property {number} gardenCoverage     Percent of veg/fruit needs met by garden (0–100)
 * @property {number} animalCoverage     Percent of protein needs met by animals (0–100)
 * @property {number} scheduleMargin     Free hours per week you can redirect if needed
 * @property {number} debtLoad           Debt payments as % of monthly income (0–100+)
 * @property {number} savingsMonths      Months of expenses saved
 */

/**
 * Clamp a number between min and max.
 * @param {number} value
 * @param {number} min
 * @param {number} max
 */
function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Normalize a value to 0–100 with simple linear or inverse mappings.
 *
 * @param {number} value
 * @param {number} ideal     Ideal or “target” value (e.g., 6 months of food)
 * @param {number} max       Max considered value for scoring (beyond this is just 100)
 * @param {"direct"|"inverse"} mode
 */
function normalize(value, ideal, max, mode = "direct") {
  const v = clamp(value, 0, max);
  if (max <= 0) return 0;

  if (mode === "inverse") {
    // Lower is better. 0 → 100, ideal → ~80–90, max → ~0
    const ratio = 1 - v / max;
    return clamp(Math.round(ratio * 100), 0, 100);
  }

  // direct: higher is better. 0 → 0, ideal → ~85–90, max → 100
  const ratio = v / max;
  const score = ratio * 100;
  const boosted =
    v >= ideal
      ? clamp(85 + (score - (ideal / max) * 100) * 0.5, 0, 100)
      : score;
  return clamp(Math.round(boosted), 0, 100);
}

/**
 * Compute domain-level stability scores from inputs.
 *
 * @param {StabilityInputs} inputs
 */
function computeStabilityScores(inputs) {
  const foodScore = Math.round(
    (normalize(inputs.foodMonths, 3, 12, "direct") +
      normalize(inputs.waterDays, 7, 30, "direct")) /
      2
  );

  const cleaningScore = clamp(inputs.cleaningScore * 10, 0, 100);

  const productionScore = Math.round(
    (normalize(inputs.gardenCoverage, 30, 100, "direct") +
      normalize(inputs.animalCoverage, 30, 100, "direct")) /
      2
  );

  const timeScore = normalize(inputs.scheduleMargin, 5, 30, "direct");

  const financeScore = Math.round(
    (normalize(inputs.debtLoad, 10, 60, "inverse") +
      normalize(inputs.savingsMonths, 3, 12, "direct")) /
      2
  );

  const overall =
    (foodScore + cleaningScore + productionScore + timeScore + financeScore) /
    5;

  return {
    foodScore,
    cleaningScore,
    productionScore,
    timeScore,
    financeScore,
    overall: Math.round(overall),
  };
}

/**
 * Very simple label for a 0–100 score.
 * @param {number} score
 * @returns {"Unstable"|"Fragile"|"Developing"|"Steady"|"Strong"}
 */
function labelForScore(score) {
  if (score < 20) return "Unstable";
  if (score < 40) return "Fragile";
  if (score < 60) return "Developing";
  if (score < 80) return "Steady";
  return "Strong";
}

/**
 * Emit a “play the next runnable session now” request.
 *
 * We hint all core domains so the SessionRunner can choose:
 *   • cooking/cleaning/garden/animals/preservation/storehouse
 *
 * @param {("cooking"|"cleaning"|"garden"|"animals"|"preservation"|"storehouse")[]} domainHints
 */
function requestNextSession(domainHints) {
  try {
    const ts = new Date().toISOString();
    emitEvent({
      type: "session.requestNext",
      ts,
      source: "HouseholdStabilityCalculator",
      data: {
        domainHints,
        reason: "household-stability-followup",
        meta: {
          page: "calculators/stability/household-stability",
        },
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      "[HouseholdStability] Failed to emit session.requestNext",
      err
    );
  }
}

/**
 * Local info modal about how to interpret stability scores.
 * This is NOT the global SessionRunner; it is only for this page.
 */
function StabilityInfoModal({ open, onClose }) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative z-50 w-full max-w-xl rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl shadow-black/70 px-5 py-4">
        <div className="flex items-start justify-between gap-3 mb-3">
          <h2 className="text-sm font-semibold text-slate-100">
            How the Household Stability score works
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-slate-700 bg-slate-900 text-slate-300 text-xs hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-400"
          >
            ✕
          </button>
        </div>
        <div className="space-y-2 text-[11px] text-slate-300">
          <p>
            This dashboard is a{" "}
            <span className="font-semibold text-emerald-300">
              planning snapshot
            </span>
            , not a judgment. It helps you see where to direct your next
            cleaning, garden, storehouse, or animal care session.
          </p>
          <p>
            Scores are normalized between 0–100 and grouped by domain:
            food/water, cleaning, production (garden & animals), time margin,
            and finances. The{" "}
            <span className="font-semibold text-slate-100">
              Overall Stability
            </span>{" "}
            is the simple average.
          </p>
          <ul className="list-disc list-inside space-y-1 text-slate-300">
            <li>
              <span className="font-semibold">Unstable / Fragile:</span> focus
              on one small, winnable improvement session (e.g., shelf-stable
              foods or one cleaning zone).
            </li>
            <li>
              <span className="font-semibold">Developing / Steady:</span> you
              have a base; now refine routines and increase resilience.
            </li>
            <li>
              <span className="font-semibold">Strong:</span> maintain and
              document what works so others in your family can plug in.
            </li>
          </ul>
          <p className="text-slate-400">
            When you click{" "}
            <span className="font-semibold text-emerald-300">
              Play Next Session Now
            </span>
            , the global SessionRunner will open a focused session. It stays
            active even if you navigate to other SSA pages.
          </p>
        </div>
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center justify-center rounded-full bg-emerald-500 px-4 py-1.5 text-xs font-semibold text-slate-950 hover:bg-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-300"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Simple pill-style badge for a score category.
 */
function ScoreBadge({ score }) {
  const label = labelForScore(score);
  let bg = "bg-slate-800 text-slate-100 border-slate-600";

  if (score < 20) bg = "bg-rose-900/50 text-rose-100 border-rose-500/60";
  else if (score < 40)
    bg = "bg-amber-900/40 text-amber-100 border-amber-500/70";
  else if (score < 60) bg = "bg-sky-900/40 text-sky-100 border-sky-500/70";
  else if (score < 80)
    bg = "bg-emerald-900/40 text-emerald-100 border-emerald-500/70";
  else bg = "bg-emerald-700/40 text-emerald-50 border-emerald-300/80";

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${bg}`}
    >
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
      <span>{label}</span>
    </span>
  );
}

/**
 * Horizontal bar visual for a 0–100 score.
 */
function ScoreBar({ score }) {
  const clamped = clamp(score, 0, 100);
  return (
    <div className="h-2 w-full rounded-full bg-slate-800 overflow-hidden">
      <div
        className="h-full rounded-full bg-emerald-400"
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

function HouseholdStabilityCalculatorPage() {
  // Inputs
  const [foodMonths, setFoodMonths] = useState(1);
  const [waterDays, setWaterDays] = useState(3);
  const [cleaningScore, setCleaningScore] = useState(5);
  const [gardenCoverage, setGardenCoverage] = useState(10);
  const [animalCoverage, setAnimalCoverage] = useState(0);
  const [scheduleMargin, setScheduleMargin] = useState(3);
  const [debtLoad, setDebtLoad] = useState(20);
  const [savingsMonths, setSavingsMonths] = useState(0.5);

  const [infoOpen, setInfoOpen] = useState(false);

  const scores = useMemo(
    () =>
      computeStabilityScores({
        foodMonths: Number(foodMonths) || 0,
        waterDays: Number(waterDays) || 0,
        cleaningScore: Number(cleaningScore) || 0,
        gardenCoverage: Number(gardenCoverage) || 0,
        animalCoverage: Number(animalCoverage) || 0,
        scheduleMargin: Number(scheduleMargin) || 0,
        debtLoad: Number(debtLoad) || 0,
        savingsMonths: Number(savingsMonths) || 0,
      }),
    [
      foodMonths,
      waterDays,
      cleaningScore,
      gardenCoverage,
      animalCoverage,
      scheduleMargin,
      debtLoad,
      savingsMonths,
    ]
  );

  const handleNowClick = useCallback(() => {
    requestNextSession([
      "storehouse",
      "cooking",
      "cleaning",
      "garden",
      "animals",
      "preservation",
    ]);
  }, []);

  return (
    <div className="min-h-screen w-full bg-slate-950 text-slate-50 flex flex-col">
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-900/70 backdrop-blur-sm">
        <div className="mx-auto max-w-6xl px-4 py-4 flex items-center justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-xl md:text-2xl font-semibold tracking-tight">
              Household Stability Calculator
            </h1>
            <p className="text-sm text-slate-400 max-w-2xl">
              Take a quick snapshot of your household&apos;s stability across
              food, cleaning, garden, animals, time, and finances—then launch a
              focused session to improve the weakest area.
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
              <span>Play Next Stability Session Now</span>
            </button>
            <p className="text-[11px] text-slate-500">
              The SessionRunner will stay active while you move around SSA.
            </p>
          </div>
        </div>
      </header>

      {/* Family Fund banner */}
      {familyFundMode && (
        <div className="bg-emerald-500/10 border-b border-emerald-500/40">
          <div className="mx-auto max-w-6xl px-4 py-2 text-xs text-emerald-100 flex items-center gap-2">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-300" />
            <span className="font-semibold">Family Fund Mode is ON.</span>
            <span className="text-emerald-200/80">
              Completed stability sessions can be exported to the Hub to track
              your household&apos;s progress over seasons and years.
            </span>
          </div>
        </div>
      )}

      {/* Main content */}
      <main className="flex-1">
        <div className="mx-auto max-w-6xl px-4 py-6 grid gap-6 lg:grid-cols-[minmax(0,2.1fr)_minmax(0,1.4fr)]">
          {/* Left: Inputs & sliders */}
          <section className="space-y-4">
            <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 md:p-5 shadow-lg shadow-slate-950/40">
              <div className="flex items-center justify-between gap-3 mb-3">
                <h2 className="text-sm font-semibold text-slate-100">
                  1. Essentials & routines
                </h2>
                <button
                  type="button"
                  onClick={() => setInfoOpen(true)}
                  className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-950/60 px-2.5 py-1 text-[11px] text-slate-300 hover:border-emerald-400 hover:text-emerald-200 focus:outline-none focus:ring-1 focus:ring-emerald-400"
                >
                  <span className="text-xs">ⓘ</span>
                  <span>How scoring works</span>
                </button>
              </div>

              {/* Food & water */}
              <div className="grid gap-4 md:grid-cols-2 mb-4">
                {/* Food months */}
                <div className="space-y-1">
                  <label
                    htmlFor="foodMonths"
                    className="block text-xs font-medium text-slate-300"
                  >
                    Months of staple food on hand
                  </label>
                  <input
                    id="foodMonths"
                    type="number"
                    min="0"
                    step="0.5"
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-50 outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400"
                    value={foodMonths}
                    onChange={(e) => setFoodMonths(e.target.value)}
                  />
                  <p className="text-[11px] text-slate-500">
                    Rough estimate: “If stores closed, how many months could we
                    eat from the storehouse?”
                  </p>
                </div>

                {/* Water days */}
                <div className="space-y-1">
                  <label
                    htmlFor="waterDays"
                    className="block text-xs font-medium text-slate-300"
                  >
                    Days of safe water on hand
                  </label>
                  <input
                    id="waterDays"
                    type="number"
                    min="0"
                    step="1"
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-50 outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400"
                    value={waterDays}
                    onChange={(e) => setWaterDays(e.target.value)}
                  />
                  <p className="text-[11px] text-slate-500">
                    Bottled water, stored water, and what you can purify
                    quickly.
                  </p>
                </div>
              </div>

              {/* Cleaning routine slider */}
              <div className="space-y-1 mb-2">
                <label
                  htmlFor="cleaningScore"
                  className="block text-xs font-medium text-slate-300"
                >
                  Cleaning routine strength (0–10)
                </label>
                <input
                  id="cleaningScore"
                  type="range"
                  min="0"
                  max="10"
                  step="1"
                  className="w-full accent-emerald-400"
                  value={cleaningScore}
                  onChange={(e) =>
                    setCleaningScore(parseInt(e.target.value, 10))
                  }
                />
                <div className="flex items-center justify-between text-[11px] text-slate-500">
                  <span>0 = chaotic / reactive</span>
                  <span className="font-semibold text-slate-200">
                    {cleaningScore}/10
                  </span>
                  <span>10 = smooth weekly cycles</span>
                </div>
              </div>
            </div>

            {/* Production: garden & animals */}
            <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 md:p-5 shadow-lg shadow-slate-950/40">
              <h2 className="text-sm font-semibold text-slate-100 mb-3">
                2. Garden & animals (food production)
              </h2>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-1">
                  <label
                    htmlFor="gardenCoverage"
                    className="block text-xs font-medium text-slate-300"
                  >
                    Garden coverage of veg/fruit needs (%)
                  </label>
                  <input
                    id="gardenCoverage"
                    type="number"
                    min="0"
                    max="200"
                    step="1"
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-50 outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400"
                    value={gardenCoverage}
                    onChange={(e) => setGardenCoverage(e.target.value)}
                  />
                  <p className="text-[11px] text-slate-500">
                    0% = store only. 100% = most produce from your garden.
                  </p>
                </div>

                <div className="space-y-1">
                  <label
                    htmlFor="animalCoverage"
                    className="block text-xs font-medium text-slate-300"
                  >
                    Animals coverage of protein needs (%)
                  </label>
                  <input
                    id="animalCoverage"
                    type="number"
                    min="0"
                    max="200"
                    step="1"
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-50 outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400"
                    value={animalCoverage}
                    onChange={(e) => setAnimalCoverage(e.target.value)}
                  />
                  <p className="text-[11px] text-slate-500">
                    Eggs, meat, milk, etc. Even 10–20% adds resilience.
                  </p>
                </div>
              </div>
            </div>

            {/* Time & finances */}
            <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 md:p-5 shadow-lg shadow-slate-950/40">
              <h2 className="text-sm font-semibold text-slate-100 mb-3">
                3. Time & finances
              </h2>
              <div className="grid gap-4 md:grid-cols-2">
                {/* Schedule margin */}
                <div className="space-y-1">
                  <label
                    htmlFor="scheduleMargin"
                    className="block text-xs font-medium text-slate-300"
                  >
                    Free hours per week you could redirect
                  </label>
                  <input
                    id="scheduleMargin"
                    type="number"
                    min="0"
                    max="80"
                    step="0.5"
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-50 outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400"
                    value={scheduleMargin}
                    onChange={(e) => setScheduleMargin(e.target.value)}
                  />
                  <p className="text-[11px] text-slate-500">
                    Realistic, not ideal. How much can you shift toward projects
                    in a typical week?
                  </p>
                </div>

                {/* Debt load */}
                <div className="space-y-1">
                  <label
                    htmlFor="debtLoad"
                    className="block text-xs font-medium text-slate-300"
                  >
                    Debt payments as % of monthly income
                  </label>
                  <input
                    id="debtLoad"
                    type="number"
                    min="0"
                    max="200"
                    step="1"
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-50 outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400"
                    value={debtLoad}
                    onChange={(e) => setDebtLoad(e.target.value)}
                  />
                  <p className="text-[11px] text-slate-500">
                    Lower is better. High debt loads make it harder to pivot or
                    absorb shocks.
                  </p>
                </div>

                {/* Savings months */}
                <div className="space-y-1 md:col-span-2">
                  <label
                    htmlFor="savingsMonths"
                    className="block text-xs font-medium text-slate-300"
                  >
                    Months of essential expenses saved
                  </label>
                  <input
                    id="savingsMonths"
                    type="number"
                    min="0"
                    max="60"
                    step="0.5"
                    className="w-full md:max-w-xs rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-50 outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400"
                    value={savingsMonths}
                    onChange={(e) => setSavingsMonths(e.target.value)}
                  />
                  <p className="text-[11px] text-slate-500">
                    Even 0.5–1 month is a good start. Set it honestly—this is
                    for you, not for show.
                  </p>
                </div>
              </div>
            </div>
          </section>

          {/* Right: Stability dashboard */}
          <section className="space-y-4">
            {/* Overall score card */}
            <div className="rounded-2xl border border-emerald-500/50 bg-emerald-500/10 p-4 md:p-5 shadow-xl shadow-emerald-950/50">
              <div className="flex items-start justify-between gap-3 mb-2">
                <div>
                  <h2 className="text-sm font-semibold text-emerald-100">
                    Overall Stability Snapshot
                  </h2>
                  <p className="text-[11px] text-emerald-100/80">
                    A quick view combining food, routines, production, time, and
                    finances.
                  </p>
                </div>
                <ScoreBadge score={scores.overall} />
              </div>

              <div className="flex items-baseline gap-3 mb-2">
                <p className="text-3xl font-bold text-emerald-50">
                  {scores.overall}
                </p>
                <p className="text-xs text-emerald-100/80">out of 100</p>
              </div>

              <ScoreBar score={scores.overall} />

              <p className="mt-2 text-[11px] text-emerald-100/80">
                Use this as a compass, not a verdict. Pick{" "}
                <span className="font-semibold">one weak area</span> and launch
                a session to strengthen it this week.
              </p>

              <div className="mt-3 flex flex-wrap gap-2 items-center">
                <button
                  type="button"
                  onClick={handleNowClick}
                  className="inline-flex items-center gap-2 rounded-full border border-emerald-300/80 bg-emerald-900/40 px-3 py-1.5 text-[11px] font-medium text-emerald-100 hover:bg-emerald-800/70 focus:outline-none focus:ring-1 focus:ring-emerald-300"
                >
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-200" />
                  Start a stability-focused session
                </button>
                <span className="text-[11px] text-emerald-100/80">
                  SessionRunner will keep timers and cues even if you switch
                  pages.
                </span>
              </div>
            </div>

            {/* Domain breakdown grid */}
            <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4 md:p-5 shadow-lg shadow-slate-950/50">
              <h2 className="text-sm font-semibold text-slate-100 mb-3">
                Stability by domain
              </h2>
              <div className="grid gap-3">
                {/* Food & water */}
                <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-xs font-medium text-slate-100">
                      Food & water
                    </p>
                    <ScoreBadge score={scores.foodScore} />
                  </div>
                  <ScoreBar score={scores.foodScore} />
                  <p className="mt-1 text-[11px] text-slate-400">
                    Aim for at least{" "}
                    <span className="font-semibold">3 months</span> of staple
                    foods and 7+ days of water. If this is your lowest score,
                    consider a{" "}
                    <span className="font-semibold text-emerald-300">
                      storehouse session
                    </span>
                    .
                  </p>
                </div>

                {/* Cleaning */}
                <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-xs font-medium text-slate-100">
                      Cleaning & routines
                    </p>
                    <ScoreBadge score={scores.cleaningScore} />
                  </div>
                  <ScoreBar score={scores.cleaningScore} />
                  <p className="mt-1 text-[11px] text-slate-400">
                    Strong cleaning cycles reduce stress and sickness. If this
                    score is low, launch a{" "}
                    <span className="font-semibold text-emerald-300">
                      cleaning session
                    </span>{" "}
                    targeting one room or zone.
                  </p>
                </div>

                {/* Garden & animals */}
                <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-xs font-medium text-slate-100">
                      Garden & animals
                    </p>
                    <ScoreBadge score={scores.productionScore} />
                  </div>
                  <ScoreBar score={scores.productionScore} />
                  <p className="mt-1 text-[11px] text-slate-400">
                    Even a few beds or a small flock matters. Use{" "}
                    <span className="font-semibold text-emerald-300">
                      garden
                    </span>{" "}
                    or{" "}
                    <span className="font-semibold text-emerald-300">
                      animals
                    </span>{" "}
                    sessions to build routines for planting, feeding, and
                    harvesting.
                  </p>
                </div>

                {/* Time margin */}
                <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-xs font-medium text-slate-100">
                      Time margin
                    </p>
                    <ScoreBadge score={scores.timeScore} />
                  </div>
                  <ScoreBar score={scores.timeScore} />
                  <p className="mt-1 text-[11px] text-slate-400">
                    If your week has no breathing room, even small projects feel
                    heavy. Use{" "}
                    <span className="font-semibold text-emerald-300">
                      cleaning
                    </span>{" "}
                    or{" "}
                    <span className="font-semibold text-emerald-300">
                      cooking
                    </span>{" "}
                    sessions to batch tasks and free future hours.
                  </p>
                </div>

                {/* Finances */}
                <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-xs font-medium text-slate-100">
                      Financial resilience
                    </p>
                    <ScoreBadge score={scores.financeScore} />
                  </div>
                  <ScoreBar score={scores.financeScore} />
                  <p className="mt-1 text-[11px] text-slate-400">
                    High debt and low savings make shocks harder. Use storehouse
                    sessions to shift spending toward staples and savings while
                    still eating well.
                  </p>
                </div>
              </div>
            </div>

            {/* Tiny hint on Family Fund if enabled */}
            {familyFundMode && (
              <div className="rounded-2xl border border-emerald-500/40 bg-emerald-900/30 p-3 text-[11px] text-emerald-100 shadow-md shadow-emerald-950/40">
                <p className="font-semibold mb-1">
                  Stability over time in the Family Fund Hub
                </p>
                <p>
                  As you run sessions from this dashboard, their analytics can
                  be aggregated in the Hub to show how your scores change by
                  season, year, and major life events.
                </p>
              </div>
            )}
          </section>
        </div>
      </main>

      {/* Local informational modal */}
      <StabilityInfoModal open={infoOpen} onClose={() => setInfoOpen(false)} />
    </div>
  );
}

export default HouseholdStabilityCalculatorPage;
