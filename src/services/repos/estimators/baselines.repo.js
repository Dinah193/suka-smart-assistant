/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\services\repos\estimators\baselines.repo.js
//
// Estimator Baselines repository
// ------------------------------
// Stores user-provided (or default) baseline inputs that estimator engines use:
//
// Table expected in Dexie (db.js):
// - estimator_baselines
//
// Baseline example fields (as requested):
// - grocerySpendMonthlyUSD
// - eatingOutFrequencyPerWeek
// - householdSize
// - mealsPerWeek
//
// This repo is:
// - local-first (Dexie)
// - safe if table missing (dev logs only; returns defaults)
// - deterministic defaults so estimator can run immediately
// - supports partial patch updates and reset

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

function makeKey(householdId) {
  const h =
    safeStr(householdId, "household_unknown").trim() || "household_unknown";
  return `estimator_baselines:${h}`;
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
      console.warn(`[estimators.baselines] Missing table: ${tableName}`);
    return null;
  }
  try {
    return await db.table(tableName).get(key);
  } catch (e) {
    if (import.meta?.env?.DEV)
      console.warn(`[estimators.baselines] safeGet failed (${tableName})`, e);
    return null;
  }
}

async function safePut(tableName, value) {
  if (!hasTable(tableName)) {
    if (import.meta?.env?.DEV)
      console.warn(`[estimators.baselines] Missing table: ${tableName}`);
    return null;
  }
  try {
    await db.table(tableName).put(value);
    return value;
  } catch (e) {
    if (import.meta?.env?.DEV)
      console.warn(`[estimators.baselines] safePut failed (${tableName})`, e);
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

/* -------------------------------------------------------------------------- */
/* Defaults + Normalization */
/* -------------------------------------------------------------------------- */

export function defaultEstimatorBaselines(householdId) {
  const ts = nowIso();
  return {
    id: makeKey(householdId),
    householdId: safeStr(householdId),
    schemaVersion: "1.0.0",
    status: "active",

    // Requested baseline fields
    grocerySpendMonthlyUSD: 600,
    eatingOutFrequencyPerWeek: 2,
    householdSize: 2,
    mealsPerWeek: 14,

    // Optional extensions (safe defaults)
    currency: "USD",
    locale: "en-US",
    notes: "",

    createdAt: ts,
    updatedAt: ts,
  };
}

export function normalizeEstimatorBaselines(
  householdId,
  baselines,
  { mergeWithDefaults = true } = {},
) {
  const defaults = defaultEstimatorBaselines(householdId);
  const base = mergeWithDefaults
    ? { ...defaults, ...(baselines || {}) }
    : { ...(baselines || {}) };

  const now = nowIso();

  return {
    ...base,
    id: makeKey(householdId),
    householdId: safeStr(householdId),

    schemaVersion: safeStr(base.schemaVersion, defaults.schemaVersion),
    status: safeStr(base.status, "active"),

    currency: safeStr(base.currency, "USD"),
    locale: safeStr(base.locale, "en-US"),
    notes: safeStr(base.notes, ""),

    // Coerce + clamp to sane ranges
    grocerySpendMonthlyUSD: clamp(base.grocerySpendMonthlyUSD, 0, 100000),
    eatingOutFrequencyPerWeek: clamp(base.eatingOutFrequencyPerWeek, 0, 21),
    householdSize: clamp(base.householdSize, 1, 50),
    mealsPerWeek: clamp(base.mealsPerWeek, 0, 70),

    createdAt: safeStr(base.createdAt, defaults.createdAt || now),
    updatedAt: now,
  };
}

/* -------------------------------------------------------------------------- */
/* Core API */
/* -------------------------------------------------------------------------- */

export async function ensureBaselines(householdId) {
  const key = makeKey(householdId);
  const existing = await safeGet("estimator_baselines", key);
  if (existing) return existing;

  const created = defaultEstimatorBaselines(householdId);
  await safePut("estimator_baselines", created);
  return created;
}

export async function getBaselines(householdId) {
  const key = makeKey(householdId);
  const existing = await safeGet("estimator_baselines", key);
  if (existing) return existing;
  return defaultEstimatorBaselines(householdId);
}

// Legacy compatibility alias
export const getLatestByHouseholdId = getBaselines;
export const getByHouseholdId = getBaselines;

export async function upsertBaselines(householdId, patch = {}) {
  const current = await ensureBaselines(householdId);
  const merged = { ...current, ...(patch || {}) };
  const normalized = normalizeEstimatorBaselines(householdId, merged, {
    mergeWithDefaults: true,
  });
  await safePut("estimator_baselines", normalized);
  return normalized;
}

export async function setBaselineField(householdId, field, value) {
  const key = safeStr(field).trim();
  if (!key) return getBaselines(householdId);

  // Only allow edits to known top-level fields (avoid junk writes)
  const allowed = new Set([
    "grocerySpendMonthlyUSD",
    "eatingOutFrequencyPerWeek",
    "householdSize",
    "mealsPerWeek",
    "currency",
    "locale",
    "notes",
    "status",
  ]);

  if (!allowed.has(key)) {
    if (import.meta?.env?.DEV) {
      console.warn(
        `[estimators.baselines] Ignoring unknown baseline field: ${key}`,
      );
    }
    return getBaselines(householdId);
  }

  return upsertBaselines(householdId, { [key]: value });
}

export async function resetBaselines(householdId) {
  const created = defaultEstimatorBaselines(householdId);
  await safePut("estimator_baselines", created);
  return created;
}

export async function deleteBaselines(householdId) {
  const key = makeKey(householdId);
  return safeDelete("estimator_baselines", key);
}

/* -------------------------------------------------------------------------- */
/* Read helpers useful for estimators */
/* -------------------------------------------------------------------------- */

export async function getHouseholdSize(householdId, fallback = 2) {
  const b = await getBaselines(householdId);
  return safeNum(b.householdSize, fallback);
}

export async function getMealsPerWeek(householdId, fallback = 14) {
  const b = await getBaselines(householdId);
  return safeNum(b.mealsPerWeek, fallback);
}

export async function getMonthlyGrocerySpend(householdId, fallback = 600) {
  const b = await getBaselines(householdId);
  return safeNum(b.grocerySpendMonthlyUSD, fallback);
}

export async function getEatingOutFrequency(householdId, fallback = 2) {
  const b = await getBaselines(householdId);
  return safeNum(b.eatingOutFrequencyPerWeek, fallback);
}

/* -------------------------------------------------------------------------- */
/* Default export (ergonomic repo object) */
/* -------------------------------------------------------------------------- */

const baselinesRepo = {
  // core
  ensureBaselines,
  getBaselines,
  getLatestByHouseholdId,
  getByHouseholdId,
  upsertBaselines,
  resetBaselines,
  deleteBaselines,
  setBaselineField,

  // helpers
  getHouseholdSize,
  getMealsPerWeek,
  getMonthlyGrocerySpend,
  getEatingOutFrequency,

  // utils
  defaultEstimatorBaselines,
  normalizeEstimatorBaselines,
};

export default baselinesRepo;
