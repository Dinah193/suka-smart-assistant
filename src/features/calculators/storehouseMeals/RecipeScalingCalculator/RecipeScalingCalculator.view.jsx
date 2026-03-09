// C:\Users\larho\suka-smart-assistant\src\features\calculators\storehouseMeals\RecipeScalingCalculator\RecipeScalingCalculator.view.jsx

/**
 * RecipeScalingCalculator.view.jsx
 *
 * How this fits:
 * - UI layer for the Recipe Scaling Calculator node in the SSA Planning Graph.
 * - Lets the user set base servings, target servings or a scale factor,
 *   rounding mode, and optional limits.
 * - Calls the RecipeScalingCalculator shim to compute new quantities and
 *   shows a preview table of base vs scaled ingredient amounts and inventory.
 * - Designed to be embedded on storehouse/meal planning pages or opened
 *   inside a modal; can emit results upward via onResult for downstream
 *   batch/planning/session flows.
 */

import React, { useState, useMemo } from "react";
import { calculateRecipeScaling } from "./RecipeScalingCalculator.shim";
import { emit as emitEvent } from "@/services/events/eventBus";

const ROUNDING_OPTIONS = [
  { value: "friendlyKitchen", label: "Friendly Kitchen (¼ increments)" },
  { value: "fractionQuarter", label: "Quarter Fractions (¼, ½, ¾)" },
  { value: "storePackage", label: "Approx. Store Packages" },
  { value: "none", label: "Exact (no rounding)" },
];

/**
 * @param {{
 *  baseRecipe?: {
 *    id?: string|null,
 *    name?: string|null,
 *    ingredients?: { ingredientId?:string|null, name:string, quantity:number, unit:string, storehouseItemId?:string|null }[]
 *  },
 *  initialInput?: Partial<import("./RecipeScalingCalculator.shim").RecipeScalingInput>,
 *  householdId?: string|null,
 *  onResult?: (result:any) => void,
 *  onClose?: () => void
 * }} props
 */
export default function RecipeScalingCalculatorView(props) {
  const {
    baseRecipe,
    initialInput,
    householdId = null,
    onResult,
    onClose,
  } = props;

  const [baseServings, setBaseServings] = useState(
    initialInput?.baseServings || 4
  );
  const [targetServings, setTargetServings] = useState(
    initialInput?.targetServings || ""
  );
  const [scaleFactor, setScaleFactor] = useState(
    initialInput?.scaleFactor || ""
  );
  const [roundingMode, setRoundingMode] = useState(
    initialInput?.roundingMode || "friendlyKitchen"
  );
  const [minScaleFactor, setMinScaleFactor] = useState(
    initialInput?.minScaleFactor || ""
  );
  const [maxScaleFactor, setMaxScaleFactor] = useState(
    initialInput?.maxScaleFactor || ""
  );
  const [respectInventory, setRespectInventory] = useState(
    initialInput?.respectInventory ?? true
  );
  const [respectEquipmentLimits, setRespectEquipmentLimits] = useState(
    initialInput?.respectEquipmentLimits ?? true
  );
  const [respectTimeConstraints, setRespectTimeConstraints] = useState(
    initialInput?.respectTimeConstraints ?? false
  );

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  const hasIngredients = useMemo(
    () =>
      Array.isArray(baseRecipe?.ingredients) &&
      baseRecipe.ingredients.length > 0,
    [baseRecipe]
  );

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const parsedBaseServings = Number(baseServings);
      if (!parsedBaseServings || parsedBaseServings <= 0) {
        throw new Error("Base servings must be a positive number.");
      }

      const parsedTargetServings =
        targetServings === "" ? null : Number(targetServings);
      const parsedScaleFactor = scaleFactor === "" ? null : Number(scaleFactor);
      const parsedMinFactor =
        minScaleFactor === "" ? null : Number(minScaleFactor);
      const parsedMaxFactor =
        maxScaleFactor === "" ? null : Number(maxScaleFactor);

      const input = {
        recipeId: baseRecipe?.id || null,
        recipeName: baseRecipe?.name || null,
        baseServings: parsedBaseServings,
        targetServings:
          parsedTargetServings && parsedTargetServings > 0
            ? parsedTargetServings
            : null,
        scaleFactor:
          parsedScaleFactor && parsedScaleFactor > 0 ? parsedScaleFactor : null,
        roundingMode,
        minScaleFactor:
          parsedMinFactor && parsedMinFactor > 0 ? parsedMinFactor : null,
        maxScaleFactor:
          parsedMaxFactor && parsedMaxFactor > 0 ? parsedMaxFactor : null,
        respectInventory,
        respectEquipmentLimits,
        respectTimeConstraints,
        inventorySnapshot: null,
        equipmentConstraints: null,
        timeConstraints: null,
        householdContext: householdId ? { householdId } : null,
      };

      const payload = {
        input,
        baseRecipe: hasIngredients
          ? {
              id: baseRecipe?.id || null,
              name: baseRecipe?.name || null,
              ingredients: baseRecipe?.ingredients || [],
            }
          : undefined,
        meta: {
          householdId: householdId || null,
        },
      };

      const calcResult = await calculateRecipeScaling(payload);
      setResult(calcResult);

      emitEvent({
        type: "calculator.ui.updated",
        ts: new Date().toISOString(),
        source:
          "features/calculators/storehouseMeals/RecipeScalingCalculator/view",
        data: {
          recipeId: input.recipeId,
          scaledServings: calcResult.output.scaledServings,
          appliedScaleFactor: calcResult.output.appliedScaleFactor,
        },
      });

      if (typeof onResult === "function") {
        onResult(calcResult);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[RecipeScalingCalculatorView] Error:", err);
      setError(
        err && err.message
          ? err.message
          : "Something went wrong while scaling this recipe."
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="ssa-panel ssa-panel--calculator">
      <div className="ssa-panel__header">
        <div>
          <h2 className="ssa-panel__title">Recipe Scaling Calculator</h2>
          <p className="ssa-panel__subtitle">
            Scale a recipe up or down and preview new ingredient amounts before
            committing to a batch session.
          </p>
        </div>
        {onClose && (
          <button
            type="button"
            className="ssa-panel__close-btn"
            onClick={onClose}
          >
            ×
          </button>
        )}
      </div>

      {!hasIngredients && (
        <div className="ssa-panel__notice">
          <p>
            No ingredient data was provided for this recipe. You can still
            compute the scale factor and new serving size, but ingredient
            quantities will not be shown until this calculator is wired to a
            recipe source.
          </p>
        </div>
      )}

      <form className="ssa-form" onSubmit={handleSubmit}>
        <div className="ssa-form__grid">
          <div className="ssa-form__field">
            <label className="ssa-form__label">Base Servings</label>
            <input
              type="number"
              min="0"
              step="0.25"
              value={baseServings}
              onChange={(e) => setBaseServings(e.target.value)}
              className="ssa-form__input"
              required
            />
            <p className="ssa-form__help">
              How many servings the recipe currently makes.
            </p>
          </div>

          <div className="ssa-form__field">
            <label className="ssa-form__label">
              Target Servings
              <span className="ssa-form__label-note"> (optional)</span>
            </label>
            <input
              type="number"
              min="0"
              step="0.25"
              value={targetServings}
              onChange={(e) => setTargetServings(e.target.value)}
              className="ssa-form__input"
              placeholder="e.g. 12"
            />
            <p className="ssa-form__help">
              If provided, this is used to derive the scale factor. Leave blank
              if you want to specify the scale factor directly.
            </p>
          </div>

          <div className="ssa-form__field">
            <label className="ssa-form__label">
              Scale Factor
              <span className="ssa-form__label-note"> (optional)</span>
            </label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={scaleFactor}
              onChange={(e) => setScaleFactor(e.target.value)}
              className="ssa-form__input"
              placeholder="e.g. 2 for double"
            />
            <p className="ssa-form__help">
              If both target servings and scale factor are provided, the scale
              factor is used.
            </p>
          </div>

          <div className="ssa-form__field">
            <label className="ssa-form__label">Rounding Mode</label>
            <select
              value={roundingMode}
              onChange={(e) => setRoundingMode(e.target.value)}
              className="ssa-form__select"
            >
              {ROUNDING_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <p className="ssa-form__help">
              Choose how ingredient quantities are rounded for kitchen use.
            </p>
          </div>

          <div className="ssa-form__field">
            <label className="ssa-form__label">
              Minimum Scale Factor
              <span className="ssa-form__label-note"> (optional)</span>
            </label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={minScaleFactor}
              onChange={(e) => setMinScaleFactor(e.target.value)}
              className="ssa-form__input"
              placeholder="e.g. 0.5"
            />
            <p className="ssa-form__help">
              Ensures you don&apos;t accidentally scale down below this factor.
            </p>
          </div>

          <div className="ssa-form__field">
            <label className="ssa-form__label">
              Maximum Scale Factor
              <span className="ssa-form__label-note"> (optional)</span>
            </label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={maxScaleFactor}
              onChange={(e) => setMaxScaleFactor(e.target.value)}
              className="ssa-form__input"
              placeholder="e.g. 4"
            />
            <p className="ssa-form__help">
              Prevents oversizing a batch beyond your equipment or freezer.
            </p>
          </div>
        </div>

        <fieldset className="ssa-form__fieldset">
          <legend className="ssa-form__legend">Planning Guards</legend>
          <div className="ssa-form__toggles">
            <label className="ssa-toggle">
              <input
                type="checkbox"
                checked={respectInventory}
                onChange={(e) => setRespectInventory(e.target.checked)}
              />
              <span>Respect inventory constraints</span>
            </label>

            <label className="ssa-toggle">
              <input
                type="checkbox"
                checked={respectEquipmentLimits}
                onChange={(e) => setRespectEquipmentLimits(e.target.checked)}
              />
              <span>Respect equipment limits</span>
            </label>

            <label className="ssa-toggle">
              <input
                type="checkbox"
                checked={respectTimeConstraints}
                onChange={(e) => setRespectTimeConstraints(e.target.checked)}
              />
              <span>Respect time constraints</span>
            </label>
          </div>
        </fieldset>

        {error && <div className="ssa-form__error">{error}</div>}

        <div className="ssa-form__actions">
          <button
            type="submit"
            className="ssa-btn ssa-btn--primary"
            disabled={loading}
          >
            {loading ? "Scaling…" : "Scale Recipe"}
          </button>
          {onClose && (
            <button
              type="button"
              className="ssa-btn ssa-btn--ghost"
              onClick={onClose}
            >
              Close
            </button>
          )}
        </div>
      </form>

      {result && (
        <div className="ssa-panel__section">
          <div className="ssa-panel__section-header">
            <h3 className="ssa-panel__section-title">Scaled Recipe Preview</h3>
            <div className="ssa-panel__section-meta">
              <span>
                Base Servings: <strong>{result.input.baseServings}</strong>
              </span>
              <span>
                New Servings: <strong>{result.output.scaledServings}</strong>
              </span>
              <span>
                Scale Factor:{" "}
                <strong>{result.output.appliedScaleFactor.toFixed(3)}</strong>
              </span>
            </div>
          </div>

          {result.output.scalingWarnings.length > 0 && (
            <div className="ssa-panel__notice ssa-panel__notice--warning">
              <ul>
                {result.output.scalingWarnings.map((w, idx) => (
                  <li key={idx}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {result.output.sessionsHints && (
            <div className="ssa-panel__hint-row">
              {result.output.sessionsHints.estimatedTotalCookMinutes !=
                null && (
                <span>
                  Estimated total cook time:{" "}
                  <strong>
                    {result.output.sessionsHints.estimatedTotalCookMinutes} min
                  </strong>
                </span>
              )}
              {result.output.sessionsHints.recommendedBatchCount != null && (
                <span>
                  Suggested batches:{" "}
                  <strong>
                    {result.output.sessionsHints.recommendedBatchCount}
                  </strong>
                </span>
              )}
            </div>
          )}

          {result.output.ingredients.length > 0 ? (
            <div className="ssa-table-wrapper">
              <table className="ssa-table ssa-table--compact">
                <thead>
                  <tr>
                    <th>Ingredient</th>
                    <th>Base Qty</th>
                    <th>Scaled Qty</th>
                    <th>Inventory</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {result.output.ingredients.map((ing, idx) => (
                    <tr key={idx}>
                      <td>{ing.name}</td>
                      <td>
                        {ing.baseQuantity} {ing.baseUnit}
                      </td>
                      <td>
                        {ing.scaledQuantity} {ing.scaledUnit}
                      </td>
                      <td>{formatInventoryStatus(ing.inventoryStatus)}</td>
                      <td>
                        {ing.warnings && ing.warnings.length > 0 && (
                          <ul className="ssa-table__warning-list">
                            {ing.warnings.map((w, wIdx) => (
                              <li key={wIdx}>{w}</li>
                            ))}
                          </ul>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="ssa-panel__empty">
              No ingredient details to show yet. Wire this calculator to a
              recipe source with ingredient quantities to see a full comparison.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function formatInventoryStatus(status) {
  switch (status) {
    case "sufficient":
      return "Sufficient";
    case "low":
      return "Low";
    case "shortage":
      return "Shortage";
    case "unknown":
    default:
      return "Unknown";
  }
}
