import { saveMealPlannerOutput } from "./MealPlannerService";

function readJsonStorage(key) {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function resolveMealPlannerIdentity() {
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

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function buildMealPlannerSavePayload({
  normalizedPlan,
  duration,
  templateId,
  cuisines,
  presets,
  horizonMonths,
  plannerGaps,
  estimateInputs,
  currentPlanId,
  fallbackPlanId,
  identity,
} = {}) {
  const who = identity || resolveMealPlannerIdentity();
  const now = new Date().toISOString();
  const startDate = now.slice(0, 10);

  const meals = asArray(normalizedPlan?.meals);
  const shoppingList = asArray(normalizedPlan?.shoppingList);
  const prepTasks = asArray(normalizedPlan?.prepTasks);

  return {
    id: currentPlanId || fallbackPlanId || `meal-${Date.now()}`,
    householdId: who.householdId,
    userId: who.userId,
    title: normalizedPlan?.title || normalizedPlan?.summary || "Meal plan",
    startDate,
    endDate: startDate,
    plannerOutput: {
      meals,
      shoppingList,
      prepTasks,
      budget: normalizedPlan?.budget || {},
      macros: normalizedPlan?.macros || {},
      estimateInputs: estimateInputs || null,
      plannerGaps: plannerGaps || null,
      context: {
        duration: duration || null,
        templateId: templateId || null,
        cuisines: asArray(cuisines),
        presets: asArray(presets),
        horizonMonths:
          Number.isFinite(Number(horizonMonths)) && Number(horizonMonths) >= 0
            ? Number(horizonMonths)
            : null,
      },
    },
    recommendationScore: normalizedPlan?.recommendationScore || {},
    updatedBy: "mealplanner:onGenerate",
    changeReason: "meal_planner_generate",
  };
}

export async function persistMealPlannerGeneration({
  normalizedPlan,
  saveAsDraft = false,
  duration,
  templateId,
  cuisines,
  presets,
  horizonMonths,
  plannerGaps,
  estimateInputs,
  currentPlanId,
  fallbackPlanId,
  saveFn = saveMealPlannerOutput,
} = {}) {
  if (saveAsDraft) {
    return { ok: false, skipped: true, reason: "draft_mode" };
  }

  const meals = asArray(normalizedPlan?.meals);
  if (!meals.length) {
    return { ok: false, skipped: true, reason: "missing_meals" };
  }

  const payload = buildMealPlannerSavePayload({
    normalizedPlan,
    duration,
    templateId,
    cuisines,
    presets,
    horizonMonths,
    plannerGaps,
    estimateInputs,
    currentPlanId,
    fallbackPlanId,
  });

  try {
    const response = await saveFn(payload);
    return {
      ok: !!response?.ok,
      skipped: false,
      payload,
      response,
    };
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      payload,
      error,
    };
  }
}

export default {
  resolveMealPlannerIdentity,
  buildMealPlannerSavePayload,
  persistMealPlannerGeneration,
};
