/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\services\repos\homestead\homesteadProfile.repo.js
//
// Homestead Profile + Visibility + Estimator baselines/snapshots repository.
// ------------------------------------------------------------------------
// Goals:
// - Local-first (Dexie) source of truth
// - Strong defaults so UI can render immediately
// - Safe upserts (no throws from "missing table" situations; dev logs only)
// - All writes timestamped (createdAt/updatedAt)
// - Designed to play nicely with db.js hooks (events + optional Hub export)
//
// Requires db.js to define these tables (v15+ recommended):
// - homestead_profile
// - homestead_visibility_state (optional but expected by UI)
// - estimator_baselines
// - estimator_snapshots
//
// Also interoperates with FTT tables already in your db.js (optional):
// - ftt_provisioning_targets
// - ftt_component_inventory
// - ftt_component_batches
// - ftt_plan_items

import db from "@/services/db";

/* -------------------------------------------------------------------------- */
/* Utilities */
/* -------------------------------------------------------------------------- */

function nowIso() {
  return new Date().toISOString();
}

function safeStr(x, fallback = "") {
  if (x == null) return fallback;
  return String(x);
}

function safeBool(x, fallback = false) {
  if (typeof x === "boolean") return x;
  if (x === "true") return true;
  if (x === "false") return false;
  return fallback;
}

function asStringArray(x) {
  if (Array.isArray(x)) return x.map((v) => String(v)).filter(Boolean);
  if (typeof x === "string") return [x].filter(Boolean);
  return [];
}

function deepClone(obj) {
  try {
    return structuredClone(obj);
  } catch {
    return JSON.parse(JSON.stringify(obj || {}));
  }
}

function makeKey(prefix, householdId, suffix = "") {
  const h =
    safeStr(householdId, "household_unknown").trim() || "household_unknown";
  const s = suffix ? `:${safeStr(suffix).trim()}` : "";
  return `${prefix}:${h}${s}`;
}

function hasTable(name) {
  try {
    // Dexie defines properties for tables; also db.table(name) throws if missing
    void db.table(name);
    return true;
  } catch {
    return false;
  }
}

async function safeGet(tableName, key) {
  if (!hasTable(tableName)) {
    if (import.meta?.env?.DEV)
      console.warn(`[homestead.repo] Missing table: ${tableName}`);
    return null;
  }
  try {
    return await db.table(tableName).get(key);
  } catch (e) {
    if (import.meta?.env?.DEV)
      console.warn(`[homestead.repo] safeGet failed (${tableName})`, e);
    return null;
  }
}

async function safePut(tableName, value) {
  if (!hasTable(tableName)) {
    if (import.meta?.env?.DEV)
      console.warn(`[homestead.repo] Missing table: ${tableName}`);
    return null;
  }
  try {
    await db.table(tableName).put(value);
    return value;
  } catch (e) {
    if (import.meta?.env?.DEV)
      console.warn(`[homestead.repo] safePut failed (${tableName})`, e);
    return null;
  }
}

async function safeDelete(tableName, key) {
  if (!hasTable(tableName)) return false;
  try {
    await db.table(tableName).delete(key);
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Defaults */
/* -------------------------------------------------------------------------- */

/**
 * Homestead levels (SSA concept):
 * 0 = just browsing / aspirational
 * 1 = beginner (small changes, low equipment)
 * 2 = intermediate (batching + preserving + garden basics)
 * 3 = advanced (serious scratch + preservation + garden/animals)
 */
export const HOMESTEAD_LEVELS = Object.freeze({
  BROWSE: 0,
  BEGINNER: 1,
  INTERMEDIATE: 2,
  ADVANCED: 3,
});

export const DEFAULT_ENABLED_DOMAINS = Object.freeze([
  // Core household ERP domains most people will start with
  "meals",
  "storehouse",
  "shopping",
  "cleaning",
  // Homestead domains can be enabled as user levels up
  "garden",
  "animals",
  "preservation",
]);

function defaultHomesteadProfile(householdId) {
  const ts = nowIso();
  return {
    id: makeKey("homestead_profile", householdId),
    householdId: safeStr(householdId),
    schemaVersion: "1.0.0",
    status: "active",

    // The big switchboard that drives what the Homestead Planner shows
    selectedLevel: HOMESTEAD_LEVELS.BEGINNER,
    enabledDomains: deepClone(DEFAULT_ENABLED_DOMAINS),

    // High-level goals (used by estimator + planner)
    goals: {
      // Food security + budget reduction are first-class in your SSA direction
      foodSecurity: {
        targetPercent: 60, // default: start meaningful but not overwhelming
        horizonDays: 30,
      },
      budget: {
        targetMonthlySavingsUSD: 0,
        reduceEatingOutPct: 20,
      },
      scratchCooking: {
        targetScratchPct: 35,
        batchDaysPerWeek: 1,
      },
      garden: {
        enabled: true,
        targetContributionPct: 15, // % of produce demand
      },
      animals: {
        enabled: false,
        targetContributionPct: 0, // % of protein demand
      },
      preservation: {
        enabled: true,
        targetContributionPct: 10,
      },
    },

    // UX helpers
    notes: "",

    createdAt: ts,
    updatedAt: ts,
  };
}

function defaultVisibilityState(householdId) {
  const ts = nowIso();
  return {
    id: makeKey("homestead_visibility_state", householdId),
    householdId: safeStr(householdId),
    schemaVersion: "1.0.0",

    // Sections user collapsed in Homestead Planner / domain pages
    collapsedSections: [],

    // Helper panels user dismissed ("don't show again" or "x")
    dismissedPanels: [],

    // Per-feature toggles (generic)
    flags: {
      dontShowWelcome: false,
      dontShowLevelExplainer: false,
      dontShowEstimatorTips: false,
    },

    createdAt: ts,
    updatedAt: ts,
  };
}

function defaultEstimatorBaselines(householdId) {
  const ts = nowIso();
  return {
    id: makeKey("estimator_baselines", householdId),
    householdId: safeStr(householdId),
    schemaVersion: "1.0.0",
    status: "active",

    // Minimal baseline inputs with safe defaults:
    householdSize: 2,
    mealsPerWeek: 14, // 2/day default; meal planner can override later
    grocerySpendMonthlyUSD: 600,
    eatingOutFrequencyPerWeek: 2,

    // Optional
    notes: "",
    createdAt: ts,
    updatedAt: ts,
  };
}

/**
 * Snapshot: computed outputs over time (food security %, days covered, savings).
 * This is for charting trends + comparing estimator runs.
 */
function normalizeEstimatorSnapshot(householdId, snapshot) {
  const ts = nowIso();
  const id =
    snapshot?.id ||
    snapshot?.snapshotId ||
    makeKey(
      "estimator_snapshot",
      householdId,
      `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    );

  return {
    id: safeStr(id),
    householdId: safeStr(householdId),
    schemaVersion: "1.0.0",

    // What computed
    kind: safeStr(snapshot?.kind, "homestead.estimator.snapshot"),
    status: safeStr(snapshot?.status, "computed"),

    // Time anchor(s)
    computedAt: safeStr(snapshot?.computedAt, ts),
    createdAt: safeStr(snapshot?.createdAt, ts),
    updatedAt: ts,

    // The actual computed values (keep it open-ended but predictable)
    outputs: {
      foodSecurityPercent: Number(
        snapshot?.outputs?.foodSecurityPercent ??
          snapshot?.foodSecurityPercent ??
          0,
      ),
      daysCovered: Number(
        snapshot?.outputs?.daysCovered ?? snapshot?.daysCovered ?? 0,
      ),
      monthlySavingsUSD: Number(
        snapshot?.outputs?.monthlySavingsUSD ??
          snapshot?.monthlySavingsUSD ??
          0,
      ),
      groceryDeltaUSD: Number(
        snapshot?.outputs?.groceryDeltaUSD ?? snapshot?.groceryDeltaUSD ?? 0,
      ),
      eatingOutDeltaUSD: Number(
        snapshot?.outputs?.eatingOutDeltaUSD ??
          snapshot?.eatingOutDeltaUSD ??
          0,
      ),
      scratchCookingPercent: Number(
        snapshot?.outputs?.scratchCookingPercent ??
          snapshot?.scratchCookingPercent ??
          0,
      ),

      // Optional detail buckets
      breakdown:
        snapshot?.outputs?.breakdown &&
        typeof snapshot.outputs.breakdown === "object"
          ? snapshot.outputs.breakdown
          : {},
    },

    // Inputs used (store a copy so the run is reproducible / auditable)
    inputs:
      snapshot?.inputs && typeof snapshot.inputs === "object"
        ? snapshot.inputs
        : {},

    // Links to plan runs / ftt targets
    links:
      snapshot?.links && typeof snapshot.links === "object"
        ? snapshot.links
        : {},

    // Optional metadata
    meta:
      snapshot?.meta && typeof snapshot.meta === "object" ? snapshot.meta : {},

    title: safeStr(snapshot?.title, "Estimator Snapshot"),
  };
}

/* -------------------------------------------------------------------------- */
/* Homestead Profile API */
/* -------------------------------------------------------------------------- */

export async function ensureHomesteadProfile(householdId) {
  const key = makeKey("homestead_profile", householdId);
  const existing = await safeGet("homestead_profile", key);
  if (existing) return existing;

  const created = defaultHomesteadProfile(householdId);
  await safePut("homestead_profile", created);
  return created;
}

export async function getHomesteadProfile(householdId) {
  const key = makeKey("homestead_profile", householdId);
  const existing = await safeGet("homestead_profile", key);
  if (existing) return existing;
  // Strong default to avoid UI blanks
  return defaultHomesteadProfile(householdId);
}

// Legacy compatibility aliases
export const getByHouseholdId = getHomesteadProfile;
export const getProfile = getHomesteadProfile;

export async function upsertHomesteadProfile(householdId, patch = {}) {
  const current = await ensureHomesteadProfile(householdId);
  const updated = {
    ...current,
    ...patch,
    id: makeKey("homestead_profile", householdId),
    householdId: safeStr(householdId),
    enabledDomains: Array.isArray(patch.enabledDomains)
      ? patch.enabledDomains.map(String).filter(Boolean)
      : Array.isArray(current.enabledDomains)
        ? current.enabledDomains
        : deepClone(DEFAULT_ENABLED_DOMAINS),
    goals:
      patch.goals && typeof patch.goals === "object"
        ? { ...(current.goals || {}), ...patch.goals }
        : current.goals || {},
    selectedLevel:
      patch.selectedLevel != null
        ? Number(patch.selectedLevel)
        : Number(current.selectedLevel ?? HOMESTEAD_LEVELS.BEGINNER),
    status: safeStr(patch.status, current.status || "active"),
    schemaVersion: safeStr(
      patch.schemaVersion,
      current.schemaVersion || "1.0.0",
    ),
    updatedAt: nowIso(),
  };

  await safePut("homestead_profile", updated);
  return updated;
}

export async function setHomesteadLevel(householdId, level) {
  const lvl = Number(level);
  const safeLevel = Number.isFinite(lvl) ? lvl : HOMESTEAD_LEVELS.BEGINNER;
  return upsertHomesteadProfile(householdId, { selectedLevel: safeLevel });
}

export async function enableHomesteadDomain(
  householdId,
  domainKey,
  enabled = true,
) {
  const domain = safeStr(domainKey).toLowerCase().trim();
  if (!domain) return getHomesteadProfile(householdId);

  const current = await ensureHomesteadProfile(householdId);
  const set = new Set(
    asStringArray(current.enabledDomains).map((d) => d.toLowerCase()),
  );
  if (enabled) set.add(domain);
  else set.delete(domain);

  return upsertHomesteadProfile(householdId, {
    enabledDomains: Array.from(set),
  });
}

export async function setHomesteadGoals(householdId, goalsPatch) {
  if (!goalsPatch || typeof goalsPatch !== "object")
    return getHomesteadProfile(householdId);
  return upsertHomesteadProfile(householdId, { goals: goalsPatch });
}

export async function resetHomesteadProfile(householdId) {
  const created = defaultHomesteadProfile(householdId);
  await safePut("homestead_profile", created);
  return created;
}

/* -------------------------------------------------------------------------- */
/* Visibility State API (dismissed panels, collapsed sections, etc.) */
/* -------------------------------------------------------------------------- */

export async function ensureHomesteadVisibility(householdId) {
  const key = makeKey("homestead_visibility_state", householdId);
  const existing = await safeGet("homestead_visibility_state", key);
  if (existing) return existing;

  const created = defaultVisibilityState(householdId);
  await safePut("homestead_visibility_state", created);
  return created;
}

export async function getHomesteadVisibility(householdId) {
  const key = makeKey("homestead_visibility_state", householdId);
  const existing = await safeGet("homestead_visibility_state", key);
  if (existing) return existing;
  return defaultVisibilityState(householdId);
}

export async function upsertHomesteadVisibility(householdId, patch = {}) {
  const current = await ensureHomesteadVisibility(householdId);
  const updated = {
    ...current,
    ...patch,
    id: makeKey("homestead_visibility_state", householdId),
    householdId: safeStr(householdId),
    schemaVersion: safeStr(
      patch.schemaVersion,
      current.schemaVersion || "1.0.0",
    ),
    collapsedSections: Array.isArray(patch.collapsedSections)
      ? patch.collapsedSections.map(String).filter(Boolean)
      : Array.isArray(current.collapsedSections)
        ? current.collapsedSections
        : [],
    dismissedPanels: Array.isArray(patch.dismissedPanels)
      ? patch.dismissedPanels.map(String).filter(Boolean)
      : Array.isArray(current.dismissedPanels)
        ? current.dismissedPanels
        : [],
    flags:
      patch.flags && typeof patch.flags === "object"
        ? { ...(current.flags || {}), ...patch.flags }
        : current.flags || {},
    updatedAt: nowIso(),
  };

  await safePut("homestead_visibility_state", updated);
  return updated;
}

export async function dismissPanel(householdId, panelKey, dismissed = true) {
  const key = safeStr(panelKey).trim();
  if (!key) return getHomesteadVisibility(householdId);

  const current = await ensureHomesteadVisibility(householdId);
  const set = new Set(asStringArray(current.dismissedPanels));
  if (dismissed) set.add(key);
  else set.delete(key);

  return upsertHomesteadVisibility(householdId, {
    dismissedPanels: Array.from(set),
  });
}

export async function setSectionCollapsed(
  householdId,
  sectionKey,
  collapsed = true,
) {
  const key = safeStr(sectionKey).trim();
  if (!key) return getHomesteadVisibility(householdId);

  const current = await ensureHomesteadVisibility(householdId);
  const set = new Set(asStringArray(current.collapsedSections));
  if (collapsed) set.add(key);
  else set.delete(key);

  return upsertHomesteadVisibility(householdId, {
    collapsedSections: Array.from(set),
  });
}

export async function setVisibilityFlag(householdId, flagKey, value) {
  const key = safeStr(flagKey).trim();
  if (!key) return getHomesteadVisibility(householdId);

  const current = await ensureHomesteadVisibility(householdId);
  const flags = { ...(current.flags || {}) };
  flags[key] = safeBool(value, false);

  return upsertHomesteadVisibility(householdId, { flags });
}

export async function resetHomesteadVisibility(householdId) {
  const created = defaultVisibilityState(householdId);
  await safePut("homestead_visibility_state", created);
  return created;
}

/* -------------------------------------------------------------------------- */
/* Estimator Baselines API */
/* -------------------------------------------------------------------------- */

export async function ensureEstimatorBaselines(householdId) {
  const key = makeKey("estimator_baselines", householdId);
  const existing = await safeGet("estimator_baselines", key);
  if (existing) return existing;

  const created = defaultEstimatorBaselines(householdId);
  await safePut("estimator_baselines", created);
  return created;
}

export async function getEstimatorBaselines(householdId) {
  const key = makeKey("estimator_baselines", householdId);
  const existing = await safeGet("estimator_baselines", key);
  if (existing) return existing;
  return defaultEstimatorBaselines(householdId);
}

export async function upsertEstimatorBaselines(householdId, patch = {}) {
  const current = await ensureEstimatorBaselines(householdId);
  const updated = {
    ...current,
    ...patch,
    id: makeKey("estimator_baselines", householdId),
    householdId: safeStr(householdId),
    schemaVersion: safeStr(
      patch.schemaVersion,
      current.schemaVersion || "1.0.0",
    ),
    status: safeStr(patch.status, current.status || "active"),
    householdSize:
      patch.householdSize != null
        ? Number(patch.householdSize)
        : Number(current.householdSize ?? 2),
    mealsPerWeek:
      patch.mealsPerWeek != null
        ? Number(patch.mealsPerWeek)
        : Number(current.mealsPerWeek ?? 14),
    grocerySpendMonthlyUSD:
      patch.grocerySpendMonthlyUSD != null
        ? Number(patch.grocerySpendMonthlyUSD)
        : Number(current.grocerySpendMonthlyUSD ?? 600),
    eatingOutFrequencyPerWeek:
      patch.eatingOutFrequencyPerWeek != null
        ? Number(patch.eatingOutFrequencyPerWeek)
        : Number(current.eatingOutFrequencyPerWeek ?? 2),
    updatedAt: nowIso(),
    createdAt: current.createdAt || nowIso(),
  };

  await safePut("estimator_baselines", updated);
  return updated;
}

export async function resetEstimatorBaselines(householdId) {
  const created = defaultEstimatorBaselines(householdId);
  await safePut("estimator_baselines", created);
  return created;
}

/* -------------------------------------------------------------------------- */
/* Estimator Snapshots API */
/* -------------------------------------------------------------------------- */

export async function saveEstimatorSnapshot(householdId, snapshot) {
  const normalized = normalizeEstimatorSnapshot(householdId, snapshot || {});
  const ok = await safePut("estimator_snapshots", normalized);
  return ok || normalized;
}

export async function getEstimatorSnapshotById(snapshotId) {
  if (!snapshotId) return null;
  return safeGet("estimator_snapshots", safeStr(snapshotId));
}

export async function listEstimatorSnapshots(householdId, { limit = 50 } = {}) {
  if (!hasTable("estimator_snapshots")) return [];
  const h = safeStr(householdId);
  try {
    // Prefer indexed query if your schema includes [householdId+computedAt] later.
    // For now, filter then sort.
    const rows = await db.estimator_snapshots
      .where("householdId")
      .equals(h)
      .toArray();

    rows.sort((a, b) =>
      safeStr(b.updatedAt || b.computedAt).localeCompare(
        safeStr(a.updatedAt || a.computedAt),
      ),
    );
    return rows.slice(0, limit);
  } catch (e) {
    if (import.meta?.env?.DEV)
      console.warn("[homestead.repo] listEstimatorSnapshots failed", e);
    return [];
  }
}

export async function deleteEstimatorSnapshot(snapshotId) {
  if (!snapshotId) return false;
  return safeDelete("estimator_snapshots", safeStr(snapshotId));
}

export async function deleteAllEstimatorSnapshots(householdId) {
  if (!hasTable("estimator_snapshots")) return 0;
  const h = safeStr(householdId);
  try {
    const rows = await db.estimator_snapshots
      .where("householdId")
      .equals(h)
      .toArray();
    const ids = rows.map((r) => r.id).filter(Boolean);
    await db.transaction("rw", db.estimator_snapshots, async () => {
      await Promise.all(ids.map((id) => db.estimator_snapshots.delete(id)));
    });
    return ids.length;
  } catch (e) {
    if (import.meta?.env?.DEV)
      console.warn("[homestead.repo] deleteAllEstimatorSnapshots failed", e);
    return 0;
  }
}

/* -------------------------------------------------------------------------- */
/* Optional: quick linkage to FTT artifacts (read-only conveniences) */
/* -------------------------------------------------------------------------- */

export async function getLatestFttProvisioningTargets(householdId) {
  if (!hasTable("ftt_provisioning_targets")) return null;
  const h = safeStr(householdId);
  try {
    // Prefer householdId+updatedAt if present; otherwise sort client-side.
    const rows = await db.ftt_provisioning_targets
      .where("householdId")
      .equals(h)
      .toArray();
    rows.sort((a, b) =>
      safeStr(b.updatedAt).localeCompare(safeStr(a.updatedAt)),
    );
    return rows[0] || null;
  } catch {
    return null;
  }
}

export async function listFttPlanItemsByPlanId(planId, { limit = 250 } = {}) {
  if (!planId || !hasTable("ftt_plan_items")) return [];
  const pid = safeStr(planId);
  try {
    const rows = await db.ftt_plan_items.where("planId").equals(pid).toArray();
    rows.sort((a, b) =>
      safeStr(b.updatedAt).localeCompare(safeStr(a.updatedAt)),
    );
    return rows.slice(0, limit);
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/* Combined “bootstrap” helper (recommended for app init) */
/* -------------------------------------------------------------------------- */

export async function bootstrapHomesteadState(householdId) {
  // Ensures all core documents exist so UI never renders blank
  const [profile, visibility, baselines] = await Promise.all([
    ensureHomesteadProfile(householdId),
    ensureHomesteadVisibility(householdId),
    ensureEstimatorBaselines(householdId),
  ]);

  return { profile, visibility, baselines };
}

/* -------------------------------------------------------------------------- */
/* Default export (ergonomic repo object) */
/* -------------------------------------------------------------------------- */

const homesteadProfileRepo = {
  // profile
  ensureHomesteadProfile,
  getHomesteadProfile,
  getByHouseholdId,
  getProfile,
  upsertHomesteadProfile,
  resetHomesteadProfile,
  setHomesteadLevel,
  enableHomesteadDomain,
  setHomesteadGoals,

  // visibility
  ensureHomesteadVisibility,
  getHomesteadVisibility,
  upsertHomesteadVisibility,
  resetHomesteadVisibility,
  dismissPanel,
  setSectionCollapsed,
  setVisibilityFlag,

  // estimator baselines
  ensureEstimatorBaselines,
  getEstimatorBaselines,
  upsertEstimatorBaselines,
  resetEstimatorBaselines,

  // estimator snapshots
  saveEstimatorSnapshot,
  getEstimatorSnapshotById,
  listEstimatorSnapshots,
  deleteEstimatorSnapshot,
  deleteAllEstimatorSnapshots,

  // optional ftt helpers
  getLatestFttProvisioningTargets,
  listFttPlanItemsByPlanId,

  // bootstrap
  bootstrapHomesteadState,

  // constants
  HOMESTEAD_LEVELS,
  DEFAULT_ENABLED_DOMAINS,
};

export default homesteadProfileRepo;
