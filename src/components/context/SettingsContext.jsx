// C:\Users\larho\suka-smart-assistant\src\components\context\SettingsContext.jsx
// Central settings store: preferences, feature flags, sabbath/quiet hours, units/locale,
// allergens & diets, grocery & meal defaults, privacy, integrations, and experiments.
// ES2015-safe, dependency-light, with DI and schema migration.

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

// --- tiny utils ---------------------------------------------------------------
function debounce(fn, ms) {
  let t = null;
  return function (...args) {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
}
function deepClone(x) {
  try { return JSON.parse(JSON.stringify(x)); } catch (_e) { return x; }
}
function getIn(obj, path, fb) {
  if (!path) return obj;
  const parts = String(path).split(".");
  let cur = obj;
  for (let i = 0; i < parts.length; i++) {
    if (cur == null) return fb;
    cur = cur[parts[i]];
  }
  return cur == null ? fb : cur;
}
function setIn(obj, path, value) {
  const parts = String(path).split(".");
  const out = deepClone(obj);
  let cur = out;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    cur[k] = cur[k] == null ? {} : cur[k];
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
  return out;
}
function delIn(obj, path) {
  const parts = String(path).split(".");
  const out = deepClone(obj);
  let cur = out;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (cur[k] == null) return out;
    cur = cur[k];
  }
  delete cur[parts[parts.length - 1]];
  return out;
}

// --- schema & defaults --------------------------------------------------------
// Bump version on breaking changes and add a migration step below.
const SETTINGS_VERSION = 3;

const DEFAULTS = Object.freeze({
  __version: SETTINGS_VERSION,
  app: {
    theme: "system", // "light" | "dark" | "system"
    density: "cozy", // "compact" | "cozy" | "roomy"
    locale: "en-US",
    timezone: "America/New_York",
    units: { // kitchen/grocery
      system: "US", // "US" | "Metric"
      temperature: "F", // F | C
      weight: "lb", // lb | g
      volume: "cup", // cup | ml
    },
    accessibility: {
      textScale: 1.0, // 0.85..1.5
      reduceMotion: false,
      highContrast: false,
    },
  },
  household: {
    members: [
      // { id, name, role:"admin"|"member"|"guest", diets:["vegetarian"], allergens:["peanut"], dislikes:["cilantro"] }
    ],
    activeMemberId: null,
  },
  cooking: {
    defaultServings: 2,
    autoScaleToServings: true,
    autoCreateLeftovers: true,
    preferredAppliances: [], // ["oven","stovetop","air fryer"]
    macronutrientTargets: null, // { calories, protein, carbs, fat } or null
  },
  grocery: {
    preferredStores: [], // ["Costco","H-E-B"]
    aisleGrouping: "smart", // "smart" | "alpha" | "none"
    budgetPerWeek: null,
    autoAddMissingFromPlan: true,
    allowSubstitutions: true,
  },
  schedule: {
    sabbathGuard: { enabled: false, start: "Fri 18:00", end: "Sat 19:00" },
    quietHours: { enabled: true, start: "21:30", end: "07:00" },
    defaultPrepBlockMinutes: 45,
  },
  notifications: {
    channels: { push: true, email: false },
    nudges: { enabled: true, muteTags: [] }, // matches useNBANudges tag mutes
  },
  allergensAndDiets: {
    globalAllergens: [], // ["peanut","tree nut","shellfish","sesame"]
    globalDiets: [], // ["vegetarian","low-carb"]
  },
  privacy: {
    telemetry: true, // anonymous feature usage
    sharePrepCandidatesAcrossDomains: true,
    piiMasking: true,
  },
  features: {
    // Feature flags toggled by Settings UI or experiments:
    prepConsolidation: true,
    nudgeCenter: true,
    recipeImporter: true,
    ingredientMapping: true,
    budgetMode: true,
    experiments: { // bucketing for a/b ideas
      deciderVarietyThrottle: "on", // "control" | "on"
    },
  },
  integrations: {
    calendar: { enabled: false, provider: "gcal", calendarId: "primary" },
    email: { enabled: false, provider: "gmail" },
    weather: { enabled: true, provider: "system" },
    storage: { provider: "local" }, // local | cloud
  },
});

// --- validators (lightweight, defensive) -------------------------------------
const VALIDATORS = {
  "app.theme": (v) => ["light", "dark", "system"].indexOf(v) >= 0,
  "app.density": (v) => ["compact", "cozy", "roomy"].indexOf(v) >= 0,
  "app.accessibility.textScale": (v) => typeof v === "number" && v >= 0.8 && v <= 1.75,
  "schedule.sabbathGuard": (v) => v && typeof v.enabled === "boolean" && v.start && v.end,
  "notifications.channels": (v) => v && typeof v.push === "boolean" && typeof v.email === "boolean",
  "features": (v) => v && typeof v === "object",
};

// --- migrations ---------------------------------------------------------------
function migrateSettings(incoming) {
  if (!incoming || typeof incoming !== "object") return deepClone(DEFAULTS);
  let s = deepClone(incoming);
  const from = Number(s.__version || 1);

  // v1 -> v2: add notifications.nudges + grocery.allowSubstitutions default
  if (from < 2) {
    s.notifications = s.notifications || {};
    s.notifications.nudges = s.notifications.nudges || { enabled: true, muteTags: [] };
    s.grocery = s.grocery || {};
    if (typeof s.grocery.allowSubstitutions === "undefined") s.grocery.allowSubstitutions = true;
    s.__version = 2;
  }
  // v2 -> v3: add features.experiments & privacy.piiMasking default
  if (s.__version < 3) {
    s.features = s.features || {};
    s.features.experiments = s.features.experiments || { deciderVarietyThrottle: "on" };
    s.privacy = s.privacy || {};
    if (typeof s.privacy.piiMasking === "undefined") s.privacy.piiMasking = true;
    s.__version = 3;
  }

  // Ensure all missing branches are backfilled from DEFAULTS
  s = deepMerge(DEFAULTS, s);
  return s;
}
function deepMerge(base, over) {
  if (Array.isArray(base)) return Array.isArray(over) ? over : base.slice(0);
  if (typeof base !== "object" || base === null) return (typeof over === "undefined" ? base : over);
  const out = {};
  const keys = Array.from(new Set(Object.keys(base).concat(Object.keys(over || {}))));
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    out[k] = deepMerge(base[k], over ? over[k] : undefined);
  }
  return out;
}

// --- context ------------------------------------------------------------------
const SettingsContext = createContext(null);

/**
 * SettingsProvider
 * deps: { storage:{get,set}, analytics:{track}, eventBus:{emit,on,off}, clock:{now}, secureStore? }
 */
export function SettingsProvider({
  children,
  deps = {},
  storageKey = "suka:settings",
  autosaveMs = 400,
}) {
  const storage = deps.storage || { get: () => null, set: () => {} };
  const eventBus = deps.eventBus || { emit: () => {}, on: null, off: null };
  const analytics = deps.analytics || { track: () => {} };

  // internal state
  const [settings, setSettings] = useState(DEFAULTS);
  const [loaded, setLoaded] = useState(false);

  // hydrate on mount
  useEffect(() => {
    let raw = null;
    try { raw = storage.get(storageKey); } catch (_e) {}
    if (raw) {
      try {
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        setSettings(migrateSettings(parsed));
      } catch (_e) {
        setSettings(deepClone(DEFAULTS));
      }
    } else {
      setSettings(deepClone(DEFAULTS));
    }
    setLoaded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // autosave
  const persist = useMemo(
    () =>
      debounce((s) => {
        try {
          storage.set(storageKey, JSON.stringify(s));
          analytics.track("settings/autosave", { version: s.__version });
        } catch (_e) {}
      }, autosaveMs),
    [analytics, autosaveMs, storage, storageKey]
  );
  useEffect(() => {
    if (!loaded) return;
    persist(settings);
  }, [settings, loaded, persist]);

  // helpers --------------------------------------------------------------------
  const validate = useCallback((path, value) => {
    const v = VALIDATORS[path];
    return v ? !!v(value) : true;
  }, []);

  const setValue = useCallback(
    (path, value, { silent = false } = {}) => {
      if (!validate(path, value)) return false;
      setSettings((prev) => {
        const next = setIn(prev, path, value);
        if (!silent) {
          try {
            analytics.track("settings/update", { path });
            eventBus.emit && eventBus.emit("settings:changed", { path, value, at: new Date().toISOString() });
          } catch (_e) {}
        }
        return next;
      });
      return true;
    },
    [analytics, eventBus, validate]
  );

  const removeValue = useCallback(
    (path, { silent = false } = {}) => {
      setSettings((prev) => {
        const next = delIn(prev, path);
        if (!silent) {
          try {
            analytics.track("settings/remove", { path });
            eventBus.emit && eventBus.emit("settings:changed", { path, value: undefined });
          } catch (_e) {}
        }
        return next;
      });
      return true;
    },
    [analytics, eventBus]
  );

  const getValue = useCallback((path, fb) => getIn(settings, path, fb), [settings]);

  const resetAll = useCallback(() => {
    const next = deepClone(DEFAULTS);
    setSettings(next);
    try {
      analytics.track("settings/reset", {});
      eventBus.emit && eventBus.emit("settings:reset", {});
    } catch (_e) {}
    return true;
  }, [analytics, eventBus]);

  // import / export ------------------------------------------------------------
  const exportSettings = useCallback(() => {
    const clean = deepClone(settings);
    // strip any volatile or secret tokens if we ever store them under integrations.*
    if (clean.integrations && clean.integrations.email) {
      delete clean.integrations.email.token;
    }
    return JSON.stringify(clean, null, 2);
  }, [settings]);

  const importSettings = useCallback(
    (json) => {
      try {
        const incoming = JSON.parse(json);
        const next = migrateSettings(incoming);
        setSettings(next);
        analytics.track("settings/import", {});
        eventBus.emit && eventBus.emit("settings:imported", {});
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e && e.message) };
      }
    },
    [analytics, eventBus]
  );

  // role / member helpers ------------------------------------------------------
  const addMember = useCallback((member) => {
    setSettings((prev) => {
      const exists = (prev.household.members || []).some((m) => m.id === member.id);
      const next = deepClone(prev);
      if (!exists) next.household.members = (prev.household.members || []).concat([member]);
      if (!next.household.activeMemberId) next.household.activeMemberId = member.id;
      return next;
    });
    analytics.track("household/member_add", {});
    return true;
  }, [analytics]);

  const updateMember = useCallback((id, patch) => {
    setSettings((prev) => {
      const next = deepClone(prev);
      next.household.members = (prev.household.members || []).map((m) =>
        m.id === id ? Object.assign({}, m, patch) : m
      );
      return next;
    });
    analytics.track("household/member_update", {});
    return true;
  }, [analytics]);

  const removeMember = useCallback((id) => {
    setSettings((prev) => {
      const next = deepClone(prev);
      next.household.members = (prev.household.members || []).filter((m) => m.id !== id);
      if (next.household.activeMemberId === id) {
        next.household.activeMemberId = (next.household.members[0] && next.household.members[0].id) || null;
      }
      return next;
    });
    analytics.track("household/member_remove", {});
    return true;
  }, [analytics]);

  const setActiveMember = useCallback((id) => {
    setSettings((prev) => setIn(prev, "household.activeMemberId", id));
    analytics.track("household/member_active", {});
  }, [analytics]);

  // convenient domain-specific setters (intuitive UX wiring) -------------------
  const setTheme = useCallback((v) => setValue("app.theme", v), [setValue]);
  const setLocale = useCallback((v) => setValue("app.locale", v), [setValue]);
  const setUnitSystem = useCallback((v) => setValue("app.units.system", v), [setValue]);
  const setSabbath = useCallback((guard) => setValue("schedule.sabbathGuard", guard), [setValue]);
  const setQuietHours = useCallback((qh) => setValue("schedule.quietHours", qh), [setValue]);
  const setNudgesMutedTags = useCallback((tags) => setValue("notifications.nudges.muteTags", tags), [setValue]);
  const toggleFeature = useCallback((key, on) => setValue(`features.${key}`, !!on), [setValue]);

  // derived selectors (for clean UI consumption) -------------------------------
  const activeMember = useMemo(() => {
    const id = settings.household.activeMemberId;
    return (settings.household.members || []).find((m) => m.id === id) || null;
  }, [settings.household]);

  const sabbathGuard = useMemo(() => settings.schedule.sabbathGuard || { enabled: false }, [settings.schedule]);
  const quietHours = useMemo(() => settings.schedule.quietHours || { enabled: false }, [settings.schedule]);
  const featureFlags = useMemo(() => settings.features || {}, [settings.features]);
  const nudgePrefs = useMemo(() => settings.notifications.nudges || { enabled: true, muteTags: [] }, [settings.notifications]);

  // event-driven enrichers (optional listeners)
  useEffect(() => {
    if (!eventBus.on || !eventBus.off) return;
    // Example: allow other parts to toggle features or set values via bus
    function handleSet(evt) { if (evt && evt.path) setValue(evt.path, evt.value); }
    function handleToggleFeature(evt) { if (evt && evt.key) toggleFeature(evt.key, evt.on); }
    eventBus.on("settings:set:req", handleSet);
    eventBus.on("settings:feature:req", handleToggleFeature);
    return () => {
      eventBus.off("settings:set:req", handleSet);
      eventBus.off("settings:feature:req", handleToggleFeature);
    };
  }, [eventBus, setValue, toggleFeature]);

  // piped settings for other contexts (PlanDraft, NBAs, executors) ------------
  const exportedForSystem = useMemo(() => ({
    timezone: settings.app.timezone,
    locale: settings.app.locale,
    unitSystem: settings.app.units.system,
    sabbathGuard,
    quietHours,
    nudgeMuteTags: nudgePrefs.muteTags || [],
    allergens: settings.allergensAndDiets.globalAllergens || [],
    diets: settings.allergensAndDiets.globalDiets || [],
    features: featureFlags,
  }), [featureFlags, nudgePrefs.muteTags, quietHours, sabbathGuard, settings]);

  // context value --------------------------------------------------------------
  const value = useMemo(
    () => ({
      loaded,
      settings,
      get: getValue,
      set: setValue,
      remove: removeValue,
      resetAll,
      exportSettings,
      importSettings,
      // domain helpers
      setTheme,
      setLocale,
      setUnitSystem,
      setSabbath,
      setQuietHours,
      setNudgesMutedTags,
      toggleFeature,
      // members
      addMember,
      updateMember,
      removeMember,
      setActiveMember,
      activeMember,
      // selectors
      sabbathGuard,
      quietHours,
      featureFlags,
      nudgePrefs,
      exportedForSystem,
    }),
    [
      loaded, settings,
      getValue, setValue, removeValue, resetAll, exportSettings, importSettings,
      setTheme, setLocale, setUnitSystem, setSabbath, setQuietHours, setNudgesMutedTags, toggleFeature,
      addMember, updateMember, removeMember, setActiveMember, activeMember,
      sabbathGuard, quietHours, featureFlags, nudgePrefs, exportedForSystem,
    ]
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used within a SettingsProvider");
  return ctx;
}
