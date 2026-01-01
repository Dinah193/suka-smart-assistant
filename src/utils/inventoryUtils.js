// src/utils/inventoryUtils.js

/**
 * Map all ingredient quantities required from a list of recipes
 */
export function aggregateIngredients(recipes = []) {
  const ingredientMap = {};

  recipes.forEach((recipe) => {
    recipe.ingredients?.forEach((ing) => {
      const key = `${ing.name.toLowerCase()}_${ing.unit}`;
      if (!ingredientMap[key]) {
        ingredientMap[key] = {
          name: ing.name,
          unit: ing.unit,
          total: 0,
        };
      }
      ingredientMap[key].total += ing.quantity || 0;
    });
  });

  return Object.values(ingredientMap);
}

/**
 * Compare inventory levels and flag shortages
 */
export function detectShortages(ingredientNeeds = [], currentInventory = []) {
  const shortages = [];

  ingredientNeeds.forEach((need) => {
    const inv = currentInventory.find(
      (item) =>
        item.name.toLowerCase() === need.name.toLowerCase() &&
        item.unit === need.unit
    );
    const available = inv?.quantity || 0;
    if (available < need.total) {
      shortages.push({
        ...need,
        available,
        shortage: need.total - available,
      });
    }
  });

  return shortages;
}

/**
 * Suggest preservation or freezing if inventory exceeds thresholds
 */
export function suggestPreservationOptions(inventory = [], thresholds = {}) {
  return inventory
    .filter((item) => {
      const limit = thresholds[item.name.toLowerCase()] || 100;
      return item.quantity > limit;
    })
    .map((item) => ({
      name: item.name,
      quantity: item.quantity,
      suggestion: "Preserve excess by freezing, drying, or canning",
    }));
}

/**
 * Generate storage placement suggestions for items
 */
export function generateStorageLabels(items = []) {
  return items.map((item) => {
    const zone =
      item.name.match(/meat|cheese|milk|eggs/i) || item.perishable
        ? "Cold Storage"
        : item.name.match(/grain|flour|beans|lentils/i)
        ? "Dry Storage"
        : "Pantry";

    return {
      ...item,
      suggestedZone: zone,
    };
  });
}

/**
 * Link ingredients to inventory entries by ID
 */
export function linkIngredientsToInventory(recipes = [], inventory = []) {
  return recipes.flatMap((recipe) =>
    recipe.ingredients.map((ing) => {
      const match = inventory.find(
        (inv) =>
          inv.name.toLowerCase() === ing.name.toLowerCase() &&
          inv.unit === ing.unit
      );
      return {
        ...ing,
        inventoryId: match?.id || null,
        available: match?.quantity || 0,
      };
    })
  );
}
