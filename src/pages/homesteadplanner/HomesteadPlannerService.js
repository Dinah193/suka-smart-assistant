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

function toFiniteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
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

export function mergeSnapshotIntoPlan(snapshot = {}, fallbackPlan = null) {
  const base =
    fallbackPlan && typeof fallbackPlan === "object"
      ? structuredClone(fallbackPlan)
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
    `/api/planners/homestead?householdId=${encodeURIComponent(targetHouseholdId)}`
  );
  if (!res.ok) throw new Error("Failed to load homestead planner data");
  return res.json();
}

export async function saveHomesteadPlannerPlan(plan = {}, opts = {}) {
  const payload = buildHomesteadSavePayload(plan, opts);
  const res = await fetch(`/api/planners/homestead`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("Failed to save homestead planner data");
  const data = await res.json();
  return {
    payload,
    data,
  };
}

export async function loadHomesteadPlannerPlan({ householdId, fallbackPlan } = {}) {
  const snapshot = await fetchHomesteadPlannerSnapshot(householdId);
  return {
    snapshot,
    plan: mergeSnapshotIntoPlan(snapshot, fallbackPlan),
  };
}

export default {
  resolveHomesteadPlannerIdentity,
  deriveSeasonKey,
  buildHomesteadSavePayload,
  mergeSnapshotIntoPlan,
  fetchHomesteadPlannerSnapshot,
  saveHomesteadPlannerPlan,
  loadHomesteadPlannerPlan,
};
