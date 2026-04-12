import { saveMealPlannerOutput } from "@/pages/mealplanner/MealPlannerService";
import { updateStorehouseInventory } from "@/pages/storehouse/planner/InventoryEstimatorService";
import {
  saveHomesteadPlannerPlan,
} from "@/pages/homesteadplanner/HomesteadPlannerService";
import { getToken } from "@/services/auth/tokenProvider";

function authHeaders(extra = {}) {
  const token = String(getToken("access") || "").trim();
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

function readProfileHouseholdId() {
  if (typeof window === "undefined") return "";
  const fromWindow =
    window.__suka?.profile?.householdId ||
    window.__suka?.profile?.homeId ||
    window.__suka?.householdId ||
    window.__suka?.homeId;
  if (fromWindow) return String(fromWindow).trim();

  try {
    const raw = window.localStorage?.getItem("suka.profile");
    const profile = raw ? JSON.parse(raw) : null;
    return String(profile?.householdId || profile?.homeId || "").trim();
  } catch {
    return "";
  }
}

function resolveHouseholdId(householdId, bundle = {}) {
  const explicit = String(householdId || "").trim();
  if (explicit && explicit !== "default-household") return explicit;

  const fromBundle = String(bundle?.context?.householdId || "").trim();
  if (fromBundle && fromBundle !== "default-household") return fromBundle;

  const fromProfile = readProfileHouseholdId();
  if (fromProfile && fromProfile !== "default-household") return fromProfile;

  return explicit || fromBundle || fromProfile || "default-household";
}

export async function requestHouseholdAutomationPlan(payload = {}) {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timeoutId = controller
    ? setTimeout(() => controller.abort(), 10_000)
    : null;

  try {
    const res = await fetch("/api/planners/assistant/plan", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      credentials: "include",
      body: JSON.stringify(payload),
      ...(controller ? { signal: controller.signal } : {}),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.ok) {
      throw new Error(data?.error || "Failed to generate household automation plan");
    }
    return data;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function composeMealSavePayload(bundle = {}, householdId = "default-household") {
  const recipes = Array.isArray(bundle?.suggestions?.meal?.recipes)
    ? bundle.suggestions.meal.recipes
    : [];
  return {
    id: `weekly-${Date.now()}`,
    householdId,
    title: "Weekly automation plan",
    plannerOutput: {
      meals: recipes,
      preservationTasks: bundle?.suggestions?.storehouse?.categories || [],
    },
    recommendationScore: {
      total: 0.84,
      source: "household-automation-panel",
    },
  };
}

function composeStorehouseUpdatePayload(bundle = {}, householdId = "default-household") {
  const categories = Array.isArray(bundle?.suggestions?.storehouse?.categories)
    ? bundle.suggestions.storehouse.categories
    : [];

  const inventory = categories.flatMap((bucket) =>
    (Array.isArray(bucket?.items) ? bucket.items : []).map((itemName, idx) => ({
      id: `${bucket.bucket}-${idx}`,
      itemName,
      category: bucket.bucket,
      qty: 1,
      unit: "batch",
      preservationStatus: bucket.bucket,
      updatedAt: new Date().toISOString(),
    }))
  );

  return {
    householdId,
    inventory,
    source: "household-automation-panel",
  };
}

function composeHomesteadSavePayload(bundle = {}, householdId = "default-household") {
  const crops = Array.isArray(bundle?.suggestions?.homestead?.suggestedCrops)
    ? bundle.suggestions.homestead.suggestedCrops
    : [];
  const animals = Array.isArray(bundle?.suggestions?.homestead?.suggestedAnimals)
    ? bundle.suggestions.homestead.suggestedAnimals
    : [];

  const plan = {
    id: `homestead-${Date.now()}`,
    season: String(bundle?.suggestions?.homestead?.productionForecast?.seasonKey || "current"),
    garden: {
      tasks: crops.map((item) => ({
        title: `Plant ${item.name}`,
        notes: item.purpose,
      })),
    },
    animals: {
      livestockMix: animals.map((item) => item.type).join(", "),
      estimatedTotal: animals.reduce((sum, item) => sum + Number(item?.targetCount || 0), 0),
    },
    outputs: animals.flatMap((item, idx) =>
      (Array.isArray(item?.outputs) ? item.outputs : []).map((outputName) => ({
        id: `${item.type}-${idx}-${outputName}`,
        outputName,
        outputType: "animal",
        qty: 1,
        unit: "weekly",
        preservationReady: true,
      }))
    ),
  };

  return {
    plan,
    opts: {
      householdId,
      replaceOutputs: true,
    },
  };
}

export async function runOneClickAction(action, bundle, householdId) {
  const resolvedHouseholdId = resolveHouseholdId(householdId, bundle);

  if (action === "generate_weekly_meal_plan") {
    const payload = composeMealSavePayload(bundle, resolvedHouseholdId);
    return saveMealPlannerOutput(payload);
  }

  if (action === "update_storehouse_inventory") {
    const payload = composeStorehouseUpdatePayload(bundle, resolvedHouseholdId);
    return updateStorehouseInventory(payload);
  }

  if (action === "schedule_homestead_tasks") {
    const payload = composeHomesteadSavePayload(bundle, resolvedHouseholdId);
    return saveHomesteadPlannerPlan(payload.plan, payload.opts);
  }

  throw new Error("Unsupported automation action");
}

export default {
  requestHouseholdAutomationPlan,
  runOneClickAction,
};
