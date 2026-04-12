import { getToken } from "@/services/auth/tokenProvider";

function readJsonStorage(key) {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function resolveHomesteadPlannerIdentity() {
  const suka = typeof window !== "undefined" ? window.__suka || {} : {};
  const profile =
    suka.profile ||
    readJsonStorage("suka.profile") ||
    readJsonStorage("suka.user") ||
    {};

  return {
    userId: String(profile.userId || profile.id || suka.userId || "system"),
    householdId: String(
      profile.homeId ||
        profile.householdId ||
        suka.homeId ||
        suka.householdId ||
        "default-household"
    ),
  };
}

export function deriveSeasonKey(plan = {}) {
  const season = String(plan?.season || "unknown-season").toLowerCase();
  return season.includes("-") ? season : `${season}-season`;
}

function toFiniteNumber(value, defaultValue = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : defaultValue;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function authHeaders(extra = {}) {
  const token = String(getToken("access") || "").trim();
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

function mapSnapshotOutputToPlannerOutput(row = {}) {
  return {
    id: row.id,
    outputType: row.outputType || "unknown",
    outputName: row.outputName || "Unnamed output",
    qty: toFiniteNumber(row.qty, 0),
    unit: row.unit || "unit",
    expectedHarvestAt: row.expectedHarvestAt || null,
    preservationReady: !!row.preservationReady,
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
  };
}

export function buildHomesteadSavePayload(plan = {}, opts = {}) {
  const identity = opts.identity || resolveHomesteadPlannerIdentity();
  const outputs = asArray(plan?.outputs).map(mapSnapshotOutputToPlannerOutput);
  const gardenTasks = asArray(plan?.garden?.tasks);

  return {
    householdId: String(opts.householdId || identity.householdId || "default-household"),
    planId: String(plan?.id || opts.planId || `homestead-${Date.now()}`),
    seasonKey: String(opts.seasonKey || deriveSeasonKey(plan)),
    gardenPlan: {
      ...(plan?.garden && typeof plan.garden === "object" ? plan.garden : {}),
      tasks: gardenTasks,
    },
    orchardPlan: plan?.orchardPlan && typeof plan.orchardPlan === "object" ? plan.orchardPlan : {},
    herbSpicePlan:
      plan?.herbSpicePlan && typeof plan.herbSpicePlan === "object" ? plan.herbSpicePlan : {},
    animalPlan: plan?.animals && typeof plan.animals === "object" ? plan.animals : {},
    outputs,
    replaceOutputs: opts.replaceOutputs !== false,
    updatedBy: "homestead.planner.ui",
    changeReason: "homestead_plan_upsert_ui",
  };
}

export function mergeSnapshotIntoPlan(snapshot = {}, seedPlan = null) {
  const base =
    seedPlan && typeof seedPlan === "object"
      ? structuredClone(seedPlan)
      : {
          id: `plan-${Math.random().toString(36).slice(2, 8)}`,
          season: "unknown",
          meals: { servingsTarget: 12, batchDaysPerWeek: 2 },
          preservation: { canningJars: 24, dehydrateTrays: 8, freezerSpaceCuFt: 4 },
          garden: { beds: 6, priorityCrops: ["greens", "onions", "garlic"], compostCft: 8 },
          animals: { estimatedTotal: 8, livestockMix: "", butcheryTargets: [] },
          storehouse: { flour_5lb: 4, rice_10lb: 2, beans_10lb: 2, salt_lb: 5 },
          cleaning: { zones: ["kitchen", "pantry"] },
          notes: "",
        };

  const seasonFromSnapshot = String(snapshot?.seasonKey || "");
  const normalizedSeason = seasonFromSnapshot.endsWith("-season")
    ? seasonFromSnapshot.replace(/-season$/, "")
    : seasonFromSnapshot;

  const gardenTasks = asArray(snapshot?.gardenTasks);
  const animalPlan = snapshot?.animalPlan && typeof snapshot.animalPlan === "object" ? snapshot.animalPlan : {};
  const outputs = asArray(snapshot?.outputs).map(mapSnapshotOutputToPlannerOutput);

  return {
    ...base,
    id: String(snapshot?.planId || base.id),
    season: normalizedSeason || base.season,
    garden: {
      ...(base.garden && typeof base.garden === "object" ? base.garden : {}),
      tasks: gardenTasks,
    },
    animals: {
      ...(base.animals && typeof base.animals === "object" ? base.animals : {}),
      ...animalPlan,
    },
    outputs,
    updatedAt: new Date().toISOString(),
    __snapshotMeta: {
      preservationForecast:
        snapshot?.preservationForecast && typeof snapshot.preservationForecast === "object"
          ? snapshot.preservationForecast
          : null,
      warnings: asArray(snapshot?.warnings),
    },
  };
}

export async function fetchHomesteadPlannerSnapshot(householdId) {
  const identity = resolveHomesteadPlannerIdentity();
  const targetHouseholdId = String(householdId || identity.householdId || "default-household");
  const res = await fetch(
    `/api/planners/homestead?householdId=${encodeURIComponent(targetHouseholdId)}`,
    {
      headers: authHeaders(),
      credentials: "include",
    }
  );
  if (!res.ok) throw new Error("Failed to load homestead planner data");
  return res.json();
}

export async function saveHomesteadPlannerPlan(plan = {}, opts = {}) {
  const payload = buildHomesteadSavePayload(plan, opts);
  const res = await fetch(`/api/planners/homestead`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    credentials: "include",
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("Failed to save homestead planner data");
  const data = await res.json();
  return {
    payload,
    data,
  };
}

export async function loadHomesteadPlannerPlan({ householdId, seedPlan } = {}) {
  const snapshot = await fetchHomesteadPlannerSnapshot(householdId);
  return {
    snapshot,
    plan: mergeSnapshotIntoPlan(snapshot, seedPlan),
  };
}

export async function fetchHomesteadTargets(householdId) {
  const identity = resolveHomesteadPlannerIdentity();
  const targetHouseholdId = String(householdId || identity.householdId || "default-household");
  const res = await fetch(
    `/api/planners/homestead/targets?householdId=${encodeURIComponent(targetHouseholdId)}`,
    {
      headers: authHeaders(),
      credentials: "include",
    }
  );
  if (!res.ok) throw new Error("Failed to load homestead targets");
  return res.json();
}

export async function upsertHomesteadTarget(target = {}, householdId) {
  const identity = resolveHomesteadPlannerIdentity();
  const res = await fetch(`/api/planners/homestead/targets`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    credentials: "include",
    body: JSON.stringify({
      householdId: String(householdId || identity.householdId || "default-household"),
      target,
      updatedBy: identity.userId,
    }),
  });
  if (!res.ok) throw new Error("Failed to save homestead target");
  return res.json();
}

export async function deleteHomesteadTarget(targetId, householdId) {
  const identity = resolveHomesteadPlannerIdentity();
  const res = await fetch(
    `/api/planners/homestead/targets/${encodeURIComponent(String(targetId || ""))}?householdId=${encodeURIComponent(
      String(householdId || identity.householdId || "default-household")
    )}`,
    {
      method: "DELETE",
      headers: authHeaders(),
      credentials: "include",
    }
  );
  if (!res.ok) throw new Error("Failed to delete homestead target");
  return res.json();
}

export async function fetchHomesteadCollaboration(householdId) {
  const identity = resolveHomesteadPlannerIdentity();
  const targetHouseholdId = String(householdId || identity.householdId || "default-household");
  const res = await fetch(
    `/api/planners/homestead/collaboration?householdId=${encodeURIComponent(targetHouseholdId)}`,
    {
      headers: authHeaders(),
      credentials: "include",
    }
  );
  if (!res.ok) throw new Error("Failed to load homestead collaboration");
  return res.json();
}

export async function upsertHomesteadCollaborationItem(kind, item = {}, householdId) {
  const identity = resolveHomesteadPlannerIdentity();
  const normalizedKind = String(kind || "").toLowerCase();
  const res = await fetch(`/api/planners/homestead/collaboration/${encodeURIComponent(normalizedKind)}`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    credentials: "include",
    body: JSON.stringify({
      householdId: String(householdId || identity.householdId || "default-household"),
      item,
      updatedBy: identity.userId,
    }),
  });
  if (!res.ok) throw new Error("Failed to save collaboration item");
  return res.json();
}

export async function sendHomesteadCollaborationAction(postId, action, householdId, delta = 1) {
  const identity = resolveHomesteadPlannerIdentity();
  const res = await fetch(
    `/api/planners/homestead/collaboration/feed/${encodeURIComponent(String(postId || ""))}/action`,
    {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      credentials: "include",
      body: JSON.stringify({
        householdId: String(householdId || identity.householdId || "default-household"),
        action,
        delta,
        updatedBy: identity.userId,
      }),
    }
  );
  if (!res.ok) throw new Error("Failed to send collaboration action");
  return res.json();
}

async function getHomesteadCollection(endpoint, householdId) {
  const identity = resolveHomesteadPlannerIdentity();
  const targetHouseholdId = String(householdId || identity.householdId || "default-household");
  const res = await fetch(`${endpoint}?householdId=${encodeURIComponent(targetHouseholdId)}`, {
    headers: authHeaders(),
    credentials: "include",
  });
  if (!res.ok) throw new Error(`Failed to load ${endpoint}`);
  return res.json();
}

async function upsertHomesteadCollectionItem(endpoint, item, householdId) {
  const identity = resolveHomesteadPlannerIdentity();
  const res = await fetch(endpoint, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    credentials: "include",
    body: JSON.stringify({
      householdId: String(householdId || identity.householdId || "default-household"),
      item,
      updatedBy: identity.userId,
    }),
  });
  if (!res.ok) throw new Error(`Failed to save ${endpoint}`);
  return res.json();
}

async function deleteHomesteadCollectionItem(endpointBase, id, householdId) {
  const identity = resolveHomesteadPlannerIdentity();
  const res = await fetch(
    `${endpointBase}/${encodeURIComponent(String(id || ""))}?householdId=${encodeURIComponent(
      String(householdId || identity.householdId || "default-household")
    )}`,
    {
      method: "DELETE",
      headers: authHeaders(),
      credentials: "include",
    }
  );
  if (!res.ok) throw new Error(`Failed to delete ${endpointBase}`);
  return res.json();
}

async function exportHomesteadCollection(endpointBase, householdId) {
  const identity = resolveHomesteadPlannerIdentity();
  const targetHouseholdId = String(householdId || identity.householdId || "default-household");
  const res = await fetch(
    `${endpointBase}/export?householdId=${encodeURIComponent(targetHouseholdId)}`,
    {
      headers: authHeaders(),
      credentials: "include",
    }
  );
  if (!res.ok) throw new Error(`Failed to export ${endpointBase}`);
  return res.json();
}

async function importHomesteadCollection(endpointBase, payload, householdId) {
  const identity = resolveHomesteadPlannerIdentity();
  const res = await fetch(`${endpointBase}/import`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    credentials: "include",
    body: JSON.stringify({
      householdId: String(householdId || identity.householdId || "default-household"),
      mode: String(payload?.mode || "merge").toLowerCase() === "replace" ? "replace" : "merge",
      items: Array.isArray(payload?.items) ? payload.items : [],
      updatedBy: identity.userId,
    }),
  });
  if (!res.ok) throw new Error(`Failed to import ${endpointBase}`);
  return res.json();
}

export function fetchHomesteadComponents(householdId) {
  return getHomesteadCollection("/api/planners/homestead/components", householdId);
}

export function upsertHomesteadComponent(item = {}, householdId) {
  return upsertHomesteadCollectionItem("/api/planners/homestead/components", item, householdId);
}

export function deleteHomesteadComponent(id, householdId) {
  return deleteHomesteadCollectionItem("/api/planners/homestead/components", id, householdId);
}

export function exportHomesteadComponents(householdId) {
  return exportHomesteadCollection("/api/planners/homestead/components", householdId);
}

export function importHomesteadComponents(payload = {}, householdId) {
  return importHomesteadCollection(
    "/api/planners/homestead/components",
    payload,
    householdId
  );
}

export function fetchHomesteadInventory(householdId) {
  return getHomesteadCollection("/api/planners/homestead/inventory", householdId);
}

export function upsertHomesteadInventoryItem(item = {}, householdId) {
  return upsertHomesteadCollectionItem("/api/planners/homestead/inventory", item, householdId);
}

export function deleteHomesteadInventoryItem(id, householdId) {
  return deleteHomesteadCollectionItem("/api/planners/homestead/inventory", id, householdId);
}

export function exportHomesteadInventory(householdId) {
  return exportHomesteadCollection("/api/planners/homestead/inventory", householdId);
}

export function importHomesteadInventory(payload = {}, householdId) {
  return importHomesteadCollection(
    "/api/planners/homestead/inventory",
    payload,
    householdId
  );
}

export function fetchHomesteadBatches(householdId) {
  return getHomesteadCollection("/api/planners/homestead/batches", householdId);
}

export function upsertHomesteadBatch(item = {}, householdId) {
  return upsertHomesteadCollectionItem("/api/planners/homestead/batches", item, householdId);
}

export function deleteHomesteadBatch(id, householdId) {
  return deleteHomesteadCollectionItem("/api/planners/homestead/batches", id, householdId);
}

export function exportHomesteadBatches(householdId) {
  return exportHomesteadCollection("/api/planners/homestead/batches", householdId);
}

export function importHomesteadBatches(payload = {}, householdId) {
  return importHomesteadCollection("/api/planners/homestead/batches", payload, householdId);
}

export async function fetchHomesteadSkills(householdId) {
  const identity = resolveHomesteadPlannerIdentity();
  const targetHouseholdId = String(householdId || identity.householdId || "default-household");
  const res = await fetch(
    `/api/planners/homestead/skills?householdId=${encodeURIComponent(targetHouseholdId)}`,
    {
      headers: authHeaders(),
      credentials: "include",
    }
  );
  if (!res.ok) throw new Error("Failed to load homestead skills");
  return res.json();
}

export async function upsertHomesteadSkillPath(pathItem = {}, householdId) {
  const identity = resolveHomesteadPlannerIdentity();
  const res = await fetch("/api/planners/homestead/skills/path", {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    credentials: "include",
    body: JSON.stringify({
      householdId: String(householdId || identity.householdId || "default-household"),
      path: pathItem,
      updatedBy: identity.userId,
    }),
  });
  if (!res.ok) throw new Error("Failed to save skill path");
  return res.json();
}

export async function upsertHomesteadSkillProgress(progress = {}, householdId) {
  const identity = resolveHomesteadPlannerIdentity();
  const res = await fetch("/api/planners/homestead/skills/progress", {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    credentials: "include",
    body: JSON.stringify({
      householdId: String(householdId || identity.householdId || "default-household"),
      progress,
      updatedBy: identity.userId,
    }),
  });
  if (!res.ok) throw new Error("Failed to save skill progress");
  return res.json();
}

export async function exportHomesteadSkills(householdId) {
  const identity = resolveHomesteadPlannerIdentity();
  const targetHouseholdId = String(householdId || identity.householdId || "default-household");
  const res = await fetch(
    `/api/planners/homestead/skills/export?householdId=${encodeURIComponent(targetHouseholdId)}`,
    {
      headers: authHeaders(),
      credentials: "include",
    }
  );
  if (!res.ok) throw new Error("Failed to export homestead skills");
  return res.json();
}

export async function importHomesteadSkills(payload = {}, householdId) {
  const identity = resolveHomesteadPlannerIdentity();
  const res = await fetch(`/api/planners/homestead/skills/import`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    credentials: "include",
    body: JSON.stringify({
      householdId: String(householdId || identity.householdId || "default-household"),
      mode: String(payload?.mode || "merge").toLowerCase() === "replace" ? "replace" : "merge",
      paths: Array.isArray(payload?.paths) ? payload.paths : [],
      progress: Array.isArray(payload?.progress) ? payload.progress : [],
      updatedBy: identity.userId,
    }),
  });
  if (!res.ok) throw new Error("Failed to import homestead skills");
  return res.json();
}

export async function fetchMealPlannerSnapshot(householdId) {
  const identity = resolveHomesteadPlannerIdentity();
  const targetHouseholdId = String(householdId || identity.householdId || "default-household");
  const res = await fetch(
    `/api/planners/meal?householdId=${encodeURIComponent(targetHouseholdId)}`,
    {
      headers: authHeaders(),
      credentials: "include",
    }
  );
  if (!res.ok) throw new Error("Failed to load meal planner snapshot");
  return res.json();
}

export async function fetchStorehousePlannerSnapshot(householdId) {
  const identity = resolveHomesteadPlannerIdentity();
  const targetHouseholdId = String(householdId || identity.householdId || "default-household");
  const res = await fetch(
    `/api/planners/storehouse?householdId=${encodeURIComponent(targetHouseholdId)}`,
    {
      headers: authHeaders(),
      credentials: "include",
    }
  );
  if (!res.ok) throw new Error("Failed to load storehouse planner snapshot");
  return res.json();
}

export async function sendHomesteadEstimatesToStorehouse(payload = {}, householdId) {
  const identity = resolveHomesteadPlannerIdentity();
  const res = await fetch(`/api/planners/storehouse/inventory`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    credentials: "include",
    body: JSON.stringify({
      householdId: String(householdId || identity.householdId || "default-household"),
      inventory: Array.isArray(payload.inventory) ? payload.inventory : [],
      changeReason: payload.changeReason || "homestead_estimate_sync",
      updatedBy: identity.userId,
    }),
  });
  if (!res.ok) throw new Error("Failed to send estimates to storehouse planner");
  return res.json();
}

export function fetchHomesteadAnimalTargets(householdId) {
  return getHomesteadCollection("/api/planners/homestead/animal-targets", householdId);
}

export function upsertHomesteadAnimalTarget(item = {}, householdId) {
  return upsertHomesteadCollectionItem("/api/planners/homestead/animal-targets", item, householdId);
}

export function deleteHomesteadAnimalTarget(id, householdId) {
  return deleteHomesteadCollectionItem("/api/planners/homestead/animal-targets", id, householdId);
}

export function fetchHomesteadGardenTargets(householdId) {
  return getHomesteadCollection("/api/planners/homestead/garden-targets", householdId);
}

export function upsertHomesteadGardenTarget(item = {}, householdId) {
  return upsertHomesteadCollectionItem("/api/planners/homestead/garden-targets", item, householdId);
}

export function deleteHomesteadGardenTarget(id, householdId) {
  return deleteHomesteadCollectionItem("/api/planners/homestead/garden-targets", id, householdId);
}

export async function fetchHomesteadCuisines(householdId) {
  const identity = resolveHomesteadPlannerIdentity();
  const targetHouseholdId = String(householdId || identity.householdId || "default-household");
  const res = await fetch(
    `/api/planners/homestead/cuisines?householdId=${encodeURIComponent(targetHouseholdId)}`,
    {
      headers: authHeaders(),
      credentials: "include",
    }
  );
  if (!res.ok) throw new Error("Failed to load homestead cuisines");
  return res.json();
}

export async function upsertHomesteadCuisineProfile(profile = {}, householdId) {
  const identity = resolveHomesteadPlannerIdentity();
  const res = await fetch("/api/planners/homestead/cuisines/profile", {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    credentials: "include",
    body: JSON.stringify({
      householdId: String(householdId || identity.householdId || "default-household"),
      profile,
      updatedBy: identity.userId,
    }),
  });
  if (!res.ok) throw new Error("Failed to save cuisine profile");
  return res.json();
}

export async function upsertHomesteadCuisineRotation(rotation = {}, householdId) {
  const identity = resolveHomesteadPlannerIdentity();
  const res = await fetch("/api/planners/homestead/cuisines/rotation", {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    credentials: "include",
    body: JSON.stringify({
      householdId: String(householdId || identity.householdId || "default-household"),
      rotation,
      updatedBy: identity.userId,
    }),
  });
  if (!res.ok) throw new Error("Failed to save cuisine rotation");
  return res.json();
}

export async function upsertHomesteadCuisinePrefs(prefs = {}, householdId) {
  const identity = resolveHomesteadPlannerIdentity();
  const res = await fetch("/api/planners/homestead/cuisines/prefs", {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    credentials: "include",
    body: JSON.stringify({
      householdId: String(householdId || identity.householdId || "default-household"),
      prefs,
      updatedBy: identity.userId,
    }),
  });
  if (!res.ok) throw new Error("Failed to save cuisine prefs");
  return res.json();
}

export async function fetchHomesteadPreferences(householdId) {
  const identity = resolveHomesteadPlannerIdentity();
  const targetHouseholdId = String(householdId || identity.householdId || "default-household");
  const res = await fetch(
    `/api/planners/homestead/preferences?householdId=${encodeURIComponent(targetHouseholdId)}`,
    {
      headers: authHeaders(),
      credentials: "include",
    }
  );
  if (!res.ok) throw new Error("Failed to load homestead preferences");
  return res.json();
}

export async function upsertHomesteadPreferences(payload = {}, householdId) {
  const identity = resolveHomesteadPlannerIdentity();
  const res = await fetch("/api/planners/homestead/preferences", {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    credentials: "include",
    body: JSON.stringify({
      householdId: String(householdId || identity.householdId || "default-household"),
      household: payload.household || {},
      profile: payload.profile || {},
      updatedBy: identity.userId,
    }),
  });
  if (!res.ok) throw new Error("Failed to save homestead preferences");
  return res.json();
}

export default {
  resolveHomesteadPlannerIdentity,
  deriveSeasonKey,
  buildHomesteadSavePayload,
  mergeSnapshotIntoPlan,
  fetchHomesteadPlannerSnapshot,
  saveHomesteadPlannerPlan,
  loadHomesteadPlannerPlan,
  fetchHomesteadTargets,
  upsertHomesteadTarget,
  deleteHomesteadTarget,
  fetchHomesteadCollaboration,
  upsertHomesteadCollaborationItem,
  sendHomesteadCollaborationAction,
  fetchHomesteadComponents,
  upsertHomesteadComponent,
  deleteHomesteadComponent,
  exportHomesteadComponents,
  importHomesteadComponents,
  fetchHomesteadInventory,
  upsertHomesteadInventoryItem,
  deleteHomesteadInventoryItem,
  exportHomesteadInventory,
  importHomesteadInventory,
  fetchHomesteadBatches,
  upsertHomesteadBatch,
  deleteHomesteadBatch,
  exportHomesteadBatches,
  importHomesteadBatches,
  fetchHomesteadSkills,
  upsertHomesteadSkillPath,
  upsertHomesteadSkillProgress,
  exportHomesteadSkills,
  importHomesteadSkills,
  fetchHomesteadAnimalTargets,
  upsertHomesteadAnimalTarget,
  deleteHomesteadAnimalTarget,
  fetchHomesteadGardenTargets,
  upsertHomesteadGardenTarget,
  deleteHomesteadGardenTarget,
  fetchHomesteadCuisines,
  upsertHomesteadCuisineProfile,
  upsertHomesteadCuisineRotation,
  upsertHomesteadCuisinePrefs,
  fetchHomesteadPreferences,
  upsertHomesteadPreferences,
  fetchMealPlannerSnapshot,
  fetchStorehousePlannerSnapshot,
  sendHomesteadEstimatesToStorehouse,
};
