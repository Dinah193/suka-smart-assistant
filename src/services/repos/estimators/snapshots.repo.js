/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\services\repos\estimators\snapshots.repo.js
//
// Estimator Snapshots repository
// ------------------------------
// Stores computed estimator outputs over time for trend charts + auditing.
//
// Table expected in Dexie (db.js):
// - estimator_snapshots
//
// Requested outputs (typical):
// - food security %
// - days covered
// - monthly savings
//
// Design:
// - local-first
// - safe if table missing (dev logs only; returns []/null)
// - deterministic normalization
// - list by household, sorted by computedAt/updatedAt
// - optional helpers for "latest" and "range"

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
      console.warn(`[estimators.snapshots] Missing table: ${tableName}`);
    return null;
  }
  try {
    return await db.table(tableName).get(key);
  } catch (e) {
    if (import.meta?.env?.DEV)
      console.warn(`[estimators.snapshots] safeGet failed (${tableName})`, e);
    return null;
  }
}

async function safePut(tableName, value) {
  if (!hasTable(tableName)) {
    if (import.meta?.env?.DEV)
      console.warn(`[estimators.snapshots] Missing table: ${tableName}`);
    return null;
  }
  try {
    await db.table(tableName).put(value);
    return value;
  } catch (e) {
    if (import.meta?.env?.DEV)
      console.warn(`[estimators.snapshots] safePut failed (${tableName})`, e);
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

function makeSnapshotId(householdId) {
  const h =
    safeStr(householdId, "household_unknown").trim() || "household_unknown";
  return `estimator_snapshot:${h}:${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/* -------------------------------------------------------------------------- */
/* Normalization */
/* -------------------------------------------------------------------------- */

export function normalizeSnapshot(householdId, snapshot = {}) {
  const ts = nowIso();

  const id = safeStr(
    snapshot.id ||
      snapshot.snapshotId ||
      snapshot.observationId ||
      makeSnapshotId(householdId),
  );

  // Allow both "outputs" object style and flat keys style.
  const outputsIn =
    snapshot.outputs && typeof snapshot.outputs === "object"
      ? snapshot.outputs
      : snapshot;

  const outputs = {
    foodSecurityPercent: clamp(
      outputsIn.foodSecurityPercent ??
        outputsIn.food_security_percent ??
        outputsIn.foodSecurityPct,
      0,
      100,
    ),
    daysCovered: clamp(
      outputsIn.daysCovered ?? outputsIn.days_covered,
      0,
      3650,
    ),
    monthlySavingsUSD: safeNum(
      outputsIn.monthlySavingsUSD ?? outputsIn.monthly_savings_usd,
      0,
    ),
    groceryDeltaUSD: safeNum(
      outputsIn.groceryDeltaUSD ?? outputsIn.grocery_delta_usd,
      0,
    ),
    eatingOutDeltaUSD: safeNum(
      outputsIn.eatingOutDeltaUSD ?? outputsIn.eating_out_delta_usd,
      0,
    ),
    scratchCookingPercent: clamp(
      outputsIn.scratchCookingPercent ??
        outputsIn.scratch_cooking_percent ??
        outputsIn.scratchCookingPct,
      0,
      100,
    ),
    // Optional bucketed breakdown (by domain / category)
    breakdown:
      outputsIn.breakdown && typeof outputsIn.breakdown === "object"
        ? outputsIn.breakdown
        : {},
  };

  const normalized = {
    id,
    householdId: safeStr(householdId),
    schemaVersion: safeStr(snapshot.schemaVersion, "1.0.0"),
    kind: safeStr(snapshot.kind, "homestead.estimator.snapshot"),
    status: safeStr(snapshot.status, "computed"),

    // Time anchors
    computedAt: safeStr(snapshot.computedAt, ts),
    createdAt: safeStr(snapshot.createdAt, snapshot.computedAt || ts),
    updatedAt: ts,

    title: safeStr(snapshot.title, "Estimator Snapshot"),

    // Structured payloads
    outputs,
    inputs:
      snapshot.inputs && typeof snapshot.inputs === "object"
        ? snapshot.inputs
        : {},
    links:
      snapshot.links && typeof snapshot.links === "object"
        ? snapshot.links
        : {},
    meta:
      snapshot.meta && typeof snapshot.meta === "object" ? snapshot.meta : {},

    // Optional quick tags for filtering
    tags: Array.isArray(snapshot.tags)
      ? snapshot.tags.map(String).filter(Boolean)
      : [],
  };

  return normalized;
}

/* -------------------------------------------------------------------------- */
/* Core API */
/* -------------------------------------------------------------------------- */

export async function saveSnapshot(householdId, snapshot) {
  const normalized = normalizeSnapshot(householdId, snapshot || {});
  const ok = await safePut("estimator_snapshots", normalized);
  return ok || normalized;
}

export async function getSnapshotById(snapshotId) {
  if (!snapshotId) return null;
  return safeGet("estimator_snapshots", safeStr(snapshotId));
}

export async function deleteSnapshot(snapshotId) {
  if (!snapshotId) return false;
  return safeDelete("estimator_snapshots", safeStr(snapshotId));
}

export async function listSnapshots(householdId, { limit = 50 } = {}) {
  if (!hasTable("estimator_snapshots")) return [];
  const h = safeStr(householdId);

  try {
    // If you later add compound indexes like [householdId+computedAt], you can
    // query using that. For now: query by householdId index and sort in memory.
    const rows = await db.estimator_snapshots
      .where("householdId")
      .equals(h)
      .toArray();
    rows.sort((a, b) =>
      safeStr(b.updatedAt || b.computedAt).localeCompare(
        safeStr(a.updatedAt || a.computedAt),
      ),
    );
    return rows.slice(0, limit);
  } catch (e) {
    if (import.meta?.env?.DEV)
      console.warn("[estimators.snapshots] listSnapshots failed", e);
    return [];
  }
}

export async function getLatestSnapshot(householdId) {
  const rows = await listSnapshots(householdId, { limit: 1 });
  return rows[0] || null;
}

// Legacy compatibility aliases
export const getById = getSnapshotById;
export const getLatestByHouseholdId = getLatestSnapshot;
export const getLatest = getLatestSnapshot;

/**
 * Returns snapshots within a computedAt window (inclusive).
 * Uses client-side filtering for now (safe, local-first scale).
 */
export async function listSnapshotsInRange(
  householdId,
  { startISO, endISO, limit = 250 } = {},
) {
  const start = startISO ? safeStr(startISO) : null;
  const end = endISO ? safeStr(endISO) : null;

  const rows = await listSnapshots(householdId, {
    limit: Math.max(limit, 250),
  });
  let filtered = rows;

  if (start)
    filtered = filtered.filter(
      (r) => safeStr(r.computedAt || r.updatedAt) >= start,
    );
  if (end)
    filtered = filtered.filter(
      (r) => safeStr(r.computedAt || r.updatedAt) <= end,
    );

  filtered.sort((a, b) =>
    safeStr(b.computedAt || b.updatedAt).localeCompare(
      safeStr(a.computedAt || a.updatedAt),
    ),
  );
  return filtered.slice(0, limit);
}

/* -------------------------------------------------------------------------- */
/* Bulk helpers */
/* -------------------------------------------------------------------------- */

export async function deleteAllSnapshots(householdId) {
  if (!hasTable("estimator_snapshots")) return 0;
  const h = safeStr(householdId);

  try {
    const rows = await db.estimator_snapshots
      .where("householdId")
      .equals(h)
      .toArray();
    const ids = rows.map((r) => r.id).filter(Boolean);

    await db.transaction("rw", db.estimator_snapshots, async () => {
      await Promise.all(ids.map((id) => db.estimator_snapshots.delete(id)));
    });

    return ids.length;
  } catch (e) {
    if (import.meta?.env?.DEV)
      console.warn("[estimators.snapshots] deleteAllSnapshots failed", e);
    return 0;
  }
}

/**
 * Optional: compact snapshots to the most recent N.
 * Useful if users run estimators constantly and you want to cap storage.
 */
export async function keepLatestSnapshots(householdId, { keep = 100 } = {}) {
  const n = Math.max(0, safeNum(keep, 100));
  if (n === 0) return deleteAllSnapshots(householdId);

  const rows = await listSnapshots(householdId, {
    limit: Math.max(n + 50, 200),
  });
  if (rows.length <= n) return 0;

  const toDelete = rows
    .slice(n)
    .map((r) => r.id)
    .filter(Boolean);
  if (!toDelete.length) return 0;

  try {
    await db.transaction("rw", db.estimator_snapshots, async () => {
      await Promise.all(
        toDelete.map((id) => db.estimator_snapshots.delete(id)),
      );
    });
    return toDelete.length;
  } catch (e) {
    if (import.meta?.env?.DEV)
      console.warn("[estimators.snapshots] keepLatestSnapshots failed", e);
    return 0;
  }
}

/* -------------------------------------------------------------------------- */
/* Convenience: create snapshot from common estimator outputs */
/* -------------------------------------------------------------------------- */

/**
 * When your estimator engine returns:
 * { outputs: {...}, inputs: {...}, links: {...}, meta: {...} }
 * you can pass the whole object here and it will normalize and store.
 */
export async function saveEstimatorRun(
  householdId,
  runResult,
  { title, tags } = {},
) {
  const run =
    runResult && typeof runResult === "object" ? deepClone(runResult) : {};
  const snapshot = {
    ...run,
    title: safeStr(title, run.title || "Estimator Snapshot"),
    tags: Array.isArray(tags) ? tags : run.tags,
    computedAt: run.computedAt || nowIso(),
    kind: run.kind || "homestead.estimator.snapshot",
    status: run.status || "computed",
  };
  return saveSnapshot(householdId, snapshot);
}

/* -------------------------------------------------------------------------- */
/* Default export (ergonomic repo object) */
/* -------------------------------------------------------------------------- */

const snapshotsRepo = {
  // core
  saveSnapshot,
  getSnapshotById,
  getById,
  deleteSnapshot,
  listSnapshots,
  getLatestSnapshot,
  getLatestByHouseholdId,
  getLatest,
  listSnapshotsInRange,

  // bulk
  deleteAllSnapshots,
  keepLatestSnapshots,

  // convenience
  saveEstimatorRun,

  // utils
  normalizeSnapshot,
};

export default snapshotsRepo;
