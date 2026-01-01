// C:\Users\larho\suka-smart-assistant\src\server\services\preferencesService.js
//
// Suka Smart Assistant — Preferences Service (Dynamic, ESM)
//
// Purpose:
//   Per-scope preferences with layered overrides and light validation.
//   Scopes: GLOBAL -> HOME (household) -> USER
//
// Key features:
//   • JSON persistence (data/preferences.json) with atomic-ish writes + backup
//   • Layered merge: global <- home <- user
//   • Dot-path get/set/delete, section reset
//   • Light validation for enums/known shapes
//   • TTL cache to avoid disk thrash; EventEmitter change bus
//   • Schema versioning + tiny migrations
//   • n8n-friendly payload builder
//
// ------------------------------------------------------------------------------

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";

// ---- Paths & constants -------------------------------------------------------
const DATA_DIR = path.resolve(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "preferences.json");
const BAK_PATH = path.join(DATA_DIR, "preferences.bak.json");

const CACHE_TTL_MS = Number(process.env.PREFS_CACHE_TTL_MS || 5_000);
const SCHEMA_VERSION = 2; // bumped (adds home scope, sabbath defaults, labels/n8n alignment)

// ---- In-memory cache & bus ---------------------------------------------------
let _cache = null; // { data, loadedAt }
const bus = new EventEmitter();

// ---- Utilities ---------------------------------------------------------------
const nowISO = () => new Date().toISOString();

function deepMerge(target, source) {
  if (Array.isArray(target) || Array.isArray(source)) {
    return Array.isArray(source) ? source.slice() : source;
  }
  const out = { ...(target || {}) };
  for (const [k, v] of Object.entries(source || {})) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? deepMerge(out[k], v) : v;
  }
  return out;
}

function getAtPath(obj, dotPath, fallback) {
  if (!dotPath) return obj;
  const parts = String(dotPath).split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return fallback;
    cur = cur[p];
  }
  return cur === undefined ? fallback : cur;
}

function setAtPath(obj, dotPath, value) {
  const parts = String(dotPath).split(".");
  let cur = obj;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (i === parts.length - 1) cur[p] = value;
    else {
      cur[p] = cur[p] && typeof cur[p] === "object" ? cur[p] : {};
      cur = cur[p];
    }
  }
}

function delAtPath(obj, dotPath) {
  const parts = String(dotPath).split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur?.[parts[i]];
    if (!cur) return false;
  }
  return delete cur[parts.at(-1)];
}

async function ensureDataDir() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
}
async function readRawFile() {
  await ensureDataDir();
  try {
    const raw = await fsp.readFile(DB_PATH, "utf8");
    return raw ? JSON.parse(raw) : { users: {}, homes: {}, _meta: {} };
  } catch (e) {
    if (e.code === "ENOENT") return { users: {}, homes: {}, _meta: {} };
    throw e;
  }
}
async function writeRawFile(obj) {
  const json = JSON.stringify(obj, null, 2);
  await fsp.writeFile(BAK_PATH, json, "utf8").catch(() => {});
  const tmp = `${DB_PATH}.tmp`;
  await fsp.writeFile(tmp, json, "utf8");
  await fsp.rename(tmp, DB_PATH);
  _cache = { data: obj, loadedAt: Date.now() };
}

async function loadDbCached() {
  if (_cache && Date.now() - _cache.loadedAt < CACHE_TTL_MS) return _cache.data;
  const data = await readRawFile();
  _cache = { data, loadedAt: Date.now() };
  return data;
}

// ---- Defaults & schema -------------------------------------------------------
export function getDefaultPreferences() {
  const now = nowISO();
  return {
    _meta: { schemaVersion: SCHEMA_VERSION, createdAt: now, updatedAt: now },

    // UI/UX
    ui: {
      theme: "system",                 // 'light' | 'dark' | 'system'
      density: "comfortable",          // 'compact' | 'comfortable'
      locale: "en-US",
      timezone: process.env.TZ || "America/New_York",
      dashboard: { showTips: true, startPanel: "meals" }, // 'meals' | 'cleaning' | 'garden' | 'inventory' | 'calendar'
    },

    // Notifications
    notifications: {
      channels: { inApp: true, email: false, sms: false, push: false },
      quietHours: { enabled: true, start: "21:00", end: "07:00" },
      digest: { enabled: true, frequency: "daily", hour: 8 }, // 24h local
    },

    // Meal planning & cooking
    meals: {
      diet: { kosherStyle: true, pork: false, shellfish: false },
      portions: { default: 4, adults: 2, children: 2 },
      cadence: { breakfast: true, lunch: true, dinner: true, snacks: false },
      proteins: ["chicken", "beef", "fish"],
      breads: ["white", "wheat", "sourdough", "cornbread"],
      veggies: ["lettuce", "spinach", "tomato", "broccoli", "onion", "pepper"],
      batchCooking: { enabled: true, sessionDay: "Sunday", sessionHour: 14, warmUpTips: true },
      donenessHints: { vegetables: "tender-crisp", meat: "medium" }, // enums validated below
    },

    // Cleaning
    cleaning: {
      rooms: { living: 1, kitchen: 1, bathroom: 1, bedroom: 2 },
      weekly: {
        living: ["dust surfaces", "vacuum", "declutter 10 min"],
        kitchen: ["wipe counters", "clean sink", "sweep/mop"],
        bathroom: ["scrub toilet", "wipe sink/mirror", "mop"],
        bedroom: ["change linens", "dust", "vacuum"],
      },
      deepClean: { starter: ["ceiling fan blades", "baseboards", "oven deep clean", "fridge purge"], cadenceWeeks: 12 },
    },

    // Garden
    garden: {
      zone: "8a",
      bedUnits: "ft", // 'ft' | 'm'
      irrigation: { defaultMinutes: 20, smartAdjust: true },
      preservation: { defaultMethods: ["freeze", "can", "dehydrate", "ferment"], labelTemplateId: null },
      alerts: { pestEarlyWarning: true, harvestWindows: true, soilCheckDays: ["Mon"] },
    },

    // Animals
    animals: {
      species: [],
      feedUnits: "lb", // 'lb' | 'kg'
      health: { dewormingReminders: true, vaccinationCalendar: true },
      manureToCompost: { enabled: true, coverOnRain: true },
    },

    // Inventory & storehouse
    inventory: {
      units: "imperial",  // 'imperial' | 'metric'
      lowStockThreshold: 2,
      autoLinkRecipes: true,
      locations: ["Pantry", "Freezer", "Fridge", "Root Cellar"],
    },

    // Labels
    labels: { defaultTemplateId: null, showQrOnFood: true, showBarcodeOnFood: false },

    // Calendar / Sabbath awareness
    calendar: {
      integrateGoogle: false,
      integrateOutlook: false,
      sabbathAware: true,
      sabbathIsSaturday: true,     // default per project chats
      sabbathSunsetOffsetMin: 30,  // finish cooking before candle lighting
    },

    // Automations / n8n
    automations: {
      n8n: {
        enabled: false,
        baseUrl: process.env.N8N_BASE_URL || "",
        webhookHashMap: {}, // { key: hash }
      },
      runSafety: { requireConfirmForDestructive: true },
    },

    // Fitness
    fitness: { weeklyGoalMinutes: 150, intensityPreference: "moderate", integrateCookingAsExercise: true },

    // Feature flags
    features: {
      recipeScanner: true,
      batchSessionPlanner: true,
      inventorySyncModal: true,
      wazeMapping: false,
    },
  };
}

// Light migrations when loading older files
function migrateIfNeeded(db) {
  const v = db?._meta?.schemaVersion || 1;
  if (v >= SCHEMA_VERSION) return db;

  // Add top-level containers if missing
  db.users = db.users || {};
  db.homes = db.homes || {};
  db._meta = { ...(db._meta || {}), schemaVersion: SCHEMA_VERSION, migratedAt: nowISO() };

  // v1 -> v2: introduce homes scope, calendar.sabbathIsSaturday default, inventory locations capitalization
  for (const userId of Object.keys(db.users)) {
    const p = db.users[userId]?.preferences || {};
    if (p.calendar && p.calendar.sabbathIsSaturday === undefined) {
      p.calendar.sabbathIsSaturday = true;
    }
    if (p.inventory?.locations) {
      p.inventory.locations = p.inventory.locations.map((s) =>
        String(s).replace(/\b\w/g, (c) => c.toUpperCase())
      );
    }
    db.users[userId].preferences = p;
  }
  return db;
}

// ---- Validation (light) ------------------------------------------------------
const enumSets = {
  theme: new Set(["light", "dark", "system"]),
  density: new Set(["compact", "comfortable"]),
  intensity: new Set(["light", "moderate", "vigorous"]),
  units: new Set(["imperial", "metric"]),
  bedUnits: new Set(["ft", "m"]),
  donenessVeg: new Set(["soft", "tender-crisp"]),
  donenessMeat: new Set(["rare", "medium", "well"]),
};

function validatePreferences(pref) {
  if (!pref || typeof pref !== "object") throw new Error("Invalid preferences payload (not an object)");

  if (pref.ui?.theme && !enumSets.theme.has(pref.ui.theme)) throw new Error(`ui.theme must be one of ${[...enumSets.theme].join(", ")}`);
  if (pref.ui?.density && !enumSets.density.has(pref.ui.density)) throw new Error(`ui.density must be one of ${[...enumSets.density].join(", ")}`);
  if (pref.inventory?.units && !enumSets.units.has(pref.inventory.units)) throw new Error(`inventory.units must be one of ${[...enumSets.units].join(", ")}`);
  if (pref.garden?.bedUnits && !enumSets.bedUnits.has(pref.garden.bedUnits)) throw new Error(`garden.bedUnits must be one of ${[...enumSets.bedUnits].join(", ")}`);
  if (pref.fitness?.intensityPreference && !enumSets.intensity.has(pref.fitness.intensityPreference)) throw new Error(`fitness.intensityPreference must be one of ${[...enumSets.intensity].join(", ")}`);
  if (pref.meals?.donenessHints?.vegetables && !enumSets.donenessVeg.has(pref.meals.donenessHints.vegetables)) throw new Error(`meals.donenessHints.vegetables must be one of ${[...enumSets.donenessVeg].join(", ")}`);
  if (pref.meals?.donenessHints?.meat && !enumSets.donenessMeat.has(pref.meals.donenessHints.meat)) throw new Error(`meals.donenessHints.meat must be one of ${[...enumSets.donenessMeat].join(", ")}`);

  return true;
}

// ---- API: scope helpers ------------------------------------------------------
function normalizeScope({ userId = "global", homeId = "default" } = {}) {
  // "global" remains a special user; home defaults go under homes[homeId]
  return { userId, homeId };
}

/**
 * Layered effective prefs:
 * defaults <- global overrides <- home overrides <- user overrides
 */
export async function getAllPreferences(userId = "global", homeId = "default") {
  const dbRaw = await loadDbCached();
  const db = migrateIfNeeded(dbRaw);

  const defaults = getDefaultPreferences();
  const globalOverrides = db.users?.global?.preferences || {};
  const homeOverrides = db.homes?.[homeId]?.preferences || {};
  const userOverrides = db.users?.[userId]?.preferences || {};

  const merged = deepMerge(defaults, deepMerge(globalOverrides, deepMerge(homeOverrides, userOverrides)));
  return merged;
}

/** Raw stored overrides (not merged) by scope */
export async function getStoredPreferences(userId = "global", homeId = "default") {
  const db = await loadDbCached();
  return {
    global: db.users?.[ "global" ]?.preferences || {},
    home: db.homes?.[homeId]?.preferences || {},
    user: db.users?.[userId]?.preferences || {},
  };
}

// ---- API: update (bulk) ------------------------------------------------------
export async function updatePreferences(scope = {}, patch = {}) {
  const { userId, homeId } = normalizeScope(scope);
  if (!patch || typeof patch !== "object") throw new Error("updatePreferences: patch must be an object");

  // Validate against effective result
  const current = await getAllPreferences(userId, homeId);
  const next = deepMerge(current, patch);
  validatePreferences(next);

  // Persist into the most specific scope by default (user), unless scope.level provided
  const level = scope.level || "user"; // 'user' | 'home' | 'global'

  const db = await loadDbCached();
  db.users = db.users || {};
  db.homes = db.homes || {};
  const now = nowISO();

  if (level === "global") {
    if (!db.users.global) db.users.global = { preferences: {}, _meta: {} };
    db.users.global.preferences = deepMerge(db.users.global.preferences, patch);
    db.users.global._meta.updatedAt = now;
  } else if (level === "home") {
    if (!db.homes[homeId]) db.homes[homeId] = { preferences: {}, _meta: {} };
    db.homes[homeId].preferences = deepMerge(db.homes[homeId].preferences, patch);
    db.homes[homeId]._meta.updatedAt = now;
  } else {
    if (!db.users[userId]) db.users[userId] = { preferences: {}, _meta: {} };
    db.users[userId].preferences = deepMerge(db.users[userId].preferences, patch);
    db.users[userId]._meta.updatedAt = now;
  }

  db._meta = { ...(db._meta || {}), schemaVersion: SCHEMA_VERSION, updatedAt: now };
  await writeRawFile(db);
  bus.emit("changed", { userId, homeId, patch, level });
  return getAllPreferences(userId, homeId);
}

// ---- API: dot-path set/get/delete -------------------------------------------
export async function setPreference(scope = {}, dotPath, value) {
  const { userId, homeId } = normalizeScope(scope);
  if (!dotPath) throw new Error("setPreference: dotPath required");

  // build test merge for validation
  const merged = await getAllPreferences(userId, homeId);
  const testMerged = JSON.parse(JSON.stringify(merged));
  setAtPath(testMerged, dotPath, value);
  validatePreferences(testMerged);

  // persist (most specific by default)
  const level = scope.level || "user";
  const db = await loadDbCached();
  db.users = db.users || {};
  db.homes = db.homes || {};
  const now = nowISO();

  const target =
    level === "global"
      ? (db.users.global = db.users.global || { preferences: {}, _meta: {} })
      : level === "home"
      ? (db.homes[homeId] = db.homes[homeId] || { preferences: {}, _meta: {} })
      : (db.users[userId] = db.users[userId] || { preferences: {}, _meta: {} });

  setAtPath(target.preferences, dotPath, value);
  target._meta.updatedAt = now;
  db._meta = { ...(db._meta || {}), schemaVersion: SCHEMA_VERSION, updatedAt: now };
  await writeRawFile(db);
  bus.emit("changed", { userId, homeId, path: dotPath, value, level });
  return getPreference({ userId, homeId }, dotPath);
}

export async function getPreference(scope = {}, dotPath, fallback = undefined) {
  const { userId, homeId } = normalizeScope(scope);
  const merged = await getAllPreferences(userId, homeId);
  return getAtPath(merged, dotPath, fallback);
}

export async function deletePreference(scope = {}, dotPath) {
  const { userId, homeId } = normalizeScope(scope);
  if (!dotPath) throw new Error("deletePreference: dotPath required");

  const level = scope.level || "user";
  const db = await loadDbCached();

  let target =
    level === "global" ? db.users?.global :
    level === "home" ? db.homes?.[homeId] :
    db.users?.[userId];

  if (!target?.preferences) return false;

  const ok = delAtPath(target.preferences, dotPath);
  if (ok) {
    target._meta = { ...(target._meta || {}), updatedAt: nowISO() };
    await writeRawFile(db);
    bus.emit("changed", { userId, homeId, path: dotPath, deleted: true, level });
  }
  return ok;
}

// ---- API: reset sections -----------------------------------------------------
/**
 * Reset one or more top-level sections at chosen level.
 * scope.level controls which layer is wiped: 'user' | 'home' | 'global'
 */
export async function resetPreferences(scope = {}, sections = []) {
  const { userId, homeId } = normalizeScope(scope);
  const level = scope.level || "user";
  const db = await loadDbCached();

  let container =
    level === "global"
      ? (db.users.global = db.users.global || { preferences: {}, _meta: {} })
      : level === "home"
      ? (db.homes[homeId] = db.homes[homeId] || { preferences: {}, _meta: {} })
      : (db.users[userId] = db.users[userId] || { preferences: {}, _meta: {} });

  if (!Array.isArray(sections) || sections.length === 0) {
    container.preferences = {};
  } else {
    for (const key of sections) if (container.preferences[key] !== undefined) delete container.preferences[key];
  }
  container._meta.updatedAt = nowISO();
  await writeRawFile(db);
  bus.emit("changed", { userId, homeId, reset: sections.length ? sections : "ALL", level });
  return true;
}

// ---- Features (flags) --------------------------------------------------------
export async function listFeatureFlags(scope = {}) {
  const merged = await getAllPreferences(scope.userId, scope.homeId);
  return merged.features || {};
}
export async function setFeatureFlag(scope = {}, flagKey, enabled) {
  if (typeof enabled !== "boolean") throw new Error("setFeatureFlag: enabled must be boolean");
  return setPreference({ ...scope }, `features.${flagKey}`, enabled);
}

// ---- Events ------------------------------------------------------------------
export function onChange(listener) {
  bus.on("changed", listener);
  return () => bus.off("changed", listener);
}

// ---- Init / health -----------------------------------------------------------
export async function init() {
  await ensureDataDir();
  try {
    await fsp.access(DB_PATH, fs.constants.F_OK);
  } catch {
    const seed = { users: { global: { preferences: {}, _meta: { createdAt: nowISO(), updatedAt: nowISO() } } }, homes: {}, _meta: { schemaVersion: SCHEMA_VERSION, createdAt: nowISO(), updatedAt: nowISO() } };
    await writeRawFile(seed);
  }
  // on first load, run migration & persist if changed
  const db = migrateIfNeeded(await loadDbCached());
  await writeRawFile(db);
  return true;
}

export async function ping() {
  try {
    const db = await loadDbCached();
    return { ok: true, users: Object.keys(db.users || {}).length, homes: Object.keys(db.homes || {}).length };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// ---- n8n payload helper ------------------------------------------------------
export function buildN8nPayload({ userId = "global", homeId = "default", includeMerged = true } = {}) {
  const base = { userId, homeId, sentAt: nowISO(), schemaVersion: SCHEMA_VERSION };
  return includeMerged
    ? { ...base, preferences: null } // callers often fill merged before sending to avoid async inside builder
    : base;
}

// ---- Default export ----------------------------------------------------------
const PreferencesService = {
  // lifecycle
  init,
  ping,

  // defaults & merging
  getDefaultPreferences,
  getAllPreferences,
  getStoredPreferences,
  resetPreferences,

  // single get/set/delete
  getPreference,
  setPreference,
  deletePreference,

  // bulk
  updatePreferences,

  // features
  listFeatureFlags,
  setFeatureFlag,

  // events
  onChange,

  // n8n
  buildN8nPayload,
};

export default PreferencesService;
