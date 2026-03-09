// File: src/store/CalendarStore.js
// SSA Calendar Store (Zustand)
// - Stores user/household calendar preferences + current view state
// - Built to be safe even when optional deps (eventBus, db) are absent
// - Persists to localStorage with versioned migrations
//
// NOTE: This store is intentionally "domain-neutral": it doesn't implement the Hebrew calendar engine.
// It provides a stable state contract for UI + engines to read/write.
//
// Usage:
//   import useCalendarStore, { calendarSelectors } from "@/store/CalendarStore";
//   import { useCalendarStore } from "@/store/CalendarStore"; // ✅ supported now
//   const monthIndex = useCalendarStore((s) => s.view.monthIndex);

import { create } from "zustand";

/* ------------------------------ persistence ------------------------------ */

const STORAGE_KEY = "ssa.calendar.store.v1";
const STORE_VERSION = 1;

function safeJsonParse(str, fallback) {
  try {
    if (!str) return fallback;
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function safeJsonStringify(obj, fallback = "{}") {
  try {
    return JSON.stringify(obj);
  } catch {
    return fallback;
  }
}

function nowISO() {
  return new Date().toISOString();
}

/**
 * Attempt to load persisted state from localStorage.
 * Returns a partial state object or null.
 */
function loadPersisted() {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage?.getItem(STORAGE_KEY);
  const data = safeJsonParse(raw, null);
  if (!data || typeof data !== "object") return null;

  // Handle migrations if needed
  const version = Number(data?.__version ?? 0);
  if (version === STORE_VERSION) return data?.state ?? null;

  // Future-proof migrations
  let migrated = data?.state ?? null;

  // Example migration hooks:
  // if (version < 1) { ... }

  return migrated;
}

function persistState(state) {
  if (typeof window === "undefined") return;
  const payload = {
    __version: STORE_VERSION,
    savedAt: nowISO(),
    state,
  };
  try {
    window.localStorage?.setItem(STORAGE_KEY, safeJsonStringify(payload));
  } catch {
    // ignore quota / disabled storage
  }
}

/* ------------------------------ helpers ------------------------------ */

function clampInt(n, min, max, fallback) {
  const v = Number.isFinite(Number(n)) ? parseInt(n, 10) : NaN;
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

function shallowPick(obj, keys) {
  const out = {};
  for (const k of keys) out[k] = obj?.[k];
  return out;
}

/**
 * Create a stable "calendar config fingerprint" used to invalidate caches
 * in any calendar engine consuming these preferences.
 */
function makeConfigFingerprint(prefs) {
  const stable = {
    calendarType: prefs?.calendarType ?? "hebrew",
    monthStartMethod: prefs?.monthStartMethod ?? "full_moon",
    monthLengthMode: prefs?.monthLengthMode ?? "astronomical",
    firstFruitsRule: prefs?.firstFruitsRule ?? "day_after_sabbath",
    shavuotCountMode: prefs?.shavuotCountMode ?? "50_days",
    sunsetBoundary: prefs?.sunsetBoundary ?? true,
    locale: prefs?.locale ?? "en-US",
    timeZone: prefs?.timeZone ?? "UTC",
  };
  return safeJsonStringify(stable, "");
}

/* ------------------------------ defaults ------------------------------ */

const DEFAULT_PREFS = {
  // calendar domain
  calendarType: "hebrew", // "hebrew" | "gregorian" | future
  // Month start selection method
  // - full_moon | new_moon | first_visible_crescent | does_not_cross_meridian | custom
  monthStartMethod: "full_moon",
  // Month length handling
  // - astronomical: derived from selected moon phase timestamps (no 29/30 clamp)
  // - fixed_29_30: classic alternating constraint (if user ever opts in)
  monthLengthMode: "astronomical",

  // Day boundary
  sunsetBoundary: true, // day starts at sunset

  // Feast day settings (kept generic & scripture-only toggles in your system)
  firstFruitsRule: "day_after_sabbath", // or "day_after_unleavened_bread" / "custom"
  shavuotCountMode: "50_days", // "50_days" | "49_sabbaths_then_50th" | "custom"

  // UI concerns
  locale: "en-US",
  timeZone:
    (typeof Intl !== "undefined" &&
      Intl.DateTimeFormat().resolvedOptions().timeZone) ||
    "UTC",

  // Optional: anchor rules (equinox/solstice constraints etc.)
  // Engines may interpret these; store only.
  solarAnchor: {
    type: "spring_equinox", // "spring_equinox" | "custom_date" | "none"
    // for "custom_date" anchors
    customISO: null,
  },

  // Optional: user overrides for specific years/months
  // Useful for "fixed Hebrew grid overlay" use cases or manual corrections.
  overrides: {
    // Example:
    // "2026": { abib1ISO: "2026-03-20T00:00:00Z", notes: "..." }
  },
};

const DEFAULT_VIEW = {
  // Current UI focus
  year: new Date().getFullYear(),
  // Month index: 0-11 for Gregorian view; engines can interpret differently for Hebrew
  monthIndex: new Date().getMonth(),
  // Optional selected day
  selectedISODate: null,

  // Layout preferences for your calendar grid
  showSunset: true,
  showMoedim: true,
  showFooterNotes: true,
  cellMinHeight: 136,
};

const DEFAULT_CACHE = {
  // Consumers can store computed artifacts keyed by a fingerprint
  // Calendar engines may choose to use this store, but it is not required.
  configFingerprint: makeConfigFingerprint(DEFAULT_PREFS),

  // Example cache containers (engines can populate):
  computed: {
    // "2026": { months: [...], moedim: {...}, generatedAt: ISO }
  },
  lastComputedAt: null,
};

const DEFAULT_META = {
  lastUpdatedAt: null,
  lastError: null,
  lastErrorAt: null,
};

/* ------------------------------ state shape ------------------------------ */

function buildInitialState() {
  const persisted = loadPersisted();

  // Persisted schema is expected to be a partial of the state below
  const initial = {
    prefs: { ...DEFAULT_PREFS, ...(persisted?.prefs || {}) },
    view: { ...DEFAULT_VIEW, ...(persisted?.view || {}) },
    cache: { ...DEFAULT_CACHE, ...(persisted?.cache || {}) },
    meta: { ...DEFAULT_META, ...(persisted?.meta || {}) },
  };

  // Normalize / clamp
  initial.view.year = clampInt(
    initial.view.year,
    1900,
    3000,
    DEFAULT_VIEW.year
  );
  initial.view.monthIndex = clampInt(
    initial.view.monthIndex,
    0,
    11,
    DEFAULT_VIEW.monthIndex
  );
  initial.view.cellMinHeight = clampInt(
    initial.view.cellMinHeight,
    72,
    600,
    DEFAULT_VIEW.cellMinHeight
  );

  // Recompute fingerprint if missing
  initial.cache.configFingerprint = makeConfigFingerprint(initial.prefs);

  return initial;
}

/* ------------------------------ store ------------------------------ */

const useCalendarStore = create((set, get) => {
  const initial = buildInitialState();

  // Persist only these slices (avoid persisting computed blobs unless you explicitly want that)
  const PERSIST_KEYS = ["prefs", "view", "cache", "meta"];

  function commit(partial, reason = "update") {
    set((state) => {
      const next = {
        ...state,
        ...partial,
        meta: {
          ...state.meta,
          ...(partial.meta || {}),
          lastUpdatedAt: nowISO(),
        },
      };

      // Persist
      const toPersist = shallowPick(next, PERSIST_KEYS);
      persistState(toPersist);

      return next;
    });

    // Optional event emission (soft-dep; no crash if absent)
    // If you later add an eventBus, you can wire it in by calling attachEventBus().
    const eb = get().__eventBus;
    if (eb?.emit) {
      try {
        eb.emit("calendar.store.updated", {
          reason,
          at: nowISO(),
        });
      } catch {
        // ignore
      }
    }
  }

  return {
    ...initial,

    // Optional attached deps (not persisted)
    __eventBus: null,
    attachEventBus(eventBus) {
      set(() => ({ __eventBus: eventBus || null }));
    },

    /* ------------------------------ prefs actions ------------------------------ */

    setPrefs(patch = {}, reason = "prefs.set") {
      const prev = get().prefs;
      const nextPrefs = { ...prev, ...patch };

      // If prefs change, update fingerprint and invalidate relevant cache (lightly)
      const nextFp = makeConfigFingerprint(nextPrefs);
      const prevFp = get().cache?.configFingerprint;

      const shouldInvalidate = nextFp !== prevFp;

      commit(
        {
          prefs: nextPrefs,
          cache: {
            ...get().cache,
            configFingerprint: nextFp,
            ...(shouldInvalidate
              ? { computed: {}, lastComputedAt: null }
              : null),
          },
        },
        reason
      );
    },

    resetPrefs(reason = "prefs.reset") {
      commit(
        {
          prefs: { ...DEFAULT_PREFS },
          cache: {
            ...DEFAULT_CACHE,
            configFingerprint: makeConfigFingerprint(DEFAULT_PREFS),
            computed: {},
            lastComputedAt: null,
          },
        },
        reason
      );
    },

    setMonthStartMethod(method, reason = "prefs.monthStartMethod") {
      get().setPrefs({ monthStartMethod: method }, reason);
    },

    setMonthLengthMode(mode, reason = "prefs.monthLengthMode") {
      get().setPrefs({ monthLengthMode: mode }, reason);
    },

    setTimeZone(timeZone, reason = "prefs.timeZone") {
      get().setPrefs({ timeZone }, reason);
    },

    setSolarAnchor(anchorPatch = {}, reason = "prefs.solarAnchor") {
      const prev = get().prefs?.solarAnchor || DEFAULT_PREFS.solarAnchor;
      get().setPrefs({ solarAnchor: { ...prev, ...anchorPatch } }, reason);
    },

    setOverride(year, overridePatch = {}, reason = "prefs.override.set") {
      const y = String(year);
      const prev = get().prefs?.overrides || {};
      const nextYear = { ...(prev[y] || {}), ...overridePatch };
      get().setPrefs({ overrides: { ...prev, [y]: nextYear } }, reason);
    },

    clearOverride(year, reason = "prefs.override.clear") {
      const y = String(year);
      const prev = get().prefs?.overrides || {};
      if (!prev[y]) return;
      const next = { ...prev };
      delete next[y];
      get().setPrefs({ overrides: next }, reason);
    },

    /* ------------------------------ view actions ------------------------------ */

    setView(patch = {}, reason = "view.set") {
      const prev = get().view;
      const next = { ...prev, ...patch };

      // Normalize
      if ("year" in patch)
        next.year = clampInt(next.year, 1900, 3000, prev.year);
      if ("monthIndex" in patch)
        next.monthIndex = clampInt(next.monthIndex, 0, 11, prev.monthIndex);
      if ("cellMinHeight" in patch)
        next.cellMinHeight = clampInt(
          next.cellMinHeight,
          72,
          600,
          prev.cellMinHeight
        );

      commit({ view: next }, reason);
    },

    gotoToday(reason = "view.gotoToday") {
      const d = new Date();
      get().setView(
        {
          year: d.getFullYear(),
          monthIndex: d.getMonth(),
          selectedISODate: d.toISOString().slice(0, 10),
        },
        reason
      );
    },

    gotoMonth(year, monthIndex, reason = "view.gotoMonth") {
      get().setView({ year, monthIndex }, reason);
    },

    selectDay(isoDate, reason = "view.selectDay") {
      // isoDate expected "YYYY-MM-DD"
      get().setView({ selectedISODate: isoDate || null }, reason);
    },

    /* ------------------------------ cache actions ------------------------------ */

    /**
     * Store computed calendar payloads (engine output).
     * Recommended shape:
     *  setComputedYear("2026", { months, moedim, source, generatedAt })
     */
    setComputedYear(year, payload, reason = "cache.setComputedYear") {
      const y = String(year);
      const cache = get().cache || DEFAULT_CACHE;
      const computed = { ...(cache.computed || {}) };

      computed[y] = {
        ...(payload || {}),
        generatedAt: payload?.generatedAt || nowISO(),
      };

      commit(
        {
          cache: {
            ...cache,
            computed,
            lastComputedAt: nowISO(),
          },
        },
        reason
      );
    },

    clearComputed(reason = "cache.clearComputed") {
      const cache = get().cache || DEFAULT_CACHE;
      commit(
        {
          cache: {
            ...cache,
            computed: {},
            lastComputedAt: null,
          },
        },
        reason
      );
    },

    /* ------------------------------ error/meta ------------------------------ */

    setError(err, reason = "meta.error") {
      const msg =
        typeof err === "string"
          ? err
          : err?.message || safeJsonStringify(err, "Unknown error");
      commit(
        {
          meta: {
            ...get().meta,
            lastError: msg,
            lastErrorAt: nowISO(),
          },
        },
        reason
      );
    },

    clearError(reason = "meta.error.clear") {
      commit(
        {
          meta: { ...get().meta, lastError: null, lastErrorAt: null },
        },
        reason
      );
    },

    /* ------------------------------ utilities ------------------------------ */

    /**
     * Hard reset everything including localStorage.
     */
    hardReset(reason = "store.hardReset") {
      if (typeof window !== "undefined") {
        try {
          window.localStorage?.removeItem(STORAGE_KEY);
        } catch {
          // ignore
        }
      }
      commit(
        {
          prefs: { ...DEFAULT_PREFS },
          view: { ...DEFAULT_VIEW },
          cache: { ...DEFAULT_CACHE, computed: {}, lastComputedAt: null },
          meta: { ...DEFAULT_META },
        },
        reason
      );
    },
  };
});

// ✅ Fix for your build error:
// GardenSettingsPage.jsx imports a *named* useCalendarStore, so export it too.
export { useCalendarStore };

export default useCalendarStore;

/* ------------------------------ selectors ------------------------------ */

export const calendarSelectors = {
  prefs: (s) => s.prefs,
  view: (s) => s.view,
  cache: (s) => s.cache,
  meta: (s) => s.meta,

  year: (s) => s.view.year,
  monthIndex: (s) => s.view.monthIndex,
  selectedISODate: (s) => s.view.selectedISODate,

  monthStartMethod: (s) => s.prefs.monthStartMethod,
  monthLengthMode: (s) => s.prefs.monthLengthMode,
  sunsetBoundary: (s) => s.prefs.sunsetBoundary,
  timeZone: (s) => s.prefs.timeZone,

  configFingerprint: (s) => s.cache.configFingerprint,
  computedForYear: (year) => (s) => s.cache?.computed?.[String(year)] || null,
};
