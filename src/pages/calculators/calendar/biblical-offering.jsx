// C:\Users\larho\suka-smart-assistant\src\pages\calculators\calendar\biblical-offering.jsx
// -----------------------------------------------------------------------------
// BiblicalOfferingCalculator Route
//
// How this fits the SSA system:
// - Lives under calculators/calendar for planning offerings by scriptural year.
// - Helps a household turn harvest + income into a simple, transparent plan for:
//   • Firstfruits
//   • Tithes
//   • Festival offerings
//   • Support for poor/Levites
//   • Freewill offerings
// - Exposes a “Now” CTA that asks the root-level SessionRunner to:
//   • resolve the next runnable storehouse / garden / animals session,
//   • open the global SessionRunner modal (mounted in App.jsx) so it
//     remains active across navigation (wake-lock, notifications, PiP, etc.).
// - Uses the shared eventBus (emitEvent) + featureFlags.familyFundMode.
//
// NOTE: This file does NOT implement the SessionRunner itself.
//       It only requests a session via `session.requestNext`.
//       The global SessionRunner listener handles:
//         • session.started, session.step.changed, etc.
//         • wake-lock, notifications, PiP
//         • Dexie persistence + auto-resume
// -----------------------------------------------------------------------------

import React, { useCallback, useMemo, useState } from "react";
import { familyFundMode } from "@/services/featureFlags";
import { emitEvent } from "@/services/eventBus";

/**
 * @typedef {Object} OfferingPercents
 * @property {number} firstfruits
 * @property {number} tithe
 * @property {number} festivals
 * @property {number} poor
 * @property {number} freewill
 */

/**
 * @typedef {Object} OfferingInputs
 * @property {number} harvestValue     Total value of harvest (grain, wine, oil, livestock, etc.)
 * @property {number} incomeValue      Total value of wages/business income
 * @property {number} otherValue       Gifts, windfalls, etc. you choose to include
 * @property {"harvest"|"income"|"combined"} basis
 * @property {OfferingPercents} percents
 */

/**
 * Safely parse a numeric input.
 * @param {string|number} value
 * @returns {number}
 */
function toSafeNumber(value) {
  const n = typeof value === "number" ? value : parseFloat(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

/**
 * Compute offering breakdown based on inputs.
 *
 * @param {OfferingInputs} inputs
 */
function computeOfferings(inputs) {
  const harvestValue = toSafeNumber(inputs.harvestValue);
  const incomeValue = toSafeNumber(inputs.incomeValue);
  const otherValue = toSafeNumber(inputs.otherValue);

  let baseValue = 0;
  switch (inputs.basis) {
    case "harvest":
      baseValue = harvestValue + otherValue;
      break;
    case "income":
      baseValue = incomeValue + otherValue;
      break;
    case "combined":
    default:
      baseValue = harvestValue + incomeValue + otherValue;
      break;
  }

  const p = inputs.percents;
  const firstfruits = baseValue * (toSafeNumber(p.firstfruits) / 100);
  const tithe = baseValue * (toSafeNumber(p.tithe) / 100);
  const festivals = baseValue * (toSafeNumber(p.festivals) / 100);
  const poor = baseValue * (toSafeNumber(p.poor) / 100);
  const freewill = baseValue * (toSafeNumber(p.freewill) / 100);

  const totalOfferings = firstfruits + tithe + festivals + poor + freewill;
  const remaining = baseValue - totalOfferings;
  const percentSum =
    toSafeNumber(p.firstfruits) +
    toSafeNumber(p.tithe) +
    toSafeNumber(p.festivals) +
    toSafeNumber(p.poor) +
    toSafeNumber(p.freewill);

  return {
    baseValue,
    firstfruits,
    tithe,
    festivals,
    poor,
    freewill,
    totalOfferings,
    remaining,
    percentSum,
  };
}

/**
 * Emit a “play the next runnable session now” request.
 *
 * We hint domains that are closely related to offerings planning:
 *   - storehouse (where offerings are held/managed)
 *   - garden (produce offerings)
 *   - animals (livestock offerings)
 *
 * @param {("storehouse"|"garden"|"animals"|"cooking"|"cleaning"|"preservation")[]} domainHints
 */
function requestNextSession(domainHints) {
  try {
    const ts = new Date().toISOString();
    emitEvent({
      type: "session.requestNext",
      ts,
      source: "BiblicalOfferingCalculator",
      data: {
        domainHints,
        reason: "biblical-offering-planning",
        meta: {
          page: "calculators/calendar/biblical-offering",
        },
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[BiblicalOfferingCalculator] Failed to emit session.requestNext", err);
  }
}

/**
 * Lightweight explanation modal (informational only).
 * NOT the SessionRunner — just a local UI helper.
 */
function OfferingNotesModal({ open, onClose }) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm"
        onClick={onClose}
      />
      {/* Modal content */}
      <div className="relative z-50 w-full max-w-lg rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl shadow-black/60 px-5 py-4">
        <div className="flex items-start justify-between gap-3 mb-3">
          <h2 className="text-sm font-semibold text-slate-100">
            About this calculator
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
            This tool is a planning aid only. Percentages and categories are
            configurable so each household can align with its convictions and
            local leadership.
          </p>
          <p>
            You can base offerings on harvest, income, or both. Values may be
            in your local currency or in “value units” if you track offerings in
           -kind (grain, oil, livestock).
          </p>
          <p>
            After you&apos;re comfortable with the numbers, use{" "}
            <span className="font-semibold text-emerald-300">
              Play Next Session Now
            </span>{" "}
            to move into a practical storehouse / garden / animals session. The
            SessionRunner will stay active in the background even if you
            navigate to other SSA pages.
          </p>
          <p className="text-slate-400">
            Nothing here is stored or exported automatically. Your offering plan
            only becomes part of analytics when you actually run and complete a
            related session.
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

function BiblicalOfferingCalculatorPage() {
  const [basis, setBasis] = useState("combined"); // "harvest" | "income" | "combined"
  const [harvestValue, setHarvestValue] = useState("");
  const [incomeValue, setIncomeValue] = useState("");
  const [otherValue, setOtherValue] = useState("");

  const [percents, setPercents] = useState({
    firstfruits: 2,
    tithe: 10,
    festivals: 5,
    poor: 3,
    freewill: 0,
  });

  const [notesOpen, setNotesOpen] = useState(false);

  const handlePercentChange = useCallback((field, value) => {
    setPercents((prev) => ({
      ...prev,
      [field]: value,
    }));
  }, []);

  const stats = useMemo(
    () =>
      computeOfferings({
        basis,
        harvestValue: toSafeNumber(harvestValue),
        incomeValue: toSafeNumber(incomeValue),
        otherValue: toSafeNumber(otherValue),
        percents: {
          firstfruits: toSafeNumber(percents.firstfruits),
          tithe: toSafeNumber(percents.tithe),
          festivals: toSafeNumber(percents.festivals),
          poor: toSafeNumber(percents.poor),
          freewill: toSafeNumber(percents.freewill),
        },
      }),
    [basis, harvestValue, incomeValue, otherValue, percents]
  );

  const handleNowClick = useCallback(() => {
    requestNextSession(["storehouse", "garden", "animals"]);
  }, []);

  const percentTooHigh = stats.percentSum > 100.01;

  return (
    <div className="min-h-screen w-full bg-slate-950 text-slate-50 flex flex-col">
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-900/70 backdrop-blur-sm">
        <div className="mx-auto max-w-6xl px-4 py-4 flex items-center justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-xl md:text-2xl font-semibold tracking-tight">
              Biblical Offering Calculator
            </h1>
            <p className="text-sm text-slate-400 max-w-2xl">
              Turn harvest and income into a clear, peaceful offering plan for
              firstfruits, tithes, feast offerings, care for the poor, and
              freewill giving—aligned with your scriptural calendar.
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
              <span>Play Next Storehouse Session Now</span>
            </button>
            <p className="text-[11px] text-slate-500">
              Opens the next runnable{" "}
              <span className="font-semibold text-slate-300">
                storehouse / garden / animals
              </span>{" "}
              session in the SessionRunner.
            </p>
          </div>
        </div>
      </header>

      {/* Family Fund banner */}
      {familyFundMode && (
        <div className="bg-indigo-500/10 border-b border-indigo-500/40">
          <div className="mx-auto max-w-6xl px-4 py-2 text-xs text-indigo-100 flex items-center gap-2">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-indigo-300" />
            <span className="font-semibold">Family Fund Mode is ON.</span>
            <span className="text-indigo-200/80">
              Offering plans completed through sessions can be exported to the
              Hub for household analytics.
            </span>
          </div>
        </div>
      )}

      {/* Main content */}
      <main className="flex-1">
        <div className="mx-auto max-w-6xl px-4 py-6 grid gap-6 lg:grid-cols-[minmax(0,2.1fr)_minmax(0,1.3fr)]">
          {/* Left: Inputs */}
          <section className="space-y-4">
            {/* Basis & totals */}
            <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 md:p-5 shadow-lg shadow-slate-950/40">
              <div className="flex items-center justify-between gap-3 mb-3">
                <h2 className="text-sm font-semibold text-slate-100">
                  1. Household totals
                </h2>
                <button
                  type="button"
                  onClick={() => setNotesOpen(true)}
                  className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-950/60 px-2.5 py-1 text-[11px] text-slate-300 hover:border-emerald-400 hover:text-emerald-200 focus:outline-none focus:ring-1 focus:ring-emerald-400"
                >
                  <span className="text-xs">ⓘ</span>
                  <span>View assumptions &amp; notes</span>
                </button>
              </div>

              {/* Basis selector */}
              <div className="mb-4">
                <span className="block text-xs font-medium text-slate-300 mb-1">
                  Offering basis
                </span>
                <div className="inline-flex rounded-full bg-slate-950/70 border border-slate-700 overflow-hidden text-[11px]">
                  <button
                    type="button"
                    onClick={() => setBasis("harvest")}
                    className={`px-3 py-1.5 ${
                      basis === "harvest"
                        ? "bg-emerald-500 text-slate-950 font-semibold"
                        : "text-slate-300 hover:bg-slate-800"
                    }`}
                  >
                    Harvest only
                  </button>
                  <button
                    type="button"
                    onClick={() => setBasis("income")}
                    className={`px-3 py-1.5 border-x border-slate-700 ${
                      basis === "income"
                        ? "bg-emerald-500 text-slate-950 font-semibold"
                        : "text-slate-300 hover:bg-slate-800"
                    }`}
                  >
                    Income only
                  </button>
                  <button
                    type="button"
                    onClick={() => setBasis("combined")}
                    className={`px-3 py-1.5 ${
                      basis === "combined"
                        ? "bg-emerald-500 text-slate-950 font-semibold"
                        : "text-slate-300 hover:bg-slate-800"
                    }`}
                  >
                    Combined
                  </button>
                </div>
                <p className="mt-1 text-[11px] text-slate-500">
                  Choose whether offerings are based on harvest, income, or the
                  combination of all increase.
                </p>
              </div>

              {/* Totals grid */}
              <div className="grid gap-4 md:grid-cols-3">
                {/* Harvest value */}
                <div className="space-y-1">
                  <label
                    htmlFor="harvestValue"
                    className="block text-xs font-medium text-slate-300"
                  >
                    Harvest value
                  </label>
                  <input
                    id="harvestValue"
                    type="number"
                    min="0"
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-50 outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400"
                    value={harvestValue}
                    onChange={(e) => setHarvestValue(e.target.value)}
                  />
                  <p className="text-[11px] text-slate-500">
                    Total value of grain, wine, oil, livestock, etc. for this
                    scriptural year.
                  </p>
                </div>

                {/* Income value */}
                <div className="space-y-1">
                  <label
                    htmlFor="incomeValue"
                    className="block text-xs font-medium text-slate-300"
                  >
                    Income value
                  </label>
                  <input
                    id="incomeValue"
                    type="number"
                    min="0"
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-50 outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400"
                    value={incomeValue}
                    onChange={(e) => setIncomeValue(e.target.value)}
                  />
                  <p className="text-[11px] text-slate-500">
                    Wages, business income, etc. that you choose to include.
                  </p>
                </div>

                {/* Other value */}
                <div className="space-y-1">
                  <label
                    htmlFor="otherValue"
                    className="block text-xs font-medium text-slate-300"
                  >
                    Other gifts / increase
                  </label>
                  <input
                    id="otherValue"
                    type="number"
                    min="0"
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-50 outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400"
                    value={otherValue}
                    onChange={(e) => setOtherValue(e.target.value)}
                  />
                  <p className="text-[11px] text-slate-500">
                    Gifts, windfalls, or other increases you want to treat as
                    part of your offering base.
                  </p>
                </div>
              </div>

              {/* Base value preview */}
              <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-sm flex items-center justify-between gap-3">
                <div>
                  <p className="text-[11px] text-slate-400 mb-0.5">
                    Current offering base
                  </p>
                  <p className="text-lg font-semibold text-emerald-300">
                    {stats.baseValue.toFixed(2)}{" "}
                    <span className="text-xs text-slate-400">value units</span>
                  </p>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    You can treat this as your local currency or as a unit
                    representing food/livestock value.
                  </p>
                </div>
                <div className="text-[11px] text-slate-400">
                  <p>
                    Basis:{" "}
                    <span className="font-semibold text-slate-200">
                      {basis === "combined"
                        ? "Harvest + Income + Other"
                        : basis === "harvest"
                        ? "Harvest + Other"
                        : "Income + Other"}
                    </span>
                  </p>
                </div>
              </div>
            </div>

            {/* Percentages */}
            <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 md:p-5 shadow-lg shadow-slate-950/40">
              <h2 className="text-sm font-semibold text-slate-100 mb-3">
                2. Offering percentages
              </h2>
              <p className="text-[11px] text-slate-500 mb-3">
                Adjust these to match your household&apos;s understanding. The
                calculator will show totals and any over/under allocation.
              </p>

              <div className="grid gap-3 md:grid-cols-2">
                {/* Firstfruits */}
                <div className="space-y-1">
                  <label
                    htmlFor="p-firstfruits"
                    className="block text-xs font-medium text-slate-300"
                  >
                    Firstfruits (% of base)
                  </label>
                  <input
                    id="p-firstfruits"
                    type="number"
                    min="0"
                    step="0.1"
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-50 outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400"
                    value={percents.firstfruits}
                    onChange={(e) =>
                      handlePercentChange("firstfruits", e.target.value)
                    }
                  />
                  <p className="text-[11px] text-slate-500">
                    A small, set-apart portion at the beginning of increase.
                  </p>
                </div>

                {/* Tithe */}
                <div className="space-y-1">
                  <label
                    htmlFor="p-tithe"
                    className="block text-xs font-medium text-slate-300"
                  >
                    Tithes (% of base)
                  </label>
                  <input
                    id="p-tithe"
                    type="number"
                    min="0"
                    step="0.1"
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-50 outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400"
                    value={percents.tithe}
                    onChange={(e) => handlePercentChange("tithe", e.target.value)}
                  />
                  <p className="text-[11px] text-slate-500">
                    Common baseline is 10%. Adjust as needed.
                  </p>
                </div>

                {/* Festivals */}
                <div className="space-y-1">
                  <label
                    htmlFor="p-festivals"
                    className="block text-xs font-medium text-slate-300"
                  >
                    Festival offerings (% of base)
                  </label>
                  <input
                    id="p-festivals"
                    type="number"
                    min="0"
                    step="0.1"
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-50 outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400"
                    value={percents.festivals}
                    onChange={(e) =>
                      handlePercentChange("festivals", e.target.value)
                    }
                  />
                  <p className="text-[11px] text-slate-500">
                    Budget for travel, animals, special meals, and rejoicing at
                    appointed times.
                  </p>
                </div>

                {/* Poor / Levites */}
                <div className="space-y-1">
                  <label
                    htmlFor="p-poor"
                    className="block text-xs font-medium text-slate-300"
                  >
                    Poor / Levites (% of base)
                  </label>
                  <input
                    id="p-poor"
                    type="number"
                    min="0"
                    step="0.1"
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-50 outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400"
                    value={percents.poor}
                    onChange={(e) => handlePercentChange("poor", e.target.value)}
                  />
                  <p className="text-[11px] text-slate-500">
                    Helping widows, orphans, strangers, and those who minister.
                  </p>
                </div>

                {/* Freewill */}
                <div className="space-y-1 md:col-span-2">
                  <label
                    htmlFor="p-freewill"
                    className="block text-xs font-medium text-slate-300"
                  >
                    Freewill offerings (% of base)
                  </label>
                  <input
                    id="p-freewill"
                    type="number"
                    min="0"
                    step="0.1"
                    className="w-full md:max-w-xs rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-50 outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400"
                    value={percents.freewill}
                    onChange={(e) =>
                      handlePercentChange("freewill", e.target.value)
                    }
                  />
                  <p className="text-[11px] text-slate-500">
                    Extra giving when your heart is moved—above structured
                    offerings.
                  </p>
                </div>
              </div>

              {/* Percent sum indicator */}
              <div className="mt-4 flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-[11px]">
                <div>
                  <p className="text-slate-400 mb-0.5">
                    Total allocated percentage
                  </p>
                  <p
                    className={`text-sm font-semibold ${
                      percentTooHigh ? "text-rose-300" : "text-emerald-300"
                    }`}
                  >
                    {stats.percentSum.toFixed(2)}%
                  </p>
                </div>
                <div className="text-slate-500 text-[11px]">
                  {percentTooHigh ? (
                    <p>
                      Your total exceeds 100%. Consider lowering some categories
                      or increasing your base if this reflects reality.
                    </p>
                  ) : (
                    <p>
                      You have{" "}
                      <span className="font-semibold text-slate-200">
                        {(100 - stats.percentSum).toFixed(2)}%
                      </span>{" "}
                      unassigned in your base. This becomes household use or extra
                      generosity.
                    </p>
                  )}
                </div>
              </div>
            </div>
          </section>

          {/* Right: Results & SSA integration */}
          <section className="space-y-4">
            {/* Breakdown summary */}
            <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4 md:p-5 shadow-xl shadow-slate-950/50">
              <h2 className="text-sm font-semibold text-slate-100 mb-3">
                Yearly offering breakdown
              </h2>

              <div className="space-y-3 text-sm">
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                    <p className="text-[11px] text-slate-400 mb-1">
                      Firstfruits
                    </p>
                    <p className="text-lg font-semibold text-emerald-300">
                      {stats.firstfruits.toFixed(2)}
                    </p>
                    <p className="text-[11px] text-slate-500">
                      Given early as a sign of trust and gratitude.
                    </p>
                  </div>
                  <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                    <p className="text-[11px] text-slate-400 mb-1">Tithes</p>
                    <p className="text-lg font-semibold text-sky-300">
                      {stats.tithe.toFixed(2)}
                    </p>
                    <p className="text-[11px] text-slate-500">
                      Regular, structured giving from increase.
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                    <p className="text-[11px] text-slate-400 mb-1">Festivals</p>
                    <p className="text-base font-semibold text-fuchsia-300">
                      {stats.festivals.toFixed(2)}
                    </p>
                    <p className="text-[11px] text-slate-500">
                      Travel, animals, and meals at appointed times.
                    </p>
                  </div>
                  <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                    <p className="text-[11px] text-slate-400 mb-1">
                      Poor / Levites
                    </p>
                    <p className="text-base font-semibold text-amber-300">
                      {stats.poor.toFixed(2)}
                    </p>
                    <p className="text-[11px] text-slate-500">
                      Set aside for those in need and those serving.
                    </p>
                  </div>
                  <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                    <p className="text-[11px] text-slate-400 mb-1">
                      Freewill offerings
                    </p>
                    <p className="text-base font-semibold text-rose-300">
                      {stats.freewill.toFixed(2)}
                    </p>
                    <p className="text-[11px] text-slate-500">
                      Extra gifts when you feel led to give.
                    </p>
                  </div>
                </div>

                {/* Totals */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-xl border border-emerald-500/50 bg-emerald-500/10 p-3">
                    <p className="text-[11px] text-emerald-100 mb-1">
                      Total offerings from base
                    </p>
                    <p className="text-lg font-semibold text-emerald-200">
                      {stats.totalOfferings.toFixed(2)}
                    </p>
                    <p className="text-[11px] text-emerald-100/80 mt-1">
                      This is what you plan to set apart from the base value.
                    </p>
                  </div>
                  <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                    <p className="text-[11px] text-slate-400 mb-1">
                      Remaining base after offerings
                    </p>
                    <p className="text-lg font-semibold text-slate-100">
                      {stats.remaining.toFixed(2)}
                    </p>
                    <p className="text-[11px] text-slate-500 mt-1">
                      This can cover household needs, savings, or more giving.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* SSA integration card */}
            <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 md:p-5 shadow-lg shadow-slate-950/40">
              <h2 className="text-sm font-semibold text-slate-100 mb-3">
                How to use this plan inside Suka Smart Assistant
              </h2>
              <ul className="space-y-2 text-[11px] text-slate-300">
                <li className="flex gap-2">
                  <span className="mt-[3px] inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  <span>
                    <span className="font-semibold">Storehouse sessions:</span>{" "}
                    turn each offering category into labeled storage bins,
                    envelopes, or digital buckets. The SessionRunner can walk you
                    through physically separating grain, meat, or funds.
                  </span>
                </li>
                <li className="flex gap-2">
                  <span className="mt-[3px] inline-block h-1.5 w-1.5 rounded-full bg-sky-400" />
                  <span>
                    <span className="font-semibold">Garden & animals:</span>{" "}
                    schedule firstfruits cuts, animal offerings, and charity
                    harvests as tasks on your garden and animal planners so they
                    are not forgotten.
                  </span>
                </li>
                <li className="flex gap-2">
                  <span className="mt-[3px] inline-block h-1.5 w-1.5 rounded-full bg-fuchsia-400" />
                  <span>
                    <span className="font-semibold">Scriptural calendar:</span>{" "}
                    combine this tool with the Scriptural Year Length and Feast
                    Day calculators to align offerings with specific days and
                    seasons.
                  </span>
                </li>
                {familyFundMode && (
                  <li className="flex gap-2">
                    <span className="mt-[3px] inline-block h-1.5 w-1.5 rounded-full bg-indigo-400" />
                    <span>
                      <span className="font-semibold">Family Fund Hub:</span> when
                      you launch and complete a storehouse / offering session,
                      SSA can export anonymized analytics to the Hub so you can
                      see how your household uses increase across years.
                    </span>
                  </li>
                )}
              </ul>

              <div className="mt-4 flex flex-wrap gap-2 items-center">
                <button
                  type="button"
                  onClick={handleNowClick}
                  className="inline-flex items-center gap-2 rounded-full border border-emerald-400/70 bg-emerald-500/10 px-3 py-1.5 text-[11px] font-medium text-emerald-200 hover:bg-emerald-500/15 focus:outline-none focus:ring-1 focus:ring-emerald-400"
                >
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-300" />
                  Start storehouse session with this plan
                </button>
                <span className="text-[11px] text-slate-500">
                  The SessionRunner modal remains active even if you navigate to
                  other SSA pages.
                </span>
              </div>
            </div>
          </section>
        </div>
      </main>

      {/* Local informational modal */}
      <OfferingNotesModal open={notesOpen} onClose={() => setNotesOpen(false)} />
    </div>
  );
}

export default BiblicalOfferingCalculatorPage;
