// File: src/db/selectors.js
/**
 * SSA Dexie Selectors
 * -----------------------------------------------------------------------------
 * Purpose:
 *  - Centralize safe, defensive, "query-only" helpers for reading from Dexie.
 *  - Keep UI/hooks/services from re-implementing ad-hoc Dexie queries everywhere.
 *  - Provide stable selector contracts even as DB versions evolve.
 *
 * Design goals:
 *  - No writes here (read-only selectors).
 *  - Defensive: returns sane defaults when tables/indexes aren't present.
 *  - Works whether a table is a Dexie.Table or undefined (older DB versions).
 *  - Avoids importing Node-only modules (browser-safe).
 *
 * Assumptions (conservative):
 *  - Your Dexie instance is exported from "@/services/db" (common in your repo).
 *    If your actual path differs, update the import below ONLY.
 *
 * Usage:
 *  import * as selectors from "@/db/selectors";
 *  const kpis = await selectors.getHomeKpis();
 */

import db from "@/services/db";

/* -------------------------------------------------------------------------------------------------
 * Utilities
 * ------------------------------------------------------------------------------------------------- */

const nowISO = () => new Date().toISOString();

function isFn(x) {
  return typeof x === "function";
}

function hasTable(name) {
  try {
    return !!db?.[name] && typeof db[name] === "object";
  } catch {
    return false;
  }
}

function table(name) {
  return hasTable(name) ? db[name] : null;
}

function safeLower(s) {
  return typeof s === "string" ? s.toLowerCase() : "";
}

function safeArray(x) {
  return Array.isArray(x) ? x : [];
}

function clamp(n, min, max) {
  const v = Number(n);
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}

function startOfDayISO(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function endOfDayISO(date = new Date()) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}

/**
 * Dexie-safe count:
 * - prefers table.where(index).equals(...).count() etc when supplied query builder
 * - falls back to table.count()
 */
async function safeCount(tbl, buildQueryFn) {
  try {
    if (!tbl) return 0;
    if (isFn(buildQueryFn)) {
      const q = buildQueryFn(tbl);
      if (q && isFn(q.count)) return await q.count();
    }
    if (isFn(tbl.count)) return await tbl.count();
    return 0;
  } catch {
    return 0;
  }
}

/**
 * Dexie-safe list:
 * - uses query builder when provided, else toArray()
 */
async function safeList(tbl, buildQueryFn, limit = null) {
  try {
    if (!tbl) return [];
    let q = null;
    if (isFn(buildQueryFn)) q = buildQueryFn(tbl);

    // If query builder returns a Collection with toArray
    if (q && isFn(q.toArray)) {
      const rows = await q.toArray();
      return typeof limit === "number" ? rows.slice(0, limit) : rows;
    }

    // Fallback
    if (isFn(tbl.toArray)) {
      const rows = await tbl.toArray();
      return typeof limit === "number" ? rows.slice(0, limit) : rows;
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Dexie-safe get by primary key
 */
async function safeGet(tbl, key) {
  try {
    if (!tbl || !isFn(tbl.get)) return null;
    return await tbl.get(key);
  } catch {
    return null;
  }
}

/**
 * Sort utility for records that may contain updatedAt/createdAt/ts fields.
 */
function sortByRecent(a, b) {
  const ta =
    Date.parse(a?.updatedAt || a?.createdAt || a?.ts || a?.at || 0) || 0;
  const tb =
    Date.parse(b?.updatedAt || b?.createdAt || b?.ts || b?.at || 0) || 0;
  return tb - ta;
}

/**
 * Attempts to identify "status" value consistently
 */
function normalizeStatus(x) {
  const s = safeLower(x);
  if (!s) return "";
  // common normalizations
  if (s === "pending_receipt" || s === "pending-receipt")
    return "pending_receipt";
  if (s === "needs_receipt" || s === "needs-receipt") return "pending_receipt";
  if (s === "pending" || s === "draft") return s;
  if (s === "complete" || s === "completed") return "completed";
  return s;
}

/* -------------------------------------------------------------------------------------------------
 * Core table-name discovery (minimal “introspection” without breaking)
 * ------------------------------------------------------------------------------------------------- */

/**
 * Because your DB is evolving (new tables, shims, bridges), we keep a very small
 * mapping layer for "likely names" of tables across versions.
 *
 * You can extend these arrays without breaking older versions.
 */
const TABLE_CANDIDATES = Object.freeze({
  // scan/compare/trust pipeline
  artifacts: ["artifacts"],
  parsedCandidates: ["parsed_candidates", "parsedCandidates"],
  methodMaps: ["method_maps", "methodMaps"],
  blueprints: ["blueprints"],
  layerOverrides: ["layer_overrides", "layerOverrides"],

  // shopping mode (common names)
  shoppingDrafts: [
    "shopping_drafts",
    "shoppingDrafts",
    "shopping_items",
    "shoppingItems",
  ],
  receipts: ["receipts", "receipt", "receipt_items", "receiptItems"],
  pricebook: ["pricebook", "prices", "priceBook"],
  coupons: ["coupons", "couponBook"],
  sessions: ["sessions", "sessionDrafts", "session_drafts"],
  mealPlans: ["mealPlans", "meal_plans"],
  inventory: ["inventory", "inventoryItems", "storehouse", "storehouseItems"],
  tasks: ["tasks", "taskItems"],
  notifications: ["notifications", "reminders", "alerts"],
});

/**
 * Resolve the first existing table among candidates.
 * @returns {import("dexie").Table | null}
 */
function resolveTable(candidateNames) {
  for (const name of safeArray(candidateNames)) {
    const t = table(name);
    if (t) return t;
  }
  return null;
}

/* -------------------------------------------------------------------------------------------------
 * Generic selectors
 * ------------------------------------------------------------------------------------------------- */

/**
 * List recent rows from a table.
 * @param {string|string[]} tableNames
 * @param {number} [limit=25]
 */
export async function listRecent(tableNames, limit = 25) {
  const t = resolveTable(Array.isArray(tableNames) ? tableNames : [tableNames]);
  const rows = await safeList(t);
  return rows.sort(sortByRecent).slice(0, clamp(limit, 0, 500));
}

/**
 * Find by id (primary key)
 * @param {string|string[]} tableNames
 * @param {any} id
 */
export async function getById(tableNames, id) {
  const t = resolveTable(Array.isArray(tableNames) ? tableNames : [tableNames]);
  return await safeGet(t, id);
}

/**
 * Simple text search (best-effort):
 * - loads a limited set and filters client-side (safe, index-agnostic)
 * - not intended for massive datasets
 *
 * @param {string|string[]} tableNames
 * @param {string} query
 * @param {object} [opts]
 * @param {number} [opts.limit=100]
 * @param {string[]} [opts.fields=["title","name","label","sku","id"]]
 */
export async function searchTable(tableNames, query, opts = {}) {
  const q = safeLower(query).trim();
  if (!q) return [];

  const limit = clamp(opts.limit ?? 100, 1, 1000);
  const fields = safeArray(opts.fields).length
    ? opts.fields
    : ["title", "name", "label", "sku", "id"];

  const t = resolveTable(Array.isArray(tableNames) ? tableNames : [tableNames]);
  const rows = await safeList(t, null, limit);

  return rows.filter((r) => fields.some((f) => safeLower(r?.[f]).includes(q)));
}

/**
 * getDomainContext(domain, opts?)
 * -----------------------------------------------------------------------------
 * Back-compat export expected by some agent shims:
 *   import { getDomainContext } from "@/db/selectors";
 *
 * Purpose:
 * - Provide a single, defensive "domain snapshot" the shims can use without
 *   needing to know table names.
 * - Read-only: safe defaults if tables/records don't exist.
 *
 * What it returns (stable shape):
 * {
 *   ts, domain,
 *   ids: { householdId, userId, groupId },
 *   range: { startISO, endISO, dateISO },
 *   kpis: { ...domain specific lightweight counts },
 *   recent: { ...domain specific recent items (bounded) }
 * }
 */
export async function getDomainContext(domain, opts = {}) {
  const d = safeLower(domain || "generic");

  const date = opts.date ? new Date(opts.date) : new Date();
  const dateISO = date.toISOString();

  const range = {
    startISO: opts.startISO ?? startOfDayISO(date),
    endISO: opts.endISO ?? endOfDayISO(date),
    dateISO,
  };

  const ids = {
    householdId: opts.householdId ?? opts.household?.id ?? null,
    userId: opts.userId ?? opts.user?.id ?? null,
    groupId: opts.groupId ?? null,
  };

  // Lightweight per-domain samples (bounded)
  const limit = clamp(opts.limit ?? 50, 0, 200);

  // Pre-resolve commonly used tables once (cheap + defensive)
  const tSessions = resolveTable(TABLE_CANDIDATES.sessions);
  const tInventory = resolveTable(TABLE_CANDIDATES.inventory);
  const tMealPlans = resolveTable(TABLE_CANDIDATES.mealPlans);
  const tShopping = resolveTable(TABLE_CANDIDATES.shoppingDrafts);
  const tReceipts = resolveTable(TABLE_CANDIDATES.receipts);
  const tTasks = resolveTable(TABLE_CANDIDATES.tasks);

  // Domain-aware KPI + recent items (keep extremely small)
  let kpis = {};
  let recent = {};

  if (d.includes("garden")) {
    // We don’t assume garden tables exist; shims mostly need household + schedule window.
    kpis = {
      sessionsToday: await countSessionsInRange(range.startISO, range.endISO),
    };
    recent = {
      sessions: (await safeList(tSessions, null, limit))
        .sort(sortByRecent)
        .slice(0, Math.min(25, limit)),
      tasks: (await safeList(tTasks, null, limit))
        .sort(sortByRecent)
        .slice(0, Math.min(25, limit)),
    };
  } else if (d.includes("animal")) {
    kpis = {
      sessionsToday: await countSessionsInRange(range.startISO, range.endISO),
    };
    recent = {
      sessions: (await safeList(tSessions, null, limit))
        .sort(sortByRecent)
        .slice(0, Math.min(25, limit)),
      tasks: (await safeList(tTasks, null, limit))
        .sort(sortByRecent)
        .slice(0, Math.min(25, limit)),
      inventory: (await safeList(tInventory, null, limit))
        .sort(sortByRecent)
        .slice(0, Math.min(25, limit)),
    };
  } else if (d.includes("meal") || d.includes("cook")) {
    kpis = {
      sessionsToday: await countSessionsInRange(range.startISO, range.endISO),
      mealPlans: (await safeCount(tMealPlans)) || 0,
    };
    recent = {
      mealPlans: (await safeList(tMealPlans, null, limit))
        .sort(sortByRecent)
        .slice(0, Math.min(25, limit)),
      inventory: (await safeList(tInventory, null, limit))
        .sort(sortByRecent)
        .slice(0, Math.min(25, limit)),
    };
  } else if (
    d.includes("shop") ||
    d.includes("scan") ||
    d.includes("receipt")
  ) {
    kpis = {
      candidatesWaitingForReceipt:
        await countShoppingCandidatesWaitingForReceipt(),
      receiptsPendingReconciliation: await countReceiptsPendingReconciliation(),
    };
    recent = {
      shoppingDrafts: (await safeList(tShopping, null, limit))
        .sort(sortByRecent)
        .slice(0, Math.min(25, limit)),
      receipts: (await safeList(tReceipts, null, limit))
        .sort(sortByRecent)
        .slice(0, Math.min(25, limit)),
    };
  } else {
    // generic snapshot
    kpis = {
      sessionsToday: await countSessionsInRange(range.startISO, range.endISO),
    };
    recent = {
      sessions: (await safeList(tSessions, null, limit))
        .sort(sortByRecent)
        .slice(0, Math.min(25, limit)),
    };
  }

  return {
    ts: nowISO(),
    domain: d,
    ids,
    range,
    kpis,
    recent,
  };
}

/* -------------------------------------------------------------------------------------------------
 * KPI selectors (Homepage / Shopping Mode / Receipts)
 * ------------------------------------------------------------------------------------------------- */

/**
 * KPI: "Shopping candidates waiting for receipt"
 * - In your pipeline, these might be "shopping drafts" or "items scanned" with a status.
 * - We attempt to count records with status in ["pending_receipt", "pending-receipt", "needs_receipt"].
 *
 * If no status field exists, we attempt:
 * - receiptId missing while has scan/meta
 */
export async function countShoppingCandidatesWaitingForReceipt() {
  const t = resolveTable(TABLE_CANDIDATES.shoppingDrafts);
  if (!t) return 0;

  // Prefer indexed where('status') if available; fallback to client-side.
  const preferred = await safeCount(t, (tbl) => {
    // Dexie where() throws if index missing; we guard in try/catch inside safeCount.
    return tbl
      .where("status")
      .anyOf(
        "pending_receipt",
        "pending-receipt",
        "needs_receipt",
        "needs-receipt",
        "pendingReceipt"
      );
  });

  if (preferred > 0) return preferred;

  // Fallback scan
  const rows = await safeList(t, null, 1000);
  const pending = rows.filter((r) => {
    const st = normalizeStatus(r?.status);
    if (st === "pending_receipt") return true;
    // heuristic: no receiptId but has barcode/scan data
    if (!r?.receiptId && (r?.barcode || r?.upc || r?.scan || r?.rawText))
      return true;
    return false;
  });
  return pending.length;
}

/**
 * KPI: "Receipts pending reconciliation"
 * - We count receipts with status pending/reconcile/reconciliation_needed.
 */
export async function countReceiptsPendingReconciliation() {
  const t = resolveTable(TABLE_CANDIDATES.receipts);
  if (!t) return 0;

  const preferred = await safeCount(t, (tbl) =>
    tbl
      .where("status")
      .anyOf(
        "pending",
        "reconcile",
        "reconciliation_needed",
        "needs_reconciliation"
      )
  );

  if (preferred > 0) return preferred;

  const rows = await safeList(t, null, 1000);
  const pending = rows.filter((r) => {
    const st = normalizeStatus(r?.status);
    if (st === "pending") return true;
    if (st.includes("recon")) return true;
    // heuristic: has lineItems but no committedAt / no inventoryCommitId
    if (
      Array.isArray(r?.items) &&
      r.items.length &&
      !r?.committedAt &&
      !r?.commitId
    )
      return true;
    return false;
  });

  return pending.length;
}

/**
 * General homepage KPI bundle (safe).
 * Expand this as you add more KPIs (sessions today, cooking session active, etc.).
 */
export async function getHomeKpis(opts = {}) {
  const date = opts.date ? new Date(opts.date) : new Date();

  const [
    shoppingPendingReceipt,
    receiptsPendingRecon,
    sessionsToday,
    activeSession,
  ] = await Promise.all([
    countShoppingCandidatesWaitingForReceipt(),
    countReceiptsPendingReconciliation(),
    countSessionsInRange(startOfDayISO(date), endOfDayISO(date)),
    getActiveSession(),
  ]);

  return {
    ts: nowISO(),
    shopping: {
      candidatesWaitingForReceipt: shoppingPendingReceipt,
      receiptsPendingReconciliation: receiptsPendingRecon,
    },
    sessions: {
      todayCount: sessionsToday,
      active: activeSession,
    },
  };
}

/* -------------------------------------------------------------------------------------------------
 * Session selectors
 * ------------------------------------------------------------------------------------------------- */

/**
 * Returns "active session" (best effort).
 * Common shapes:
 * - sessions table with status: "active" or "running"
 * - SessionRunner drafts might store in sessions with progress.startedAt set and completedAt null.
 */
export async function getActiveSession() {
  const t = resolveTable(TABLE_CANDIDATES.sessions);
  if (!t) return null;

  // Prefer status index
  const rowsByStatus = await safeList(
    t,
    (tbl) =>
      tbl
        .where("status")
        .anyOf("active", "running", "in_progress", "in-progress"),
    10
  );

  const candidates = rowsByStatus.length
    ? rowsByStatus
    : await safeList(t, null, 200);

  const active = candidates
    .filter((s) => {
      const st = normalizeStatus(s?.status);
      if (st === "active" || st === "running" || st === "in_progress")
        return true;
      // heuristic: started but not ended
      if (
        (s?.progress?.startedAt || s?.startedAt) &&
        !(s?.completedAt || s?.endedAt)
      )
        return true;
      return false;
    })
    .sort(sortByRecent)[0];

  return active || null;
}

/**
 * Count sessions in a time range (best effort).
 * Uses createdAt/startedAt timestamps.
 */
export async function countSessionsInRange(startISO, endISO) {
  const t = resolveTable(TABLE_CANDIDATES.sessions);
  if (!t) return 0;

  // Try indexed where('createdAt') if present
  const preferred = await safeCount(t, (tbl) =>
    tbl.where("createdAt").between(startISO, endISO, true, true)
  );
  if (preferred > 0) return preferred;

  // fallback to startedAt
  const alt = await safeCount(t, (tbl) =>
    tbl.where("startedAt").between(startISO, endISO, true, true)
  );
  if (alt > 0) return alt;

  // full fallback scan (limited)
  const rows = await safeList(t, null, 2000);
  const start = Date.parse(startISO) || 0;
  const end = Date.parse(endISO) || Number.MAX_SAFE_INTEGER;

  return rows.filter((s) => {
    const t1 = Date.parse(s?.createdAt || s?.startedAt || s?.ts || 0) || 0;
    return t1 >= start && t1 <= end;
  }).length;
}

/**
 * List recent session drafts (pending).
 */
export async function listSessionDrafts(limit = 25) {
  const t = resolveTable(TABLE_CANDIDATES.sessions);
  const rows = await safeList(t, null, 500);
  return rows
    .filter((s) => {
      const st = normalizeStatus(s?.status);
      return st === "pending" || st === "draft";
    })
    .sort(sortByRecent)
    .slice(0, clamp(limit, 0, 200));
}

/* -------------------------------------------------------------------------------------------------
 * Inventory selectors
 * ------------------------------------------------------------------------------------------------- */

/**
 * Best-effort lookup inventory items by name/sku.
 * @param {string} query
 * @param {object} [opts]
 * @param {number} [opts.limit=50]
 */
export async function searchInventory(query, opts = {}) {
  const t = resolveTable(TABLE_CANDIDATES.inventory);
  if (!t) return [];
  return await searchTable([t.name || "inventory"], query, {
    limit: opts.limit ?? 50,
    fields: opts.fields || ["name", "label", "sku", "upc", "barcode", "id"],
  });
}

/**
 * Get low-stock items (best-effort).
 * Looks for qty/quantity + minQty/reorderPoint fields.
 */
export async function listLowStockInventory(limit = 50) {
  const t = resolveTable(TABLE_CANDIDATES.inventory);
  if (!t) return [];

  const rows = await safeList(t, null, 2000);
  const lows = rows.filter((it) => {
    const qty = Number(it?.qty ?? it?.quantity ?? it?.onHand ?? 0);
    const min = Number(it?.minQty ?? it?.reorderPoint ?? it?.parLevel ?? 0);
    if (!Number.isFinite(qty) || !Number.isFinite(min)) return false;
    return qty <= min;
  });

  lows.sort((a, b) => {
    const qa = Number(a?.qty ?? a?.quantity ?? a?.onHand ?? 0);
    const qb = Number(b?.qty ?? b?.quantity ?? b?.onHand ?? 0);
    return qa - qb; // smallest first
  });

  return lows.slice(0, clamp(limit, 0, 500));
}

/* -------------------------------------------------------------------------------------------------
 * Meal plan selectors (read-only)
 * ------------------------------------------------------------------------------------------------- */

export async function listMealPlans(limit = 25) {
  const t = resolveTable(TABLE_CANDIDATES.mealPlans);
  if (!t) return [];
  const rows = await safeList(t, null, 500);
  return rows.sort(sortByRecent).slice(0, clamp(limit, 0, 200));
}

/**
 * Get meal plan by id, if that table exists.
 */
export async function getMealPlanById(id) {
  const t = resolveTable(TABLE_CANDIDATES.mealPlans);
  return await safeGet(t, id);
}

/* -------------------------------------------------------------------------------------------------
 * Layer spine selectors (artifacts → parsed → method maps → blueprints)
 * ------------------------------------------------------------------------------------------------- */

export async function listArtifacts(limit = 50) {
  return await listRecent(TABLE_CANDIDATES.artifacts, limit);
}

export async function listParsedCandidates(limit = 50) {
  return await listRecent(TABLE_CANDIDATES.parsedCandidates, limit);
}

export async function listMethodMaps(limit = 50) {
  return await listRecent(TABLE_CANDIDATES.methodMaps, limit);
}

export async function listBlueprints(limit = 50) {
  return await listRecent(TABLE_CANDIDATES.blueprints, limit);
}

export async function listLayerOverrides(limit = 50) {
  return await listRecent(TABLE_CANDIDATES.layerOverrides, limit);
}

/* -------------------------------------------------------------------------------------------------
 * Convenience export: everything as a namespace default
 * ------------------------------------------------------------------------------------------------- */

const selectors = {
  // generic
  listRecent,
  getById,
  searchTable,
  getDomainContext,

  // KPIs
  countShoppingCandidatesWaitingForReceipt,
  countReceiptsPendingReconciliation,
  getHomeKpis,

  // sessions
  getActiveSession,
  countSessionsInRange,
  listSessionDrafts,

  // inventory
  searchInventory,
  listLowStockInventory,

  // meal plans
  listMealPlans,
  getMealPlanById,

  // layer spine
  listArtifacts,
  listParsedCandidates,
  listMethodMaps,
  listBlueprints,
  listLayerOverrides,
};

export default selectors;
