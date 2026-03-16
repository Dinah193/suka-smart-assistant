// C:\Users\larho\suka-smart-assistant\src\hooks\homestead\useHomesteadVisibility.js

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHomesteadProfile } from "./useHomesteadProfile";

/**
 * useHomesteadVisibility
 * -----------------------------------------------------------------------------
 * Centralizes "what homestead stuff should show up right now?" logic.
 *
 * Primary use:
 * - Only show farm-to-table / homestead pipeline UI when user explicitly opts in
 *   (e.g., selects Homestead Planner and chooses a starting level).
 *
 * Secondary use:
 * - Gate advanced modules by level (garden/animals/preservation/storehouse).
 * - Provide feature flags for the estimator UI ("food security", "cost delta").
 *
 * This hook is intentionally deterministic and safe: it does not call the web,
 * does not infer user intentions beyond explicit toggles/level selections, and
 * has a localStorage fallback if Dexie isn't wired yet.
 *
 * API:
 * const vis = useHomesteadVisibility({ context });
 * vis.enabled                     // boolean (master on/off)
 * vis.level                       // number
 * vis.mode                        // "homestead_planner" | "meal_planner" | "unknown"
 * vis.showHomesteadPlannerUI      // boolean
 * vis.showEstimatorPanels         // boolean
 * vis.showFoodSecurityEstimator   // boolean
 * vis.showCostDeltaEstimator      // boolean
 * vis.showGardenModules           // boolean
 * vis.showAnimalModules           // boolean
 * vis.showPreservationModules     // boolean
 * vis.showStorehouseModules       // boolean
 * vis.reason                      // plain-language gating explanation (for tooltips)
 *
 * Actions:
 * vis.enable(level?)              // enables homestead mode and sets a level
 * vis.disable()                   // disables homestead mode (keeps profile but hides UI)
 * vis.setLevel(n)                 // sets level (auto-enables if n>0)
 * vis.setMode(mode)               // sets current UI mode (persisted)
 * vis.setEnabled(boolean)         // explicit toggle
 *
 * Options:
 * - context: { mode, screen, route, plannerMode } optional runtime context
 * - key: override localStorage key for visibility state (default: "ssa.homestead.visibility")
 * - profileOptions: passed to useHomesteadProfile
 * - thresholds: override gating levels for modules
 */

export function useHomesteadVisibility(options = {}) {
  const {
    context = null,
    key = "ssa.homestead.visibility",
    profileOptions = undefined,
    thresholds = undefined,
  } = options;

  const {
    profile,
    patchProfile,
    status: profileStatus,
  } = useHomesteadProfile(profileOptions || {});
  const [state, setState] = useState(() => readVisibilityState(key));

  const thresholdsResolved = useMemo(
    () => ({ ...DEFAULT_THRESHOLDS, ...(thresholds || {}) }),
    [thresholds],
  );

  // Keep state in sync with context (if provided)
  useEffect(() => {
    if (!context) return;
    const ctxMode = context?.mode || context?.plannerMode || null;
    if (ctxMode && ctxMode !== state.mode) {
      setState((prev) => {
        const next = { ...prev, mode: normalizeMode(ctxMode) };
        writeVisibilityState(key, next);
        return next;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context?.mode, context?.plannerMode]);

  // Mirror level from profile (source of truth for "what level did user pick?")
  // but keep enabled separate (user can disable without losing their level).
  const level = useMemo(
    () => clampNumber(profile?.homestead?.level ?? 0, 0, 10),
    [profile],
  );

  // Sync stored level snapshot for UI rendering even before profile loads
  useEffect(() => {
    setState((prev) => {
      if (prev.levelSnapshot === level) return prev;
      const next = { ...prev, levelSnapshot: level };
      writeVisibilityState(key, next);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [level]);

  const enabled = Boolean(state.enabled) && level > 0; // enabled only if user picked a level > 0
  const mode = normalizeMode(
    state.mode || context?.mode || context?.plannerMode,
  );

  // Derived gating flags (deterministic)
  const showHomesteadPlannerUI = enabled && mode === "homestead_planner";
  const showEstimatorPanels =
    enabled && (mode === "homestead_planner" || mode === "meal_planner");
  const showFoodSecurityEstimator = enabled && showEstimatorPanels;
  const showCostDeltaEstimator = enabled && showEstimatorPanels;

  const showGardenModules = enabled && level >= thresholdsResolved.garden;
  const showAnimalModules = enabled && level >= thresholdsResolved.animals;
  const showPreservationModules =
    enabled && level >= thresholdsResolved.preservation;
  const showStorehouseModules =
    enabled && level >= thresholdsResolved.storehouse;

  const showFarmToTablePipeline = enabled; // master "pipeline runs" toggle (UI and estimators rely on it)

  const reason = useMemo(() => {
    if (!level || level <= 0) {
      return "Homesteading is hidden until you choose a starting level. Pick a level to see food security and budget impact estimates.";
    }
    if (!state.enabled) {
      return "Homesteading is turned off. Turn it on to see homestead planning tools and estimates.";
    }
    if (mode !== "homestead_planner" && mode !== "meal_planner") {
      return "Homesteading is on, but the current screen isn’t a planner context. Homestead panels may be hidden to reduce clutter.";
    }
    if (mode === "meal_planner") {
      return "Homesteading is on while you plan meals, so SSA shows food security and budget-impact estimates without overwhelming you with full homestead tooling.";
    }
    return "Homesteading is on. SSA will show tools based on your selected level and the planner context.";
  }, [level, mode, state.enabled]);

  /* ---------------------------------------------------------------------------
     Actions
  --------------------------------------------------------------------------- */

  const persist = useCallback(
    (next) => {
      setState(next);
      writeVisibilityState(key, next);
    },
    [key],
  );

  const setEnabled = useCallback(
    (value) => {
      const v = Boolean(value);
      persist({ ...state, enabled: v, updatedAt: new Date().toISOString() });
    },
    [persist, state],
  );

  const setMode = useCallback(
    (nextMode) => {
      persist({
        ...state,
        mode: normalizeMode(nextMode),
        updatedAt: new Date().toISOString(),
      });
    },
    [persist, state],
  );

  const setLevel = useCallback(
    (n, meta = {}) => {
      const levelNext = clampNumber(n, 0, 10);
      // If they pick a level > 0, enable automatically (they opted in by choosing a level)
      const willEnable = levelNext > 0 ? true : state.enabled;

      persist({
        ...state,
        enabled: willEnable,
        levelSnapshot: levelNext,
        updatedAt: new Date().toISOString(),
      });

      patchProfile(
        {
          homestead: {
            level: levelNext,
            startDate:
              profile?.homestead?.startDate || new Date().toISOString(),
          },
        },
        { action: "set_level", ...meta },
      );
    },
    [persist, patchProfile, profile?.homestead?.startDate, state],
  );

  const enable = useCallback(
    (levelMaybe = null, meta = {}) => {
      const levelNext =
        levelMaybe == null
          ? Math.max(1, level || state.levelSnapshot || 1)
          : clampNumber(levelMaybe, 1, 10);
      persist({
        ...state,
        enabled: true,
        levelSnapshot: levelNext,
        updatedAt: new Date().toISOString(),
      });
      patchProfile(
        {
          homestead: {
            level: levelNext,
            startDate:
              profile?.homestead?.startDate || new Date().toISOString(),
          },
        },
        { action: "enable", ...meta },
      );
    },
    [level, patchProfile, persist, profile?.homestead?.startDate, state],
  );

  const disable = useCallback(
    (meta = {}) => {
      // Disable keeps the level in profile (so they can resume later),
      // but hides the homestead UI.
      persist({
        ...state,
        enabled: false,
        updatedAt: new Date().toISOString(),
      });
      // optional: annotate profile focus flags if you want a "paused" state
      patchProfile(
        {
          homestead: {
            focus: { ...(profile?.homestead?.focus || {}), paused: true },
          },
        },
        { action: "disable", ...meta },
      );
    },
    [patchProfile, persist, profile?.homestead?.focus, state],
  );

  const api = useMemo(
    () => ({
      // raw
      enabled,
      mode,
      level,
      levelSnapshot: state.levelSnapshot,
      thresholds: thresholdsResolved,
      profileStatus,

      // core gates
      showFarmToTablePipeline,
      showHomesteadPlannerUI,
      showEstimatorPanels,
      showFoodSecurityEstimator,
      showCostDeltaEstimator,

      // module gates
      showGardenModules,
      showAnimalModules,
      showPreservationModules,
      showStorehouseModules,

      // UX
      reason,

      // actions
      setEnabled,
      setMode,
      setLevel,
      enable,
      disable,
    }),
    [
      enabled,
      mode,
      level,
      state.levelSnapshot,
      thresholdsResolved,
      profileStatus,
      showFarmToTablePipeline,
      showHomesteadPlannerUI,
      showEstimatorPanels,
      showFoodSecurityEstimator,
      showCostDeltaEstimator,
      showGardenModules,
      showAnimalModules,
      showPreservationModules,
      showStorehouseModules,
      reason,
      setEnabled,
      setMode,
      setLevel,
      enable,
      disable,
    ],
  );

  return api;
}

/* =============================================================================
   Defaults + Helpers
============================================================================= */

const DEFAULT_THRESHOLDS = {
  // You can tune these to match your SSA "homestead levels"
  // 0: off
  // 1: scratch cooking + pantry basics
  // 2: garden basics
  // 3: preservation
  // 4: animals/protein pipeline
  // 5: full storehouse planning + multi-season targets
  garden: 2,
  preservation: 3,
  animals: 4,
  storehouse: 2, // storehouse value begins early
};

function normalizeMode(mode) {
  const m = String(mode || "")
    .toLowerCase()
    .trim();
  if (m.includes("homestead")) return "homestead_planner";
  if (m.includes("meal")) return "meal_planner";
  return m ? m : "unknown";
}

function clampNumber(v, min, max) {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function readVisibilityState(key) {
  // Keep it minimal and resilient.
  const fallback = {
    enabled: false,
    mode: "unknown",
    levelSnapshot: 0,
    updatedAt: new Date(0).toISOString(),
  };

  try {
    const raw = window?.localStorage?.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return fallback;

    return {
      enabled: Boolean(parsed.enabled),
      mode: normalizeMode(parsed.mode),
      levelSnapshot: clampNumber(parsed.levelSnapshot ?? 0, 0, 10),
      updatedAt: parsed.updatedAt
        ? String(parsed.updatedAt)
        : fallback.updatedAt,
    };
  } catch {
    return fallback;
  }
}

function writeVisibilityState(key, state) {
  try {
    const safe = {
      enabled: Boolean(state.enabled),
      mode: normalizeMode(state.mode),
      levelSnapshot: clampNumber(state.levelSnapshot ?? 0, 0, 10),
      updatedAt: state.updatedAt
        ? String(state.updatedAt)
        : new Date().toISOString(),
    };
    window?.localStorage?.setItem(key, JSON.stringify(safe));
  } catch {
    // ignore
  }
}
