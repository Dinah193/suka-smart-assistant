// C:\Users\larho\suka-smart-assistant\src\features\calculators\storehouseMeals\StorehouseRefillCalculator\StorehouseRefillCalculator.view.jsx

/**
 * StorehouseRefillCalculator.view.jsx
 *
 * HOW THIS FITS
 * -------------
 * This React view wires the Storehouse Refill shim into the SSA UI layer.
 *
 * Responsibilities:
 * - Let the user review/configure high-level refill options
 *   (planning horizon days, hair-nutrition emphasis, etc.).
 * - Call the shim (`runStorehouseRefillCalculation`) to compute suggestions.
 * - Render refill lines, priority store baskets, and timeline hints.
 * - Expose “Next step” actions so other modules can:
 *   - Create shopping sessions / lists
 *   - Feed into freezer / batch planning
 *   - Write back to inventory
 *
 * It is intentionally:
 * - Stateless with regard to long-term persistence (Dexie, Planning Graph, etc.).
 * - Friendly for use inside modals, sidebars, or full pages.
 * - Compatible with background execution: the heavy work lives in the shim,
 *   which can also be called from a worker; this view only displays results
 *   passed back to it.
 */

import React, { useState, useEffect } from "react";
import PropTypes from "prop-types";
import { runStorehouseRefillCalculation } from "./StorehouseRefillCalculator.shim";

/**
 * @typedef {import("./StorehouseRefillCalculator.schema.json").definitions.StorehouseRefillInput} StorehouseRefillInput
 * @typedef {import("./StorehouseRefillCalculator.schema.json").definitions.StorehouseRefillOutput} StorehouseRefillOutput
 */

/**
 * @param {{
 *   initialInput?: StorehouseRefillInput | null;
 *   autoRunOnMount?: boolean;
 *   onPlanComputed?: (output: StorehouseRefillOutput) => void;
 *   onCreateShoppingSession?: (output: StorehouseRefillOutput) => void;
 *   onBackToPlanningGraph?: () => void;
 * }} props
 */
function StorehouseRefillCalculatorView({
  initialInput = null,
  autoRunOnMount = false,
  onPlanComputed,
  onCreateShoppingSession,
  onBackToPlanningGraph
}) {
  const [inputState, setInputState] = useState(() => {
    const base = initialInput || {
      householdId: "",
      planningHorizonDays: 14,
      familyPreferences: {
        prioritizeHairNutritionItems: true
      },
      storehouseSnapshot: [],
      minimumParLevels: {},
      safetyStockRules: [],
      priceBookSnapshot: []
    };

    // Ensure familyPreferences exists
    return {
      ...base,
      familyPreferences: {
        prioritizeHairNutritionItems:
          base.familyPreferences?.prioritizeHairNutritionItems ?? true
      }
    };
  });

  const [result, setResult] = useState(null /** @type {StorehouseRefillOutput | null} */);
  const [activeTab, setActiveTab] = useState("lines"); // "lines" | "baskets" | "timeline"
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState("");

  // Optional auto-run behavior when mounted (e.g., from Planning Graph edge)
  useEffect(() => {
    if (autoRunOnMount && inputState.storehouseSnapshot?.length) {
      handleRunCalculation();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRunOnMount]);

  /**
   * Defensive helper to parse integer fields from inputs.
   * @param {React.ChangeEvent<HTMLInputElement>} e
   */
  function handlePlanningHorizonChange(e) {
    const value = e.target.value;
    const parsed = Number.parseInt(value, 10);
    setInputState((prev) => ({
      ...prev,
      planningHorizonDays: Number.isFinite(parsed) && parsed > 0 ? parsed : prev.planningHorizonDays
    }));
  }

  function handleHairPrefToggle() {
    setInputState((prev) => ({
      ...prev,
      familyPreferences: {
        ...prev.familyPreferences,
        prioritizeHairNutritionItems: !prev.familyPreferences?.prioritizeHairNutritionItems
      }
    }));
  }

  async function handleRunCalculation() {
    if (!inputState || !Array.isArray(inputState.storehouseSnapshot)) {
      setError("Storehouse snapshot is missing or invalid. Please sync inventory first.");
      return;
    }

    setIsRunning(true);
    setError("");
    try {
      const output = await runStorehouseRefillCalculation(inputState);
      setResult(output);
      if (typeof onPlanComputed === "function") {
        onPlanComputed(output);
      }
    } catch (err) {
      console.error("[StorehouseRefillCalculator] run error:", err);
      setError("Unable to compute refill suggestions. Please try again.");
    } finally {
      setIsRunning(false);
    }
  }

  function handleCreateShoppingSession() {
    if (!result || typeof onCreateShoppingSession !== "function") return;
    onCreateShoppingSession(result);
  }

  const totalLines = result?.aggregatedRefillSummary?.totalLines ?? 0;
  const totalCost =
    result?.aggregatedRefillSummary?.totalEstimatedCost != null
      ? result.aggregatedRefillSummary.totalEstimatedCost.toFixed(2)
      : null;
  const highUrgencyCount = result?.aggregatedRefillSummary?.highUrgencyCount ?? 0;

  return (
    <div className="ssa-card ssa-refill-calculator">
      <div className="ssa-card-header ssa-refill-header">
        <div>
          <h2 className="ssa-title">Storehouse Refill Planner</h2>
          <p className="ssa-subtitle">
            See what needs restocking, group items by store, and keep your staple foods,
            cleaning supplies, and Black hair nutrition items covered.
          </p>
        </div>
        {onBackToPlanningGraph && (
          <button
            type="button"
            className="ssa-btn ssa-btn-ghost"
            onClick={onBackToPlanningGraph}
          >
            ← Back to Planning Graph
          </button>
        )}
      </div>

      {/* Top controls */}
      <div className="ssa-refill-controls">
        <div className="ssa-refill-control-group">
          <label className="ssa-label">
            Planning horizon (days)
            <input
              type="number"
              min={1}
              className="ssa-input"
              defaultValue={inputState.planningHorizonDays}
              onBlur={handlePlanningHorizonChange}
            />
          </label>
          <label className="ssa-checkbox">
            <input
              type="checkbox"
              checked={!!inputState.familyPreferences?.prioritizeHairNutritionItems}
              onChange={handleHairPrefToggle}
            />
            <span>Highlight Black hair + scalp nutrition items</span>
          </label>
        </div>

        <div className="ssa-refill-actions">
          <button
            type="button"
            className="ssa-btn ssa-btn-primary"
            onClick={handleRunCalculation}
            disabled={isRunning}
          >
            {isRunning ? "Calculating…" : "Run refill plan"}
          </button>

          <button
            type="button"
            className="ssa-btn ssa-btn-secondary"
            disabled={!result || totalLines === 0}
            onClick={handleCreateShoppingSession}
          >
            Create shopping session
          </button>
        </div>
      </div>

      {/* Summary bar */}
      <div className="ssa-refill-summary">
        <div className="ssa-refill-summary-item">
          <span className="ssa-refill-summary-label">Items to refill</span>
          <span className="ssa-refill-summary-value">{totalLines}</span>
        </div>
        <div className="ssa-refill-summary-item">
          <span className="ssa-refill-summary-label">High / critical urgency</span>
          <span className="ssa-refill-summary-value">{highUrgencyCount}</span>
        </div>
        <div className="ssa-refill-summary-item">
          <span className="ssa-refill-summary-label">Est. cost</span>
          <span className="ssa-refill-summary-value">
            {totalCost != null ? `$${totalCost}` : "—"}
          </span>
        </div>
      </div>

      {/* Error state */}
      {error && <div className="ssa-error-banner">{error}</div>}

      {/* Empty state */}
      {!result && !error && (
        <div className="ssa-empty-state">
          <p>
            Run the planner to see refill suggestions based on your current storehouse and
            family preferences.
          </p>
        </div>
      )}

      {/* Tabs + content when results exist */}
      {result && (
        <>
          <div className="ssa-tabs">
            <button
              type="button"
              className={`ssa-tab ${activeTab === "lines" ? "ssa-tab-active" : ""}`}
              onClick={() => setActiveTab("lines")}
            >
              Refill lines
            </button>
            <button
              type="button"
              className={`ssa-tab ${activeTab === "baskets" ? "ssa-tab-active" : ""}`}
              onClick={() => setActiveTab("baskets")}
            >
              Store baskets
            </button>
            <button
              type="button"
              className={`ssa-tab ${activeTab === "timeline" ? "ssa-tab-active" : ""}`}
              onClick={() => setActiveTab("timeline")}
            >
              Timeline hints
            </button>
          </div>

          <div className="ssa-tab-content">
            {activeTab === "lines" && (
              <RefillLinesTable
                lines={result.refillLines}
                highlightHairNutrition={
                  !!inputState.familyPreferences?.prioritizeHairNutritionItems
                }
              />
            )}

            {activeTab === "baskets" && (
              <BasketsList priorityBaskets={result.priorityBaskets} />
            )}

            {activeTab === "timeline" && (
              <TimelineHintsList timelineHints={result.timelineHints} />
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Render a table of refill lines.
 *
 * @param {{
 *   lines: StorehouseRefillOutput["refillLines"];
 *   highlightHairNutrition: boolean;
 * }} props
 */
function RefillLinesTable({ lines, highlightHairNutrition }) {
  if (!Array.isArray(lines) || lines.length === 0) {
    return (
      <div className="ssa-empty-state">
        <p>No items require refill based on the current configuration.</p>
      </div>
    );
  }

  return (
    <div className="ssa-table-wrapper">
      <table className="ssa-table">
        <thead>
          <tr>
            <th>Item</th>
            <th>Category</th>
            <th>Location</th>
            <th>Current</th>
            <th>Target</th>
            <th>Refill</th>
            <th>Urgency</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => {
            const isHairNote =
              highlightHairNutrition &&
              typeof line.notes === "string" &&
              /hair \+ scalp health|Black hair/i.test(line.notes);

            return (
              <tr
                key={line.itemId}
                className={`ssa-row-urgency-${line.urgency} ${
                  isHairNote ? "ssa-row-hair-nutrition" : ""
                }`}
              >
                <td>{line.label}</td>
                <td>{line.category || "—"}</td>
                <td>{line.location || "—"}</td>
                <td>
                  {line.currentQty} {line.uom}
                </td>
                <td>{line.targetQty}</td>
                <td>{line.refillQty}</td>
                <td className="ssa-urgency-cell">{line.urgency}</td>
                <td>
                  {line.notes ? (
                    <span>
                      {line.notes}
                      {isHairNote && (
                        <span className="ssa-chip ssa-chip-hair">hair nutrition</span>
                      )}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {highlightHairNutrition && (
        <p className="ssa-footnote">
          Items marked with <span className="ssa-chip ssa-chip-hair">hair nutrition</span>{" "}
          can support Black hair + scalp health when part of a balanced diet and lifestyle.
        </p>
      )}
    </div>
  );
}

/**
 * Render a list of store baskets grouped by store.
 *
 * @param {{
 *   priorityBaskets: StorehouseRefillOutput["priorityBaskets"];
 * }} props
 */
function BasketsList({ priorityBaskets }) {
  if (!Array.isArray(priorityBaskets) || priorityBaskets.length === 0) {
    return (
      <div className="ssa-empty-state">
        <p>No store-specific baskets were created. Add pricebook entries to see grouped runs.</p>
      </div>
    );
  }

  return (
    <div className="ssa-basket-list">
      {priorityBaskets.map((basket) => (
        <div
          key={basket.basketId}
          className={`ssa-basket-card ssa-basket-priority-${basket.priority}`}
        >
          <div className="ssa-basket-header">
            <h3>{basket.label}</h3>
            <span className="ssa-chip ssa-chip-priority">{basket.priority} priority</span>
          </div>
          <p className="ssa-basket-cost">
            Est. cost:{" "}
            {typeof basket.estimatedCost === "number"
              ? `$${basket.estimatedCost.toFixed(2)}`
              : "—"}
          </p>
          <p className="ssa-basket-lines-count">
            Lines: {Array.isArray(basket.lines) ? basket.lines.length : 0}
          </p>
        </div>
      ))}
    </div>
  );
}

/**
 * Render a list of timeline hints (when to buy what).
 *
 * @param {{
 *   timelineHints: StorehouseRefillOutput["timelineHints"];
 * }} props
 */
function TimelineHintsList({ timelineHints }) {
  if (!Array.isArray(timelineHints) || timelineHints.length === 0) {
    return (
      <div className="ssa-empty-state">
        <p>No time-sensitive risks detected based on current data.</p>
      </div>
    );
  }

  return (
    <div className="ssa-timeline-list">
      {timelineHints.map((hint) => {
        const dateLabel = hint.shouldBuyBy
          ? new Date(hint.shouldBuyBy).toLocaleDateString()
          : "as soon as possible";
        return (
          <div key={hint.itemId} className="ssa-timeline-card">
            <h3>{hint.label}</h3>
            <p>
              Buy by <strong>{dateLabel}</strong>
            </p>
            <p className="ssa-timeline-risk">{hint.riskIfDelayed}</p>
          </div>
        );
      })}
    </div>
  );
}

StorehouseRefillCalculatorView.propTypes = {
  initialInput: PropTypes.object,
  autoRunOnMount: PropTypes.bool,
  onPlanComputed: PropTypes.func,
  onCreateShoppingSession: PropTypes.func,
  onBackToPlanningGraph: PropTypes.func
};

RefillLinesTable.propTypes = {
  lines: PropTypes.array.isRequired,
  highlightHairNutrition: PropTypes.bool.isRequired
};

BasketsList.propTypes = {
  priorityBaskets: PropTypes.array.isRequired
};

TimelineHintsList.propTypes = {
  timelineHints: PropTypes.array.isRequired
};

export default StorehouseRefillCalculatorView;
