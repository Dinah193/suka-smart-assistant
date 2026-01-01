// src/store/ProfileStore.js
// Zustand store for user/household profile, preferences, and orchestration glue.
// - Persistence via localStorage (no middleware dependency required)
// - Back-compat: top-level `region` mirrors `location.region`
// - Favorites: user-owned sessions & schedules (separate from system presets)
// - Sabbath Guard & Quiet Hours
// - Torah-compliant diet defaults (excludes pork/shellfish etc.)
// - Emits canonical events so other modules stay in sync
// - Soft geo support + hooks for Garden/Animals/Meals agents

import { create } from "zustand";

/* --------------------------------- helpers -------------------------------- */
const STORAGE_KEY = "suka.profile.v3";
const VERSION = 3;

const nowTs = () => Date.now();
const safeJSON = {
  parse: (s, fb) => {
    try {
      return JSON.parse(s);
    } catch {
      return fb;
    }
  },
  stringify: (o) => {
    try {
      return JSON.stringify(o);
    } catch {
      return "{}";
    }
  },
};

const fire = (type, detail = {}) => {
  // DOM Custom Event
  try {
    window.dispatchEvent(new CustomEvent(type, { detail }));
  } catch {
    /* noop */
  }
  // Optional event bus
  try {
    const bus = window.__suka?.eventBus;
    if (bus?.emit) bus.emit(type, detail);
  } catch {
    /* noop */
  }
};

const migrate = (raw) => {
  // Handle older shapes gracefully and elevate to VERSION 3
  const v = raw?.__version ?? 1;
  let state = { ...raw };

  if (v < 2) {
    // Ensure diet/sabbath structures exist
    state.preferences = {
      ...(state.preferences || {}),
      diet: {
        torahCompliant: true,
        disallow: ["pork", "shellfish"],
        avoidIngredients: [],
        preferredMeats: ["lamb", "beef", "goat"], // user preference noted in project context
      },
    };
    state.sabbathGuard = state.sabbathGuard || {
      enabled: false,
      start: "Friday 18:00",
      end: "Saturday 19:30",
    };
    state.quietHours = state.quietHours || { enabled: false, start: "22:00", end: "06:00" };
  }

  if (v < 3) {
    // Add favorites & location mirror
    state.favorites = state.favorites || { sessions: [], schedules: [] };
    state.location = state.location || { region: state.region || null, lat: null, lon: null, timezone: null };
    state.region = state.location.region ?? null; // mirror for back-compat
    state.calendar = state.calendar || {
      // Supports your Hebrew calendar rules engine preferences
      method: "first-visible-crescent", // or: "full-moon" | "new-moon" | "no-meridian-cross"
      meridianRule: "moon-does-not-cross",
      timezone: state.location.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York",
      // configurable: visibility threshold, altitude/azimuth rules, etc.
      options: { visibilityThresholdDeg: 5.0, preferLocalAstronomyData: true },
    };
  }

  state.__version = VERSION;
  return state;
};

const loadFromStorage = () => {
  const raw = safeJSON.parse(localStorage.getItem(STORAGE_KEY), null);
  if (!raw) return null;
  return migrate(raw);
};

const saveToStorage = (state) => {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      safeJSON.stringify({
        ...state,
        __version: VERSION,
      })
    );
  } catch {
    /* ignore quota errors */
  }
};

const id = () => (crypto?.randomUUID?.() ? crypto.randomUUID() : Math.random().toString(36).slice(2));

/* -------------------------------- defaults -------------------------------- */
const defaultState = {
  __version: VERSION,

  // Household
  household: {
    name: "My Household",
    members: [], // {id,name,role,age?,notes?}
    roles: [], // e.g., ["householder","cook","gardener","animal-keeper"]
  },

  // Location / Region
  location: {
    region: null, // e.g., "US-AL-Florida Panhandle" or "USDA 8a"
    lat: null,
    lon: null,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York",
  },

  // Back-compat mirror (HomePage expects useProfile().region)
  region: null,

  // Calendar preferences (Hebrew calendar engine alignment)
  calendar: {
    method: "first-visible-crescent", // "full-moon" | "new-moon" | "no-meridian-cross" | "new-moon"
    meridianRule: "moon-does-not-cross",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York",
    options: { visibilityThresholdDeg: 5.0, preferLocalAstronomyData: true },
  },

  // Preferences (Dietary, Cleaning, Meals, Garden, Animals)
  preferences: {
    diet: {
      torahCompliant: true,
      disallow: ["pork", "shellfish"], // high-level exclusions
      avoidIngredients: [], // user-maintained: e.g., specific additives/allergens
      preferredMeats: ["lamb", "beef", "goat"],
    },
    meals: {
      servingsDefault: 4,
      batchCookingPreferred: true,
      autoLinkToInventory: true,
    },
    cleaning: {
      zoneCycleDays: 7,
      showTimers: true,
      streaksEnabled: true,
    },
    garden: {
      hardinessZone: null, // optional if user sets or an agent computes
      firstFrost: null,
      lastFrost: null,
      preferPerennials: false,
    },
    animals: {
      species: ["chicken", "goat", "sheep"], // default recommendations
      allowBreedSuggestions: true,
      demandAwarePlanning: true, // tie to recipe demand when available
    },
    converters: {
      allowPinterest: true,
      allowGenericUrl: true,
      autoNormalize: true,
    },
    scanCompareTrust: {
      autoCheckCoupons: true,
      autoCheckRecalls: true,
      autoCheckIngredients: true,
      preferredStores: [], // loyalty stores user identifies
    },
  },

  // Guardrails & rhythms
  sabbathGuard: {
    enabled: false,
    start: "Friday 18:00",
    end: "Saturday 19:30",
  },
  quietHours: {
    enabled: false,
    start: "22:00",
    end: "06:00",
  },

  // Favorites (user-owned)
  favorites: {
    sessions: [], // [{id,name,intent,payload,createdAt}]
    schedules: [], // [{id,name,applyIntent,payload,createdAt}]
  },

  // UI prefs
  ui: {
    theme: "system", // "light" | "dark" | "system"
    density: "comfortable", // "compact" | "comfortable"
  },

  // Timestamps
  createdAt: nowTs(),
  updatedAt: nowTs(),
};

/* --------------------------------- store ---------------------------------- */
export const useProfile = create((set, get) => {
  // Hydrate initial state
  const saved = loadFromStorage();
  const base = saved ? saved : defaultState;

  // subscribe to storage changes from other tabs
  try {
    window.addEventListener("storage", (e) => {
      if (e.key === STORAGE_KEY && e.newValue) {
        const next = migrate(safeJSON.parse(e.newValue, null));
        if (next) {
          set(() => ({ ...next }));
          fire("profile/updated", { source: "storage", state: next });
        }
      }
    });
  } catch {
    /* noop */
  }

  /* ------------------------------ action helpers ----------------------------- */
  const stamp = (partial = {}) => ({
    ...partial,
    updatedAt: nowTs(),
  });

  const persistAndEmit = (selector = (s) => s) => {
    const state = get();
    saveToStorage(state);
    fire("profile/updated", { state: selector(state), source: "ProfileStore" });
  };

  return {
    ...base,

    /* ------------------------------- selectors ------------------------------- */
    getRegion: () => get().region || get().location.region,
    getTimezone: () => get().calendar.timezone || get().location.timezone,

    /* -------------------------------- updates -------------------------------- */
    setRegion: (region) => {
      set((s) => ({
        region,
        location: { ...s.location, region },
        ...stamp(),
      }));
      persistAndEmit((s) => ({ region: s.region, location: s.location }));
      fire("geo/updated", { region, source: "ProfileStore" });
    },

    setGeo: ({ lat = null, lon = null, region = null } = {}) => {
      set((s) => ({
        location: { ...s.location, lat, lon, region: region ?? s.location.region },
        region: region ?? s.region,
        ...stamp(),
      }));
      persistAndEmit((s) => s.location);
      fire("geo/updated", { latitude: lat, longitude: lon, region: region ?? get().region, source: "ProfileStore" });
    },

    updateHousehold: (partial) => {
      set((s) => ({ household: { ...s.household, ...partial }, ...stamp() }));
      persistAndEmit((s) => s.household);
    },

    updatePreferences: (partial) => {
      set((s) => ({ preferences: { ...s.preferences, ...partial }, ...stamp() }));
      persistAndEmit((s) => s.preferences);
    },

    setDiet: (partial) => {
      set((s) => ({
        preferences: { ...s.preferences, diet: { ...s.preferences.diet, ...partial } },
        ...stamp(),
      }));
      persistAndEmit((s) => s.preferences.diet);
      fire("diet/updated", { diet: get().preferences.diet, source: "ProfileStore" });
    },

    setCalendarPrefs: (partial) => {
      set((s) => ({ calendar: { ...s.calendar, ...partial }, ...stamp() }));
      persistAndEmit((s) => s.calendar);
      fire("calendar/prefs/updated", { calendar: get().calendar, source: "ProfileStore" });
    },

    toggleSabbathGuard: (enabled) => {
      set((s) => ({ sabbathGuard: { ...s.sabbathGuard, enabled }, ...stamp() }));
      persistAndEmit((s) => s.sabbathGuard);
      fire("sabbath/guard/updated", { ...get().sabbathGuard, source: "ProfileStore" });
    },

    setSabbathWindow: ({ start, end }) => {
      set((s) => ({ sabbathGuard: { ...s.sabbathGuard, start: start ?? s.sabbathGuard.start, end: end ?? s.sabbathGuard.end }, ...stamp() }));
      persistAndEmit((s) => s.sabbathGuard);
      fire("sabbath/guard/updated", { ...get().sabbathGuard, source: "ProfileStore" });
    },

    setQuietHours: ({ enabled, start, end }) => {
      set((s) => ({
        quietHours: {
          enabled: enabled ?? s.quietHours.enabled,
          start: start ?? s.quietHours.start,
          end: end ?? s.quietHours.end,
        },
        ...stamp(),
      }));
      persistAndEmit((s) => s.quietHours);
      fire("quiet-hours/updated", { ...get().quietHours, source: "ProfileStore" });
    },

    /* -------------------------------- favorites ------------------------------- */
    addFavoriteSession: (fav) => {
      const item = {
        id: fav?.id || id(),
        name: fav?.name || "Favorite Session",
        intent: fav?.intent || "session/run",
        payload: fav?.payload || {},
        createdAt: fav?.createdAt || nowTs(),
      };
      set((s) => ({
        favorites: { ...s.favorites, sessions: [...(s.favorites.sessions || []).filter((x) => x.id !== item.id), item] },
        ...stamp(),
      }));
      persistAndEmit((s) => s.favorites.sessions);
      fire("favorites/session/saved", { item, source: "ProfileStore" });
    },

    removeFavoriteSession: (id) => {
      set((s) => ({
        favorites: { ...s.favorites, sessions: (s.favorites.sessions || []).filter((x) => x.id !== id) },
        ...stamp(),
      }));
      persistAndEmit((s) => s.favorites.sessions);
      fire("favorites/session/removed", { id, source: "ProfileStore" });
    },

    addFavoriteSchedule: (fav) => {
      const item = {
        id: fav?.id || id(),
        name: fav?.name || "Favorite Schedule",
        applyIntent: fav?.applyIntent || "scheduler/apply",
        payload: fav?.payload || {},
        createdAt: fav?.createdAt || nowTs(),
      };
      set((s) => ({
        favorites: { ...s.favorites, schedules: [...(s.favorites.schedules || []).filter((x) => x.id !== item.id), item] },
        ...stamp(),
      }));
      persistAndEmit((s) => s.favorites.schedules);
      fire("favorites/schedule/saved", { item, source: "ProfileStore" });
    },

    removeFavoriteSchedule: (id) => {
      set((s) => ({
        favorites: { ...s.favorites, schedules: (s.favorites.schedules || []).filter((x) => x.id !== id) },
        ...stamp(),
      }));
      persistAndEmit((s) => s.favorites.schedules);
      fire("favorites/schedule/removed", { id, source: "ProfileStore" });
    },

    exportFavorites: () => {
      const { favorites } = get();
      return {
        exportedAt: new Date().toISOString(),
        sessions: favorites.sessions || [],
        schedules: favorites.schedules || [],
      };
    },

    importFavorites: ({ sessions = [], schedules = [] } = {}) => {
      set((s) => ({
        favorites: {
          sessions: mergeUnique(s.favorites.sessions || [], sessions),
          schedules: mergeUnique(s.favorites.schedules || [], schedules),
        },
        ...stamp(),
      }));
      persistAndEmit((s) => s.favorites);
      fire("favorites/imported", { source: "ProfileStore" });
    },

    /* ------------------------------- orchestration ---------------------------- */
    // Lightweight router for incoming intents that affect the profile.
    // Other features can dispatch: fire("automation:intent", {intent:"profile/*", payload:{...}})
    handleIntent: ({ intent, payload = {}, source }) => {
      switch (intent) {
        case "profile/set-region":
          get().setRegion(payload.region ?? null);
          return true;
        case "profile/set-geo":
          get().setGeo({ lat: payload.lat, lon: payload.lon, region: payload.region });
          return true;
        case "profile/favorites/save-session":
          get().addFavoriteSession(payload);
          return true;
        case "profile/favorites/remove-session":
          get().removeFavoriteSession(payload?.id);
          return true;
        case "profile/favorites/save-schedule":
          get().addFavoriteSchedule(payload);
          return true;
        case "profile/favorites/remove-schedule":
          get().removeFavoriteSchedule(payload?.id);
          return true;
        case "profile/diet/update":
          get().setDiet(payload);
          return true;
        case "profile/calendar/update":
          get().setCalendarPrefs(payload);
          return true;
        case "profile/sabbath/set":
          if (typeof payload?.enabled === "boolean") get().toggleSabbathGuard(payload.enabled);
          if (payload?.start || payload?.end) get().setSabbathWindow(payload);
          return true;
        case "profile/quiet-hours/set":
          get().setQuietHours(payload || {});
          return true;
        default:
          return false;
      }
    },

    /* --------------------------------- resets -------------------------------- */
    resetProfile: () => {
      set(() => ({ ...defaultState, updatedAt: nowTs() }));
      persistAndEmit();
      fire("profile/reset", { source: "ProfileStore" });
    },
  };
});

/* ------------------------------- util: merge ------------------------------- */
function mergeUnique(existing = [], incoming = []) {
  const map = new Map();
  [...existing, ...incoming].forEach((it) => map.set(it.id || id(), { ...it }));
  return Array.from(map.values());
}

/* ------------------------ intent listener (optional) ----------------------- */
// Let this store react to cross-page "automation:intent" events (consistent glue).
// You can remove this if you prefer to wire it in an agent.
try {
  window.addEventListener("automation:intent", (e) => {
    const detail = e?.detail || {};
    useProfile.getState().handleIntent(detail);
  });
} catch {
  /* noop */
}

/* ------------------------------- auto-persist ------------------------------ */
// Persist on every state change; lightweight and reliable.
useProfile.subscribe((state) => {
  saveToStorage(state);
});
