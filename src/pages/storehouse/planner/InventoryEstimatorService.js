import { PlannerEvents, publishPlannerEvent } from "@/eventBus/plannerEventBus";

const DEV_STORE_KEY = "suka:dev:storehouse:inventory";
const DEV_DEFAULT_HOUSEHOLD = "default-household";

function canUseWindowStorage() {
  return typeof window !== "undefined" && !!window.localStorage;
}

function isDevMode() {
  if (typeof window !== "undefined") {
    const host = String(window.location?.hostname || "").toLowerCase();
    if (host === "localhost" || host === "127.0.0.1") return true;
  }
  try {
    return !!import.meta?.env?.DEV;
  } catch {
    return false;
  }
}

function normalizeHouseholdId(householdId) {
  return String(householdId || DEV_DEFAULT_HOUSEHOLD);
}

function readDevInventoryStore() {
  if (!canUseWindowStorage()) return {};
  try {
    const raw = window.localStorage.getItem(DEV_STORE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeDevInventoryStore(nextStore) {
  if (!canUseWindowStorage()) return;
  try {
    window.localStorage.setItem(DEV_STORE_KEY, JSON.stringify(nextStore || {}));
  } catch {
    // Ignore storage write errors in dev fallback mode.
  }
}

function readDevInventory(householdId) {
  const store = readDevInventoryStore();
  const key = normalizeHouseholdId(householdId);
  const rows = Array.isArray(store[key]) ? store[key] : [];
  return rows;
}

function mergeRowsByKey(existingRows = [], incomingRows = []) {
  const keyOf = (row) => String(row?.id || row?.sku || row?.itemName || "");
  const nextMap = new Map(existingRows.map((row) => [keyOf(row), row]));
  for (const row of incomingRows) {
    nextMap.set(keyOf(row), row);
  }
  return Array.from(nextMap.values());
}

function writeDevInventory(householdId, incomingRows = []) {
  const key = normalizeHouseholdId(householdId);
  const store = readDevInventoryStore();
  const existing = Array.isArray(store[key]) ? store[key] : [];
  store[key] = mergeRowsByKey(existing, incomingRows);
  writeDevInventoryStore(store);
  return store[key];
}

function buildFallbackFetchPayload(householdId) {
  return {
    householdId: normalizeHouseholdId(householdId),
    inventory: readDevInventory(householdId),
  };
}

function buildFallbackUpdatePayload(payload) {
  const householdId = normalizeHouseholdId(payload?.householdId);
  const inventoryRows = Array.isArray(payload?.inventory) ? payload.inventory : [];
  const inventory = writeDevInventory(householdId, inventoryRows);
  return {
    ok: true,
    success: true,
    mode: "dev-fallback",
    householdId,
    inventory,
    updatedAt: new Date().toISOString(),
  };
}

export async function fetchStorehousePlannerData(householdId) {
  const encodedHouseholdId = encodeURIComponent(normalizeHouseholdId(householdId));
  try {
    const res = await fetch(`/api/planners/storehouse?householdId=${encodedHouseholdId}`);
    if (!res.ok) throw new Error("Failed to load storehouse planner data");
    return res.json();
  } catch (err) {
    if (!isDevMode()) throw err;
    return buildFallbackFetchPayload(householdId);
  }
}

export async function updateStorehouseInventory(payload) {
  let data;

  try {
    const res = await fetch(`/api/planners/storehouse/inventory`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error("Failed to update storehouse inventory");
    data = await res.json();
  } catch (err) {
    if (!isDevMode()) throw err;
    data = buildFallbackUpdatePayload(payload);
  }

  publishPlannerEvent(PlannerEvents.STOREHOUSE_INVENTORY_UPDATED, data, {
    source: "InventoryEstimatorService.updateStorehouseInventory",
  });

  return data;
}

export default { fetchStorehousePlannerData, updateStorehouseInventory };
