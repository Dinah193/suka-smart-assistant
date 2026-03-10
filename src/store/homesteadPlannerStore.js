// C:\Users\larho\suka-smart-assistant\src\store\homesteadPlannerStore.js

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { eventBus } from "@/services/events/eventBus";
import { buildEstimateInputsFromNormalizedPlan } from "@/services/planners/mealPlannerBridge";

/**
 * Homestead Planner Store (Zustand)
 * -----------------------------------------------------------------------------
 * This store is the single source of truth for:
 * - Whether the user is in Homestead Planner mode (vs standard Meal Planner)
 * - Which homestead level they selected (1..10)
 * - Simple goal toggles and UI prefs that gate estimator panels (Food Security,
 *   Cost Delta) so the meal planner isn't overwhelming by default.
 *
 * Design goals:
 * - Deterministic and predictable state transitions
 * - Backward compatible (safe defaults, migration)
 * - UI-friendly selectors and helper methods
 *
 * This store is meant to work with:
 * - src/hooks/homestead/useHomesteadProfile.js
 * - src/hooks/homestead/useHomesteadVisibility.js
 * - src/hooks/homestead/useHomesteadLevel.js
 * - src/hooks/estimators/* (Food Security + Cost Delta + Baselines + Snapshots)
 *
 * NOTE:
 * - This store does NOT directly depend on Dexie.
 * - Dexie persistence (if desired) should be handled in a separate service or
 *   adapter; for now we persist to localStorage for instant UX.
 */

/**
 * State shape:
 * {
 *   schemaVersion: "1.0.0",
 *   updatedAt: ISO,
 *
 *   plannerMode: "standard" | "homestead",
 *   enabled: boolean, // derived from plannerMode in selectors, but stored for compat
 *
 *   level: number, // 0..10 (0 means not opted in)
 *   startDate: ISO | null,
 *
 *   goals: {
 *     foodSecurity: boolean,
 *     budgetReduction: boolean,
 *     scratchCooking: boolean,
 *     pantryBuildout: boolean,
 *     gardenStarter: boolean,
 *     animalStarter: boolean
 *   },
 *
 *   ui: {
 *     showEstimators: boolean, // master toggle within homestead planner
 *     showFoodSecurity: boolean,
 *     showCostDelta: boolean,
 *     showDetailsDrawer: boolean,
 *     lastActivePanel: "overview"|"food_security"|"cost_delta"|"plan"|"inventory"|"settings",
 *   }
 * }
 */

const STORAGE_KEY = "ssa.homesteadPlanner";

/* =============================================================================
   Defaults
============================================================================= */

const DEFAULT_STATE = {
  schemaVersion: "1.0.0",
  updatedAt: new Date(0).toISOString(),

  plannerMode: "standard", // standard|homestead
  enabled: false,

  level: 0, // 0..10
  startDate: null,

  goals: {
    foodSecurity: true,
    budgetReduction: true,
    scratchCooking: true,
    pantryBuildout: true,
    gardenStarter: false,
    animalStarter: false,
  },

  ui: {
    showEstimators: true,
    showFoodSecurity: true,
    showCostDelta: true,
    showDetailsDrawer: true,
    lastActivePanel: "overview",
  },

  ingest: {
    lastMealPlanContract: null,
    lastEstimateInputs: null,
    lastIngestedAt: null,
  },
};

function normalizeState(input) {
  const s = input && typeof input === "object" ? input : {};
  const goals = s.goals && typeof s.goals === "object" ? s.goals : {};
  const ui = s.ui && typeof s.ui === "object" ? s.ui : {};
  const ingest = s.ingest && typeof s.ingest === "object" ? s.ingest : {};

  const plannerMode = s.plannerMode === "homestead" ? "homestead" : "standard";
  const level = clampInt(s.level ?? 0, 0, 10);

  return {
    schemaVersion:
      typeof s.schemaVersion === "string" ? s.schemaVersion : "1.0.0",
    updatedAt: normalizeIsoNow(s.updatedAt),

    plannerMode,
    enabled: Boolean(s.enabled ?? (plannerMode === "homestead" && level > 0)),

    level,
    startDate: s.startDate ? normalizeIsoNow(s.startDate) : null,

    goals: {
      foodSecurity: Boolean(goals.foodSecurity ?? true),
      budgetReduction: Boolean(goals.budgetReduction ?? true),
      scratchCooking: Boolean(goals.scratchCooking ?? true),
      pantryBuildout: Boolean(goals.pantryBuildout ?? true),
      gardenStarter: Boolean(goals.gardenStarter ?? false),
      animalStarter: Boolean(goals.animalStarter ?? false),
    },

    ui: {
      showEstimators: Boolean(ui.showEstimators ?? true),
      showFoodSecurity: Boolean(ui.showFoodSecurity ?? true),
      showCostDelta: Boolean(ui.showCostDelta ?? true),
      showDetailsDrawer: Boolean(ui.showDetailsDrawer ?? true),
      lastActivePanel: normalizePanel(ui.lastActivePanel),
    },

    ingest: {
      lastMealPlanContract:
        ingest.lastMealPlanContract && typeof ingest.lastMealPlanContract === "object"
          ? ingest.lastMealPlanContract
          : null,
      lastEstimateInputs:
        ingest.lastEstimateInputs && typeof ingest.lastEstimateInputs === "object"
          ? ingest.lastEstimateInputs
          : null,
      lastIngestedAt: ingest.lastIngestedAt ? normalizeIsoNow(ingest.lastIngestedAt) : null,
    },
  };
}

function migrateState(persisted, version) {
  // Zustand persist "version" is separate from schemaVersion, but we keep both.
  // We do additive migrations here for stability.
  const base = normalizeState(persisted || DEFAULT_STATE);

  // Example future migration blocks:
  // if (version < 2) { ... }

  return base;
}

/* =============================================================================
   Store
============================================================================= */

export const useHomesteadPlannerStore = create(
  persist(
    (set, get) => ({
      ...normalizeState(DEFAULT_STATE),

      /* ---------------------------------------------------------------------
         Core mode controls
      --------------------------------------------------------------------- */

      setPlannerMode: (mode, meta = {}) => {
        const nextMode = mode === "homestead" ? "homestead" : "standard";
        set((prev) => {
          const prevNorm = normalizeState(prev);
          const level = prevNorm.level;

          // If switching to standard, disable and optionally keep level as-is (so user can return quickly)
          const enabled = nextMode === "homestead" ? level > 0 : false;

          const next = normalizeState({
            ...prevNorm,
            plannerMode: nextMode,
            enabled,
            updatedAt: new Date().toISOString(),
          });

          // If moving to standard, we typically hide estimator UI in meal planner.
          if (nextMode === "standard") {
            next.ui = {
              ...next.ui,
              showEstimators: false,
            };
          }

          return next;
        });
        // meta hook (optional) for future eventBus taps could go here
        void meta;
      },

      enableHomesteadMode: (level = 1, meta = {}) => {
        set((prev) => {
          const prevNorm = normalizeState(prev);
          const lvl = clampInt(level ?? 1, 1, 10);

          const next = normalizeState({
            ...prevNorm,
            plannerMode: "homestead",
            enabled: true,
            level: lvl,
            startDate: prevNorm.startDate || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            ui: {
              ...prevNorm.ui,
              showEstimators: true,
              showFoodSecurity: true,
              showCostDelta: true,
              lastActivePanel: prevNorm.ui.lastActivePanel || "overview",
            },
          });

          return next;
        });
        void meta;
      },

      disableHomesteadMode: (meta = {}) => {
        set((prev) => {
          const prevNorm = normalizeState(prev);

          const next = normalizeState({
            ...prevNorm,
            plannerMode: "standard",
            enabled: false,
            // keep level so user can re-enable quickly; UI will gate display anyway
            updatedAt: new Date().toISOString(),
            ui: {
              ...prevNorm.ui,
              showEstimators: false,
            },
          });

          return next;
        });
        void meta;
      },

      /* ---------------------------------------------------------------------
         Level controls
      --------------------------------------------------------------------- */

      setLevel: (level, meta = {}) => {
        set((prev) => {
          const prevNorm = normalizeState(prev);
          const lvl = clampInt(level ?? 0, 0, 10);

          // Level 0 means not opted in (keep mode consistent: usually standard)
          const plannerMode = lvl > 0 ? "homestead" : "standard";
          const enabled = lvl > 0;

          const next = normalizeState({
            ...prevNorm,
            level: lvl,
            plannerMode,
            enabled,
            startDate: enabled
              ? prevNorm.startDate || new Date().toISOString()
              : null,
            updatedAt: new Date().toISOString(),
          });

          // If level becomes >0, ensure estimator toggles are on by default
          if (enabled) {
            next.ui = {
              ...next.ui,
              showEstimators: true,
              showFoodSecurity: next.ui.showFoodSecurity ?? true,
              showCostDelta: next.ui.showCostDelta ?? true,
            };
          } else {
            next.ui = {
              ...next.ui,
              showEstimators: false,
            };
          }

          return next;
        });
        void meta;
      },

      incrementLevel: (meta = {}) => {
        const cur = get().level || 0;
        get().setLevel(Math.min(10, cur + 1), meta);
      },

      decrementLevel: (meta = {}) => {
        const cur = get().level || 0;
        get().setLevel(Math.max(0, cur - 1), meta);
      },

      /* ---------------------------------------------------------------------
         Goals
      --------------------------------------------------------------------- */

      setGoal: (key, value, meta = {}) => {
        set((prev) => {
          const prevNorm = normalizeState(prev);
          const goals = { ...prevNorm.goals };

          if (!Object.prototype.hasOwnProperty.call(goals, key)) {
            return prevNorm; // ignore unknown
          }

          goals[key] = Boolean(value);

          return normalizeState({
            ...prevNorm,
            goals,
            updatedAt: new Date().toISOString(),
          });
        });
        void meta;
      },

      toggleGoal: (key, meta = {}) => {
        const goals = get().goals || {};
        const cur = Boolean(goals[key]);
        get().setGoal(key, !cur, meta);
      },

      setGoals: (partial, meta = {}) => {
        set((prev) => {
          const prevNorm = normalizeState(prev);
          const nextGoals = { ...prevNorm.goals };

          if (partial && typeof partial === "object") {
            for (const [k, v] of Object.entries(partial)) {
              if (Object.prototype.hasOwnProperty.call(nextGoals, k)) {
                nextGoals[k] = Boolean(v);
              }
            }
          }

          return normalizeState({
            ...prevNorm,
            goals: nextGoals,
            updatedAt: new Date().toISOString(),
          });
        });
        void meta;
      },

      /* ---------------------------------------------------------------------
         UI Controls
      --------------------------------------------------------------------- */

      setUI: (patch, meta = {}) => {
        set((prev) => {
          const prevNorm = normalizeState(prev);
          const uiPatch = patch && typeof patch === "object" ? patch : {};
          const nextUI = {
            ...prevNorm.ui,
            ...uiPatch,
            lastActivePanel: uiPatch.lastActivePanel
              ? normalizePanel(uiPatch.lastActivePanel)
              : prevNorm.ui.lastActivePanel,
          };

          return normalizeState({
            ...prevNorm,
            ui: nextUI,
            updatedAt: new Date().toISOString(),
          });
        });
        void meta;
      },

      setLastActivePanel: (panel, meta = {}) => {
        get().setUI({ lastActivePanel: normalizePanel(panel) }, meta);
      },

      toggleEstimators: (meta = {}) => {
        const cur = Boolean(get().ui?.showEstimators);
        get().setUI({ showEstimators: !cur }, meta);
      },

      toggleFoodSecurityPanel: (meta = {}) => {
        const cur = Boolean(get().ui?.showFoodSecurity);
        get().setUI({ showFoodSecurity: !cur }, meta);
      },

      toggleCostDeltaPanel: (meta = {}) => {
        const cur = Boolean(get().ui?.showCostDelta);
        get().setUI({ showCostDelta: !cur }, meta);
      },

      toggleDetailsDrawer: (meta = {}) => {
        const cur = Boolean(get().ui?.showDetailsDrawer);
        get().setUI({ showDetailsDrawer: !cur }, meta);
      },

      /* ---------------------------------------------------------------------
         Reset & Import/Export
      --------------------------------------------------------------------- */

      reset: (meta = {}) => {
        set(() => normalizeState(DEFAULT_STATE));
        void meta;
      },

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

      ingestMealPlanGenerated: (contract, meta = {}) => {
        if (!contract || typeof contract !== "object") return { ok: false };

        set((prev) => {
          const prevNorm = normalizeState(prev);
          const estimateInputs = buildEstimateInputsFromNormalizedPlan({
            normalizedPlan: {
              title: contract?.plan?.title,
              summary: contract?.plan?.summary,
              // Keep backward-compatible shape from emission contract.
              meals: Array(Number(contract?.plan?.mealCount || 0)).fill({}),
              shoppingList: Array(Number(contract?.plan?.shoppingCount || 0)).fill({}),
              prepTasks: Array(Number(contract?.plan?.prepTaskCount || 0)).fill({}),
              budget: contract?.plan?.budget || {},
              macros: contract?.plan?.macros || {},
            },
            meta: {
              sessionId: meta.sessionId || null,
            },
          });

          return normalizeState({
            ...prevNorm,
            ingest: {
              lastMealPlanContract: contract,
              lastEstimateInputs: estimateInputs,
              lastIngestedAt: new Date().toISOString(),
            },
            updatedAt: new Date().toISOString(),
          });
        });

        void meta;
        return { ok: true };
      },
    }),
    {
      name: STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => window.localStorage),
      partialize: (state) => {
        // Keep persisted footprint small and stable
        const s = normalizeState(state);
        return {
          schemaVersion: s.schemaVersion,
          updatedAt: s.updatedAt,
          plannerMode: s.plannerMode,
          enabled: s.enabled,
          level: s.level,
          startDate: s.startDate,
          goals: s.goals,
          ui: s.ui,
          ingest: s.ingest,
        };
      },
      migrate: (persistedState, version) =>
        migrateState(persistedState, version),
    },
  ),
);

let _homesteadIngestorOff = null;
export function initializeHomesteadMealPlanIngestor() {
  if (_homesteadIngestorOff) return _homesteadIngestorOff;
  _homesteadIngestorOff = eventBus?.on?.(
    "homestead.planner.mealPlan.generated",
    (payload) => {
      try {
        const contract =
          payload && typeof payload === "object" && payload.data && payload.type
            ? payload.data
            : payload;

        useHomesteadPlannerStore.getState().ingestMealPlanGenerated(contract, {
          source: "eventBus:homestead.planner.mealPlan.generated",
        });
      } catch (e) {
        console.warn("[homesteadPlannerStore] ingest failed", e);
      }
    }
  );
  return _homesteadIngestorOff;
}

if (typeof window !== "undefined") {
  try {
    initializeHomesteadMealPlanIngestor();
  } catch {
    // no-op: store remains usable even if event bus is unavailable
  }
}

/* =============================================================================
   Selectors (recommended)
============================================================================= */

export const selectHomesteadEnabled = (s) =>
  Boolean(s.enabled || (s.plannerMode === "homestead" && (s.level || 0) > 0));
export const selectHomesteadLevel = (s) => clampInt(s.level ?? 0, 0, 10);
export const selectPlannerMode = (s) =>
  s.plannerMode === "homestead" ? "homestead" : "standard";

export const selectShowEstimators = (s) => Boolean(s.ui?.showEstimators);
export const selectShowFoodSecurity = (s) => Boolean(s.ui?.showFoodSecurity);
export const selectShowCostDelta = (s) => Boolean(s.ui?.showCostDelta);
export const selectShowDetailsDrawer = (s) => Boolean(s.ui?.showDetailsDrawer);
export const selectLastActivePanel = (s) =>
  normalizePanel(s.ui?.lastActivePanel);

/**
 * Derived helper:
 * gate estimators in UI (so meal planner stays uncluttered)
 */
export const selectEstimatorGate = (s) => {
  const enabled = selectHomesteadEnabled(s);
  const showEstimators = enabled && selectShowEstimators(s);
  return {
    enabled,
    showEstimators,
    showFoodSecurity: showEstimators && selectShowFoodSecurity(s),
    showCostDelta: showEstimators && selectShowCostDelta(s),
    showDetailsDrawer: enabled && selectShowDetailsDrawer(s),
    level: selectHomesteadLevel(s),
    mode: selectPlannerMode(s),
    lastActivePanel: selectLastActivePanel(s),
  };
};

/* =============================================================================
   Utilities
============================================================================= */

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

function normalizePanel(panel) {
  const p = String(panel || "overview")
    .toLowerCase()
    .trim();
  const allowed = new Set([
    "overview",
    "food_security",
    "cost_delta",
    "plan",
    "inventory",
    "settings",
  ]);
  return allowed.has(p) ? p : "overview";
}

function safeParseJson(text) {
  try {
    const value = JSON.parse(String(text || ""));
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: e };
  }
}
