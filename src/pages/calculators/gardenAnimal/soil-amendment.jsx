// C:\Users\larho\suka-smart-assistant\src\pages\calculators\gardenAnimal\soil-amendment.jsx

/**
 * Soil Amendment Calculator Route
 *
 * How this fits SSA:
 * - Wraps SoilAmendmentCalculatorView with:
 *   • calculatorRunner wiring for consistent execution + logging
 *   • eventBus emissions so Planning Graph & automation can react
 *   • a summary card surfacing total amendments, N-P-K, and timing
 *   • CTAs to:
 *       - push amendment plan into Garden Planner / Tasks
 *       - sync nutrient needs into Storehouse / purchasing
 *       - request a SessionRunner flow for amendment application
 *
 * Typical graph flow:
 *   - FROM: soil test data, garden bed layout, crop rotation plans
 *   - TO:   garden planting calendar, storehouse purchase planning,
 *           composting & manure usage, watering / feeding schedules
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import eventBus from "@/services/events/eventBus";
import { familyFundMode } from "@/config/featureFlags";
import { runCalculator } from "@/services/calculators/calculatorRunner";
import SoilAmendmentCalculatorView from "@/features/calculators/gardenAnimal/SoilAmendmentCalculator.view.jsx";

const CALCULATOR_ID = "garden.soilAmendment";

/**
 * @typedef {Object} SoilAmendmentMaterial
 * @property {string} id
 * @property {string} name
 * @property {number} amount
 * @property {string} unit
 * @property {number} [nPercent]
 * @property {number} [pPercent]
 * @property {number} [kPercent]
 * @property {string[]} [notes]
 */

/**
 * @typedef {Object} SoilAmendmentResult
 * @property {string} [seasonLabel]
 * @property {string} [locationLabel]
 * @property {string} [zone]
 * @property {number} [totalAreaSqFt]
 * @property {number} [targetN]   // lb or kg per 100 sq ft (normalized by calculator)
 * @property {number} [targetP]
 * @property {number} [targetK]
 * @property {number} [suppliedN]
 * @property {number} [suppliedP]
 * @property {number} [suppliedK]
 * @property {SoilAmendmentMaterial[]} [materials]
 * @property {string[]} [warnings]
 * @property {string[]} [notes]
 * @property {string} [applicationTiming] // e.g. "2 weeks before planting"
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
 * @param {SoilAmendmentResult} result
 */
function emitSoilAmendmentCompleted(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.soilAmendment.completed",
      ts: new Date().toISOString(),
      source: "pages.calculators.gardenAnimal.soil-amendment",
      data: {
        calculatorId: CALCULATOR_ID,
        result,
        familyFundMode: !!familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[soil-amendment.jsx] Failed to emit calculator.soilAmendment.completed",
      err
    );
  }
}

/**
 * Ask automation/runtime to create a SessionRunner flow to actually apply amendments.
 * @param {SoilAmendmentResult} result
 */
function requestAmendmentSession(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;

    eventBus.emit({
      type: "calculator.soilAmendment.session.requested",
      ts: new Date().toISOString(),
      source: "pages.calculators.gardenAnimal.soil-amendment",
      data: {
        calculatorId: CALCULATOR_ID,
        domain: "garden",
        result,
        familyFundMode: !!familyFundMode,
        sessionHint: {
          title:
            result?.suggestedSessionTitle ||
            "Garden soil amendment & bed prep session",
          suggestedDomain: "garden",
          tags: ["garden", "soil", "amendments", "bed prep"],
        },
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[soil-amendment.jsx] Failed to emit calculator.soilAmendment.session.requested",
      err
    );
  }
}

/**
 * Ask Storehouse / purchasing planner to sync amendment material requirements.
 * @param {SoilAmendmentResult} result
 */
function requestStorehouseSync(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;

    eventBus.emit({
      type: "calculator.soilAmendment.storehouseSync.requested",
      ts: new Date().toISOString(),
      source: "pages.calculators.gardenAnimal.soil-amendment",
      data: {
        calculatorId: CALCULATOR_ID,
        result,
        familyFundMode: !!familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[soil-amendment.jsx] Failed to emit calculator.soilAmendment.storehouseSync.requested",
      err
    );
  }
}

/**
 * Ask Garden Planner to attach amendment schedule to beds / rotations.
 * @param {SoilAmendmentResult} result
 */
function requestGardenPlannerSync(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;

    eventBus.emit({
      type: "calculator.soilAmendment.gardenPlannerSync.requested",
      ts: new Date().toISOString(),
      source: "pages.calculators.gardenAnimal.soil-amendment",
      data: {
        calculatorId: CALCULATOR_ID,
        result,
        familyFundMode: !!familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[soil-amendment.jsx] Failed to emit calculator.soilAmendment.gardenPlannerSync.requested",
      err
    );
  }
}

/**
 * Summary card for soil amendment results and next steps.
 *
 * @param {{
 *   result: SoilAmendmentResult | null,
 *   onStartSession: (r: SoilAmendmentResult) => void,
 *   onStorehouseSync: (r: SoilAmendmentResult) => void,
 *   onGardenPlannerSync: (r: SoilAmendmentResult) => void
 * }} props
 */
function SoilAmendmentSummaryCard({
  result,
  onStartSession,
  onStorehouseSync,
  onGardenPlannerSync,
}) {
  if (!result) return null;

  const {
    seasonLabel,
    locationLabel,
    zone,
    totalAreaSqFt,
    targetN,
    targetP,
    targetK,
    suppliedN,
    suppliedP,
    suppliedK,
    materials,
    warnings,
    notes,
    applicationTiming,
  } = result;

  const labelSeason = seasonLabel || "Season not set";
  const labelLocation =
    locationLabel && zone
      ? `${locationLabel} · Zone ${zone}`
      : locationLabel || (zone ? `Zone ${zone}` : "Location not set");

  const materialCount = Array.isArray(materials) ? materials.length : 0;

  const topMaterials = useMemo(() => {
    if (!Array.isArray(materials)) return [];
    return [...materials].slice(0, 4);
  }, [materials]);

  return (
    <section className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/75 px-4 py-4 space-y-3">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">
            Soil Amendment Summary &amp; Next Steps
          </h2>
          <p className="text-xs text-slate-400 mt-0.5 max-w-xl">
            SSA balances your soil test or target N-P-K with compost, manure,
            and organic fertilizers so you know exactly what to add per bed,
            when to add it, and how it affects your storehouse and purchase
            list.
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
            Used to normalize N-P-K targets across all beds.
          </span>
        </div>

        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Target N-P-K (per unit)</span>
          <span className="text-slate-50 font-semibold">
            N {safeNumber(targetN)} · P {safeNumber(targetP)} · K{" "}
            {safeNumber(targetK)}
          </span>
          <span className="text-slate-500">
            Ideal nutrient levels based on your inputs.
          </span>
        </div>

        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">
            Supplied N-P-K (from mix)
          </span>
          <span className="text-slate-50 font-semibold">
            N {safeNumber(suppliedN)} · P {safeNumber(suppliedP)} · K{" "}
            {safeNumber(suppliedK)}
          </span>
          <span className="text-slate-500">
            Use this to watch for over- or under-fertilizing.
          </span>
        </div>

        <div className="flex flex-col">
          <span className="text-slate-400 mb-0.5">Amendments Used</span>
          <span className="text-slate-50 font-semibold">{materialCount}</span>
          <span className="text-slate-500">
            Compost, manure, organic blends, and minerals.
          </span>
        </div>
      </div>

      {applicationTiming && (
        <div className="text-[11px] text-emerald-100 rounded-xl border border-emerald-500/60 bg-emerald-950/60 px-3 py-2">
          <p className="font-medium mb-0.5">Recommended Application Timing</p>
          <p className="leading-snug">{applicationTiming}</p>
        </div>
      )}

      {Array.isArray(topMaterials) && topMaterials.length > 0 && (
        <div className="mt-1 text-[11px] text-slate-300">
          <p className="font-medium text-slate-100 mb-0.5">
            Amendment Mix Overview
          </p>
          <div className="grid gap-2 md:grid-cols-2">
            {topMaterials.map((m) => (
              <div
                key={m.id || m.name}
                className="rounded-xl border border-slate-800 bg-slate-900/80 px-3 py-2"
              >
                <p className="text-slate-100 font-semibold text-[11px]">
                  {m.name}
                </p>
                <p className="text-slate-400 text-[11px]">
                  {safeNumber(m.amount, 2)} {m.unit}
                </p>
                {(m.nPercent || m.pPercent || m.kPercent) && (
                  <p className="text-slate-400 text-[11px] mt-0.5">
                    N {safeNumber(m.nPercent || 0, 0)}% · P{" "}
                    {safeNumber(m.pPercent || 0, 0)}% · K{" "}
                    {safeNumber(m.kPercent || 0, 0)}%
                  </p>
                )}
                {Array.isArray(m.notes) && m.notes.length > 0 && (
                  <p className="mt-1 text-[10px] text-slate-400">
                    {m.notes.join(" • ")}
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
          Tip: Sync this amendment schedule directly into your Garden Planner to
          attach N-P-K goals to specific beds, then feed material requirements
          into your Storehouse and Purchase Planner so you always have what you
          need on hand.
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
            Send to Storehouse / Purchases
          </button>
          <button
            type="button"
            onClick={() => result && onStartSession && onStartSession(result)}
            className="inline-flex items-center justify-center rounded-xl px-3.5 py-2 text-[11px] font-semibold bg-emerald-400 hover:bg-emerald-300 text-slate-950 shadow-md shadow-emerald-500/30 transition"
          >
            Plan Amendment Session
          </button>
        </div>
      </div>
    </section>
  );
}

/**
 * Route component for Soil Amendment Calculator.
 */
export default function SoilAmendmentCalculatorPage() {
  /** @type {[SoilAmendmentResult|null, React.Dispatch<React.SetStateAction<SoilAmendmentResult|null>>]} */
  const [result, setResult] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    document.title = "Soil Amendment Calculator | Suka Smart Assistant";
  }, []);

  /**
   * Handler passed to SoilAmendmentCalculatorView.
   * @param {Object} input - Calculator input (beds, soil test, crop targets, etc.)
   */
  const handleCalculate = useCallback(async (input) => {
    setIsRunning(true);
    setError(null);

    try {
      const { result: calcResult } = await runCalculator(CALCULATOR_ID, input, {
        source: "pages.calculators.gardenAnimal.soil-amendment",
        emitEvents: true,
      });

      if (!calcResult || typeof calcResult !== "object") {
        throw new Error(
          "Soil Amendment calculator did not return a result object."
        );
      }

      /** @type {SoilAmendmentResult} */
      const normalized = {
        seasonLabel:
          typeof calcResult.seasonLabel === "string"
            ? calcResult.seasonLabel
            : undefined,
        locationLabel:
          typeof calcResult.locationLabel === "string"
            ? calcResult.locationLabel
            : undefined,
        zone: typeof calcResult.zone === "string" ? calcResult.zone : undefined,
        totalAreaSqFt:
          typeof calcResult.totalAreaSqFt === "number"
            ? calcResult.totalAreaSqFt
            : undefined,
        targetN:
          typeof calcResult.targetN === "number"
            ? calcResult.targetN
            : undefined,
        targetP:
          typeof calcResult.targetP === "number"
            ? calcResult.targetP
            : undefined,
        targetK:
          typeof calcResult.targetK === "number"
            ? calcResult.targetK
            : undefined,
        suppliedN:
          typeof calcResult.suppliedN === "number"
            ? calcResult.suppliedN
            : undefined,
        suppliedP:
          typeof calcResult.suppliedP === "number"
            ? calcResult.suppliedP
            : undefined,
        suppliedK:
          typeof calcResult.suppliedK === "number"
            ? calcResult.suppliedK
            : undefined,
        materials: Array.isArray(calcResult.materials)
          ? calcResult.materials
          : [],
        warnings: Array.isArray(calcResult.warnings) ? calcResult.warnings : [],
        notes: Array.isArray(calcResult.notes) ? calcResult.notes : [],
        applicationTiming:
          typeof calcResult.applicationTiming === "string"
            ? calcResult.applicationTiming
            : undefined,
        suggestedSessionTitle:
          typeof calcResult.suggestedSessionTitle === "string"
            ? calcResult.suggestedSessionTitle
            : undefined,
        meta: calcResult.meta || {},
      };

      setResult(normalized);
      emitSoilAmendmentCompleted(normalized);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        "[soil-amendment.jsx] Soil Amendment calculator error",
        err
      );
      setError(
        err && err.message
          ? err.message
          : "There was a problem running the Soil Amendment calculator."
      );
    } finally {
      setIsRunning(false);
    }
  }, []);

  const handleStartSession = useCallback((amendResult) => {
    if (!amendResult) return;
    requestAmendmentSession(amendResult);
  }, []);

  const handleStorehouseSync = useCallback((amendResult) => {
    if (!amendResult) return;
    requestStorehouseSync(amendResult);
  }, []);

  const handleGardenPlannerSync = useCallback((amendResult) => {
    if (!amendResult) return;
    requestGardenPlannerSync(amendResult);
  }, []);

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-slate-950/90 text-slate-50">
      <div className="mx-auto max-w-5xl px-4 py-6 lg:py-8">
        {/* Header */}
        <header className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-50">
              Soil Amendment Calculator
            </h1>
            <p className="mt-1 text-sm text-slate-400 max-w-2xl">
              Turn soil tests and bed sizes into a simple, actionable amendment
              plan. SSA mixes compost, manure, and organic fertilizers into a
              clear N-P-K schedule you can attach to beds, purchases, and
              SessionRunner tasks for bed prep days.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-900/80 px-3 py-1 border border-slate-700">
              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
              Feeds Garden Planner &amp; Bed Prep
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-900/80 px-3 py-1 border border-slate-700">
              <span className="h-2 w-2 rounded-full bg-sky-400" />
              Storehouse &amp; Purchase Planning
            </span>
          </div>
        </header>

        {/* Main card */}
        <main className="bg-slate-900/70 border border-slate-700 rounded-2xl shadow-xl p-4 lg:p-6">
          <SoilAmendmentCalculatorView
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

          <SoilAmendmentSummaryCard
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
