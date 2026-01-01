// C:\Users\larho\suka-smart-assistant\src\features\calculators\gardenAnimal\GardenYieldCalculator\GardenYieldCalculator.view.jsx

import React, { useState, useMemo } from "react";
import { runGardenYieldCalculatorShim } from "./GardenYieldCalculator.shim";
import eventBus from "@/services/eventBus";

/**
 * GardenYieldCalculatorView
 *
 * UI for visualizing garden yields, weekly harvest load, and preservation
 * batches. It also exposes “Now” CTAs that emit session.requested events
 * so the SessionRunner can guide harvest / preservation work.
 *
 * Props:
 * - initialPayload?: { context, inputs, outputs }
 * - onPayloadChange?: (payload) => void
 * - onResult?: (result) => void
 */
export default function GardenYieldCalculatorView({
  initialPayload,
  onPayloadChange,
  onResult
}) {
  const [payload, setPayload] = useState(() =>
    initialPayload && typeof initialPayload === "object"
      ? initialPayload
      : getDefaultPayload()
  );
  const [result, setResult] = useState(() =>
    initialPayload && initialPayload.outputs ? initialPayload : null
  );
  const [isComputing, setIsComputing] = useState(false);
  const [error, setError] = useState("");

  const inputs = payload.inputs || {};
  const crops = Array.isArray(inputs.crops) ? inputs.crops : [];
  const assumptions = inputs.assumptions || {};
  const storehouseTargets =
    (inputs.storehouseTargets && inputs.storehouseTargets.targetsByCrop) || [];

  const outputs = (result && result.outputs) || {
    yieldEstimates: [],
    harvestLoadByWeek: [],
    preservationLoad: [],
    storehouseCoverage: [],
    summary: {
      totalCrops: crops.length,
      totalExpectedYield: 0,
      yieldUnit: "lbs",
      totalPreservationBatches: 0,
      busiestWeekStartDate: null,
      busiestWeekTotalYield: 0,
      notes: ""
    }
  };

  const yieldEstimates = outputs.yieldEstimates || [];
  const harvestLoadByWeek = outputs.harvestLoadByWeek || [];
  const preservationLoad = outputs.preservationLoad || [];
  const storehouseCoverage = outputs.storehouseCoverage || [];
  const summary = outputs.summary || {};

  const sortedHarvestWeeks = useMemo(
    () =>
      [...harvestLoadByWeek].sort((a, b) =>
        (a.weekStartDate || "").localeCompare(b.weekStartDate || "")
      ),
    [harvestLoadByWeek]
  );

  const sortedPreservationGroups = useMemo(
    () =>
      [...preservationLoad].sort((a, b) =>
        (a.method || "").localeCompare(b.method || "")
      ),
    [preservationLoad]
  );

  const nextHarvestWeek = useMemo(
    () => findNextHarvestWeek(sortedHarvestWeeks),
    [sortedHarvestWeeks]
  );
  const nextPreservationGroup = useMemo(
    () => findNextPreservationGroup(sortedPreservationGroups),
    [sortedPreservationGroups]
  );

  async function handleRecalculate() {
    setIsComputing(true);
    setError("");
    try {
      const next = await runGardenYieldCalculatorShim(payload, {
        eventBus,
        featureFlags: { familyFundMode: false }
      });
      setResult(next);
      setPayload(next);
      if (onResult) onResult(next);
      if (onPayloadChange) onPayloadChange(next);
    } catch (err) {
      console.error("GardenYieldCalculatorView error:", err);
      setError("Unable to recompute yields. Please check inputs.");
    } finally {
      setIsComputing(false);
    }
  }

  function updateInputs(partial) {
    const next = {
      ...payload,
      inputs: {
        ...payload.inputs,
        ...partial
      }
    };
    setPayload(next);
    if (onPayloadChange) onPayloadChange(next);
  }

  function handleAssumptionChange(field, value) {
    const nextAssumptions = {
      ...assumptions,
      [field]:
        field === "lossFactor" || field === "laborHoursPerUnit"
          ? toNumber(value, assumptions[field] || 0)
          : value
    };
    updateInputs({ assumptions: nextAssumptions });
  }

  function handleCropChange(index, field, value) {
    const nextCrops = [...crops];
    const current = nextCrops[index] || {};
    nextCrops[index] = {
      ...current,
      [field]:
        field === "rowFeet" ||
        field === "plantsPerFoot" ||
        field === "expectedYieldPerPlant"
          ? toNumber(value, "")
          : value
    };
    updateInputs({ crops: nextCrops });
  }

  function handleAddCrop() {
    const nextCrops = [
      ...crops,
      {
        cropId: `crop-${Date.now()}`,
        name: "",
        bedId: "",
        rowFeet: "",
        plantsPerFoot: "",
        expectedYieldPerPlant: "",
        yieldUnit: "lbs",
        targetUse: "mixed",
        successionCount: 1,
        preservationRatio: "",
        notes: ""
      }
    ];
    updateInputs({ crops: nextCrops });
  }

  function handleRemoveCrop(index) {
    const nextCrops = crops.filter((_, i) => i !== index);
    updateInputs({ crops: nextCrops });
  }

  /**
   * Launch a harvest-focused garden session for a target week bucket.
   */
  function handleLaunchHarvestWeekSession(weekBucket) {
    if (!weekBucket) return;
    const ts = new Date().toISOString();
    const session = buildHarvestSessionFromWeek(weekBucket);
    try {
      if (eventBus && typeof eventBus.emit === "function") {
        eventBus.emit({
          type: "session.requested",
          ts,
          source: "calculators/garden/GardenYieldCalculator.view",
          data: { session }
        });
      }
    } catch (err) {
      console.warn(
        "[GardenYieldCalculator.view] harvest week emit failed:",
        err
      );
    }
  }

  /**
   * Launch a preservation session for a given preservation batch group.
   */
  function handleLaunchPreservationSession(group) {
    if (!group) return;
    const ts = new Date().toISOString();
    const session = buildPreservationSessionFromGroup(group);
    try {
      if (eventBus && typeof eventBus.emit === "function") {
        eventBus.emit({
          type: "session.requested",
          ts,
          source: "calculators/garden/GardenYieldCalculator.view",
          data: { session }
        });
      }
    } catch (err) {
      console.warn(
        "[GardenYieldCalculator.view] preservation emit failed:",
        err
      );
    }
  }

  return (
    <div className="ssa-calculator-card">
      <header className="ssa-calculator-header">
        <div>
          <h2 className="ssa-calculator-title">Garden Yield & Harvest Planner</h2>
          <p className="ssa-calculator-subtitle">
            Estimate per-crop yields, see your busiest harvest weeks, and plan
            preservation batches that feed directly into SSA garden sessions.
          </p>
        </div>
        <div className="ssa-calculator-actions">
          <button
            type="button"
            className="ssa-button-secondary"
            onClick={handleRecalculate}
            disabled={isComputing}
          >
            {isComputing ? "Calculating…" : "Recalculate Yields"}
          </button>

          {/* “Now” buttons for the nearest harvest week and preservation batch */}
          <button
            type="button"
            className="ssa-button-primary"
            disabled={!nextHarvestWeek}
            onClick={() => nextHarvestWeek && handleLaunchHarvestWeekSession(nextHarvestWeek)}
          >
            Harvest Now
          </button>
          <button
            type="button"
            className="ssa-button-primary ssa-button-outline"
            disabled={!nextPreservationGroup}
            onClick={() =>
              nextPreservationGroup &&
              handleLaunchPreservationSession(nextPreservationGroup)
            }
          >
            Preservation Now
          </button>
        </div>
      </header>

      {error && <div className="ssa-alert-error">{error}</div>}

      {/* Inputs strip: crops + assumptions */}
      <section className="ssa-calculator-grid">
        {/* Crop configuration */}
        <div className="ssa-panel">
          <div className="ssa-panel-header">
            <h3 className="ssa-panel-title">Crop Yield Inputs</h3>
            <button
              type="button"
              className="ssa-button-ghost"
              onClick={handleAddCrop}
            >
              + Add Crop
            </button>
          </div>

          {crops.length === 0 ? (
            <p className="ssa-empty-state">
              No crops defined yet. Add at least one crop with row feet, plants
              per foot, and expected yield per plant.
            </p>
          ) : (
            <div className="ssa-table-wrapper ssa-table-wrapper--compact">
              <table className="ssa-table">
                <thead>
                  <tr>
                    <th>Crop</th>
                    <th>Bed</th>
                    <th>Row Feet</th>
                    <th>Plants / Ft</th>
                    <th>Yield / Plant</th>
                    <th>Unit</th>
                    <th>Target Use</th>
                    <th>Succession Count</th>
                    <th>Preservation Ratio</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {crops.map((crop, idx) => (
                    <tr key={crop.cropId || idx}>
                      <td>
                        <input
                          type="text"
                          className="ssa-input ssa-input-sm"
                          value={crop.name || ""}
                          onChange={(e) =>
                            handleCropChange(idx, "name", e.target.value)
                          }
                          placeholder="e.g., Roma tomato"
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          className="ssa-input ssa-input-sm"
                          value={crop.bedId || ""}
                          onChange={(e) =>
                            handleCropChange(idx, "bedId", e.target.value)
                          }
                          placeholder="Bed A1"
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          className="ssa-input ssa-input-sm"
                          value={crop.rowFeet ?? ""}
                          onChange={(e) =>
                            handleCropChange(idx, "rowFeet", e.target.value)
                          }
                          min={0}
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          className="ssa-input ssa-input-sm"
                          value={crop.plantsPerFoot ?? ""}
                          onChange={(e) =>
                            handleCropChange(
                              idx,
                              "plantsPerFoot",
                              e.target.value
                            )
                          }
                          min={0}
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          className="ssa-input ssa-input-sm"
                          value={crop.expectedYieldPerPlant ?? ""}
                          onChange={(e) =>
                            handleCropChange(
                              idx,
                              "expectedYieldPerPlant",
                              e.target.value
                            )
                          }
                          min={0}
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          className="ssa-input ssa-input-sm"
                          value={crop.yieldUnit || "lbs"}
                          onChange={(e) =>
                            handleCropChange(idx, "yieldUnit", e.target.value)
                          }
                        />
                      </td>
                      <td>
                        <select
                          className="ssa-input ssa-input-sm"
                          value={crop.targetUse || "mixed"}
                          onChange={(e) =>
                            handleCropChange(idx, "targetUse", e.target.value)
                          }
                        >
                          <option value="fresh">Fresh</option>
                          <option value="preservation">Preservation</option>
                          <option value="seed">Seed saving</option>
                          <option value="mixed">Mixed</option>
                        </select>
                      </td>
                      <td>
                        <input
                          type="number"
                          className="ssa-input ssa-input-sm"
                          value={crop.successionCount ?? 1}
                          onChange={(e) =>
                            handleCropChange(
                              idx,
                              "successionCount",
                              e.target.value
                            )
                          }
                          min={1}
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          className="ssa-input ssa-input-sm"
                          step="0.05"
                          min={0}
                          max={1}
                          value={crop.preservationRatio ?? ""}
                          onChange={(e) =>
                            handleCropChange(
                              idx,
                              "preservationRatio",
                              e.target.value
                            )
                          }
                          placeholder="0.5"
                        />
                      </td>
                      <td className="ssa-cell-actions">
                        <button
                          type="button"
                          className="ssa-icon-button"
                          onClick={() => handleRemoveCrop(idx)}
                          aria-label="Remove crop"
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Assumptions & defaults */}
        <div className="ssa-panel">
          <h3 className="ssa-panel-title">Assumptions & Labor</h3>
          <div className="ssa-field-group">
            <label className="ssa-field">
              <span className="ssa-field-label">Loss Factor</span>
              <span className="ssa-field-help">
                Fraction of yield lost to pests, disease, and misses (0–1).
              </span>
              <input
                type="number"
                className="ssa-input"
                step="0.05"
                min={0}
                max={1}
                value={assumptions.lossFactor ?? 0.15}
                onChange={(e) =>
                  handleAssumptionChange("lossFactor", e.target.value)
                }
              />
            </label>
          </div>
          <div className="ssa-field-group">
            <label className="ssa-field">
              <span className="ssa-field-label">Labor Hours per Unit</span>
              <span className="ssa-field-help">
                Approximate hours needed per unit of harvest (e.g., per lb).
              </span>
              <input
                type="number"
                className="ssa-input"
                step="0.05"
                min={0}
                value={assumptions.laborHoursPerUnit ?? 0.25}
                onChange={(e) =>
                  handleAssumptionChange("laborHoursPerUnit", e.target.value)
                }
              />
            </label>
          </div>
          <p className="ssa-helper-text">
            These values influence weekly harvest workload and preservation
            batch planning. You can refine them as you gather real data.
          </p>
        </div>
      </section>

      {/* Summary strip */}
      <section className="ssa-summary-strip">
        <div className="ssa-summary-item">
          <span className="ssa-summary-label">Crops</span>
          <span className="ssa-summary-value">
            {summary.totalCrops ?? yieldEstimates.length}
          </span>
        </div>
        <div className="ssa-summary-item">
          <span className="ssa-summary-label">Total Expected Yield</span>
          <span className="ssa-summary-value">
            {summary.totalExpectedYield ?? 0}{" "}
            {summary.yieldUnit || "lbs"}
          </span>
        </div>
        <div className="ssa-summary-item">
          <span className="ssa-summary-label">Preservation Batches</span>
          <span className="ssa-summary-value">
            {summary.totalPreservationBatches ?? 0}
          </span>
        </div>
        {summary.busiestWeekStartDate && (
          <div className="ssa-summary-item">
            <span className="ssa-summary-label">Busiest Week</span>
            <span className="ssa-summary-value">
              {summary.busiestWeekStartDate} (
              {summary.busiestWeekTotalYield ?? 0}{" "}
              {summary.yieldUnit || "lbs"})
            </span>
          </div>
        )}
      </section>

      {/* Yield table + storehouse coverage */}
      <section className="ssa-results-grid">
        {/* Yield estimates table */}
        <div className="ssa-panel">
          <div className="ssa-panel-header">
            <h3 className="ssa-panel-title">Yield Estimates by Crop</h3>
          </div>
          {yieldEstimates.length === 0 ? (
            <p className="ssa-empty-state">
              No yield estimates yet. Add crops and recalculate.
            </p>
          ) : (
            <div className="ssa-table-wrapper ssa-table-wrapper--scroll">
              <table className="ssa-table ssa-table-sm">
                <thead>
                  <tr>
                    <th>Crop</th>
                    <th>Bed</th>
                    <th>Total Plants</th>
                    <th>Yield / Plant</th>
                    <th>Total Yield</th>
                    <th>Adjusted (Loss)</th>
                    <th>Fresh</th>
                    <th>For Preservation</th>
                    <th>For Seed</th>
                  </tr>
                </thead>
                <tbody>
                  {yieldEstimates.map((est) => (
                    <tr key={est.cropId || est.cropName}>
                      <td>{est.cropName}</td>
                      <td>{est.bedId || "—"}</td>
                      <td>{est.totalPlants}</td>
                      <td>
                        {est.expectedYieldPerPlant} {est.yieldUnit}
                      </td>
                      <td>
                        {est.expectedTotalYield} {est.yieldUnit}
                      </td>
                      <td>
                        {est.adjustedForLoss} {est.yieldUnit}
                      </td>
                      <td>
                        {est.forFresh} {est.yieldUnit}
                      </td>
                      <td>
                        {est.forPreservation} {est.yieldUnit}
                      </td>
                      <td>
                        {est.forSeed} {est.yieldUnit}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Storehouse coverage */}
        <div className="ssa-panel">
          <div className="ssa-panel-header">
            <h3 className="ssa-panel-title">Storehouse Coverage</h3>
          </div>
          {storehouseTargets.length === 0 ? (
            <p className="ssa-empty-state">
              No storehouse targets configured. Once you define per-crop target
              amounts, coverage will appear here.
            </p>
          ) : storehouseCoverage.length === 0 ? (
            <p className="ssa-empty-state">
              Targets are defined, but no coverage could be computed yet. Make
              sure crops line up by cropId.
            </p>
          ) : (
            <div className="ssa-table-wrapper ssa-table-wrapper--scroll">
              <table className="ssa-table ssa-table-sm">
                <thead>
                  <tr>
                    <th>Crop</th>
                    <th>Target</th>
                    <th>Expected Preserved</th>
                    <th>Coverage</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {storehouseCoverage.map((c) => (
                    <tr key={c.cropId || c.cropName}>
                      <td>{c.cropName}</td>
                      <td>
                        {c.targetAmount} {c.targetUnit}
                      </td>
                      <td>
                        {c.expectedPreservedAmount} {c.targetUnit}
                      </td>
                      <td>{Math.round(c.coveragePercent)}%</td>
                      <td>
                        <span
                          className={`ssa-badge-outline ssa-badge-status-${c.status}`}
                        >
                          {c.status.replace("-", " ")}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {/* Harvest load + preservation batches */}
      <section className="ssa-results-grid">
        {/* Weekly harvest load timeline */}
        <div className="ssa-panel ssa-panel--spacious">
          <div className="ssa-panel-header">
            <h3 className="ssa-panel-title">Weekly Harvest Load</h3>
            <p className="ssa-panel-subtitle">
              See which weeks are heaviest for harvest and labor.
            </p>
          </div>
          {sortedHarvestWeeks.length === 0 ? (
            <p className="ssa-empty-state">
              No harvest load data yet. Make sure harvest windows are provided
              to this calculator.
            </p>
          ) : (
            <ul className="ssa-timeline">
              {sortedHarvestWeeks.map((week) => (
                <li key={week.weekStartDate} className="ssa-timeline-item">
                  <div className="ssa-timeline-date">
                    {week.weekStartDate} – {week.weekEndDate}
                  </div>
                  <div className="ssa-timeline-content">
                    <div className="ssa-timeline-header">
                      <span className="ssa-timeline-title">
                        {Math.round(week.totalYield)} {week.yieldUnit} expected
                      </span>
                      <span className="ssa-cell-sub">
                        Labor: {week.estimatedLaborHours.toFixed(1)} hours
                      </span>
                    </div>
                    <div className="ssa-badge-row">
                      {Array.isArray(week.crops) &&
                        week.crops.map((c) => (
                          <span
                            key={c.cropId || c.cropName}
                            className="ssa-badge-muted"
                          >
                            {c.cropName || c.cropId}:{" "}
                            {Math.round(c.yield)} {week.yieldUnit}
                          </span>
                        ))}
                    </div>
                    <div className="ssa-timeline-actions">
                      <button
                        type="button"
                        className="ssa-button-secondary ssa-button-xs"
                        onClick={() =>
                          handleLaunchHarvestWeekSession(week)
                        }
                      >
                        Run Harvest Session
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Preservation batches */}
        <div className="ssa-panel ssa-panel--spacious">
          <div className="ssa-panel-header">
            <h3 className="ssa-panel-title">Preservation Batches</h3>
            <p className="ssa-panel-subtitle">
              Grouped by method and crop to help you schedule canning, freezing,
              dehydrating, and more.
            </p>
          </div>
          {sortedPreservationGroups.length === 0 ? (
            <p className="ssa-empty-state">
              No preservation groups yet. Define crops and recalculate with
              preservation ratios.
            </p>
          ) : (
            <ul className="ssa-timeline">
              {sortedPreservationGroups.map((group) => (
                <li key={group.batchGroupId} className="ssa-timeline-item">
                  <div className="ssa-timeline-date">
                    {group.method.toUpperCase()}
                  </div>
                  <div className="ssa-timeline-content">
                    <div className="ssa-timeline-header">
                      <span className="ssa-timeline-title">
                        {group.cropName} –{" "}
                        {Math.round(group.totalForPreservation)}{" "}
                        {group.yieldUnit}
                      </span>
                      <span className="ssa-cell-sub">
                        Batch size: {group.idealBatchSize} {group.yieldUnit} ·
                        Batches:{" "}
                        {group.expectedBatchCount.toFixed(1)}
                      </span>
                    </div>
                    {Array.isArray(group.linkedHarvestWindows) &&
                      group.linkedHarvestWindows.length > 0 && (
                        <p className="ssa-timeline-notes">
                          Linked harvest windows:{" "}
                          {group.linkedHarvestWindows.join(", ")}
                        </p>
                      )}
                    <div className="ssa-timeline-actions">
                      <button
                        type="button"
                        className="ssa-button-secondary ssa-button-xs"
                        onClick={() =>
                          handleLaunchPreservationSession(group)
                        }
                      >
                        Plan Preservation Session
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function getDefaultPayload() {
  const now = new Date();
  return {
    context: {
      nodeKey: "gardenYield",
      version: "1.0.0"
    },
    inputs: {
      crops: [],
      plantingWindows: [],
      harvestWindows: [],
      storehouseTargets: {
        year: now.getFullYear(),
        targetsByCrop: []
      },
      assumptions: {
        lossFactor: 0.15,
        laborHoursPerUnit: 0.25,
        batchSizeDefaults: {
          canning: 10,
          freezing: 10,
          dehydrating: 8,
          fermenting: 8,
          rootCellar: 12,
          unit: "lbs"
        }
      }
    },
    outputs: null
  };
}

/**
 * Build a harvest session object from a weekly harvest load bucket.
 */
function buildHarvestSessionFromWeek(weekBucket) {
  const id = `garden-harvest-week-${weekBucket.weekStartDate}-${Date.now()}`;
  const title = `Harvest Week of ${weekBucket.weekStartDate}`;
  const stepIdBase = `${id}-step`;

  const steps = [
    {
      id: `${stepIdBase}-plan`,
      title: "Review harvest plan",
      desc:
        "Review which crops to harvest this week and confirm containers, tools, and helpers.",
      durationSec: 10 * 60,
      blockers: ["inventory", "weather"],
      metadata: {
        tempTargetF: 0,
        donenessCue: "timer",
        cueNotes: "Check tools, crates, and shade setup."
      }
    },
    {
      id: `${stepIdBase}-harvest`,
      title: "Harvest crops",
      desc:
        "Harvest listed crops, keeping produce shaded and cool. Sort as you go for fresh use vs. preservation.",
      durationSec: 45 * 60,
      blockers: ["weather"],
      metadata: {
        tempTargetF: 0,
        donenessCue: "timer",
        cueNotes:
          "Aim to complete all harvest tasks for this week bucket."
      }
    },
    {
      id: `${stepIdBase}-post`,
      title: "Post-harvest handling",
      desc:
        "Rinse (if appropriate), dry, and stage produce for refrigeration or preservation batches.",
      durationSec: 25 * 60,
      blockers: [],
      metadata: {
        tempTargetF: 0,
        donenessCue: "timer",
        cueNotes:
          "Label containers with crop name and date for easier tracking."
      }
    }
  ];

  return {
    id,
    domain: "garden",
    title,
    source: {
      type: "gardenPlan",
      refId: weekBucket.weekStartDate || null
    },
    steps,
    prefs: {
      voiceGuidance: true,
      haptic: true,
      autoAdvance: false
    },
    status: "pending",
    progress: {
      currentStepIndex: 0,
      elapsedSec: 0,
      startedAt: null,
      pausedAt: null
    },
    analytics: {
      skippedSteps: [],
      adjustments: []
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

/**
 * Build a preservation session from a preservation batch group.
 */
function buildPreservationSessionFromGroup(group) {
  const id = `garden-preserve-${group.method}-${group.cropId}-${Date.now()}`;
  const methodLabel = group.method.toUpperCase();
  const title = `${methodLabel} ${group.cropName}`;

  const stepIdBase = `${id}-step`;

  const steps = [
    {
      id: `${stepIdBase}-prep`,
      title: "Prep produce and equipment",
      desc:
        "Wash, trim, and portion produce. Set up jars, lids, freezer bags, dehydrator trays, or other equipment.",
      durationSec: 30 * 60,
      blockers: ["inventory", "equipment"],
      metadata: {
        tempTargetF: 0,
        donenessCue: "timer",
        cueNotes:
          "Double-check lids, seals, and equipment condition before starting."
      }
    },
    {
      id: `${stepIdBase}-process`,
      title: "Run preservation process",
      desc:
        "Follow your chosen method and recipe to complete the preservation batches for this crop.",
      durationSec: 60 * 60,
      blockers: ["inventory", "equipment", "weather"],
      metadata: {
        tempTargetF: 0,
        donenessCue: "timer",
        cueNotes:
          "Adjust processing time and pressure for altitude and jar size as needed."
      }
    },
    {
      id: `${stepIdBase}-finish`,
      title: "Cool, label, and store",
      desc:
        "Allow jars or containers to cool, label each with crop, method, and date, then move to long-term storage.",
      durationSec: 20 * 60,
      blockers: ["inventory"],
      metadata: {
        tempTargetF: 0,
        donenessCue: "timer",
        cueNotes:
          "Verify seals or closures before moving to pantry, freezer, or root cellar."
      }
    }
  ];

  return {
    id,
    domain: "garden",
    title,
    source: {
      type: "gardenPlan",
      refId: group.batchGroupId || null
    },
    steps,
    prefs: {
      voiceGuidance: true,
      haptic: true,
      autoAdvance: false
    },
    status: "pending",
    progress: {
      currentStepIndex: 0,
      elapsedSec: 0,
      startedAt: null,
      pausedAt: null
    },
    analytics: {
      skippedSteps: [],
      adjustments: []
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function findNextHarvestWeek(weeks) {
  if (!Array.isArray(weeks) || weeks.length === 0) return null;
  const today = new Date().toISOString().slice(0, 10);

  const upcoming = weeks
    .filter((w) => w.weekEndDate >= today)
    .sort((a, b) =>
      (a.weekStartDate || "").localeCompare(b.weekStartDate || "")
    );

  return upcoming[0] || weeks[0];
}

function findNextPreservationGroup(groups) {
  if (!Array.isArray(groups) || groups.length === 0) return null;
  // Light heuristic: pick group with the highest totalForPreservation
  let best = null;
  let bestAmount = -Infinity;
  for (const g of groups) {
    const amt = Number(g.totalForPreservation) || 0;
    if (amt > bestAmount) {
      bestAmount = amt;
      best = g;
    }
  }
  return best;
}

function toNumber(value, fallback) {
  if (value === "" || value === null || value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
