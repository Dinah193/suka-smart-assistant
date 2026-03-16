import { PlannerEvents, publishPlannerEvent } from "@/eventBus/plannerEventBus";

export async function fetchStorehousePlannerData(householdId) {
  const res = await fetch(`/api/planners/storehouse?householdId=${encodeURIComponent(householdId)}`);
  if (!res.ok) throw new Error("Failed to load storehouse planner data");
  return res.json();
}

export async function updateStorehouseInventory(payload) {
  const res = await fetch(`/api/planners/storehouse/inventory`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("Failed to update storehouse inventory");
  const data = await res.json();

  publishPlannerEvent(PlannerEvents.STOREHOUSE_INVENTORY_UPDATED, data, {
    source: "InventoryEstimatorService.updateStorehouseInventory",
  });

  return data;
}

export default { fetchStorehousePlannerData, updateStorehouseInventory };
