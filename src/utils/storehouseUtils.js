// src/utils/storehouseUtils.js

export function summarizeIngredientsFromMealPlan(mealPlan = {}) {
  const totals = {};

  Object.values(mealPlan).flat().forEach((recipe) => {
    recipe.ingredients?.forEach((ingredient) => {
      const { name, quantity, unit } = ingredient;
      const key = `${name}-${unit}`;
      if (!totals[key]) {
        totals[key] = { name, unit, total: 0 };
      }
      totals[key].total += quantity;
    });
  });

  return Object.values(totals);
}

export function suggestPreservationType(itemName) {
  const lower = itemName.toLowerCase();
  if (lower.includes("tomato") || lower.includes("stew")) return "Canning";
  if (lower.includes("herb") || lower.includes("onion")) return "Dehydrating";
  if (lower.includes("meat") || lower.includes("sausage")) return "Freezing";
  if (lower.includes("fruit")) return "Fermenting";
  return "Root Cellar / Dry Storage";
}
