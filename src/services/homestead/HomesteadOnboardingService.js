/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\services\homestead\HomesteadOnboardingService.js
//
// HomesteadOnboardingService
// --------------------------
// Deterministic onboarding: level selection + first-run guidance for Homestead Planner.
//
// Responsibilities:
// 1) Determine if this household is "first-run" for homestead onboarding.
// 2) Provide a guided, level-aware onboarding plan (cards/steps/checklist).
// 3) Persist user choices (level selection + accepted steps + dismissals).
// 4) Bridge to VisibilityRulesEngine via homestead_visibility_state "dontShowAgain"/dismissedPanels.
//
// Dependencies (local-first):
// - db tables (from your db.js updates):
//   - homestead_profile
//   - homestead_visibility_state
//   - estimator_baselines
//   - estimator_snapshots
//   - ftt_provisioning_targets, ftt_component_inventory, ftt_component_batches, ftt_plan_items
// - HomesteadLevelService: reads level catalog + applies unlock rules.
// - (optional) homesteadProfile.repo.js, visibilityState.repo.js, baselines.repo.js, snapshots.repo.js
//
// Design notes:
// - No AI. Deterministic steps based on missing data + unlocks + first-run.
// - "Guidance" objects are UI-safe and stable (ids + keys).
// - All writes are best-effort and should never block UI.
//
// Public API:
// - getStatus(householdId) -> { firstRun, needsLevelSelection, level, lastSeenAt, completedAt, progress }
// - getGuidance(householdId, opts?) -> { levelMeta, steps[], checkpoints{}, suggestions[] }
// - selectLevel(householdId, levelKey, meta?) -> updated profile
// - markStepComplete(householdId, stepId, meta?) -> updated profile
// - dismissPanel(householdId, panelKey, meta?) -> updated visibility state
// - dontShowAgain(householdId, key) -> updated visibility state
// - resetOnboarding(householdId) -> clears onboarding progress (keeps level unless meta.keepLevel)
//
// Expected homestead_profile shape (stored):
// {
//   id: "homestead_profile:<householdId>",
//   householdId,
//   level: "off"|"pantry"|"scratch"|"homestead"|"village",
//   enabledDomains: ["farm_to_table", ...],
//   goals: {...},
//   onboarding: {
//     firstRunAt, lastSeenAt, completedAt,
//     stepsCompleted: { [stepId]: { at, meta } },
//     dismissedSteps: { [stepId]: { at, meta } },
//     selectedAt: ISO,
//     version: 1
//   },
//   createdAt, updatedAt
// }

import db from "@/services/db";
import HomesteadLevelService from "@/services/homestead/HomesteadLevelService";

// Optional repos (service works without them)
let HomesteadProfileRepo = null;
let VisibilityStateRepo = null;
let BaselinesRepo = null;
let SnapshotsRepo = null;

try {
  HomesteadProfileRepo = (
    await import("@/services/repos/homestead/homesteadProfile.repo.js")
  ).default;
} catch {
  HomesteadProfileRepo = null;
}
try {
  VisibilityStateRepo = (
    await import("@/services/repos/homestead/visibilityState.repo.js")
  ).default;
} catch {
  VisibilityStateRepo = null;
}
try {
  BaselinesRepo = (
    await import("@/services/repos/estimators/baselines.repo.js")
  ).default;
} catch {
  BaselinesRepo = null;
}
try {
  SnapshotsRepo = (
    await import("@/services/repos/estimators/snapshots.repo.js")
  ).default;
} catch {
  SnapshotsRepo = null;
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

function clampInt(n, min, max) {
  const v = Number.parseInt(String(n), 10);
  if (Number.isNaN(v)) return min;
  return Math.max(min, Math.min(max, v));
}

/* -------------------------------------------------------------------------- */
/* Storage helpers                                                             */
/* -------------------------------------------------------------------------- */

const PROFILE_ID = (householdId) =>
  `homestead_profile:${householdId || "anonymous"}`;
const VIS_ID = (householdId) =>
  `homestead_visibility_state:${householdId || "anonymous"}`;

async function loadProfile(householdId) {
  const hId = safeStr(householdId).trim() || "anonymous";
  const fallback = {
    id: PROFILE_ID(hId),
    householdId: hId,
    level: HomesteadLevelService.DEFAULT_LEVEL,
    enabledDomains: [],
    goals: {},
    onboarding: {
      version: 1,
      firstRunAt: null,
      lastSeenAt: null,
      completedAt: null,
      selectedAt: null,
      stepsCompleted: {},
      dismissedSteps: {},
    },
    createdAt: nowIso(),
    updatedAt: nowIso(),
    source: "fallback",
  };

  // Prefer repo
  if (HomesteadProfileRepo && typeof HomesteadProfileRepo.get === "function") {
    try {
      const row = await HomesteadProfileRepo.get(hId);
      if (row && typeof row === "object") {
        const onboarding = isPlainObject(row.onboarding) ? row.onboarding : {};
        return {
          ...fallback,
          ...row,
          onboarding: {
            ...fallback.onboarding,
            ...onboarding,
            stepsCompleted: isPlainObject(onboarding.stepsCompleted)
              ? onboarding.stepsCompleted
              : {},
            dismissedSteps: isPlainObject(onboarding.dismissedSteps)
              ? onboarding.dismissedSteps
              : {},
          },
          source: "repo",
        };
      }
    } catch (err) {
      if (import.meta?.env?.DEV)
        console.warn("[HomesteadOnboarding] profile repo get failed:", err);
    }
  }

  // Fallback db table
  if (hasTable("homestead_profile")) {
    try {
      const byId = await db.homestead_profile.get(PROFILE_ID(hId));
      const byHousehold = await db.homestead_profile
        .where("householdId")
        .equals(hId)
        .first();
      const row = byId || byHousehold;
      if (row && typeof row === "object") {
        const onboarding = isPlainObject(row.onboarding) ? row.onboarding : {};
        return {
          ...fallback,
          ...row,
          onboarding: {
            ...fallback.onboarding,
            ...onboarding,
            stepsCompleted: isPlainObject(onboarding.stepsCompleted)
              ? onboarding.stepsCompleted
              : {},
            dismissedSteps: isPlainObject(onboarding.dismissedSteps)
              ? onboarding.dismissedSteps
              : {},
          },
          source: "db",
        };
      }
    } catch {
      // ignore
    }
  }

  return fallback;
}

async function saveProfile(profile) {
  const row = { ...profile, updatedAt: nowIso() };
  // Prefer repo
  if (
    HomesteadProfileRepo &&
    typeof HomesteadProfileRepo.upsert === "function"
  ) {
    try {
      await HomesteadProfileRepo.upsert(row);
      return row;
    } catch (err) {
      if (import.meta?.env?.DEV)
        console.warn("[HomesteadOnboarding] profile repo upsert failed:", err);
    }
  }

  if (hasTable("homestead_profile")) {
    await db.homestead_profile.put(row);
    return row;
  }

  // If table is missing, best-effort no-op
  if (import.meta?.env?.DEV)
    console.warn(
      "[HomesteadOnboarding] homestead_profile table missing; cannot persist",
    );
  return row;
}

async function loadVisibilityState(householdId) {
  const hId = safeStr(householdId).trim() || "anonymous";
  const fallback = {
    id: VIS_ID(hId),
    householdId: hId,
    dismissedPanels: {},
    collapsedSections: {},
    dontShowAgain: {},
    createdAt: nowIso(),
    updatedAt: nowIso(),
    source: "fallback",
  };

  if (VisibilityStateRepo && typeof VisibilityStateRepo.get === "function") {
    try {
      const row = await VisibilityStateRepo.get(hId);
      if (row && typeof row === "object") {
        return {
          ...fallback,
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
        console.warn("[HomesteadOnboarding] visibility repo get failed:", err);
    }
  }

  if (hasTable("homestead_visibility_state")) {
    try {
      const byId = await db.homestead_visibility_state.get(VIS_ID(hId));
      const byHousehold = await db.homestead_visibility_state
        .where("householdId")
        .equals(hId)
        .first();
      const row = byId || byHousehold;
      if (row && typeof row === "object") {
        return {
          ...fallback,
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

  return fallback;
}

async function saveVisibilityState(state) {
  const row = { ...state, updatedAt: nowIso() };

  if (VisibilityStateRepo && typeof VisibilityStateRepo.upsert === "function") {
    try {
      await VisibilityStateRepo.upsert(row);
      return row;
    } catch (err) {
      if (import.meta?.env?.DEV)
        console.warn(
          "[HomesteadOnboarding] visibility repo upsert failed:",
          err,
        );
    }
  }

  if (hasTable("homestead_visibility_state")) {
    await db.homestead_visibility_state.put(row);
    return row;
  }

  if (import.meta?.env?.DEV)
    console.warn(
      "[HomesteadOnboarding] homestead_visibility_state table missing; cannot persist",
    );
  return row;
}

/* -------------------------------------------------------------------------- */
/* Presence checks used to build deterministic steps                            */
/* -------------------------------------------------------------------------- */

async function getPresence(householdId) {
  const hId = safeStr(householdId).trim() || "anonymous";
  const presence = {
    hasBaselines: false,
    hasSnapshots: false,
    hasTargets: false,
    hasComponentInventory: false,
    hasComponentBatches: false,
    hasPlanItems: false,
    hasInventory: false,
    hasStorehouse: false,
  };

  if (!hId || hId === "anonymous") return presence;

  // Baselines
  try {
    if (BaselinesRepo && typeof BaselinesRepo.getLatest === "function") {
      const row = await BaselinesRepo.getLatest(hId);
      presence.hasBaselines = Boolean(row);
    } else if (hasTable("estimator_baselines")) {
      const row = await db.estimator_baselines
        .where("householdId")
        .equals(hId)
        .first();
      presence.hasBaselines = Boolean(row);
    }
  } catch {
    // ignore
  }

  // Snapshots
  try {
    if (SnapshotsRepo && typeof SnapshotsRepo.getLatest === "function") {
      const row = await SnapshotsRepo.getLatest(hId);
      presence.hasSnapshots = Boolean(row);
    } else if (hasTable("estimator_snapshots")) {
      const row = await db.estimator_snapshots
        .where("householdId")
        .equals(hId)
        .first();
      presence.hasSnapshots = Boolean(row);
    }
  } catch {
    // ignore
  }

  // Targets
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

  // Component inventory
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

  // Component batches
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

  // Plan items
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

  // Inventory / Storehouse
  try {
    if (hasTable("inventory"))
      presence.hasInventory = (await db.inventory.count()) > 0;
  } catch {
    // ignore
  }
  try {
    if (hasTable("storehouse"))
      presence.hasStorehouse = (await db.storehouse.count()) > 0;
  } catch {
    // ignore
  }

  return presence;
}

/* -------------------------------------------------------------------------- */
/* Guidance model                                                               */
/* -------------------------------------------------------------------------- */

function makeStep({
  id,
  title,
  body,
  ctaLabel,
  ctaAction,
  levelMinRank = 0,
  levelMaxRank = 99,
  required = false,
  dependsOn = [],
  showIf = null,
  tags = [],
  panelKey = null,
}) {
  return {
    id: safeStr(id),
    title: safeStr(title),
    body: safeStr(body),
    ctaLabel: safeStr(ctaLabel || "Open"),
    ctaAction: safeStr(ctaAction || ""),
    required: Boolean(required),
    levelMinRank: Number(levelMinRank),
    levelMaxRank: Number(levelMaxRank),
    dependsOn: uniq(dependsOn),
    tags: uniq(tags),
    panelKey: panelKey ? safeStr(panelKey) : null,
    // showIf(ctx): boolean
    showIf: typeof showIf === "function" ? showIf : null,
  };
}

function stepCompleted(profile, stepId) {
  return Boolean(profile?.onboarding?.stepsCompleted?.[stepId]);
}

function stepDismissed(profile, stepId) {
  return Boolean(profile?.onboarding?.dismissedSteps?.[stepId]);
}

function computeProgress(profile, visibleSteps) {
  const totalRequired = visibleSteps.filter((s) => s.required).length;
  const requiredDone = visibleSteps.filter(
    (s) => s.required && stepCompleted(profile, s.id),
  ).length;
  const total = visibleSteps.length;
  const done = visibleSteps.filter((s) => stepCompleted(profile, s.id)).length;

  const pctRequired = totalRequired
    ? Math.round((requiredDone / totalRequired) * 100)
    : 100;
  const pctAll = total ? Math.round((done / total) * 100) : 100;

  return {
    total,
    done,
    totalRequired,
    requiredDone,
    pctRequired,
    pctAll,
  };
}

/* -------------------------------------------------------------------------- */
/* Default onboarding steps                                                     */
/* -------------------------------------------------------------------------- */
/**
 * We keep a stable list of step IDs. Visibility is driven by unlock + presence.
 * CTA actions are strings for UI routing; your UI can interpret them.
 */
const STEPS = [
  // Level selection
  makeStep({
    id: "level.select",
    title: "Choose your starting level",
    body: "Pick how you want SSA to guide you right now. You can change this later. Lower levels show fewer panels and focus on quick wins.",
    ctaLabel: "Select level",
    ctaAction: "homestead:openLevelPicker",
    required: true,
    levelMinRank: 0,
    tags: ["onboarding", "level"],
    panelKey: "homestead.onboarding",
  }),

  // Estimator baselines
  makeStep({
    id: "estimator.baselines",
    title: "Set your baseline (spend + meals/week)",
    body: "This unlocks your food security % and projected monthly savings as you homestead more. Keep it simple—rough estimates work.",
    ctaLabel: "Add baselines",
    ctaAction: "estimator:openBaselines",
    required: true,
    levelMinRank: 1, // Pantry+
    tags: ["estimator", "food_security", "savings"],
    panelKey: "homestead.estimator.baselines_card",
  }),

  // Run first snapshot
  makeStep({
    id: "estimator.run_snapshot",
    title: "Run your first food-security snapshot",
    body: "Generate a snapshot so SSA can track progress over time (days covered, % food security, savings deltas).",
    ctaLabel: "Run snapshot",
    ctaAction: "estimator:runSnapshot",
    required: false,
    levelMinRank: 1,
    tags: ["estimator", "snapshots"],
    panelKey: "homestead.estimator.snapshots_card",
    dependsOn: ["estimator.baselines"],
  }),

  // Farm-to-table targets (Pantry+)
  makeStep({
    id: "ftt.targets",
    title: "Generate provisioning targets",
    body: "Targets are what SSA thinks you should stock/produce/purchase for your horizon window. This is the engine behind food security and the homestead planner.",
    ctaLabel: "Generate targets",
    ctaAction: "ftt:generateTargets",
    required: false,
    levelMinRank: 1,
    tags: ["ftt", "targets"],
    panelKey: "ftt.targets.summary",
    dependsOn: ["estimator.baselines"],
  }),

  // Scratch: component inventory
  makeStep({
    id: "ftt.components.inventory",
    title: "Map pantry items to farm-to-table components",
    body: "Components (beans, broths, grains, chopped veg) let SSA reason about scratch cooking and batch prep without overwhelming your inventory table.",
    ctaLabel: "Open component inventory",
    ctaAction: "ftt:openComponentInventory",
    required: false,
    levelMinRank: 2, // Scratch+
    tags: ["ftt", "components"],
    panelKey: "ftt.components.inventory",
    dependsOn: ["ftt.targets"],
  }),

  // Scratch: first batch
  makeStep({
    id: "ftt.batches.first",
    title: "Log your first batch (beans, broth, chopped veg)",
    body: "Batch logs help SSA close gaps and reduce weeknight friction. Start with one batch you already do (like beans or broth).",
    ctaLabel: "Log a batch",
    ctaAction: "ftt:logBatch",
    required: false,
    levelMinRank: 2,
    tags: ["ftt", "batches"],
    panelKey: "ftt.components.batches",
    dependsOn: ["ftt.targets"],
  }),

  // Scratch: gaps
  makeStep({
    id: "ftt.gaps.review",
    title: "Review your gaps",
    body: "Gaps show what’s missing for your plan horizon (what to buy, what to batch, what to grow). Use it as a weekly decision board.",
    ctaLabel: "View gaps",
    ctaAction: "ftt:openGaps",
    required: false,
    levelMinRank: 2,
    tags: ["ftt", "gaps"],
    panelKey: "ftt.gaps.panel",
    dependsOn: ["ftt.targets"],
  }),

  // Scratch: sourcing
  makeStep({
    id: "ftt.sourcing.setup",
    title: "Choose how you source gaps (buy, grow, raise, preserve)",
    body: "SSA can recommend sourcing paths for each gap based on your level and goals—buy now, grow later, batch weekly, or preserve in season.",
    ctaLabel: "Open sourcing",
    ctaAction: "ftt:openSourcing",
    required: false,
    levelMinRank: 2,
    tags: ["ftt", "sourcing"],
    panelKey: "ftt.sourcing.panel",
    dependsOn: ["ftt.targets"],
  }),

  // Homestead+: plans
  makeStep({
    id: "ftt.plan.create",
    title: "Create a homestead plan run",
    body: "A plan run locks in your assumptions and produces actionable plan items (targets, tasks, gap actions). This is your weekly/monthly homestead playbook.",
    ctaLabel: "Create plan",
    ctaAction: "ftt:createPlan",
    required: false,
    levelMinRank: 3, // Homestead+
    tags: ["ftt", "plans"],
    panelKey: "ftt.plans.list",
    dependsOn: ["ftt.targets"],
  }),

  // Homestead+: plan items
  makeStep({
    id: "ftt.plan_items.review",
    title: "Review plan items (tasks + targets)",
    body: "Plan items are your to-do list and shopping/batching/growing guidance—filtered by what’s unlocked at your level.",
    ctaLabel: "View plan items",
    ctaAction: "ftt:openPlanItems",
    required: false,
    levelMinRank: 3,
    tags: ["ftt", "plan_items"],
    panelKey: "ftt.plan_items.table",
    dependsOn: ["ftt.plan.create"],
  }),
];

/* -------------------------------------------------------------------------- */
/* Deterministic step filtering                                                 */
/* -------------------------------------------------------------------------- */

function filterStepsForContext({ profile, levelRank, unlock, presence }) {
  const steps = [];

  for (const s of STEPS) {
    if (!s || !s.id) continue;

    // Rank bounds
    if (levelRank < s.levelMinRank || levelRank > s.levelMaxRank) continue;

    // If step is dismissed, do not show (it is not "dontShowAgain"; it's "skip")
    if (stepDismissed(profile, s.id)) continue;

    // Optional showIf predicate
    if (typeof s.showIf === "function") {
      try {
        const ok = Boolean(s.showIf({ profile, levelRank, unlock, presence }));
        if (!ok) continue;
      } catch {
        // ignore
      }
    }

    // Feature gating (hard-coded for core steps)
    // These keys must align with HomesteadLevelService feature gates.
    const featureNeeded = s.id.startsWith("estimator.")
      ? "estimator"
      : s.id.startsWith("ftt.")
        ? "farm_to_table"
        : null;

    if (featureNeeded === "estimator") {
      // Estimator card is for Pantry+; if estimator is disabled at this level, skip estimator steps.
      if (!unlock.features?.estimator && !unlock.features?.baselines) continue;
    }
    if (featureNeeded === "farm_to_table") {
      if (!unlock.domains?.farm_to_table) continue;
    }

    // Presence-driven suppressions:
    // - If baselines already exist and step is baselines, still show but mark as "completed" in UI.
    // - If snapshots exist, we may hide "run_snapshot" unless onboarding not completed.
    if (s.id === "estimator.run_snapshot" && presence.hasSnapshots) {
      // Hide if already done AND onboarding is not strictly required anymore
      // But if required steps not done yet, keep it visible as optional
      // (UI can still show it in "completed" state if you prefer)
      // We'll keep it visible but UI can mark completed.
    }

    steps.push(s);
  }

  // Ensure deterministic ordering: required first, then by levelMinRank, then id
  steps.sort((a, b) => {
    const ra = a.required ? 1 : 0;
    const rb = b.required ? 1 : 0;
    if (ra !== rb) return rb - ra;
    if (a.levelMinRank !== b.levelMinRank)
      return a.levelMinRank - b.levelMinRank;
    return String(a.id).localeCompare(String(b.id));
  });

  return steps;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                   */
/* -------------------------------------------------------------------------- */

async function getStatus(householdId) {
  const profile = await loadProfile(householdId);

  // Normalize level
  const levelKey = HomesteadLevelService.normalizeHomesteadLevel(profile.level);
  const levelMeta = HomesteadLevelService.getLevelMeta(levelKey);
  const unlock = await HomesteadLevelService.getUiGateMap(profile.householdId, {
    profile,
    fallbackLevel: levelKey,
  });

  // If profile never had onboarding.firstRunAt, treat as first-run
  const firstRun = !profile.onboarding?.firstRunAt;
  const needsLevelSelection = !profile.onboarding?.selectedAt;

  const presence = await getPresence(profile.householdId);

  const stepsVisible = filterStepsForContext({
    profile,
    levelRank: levelMeta.rank,
    unlock,
    presence,
  });

  const progress = computeProgress(profile, stepsVisible);

  // Completed if required steps are done
  const completedAt =
    profile.onboarding?.completedAt ||
    (progress.pctRequired === 100 ? nowIso() : null);

  return {
    householdId: profile.householdId,
    firstRun,
    needsLevelSelection,
    level: levelKey,
    levelLabel: levelMeta.label,
    levelRank: levelMeta.rank,
    lastSeenAt: profile.onboarding?.lastSeenAt || null,
    completedAt,
    progress,
    presence,
  };
}

/**
 * Guidance returns:
 * - levelMeta
 * - steps[] with uiState fields (completed/blocked)
 * - checkpoints: presence flags
 * - suggestions: deterministic "next best action" strings
 */
async function getGuidance(householdId, opts = {}) {
  const profile = await loadProfile(householdId);

  // Ensure onboarding.firstRunAt exists (but don't write unless asked, to keep read pure)
  const levelKey = HomesteadLevelService.normalizeHomesteadLevel(
    opts.levelOverride ?? profile.level,
  );
  const levelMeta = HomesteadLevelService.getLevelMeta(levelKey);
  const unlock = await HomesteadLevelService.getUiGateMap(profile.householdId, {
    profile: { ...profile, level: levelKey },
    fallbackLevel: levelKey,
  });

  const presence = await getPresence(profile.householdId);

  const steps = filterStepsForContext({
    profile,
    levelRank: levelMeta.rank,
    unlock,
    presence,
  }).map((s) => {
    const completed = stepCompleted(profile, s.id);
    const dismissed = stepDismissed(profile, s.id);

    // Dependency blocking
    const deps = Array.isArray(s.dependsOn) ? s.dependsOn : [];
    const missingDeps = deps.filter((dep) => !stepCompleted(profile, dep));
    const blocked = missingDeps.length > 0;

    return {
      ...s,
      uiState: {
        completed,
        dismissed,
        blocked,
        missingDeps,
      },
    };
  });

  const progress = computeProgress(profile, steps);

  // Deterministic suggestions (minimal, UI-safe)
  const suggestions = [];
  const nextRequired = steps.find(
    (s) => s.required && !s.uiState.completed && !s.uiState.blocked,
  );
  if (nextRequired) {
    suggestions.push(`Next required: ${nextRequired.title}`);
  } else {
    const nextOptional = steps.find(
      (s) => !s.required && !s.uiState.completed && !s.uiState.blocked,
    );
    if (nextOptional) suggestions.push(`Next: ${nextOptional.title}`);
  }

  if (
    !presence.hasBaselines &&
    (unlock.features?.estimator || unlock.features?.baselines)
  ) {
    suggestions.push(
      "Set baselines to unlock food security and savings estimates.",
    );
  }
  if (
    presence.hasBaselines &&
    !presence.hasTargets &&
    unlock.domains?.farm_to_table
  ) {
    suggestions.push(
      "Generate targets to see what to stock/produce for your horizon.",
    );
  }
  if (
    presence.hasTargets &&
    levelMeta.rank >= 2 &&
    !presence.hasComponentBatches
  ) {
    suggestions.push(
      "Log one batch this week to reduce friction and close gaps.",
    );
  }

  return {
    householdId: profile.householdId,
    levelKey,
    levelMeta,
    unlock,
    checkpoints: presence,
    progress,
    steps,
    suggestions,
    ts: nowIso(),
  };
}

/**
 * Select a homestead level (first-run or later). Also records onboarding.selectedAt on first selection.
 */
async function selectLevel(householdId, level, meta = {}) {
  const profile = await loadProfile(householdId);

  const levelKey = HomesteadLevelService.normalizeHomesteadLevel(level);
  const levelMeta = HomesteadLevelService.getLevelMeta(levelKey);

  const updated = {
    ...profile,
    level: levelKey,
    enabledDomains: HomesteadLevelService.getEnabledDomains({
      profile: { ...profile, level: levelKey },
      level: levelKey,
    }),
    onboarding: {
      ...profile.onboarding,
      version: 1,
      firstRunAt: profile.onboarding?.firstRunAt || nowIso(),
      selectedAt: profile.onboarding?.selectedAt || nowIso(),
      lastSeenAt: nowIso(),
      // Preserve existing stepsCompleted/dismissedSteps
      stepsCompleted: isPlainObject(profile.onboarding?.stepsCompleted)
        ? profile.onboarding.stepsCompleted
        : {},
      dismissedSteps: isPlainObject(profile.onboarding?.dismissedSteps)
        ? profile.onboarding.dismissedSteps
        : {},
      // Completion reset if level changes drastically? Keep unless caller requests reset.
      completedAt: profile.onboarding?.completedAt || null,
      selectedMeta: isPlainObject(meta) ? meta : {},
      levelLabel: levelMeta.label,
      levelRank: levelMeta.rank,
    },
  };

  return await saveProfile(updated);
}

/**
 * Mark a step complete in onboarding progress.
 */
async function markStepComplete(householdId, stepId, meta = {}) {
  const profile = await loadProfile(householdId);
  const id = safeStr(stepId).trim();
  if (!id) throw new Error("[HomesteadOnboardingService] stepId is required");

  const stepsCompleted = { ...(profile.onboarding?.stepsCompleted || {}) };
  stepsCompleted[id] = { at: nowIso(), meta: isPlainObject(meta) ? meta : {} };

  // If required steps are all complete, set completedAt
  const status = await getStatus(profile.householdId);
  const willComplete = status.progress.pctRequired === 100;

  const updated = {
    ...profile,
    onboarding: {
      ...profile.onboarding,
      version: 1,
      firstRunAt: profile.onboarding?.firstRunAt || nowIso(),
      selectedAt: profile.onboarding?.selectedAt || null,
      lastSeenAt: nowIso(),
      stepsCompleted,
      completedAt: willComplete
        ? profile.onboarding?.completedAt || nowIso()
        : profile.onboarding?.completedAt || null,
    },
  };

  return await saveProfile(updated);
}

/**
 * Dismiss a step (skip it from onboarding list). This is not the same as "dont show again".
 */
async function dismissStep(householdId, stepId, meta = {}) {
  const profile = await loadProfile(householdId);
  const id = safeStr(stepId).trim();
  if (!id) throw new Error("[HomesteadOnboardingService] stepId is required");

  const dismissedSteps = { ...(profile.onboarding?.dismissedSteps || {}) };
  dismissedSteps[id] = { at: nowIso(), meta: isPlainObject(meta) ? meta : {} };

  const updated = {
    ...profile,
    onboarding: {
      ...profile.onboarding,
      version: 1,
      firstRunAt: profile.onboarding?.firstRunAt || nowIso(),
      lastSeenAt: nowIso(),
      dismissedSteps,
    },
  };

  return await saveProfile(updated);
}

/**
 * Dismiss a panel (maps into visibility state dismissedPanels).
 * panelKey should match VisibilityRulesEngine decision keys (e.g. "ui.helpers.food_security").
 */
async function dismissPanel(householdId, panelKey, meta = {}) {
  const state = await loadVisibilityState(householdId);
  const key = safeStr(panelKey).trim();
  if (!key)
    throw new Error("[HomesteadOnboardingService] panelKey is required");

  const dismissedPanels = { ...(state.dismissedPanels || {}) };
  dismissedPanels[key] = {
    dismissedAt: nowIso(),
    meta: isPlainObject(meta) ? meta : {},
  };

  return await saveVisibilityState({ ...state, dismissedPanels });
}

/**
 * Strong hide: sets visibilityState.dontShowAgain[key] = true
 */
async function dontShowAgain(householdId, key) {
  const state = await loadVisibilityState(householdId);
  const k = safeStr(key).trim();
  if (!k) throw new Error("[HomesteadOnboardingService] key is required");

  const dontShowAgainMap = { ...(state.dontShowAgain || {}) };
  dontShowAgainMap[k] = true;

  // Also remove from dismissedPanels (optional cleanup)
  const dismissedPanels = { ...(state.dismissedPanels || {}) };
  if (dismissedPanels[k]) delete dismissedPanels[k];

  return await saveVisibilityState({
    ...state,
    dontShowAgain: dontShowAgainMap,
    dismissedPanels,
  });
}

/**
 * Reset onboarding progress (keeps level by default).
 * @param {object} meta
 * @param {boolean} [meta.keepLevel=true]
 */
async function resetOnboarding(householdId, meta = {}) {
  const keepLevel = meta?.keepLevel !== false;
  const profile = await loadProfile(householdId);

  const updated = {
    ...profile,
    level: keepLevel ? profile.level : HomesteadLevelService.DEFAULT_LEVEL,
    onboarding: {
      version: 1,
      firstRunAt: null,
      selectedAt: null,
      lastSeenAt: null,
      completedAt: null,
      stepsCompleted: {},
      dismissedSteps: {},
    },
  };

  return await saveProfile(updated);
}

/**
 * Mark onboarding "seen" (called when user visits Homestead Planner page).
 * This sets firstRunAt on first visit and updates lastSeenAt always.
 */
async function markSeen(householdId, meta = {}) {
  const profile = await loadProfile(householdId);

  const updated = {
    ...profile,
    onboarding: {
      ...profile.onboarding,
      version: 1,
      firstRunAt: profile.onboarding?.firstRunAt || nowIso(),
      lastSeenAt: nowIso(),
      seenMeta: isPlainObject(meta) ? meta : profile.onboarding?.seenMeta || {},
    },
  };

  return await saveProfile(updated);
}

/* -------------------------------------------------------------------------- */
/* Convenience: "first-run auto-seed"                                           */
/* -------------------------------------------------------------------------- */
/**
 * Optionally auto-seed minimal baselines for a first-run household to avoid blank screens.
 * This does NOT overwrite existing baselines.
 * It is safe to call on app boot or page enter.
 */
async function ensureBaselinesSeeded(householdId, seed = {}) {
  const hId = safeStr(householdId).trim();
  if (!hId) return { seeded: false, reason: "missing householdId" };

  const presence = await getPresence(hId);
  if (presence.hasBaselines)
    return { seeded: false, reason: "baselines already exist" };

  // Only seed if baselines table exists / repo exists
  const payload = {
    id: `baseline:${hId}:${Date.now()}`,
    householdId: hId,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    // Defaults keep it conservative
    householdSize: clampInt(seed.householdSize ?? 3, 1, 30),
    mealsPerWeek: clampInt(seed.mealsPerWeek ?? 14, 1, 70),
    grocerySpendMonthly: Number(seed.grocerySpendMonthly ?? 0),
    eatingOutPerWeek: clampInt(seed.eatingOutPerWeek ?? 0, 0, 21),
    notes: safeStr(seed.notes || "Auto-seeded baseline (edit me)"),
    source: "onboarding.seed",
  };

  try {
    if (BaselinesRepo && typeof BaselinesRepo.upsert === "function") {
      await BaselinesRepo.upsert(payload);
      return { seeded: true, via: "repo", payload };
    }
    if (hasTable("estimator_baselines")) {
      await db.estimator_baselines.put(payload);
      return { seeded: true, via: "db", payload };
    }
    return { seeded: false, reason: "no baselines store available" };
  } catch (err) {
    if (import.meta?.env?.DEV)
      console.warn("[HomesteadOnboarding] baseline seed failed:", err);
    return {
      seeded: false,
      reason: "seed failed",
      error: String(err?.message || err),
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Export                                                                       */
/* -------------------------------------------------------------------------- */

const HomesteadOnboardingService = {
  getStatus,
  getGuidance,
  selectLevel,
  markSeen,
  markStepComplete,
  dismissStep,
  dismissPanel,
  dontShowAgain,
  resetOnboarding,
  ensureBaselinesSeeded,
};

export default HomesteadOnboardingService;
