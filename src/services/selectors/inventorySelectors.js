// File: src/services/selectors/inventorySelectors.js
/**
 * inventorySelectors
 * -----------------------------------------------------------------------------
 * Production-ready selector layer for SSA inventory (Dexie-backed).
 *
 * Goals
 *  - Zero-UI, service-safe inventory querying & aggregation
 *  - Works even if table naming differs (inventory vs inventoryItems vs inventory_items)
 *  - Provides:
 *      • basic CRUD lookups (read-only)
 *      • search + filtering + pagination
 *      • low stock / out of stock / expiring soon
 *      • grouping (by category/location/unit)
 *      • KPI aggregates (for dashboards)
 *
 * Notes
 *  - This module is intentionally read-only. Committing changes belongs in services.
 *  - It assumes a Dexie db export at: src/services/db.js
 */

import db from "@/services/db";
import { liveQuery } from "dexie";

/* -----------------------------------------------------------------------------
 * Constants / Defaults
 * -------------------------------------------------------------------------- */

const DEFAULTS = Object.freeze({
  limit: 100,
  offset: 0,
  sortBy: "name", // name | updatedAt | createdAt | qty | expiresAt | category | location
  sortDir: "asc", // asc | desc
  expiringWithinDays: 14,
  lowStockMode: "lteReorderPoint", // lteReorderPoint | belowPar | custom
  now: () => Date.now(),
});

const TABLE_CANDIDATES = [
  "inventory",
  "inventoryItems",
  "inventory_items",
  "storehouse",
  "pantry",
];

/* -----------------------------------------------------------------------------
 * Table Resolution (robust to schema naming)
 * -------------------------------------------------------------------------- */

/**
 * @param {any} dexieDb
 * @returns {import("dexie").Table|null}
 */
function resolveInventoryTable(dexieDb) {
  if (!dexieDb) return null;
  for (const key of TABLE_CANDIDATES) {
    if (dexieDb[key] && typeof dexieDb[key].toCollection === "function")
      return dexieDb[key];
  }
  // Fallback: scan for a table that "looks" like inventory (best-effort)
  try {
    const tables = dexieDb.tables || [];
    const match =
      tables.find((t) => /inventory|storehouse|pantry/i.test(t?.name || "")) ||
      tables.find((t) => /item/i.test(t?.name || ""));
    return match || null;
  } catch {
    return null;
  }
}

function invTable() {
  const t = resolveInventoryTable(db);
  if (!t) {
    const known = (db?.tables || []).map((x) => x?.name).filter(Boolean);
    throw new Error(
      `inventorySelectors: No inventory table found. Tried: ${TABLE_CANDIDATES.join(
        ", "
      )}. Known tables: ${known.join(", ")}`
    );
  }
  return t;
}

/* -----------------------------------------------------------------------------
 * Normalization helpers
 * -------------------------------------------------------------------------- */

function isFiniteNumber(x) {
  return typeof x === "number" && Number.isFinite(x);
}

function toLowerSafe(s) {
  return typeof s === "string" ? s.toLowerCase() : "";
}

function normalizeText(s) {
  return toLowerSafe(String(s || "")).trim();
}

function normalizeUnit(unit) {
  const u = normalizeText(unit);
  if (!u) return "";
  // keep SSA flexible; just normalize common variants
  const map = {
    lbs: "lb",
    pound: "lb",
    pounds: "lb",
    ozs: "oz",
    ounces: "oz",
    grams: "g",
    kilogram: "kg",
    kilograms: "kg",
    liters: "l",
    litre: "l",
    litres: "l",
    milliliters: "ml",
    millilitres: "ml",
    each: "ea",
    unit: "ea",
    units: "ea",
    count: "ea",
    pc: "ea",
    pcs: "ea",
    piece: "ea",
    pieces: "ea",
  };
  return map[u] || u;
}

function normalizeDateValue(v) {
  // supports: epoch ms, ISO string, Date
  if (!v) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const ms = Date.parse(String(v));
  return Number.isFinite(ms) ? ms : null;
}

function safeQty(item) {
  const q = item?.qty ?? item?.quantity ?? item?.onHand ?? item?.stock ?? 0;
  return isFiniteNumber(q) ? q : Number(q) || 0;
}

function safeReorderPoint(item) {
  const rp =
    item?.reorderPoint ?? item?.reorder_point ?? item?.minQty ?? item?.min_qty;
  if (rp == null) return null;
  return isFiniteNumber(rp) ? rp : Number(rp);
}

function safePar(item) {
  const p =
    item?.parLevel ?? item?.par_level ?? item?.targetQty ?? item?.target_qty;
  if (p == null) return null;
  return isFiniteNumber(p) ? p : Number(p);
}

function safeUpdatedAt(item) {
  return normalizeDateValue(
    item?.updatedAt ??
      item?.updated_at ??
      item?.lastUpdated ??
      item?.last_updated
  );
}

function safeCreatedAt(item) {
  return normalizeDateValue(
    item?.createdAt ?? item?.created_at ?? item?.created ?? item?.createdOn
  );
}

function safeName(item) {
  return String(item?.name ?? item?.label ?? item?.title ?? "").trim();
}

function safeCategory(item) {
  return String(item?.category ?? item?.group ?? item?.type ?? "").trim();
}

function safeLocation(item) {
  const loc =
    item?.location ??
    item?.storageLocation ??
    item?.storage_location ??
    item?.zone ??
    item?.area ??
    "";
  return String(loc || "").trim();
}

function safeExpiresAt(item) {
  return normalizeDateValue(
    item?.expiresAt ?? item?.expires_at ?? item?.exp ?? item?.expiry
  );
}

function safePrice(item) {
  const p =
    item?.price ??
    item?.unitPrice ??
    item?.unit_price ??
    item?.avgPrice ??
    item?.avg_price;
  if (p == null) return null;
  const n = isFiniteNumber(p) ? p : Number(p);
  return Number.isFinite(n) ? n : null;
}

function safeSku(item) {
  return String(item?.sku ?? item?.upc ?? item?.barcode ?? "").trim();
}

function pickSearchFields(item) {
  const parts = [
    safeName(item),
    safeSku(item),
    safeCategory(item),
    safeLocation(item),
    ...(Array.isArray(item?.tags) ? item.tags : []),
    ...(Array.isArray(item?.aliases) ? item.aliases : []),
  ].filter(Boolean);
  return normalizeText(parts.join(" "));
}

/* -----------------------------------------------------------------------------
 * Sorting
 * -------------------------------------------------------------------------- */

function sortItems(items, sortBy, sortDir) {
  const dir = String(sortDir || "asc").toLowerCase() === "desc" ? -1 : 1;

  const getter = (() => {
    switch (sortBy) {
      case "updatedAt":
        return (x) => safeUpdatedAt(x) ?? 0;
      case "createdAt":
        return (x) => safeCreatedAt(x) ?? 0;
      case "qty":
        return (x) => safeQty(x);
      case "expiresAt":
        return (x) => safeExpiresAt(x) ?? Number.MAX_SAFE_INTEGER;
      case "category":
        return (x) => normalizeText(safeCategory(x));
      case "location":
        return (x) => normalizeText(safeLocation(x));
      case "name":
      default:
        return (x) => normalizeText(safeName(x));
    }
  })();

  return [...items].sort((a, b) => {
    const av = getter(a);
    const bv = getter(b);
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    // stable tie-breaker
    const an = normalizeText(safeName(a));
    const bn = normalizeText(safeName(b));
    if (an < bn) return -1 * dir;
    if (an > bn) return 1 * dir;
    return 0;
  });
}

/* -----------------------------------------------------------------------------
 * Filters
 * -------------------------------------------------------------------------- */

function matchesTextQuery(item, q) {
  const qq = normalizeText(q);
  if (!qq) return true;
  const hay = pickSearchFields(item);
  return hay.includes(qq);
}

function matchesTags(item, tags = []) {
  const wanted = (tags || []).map(normalizeText).filter(Boolean);
  if (!wanted.length) return true;
  const itags = Array.isArray(item?.tags) ? item.tags.map(normalizeText) : [];
  if (!itags.length) return false;
  return wanted.every((t) => itags.includes(t));
}

function matchesCategory(item, category) {
  const c = normalizeText(category);
  if (!c) return true;
  return normalizeText(safeCategory(item)) === c;
}

function matchesLocation(item, location) {
  const l = normalizeText(location);
  if (!l) return true;
  return normalizeText(safeLocation(item)) === l;
}

function matchesUnits(item, units = []) {
  const wanted = (units || []).map(normalizeUnit).filter(Boolean);
  if (!wanted.length) return true;
  const u = normalizeUnit(item?.unit ?? item?.uom ?? item?.UOM);
  if (!u) return false;
  return wanted.includes(u);
}

function matchesArchived(item, includeArchived) {
  // common patterns: archived, isArchived, deleted, isDeleted
  const archived = !!(
    item?.archived ??
    item?.isArchived ??
    item?.deleted ??
    item?.isDeleted
  );
  return includeArchived ? true : !archived;
}

function isExpiringWithin(item, withinDays, nowMs) {
  const exp = safeExpiresAt(item);
  if (!exp) return false;
  const ms = withinDays * 24 * 60 * 60 * 1000;
  return exp <= nowMs + ms;
}

function isExpired(item, nowMs) {
  const exp = safeExpiresAt(item);
  if (!exp) return false;
  return exp < nowMs;
}

function isOutOfStock(item) {
  return safeQty(item) <= 0;
}

function isLowStock(item, mode = DEFAULTS.lowStockMode, customThreshold) {
  const qty = safeQty(item);

  if (mode === "custom") {
    const t = Number(customThreshold);
    if (!Number.isFinite(t)) return false;
    return qty <= t;
  }

  if (mode === "belowPar") {
    const par = safePar(item);
    if (par == null || !Number.isFinite(par)) return false;
    return qty < par;
  }

  // default: lteReorderPoint
  const rp = safeReorderPoint(item);
  if (rp == null || !Number.isFinite(rp)) return false;
  return qty <= rp;
}

/* -----------------------------------------------------------------------------
 * Core selectors (async)
 * -------------------------------------------------------------------------- */

/**
 * Read by primary key.
 * @param {string|number} id
 */
export async function getInventoryItemById(id) {
  if (id == null) return null;
  return await invTable().get(id);
}

/**
 * Read by barcode/sku/upc (best-effort).
 * @param {string} code
 */
export async function getInventoryItemByCode(code) {
  const q = String(code || "").trim();
  if (!q) return null;

  const table = invTable();

  // Try indexed searches first if fields exist; fallback to full scan.
  try {
    // Dexie won't error on "where" if index isn't there? It will.
    // So we guard by checking schema/indexes.
    const idx = table?.schema?.idxByName || {};
    const hasIndex = (name) => !!idx?.[name];

    if (hasIndex("upc")) {
      const hit = await table.where("upc").equals(q).first();
      if (hit) return hit;
    }
    if (hasIndex("barcode")) {
      const hit = await table.where("barcode").equals(q).first();
      if (hit) return hit;
    }
    if (hasIndex("sku")) {
      const hit = await table.where("sku").equals(q).first();
      if (hit) return hit;
    }

    // Fall through to scan
  } catch {
    // ignore, fall back
  }

  const all = await table.toArray();
  const hit = all.find((it) => safeSku(it) === q);
  return hit || null;
}

/**
 * Generic list with filters + pagination.
 *
 * @param {object} opts
 * @param {string} [opts.query]
 * @param {string} [opts.category]
 * @param {string} [opts.location]
 * @param {string[]} [opts.tags]
 * @param {string[]} [opts.units]
 * @param {boolean} [opts.includeArchived]
 * @param {number} [opts.limit]
 * @param {number} [opts.offset]
 * @param {string} [opts.sortBy]
 * @param {string} [opts.sortDir]
 * @returns {Promise<{ items:any[], total:number }>}
 */
export async function listInventory(opts = {}) {
  const {
    query,
    category,
    location,
    tags,
    units,
    includeArchived = false,
    limit = DEFAULTS.limit,
    offset = DEFAULTS.offset,
    sortBy = DEFAULTS.sortBy,
    sortDir = DEFAULTS.sortDir,
  } = opts;

  const table = invTable();

  // For flexibility across schemas, do a collection scan and filter in memory.
  // Inventory volumes are typically manageable; for very large volumes, introduce
  // indexed query plans in a dedicated selector file.
  const all = await table.toArray();

  const filtered = all
    .filter((it) => matchesArchived(it, includeArchived))
    .filter((it) => matchesCategory(it, category))
    .filter((it) => matchesLocation(it, location))
    .filter((it) => matchesTags(it, tags))
    .filter((it) => matchesUnits(it, units))
    .filter((it) => matchesTextQuery(it, query));

  const sorted = sortItems(filtered, sortBy, sortDir);

  const total = sorted.length;
  const start = Math.max(0, Number(offset) || 0);
  const end = start + Math.max(0, Number(limit) || 0);
  const items = sorted.slice(start, end);

  return { items, total };
}

/**
 * List items that are low stock.
 * @param {object} opts
 * @param {"lteReorderPoint"|"belowPar"|"custom"} [opts.mode]
 * @param {number} [opts.customThreshold]
 * @param {boolean} [opts.includeArchived]
 * @param {string} [opts.category]
 * @param {string} [opts.location]
 * @param {string} [opts.sortBy]
 * @param {string} [opts.sortDir]
 */
export async function listLowStock(opts = {}) {
  const {
    mode = DEFAULTS.lowStockMode,
    customThreshold,
    includeArchived = false,
    category,
    location,
    sortBy = "qty",
    sortDir = "asc",
  } = opts;

  const all = await invTable().toArray();

  const items = all
    .filter((it) => matchesArchived(it, includeArchived))
    .filter((it) => matchesCategory(it, category))
    .filter((it) => matchesLocation(it, location))
    .filter((it) => !isOutOfStock(it))
    .filter((it) => isLowStock(it, mode, customThreshold));

  return sortItems(items, sortBy, sortDir);
}

/**
 * List out-of-stock items.
 */
export async function listOutOfStock(opts = {}) {
  const {
    includeArchived = false,
    category,
    location,
    sortBy = "name",
    sortDir = "asc",
  } = opts;
  const all = await invTable().toArray();
  const items = all
    .filter((it) => matchesArchived(it, includeArchived))
    .filter((it) => matchesCategory(it, category))
    .filter((it) => matchesLocation(it, location))
    .filter(isOutOfStock);

  return sortItems(items, sortBy, sortDir);
}

/**
 * List items expiring within N days.
 * @param {object} opts
 * @param {number} [opts.withinDays]
 * @param {boolean} [opts.includeExpired]
 * @param {boolean} [opts.includeArchived]
 * @param {string} [opts.category]
 * @param {string} [opts.location]
 */
export async function listExpiringSoon(opts = {}) {
  const {
    withinDays = DEFAULTS.expiringWithinDays,
    includeExpired = true,
    includeArchived = false,
    category,
    location,
    sortBy = "expiresAt",
    sortDir = "asc",
    nowMs = DEFAULTS.now(),
  } = opts;

  const all = await invTable().toArray();

  const items = all
    .filter((it) => matchesArchived(it, includeArchived))
    .filter((it) => matchesCategory(it, category))
    .filter((it) => matchesLocation(it, location))
    .filter((it) => {
      const exp = safeExpiresAt(it);
      if (!exp) return false;
      if (!includeExpired && exp < nowMs) return false;
      return isExpiringWithin(it, withinDays, nowMs);
    });

  return sortItems(items, sortBy, sortDir);
}

/**
 * List expired items only.
 */
export async function listExpired(opts = {}) {
  const {
    includeArchived = false,
    category,
    location,
    sortBy = "expiresAt",
    sortDir = "asc",
    nowMs = DEFAULTS.now(),
  } = opts;

  const all = await invTable().toArray();
  const items = all
    .filter((it) => matchesArchived(it, includeArchived))
    .filter((it) => matchesCategory(it, category))
    .filter((it) => matchesLocation(it, location))
    .filter((it) => isExpired(it, nowMs));

  return sortItems(items, sortBy, sortDir);
}

/**
 * Generate "shopping candidates" (commonly used for KPIs):
 *  - out of stock OR low stock (based on reorder point / par)
 */
export async function listShoppingCandidates(opts = {}) {
  const {
    lowStockMode = DEFAULTS.lowStockMode,
    customThreshold,
    includeArchived = false,
    category,
    location,
    sortBy = "qty",
    sortDir = "asc",
  } = opts;

  const all = await invTable().toArray();
  const items = all
    .filter((it) => matchesArchived(it, includeArchived))
    .filter((it) => matchesCategory(it, category))
    .filter((it) => matchesLocation(it, location))
    .filter(
      (it) => isOutOfStock(it) || isLowStock(it, lowStockMode, customThreshold)
    );

  return sortItems(items, sortBy, sortDir);
}

/* -----------------------------------------------------------------------------
 * Grouping / Aggregation
 * -------------------------------------------------------------------------- */

function groupByKey(items, keyFn) {
  /** @type {Record<string, any[]>} */
  const out = {};
  for (const it of items || []) {
    const k = String(keyFn(it) ?? "").trim() || "(Unspecified)";
    if (!out[k]) out[k] = [];
    out[k].push(it);
  }
  return out;
}

function summarizeGroup(items) {
  const totalQty = (items || []).reduce((sum, it) => sum + safeQty(it), 0);
  const uniqueUnits = Array.from(
    new Set(
      (items || [])
        .map((it) => normalizeUnit(it?.unit ?? it?.uom ?? it?.UOM))
        .filter(Boolean)
    )
  );
  const value = (items || []).reduce((sum, it) => {
    const p = safePrice(it);
    const q = safeQty(it);
    if (p == null) return sum;
    return sum + p * q;
  }, 0);

  return {
    count: (items || []).length,
    totalQty,
    units: uniqueUnits,
    estimatedValue: value,
  };
}

/**
 * Group inventory by category.
 */
export async function groupInventoryByCategory(opts = {}) {
  const { includeArchived = false } = opts;
  const all = await invTable().toArray();
  const items = all.filter((it) => matchesArchived(it, includeArchived));
  const grouped = groupByKey(items, safeCategory);

  /** @type {Array<{ key:string, items:any[], summary:any }>} */
  const rows = Object.keys(grouped)
    .sort((a, b) => normalizeText(a).localeCompare(normalizeText(b)))
    .map((k) => ({
      key: k,
      items: grouped[k],
      summary: summarizeGroup(grouped[k]),
    }));

  return rows;
}

/**
 * Group inventory by location.
 */
export async function groupInventoryByLocation(opts = {}) {
  const { includeArchived = false } = opts;
  const all = await invTable().toArray();
  const items = all.filter((it) => matchesArchived(it, includeArchived));
  const grouped = groupByKey(items, safeLocation);

  const rows = Object.keys(grouped)
    .sort((a, b) => normalizeText(a).localeCompare(normalizeText(b)))
    .map((k) => ({
      key: k,
      items: grouped[k],
      summary: summarizeGroup(grouped[k]),
    }));

  return rows;
}

/**
 * Group inventory by normalized unit (UOM).
 */
export async function groupInventoryByUnit(opts = {}) {
  const { includeArchived = false } = opts;
  const all = await invTable().toArray();
  const items = all.filter((it) => matchesArchived(it, includeArchived));
  const grouped = groupByKey(items, (it) =>
    normalizeUnit(it?.unit ?? it?.uom ?? it?.UOM)
  );

  const rows = Object.keys(grouped)
    .sort((a, b) => normalizeText(a).localeCompare(normalizeText(b)))
    .map((k) => ({
      key: k,
      items: grouped[k],
      summary: summarizeGroup(grouped[k]),
    }));

  return rows;
}

/**
 * Dashboard KPI bundle for Inventory.
 *
 * @param {object} opts
 * @param {boolean} [opts.includeArchived]
 * @param {number} [opts.expiringWithinDays]
 * @param {"lteReorderPoint"|"belowPar"|"custom"} [opts.lowStockMode]
 * @param {number} [opts.customThreshold]
 * @param {number} [opts.nowMs]
 */
export async function getInventoryKPIs(opts = {}) {
  const {
    includeArchived = false,
    expiringWithinDays = DEFAULTS.expiringWithinDays,
    lowStockMode = DEFAULTS.lowStockMode,
    customThreshold,
    nowMs = DEFAULTS.now(),
  } = opts;

  const allRaw = await invTable().toArray();
  const all = allRaw.filter((it) => matchesArchived(it, includeArchived));

  const totalCount = all.length;
  const outOfStockCount = all.filter(isOutOfStock).length;
  const lowStockCount = all.filter(
    (it) => !isOutOfStock(it) && isLowStock(it, lowStockMode, customThreshold)
  ).length;
  const shoppingCandidateCount = all.filter(
    (it) => isOutOfStock(it) || isLowStock(it, lowStockMode, customThreshold)
  ).length;

  const expiringSoonCount = all.filter((it) =>
    isExpiringWithin(it, expiringWithinDays, nowMs)
  ).length;
  const expiredCount = all.filter((it) => isExpired(it, nowMs)).length;

  const uniqueCategories = new Set(
    all.map((it) => normalizeText(safeCategory(it))).filter(Boolean)
  ).size;
  const uniqueLocations = new Set(
    all.map((it) => normalizeText(safeLocation(it))).filter(Boolean)
  ).size;

  const estimatedValue = all.reduce((sum, it) => {
    const p = safePrice(it);
    if (p == null) return sum;
    return sum + p * safeQty(it);
  }, 0);

  // freshness: latest update timestamp
  const lastUpdatedAt =
    all.reduce((max, it) => Math.max(max, safeUpdatedAt(it) ?? 0), 0) || null;

  return {
    totalCount,
    outOfStockCount,
    lowStockCount,
    shoppingCandidateCount,
    expiringSoonCount,
    expiredCount,
    uniqueCategories,
    uniqueLocations,
    estimatedValue,
    lastUpdatedAt,
    generatedAt: nowMs,
  };
}

/* -----------------------------------------------------------------------------
 * “Live” selector factories (Dexie liveQuery)
 * -------------------------------------------------------------------------- */

/**
 * Use inside React with dexie-react-hooks or manually subscribe.
 * Example (dexie-react-hooks):
 *   const items = useLiveQuery(makeLiveInventoryList({ query: "beef" }), [], []);
 */
export function makeLiveInventoryList(opts = {}) {
  return () => liveQuery(() => listInventory(opts));
}

export function makeLiveInventoryKPIs(opts = {}) {
  return () => liveQuery(() => getInventoryKPIs(opts));
}

export function makeLiveShoppingCandidates(opts = {}) {
  return () => liveQuery(() => listShoppingCandidates(opts));
}

export function makeLiveExpiringSoon(opts = {}) {
  return () => liveQuery(() => listExpiringSoon(opts));
}

/* -----------------------------------------------------------------------------
 * Convenience helpers (pure, no DB)
 * -------------------------------------------------------------------------- */

/**
 * Compute a human-friendly status for an inventory record (for chips/badges).
 * @param {any} item
 * @param {object} [opts]
 * @param {number} [opts.expiringWithinDays]
 * @param {"lteReorderPoint"|"belowPar"|"custom"} [opts.lowStockMode]
 * @param {number} [opts.customThreshold]
 * @param {number} [opts.nowMs]
 */
export function computeInventoryStatus(item, opts = {}) {
  const {
    expiringWithinDays = DEFAULTS.expiringWithinDays,
    lowStockMode = DEFAULTS.lowStockMode,
    customThreshold,
    nowMs = DEFAULTS.now(),
  } = opts;

  if (!item) return { status: "unknown", flags: [] };

  const flags = [];
  const qty = safeQty(item);

  if (qty <= 0) flags.push("out_of_stock");
  else if (isLowStock(item, lowStockMode, customThreshold))
    flags.push("low_stock");

  const exp = safeExpiresAt(item);
  if (exp != null) {
    if (isExpired(item, nowMs)) flags.push("expired");
    else if (isExpiringWithin(item, expiringWithinDays, nowMs))
      flags.push("expiring_soon");
  }

  if (item?.needsReview || item?.needs_review) flags.push("needs_review");
  if (item?.needsReconcile || item?.needs_reconcile)
    flags.push("needs_reconcile");

  // choose primary status
  const status = flags.includes("expired")
    ? "expired"
    : flags.includes("out_of_stock")
    ? "out_of_stock"
    : flags.includes("low_stock")
    ? "low_stock"
    : flags.includes("expiring_soon")
    ? "expiring_soon"
    : "ok";

  return { status, flags };
}

/**
 * Create a stable, searchable string for an inventory record (useful for client-side search).
 * @param {any} item
 */
export function inventorySearchBlob(item) {
  return pickSearchFields(item);
}

/**
 * Normalize an inventory item into a lightweight card model for UI.
 * (Keeps the selector layer useful without coupling UI to schema.)
 * @param {any} item
 */
export function toInventoryCardModel(item) {
  if (!item) return null;
  return {
    id: item.id ?? item._id ?? item.key ?? item.uuid ?? null,
    name: safeName(item),
    qty: safeQty(item),
    unit: normalizeUnit(item?.unit ?? item?.uom ?? item?.UOM),
    category: safeCategory(item),
    location: safeLocation(item),
    expiresAt: safeExpiresAt(item),
    reorderPoint: safeReorderPoint(item),
    parLevel: safePar(item),
    price: safePrice(item),
    sku: safeSku(item),
    tags: Array.isArray(item?.tags) ? item.tags : [],
    updatedAt: safeUpdatedAt(item),
    createdAt: safeCreatedAt(item),
  };
}

/* -----------------------------------------------------------------------------
 * Back-compat context selector (expected by agent shims)
 * -------------------------------------------------------------------------- */

/**
 * selectInventoryContext(opts)
 * ---------------------------------------------------------------------------
 * Back-compat export expected by shims such as:
 *   import { selectInventoryContext } from "@/services/selectors/inventorySelectors";
 *
 * Returns a compact, stable "inventory context" object suitable for:
 * - prompting (reasoner/shims)
 * - UI summaries
 * - logging
 *
 * This is intentionally tolerant:
 * - never throws (returns a safe empty context on failure)
 * - keeps payload sizes bounded (top-N lists only)
 *
 * @param {object} [opts]
 * @param {string|number|null} [opts.householdId]
 * @param {string|number|null} [opts.groupId]
 * @param {boolean} [opts.includeArchived]
 * @param {number} [opts.sampleLimit]        - how many items to include per list
 * @param {"lteReorderPoint"|"belowPar"|"custom"} [opts.lowStockMode]
 * @param {number} [opts.customThreshold]
 * @param {number} [opts.expiringWithinDays]
 * @param {number} [opts.nowMs]
 */
export async function selectInventoryContext(opts = {}) {
  const {
    householdId = null,
    groupId = null,
    includeArchived = false,
    sampleLimit = 12,
    lowStockMode = DEFAULTS.lowStockMode,
    customThreshold,
    expiringWithinDays = DEFAULTS.expiringWithinDays,
    nowMs = DEFAULTS.now(),
  } = opts;

  const safeEmpty = {
    domain: "inventory",
    householdId,
    groupId,
    kpis: {
      totalCount: 0,
      outOfStockCount: 0,
      lowStockCount: 0,
      shoppingCandidateCount: 0,
      expiringSoonCount: 0,
      expiredCount: 0,
      uniqueCategories: 0,
      uniqueLocations: 0,
      estimatedValue: 0,
      lastUpdatedAt: null,
      generatedAt: nowMs,
    },
    samples: {
      recent: [],
      lowStock: [],
      outOfStock: [],
      expiringSoon: [],
      shoppingCandidates: [],
    },
    generatedAt: nowMs,
    _meta: { ok: false, source: "inventorySelectors.selectInventoryContext" },
  };

  try {
    const kpis = await getInventoryKPIs({
      includeArchived,
      expiringWithinDays,
      lowStockMode,
      customThreshold,
      nowMs,
    });

    // Recent items (by updatedAt desc)
    const recentRes = await listInventory({
      includeArchived,
      limit: Math.max(1, Number(sampleLimit) || 12),
      offset: 0,
      sortBy: "updatedAt",
      sortDir: "desc",
    });

    const lowStock = await listLowStock({
      includeArchived,
      mode: lowStockMode,
      customThreshold,
      sortBy: "qty",
      sortDir: "asc",
    });

    const outOfStock = await listOutOfStock({
      includeArchived,
      sortBy: "name",
      sortDir: "asc",
    });

    const expiringSoon = await listExpiringSoon({
      includeArchived,
      withinDays: expiringWithinDays,
      includeExpired: true,
      sortBy: "expiresAt",
      sortDir: "asc",
      nowMs,
    });

    const shoppingCandidates = await listShoppingCandidates({
      includeArchived,
      lowStockMode,
      customThreshold,
      sortBy: "qty",
      sortDir: "asc",
    });

    const take = (arr) =>
      (Array.isArray(arr) ? arr : [])
        .slice(0, Math.max(1, Number(sampleLimit) || 12))
        .map(toInventoryCardModel)
        .filter(Boolean);

    return {
      domain: "inventory",
      householdId,
      groupId,
      kpis,
      samples: {
        recent: take(recentRes?.items || []),
        lowStock: take(lowStock),
        outOfStock: take(outOfStock),
        expiringSoon: take(expiringSoon),
        shoppingCandidates: take(shoppingCandidates),
      },
      generatedAt: nowMs,
      _meta: { ok: true, source: "inventorySelectors.selectInventoryContext" },
    };
  } catch (e) {
    return {
      ...safeEmpty,
      _meta: {
        ok: false,
        source: "inventorySelectors.selectInventoryContext",
        error: e?.message || String(e),
      },
    };
  }
}
