// C:\Users\larho\suka-smart-assistant\src\features\calculators\gardenAnimal\ButcheryWeightCalculator\ButcheryWeightCalculator.view.jsx

/**
 * ButcheryWeightCalculator.view.jsx
 *
 * UI to estimate yields from livestock butchery.
 *
 * How this fits SSA:
 * - Lets the user define a small batch of animals (species, live weight, head count).
 * - Calls the ButcheryWeightCalculator shim to compute carcass, retail, and by-product yields.
 * - Shows friendly cards for head count, carcass weights, retail cuts, and by-products.
 * - Exposes a “Plan Butchery Session (Now)” CTA that higher-level pages can wire into SessionRunner.
 *
 * This file does NOT implement SessionRunner; it only:
 * - preps a sessionDraft for the parent via `onCreateSessionDraft`,
 * - keeps a local preview modal for the butchery plan.
 *
 * Props:
 * - onCreateSessionDraft?: (sessionDraft: SessionDraft) => void
 *   Called when user clicks “Plan Butchery Session (Now)”.
 *
 * SessionDraft shape (minimum viable, aligned with SSA Session contract):
 * {
 *   id: string,
 *   domain: "animals",
 *   title: string,
 *   source: { type: "animalTask", refId: string|null },
 *   steps: [
 *     {
 *       id: string,
 *       title: string,
 *       desc: string,
 *       durationSec: number,
 *       blockers: string[],
 *       metadata: {
 *         tempTargetF: number,
 *         donenessCue: "color"|"texture"|"probeTemp"|"timer"|"smell",
 *         cueNotes: string
 *       }
 *     }
 *   ],
 *   prefs: { voiceGuidance: boolean, haptic: boolean, autoAdvance: boolean }
 * }
 */

import React, { useCallback, useMemo, useState } from "react";
import { runButcheryWeightCalculator } from "./ButcheryWeightCalculator.shim";

/**
 * @typedef {Object} ButcheryViewProps
 * @property {(sessionDraft: any) => void} [onCreateSessionDraft]
 */

/**
 * Top-level view component.
 *
 * @param {ButcheryViewProps} props
 */
export default function ButcheryWeightCalculatorView(props) {
  const { onCreateSessionDraft } = props || {};

  const [unitSystem, setUnitSystem] = useState("imperial"); // matches typical US workflow
  const [animals, setAnimals] = useState(() => [
    makeEmptyAnimalRow("1")
  ]);
  const [processingDate, setProcessingDate] = useState("");
  const [location, setLocation] = useState("");
  const [notes, setNotes] = useState("");

  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [showPreview, setShowPreview] = useState(false);

  const headCount = useMemo(
    () =>
      animals.reduce(
        (sum, a) => sum + (Number.isFinite(a.count) ? Number(a.count) || 0 : 0),
        0
      ),
    [animals]
  );

  const totalLiveWeightEstimate = useMemo(
    () =>
      animals.reduce((sum, a) => {
        const w = Number(a.liveWeight) || 0;
        const c = Number(a.count) || 0;
        return sum + w * c;
      }, 0),
    [animals]
  );

  const handleAnimalChange = useCallback((id, field, value) => {
    setAnimals((prev) =>
      prev.map((row) =>
        row.id === id
          ? {
              ...row,
              [field]: field === "count" || field === "liveWeight" ? value.replace(/[^\d.]/g, "") : value
            }
          : row
      )
    );
  }, []);

  const handleAddAnimalRow = useCallback(() => {
    setAnimals((prev) => [...prev, makeEmptyAnimalRow(String(prev.length + 1))]);
  }, []);

  const handleRemoveAnimalRow = useCallback((id) => {
    setAnimals((prev) => (prev.length === 1 ? prev : prev.filter((row) => row.id !== id)));
  }, []);

  const handleRunCalculator = useCallback(async () => {
    setIsBusy(true);
    setError("");
    try {
      const normalizedAnimals = animals
        .filter((a) => (a.species || "").trim() && Number(a.liveWeight) > 0)
        .map((a) => ({
          id: a.id,
          species: (a.species || "").trim().toLowerCase(),
          class: (a.class || "").trim().toLowerCase() || null,
          displayName: a.name || a.id,
          liveWeightKg:
            unitSystem === "metric" ? Number(a.liveWeight) || 0 : (Number(a.liveWeight) || 0) * 0.45359237,
          liveWeightLb: unitSystem === "imperial" ? Number(a.liveWeight) || 0 : undefined,
          count: Number(a.count) || 1,
          notes: a.notes || ""
        }));

      if (!normalizedAnimals.length) {
        setError("Please add at least one animal with species and live weight.");
        setIsBusy(false);
        return;
      }

      const payload = {
        context: {
          unitSystem,
          processingDate: processingDate || null,
          location: location || null,
          notes: notes || ""
        },
        animals: normalizedAnimals,
        // yieldCurves & storehouseInventory can be injected later by a higher-level planner if desired
      };

      const calcResult = await runButcheryWeightCalculator(payload);
      setResult(calcResult);
      setShowPreview(true);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("ButcheryWeightCalculatorView: calculation failed", err);
      setError(err?.message || "Something went wrong while estimating yields.");
    } finally {
      setIsBusy(false);
    }
  }, [animals, unitSystem, processingDate, location, notes]);

  const handleCreateSessionDraft = useCallback(() => {
    if (!result || !onCreateSessionDraft) return;

    const ts = new Date().toISOString();
    const headCountLabel = result?.result?.analytics?.headCount || headCount || 0;
    const titleBase =
      headCountLabel > 0
        ? `Butchery Session – ${headCountLabel} head`
        : "Butchery Session – Livestock Batch";

    const steps = buildSessionStepsFromResult(result);

    const sessionDraft = {
      id: `butchery-${ts}`,
      domain: "animals",
      title: titleBase,
      source: {
        type: "animalTask",
        refId: null
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
      createdAt: ts,
      updatedAt: ts
    };

    onCreateSessionDraft(sessionDraft);
  }, [result, onCreateSessionDraft, headCount]);

  return (
    <div className="ssa-butchery-view">
      {/* Header */}
      <div className="ssa-butchery-header ssa-card">
        <div className="ssa-butchery-header-main">
          <div>
            <h1 className="ssa-title-lg">Butchery Yield Estimator</h1>
            <p className="ssa-text-muted">
              Plan how much meat, bones, fat, and organs you can expect from each animal or batch before
              booking processing days or starting a home butchery session.
            </p>
          </div>
        </div>
        <div className="ssa-butchery-header-actions">
          <div className="ssa-toggle-group" role="radiogroup" aria-label="Unit system">
            <button
              type="button"
              className={`ssa-toggle ${unitSystem === "imperial" ? "ssa-toggle-active" : ""}`}
              onClick={() => setUnitSystem("imperial")}
            >
              lb
            </button>
            <button
              type="button"
              className={`ssa-toggle ${unitSystem === "metric" ? "ssa-toggle-active" : ""}`}
              onClick={() => setUnitSystem("metric")}
            >
              kg
            </button>
          </div>
          <button
            type="button"
            className="ssa-button-primary"
            disabled={isBusy}
            onClick={handleRunCalculator}
          >
            {isBusy ? "Calculating…" : "Estimate Yields"}
          </button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="ssa-alert ssa-alert-error" role="alert">
          {error}
        </div>
      )}

      {/* Layout grid */}
      <div className="ssa-grid ssa-grid-cols-1 md:ssa-grid-cols-3 ssa-gap-lg ssa-mt-lg">
        {/* Left: Batch configuration */}
        <section className="ssa-card md:ssa-col-span-2">
          <header className="ssa-card-header">
            <h2 className="ssa-title-md">Livestock Batch</h2>
            <p className="ssa-text-muted">
              Add each animal or grouped lot with species, weight, and head count. You can refine yield
              curves later in an advanced settings panel.
            </p>
          </header>

          <div className="ssa-table-wrapper ssa-mt-md">
            <table className="ssa-table">
              <thead>
                <tr>
                  <th>Label</th>
                  <th>Species</th>
                  <th>Class</th>
                  <th>
                    Live Weight
                    <span className="ssa-text-xs ssa-text-muted ssa-ml-xs">
                      ({unitSystem === "imperial" ? "lb/head" : "kg/head"})
                    </span>
                  </th>
                  <th>Head</th>
                  <th>Notes</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {animals.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <input
                        className="ssa-input"
                        value={row.name}
                        onChange={(e) => handleAnimalChange(row.id, "name", e.target.value)}
                        placeholder="e.g. Steer #1"
                      />
                    </td>
                    <td>
                      <input
                        className="ssa-input"
                        value={row.species}
                        onChange={(e) => handleAnimalChange(row.id, "species", e.target.value)}
                        placeholder="e.g. cattle, sheep"
                      />
                    </td>
                    <td>
                      <input
                        className="ssa-input"
                        value={row.class}
                        onChange={(e) => handleAnimalChange(row.id, "class", e.target.value)}
                        placeholder="e.g. steer, lamb"
                      />
                    </td>
                    <td>
                      <input
                        className="ssa-input ssa-input-number"
                        inputMode="decimal"
                        value={row.liveWeight}
                        onChange={(e) => handleAnimalChange(row.id, "liveWeight", e.target.value)}
                        placeholder="e.g. 1100"
                      />
                    </td>
                    <td>
                      <input
                        className="ssa-input ssa-input-number"
                        inputMode="numeric"
                        value={row.count}
                        onChange={(e) => handleAnimalChange(row.id, "count", e.target.value)}
                        placeholder="1"
                      />
                    </td>
                    <td>
                      <input
                        className="ssa-input"
                        value={row.notes}
                        onChange={(e) => handleAnimalChange(row.id, "notes", e.target.value)}
                        placeholder="Optional body condition, feed notes…"
                      />
                    </td>
                    <td className="ssa-text-right">
                      <button
                        type="button"
                        className="ssa-icon-button"
                        onClick={() => handleRemoveAnimalRow(row.id)}
                        aria-label="Remove animal row"
                        disabled={animals.length === 1}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="ssa-flex ssa-justify-between ssa-items-center ssa-mt-md">
              <button type="button" className="ssa-button-ghost" onClick={handleAddAnimalRow}>
                + Add Animal / Lot
              </button>
              <div className="ssa-text-xs ssa-text-muted">
                Head count: <span className="ssa-font-semibold">{headCount}</span> • Estimated total live
                weight:{" "}
                <span className="ssa-font-semibold">
                  {totalLiveWeightEstimate || 0} {unitSystem === "imperial" ? "lb" : "kg"}
                </span>
              </div>
            </div>
          </div>

          <hr className="ssa-divider ssa-my-md" />

          <div className="ssa-grid ssa-grid-cols-1 md:ssa-grid-cols-3 ssa-gap-md">
            <div>
              <label className="ssa-label">
                Processing Date
                <input
                  type="date"
                  className="ssa-input"
                  value={processingDate}
                  onChange={(e) => setProcessingDate(e.target.value)}
                />
              </label>
            </div>
            <div>
              <label className="ssa-label">
                Processing Location
                <input
                  type="text"
                  className="ssa-input"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="On-farm, Local processor, etc."
                />
              </label>
            </div>
            <div>
              <label className="ssa-label">
                Planning Notes
                <textarea
                  className="ssa-input ssa-h-20"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Special requests, hanging time preferences, cut style…"
                />
              </label>
            </div>
          </div>
        </section>

        {/* Right: Summary + Call-to-action */}
        <aside className="ssa-card md:ssa-col-span-1">
          <header className="ssa-card-header">
            <h2 className="ssa-title-md">Batch Snapshot</h2>
          </header>

          <div className="ssa-stats ssa-mt-md">
            <div className="ssa-stat">
              <div className="ssa-stat-label">Head Count</div>
              <div className="ssa-stat-value">{headCount}</div>
            </div>
            <div className="ssa-stat">
              <div className="ssa-stat-label">
                Live Weight ({unitSystem === "imperial" ? "lb" : "kg"})
              </div>
              <div className="ssa-stat-value">{totalLiveWeightEstimate || 0}</div>
            </div>
          </div>

          <p className="ssa-text-xs ssa-text-muted ssa-mt-md">
            Once you estimate yields, you can preview the cut breakdown and, if desired, convert this plan
            into a live SSA butchery session with timers and checklists.
          </p>

          <div className="ssa-flex ssa-flex-col ssa-gap-sm ssa-mt-lg">
            <button
              type="button"
              className="ssa-button-primary"
              disabled={isBusy}
              onClick={handleRunCalculator}
            >
              {isBusy ? "Estimating…" : "Estimate Yields"}
            </button>

            <button
              type="button"
              className="ssa-button-secondary"
              disabled={!result || !onCreateSessionDraft}
              onClick={handleCreateSessionDraft}
            >
              Plan Butchery Session (Now)
            </button>

            {!onCreateSessionDraft && (
              <p className="ssa-text-xxs ssa-text-muted">
                To wire this into SessionRunner, pass an <code>onCreateSessionDraft</code> prop from the
                animals domain page. That prop should open your SessionRunner modal with the provided
                sessionDraft.
              </p>
            )}
          </div>
        </aside>
      </div>

      {/* Preview modal for yields */}
      {showPreview && result && (
        <ButcheryYieldPreviewModal
          unitSystem={unitSystem}
          result={result}
          onClose={() => setShowPreview(false)}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Modal component                                                            */
/* -------------------------------------------------------------------------- */

/**
 * @param {Object} props
 * @param {"metric"|"imperial"} props.unitSystem
 * @param {any} props.result
 * @param {() => void} props.onClose
 */
function ButcheryYieldPreviewModal({ unitSystem, result, onClose }) {
  const analytics = result?.result?.analytics || {};
  const carcasses = result?.result?.carcassBreakdown || [];
  const retailCuts = result?.result?.retailCutPlan || [];
  const byproducts = result?.result?.offalAndByproducts || [];

  const weightDisplay = useCallback(
    (kg) => {
      if (!kg || !Number.isFinite(kg)) return "0";
      if (unitSystem === "metric") return `${roundTo(kg, 1)} kg`;
      const lb = kg / 0.45359237;
      return `${roundTo(lb, 1)} lb`;
    },
    [unitSystem]
  );

  return (
    <div className="ssa-modal-backdrop" role="dialog" aria-modal="true">
      <div className="ssa-modal ssa-modal-lg">
        <header className="ssa-modal-header">
          <div>
            <h2 className="ssa-title-md">Estimated Yields</h2>
            <p className="ssa-text-muted ssa-text-xs">
              Review carcass, retail, and by-product estimates. You can still adjust cuts and labels later
              when you plan your full butchery session.
            </p>
          </div>
          <button type="button" className="ssa-icon-button" onClick={onClose} aria-label="Close preview">
            ✕
          </button>
        </header>

        <div className="ssa-modal-body ssa-grid ssa-grid-cols-1 lg:ssa-grid-cols-3 ssa-gap-md">
          {/* Batch analytics */}
          <section className="ssa-card lg:ssa-col-span-1">
            <h3 className="ssa-title-sm">Batch Totals</h3>
            <dl className="ssa-mt-sm ssa-deflist">
              <div className="ssa-deflist-row">
                <dt>Head Count</dt>
                <dd>{analytics.headCount || 0}</dd>
              </div>
              <div className="ssa-deflist-row">
                <dt>Total Live Weight</dt>
                <dd>{weightDisplay(analytics.totalLiveWeightKg || 0)}</dd>
              </div>
              <div className="ssa-deflist-row">
                <dt>Total Carcass Weight</dt>
                <dd>{weightDisplay(analytics.totalCarcassWeightKg || 0)}</dd>
              </div>
              <div className="ssa-deflist-row">
                <dt>Total Retail Weight</dt>
                <dd>{weightDisplay(analytics.totalRetailWeightKg || 0)}</dd>
              </div>
              <div className="ssa-deflist-row">
                <dt>Total By-products</dt>
                <dd>{weightDisplay(analytics.totalByproductWeightKg || 0)}</dd>
              </div>
              <div className="ssa-deflist-row">
                <dt>Average Dressing %</dt>
                <dd>{analytics.averageDressingPercent || 0}%</dd>
              </div>
              <div className="ssa-deflist-row">
                <dt>Average Retail Yield %</dt>
                <dd>{analytics.averageRetailYieldPercent || 0}%</dd>
              </div>
            </dl>
          </section>

          {/* Carcass breakdown */}
          <section className="ssa-card lg:ssa-col-span-2">
            <h3 className="ssa-title-sm">Per-Animal Carcass Breakdown</h3>
            <div className="ssa-table-wrapper ssa-mt-sm ssa-max-h-48 ssa-overflow-auto">
              <table className="ssa-table ssa-table-sm">
                <thead>
                  <tr>
                    <th>Animal</th>
                    <th>Head</th>
                    <th>Live</th>
                    <th>Carcass</th>
                    <th>Dressing %</th>
                    <th>Shrink %</th>
                  </tr>
                </thead>
                <tbody>
                  {carcasses.map((c) => (
                    <tr key={c.animalId}>
                      <td>
                        <div className="ssa-text-xs">
                          <div className="ssa-font-semibold">{c.animalId}</div>
                          <div className="ssa-text-muted">
                            {c.species}
                            {c.class ? ` / ${c.class}` : ""}
                          </div>
                        </div>
                      </td>
                      <td>{c.count || 1}</td>
                      <td>{weightDisplay(c.liveWeightKg)}</td>
                      <td>{weightDisplay(c.carcassChilledKg)}</td>
                      <td>{typeof c.dressingPercent === "number" ? `${c.dressingPercent}%` : "—"}</td>
                      <td>{typeof c.shrinkPercent === "number" ? `${c.shrinkPercent}%` : "—"}</td>
                    </tr>
                  ))}
                  {!carcasses.length && (
                    <tr>
                      <td colSpan={6} className="ssa-text-center ssa-text-xs ssa-text-muted">
                        No carcass data — run the estimator first.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {/* Retail cuts */}
          <section className="ssa-card lg:ssa-col-span-2">
            <h3 className="ssa-title-sm">Retail Cut Plan</h3>
            <div className="ssa-table-wrapper ssa-mt-sm ssa-max-h-48 ssa-overflow-auto">
              <table className="ssa-table ssa-table-sm">
                <thead>
                  <tr>
                    <th>Cut</th>
                    <th>Animal</th>
                    <th>Weight</th>
                    <th>Packages</th>
                  </tr>
                </thead>
                <tbody>
                  {retailCuts.map((r, idx) => (
                    <tr key={`${r.animalId}-${r.cutKey}-${idx}`}>
                      <td>
                        <div className="ssa-text-xs">
                          <div className="ssa-font-semibold">{r.cutName}</div>
                          <div className="ssa-text-muted">{r.cutKey}</div>
                        </div>
                      </td>
                      <td className="ssa-text-xs">{r.animalId}</td>
                      <td>{weightDisplay(r.weightKg)}</td>
                      <td className="ssa-text-xs">
                        {r.units ? `${r.units} @ ${r.unitSizeKg || "?"} kg` : "—"}
                      </td>
                    </tr>
                  ))}
                  {!retailCuts.length && (
                    <tr>
                      <td colSpan={4} className="ssa-text-center ssa-text-xs ssa-text-muted">
                        No retail cut plan — estimator will auto create a generic “Mixed Retail Cuts” entry
                        if no detailed distributions are configured.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {/* By-products */}
          <section className="ssa-card lg:ssa-col-span-1">
            <h3 className="ssa-title-sm">By-products</h3>
            <div className="ssa-table-wrapper ssa-mt-sm ssa-max-h-48 ssa-overflow-auto">
              <table className="ssa-table ssa-table-sm">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Animal</th>
                    <th>Weight</th>
                  </tr>
                </thead>
                <tbody>
                  {byproducts.map((b, idx) => (
                    <tr key={`${b.animalId}-${b.name}-${idx}`}>
                      <td className="ssa-text-xs">
                        <div className="ssa-font-semibold">{b.name}</div>
                        <div className="ssa-text-muted">{b.category}</div>
                      </td>
                      <td className="ssa-text-xs">{b.animalId}</td>
                      <td>{weightDisplay(b.weightKg)}</td>
                    </tr>
                  ))}
                  {!byproducts.length && (
                    <tr>
                      <td colSpan={3} className="ssa-text-center ssa-text-xs ssa-text-muted">
                        No by-product estimate — calculator will generate simple bones/fat/organs estimates
                        by default.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <footer className="ssa-modal-footer">
          <button type="button" className="ssa-button-secondary" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Local helpers                                                              */
/* -------------------------------------------------------------------------- */

function makeEmptyAnimalRow(id) {
  return {
    id,
    name: "",
    species: "",
    class: "",
    liveWeight: "",
    count: "1",
    notes: ""
  };
}

function roundTo(value, decimals) {
  const factor = Math.pow(10, decimals || 0);
  return Math.round((Number(value) || 0) * factor) / factor;
}

/**
 * Builds a simple SSA session step list from butchery analytics + carcass data.
 * This is intentionally high-level and can be extended into more detailed checklists later.
 *
 * @param {any} result
 * @returns {Array<any>}
 */
function buildSessionStepsFromResult(result) {
  const carcasses = result?.result?.carcassBreakdown || [];
  const analytics = result?.result?.analytics || {};
  const tsLabel = new Date().toLocaleDateString();

  const headCount = analytics.headCount || carcasses.length || 0;
  const totalLive = analytics.totalLiveWeightKg || 0;
  const totalCarcass = analytics.totalCarcassWeightKg || 0;

  const steps = [];

  steps.push({
    id: "step-intake",
    title: "Verify Livestock & Setup Area",
    desc: `Confirm ${headCount} head for processing (${roundTo(totalLive, 1)} kg live). Check equipment, sanitation, and safety before starting.`,
    durationSec: 20 * 60,
    blockers: ["equipment", "inventory"],
    metadata: {
      tempTargetF: 0,
      donenessCue: "timer",
      cueNotes: "Use this time to cross-check animals, tags, and humane handling steps."
    }
  });

  steps.push({
    id: "step-harvest-chill",
    title: "Harvest & Initial Chilling",
    desc: `Perform humane harvest and hang carcasses. Target total hot carcass weight ~${roundTo(
      totalCarcass,
      1
    )} kg for this batch.`,
    durationSec: 90 * 60,
    blockers: ["weather", "equipment"],
    metadata: {
      tempTargetF: 40,
      donenessCue: "probeTemp",
      cueNotes: "Aim to bring carcass temp down below 40°F / 4°C as quickly and safely as possible."
    }
  });

  steps.push({
    id: "step-breakdown",
    title: "Carcass Breakdown & Retail Cuts",
    desc:
      "Break each carcass into primals and retail cuts according to your plan (steaks, roasts, ground, etc.). Track final weights by cut.",
    durationSec: 120 * 60,
    blockers: ["equipment"],
    metadata: {
      tempTargetF: 0,
      donenessCue: "timer",
      cueNotes: "Use your SSA cut labels and scales to log weights into the Butchery Yield tools."
    }
  });

  steps.push({
    id: "step-byproducts",
    title: "By-products & Organs Handling",
    desc: "Separate bones, fat trim, and organs for stock, rendering, pet food, or discard. Label and store per food safety rules.",
    durationSec: 45 * 60,
    blockers: ["inventory"],
    metadata: {
      tempTargetF: 0,
      donenessCue: "timer",
      cueNotes: "Keep offal properly chilled and clearly labeled for intended use."
    }
  });

  steps.push({
    id: "step-cleanup",
    title: `Cleanup & Log to Storehouse (${tsLabel})`,
    desc:
      "Clean all tools and surfaces, sanitize the work area, and log final cut weights into the Storehouse inventory for meal planning.",
    durationSec: 30 * 60,
    blockers: ["inventory", "equipment"],
    metadata: {
      tempTargetF: 0,
      donenessCue: "smell",
      cueNotes: "Area should be visibly clean with no off odors; record cuts and batch IDs in SSA."
    }
  });

  return steps;
}
