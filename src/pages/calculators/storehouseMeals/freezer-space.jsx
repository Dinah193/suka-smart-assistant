// C:\Users\larho\suka-smart-assistant\src\pages\calculators\storehouseMeals\freezer-space.jsx

/**
 * Freezer Space Calculator Route
 *
 * How this fits SSA:
 * - Wraps FreezerSpaceCalculatorView with:
 *   • calculatorRunner wiring for consistent execution + logging
 *   • eventBus emissions so Planning Graph & automation can react
 *   • a summary card to highlight volume needs vs. capacity, utilization,
 *     and layout suggestions by freezer zone (shelves, baskets, door)
 *   • CTAs to:
 *       - create a storehouse SessionRunner flow to reorganize/defrost
 *       - sync the layout recommendation with storehouse inventory
 *
 * Typical graph flow:
 *   - FROM: batch cooking, butchery yields, preservation outputs
 *   - TO:   storehouse layout, freezer organization sessions, refill planning
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import eventBus from "@/services/events/eventBus";
import { familyFundMode } from "@/config/featureFlags";
import { runCalculator } from "@/services/calculators/calculatorRunner";
import FreezerSpaceCalculatorView from "@/features/calculators/storehouseMeals/FreezerSpaceCalculator/FreezerSpaceCalculator.view.jsx";

const CALCULATOR_ID = "storehouseMeals.freezerSpace";

/**
 * @typedef {Object} FreezerZonePlan
 * @property {string} id            // "topShelf", "basket1", "door", etc.
 * @property {string} label         // Human label for UI
 * @property {number} [allocatedCuFt] // Allocated cubic feet
 * @property {string[]} [tags]      // "meals", "meat", "veg", etc.
 * @property {string[]} [notes]
 */

/**
 * @typedef {Object} FreezerSpaceResult
 * @property {number} [totalRequiredCuFt]  // Volume needed for this plan
 * @property {number} [availableCuFt]      // Total known capacity
 * @property {number} [utilizationPercent] // 0–200+ (over capacity)
 * @property {number} [headroomCuFt]       // Positive if space remaining, negative if overflow
 * @property {boolean} [isOverCapacity]
 * @property {("compact"|"upright"|"chest"|"mixed"|string)} [freezerType]
 * @property {FreezerZonePlan[]} [zonePlan]
 * @property {string[]} [organizationTips]
 * @property {string[]} [warnings]         // Risk/overflow warnings
 * @property {string[]} [notes]            // General notes
 * @property {string} [suggestedSessionTitle] // Title for a potential organization session
 * @property {Object<string, any>} [meta]
 */

/**
 * Format a number to one decimal place, falling back gracefully.
 * @param {number | undefined | null} value
 * @returns {string}
 */
function formatOneDecimal(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return "–";
  return value.toFixed(1);
}

/**
 * Emit completion event so analytics & automation can listen.
 * @param {FreezerSpaceResult} result
 */
function emitFreezerSpaceCompleted(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.freezerSpace.completed",
      ts: new Date().toISOString(),
      source: "pages.calculators.storehouseMeals.freezer-space",
      data: {
        calculatorId: CALCULATOR_ID,
        result,
        familyFundMode: !!familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[freezer-space.jsx] Failed to emit calculator.freezerSpace.completed",
      err
    );
  }
}

/**
 * Ask automation/runtime to create a storehouse SessionRunner flow
 * to reorganize the freezer according to this plan.
 * @param {FreezerSpaceResult} result
 */
function requestFreezerSession(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;

    eventBus.emit({
      type: "calculator.freezerSpace.session.requested",
      ts: new Date().toISOString(),
      source: "pages.calculators.storehouseMeals.freezer-space",
      data: {
        calculatorId: CALCULATOR_ID,
        domain: "storehouse",
        result,
        familyFundMode: !!familyFundMode,
        sessionHint: {
          title:
            result?.suggestedSessionTitle ||
            (result?.freezerType
              ? `Organize ${result.freezerType} freezer`
              : "Freezer organization session"),
          suggestedDomain: "storehouse",
          tags: ["freezer", "organization", "storehouse"],
        },
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[freezer-space.jsx] Failed to emit calculator.freezerSpace.session.requested",
      err
    );
  }
}

/**
 * Ask Storehouse / Inventory to sync this layout.
 * @param {FreezerSpaceResult} result
 */
function requestStorehouseSync(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;

    eventBus.emit({
      type: "calculator.freezerSpace.storehouseSync.requested",
      ts: new Date().toISOString(),
      source: "pages.calculators.storehouseMeals.freezer-space",
      data: {
        calculatorId: CALCULATOR_ID,
        result,
        familyFundMode: !!familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[freezer-space.jsx] Failed to emit calculator.freezerSpace.storehouseSync.requested",
      err
    );
  }
}

/**
 * Summary card for volume, utilization, and simple zone plan.
 *
 * @param {{
 *   result: FreezerSpaceResult | null,
 *   onStartSession: (r: FreezerSpaceResult) => void,
 *   onStorehouseSync: (r: FreezerSpaceResult) => void
 * }} props
 */
function FreezerSummaryCard({ result, onStartSession, onStorehouseSync }) {
  if (!result) return null;

  const {
    totalRequiredCuFt,
    availableCuFt,
    utilizationPercent,
    headroomCuFt,
    isOverCapacity,
    freezerType,
    zonePlan,
    organizationTips,
    warnings,
    notes,
  } = result;

  const utilizationLabel =
    typeof utilizationPercent === "number"
      ? `${utilizationPercent.toFixed(0)}%`
      : "–";

  const fitStatus = useMemo(() => {
    if (typeof utilizationPercent !== "number") return "Unknown fit";
    if (utilizationPercent < 85) return "Plenty of space";
    if (utilizationPercent <= 100) return "Fits snugly";
    if (utilizationPercent <= 120) return "Over-filled (tight)";
    return "Significantly over capacity";
  }, [utilizationPercent]);

  const fitTone =
    typeof utilizationPercent === "number" && utilizationPercent > 100
      ? "text-amber-300"
      : "text-emerald-300";

  const headroomLabel =
    typeof headroomCuFt === "number"
      ? headroomCuFt >= 0
        ? `${headroomCuFt.toFixed(1)} cu ft free`
        : `${Math.abs(headroomCuFt).toFixed(1)} cu ft over`
      : "Unknown";

  return (
    <section className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/75 px-4 py-4 space-y-3">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">
            Freezer Capacity &amp; Layout Summary
          </h2>
          <p className="text-xs text-slate-400 mt-0.5 max-w-xl">
            See whether this plan fits inside your freezer and how SSA suggests
            mapping each shelf or basket so you can actually find the meals,
            meat, and veg you&apos;re stocking.
          </p>
        </div>
        <span className="text-[10px] px-2 py-1 rounded-full bg-slate-900 border border-slate-700 text-slate-200 whitespace-nowrap">
          {freezerType ? `${freezerType} freezer` : "Freezer layout ready"}
        </span>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Required Volume</span>
          <span className="text-slate-50 font-semibold">
            {formatOneDecimal(totalRequiredCuFt)} cu ft
          </span>
          <span className="text-slate-500">
            Planned contents (meals, meat, veg, etc.)
          </span>
        </div>

        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Available Capacity</span>
          <span className="text-slate-50 font-semibold">
            {formatOneDecimal(availableCuFt)} cu ft
          </span>
          <span className="text-slate-500">{headroomLabel}</span>
        </div>

        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Utilization</span>
          <span className={`text-slate-50 font-semibold ${fitTone}`}>
            {utilizationLabel}
          </span>
          <span className="text-slate-500">{fitStatus}</span>
        </div>

        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Fit Check</span>
          <span
            className={`text-slate-50 font-semibold ${
              isOverCapacity ? "text-red-300" : "text-emerald-300"
            }`}
          >
            {isOverCapacity ? "Does NOT fully fit" : "Fits in current freezer"}
          </span>
          <span className="text-slate-500">
            {isOverCapacity
              ? "Consider second freezer or adjust batch size."
              : "You still have wiggle room for sales or surprise harvests."}
          </span>
        </div>
      </div>

      {Array.isArray(zonePlan) && zonePlan.length > 0 && (
        <div className="mt-1 text-[11px] text-slate-300">
          <p className="font-medium text-slate-100 mb-0.5">
            Zone-by-Zone Layout
          </p>
          <div className="grid gap-2 md:grid-cols-2">
            {zonePlan.map((zone) => (
              <div
                key={zone.id}
                className="rounded-xl border border-slate-800 bg-slate-900/80 px-3 py-2"
              >
                <p className="text-slate-100 font-semibold text-[11px]">
                  {zone.label || zone.id}
                </p>
                <p className="text-slate-400 text-[11px]">
                  {zone.allocatedCuFt != null
                    ? `${zone.allocatedCuFt.toFixed(1)} cu ft planned`
                    : "Volume not set"}
                </p>
                {Array.isArray(zone.tags) && zone.tags.length > 0 && (
                  <p className="mt-1 text-[10px] text-slate-400">
                    Tags:&nbsp;
                    <span className="text-slate-200">
                      {zone.tags.join(", ")}
                    </span>
                  </p>
                )}
                {Array.isArray(zone.notes) && zone.notes.length > 0 && (
                  <ul className="mt-1 list-disc list-inside text-[10px] text-slate-400 space-y-0.5">
                    {zone.notes.map((note, idx) => (
                      <li key={idx}>{note}</li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {Array.isArray(organizationTips) && organizationTips.length > 0 && (
        <div className="mt-1 text-[11px] text-slate-300">
          <p className="font-medium text-slate-100 mb-0.5">
            Organization &amp; Rotation Tips
          </p>
          <ul className="list-disc list-inside space-y-0.5">
            {organizationTips.map((tip, idx) => (
              <li key={idx}>{tip}</li>
            ))}
          </ul>
        </div>
      )}

      {Array.isArray(warnings) && warnings.length > 0 && (
        <div className="mt-2 rounded-xl border border-red-500/70 bg-red-950/60 px-3 py-2 text-[11px] text-red-100">
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
          Tip: Let SSA turn this plan into a freezer organization session and
          sync the layout with your Storehouse inventory so future batches know
          exactly where to go.
        </p>
        <div className="flex flex-wrap gap-2 justify-end">
          <button
            type="button"
            onClick={() =>
              result && onStorehouseSync && onStorehouseSync(result)
            }
            className="inline-flex items-center justify-center rounded-xl px-3.5 py-2 text-[11px] font-semibold bg-sky-400 hover:bg-sky-300 text-slate-950 shadow-md shadow-sky-500/30 transition"
          >
            Sync With Storehouse
          </button>
          <button
            type="button"
            onClick={() => result && onStartSession && onStartSession(result)}
            className="inline-flex items-center justify-center rounded-xl px-3.5 py-2 text-[11px] font-semibold bg-emerald-400 hover:bg-emerald-300 text-slate-950 shadow-md shadow-emerald-500/30 transition"
          >
            Plan Freezer Session
          </button>
        </div>
      </div>
    </section>
  );
}

/**
 * Route component for Freezer Space Calculator.
 */
export default function FreezerSpaceCalculatorPage() {
  /** @type {[FreezerSpaceResult|null, React.Dispatch<React.SetStateAction<FreezerSpaceResult|null>>]} */
  const [result, setResult] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    document.title = "Freezer Space Calculator | Suka Smart Assistant";
  }, []);

  /**
   * Handler passed to FreezerSpaceCalculatorView.
   * @param {Object} input - Calculator input (freezer type, dimensions, items, etc.)
   */
  const handleCalculate = useCallback(async (input) => {
    setIsRunning(true);
    setError(null);

    try {
      const { result: calcResult } = await runCalculator(CALCULATOR_ID, input, {
        source: "pages.calculators.storehouseMeals.freezer-space",
        emitEvents: true,
      });

      if (!calcResult || typeof calcResult !== "object") {
        throw new Error(
          "Freezer Space calculator did not return a result object."
        );
      }

      /** @type {FreezerSpaceResult} */
      const normalized = {
        totalRequiredCuFt:
          typeof calcResult.totalRequiredCuFt === "number"
            ? calcResult.totalRequiredCuFt
            : undefined,
        availableCuFt:
          typeof calcResult.availableCuFt === "number"
            ? calcResult.availableCuFt
            : undefined,
        utilizationPercent:
          typeof calcResult.utilizationPercent === "number"
            ? calcResult.utilizationPercent
            : undefined,
        headroomCuFt:
          typeof calcResult.headroomCuFt === "number"
            ? calcResult.headroomCuFt
            : undefined,
        isOverCapacity: !!calcResult.isOverCapacity,
        freezerType:
          typeof calcResult.freezerType === "string"
            ? calcResult.freezerType
            : undefined,
        zonePlan: Array.isArray(calcResult.zonePlan) ? calcResult.zonePlan : [],
        organizationTips: Array.isArray(calcResult.organizationTips)
          ? calcResult.organizationTips
          : [],
        warnings: Array.isArray(calcResult.warnings) ? calcResult.warnings : [],
        notes: Array.isArray(calcResult.notes) ? calcResult.notes : [],
        suggestedSessionTitle:
          typeof calcResult.suggestedSessionTitle === "string"
            ? calcResult.suggestedSessionTitle
            : undefined,
        meta: calcResult.meta || {},
      };

      setResult(normalized);
      emitFreezerSpaceCompleted(normalized);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[freezer-space.jsx] Freezer Space calculator error", err);
      setError(
        err && err.message
          ? err.message
          : "There was a problem running the Freezer Space calculator."
      );
    } finally {
      setIsRunning(false);
    }
  }, []);

  const handleStartSession = useCallback((freezerResult) => {
    if (!freezerResult) return;
    requestFreezerSession(freezerResult);
  }, []);

  const handleStorehouseSync = useCallback((freezerResult) => {
    if (!freezerResult) return;
    requestStorehouseSync(freezerResult);
  }, []);

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-slate-950/90 text-slate-50">
      <div className="mx-auto max-w-5xl px-4 py-6 lg:py-8">
        {/* Header */}
        <header className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-50">
              Freezer Space Calculator
            </h1>
            <p className="mt-1 text-sm text-slate-400 max-w-2xl">
              Estimate how much cubic footage you need for planned meals, meat,
              and preservation batches — and see if it all fits in your current
              freezer layout, before you start cooking or butchering.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-900/80 px-3 py-1 border border-slate-700">
              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
              Feeds Storehouse Planner
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-900/80 px-3 py-1 border border-slate-700">
              <span className="h-2 w-2 rounded-full bg-sky-400" />
              Freezer Org Sessions
            </span>
          </div>
        </header>

        {/* Main card */}
        <main className="bg-slate-900/70 border border-slate-700 rounded-2xl shadow-xl p-4 lg:p-6">
          <FreezerSpaceCalculatorView
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

          <FreezerSummaryCard
            result={result}
            onStartSession={handleStartSession}
            onStorehouseSync={handleStorehouseSync}
          />
        </main>
      </div>
    </div>
  );
}
