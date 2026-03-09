// C:\Users\larho\suka-smart-assistant\src\features\calculators\storehouseMeals\BatchYieldCalculator\BatchYieldCalculator.view.jsx
/**
 * BatchYieldCalculator.view
 *
 * HOW THIS FITS:
 * - UI wrapper for the Batch Yield Calculator shim.
 * - Lets the user:
 *   - Enter base recipe yield (servings + serving size).
 *   - Choose a scaling strategy (scale factor, target servings, or containers).
 *   - Set basic portioning preferences (ready-to-eat vs preserved).
 *   - Pick container types for preserved servings.
 * - On submit:
 *   - Calls the BatchYieldCalculator shim (via hooks/runtime).
 *   - Emits calculator events via eventBus.
 *   - Exposes “Use in Session” / “Update Storehouse” style actions for SSA.
 *
 * NOTE:
 * - No timers or long-running behavior are handled here; this is a quick
 *   calculator view. Longer-running batch cooking/preservation sessions
 *   should be handled by the SessionBuilder + SessionRunner pipeline.
 */

import React, { useState } from "react";
import { emit } from "@/services/events/eventBus";
import { useBatchYieldCalculator } from "./BatchYieldCalculator.hooks";

const SCALING_MODES = [
  { value: "scaleFactor", label: "Scale by factor" },
  { value: "servings", label: "Target total servings" },
  { value: "containers", label: "Fill specific containers" },
];

const ROUNDING_MODES = [
  { value: "floor", label: "Round down" },
  { value: "nearest", label: "Round to nearest" },
  { value: "ceil", label: "Round up" },
];

const DEFAULT_CONTAINER_CATALOG = [
  {
    containerTypeId: "qt-jar",
    label: "1 qt canning jar",
    approxVolumeMl: 946,
    approxFoodWeightGrams: 900,
    maxFillFraction: 0.9,
    preferredPreservationMethod: "pressure-canning",
    storageLocation: "root-cellar",
  },
  {
    containerTypeId: "pt-jar",
    label: "1 pt canning jar",
    approxVolumeMl: 473,
    approxFoodWeightGrams: 450,
    maxFillFraction: 0.9,
    preferredPreservationMethod: "water-bath",
    storageLocation: "pantry",
  },
  {
    containerTypeId: "freezer-pan",
    label: "9x13 freezer pan",
    approxVolumeMl: 3000,
    approxFoodWeightGrams: 2500,
    maxFillFraction: 0.95,
    preferredPreservationMethod: "freezing",
    storageLocation: "freezer",
  },
];

/**
 * Simple container target row editor.
 *
 * @param {{
 *  target: { containerTypeId?: string, count?: number|string },
 *  catalog: Array<{ containerTypeId?: string, label?: string }>,
 *  onChange: (nextTarget: { containerTypeId?: string, count?: number|string }) => void,
 *  onRemove: () => void
 * }} props
 */
function ContainerTargetRow({ target, catalog, onChange, onRemove }) {
  const handleContainerChange = (e) => {
    onChange({ ...target, containerTypeId: e.target.value });
  };

  const handleCountChange = (e) => {
    const value = e.target.value;
    onChange({
      ...target,
      count: value === "" ? "" : Number(value),
    });
  };

  return (
    <div className="batch-yield-container-target-row">
      <select
        value={target.containerTypeId || ""}
        onChange={handleContainerChange}
      >
        <option value="">Select container…</option>
        {catalog.map((c) => (
          <option key={c.containerTypeId} value={c.containerTypeId}>
            {c.label}
          </option>
        ))}
      </select>
      <input
        type="number"
        min="0"
        step="1"
        value={target.count === "" ? "" : target.count || 0}
        onChange={handleCountChange}
        placeholder="# of containers"
      />
      <button
        type="button"
        className="batch-yield-button-secondary"
        onClick={onRemove}
      >
        ✕
      </button>
    </div>
  );
}

/**
 * @param {{
 *  defaultRecipe?: {
 *    title?: string,
 *    baseYield?: { servings?: number, servingSizeGrams?: number },
 *    ingredients?: Array<{
 *      inventoryItemId?: string,
 *      name?: string,
 *      quantity?: string|number,
 *      unit?: string
 *    }>,
 *    notes?: string,
 *    containerCatalog?: Array<{ containerTypeId?: string, label?: string }>
 *  } | null
 * }} props
 */
export function BatchYieldCalculatorView({ defaultRecipe }) {
  const { runCalculation, loading, lastResult, error } =
    useBatchYieldCalculator();

  // Base recipe form state
  const [recipeTitle, setRecipeTitle] = useState(
    defaultRecipe?.title || "Batch Recipe"
  );
  const [baseServings, setBaseServings] = useState(
    defaultRecipe?.baseYield?.servings ?? 8
  );
  const [baseServingSizeGrams, setBaseServingSizeGrams] = useState(
    defaultRecipe?.baseYield?.servingSizeGrams ?? 250
  );

  // Scaling
  const [scalingMode, setScalingMode] = useState("servings");
  const [scaleFactor, setScaleFactor] = useState(2);
  const [targetServings, setTargetServings] = useState(24);
  const [containerTargets, setContainerTargets] = useState([
    { containerTypeId: "qt-jar", count: 8 },
  ]);

  // Portioning preferences
  const [readyToEatServings, setReadyToEatServings] = useState(4);
  const [preservedServings, setPreservedServings] = useState("");
  const [portionRoundingMode, setPortionRoundingMode] = useState("floor");
  const [defaultServingSizeOverride, setDefaultServingSizeOverride] =
    useState("");

  const [unitSystem, setUnitSystem] = useState("imperial");

  const containerCatalog = defaultRecipe?.containerCatalog
    ? defaultRecipe.containerCatalog
    : DEFAULT_CONTAINER_CATALOG;

  const handleAddContainerTarget = () => {
    setContainerTargets((prev) => [
      ...prev,
      { containerTypeId: "", count: "" },
    ]);
  };

  const handleContainerTargetChange = (index, updated) => {
    setContainerTargets((prev) =>
      prev.map((t, i) => (i === index ? updated : t))
    );
  };

  const handleContainerTargetRemove = (index) => {
    setContainerTargets((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    const recipeDefinition = {
      title: recipeTitle,
      baseYield: {
        servings: Number(baseServings) || 1,
        servingSizeGrams: Number(baseServingSizeGrams) || 250,
      },
      ingredients: defaultRecipe?.ingredients || [],
      notes: defaultRecipe?.notes || "",
    };

    const scalingTarget = (() => {
      if (scalingMode === "scaleFactor") {
        return {
          mode: "scaleFactor",
          scaleFactor: scaleFactor === "" ? null : Number(scaleFactor) || null,
        };
      }
      if (scalingMode === "servings") {
        return {
          mode: "servings",
          targetServings:
            targetServings === "" ? null : Number(targetServings) || null,
        };
      }
      return {
        mode: "containers",
        targetContainers: containerTargets
          .filter((t) => t.containerTypeId && t.count)
          .map((t) => ({
            containerTypeId: t.containerTypeId,
            count: Number(t.count) || 0,
          })),
      };
    })();

    const portioningPreferences = {
      portionRoundingMode,
      defaultServingSizeGrams:
        defaultServingSizeOverride === ""
          ? undefined
          : Number(defaultServingSizeOverride) || undefined,
      portionDistribution: {
        readyToEatServings:
          readyToEatServings === ""
            ? undefined
            : Number(readyToEatServings) || undefined,
        preservedServings:
          preservedServings === ""
            ? undefined
            : Number(preservedServings) || undefined,
      },
    };

    const input = {
      unitSystem,
      recipeDefinition,
      batchScalingTarget: scalingTarget,
      portioningPreferences,
      containerCatalog,
      macroTargets: null,
      hairSupportTargets: null,
    };

    await runCalculation(input);
  };

  const handleSuggestSession = () => {
    if (!lastResult) return;
    const nowIso = new Date().toISOString();

    emit({
      type: "sessions.suggestion.batchYield",
      ts: nowIso,
      source: "calculators/storehouseMeals/BatchYieldCalculator.view",
      data: {
        title: `Batch: ${recipeTitle}`,
        estimate: {
          totalServings: lastResult.output.batchPortionYield.totalServings,
          preservedServings:
            lastResult.output.batchPortionYield.preservedServings,
          containerCount: lastResult.output.batchContainerPlan.length,
        },
        inventoryDelta: lastResult.output.batchInventoryDelta || undefined,
      },
    });
  };

  const handleSendToStorehouse = () => {
    if (!lastResult) return;
    const nowIso = new Date().toISOString();

    emit({
      type: "storehouse.batchYield.applied",
      ts: nowIso,
      source: "calculators/storehouseMeals/BatchYieldCalculator.view",
      data: {
        batchResult: lastResult.output,
      },
    });
  };

  return (
    <div className="calculator-card batch-yield-calculator">
      <header className="calculator-header">
        <h1>Batch Yield Planner</h1>
        <p className="calculator-subtitle">
          Design a big batch, estimate servings and containers, and sync with
          your storehouse and sessions.
        </p>
      </header>

      <form className="calculator-form" onSubmit={handleSubmit}>
        {/* Recipe basics */}
        <section className="calculator-section">
          <h2>1. Recipe basics</h2>
          <div className="calculator-grid">
            <label className="calculator-field">
              <span>Recipe / Batch name</span>
              <input
                type="text"
                value={recipeTitle}
                onChange={(e) => setRecipeTitle(e.target.value)}
                placeholder="Grandma's Chili – Batch"
              />
            </label>

            <label className="calculator-field">
              <span>Unit system</span>
              <select
                value={unitSystem}
                onChange={(e) => setUnitSystem(e.target.value)}
              >
                <option value="imperial">Imperial (US)</option>
                <option value="metric">Metric</option>
              </select>
            </label>
          </div>

          <div className="calculator-grid">
            <label className="calculator-field">
              <span>Base servings (original recipe)</span>
              <input
                type="number"
                min="1"
                step="1"
                value={baseServings}
                onChange={(e) => setBaseServings(e.target.value)}
              />
            </label>

            <label className="calculator-field">
              <span>Base serving size (g)</span>
              <input
                type="number"
                min="1"
                step="1"
                value={baseServingSizeGrams}
                onChange={(e) => setBaseServingSizeGrams(e.target.value)}
              />
            </label>
          </div>
        </section>

        {/* Scaling strategy */}
        <section className="calculator-section">
          <h2>2. How big is this batch?</h2>

          <div className="calculator-grid">
            <label className="calculator-field">
              <span>Scaling mode</span>
              <select
                value={scalingMode}
                onChange={(e) => setScalingMode(e.target.value)}
              >
                {SCALING_MODES.map((mode) => (
                  <option key={mode.value} value={mode.value}>
                    {mode.label}
                  </option>
                ))}
              </select>
            </label>

            {scalingMode === "scaleFactor" && (
              <label className="calculator-field">
                <span>Scale factor</span>
                <input
                  type="number"
                  min="0.1"
                  step="0.1"
                  value={scaleFactor}
                  onChange={(e) => setScaleFactor(e.target.value)}
                />
              </label>
            )}

            {scalingMode === "servings" && (
              <label className="calculator-field">
                <span>Target total servings</span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={targetServings}
                  onChange={(e) => setTargetServings(e.target.value)}
                />
              </label>
            )}
          </div>

          {scalingMode === "containers" && (
            <div className="calculator-subsection">
              <div className="calculator-subsection-header">
                <h3>Fill containers</h3>
                <button
                  type="button"
                  className="batch-yield-button-secondary"
                  onClick={handleAddContainerTarget}
                >
                  + Add container type
                </button>
              </div>

              {containerTargets.length === 0 && (
                <p className="calculator-hint">
                  Add at least one container type and count to estimate a batch
                  size that fills those containers.
                </p>
              )}

              {containerTargets.map((target, index) => (
                <ContainerTargetRow
                  key={`${index}-${target.containerTypeId || "empty"}`}
                  target={target}
                  catalog={containerCatalog}
                  onChange={(updated) =>
                    handleContainerTargetChange(index, updated)
                  }
                  onRemove={() => handleContainerTargetRemove(index)}
                />
              ))}
            </div>
          )}
        </section>

        {/* Portioning preferences */}
        <section className="calculator-section">
          <h2>3. Portioning & preservation</h2>
          <div className="calculator-grid">
            <label className="calculator-field">
              <span>Ready-to-eat servings</span>
              <input
                type="number"
                min="0"
                step="1"
                value={readyToEatServings}
                onChange={(e) => setReadyToEatServings(e.target.value)}
                placeholder="Optional"
              />
              <small>Leave blank to let SSA choose a reasonable default.</small>
            </label>

            <label className="calculator-field">
              <span>Servings to preserve</span>
              <input
                type="number"
                min="0"
                step="1"
                value={preservedServings}
                onChange={(e) => setPreservedServings(e.target.value)}
                placeholder="Optional"
              />
              <small>
                SSA will reconcile totals so you don&apos;t overshoot.
              </small>
            </label>
          </div>

          <div className="calculator-grid">
            <label className="calculator-field">
              <span>Portion rounding</span>
              <select
                value={portionRoundingMode}
                onChange={(e) => setPortionRoundingMode(e.target.value)}
              >
                {ROUNDING_MODES.map((mode) => (
                  <option key={mode.value} value={mode.value}>
                    {mode.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="calculator-field">
              <span>Serving size override (g)</span>
              <input
                type="number"
                min="1"
                step="1"
                value={defaultServingSizeOverride}
                onChange={(e) => setDefaultServingSizeOverride(e.target.value)}
                placeholder="Leave blank to use base serving size"
              />
            </label>
          </div>
        </section>

        <footer className="calculator-footer">
          <button
            type="submit"
            className="batch-yield-button-primary"
            disabled={loading}
          >
            {loading ? "Calculating…" : "Calculate Batch Yield"}
          </button>
        </footer>
      </form>

      {/* Results */}
      {error && (
        <div className="calculator-error">
          <strong>Something went wrong.</strong>
          <p>{error}</p>
        </div>
      )}

      {lastResult && (
        <section className="calculator-results">
          <header className="calculator-results-header">
            <h2>Batch yield summary</h2>
            <p>
              Based on your inputs, here&apos;s how this batch breaks down into
              servings and containers.
            </p>
          </header>

          <div className="calculator-grid">
            <div className="calculator-card-lite">
              <h3>Servings overview</h3>
              <ul className="calculator-metrics-list">
                <li>
                  <span>Total servings</span>
                  <strong>
                    {lastResult.output.batchPortionYield.totalServings}
                  </strong>
                </li>
                <li>
                  <span>Ready-to-eat servings</span>
                  <strong>
                    {lastResult.output.batchPortionYield.readyToEatServings}
                  </strong>
                </li>
                <li>
                  <span>Servings preserved</span>
                  <strong>
                    {lastResult.output.batchPortionYield.preservedServings}
                  </strong>
                </li>
                <li>
                  <span>Serving size (g)</span>
                  <strong>
                    {lastResult.output.batchPortionYield.servingSizeGrams}
                  </strong>
                </li>
              </ul>
            </div>

            <div className="calculator-card-lite">
              <h3>Labeling hints</h3>
              <p className="calculator-label-lines">
                {lastResult.output.batchLabelingHints.labelLines.map(
                  (line, idx) => (
                    <span key={idx}>{line}</span>
                  )
                )}
              </p>
              <p className="calculator-hint">
                These lines are ready to send to your label printer or Batch
                Session planner.
              </p>
            </div>
          </div>

          {/* Container plan */}
          <div className="calculator-subsection">
            <h3>Container plan</h3>
            {lastResult.output.batchContainerPlan.length === 0 ? (
              <p className="calculator-hint">
                No container plan generated. Try using the container scaling
                mode or adding preservation servings.
              </p>
            ) : (
              <table className="calculator-table">
                <thead>
                  <tr>
                    <th>Container</th>
                    <th>Count</th>
                    <th>Est. servings / container</th>
                    <th>Fill</th>
                    <th>Method</th>
                    <th>Location</th>
                  </tr>
                </thead>
                <tbody>
                  {lastResult.output.batchContainerPlan.map((cp, idx) => (
                    <tr key={`${cp.containerTypeId}-${idx}`}>
                      <td>{cp.label}</td>
                      <td>{cp.count}</td>
                      <td>
                        {cp.estimatedServingsPerContainer
                          ? cp.estimatedServingsPerContainer.toFixed(1)
                          : "—"}
                      </td>
                      <td>
                        {cp.fillFraction != null
                          ? `${Math.round(cp.fillFraction * 100)}%`
                          : "—"}
                      </td>
                      <td>{cp.preservationMethod}</td>
                      <td>{cp.storageLocation}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Inventory impact */}
          <div className="calculator-subsection">
            <h3>Inventory impact (preview)</h3>
            <div className="calculator-grid">
              <div className="calculator-card-lite">
                <h4>Ingredients used</h4>
                {lastResult.output.batchInventoryDelta.ingredientsConsumed
                  .length === 0 ? (
                  <p className="calculator-hint">
                    No linked ingredients yet. Once this recipe is tied to
                    storehouse items, SSA will show exact changes.
                  </p>
                ) : (
                  <ul className="calculator-metrics-list">
                    {lastResult.output.batchInventoryDelta.ingredientsConsumed.map(
                      (item, idx) => (
                        <li key={`${item.inventoryItemId}-${idx}`}>
                          <span>{item.label}</span>
                          <strong>
                            {item.quantityChange} {item.unit}
                          </strong>
                        </li>
                      )
                    )}
                  </ul>
                )}
              </div>

              <div className="calculator-card-lite">
                <h4>Items produced</h4>
                {lastResult.output.batchInventoryDelta.itemsProduced.length ===
                0 ? (
                  <p className="calculator-hint">
                    No produced items yet. Container plan will create production
                    entries here.
                  </p>
                ) : (
                  <ul className="calculator-metrics-list">
                    {lastResult.output.batchInventoryDelta.itemsProduced.map(
                      (item, idx) => (
                        <li key={`${item.inventoryItemId}-${idx}`}>
                          <span>{item.label}</span>
                          <strong>
                            +{item.quantityChange} {item.unit}
                          </strong>
                        </li>
                      )
                    )}
                  </ul>
                )}
              </div>
            </div>
          </div>

          {/* Actions: sessions + storehouse */}
          <footer className="calculator-results-footer">
            <button
              type="button"
              className="batch-yield-button-primary"
              onClick={handleSuggestSession}
            >
              Use in Batch Session
            </button>
            <button
              type="button"
              className="batch-yield-button-secondary"
              onClick={handleSendToStorehouse}
            >
              Send to Storehouse Planner
            </button>
          </footer>
        </section>
      )}
    </div>
  );
}

export default BatchYieldCalculatorView;
