// File: C:\Users\larho\suka-smart-assistant\src\store\CleaningPrefsStore.js
/**
 * CleaningPrefsStore (SSA)
 * -----------------------------------------------------------------------------
 * Offline-first store for cleaning preferences, cadence, rooms, supplies,
 * quiet-hours/sabbath guards, and per-household overrides.
 *
 * Goals
 *  - Browser-safe (no Node imports)
 *  - Dexie-backed if tables exist; localStorage fallback otherwise
 *  - Tolerant to missing tables / schema drift
 *  - React-friendly with subscribe/getState
 *  - Integrates with SSA eventBus + automation bus (soft deps)
 *
 * Typical consumers
 *  - Cleaning planners (weekly rhythm, deep-clean rotation)
 *  - Session builders (CleaningSessionEngine / blueprint builder)
 *  - Match tools / recommendations ("what tools do we need?")
 *  - UI Preferences panels
 *
 * Data model (single-document, id="primary")
 *  - preferences:
 *      • cadence (daily/weekly/seasonal)
 *      • rooms config & room priorities
 *      • methods & constraints (products, sensitivities, pets, kids)
 *      • supplies & restock rules
 *      • quiet hours & sabbathAware
 *
 * Public API
 *  - hydrate()
 *  - getState(), subscribe(fn)
 *  - getPrefs()
 *  - setPrefs(partial | updater, options?)
 *  - reset(kind?)
 *  - persistNow()
 *  - helpers: setRoomEnabled(), setRoomPriority(), upsertRoom(), removeRoom()
 *
 * Optional Dexie tables (if you add later)
 *  - cleaning_prefs: { id: "primary", value, updatedAt }
 */

import db from "@/services/db";

/* -----------------------------------------------------------------------------
 * Optional deps (soft)
 * -------------------------------------------------------------------------- */

let logger = null;
try {
  const mod = await import("@/utils/logger.js");
  logger = mod?.default ?? mod ?? null;
} catch {
  logger = null;
}

let eventBus = null;
try {
  const mod = await import("@/services/events/eventBus");
  eventBus = mod?.default ?? mod ?? null;
} catch {
  eventBus = null;
}

let autoBus = null;
try {
  const mod = await import("@/services/automation/eventBus.js");
  autoBus = mod?.default ?? mod ?? null;
} catch {
  autoBus = null;
}

/* -----------------------------------------------------------------------------
 * Constants
 * -------------------------------------------------------------------------- */

const SOURCE = "store.CleaningPrefsStore";
const LS_KEY = "ssa.cleaning.prefs.v1";
const LS_META = "ssa.cleaning.prefs.meta.v1";

const DEFAULTS = {
  id: "primary",
  version: 1,

  // High-level switches
  enabled: true,
  sabbathAware: true,

  // Quiet-hours guard used by planners/alerts
  quietHours: { start: "22:00", end: "07:00", deferTo: "08:00" },

  // Cleaning style preferences
  style: {
    // "whole-house flow" vs "room-by-room"
    approach: "zone", // zone | room | batch
    // preferred product types
    productStyle: "standard", // standard | diy | fragranceFree | natural
    fragranceSensitivity: "none", // none | mild | strong
    bleachAllowed: true,
    ammoniaAllowed: true,
    vinegarAllowed: true,
    pets: { hasPets: false, notes: "" },
    kids: { hasKids: false, notes: "" },
    notes: "",
  },

  // Cadence rules (the “rhythm”)
  cadence: {
    // daily micro-tasks
    daily: {
      enabled: true,
      maxMinutes: 20,
      focus: ["kitchen_reset", "bathroom_touch", "floors_spot"],
    },
    // weekly tasks
    weekly: {
      enabled: true,
      dayOfWeek: 6, // 0=Sun .. 6=Sat (default Sat)
      maxMinutes: 90,
      includeLaundry: true,
      includeBedding: true,
    },
    // rotating deep clean
    deep: {
      enabled: true,
      rotationWeeks: 4,
      maxMinutes: 120,
      // recommended focus sequence (can be overridden)
      rotation: [
        "kitchen_deep",
        "bathroom_deep",
        "bedrooms_deep",
        "living_deep",
      ],
    },
    // seasonal tasks
    seasonal: {
      enabled: true,
      spring: true,
      summer: false,
      fall: true,
      winter: false,
    },
  },

  // Rooms & zones
  // room shape:
  // { id, name, kind, enabled, priority, size, notes, tasksEnabled, suppliesOverrides }
  rooms: [
    {
      id: "kitchen",
      name: "Kitchen",
      kind: "kitchen",
      enabled: true,
      priority: 5,
      size: "m",
      notes: "",
    },
    {
      id: "bathroom",
      name: "Bathroom",
      kind: "bathroom",
      enabled: true,
      priority: 5,
      size: "m",
      notes: "",
    },
    {
      id: "bedroom",
      name: "Bedroom",
      kind: "bedroom",
      enabled: true,
      priority: 4,
      size: "m",
      notes: "",
    },
    {
      id: "living",
      name: "Living Room",
      kind: "living",
      enabled: true,
      priority: 4,
      size: "m",
      notes: "",
    },
  ],

  // Tools & supplies preferences (not inventory itself — just preferences)
  supplies: {
    // if true, planners should generate restock suggestions
    restockEnabled: true,
    lowStockThresholdPct: 0.2,
    preferredBrands: [],
    preferredStores: [],
    // “core kit” toggles
    kit: {
      microfiberCloths: true,
      scrubBrush: true,
      mop: true,
      vacuum: true,
      squeegee: false,
      gloves: true,
    },
    notes: "",
  },

  // Products (mapping to your catalogs/lexicons if present)
  products: {
    allPurpose: "all_purpose_spray",
    glass: "glass_cleaner",
    degreaser: "degreaser",
    disinfectant: "disinfectant",
    bathroom: "bathroom_cleaner",
    floor: "floor_cleaner",
    dish: "dish_soap",
    laundry: "laundry_detergent",
    notes: "",
  },

  // Automation hooks / integrations
  integrations: {
    // if true, emit events for session planning suggestions
    emitPlanningHints: true,
    // if true, planners can auto-create “cleaning sessions” from cadence
    allowAutoSessions: false,
    // if true, suggest DIY supply recipes when productStyle="diy"
    suggestDiyRecipes: true,
  },

  meta: {
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastHydratedAt: null,
    source: "defaults",
  },
};

const DEFAULT_STATE = {
  hydrated: false,
  dirty: false,
  lastUpdated: 0,
  error: null,
  source: "defaults", // defaults|dexie|localStorage
};

const state = {
  ...DEFAULT_STATE,
  prefs: { ...DEFAULTS },
};

const subs = new Set();
let persistTimer = null;

/* -----------------------------------------------------------------------------
 * Helpers
 * -------------------------------------------------------------------------- */

function safeObj(x) {
  return x && typeof x === "object" && !Array.isArray(x) ? x : {};
}
function safeArr(x) {
  return Array.isArray(x) ? x : [];
}
function isObj(x) {
  return x && typeof x === "object" && !Array.isArray(x);
}
function nowISO() {
  return new Date().toISOString();
}
function clamp(n, a, b) {
  const v = Number(n);
  if (!Number.isFinite(v)) return a;
  return Math.max(a, Math.min(b, v));
}
function deepMerge(base, patch) {
  const b = safeObj(base);
  const p = safeObj(patch);
  const out = { ...b };
  for (const k of Object.keys(p)) {
    const pv = p[k];
    const bv = out[k];
    if (isObj(pv) && isObj(bv)) out[k] = deepMerge(bv, pv);
    else out[k] = pv;
  }
  return out;
}
function emit(name, payload) {
  try {
    eventBus?.emit?.(name, payload);
  } catch {}
  try {
    autoBus?.emit?.(name, payload);
  } catch {}
}
function notify() {
  const snap = getState();
  for (const fn of subs) {
    try {
      fn(snap);
    } catch {}
  }
}
function schedulePersist(delayMs = 250) {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistNow().catch(() => {});
  }, delayMs);
}
function normalizeRoom(r) {
  const x = safeObj(r);
  const id =
    String(x.id || x.kind || x.name || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "_") || `room_${Date.now()}`;
  return {
    id,
    name: String(x.name || id).trim(),
    kind: String(x.kind || id).trim(),
    enabled: x.enabled !== false,
    priority: clamp(x.priority ?? 3, 1, 5),
    size: String(x.size || "m"),
    notes: x.notes != null ? String(x.notes) : "",
    tasksEnabled: safeObj(x.tasksEnabled),
    suppliesOverrides: safeObj(x.suppliesOverrides),
  };
}
function normalizeQuietHours(qh) {
  const q = safeObj(qh);
  return {
    start: String(q.start || DEFAULTS.quietHours.start),
    end: String(q.end || DEFAULTS.quietHours.end),
    deferTo: String(q.deferTo || DEFAULTS.quietHours.deferTo),
  };
}
function normalizePrefs(raw) {
  const r = safeObj(raw);
  const merged = deepMerge(DEFAULTS, r);

  const rooms = safeArr(merged.rooms).map(normalizeRoom);

  return {
    ...merged,
    id: "primary",
    version: DEFAULTS.version,
    enabled: merged.enabled !== false,
    sabbathAware: merged.sabbathAware !== false,
    quietHours: normalizeQuietHours(merged.quietHours),
    cadence: {
      daily: {
        enabled: merged.cadence?.daily?.enabled !== false,
        maxMinutes: clamp(
          merged.cadence?.daily?.maxMinutes ??
            DEFAULTS.cadence.daily.maxMinutes,
          5,
          120
        ),
        focus: safeArr(
          merged.cadence?.daily?.focus ?? DEFAULTS.cadence.daily.focus
        ).map(String),
      },
      weekly: {
        enabled: merged.cadence?.weekly?.enabled !== false,
        dayOfWeek: clamp(
          merged.cadence?.weekly?.dayOfWeek ??
            DEFAULTS.cadence.weekly.dayOfWeek,
          0,
          6
        ),
        maxMinutes: clamp(
          merged.cadence?.weekly?.maxMinutes ??
            DEFAULTS.cadence.weekly.maxMinutes,
          15,
          240
        ),
        includeLaundry: merged.cadence?.weekly?.includeLaundry !== false,
        includeBedding: merged.cadence?.weekly?.includeBedding !== false,
      },
      deep: {
        enabled: merged.cadence?.deep?.enabled !== false,
        rotationWeeks: clamp(
          merged.cadence?.deep?.rotationWeeks ??
            DEFAULTS.cadence.deep.rotationWeeks,
          1,
          12
        ),
        maxMinutes: clamp(
          merged.cadence?.deep?.maxMinutes ?? DEFAULTS.cadence.deep.maxMinutes,
          30,
          300
        ),
        rotation: safeArr(
          merged.cadence?.deep?.rotation ?? DEFAULTS.cadence.deep.rotation
        ).map(String),
      },
      seasonal: {
        enabled: merged.cadence?.seasonal?.enabled !== false,
        spring: merged.cadence?.seasonal?.spring !== false,
        summer: !!merged.cadence?.seasonal?.summer,
        fall: merged.cadence?.seasonal?.fall !== false,
        winter: !!merged.cadence?.seasonal?.winter,
      },
    },
    rooms,
    supplies: {
      restockEnabled: merged.supplies?.restockEnabled !== false,
      lowStockThresholdPct: clamp(
        merged.supplies?.lowStockThresholdPct ??
          DEFAULTS.supplies.lowStockThresholdPct,
        0,
        1
      ),
      preferredBrands: safeArr(merged.supplies?.preferredBrands).map(String),
      preferredStores: safeArr(merged.supplies?.preferredStores).map(String),
      kit: {
        ...DEFAULTS.supplies.kit,
        ...safeObj(merged.supplies?.kit),
      },
      notes:
        merged.supplies?.notes != null ? String(merged.supplies.notes) : "",
    },
    products: {
      ...DEFAULTS.products,
      ...safeObj(merged.products),
      notes:
        merged.products?.notes != null ? String(merged.products.notes) : "",
    },
    style: {
      ...DEFAULTS.style,
      ...safeObj(merged.style),
      pets: { ...DEFAULTS.style.pets, ...safeObj(merged.style?.pets) },
      kids: { ...DEFAULTS.style.kids, ...safeObj(merged.style?.kids) },
      notes: merged.style?.notes != null ? String(merged.style.notes) : "",
    },
    integrations: {
      ...DEFAULTS.integrations,
      ...safeObj(merged.integrations),
    },
    meta: {
      ...safeObj(DEFAULTS.meta),
      ...safeObj(merged.meta),
      updatedAt: String(merged.meta?.updatedAt || nowISO()),
    },
  };
}

/* -----------------------------------------------------------------------------
 * Persistence (Dexie preferred, localStorage fallback)
 * -------------------------------------------------------------------------- */

const TABLE_CANDIDATES = [
  "cleaning_prefs",
  "cleaningPrefs",
  "prefs_cleaning",
  "cleaning_preferences",
];

function resolveTable() {
  for (const name of TABLE_CANDIDATES) {
    const t = db?.[name];
    if (t && typeof t.put === "function" && typeof t.get === "function")
      return t;
  }
  try {
    const tables = db?.tables || [];
    for (const name of TABLE_CANDIDATES) {
      const hit = tables.find((t) => t?.name === name);
      if (hit) return hit;
    }
  } catch {}
  return null;
}

async function loadDexie() {
  const t = resolveTable();
  if (!t) return null;
  try {
    const row = await t.get("primary");
    if (!row) return null;
    return row.value || row.prefs || row.state || row;
  } catch {
    return null;
  }
}

async function saveDexie(prefs) {
  const t = resolveTable();
  if (!t) return false;
  try {
    await t.put({
      id: "primary",
      value: prefs,
      updatedAt: Date.now(),
      source: SOURCE,
    });
    return true;
  } catch {
    return false;
  }
}

function loadLS() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveLS(prefs) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(prefs));
    localStorage.setItem(
      LS_META,
      JSON.stringify({ updatedAt: Date.now(), source: SOURCE })
    );
    return true;
  } catch {
    return false;
  }
}

/* -----------------------------------------------------------------------------
 * Public API
 * -------------------------------------------------------------------------- */

export function getState() {
  return {
    hydrated: state.hydrated,
    dirty: state.dirty,
    lastUpdated: state.lastUpdated,
    error: state.error,
    source: state.source,
    prefs: getPrefs(),
  };
}

export function subscribe(fn) {
  if (typeof fn !== "function") return () => {};
  subs.add(fn);
  return () => subs.delete(fn);
}

export function getPrefs() {
  // snapshot
  const p = state.prefs || DEFAULTS;
  return {
    ...p,
    quietHours: { ...safeObj(p.quietHours) },
    cadence: {
      daily: { ...safeObj(p.cadence?.daily) },
      weekly: { ...safeObj(p.cadence?.weekly) },
      deep: { ...safeObj(p.cadence?.deep) },
      seasonal: { ...safeObj(p.cadence?.seasonal) },
    },
    rooms: safeArr(p.rooms).map((r) => ({
      ...r,
      tasksEnabled: { ...safeObj(r.tasksEnabled) },
      suppliesOverrides: { ...safeObj(r.suppliesOverrides) },
    })),
    supplies: { ...safeObj(p.supplies), kit: { ...safeObj(p.supplies?.kit) } },
    products: { ...safeObj(p.products) },
    style: {
      ...safeObj(p.style),
      pets: { ...safeObj(p.style?.pets) },
      kids: { ...safeObj(p.style?.kids) },
    },
    integrations: { ...safeObj(p.integrations) },
    meta: { ...safeObj(p.meta) },
  };
}

export async function hydrate() {
  try {
    let loaded = await loadDexie();
    let source = "dexie";

    if (!loaded) {
      loaded = loadLS();
      source = loaded ? "localStorage" : "defaults";
    }

    const prefs = normalizePrefs(loaded || DEFAULTS);

    state.prefs = prefs;
    state.hydrated = true;
    state.dirty = false;
    state.error = null;
    state.source = source;
    state.lastUpdated = Date.now();

    state.prefs.meta = {
      ...safeObj(state.prefs.meta),
      lastHydratedAt: nowISO(),
      source,
      updatedAt: nowISO(),
    };

    emit("cleaning.prefs.hydrated", { source, prefs });
    notify();

    return { ok: true, source, prefs };
  } catch (err) {
    state.error = String(err?.message || err);
    try {
      logger?.error?.("CleaningPrefsStore hydrate failed", err, {
        source: SOURCE,
      });
    } catch {}
    notify();
    return { ok: false, error: state.error };
  }
}

export async function persistNow() {
  try {
    const prefs = normalizePrefs({
      ...state.prefs,
      meta: { ...safeObj(state.prefs?.meta), updatedAt: nowISO() },
    });

    let ok = await saveDexie(prefs);
    let source = "dexie";
    if (!ok) {
      ok = saveLS(prefs);
      source = "localStorage";
    }

    if (ok) {
      state.prefs = prefs;
      state.dirty = false;
      state.lastUpdated = Date.now();
      state.source = source;

      emit("cleaning.prefs.persisted", { source, prefs });
      notify();

      return { ok: true, source };
    }

    return { ok: false, reason: "persist_failed" };
  } catch (err) {
    try {
      logger?.warn?.(
        "CleaningPrefsStore persist failed",
        { err: String(err?.message || err) },
        { source: SOURCE }
      );
    } catch {}
    return { ok: false, error: String(err?.message || err) };
  }
}

/**
 * setPrefs(partial|updater)
 * @param {object|function} partialOrUpdater
 * @param {object} [options] { persist=true, persistDelayMs=250 }
 */
export function setPrefs(partialOrUpdater, options = {}) {
  const opts = safeObj(options);
  const prev = getPrefs();
  const patch =
    typeof partialOrUpdater === "function"
      ? partialOrUpdater(prev)
      : partialOrUpdater;

  const nextRaw = deepMerge(prev, safeObj(patch));
  const next = normalizePrefs({
    ...nextRaw,
    meta: { ...safeObj(nextRaw.meta), updatedAt: nowISO() },
  });

  state.prefs = next;
  state.dirty = true;
  state.lastUpdated = Date.now();

  emit("cleaning.prefs.changed", { patch: safeObj(patch), prefs: next });
  notify();

  if (opts.persist !== false) schedulePersist(opts.persistDelayMs ?? 250);

  return getPrefs();
}

/**
 * Reset store.
 * @param {"all"|"rooms"|"cadence"|"supplies"|"products"|"style"} [kind="all"]
 */
export function reset(kind = "all") {
  const k = String(kind || "all").toLowerCase();

  if (k === "rooms") return setPrefs({ rooms: DEFAULTS.rooms });
  if (k === "cadence") return setPrefs({ cadence: DEFAULTS.cadence });
  if (k === "supplies") return setPrefs({ supplies: DEFAULTS.supplies });
  if (k === "products") return setPrefs({ products: DEFAULTS.products });
  if (k === "style") return setPrefs({ style: DEFAULTS.style });

  state.prefs = normalizePrefs({
    ...DEFAULTS,
    meta: {
      ...safeObj(DEFAULTS.meta),
      createdAt: nowISO(),
      updatedAt: nowISO(),
      source: "reset",
    },
  });
  state.dirty = true;
  state.lastUpdated = Date.now();

  emit("cleaning.prefs.reset", { prefs: getPrefs() });
  notify();
  schedulePersist(50);

  return getPrefs();
}

/* -----------------------------------------------------------------------------
 * Room helpers
 * -------------------------------------------------------------------------- */

export function upsertRoom(room, options = {}) {
  const r = normalizeRoom(room);
  const opts = safeObj(options);

  return setPrefs((prev) => {
    const rooms = safeArr(prev.rooms);
    const idx = rooms.findIndex((x) => x.id === r.id);
    const nextRooms =
      idx >= 0
        ? rooms.map((x) => (x.id === r.id ? { ...x, ...r } : x))
        : [...rooms, r];
    return { rooms: nextRooms };
  }, opts);
}

export function removeRoom(roomId, options = {}) {
  const id = String(roomId || "").trim();
  if (!id) return getPrefs();
  const opts = safeObj(options);

  return setPrefs(
    (prev) => ({ rooms: safeArr(prev.rooms).filter((r) => r.id !== id) }),
    opts
  );
}

export function setRoomEnabled(roomId, enabled, options = {}) {
  const id = String(roomId || "").trim();
  if (!id) return getPrefs();
  const opts = safeObj(options);

  return setPrefs(
    (prev) => ({
      rooms: safeArr(prev.rooms).map((r) =>
        r.id === id ? { ...r, enabled: enabled !== false } : r
      ),
    }),
    opts
  );
}

export function setRoomPriority(roomId, priority, options = {}) {
  const id = String(roomId || "").trim();
  if (!id) return getPrefs();
  const opts = safeObj(options);
  const pr = clamp(priority, 1, 5);

  return setPrefs(
    (prev) => ({
      rooms: safeArr(prev.rooms).map((r) =>
        r.id === id ? { ...r, priority: pr } : r
      ),
    }),
    opts
  );
}

/* -----------------------------------------------------------------------------
 * Auto-hydrate helper
 * -------------------------------------------------------------------------- */

let _autoHydrated = false;
export function ensureHydrated() {
  if (_autoHydrated) return;
  _autoHydrated = true;
  hydrate().catch(() => {});
}

/* -----------------------------------------------------------------------------
 * Default export facade
 * -------------------------------------------------------------------------- */

const CleaningPrefsStore = {
  getState,
  subscribe,
  hydrate,
  persistNow,
  setPrefs,
  getPrefs,
  reset,

  upsertRoom,
  removeRoom,
  setRoomEnabled,
  setRoomPriority,

  ensureHydrated,
};

export default CleaningPrefsStore;
