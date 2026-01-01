/**
 * src/agents/skills/inventory/lookup.js
 *
 * How this fits:
 * - Shared "read" skill for SSA:
 *   • Cooking agent: check availability of ingredients for sessions.
 *   • Cleaning agent: check supply usage & reorder thresholds (supplyUseCalc).
 *   • Garden/animals/preservation: peek at stock in storehouse.
 *
 * - Uses Dexie (via your existing DB module) to read from the inventory table.
 *   This file NEVER mutates inventory; it is read-only and safe to call freely.
 *
 * - Designed to be fast:
 *   • In-memory TTL cache for ID/SKU/name lookups.
 *   • Uses indexed queries when possible; falls back to filters.
 *
 * - Event bus:
 *   • Emits small analytics events for observability:
 *     - inventory.lookup.performed
 *     - inventory.lookup.bulk
 *
 * Assumed inventory shape (minimal):
 * {
 *   id: string,
 *   name: string,
 *   nameLower?: string,       // optional index helper
 *   sku?: string,
 *   tags?: string[],
 *   location?: string,
 *   quantity: number,
 *   unit?: string,
 *   minThreshold?: number,
 *   domain?: "cooking"|"cleaning"|"garden"|"animals"|"preservation"|"storehouse",
 *   updatedAt?: string
 * }
 */

import { emit } from "@/services/eventBus"; // guarded usage below

/* ------------------------------- Soft DB load ------------------------------- */

/**
 * Try to import your Dexie DB from a few common locations.
 * Adjust/add paths here to match your actual project.
 */
let _dbPromise = null;

async function getDb() {
  if (_dbPromise) return _dbPromise;

  _dbPromise = (async () => {
    const candidates = [
      "@/services/db",
      "@/db",
      "@/data/db",
    ];

    for (const path of candidates) {
      try {
        const mod = await import(/* @vite-ignore */ path);
        const db = mod?.default || mod?.db || mod;
        if (db && typeof db === "object") return db;
      } catch {
        // keep trying
      }
    }

    console.warn("[inventory.lookup] Dexie DB not found; returning null");
    return null;
  })();

  return _dbPromise;
}

/**
 * Try to get an inventory-like table from the DB.
 * Supports a few expected table names.
 */
async function getInventoryTable() {
  const db = await getDb();
  if (!db) return null;

  // Prefer explicit inventory, then storehouse-like tables
  const candidates = [
    db.inventory,
    db.storehouse,
    db.storehouseItems,
  ];
  for (const t of candidates) {
    if (t && typeof t.where === "function") return t;
  }

  // Last resort: scan db.tables
  if (Array.isArray(db.tables)) {
    const inv = db.tables.find((t) => /inventory|storehouse/i.test(t.name || ""));
    if (inv) return inv;
  }

  console.warn("[inventory.lookup] No inventory-like table found on DB");
  return null;
}

/* --------------------------------- Caching --------------------------------- */

const CACHE_TTL_MS = 15_000; // 15 seconds

/** @type {Map<string, { value:any, expiresAt:number }>} */
const cache = new Map();

function cacheKey(parts) {
  return parts.filter(Boolean).join("::");
}

function setCache(key, value) {
  cache.set(key, {
    value,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

function getCache(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

/* --------------------------------- Lookups --------------------------------- */

/**
 * Fast lookup by inventory id.
 * @param {string} id
 * @returns {Promise<any|null>}
 */
export async function lookupById(id) {
  const key = cacheKey(["id", id]);
  const cached = getCache(key);
  if (cached !== null) return cached;

  if (!id) return null;
  const table = await getInventoryTable();
  if (!table) return null;

  let item = null;
  try {
    item = await table.get(id);
  } catch (err) {
    console.warn("[inventory.lookup] lookupById failed:", err);
    item = null;
  }

  if (item) {
    setCache(key, item);
  }

  emitLookupEvent("inventory.lookup.performed", { mode: "id", hits: item ? 1 : 0 });
  return item;
}

/**
 * Fast lookup by SKU (assumes indexed or at least a field `sku`).
 * @param {string} sku
 * @returns {Promise<any|null>}
 */
export async function lookupBySku(sku) {
  const s = (sku || "").trim();
  if (!s) return null;

  const key = cacheKey(["sku", s]);
  const cached = getCache(key);
  if (cached !== null) return cached;

  const table = await getInventoryTable();
  if (!table) return null;

  let item = null;
  try {
    // Prefer indexed where if available
    if (table.schema?.idxByName?.includes("sku") || table.schema?.indexes?.some?.((i) => i.src === "sku")) {
      item = await table.where("sku").equalsIgnoreCase(s).first();
    } else {
      item = await table.filter((row) => (row.sku || "").toLowerCase() === s.toLowerCase()).first();
    }
  } catch (err) {
    console.warn("[inventory.lookup] lookupBySku failed:", err);
    item = null;
  }

  if (item) {
    setCache(key, item);
  }

  emitLookupEvent("inventory.lookup.performed", { mode: "sku", hits: item ? 1 : 0 });
  return item;
}

/**
 * Fuzzy-ish lookup by name.
 * - Normalizes case
 * - Checks name and nameLower fields
 * - Optional domain filter
 *
 * @param {string} name
 * @param {{ limit?:number, domain?:string }} [options]
 * @returns {Promise<any[]>}
 */
export async function lookupByName(name, options = {}) {
  const needle = norm(name);
  if (!needle) return [];

  const limit = options.limit && options.limit > 0 ? options.limit : 20;
  const domainFilter = options.domain || null;

  const key = cacheKey(["name", needle, domainFilter || "all", limit]);
  const cached = getCache(key);
  if (cached !== null) return cached;

  const table = await getInventoryTable();
  if (!table) return [];

  let rows = [];
  try {
    // If we have a nameLower index, use that.
    const hasNameLowerIdx =
      table.schema?.idxByName?.includes("nameLower") ||
      table.schema?.indexes?.some?.((i) => i.src === "nameLower");

    if (hasNameLowerIdx) {
      rows = await table
        .where("nameLower")
        .startsWithIgnoreCase(needle)
        .limit(limit)
        .toArray();
    } else {
      // Fallback: full scan with filter (slower, but safe).
      rows = await table
        .filter((row) => {
          const n = norm(row.name || row.label || "");
          if (!n) return false;
          if (!n.includes(needle)) return false;
          if (domainFilter && row.domain && row.domain !== domainFilter) return false;
          return true;
        })
        .limit(limit)
        .toArray();
    }
  } catch (err) {
    console.warn("[inventory.lookup] lookupByName failed:", err);
    rows = [];
  }

  setCache(key, rows);
  emitLookupEvent("inventory.lookup.performed", { mode: "name", hits: rows.length });
  return rows;
}

/**
 * Bulk lookup by ids.
 * Uses cache where possible, and DB for missing ids.
 *
 * @param {string[]} ids
 * @returns {Promise<any[]>}
 */
export async function lookupManyByIds(ids = []) {
  const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
  if (!uniqueIds.length) return [];

  const results = [];
  const missing = [];

  for (const id of uniqueIds) {
    const key = cacheKey(["id", id]);
    const cached = getCache(key);
    if (cached !== null) {
      results.push(cached);
    } else {
      missing.push(id);
    }
  }

  if (missing.length) {
    const table = await getInventoryTable();
    if (!table) return results;

    try {
      const fetched = await table.bulkGet(missing);
      for (let i = 0; i < missing.length; i++) {
        const id = missing[i];
        const item = fetched[i];
        if (item) {
          const ck = cacheKey(["id", id]);
          setCache(ck, item);
          results.push(item);
        }
      }
    } catch (err) {
      console.warn("[inventory.lookup] lookupManyByIds bulkGet failed:", err);
    }
  }

  emitLookupEvent("inventory.lookup.bulk", { mode: "id", inCount: uniqueIds.length, outCount: results.length });
  return results;
}

/**
 * Search inventory with a flexible filter:
 * - text: substring match on name / tags / sku
 * - tags: all tags must be present
 * - domain: cooking|cleaning|...
 * - location: storage location filter
 * - lowStockOnly: items where quantity < minThreshold
 *
 * @param {{
 *   text?: string,
 *   tags?: string[],
 *   domain?: string,
 *   location?: string,
 *   lowStockOnly?: boolean,
 *   limit?: number
 * }} [query]
 * @returns {Promise<any[]>}
 */
export async function searchInventory(query = {}) {
  const {
    text,
    tags = [],
    domain,
    location,
    lowStockOnly = false,
    limit = 50,
  } = query;

  const table = await getInventoryTable();
  if (!table) return [];

  const textNorm = norm(text || "");
  const tagNorms = tags.map(norm).filter(Boolean);
  const locNorm = norm(location || "");
  const dom = domain || null;

  let rows = [];

  try {
    rows = await table
      .filter((row) => {
        if (dom && row.domain && row.domain !== dom) return false;

        if (locNorm) {
          const rowLoc = norm(row.location || "");
          if (rowLoc !== locNorm) return false;
        }

        if (lowStockOnly) {
          const qty = Number(row.quantity || 0);
          const min = Number(row.minThreshold || 0);
          if (!(min > 0 && qty < min)) return false;
        }

        if (tagNorms.length) {
          const rowTags = (row.tags || []).map(norm);
          const hasAll = tagNorms.every((t) => rowTags.includes(t));
          if (!hasAll) return false;
        }

        if (textNorm) {
          const n = norm(row.name || "");
          const sku = norm(row.sku || "");
          const tagsJoined = norm((row.tags || []).join(" "));
          if (!n.includes(textNorm) && !sku.includes(textNorm) && !tagsJoined.includes(textNorm)) {
            return false;
          }
        }

        return true;
      })
      .limit(limit)
      .toArray();
  } catch (err) {
    console.warn("[inventory.lookup] searchInventory failed:", err);
    rows = [];
  }

  emitLookupEvent("inventory.lookup.performed", {
    mode: "search",
    hits: rows.length,
  });
  return rows;
}

/**
 * Helper for cooking sessions:
 * Given normalized ingredient rows, check availability.
 * Returns:
 *  - matches: [{ ingredient, matches:[items], best?:item }]
 *  - missing: [ingredientName]
 *
 * @param {Array<{name:string, qty?:number, unit?:string}>} ingredients
 * @param {{ domain?:string, limitPerIngredient?:number }} [options]
 */
export async function lookupIngredientAvailability(ingredients = [], options = {}) {
  const domain = options.domain || "cooking";
  const limit = options.limitPerIngredient || 5;

  const matches = [];
  const missing = [];

  for (const ing of ingredients) {
    const name = ing?.name;
    if (!name) continue;

    const rows = await lookupByName(name, { domain, limit });
    if (!rows.length) {
      missing.push(name);
      continue;
    }

    // naive "best" pick: highest quantity
    const best = rows.reduce((a, b) => (Number(b.quantity || 0) > Number(a.quantity || 0) ? b : a), rows[0]);

    matches.push({
      ingredient: ing,
      matches: rows,
      best,
    });
  }

  emitLookupEvent("inventory.lookup.performed", {
    mode: "ingredientAvailability",
    hits: matches.length,
    missing: missing.length,
  });

  return { matches, missing };
}

/* --------------------------------- Events ---------------------------------- */

function emitLookupEvent(type, data) {
  try {
    emit?.({
      type,
      ts: new Date().toISOString(),
      source: "inventory.lookup",
      data,
    });
  } catch {
    // ignore
  }
}

/* --------------------------------- Utils ----------------------------------- */

function norm(s) {
  return String(s || "").toLowerCase().trim();
}
function cleanSpace(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

/* --------------------------------- Export ---------------------------------- */

export default {
  lookupById,
  lookupBySku,
  lookupByName,
  lookupManyByIds,
  searchInventory,
  lookupIngredientAvailability,
};
