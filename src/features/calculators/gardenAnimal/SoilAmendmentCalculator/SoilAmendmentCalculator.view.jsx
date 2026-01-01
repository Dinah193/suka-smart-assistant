// C:\Users\larho\suka-smart-assistant\src\features\calculators\gardenAnimal\SoilAmendmentCalculator\SoilAmendmentCalculator.view.jsx

import React, { useMemo } from "react";

/**
 * SoilAmendmentCalculator.view
 *
 * HOW THIS FITS:
 * - Pure UI component for editing SoilAmendmentCalculator payload inputs
 *   (soilProfile, soilTests, targetFertility, gardenLayout.beds).
 * - Displays amendment outputs produced by SoilAmendmentCalculator.shim.js
 *   (amendmentPlan, amendmentSessions, amendmentSummary).
 * - Exposes callbacks instead of owning business logic:
 *   - onPayloadChange(nextPayload)  → parent persists / runs shim.
 *   - onRunShim(payload)            → parent invokes shim (or Reasoner).
 *   - onRequestSessionNow(sessions) → parent maps sessions → SessionRunner.
 *
 * This keeps the calculator view reusable and side-effect-free while still
 * playing nicely with the SessionRunner “Now” flows on garden pages.
 *
 * Expected payload shape (short version):
 * {
 *   context: { nodeKey, version, runId },
 *   inputs: {
 *     soilProfile: {
 *       defaultTexture: "loam|sand|clay|...",
 *       beds: [
 *         { bedId, name, texture, organicMatterPct, drainage }
 *       ]
 *     },
 *     soilTests: [
 *       { testId, bedId, takenAt, ph, nPpm, pPpm, kPpm, caPpm, mgPpm }
 *     ],
 *     targetFertility: { phMin, phMax, nMin, nMax, pMin, pMax, kMin, kMax },
 *     gardenLayout: { beds: [{ bedId, name, areaSqFt, depthInches }] }
 *   },
 *   outputs: {
 *     amendmentPlan: [...],
 *     amendmentSessions: [...],
 *     amendmentSummary: {...}
 *   }
 * }
 */

/**
 * @typedef {Object} SoilAmendmentViewProps
 * @property {any} payload
 * @property {(nextPayload: any) => void} [onPayloadChange]
 * @property {(payload: any) => void | Promise<void>} [onRunShim]
 * @property {(sessions: any[]) => void} [onRequestSessionNow]
 * @property {boolean} [busy]
 * @property {string | null} [error]
 */

/**
 * @param {SoilAmendmentViewProps} props
 */
export default function SoilAmendmentCalculatorView(props) {
  const {
    payload,
    onPayloadChange,
    onRunShim,
    onRequestSessionNow,
    busy = false,
    error = null
  } = props;

  const inputs = payload?.inputs || {};
  const soilProfile = inputs.soilProfile || {};
  const soilBeds = Array.isArray(soilProfile.beds) ? soilProfile.beds : [];
  const soilTests = Array.isArray(inputs.soilTests) ? inputs.soilTests : [];
  const targetFertility = inputs.targetFertility || {};
  const gardenLayout = inputs.gardenLayout || {};
  const layoutBeds = Array.isArray(gardenLayout.beds) ? gardenLayout.beds : [];

  const outputs = payload?.outputs || {};
  const amendmentPlan = Array.isArray(outputs.amendmentPlan) ? outputs.amendmentPlan : [];
  const amendmentSessions = Array.isArray(outputs.amendmentSessions)
    ? outputs.amendmentSessions
    : [];
  const amendmentSummary = outputs.amendmentSummary || null;

  // ---------------------------------------------------------------------------
  // Derived helpers
  // ---------------------------------------------------------------------------

  const bedsWithLayout = useMemo(() => {
    const layoutById = new Map();
    layoutBeds.forEach((b) => {
      if (b && b.bedId) layoutById.set(String(b.bedId), b);
    });
    return soilBeds.map((b) => {
      const id = String(b.bedId || "");
      const layoutBed = layoutById.get(id);
      return {
        ...layoutBed,
        ...b,
        bedId: id || layoutBed?.bedId || `bed-${Math.random().toString(36).slice(2)}`
      };
    });
  }, [soilBeds, layoutBeds]);

  // For quick map of bed name in tables
  const bedNameById = useMemo(() => {
    const map = new Map();
    bedsWithLayout.forEach((b) => {
      if (!b || !b.bedId) return;
      map.set(String(b.bedId), b.name || `Bed ${b.bedId}`);
    });
    return map;
  }, [bedsWithLayout]);

  // ---------------------------------------------------------------------------
  // Change utilities
  // ---------------------------------------------------------------------------

  const updateInputs = (updater) => {
    if (!onPayloadChange) return;
    const base = payload || {};
    const nextInputs = updater(inputs || {});
    onPayloadChange({
      ...base,
      inputs: nextInputs
    });
  };

  const handleBedFieldChange = (index, field, value) => {
    updateInputs((prev) => {
      const nextSoilProfile = { ...(prev.soilProfile || {}) };
      const beds = Array.isArray(nextSoilProfile.beds) ? [...nextSoilProfile.beds] : [];
      const prevBed = beds[index] || {};
      beds[index] = {
        ...prevBed,
        [field]: field === "organicMatterPct" || field === "depthInches" || field === "areaSqFt"
          ? toNumber(value, "")
          : value
      };
      nextSoilProfile.beds = beds;
      const nextGardenLayout = { ...(prev.gardenLayout || {}) };
      const layoutBedsNext = Array.isArray(nextGardenLayout.beds)
        ? [...nextGardenLayout.beds]
        : [];
      const layoutIndex = layoutBedsNext.findIndex(
        (b) => String(b.bedId) === String(beds[index].bedId)
      );
      if (field === "name" || field === "areaSqFt" || field === "depthInches") {
        const layoutBed = layoutIndex >= 0 ? layoutBedsNext[layoutIndex] : {};
        const merged = {
          ...layoutBed,
          bedId: beds[index].bedId,
          name: field === "name" ? value : layoutBed.name || beds[index].name,
          areaSqFt:
            field === "areaSqFt"
              ? toNumber(value, layoutBed.areaSqFt || 0)
              : layoutBed.areaSqFt || beds[index].areaSqFt,
          depthInches:
            field === "depthInches"
              ? toNumber(value, layoutBed.depthInches || 0)
              : layoutBed.depthInches || beds[index].depthInches
        };
        if (layoutIndex >= 0) {
          layoutBedsNext[layoutIndex] = merged;
        } else {
          layoutBedsNext.push(merged);
        }
      }
      nextGardenLayout.beds = layoutBedsNext;
      return {
        ...prev,
        soilProfile: nextSoilProfile,
        gardenLayout: nextGardenLayout
      };
    });
  };

  const handleAddBed = () => {
    updateInputs((prev) => {
      const nextSoilProfile = { ...(prev.soilProfile || {}) };
      const beds = Array.isArray(nextSoilProfile.beds) ? [...nextSoilProfile.beds] : [];
      const id = `bed-${beds.length + 1}`;
      beds.push({
        bedId: id,
        name: `Bed ${beds.length + 1}`,
        texture: soilProfile.defaultTexture || "loam",
        organicMatterPct: "",
        drainage: "moderate"
      });
      nextSoilProfile.beds = beds;

      const nextGardenLayout = { ...(prev.gardenLayout || {}) };
      const layoutBedsNext = Array.isArray(nextGardenLayout.beds)
        ? [...nextGardenLayout.beds]
        : [];
      layoutBedsNext.push({
        bedId: id,
        name: `Bed ${beds.length}`,
        areaSqFt: "",
        depthInches: 8
      });
      nextGardenLayout.beds = layoutBedsNext;

      return {
        ...prev,
        soilProfile: nextSoilProfile,
        gardenLayout: nextGardenLayout
      };
    });
  };

  const handleSoilTestChange = (index, field, value) => {
    updateInputs((prev) => {
      const tests = Array.isArray(prev.soilTests) ? [...prev.soilTests] : [];
      const prevTest = tests[index] || {};
      tests[index] = {
        ...prevTest,
        [field]:
          field === "ph" ||
          field === "nPpm" ||
          field === "pPpm" ||
          field === "kPpm" ||
          field === "caPpm" ||
          field === "mgPpm"
            ? toNumber(value, "")
            : value
      };
      return {
        ...prev,
        soilTests: tests
      };
    });
  };

  const handleAddTest = () => {
    const firstBed = bedsWithLayout[0];
    updateInputs((prev) => {
      const tests = Array.isArray(prev.soilTests) ? [...prev.soilTests] : [];
      tests.push({
        testId: `test-${tests.length + 1}`,
        bedId: firstBed ? firstBed.bedId : "",
        takenAt: new Date().toISOString().slice(0, 10),
        ph: "",
        nPpm: "",
        pPpm: "",
        kPpm: ""
      });
      return {
        ...prev,
        soilTests: tests
      };
    });
  };

  const handleTargetChange = (field, value) => {
    updateInputs((prev) => {
      const nextTarget = { ...(prev.targetFertility || {}) };
      nextTarget[field] = toNumber(value, "");
      return {
        ...prev,
        targetFertility: nextTarget
      };
    });
  };

  const handleRunClick = async () => {
    if (!onRunShim) return;
    await onRunShim(payload);
  };

  const handleNowClick = () => {
    if (!onRequestSessionNow || amendmentSessions.length === 0) return;
    onRequestSessionNow(amendmentSessions);
  };

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  return (
    <div className="ssa-panel ssa-panel--calculator grid grid-cols-1 xl:grid-cols-3 gap-4 h-full">
      {/* Left column: Beds & soil profile */}
      <div className="flex flex-col border rounded-lg bg-white/70 dark:bg-slate-900/60 shadow-sm overflow-hidden">
        <header className="px-4 py-3 border-b bg-slate-50 dark:bg-slate-900/80 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
              Beds & soil profile
            </h2>
            <p className="text-xs text-slate-500">
              Define each garden bed, texture, and approximate size.
            </p>
          </div>
          <button
            type="button"
            className="text-xs px-2 py-1 rounded-md border border-slate-300 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800"
            onClick={handleAddBed}
          >
            + Add bed
          </button>
        </header>

        <div className="flex-1 overflow-auto p-3 space-y-3">
          <div className="flex items-center gap-2">
            <label className="text-xs font-medium text-slate-600 dark:text-slate-300">
              Default texture
            </label>
            <select
              className="flex-1 text-xs border rounded-md px-2 py-1 bg-white dark:bg-slate-900"
              value={soilProfile.defaultTexture || ""}
              onChange={(e) =>
                updateInputs((prev) => ({
                  ...prev,
                  soilProfile: {
                    ...(prev.soilProfile || {}),
                    defaultTexture: e.target.value
                  }
                }))
              }
            >
              <option value="">Choose…</option>
              <option value="sand">Sand</option>
              <option value="sandy-loam">Sandy loam</option>
              <option value="loam">Loam</option>
              <option value="silt-loam">Silt loam</option>
              <option value="clay">Clay</option>
              <option value="clay-loam">Clay loam</option>
            </select>
          </div>

          {bedsWithLayout.length === 0 && (
            <p className="text-xs text-slate-500 italic">
              No beds defined yet. Add at least one bed to generate recommendations.
            </p>
          )}

          <div className="space-y-2">
            {bedsWithLayout.map((bed, index) => (
              <div
                key={bed.bedId || index}
                className="border rounded-md px-3 py-2 bg-white dark:bg-slate-950/60 space-y-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <input
                    type="text"
                    className="flex-1 text-xs border rounded-md px-2 py-1 bg-white dark:bg-slate-900"
                    value={bed.name || ""}
                    onChange={(e) => handleBedFieldChange(index, "name", e.target.value)}
                    placeholder="Bed name"
                  />
                  <span className="text-[10px] text-slate-400">ID: {bed.bedId}</span>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="flex flex-col gap-1">
                    <label className="text-[11px] text-slate-500">Texture</label>
                    <select
                      className="text-xs border rounded-md px-2 py-1 bg-white dark:bg-slate-900"
                      value={bed.texture || ""}
                      onChange={(e) => handleBedFieldChange(index, "texture", e.target.value)}
                    >
                      <option value="">Inherit default</option>
                      <option value="sand">Sand</option>
                      <option value="sandy-loam">Sandy loam</option>
                      <option value="loam">Loam</option>
                      <option value="silt-loam">Silt loam</option>
                      <option value="clay">Clay</option>
                      <option value="clay-loam">Clay loam</option>
                    </select>
                  </div>

                  <div className="flex flex-col gap-1">
                    <label className="text-[11px] text-slate-500">% Organic matter</label>
                    <input
                      type="number"
                      className="text-xs border rounded-md px-2 py-1 bg-white dark:bg-slate-900"
                      value={bed.organicMatterPct ?? ""}
                      onChange={(e) =>
                        handleBedFieldChange(index, "organicMatterPct", e.target.value)
                      }
                      min={0}
                      step={0.1}
                    />
                  </div>

                  <div className="flex flex-col gap-1">
                    <label className="text-[11px] text-slate-500">Area (sq ft)</label>
                    <input
                      type="number"
                      className="text-xs border rounded-md px-2 py-1 bg-white dark:bg-slate-900"
                      value={bed.areaSqFt ?? ""}
                      onChange={(e) => handleBedFieldChange(index, "areaSqFt", e.target.value)}
                      min={0}
                    />
                  </div>

                  <div className="flex flex-col gap-1">
                    <label className="text-[11px] text-slate-500">Worked depth (in)</label>
                    <input
                      type="number"
                      className="text-xs border rounded-md px-2 py-1 bg-white dark:bg-slate-900"
                      value={bed.depthInches ?? ""}
                      onChange={(e) =>
                        handleBedFieldChange(index, "depthInches", e.target.value)
                      }
                      min={1}
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-1">
                  <label className="text-[11px] text-slate-500">Drainage</label>
                  <select
                    className="text-xs border rounded-md px-2 py-1 bg-white dark:bg-slate-900"
                    value={bed.drainage || "moderate"}
                    onChange={(e) => handleBedFieldChange(index, "drainage", e.target.value)}
                  >
                    <option value="poor">Poor / heavy</option>
                    <option value="moderate">Moderate</option>
                    <option value="fast">Fast / sandy</option>
                  </select>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Middle column: Soil tests + target fertility */}
      <div className="flex flex-col border rounded-lg bg-white/70 dark:bg-slate-900/60 shadow-sm overflow-hidden">
        <header className="px-4 py-3 border-b bg-slate-50 dark:bg-slate-900/80 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
              Soil tests & fertility targets
            </h2>
            <p className="text-xs text-slate-500">
              Enter lab or DIY soil test values and your fertility targets.
            </p>
          </div>
          <button
            type="button"
            className="text-xs px-2 py-1 rounded-md border border-slate-300 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800"
            onClick={handleAddTest}
          >
            + Add test
          </button>
        </header>

        <div className="flex-1 overflow-auto p-3 space-y-4">
          {/* Soil tests table */}
          {soilTests.length === 0 && (
            <p className="text-xs text-slate-500 italic">
              No soil tests yet. Add at least one test, or leave blank for generic compost
              recommendations.
            </p>
          )}

          {soilTests.length > 0 && (
            <div className="border rounded-md overflow-x-auto">
              <table className="min-w-full text-[11px]">
                <thead className="bg-slate-50 dark:bg-slate-900/80">
                  <tr>
                    <th className="px-2 py-1 text-left font-semibold text-slate-600">Bed</th>
                    <th className="px-2 py-1 text-left font-semibold text-slate-600">Taken</th>
                    <th className="px-2 py-1 text-left font-semibold text-slate-600">pH</th>
                    <th className="px-2 py-1 text-left font-semibold text-slate-600">N</th>
                    <th className="px-2 py-1 text-left font-semibold text-slate-600">P</th>
                    <th className="px-2 py-1 text-left font-semibold text-slate-600">K</th>
                  </tr>
                </thead>
                <tbody>
                  {soilTests.map((t, index) => (
                    <tr key={t.testId || index} className="border-t">
                      <td className="px-2 py-1">
                        <select
                          className="text-[11px] border rounded-md px-1 py-0.5 bg-white dark:bg-slate-900"
                          value={t.bedId || ""}
                          onChange={(e) =>
                            handleSoilTestChange(index, "bedId", e.target.value || "")
                          }
                        >
                          <option value="">Choose…</option>
                          {bedsWithLayout.map((b) => (
                            <option key={b.bedId} value={b.bedId}>
                              {bedNameById.get(String(b.bedId))}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-2 py-1">
                        <input
                          type="date"
                          className="text-[11px] border rounded-md px-1 py-0.5 bg-white dark:bg-slate-900"
                          value={t.takenAt || ""}
                          onChange={(e) =>
                            handleSoilTestChange(index, "takenAt", e.target.value)
                          }
                        />
                      </td>
                      <td className="px-2 py-1">
                        <input
                          type="number"
                          step="0.1"
                          className="w-16 text-[11px] border rounded-md px-1 py-0.5 bg-white dark:bg-slate-900"
                          value={t.ph ?? ""}
                          onChange={(e) => handleSoilTestChange(index, "ph", e.target.value)}
                        />
                      </td>
                      <td className="px-2 py-1">
                        <input
                          type="number"
                          className="w-16 text-[11px] border rounded-md px-1 py-0.5 bg-white dark:bg-slate-900"
                          value={t.nPpm ?? ""}
                          onChange={(e) => handleSoilTestChange(index, "nPpm", e.target.value)}
                        />
                      </td>
                      <td className="px-2 py-1">
                        <input
                          type="number"
                          className="w-16 text-[11px] border rounded-md px-1 py-0.5 bg-white dark:bg-slate-900"
                          value={t.pPpm ?? ""}
                          onChange={(e) => handleSoilTestChange(index, "pPpm", e.target.value)}
                        />
                      </td>
                      <td className="px-2 py-1">
                        <input
                          type="number"
                          className="w-16 text-[11px] border rounded-md px-1 py-0.5 bg-white dark:bg-slate-900"
                          value={t.kPpm ?? ""}
                          onChange={(e) => handleSoilTestChange(index, "kPpm", e.target.value)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Target fertility mini-panel */}
          <div className="border rounded-md p-3 bg-slate-50/70 dark:bg-slate-950/60 space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-slate-700 dark:text-slate-100">
                Target fertility
              </h3>
              <p className="text-[10px] text-slate-500">
                Adjust for crops that prefer higher or lower fertility.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <TargetRangeField
                label="pH range"
                minValue={targetFertility.phMin}
                maxValue={targetFertility.phMax}
                onMinChange={(v) => handleTargetChange("phMin", v)}
                onMaxChange={(v) => handleTargetChange("phMax", v)}
              />
              <TargetRangeField
                label="Nitrogen N (ppm)"
                minValue={targetFertility.nMin}
                maxValue={targetFertility.nMax}
                onMinChange={(v) => handleTargetChange("nMin", v)}
                onMaxChange={(v) => handleTargetChange("nMax", v)}
              />
              <TargetRangeField
                label="Phosphorus P (ppm)"
                minValue={targetFertility.pMin}
                maxValue={targetFertility.pMax}
                onMinChange={(v) => handleTargetChange("pMin", v)}
                onMaxChange={(v) => handleTargetChange("pMax", v)}
              />
              <TargetRangeField
                label="Potassium K (ppm)"
                minValue={targetFertility.kMin}
                maxValue={targetFertility.kMax}
                onMinChange={(v) => handleTargetChange("kMin", v)}
                onMaxChange={(v) => handleTargetChange("kMax", v)}
              />
            </div>
          </div>

          {/* Run button + error */}
          <div className="flex items-center justify-between gap-2 pt-1">
            <button
              type="button"
              onClick={handleRunClick}
              disabled={busy}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
            >
              {busy ? "Calculating…" : "Update recommendations"}
            </button>
            {error && (
              <span className="text-[11px] text-red-500 truncate" title={error}>
                {error}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Right column: Recommendations + “Now” session CTA */}
      <div className="flex flex-col border rounded-lg bg-white/70 dark:bg-slate-900/60 shadow-sm overflow-hidden">
        <header className="px-4 py-3 border-b bg-slate-50 dark:bg-slate-900/80 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
              Amendment recommendations
            </h2>
            <p className="text-xs text-slate-500">
              Review materials and quantities; then schedule or run a prep session.
            </p>
          </div>
          <button
            type="button"
            onClick={handleNowClick}
            disabled={amendmentSessions.length === 0}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-semibold bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed shadow-sm"
          >
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-lime-300 animate-pulse" />
            Now
          </button>
        </header>

        <div className="flex-1 overflow-auto p-3 space-y-3">
          {/* Summary cards */}
          {amendmentSummary ? (
            <div className="grid grid-cols-2 gap-2">
              <SummaryCard
                label="Beds covered"
                value={amendmentSummary.totalBeds}
                hint="Beds with at least one recommendation."
              />
              <SummaryCard
                label="Materials"
                value={amendmentSummary.totalMaterials}
                hint="Unique amendment materials."
              />
              <SummaryCard
                label="Prep sessions"
                value={amendmentSummary.totalSessions}
                hint="One session per bed with amendments."
              />
              <SummaryCard
                label="Est. labor (min)"
                value={amendmentSummary.estimatedTotalLaborMinutes}
                hint="Rough estimate for planning your workday."
              />
            </div>
          ) : (
            <p className="text-xs text-slate-500 italic">
              Run the calculator to see suggested materials and labor estimates.
            </p>
          )}

          {/* Amendment plan table */}
          {amendmentPlan.length > 0 && (
            <div className="border rounded-md overflow-x-auto">
              <table className="min-w-full text-[11px]">
                <thead className="bg-slate-50 dark:bg-slate-900/80">
                  <tr>
                    <th className="px-2 py-1 text-left font-semibold text-slate-600">Bed</th>
                    <th className="px-2 py-1 text-left font-semibold text-slate-600">Material</th>
                    <th className="px-2 py-1 text-right font-semibold text-slate-600">
                      Rate / sq ft
                    </th>
                    <th className="px-2 py-1 text-right font-semibold text-slate-600">Total</th>
                    <th className="px-2 py-1 text-left font-semibold text-slate-600">Priority</th>
                  </tr>
                </thead>
                <tbody>
                  {amendmentPlan.map((row, idx) => (
                    <tr key={row.planId || idx} className="border-t">
                      <td className="px-2 py-1">
                        {bedNameById.get(String(row.bedId)) || row.bedId || "Bed"}
                      </td>
                      <td className="px-2 py-1">{row.materialName}</td>
                      <td className="px-2 py-1 text-right">
                        {formatNumber(row.ratePerSqFt)}{" "}
                        <span className="text-[10px] text-slate-400">
                          {row.materialUnit || ""}
                        </span>
                      </td>
                      <td className="px-2 py-1 text-right">
                        {formatNumber(row.totalAmount)}{" "}
                        <span className="text-[10px] text-slate-400">
                          {row.materialUnit || ""}
                        </span>
                      </td>
                      <td className="px-2 py-1">
                        <PriorityPill priority={row.priority} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Sessions preview */}
          {amendmentSessions.length > 0 && (
            <div className="border rounded-md p-2 bg-slate-50/70 dark:bg-slate-950/60 space-y-1">
              <div className="flex items-center justify-between">
                <h3 className="text-[11px] font-semibold text-slate-700 dark:text-slate-100">
                  Prep sessions
                </h3>
                <span className="text-[10px] text-slate-500">
                  {amendmentSessions.length} session
                  {amendmentSessions.length > 1 ? "s" : ""}
                </span>
              </div>
              <ul className="space-y-1 max-h-32 overflow-auto pr-1">
                {amendmentSessions.map((s) => (
                  <li
                    key={s.sessionId}
                    className="flex items-center justify-between text-[11px] border rounded px-2 py-1 bg-white dark:bg-slate-900"
                  >
                    <span className="truncate mr-2" title={s.title}>
                      {s.title}
                    </span>
                    <span className="text-[10px] text-slate-500">
                      {Math.round((s.estimatedDurationSec || 0) / 60)} min
                    </span>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={handleNowClick}
                disabled={amendmentSessions.length === 0}
                className="mt-1 inline-flex items-center justify-center w-full px-2 py-1 rounded-md text-[11px] font-semibold bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Start first prep session now
              </button>
            </div>
          )}

          {amendmentSummary && amendmentSummary.notes && (
            <p className="text-[11px] text-slate-500 italic">{amendmentSummary.notes}</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   label: string;
 *   minValue: number | string | undefined;
 *   maxValue: number | string | undefined;
 *   onMinChange: (val: string) => void;
 *   onMaxChange: (val: string) => void;
 * }} props
 */
function TargetRangeField({ label, minValue, maxValue, onMinChange, onMaxChange }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[11px] text-slate-600 dark:text-slate-300">{label}</label>
      <div className="flex items-center gap-1">
        <input
          type="number"
          className="flex-1 text-[11px] border rounded-md px-2 py-0.5 bg-white dark:bg-slate-900"
          value={minValue ?? ""}
          onChange={(e) => onMinChange(e.target.value)}
        />
        <span className="text-[10px] text-slate-400">to</span>
        <input
          type="number"
          className="flex-1 text-[11px] border rounded-md px-2 py-0.5 bg-white dark:bg-slate-900"
          value={maxValue ?? ""}
          onChange={(e) => onMaxChange(e.target.value)}
        />
      </div>
    </div>
  );
}

/**
 * @param {{ label: string; value: number | string | undefined; hint?: string }} props
 */
function SummaryCard({ label, value, hint }) {
  return (
    <div className="border rounded-md px-2.5 py-1.5 bg-white/80 dark:bg-slate-950/60 shadow-xs">
      <div className="text-[10px] text-slate-500">{label}</div>
      <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">
        {value ?? "—"}
      </div>
      {hint && <div className="text-[10px] text-slate-400 mt-0.5">{hint}</div>}
    </div>
  );
}

/**
 * @param {{ priority?: string }} props
 */
function PriorityPill({ priority }) {
  const label = priority || "medium";
  let bgClass = "bg-amber-100 text-amber-700 border-amber-200";

  if (label === "high" || label === "critical") {
    bgClass = "bg-red-100 text-red-700 border-red-200";
  } else if (label === "low") {
    bgClass = "bg-slate-100 text-slate-700 border-slate-200";
  }

  return (
    <span
      className={
        "inline-flex items-center px-2 py-0.5 rounded-full text-[10px] border capitalize " +
        bgClass
      }
    >
      {label}
    </span>
  );
}

/**
 * @param {any} v
 * @param {number} [fallback]
 */
function toNumber(v, fallback = 0) {
  if (v === "" || v === null || v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {any} v
 */
function formatNumber(v) {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  if (Math.abs(n) >= 100) return n.toFixed(0);
  if (Math.abs(n) >= 10) return n.toFixed(1);
  return n.toFixed(2);
}
