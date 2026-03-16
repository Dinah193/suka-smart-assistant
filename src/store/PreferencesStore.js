// src/store/PreferencesStore.js
/**
 * Suka Preferences Store (v3)
 * - External store (no Zustand dep), persisted to localStorage
 * - Versioned schema + migration
 * - Emits events/toasts to the automation bus
 * - Undo, Import/Export, Theme application (CSS vars + mode)
 * - Back-compat alias: nutrition.dailyGoals ↔ foodTargets
 *
 * Plays nicely with:
 * - MealPlanStore (reads foodTargets if NutritionGoalsStore isn't loaded)
 * - Recipe/Inventory UIs (density, a11y, locale & unit prefs)
 */

import React from "react";
import { automation } from "@/services/automation/runtime";
import { applyThemeVars } from "@/utils/css";

/* ----------------------------------------------------------------------------
 * Storage / schema
 * ---------------------------------------------------------------------------- */

const LS_KEY = "suka.preferences.v3";
const SCHEMA_VERSION = 3;

const DEFAULTS = {
  __v: SCHEMA_VERSION,

  ui: {
    theme: {
      mode: "system", // light | dark | system
      accent: "hsl(8 79% 54%)", // primary brand accent
      vars: {
        "--radius": "12px",
        "--surface": "0 0% 100%",
        "--base": "0 0% 96%",
      },
      density: "comfy", // comfy | compact
      reducedMotion: false,
      tooltips: true,
    },
    locale: "en-US",
    timezone: "America/New_York",
    dateFormat: "auto", // auto | MDY | DMY | YMD
    timeFormat: "auto", // auto | 12h | 24h
  },

  nutrition: {
    units: "kcal", // kcal | kJ
    decimalPlaces: 0,
    showMacroRing: true,
    dailyGoals: { calories: 2000, protein: 120, carbs: 220, fat: 70 }, // source of truth
    macroGoalMode: "calculated", // calculated | custom
  },

  /** Back-compat alias for older modules expecting Preferences.foodTargets */
  foodTargets: { calories: 2000, protein: 120, carbs: 220, fat: 70 },

  cooking: {
    defaultMealTags: ["Breakfast", "Lunch", "Dinner", "Snack"],
    batchMode: "balanced", // balanced | cook_once_eat_twice | freezer_fill
    environment: "auto", // auto | indoor | outdoor
    pantryFirst: true,
    seasonalOnly: false,
    sabbathAware: false,
    rhythm: { enabled: false, start: "11:00", end: "19:00" },
  },

  calendar: {
    autoSync: true,
    defaultCalendarId: null,
    notifyOnConflict: true,
  },

  inventory: {
    preferPantryFirst: true,
    lowStockDays: 5,
    measurement: "imperial", // imperial | metric
  },

  notifications: {
    push: true,
    email: false,
    sounds: true,
    quietHours: { start: "22:00", end: "07:00" },
  },

  voice: {
    ttsVoice: "auto", // auto | name
    speed: 1.0, // 0.8–1.3
    wakeWord: "Suka", // wake word used by the assistant
  },

  privacy: {
    telemetry: false,
    personalization: true,
    dataRetentionDays: 180, // scrub old activity after N days (UI/cron can enforce)
  },

  experiments: {
    nbaToolbar: true, // Next-Best-Action UI hints
    foodTruckMode: true,
    westAfricanSuggest: true,
  },

  shortcuts: {
    openCommandBar: "Ctrl+K",
    addRecipe: "R",
    addInventory: "I",
    plannerNextWeek: "N",
    plannerPrevWeek: "P",
  },

  a11y: {
    highContrast: false,
    textScale: 1, // 0.85–1.4 supported
  },

  onboarding: {
    completed: false,
    steps: {
      connectCalendar: false,
      setDailyGoals: false,
      importRecipes: false,
      scanPantry: false,
    },
  },
};

function migrate(raw) {
  // Gentle forward migration
  if (!raw || typeof raw !== "object") return { ...DEFAULTS };
  const v = raw.__v || 1;
  let next = { ...DEFAULTS, ...raw };

  if (v < 2) {
    // v1 -> v2: introduce a11y + decimalPlaces defaults (from your previous code)
    next.a11y = next.a11y || { highContrast: false, textScale: 1 };
    next.nutrition = {
      ...DEFAULTS.nutrition,
      ...(next.nutrition || {}),
      decimalPlaces: Number(
        next.nutrition?.decimalPlaces ?? DEFAULTS.nutrition.decimalPlaces
      ),
    };
  }

  if (v < 3) {
    // v2 -> v3:
    // - add theme.mode/accent, locale/timezone/date/time formats
    // - add notifications/voice/privacy/experiments/shortcuts/onboarding
    // - add foodTargets alias mirrored from nutrition.dailyGoals if present
    next.ui = {
      ...DEFAULTS.ui,
      ...(next.ui || {}),
      theme: {
        ...DEFAULTS.ui.theme,
        ...(next.ui?.theme || {}),
        mode: next.ui?.theme?.mode || "system",
        accent: next.ui?.theme?.accent || DEFAULTS.ui.theme.accent,
      },
    };
    next.notifications = {
      ...DEFAULTS.notifications,
      ...(next.notifications || {}),
    };
    next.voice = { ...DEFAULTS.voice, ...(next.voice || {}) };
    next.privacy = { ...DEFAULTS.privacy, ...(next.privacy || {}) };
    next.experiments = { ...DEFAULTS.experiments, ...(next.experiments || {}) };
    next.shortcuts = { ...DEFAULTS.shortcuts, ...(next.shortcuts || {}) };
    next.onboarding = { ...DEFAULTS.onboarding, ...(next.onboarding || {}) };

    const dg = next.nutrition?.dailyGoals || DEFAULTS.nutrition.dailyGoals;
    next.foodTargets = {
      calories: Number(dg.calories || 0),
      protein: Number(dg.protein || 0),
      carbs: Number(dg.carbs || 0),
      fat: Number(dg.fat || 0),
    };
  }

  next.__v = SCHEMA_VERSION;
  return next;
}

function readFromStorage() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || "null");
    return migrate(raw);
  } catch {
    return { ...DEFAULTS };
  }
}

function writeToStorage(state) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  } catch {}
}

/* ----------------------------------------------------------------------------
 * Event & UI helpers
 * ---------------------------------------------------------------------------- */

const BUS = {
  emit: (type, data) => {
    try {
      automation.emit?.(type, data);
    } catch {}
  },
  toast: (payload) => {
    try {
      automation.emit?.("ui.toast", payload);
    } catch {}
  },
};

function nextBest(route, label) {
  return route ? { label: label || "Open", navigate: route } : null;
}

function toastSuccess(text, action) {
  BUS.toast({ tone: "success", text, action: action || null });
}

/* ----------------------------------------------------------------------------
 * External store core
 * ---------------------------------------------------------------------------- */

function createStore(initial) {
  let state = initial;
  const listeners = new Set();
  const history = []; // undo (snapshots, shallow)

  const getState = () => state;
  const subscribe = (fn) => (listeners.add(fn), () => listeners.delete(fn));

  function setState(patch, meta = {}) {
    const prev = state;
    const next = typeof patch === "function" ? patch(state) : patch;
    state = { ...state, ...next };

    // persist + notify
    writeToStorage(state);
    listeners.forEach((l) => l(state, prev, meta));
  }

  function pushUndo(snapshot) {
    history.push(snapshot);
    while (history.length > 20) history.shift();
  }

  function undo() {
    const snap = history.pop();
    if (!snap) return false;
    state = snap;
    writeToStorage(state);
    listeners.forEach((l) => l(state, snap, { kind: "undo" }));
    BUS.emit("preferences.changed", { scope: "undo" });
    toastSuccess("Undid last preference change.");
    return true;
  }

  // React hook
  const useStore = (selector = (s) => s) =>
    React.useSyncExternalStore(
      subscribe,
      () => selector(getState()),
      () => selector(getState())
    );

  return { getState, setState, subscribe, useStore, pushUndo, undo };
}

const core = createStore(readFromStorage());

/* ----------------------------------------------------------------------------
 * Theme helpers
 * ---------------------------------------------------------------------------- */

function applyTheme(state) {
  const { theme } = state?.ui || {};
  const vars = theme?.vars || {};
  // Respect theme mode: set data-theme on <html>
  const root = document.documentElement;
  const mode = theme?.mode || "system";
  const prefersDark = window.matchMedia?.(
    "(prefers-color-scheme: dark)"
  ).matches;
  const finalMode = mode === "system" ? (prefersDark ? "dark" : "light") : mode;

  try {
    root.setAttribute("data-theme", finalMode);
  } catch {}
  // Accent injection
  const merged = {
    "--accent": theme?.accent || DEFAULTS.ui.theme.accent,
    ...vars,
  };
  applyThemeVars(merged);

  BUS.emit("preferences.theme.changed", {
    vars: merged,
    density: theme?.density,
    reducedMotion: theme?.reducedMotion,
    mode: finalMode,
  });
}

/* Apply theme on first import */
try {
  applyTheme(core.getState());
} catch {}

/* ----------------------------------------------------------------------------
 * Internal helpers
 * ---------------------------------------------------------------------------- */

function deepClone(x) {
  return JSON.parse(JSON.stringify(x));
}

function patch(path, patcher, { silent = false } = {}) {
  // Simple deep patcher (1–2 levels)
  const s = core.getState();
  const before = deepClone(s); // snapshot for undo
  let draft = deepClone(s);
  let ref = draft;

  const segs = path.split(".");
  for (let i = 0; i < segs.length - 1; i++) ref = ref[segs[i]] ||= {};
  ref[segs.at(-1)] = {
    ...(ref[segs.at(-1)] || {}),
    ...(typeof patcher === "function"
      ? patcher(ref[segs.at(-1)] || {})
      : patcher),
  };

  core.pushUndo(before);
  core.setState(draft);
  if (!silent) BUS.emit("preferences.changed", { scope: path });
  return draft;
}

/** Keep `foodTargets` in sync for back-compat consumers */
function syncFoodTargets(state) {
  const dg = state.nutrition?.dailyGoals || DEFAULTS.nutrition.dailyGoals;
  state.foodTargets = {
    calories: Number(dg.calories || 0),
    protein: Number(dg.protein || 0),
    carbs: Number(dg.carbs || 0),
    fat: Number(dg.fat || 0),
  };
  return state;
}

/* ----------------------------------------------------------------------------
 * Actions by domain
 * ---------------------------------------------------------------------------- */

/* UI / Theme */
function setThemeVars(vars) {
  const next = patch("ui.theme", (t) => ({
    ...t,
    vars: { ...(t.vars || {}), ...(vars || {}) },
  }));
  applyTheme(next);
  toastSuccess("Theme updated.", nextBest("/settings/appearance", "Customize"));
  return next;
}
function setThemeMode(mode /* light|dark|system */) {
  const next = patch("ui.theme", (t) => ({ ...t, mode: mode || "system" }));
  applyTheme(next);
  toastSuccess("Theme mode updated.");
  return next;
}
function setAccent(accent) {
  const next = patch("ui.theme", (t) => ({ ...t, accent }));
  applyTheme(next);
  toastSuccess("Accent color updated.");
  return next;
}
function setDensity(density /* comfy|compact */) {
  const next = patch("ui.theme", (t) => ({ ...t, density }));
  toastSuccess("Density updated.");
  return next;
}
function setReducedMotion(on) {
  const next = patch("ui.theme", (t) => ({ ...t, reducedMotion: !!on }));
  toastSuccess("Motion preference saved.");
  return next;
}
function setTooltips(on) {
  const next = patch("ui.theme", (t) => ({ ...t, tooltips: !!on }));
  return next;
}

/* Locale/Time */
function setLocale(locale) {
  const next = patch("ui", (u) => ({
    ...u,
    locale: locale || DEFAULTS.ui.locale,
  }));
  BUS.emit("preferences.locale.changed", { locale: next.ui.locale });
  return next;
}
function setTimezone(timezone) {
  const next = patch("ui", (u) => ({
    ...u,
    timezone: timezone || DEFAULTS.ui.timezone,
  }));
  BUS.emit("preferences.tz.changed", { timezone: next.ui.timezone });
  return next;
}
function setDateTimeFormats({ dateFormat, timeFormat }) {
  const next = patch("ui", (u) => ({
    ...u,
    ...(dateFormat ? { dateFormat } : {}),
    ...(timeFormat ? { timeFormat } : {}),
  }));
  return next;
}

/* Nutrition */
function setNutritionUnits(units /* kcal|kJ */) {
  const next = patch("nutrition", (n) => ({ ...n, units }));
  BUS.emit("preferences.nutrition.changed", next);
  toastSuccess("Nutrition units updated.", nextBest("/cooking", "Recalculate"));
  return next;
}
function setDailyGoals(goals /* {calories,protein,carbs,fat} */) {
  const next = patch("nutrition", (n) => ({
    ...n,
    dailyGoals: { ...n.dailyGoals, ...goals },
  }));
  // keep alias in sync
  core.setState(syncFoodTargets(core.getState()));
  BUS.emit("preferences.nutrition.changed", core.getState());
  toastSuccess("Daily goals saved.");
  return core.getState();
}
function setMacroGoalMode(mode /* calculated|custom */) {
  const next = patch("nutrition", (n) => ({ ...n, macroGoalMode: mode }));
  return next;
}
function setShowMacroRing(on) {
  const next = patch("nutrition", (n) => ({ ...n, showMacroRing: !!on }));
  return next;
}
function setDecimalPlaces(n) {
  const safe = Math.max(0, Math.min(2, Number(n) || 0));
  const next = patch("nutrition", (x) => ({ ...x, decimalPlaces: safe }));
  return next;
}

/* Cooking defaults */
function setCookingDefaults(p) {
  const next = patch("cooking", (c) => ({ ...c, ...p }));
  BUS.emit("preferences.cooking.changed", next);
  return next;
}
function toggleMealTag(tag) {
  const s = core.getState();
  const tags = new Set(s.cooking.defaultMealTags);
  tags.has(tag) ? tags.delete(tag) : tags.add(tag);
  return setCookingDefaults({ defaultMealTags: Array.from(tags) });
}

/* Calendar */
function setCalendarPrefs(p) {
  const next = patch("calendar", (c) => ({ ...c, ...p }));
  BUS.emit("preferences.calendar.changed", next);
  if (p?.autoSync === true) {
    toastSuccess(
      "Calendar auto-sync enabled.",
      nextBest("/calendar", "Open Calendar")
    );
  }
  return next;
}

/* Inventory */
function setInventoryPrefs(p) {
  const next = patch("inventory", (i) => ({ ...i, ...p }));
  BUS.emit("preferences.inventory.changed", next);
  return next;
}

/* Notifications / Voice */
function setNotifications(prefs) {
  const next = patch("notifications", (n) => ({ ...n, ...prefs }));
  BUS.emit("preferences.notifications.changed", next);
  return next;
}
function setVoice(prefs) {
  const clamped = {
    ...prefs,
    speed: Math.max(0.8, Math.min(1.3, Number(prefs?.speed ?? 1))),
  };
  const next = patch("voice", (v) => ({ ...v, ...clamped }));
  BUS.emit("preferences.voice.changed", next);
  return next;
}

/* Privacy / Experiments / Shortcuts / Onboarding */
function setPrivacy(prefs) {
  const safe = {
    telemetry: !!prefs?.telemetry,
    personalization: !!prefs?.personalization,
    dataRetentionDays: Math.max(
      30,
      Math.min(
        3650,
        Number(prefs?.dataRetentionDays ?? DEFAULTS.privacy.dataRetentionDays)
      )
    ),
  };
  const next = patch("privacy", (p) => ({ ...p, ...safe }));
  BUS.emit("preferences.privacy.changed", next);
  return next;
}
function setExperiments(flags) {
  const next = patch("experiments", (f) => ({ ...f, ...flags }));
  return next;
}
function setShortcuts(map) {
  const next = patch("shortcuts", (m) => ({ ...m, ...map }));
  return next;
}
function completeOnboardingStep(stepKey) {
  const s = core.getState();
  if (!s.onboarding?.steps?.hasOwnProperty(stepKey)) return s;
  const next = patch("onboarding", (o) => ({
    ...o,
    steps: { ...o.steps, [stepKey]: true },
    completed: Object.values({ ...o.steps, [stepKey]: true }).every(Boolean),
  }));
  return next;
}

/* Accessibility */
function setHighContrast(on) {
  const next = patch("a11y", (a) => ({ ...a, highContrast: !!on }));
  toastSuccess("High-contrast mode saved.");
  return next;
}
function setTextScale(scale /* 0.85–1.4 */) {
  const safe = Math.max(0.85, Math.min(1.4, Number(scale) || 1));
  const next = patch("a11y", (a) => ({ ...a, textScale: safe }));
  BUS.emit("preferences.a11y.changed", next);
  return next;
}

/* Global operations */
function resetAll() {
  const before = core.getState();
  core.pushUndo(before);
  const reset = deepClone(DEFAULTS);
  core.setState(reset);
  writeToStorage(reset);
  applyTheme(reset);
  BUS.emit("preferences.changed", { scope: "reset" });
  toastSuccess("Preferences reset to defaults.");
}

function exportJSON() {
  const { __v, ...rest } = core.getState();
  return JSON.stringify({ __v: SCHEMA_VERSION, ...rest }, null, 2);
}

function importJSON(json) {
  try {
    const obj = JSON.parse(json);
    const merged = migrate({ ...DEFAULTS, ...obj });
    const before = core.getState();
    core.pushUndo(before);
    core.setState(merged);
    writeToStorage(merged);
    applyTheme(merged);
    BUS.emit("preferences.changed", { scope: "import" });
    toastSuccess("Preferences imported.", nextBest("/settings", "Review"));
    return true;
  } catch (e) {
    BUS.toast({ tone: "error", text: "Invalid preferences file." });
    return false;
  }
}

/* ----------------------------------------------------------------------------
 * Public API
 * ---------------------------------------------------------------------------- */

export const preferencesStore = {
  getState: core.getState,
  subscribe: core.subscribe,
  undo: core.undo,

  // Theme/UI
  setThemeVars,
  setThemeMode,
  setAccent,
  setDensity,
  setReducedMotion,
  setTooltips,

  // Locale/Time
  setLocale,
  setTimezone,
  setDateTimeFormats,

  // Nutrition
  setNutritionUnits,
  setDailyGoals,
  setMacroGoalMode,
  setShowMacroRing,
  setDecimalPlaces,

  // Cooking
  setCookingDefaults,
  toggleMealTag,

  // Calendar & Inventory
  setCalendarPrefs,
  setInventoryPrefs,

  // Notifications / Voice
  setNotifications,
  setVoice,

  // Privacy & Experiments & Shortcuts & Onboarding
  setPrivacy,
  setExperiments,
  setShortcuts,
  completeOnboardingStep,

  // Accessibility
  setHighContrast,
  setTextScale,

  // Global
  resetAll,
  exportJSON,
  importJSON,
};

export function usePreferencesStore() {
  const s = core.useStore((x) => x);
  return {
    ...s,
    ...preferencesStore,
  };
}

export default usePreferencesStore;

/* ----------------------------------------------------------------------------
 * Keep theme & foodTargets synced on any external state change (rare)
 * ---------------------------------------------------------------------------- */
try {
  preferencesStore.subscribe((state, prev) => {
    // Sync alias if dailyGoals changed outside our setters
    const prevDG = prev?.nutrition?.dailyGoals || {};
    const nextDG = state?.nutrition?.dailyGoals || {};
    if (
      prevDG.calories !== nextDG.calories ||
      prevDG.protein !== nextDG.protein ||
      prevDG.carbs !== nextDG.carbs ||
      prevDG.fat !== nextDG.fat
    ) {
      const patched = syncFoodTargets({ ...state });
      writeToStorage(patched);
    }
    // Re-apply theme if mode/accent/vars changed
    const pTheme = prev?.ui?.theme || {};
    const nTheme = state?.ui?.theme || {};
    if (
      pTheme.mode !== nTheme.mode ||
      pTheme.accent !== nTheme.accent ||
      JSON.stringify(pTheme.vars) !== JSON.stringify(nTheme.vars)
    ) {
      applyTheme(state);
    }
  });
} catch {}
