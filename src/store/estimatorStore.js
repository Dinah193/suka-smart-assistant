// C:\Users\larho\suka-smart-assistant\src\store\estimatorStore.js

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

/**
 * Estimator Store (Zustand)
 * -----------------------------------------------------------------------------
 * Centralized, UI-friendly state for SSA estimators:
 * - Food Security
 * - Cost Delta (budget reduction)
 *
 * What belongs here:
 * - UI state: which estimator panel is open, drawer open/closed, filters, etc.
 * - Cached last-run results (so user sees something instantly when revisiting)
 * - "Why this?" and plain-language explanations computed elsewhere can be stored
 *   here if desired, but this store keeps only light, serializable artifacts.
 *
 * What does NOT belong here:
 * - Heavy live data snapshots (inventory, price tables, etc.) — those should be
 *   pulled by adapters via hooks (useEstimatorSnapshots) when needed.
 *
 * Integration points:
 * - src/hooks/estimators/useFoodSecurityEstimator.js
 * - src/hooks/estimators/useCostDeltaEstimator.js
 * - src/hooks/estimators/useEstimatorBaselines.js
 * - src/hooks/estimators/useEstimatorSnapshots.js
 * - src/components/estimators/* UI components
 *
 * Persistence:
 * - localStorage for fast UX
 * - keep footprint small via partialize
 */

const STORAGE_KEY = "ssa.estimators.store";

/* =============================================================================
   Defaults
============================================================================= */

const DEFAULT_STATE = {
  schemaVersion: "1.0.0",
  updatedAt: new Date(0).toISOString(),

  ui: {
    drawerOpen: false,
    drawerWidth: 420,
    activeEstimator: "overview", // overview|food_security|cost_delta|baselines
    activeTab: "summary", // summary|details|drivers|assumptions|history
    showWhyThis: true,
    showAdvanced: false,
    compactMode: false,

    // Optional: user wants to hide estimator modules unless homestead enabled;
    // actual gating should be determined by useHomesteadVisibility, but this
    // allows user preference.
    hideUnlessHomestead: true,
  },

  // Cached results (last run per estimator)
  results: {
    foodSecurity: null,
    costDelta: null,
  },

  // Optional: history list (trimmed)
  history: {
    foodSecurity: [],
    costDelta: [],
    maxEntries: 12,
  },

  // Diagnostics for UI (last error per estimator)
  errors: {
    foodSecurity: null,
    costDelta: null,
  },
};

function normalizeState(input) {
  const s = input && typeof input === "object" ? input : {};
  const ui = s.ui && typeof s.ui === "object" ? s.ui : {};
  const results = s.results && typeof s.results === "object" ? s.results : {};
  const history = s.history && typeof s.history === "object" ? s.history : {};
  const errors = s.errors && typeof s.errors === "object" ? s.errors : {};

  return {
    schemaVersion:
      typeof s.schemaVersion === "string" ? s.schemaVersion : "1.0.0",
    updatedAt: normalizeIsoNow(s.updatedAt),

    ui: {
      drawerOpen: Boolean(ui.drawerOpen ?? false),
      drawerWidth: clampInt(ui.drawerWidth ?? 420, 280, 720),
      activeEstimator: normalizeEstimatorKey(ui.activeEstimator),
      activeTab: normalizeTabKey(ui.activeTab),
      showWhyThis: Boolean(ui.showWhyThis ?? true),
      showAdvanced: Boolean(ui.showAdvanced ?? false),
      compactMode: Boolean(ui.compactMode ?? false),
      hideUnlessHomestead: Boolean(ui.hideUnlessHomestead ?? true),
    },

    results: {
      foodSecurity: sanitizeResult(results.foodSecurity),
      costDelta: sanitizeResult(results.costDelta),
    },

    history: {
      foodSecurity: trimHistory(
        history.foodSecurity,
        clampInt(history.maxEntries ?? 12, 0, 100),
      ),
      costDelta: trimHistory(
        history.costDelta,
        clampInt(history.maxEntries ?? 12, 0, 100),
      ),
      maxEntries: clampInt(history.maxEntries ?? 12, 0, 100),
    },

    errors: {
      foodSecurity: sanitizeError(errors.foodSecurity),
      costDelta: sanitizeError(errors.costDelta),
    },
  };
}

function migrateState(persisted, version) {
  // Future additive migrations can be done here.
  // if (version < 2) { ... }
  void version;
  return normalizeState(persisted || DEFAULT_STATE);
}

/* =============================================================================
   Store
============================================================================= */

export const useEstimatorStore = create(
  persist(
    (set, get) => ({
      ...normalizeState(DEFAULT_STATE),

      /* ---------------------------------------------------------------------
         UI Actions
      --------------------------------------------------------------------- */

      openDrawer: (meta = {}) => {
        set((prev) =>
          normalizeState({
            ...prev,
            ui: { ...prev.ui, drawerOpen: true },
            updatedAt: new Date().toISOString(),
          }),
        );
        void meta;
      },

      closeDrawer: (meta = {}) => {
        set((prev) =>
          normalizeState({
            ...prev,
            ui: { ...prev.ui, drawerOpen: false },
            updatedAt: new Date().toISOString(),
          }),
        );
        void meta;
      },

      toggleDrawer: (meta = {}) => {
        const cur = Boolean(get().ui?.drawerOpen);
        if (cur) get().closeDrawer(meta);
        else get().openDrawer(meta);
      },

      setDrawerWidth: (width, meta = {}) => {
        set((prev) =>
          normalizeState({
            ...prev,
            ui: { ...prev.ui, drawerWidth: clampInt(width ?? 420, 280, 720) },
            updatedAt: new Date().toISOString(),
          }),
        );
        void meta;
      },

      setActiveEstimator: (key, meta = {}) => {
        set((prev) =>
          normalizeState({
            ...prev,
            ui: { ...prev.ui, activeEstimator: normalizeEstimatorKey(key) },
            updatedAt: new Date().toISOString(),
          }),
        );
        void meta;
      },

      setActiveTab: (tab, meta = {}) => {
        set((prev) =>
          normalizeState({
            ...prev,
            ui: { ...prev.ui, activeTab: normalizeTabKey(tab) },
            updatedAt: new Date().toISOString(),
          }),
        );
        void meta;
      },

      setUI: (patch, meta = {}) => {
        set((prev) => {
          const p = patch && typeof patch === "object" ? patch : {};
          return normalizeState({
            ...prev,
            ui: {
              ...prev.ui,
              ...p,
              activeEstimator: p.activeEstimator
                ? normalizeEstimatorKey(p.activeEstimator)
                : prev.ui.activeEstimator,
              activeTab: p.activeTab
                ? normalizeTabKey(p.activeTab)
                : prev.ui.activeTab,
              drawerWidth:
                p.drawerWidth != null
                  ? clampInt(p.drawerWidth, 280, 720)
                  : prev.ui.drawerWidth,
            },
            updatedAt: new Date().toISOString(),
          });
        });
        void meta;
      },

      toggleWhyThis: (meta = {}) => {
        const cur = Boolean(get().ui?.showWhyThis);
        get().setUI({ showWhyThis: !cur }, meta);
      },

      toggleAdvanced: (meta = {}) => {
        const cur = Boolean(get().ui?.showAdvanced);
        get().setUI({ showAdvanced: !cur }, meta);
      },

      toggleCompact: (meta = {}) => {
        const cur = Boolean(get().ui?.compactMode);
        get().setUI({ compactMode: !cur }, meta);
      },

      setHideUnlessHomestead: (value, meta = {}) => {
        get().setUI({ hideUnlessHomestead: Boolean(value) }, meta);
      },

      /* ---------------------------------------------------------------------
         Result caching
      --------------------------------------------------------------------- */

      setFoodSecurityResult: (result, meta = {}) => {
        get().setResult("foodSecurity", result, meta);
      },

      setCostDeltaResult: (result, meta = {}) => {
        get().setResult("costDelta", result, meta);
      },

      setResult: (kind, result, meta = {}) => {
        const k = normalizeResultKind(kind);
        if (!k) return;

        set((prev) => {
          const next = normalizeState({
            ...prev,
            results: {
              ...prev.results,
              [k]: sanitizeResult(result),
            },
            errors: {
              ...prev.errors,
              [k]: null,
            },
            updatedAt: new Date().toISOString(),
          });

          // optionally write history entry
          const addHistory = Boolean(meta?.addToHistory ?? true);
          if (addHistory && result) {
            return normalizeState({
              ...next,
              history: addHistoryEntry(next.history, k, result),
            });
          }

          return next;
        });
      },

      clearResult: (kind, meta = {}) => {
        const k = normalizeResultKind(kind);
        if (!k) return;
        set((prev) =>
          normalizeState({
            ...prev,
            results: { ...prev.results, [k]: null },
            updatedAt: new Date().toISOString(),
          }),
        );
        void meta;
      },

      clearAllResults: (meta = {}) => {
        set((prev) =>
          normalizeState({
            ...prev,
            results: { foodSecurity: null, costDelta: null },
            updatedAt: new Date().toISOString(),
          }),
        );
        void meta;
      },

      /* ---------------------------------------------------------------------
         Errors
      --------------------------------------------------------------------- */

      setError: (kind, error, meta = {}) => {
        const k = normalizeResultKind(kind);
        if (!k) return;
        set((prev) =>
          normalizeState({
            ...prev,
            errors: { ...prev.errors, [k]: sanitizeError(error) },
            updatedAt: new Date().toISOString(),
          }),
        );
        void meta;
      },

      clearError: (kind, meta = {}) => {
        const k = normalizeResultKind(kind);
        if (!k) return;
        set((prev) =>
          normalizeState({
            ...prev,
            errors: { ...prev.errors, [k]: null },
            updatedAt: new Date().toISOString(),
          }),
        );
        void meta;
      },

      /* ---------------------------------------------------------------------
         History
      --------------------------------------------------------------------- */

      setMaxHistoryEntries: (n, meta = {}) => {
        const maxEntries = clampInt(n ?? 12, 0, 100);
        set((prev) =>
          normalizeState({
            ...prev,
            history: {
              ...prev.history,
              maxEntries,
              foodSecurity: trimHistory(prev.history.foodSecurity, maxEntries),
              costDelta: trimHistory(prev.history.costDelta, maxEntries),
            },
            updatedAt: new Date().toISOString(),
          }),
        );
        void meta;
      },

      clearHistory: (kind, meta = {}) => {
        const k = normalizeResultKind(kind);
        set((prev) => {
          const h = { ...prev.history };
          if (!k) {
            h.foodSecurity = [];
            h.costDelta = [];
          } else {
            h[k] = [];
          }
          return normalizeState({
            ...prev,
            history: h,
            updatedAt: new Date().toISOString(),
          });
        });
        void meta;
      },

      /* ---------------------------------------------------------------------
         Import / Export / Reset
      --------------------------------------------------------------------- */

      exportState: () => {
        const s = normalizeState(get());
        return JSON.stringify(s, null, 2);
      },

      importState: (jsonOrObject, meta = {}) => {
        const parsed =
          typeof jsonOrObject === "string"
            ? safeParseJson(jsonOrObject)
            : { ok: true, value: jsonOrObject };
        if (!parsed.ok) return { ok: false, error: parsed.error };

        const next = normalizeState(parsed.value);
        set(() => next);
        void meta;
        return { ok: true, state: next };
      },

      reset: (meta = {}) => {
        set(() => normalizeState(DEFAULT_STATE));
        void meta;
      },
    }),
    {
      name: STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => window.localStorage),
      partialize: (state) => {
        const s = normalizeState(state);
        return {
          schemaVersion: s.schemaVersion,
          updatedAt: s.updatedAt,
          ui: s.ui,
          results: s.results,
          history: s.history,
          errors: s.errors,
        };
      },
      migrate: (persistedState, version) =>
        migrateState(persistedState, version),
    },
  ),
);

/* =============================================================================
   Selectors (recommended)
============================================================================= */

export const selectEstimatorUI = (s) => s.ui;
export const selectDrawerOpen = (s) => Boolean(s.ui?.drawerOpen);
export const selectActiveEstimator = (s) =>
  normalizeEstimatorKey(s.ui?.activeEstimator);
export const selectActiveTab = (s) => normalizeTabKey(s.ui?.activeTab);

export const selectFoodSecurityResult = (s) => s.results?.foodSecurity || null;
export const selectCostDeltaResult = (s) => s.results?.costDelta || null;

export const selectFoodSecurityError = (s) => s.errors?.foodSecurity || null;
export const selectCostDeltaError = (s) => s.errors?.costDelta || null;

export const selectEstimatorHistory = (s) => s.history;
export const selectFoodSecurityHistory = (s) =>
  Array.isArray(s.history?.foodSecurity) ? s.history.foodSecurity : [];
export const selectCostDeltaHistory = (s) =>
  Array.isArray(s.history?.costDelta) ? s.history.costDelta : [];

/**
 * A single selector to power the drawer header + navigation
 */
export const selectEstimatorNavModel = (s) => {
  const ui = s.ui || {};
  return {
    drawerOpen: Boolean(ui.drawerOpen),
    drawerWidth: clampInt(ui.drawerWidth ?? 420, 280, 720),
    activeEstimator: normalizeEstimatorKey(ui.activeEstimator),
    activeTab: normalizeTabKey(ui.activeTab),
    showWhyThis: Boolean(ui.showWhyThis),
    showAdvanced: Boolean(ui.showAdvanced),
    compactMode: Boolean(ui.compactMode),
    hideUnlessHomestead: Boolean(ui.hideUnlessHomestead),
  };
};

/* =============================================================================
   Internals
============================================================================= */

function normalizeResultKind(kind) {
  const k = String(kind || "")
    .trim()
    .toLowerCase();
  if (
    k === "foodsecurity" ||
    k === "food_security" ||
    k === "foodsecurityestimator"
  )
    return "foodSecurity";
  if (
    k === "costdelta" ||
    k === "cost_delta" ||
    k === "budget" ||
    k === "costdeltaestimator"
  )
    return "costDelta";
  if (k === "foodsecurityresult" || k === "foodsecurity_results")
    return "foodSecurity";
  if (k === "costdeltaresult" || k === "costdelta_results") return "costDelta";
  if (k === "foodsecurity" || k === "foodsecurity") return "foodSecurity";
  if (k === "costdelta" || k === "costdelta") return "costDelta";
  return k === "foodsecurity"
    ? "foodSecurity"
    : k === "costdelta"
      ? "costDelta"
      : k === "foodsecurity"
        ? "foodSecurity"
        : null;
}

function normalizeEstimatorKey(key) {
  const k = String(key || "overview")
    .trim()
    .toLowerCase();
  const allowed = new Set([
    "overview",
    "food_security",
    "cost_delta",
    "baselines",
  ]);
  if (allowed.has(k)) return k;
  // accept aliases
  if (k === "foodsecurity") return "food_security";
  if (k === "costdelta" || k === "budget") return "cost_delta";
  return "overview";
}

function normalizeTabKey(key) {
  const k = String(key || "summary")
    .trim()
    .toLowerCase();
  const allowed = new Set([
    "summary",
    "details",
    "drivers",
    "assumptions",
    "history",
  ]);
  return allowed.has(k) ? k : "summary";
}

function sanitizeResult(r) {
  if (!r || typeof r !== "object") return null;

  // Keep only serializable "safe" fields; allow nested outputs
  const schemaVersion =
    typeof r.schemaVersion === "string" ? r.schemaVersion : "1.0.0";
  const updatedAt = normalizeIsoNow(
    r.updatedAt || r.run?.createdAt || r.meta?.updatedAt,
  );

  const meta = r.meta && typeof r.meta === "object" ? r.meta : {};
  const run = r.run && typeof r.run === "object" ? r.run : {};
  const outputs = r.outputs && typeof r.outputs === "object" ? r.outputs : {};

  return {
    schemaVersion,
    updatedAt,
    meta: {
      id: meta.id ? String(meta.id) : null,
      type: meta.type ? String(meta.type) : null,
      domain: meta.domain ? String(meta.domain) : null,
      locale: meta.locale ? String(meta.locale) : "en-US",
      label: meta.label ? String(meta.label) : null,
      description: meta.description ? String(meta.description) : null,
    },
    run: {
      id: run.id ? String(run.id) : null,
      createdAt: run.createdAt ? String(run.createdAt) : updatedAt,
      context:
        run.context && typeof run.context === "object" ? run.context : null,
      inputs: run.inputs && typeof run.inputs === "object" ? run.inputs : null,
      assumptions:
        run.assumptions && typeof run.assumptions === "object"
          ? run.assumptions
          : null,
    },
    outputs,
  };
}

function sanitizeError(e) {
  if (!e) return null;
  if (typeof e === "string")
    return { message: e, at: new Date().toISOString() };
  if (e instanceof Error)
    return {
      message: e.message,
      at: new Date().toISOString(),
      name: e.name,
      stack: e.stack,
    };
  if (typeof e === "object") {
    return {
      message: String(e.message || "Estimator error"),
      at: new Date().toISOString(),
      name: e.name ? String(e.name) : null,
      stack: e.stack ? String(e.stack) : null,
    };
  }
  return { message: String(e), at: new Date().toISOString() };
}

function addHistoryEntry(historyState, kind, result) {
  const maxEntries = clampInt(historyState?.maxEntries ?? 12, 0, 100);

  const entry = {
    id:
      result?.run?.id ||
      `h_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    at: normalizeIsoNow(result?.updatedAt || result?.run?.createdAt),
    meta: {
      id: result?.meta?.id || null,
      label: result?.meta?.label || null,
    },
    // Store only a small output preview for history list UI
    preview: buildHistoryPreview(kind, result?.outputs || {}),
    outputs: result?.outputs || {},
  };

  const out = { ...(historyState || {}) };
  const list = Array.isArray(out[kind]) ? out[kind].slice() : [];
  list.unshift(entry);

  out[kind] = trimHistory(list, maxEntries);
  out.maxEntries = maxEntries;

  return out;
}

function buildHistoryPreview(kind, outputs) {
  if (!outputs || typeof outputs !== "object") return {};

  if (kind === "foodSecurity") {
    return {
      days: outputs.daysOfCoverage ?? null,
      meals: outputs.mealEquivalentDays ?? null,
      confidence: outputs.confidence ?? null,
    };
  }

  if (kind === "costDelta") {
    return {
      weeklySavings: outputs.weeklySavings ?? null,
      monthlySavings: outputs.monthlySavings ?? null,
      confidence: outputs.confidence ?? null,
    };
  }

  return {};
}

function trimHistory(list, maxEntries) {
  if (!Array.isArray(list)) return [];
  const n = clampInt(maxEntries ?? 12, 0, 100);
  if (n === 0) return [];
  return list
    .filter(Boolean)
    .slice(0, n)
    .map((x) => (x && typeof x === "object" ? x : null))
    .filter(Boolean);
}

function clampInt(v, min, max) {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function normalizeIsoNow(value) {
  if (!value) return new Date().toISOString();
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return new Date().toISOString();
  return d.toISOString();
}

function safeParseJson(text) {
  try {
    const value = JSON.parse(String(text || ""));
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: e };
  }
}
