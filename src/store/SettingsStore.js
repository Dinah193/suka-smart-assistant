// C:\Users\larho\suka-smart-assistant\src\store\SettingsStore.js
// Dynamic app settings store with persistence, cross-tab sync, and orchestration hooks
// - Adds favorite plan save prefs (destinations, recents)
// - Adds template & session defaults that other modules (SessionStore, TemplateStore, SavePlan modal) can read
// - Listens to favorite saved events to remember last-used destination
// - Backwards compatible with your previous API

import { useEffect, useMemo, useRef, useState } from "react";

/* -------------------------------------------------------------------------- */
/*                                   Meta                                     */
/* -------------------------------------------------------------------------- */

const VERSION = 3; // ⬅ bump: new sections (favorites, storage.connectors, sessions.ui)
const STORAGE_KEY = `suka.settings.v${VERSION}`;
const LEGACY_KEYS = ["suka.settings.v1", "suka.settings.v2"]; // migrate from these if found

/* -------------------------------------------------------------------------- */
/*                                  Defaults                                  */
/* -------------------------------------------------------------------------- */

const defaultState = {
  app: {
    locale: "en-US",
    timezone:
      (typeof Intl !== "undefined" &&
        Intl.DateTimeFormat().resolvedOptions().timeZone) ||
      "America/New_York",
    units: "imperial", // 'imperial' | 'metric'
    haptics: true,
    sounds: true,
    colorScheme: "system", // 'light' | 'dark' | 'system'
    accessibility: {
      reduceMotion: false,
      highContrast: false,
      textScale: 1.0,
    },
  },

  calendar: {
    defaultReminderMins: 30,
    connectGoogle: false,
    connectOutlook: false,
    weekStartsOn: 0, // 0=Sun..6=Sat
    showSunsetTimes: true,
    sabbathAware: true,
  },

  observance: {
    sabbathAware: true,
    sabbathDayRule: "hebrew_day7", // 'hebrew_day7' | 'saturday'
    sabbathPrepWindowHours: 4,
    feastDayBehavior: "lock", // 'lock' | 'swap' | 'skip'
  },

  notifications: {
    enabled: true,
    defaultChannels: ["toast"], // 'toast' | 'push' | 'email'
    quietHours: {
      enabled: false,
      start: "22:00",
      end: "07:00",
      respectObservance: true, // suppress during sabbath windows if enabled
    },
  },

  /** New: where & how plans/templates save by default */
  favorites: {
    autoPromptOnPlanStart: true, // SessionStore.startWithPlan may use this to nudge "Save as Favorite"
    defaultDestination: "local", // 'local' | 'device' | 'googleDrive'
    // Recently used save targets/paths for quick UX
    recent: [], // [{ id, title, domain, destination, path, savedAt }]
    cap: 20,
    // Export formats the Save modal can offer
    export: {
      json: true,
      pdf: true,
      ical: true,
    },
  },

  /** New: connector preferences and capabilities */
  storage: {
    connectors: {
      local: { enabled: true }, // IndexedDB/Dexie
      device: {
        enabled:
          typeof window !== "undefined" &&
          "showSaveFilePicker" in window, // File System Access API
      },
      googleDrive: {
        enabled: false,
        // Tokens/keys are placeholders; real auth handled elsewhere
        clientId: "",
        token: "",
        defaultFolderId: "",
      },
    },
    // Space guard for local persistence (soft)
    caps: {
      maxFavorites: 200,
      maxTemplates: 500,
    },
  },

  /** New: template editing defaults */
  templates: {
    defaultDomain: "general", // pre-select domain on "New Template"
    autosaveEdits: true,
    showAdvancedFields: false,
  },

  /** New: session defaults + UI controls used by SessionHUD / SessionStore */
  sessions: {
    itemRuntimePanel: {
      show: true,
      columns: ["idx", "title", "status", "plannedStart", "plannedEnd", "slack"],
      compact: false,
    },
    autoPauseOnWithhold: true,
    autoResumeWhenClear: true,
    showRecoveryStrip: true,
    timers: {
      tickMs: 1000,
      voiceAlerts: false,
    },
  },

  /** Existing preservation (unchanged) */
  preservation: {
    preferredJarSize: "quart", // 'pint' | 'quart' | 'halfPint'
    cannerType: "pressure", // 'pressure' | 'waterbath'
    ventTimeMin: 10,
    coolDownMin: 0,
    capacity: {
      pint: 8,
      quart: 7,
      halfPint: 10,
    },
    safetyTips: true,
  },

  equipment: {
    pressureCanner: {
      brand: "",
      model: "",
      volumeQt: 23, // common All American / Presto size
    },
    thermometers: { probe: true, infrared: false },
    scales: { kitchen: true },
  },

  features: {
    aiSuggestions: true,
    enableCostEstimates: true,
    pantryAutoSync: true,
    mealRhythmPlanner: true,
    batchSessionPlanner: true,
  },
};

/* -------------------------------------------------------------------------- */
/*                              Persistence + BC                              */
/* -------------------------------------------------------------------------- */

function migrateFromLegacy() {
  for (const key of LEGACY_KEYS) {
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw);
        return parsed;
      }
    } catch {}
  }
  return null;
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  // migrate legacy → v3 (deep-ish merge into defaults)
  const legacy = migrateFromLegacy();
  if (legacy && typeof legacy === "object") {
    return mergeDeep(defaultState, legacy);
  }
  return null;
}

function save(next) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore quota errors
  }
}

/* --------------------- store internals --------------------- */
let state = load() || defaultState;
const listeners = new Set();

/* --------------------- event bus bridge (optional) --------------------- */
let eventBus = { on() {}, off() {}, emit() {} };

// Attempt dynamic resolution in multiple environments (ESM/CJS/browser)
(async () => {
  try {
    // Prefer ESM import if available
    const eb = await import(/* @vite-ignore */ "@/services/eventBus").catch(() => null);
    if (eb) eventBus = eb.default || eb.eventBus || eb;
  } catch {}
  try {
    // Also attempt global bus (injected elsewhere)
    if (globalThis && (globalThis.eventBus || globalThis.SukaEventBus)) {
      eventBus = globalThis.eventBus || globalThis.SukaEventBus;
    }
  } catch {}
  attachEventBusListeners();
})();

/** React to favorite saves to improve UX next time */
function attachEventBusListeners() {
  try {
    if (!eventBus?.on) return;
    const handler = (payload) => {
      // Normalize payload: { domain, plan, destination, path }
      const dest = payload?.destination || state.favorites.defaultDestination || "local";
      const entry = {
        id:
          payload?.plan?.$id ||
          payload?.favoriteKey ||
          `${payload?.domain || "general"}:${Date.now()}`,
        title:
          payload?.plan?.meta?.title ||
          payload?.title ||
          payload?.planTitle ||
          "Favorite Plan",
        domain: payload?.domain || payload?.plan?.meta?.domain || "general",
        destination: dest,
        path: payload?.path || "",
        savedAt: Date.now(),
      };
      recordFavorite(entry, { destinationOverride: dest });
    };

    // Listen to any domain-specific or generic favorite saved signals
    const topics = [
      "favorite.saved",
      "garden.plan.favorite.saved",
      "cooking.plan.favorite.saved",
      "animals.plan.favorite.saved",
      "cleaning.plan.favorite.saved",
      "general.plan.favorite.saved",
    ];

    topics.forEach((t) => {
      try {
        eventBus.on(t, handler);
      } catch {}
    });
  } catch {}
}

/* --------------------- BroadcastChannel cross-tab sync --------------------- */
let bc = null;
try {
  if (typeof BroadcastChannel !== "undefined") {
    bc = new BroadcastChannel("suka.settings");
    bc.addEventListener?.("message", (ev) => {
      const msg = ev?.data;
      if (!msg || msg.type !== "settings:patch") return;
      state = msg.deep
        ? mergeDeep(state, msg.patch || {})
        : { ...state, ...(msg.patch || {}) };
      save(state);
      notify(state);
    });
  }
} catch {}

/** Notify subscribers with the NEW state reference */
function notify(next) {
  for (const cb of listeners) {
    try {
      cb(next);
    } catch {}
  }
}

/** Shallow compare (object or primitive) */
function isShallowEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.is(a[k], b[k])) return false;
  return true;
}

/* ----------------------- dot-path helpers ----------------------- */

function getAtPath(obj, path, fallback) {
  const parts = String(path).split(".").filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null || !(p in cur)) return fallback;
    cur = cur[p];
  }
  return cur;
}

function setDeep(root, path, value) {
  const parts = String(path).split(".").filter(Boolean);
  if (parts.length === 0) return root;
  const nextRoot = Array.isArray(root) ? root.slice() : { ...root };
  let curPrev = root;
  let curNext = nextRoot;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const prevChild = (curPrev && curPrev[key]) ?? {};
    const nextChild = Array.isArray(prevChild) ? prevChild.slice() : { ...prevChild };
    curNext[key] = nextChild;
    curPrev = prevChild;
    curNext = nextChild;
  }
  const leafKey = parts[parts.length - 1];
  const prevLeaf = curPrev ? curPrev[leafKey] : undefined;
  if (Object.is(prevLeaf, value)) return root;
  curNext[leafKey] = value;
  return nextRoot;
}

function deleteDeep(root, path) {
  const parts = String(path).split(".").filter(Boolean);
  if (parts.length === 0) return root;
  const nextRoot = Array.isArray(root) ? root.slice() : { ...root };
  let curPrev = root;
  let curNext = nextRoot;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const prevChild = (curPrev && curPrev[key]) ?? {};
    const nextChild = Array.isArray(prevChild) ? prevChild.slice() : { ...prevChild };
    curNext[key] = nextChild;
    curPrev = prevChild;
    curNext = nextChild;
  }
  const leafKey = parts[parts.length - 1];
  if (curNext && Object.prototype.hasOwnProperty.call(curNext, leafKey)) {
    if (Array.isArray(curNext)) curNext.splice(Number(leafKey), 1);
    else delete curNext[leafKey];
  }
  return nextRoot;
}

function mergeDeep(target, patch) {
  if (Array.isArray(target) || Array.isArray(patch)) return patch;
  if (typeof target !== "object" || typeof patch !== "object" || !target || !patch)
    return patch;
  const out = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = mergeDeep(target[k], v);
  }
  return out;
}

/* ------------------------- public API ------------------------- */
export function subscribe(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function get(path, fallback) {
  return getAtPath(state, path, fallback);
}

/**
 * Immutable deep set that changes the root reference so updates are detectable.
 * Accepts either a value OR an updater function: set("a.b", prev => next).
 */
export function set(path, valueOrUpdater, { broadcast = true } = {}) {
  const prevAtPath = get(path);
  const nextValue =
    typeof valueOrUpdater === "function"
      ? valueOrUpdater(prevAtPath)
      : valueOrUpdater;
  const next = setDeep(state, path, nextValue);
  if (next === state) return;
  state = next;
  save(state);
  notify(state);
  if (broadcast)
    bc?.postMessage?.({ type: "settings:patch", patch: setAtRoot(path, nextValue) });
}

/** Shallow update at the root (merge). */
export function update(partial, { broadcast = true } = {}) {
  if (!partial || typeof partial !== "object") return;
  const next = { ...state, ...partial };
  if (isShallowEqual(state, next)) return;
  state = next;
  save(state);
  notify(state);
  if (broadcast) bc?.postMessage?.({ type: "settings:patch", patch: partial });
}

/** Deep merge at the root. */
export function merge(partial, { broadcast = true } = {}) {
  if (!partial || typeof partial !== "object") return;
  const next = mergeDeep(state, partial);
  if (next === state) return;
  state = next;
  save(state);
  notify(state);
  if (broadcast)
    bc?.postMessage?.({ type: "settings:patch", patch: partial, deep: true });
}

/** Reset to defaults or to named section (e.g., "observance"). */
export function reset(section = null, { broadcast = true } = {}) {
  if (!section) {
    if (state === defaultState || isShallowEqual(state, defaultState)) return;
    state = { ...defaultState };
    save(state);
    notify(state);
    if (broadcast) bc?.postMessage?.({ type: "settings:patch", patch: state });
    return;
  }
  const next = { ...state, [section]: defaultState[section] };
  if (isShallowEqual(state, next)) return;
  state = next;
  save(state);
  notify(state);
  if (broadcast)
    bc?.postMessage?.({
      type: "settings:patch",
      patch: { [section]: defaultState[section] },
    });
}

/** Delete a value at a path (object key or array index). */
export function del(path, { broadcast = true } = {}) {
  const next = deleteDeep(state, path);
  if (next === state) return;
  state = next;
  save(state);
  notify(state);
  if (broadcast) bc?.postMessage?.({ type: "settings:patch", patch: {} });
}

/** Convenience: does a path exist (truthy existence, not value). */
export function has(path) {
  const parts = String(path).split(".").filter(Boolean);
  let cur = state;
  for (const p of parts) {
    if (cur == null || !(p in cur)) return false;
    cur = cur[p];
  }
  return true;
}

/** Toggle a boolean at a path. */
export function toggle(path) {
  const prev = !!get(path, false);
  set(path, !prev);
}

/** Increment a numeric path by n (can be negative). */
export function inc(path, n = 1) {
  const prev = Number(get(path, 0)) || 0;
  set(path, prev + Number(n || 0));
}

/** Push into an array at a path (unique optional). */
export function push(path, value, { unique = false, key } = {}) {
  const prev = get(path, []);
  const arr = Array.isArray(prev) ? prev.slice() : [];
  if (unique) {
    if (key) {
      const exists = arr.some((x) =>
        x && typeof x === "object" ? x[key] === value[key] : false
      );
      if (exists) return;
    } else if (arr.includes(value)) return;
  }
  arr.push(value);
  set(path, arr);
}

/** Set multiple root keys at once. */
export function setMany(entries = {}) {
  const next = { ...state, ...entries };
  if (isShallowEqual(state, next)) return;
  state = next;
  save(state);
  notify(state);
  bc?.postMessage?.({ type: "settings:patch", patch: entries });
}

/** Merge deeply multiple keys. */
export function mergeManyDeep(entries = {}) {
  merge(entries);
}

/** Debug accessor */
export function _state() {
  return state;
}

/* ----------------------- Favorites helpers (new) ----------------------- */

/** Programmatically record a favorite save (used by Save modal or event bus) */
export function recordFavorite(
  entry,
  { destinationOverride = null } = {}
) {
  const dest =
    destinationOverride ||
    entry?.destination ||
    state.favorites.defaultDestination ||
    "local";

  const item = {
    id: entry?.id || `${entry?.domain || "general"}:${Date.now()}`,
    title: entry?.title || "Favorite Plan",
    domain: entry?.domain || "general",
    destination: dest,
    path: entry?.path || "",
    savedAt: entry?.savedAt || Date.now(),
  };

  const cap = Number(state.favorites.cap || 20);
  const prev = Array.isArray(state.favorites.recent)
    ? state.favorites.recent.slice()
    : [];
  const nextRecent = [item]
    .concat(prev.filter((x) => x.id !== item.id))
    .slice(0, cap);

  state = setDeep(state, "favorites.recent", nextRecent);
  state = setDeep(state, "favorites.defaultDestination", dest);
  save(state);
  notify(state);
  bc?.postMessage?.({
    type: "settings:patch",
    patch: { favorites: { recent: nextRecent, defaultDestination: dest } },
    deep: true,
  });

  return item;
}

/** Clear favorites history */
export function clearRecentFavorites() {
  state = setDeep(state, "favorites.recent", []);
  save(state);
  notify(state);
  bc?.postMessage?.({
    type: "settings:patch",
    patch: { favorites: { recent: [] } },
    deep: true,
  });
}

/* ---------------------- Import / Export whole state ---------------------- */
export function exportJson(pretty = true) {
  const json = JSON.stringify(state, null, pretty ? 2 : 0);
  return json;
}
export function importJson(json, { mergeMode = "deep" } = {}) {
  try {
    const obj = typeof json === "string" ? JSON.parse(json) : json;
    if (!obj || typeof obj !== "object") return;
    if (mergeMode === "shallow") update(obj);
    else merge(obj);
  } catch {}
}

/* ----------------- React hook (stable, loop-proof) ----------------- */
/**
 * useSettings(selector?) — subscribe to settings with a selector.
 * - Dedupes updates by Object.is on the selected slice.
 */
export function useSettings(selector = (s) => s) {
  const selectorRef = useRef(selector);
  selectorRef.current = selector;

  const [slice, setSlice] = useState(() => selectorRef.current(state));

  useEffect(() => {
    const cb = (nextState) => {
      try {
        const nextSlice = selectorRef.current(nextState);
        setSlice((prev) => (Object.is(prev, nextSlice) ? prev : nextSlice));
      } catch {}
    };
    return subscribe(cb);
  }, []);

  return useMemo(() => slice, [slice]);
}

/* -------------------------- small internals ------------------------- */

/** builds a minimal root-shaped patch for broadcast from a/b dot path set */
function setAtRoot(path, value) {
  const parts = String(path).split(".").filter(Boolean);
  if (!parts.length) return value;
  let patch = {};
  let cur = patch;
  for (let i = 0; i < parts.length - 1; i++) {
    cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
  return patch;
}

/* For convenience in modules that prefer a default export */
export default {
  subscribe,
  get,
  set,
  setMany,
  merge,
  mergeManyDeep,
  update,
  reset,
  del,
  has,
  toggle,
  inc,
  push,
  exportJson,
  importJson,
  recordFavorite,
  clearRecentFavorites,
  _state,
  useSettings,
};
