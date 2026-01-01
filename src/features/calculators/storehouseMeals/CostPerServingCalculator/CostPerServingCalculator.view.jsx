// C:\Users\larho\suka-smart-assistant\src\features\calculators\storehouseMeals\CostPerServingCalculator\CostPerServingCalculator.view.jsx

/**
 * CostPerServingCalculator.view.jsx
 *
 * HOW THIS FITS
 * -------------
 * Presentation-only UI for the Cost Per Serving calculator.
 *
 * - Displays per-unit and per-serving costs for each item.
 * - Highlights "best value" items visually.
 * - Shows an optional "hair-supportive nutrients per dollar" score
 *   (computed in the shim based on nutrient metadata).
 * - Provides hooks (callbacks) for:
 *   - adjusting an item,
 *   - sending chosen items to shopping lists or storehouse plans,
 *   - closing the calculator panel/modal.
 *
 * This component:
 * - Does NOT perform the calculations itself (shim handles that).
 * - Can live inside a SessionRunner sidebar or a standalone planner view.
 * - Is safe to re-mount / re-render with persisted results.
 */

import React, { useMemo, useState } from "react";

/**
 * @typedef {Object} CostPerServingMeta
 * @property {number|null} [pricePerUnit]
 * @property {number|null} [pricePerServing]
 * @property {string} [currency]
 * @property {number|null} [hairNutrientScorePerDollar]
 */

/**
 * @typedef {Object} CostPerServingItem
 * @property {string} id
 * @property {string} name
 * @property {number} packagePrice
 * @property {number} packageSize
 * @property {string} packageUnit
 * @property {number} servingsFromPackage
 * @property {CostPerServingMeta} [meta]
 */

/**
 * @typedef {Object} CostPerServingSummary
 * @property {number} totalItems
 * @property {number} totalSpending
 * @property {number} avgPricePerServing
 * @property {string} createdAt
 * @property {string} currency
 * @property {string} version
 * @property {string|null} householdProfileId
 */

/**
 * @typedef {"name"|"pricePerUnit"|"pricePerServing"|"hairScore"} SortKey
 */

/**
 * @param {Object} props
 * @param {string|null} [props.calculatorId]
 * @param {CostPerServingItem[]} props.items
 * @param {CostPerServingSummary} props.summary
 * @param {boolean} [props.loading]
 * @param {string|null} [props.error]
 * @param {(item: CostPerServingItem) => void} [props.onAdjustItem]
 * @param {(selectedIds: string[]) => void} [props.onSendToShoppingList]
 * @param {() => void} [props.onClose]
 */
export function CostPerServingCalculatorView({
  calculatorId = null,
  items,
  summary,
  loading = false,
  error = null,
  onAdjustItem,
  onSendToShoppingList,
  onClose,
}) {
  const [sortKey, setSortKey] = useState(/** @type {SortKey} */ ("pricePerServing"));
  const [sortDir, setSortDir] = useState(/** @type {"asc"|"desc"} */ ("asc"));
  const [selectedIds, setSelectedIds] = useState(() => new Set());

  const currency = summary?.currency || "USD";

  const { bestPerServingId, bestHairScoreId } = useMemo(() => {
    let bestServingId = null;
    let bestServingValue = Infinity;
    let bestHairId = null;
    let bestHairValue = -Infinity;

    for (const item of items || []) {
      const pricePerServing = item.meta?.pricePerServing ?? null;
      const hairScore = item.meta?.hairNutrientScorePerDollar ?? null;

      if (typeof pricePerServing === "number" && pricePerServing > 0) {
        if (pricePerServing < bestServingValue) {
          bestServingValue = pricePerServing;
          bestServingId = item.id;
        }
      }

      if (typeof hairScore === "number" && hairScore > 0) {
        if (hairScore > bestHairValue) {
          bestHairValue = hairScore;
          bestHairId = item.id;
        }
      }
    }

    return {
      bestPerServingId: bestServingId,
      bestHairScoreId: bestHairId,
    };
  }, [items]);

  const sortedItems = useMemo(() => {
    const copy = [...(items || [])];

    copy.sort((a, b) => {
      const aMeta = a.meta || {};
      const bMeta = b.meta || {};

      let av;
      let bv;

      switch (sortKey) {
        case "name":
          av = (a.name || "").toLowerCase();
          bv = (b.name || "").toLowerCase();
          return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
        case "pricePerUnit":
          av = aMeta.pricePerUnit ?? Infinity;
          bv = bMeta.pricePerUnit ?? Infinity;
          break;
        case "pricePerServing":
          av = aMeta.pricePerServing ?? Infinity;
          bv = bMeta.pricePerServing ?? Infinity;
          break;
        case "hairScore":
          // For hairScore we want highest first by default
          av = aMeta.hairNutrientScorePerDollar ?? -Infinity;
          bv = bMeta.hairNutrientScorePerDollar ?? -Infinity;
          break;
        default:
          av = 0;
          bv = 0;
      }

      if (av === bv) return 0;
      if (sortDir === "asc") {
        return av < bv ? -1 : 1;
      } else {
        return av > bv ? -1 : 1;
      }
    });

    return copy;
  }, [items, sortKey, sortDir]);

  /**
   * @param {SortKey} key
   */
  function handleSort(key) {
    if (sortKey === key) {
      setSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "hairScore" ? "desc" : "asc"); // hairScore naturally high→low
    }
  }

  /**
   * @param {string} id
   */
  function toggleSelected(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function handleSendToShoppingList() {
    if (!onSendToShoppingList) return;
    const ids = Array.from(selectedIds);
    onSendToShoppingList(ids);
  }

  const hasHairScores = useMemo(
    () => items?.some((i) => typeof i.meta?.hairNutrientScorePerDollar === "number"),
    [items]
  );

  return (
    <div className="flex flex-col h-full bg-slate-950/95 text-slate-50 border border-slate-800 rounded-2xl shadow-xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
        <div className="flex flex-col">
          <h2 className="text-lg font-semibold">
            Cost Per Serving <span className="text-xs text-slate-400 ml-1">– Storehouse Planner</span>
          </h2>
          {calculatorId && (
            <span className="text-[10px] uppercase tracking-wide text-slate-500">
              Calculator ID: {calculatorId}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="px-2 py-0.5 rounded-full bg-emerald-900/40 text-emerald-300 text-[11px]">
            {items?.length ?? 0} items
          </span>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-slate-800 hover:bg-slate-700 transition-colors text-slate-200"
              aria-label="Close cost per serving view"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Summary strip */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 px-4 py-3 border-b border-slate-800 bg-slate-900/60">
        <SummaryCard
          label="Total Spending (package cost)"
          value={formatCurrency(summary?.totalSpending ?? 0, currency)}
          helper="Sum of all package prices"
        />
        <SummaryCard
          label="Avg Price / Serving"
          value={formatCurrency(summary?.avgPricePerServing ?? 0, currency)}
          helper="Weighted by servings per package"
        />
        <SummaryCard
          label="Hair Nutrients Coverage"
          value={hasHairScores ? "Available" : "Not provided"}
          helper="Higher score = more hair-supportive nutrients per dollar"
        />
      </div>

      {/* Error / loading state */}
      {error && (
        <div className="px-4 py-2 text-sm text-rose-300 bg-rose-950/40 border-b border-rose-900">
          {error}
        </div>
      )}
      {loading && (
        <div className="px-4 py-2 text-sm text-amber-200 bg-amber-950/30 border-b border-amber-900 animate-pulse">
          Calculating per-serving costs…
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="min-w-full text-xs sm:text-sm border-collapse">
          <thead className="bg-slate-900/60 sticky top-0 z-10">
            <tr>
              <th className="px-3 py-2 text-left text-slate-400 font-medium w-8">
                <span className="sr-only">Select</span>
              </th>
              <SortableHeader
                label="Item"
                sortKey="name"
                activeKey={sortKey}
                dir={sortDir}
                onSort={handleSort}
              />
              <th className="px-3 py-2 text-right text-slate-400 font-medium whitespace-nowrap">
                Package ({currency})
              </th>
              <SortableHeader
                label="Unit Cost"
                sortKey="pricePerUnit"
                activeKey={sortKey}
                dir={sortDir}
                onSort={handleSort}
                tooltip="Package price ÷ package size"
              />
              <th className="px-3 py-2 text-right text-slate-400 font-medium whitespace-nowrap">
                Servings / Package
              </th>
              <SortableHeader
                label="Cost / Serving"
                sortKey="pricePerServing"
                activeKey={sortKey}
                dir={sortDir}
                onSort={handleSort}
                tooltip="Package price ÷ servings"
              />
              {hasHairScores && (
                <SortableHeader
                  label="Hair Nutrients / $"
                  sortKey="hairScore"
                  activeKey={sortKey}
                  dir={sortDir}
                  onSort={handleSort}
                  tooltip="More hair-supportive nutrients per dollar"
                />
              )}
              <th className="px-3 py-2 text-right text-slate-400 font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {sortedItems.map((item) => {
              const meta = item.meta || {};
              const unitCost = meta.pricePerUnit ?? null;
              const servingCost = meta.pricePerServing ?? null;
              const hairScore = meta.hairNutrientScorePerDollar ?? null;

              const isBestServing = item.id === bestPerServingId;
              const isBestHair = hasHairScores && item.id === bestHairScoreId;

              return (
                <tr
                  key={item.id}
                  className="hover:bg-slate-900/50 transition-colors"
                >
                  <td className="px-3 py-2 align-middle">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-emerald-500"
                      checked={selectedIds.has(item.id)}
                      onChange={() => toggleSelected(item.id)}
                      aria-label={`Select ${item.name} for shopping or planning`}
                    />
                  </td>
                  <td className="px-3 py-2 align-top">
                    <div className="flex flex-col">
                      <span className="font-medium text-slate-50 truncate">
                        {item.name || "Unnamed item"}
                      </span>
                      <span className="text-[11px] text-slate-500">
                        {item.packageSize} {item.packageUnit} @{" "}
                        {formatCurrency(item.packagePrice, currency)}
                      </span>
                      {(isBestServing || isBestHair) && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {isBestServing && (
                            <Badge label="Best price / serving" tone="emerald" />
                          )}
                          {isBestHair && (
                            <Badge label="Best hair nutrients / $" tone="violet" />
                          )}
                        </div>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right align-middle whitespace-nowrap">
                    {formatCurrency(item.packagePrice, currency)}
                  </td>
                  <td className="px-3 py-2 text-right align-middle whitespace-nowrap">
                    {unitCost != null && Number.isFinite(unitCost)
                      ? `${formatCurrency(unitCost, currency)} / ${item.packageUnit}`
                      : <span className="text-slate-500">—</span>}
                  </td>
                  <td className="px-3 py-2 text-right align-middle whitespace-nowrap">
                    {Number.isFinite(item.servingsFromPackage)
                      ? item.servingsFromPackage
                      : <span className="text-slate-500">—</span>}
                  </td>
                  <td className="px-3 py-2 text-right align-middle whitespace-nowrap">
                    {servingCost != null && Number.isFinite(servingCost)
                      ? `${formatCurrency(servingCost, currency)} / serving`
                      : <span className="text-slate-500">—</span>}
                  </td>
                  {hasHairScores && (
                    <td className="px-3 py-2 text-right align-middle whitespace-nowrap">
                      {hairScore != null && Number.isFinite(hairScore)
                        ? hairScore.toFixed(2)
                        : <span className="text-slate-500">—</span>}
                    </td>
                  )}
                  <td className="px-3 py-2 text-right align-middle whitespace-nowrap">
                    {onAdjustItem && (
                      <button
                        type="button"
                        onClick={() => onAdjustItem(item)}
                        className="inline-flex items-center px-2 py-1 rounded-full border border-slate-600 text-[11px] text-slate-100 hover:bg-slate-800"
                      >
                        Adjust
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}

            {sortedItems.length === 0 && (
              <tr>
                <td
                  colSpan={hasHairScores ? 8 : 7}
                  className="px-3 py-6 text-center text-sm text-slate-500"
                >
                  No items to display yet. Add ingredients or storehouse items to see
                  per-serving costs.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Footer actions */}
      <div className="px-4 py-3 border-t border-slate-800 bg-slate-950/90 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div className="text-[11px] text-slate-500">
          Tip: Select your best-value items, then send them to a shopping plan or
          storehouse refill workflow.
        </div>
        <div className="flex items-center justify-end gap-2">
          {onSendToShoppingList && (
            <button
              type="button"
              disabled={selectedIds.size === 0}
              onClick={handleSendToShoppingList}
              className={`inline-flex items-center px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                selectedIds.size === 0
                  ? "bg-slate-800 text-slate-500 cursor-not-allowed"
                  : "bg-emerald-600 hover:bg-emerald-500 text-emerald-50"
              }`}
            >
              Send {selectedIds.size > 0 ? `(${selectedIds.size})` : ""} to Shopping
            </button>
          )}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center px-3 py-1.5 rounded-full text-xs font-medium border border-slate-700 text-slate-200 hover:bg-slate-800"
            >
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * @param {Object} props
 * @param {string} props.label
 * @param {string|number} props.value
 * @param {string} [props.helper]
 */
function SummaryCard({ label, value, helper }) {
  return (
    <div className="flex flex-col gap-0.5 px-3 py-2 rounded-xl bg-slate-950/70 border border-slate-800">
      <span className="text-[11px] text-slate-400 uppercase tracking-wide">
        {label}
      </span>
      <span className="text-sm font-semibold text-slate-50">{value}</span>
      {helper && (
        <span className="text-[10px] text-slate-500">{helper}</span>
      )}
    </div>
  );
}

/**
 * @param {Object} props
 * @param {string} props.label
 * @param {"emerald"|"violet"} [props.tone]
 */
function Badge({ label, tone = "emerald" }) {
  const toneClasses =
    tone === "violet"
      ? "bg-violet-900/50 text-violet-200 border-violet-700"
      : "bg-emerald-900/50 text-emerald-200 border-emerald-700";

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] border ${toneClasses}`}
    >
      {label}
    </span>
  );
}

/**
 * @param {Object} props
 * @param {string} props.label
 * @param {SortKey} props.sortKey
 * @param {SortKey} props.activeKey
 * @param {"asc"|"desc"} props.dir
 * @param {(key: SortKey) => void} props.onSort
 * @param {string} [props.tooltip]
 */
function SortableHeader({ label, sortKey, activeKey, dir, onSort, tooltip }) {
  const isActive = sortKey === activeKey;
  const arrow = !isActive ? "↕" : dir === "asc" ? "▲" : "▼";

  return (
    <th className="px-3 py-2 text-left text-slate-400 font-medium whitespace-nowrap">
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className="inline-flex items-center gap-1 text-xs text-slate-300 hover:text-slate-100"
        title={tooltip || label}
      >
        <span>{label}</span>
        <span className="text-[10px]">{arrow}</span>
      </button>
    </th>
  );
}

/**
 * Simple currency formatter; can be swapped to a shared utility later.
 *
 * @param {number} value
 * @param {string} currency
 * @returns {string}
 */
function formatCurrency(value, currency) {
  if (!Number.isFinite(value)) return "—";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency || "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${currency || "$"} ${value.toFixed(2)}`;
  }
}

export default CostPerServingCalculatorView;
