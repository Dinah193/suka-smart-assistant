// C:\Users\larho\suka-smart-assistant\src\features\calculators\storehouseMeals\MeatBreakdownCalculator\MeatBreakdownCalculator.view.jsx

/**
 * MeatBreakdownCalculator.view.jsx
 *
 * HOW THIS FITS:
 * - Pure React UI for visualizing a single Meat Breakdown calculation.
 * - Expects a payload that conforms to MeatBreakdownCalculator.schema.json.
 * - Can be used inside any Storehouse/Animals domain page or a dedicated
 *   "Butchery Session" details route.
 * - Provides:
 *    • Summary cards (total meat, bones, fat, offal, servings).
 *    • Yield percentage bars for quick visual comparison.
 *    • Filterable table of cuts with per-package info.
 *    • Byproducts table (bones for stock, fat for rendering, organs, etc.).
 *    • A "Use This Breakdown Now" CTA that can be wired to:
 *        - open a SessionBuilder, or
 *        - immediately request a SessionRunner session.
 *
 * Integration points:
 * - Optional `onStartSession` prop lets the parent initiate a SessionRunner flow.
 *   For example, parent can:
 *      onStartSession={(payload) => emit({ type: "session.request.fromMeatBreakdown", ... })}
 * - Uses eventBus emit for lightweight analytics ("viewed" events).
 */

import React, { useEffect, useMemo, useState } from "react";
import { emit } from "@/services/eventBus";

/**
 * @typedef {Object} MeatBreakdownCalculatorViewProps
 * @property {object|null} data - Calculator payload (schema-compatible) or null while loading/empty.
 * @property {boolean} [isLoading] - Optional loading flag.
 * @property {string|null} [error] - Optional error message.
 * @property {(data: object) => void} [onStartSession] - Optional handler to start a SessionRunner flow.
 * @property {boolean} [compact] - If true, renders a more compact layout (for sidebars, etc.).
 */

/**
 * Main UI component to visualize meat breakdown and available cuts.
 *
 * @param {MeatBreakdownCalculatorViewProps} props
 */
const MeatBreakdownCalculatorView = ({
  data,
  isLoading = false,
  error = null,
  onStartSession,
  compact = false,
}) => {
  const [selectedCut, setSelectedCut] = useState(null);
  const [cutFilter, setCutFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");

  const summary = data?.outputs?.summary || null;
  const cuts = Array.isArray(data?.outputs?.cuts) ? data.outputs.cuts : [];
  const byproducts = Array.isArray(data?.outputs?.byproducts)
    ? data.outputs.byproducts
    : [];
  const inputs = data?.inputs || {};
  const animal = inputs.animal || {};
  const carcass = inputs.carcass || {};

  // Emit a basic analytics event when a valid payload is shown.
  useEffect(() => {
    if (!data || !summary) return;
    emit({
      type: "calculator.meatBreakdown.viewed",
      ts: new Date().toISOString(),
      source:
        "features/calculators/storehouseMeals/MeatBreakdownCalculator.view",
      data: {
        calculatorId: "MeatBreakdownCalculator",
        species: animal?.species || "unknown",
        basisType: summary.basisType,
        basisWeight: summary.basisWeight,
      },
    });
  }, [data, summary, animal?.species]);

  const filteredCuts = useMemo(() => {
    let rows = cuts;
    if (categoryFilter !== "all") {
      rows = rows.filter(
        (c) => String(c.category || "") === String(categoryFilter)
      );
    }
    if (cutFilter.trim()) {
      const q = cutFilter.trim().toLowerCase();
      rows = rows.filter((c) => {
        return (
          String(c.name || "").toLowerCase().includes(q) ||
          String(c.primal || "").toLowerCase().includes(q)
        );
      });
    }
    return rows;
  }, [cuts, cutFilter, categoryFilter]);

  const handleStartSessionClick = () => {
    if (!data) return;
    // Allow parent to decide what session to build; we just pass context.
    if (typeof onStartSession === "function") {
      onStartSession(data);
      return;
    }

    // Fallback: emit an event the central scheduler can listen for.
    emit({
      type: "session.request.fromMeatBreakdown",
      ts: new Date().toISOString(),
      source:
        "features/calculators/storehouseMeals/MeatBreakdownCalculator.view",
      data: {
        calculatorId: "MeatBreakdownCalculator",
        payload: data,
      },
    });
  };

  if (isLoading) {
    return (
      <div className="w-full h-full flex items-center justify-center text-slate-500 text-sm">
        Calculating meat breakdown…
      </div>
    );
  }

  if (error) {
    return (
      <div className="w-full rounded-lg border border-red-500/40 bg-red-50 text-red-800 p-4 text-sm">
        <div className="font-semibold mb-1">Unable to show meat breakdown</div>
        <div>{error}</div>
      </div>
    );
  }

  if (!data || !summary) {
    return (
      <div className="w-full rounded-lg border border-slate-200 bg-slate-50 text-slate-600 p-4 text-sm">
        No meat breakdown data yet. Run the calculator to see yields.
      </div>
    );
  }

  const weightUnitLabel = summary.weightUnit === "kg" ? "kg" : "lb";
  const basisLabel = basisTypeToLabel(summary.basisType);

  const layoutClass = compact
    ? "space-y-4"
    : "space-y-6 md:space-y-8";

  return (
    <div className={layoutClass}>
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2 md:gap-4">
        <div>
          <h2 className="text-lg md:text-xl font-semibold text-slate-900">
            Meat Breakdown Overview
          </h2>
          <p className="text-xs md:text-sm text-slate-500">
            {renderAnimalHeader(animal)} &bull; Basis:{" "}
            <span className="font-medium">
              {summary.basisWeight.toFixed(1)} {weightUnitLabel} (
              {basisLabel})
            </span>
          </p>
          {carcass.slaughterDate && (
            <p className="text-xs text-slate-400 mt-0.5">
              Slaughtered on {carcass.slaughterDate}
              {carcass.processingDate ? ` • Cut on ${carcass.processingDate}` : ""}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 mt-1 md:mt-0">
          <button
            type="button"
            onClick={handleStartSessionClick}
            className="inline-flex items-center justify-center rounded-full bg-emerald-600 px-4 py-1.5 text-xs md:text-sm font-medium text-white shadow-sm hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-1"
          >
            Use This Breakdown Now
          </button>
        </div>
      </div>

      {/* Summary cards */}
      <SummaryGrid summary={summary} weightUnitLabel={weightUnitLabel} />

      {/* Yield percentages bar row */}
      <YieldBars summary={summary} />

      {/* Cuts & filters */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 md:gap-6">
        <div className="xl:col-span-2 space-y-3 md:space-y-4">
          <CutsToolbar
            cutFilter={cutFilter}
            setCutFilter={setCutFilter}
            categoryFilter={categoryFilter}
            setCategoryFilter={setCategoryFilter}
          />
          <CutsTable
            cuts={filteredCuts}
            weightUnitLabel={weightUnitLabel}
            onSelectCut={setSelectedCut}
          />
        </div>

        {/* Byproducts */}
        <div className="space-y-2 md:space-y-3">
          <h3 className="text-sm font-semibold text-slate-800">
            Byproducts & Stock Planning
          </h3>
          <ByproductsCard
            byproducts={byproducts}
            basisWeight={summary.basisWeight}
            weightUnitLabel={weightUnitLabel}
          />
        </div>
      </div>

      {/* Cut detail modal */}
      <CutDetailModal
        cut={selectedCut}
        onClose={() => setSelectedCut(null)}
      />
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* Small Components                                                           */
/* -------------------------------------------------------------------------- */

const SummaryGrid = ({ summary, weightUnitLabel }) => {
  const cards = [
    {
      key: "meat",
      label: "Total Usable Meat",
      value: summary.totalUsableMeatWeight,
      unit: weightUnitLabel,
      extra: `${(summary.yieldPercentages?.meatPct ?? 0).toFixed(1)}%`,
    },
    {
      key: "servings",
      label: "Estimated Servings",
      value: summary.estimatedTotalServings,
      unit: "servings",
      extra: "~0.5 lb / serving",
    },
    {
      key: "bone",
      label: "Bones",
      value: summary.totalBoneWeight,
      unit: weightUnitLabel,
      extra: `${(summary.yieldPercentages?.bonePct ?? 0).toFixed(1)}%`,
    },
    {
      key: "fat",
      label: "Trim Fat",
      value: summary.totalTrimFatWeight,
      unit: weightUnitLabel,
      extra: `${(summary.yieldPercentages?.trimFatPct ?? 0).toFixed(1)}%`,
    },
    {
      key: "offal",
      label: "Offal",
      value: summary.totalOffalWeight,
      unit: weightUnitLabel,
      extra: `${(summary.yieldPercentages?.offalPct ?? 0).toFixed(1)}%`,
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3 md:gap-4">
      {cards.map((card) => (
        <div
          key={card.key}
          className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 md:px-4 md:py-3 shadow-sm"
        >
          <p className="text-[11px] md:text-xs font-medium uppercase tracking-wide text-slate-400">
            {card.label}
          </p>
          <p className="mt-1 text-base md:text-lg font-semibold text-slate-900">
            {formatNumber(card.value)}{" "}
            <span className="text-xs text-slate-500">{card.unit}</span>
          </p>
          {card.extra && (
            <p className="mt-0.5 text-[11px] md:text-xs text-slate-400">
              {card.extra}
            </p>
          )}
        </div>
      ))}
    </div>
  );
};

const YieldBars = ({ summary }) => {
  const rows = [
    {
      key: "meatPct",
      label: "Meat",
      color: "bg-emerald-500",
      value: summary.yieldPercentages?.meatPct ?? 0,
    },
    {
      key: "bonePct",
      label: "Bone",
      color: "bg-sky-500",
      value: summary.yieldPercentages?.bonePct ?? 0,
    },
    {
      key: "trimFatPct",
      label: "Trim Fat",
      color: "bg-amber-500",
      value: summary.yieldPercentages?.trimFatPct ?? 0,
    },
    {
      key: "offalPct",
      label: "Offal",
      color: "bg-purple-500",
      value: summary.yieldPercentages?.offalPct ?? 0,
    },
    {
      key: "shrinkLossPct",
      label: "Shrink/Waste",
      color: "bg-rose-500",
      value: summary.yieldPercentages?.shrinkLossPct ?? 0,
    },
  ];

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 md:p-4">
      <p className="text-xs md:text-sm font-semibold text-slate-800 mb-2">
        Yield Distribution (% of carcass basis)
      </p>
      <div className="space-y-1.5 md:space-y-2">
        {rows.map((row) => (
          <div key={row.key} className="flex items-center gap-2">
            <div className="flex-1">
              <div className="flex items-center justify-between text-[11px] md:text-xs text-slate-500 mb-0.5">
                <span>{row.label}</span>
                <span className="font-medium text-slate-700">
                  {row.value.toFixed(1)}%
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
                <div
                  className={`h-1.5 rounded-full ${row.color}`}
                  style={{ width: `${Math.max(0, Math.min(100, row.value))}%` }}
                />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

const CutsToolbar = ({
  cutFilter,
  setCutFilter,
  categoryFilter,
  setCategoryFilter,
}) => {
  const categories = [
    { value: "all", label: "All cuts" },
    { value: "steak", label: "Steaks" },
    { value: "roast", label: "Roasts" },
    { value: "chop", label: "Chops" },
    { value: "rib", label: "Ribs" },
    { value: "ground", label: "Ground" },
    { value: "stew", label: "Stew meat" },
    { value: "organ", label: "Organs" },
    { value: "sausage", label: "Sausage" },
    { value: "other", label: "Other" },
  ];

  return (
    <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2 md:gap-3">
      <div className="flex-1 flex items-center gap-2">
        <div className="relative flex-1">
          <input
            type="text"
            value={cutFilter}
            onChange={(e) => setCutFilter(e.target.value)}
            placeholder="Search cuts (name, primal)…"
            className="w-full rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs md:text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
          />
          <div className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-slate-400">
            <span className="material-icons-outlined text-base md:text-lg">
              search
            </span>
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 md:gap-3">
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs md:text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
        >
          {categories.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
};

const CutsTable = ({ cuts, weightUnitLabel, onSelectCut }) => {
  if (!cuts.length) {
    return (
      <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs text-slate-500">
        No cuts found for this filter.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
      <div className="max-h-80 md:max-h-96 overflow-auto">
        <table className="min-w-full text-xs md:text-sm text-left">
          <thead className="bg-slate-50 text-[11px] md:text-xs uppercase tracking-wide text-slate-400 border-b border-slate-200">
            <tr>
              <th className="px-3 py-2 font-medium">Cut</th>
              <th className="px-3 py-2 font-medium">Primal</th>
              <th className="px-3 py-2 font-medium text-right">
                Weight ({weightUnitLabel})
              </th>
              <th className="px-3 py-2 font-medium text-right">
                % of Meat
              </th>
              <th className="px-3 py-2 font-medium text-right">
                Packages
              </th>
              <th className="px-3 py-2 font-medium text-right">
                Servings
              </th>
            </tr>
          </thead>
          <tbody>
            {cuts.map((cut, idx) => (
              <tr
                key={cut.id || idx}
                className="border-b border-slate-100 hover:bg-emerald-50/40 cursor-pointer"
                onClick={() => onSelectCut && onSelectCut(cut)}
              >
                <td className="px-3 py-2 align-middle">
                  <div className="flex flex-col">
                    <span className="font-medium text-slate-800">
                      {cut.name || "Cut"}
                    </span>
                    <span className="text-[11px] text-slate-400 capitalize">
                      {cut.category || "cut"}
                      {cut.boneIn ? " • bone-in" : ""}
                    </span>
                  </div>
                </td>
                <td className="px-3 py-2 align-middle">
                  <div className="flex flex-col">
                    <span className="text-slate-700">
                      {cut.primal || "—"}
                    </span>
                    {cut.subPrimal ? (
                      <span className="text-[11px] text-slate-400">
                        {cut.subPrimal}
                      </span>
                    ) : null}
                  </div>
                </td>
                <td className="px-3 py-2 align-middle text-right">
                  {formatNumber(cut.weight)}
                </td>
                <td className="px-3 py-2 align-middle text-right">
                  {(cut.yieldPctOfMeat ?? 0).toFixed(1)}%
                </td>
                <td className="px-3 py-2 align-middle text-right">
                  {cut.packagePlan?.packages ?? "—"}
                </td>
                <td className="px-3 py-2 align-middle text-right">
                  {formatNumber(cut.estimatedServings)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="px-3 py-1.5 text-[11px] text-slate-400 border-t border-slate-100">
        Click a row to see details and packaging suggestions.
      </p>
    </div>
  );
};

const ByproductsCard = ({ byproducts, basisWeight, weightUnitLabel }) => {
  if (!byproducts.length) {
    return (
      <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs text-slate-500">
        No byproducts recorded yet. Trim fat, bones, and organs will appear
        here for stock, rendering, or pet food planning.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 md:p-4">
      <div className="space-y-2 md:space-y-3 text-xs md:text-sm">
        {byproducts.map((bp, idx) => {
          const pct =
            basisWeight && basisWeight > 0
              ? ((bp.weight || 0) / basisWeight) * 100
              : bp.yieldPctOfBasis ?? 0;
          return (
            <div key={idx} className="border-b border-slate-100 pb-1.5 mb-1.5 last:border-b-0 last:pb-0 last:mb-0">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-medium text-slate-800">
                    {bp.label || typeToLabel(bp.type)}
                  </p>
                  <p className="text-[11px] text-slate-400 capitalize">
                    {bp.type || "byproduct"} • {bp.intendedUse || "use later"}
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-semibold text-slate-900">
                    {formatNumber(bp.weight)} {weightUnitLabel}
                  </p>
                  <p className="text-[11px] text-slate-400">
                    {pct.toFixed(1)}% of basis
                  </p>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

/**
 * Simple modal overlay for showing detailed info about a single cut.
 * This is a standard full-screen modal that can be hoisted into a
 * portal at the app root if you want it to behave like SessionRunner.
 */
const CutDetailModal = ({ cut, onClose }) => {
  if (!cut) return null;

  return (
    <div
      className="fixed inset-0 z-40 flex items-end md:items-center justify-center bg-black/40"
      aria-modal="true"
      role="dialog"
    >
      <div className="relative w-full md:max-w-md bg-white rounded-t-2xl md:rounded-2xl shadow-xl max-h-[90vh] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
          <div>
            <h3 className="text-sm md:text-base font-semibold text-slate-900">
              {cut.name || "Cut details"}
            </h3>
            <p className="text-[11px] md:text-xs text-slate-400 capitalize">
              {cut.category || "cut"}
              {cut.boneIn ? " • bone-in" : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-slate-200 text-slate-500 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            aria-label="Close"
          >
            <span className="material-icons-outlined text-base">close</span>
          </button>
        </div>

        {/* Body */}
        <div className="px-4 py-3 md:py-4 space-y-3 text-xs md:text-sm text-slate-700">
          <div className="grid grid-cols-2 gap-3">
            <DetailItem label="Primal">
              {cut.primal || "—"}
              {cut.subPrimal ? (
                <span className="text-[11px] text-slate-400 block">
                  {cut.subPrimal}
                </span>
              ) : null}
            </DetailItem>
            <DetailItem label="Intended Use">
              {cut.intendedUse || "family_meals"}
            </DetailItem>
            <DetailItem label="Weight">
              {formatNumber(cut.weight)} {cut.weightUnit || "lb"}
            </DetailItem>
            <DetailItem label="Yield (of meat)">
              {(cut.yieldPctOfMeat ?? 0).toFixed(1)}%
            </DetailItem>
            <DetailItem label="Servings (est.)">
              {formatNumber(cut.estimatedServings)}
            </DetailItem>
            <DetailItem label="Serving Unit">
              {cut.servingSizeUnit || "lb"}
            </DetailItem>
          </div>

          <div className="mt-2 border-t border-slate-100 pt-3">
            <p className="text-[11px] md:text-xs font-semibold text-slate-500 mb-1.5">
              Packaging Plan
            </p>
            <div className="grid grid-cols-3 gap-2">
              <DetailItem label="Packages">
                {cut.packagePlan?.packages ?? "—"}
              </DetailItem>
              <DetailItem label="Wt per pkg">
                {cut.packagePlan?.weightPerPackage != null
                  ? formatNumber(cut.packagePlan.weightPerPackage)
                  : "—"}{" "}
                {cut.weightUnit || "lb"}
              </DetailItem>
              <DetailItem label="Servings/pkg">
                {cut.packagePlan?.servingsPerPackage != null
                  ? formatNumber(cut.packagePlan.servingsPerPackage)
                  : "—"}
              </DetailItem>
            </div>
          </div>

          {cut.notes ? (
            <div className="border-t border-slate-100 pt-3">
              <p className="text-[11px] md:text-xs font-semibold text-slate-500 mb-1.5">
                Notes
              </p>
              <p className="text-xs md:text-sm text-slate-700 whitespace-pre-wrap">
                {cut.notes}
              </p>
            </div>
          ) : null}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-slate-200 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center justify-center rounded-full border border-slate-200 px-3 py-1.5 text-xs md:text-sm text-slate-700 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-emerald-500"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

const DetailItem = ({ label, children }) => (
  <div className="space-y-0.5">
    <p className="text-[10px] md:text-[11px] uppercase tracking-wide text-slate-400">
      {label}
    </p>
    <p className="text-xs md:text-sm text-slate-800">{children}</p>
  </div>
);

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function basisTypeToLabel(type) {
  switch (type) {
    case "hot_carcass":
      return "Hot carcass";
    case "live":
      return "Live weight";
    case "chilled_carcass":
    default:
      return "Chilled carcass";
  }
}

function renderAnimalHeader(animal) {
  const species = animal?.species || "Unknown species";
  const breed = animal?.breed ? ` • ${animal.breed}` : "";
  const tag = animal?.tagId ? ` • Tag ${animal.tagId}` : "";
  return `${capitalize(species)}${breed}${tag}`;
}

function typeToLabel(type) {
  switch (type) {
    case "bone":
      return "Bones";
    case "fat":
      return "Trim Fat";
    case "organ":
      return "Organs/Offal";
    case "stock_bag":
      return "Stock Bags";
    case "hide":
      return "Hide";
    case "pet_food":
      return "Pet Food";
    default:
      return "Byproduct";
  }
}

function formatNumber(val) {
  if (val == null || Number.isNaN(Number(val))) return "—";
  const n = Number(val);
  if (Math.abs(n) >= 100) return n.toFixed(0);
  if (Math.abs(n) >= 10) return n.toFixed(1);
  return n.toFixed(2);
}

function capitalize(str) {
  if (!str) return "";
  const s = String(str);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default MeatBreakdownCalculatorView;
