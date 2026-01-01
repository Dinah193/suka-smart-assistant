// C:\Users\larho\suka-smart-assistant\src\services\profile\householdProfileService.js
/* eslint-disable no-console */

/**
 * Household Profile Service
 * Single source of truth for cross-agent settings (Meals, Storehouse, Garden, Animals, Calendar).
 * - Schema-versioned with migrations
 * - LocalStorage persistence (pluggable adapters)
 * - Reactive subscriptions + event glue
 * - Undo-first mutation helpers
 * - Checkbox-first data model with "add-your-own" lists
 *
 * Events emitted (via automation/events if available; safe fallbacks otherwise):
 * - "preferences.changed" { at, scope: "householdProfile", changedPaths: string[] }
 * - "household.profile.updated" { profile }     // <-- added (for cuisine bias bootstrap, etc.)
 * - "ui.nba.suggest" { label, href|onClick, cta }
 */

let Events = null;
try { Events = require("@/services/automation/events"); } catch { Events = { emit: () => {}, on: () => () => {} }; }

const STORAGE_KEY = "suka.householdProfile.v2";
const SCHEMA_VERSION = 2;

/* -------------------------------------------------------------------------------------------------
 * Defaults (Torah-aligned; no Talmud/Mishna references)
 * ------------------------------------------------------------------------------------------------- */
const DEFAULTS = Object.freeze({
  _meta: { schemaVersion: SCHEMA_VERSION, createdAt: null, updatedAt: null },
  torahFood: {
    shellfishAllowed: false,
    casingPolicy: { beefCollagen: true, cellulose: true, hogCasings: false },
    permittedMeats: ["beef", "lamb", "goat", "venison", "turkey", "chicken", "duck", "fish (fins & scales)"],
    excludedFoods: [],
    fatsOils: ["olive oil", "tallow", "butter"],
  },
  household: {
    adults: 2, children: 0, infants: 0,
    specialNotes: [],
    guestsFrequency: "weekly", // "weekly" | "feast-days" | "rare"
    // NEW: cuisine bias drives resolver/usdaDefaults/template recs.
    // Store as array of strings; UI may show chips (add/remove).
    cuisineBias: ["african-american"], // default per project direction
  },
  calendar: {
    timezone: typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" : "UTC",
    monthStartMethod: "First Crescent",
    sabbathGuard: true,
    feastDaysMethod: "Observed List",
  },
  gardenAnimals: {
    zone: "",
    preferredCrops: ["beans", "wheat", "kale"],
    animalsOwned: ["chickens"],
    preservationOrder: ["canning", "drying", "fermenting", "freezing"],
    butchering: "external",
  },
  storehouse: {
    coverageDays: 90,
    budgetSensitivity: "normal", // "bulk-only" | "thrifty" | "normal"
    seasoningsStaples: ["salt", "pepper", "garlic", "onion"],
    fifoStrictness: "soft",
  },
  healthMeals: {
    macroBalance: "balanced", // "high-protein" | "balanced" | "custom"
    goals: [],
    doneness: { steak: "medium", rice: "soft", breadCrust: "soft" },
    excludedIngredients: [],
  },
  notifications: {
    recipients: ["household"],
    delivery: ["dashboard"], // "sms" | "push" | "email" | "dashboard"
    alerts: ["low stock", "feast prep", "animal health", "chore reminders"],
  },
});

/* -------------------------------------------------------------------------------------------------
 * Storage adapter (localStorage by default; can be swapped later)
 * ------------------------------------------------------------------------------------------------- */
const storage = {
  read(key = STORAGE_KEY) {
    try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; }
  },
  write(value, key = STORAGE_KEY) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { console.error(e); return false; }
  },
  remove(key = STORAGE_KEY) {
    try { localStorage.removeItem(key); } catch {}
  },
};

/* -------------------------------------------------------------------------------------------------
 * Migrations (v1 -> v2)
 * ------------------------------------------------------------------------------------------------- */
function migrateIfNeeded(raw) {
  if (!raw || typeof raw !== "object") return null;
  const v = Number(raw?._meta?.schemaVersion || 1);
  if (v === SCHEMA_VERSION) {
    // Backfill new fields if missing (e.g., cuisineBias)
    if (!raw?.household?.cuisineBias) raw.household = { ...(raw.household || {}), cuisineBias: ["african-american"] };
    return raw;
  }

  let working = { ...raw };

  // v1 -> v2: wrap any missing branches with defaults, preserve existing values
  if (v < 2) {
    const withDefaults = deepMerge(getDefaults(), working);
    withDefaults._meta = {
      schemaVersion: 2,
      createdAt: working?._meta?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    // ensure cuisineBias exists
    if (!withDefaults?.household?.cuisineBias) withDefaults.household.cuisineBias = ["african-american"];
    working = withDefaults;
  }

  // Add future migrations here…

  return working;
}

/* -------------------------------------------------------------------------------------------------
 * Utilities
 * ------------------------------------------------------------------------------------------------- */
const clone = (x) => JSON.parse(JSON.stringify(x));

function getDefaults() {
  const d = clone(DEFAULTS);
  const now = new Date().toISOString();
  d._meta.createdAt = now;
  d._meta.updatedAt = now;
  return d;
}

function deepMerge(base, patch) {
  if (Array.isArray(base)) return Array.isArray(patch) ? Array.from(new Set([...base, ...patch])) : base;
  if (typeof base !== "object" || base === null) return patch === undefined ? base : patch;

  const out = { ...base };
  for (const k of Object.keys(patch || {})) {
    out[k] = deepMerge(base[k], patch[k]);
  }
  return out;
}

function setByPath(obj, path, value) {
  const keys = String(path).split(".");
  const target = keys.slice(0, -1).reduce((acc, k) => (acc[k] ??= {}), obj);
  target[keys.at(-1)] = value;
  return obj;
}
function getByPath(obj, path, fallback) {
  return String(path).split(".").reduce((acc, k) => (acc == null ? acc : acc[k]), obj) ?? fallback;
}

const isHouseholdRelatedPath = (p) => p === "*" || p === "household" || p.startsWith("household.");

/* -------------------------------------------------------------------------------------------------
 * In-memory cache + subscribers + undo ring
 * ------------------------------------------------------------------------------------------------- */
let _cache = null;
const _subs = new Set();
const _undoRing = []; // [{ token, prev, next, paths }]
const UNDO_LIMIT = 32;

function emitProfileUpdatedIfNeeded(changedPaths, nextState) {
  // Emit when household subtree (or "*") changes
  if (!Array.isArray(changedPaths)) return;

  const shouldEmit = changedPaths.some(isHouseholdRelatedPath);
  if (!shouldEmit) return;

  // Mirror cuisineBias at root of payload as well for simpler consumers
  const profilePayload = {
    ...clone(nextState.household),
    cuisineBias: clone(nextState.household?.cuisineBias || []),
  };

  Events.emit?.("household.profile.updated", { profile: profilePayload });
}

function notify(changedPaths, nextState) {
  // app-wide change event
  Events.emit?.("preferences.changed", {
    at: new Date().toISOString(),
    scope: "householdProfile",
    changedPaths: Array.from(new Set(changedPaths || [])),
  });

  // targeted profile update (drives cuisine bias bootstrap, etc.)
  emitProfileUpdatedIfNeeded(changedPaths, nextState);

  // Suggest NBAs for impactful toggles
  try {
    const paths = new Set(changedPaths);

    if (paths.has("calendar.sabbathGuard")) {
      Events.emit?.("ui.nba.suggest", {
        label: "Recalculate schedules with Sabbath Guard",
        href: "#/tasks/run",
        cta: "Recalculate",
      });
    }
    if (paths.has("torahFood.shellfishAllowed")) {
      Events.emit?.("ui.nba.suggest", {
        label: "Refresh meal & sausage suggestions",
        href: "#/meals",
        cta: "Refresh",
      });
    }
    if (paths.has("storehouse.coverageDays")) {
      Events.emit?.("ui.nba.suggest", {
        label: "Recompute Storehouse PAR targets",
        href: "#/storehouse",
        cta: "Recompute",
      });
    }
    if (paths.has("household.cuisineBias")) {
      Events.emit?.("ui.nba.suggest", {
        label: "Refresh ingredient defaults & template picks",
        href: "#/meals/templates",
        cta: "Refresh",
      });
    }
  } catch { /* no-op */ }

  // local subscribers
  for (const fn of _subs) {
    try { fn(clone(nextState)); } catch (e) { console.warn("subscriber failed", e); }
  }
}

function pushUndo(prev, next, paths) {
  const token = `undo:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  _undoRing.push({ token, prev: clone(prev), next: clone(next), paths: Array.from(new Set(paths || [])) });
  if (_undoRing.length > UNDO_LIMIT) _undoRing.shift();
  Events.emit?.("ui.undo.offer", { token, label: "Revert profile changes" });
  return token;
}

/* -------------------------------------------------------------------------------------------------
 * Public API
 * ------------------------------------------------------------------------------------------------- */

/** Load (or create) the profile from storage, with migrations. */
export function loadProfile() {
  if (_cache) return clone(_cache);
  const raw = storage.read();
  const migrated = migrateIfNeeded(raw) ?? getDefaults();
  _cache = migrated;
  return clone(_cache);
}

/** Save whole profile atomically (replaces). Emits change events. */
export function saveProfile(next) {
  const prev = _cache || loadProfile();
  const stamped = {
    ...clone(next),
    _meta: {
      schemaVersion: SCHEMA_VERSION,
      createdAt: next?._meta?.createdAt || prev?._meta?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };
  _cache = stamped;
  storage.write(_cache);
  pushUndo(prev, _cache, ["*"]);
  notify(["*"], _cache);
  return true;
}

/** Patch the profile with a partial object (deep merge). */
export function patchProfile(partial = {}) {
  const prev = _cache || loadProfile();
  const next = deepMerge(prev, partial);
  next._meta = {
    schemaVersion: SCHEMA_VERSION,
    createdAt: prev._meta?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  _cache = next;
  storage.write(_cache);

  const paths = collectPaths(partial);
  pushUndo(prev, next, paths);
  notify(paths, _cache);
  return clone(_cache);
}

/** Set a value by dot-path (e.g., "torahFood.shellfishAllowed"). */
export function setAtPath(path, value) {
  const prev = _cache || loadProfile();
  const next = clone(prev);
  setByPath(next, path, value);
  next._meta = {
    schemaVersion: SCHEMA_VERSION,
    createdAt: prev._meta?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  _cache = next;
  storage.write(_cache);

  pushUndo(prev, next, [String(path)]);
  notify([String(path)], _cache);
  return clone(_cache);
}

/** Get a value by dot-path with fallback. */
export function getAtPath(path, fallback) {
  return getByPath(_cache || loadProfile(), path, fallback);
}

/** List helpers for checkbox-style multi-selects with "add your own". */
export function listAdd(path, item) {
  if (!item || !String(item).trim()) return loadProfile();
  const list = Array.isArray(getAtPath(path, [])) ? new Set(getAtPath(path, [])) : new Set();
  list.add(String(item).trim());
  return setAtPath(path, Array.from(list));
}
export function listRemove(path, item) {
  const list = Array.isArray(getAtPath(path, [])) ? new Set(getAtPath(path, [])) : new Set();
  list.delete(String(item).trim());
  return setAtPath(path, Array.from(list));
}
export function listToggle(path, item) {
  const list = Array.isArray(getAtPath(path, [])) ? new Set(getAtPath(path, [])) : new Set();
  const v = String(item).trim();
  list.has(v) ? list.delete(v) : list.add(v);
  return setAtPath(path, Array.from(list));
}

/** Cuisine bias convenience helpers */
export function setCuisineBias(list = []) {
  const arr = (list || []).map(String).filter(Boolean);
  return setAtPath("household.cuisineBias", arr.length ? arr : ["african-american"]);
}
export function addCuisine(tag)  { return listAdd("household.cuisineBias", tag); }
export function removeCuisine(tag) { return listRemove("household.cuisineBias", tag); }
export function toggleCuisine(tag) { return listToggle("household.cuisineBias", tag); }

/** Undo last profile-affecting change by token (from ui.undo.offer). */
export function undo(token) {
  const idx = _undoRing.findIndex((u) => u.token === token);
  if (idx === -1) return { ok: false, error: "Invalid or expired token" };
  const entry = _undoRing.splice(idx, 1)[0];
  _cache = entry.prev;
  storage.write(_cache);
  notify(entry.paths, _cache);
  return { ok: true };
}

/** Subscriptions for reactive UIs (returns unsubscribe). */
export function subscribe(fn) {
  if (typeof fn !== "function") return () => {};
  _subs.add(fn);
  try { fn(loadProfile()); } catch {}
  return () => _subs.delete(fn);
}

/* -------------------------------------------------------------------------------------------------
 * Domain selectors (agents call these; keep agents decoupled)
 * ------------------------------------------------------------------------------------------------- */
export function selectTorahFood(p = loadProfile())        { return clone(p.torahFood); }
export function selectHousehold(p = loadProfile())        { return clone(p.household); }
export function selectCalendar(p = loadProfile())         { return clone(p.calendar); }
export function selectGardenAnimals(p = loadProfile())    { return clone(p.gardenAnimals); }
export function selectStorehouse(p = loadProfile())       { return clone(p.storehouse); }
export function selectHealthMeals(p = loadProfile())      { return clone(p.healthMeals); }
export function selectNotifications(p = loadProfile())    { return clone(p.notifications); }

/* -------------------------------------------------------------------------------------------------
 * Convenience helpers for capsules/agents (checkbox-first APIs)
 * ------------------------------------------------------------------------------------------------- */
export async function getHouseholdProfile() { return loadProfile(); }
export async function setShellfishAllowed(allowed) { return setAtPath("torahFood.shellfishAllowed", !!allowed); }
export async function setSabbathGuard(enabled) { return setAtPath("calendar.sabbathGuard", !!enabled); }
export async function addPermittedMeat(item) { return listAdd("torahFood.permittedMeats", item); }
export async function removePermittedMeat(item) { return listRemove("torahFood.permittedMeats", item); }
export async function addExcludedFood(item) { return listAdd("torahFood.excludedFoods", item); }
export async function removeExcludedFood(item) { return listRemove("torahFood.excludedFoods", item); }
export async function addStaple(item) { return listAdd("storehouse.seasoningsStaples", item); }
export async function removeStaple(item) { return listRemove("storehouse.seasoningsStaples", item); }

/* -------------------------------------------------------------------------------------------------
 * Compatibility layer (legacy TIP-style callers)
 * ------------------------------------------------------------------------------------------------- */
export async function getTIP() {
  const p = loadProfile();
  return {
    shellfishAllowed: !!p.torahFood.shellfishAllowed,
    sabbath: { guardActions: !!p.calendar.sabbathGuard },
    timezone: p.calendar.timezone,
    permittedMeats: clone(p.torahFood.permittedMeats),
    casingPolicy: clone(p.torahFood.casingPolicy),
  };
}

/* -------------------------------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------------------------------- */
function collectPaths(obj, prefix = "") {
  const paths = [];
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === "object" && !Array.isArray(v)) paths.push(...collectPaths(v, p));
      else paths.push(p);
    }
  } else {
    paths.push(prefix || "*");
  }
  return paths.length ? paths : ["*"];
}

/* -------------------------------------------------------------------------------------------------
 * Public resets (useful in tests/debug)
 * ------------------------------------------------------------------------------------------------- */
export function resetToDefaults() {
  const next = getDefaults();
  _cache = next;
  storage.write(_cache);
  notify(["*"], _cache);
  return clone(_cache);
}

/* -------------------------------------------------------------------------------------------------
 * Module init
 * ------------------------------------------------------------------------------------------------- */
(function init() {
  const loaded = loadProfile();
  // ensure current schemaVersion
  if (loaded?._meta?.schemaVersion !== SCHEMA_VERSION) {
    storage.write({ ...loaded, _meta: { ...loaded._meta, schemaVersion: SCHEMA_VERSION } });
  }
  // Emit an initial household profile snapshot so bootstrap listeners can prime on first load
  emitProfileUpdatedIfNeeded(["household"], loaded);
})();
