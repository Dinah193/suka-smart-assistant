/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\services\repos\homesteadPlanner\preferences.repo.js
//
// SSA • Homestead Planner Preferences Repository
// -----------------------------------------------------------------------------
// Goals:
//  - Browser-safe (Vite) — no Node imports
//  - Dexie-backed, schema-tolerant (works even if table name differs / is absent)
//  - Deterministic defaults + sanitization
//  - Emits eventBus signals so UI/automation can react
//
// Conventions:
//  - Preferences are stored per (householdId, userId?) with a stable compound id.
//  - Household-level prefs use userId = null (or "__household__").
//  - Records are stored in a dedicated table when available; otherwise fallback
//    to a generic "kv" / "settings" table (common in SSA projects).
//
// Recommended Dexie tables (db.js):
//  - homesteadPlannerPreferences: "&id, householdId, userId, updatedAt"
//  - homesteadPlannerPreferencesHistory: "++pk, id, householdId, userId, at"
//
// If those tables don’t exist yet, this repo will still function via fallback
// storage, but you should add the tables for best performance + queryability.

const DEFAULT_SOURCE = "services/repos/homesteadPlanner/preferences.repo";

/** Event names (keep stable) */
export const HP_PREF_EVENTS = Object.freeze({
  UPDATED: "homesteadPlanner.preferences.updated",
  RESET: "homesteadPlanner.preferences.reset",
});

/** Storage table candidates in order of preference */
const TABLE_CANDIDATES = Object.freeze([
  "homesteadPlannerPreferences",
  "homesteadPlannerPrefs",
  "plannerPreferences",
  "preferences",
]);

/** Fallback KV table candidates (id/key -> value) */
const KV_TABLE_CANDIDATES = Object.freeze(["kv", "settings", "appSettings"]);

/** History table candidates */
const HISTORY_TABLE_CANDIDATES = Object.freeze([
  "homesteadPlannerPreferencesHistory",
  "homesteadPlannerPrefsHistory",
  "preferencesHistory",
]);

/** Simple deep clone safe for JSON-only data */
function jclone(x) {
  return x == null ? x : JSON.parse(JSON.stringify(x));
}

function nowISO() {
  return new Date().toISOString();
}

/** Safe object check */
function isObj(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Deep merge: src overrides dst (objects only). Arrays replaced. */
function deepMerge(dst, src) {
  if (!isObj(dst)) dst = {};
  if (!isObj(src)) return dst;

  const out = { ...dst };
  for (const [k, v] of Object.entries(src)) {
    if (isObj(v) && isObj(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}

/** Remove keys with undefined (recursively) */
function stripUndefined(x) {
  if (Array.isArray(x)) return x.map(stripUndefined);
  if (!isObj(x)) return x;

  const out = {};
  for (const [k, v] of Object.entries(x)) {
    if (v === undefined) continue;
    out[k] = stripUndefined(v);
  }
  return out;
}

/** Make a stable record id */
export function makeHomesteadPlannerPrefsId({ householdId, userId }) {
  const hid = String(householdId || "").trim();
  if (!hid) throw new Error("householdId is required");
  const uid =
    userId == null || String(userId).trim() === ""
      ? "__household__"
      : String(userId).trim();
  return `${hid}::${uid}`;
}

/** Default preferences (deterministic, safe) */
export function getHomesteadPlannerDefaults() {
  return {
    // meta
    schemaVersion: 1,

    // planning horizon / time assumptions
    planning: {
      horizonDays: 90,
      startWeekOn: "monday", // monday|sunday
      timezone: null, // if household profile provides, keep null here
      includeSeasonality: true,
    },

    // cuisine + rotation preferences (planner will interpret)
    cuisine: {
      primaryCuisineKey: null, // e.g. "aai", "southern", "west_african"
      rotationKeys: [], // ordered list of cuisines in rotation
      avoidIngredients: [], // normalized ingredient keys (string)
      preferIngredients: [], // normalized ingredient keys (string)
      avoidMethods: [], // normalized method keys (string)
      preferMethods: [], // normalized method keys (string)
      spiceHeat: "medium", // none|low|medium|high
      saltPreference: "normal", // low|normal|high
      sweetPreference: "normal", // low|normal|high
    },

    // provisioning targets behavior
    provisioning: {
      // how aggressively to provision (planner uses as multiplier / bias)
      posture: "balanced", // conservative|balanced|aggressive
      pantryBufferDays: 14,
      freezerBufferDays: 30,
      preserveSurplus: true,
      favorShelfStable: false,
      capNewSkillsPerWeek: 2,
    },

    // garden targets behavior
    garden: {
      enabled: true,
      maxBeds: null, // number|null
      maxSqFt: null, // number|null
      prioritizePerennials: false,
      includeHerbs: true,
      includeMedicinals: false,
      avoidCrops: [],
      preferCrops: [],
      irrigation: "unknown", // none|manual|drip|sprinkler|unknown
    },

    // animals targets behavior
    animals: {
      enabled: true,
      allowNewAcquisitions: true,
      maxSpeciesCount: null,
      avoidSpecies: [],
      preferSpecies: [],
      ethics: {
        noPork: true,
        noShellfish: true,
        halalLike: false,
      },
    },

    // storehouse / storage capacity assumptions
    storehouse: {
      jarsAvailable: null,
      freezerCuFt: null,
      dehydratorTrays: null,
      rootCellarAvailable: false,
    },

    // UX flags (non-critical)
    ui: {
      showExplainability: true,
      showGapsFirst: true,
      compactCards: false,
    },
  };
}

/**
 * Sanitizes / normalizes a prefs object.
 * - strips undefined
 * - ensures objects exist
 * - ensures arrays are arrays of strings where expected
 * - clamps known simple values
 */
export function sanitizeHomesteadPlannerPrefs(prefs) {
  const d = getHomesteadPlannerDefaults();
  const merged = deepMerge(d, isObj(prefs) ? prefs : {});
  const out = stripUndefined(merged);

  // Normalize arrays (strings only)
  const normalizeStrArray = (v) =>
    Array.isArray(v)
      ? v
          .map(String)
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  out.cuisine.rotationKeys = normalizeStrArray(out.cuisine.rotationKeys);
  out.cuisine.avoidIngredients = normalizeStrArray(
    out.cuisine.avoidIngredients
  );
  out.cuisine.preferIngredients = normalizeStrArray(
    out.cuisine.preferIngredients
  );
  out.cuisine.avoidMethods = normalizeStrArray(out.cuisine.avoidMethods);
  out.cuisine.preferMethods = normalizeStrArray(out.cuisine.preferMethods);

  out.garden.avoidCrops = normalizeStrArray(out.garden.avoidCrops);
  out.garden.preferCrops = normalizeStrArray(out.garden.preferCrops);
  out.animals.avoidSpecies = normalizeStrArray(out.animals.avoidSpecies);
  out.animals.preferSpecies = normalizeStrArray(out.animals.preferSpecies);

  // Clamp enums
  const clampEnum = (val, allowed, fallback) =>
    allowed.includes(val) ? val : fallback;

  out.planning.startWeekOn = clampEnum(
    out.planning.startWeekOn,
    ["monday", "sunday"],
    "monday"
  );
  out.provisioning.posture = clampEnum(
    out.provisioning.posture,
    ["conservative", "balanced", "aggressive"],
    "balanced"
  );
  out.cuisine.spiceHeat = clampEnum(
    out.cuisine.spiceHeat,
    ["none", "low", "medium", "high"],
    "medium"
  );
  out.cuisine.saltPreference = clampEnum(
    out.cuisine.saltPreference,
    ["low", "normal", "high"],
    "normal"
  );
  out.cuisine.sweetPreference = clampEnum(
    out.cuisine.sweetPreference,
    ["low", "normal", "high"],
    "normal"
  );
  out.garden.irrigation = clampEnum(
    out.garden.irrigation,
    ["none", "manual", "drip", "sprinkler", "unknown"],
    "unknown"
  );

  // Clamp numeric-ish fields
  const clampNumOrNull = (v, min, max) => {
    if (v == null || v === "") return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.max(min, Math.min(max, n));
  };

  out.planning.horizonDays =
    clampNumOrNull(out.planning.horizonDays, 7, 366) ?? 90;
  out.provisioning.pantryBufferDays =
    clampNumOrNull(out.provisioning.pantryBufferDays, 0, 365) ?? 14;
  out.provisioning.freezerBufferDays =
    clampNumOrNull(out.provisioning.freezerBufferDays, 0, 365) ?? 30;
  out.provisioning.capNewSkillsPerWeek =
    clampNumOrNull(out.provisioning.capNewSkillsPerWeek, 0, 20) ?? 2;

  out.garden.maxBeds = clampNumOrNull(out.garden.maxBeds, 0, 500);
  out.garden.maxSqFt = clampNumOrNull(out.garden.maxSqFt, 0, 200000);

  out.animals.maxSpeciesCount = clampNumOrNull(
    out.animals.maxSpeciesCount,
    0,
    200
  );

  out.storehouse.jarsAvailable = clampNumOrNull(
    out.storehouse.jarsAvailable,
    0,
    50000
  );
  out.storehouse.freezerCuFt = clampNumOrNull(
    out.storehouse.freezerCuFt,
    0,
    10000
  );
  out.storehouse.dehydratorTrays = clampNumOrNull(
    out.storehouse.dehydratorTrays,
    0,
    1000
  );

  // Ensure booleans
  const asBool = (v) => !!v;
  out.planning.includeSeasonality = asBool(out.planning.includeSeasonality);
  out.provisioning.preserveSurplus = asBool(out.provisioning.preserveSurplus);
  out.provisioning.favorShelfStable = asBool(out.provisioning.favorShelfStable);
  out.garden.enabled = asBool(out.garden.enabled);
  out.garden.prioritizePerennials = asBool(out.garden.prioritizePerennials);
  out.garden.includeHerbs = asBool(out.garden.includeHerbs);
  out.garden.includeMedicinals = asBool(out.garden.includeMedicinals);
  out.animals.enabled = asBool(out.animals.enabled);
  out.animals.allowNewAcquisitions = asBool(out.animals.allowNewAcquisitions);
  out.storehouse.rootCellarAvailable = asBool(
    out.storehouse.rootCellarAvailable
  );
  out.ui.showExplainability = asBool(out.ui.showExplainability);
  out.ui.showGapsFirst = asBool(out.ui.showGapsFirst);
  out.ui.compactCards = asBool(out.ui.compactCards);

  // Default schemaVersion
  if (!Number.isFinite(Number(out.schemaVersion))) out.schemaVersion = 1;

  return out;
}

/** Lazy-load db and eventBus (avoids hard crashes if path differs during refactors) */
async function getDbAndBus() {
  let db = null;
  let eventBus = null;

  // Dexie db
  try {
    // Prefer alias import if you use it
    const mod = await import("@/services/db");
    db = mod.db || mod.default || null;
  } catch (e1) {
    try {
      const mod = await import("../../db");
      db = mod.db || mod.default || null;
    } catch (e2) {
      // leave null
    }
  }

  // eventBus
  try {
    const mod = await import("@/services/events/eventBus");
    eventBus = mod.eventBus || mod.default || null;
  } catch (e1) {
    try {
      const mod = await import("../../events/eventBus");
      eventBus = mod.eventBus || mod.default || null;
    } catch (e2) {
      // leave null
    }
  }

  return { db, eventBus };
}

function hasTable(db, name) {
  try {
    if (!db || !db.tables) return false;
    return db.tables.some((t) => t && t.name === name);
  } catch {
    return false;
  }
}

function pickFirstExistingTable(db, candidates) {
  for (const n of candidates) if (hasTable(db, n)) return n;
  return null;
}

function emit(bus, evt, payload) {
  try {
    if (!bus) return;
    if (typeof bus.emit === "function") bus.emit(evt, payload);
    else if (typeof bus.publish === "function") bus.publish(evt, payload);
  } catch (e) {
    // Never fail persistence due to notifications
    console.warn(`[HP prefs] event emit failed: ${evt}`, e);
  }
}

/**
 * Core repo factory (dependency-injectable).
 * If you prefer explicit wiring in your services, import and call:
 *   const repo = createHomesteadPlannerPreferencesRepo({ db, eventBus })
 */
export function createHomesteadPlannerPreferencesRepo(deps = {}) {
  const injectedDb = deps.db || null;
  const injectedBus = deps.eventBus || null;

  async function resolve() {
    if (injectedDb || injectedBus)
      return { db: injectedDb, eventBus: injectedBus };
    return getDbAndBus();
  }

  async function resolveStorage(db) {
    const primary = pickFirstExistingTable(db, TABLE_CANDIDATES);
    const history = pickFirstExistingTable(db, HISTORY_TABLE_CANDIDATES);
    const kv = pickFirstExistingTable(db, KV_TABLE_CANDIDATES);
    return { primary, history, kv };
  }

  /**
   * Reads preferences, returning defaults merged with stored prefs.
   * @param {object} args
   * @param {string} args.householdId
   * @param {string|null} [args.userId]
   */
  async function getPreferences({ householdId, userId = null } = {}) {
    const { db } = await resolve();
    if (!db) {
      // no db available — return defaults only (still deterministic)
      return sanitizeHomesteadPlannerPrefs(getHomesteadPlannerDefaults());
    }

    const { primary, kv } = await resolveStorage(db);
    const id = makeHomesteadPlannerPrefsId({ householdId, userId });

    let stored = null;

    if (primary) {
      stored = await db.table(primary).get(id);
      stored = stored ? stored.prefs : null;
    } else if (kv) {
      // KV format: { key, value } or { id, value } — handle both
      const key = `homesteadPlanner.preferences.${id}`;
      const row =
        (await db.table(kv).get(key)) ||
        (await db.table(kv).get(`hpPrefs:${id}`)) ||
        null;
      stored = row ? row.value || row.val || row.data || null : null;
    }

    return sanitizeHomesteadPlannerPrefs(stored);
  }

  /**
   * Returns the raw stored record (if available). Useful for debugging.
   */
  async function getPreferencesRecord({ householdId, userId = null } = {}) {
    const { db } = await resolve();
    if (!db) return null;

    const { primary, kv } = await resolveStorage(db);
    const id = makeHomesteadPlannerPrefsId({ householdId, userId });

    if (primary) return db.table(primary).get(id);

    if (kv) {
      const key = `homesteadPlanner.preferences.${id}`;
      return (
        (await db.table(kv).get(key)) ||
        (await db.table(kv).get(`hpPrefs:${id}`)) ||
        null
      );
    }

    return null;
  }

  /**
   * Upserts preferences.
   * - By default, deep-merges patch into existing stored prefs.
   * - If replace=true, replaces stored prefs entirely.
   */
  async function setPreferences({
    householdId,
    userId = null,
    patch = {},
    replace = false,
    source = DEFAULT_SOURCE,
    reason = "user_update",
    emitEvents = true,
    writeHistory = true,
  } = {}) {
    const { db, eventBus } = await resolve();
    if (!db) {
      // still emit (optional) so callers can proceed in "no-db" environments
      const next = sanitizeHomesteadPlannerPrefs(
        replace ? patch : deepMerge(getHomesteadPlannerDefaults(), patch)
      );
      if (emitEvents) {
        emit(eventBus, HP_PREF_EVENTS.UPDATED, {
          householdId,
          userId,
          id: makeHomesteadPlannerPrefsId({ householdId, userId }),
          source,
          reason,
          updatedAt: nowISO(),
          prefs: jclone(next),
          persistence: "none",
        });
      }
      return next;
    }

    const { primary, history, kv } = await resolveStorage(db);
    const id = makeHomesteadPlannerPrefsId({ householdId, userId });

    const at = nowISO();
    const defaults = getHomesteadPlannerDefaults();

    // Build next prefs
    let currentPrefs = null;
    if (!replace) currentPrefs = await getPreferences({ householdId, userId });
    const nextPrefs = sanitizeHomesteadPlannerPrefs(
      replace ? deepMerge(defaults, patch) : deepMerge(currentPrefs, patch)
    );

    // Persist
    if (primary) {
      const table = db.table(primary);
      const record = {
        id,
        householdId: String(householdId),
        userId: userId == null ? null : String(userId),
        prefs: jclone(nextPrefs),
        schemaVersion: Number(nextPrefs.schemaVersion) || 1,
        source,
        reason,
        createdAt: at, // will be overwritten on update below if already exists
        updatedAt: at,
      };

      await db.transaction(
        "rw",
        table,
        ...(history ? [db.table(history)] : []),
        async () => {
          const existing = await table.get(id);
          if (existing && existing.createdAt)
            record.createdAt = existing.createdAt;

          await table.put(record);

          if (history && writeHistory) {
            const h = db.table(history);
            await h.add({
              id,
              householdId: record.householdId,
              userId: record.userId,
              at,
              source,
              reason,
              prefs: jclone(nextPrefs),
            });
          }
        }
      );

      if (emitEvents) {
        emit(eventBus, HP_PREF_EVENTS.UPDATED, {
          householdId,
          userId,
          id,
          source,
          reason,
          updatedAt: at,
          prefs: jclone(nextPrefs),
          persistence: "table",
          table: primary,
        });
      }

      return nextPrefs;
    }

    if (kv) {
      const table = db.table(kv);
      const keyA = `homesteadPlanner.preferences.${id}`;
      const keyB = `hpPrefs:${id}`;

      await db.transaction("rw", table, async () => {
        // Prefer keyA, but if keyB exists, update that.
        const existingA = await table.get(keyA);
        const existingB = existingA ? null : await table.get(keyB);

        const keyToUse = existingB ? keyB : keyA;

        // Attempt to preserve common KV shapes
        const base = existingB || existingA || { key: keyToUse };
        const out = {
          ...base,
          key: base.key ?? keyToUse,
          id: base.id ?? base.key ?? keyToUse,
          value: jclone(nextPrefs),
          updatedAt: at,
          source,
          reason,
        };

        await table.put(out);
      });

      if (emitEvents) {
        emit(eventBus, HP_PREF_EVENTS.UPDATED, {
          householdId,
          userId,
          id,
          source,
          reason,
          updatedAt: at,
          prefs: jclone(nextPrefs),
          persistence: "kv",
          table: kv,
        });
      }

      return nextPrefs;
    }

    // No compatible tables — return sanitized without persistence
    if (emitEvents) {
      emit(eventBus, HP_PREF_EVENTS.UPDATED, {
        householdId,
        userId,
        id,
        source,
        reason,
        updatedAt: at,
        prefs: jclone(nextPrefs),
        persistence: "none",
      });
    }
    return nextPrefs;
  }

  /**
   * Resets preferences back to defaults (stored).
   */
  async function resetPreferences({
    householdId,
    userId = null,
    source = DEFAULT_SOURCE,
    reason = "reset_to_defaults",
    emitEvents = true,
  } = {}) {
    const defaults = sanitizeHomesteadPlannerPrefs(
      getHomesteadPlannerDefaults()
    );
    const out = await setPreferences({
      householdId,
      userId,
      patch: defaults,
      replace: true,
      source,
      reason,
      emitEvents,
      writeHistory: true,
    });

    const { eventBus } = await resolve();
    if (emitEvents) {
      emit(eventBus, HP_PREF_EVENTS.RESET, {
        householdId,
        userId,
        id: makeHomesteadPlannerPrefsId({ householdId, userId }),
        source,
        reason,
        updatedAt: nowISO(),
      });
    }

    return out;
  }

  /**
   * Deletes preferences for a scope.
   */
  async function deletePreferences({
    householdId,
    userId = null,
    source = DEFAULT_SOURCE,
    reason = "delete",
    emitEvents = true,
  } = {}) {
    const { db, eventBus } = await resolve();
    if (!db) return true;

    const { primary, kv } = await resolveStorage(db);
    const id = makeHomesteadPlannerPrefsId({ householdId, userId });
    const at = nowISO();

    if (primary) {
      await db.table(primary).delete(id);
      if (emitEvents) {
        emit(eventBus, HP_PREF_EVENTS.UPDATED, {
          householdId,
          userId,
          id,
          source,
          reason,
          updatedAt: at,
          prefs: null,
          persistence: "table",
          table: primary,
          deleted: true,
        });
      }
      return true;
    }

    if (kv) {
      const t = db.table(kv);
      await t.delete(`homesteadPlanner.preferences.${id}`);
      await t.delete(`hpPrefs:${id}`);
      if (emitEvents) {
        emit(eventBus, HP_PREF_EVENTS.UPDATED, {
          householdId,
          userId,
          id,
          source,
          reason,
          updatedAt: at,
          prefs: null,
          persistence: "kv",
          table: kv,
          deleted: true,
        });
      }
      return true;
    }

    return false;
  }

  /**
   * Lists all preference records for a household (table-backed only).
   * If stored via KV fallback, this returns [] (KV tables are not reliably queryable by prefix).
   */
  async function listHouseholdPreferenceRecords({ householdId } = {}) {
    const { db } = await resolve();
    if (!db) return [];

    const { primary } = await resolveStorage(db);
    if (!primary) return [];

    return db
      .table(primary)
      .where("householdId")
      .equals(String(householdId))
      .toArray();
  }

  /**
   * Convenience: get household-level prefs and user-level prefs, then merge:
   * household baseline → user overrides (if user exists).
   */
  async function getEffectivePreferences({ householdId, userId = null } = {}) {
    const householdPrefs = await getPreferences({ householdId, userId: null });
    if (userId == null) return householdPrefs;
    const userPrefs = await getPreferences({ householdId, userId });
    // User prefs are stored as a full prefs object, but treat them as override layer.
    return sanitizeHomesteadPlannerPrefs(deepMerge(householdPrefs, userPrefs));
  }

  return Object.freeze({
    // ids + defaults
    makeId: makeHomesteadPlannerPrefsId,
    defaults: getHomesteadPlannerDefaults,
    sanitize: sanitizeHomesteadPlannerPrefs,

    // reads
    getPreferences,
    getPreferencesRecord,
    getEffectivePreferences,
    listHouseholdPreferenceRecords,

    // writes
    setPreferences,
    resetPreferences,
    deletePreferences,
  });
}

/**
 * Default singleton repo (works with your existing db/eventBus wiring).
 * Usage:
 *   import { homesteadPlannerPreferencesRepo as hpPrefs } from "@/services/repos/homesteadPlanner/preferences.repo";
 *   const prefs = await hpPrefs.getEffectivePreferences({ householdId, userId });
 */
export const homesteadPlannerPreferencesRepo =
  createHomesteadPlannerPreferencesRepo();

/* -----------------------------------------------------------------------------
Example usage (in a page/service)
------------------------------------------------------------------------------
import { homesteadPlannerPreferencesRepo as hpPrefs } from "@/services/repos/homesteadPlanner/preferences.repo";

const prefs = await hpPrefs.getEffectivePreferences({ householdId, userId });

await hpPrefs.setPreferences({
  householdId,
  userId,
  patch: {
    cuisine: { primaryCuisineKey: "aai", spiceHeat: "high" },
    provisioning: { pantryBufferDays: 21 },
  },
  source: "pages/homesteadplanner/targets",
  reason: "user_changed_settings",
});

await hpPrefs.resetPreferences({ householdId, userId, source: "settings_modal" });
----------------------------------------------------------------------------- */
