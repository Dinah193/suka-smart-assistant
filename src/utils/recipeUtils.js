// src/utils/recipeUtils.js

/**
 * Extract ingredients from a recipe object into a flat list.
 * @param {Object} recipe
 * @returns {Array<{ name: string, amount: number, unit: string }>}
 */
export function extractIngredients(recipe) {
  if (!recipe || !Array.isArray(recipe.ingredients)) return [];

  return recipe.ingredients.map((item) => ({
    name: item.name?.trim().toLowerCase() || "unknown",
    amount: item.amount || 0,
    unit: item.unit || "",
  }));
}

/**
 * getRecipeIngredients
 * - Backward-compatible export expected by some components (e.g., InventoryAwarePlanner).
 * - Returns a normalized ingredient list.
 * - Supports both "amount" and "quantity" style fields safely.
 *
 * @param {Object} recipe
 * @returns {Array<{ name: string, amount: number, unit: string }>}
 */
export function getRecipeIngredients(recipe) {
  if (!recipe || !Array.isArray(recipe.ingredients)) return [];

  return recipe.ingredients
    .map((item) => {
      const name = String(item?.name || item?.label || "")
        .trim()
        .toLowerCase();
      const unit = String(item?.unit || item?.uom || "").trim();
      const amount =
        Number(item?.amount ?? item?.quantity ?? item?.qty ?? item?.value) || 0;

      return {
        name: name || "unknown",
        amount,
        unit,
      };
    })
    .filter((x) => x.name && x.amount >= 0);
}

/**
 * Consolidate and total ingredients from multiple recipes.
 * @param {Array<Object>} recipes
 * @returns {Array<{ name: string, totalAmount: number, unit: string }>}
 */
export function consolidateIngredients(recipes = []) {
  const totals = {};

  recipes.forEach((recipe) => {
    extractIngredients(recipe).forEach(({ name, amount, unit }) => {
      const key = `${name}|${unit}`;
      if (!totals[key]) {
        totals[key] = { name, unit, totalAmount: 0 };
      }
      totals[key].totalAmount += amount;
    });
  });

  return Object.values(totals);
}

/**
 * Estimate total cooking time from step durations
 * @param {Array<{ minutes: number }>} steps
 * @returns {number} total time in minutes
 */
export function estimateTotalTime(steps = []) {
  return steps.reduce((sum, step) => sum + (step.minutes || 0), 0);
}

/**
 * Break down steps into time blocks (used for timers or scheduling)
 * @param {Array<{ label: string, minutes: number }>} steps
 * @param {number} blockSize
 * @returns {Array<{ blockLabel: string, duration: number }>}
 */
export function splitStepsIntoBlocks(steps, blockSize = 10) {
  const blocks = [];

  steps.forEach((step) => {
    const duration = step.minutes || 0;
    const fullBlocks = Math.floor(duration / blockSize);
    const remainder = duration % blockSize;

    for (let i = 0; i < fullBlocks; i++) {
      blocks.push({
        blockLabel: `${step.label} (part ${i + 1})`,
        duration: blockSize,
      });
    }

    if (remainder > 0) {
      blocks.push({
        blockLabel: `${step.label} (final)`,
        duration: remainder,
      });
    }
  });

  return blocks;
}

/**
 * Generate a unique session title from selected recipes.
 * @param {Array} recipes
 * @returns {string}
 */
export function generateSessionTitle(recipes = []) {
  const names = recipes.map((r) => r.name || "Untitled");
  return `Batch Session: ${names.join(", ").slice(0, 80)}`;
}
