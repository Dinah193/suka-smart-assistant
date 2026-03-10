// src/services/planners/mealPlannerBridge.js
// Minimal bridge contracts between Meal Planner, Storehouse Planner, and Homestead Planner.

function asArray(v) {
  return Array.isArray(v) ? v : v ? [v] : [];
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normText(v) {
  return String(v || "").trim();
}

function makeId(prefix = "id") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

export function mapProvisionPayloadToStorehouseNeeds(payload = {}) {
  return asArray(payload.items)
    .map((it) => {
      const name = normText(it?.name);
      if (!name) return null;

      const neededQty = toNum(it?.neededQty, 0);
      const onHandQty = toNum(it?.onHandQty, 0);
      const explicitShortfall = toNum(it?.shortfallQty, neededQty - onHandQty);
      const shortfallQty = Math.max(0, explicitShortfall);

      return {
        id: makeId("need"),
        name,
        qty: shortfallQty > 0 ? shortfallQty : Math.max(0, neededQty),
        unit: normText(it?.unit) || "unit",
        category: "meal-planner",
        priority: 2,
        tags: ["meal-plan", "provision", "auto-forward"],
        source: "meal-planner",
        notes: `Needed for planned meals (${asArray(it?.recipeTitles).length} recipes)`,
        linkedRecipeId: asArray(it?.recipeIds)[0] || undefined,
      };
    })
    .filter(Boolean);
}

export function forwardProvisionToStorehousePlanner({
  payload,
  eventBusEmit,
  upsertNeeds,
} = {}) {
  const needs = mapProvisionPayloadToStorehouseNeeds(payload);

  if (typeof eventBusEmit === "function") {
    eventBusEmit("storehouse.planner.ingest.requested", {
      contractVersion: "storehouse.ingest.v1",
      source: "meal-planner",
      sessionId: payload?.sessionId || null,
      seasonContext: payload?.seasonContext || null,
      count: needs.length,
      needs,
    });
  }

  if (typeof upsertNeeds === "function" && needs.length) {
    upsertNeeds(needs);
  }

  if (typeof eventBusEmit === "function") {
    eventBusEmit("storehouse.planner.ingest.completed", {
      contractVersion: "storehouse.ingest.v1",
      source: "meal-planner",
      sessionId: payload?.sessionId || null,
      count: needs.length,
      forwarded: needs.length > 0,
    });
  }

  return { ok: true, forwardedCount: needs.length, needs };
}

export function buildHomesteadMealPlanContract({
  normalizedPlan,
  meta = {},
} = {}) {
  const meals = asArray(normalizedPlan?.meals);
  const shoppingList = asArray(normalizedPlan?.shoppingList);
  const prepTasks = asArray(normalizedPlan?.prepTasks);

  return {
    contractVersion: "homestead.mealplan.v1",
    source: "meal-planner",
    generatedAt: new Date().toISOString(),
    plan: {
      title: normalizedPlan?.title || "Meal Plan",
      summary: normalizedPlan?.summary || "",
      mealCount: meals.length,
      shoppingCount: shoppingList.length,
      prepTaskCount: prepTasks.length,
      budget: normalizedPlan?.budget || {},
      macros: normalizedPlan?.macros || {},
    },
    routing: {
      templateId: meta.templateId || null,
      cuisines: asArray(meta.cuisines),
      presets: asArray(meta.presets),
      duration: meta.duration || null,
      saveAsDraft: Boolean(meta.saveAsDraft),
    },
  };
}

export function emitHomesteadMealPlanGenerated({
  normalizedPlan,
  meta,
  eventBusEmit,
} = {}) {
  if (typeof eventBusEmit !== "function") {
    return { ok: false, error: "eventBusEmit_missing" };
  }

  const contract = buildHomesteadMealPlanContract({ normalizedPlan, meta });
  eventBusEmit("homestead.planner.mealPlan.generated", contract);

  return { ok: true, contract };
}

export default {
  mapProvisionPayloadToStorehouseNeeds,
  forwardProvisionToStorehousePlanner,
  buildHomesteadMealPlanContract,
  emitHomesteadMealPlanGenerated,
};
