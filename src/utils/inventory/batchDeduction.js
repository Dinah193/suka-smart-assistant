// src/utils/inventory/batchDeduction.js
import db from "../../db";
import SupplyInventory from "../../models/SupplyInventory";

/**
 * Deducts supplies from inventory based on recipes in a batch cooking session.
 * @param {Array} recipes - Array of recipe objects (must include ingredients)
 * @param {string} batchId - ID of the batch session
 */
export async function deductIngredientsForBatch(recipes = [], batchId = "") {
  const inventoryMap = {};

  // Fetch current inventory into a quick-access object
  const allSupplies = await db.supplies.toArray();
  for (const item of allSupplies) {
    inventoryMap[item.name.toLowerCase()] = new SupplyInventory(item);
  }

  const updates = [];

  for (const recipe of recipes) {
    for (const { name, quantity = 0 } of recipe.ingredients || []) {
      const key = name.toLowerCase();
      const supply = inventoryMap[key];

      if (supply) {
        supply.decrease(quantity, { recipeId: recipe.id, batchId });
        updates.push(supply);
      }
    }
  }

  // Save all updated supplies
  await db.supplies.bulkPut(updates.map((s) => s.toJSON()));
  return updates;
}
