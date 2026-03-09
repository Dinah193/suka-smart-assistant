/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\services\homestead\VisibilityRulesEngine.js
//
// VisibilityRulesEngine (deterministic)
// -------------------------------------
// Produces UI-safe, deterministic show/hide decisions for Homestead + FTT + Estimators.
// Inputs:
// - householdId (for loading profile + visibility state)
// - optional overrides (level, unlocked features/domains, etc.)
// Output:
// - decisions: { [key]: { show:boolean, mode:string, reason:string, priority:number } }
// - helpers: .show(key), .mode(key), .reason(key)
// - sections: grouped view for panels/cards
//
// Design principles:
// - Deterministic: no ML/LLM; pure rule evaluation.
// - Stable keys: UI uses stable decision keys to avoid churn.
// - Layered: catalog rules (via HomesteadLevelService) + user "don't show again" state.
// - Fail-safe: if data missing, default to "hide advanced" and "show onboarding basics".
//
// Depends on:
// - HomesteadLevelService (reads level catalog + unlock rules)
// - visibilityState.repo.js (optional; can fall back to db.homestead_visibility_state)
//
// Decision key conventions (examples):
// - "homestead.hero"
// - "homestead.onboarding"
// - "homestead.level_picker"
// - "homestead.estimator.baselines_card"
// - "ftt.targets.summary"
// - "ftt.gaps.panel"
// - "ftt.plan_items.table"
// - "ftt.components.inventory"
// - "ftt.components.batches"
// - "ui.helpers.food_security"
// - "ui.helpers.what_is_ftt"
// - "ui.debug.unlock_state"
//
// You can extend by adding more rules in DEFAULT_RULES below.

import db from "@/services/db";
import HomesteadLevelService from "@/services/homestead/HomesteadLevelService";

// Optional repo import (works without it)
let VisibilityStateRepo = null;
try {
  VisibilityStateRepo = (
    await import("@/services/repos/homestead/visibilityState.repo.js")
  ).default;
} catch {
  VisibilityStateRepo = null;
}

/* -------------------------------------------------------------------------- */
/* Utils                                                                       */
/* -------------------------------------------------------------------------- */

function nowIso() {
  return new Date().toISOString();
}

function safeStr(x, fallback = "") {
  if (x == null) return fallback;
  return String(x);
}

function isPlainObject(x) {
  return Boolean(x && typeof x === "object" && !Array.isArray(x));
}

function bool(x) {
  return Boolean(x === true);
}

function uniq(arr) {
  return Array.from(new Set((arr || []).map(String).filter(Boolean)));
}

function hasTable(name) {
  try {
    void db.table(name);
    return true;
  } catch {
    return false;
  }
}

function stableDecision(show, mode, reason, priority = 50, meta = null) {
  return {
    show: Boolean(show),
    mode: safeStr(mode || "default"),
    reason: safeStr(reason || ""),
    priority: Number.isFinite(Number(priority)) ? Number(priority) : 50,
    meta: meta && isPlainObject(meta) ? meta : undefined,
  };
}

/* -------------------------------------------------------------------------- */
/* Visibility State                                                            */
/* -------------------------------------------------------------------------- */
/**
 * Visibility state is user-driven UI prefs:
 * - dismissedPanels: { [panelKey]: { dismissedAt, reason? } }
 * - collapsedSections: { [sectionKey]: true }
 * - dontShowAgain: { [key]: true } // strongest hide
 *
 * Stored in:
 * - repo (preferred) OR db.homestead_visibility_state
 */
async function loadVisibilityState(householdId) {
  const hId = safeStr(householdId).trim();
  const empty = {
    id: `homestead_visibility_state:${hId || "anonymous"}`,
    householdId: hId || "anonymous",
    dismissedPanels: {},
    collapsedSections: {},
    dontShowAgain: {},
    createdAt: nowIso(),
    updatedAt: nowIso(),
    source: "fallback",
  };

  if (!hId) return empty;

  if (VisibilityStateRepo && typeof VisibilityStateRepo.get === "function") {
    try {
      const row = await VisibilityStateRepo.get(hId);
      if (row && typeof row === "object") {
        return {
          ...empty,
          ...row,
          dismissedPanels: isPlainObject(row.dismissedPanels)
            ? row.dismissedPanels
            : {},
          collapsedSections: isPlainObject(row.collapsedSections)
            ? row.collapsedSections
            : {},
          dontShowAgain: isPlainObject(row.dontShowAgain)
            ? row.dontShowAgain
            : {},
          source: "repo",
        };
      }
    } catch (err) {
      if (import.meta?.env?.DEV)
        console.warn(
          "[VisibilityRulesEngine] visibility repo get failed:",
          err,
        );
    }
  }

  if (hasTable("homestead_visibility_state")) {
    try {
      const byId = await db.homestead_visibility_state.get(
        `homestead_visibility_state:${hId}`,
      );
      const byHousehold = await db.homestead_visibility_state
        .where("householdId")
        .equals(hId)
        .first();
      const row = byId || byHousehold;
      if (row && typeof row === "object") {
        return {
          ...empty,
          ...row,
          dismissedPanels: isPlainObject(row.dismissedPanels)
            ? row.dismissedPanels
            : {},
          collapsedSections: isPlainObject(row.collapsedSections)
            ? row.collapsedSections
            : {},
          dontShowAgain: isPlainObject(row.dontShowAgain)
            ? row.dontShowAgain
            : {},
          source: "db",
        };
      }
    } catch {
      // ignore
    }
  }

  return empty;
}

/* -------------------------------------------------------------------------- */
/* Data availability probes (deterministic, local-first)                        */
/* -------------------------------------------------------------------------- */
/**
 * These probes let UI hide “empty” sections unless onboarding wants them visible.
 * Keep probes CHEAP: use .count() or .where(...).first() minimal queries.
 */
async function probeDataPresence(householdId) {
  const hId = safeStr(householdId).trim();
  const presence = {
    hasBaselines: false,
    hasEstimatorSnapshots: false,
    hasTargets: false,
    hasComponentInventory: false,
    hasComponentBatches: false,
    hasPlans: false,
    hasPlanItems: false,
    hasInventory: false,
    hasStorehouse: false,
  };

  // If no householdId, we can't check - return false everywhere.
  if (!hId) return presence;

  try {
    if (hasTable("estimator_baselines")) {
      const row = await db.estimator_baselines
        .where("householdId")
        .equals(hId)
        .first();
      presence.hasBaselines = Boolean(row);
    }
  } catch {
    // ignore
  }

  try {
    if (hasTable("estimator_snapshots")) {
      const row = await db.estimator_snapshots
        .where("householdId")
        .equals(hId)
        .first();
      presence.hasEstimatorSnapshots = Boolean(row);
    }
  } catch {
    // ignore
  }

  try {
    if (hasTable("ftt_provisioning_targets")) {
      const row = await db.ftt_provisioning_targets
        .where("householdId")
        .equals(hId)
        .first();
      presence.hasTargets = Boolean(row);
    }
  } catch {
    // ignore
  }

  try {
    if (hasTable("ftt_component_inventory")) {
      const row = await db.ftt_component_inventory
        .where("householdId")
        .equals(hId)
        .first();
      presence.hasComponentInventory = Boolean(row);
    }
  } catch {
    // ignore
  }

  try {
    if (hasTable("ftt_component_batches")) {
      const row = await db.ftt_component_batches
        .where("householdId")
        .equals(hId)
        .first();
      presence.hasComponentBatches = Boolean(row);
    }
  } catch {
    // ignore
  }

  try {
    if (hasTable("ftt_plans")) {
      const row = await db.ftt_plans.where("householdId").equals(hId).first();
      presence.hasPlans = Boolean(row);
    }
  } catch {
    // ignore
  }

  try {
    if (hasTable("ftt_plan_items")) {
      const row = await db.ftt_plan_items
        .where("householdId")
        .equals(hId)
        .first();
      presence.hasPlanItems = Boolean(row);
    }
  } catch {
    // ignore
  }

  try {
    if (hasTable("inventory")) {
      const count = await db.inventory.count();
      presence.hasInventory = count > 0;
    }
  } catch {
    // ignore
  }

  try {
    if (hasTable("storehouse")) {
      const count = await db.storehouse.count();
      presence.hasStorehouse = count > 0;
    }
  } catch {
    // ignore
  }

  return presence;
}

/* -------------------------------------------------------------------------- */
/* Rule model                                                                  */
/* -------------------------------------------------------------------------- */
/**
 * Rule contract:
 * {
 *   key: string,
 *   priority: number (higher wins),
 *   when: (ctx) => boolean,
 *   decide: (ctx) => Decision
 * }
 *
 * We apply:
 * - global hard hides (dontShowAgain)
 * - evaluate all matching rules for key
 * - choose highest priority decision
 * - if no rule matches, use default fallback
 */

const DEFAULT_FALLBACK_DECISION = stableDecision(
  false,
  "hidden",
  "No rule matched",
  0,
);

/**
 * Deterministic helpers for matching.
 */
function rankAtLeast(ctx, minRank) {
  return Number(ctx.levelRank || 0) >= Number(minRank || 0);
}

function featureOn(ctx, featureKey) {
  return Boolean(ctx.unlock?.features?.[featureKey] === true);
}

function domainOn(ctx, domainKey) {
  return Boolean(ctx.unlock?.domains?.[domainKey] === true);
}

function notDismissed(ctx, key) {
  // dontShowAgain is stronger than dismissedPanels
  if (ctx.visibility?.dontShowAgain?.[key] === true) return false;
  if (ctx.visibility?.dismissedPanels?.[key]) return false;
  return true;
}

function allowEmptyIfOnboarding(ctx) {
  return Boolean(ctx.onboardingMode === true);
}

/* -------------------------------------------------------------------------- */
/* Rules                                                                       */
/* -------------------------------------------------------------------------- */
/**
 * Keys are stable and UI-facing.
 * You can add more keys without breaking older UI by just not using them yet.
 */
const RULES = [
  // --- Homestead main ---
  {
    key: "homestead.hero",
    priority: 90,
    when: (ctx) => true,
    decide: (ctx) =>
      stableDecision(true, "hero", "Always show homestead hero", 90, {
        level: ctx.levelKey,
        levelLabel: ctx.levelLabel,
      }),
  },
  {
    key: "homestead.level_picker",
    priority: 90,
    when: (ctx) => true,
    decide: () =>
      stableDecision(true, "control", "Always allow level selection", 90),
  },
  {
    key: "homestead.onboarding",
    priority: 80,
    when: (ctx) => ctx.levelRank <= 2,
    decide: (ctx) => {
      if (!notDismissed(ctx, "homestead.onboarding")) {
        return stableDecision(false, "hidden", "User dismissed onboarding", 80);
      }
      return stableDecision(
        true,
        "panel",
        "Show onboarding for Pantry/Scratch levels",
        80,
      );
    },
  },

  // --- Estimator ---
  {
    key: "homestead.estimator.baselines_card",
    priority: 85,
    when: (ctx) => featureOn(ctx, "baselines") || featureOn(ctx, "estimator"),
    decide: (ctx) => {
      if (!notDismissed(ctx, "homestead.estimator.baselines_card")) {
        return stableDecision(false, "hidden", "Dismissed by user", 85);
      }

      // If baselines exist, show as "summary"; else show as "action required"
      if (ctx.presence.hasBaselines) {
        return stableDecision(true, "summary", "Baselines exist", 85);
      }
      // Show even if empty when onboarding is on
      if (allowEmptyIfOnboarding(ctx)) {
        return stableDecision(
          true,
          "required",
          "Need baselines (onboarding)",
          85,
        );
      }
      // Otherwise show for Pantry/Scratch/Homestead+ because it's critical
      return stableDecision(
        true,
        "required",
        "Need baselines to compute savings",
        85,
      );
    },
  },
  {
    key: "homestead.estimator.snapshots_card",
    priority: 80,
    when: (ctx) => featureOn(ctx, "estimator") || featureOn(ctx, "baselines"),
    decide: (ctx) => {
      if (!notDismissed(ctx, "homestead.estimator.snapshots_card")) {
        return stableDecision(false, "hidden", "Dismissed by user", 80);
      }
      if (ctx.presence.hasEstimatorSnapshots) {
        return stableDecision(true, "chart", "Snapshots exist", 80);
      }
      if (allowEmptyIfOnboarding(ctx) && ctx.presence.hasBaselines) {
        return stableDecision(
          true,
          "empty",
          "No snapshots yet; show empty state",
          80,
        );
      }
      // Hide if no snapshots and not onboarding
      return stableDecision(false, "hidden", "No estimator snapshots yet", 10);
    },
  },

  // --- Farm-to-table Targets ---
  {
    key: "ftt.targets.summary",
    priority: 85,
    when: (ctx) => featureOn(ctx, "targets") && domainOn(ctx, "farm_to_table"),
    decide: (ctx) => {
      if (!notDismissed(ctx, "ftt.targets.summary")) {
        return stableDecision(false, "hidden", "Dismissed by user", 85);
      }
      if (ctx.presence.hasTargets)
        return stableDecision(true, "summary", "Targets exist", 85);

      if (allowEmptyIfOnboarding(ctx)) {
        return stableDecision(
          true,
          "empty",
          "No targets yet; show empty state",
          60,
        );
      }
      // Show action required at Pantry+ because targets are central to food security view
      return stableDecision(
        true,
        "required",
        "Run targets to see food security",
        70,
      );
    },
  },

  // --- Components Inventory (Scratch+) ---
  {
    key: "ftt.components.inventory",
    priority: 75,
    when: (ctx) =>
      featureOn(ctx, "components") && domainOn(ctx, "farm_to_table"),
    decide: (ctx) => {
      if (!rankAtLeast(ctx, 2)) {
        return stableDecision(
          false,
          "hidden",
          "Components start at Scratch level",
          75,
        );
      }
      if (!notDismissed(ctx, "ftt.components.inventory")) {
        return stableDecision(false, "hidden", "Dismissed by user", 75);
      }
      if (ctx.presence.hasComponentInventory) {
        return stableDecision(true, "table", "Component inventory exists", 75);
      }
      if (allowEmptyIfOnboarding(ctx)) {
        return stableDecision(true, "empty", "No component inventory yet", 40);
      }
      // Hide by default if empty to avoid overwhelming users; targets already cover essentials
      return stableDecision(
        false,
        "hidden",
        "No component inventory; hidden to reduce clutter",
        20,
      );
    },
  },

  // --- Component Batches (Scratch+) ---
  {
    key: "ftt.components.batches",
    priority: 75,
    when: (ctx) => featureOn(ctx, "batches") && domainOn(ctx, "farm_to_table"),
    decide: (ctx) => {
      if (!rankAtLeast(ctx, 2)) {
        return stableDecision(
          false,
          "hidden",
          "Batches start at Scratch level",
          75,
        );
      }
      if (!notDismissed(ctx, "ftt.components.batches")) {
        return stableDecision(false, "hidden", "Dismissed by user", 75);
      }
      if (ctx.presence.hasComponentBatches) {
        return stableDecision(true, "timeline", "Batches exist", 75);
      }
      if (allowEmptyIfOnboarding(ctx)) {
        return stableDecision(true, "empty", "No batches yet", 35);
      }
      // Show a simple CTA at Scratch level if they have targets but no batches
      if (ctx.levelRank === 2 && ctx.presence.hasTargets) {
        return stableDecision(
          true,
          "cta",
          "Start first batch to close gaps",
          55,
        );
      }
      return stableDecision(false, "hidden", "No batches yet", 15);
    },
  },

  // --- Gaps panel (Scratch+) ---
  {
    key: "ftt.gaps.panel",
    priority: 70,
    when: (ctx) => featureOn(ctx, "gaps") && domainOn(ctx, "farm_to_table"),
    decide: (ctx) => {
      if (!rankAtLeast(ctx, 2))
        return stableDecision(false, "hidden", "Gaps start at Scratch", 70);
      if (!notDismissed(ctx, "ftt.gaps.panel"))
        return stableDecision(false, "hidden", "Dismissed", 70);

      // If no targets, gaps aren't meaningful
      if (!ctx.presence.hasTargets) {
        return allowEmptyIfOnboarding(ctx)
          ? stableDecision(true, "empty", "Run targets to see gaps", 40)
          : stableDecision(false, "hidden", "No targets; gaps hidden", 20);
      }
      return stableDecision(true, "panel", "Show gaps once targets exist", 70);
    },
  },

  // --- Sourcing panel (Scratch+) ---
  {
    key: "ftt.sourcing.panel",
    priority: 65,
    when: (ctx) => featureOn(ctx, "sourcing") && domainOn(ctx, "farm_to_table"),
    decide: (ctx) => {
      if (!rankAtLeast(ctx, 2))
        return stableDecision(
          false,
          "hidden",
          "Sourcing starts at Scratch",
          65,
        );
      if (!notDismissed(ctx, "ftt.sourcing.panel"))
        return stableDecision(false, "hidden", "Dismissed", 65);

      if (!ctx.presence.hasTargets) {
        return allowEmptyIfOnboarding(ctx)
          ? stableDecision(true, "empty", "Need targets before sourcing", 35)
          : stableDecision(false, "hidden", "No targets", 15);
      }
      return stableDecision(
        true,
        "panel",
        "Show sourcing suggestions after targets",
        65,
      );
    },
  },

  // --- Plans (Homestead+) ---
  {
    key: "ftt.plans.list",
    priority: 80,
    when: (ctx) => featureOn(ctx, "plans") && domainOn(ctx, "farm_to_table"),
    decide: (ctx) => {
      if (!rankAtLeast(ctx, 3))
        return stableDecision(false, "hidden", "Plans start at Homestead", 80);
      if (!notDismissed(ctx, "ftt.plans.list"))
        return stableDecision(false, "hidden", "Dismissed", 80);

      if (ctx.presence.hasPlans)
        return stableDecision(true, "list", "Plans exist", 80);

      // Even if empty, show CTA at Homestead+ because this is the key workflow
      return stableDecision(true, "cta", "No plans yet; create first plan", 70);
    },
  },

  // --- Plan Items (Homestead+) ---
  {
    key: "ftt.plan_items.table",
    priority: 75,
    when: (ctx) =>
      featureOn(ctx, "plan_items") && domainOn(ctx, "farm_to_table"),
    decide: (ctx) => {
      if (!rankAtLeast(ctx, 3))
        return stableDecision(
          false,
          "hidden",
          "Plan items start at Homestead",
          75,
        );
      if (!notDismissed(ctx, "ftt.plan_items.table"))
        return stableDecision(false, "hidden", "Dismissed", 75);

      if (ctx.presence.hasPlanItems)
        return stableDecision(true, "table", "Plan items exist", 75);

      // If plans exist but items missing, show debug/empty state
      if (ctx.presence.hasPlans)
        return stableDecision(true, "empty", "No plan items found", 40);

      return allowEmptyIfOnboarding(ctx)
        ? stableDecision(true, "empty", "No plans/items yet", 30)
        : stableDecision(false, "hidden", "No plan items yet", 20);
    },
  },

  // --- Helpers ---
  {
    key: "ui.helpers.food_security",
    priority: 60,
    when: (ctx) =>
      featureOn(ctx, "estimator") ||
      featureOn(ctx, "baselines") ||
      featureOn(ctx, "targets"),
    decide: (ctx) => {
      if (!notDismissed(ctx, "ui.helpers.food_security"))
        return stableDecision(false, "hidden", "Dismissed", 60);
      // show at Pantry+ (levelRank>=1)
      if (ctx.levelRank >= 1)
        return stableDecision(
          true,
          "helper",
          "Explain food security metric",
          60,
        );
      return stableDecision(false, "hidden", "Homestead off", 10);
    },
  },
  {
    key: "ui.helpers.what_is_ftt",
    priority: 55,
    when: (ctx) => domainOn(ctx, "farm_to_table"),
    decide: (ctx) => {
      if (!notDismissed(ctx, "ui.helpers.what_is_ftt"))
        return stableDecision(false, "hidden", "Dismissed", 55);
      // show at Pantry/Scratch only to reduce noise later
      if (ctx.levelRank <= 2)
        return stableDecision(
          true,
          "helper",
          "Explain farm-to-table pipeline",
          55,
        );
      return stableDecision(false, "hidden", "Not needed at this level", 15);
    },
  },

  // --- Debug unlock state (Village/DEV only) ---
  {
    key: "ui.debug.unlock_state",
    priority: 95,
    when: (ctx) => Boolean(import.meta?.env?.DEV) || ctx.levelRank >= 4,
    decide: (ctx) =>
      stableDecision(true, "debug", "Show debug unlock state", 95),
  },
];

/* -------------------------------------------------------------------------- */
/* Engine                                                                      */
/* -------------------------------------------------------------------------- */

function groupDecisions(decisions) {
  // Groups are a convenience for UI layouts; stable keys still drive rendering.
  const sections = {
    homestead: [],
    estimator: [],
    ftt_targets: [],
    ftt_components: [],
    ftt_plans: [],
    helpers: [],
    debug: [],
    other: [],
  };

  for (const [key, d] of Object.entries(decisions || {})) {
    const entry = { key, ...d };

    if (key.startsWith("homestead.")) sections.homestead.push(entry);
    else if (key.startsWith("homestead.estimator."))
      sections.estimator.push(entry);
    else if (key.startsWith("ftt.targets")) sections.ftt_targets.push(entry);
    else if (key.startsWith("ftt.components"))
      sections.ftt_components.push(entry);
    else if (key.startsWith("ftt.plans") || key.startsWith("ftt.plan_items"))
      sections.ftt_plans.push(entry);
    else if (key.startsWith("ui.helpers.")) sections.helpers.push(entry);
    else if (key.startsWith("ui.debug.")) sections.debug.push(entry);
    else sections.other.push(entry);
  }

  // Sort by priority desc then key asc (deterministic)
  for (const k of Object.keys(sections)) {
    sections[k].sort((a, b) => {
      const dp = (b.priority || 0) - (a.priority || 0);
      if (dp !== 0) return dp;
      return String(a.key).localeCompare(String(b.key));
    });
  }

  return sections;
}

/**
 * Compute deterministic visibility decisions for Homestead UI.
 *
 * @param {object} params
 * @param {string} params.householdId
 * @param {boolean} [params.onboardingMode] If true, show empty states more.
 * @param {object} [params.profileOverride] Optional override profile (rare)
 * @param {string|number} [params.levelOverride] Override level (e.g. preview)
 * @param {object} [params.unlockOverride] Optional override {features, domains} (rare)
 * @param {object} [params.presenceOverride] Optional override presence flags (testing)
 * @param {string[]} [params.keys] If provided, only compute these decision keys.
 *
 * @returns {Promise<object>}
 */
export async function computeVisibility(params = {}) {
  const householdId = safeStr(params.householdId).trim();

  // 1) Load gate map (level + unlock rules)
  let gate = null;
  try {
    // If caller provides unlockOverride, we still want profile/level meta
    if (params.levelOverride != null || isPlainObject(params.profileOverride)) {
      const level = params.levelOverride ?? params.profileOverride?.level;
      const levelKey = HomesteadLevelService.normalizeHomesteadLevel(level);
      const levelMeta = HomesteadLevelService.getLevelMeta(levelKey);
      gate = {
        level: levelKey,
        levelRank: levelMeta.rank,
        levelLabel: levelMeta.label,
        detailMode: HomesteadLevelService.defaultDetailMode(levelKey),
        enabledDomains: HomesteadLevelService.getEnabledDomains({
          profile: params.profileOverride || { level: levelKey },
          level: levelKey,
        }),
        domains: {},
        features: {},
        lockedReasons: { features: {}, domains: {} },
      };

      // Default domains/features from levelAllows + enabledDomains
      const enabled = new Set(gate.enabledDomains);
      for (const d of HomesteadLevelService.DOMAIN_KEYS)
        gate.domains[d] = enabled.has(d);

      // Feature gates: we don't have direct catalog map here; rely on service call via getUiGateMap if possible.
      // We'll attempt to get full gate map if householdId provided; otherwise use levelAllows heuristics.
      if (householdId) {
        gate = await HomesteadLevelService.getUiGateMap(householdId, {
          profile: params.profileOverride,
          fallbackLevel: levelKey,
        });
      } else {
        const featureKeys = [
          "baselines",
          "estimator",
          "targets",
          "components",
          "batches",
          "gaps",
          "sourcing",
          "plans",
          "plan_items",
        ];
        for (const fk of featureKeys)
          gate.features[fk] = HomesteadLevelService.levelAllows(levelKey, fk);
      }
    } else {
      gate = await HomesteadLevelService.getUiGateMap(householdId);
    }
  } catch (err) {
    if (import.meta?.env?.DEV)
      console.warn(
        "[VisibilityRulesEngine] getUiGateMap failed; fallback:",
        err,
      );
    const levelKey = HomesteadLevelService.DEFAULT_LEVEL;
    const levelMeta = HomesteadLevelService.getLevelMeta(levelKey);
    gate = {
      level: levelKey,
      levelRank: levelMeta.rank,
      levelLabel: levelMeta.label,
      detailMode: HomesteadLevelService.defaultDetailMode(levelKey),
      enabledDomains: HomesteadLevelService.getEnabledDomains({
        profile: { level: levelKey },
        level: levelKey,
      }),
      domains: {},
      features: {},
      lockedReasons: { features: {}, domains: {} },
    };
    const enabled = new Set(gate.enabledDomains);
    for (const d of HomesteadLevelService.DOMAIN_KEYS)
      gate.domains[d] = enabled.has(d);
    // conservative features
    for (const fk of Object.keys(gate.features)) gate.features[fk] = false;
  }

  // Apply unlockOverride if provided
  if (isPlainObject(params.unlockOverride)) {
    if (isPlainObject(params.unlockOverride.domains))
      gate.domains = { ...gate.domains, ...params.unlockOverride.domains };
    if (isPlainObject(params.unlockOverride.features))
      gate.features = { ...gate.features, ...params.unlockOverride.features };
  }

  // 2) Load visibility state (dismissed + dontShowAgain)
  const visibility = await loadVisibilityState(householdId);

  // 3) Probe data presence (cheap)
  const presence = isPlainObject(params.presenceOverride)
    ? { ...(await probeDataPresence(householdId)), ...params.presenceOverride }
    : await probeDataPresence(householdId);

  // 4) Build evaluation context
  const ctx = {
    householdId: householdId || "anonymous",
    onboardingMode: bool(params.onboardingMode),
    levelKey: gate.level,
    levelRank: gate.levelRank,
    levelLabel: gate.levelLabel,
    detailMode: gate.detailMode,
    unlock: {
      features: gate.features || {},
      domains: gate.domains || {},
      lockedReasons: gate.lockedReasons || { features: {}, domains: {} },
    },
    visibility,
    presence,
    ts: nowIso(),
  };

  // 5) Evaluate rules
  const wantedKeys =
    Array.isArray(params.keys) && params.keys.length
      ? new Set(params.keys.map(String))
      : null;

  const decisions = {};
  const matchesByKey = {};

  for (const rule of RULES) {
    if (!rule || typeof rule !== "object") continue;
    const key = safeStr(rule.key).trim();
    if (!key) continue;
    if (wantedKeys && !wantedKeys.has(key)) continue;

    // Hard hide if dontShowAgain (unless key is forced-critical)
    const hardHidden = ctx.visibility?.dontShowAgain?.[key] === true;
    const isCritical =
      key === "homestead.hero" || key === "homestead.level_picker";
    if (hardHidden && !isCritical) {
      // we still record, but with top priority so nothing overrides
      decisions[key] = stableDecision(false, "hidden", "dontShowAgain", 100);
      continue;
    }

    let ok = false;
    try {
      ok = typeof rule.when === "function" ? Boolean(rule.when(ctx)) : false;
    } catch (err) {
      ok = false;
      if (import.meta?.env?.DEV)
        console.warn("[VisibilityRulesEngine] rule.when failed:", key, err);
    }
    if (!ok) continue;

    let decision = null;
    try {
      decision = typeof rule.decide === "function" ? rule.decide(ctx) : null;
    } catch (err) {
      decision = null;
      if (import.meta?.env?.DEV)
        console.warn("[VisibilityRulesEngine] rule.decide failed:", key, err);
    }
    if (!decision) continue;

    const normalized = stableDecision(
      decision.show,
      decision.mode,
      decision.reason,
      decision.priority,
      decision.meta,
    );

    if (!matchesByKey[key]) matchesByKey[key] = [];
    matchesByKey[key].push(normalized);
  }

  // Choose winning decision per key
  const allKeys = wantedKeys
    ? Array.from(wantedKeys)
    : uniq(RULES.map((r) => r.key));

  for (const key of allKeys) {
    // If already set by dontShowAgain hard hide, keep it.
    if (decisions[key]) continue;

    const candidates = matchesByKey[key] || [];
    if (!candidates.length) {
      decisions[key] = {
        ...DEFAULT_FALLBACK_DECISION,
        reason: `No rule matched for ${key}`,
      };
      continue;
    }
    candidates.sort((a, b) => {
      const dp = (b.priority || 0) - (a.priority || 0);
      if (dp !== 0) return dp;
      // deterministic tiebreaker: show wins over hide if same priority
      const ds = Number(Boolean(b.show)) - Number(Boolean(a.show));
      if (ds !== 0) return ds;
      return String(a.mode).localeCompare(String(b.mode));
    });
    decisions[key] = candidates[0];
  }

  // 6) Build helpers + sections
  const sections = groupDecisions(decisions);

  const api = {
    ctx,
    decisions,
    sections,
    show: (key) => Boolean(decisions?.[key]?.show),
    mode: (key) => decisions?.[key]?.mode || "default",
    reason: (key) => decisions?.[key]?.reason || "",
    decision: (key) => decisions?.[key] || DEFAULT_FALLBACK_DECISION,
  };

  return api;
}

/* -------------------------------------------------------------------------- */
/* Convenience wrappers                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Lightweight call: return just decisions (no ctx noise) for most UIs.
 */
export async function getVisibilityDecisions(householdId, opts = {}) {
  const res = await computeVisibility({ householdId, ...opts });
  return res.decisions;
}

/**
 * UI-safe summaries for a panel list: only show=true decisions sorted by priority.
 */
export async function listVisiblePanels(householdId, opts = {}) {
  const res = await computeVisibility({ householdId, ...opts });
  const list = Object.entries(res.decisions)
    .map(([key, d]) => ({ key, ...d }))
    .filter((x) => x.show)
    .sort(
      (a, b) =>
        (b.priority || 0) - (a.priority || 0) ||
        String(a.key).localeCompare(String(b.key)),
    );
  return list;
}

/* -------------------------------------------------------------------------- */
/* Default export                                                              */
/* -------------------------------------------------------------------------- */

const VisibilityRulesEngine = {
  computeVisibility,
  getVisibilityDecisions,
  listVisiblePanels,
};

export default VisibilityRulesEngine;
