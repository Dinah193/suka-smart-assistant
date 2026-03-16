/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\services\repos\homestead\visibilityState.repo.js
//
// Homestead Visibility State repository
// ------------------------------------
// Stores UI visibility preferences for Homestead Planner and related pages:
// - dismissed helper panels ("don't show again")
// - collapsed sections/accordions
// - arbitrary flags / UI preferences
//
// Table expected in Dexie (db.js):
// - homestead_visibility_state: "id, householdId, updatedAt, createdAt, ..."
//   (string primary key `id` recommended)
//
// This repo is:
// - local-first (Dexie)
// - safe (won't crash if table missing; dev logs only)
// - deterministic defaults (UI can render immediately)

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

function safeBool(x, fallback = false) {
  if (typeof x === "boolean") return x;
  if (x === "true") return true;
  if (x === "false") return false;
  return fallback;
}

function asStringArray(x) {
  if (Array.isArray(x)) return x.map((v) => String(v)).filter(Boolean);
  if (typeof x === "string") return [x].filter(Boolean);
  return [];
}

function deepClone(obj) {
  try {
    return structuredClone(obj);
  } catch {
    return JSON.parse(JSON.stringify(obj || {}));
  }
}

function makeKey(prefix, householdId) {
  const h =
    safeStr(householdId, "household_unknown").trim() || "household_unknown";
  return `${prefix}:${h}`;
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
      console.warn(`[visibility.repo] Missing table: ${tableName}`);
    return null;
  }
  try {
    return await db.table(tableName).get(key);
  } catch (e) {
    if (import.meta?.env?.DEV)
      console.warn(`[visibility.repo] safeGet failed (${tableName})`, e);
    return null;
  }
}

async function safePut(tableName, value) {
  if (!hasTable(tableName)) {
    if (import.meta?.env?.DEV)
      console.warn(`[visibility.repo] Missing table: ${tableName}`);
    return null;
  }
  try {
    await db.table(tableName).put(value);
    return value;
  } catch (e) {
    if (import.meta?.env?.DEV)
      console.warn(`[visibility.repo] safePut failed (${tableName})`, e);
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
/* Defaults */
/* -------------------------------------------------------------------------- */

/**
 * You can standardize keys so UI and repo stay consistent:
 * - panel keys: "homestead.welcome", "homestead.levels", "estimator.tips", etc.
 * - section keys: "homestead.kpis", "homestead.estimator", "ftt.targets", etc.
 */
export const DEFAULT_VISIBILITY_FLAGS = Object.freeze({
  dontShowWelcome: false,
  dontShowLevelExplainer: false,
  dontShowEstimatorTips: false,
});

export const DEFAULT_PREFERENCES = Object.freeze({
  // Example: allow UI to remember preferred view mode
  viewMode: "standard", // "standard" | "compact"
  showAdvanced: false,
});

function defaultVisibilityState(householdId) {
  const ts = nowIso();
  return {
    id: makeKey("homestead_visibility_state", householdId),
    householdId: safeStr(householdId),
    schemaVersion: "1.0.0",
    status: "active",

    // User-driven UI state
    collapsedSections: [],
    dismissedPanels: [],

    // Boolean flags (opt-out patterns)
    flags: deepClone(DEFAULT_VISIBILITY_FLAGS),

    // Non-boolean preferences (strings/numbers/etc.)
    preferences: deepClone(DEFAULT_PREFERENCES),

    createdAt: ts,
    updatedAt: ts,
  };
}

/* -------------------------------------------------------------------------- */
/* Core API */
/* -------------------------------------------------------------------------- */

export async function ensureVisibilityState(householdId) {
  const key = makeKey("homestead_visibility_state", householdId);
  const existing = await safeGet("homestead_visibility_state", key);
  if (existing) return existing;

  const created = defaultVisibilityState(householdId);
  await safePut("homestead_visibility_state", created);
  return created;
}

export async function getVisibilityState(householdId) {
  const key = makeKey("homestead_visibility_state", householdId);
  const existing = await safeGet("homestead_visibility_state", key);
  if (existing) return existing;
  return defaultVisibilityState(householdId);
}

export async function upsertVisibilityState(householdId, patch = {}) {
  const current = await ensureVisibilityState(householdId);
  const updated = {
    ...current,
    ...patch,
    id: makeKey("homestead_visibility_state", householdId),
    householdId: safeStr(householdId),
    schemaVersion: safeStr(
      patch.schemaVersion,
      current.schemaVersion || "1.0.0",
    ),
    status: safeStr(patch.status, current.status || "active"),

    collapsedSections: Array.isArray(patch.collapsedSections)
      ? patch.collapsedSections.map(String).filter(Boolean)
      : Array.isArray(current.collapsedSections)
        ? current.collapsedSections
        : [],

    dismissedPanels: Array.isArray(patch.dismissedPanels)
      ? patch.dismissedPanels.map(String).filter(Boolean)
      : Array.isArray(current.dismissedPanels)
        ? current.dismissedPanels
        : [],

    flags:
      patch.flags && typeof patch.flags === "object"
        ? { ...(current.flags || {}), ...patch.flags }
        : current.flags || deepClone(DEFAULT_VISIBILITY_FLAGS),

    preferences:
      patch.preferences && typeof patch.preferences === "object"
        ? { ...(current.preferences || {}), ...patch.preferences }
        : current.preferences || deepClone(DEFAULT_PREFERENCES),

    updatedAt: nowIso(),
    createdAt: current.createdAt || nowIso(),
  };

  await safePut("homestead_visibility_state", updated);
  return updated;
}

export async function resetVisibilityState(householdId) {
  const created = defaultVisibilityState(householdId);
  await safePut("homestead_visibility_state", created);
  return created;
}

/* -------------------------------------------------------------------------- */
/* Panel dismissal helpers */
/* -------------------------------------------------------------------------- */

export async function dismissPanel(householdId, panelKey, dismissed = true) {
  const key = safeStr(panelKey).trim();
  if (!key) return getVisibilityState(householdId);

  const current = await ensureVisibilityState(householdId);
  const set = new Set(asStringArray(current.dismissedPanels));

  if (dismissed) set.add(key);
  else set.delete(key);

  return upsertVisibilityState(householdId, {
    dismissedPanels: Array.from(set),
  });
}

export async function isPanelDismissed(householdId, panelKey) {
  const key = safeStr(panelKey).trim();
  if (!key) return false;

  const state = await getVisibilityState(householdId);
  return new Set(asStringArray(state.dismissedPanels)).has(key);
}

export async function clearDismissedPanels(householdId) {
  return upsertVisibilityState(householdId, { dismissedPanels: [] });
}

/* -------------------------------------------------------------------------- */
/* Section collapse helpers */
/* -------------------------------------------------------------------------- */

export async function setSectionCollapsed(
  householdId,
  sectionKey,
  collapsed = true,
) {
  const key = safeStr(sectionKey).trim();
  if (!key) return getVisibilityState(householdId);

  const current = await ensureVisibilityState(householdId);
  const set = new Set(asStringArray(current.collapsedSections));

  if (collapsed) set.add(key);
  else set.delete(key);

  return upsertVisibilityState(householdId, {
    collapsedSections: Array.from(set),
  });
}

export async function toggleSectionCollapsed(householdId, sectionKey) {
  const key = safeStr(sectionKey).trim();
  if (!key) return getVisibilityState(householdId);

  const current = await ensureVisibilityState(householdId);
  const set = new Set(asStringArray(current.collapsedSections));

  if (set.has(key)) set.delete(key);
  else set.add(key);

  return upsertVisibilityState(householdId, {
    collapsedSections: Array.from(set),
  });
}

export async function isSectionCollapsed(householdId, sectionKey) {
  const key = safeStr(sectionKey).trim();
  if (!key) return false;

  const state = await getVisibilityState(householdId);
  return new Set(asStringArray(state.collapsedSections)).has(key);
}

export async function clearCollapsedSections(householdId) {
  return upsertVisibilityState(householdId, { collapsedSections: [] });
}

/* -------------------------------------------------------------------------- */
/* Flags + preferences helpers */
/* -------------------------------------------------------------------------- */

export async function setFlag(householdId, flagKey, value) {
  const key = safeStr(flagKey).trim();
  if (!key) return getVisibilityState(householdId);

  const current = await ensureVisibilityState(householdId);
  const flags = { ...(current.flags || {}) };
  flags[key] = safeBool(value, false);

  return upsertVisibilityState(householdId, { flags });
}

export async function getFlag(householdId, flagKey, fallback = false) {
  const key = safeStr(flagKey).trim();
  if (!key) return fallback;

  const state = await getVisibilityState(householdId);
  const v = state?.flags?.[key];
  return safeBool(v, fallback);
}

export async function setPreference(householdId, prefKey, value) {
  const key = safeStr(prefKey).trim();
  if (!key) return getVisibilityState(householdId);

  const current = await ensureVisibilityState(householdId);
  const preferences = { ...(current.preferences || {}) };
  preferences[key] = value;

  return upsertVisibilityState(householdId, { preferences });
}

export async function getPreference(householdId, prefKey, fallback = null) {
  const key = safeStr(prefKey).trim();
  if (!key) return fallback;

  const state = await getVisibilityState(householdId);
  if (!state?.preferences || typeof state.preferences !== "object")
    return fallback;

  return Object.prototype.hasOwnProperty.call(state.preferences, key)
    ? state.preferences[key]
    : fallback;
}

/* -------------------------------------------------------------------------- */
/* Advanced: one-shot patch helpers */
/* -------------------------------------------------------------------------- */

export async function patchVisibilityState(householdId, updaterFn) {
  if (typeof updaterFn !== "function") {
    throw new Error(
      "[visibility.repo] patchVisibilityState requires a function",
    );
  }
  const current = await ensureVisibilityState(householdId);
  const patch = updaterFn(deepClone(current)) || {};
  if (!patch || typeof patch !== "object") return current;
  return upsertVisibilityState(householdId, patch);
}

/* -------------------------------------------------------------------------- */
/* Maintenance helpers */
/* -------------------------------------------------------------------------- */

export async function deleteVisibilityState(householdId) {
  const key = makeKey("homestead_visibility_state", householdId);
  return safeDelete("homestead_visibility_state", key);
}

// Legacy compatibility aliases
export const getByHouseholdId = getVisibilityState;
export const getState = getVisibilityState;
export const upsertByHouseholdId = upsertVisibilityState;
export const saveState = upsertVisibilityState;

/* -------------------------------------------------------------------------- */
/* Default export (ergonomic repo object) */
/* -------------------------------------------------------------------------- */

const visibilityStateRepo = {
  // core
  ensureVisibilityState,
  getVisibilityState,
  upsertVisibilityState,
  getByHouseholdId,
  getState,
  upsertByHouseholdId,
  saveState,
  resetVisibilityState,
  patchVisibilityState,
  deleteVisibilityState,

  // panels
  dismissPanel,
  isPanelDismissed,
  clearDismissedPanels,

  // sections
  setSectionCollapsed,
  toggleSectionCollapsed,
  isSectionCollapsed,
  clearCollapsedSections,

  // flags/prefs
  setFlag,
  getFlag,
  setPreference,
  getPreference,

  // defaults
  DEFAULT_VISIBILITY_FLAGS,
  DEFAULT_PREFERENCES,
};

export default visibilityStateRepo;
