// C:\Users\larho\suka-smart-assistant\src\features\calculators\storehouseMeals\FreezerSpaceCalculator\FreezerSpaceCalculator.view.jsx

/**
 * FreezerSpaceCalculator.view
 *
 * How this fits:
 * - UI shell for configuring household freezers and planned items.
 * - Calls the FreezerSpaceCalculator shim to compute usage, fit, and layout.
 * - Visualizes per-freezer utilization, warnings, and overflow.
 * - Exposes a "Now" CTA that emits a session request event for SessionRunner.
 *
 * This file does not implement SessionRunner itself. Instead it:
 * - Uses the shared eventBus to emit `session.request.fromFreezerSpace.now`.
 * - Relies on the global SessionRunner (mounted in App.jsx) to pick up the
 *   request and open a guided session.
 */

import React, { useCallback, useMemo, useState } from "react";
import { emit } from "@/services/eventBus";
import { runFreezerSpaceCalculation } from "./FreezerSpaceCalculator.shim";

const VIEW_SOURCE = "features/FreezerSpaceCalculator.view";

/**
 * Utility: ISO timestamp
 */
function nowIso() {
  return new Date().toISOString();
}

/**
 * Emit an event with standard envelope
 * @param {string} type
 * @param {any} data
 */
function emitEvent(type, data) {
  try {
    emit({
      type,
      ts: nowIso(),
      source: VIEW_SOURCE,
      data,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[FreezerSpaceCalculator.view] emit error", type, err);
  }
}

/**
 * Simple field helpers
 */
function updateArrayItem(arr, index, patch) {
  return arr.map((item, i) => (i === index ? { ...item, ...patch } : item));
}

function removeArrayItem(arr, index) {
  return arr.filter((_, i) => i !== index);
}

function createDefaultFreezer(index = 0) {
  return {
    freezerId: `freezer_${index + 1}`,
    label: index === 0 ? "Main Chest Freezer" : `Freezer ${index + 1}`,
    capacityLiters: 400,
    reservePct: 15,
    zones: [
      { zoneId: "TOP", label: "Top" },
      { zoneId: "MIDDLE", label: "Middle" },
      { zoneId: "BOTTOM", label: "Bottom" },
    ],
  };
}

function createDefaultItem(index = 0) {
  return {
    itemId: `item_${index + 1}`,
    label: index === 0 ? "Beef Roast Batch" : `Item ${index + 1}`,
    volumeLiters: 3,
    quantity: 4,
    preferredFreezerId: null,
    preferredZoneId: null,
  };
}

/**
 * Compact progress bar for utilization
 */
function UtilizationBar({ value }) {
  const pct = Math.min(Math.max(value || 0, 0), 120);
  const capped = pct > 100 ? 100 : pct;

  let statusColor = "bg-emerald-500";
  if (pct > 95) statusColor = "bg-rose-500";
  else if (pct > 90) statusColor = "bg-amber-500";

  return (
    <div className="mt-2 w-full bg-slate-200/80 rounded-full h-2 overflow-hidden">
      <div
        className={`${statusColor} h-2 transition-all`}
        style={{ width: `${capped}%` }}
      />
    </div>
  );
}

/**
 * Main FreezerSpaceCalculator View Component
 */
const FreezerSpaceCalculatorView = () => {
  const [householdId, setHouseholdId] = useState("");
  const [freezers, setFreezers] = useState(() => [createDefaultFreezer(0)]);
  const [items, setItems] = useState(() => [createDefaultItem(0)]);
  const [reservePctGlobal, setReservePctGlobal] = useState(15);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const hasResult = !!result && result.ok && result.outputs;

  const firstSuggestion = useMemo(() => {
    if (!hasResult) return null;
    const suggestions = result.outputs.sessionSuggestions || [];
    return suggestions.length > 0 ? suggestions[0] : null;
  }, [hasResult, result]);

  const handleAddFreezer = () => {
    setFreezers((prev) => [...prev, createDefaultFreezer(prev.length)]);
  };

  const handleFreezerChange = (index, field, value) => {
    setFreezers((prev) =>
      updateArrayItem(prev, index, {
        [field]:
          field === "capacityLiters" || field === "reservePct"
            ? Number(value) || 0
            : value,
      }),
    );
  };

  const handleRemoveFreezer = (index) => {
    setFreezers((prev) => removeArrayItem(prev, index));
  };

  const handleAddItem = () => {
    setItems((prev) => [...prev, createDefaultItem(prev.length)]);
  };

  const handleItemChange = (index, field, value) => {
    setItems((prev) =>
      updateArrayItem(prev, index, {
        [field]:
          field === "volumeLiters" || field === "quantity"
            ? Number(value) || 0
            : value,
      }),
    );
  };

  const handleRemoveItem = (index) => {
    setItems((prev) => removeArrayItem(prev, index));
  };

  const handleCalculate = useCallback(
    async (e) => {
      e?.preventDefault();
      setLoading(true);
      setError(null);
      setResult(null);

      try {
        const payload = {
          inputs: {
            householdId: householdId || null,
            freezers,
            items,
            constraints: {
              reservePct: Number.isFinite(reservePctGlobal)
                ? Number(reservePctGlobal)
                : null,
            },
          },
          meta: {
            invokedBy: "FreezerSpaceCalculator.view",
            ts: nowIso(),
          },
        };

        const calculationResult = await runFreezerSpaceCalculation(payload);
        setResult(calculationResult);

        if (!calculationResult.ok && calculationResult.error) {
          setError(calculationResult.error.message || "Calculation error");
        } else {
          emitEvent("calculator.freezerSpace.ui.completed", calculationResult);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[FreezerSpaceCalculator.view] calculate error", err);
        setError("Unexpected error during calculation.");
      } finally {
        setLoading(false);
      }
    },
    [freezers, items, householdId, reservePctGlobal],
  );

  /**
   * "Now" CTA → SessionRunner
   */
  const handleStartNowSession = () => {
    if (!firstSuggestion || !hasResult) return;

    const sessionRequest = {
      domain: "storehouse",
      householdId: householdId || null,
      calculatorId: "FreezerSpaceCalculator",
      suggestion: firstSuggestion,
      resultSnapshot: {
        volumeUsage: result.outputs.volumeUsage,
        fitReport: result.outputs.fitReport,
        suggestedLayout: result.outputs.suggestedLayout,
      },
    };

    emitEvent("session.request.fromFreezerSpace.now", sessionRequest);
  };

  const volumeUsage = hasResult ? result.outputs.volumeUsage || [] : [];
  const fitReport = hasResult ? result.outputs.fitReport || null : null;
  const suggestedLayout = hasResult ? result.outputs.suggestedLayout || [] : [];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold text-slate-900">
          Freezer Space Calculator
        </h1>
        <p className="text-sm text-slate-600 max-w-2xl">
          Describe your household freezers and planned items. SSA will estimate
          how everything fits, flag overflows, and prepare a &ldquo;Now&rdquo;
          session so you can reorganize or batch cook before things get
          overloaded.
        </p>
      </header>

      {/* Layout: left inputs / right results */}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        {/* LEFT: Input forms */}
        <section className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-white/80 p-4 shadow-sm">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex flex-col flex-1 min-w-[220px]">
                <label className="text-xs font-medium text-slate-600">
                  Household ID (optional)
                </label>
                <input
                  type="text"
                  value={householdId}
                  onChange={(e) => setHouseholdId(e.target.value)}
                  className="mt-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/60"
                  placeholder="household-123..."
                />
              </div>
              <div className="flex flex-col min-w-[160px]">
                <label className="text-xs font-medium text-slate-600">
                  Global reserve margin (%)
                </label>
                <input
                  type="number"
                  value={reservePctGlobal}
                  onChange={(e) => setReservePctGlobal(Number(e.target.value) || 0)}
                  className="mt-1 w-24 rounded-md border border-slate-200 bg-white px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/60"
                  min={0}
                  max={40}
                />
                <p className="mt-1 text-[11px] text-slate-500">
                  Portion of capacity to keep free for airflow &amp; flexibility.
                </p>
              </div>
            </div>
          </div>

          {/* Freezers block */}
          <div className="rounded-xl border border-slate-200 bg-white/80 p-4 shadow-sm">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-slate-800">
                Freezers
              </h2>
              <button
                type="button"
                onClick={handleAddFreezer}
                className="inline-flex items-center rounded-md border border-emerald-500 px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50"
              >
                + Add Freezer
              </button>
            </div>
            <p className="mt-1 text-[11px] text-slate-500">
              Include all chest / upright / fridge freezers you use for long-term storage.
            </p>

            <div className="mt-3 space-y-3">
              {freezers.map((f, index) => (
                <div
                  key={f.freezerId || index}
                  className="rounded-lg border border-slate-200 bg-slate-50/60 p-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 grid gap-3 sm:grid-cols-2">
                      <div className="flex flex-col">
                        <label className="text-xs font-medium text-slate-600">
                          Label
                        </label>
                        <input
                          type="text"
                          value={f.label || ""}
                          onChange={(e) =>
                            handleFreezerChange(index, "label", e.target.value)
                          }
                          className="mt-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500/60"
                          placeholder="Main Chest Freezer"
                        />
                      </div>
                      <div className="flex flex-col">
                        <label className="text-xs font-medium text-slate-600">
                          Capacity (L)
                        </label>
                        <input
                          type="number"
                          value={f.capacityLiters ?? ""}
                          onChange={(e) =>
                            handleFreezerChange(
                              index,
                              "capacityLiters",
                              e.target.value,
                            )
                          }
                          className="mt-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500/60"
                          min={0}
                        />
                      </div>
                      <div className="flex flex-col">
                        <label className="text-xs font-medium text-slate-600">
                          Reserve (%) (override)
                        </label>
                        <input
                          type="number"
                          value={f.reservePct ?? ""}
                          onChange={(e) =>
                            handleFreezerChange(index, "reservePct", e.target.value)
                          }
                          className="mt-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500/60"
                          min={0}
                          max={40}
                        />
                        <p className="mt-1 text-[10px] text-slate-500">
                          Leave blank to use global setting.
                        </p>
                      </div>
                    </div>
                    {freezers.length > 1 && (
                      <button
                        type="button"
                        onClick={() => handleRemoveFreezer(index)}
                        className="ml-2 rounded-md border border-transparent px-2 py-1 text-[10px] font-medium text-slate-500 hover:bg-rose-50 hover:text-rose-600"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Items block */}
          <div className="rounded-xl border border-slate-200 bg-white/80 p-4 shadow-sm">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-slate-800">
                Planned Items / Batches
              </h2>
              <button
                type="button"
                onClick={handleAddItem}
                className="inline-flex items-center rounded-md border border-emerald-500 px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50"
              >
                + Add Item
              </button>
            </div>
            <p className="mt-1 text-[11px] text-slate-500">
              Enter new meat batches, prepared meals, bulk buys, or other items
              you want to fit into the freezers.
            </p>

            <div className="mt-3 space-y-3">
              {items.map((item, index) => (
                <div
                  key={item.itemId || index}
                  className="rounded-lg border border-slate-200 bg-slate-50/60 p-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 grid gap-3 sm:grid-cols-2 md:grid-cols-4">
                      <div className="flex flex-col">
                        <label className="text-xs font-medium text-slate-600">
                          Label
                        </label>
                        <input
                          type="text"
                          value={item.label || ""}
                          onChange={(e) =>
                            handleItemChange(index, "label", e.target.value)
                          }
                          className="mt-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500/60"
                          placeholder="Batch of stews, roasts..."
                        />
                      </div>
                      <div className="flex flex-col">
                        <label className="text-xs font-medium text-slate-600">
                          Volume per unit (L)
                        </label>
                        <input
                          type="number"
                          value={item.volumeLiters ?? ""}
                          onChange={(e) =>
                            handleItemChange(index, "volumeLiters", e.target.value)
                          }
                          className="mt-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500/60"
                          min={0}
                          step="0.1"
                        />
                      </div>
                      <div className="flex flex-col">
                        <label className="text-xs font-medium text-slate-600">
                          Quantity
                        </label>
                        <input
                          type="number"
                          value={item.quantity ?? ""}
                          onChange={(e) =>
                            handleItemChange(index, "quantity", e.target.value)
                          }
                          className="mt-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500/60"
                          min={0}
                        />
                      </div>
                      <div className="flex flex-col">
                        <label className="text-xs font-medium text-slate-600">
                          Preferred Freezer
                        </label>
                        <select
                          value={item.preferredFreezerId || ""}
                          onChange={(e) =>
                            handleItemChange(
                              index,
                              "preferredFreezerId",
                              e.target.value || null,
                            )
                          }
                          className="mt-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500/60"
                        >
                          <option value="">Any</option>
                          {freezers.map((f) => (
                            <option key={f.freezerId} value={f.freezerId}>
                              {f.label || f.freezerId}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    {items.length > 1 && (
                      <button
                        type="button"
                        onClick={() => handleRemoveItem(index)}
                        className="ml-2 rounded-md border border-transparent px-2 py-1 text-[10px] font-medium text-slate-500 hover:bg-rose-50 hover:text-rose-600"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <div className="text-xs text-slate-500">
                SSA will estimate utilization, flags, and session suggestions.
              </div>
              <button
                type="button"
                onClick={handleCalculate}
                disabled={loading}
                className="inline-flex items-center rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-emerald-300"
              >
                {loading ? "Calculating..." : "Calculate Freezer Space"}
              </button>
            </div>

            {error && (
              <p className="mt-2 text-xs text-rose-600">
                {error}
              </p>
            )}
          </div>
        </section>

        {/* RIGHT: Results / "Now" CTA */}
        <section className="space-y-4">
          {/* "Now" runner panel */}
          <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 p-4 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-emerald-900">
                  Plan Around Limitations &amp; Start a Session
                </h2>
                <p className="mt-1 text-xs text-emerald-900/80">
                  After calculation, you can launch a &ldquo;Now&rdquo; session
                  to prep, reorganize, or batch cook before you run out of
                  freezer space.
                </p>
              </div>
              <button
                type="button"
                onClick={handleStartNowSession}
                disabled={!firstSuggestion || !hasResult}
                className="inline-flex items-center rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-emerald-800 disabled:cursor-not-allowed disabled:bg-emerald-300"
              >
                Start Freezer Session Now
              </button>
            </div>
            {firstSuggestion && (
              <div className="mt-3 rounded-lg border border-emerald-200 bg-white/70 p-3">
                <p className="text-[11px] font-semibold text-emerald-900">
                  Next suggested session:
                </p>
                <p className="mt-1 text-xs font-medium text-emerald-950">
                  {firstSuggestion.label}
                </p>
                {firstSuggestion.kind && (
                  <p className="mt-0.5 text-[11px] text-emerald-800/90">
                    Kind: {firstSuggestion.kind}
                  </p>
                )}
                <p className="mt-1 text-[11px] text-emerald-800/80">
                  When you click &ldquo;Start&rdquo;, SSA posts a request to
                  SessionRunner so you can walk through the tasks hands-free.
                </p>
              </div>
            )}
          </div>

          {/* Usage summary */}
          <div className="rounded-xl border border-slate-200 bg-white/80 p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-slate-800">
              Freezer Utilization
            </h2>
            {!hasResult && (
              <p className="mt-2 text-xs text-slate-500">
                Run a calculation to see how each freezer is used, what&apos;s
                left, and where you need to adjust.
              </p>
            )}

            {hasResult && volumeUsage.length === 0 && (
              <p className="mt-2 text-xs text-slate-500">
                No usage data returned. Check your inputs and try again.
              </p>
            )}

            {hasResult && volumeUsage.length > 0 && (
              <div className="mt-3 space-y-3">
                {volumeUsage.map((u) => (
                  <div
                    key={u.freezerId}
                    className="rounded-lg border border-slate-200 bg-slate-50/70 p-3"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <p className="text-xs font-semibold text-slate-800">
                          {u.label}
                        </p>
                        <p className="text-[11px] text-slate-500">
                          {u.usedLiters.toFixed(1)} L used of{" "}
                          {u.capacityLiters.toFixed(1)} L,{" "}
                          {u.freeLiters.toFixed(1)} L free.
                        </p>
                      </div>
                      <p className="text-xs font-semibold text-slate-700">
                        {u.utilizationPct.toFixed(1)}%
                      </p>
                    </div>
                    <UtilizationBar value={u.utilizationPct} />
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Fit report & warnings */}
          <div className="rounded-xl border border-slate-200 bg-white/80 p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-slate-800">
              Fit Report &amp; Warnings
            </h2>
            {!hasResult && (
              <p className="mt-2 text-xs text-slate-500">
                After calculation, SSA will show which items fit and where you
                may need new sessions or storage strategies.
              </p>
            )}
            {hasResult && fitReport && (
              <div className="mt-2 space-y-2">
                <p className="text-xs font-medium text-slate-700">
                  Overall fit:{" "}
                  <span
                    className={
                      fitReport.fitsAll
                        ? "text-emerald-700"
                        : "text-amber-700 font-semibold"
                    }
                  >
                    {fitReport.fitsAll
                      ? "All items fit within current capacities."
                      : "Some items do not fit within current capacities."}
                  </span>
                </p>
                {Array.isArray(fitReport.overflowItems) &&
                  fitReport.overflowItems.length > 0 && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50/70 p-2">
                      <p className="text-[11px] font-semibold text-amber-800">
                        Overflow Items
                      </p>
                      <ul className="mt-1 space-y-0.5">
                        {fitReport.overflowItems.map((o) => (
                          <li
                            key={o.itemId}
                            className="text-[11px] text-amber-900"
                          >
                            {o.label || o.itemId} — needs{" "}
                            {o.requiredLiters.toFixed(1)} L
                          </li>
                        ))}
                      </ul>
                      <p className="mt-1 text-[11px] text-amber-800/90">
                        Consider moving older items to a &ldquo;use soon&rdquo;
                        plan or scheduling a repack session.
                      </p>
                    </div>
                  )}
                {Array.isArray(fitReport.warnings) &&
                  fitReport.warnings.length > 0 && (
                    <div className="rounded-lg border border-rose-200 bg-rose-50/70 p-2">
                      <p className="text-[11px] font-semibold text-rose-800">
                        Warnings
                      </p>
                      <ul className="mt-1 space-y-0.5">
                        {fitReport.warnings.map((w, i) => (
                          <li key={i} className="text-[11px] text-rose-900">
                            • {w}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
              </div>
            )}
          </div>

          {/* Layout suggestion */}
          <div className="rounded-xl border border-slate-200 bg-white/80 p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-slate-800">
              Suggested Layout by Zone
            </h2>
            {!hasResult && (
              <p className="mt-2 text-xs text-slate-500">
                Once you calculate, SSA will suggest which zones to use so
                you&apos;re not digging through mystery bags later.
              </p>
            )}

            {hasResult && suggestedLayout.length > 0 && (
              <div className="mt-3 space-y-3">
                {suggestedLayout.map((layout) => (
                  <div
                    key={layout.freezerId}
                    className="rounded-lg border border-slate-200 bg-slate-50/70 p-3"
                  >
                    <p className="text-xs font-semibold text-slate-800">
                      {layout.freezerId}
                    </p>
                    {(!Array.isArray(layout.zones) ||
                      layout.zones.length === 0) && (
                      <p className="mt-1 text-[11px] text-slate-500">
                        No zone layout generated for this freezer.
                      </p>
                    )}
                    {Array.isArray(layout.zones) &&
                      layout.zones.length > 0 && (
                        <div className="mt-2 grid gap-2 sm:grid-cols-2">
                          {layout.zones.map((z) => (
                            <div
                              key={z.zoneId}
                              className="rounded-md border border-slate-200 bg-white/80 p-2"
                            >
                              <p className="text-[11px] font-semibold text-slate-800">
                                {z.label || z.zoneId}
                              </p>
                              {Array.isArray(z.items) &&
                              z.items.length > 0 ? (
                                <ul className="mt-1 space-y-0.5">
                                  {z.items.map((it) => (
                                    <li
                                      key={it.itemId}
                                      className="text-[11px] text-slate-700"
                                    >
                                      {it.label || it.itemId} — {it.quantity} ×{" "}
                                      {it.volumeLiters.toFixed(1)} L
                                    </li>
                                  ))}
                                </ul>
                              ) : (
                                <p className="mt-1 text-[11px] text-slate-500">
                                  No items assigned to this zone.
                                </p>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
};

export default FreezerSpaceCalculatorView;
