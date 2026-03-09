// File: C:\Users\larho\suka-smart-assistant\src\services\calendar\state.js
/**
 * Calendar State (SSA)
 * -----------------------------------------------------------------------------
 * Browser-safe, Dexie-backed, event-driven calendar state store.
 *
 * Goals
 *  - Centralize calendar-related state used across SSA modules:
 *      • selectedDate / activeRange
 *      • viewMode (day|week|month|agenda)
 *      • "overlay" sources (sessions, chores, meal plans, garden, animals)
 *      • user preferences (week starts, sabbath-aware hints, quiet hours)
 *      • cached computed "day cards" (for dashboard/home)
 *  - Offline-first via Dexie when available
 *  - Safe if DB tables do not exist (falls back to localStorage + memory)
 *  - Emits events for UI and automation systems
 *
 * API
 *  - getState()
 *  - setState(patch | updater)
 *  - subscribe(fn) -> unsubscribe
 *  - hydrate() -> loads persisted state
 *  - persistNow() -> writes state
 *  - reset(kind?)
 *  - selectors:
 *      • getSelectedDate()
 *      • getActiveRange()
 *      • getViewMode()
 *      • getPreferences()
 *
 * Notes
 *  - This state is UI-friendly and not meant as the canonical calendar DB.
 *  - Actual calendar events can live in a separate table (CalendarManager).
 */

import db from "@/services/db";

/* -----------------------------------------------------------------------------
 * Optional deps (soft)
 * -------------------------------------------------------------------------- */

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

let logger = null;
try {
  const mod = await import("@/utils/logger.js");
  logger = mod?.default ?? null;
} catch {
  logger = null;
}

/* -----------------------------------------------------------------------------
 * Constants
 * -------------------------------------------------------------------------- */

const SOURCE = "services.calendar.state";
const STORAGE_KEY = "ssa.calendar.state.v1";
const STORAGE_META_KEY = "ssa.calendar.state.meta.v1";

const DEFAULTS = {
  version: 1,
  hydrated: false,
  dirty: false,
  lastUpdated: 0,

  viewMode: "month", // day|week|month|agenda
  selectedDateISO: new Date().toISOString().slice(0, 10), // YYYY-MM-DD
  activeRange: {
    startISO: null, // YYYY-MM-DD
    endISO: null, // YYYY-MM-DD (inclusive)
  },

  preferences: {
    weekStartsOn: 0, // 0=Sun, 1=Mon
    sabbathAware: true,
    quietHours: { start: "22:00", end: "07:00" },
    showSunset: true,
    timezone: null, // best-effort; UI can pass IANA
    locale: null,
  },

  overlays: {
    // toggles for overlay layers that calendar UI can render
    sessions: true,
    chores: true,
    meals: true,
    garden: true,
    animals: true,
    finance: false,
  },

  caches: {
    // small cache of computed day cards (dashboard/home)
    // by dateISO -> { updatedAt, items: [...] }
    dayCards: {},
  },
};

/* -----------------------------------------------------------------------------
 * Internal state
 * -------------------------------------------------------------------------- */

const state = {
  ...DEFAULTS,
};

const subs = new Set();
let persistTimer = null;

/* -----------------------------------------------------------------------------
 * Helpers
 * -------------------------------------------------------------------------- */

function emit(name, payload) {
  try {
    eventBus?.emit?.(name, payload);
  } catch {
    // ignore
  }
  try {
    autoBus?.emit?.(name, payload);
  } catch {
    // ignore
  }
}

function notify() {
  for (const fn of subs) {
    try {
      fn(getState());
    } catch {
      // ignore subscriber errors
    }
  }
}

function isObj(x) {
  return x && typeof x === "object" && !Array.isArray(x);
}

function safeObj(x) {
  return isObj(x) ? x : {};
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

function clamp(n, a, b) {
  const v = Number(n);
  if (!Number.isFinite(v)) return a;
  return Math.max(a, Math.min(b, v));
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeDateISO(dateISO) {
  const s = String(dateISO || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return todayISO();
  return d.toISOString().slice(0, 10);
}

function normalizeViewMode(mode) {
  const m = String(mode || "").toLowerCase();
  if (["day", "week", "month", "agenda"].includes(m)) return m;
  return DEFAULTS.viewMode;
}

function normalizePreferences(prefs) {
  const p = safeObj(prefs);
  const quiet = safeObj(p.quietHours);
  return {
    weekStartsOn: clamp(
      p.weekStartsOn ?? DEFAULTS.preferences.weekStartsOn,
      0,
      1
    ),
    sabbathAware: p.sabbathAware !== false,
    quietHours: {
      start: String(quiet.start || DEFAULTS.preferences.quietHours.start),
      end: String(quiet.end || DEFAULTS.preferences.quietHours.end),
    },
    showSunset: p.showSunset !== false,
    timezone: p.timezone ?? null,
    locale: p.locale ?? null,
  };
}

function normalizeOverlays(overlays) {
  const o = safeObj(overlays);
  const out = { ...DEFAULTS.overlays };
  for (const k of Object.keys(out)) {
    if (typeof o[k] === "boolean") out[k] = o[k];
  }
  return out;
}

function normalizeCaches(caches) {
  const c = safeObj(caches);
  const dayCards = safeObj(c.dayCards);
  // Keep cache small to avoid bloat
  const keys = Object.keys(dayCards);
  let trimmed = dayCards;
  if (keys.length > 60) {
    const sorted = keys
      .map((k) => ({ k, at: Number(dayCards[k]?.updatedAt || 0) }))
      .sort((a, b) => b.at - a.at)
      .slice(0, 60)
      .map((x) => x.k);
    trimmed = {};
    for (const k of sorted) trimmed[k] = dayCards[k];
  }
  return { dayCards: trimmed };
}

function normalizeStateShape(raw) {
  const r = safeObj(raw);
  const selectedDateISO = normalizeDateISO(
    r.selectedDateISO || DEFAULTS.selectedDateISO
  );

  const range = safeObj(r.activeRange);
  const startISO = range.startISO ? normalizeDateISO(range.startISO) : null;
  const endISO = range.endISO ? normalizeDateISO(range.endISO) : null;

  const viewMode = normalizeViewMode(r.viewMode || DEFAULTS.viewMode);

  return {
    ...DEFAULTS,
    ...r,
    version: DEFAULTS.version,
    viewMode,
    selectedDateISO,
    activeRange: { startISO, endISO },
    preferences: normalizePreferences(r.preferences),
    overlays: normalizeOverlays(r.overlays),
    caches: normalizeCaches(r.caches),
    hydrated: !!r.hydrated,
    dirty: !!r.dirty,
    lastUpdated: Number(r.lastUpdated || 0),
  };
}

function schedulePersist(delayMs = 250) {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistNow().catch(() => {});
  }, delayMs);
}

/* -----------------------------------------------------------------------------
 * Persistence (Dexie preferred, localStorage fallback)
 * -------------------------------------------------------------------------- */

const TABLE_CANDIDATES = [
  "calendar_state",
  "calendarState",
  "ui_state_calendar",
  "uiCalendarState",
];

function resolveTable() {
  for (const name of TABLE_CANDIDATES) {
    const t = db?.[name];
    if (t && typeof t.put === "function" && typeof t.get === "function")
      return t;
  }
  try {
    const tables = db?.tables || [];
    return tables.find((t) => TABLE_CANDIDATES.includes(t?.name)) || null;
  } catch {
    return null;
  }
}

async function loadFromDexie() {
  const t = resolveTable();
  if (!t) return null;
  try {
    // standard key: "primary"
    const row = await t.get("primary");
    if (!row) return null;
    return row?.value || row?.state || row;
  } catch {
    return null;
  }
}

async function saveToDexie(snapshot) {
  const t = resolveTable();
  if (!t) return false;
  try {
    await t.put({
      id: "primary",
      value: snapshot,
      updatedAt: Date.now(),
      source: SOURCE,
    });
    return true;
  } catch {
    return false;
  }
}

function loadFromLocalStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveToLocalStorage(snapshot) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    localStorage.setItem(
      STORAGE_META_KEY,
      JSON.stringify({ updatedAt: Date.now(), version: DEFAULTS.version })
    );
    return true;
  } catch {
    return false;
  }
}

/* -----------------------------------------------------------------------------
 * Public API
 * -------------------------------------------------------------------------- */

/**
 * Get current state (immutable snapshot)
 */
export function getState() {
  return {
    ...state,
    preferences: {
      ...state.preferences,
      quietHours: { ...state.preferences.quietHours },
    },
    overlays: { ...state.overlays },
    activeRange: { ...state.activeRange },
    caches: {
      ...state.caches,
      dayCards: { ...state.caches.dayCards },
    },
  };
}

/**
 * Subscribe to changes
 */
export function subscribe(fn) {
  if (typeof fn !== "function") return () => {};
  subs.add(fn);
  return () => subs.delete(fn);
}

/**
 * Set state with patch or updater(state)->patch
 */
export function setState(patchOrUpdater, options = {}) {
  const opts = safeObj(options);
  const prev = getState();

  const patch =
    typeof patchOrUpdater === "function"
      ? patchOrUpdater(prev)
      : patchOrUpdater;

  const p = safeObj(patch);

  // Normalize key parts
  const merged = deepMerge(state, p);

  merged.viewMode = normalizeViewMode(merged.viewMode);
  merged.selectedDateISO = normalizeDateISO(merged.selectedDateISO);
  merged.activeRange = {
    startISO: merged.activeRange?.startISO
      ? normalizeDateISO(merged.activeRange.startISO)
      : null,
    endISO: merged.activeRange?.endISO
      ? normalizeDateISO(merged.activeRange.endISO)
      : null,
  };
  merged.preferences = normalizePreferences(merged.preferences);
  merged.overlays = normalizeOverlays(merged.overlays);
  merged.caches = normalizeCaches(merged.caches);

  merged.lastUpdated = Date.now();
  merged.dirty = opts.persist === false ? true : true; // always mark dirty; persistNow clears
  merged.hydrated = state.hydrated || !!opts.hydrated;

  Object.assign(state, merged);

  emit("calendar.state.changed", { patch: p, next: getState() });
  notify();

  if (opts.persist !== false) schedulePersist(opts.persistDelayMs ?? 250);

  return getState();
}

/**
 * Hydrate state from persistence
 */
export async function hydrate() {
  try {
    let loaded = await loadFromDexie();
    if (!loaded) loaded = loadFromLocalStorage();

    if (loaded) {
      const normalized = normalizeStateShape({
        ...loaded,
        hydrated: true,
        dirty: false,
      });
      Object.assign(state, normalized);
      emit("calendar.state.hydrated", { state: getState() });
      notify();
      return {
        ok: true,
        source: loaded ? "persisted" : "defaults",
        state: getState(),
      };
    }

    // defaults
    Object.assign(state, {
      ...DEFAULTS,
      hydrated: true,
      dirty: false,
      lastUpdated: Date.now(),
    });
    emit("calendar.state.hydrated", { state: getState() });
    notify();
    return { ok: true, source: "defaults", state: getState() };
  } catch (err) {
    try {
      logger?.warn?.("calendar.state hydrate failed", err, { source: SOURCE });
    } catch {
      // ignore
    }
    return { ok: false, error: String(err?.message || err) };
  }
}

/**
 * Persist immediately
 */
export async function persistNow() {
  const snapshot = normalizeStateShape({
    ...getState(),
    hydrated: true,
    dirty: false,
  });
  // Do not persist ephemeral flags
  snapshot.dirty = false;

  let ok = await saveToDexie(snapshot);
  if (!ok) ok = saveToLocalStorage(snapshot);

  if (ok) {
    state.dirty = false;
    state.lastUpdated = Date.now();
    emit("calendar.state.persisted", { state: getState() });
    notify();
    return { ok: true };
  }

  return { ok: false, reason: "persist_failed" };
}

/**
 * Reset state
 * @param {"all"|"view"|"prefs"|"overlays"|"caches"} [kind="all"]
 */
export function reset(kind = "all") {
  const k = String(kind || "all").toLowerCase();

  if (k === "view") {
    return setState({
      viewMode: DEFAULTS.viewMode,
      selectedDateISO: todayISO(),
      activeRange: { ...DEFAULTS.activeRange },
    });
  }
  if (k === "prefs")
    return setState({ preferences: { ...DEFAULTS.preferences } });
  if (k === "overlays") return setState({ overlays: { ...DEFAULTS.overlays } });
  if (k === "caches") return setState({ caches: { ...DEFAULTS.caches } });

  // all
  Object.assign(state, {
    ...DEFAULTS,
    hydrated: true,
    dirty: true,
    lastUpdated: Date.now(),
  });
  emit("calendar.state.reset", { state: getState() });
  notify();
  schedulePersist(50);
  return getState();
}

/* -----------------------------------------------------------------------------
 * Selectors
 * -------------------------------------------------------------------------- */

export function getSelectedDate() {
  return getState().selectedDateISO;
}

export function getActiveRange() {
  return getState().activeRange;
}

export function getViewMode() {
  return getState().viewMode;
}

export function getPreferences() {
  return getState().preferences;
}

export function getOverlays() {
  return getState().overlays;
}

export function getDayCard(dateISO) {
  const d = normalizeDateISO(dateISO);
  return getState().caches.dayCards[d] || null;
}

/**
 * Set or update a cached day card (dashboard-friendly)
 * @param {string} dateISO
 * @param {object|function} cardOrUpdater
 * @param {object} [options]
 * @param {boolean} [options.persist=true]
 */
export function setDayCard(dateISO, cardOrUpdater, options = {}) {
  const d = normalizeDateISO(dateISO);
  const opts = safeObj(options);
  const prev = getState().caches.dayCards[d] || null;

  const nextCard =
    typeof cardOrUpdater === "function" ? cardOrUpdater(prev) : cardOrUpdater;

  const card = safeObj(nextCard);

  return setState(
    {
      caches: {
        dayCards: {
          [d]: {
            ...card,
            updatedAt: Date.now(),
          },
        },
      },
    },
    {
      persist: opts.persist !== false,
      persistDelayMs: opts.persistDelayMs ?? 300,
    }
  );
}

/* -----------------------------------------------------------------------------
 * Auto-hydrate (best-effort)
 * -------------------------------------------------------------------------- */

let _autoHydrated = false;

/**
 * Call once at app startup if desired:
 *  import { ensureHydrated } from "@/services/calendar/state";
 *  ensureHydrated();
 */
export function ensureHydrated() {
  if (_autoHydrated) return;
  _autoHydrated = true;
  hydrate().catch(() => {});
}

/* -----------------------------------------------------------------------------
 * Default export (store-like facade)
 * -------------------------------------------------------------------------- */

const CalendarState = {
  getState,
  setState,
  subscribe,
  hydrate,
  persistNow,
  reset,
  ensureHydrated,

  // selectors
  getSelectedDate,
  getActiveRange,
  getViewMode,
  getPreferences,
  getOverlays,
  getDayCard,
  setDayCard,
};

export default CalendarState;
