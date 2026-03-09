// C:\Users\larho\suka-smart-assistant\src\features\calculators\gardenAnimal\SeedViabilityCalculator\SeedViabilityCalculator.view.jsx

import React, { useState } from "react";
import { emit } from "@/services/events/eventBus";
import { runSeedViabilityCalculatorShim } from "./SeedViabilityCalculator.shim";

/**
 * SeedViabilityCalculator.view.jsx
 *
 * UI for checking seed viability and planning seeding.
 *
 * This component:
 * - Lets you enter one or more seed lots with basic metadata.
 * - Optionally captures environment and planning hints.
 * - Calls the SeedViabilityCalculator shim to estimate germination & viability.
 * - Shows per-lot results with sowing multipliers and replacement guidance.
 * - Can request germination / sorting sessions via the SessionRunner pipeline.
 */

export default function SeedViabilityCalculatorView() {
  const [seedLots, setSeedLots] = useState([
    {
      id: "lot-1",
      crop: "",
      variety: "",
      ageCategory: "1-2-years",
      packedForYear: null,
      storageProfile: {
        sealed: false,
        cool: false,
        dark: false,
        dry: false,
      },
      planning: {
        priority: "important",
      },
      germinationTest: {
        performed: false,
      },
    },
  ]);

  const [environment, setEnvironment] = useState({
    locationLabel: "",
    expectedSoilTempStartC: null,
    regionClimate: "",
    frostRisk: "medium",
  });

  const [planningHints, setPlanningHints] = useState({
    storehouseGoalProfile: {
      staplePriorityFactor: 1.0,
      minimumViabilityForStaples: 70,
    },
    allowHighRiskLots: false,
  });

  const [result, setResult] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState(null);
  const [detailsLot, setDetailsLot] = useState(null);

  const handleLotChange = (index, field, value) => {
    setSeedLots((prev) => {
      const next = [...prev];
      next[index] = {
        ...next[index],
        [field]: value,
      };
      return next;
    });
  };

  const handleStorageChange = (index, field, value) => {
    setSeedLots((prev) => {
      const next = [...prev];
      next[index] = {
        ...next[index],
        storageProfile: {
          ...(next[index].storageProfile || {}),
          [field]: value,
        },
      };
      return next;
    });
  };

  const handlePlanningChange = (index, field, value) => {
    setSeedLots((prev) => {
      const next = [...prev];
      next[index] = {
        ...next[index],
        planning: {
          ...(next[index].planning || {}),
          [field]: value,
        },
      };
      return next;
    });
  };

  const addSeedLot = () => {
    setSeedLots((prev) => [
      ...prev,
      {
        id: `lot-${prev.length + 1}`,
        crop: "",
        variety: "",
        ageCategory: "1-2-years",
        packedForYear: null,
        storageProfile: {
          sealed: false,
          cool: false,
          dark: false,
          dry: false,
        },
        planning: {
          priority: "important",
        },
        germinationTest: {
          performed: false,
        },
      },
    ]);
  };

  const removeSeedLot = (index) => {
    setSeedLots((prev) => prev.filter((_, i) => i !== index));
  };

  const handleRunCalculator = async () => {
    setIsRunning(true);
    setError(null);

    const ts = new Date().toISOString();

    emit({
      type: "planningGraph.seedViability.invoked",
      ts,
      source: "SeedViabilityCalculator.view",
      data: { lotCount: seedLots.length },
    });

    try {
      const payload = {
        seedLots,
        environment,
        planningHints,
      };

      const shimResult = await runSeedViabilityCalculatorShim(payload);
      setResult(shimResult);

      if (!shimResult?.meta?.ok) {
        setError(
          shimResult?.meta?.message ||
            "Seed viability calculation completed with issues."
        );
      }
    } catch (err) {
      setError(
        err && err.message
          ? err.message
          : "Unexpected error while running seed viability calculator."
      );
    } finally {
      setIsRunning(false);
    }
  };

  /**
   * Request a germination test SessionRunner session based on current results.
   * Prefer lots that are "watch", "replace-soon", or "replace-now".
   */
  const handleCreateGerminationSession = () => {
    if (!result || !Array.isArray(result.lots) || result.lots.length === 0) {
      // Fall back to all current seedLots if we have no result yet
      emit({
        type: "session.request",
        ts: new Date().toISOString(),
        source: "SeedViabilityCalculator.view",
        data: {
          domain: "garden",
          templateId: "seed-viability-germination-test",
          nodeKey: "seedViabilityCalculator",
          lots: seedLots,
        },
      });
      return;
    }

    const candidateLots = result.lots.filter((lot) =>
      ["watch", "replace-soon", "replace-now"].includes(lot.recommendedStatus)
    );

    emit({
      type: "session.request",
      ts: new Date().toISOString(),
      source: "SeedViabilityCalculator.view",
      data: {
        domain: "garden",
        templateId: "seed-viability-germination-test",
        nodeKey: "seedViabilityCalculator",
        lots: candidateLots,
      },
    });
  };

  /**
   * Request a sorting / culling session based on current results.
   */
  const handleCreateSortingSession = () => {
    const lotsForSorting =
      result && Array.isArray(result.lots) && result.lots.length > 0
        ? result.lots
        : seedLots;

    emit({
      type: "session.request",
      ts: new Date().toISOString(),
      source: "SeedViabilityCalculator.view",
      data: {
        domain: "garden",
        templateId: "seed-viability-sorting-session",
        nodeKey: "seedViabilityCalculator",
        lots: lotsForSorting,
      },
    });
  };

  return (
    <div className="sv-seed-viability-layout">
      <header className="sv-header">
        <div>
          <h2 className="sv-title">Seed Viability Calculator</h2>
          <p className="sv-subtitle">
            Evaluate seed lots, estimate germination, and plan over-seeding or
            replacement before planting.
          </p>
        </div>
        <div className="sv-header-actions">
          <button
            type="button"
            className="sv-button sv-button-primary"
            onClick={handleRunCalculator}
            disabled={isRunning || seedLots.length === 0}
          >
            {isRunning ? "Running..." : "Run Viability Check"}
          </button>
          <button
            type="button"
            className="sv-button sv-button-ghost"
            onClick={handleCreateGerminationSession}
          >
            Create Germination Test Session
          </button>
          <button
            type="button"
            className="sv-button sv-button-ghost"
            onClick={handleCreateSortingSession}
          >
            Create Sorting Session
          </button>
        </div>
      </header>

      <main className="sv-main-grid">
        {/* LEFT: Seed lots + environment + planning */}
        <section className="sv-card sv-card-left">
          <div className="sv-card-header">
            <h3>Seed Lots & Details</h3>
            <button
              type="button"
              className="sv-button sv-button-sm sv-button-outline"
              onClick={addSeedLot}
            >
              + Add Lot
            </button>
          </div>

          <div className="sv-lots-table-wrapper">
            <table className="sv-table sv-table-compact">
              <thead>
                <tr>
                  <th>Lot ID</th>
                  <th>Crop</th>
                  <th>Variety</th>
                  <th>Age</th>
                  <th>Priority</th>
                  <th>Storage (C/D/Dr/S)</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {seedLots.map((lot, index) => (
                  <tr key={lot.id || index}>
                    <td>
                      <input
                        type="text"
                        className="sv-input sv-input-xs"
                        value={lot.id}
                        onChange={(e) =>
                          handleLotChange(index, "id", e.target.value)
                        }
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        className="sv-input sv-input-xs"
                        value={lot.crop}
                        onChange={(e) =>
                          handleLotChange(index, "crop", e.target.value)
                        }
                        placeholder="e.g. Collards"
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        className="sv-input sv-input-xs"
                        value={lot.variety || ""}
                        onChange={(e) =>
                          handleLotChange(index, "variety", e.target.value)
                        }
                        placeholder="Variety"
                      />
                    </td>
                    <td>
                      <select
                        className="sv-select sv-select-xs"
                        value={lot.ageCategory || "1-2-years"}
                        onChange={(e) =>
                          handleLotChange(index, "ageCategory", e.target.value)
                        }
                      >
                        <option value="fresh">Fresh</option>
                        <option value="1-2-years">1–2 years</option>
                        <option value="3-4-years">3–4 years</option>
                        <option value="5+-years">5+ years</option>
                      </select>
                    </td>
                    <td>
                      <select
                        className="sv-select sv-select-xs"
                        value={lot.planning?.priority || "important"}
                        onChange={(e) =>
                          handlePlanningChange(
                            index,
                            "priority",
                            e.target.value
                          )
                        }
                      >
                        <option value="staple">Staple</option>
                        <option value="important">Important</option>
                        <option value="experimental">Experimental</option>
                      </select>
                    </td>
                    <td>
                      <div className="sv-storage-flags">
                        <label title="Cool">
                          <input
                            type="checkbox"
                            checked={!!lot.storageProfile?.cool}
                            onChange={(e) =>
                              handleStorageChange(
                                index,
                                "cool",
                                e.target.checked
                              )
                            }
                          />
                          C
                        </label>
                        <label title="Dark">
                          <input
                            type="checkbox"
                            checked={!!lot.storageProfile?.dark}
                            onChange={(e) =>
                              handleStorageChange(
                                index,
                                "dark",
                                e.target.checked
                              )
                            }
                          />
                          D
                        </label>
                        <label title="Dry">
                          <input
                            type="checkbox"
                            checked={!!lot.storageProfile?.dry}
                            onChange={(e) =>
                              handleStorageChange(
                                index,
                                "dry",
                                e.target.checked
                              )
                            }
                          />
                          Dr
                        </label>
                        <label title="Sealed">
                          <input
                            type="checkbox"
                            checked={!!lot.storageProfile?.sealed}
                            onChange={(e) =>
                              handleStorageChange(
                                index,
                                "sealed",
                                e.target.checked
                              )
                            }
                          />
                          S
                        </label>
                      </div>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="sv-button sv-button-xs sv-button-danger"
                        onClick={() => removeSeedLot(index)}
                        disabled={seedLots.length === 1}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
                {seedLots.length === 0 && (
                  <tr>
                    <td colSpan={7} className="sv-empty-row">
                      No seed lots yet. Add at least one lot to run the
                      calculator.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="sv-divider" />

          <div className="sv-subgrid">
            <div>
              <h4 className="sv-section-title">Environment</h4>
              <div className="sv-field">
                <label>Location Label</label>
                <input
                  type="text"
                  className="sv-input"
                  value={environment.locationLabel}
                  onChange={(e) =>
                    setEnvironment((prev) => ({
                      ...prev,
                      locationLabel: e.target.value,
                    }))
                  }
                  placeholder="e.g. Backyard beds"
                />
              </div>
              <div className="sv-field">
                <label>Expected Soil Temp at Planting (°C)</label>
                <input
                  type="number"
                  className="sv-input"
                  value={environment.expectedSoilTempStartC ?? ""}
                  onChange={(e) =>
                    setEnvironment((prev) => ({
                      ...prev,
                      expectedSoilTempStartC:
                        e.target.value === "" ? null : Number(e.target.value),
                    }))
                  }
                />
              </div>
              <div className="sv-field">
                <label>Region Climate</label>
                <input
                  type="text"
                  className="sv-input"
                  value={environment.regionClimate}
                  onChange={(e) =>
                    setEnvironment((prev) => ({
                      ...prev,
                      regionClimate: e.target.value,
                    }))
                  }
                  placeholder="e.g. humid-subtropical"
                />
              </div>
              <div className="sv-field">
                <label>Frost Risk</label>
                <select
                  className="sv-select"
                  value={environment.frostRisk}
                  onChange={(e) =>
                    setEnvironment((prev) => ({
                      ...prev,
                      frostRisk: e.target.value,
                    }))
                  }
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </div>
            </div>

            <div>
              <h4 className="sv-section-title">Planning Hints</h4>
              <div className="sv-field">
                <label>Staple Priority Factor</label>
                <input
                  type="number"
                  step="0.1"
                  className="sv-input"
                  value={
                    planningHints.storehouseGoalProfile.staplePriorityFactor ??
                    ""
                  }
                  onChange={(e) =>
                    setPlanningHints((prev) => ({
                      ...prev,
                      storehouseGoalProfile: {
                        ...prev.storehouseGoalProfile,
                        staplePriorityFactor:
                          e.target.value === "" ? null : Number(e.target.value),
                      },
                    }))
                  }
                />
              </div>
              <div className="sv-field">
                <label>Min Viability for Staples</label>
                <input
                  type="number"
                  className="sv-input"
                  min={0}
                  max={100}
                  value={
                    planningHints.storehouseGoalProfile
                      .minimumViabilityForStaples ?? ""
                  }
                  onChange={(e) =>
                    setPlanningHints((prev) => ({
                      ...prev,
                      storehouseGoalProfile: {
                        ...prev.storehouseGoalProfile,
                        minimumViabilityForStaples:
                          e.target.value === "" ? null : Number(e.target.value),
                      },
                    }))
                  }
                />
              </div>
              <div className="sv-field sv-field-inline">
                <label>Allow High-Risk Lots</label>
                <input
                  type="checkbox"
                  checked={!!planningHints.allowHighRiskLots}
                  onChange={(e) =>
                    setPlanningHints((prev) => ({
                      ...prev,
                      allowHighRiskLots: e.target.checked,
                    }))
                  }
                />
              </div>
              <p className="sv-hint">
                These hints help the calculator treat staple crops more strictly
                and decide when to recommend replacement.
              </p>
            </div>
          </div>
        </section>

        {/* RIGHT: Results */}
        <section className="sv-card sv-card-right">
          <div className="sv-card-header">
            <h3>Results & Recommendations</h3>
          </div>

          {error && (
            <div className="sv-alert sv-alert-error">
              <strong>Error:</strong> {error}
            </div>
          )}

          {!result && !error && (
            <p className="sv-placeholder">
              Run the viability check to see germination estimates, sowing
              multipliers, and replacement timing.
            </p>
          )}

          {result && (
            <>
              <div className="sv-meta-summary">
                <span>
                  Lots evaluated: <strong>{result.meta?.lotCount}</strong>
                </span>
                <span>
                  High-risk lots:{" "}
                  <strong>{result.meta?.highRiskLotCount}</strong>
                </span>
                <span>
                  Replace-now lots:{" "}
                  <strong>{result.meta?.replaceNowCount}</strong>
                </span>
              </div>
              <div className="sv-results-table-wrapper">
                <table className="sv-table">
                  <thead>
                    <tr>
                      <th>Lot</th>
                      <th>Crop</th>
                      <th>Viability</th>
                      <th>Est. Germ%</th>
                      <th>Sow ×</th>
                      <th>Status</th>
                      <th>Flags</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {result.lots.map((lot) => (
                      <tr key={lot.id}>
                        <td>{lot.id}</td>
                        <td>
                          {lot.crop}
                          {lot.variety ? ` – ${lot.variety}` : ""}
                        </td>
                        <td>{Math.round(lot.viabilityScore)} / 100</td>
                        <td>{Math.round(lot.estimatedGerminationRate)}%</td>
                        <td>{lot.sowRateMultiplier.toFixed(2)}</td>
                        <td
                          className={`sv-status sv-status-${lot.recommendedStatus}`}
                        >
                          {statusLabel(lot.recommendedStatus)}
                        </td>
                        <td>
                          {Array.isArray(lot.riskFlags) &&
                          lot.riskFlags.length > 0
                            ? lot.riskFlags.join(", ")
                            : "—"}
                        </td>
                        <td>
                          <button
                            type="button"
                            className="sv-button sv-button-xs sv-button-outline"
                            onClick={() => setDetailsLot(lot)}
                          >
                            Details
                          </button>
                        </td>
                      </tr>
                    ))}
                    {result.lots.length === 0 && (
                      <tr>
                        <td colSpan={8} className="sv-empty-row">
                          No lots returned from shim.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      </main>

      {detailsLot && (
        <SeedLotDetailsModal
          lot={detailsLot}
          onClose={() => setDetailsLot(null)}
        />
      )}
    </div>
  );
}

/**
 * Compact mapping of status → label.
 */
function statusLabel(status) {
  switch (status) {
    case "ok":
      return "OK";
    case "watch":
      return "Watch";
    case "replace-soon":
      return "Replace Soon";
    case "replace-now":
      return "Replace Now";
    default:
      return status || "Unknown";
  }
}

/**
 * Simple details modal to inspect a single lot's notes & next actions.
 * This is a local UI modal, separate from the global SessionRunner modal.
 */
function SeedLotDetailsModal({ lot, onClose }) {
  return (
    <div className="sv-modal-backdrop" role="dialog" aria-modal="true">
      <div className="sv-modal">
        <header className="sv-modal-header">
          <h3>
            Seed Lot Details: {lot.id} {lot.crop ? `– ${lot.crop}` : ""}
          </h3>
          <button
            type="button"
            className="sv-modal-close"
            onClick={onClose}
            aria-label="Close details"
          >
            ×
          </button>
        </header>
        <div className="sv-modal-body">
          <div className="sv-modal-grid">
            <div>
              <h4>Summary</h4>
              <p>
                <strong>Viability Score:</strong>{" "}
                {Math.round(lot.viabilityScore)} / 100
              </p>
              <p>
                <strong>Estimated Germination:</strong>{" "}
                {Math.round(lot.estimatedGerminationRate)}%
              </p>
              <p>
                <strong>Sow Rate Multiplier:</strong>{" "}
                {lot.sowRateMultiplier.toFixed(2)}
              </p>
              <p>
                <strong>Status:</strong> {statusLabel(lot.recommendedStatus)}
              </p>
              <p>
                <strong>Risk Flags:</strong>{" "}
                {Array.isArray(lot.riskFlags) && lot.riskFlags.length
                  ? lot.riskFlags.join(", ")
                  : "None"}
              </p>
            </div>
            <div>
              <h4>Notes</h4>
              {Array.isArray(lot.notes) && lot.notes.length > 0 ? (
                <ul className="sv-list">
                  {lot.notes.map((note, idx) => (
                    <li key={idx}>{note}</li>
                  ))}
                </ul>
              ) : (
                <p>No notes generated.</p>
              )}

              <h4 className="sv-modal-subtitle">Next Actions</h4>
              {Array.isArray(lot.nextActions) && lot.nextActions.length > 0 ? (
                <ul className="sv-list">
                  {lot.nextActions.map((action, idx) => (
                    <li key={idx}>{action}</li>
                  ))}
                </ul>
              ) : (
                <p>No specific next actions suggested.</p>
              )}
            </div>
          </div>
        </div>
        <footer className="sv-modal-footer">
          <button
            type="button"
            className="sv-button sv-button-primary"
            onClick={onClose}
          >
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}
