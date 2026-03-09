// File: src/features/calculators/gardenAnimal/AnimalFeedCalculator/AnimalFeedCalculator.view.jsx
/**
 * AnimalFeedCalculator.view.jsx
 * ---------------------------------------------------------------------------
 * UI for planning feed usage and purchases.
 *
 * How this fits into SSA:
 * - Sits on route: /tier2/animals/calculators/feed (see config node).
 * - Lets the user:
 *   • Pick a planning horizon and context.
 *   • Run the AnimalFeedCalculator shim to compute rations + projections.
 *   • Review daily feed usage and projected shortages.
 *   • Trigger a “Feed Session Now” via SessionRunner (through hooks).
 *
 * - The actual time-based execution is handled by SessionRunner:
 *   • This view calls useAnimalFeedSessionLaunchers().launchFeedSessionNow(result)
 *     which should:
 *       - build a Session object (domain: "animals")
 *       - persist to Dexie
 *       - emit session.requested
 *       - optionally export to Hub (if familyFundMode)
 *   • The global SessionRunner (mounted at App root) then opens its modal,
 *     keeps timers alive across navigation, and handles wake-lock/notifications.
 */

import React, { useState } from "react";

// Shim: logic computing feed requirements over time
import { runAnimalFeedCalculatorShim } from "./AnimalFeedCalculator.shim";

// Hooks: launch Now sessions for SessionRunner (you’ll wire this in hooks file)
import { useAnimalFeedSessionLaunchers } from "./AnimalFeedCalculator.hooks";

/**
 * @typedef {import("./AnimalFeedCalculator.shim").AnimalFeedShimRequest} AnimalFeedShimRequest
 * @typedef {import("./AnimalFeedCalculator.shim").AnimalFeedShimResponse} AnimalFeedShimResponse
 */

/**
 * @param {{
 *   animals?: any[];
 *   feedInventory?: any[];
 *   initialContext?: {
 *     planningHorizonDays?: number;
 *     unitSystem?: "metric"|"imperial";
 *     farmLocation?: string;
 *     notes?: string;
 *   };
 * }} props
 */
function AnimalFeedCalculatorView(props) {
  const [planningHorizonDays, setPlanningHorizonDays] = useState(
    props.initialContext?.planningHorizonDays || 7
  );
  const [unitSystem, setUnitSystem] = useState(
    props.initialContext?.unitSystem || "metric"
  );
  const [farmLocation, setFarmLocation] = useState(
    props.initialContext?.farmLocation || ""
  );
  const [notes, setNotes] = useState(props.initialContext?.notes || "");
  const [exportToHub, setExportToHub] = useState(false);

  const [result, setResult] = useState(null);
  const [warnings, setWarnings] = useState([]);
  const [error, setError] = useState(null);
  const [isCalculating, setIsCalculating] = useState(false);
  const [showDetailsModal, setShowDetailsModal] = useState(false);

  const hasAnimals = Array.isArray(props.animals) && props.animals.length > 0;

  const { launchFeedSessionNow } = useAnimalFeedSessionLaunchers({
    feedPlanResult: result,
  });

  async function handleRunCalculation() {
    setIsCalculating(true);
    setError(null);
    setWarnings([]);

    /** @type {AnimalFeedShimRequest} */
    const req = {
      nodeKey: "animals.feedCalculator",
      animals: props.animals || [],
      feedInventory: props.feedInventory || [],
      context: {
        planningHorizonDays,
        unitSystem,
        farmLocation,
        notes,
      },
      exportToHub,
    };

    try {
      /** @type {AnimalFeedShimResponse} */
      // eslint-disable-next-line no-unused-vars
      const res = await runAnimalFeedCalculatorShim(req);

      if (!res?.ok || !res?.result) {
        setError(res?.error || "Unable to compute feed plan.");
        setWarnings(res?.warnings || []);
        setResult(null);
      } else {
        setResult(res.result);
        setWarnings(res.warnings || []);
      }
    } catch (e) {
      // Defensive: never blow up the page
      // eslint-disable-next-line no-console
      console.error("AnimalFeedCalculatorView error:", e);
      setError("An unexpected error occurred while computing the feed plan.");
      setResult(null);
    } finally {
      setIsCalculating(false);
    }
  }

  function handleLaunchNow() {
    if (!result) return;
    launchFeedSessionNow?.(result);
  }

  const analytics = result?.analytics || {};
  const demandProjection = result?.feedDemandProjection || [];
  const dailyFeedPlan = result?.dailyFeedPlan || [];

  const hasShortages = demandProjection.some(
    (d) => (d?.projectedShortageKg || 0) > 0
  );

  return (
    <div className="afc-root">
      {/* Header */}
      <div className="afc-header">
        <div>
          <h1 className="afc-title">Animal Feed Planner</h1>
          <p className="afc-subtitle">
            Plan daily rations, project feed usage, and spot shortages early so
            you can buy or mix feed before you run out.
          </p>
        </div>

        <div className="afc-header-actions">
          <button
            type="button"
            className="afc-btn afc-btn-primary"
            onClick={handleRunCalculation}
            disabled={isCalculating || !hasAnimals}
          >
            {isCalculating ? "Calculating…" : "Run Feed Plan"}
          </button>

          <button
            type="button"
            className="afc-btn afc-btn-ghost"
            onClick={handleLaunchNow}
            disabled={!result}
            title={
              result
                ? "Open a guided Feed Session in SessionRunner."
                : "Run the feed plan first."
            }
          >
            Feed Session Now
          </button>
        </div>
      </div>

      {/* Context / Inputs Panel */}
      <div className="afc-panel afc-panel-context">
        <h2 className="afc-panel-title">Planning Context</h2>

        {!hasAnimals && (
          <div className="afc-alert afc-alert-warning">
            <strong>No animals found.</strong> Connect this calculator to your
            Animals Registry or pass an animals list as props. Until then, the
            planner can’t compute rations.
          </div>
        )}

        <div className="afc-grid afc-grid-3">
          <label className="afc-field">
            <span className="afc-field-label">Planning Horizon (days)</span>
            <input
              type="number"
              min={1}
              className="afc-input"
              value={planningHorizonDays}
              onChange={(e) =>
                setPlanningHorizonDays(Math.max(1, Number(e.target.value) || 1))
              }
            />
            <span className="afc-field-help">
              How far ahead to project usage and shortages.
            </span>
          </label>

          <label className="afc-field">
            <span className="afc-field-label">Units</span>
            <select
              className="afc-input"
              value={unitSystem}
              onChange={(e) => setUnitSystem(e.target.value)}
            >
              <option value="metric">Metric (kg)</option>
              <option value="imperial">Imperial (lb, converted)</option>
            </select>
            <span className="afc-field-help">
              Metric is used internally; imperial can be displayed later.
            </span>
          </label>

          <label className="afc-field">
            <span className="afc-field-label">Farm / Location</span>
            <input
              type="text"
              className="afc-input"
              value={farmLocation}
              onChange={(e) => setFarmLocation(e.target.value)}
              placeholder="e.g., Upper Pasture, South Barn"
            />
            <span className="afc-field-help">
              Optional label for multi-site analytics.
            </span>
          </label>
        </div>

        <div className="afc-grid afc-grid-2 afc-grid-gap-lg">
          <label className="afc-field">
            <span className="afc-field-label">Notes</span>
            <textarea
              className="afc-input afc-input-textarea"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Late gestation, heavy mud, drought, etc."
            />
          </label>

          <div className="afc-field afc-field-checkbox">
            <label className="afc-checkbox-label">
              <input
                type="checkbox"
                checked={exportToHub}
                onChange={(e) => setExportToHub(e.target.checked)}
              />
              <span>Export summary to Family Fund Hub (if enabled)</span>
            </label>

            <span className="afc-field-help">
              When familyFundMode is on, a compact analytics summary will be
              exported after each successful run.
            </span>
          </div>
        </div>
      </div>

      {/* Status / Alerts */}
      {(error || warnings.length > 0) && (
        <div className="afc-panel afc-panel-status">
          {error && (
            <div className="afc-alert afc-alert-error">
              <strong>Error:</strong> {error}
            </div>
          )}

          {warnings.length > 0 && (
            <div className="afc-alert afc-alert-info">
              <strong>Warnings:</strong>
              <ul className="afc-list">
                {warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Summary Metrics */}
      {result && (
        <div className="afc-panel afc-panel-summary">
          <div className="afc-panel-header">
            <h2 className="afc-panel-title">Feed Plan Summary</h2>
            <button
              type="button"
              className="afc-btn afc-btn-outline"
              onClick={() => setShowDetailsModal(true)}
            >
              View Detailed Rations
            </button>
          </div>

          <div className="afc-grid afc-grid-4">
            <div className="afc-kpi-card">
              <span className="afc-kpi-label">Total As-Fed / Day</span>
              <span className="afc-kpi-value">
                {analytics.totalAsFedKgPerDay != null
                  ? `${Number(analytics.totalAsFedKgPerDay).toFixed(1)} kg`
                  : "–"}
              </span>
              <span className="afc-kpi-hint">All animals combined.</span>
            </div>

            <div className="afc-kpi-card">
              <span className="afc-kpi-label">Total Dry Matter / Day</span>
              <span className="afc-kpi-value">
                {analytics.totalDryMatterKgPerDay != null
                  ? `${Number(analytics.totalDryMatterKgPerDay).toFixed(1)} kg`
                  : "–"}
              </span>
              <span className="afc-kpi-hint">
                Used for ration quality checks.
              </span>
            </div>

            <div className="afc-kpi-card">
              <span className="afc-kpi-label">Estimated Cost / Day</span>
              <span className="afc-kpi-value">
                {analytics.estimatedFeedCostPerDay != null
                  ? `$${Number(analytics.estimatedFeedCostPerDay).toFixed(2)}`
                  : "–"}
              </span>
              <span className="afc-kpi-hint">
                Based on inventory cost data.
              </span>
            </div>

            <div className="afc-kpi-card">
              <span className="afc-kpi-label">Earliest Projected Shortage</span>
              <span
                className={
                  "afc-kpi-value " +
                  (hasShortages ? "afc-kpi-value-danger" : "afc-kpi-value-ok")
                }
              >
                {analytics.projectedShortageDays != null
                  ? `${analytics.projectedShortageDays} days`
                  : hasShortages
                  ? "Within horizon"
                  : "None"}
              </span>
              <span className="afc-kpi-hint">
                First day any feed might run out at current usage.
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Purchases / Shortage Table */}
      {result && demandProjection.length > 0 && (
        <div className="afc-panel afc-panel-table">
          <h2 className="afc-panel-title">Projected Feed Usage & Shortages</h2>
          <p className="afc-panel-text">
            Use this table to decide what to buy before your planning horizon
            ends. Red rows mean your animals will out-eat your current
            inventory.
          </p>

          <div className="afc-table-wrapper">
            <table className="afc-table">
              <thead>
                <tr>
                  <th>Feed Item</th>
                  <th>Current Inventory (kg)</th>
                  <th>Projected Usage (kg)</th>
                  <th>Shortage (kg)</th>
                  <th>Estimated Runout</th>
                </tr>
              </thead>
              <tbody>
                {demandProjection.map((row) => {
                  const shortage = row?.projectedShortageKg || 0;
                  const danger = shortage > 0;

                  return (
                    <tr
                      key={row.feedItemId || row.name}
                      className={danger ? "afc-row-danger" : ""}
                    >
                      <td>{row.name}</td>
                      <td>{Number(row.currentInventoryKg || 0).toFixed(1)}</td>
                      <td>{Number(row.projectedUsageKg || 0).toFixed(1)}</td>
                      <td>{shortage > 0 ? shortage.toFixed(1) : "—"}</td>
                      <td>{row.estimatedRunoutDate || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {hasShortages && (
            <div className="afc-alert afc-alert-warning afc-mt-md">
              <strong>Shortages detected.</strong> Consider planning a
              storehouse refill session, updating your feed mix, or reducing
              stocking density before you reach these dates.
            </div>
          )}
        </div>
      )}

      {/* Modal: Detailed per-animal rations (local UI only; SessionRunner lives at app root) */}
      {showDetailsModal && result && (
        <div
          className="afc-modal-backdrop"
          onClick={() => setShowDetailsModal(false)}
        >
          <div
            className="afc-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="afc-modal-title"
          >
            <div className="afc-modal-header">
              <h2 id="afc-modal-title" className="afc-modal-title">
                Detailed Rations (Daily)
              </h2>

              <button
                type="button"
                className="afc-modal-close"
                onClick={() => setShowDetailsModal(false)}
                aria-label="Close"
              >
                ×
              </button>
            </div>

            <div className="afc-modal-body">
              {dailyFeedPlan.length === 0 && (
                <p>No rations generated yet for the current run.</p>
              )}

              {dailyFeedPlan.map((plan) => {
                const subject = (result.animals || []).find(
                  (a) => a.id === plan.subjectId
                );

                return (
                  <div key={plan.rationId} className="afc-ration-card">
                    <div className="afc-ration-header">
                      <div>
                        <h3 className="afc-ration-title">
                          {subject?.displayName || subject?.id || "Animal"}
                        </h3>
                        <p className="afc-ration-subtitle">
                          {subject?.species} &middot; {subject?.class} &middot;{" "}
                          {subject?.count || 1} head
                        </p>
                      </div>

                      <div className="afc-ration-totals">
                        <span className="afc-pill">
                          As-Fed:{" "}
                          {plan?.totals?.asFedKgPerHeadPerDay != null
                            ? `${Number(
                                plan.totals.asFedKgPerHeadPerDay
                              ).toFixed(2)} kg / head`
                            : "—"}
                        </span>
                        <span className="afc-pill">
                          Dry Matter:{" "}
                          {plan?.totals?.dryMatterKgPerHeadPerDay != null
                            ? `${Number(
                                plan.totals.dryMatterKgPerHeadPerDay
                              ).toFixed(2)} kg / head`
                            : "—"}
                        </span>
                      </div>
                    </div>

                    <div className="afc-table-wrapper afc-table-compact">
                      <table className="afc-table">
                        <thead>
                          <tr>
                            <th>Feed</th>
                            <th>Category</th>
                            <th>As-Fed (kg/head)</th>
                            <th>Dry Matter (kg/head)</th>
                            <th>Notes</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(plan.feedItems || []).map((item) => (
                            <tr key={item.feedItemId || item.name}>
                              <td>{item.name}</td>
                              <td>{item.category || "—"}</td>
                              <td>
                                {item.asFedKgPerHeadPerDay != null
                                  ? Number(item.asFedKgPerHeadPerDay).toFixed(2)
                                  : "—"}
                              </td>
                              <td>
                                {item.dryMatterKgPerHeadPerDay != null
                                  ? Number(
                                      item.dryMatterKgPerHeadPerDay
                                    ).toFixed(2)
                                  : "—"}
                              </td>
                              <td>{item.notes || "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {plan.instructions && (
                      <p className="afc-ration-instructions">
                        <strong>Instructions:</strong> {plan.instructions}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="afc-modal-footer">
              <button
                type="button"
                className="afc-btn afc-btn-primary"
                onClick={handleLaunchNow}
                disabled={!result}
              >
                Feed Session Now
              </button>

              <button
                type="button"
                className="afc-btn afc-btn-ghost"
                onClick={() => setShowDetailsModal(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ✅ Ensure this module *definitely* has a default export (and a named export too).
export { AnimalFeedCalculatorView };
export default AnimalFeedCalculatorView;
