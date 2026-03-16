/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\services\repos\farmToTable\targets.repo.js
//
// Farm-to-Table (FTT) Provisioning Targets repository
// ---------------------------------------------------
// Persists computed provisioning targets for a household over a horizon window.
// These targets are produced by the Homestead Planner and used by:
// - Meal Planner (component availability, scratch-cooking targets)
// - Storehouse / Pantry provisioning (what to buy/stock)
// - Garden / Animals recommendations (what to grow/raise)
// - Estimator (food security %, days covered, savings)
//
// Dexie table expected in db.js:
// - ftt_provisioning_targets
//   "id, householdId, horizonStartISO, horizonDays, updatedAt, createdAt, status,
//    [householdId+horizonStartISO], [householdId+updatedAt], [householdId+status]"
//
// Record shape (recommended):
// {
//   id: string,
//   householdId: string,
//   horizonStartISO: string,
//   horizonDays: number,
//   status: "draft"|"computed"|"applied"|"archived",
//   title: string,
//   createdAt: ISO,
//   updatedAt: ISO,
//
//   // inputs used for run
//   inputs: { ... }, // baselines, preferences, overrides, assumptions
//
//   // outputs
//   summary: {
//     foodSecurityPercent?: number,
//     daysCovered?: number,
//     monthlySavingsUSD?: number,
//     scratchCookingPercent?: number,
//     notes?: string[]
//   },
//   targets: [
//     {
//       id?: string,
//       kind: "purchase"|"produce"|"preserve"|"batch"|"inventory_restock",
//       domain?: "storehouse"|"garden"|"animals"|"meals"|"preservation",
//       itemKey: string,
//       componentKey?: string,
//       label?: string,
//       qty?: { value:number, unit:string },
//       priority?: "low"|"medium"|"high",
//       dueByISO?: string,
//       confidence?: number, // 0..1
//       reasoning?: string[],
//       tags?: string[]
//     }
//   ],
//
//   // links to plans/drafts/snapshots
//   links: { homesteadPlanId?: string, estimatorSnapshotId?: string, relatedIds?: string[] },
//
//   meta: { engineVersion?: string, source?: string }
// }
//
// This repo is:
// - local-first
// - safe if table missing (dev logs only; returns defaults)
// - supports latest-by-household queries
// - supports horizon lookups + status filtering

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
      console.warn(`[ftt.targets] Missing table: ${tableName}`);
    return null;
  }
  try {
    return await db.table(tableName).get(key);
  } catch (e) {
    if (import.meta?.env?.DEV)
      console.warn(`[ftt.targets] safeGet failed (${tableName})`, e);
    return null;
  }
}

async function safePut(tableName, value) {
  if (!hasTable(tableName)) {
    if (import.meta?.env?.DEV)
      console.warn(`[ftt.targets] Missing table: ${tableName}`);
    return null;
  }
  try {
    await db.table(tableName).put(value);
    return value;
  } catch (e) {
    if (import.meta?.env?.DEV)
      console.warn(`[ftt.targets] safePut failed (${tableName})`, e);
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

function makeTargetsId(householdId, horizonStartISO) {
  const h =
    safeStr(householdId, "household_unknown").trim() || "household_unknown";
  const s = safeStr(horizonStartISO, nowIso()).slice(0, 10); // YYYY-MM-DD-ish
  return `ftt_targets:${h}:${s}:${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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

function normalizeTargetLine(line, idx = 0) {
  const obj = line && typeof line === "object" ? line : {};
  const itemKey = safeStr(obj.itemKey || obj.item || obj.sku || "").trim();

  // itemKey is required for meaningful targets; if missing, keep but mark invalid
  const id =
    safeStr(obj.id, "") ||
    `ftt_target_line:${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 8)}`;

  const kind = safeStr(obj.kind, "purchase");
  const priority = safeStr(obj.priority, "medium");

  const qty = normalizeQty(obj.qty || obj.amount || obj.quantity || obj);

  const confidence =
    obj.confidence == null ? null : clamp(obj.confidence, 0, 1);

  return {
    id,
    kind, // purchase|produce|preserve|batch|inventory_restock
    domain: safeStr(obj.domain, ""), // storehouse|garden|animals|meals|preservation
    itemKey,
    componentKey: safeStr(obj.componentKey, ""),
    label: safeStr(obj.label, ""),
    qty,
    priority, // low|medium|high
    dueByISO: safeStr(obj.dueByISO || obj.dueBy || "", ""),
    confidence,
    reasoning: Array.isArray(obj.reasoning)
      ? obj.reasoning.map(String).filter(Boolean)
      : [],
    tags: Array.isArray(obj.tags) ? obj.tags.map(String).filter(Boolean) : [],
    status: safeStr(obj.status, "active"),
  };
}

/* -------------------------------------------------------------------------- */
/* Normalization */
/* -------------------------------------------------------------------------- */

export function normalizeProvisioningTargets(householdId, doc = {}) {
  const ts = nowIso();
  const obj = doc && typeof doc === "object" ? doc : {};

  const horizonStartISO = safeStr(
    obj.horizonStartISO || obj.horizonStart || ts,
  );
  const horizonDays = clamp(obj.horizonDays ?? obj.horizon ?? 14, 1, 365);

  const id = safeStr(obj.id, "") || makeTargetsId(householdId, horizonStartISO);

  const summaryIn =
    obj.summary && typeof obj.summary === "object"
      ? obj.summary
      : obj.outputs || {};

  const summary = {
    foodSecurityPercent:
      summaryIn.foodSecurityPercent == null
        ? null
        : clamp(summaryIn.foodSecurityPercent, 0, 100),
    daysCovered:
      summaryIn.daysCovered == null
        ? null
        : clamp(summaryIn.daysCovered, 0, 3650),
    monthlySavingsUSD:
      summaryIn.monthlySavingsUSD == null
        ? null
        : safeNum(summaryIn.monthlySavingsUSD, 0),
    scratchCookingPercent:
      summaryIn.scratchCookingPercent == null
        ? null
        : clamp(summaryIn.scratchCookingPercent, 0, 100),
    notes: Array.isArray(summaryIn.notes)
      ? summaryIn.notes.map(String).filter(Boolean)
      : [],
  };

  const targetsArr = Array.isArray(obj.targets)
    ? obj.targets
    : Array.isArray(obj.items)
      ? obj.items
      : [];
  const targets = targetsArr.map((t, i) => normalizeTargetLine(t, i));

  return {
    id,
    householdId: safeStr(householdId),
    schemaVersion: safeStr(obj.schemaVersion, "1.0.0"),
    kind: safeStr(obj.kind, "ftt.provisioning.targets"),
    status: safeStr(obj.status, "computed"),
    title: safeStr(obj.title, `Provisioning Targets (${horizonDays}d)`),

    horizonStartISO,
    horizonDays,

    // payloads
    inputs:
      obj.inputs && typeof obj.inputs === "object" ? deepClone(obj.inputs) : {},
    summary,
    targets,

    links:
      obj.links && typeof obj.links === "object" ? deepClone(obj.links) : {},
    meta: obj.meta && typeof obj.meta === "object" ? deepClone(obj.meta) : {},

    createdAt: safeStr(obj.createdAt, obj.computedAt || ts),
    updatedAt: ts,
    computedAt: safeStr(obj.computedAt, ts),

    tags: Array.isArray(obj.tags) ? obj.tags.map(String).filter(Boolean) : [],
  };
}

/* -------------------------------------------------------------------------- */
/* Core API */
/* -------------------------------------------------------------------------- */

export async function saveTargets(householdId, targetsDoc) {
  const normalized = normalizeProvisioningTargets(
    householdId,
    targetsDoc || {},
  );
  const ok = await safePut("ftt_provisioning_targets", normalized);
  return ok || normalized;
}

export async function getTargetsById(id) {
  if (!id) return null;
  return safeGet("ftt_provisioning_targets", safeStr(id));
}

export async function deleteTargets(id) {
  if (!id) return false;
  return safeDelete("ftt_provisioning_targets", safeStr(id));
}

/**
 * List targets docs for a household (most recent first).
 * For small local-first scale, we query by index householdId and sort.
 */
export async function listTargets(householdId, { status, limit = 25 } = {}) {
  if (!hasTable("ftt_provisioning_targets")) return [];
  const h = safeStr(householdId);

  try {
    let rows = await db.ftt_provisioning_targets
      .where("householdId")
      .equals(h)
      .toArray();

    if (status) {
      const s = safeStr(status);
      rows = rows.filter((r) => safeStr(r.status) === s);
    }

    rows.sort((a, b) =>
      safeStr(b.updatedAt || b.computedAt).localeCompare(
        safeStr(a.updatedAt || a.computedAt),
      ),
    );
    return rows.slice(0, limit);
  } catch (e) {
    if (import.meta?.env?.DEV)
      console.warn("[ftt.targets] listTargets failed", e);
    return [];
  }
}

export async function getLatestTargets(householdId, { status } = {}) {
  const rows = await listTargets(householdId, { status, limit: 1 });
  return rows[0] || null;
}

// Legacy compatibility aliases
export const getLatestByHouseholdId = getLatestTargets;
export const getLatest = getLatestTargets;

/**
 * Find targets for a given horizon window.
 * - Prefer exact match by horizonStartISO + horizonDays when possible.
 * - Otherwise return nearest-most-recent for same horizonStartISO.
 */
export async function findTargetsForHorizon(
  householdId,
  { horizonStartISO, horizonDays, status } = {},
) {
  const start = horizonStartISO ? safeStr(horizonStartISO) : null;
  const days = horizonDays == null ? null : clamp(horizonDays, 1, 365);
  const rows = await listTargets(householdId, { status, limit: 200 });

  let filtered = rows;
  if (start)
    filtered = filtered.filter(
      (r) => safeStr(r.horizonStartISO).slice(0, 10) === start.slice(0, 10),
    );
  if (days != null)
    filtered = filtered.filter((r) => safeNum(r.horizonDays, -1) === days);

  filtered.sort((a, b) =>
    safeStr(b.updatedAt || b.computedAt).localeCompare(
      safeStr(a.updatedAt || a.computedAt),
    ),
  );
  return filtered[0] || null;
}

/* -------------------------------------------------------------------------- */
/* Line-item helpers */
/* -------------------------------------------------------------------------- */

export async function listTargetLines(targetsId) {
  const doc = await getTargetsById(targetsId);
  if (!doc) return [];
  return Array.isArray(doc.targets) ? doc.targets : [];
}

export async function listTargetLinesByKind(
  householdId,
  { kind, status, limit = 200 } = {},
) {
  const doc = await getLatestTargets(householdId, { status });
  if (!doc) return [];
  const k = safeStr(kind).trim();
  if (!k) return Array.isArray(doc.targets) ? doc.targets : [];
  const lines = Array.isArray(doc.targets) ? doc.targets : [];
  return lines.filter((t) => safeStr(t.kind) === k).slice(0, limit);
}

export async function getTargetsSummary(householdId, { status } = {}) {
  const doc = await getLatestTargets(householdId, { status });
  return doc?.summary || null;
}

/* -------------------------------------------------------------------------- */
/* Status transitions */
/* -------------------------------------------------------------------------- */

export async function setTargetsStatus(targetsId, status) {
  if (!hasTable("ftt_provisioning_targets")) return null;
  const id = safeStr(targetsId);
  if (!id) return null;

  try {
    const existing = await db.ftt_provisioning_targets.get(id);
    if (!existing) return null;

    const updated = {
      ...existing,
      status: safeStr(status, existing.status || "computed"),
      updatedAt: nowIso(),
    };
    await db.ftt_provisioning_targets.put(updated);
    return updated;
  } catch (e) {
    if (import.meta?.env?.DEV)
      console.warn("[ftt.targets] setTargetsStatus failed", e);
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Bulk helpers */
/* -------------------------------------------------------------------------- */

export async function deleteAllTargetsForHousehold(householdId) {
  if (!hasTable("ftt_provisioning_targets")) return 0;
  const h = safeStr(householdId);

  try {
    const rows = await db.ftt_provisioning_targets
      .where("householdId")
      .equals(h)
      .toArray();
    const ids = rows.map((r) => r.id).filter(Boolean);

    await db.transaction("rw", db.ftt_provisioning_targets, async () => {
      await Promise.all(
        ids.map((id) => db.ftt_provisioning_targets.delete(id)),
      );
    });

    return ids.length;
  } catch (e) {
    if (import.meta?.env?.DEV)
      console.warn("[ftt.targets] deleteAllTargetsForHousehold failed", e);
    return 0;
  }
}

/**
 * Keep only the latest N targets docs for a household (optional maintenance).
 */
export async function keepLatestTargets(householdId, { keep = 50 } = {}) {
  const n = Math.max(0, safeNum(keep, 50));
  if (n === 0) return deleteAllTargetsForHousehold(householdId);

  const rows = await listTargets(householdId, { limit: Math.max(n + 50, 200) });
  if (rows.length <= n) return 0;

  const toDelete = rows
    .slice(n)
    .map((r) => r.id)
    .filter(Boolean);
  if (!toDelete.length) return 0;

  try {
    await db.transaction("rw", db.ftt_provisioning_targets, async () => {
      await Promise.all(
        toDelete.map((id) => db.ftt_provisioning_targets.delete(id)),
      );
    });
    return toDelete.length;
  } catch (e) {
    if (import.meta?.env?.DEV)
      console.warn("[ftt.targets] keepLatestTargets failed", e);
    return 0;
  }
}

/* -------------------------------------------------------------------------- */
/* Default export (ergonomic repo object) */
/* -------------------------------------------------------------------------- */

const targetsRepo = {
  // core
  saveTargets,
  getTargetsById,
  deleteTargets,
  listTargets,
  getLatestTargets,
  getLatestByHouseholdId,
  getLatest,
  findTargetsForHorizon,

  // helpers
  listTargetLines,
  listTargetLinesByKind,
  getTargetsSummary,

  // status
  setTargetsStatus,

  // bulk/maintenance
  deleteAllTargetsForHousehold,
  keepLatestTargets,

  // utils
  normalizeProvisioningTargets,
};

export default targetsRepo;
