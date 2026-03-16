// src/services/household/HouseholdProfile.js
//
// HouseholdProfile
// ----------------
// Single source of truth for household constraints & Torah/diet preferences.
//
// Pipeline role:
//   imports → intelligence → automation(SessionRunner) → (optional) Hub export
//
// This module sits alongside the “intelligence” layer. Any domain that needs
// to respect Torah/diet/health constraints (cooking, cleaning, garden, animals,
// preservation, storehouse) should call `getHouseholdProfile(householdId)`
// and adapt its plans / StepGraphs accordingly.
//
// When a profile is changed via `updateHouseholdProfile`, this module:
//   - persists the normalized profile,
//   - emits household.profile.updated (always),
//   - emits torah.profile.updated when Torah/diet-related fields change,
//   - optionally exports to the Hub when familyFundMode is enabled.

/* ---------------------------------- Imports ---------------------------------- */

import { emitEvent } from "../events/eventBus";
import { featureFlags } from "@/config/featureFlags";
import { HubPacketFormatter } from "@/services/hub/HubPacketFormatter";
import { FamilyFundConnector } from "@/services/hub/FamilyFundConnector";

/* --------------------------------- Constants --------------------------------- */

const PROFILE_VERSION = 1;
const MODULE_SOURCE = "services.household.HouseholdProfile";

/**
 * Local subscribers for profile changes (SessionRunner, planners, etc.).
 * Each handler will receive: (profile, { householdId, reason })
 */
const profileChangeHandlers = [];

/**
 * In-memory cache to avoid repeated localStorage parsing.
 * Map<string, HouseholdProfile>
 */
const profileCache = new Map();

/* --------------------------- Public API: Get/Update -------------------------- */

/**
 * Get the normalized HouseholdProfile for a given household.
 * Always returns a complete object with defaults filled in.
 *
 * @param {string|null|undefined} householdId
 * @returns {Promise<HouseholdProfile>}
 */
export async function getHouseholdProfile(householdId) {
  const key = normalizedHouseholdId(householdId);

  // Check cache first
  if (profileCache.has(key)) {
    return profileCache.get(key);
  }

  const stored = await loadProfileFromStorage(key);
  const profile = normalizeProfile(stored || createDefaultProfile(key));

  profileCache.set(key, profile);
  return profile;
}

/**
 * Update (patch) the HouseholdProfile for a given household.
 * Returns the updated profile.
 *
 * @param {string|null|undefined} householdId
 * @param {Object} patch - Partial profile fields to update.
 * @returns {Promise<HouseholdProfile|null>} - Updated profile or null on error.
 */
export async function updateHouseholdProfile(householdId, patch) {
  const key = normalizedHouseholdId(householdId);

  if (!patch || typeof patch !== "object") {
    console.warn(
      "[HouseholdProfile] updateHouseholdProfile called with invalid patch",
      patch
    );
    return null;
  }

  const existing = await getHouseholdProfile(key);
  const prev = existing || createDefaultProfile(key);

  // Shallow merge top-level, but normalize known fields carefully.
  const merged = {
    ...prev,
    ...patch,
    hardNoIngredients: normalizeStringArray(
      patch.hardNoIngredients != null
        ? patch.hardNoIngredients
        : prev.hardNoIngredients
    ),
    softAvoidIngredients: normalizeStringArray(
      patch.softAvoidIngredients != null
        ? patch.softAvoidIngredients
        : prev.softAvoidIngredients
    ),
    allergens: normalizeStringArray(
      patch.allergens != null ? patch.allergens : prev.allergens
    ),
    cleaningBans: normalizeStringArray(
      patch.cleaningBans != null ? patch.cleaningBans : prev.cleaningBans
    ),
    gardenBans: normalizeStringArray(
      patch.gardenBans != null ? patch.gardenBans : prev.gardenBans
    ),
    animalCareBans: normalizeStringArray(
      patch.animalCareBans != null ? patch.animalCareBans : prev.animalCareBans
    ),
    macroHealthGoals: normalizeMacroHealthGoals(
      patch.macroHealthGoals != null
        ? patch.macroHealthGoals
        : prev.macroHealthGoals
    ),
    updatedAt: new Date().toISOString(),
  };

  const normalized = normalizeProfile(merged);

  // Save + update cache
  await saveProfileToStorage(key, normalized);
  profileCache.set(key, normalized);

  const ts = normalized.updatedAt;

  // Emit household-level profile update
  emitSafe({
    type: "household.profile.updated",
    ts,
    source: MODULE_SOURCE,
    data: {
      householdId: key,
      profile: strippedProfileForEvents(normalized),
    },
  });

  // If Torah/diet fields changed, emit a torah-specific event
  if (torahRelevantFieldsChanged(prev, normalized)) {
    emitSafe({
      type: "torah.profile.updated",
      ts,
      source: MODULE_SOURCE,
      data: {
        householdId: key,
        profile: strippedProfileForEvents(normalized),
      },
    });
  }

  // Notify local subscribers
  notifyProfileChangeHandlers(normalized, {
    householdId: key,
    reason: "update",
  });

  // Optionally export to Hub
  exportToHubIfEnabled({
    householdId: key,
    profile: strippedProfileForHub(normalized),
    ts,
  });

  return normalized;
}

/* ------------------------ Public API: Change Subscription -------------------- */

/**
 * Subscribe to household profile changes.
 * The handler will be called with: (profile, { householdId, reason })
 *
 * This is a convenience wrapper so callers don’t have to wire into eventBus
 * directly just to react to household.profile.updated / torah.profile.updated.
 *
 * @param {(profile: HouseholdProfile, context: {householdId: string, reason: string}) => void} handler
 * @returns {() => void} unsubscribe
 */
export function onHouseholdProfileChange(handler) {
  if (typeof handler !== "function") {
    console.warn(
      "[HouseholdProfile] onHouseholdProfileChange called with non-function handler"
    );
    return () => {};
  }

  profileChangeHandlers.push(handler);

  // Return unsubscribe function
  return () => {
    const idx = profileChangeHandlers.indexOf(handler);
    if (idx >= 0) profileChangeHandlers.splice(idx, 1);
  };
}

/* --------------------------------- Data Shape -------------------------------- */

/**
 * @typedef {Object} MacroHealthGoals
 * @property {boolean} [lowSodium]
 * @property {boolean} [highProtein]
 * @property {boolean} [lowSugar]
 * @property {boolean} [highFiber]
 * @property {boolean} [weightLoss]
 * @property {boolean} [weightGain]
 * @property {boolean} [maintenance]
 * @property {Object} [targets] - optional numeric targets (calories, protein, carbs, fats)
 * @property {string} [notes]
 */

/**
 * @typedef {Object} HouseholdProfile
 * @property {string} id
 * @property {string} householdId
 * @property {number} version
 * @property {string[]} hardNoIngredients
 * @property {string[]} softAvoidIngredients
 * @property {string[]} allergens
 * @property {string[]} cleaningBans
 * @property {string[]} gardenBans
 * @property {string[]} animalCareBans
 * @property {MacroHealthGoals} macroHealthGoals
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string} source
 */

/* --------------------------- Creation / Normalization ------------------------ */

/**
 * Normalized householdId – allows null/undefined to map to "default".
 *
 * @param {string|null|undefined} householdId
 * @returns {string}
 */
function normalizedHouseholdId(householdId) {
  if (!householdId || typeof householdId !== "string") return "default";
  return householdId.trim() || "default";
}

/**
 * Create a brand new profile with defaults.
 *
 * @param {string} householdId
 * @returns {HouseholdProfile}
 */
function createDefaultProfile(householdId) {
  const now = new Date().toISOString();

  return {
    id: `household-profile:${householdId}`,
    householdId,
    version: PROFILE_VERSION,
    hardNoIngredients: [
      "pork",
      "shellfish",
      "insects (unclean species)",
      "blood",
      "strangled meats",
    ],
    softAvoidIngredients: [
      "industrial seed oils",
      "ultra-processed foods",
      "artificial sweeteners",
    ],
    allergens: [],
    cleaningBans: ["synthetic fragrance-heavy cleaners"],
    gardenBans: ["known invasives", "banned chemicals"],
    animalCareBans: ["routine non-therapeutic antibiotics", "unclean feeds"],
    macroHealthGoals: {
      lowSodium: false,
      highProtein: false,
      lowSugar: false,
      highFiber: false,
      weightLoss: false,
      weightGain: false,
      maintenance: true,
      targets: {},
      notes: "",
    },
    createdAt: now,
    updatedAt: now,
    source: "default",
  };
}

/**
 * Normalize a stored profile into the latest contract shape.
 *
 * @param {any} raw
 * @returns {HouseholdProfile}
 */
function normalizeProfile(raw) {
  const now = new Date().toISOString();
  const householdId = normalizedHouseholdId(raw?.householdId || "default");

  const base = createDefaultProfile(householdId);

  const profile = {
    ...base,
    ...(raw && typeof raw === "object" ? raw : {}),
    version: PROFILE_VERSION,
    householdId,
    hardNoIngredients: normalizeStringArray(
      raw?.hardNoIngredients ?? base.hardNoIngredients
    ),
    softAvoidIngredients: normalizeStringArray(
      raw?.softAvoidIngredients ?? base.softAvoidIngredients
    ),
    allergens: normalizeStringArray(raw?.allergens ?? base.allergens),
    cleaningBans: normalizeStringArray(raw?.cleaningBans ?? base.cleaningBans),
    gardenBans: normalizeStringArray(raw?.gardenBans ?? base.gardenBans),
    animalCareBans: normalizeStringArray(
      raw?.animalCareBans ?? base.animalCareBans
    ),
    macroHealthGoals: normalizeMacroHealthGoals(
      raw?.macroHealthGoals ?? base.macroHealthGoals
    ),
    createdAt: raw?.createdAt || base.createdAt || now,
    updatedAt: raw?.updatedAt || now,
    source: raw?.source || "stored",
  };

  return profile;
}

/**
 * Normalize arrays of strings (dedupe, trim, lowercase for comparison).
 *
 * @param {any} input
 * @returns {string[]}
 */
function normalizeStringArray(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const result = [];

  for (const item of input) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed) continue;

    // Keep normalized lowercase for dedupe but preserve original case in result.
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }

  return result;
}

/**
 * Normalize macroHealthGoals.
 *
 * @param {any} raw
 * @returns {MacroHealthGoals}
 */
function normalizeMacroHealthGoals(raw) {
  const base = {
    lowSodium: false,
    highProtein: false,
    lowSugar: false,
    highFiber: false,
    weightLoss: false,
    weightGain: false,
    maintenance: true,
    targets: {},
    notes: "",
  };

  if (!raw || typeof raw !== "object") return base;

  const targets = {
    ...(typeof raw.targets === "object" && raw.targets !== null
      ? raw.targets
      : {}),
  };

  return {
    ...base,
    ...raw,
    targets,
    notes: typeof raw.notes === "string" ? raw.notes : base.notes,
  };
}

/* ----------------------------- Storage (Local/Adapter) ----------------------- */

/**
 * Load a profile from storage (localStorage or in-memory).
 *
 * @param {string} householdId
 * @returns {Promise<HouseholdProfile|null>}
 */
async function loadProfileFromStorage(householdId) {
  const adapter = getAdapter();
  if (adapter && typeof adapter.get === "function") {
    try {
      const result = await adapter.get(householdId);
      return result || null;
    } catch (err) {
      console.warn("[HouseholdProfile] Adapter get failed", err);
    }
  }

  // Fallback: localStorage
  if (hasLocalStorage()) {
    try {
      const key = storageKey(householdId);
      const raw = window.localStorage.getItem(key);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (err) {
      console.warn(
        "[HouseholdProfile] Failed to parse localStorage profile",
        err
      );
      return null;
    }
  }

  // Fallback: nothing persisted, rely on defaults
  return null;
}

/**
 * Save a profile to storage.
 *
 * @param {string} householdId
 * @param {HouseholdProfile} profile
 * @returns {Promise<void>}
 */
async function saveProfileToStorage(householdId, profile) {
  const adapter = getAdapter();
  if (adapter && typeof adapter.set === "function") {
    try {
      await adapter.set(householdId, profile);
    } catch (err) {
      console.warn("[HouseholdProfile] Adapter set failed", err);
    }
  }

  if (hasLocalStorage()) {
    try {
      const key = storageKey(householdId);
      window.localStorage.setItem(key, JSON.stringify(profile));
    } catch (err) {
      console.warn(
        "[HouseholdProfile] Failed to write profile to localStorage",
        err
      );
    }
  }
}

/**
 * Resolve an external adapter if available.
 * Optional extension point:
 *   globalThis.SSA_HOUSEHOLD_PROFILE_ADAPTER = { get(householdId), set(householdId, profile) }
 */
function getAdapter() {
  if (
    typeof globalThis !== "undefined" &&
    globalThis.SSA_HOUSEHOLD_PROFILE_ADAPTER
  ) {
    return globalThis.SSA_HOUSEHOLD_PROFILE_ADAPTER;
  }
  return null;
}

function hasLocalStorage() {
  try {
    return typeof window !== "undefined" && !!window.localStorage;
  } catch {
    return false;
  }
}

function storageKey(householdId) {
  return `ssa:householdProfile:${householdId}`;
}

/* ------------------------------- Events / Hub -------------------------------- */

/**
 * Safe wrapper for eventBus emit.
 *
 * @param {{ type: string, ts: string, source: string, data: any }} payload
 */
function emitSafe(payload) {
  if (typeof emitEvent !== "function") return;

  try {
    emitEvent(payload);
  } catch (err) {
    console.warn("[HouseholdProfile] Failed to emit event", err);
  }
}

/**
 * Notify local handlers for profile changes.
 *
 * @param {HouseholdProfile} profile
 * @param {{householdId: string, reason: string}} context
 */
function notifyProfileChangeHandlers(profile, context) {
  if (!profileChangeHandlers.length) return;

  for (const handler of [...profileChangeHandlers]) {
    try {
      handler(profile, context);
    } catch (err) {
      console.warn(
        "[HouseholdProfile] onHouseholdProfileChange handler threw",
        err
      );
    }
  }
}

/**
 * Determine if Torah/diet relevant fields changed between profiles.
 *
 * @param {HouseholdProfile} prev
 * @param {HouseholdProfile} next
 * @returns {boolean}
 */
function torahRelevantFieldsChanged(prev, next) {
  if (!prev || !next) return true;

  return (
    !arraysEqual(prev.hardNoIngredients, next.hardNoIngredients) ||
    !arraysEqual(prev.softAvoidIngredients, next.softAvoidIngredients) ||
    !arraysEqual(prev.allergens, next.allergens) ||
    !arraysEqual(prev.cleaningBans, next.cleaningBans) ||
    !arraysEqual(prev.gardenBans, next.gardenBans) ||
    !arraysEqual(prev.animalCareBans, next.animalCareBans) ||
    JSON.stringify(prev.macroHealthGoals || {}) !==
      JSON.stringify(next.macroHealthGoals || {})
  );
}

/**
 * Simple array equality helper (order-sensitive).
 *
 * @param {any[]} a
 * @param {any[]} b
 * @returns {boolean}
 */
function arraysEqual(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Strip profile for events (no huge nested objects).
 *
 * @param {HouseholdProfile} profile
 */
function strippedProfileForEvents(profile) {
  return {
    householdId: profile.householdId,
    version: profile.version,
    hardNoIngredients: profile.hardNoIngredients,
    softAvoidIngredients: profile.softAvoidIngredients,
    allergens: profile.allergens,
    cleaningBans: profile.cleaningBans,
    gardenBans: profile.gardenBans,
    animalCareBans: profile.animalCareBans,
    macroHealthGoals: profile.macroHealthGoals,
    updatedAt: profile.updatedAt,
  };
}

/**
 * Strip profile for Hub export (small but descriptive).
 *
 * @param {HouseholdProfile} profile
 */
function strippedProfileForHub(profile) {
  return {
    householdId: profile.householdId,
    version: profile.version,
    hardNoIngredients: profile.hardNoIngredients,
    softAvoidIngredients: profile.softAvoidIngredients,
    allergens: profile.allergens,
    cleaningBans: profile.cleaningBans,
    gardenBans: profile.gardenBans,
    animalCareBans: profile.animalCareBans,
    macroHealthGoals: profile.macroHealthGoals,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

/**
 * Optional Hub export helper.
 * Only runs when featureFlags.familyFundMode is true.
 *
 * @param {{ householdId: string, profile: any, ts: string }} payload
 */
function exportToHubIfEnabled(payload) {
  try {
    if (!featureFlags || !featureFlags.familyFundMode) return;

    const packet =
      typeof HubPacketFormatter?.format === "function"
        ? HubPacketFormatter.format("household.profile.updated", payload)
        : payload; // conservative fallback

    if (!packet) return;

    if (typeof FamilyFundConnector?.send === "function") {
      FamilyFundConnector.send(packet);
    }
  } catch (err) {
    // Fail silently by design; Hub is optional.
    console.warn("[HouseholdProfile] exportToHubIfEnabled failed", err);
  }
}
