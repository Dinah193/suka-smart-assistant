// C:\Users\larho\suka-smart-assistant\src\hooks\homestead\useHomesteadLevel.js

import { useCallback, useMemo } from "react";
import { useHomesteadProfile } from "./useHomesteadProfile";
import { useHomesteadVisibility } from "./useHomesteadVisibility";

/**
 * useHomesteadLevel
 * -----------------------------------------------------------------------------
 * Single source of truth for:
 * - Homestead level value (0..10)
 * - Level definitions (plain-language labels + what unlocks)
 * - Level setters that keep Profile + Visibility aligned
 *
 * Why this exists:
 * - Profile stores the level as household preference (data).
 * - Visibility stores whether homestead UI is currently enabled (presentation).
 * - This hook provides one consistent API so UI components don’t duplicate logic.
 *
 * API:
 * const lvl = useHomesteadLevel({ context, profileOptions, visibilityOptions, levels, min, max });
 *
 * lvl.level                  // number (0..max)
 * lvl.enabled                // boolean (homestead UI enabled + level > 0)
 * lvl.mode                   // "homestead_planner" | "meal_planner" | "unknown"
 * lvl.current                // resolved level object (definition)
 * lvl.levels                 // array of level objects
 * lvl.byId                   // map: id -> level object
 * lvl.next / lvl.prev        // adjacent level objects or null
 * lvl.progress               // 0..1 across min..max
 * lvl.setLevel(n)            // sets level (auto-enables if n>0)
 * lvl.enable(level?)         // enable homesteading (defaults to >=1)
 * lvl.disable()              // disable UI (does not erase chosen level)
 * lvl.stepUp() / stepDown()  // move between defined levels
 * lvl.summary                // plain-language “what this means”
 * lvl.unlocks                // derived gates from visibility hook
 */

export function useHomesteadLevel(options = {}) {
  const {
    context = null,
    profileOptions = undefined,
    visibilityOptions = undefined,
    levels = DEFAULT_LEVELS,
    min = 0,
    max = 5, // SSA default “0–5” ladder; you can expand to 10 if desired
  } = options;

  const prof = useHomesteadProfile(profileOptions || {});
  const vis = useHomesteadVisibility({
    context,
    ...(visibilityOptions || {}),
    profileOptions:
      profileOptions ||
      (visibilityOptions ? visibilityOptions.profileOptions : undefined),
  });

  const levelValue = useMemo(
    () =>
      clampNumber(prof.profile?.homestead?.level ?? 0, min, Math.max(max, min)),
    [prof.profile, min, max],
  );

  const levelDefs = useMemo(
    () => normalizeLevels(levels, { min, max }),
    [levels, min, max],
  );

  const byId = useMemo(() => {
    const m = new Map();
    for (const l of levelDefs) m.set(l.id, l);
    return m;
  }, [levelDefs]);

  const current = useMemo(() => {
    return resolveLevel(levelDefs, levelValue, { min, max });
  }, [levelDefs, levelValue, min, max]);

  const idx = useMemo(
    () => levelDefs.findIndex((l) => l.value === current.value),
    [levelDefs, current.value],
  );

  const prev = useMemo(
    () => (idx > 0 ? levelDefs[idx - 1] : null),
    [idx, levelDefs],
  );
  const next = useMemo(
    () => (idx >= 0 && idx < levelDefs.length - 1 ? levelDefs[idx + 1] : null),
    [idx, levelDefs],
  );

  const progress = useMemo(() => {
    const denom = Math.max(1, max - min);
    return clamp01((levelValue - min) / denom);
  }, [levelValue, min, max]);

  const setLevel = useCallback(
    (n, meta = {}) => {
      // Delegate to visibility setter, which also patches profile.
      vis.setLevel(n, meta);
    },
    [vis],
  );

  const enable = useCallback(
    (n = null, meta = {}) => {
      vis.enable(n, meta);
    },
    [vis],
  );

  const disable = useCallback(
    (meta = {}) => {
      vis.disable(meta);
    },
    [vis],
  );

  const stepUp = useCallback(
    (meta = {}) => {
      const target = next ? next.value : current.value;
      setLevel(target, { action: "step_up", ...meta });
    },
    [current.value, next, setLevel],
  );

  const stepDown = useCallback(
    (meta = {}) => {
      const target = prev ? prev.value : current.value;
      setLevel(target, { action: "step_down", ...meta });
    },
    [current.value, prev, setLevel],
  );

  const summary = useMemo(() => {
    // Keep this extremely plain language for UI display.
    if (!vis.enabled || levelValue <= 0) {
      return "Homesteading is currently off. Choose a starting level to see food security and budget impact estimates.";
    }
    if (vis.mode === "meal_planner") {
      return `Homesteading is on at level ${current.value}: ${current.label}. While planning meals, SSA will show simple estimates (food security + cost impact) without showing every homestead module.`;
    }
    if (vis.mode === "homestead_planner") {
      return `Homesteading is on at level ${current.value}: ${current.label}. SSA will show tools and estimates that match this level.`;
    }
    return `Homesteading is on at level ${current.value}: ${current.label}.`;
  }, [vis.enabled, vis.mode, levelValue, current.value, current.label]);

  const unlocks = useMemo(
    () => ({
      showFarmToTablePipeline: vis.showFarmToTablePipeline,
      showHomesteadPlannerUI: vis.showHomesteadPlannerUI,
      showEstimatorPanels: vis.showEstimatorPanels,
      showFoodSecurityEstimator: vis.showFoodSecurityEstimator,
      showCostDeltaEstimator: vis.showCostDeltaEstimator,
      showGardenModules: vis.showGardenModules,
      showAnimalModules: vis.showAnimalModules,
      showPreservationModules: vis.showPreservationModules,
      showStorehouseModules: vis.showStorehouseModules,
      reason: vis.reason,
    }),
    [vis],
  );

  return useMemo(
    () => ({
      // state
      level: levelValue,
      enabled: vis.enabled,
      mode: vis.mode,

      // definitions
      current,
      levels: levelDefs,
      byId,

      // navigation
      prev,
      next,
      progress,

      // actions
      setLevel,
      enable,
      disable,
      stepUp,
      stepDown,

      // ux helpers
      summary,
      unlocks,

      // low-level access if needed
      profile: prof.profile,
      profileStatus: prof.status,
      visibility: vis,
    }),
    [
      levelValue,
      vis.enabled,
      vis.mode,
      current,
      levelDefs,
      byId,
      prev,
      next,
      progress,
      setLevel,
      enable,
      disable,
      stepUp,
      stepDown,
      summary,
      unlocks,
      prof.profile,
      prof.status,
      vis,
    ],
  );
}

/* =============================================================================
   Default Level Definitions
============================================================================= */

/**
 * DEFAULT_LEVELS (0–5) — tuned for SSA’s “Homestead Planner” story:
 * - keep the ladder simple and non-overwhelming
 * - unlock modules in a predictable order
 *
 * You can extend to 0–10 later; the hook supports it as long as values exist.
 */
export const DEFAULT_LEVELS = [
  {
    id: "homestead.level.0",
    value: 0,
    label: "Off / Not homesteading yet",
    short: "Off",
    description:
      "No homestead planning tools are shown. SSA can still do normal meal planning, but food security and homestead savings estimates stay hidden until you opt in.",
    includes: ["meal_planning"],
    unlocks: [],
    tips: [
      "Choose level 1 when you want SSA to estimate food security and budget impact from scratch cooking.",
    ],
  },
  {
    id: "homestead.level.1",
    value: 1,
    label: "Scratch cooking starter",
    short: "Scratch",
    description:
      "You’re starting by cooking more at home. SSA shows food security and budget impact estimates using pantry + meal plan + defaults.",
    includes: ["scratch_cooking", "pantry_basics", "batch_cooking"],
    unlocks: [
      "estimators.food_security",
      "estimators.cost_delta",
      "storehouse.basics",
    ],
    tips: [
      "Track pantry basics to tighten estimates.",
      "Add 5–10 baseline recipes and repeat them weekly.",
    ],
  },
  {
    id: "homestead.level.2",
    value: 2,
    label: "Garden basics + storehouse rhythm",
    short: "Garden",
    description:
      "You’re adding a garden plan. SSA starts translating meals into growing targets and storehouse refill rhythms.",
    includes: ["garden_planning", "seasonal_targets", "storehouse.rotation"],
    unlocks: ["garden.modules", "storehouse.modules"],
    tips: [
      "Start with a small list of high-impact crops.",
      "Log harvests so SSA can reduce grocery targets.",
    ],
  },
  {
    id: "homestead.level.3",
    value: 3,
    label: "Preservation & pantry depth",
    short: "Preserve",
    description:
      "You’re preserving food (freezing, dehydrating, fermenting, canning). SSA begins tracking how preservation increases coverage days.",
    includes: [
      "preservation",
      "freezing",
      "dehydrating",
      "fermenting",
      "canning",
    ],
    unlocks: ["preservation.modules"],
    tips: [
      "Preserve what you already eat regularly.",
      "Label + log preserved quantities for accurate coverage.",
    ],
  },
  {
    id: "homestead.level.4",
    value: 4,
    label: "Protein pipeline (animals / butchery)",
    short: "Animals",
    description:
      "You’re adding a protein pipeline (animals, hunting/fishing, or bulk buys). SSA connects butchery cuts to inventory and meal planning.",
    includes: ["animals", "butchery", "protein_planning"],
    unlocks: ["animals.modules"],
    tips: [
      "Start with one dependable protein source.",
      "Standardize a cut sheet so inventory stays clean.",
    ],
  },
  {
    id: "homestead.level.5",
    value: 5,
    label: "Full homestead system (multi-season)",
    short: "Full",
    description:
      "You’re planning multi-season food security. SSA ties meals ↔ storehouse ↔ garden ↔ animals ↔ preservation into a single pipeline.",
    includes: ["multi_season_planning", "redundancy", "deep_storehouse"],
    unlocks: ["homestead.full_pipeline"],
    tips: [
      "Audit monthly: what you used vs. what you produced.",
      "Build a “minimum viable storehouse” list and maintain it.",
    ],
  },
];

/* =============================================================================
   Helpers
============================================================================= */

function normalizeLevels(levels, { min, max }) {
  const arr = Array.isArray(levels) ? levels : [];
  const clean = [];

  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;

    const v = clampNumber(raw.value, min, max);
    const id =
      typeof raw.id === "string" && raw.id.trim()
        ? raw.id.trim()
        : `homestead.level.${v}`;
    const label =
      typeof raw.label === "string" && raw.label.trim()
        ? raw.label.trim()
        : `Level ${v}`;
    const short =
      typeof raw.short === "string" && raw.short.trim()
        ? raw.short.trim()
        : label;
    const description =
      typeof raw.description === "string" ? raw.description : "";
    const includes = arrayify(raw.includes);
    const unlocks = arrayify(raw.unlocks);
    const tips = arrayify(raw.tips);

    clean.push({
      ...raw,
      id,
      value: v,
      label,
      short,
      description,
      includes,
      unlocks,
      tips,
    });
  }

  // Ensure uniqueness by value; keep first occurrence
  const seen = new Set();
  const uniq = [];
  for (const l of clean.sort((a, b) => a.value - b.value)) {
    if (seen.has(l.value)) continue;
    seen.add(l.value);
    uniq.push(l);
  }

  // Ensure we at least have min and max representation if caller gave sparse defs
  // (Only if no levels passed or extremely sparse)
  if (!uniq.length) {
    return DEFAULT_LEVELS.filter((l) => l.value >= min && l.value <= max);
  }

  return uniq;
}

function resolveLevel(levelDefs, value, { min, max }) {
  const v = clampNumber(value, min, max);
  const exact = levelDefs.find((l) => l.value === v);
  if (exact) return exact;

  // If missing exact, choose nearest lower; else nearest higher; else fallback first.
  const sorted = [...levelDefs].sort((a, b) => a.value - b.value);
  let lower = null;
  for (const l of sorted) {
    if (l.value <= v) lower = l;
    if (l.value > v) break;
  }
  if (lower) return lower;

  const higher = sorted.find((l) => l.value >= v);
  return (
    higher ||
    sorted[0] || {
      id: `homestead.level.${v}`,
      value: v,
      label: `Level ${v}`,
      short: `Level ${v}`,
    }
  );
}

function clampNumber(v, min, max) {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function clamp01(x) {
  const n = typeof x === "number" ? x : Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function arrayify(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.filter((x) => x != null).map(String);
  return [String(v)];
}
