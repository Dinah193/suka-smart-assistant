/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\services\repos\farmToTable\batches.repo.js
//
// Farm-to-Table (FTT) Component Batches repository
// ------------------------------------------------
// Persists batch-prep outputs and preservation runs tied to FTT components.
//
// Examples:
// - cooked black beans batch
// - chicken broth batch
// - chopped onions batch
// - dehydrated herbs batch
// - canned tomatoes run
//
// Dexie table expected in db.js:
// - ftt_component_batches
//   "id, householdId, componentKey, batchDateISO, updatedAt, createdAt, status,
//    [householdId+componentKey], [householdId+batchDateISO], [componentKey+batchDateISO], [status+batchDateISO]"
//
// Recommended record shape:
// {
//   id: string,
//   householdId: string,
//   componentKey: string,          // e.g. "beans.black.cooked"
//   batchDateISO: string,          // date anchor for batch/run
//   status: "planned"|"in_progress"|"completed"|"aborted"|"archived",
//   title?: string,
//   createdAt: ISO,
//   updatedAt: ISO,
//
//   // quantities in/out
//   inputs?: [{ itemKey, qty:{value,unit}, notes? }],
//   outputs?: [{ itemKey?, componentKey?, qty:{value,unit}, storage?, expiresISO? }],
//
//   // optional links to sessions / plan items
//   links?: { sessionId?: string, planId?: string, planItemIds?: string[], relatedIds?: string[] },
//
//   // storage/meta
//   storage?: { location?: "freezer"|"fridge"|"pantry"|"root_cellar", containers?: number, containerType?: string },
//   tags?: string[],
//   notes?: string[],
//   meta?: object
// }
//
// Repo characteristics:
// - local-first
// - safe if table missing (dev logs only; returns []/null)
// - supports upsert by id
// - supports list by householdId, by componentKey, by date range, by status

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

async function safeGet(tableName, key) {
  if (!hasTable(tableName)) {
    if (import.meta?.env?.DEV)
      console.warn(`[ftt.batches] Missing table: ${tableName}`);
    return null;
  }
  try {
    return await db.table(tableName).get(key);
  } catch (e) {
    if (import.meta?.env?.DEV)
      console.warn(`[ftt.batches] safeGet failed (${tableName})`, e);
    return null;
  }
}

async function safePut(tableName, value) {
  if (!hasTable(tableName)) {
    if (import.meta?.env?.DEV)
      console.warn(`[ftt.batches] Missing table: ${tableName}`);
    return null;
  }
  try {
    await db.table(tableName).put(value);
    return value;
  } catch (e) {
    if (import.meta?.env?.DEV)
      console.warn(`[ftt.batches] safePut failed (${tableName})`, e);
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

function makeBatchId(householdId, componentKey, batchDateISO) {
  const h =
    safeStr(householdId, "household_unknown").trim() || "household_unknown";
  const c =
    safeStr(componentKey, "component_unknown").trim() || "component_unknown";
  const d = safeStr(batchDateISO, nowIso()).slice(0, 10); // YYYY-MM-DD-ish
  return `ftt_batch:${h}:${c}:${d}:${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeLineArray(arr) {
  const a = Array.isArray(arr) ? arr : [];
  return a
    .map((x) => (x && typeof x === "object" ? x : {}))
    .map((x) => ({
      itemKey: safeStr(x.itemKey || x.item || x.sku, "").trim(),
      componentKey: safeStr(x.componentKey || "", "").trim(),
      qty: normalizeQty(x.qty || x.amount || x.quantity || x),
      notes: Array.isArray(x.notes)
        ? x.notes.map(String).filter(Boolean)
        : safeStr(x.notes, ""),
      storage:
        x.storage && typeof x.storage === "object"
          ? deepClone(x.storage)
          : undefined,
      expiresISO: x.expiresISO == null ? null : safeStr(x.expiresISO),
      tags: Array.isArray(x.tags) ? x.tags.map(String).filter(Boolean) : [],
    }))
    .filter((x) => x.itemKey || x.componentKey || x.qty);
}

/* -------------------------------------------------------------------------- */
/* Normalization */
/* -------------------------------------------------------------------------- */

export function normalizeBatch(householdId, batch = {}) {
  const obj = batch && typeof batch === "object" ? batch : {};
  const ts = nowIso();

  const componentKey = safeStr(obj.componentKey || obj.component || "").trim();
  const batchDateISO = safeStr(
    obj.batchDateISO || obj.batchDate || obj.date || ts,
  );

  const id =
    safeStr(obj.id, "") ||
    makeBatchId(householdId, componentKey || "unknown", batchDateISO);

  const storage =
    obj.storage && typeof obj.storage === "object"
      ? deepClone(obj.storage)
      : {};

  // Optional quick sanity: if user passes confidence, clamp it
  const confidence =
    obj.confidence == null ? null : clamp(obj.confidence, 0, 1);

  return {
    id,
    householdId: safeStr(householdId),
    schemaVersion: safeStr(obj.schemaVersion, "1.0.0"),
    kind: safeStr(obj.kind, "ftt.component.batch"),
    status: safeStr(obj.status, "planned"),
    title: safeStr(
      obj.title,
      componentKey ? `Batch: ${componentKey}` : "FTT Batch",
    ),

    componentKey,
    batchDateISO,

    // quantities
    inputs: normalizeLineArray(obj.inputs),
    outputs: normalizeLineArray(obj.outputs),

    // storage / shelf life
    storage,
    expirationISO:
      obj.expirationISO == null ? null : safeStr(obj.expirationISO),
    location: safeStr(obj.location || storage.location, ""),

    // links
    links:
      obj.links && typeof obj.links === "object" ? deepClone(obj.links) : {},
    meta: obj.meta && typeof obj.meta === "object" ? deepClone(obj.meta) : {},
    notes: Array.isArray(obj.notes)
      ? obj.notes.map(String).filter(Boolean)
      : [],
    tags: Array.isArray(obj.tags) ? obj.tags.map(String).filter(Boolean) : [],

    confidence,

    createdAt: safeStr(obj.createdAt, ts),
    updatedAt: ts,
    completedAt: obj.completedAt == null ? null : safeStr(obj.completedAt),
  };
}

/* -------------------------------------------------------------------------- */
/* Core API */
/* -------------------------------------------------------------------------- */

export async function saveBatch(householdId, batch) {
  const normalized = normalizeBatch(householdId, batch || {});
  const ok = await safePut("ftt_component_batches", normalized);
  return ok || normalized;
}

export async function getBatchById(id) {
  if (!id) return null;
  return safeGet("ftt_component_batches", safeStr(id));
}

export async function deleteBatch(id) {
  if (!id) return false;
  return safeDelete("ftt_component_batches", safeStr(id));
}

/**
 * List batches for household (most recent first).
 */
export async function listBatches(householdId, { status, limit = 100 } = {}) {
  if (!hasTable("ftt_component_batches")) return [];
  const h = safeStr(householdId);

  try {
    // Use householdId index via where("householdId") if present.
    let rows = await db.ftt_component_batches
      .where("householdId")
      .equals(h)
      .toArray();

    if (status) {
      const s = safeStr(status);
      rows = rows.filter((r) => safeStr(r.status) === s);
    }

    rows.sort((a, b) =>
      safeStr(b.batchDateISO || b.updatedAt).localeCompare(
        safeStr(a.batchDateISO || a.updatedAt),
      ),
    );
    return rows.slice(0, limit);
  } catch (e) {
    if (import.meta?.env?.DEV)
      console.warn("[ftt.batches] listBatches failed", e);
    return [];
  }
}

/**
 * List batches for a componentKey (uses compound index if possible).
 * Your Dexie schema includes: [householdId+componentKey]
 */
export async function listBatchesForComponent(
  householdId,
  componentKey,
  { status, limit = 100 } = {},
) {
  if (!hasTable("ftt_component_batches")) return [];
  const h = safeStr(householdId);
  const c = safeStr(componentKey).trim();
  if (!c) return [];

  try {
    let rows = await db.ftt_component_batches
      .where("[householdId+componentKey]")
      .equals([h, c])
      .toArray();

    if (status) {
      const s = safeStr(status);
      rows = rows.filter((r) => safeStr(r.status) === s);
    }

    rows.sort((a, b) =>
      safeStr(b.batchDateISO || b.updatedAt).localeCompare(
        safeStr(a.batchDateISO || a.updatedAt),
      ),
    );
    return rows.slice(0, limit);
  } catch (e) {
    if (import.meta?.env?.DEV)
      console.warn("[ftt.batches] listBatchesForComponent failed", e);
    // fallback: list all for household and filter
    const rows = await listBatches(householdId, {
      status,
      limit: Math.max(limit, 300),
    });
    const filtered = rows.filter((r) => safeStr(r.componentKey) === c);
    return filtered.slice(0, limit);
  }
}

/**
 * List batches in date range (inclusive, string compare ISO works if ISO dates).
 * Uses client-side filtering (safe local-first).
 */
export async function listBatchesInRange(
  householdId,
  { startISO, endISO, status, limit = 500 } = {},
) {
  const start = startISO ? safeStr(startISO) : null;
  const end = endISO ? safeStr(endISO) : null;

  const rows = await listBatches(householdId, {
    status,
    limit: Math.max(limit, 800),
  });

  let filtered = rows;
  if (start)
    filtered = filtered.filter((r) => safeStr(r.batchDateISO) >= start);
  if (end) filtered = filtered.filter((r) => safeStr(r.batchDateISO) <= end);

  filtered.sort((a, b) =>
    safeStr(b.batchDateISO || b.updatedAt).localeCompare(
      safeStr(a.batchDateISO || a.updatedAt),
    ),
  );
  return filtered.slice(0, limit);
}

export async function getLatestBatchForComponent(
  householdId,
  componentKey,
  { status } = {},
) {
  const rows = await listBatchesForComponent(householdId, componentKey, {
    status,
    limit: 1,
  });
  return rows[0] || null;
}

/* -------------------------------------------------------------------------- */
/* Status transitions */
/* -------------------------------------------------------------------------- */

export async function setBatchStatus(batchId, status, { completedAt } = {}) {
  if (!hasTable("ftt_component_batches")) return null;
  const id = safeStr(batchId);
  if (!id) return null;

  try {
    const existing = await db.ftt_component_batches.get(id);
    if (!existing) return null;

    const nextStatus = safeStr(status, existing.status || "planned");
    const updated = {
      ...existing,
      status: nextStatus,
      updatedAt: nowIso(),
      completedAt:
        nextStatus === "completed"
          ? safeStr(completedAt, nowIso())
          : (existing.completedAt ?? null),
    };

    await db.ftt_component_batches.put(updated);
    return updated;
  } catch (e) {
    if (import.meta?.env?.DEV)
      console.warn("[ftt.batches] setBatchStatus failed", e);
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Bulk helpers */
/* -------------------------------------------------------------------------- */

export async function bulkSaveBatches(householdId, batches = []) {
  if (!hasTable("ftt_component_batches")) return [];

  const arr = Array.isArray(batches) ? batches : [];
  const normalized = arr.map((b) => normalizeBatch(householdId, b));

  try {
    await db.transaction("rw", db.ftt_component_batches, async () => {
      await db.ftt_component_batches.bulkPut(normalized);
    });
    return normalized;
  } catch (e) {
    if (import.meta?.env?.DEV)
      console.warn("[ftt.batches] bulkSaveBatches failed", e);
    // fallback: sequential
    const out = [];
    for (const n of normalized) {
      // eslint-disable-next-line no-await-in-loop
      const saved = await safePut("ftt_component_batches", n);
      out.push(saved || n);
    }
    return out;
  }
}

export async function deleteAllBatchesForHousehold(householdId) {
  if (!hasTable("ftt_component_batches")) return 0;
  const h = safeStr(householdId);

  try {
    const rows = await db.ftt_component_batches
      .where("householdId")
      .equals(h)
      .toArray();
    const ids = rows.map((r) => r.id).filter(Boolean);

    await db.transaction("rw", db.ftt_component_batches, async () => {
      await Promise.all(ids.map((id) => db.ftt_component_batches.delete(id)));
    });

    return ids.length;
  } catch (e) {
    if (import.meta?.env?.DEV)
      console.warn("[ftt.batches] deleteAllBatchesForHousehold failed", e);
    return 0;
  }
}

/**
 * Optional maintenance: keep only latest N batches for a componentKey.
 */
export async function keepLatestBatchesForComponent(
  householdId,
  componentKey,
  { keep = 50 } = {},
) {
  const n = Math.max(0, safeNum(keep, 50));
  if (n === 0) return 0;

  const rows = await listBatchesForComponent(householdId, componentKey, {
    limit: Math.max(n + 50, 200),
  });
  if (rows.length <= n) return 0;

  const toDelete = rows
    .slice(n)
    .map((r) => r.id)
    .filter(Boolean);
  if (!toDelete.length) return 0;

  try {
    await db.transaction("rw", db.ftt_component_batches, async () => {
      await Promise.all(
        toDelete.map((id) => db.ftt_component_batches.delete(id)),
      );
    });
    return toDelete.length;
  } catch (e) {
    if (import.meta?.env?.DEV)
      console.warn("[ftt.batches] keepLatestBatchesForComponent failed", e);
    return 0;
  }
}

// Legacy compatibility helpers
export async function countRecentByHouseholdId(householdId, { days = 14 } = {}) {
  const rows = await listBatches(householdId, { limit: 5000 });
  const windowMs = Number(days || 14) * 24 * 60 * 60 * 1000;
  const now = Date.now();
  return rows.filter((row) => {
    const t = Date.parse(row?.updatedAt || row?.createdAt || "");
    return Number.isFinite(t) && now - t <= windowMs;
  }).length;
}

export const countRecent = countRecentByHouseholdId;

/* -------------------------------------------------------------------------- */
/* Default export (ergonomic repo object) */
/* -------------------------------------------------------------------------- */

const batchesRepo = {
  // core
  saveBatch,
  getBatchById,
  deleteBatch,
  listBatches,
  listBatchesForComponent,
  listBatchesInRange,
  getLatestBatchForComponent,

  // status
  setBatchStatus,

  // bulk
  bulkSaveBatches,
  deleteAllBatchesForHousehold,
  keepLatestBatchesForComponent,
  countRecentByHouseholdId,
  countRecent,

  // utils
  normalizeBatch,
};

export default batchesRepo;
