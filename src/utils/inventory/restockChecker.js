// src/utils/inventory/restockChecker.js
import db from "../../db";

/**
 * Scans inventory for low items and returns those that need reordering.
 */
export async function getLowInventoryAlerts() {
  const allSupplies = await db.supplies.toArray();
  return allSupplies.filter((item) => item.quantity <= item.threshold);
}

/**
 * Automatically marks low supplies for restock if autoRestock is true.
 */
export async function triggerAutoRestocks() {
  const lowItems = await getLowInventoryAlerts();
  const restockUpdates = [];

  for (const item of lowItems) {
    if (item.autoRestock && item.reorderStatus !== "pending") {
      item.reorderStatus = "pending";
      item.lastUpdated = new Date();
      restockUpdates.push(item);
    }
  }

  if (restockUpdates.length > 0) {
    await db.supplies.bulkPut(restockUpdates);
  }

  return restockUpdates;
}
