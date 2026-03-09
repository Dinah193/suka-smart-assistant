/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\services\repos\farmToTable\componentInventory.repo.js
//
// Farm-to-Table (FTT) Component Inventory repository
// -------------------------------------------------
// Persists the normalized Farm-to-Table component inventory view for a household.
//
// This is NOT the same as SSA "inventory" table; this is a planner-friendly,
// normalized component layer (beans cooked, broth, chopped veg, grains, etc.)
// that can later be mapped to inventory/storehouse items.
//
// Dexie table expected in db.js:
// - ftt_component_inventory
//   "id, householdId, componentKey, itemKey, updatedAt, createdAt,
//    [householdId+componentKey], [householdId+itemKey], [componentKey+updatedAt], [itemKey+updatedAt]"
//
// Recommended record shape:
// {
//   id: string,
//   householdId: string,
//   componentKey: string,      // canonical FTT component identifier ("beans.black", "broth.chicken", ...)
//   itemKey: string,           // SSA inventory/storehouse key mapping ("inventory.sku:...", "storehouse.item:...") or plain
//   label?: string,
//   category?: string,         // "protein"|"produce"|"grain"|"preserve"|"dairy"|...
//   location?: string,         // "freezer", "pantry", "fridge", "root_cellar"
//   qty?: { value:number, unit:string },
//   minQty?: { value:number, unit:string },
//   maxQty?: { value:number, unit:string },
//   parQty?: { value:number, unit:string }, // target stocking level
//   lastUpdatedFrom?: "inventory"|"storehouse"|"batch"|"manual"|"import",
//   lastBatchId?: string|null,
//   expirationISO?: string|null,
//   status?: "active"|"archived",
//   tags?: string[],
//   meta?: object,
//   createdAt: ISO,
//   updatedAt: ISO
// }
//
// This repo is:
// - local-first
// - safe if table missing (dev logs only; returns defaults/[])
// - supports upserts by householdId+componentKey
// - supports list/filter helpers used by FTT planner UI

import db from "@/services/db";

/* -------------------------------------------------------------------------- */
/* Utilities */
/* -------------------------------------------------------------------------- */

function nowIso() {
  return new Date().toISOString();
}

function safeStr(x, fallback = "") {
  if (x == null) return fallback;
  return String(x);
}

function safeNum(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  const v = safeNum(n, min);
  return Math.min(max, Math.max(min, v));
}

function deepClone(obj) {
  try {
    return structuredClone(obj);
  } catch {
    return JSON.parse(JSON.stringify(obj || {}));
  }
}

function hasTable(name) {
  try {
    void db.table(name);
    return true;
  } catch {
    return false;
  }
}

async function safePut(tableName, value) {
  if (!hasTable(tableName)) {
    if (import.meta?.env?.DEV)
      console.warn(`[ftt.componentInventory] Missing table: ${tableName}`);
    return null;
  }
  try {
    await db.table(tableName).put(value);
    return value;
  } catch (e) {
    if (import.meta?.env?.DEV)
      console.warn(`[ftt.componentInventory] safePut failed (${tableName})`, e);
    return null;
  }
}

async function safeGet(tableName, key) {
  if (!hasTable(tableName)) {
    if (import.meta?.env?.DEV)
      console.warn(`[ftt.componentInventory] Missing table: ${tableName}`);
    return null;
  }
  try {
    return await db.table(tableName).get(key);
  } catch (e) {
    if (import.meta?.env?.DEV)
      console.warn(`[ftt.componentInventory] safeGet failed (${tableName})`, e);
    return null;
  }
}

async function safeDelete(tableName, key) {
  if (!hasTable(tableName)) return false;
  try {
    await db.table(tableName).delete(key);
    return true;
  } catch {
    return false;
  }
}

function normalizeQty(qty) {
  // Accept: {value, unit} OR {amount:{value,unit}} OR legacy {qty, unit}
  if (!qty || typeof qty !== "object") return null;

  if (qty.amount && typeof qty.amount === "object") {
    const v = safeNum(qty.amount.value, NaN);
    const u = safeStr(qty.amount.unit, "").trim();
    if (Number.isFinite(v) && u) return { value: v, unit: u };
  }

  const v = safeNum(qty.value ?? qty.qty, NaN);
  const u = safeStr(qty.unit, "").trim();
  if (Number.isFinite(v) && u) return { value: v, unit: u };

  return null;
}

function makeId(householdId, componentKey) {
  const h =
    safeStr(householdId, "household_unknown").trim() || "household_unknown";
  const c =
    safeStr(componentKey, "component_unknown").trim() || "component_unknown";
  return `ftt_component_inventory:${h}:${c}`;
}

/* -------------------------------------------------------------------------- */
/* Normalization */
/* -------------------------------------------------------------------------- */

export function normalizeComponentInventoryItem(householdId, item = {}) {
  const obj = item && typeof item === "object" ? item : {};
  const ts = nowIso();

  const componentKey = safeStr(obj.componentKey || obj.component || "").trim();
  const itemKey = safeStr(obj.itemKey || obj.item || obj.sku || "").trim();

  const id =
    safeStr(obj.id, "") ||
    makeId(householdId, componentKey || itemKey || "unknown");

  return {
    id,
    householdId: safeStr(householdId),
    schemaVersion: safeStr(obj.schemaVersion, "1.0.0"),
    status: safeStr(obj.status, "active"),

    componentKey,
    itemKey,

    label: safeStr(obj.label, ""),
    category: safeStr(obj.category, ""),
    location: safeStr(obj.location, ""),

    qty: normalizeQty(obj.qty || obj.amount || obj.quantity),
    minQty: normalizeQty(obj.minQty),
    maxQty: normalizeQty(obj.maxQty),
    parQty: normalizeQty(obj.parQty),

    lastUpdatedFrom: safeStr(obj.lastUpdatedFrom, "manual"),
    lastBatchId: obj.lastBatchId == null ? null : safeStr(obj.lastBatchId),
    expirationISO:
      obj.expirationISO == null ? null : safeStr(obj.expirationISO),

    tags: Array.isArray(obj.tags) ? obj.tags.map(String).filter(Boolean) : [],
    meta: obj.meta && typeof obj.meta === "object" ? deepClone(obj.meta) : {},

    createdAt: safeStr(obj.createdAt, ts),
    updatedAt: ts,
  };
}

/* -------------------------------------------------------------------------- */
/* Core API */
/* -------------------------------------------------------------------------- */

export async function upsertComponentItem(householdId, item) {
  const normalized = normalizeComponentInventoryItem(householdId, item || {});
  const ok = await safePut("ftt_component_inventory", normalized);
  return ok || normalized;
}

export async function getComponentItemById(id) {
  if (!id) return null;
  return safeGet("ftt_component_inventory", safeStr(id));
}

/**
 * Fast lookup by householdId + componentKey if compound index exists.
 * Your Dexie schema includes: [householdId+componentKey]
 */
export async function getByComponentKey(householdId, componentKey) {
  if (!hasTable("ftt_component_inventory")) return null;
  const h = safeStr(householdId);
  const c = safeStr(componentKey).trim();
  if (!c) return null;

  try {
    const row = await db.ftt_component_inventory
      .where("[householdId+componentKey]")
      .equals([h, c])
      .first();
    return row || null;
  } catch (e) {
    if (import.meta?.env?.DEV)
      console.warn("[ftt.componentInventory] getByComponentKey failed", e);
    // fallback: scan by householdId
    try {
      const rows = await db.ftt_component_inventory
        .where("householdId")
        .equals(h)
        .toArray();
      return rows.find((r) => safeStr(r.componentKey) === c) || null;
    } catch {
      return null;
    }
  }
}

/**
 * Fast lookup by householdId + itemKey if compound index exists.
 * Your Dexie schema includes: [householdId+itemKey]
 */
export async function getByItemKey(householdId, itemKey) {
  if (!hasTable("ftt_component_inventory")) return null;
  const h = safeStr(householdId);
  const k = safeStr(itemKey).trim();
  if (!k) return null;

  try {
    const row = await db.ftt_component_inventory
      .where("[householdId+itemKey]")
      .equals([h, k])
      .first();
    return row || null;
  } catch (e) {
    if (import.meta?.env?.DEV)
      console.warn("[ftt.componentInventory] getByItemKey failed", e);
    try {
      const rows = await db.ftt_component_inventory
        .where("householdId")
        .equals(h)
        .toArray();
      return rows.find((r) => safeStr(r.itemKey) === k) || null;
    } catch {
      return null;
    }
  }
}

export async function deleteComponentItem(id) {
  if (!id) return false;
  return safeDelete("ftt_component_inventory", safeStr(id));
}

/**
 * Delete by householdId+componentKey (convenient when id is deterministic).
 */
export async function deleteByComponentKey(householdId, componentKey) {
  const existing = await getByComponentKey(householdId, componentKey);
  if (!existing?.id) return false;
  return deleteComponentItem(existing.id);
}

export async function listComponentItems(
  householdId,
  { status = "active", limit = 500 } = {},
) {
  if (!hasTable("ftt_component_inventory")) return [];
  const h = safeStr(householdId);

  try {
    let rows = await db.ftt_component_inventory
      .where("householdId")
      .equals(h)
      .toArray();

    if (status) {
      const s = safeStr(status);
      rows = rows.filter((r) => safeStr(r.status) === s);
    }

    rows.sort((a, b) =>
      safeStr(b.updatedAt).localeCompare(safeStr(a.updatedAt)),
    );
    return rows.slice(0, limit);
  } catch (e) {
    if (import.meta?.env?.DEV)
      console.warn("[ftt.componentInventory] listComponentItems failed", e);
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/* Bulk helpers */
/* -------------------------------------------------------------------------- */

export async function bulkUpsertComponentItems(householdId, items = []) {
  if (!hasTable("ftt_component_inventory")) return [];

  const arr = Array.isArray(items) ? items : [];
  const normalized = arr.map((it) =>
    normalizeComponentInventoryItem(householdId, it),
  );

  try {
    await db.transaction("rw", db.ftt_component_inventory, async () => {
      await db.ftt_component_inventory.bulkPut(normalized);
    });
    return normalized;
  } catch (e) {
    if (import.meta?.env?.DEV)
      console.warn("[ftt.componentInventory] bulkUpsert failed", e);
    // fallback: sequential
    const out = [];
    for (const n of normalized) {
      // eslint-disable-next-line no-await-in-loop
      const saved = await safePut("ftt_component_inventory", n);
      out.push(saved || n);
    }
    return out;
  }
}

export async function deleteAllComponentItemsForHousehold(householdId) {
  if (!hasTable("ftt_component_inventory")) return 0;
  const h = safeStr(householdId);

  try {
    const rows = await db.ftt_component_inventory
      .where("householdId")
      .equals(h)
      .toArray();
    const ids = rows.map((r) => r.id).filter(Boolean);

    await db.transaction("rw", db.ftt_component_inventory, async () => {
      await Promise.all(ids.map((id) => db.ftt_component_inventory.delete(id)));
    });

    return ids.length;
  } catch (e) {
    if (import.meta?.env?.DEV)
      console.warn(
        "[ftt.componentInventory] deleteAllComponentItemsForHousehold failed",
        e,
      );
    return 0;
  }
}

/* -------------------------------------------------------------------------- */
/* Domain helpers used by planners */
/* -------------------------------------------------------------------------- */

export function isLowStock(item) {
  if (!item || typeof item !== "object") return false;
  const qty = item.qty;
  const minQty = item.minQty;

  if (!qty || !minQty) return false;
  if (safeStr(qty.unit) !== safeStr(minQty.unit)) return false;

  return safeNum(qty.value) < safeNum(minQty.value);
}

export function isOverstock(item) {
  if (!item || typeof item !== "object") return false;
  const qty = item.qty;
  const maxQty = item.maxQty;

  if (!qty || !maxQty) return false;
  if (safeStr(qty.unit) !== safeStr(maxQty.unit)) return false;

  return safeNum(qty.value) > safeNum(maxQty.value);
}

export async function listLowStock(householdId, { limit = 200 } = {}) {
  const rows = await listComponentItems(householdId, {
    status: "active",
    limit: 1000,
  });
  const low = rows.filter(isLowStock);
  low.sort((a, b) => safeStr(b.updatedAt).localeCompare(safeStr(a.updatedAt)));
  return low.slice(0, limit);
}

export async function listOverstock(householdId, { limit = 200 } = {}) {
  const rows = await listComponentItems(householdId, {
    status: "active",
    limit: 1000,
  });
  const over = rows.filter(isOverstock);
  over.sort((a, b) => safeStr(b.updatedAt).localeCompare(safeStr(a.updatedAt)));
  return over.slice(0, limit);
}

// Legacy compatibility helpers
export async function countByHouseholdId(householdId) {
  const rows = await listComponentItems(householdId, { limit: 100000 });
  return rows.length;
}

export const countForHousehold = countByHouseholdId;

/* -------------------------------------------------------------------------- */
/* Default export (ergonomic repo object) */
/* -------------------------------------------------------------------------- */

const componentInventoryRepo = {
  // core
  upsertComponentItem,
  getComponentItemById,
  getByComponentKey,
  getByItemKey,
  deleteComponentItem,
  deleteByComponentKey,
  listComponentItems,

  // bulk
  bulkUpsertComponentItems,
  deleteAllComponentItemsForHousehold,

  // planner helpers
  isLowStock,
  isOverstock,
  listLowStock,
  listOverstock,
  countByHouseholdId,
  countForHousehold,

  // utils
  normalizeComponentInventoryItem,
};

export default componentInventoryRepo;
