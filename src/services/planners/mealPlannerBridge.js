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

function guessProteinType(name = "") {
  const n = normText(name).toLowerCase();
  if (!n) return "other";
  if (/chicken|turkey|duck/.test(n)) return "poultry";
  if (/beef|steak/.test(n)) return "beef";
  if (/pork|ham|bacon/.test(n)) return "pork";
  if (/lamb|goat/.test(n)) return "small-ruminant";
  if (/fish|salmon|tuna|cod|trout/.test(n)) return "fish";
  if (/shrimp|crab|lobster|shellfish/.test(n)) return "shellfish";
  if (/egg/.test(n)) return "egg";
  return "other";
}

function looksLikeGardenProduce(name = "") {
  const n = normText(name).toLowerCase();
  if (!n) return false;
  return /tomato|onion|garlic|pepper|potato|carrot|greens|spinach|lettuce|okra|corn|herb|basil|cilantro|parsley|cabbage|squash/.test(
    n
  );
}

function looksLikePreservationPrep(task = {}) {
  const t = normText(task?.title || task?.name || task?.task).toLowerCase();
  return /can|dehydrat|freeze|ferment|pickle|preserv|jar/.test(t);
}

function mapPrepTaskToPreservationTask(task = {}, i = 0) {
  const label = normText(task?.title || task?.name || task?.task);
  if (!label) return null;

  // Try to recover a produce anchor from the task text for merge-friendly upserts.
  const produceMatch = label.match(
    /(tomato|onion|garlic|pepper|greens|okra|corn|cabbage|carrot|berries|fruit|beans)/i
  );
  const methodMatch = label.match(/(can|dehydrat|freeze|ferment|pickle|jar)/i);

  return {
    id: `pres-${i + 1}`,
    produce: produceMatch ? produceMatch[1].toLowerCase() : "mixed produce",
    method: methodMatch ? methodMatch[1].toLowerCase() : "preserve",
    quantity: 1,
    unit: "batch",
    status: "planned",
    notes: label,
  };
}

export function buildEstimateInputsFromNormalizedPlan({
  normalizedPlan,
  meta = {},
} = {}) {
  const shoppingList = asArray(normalizedPlan?.shoppingList);
  const meals = asArray(normalizedPlan?.meals);
  const prepTasks = asArray(normalizedPlan?.prepTasks);

  const proteinDemandByType = {};
  const produceDemand = [];
  const preservationTasks = prepTasks
    .filter((t) => looksLikePreservationPrep(t))
    .map((t, i) => mapPrepTaskToPreservationTask(t, i))
    .filter(Boolean);

  for (const it of shoppingList) {
    const name = normText(typeof it === "string" ? it : it?.name);
    if (!name) continue;
    const qty = toNum(typeof it === "string" ? 1 : it?.qty ?? it?.neededQty, 1);

    const proteinType = guessProteinType(name);
    proteinDemandByType[proteinType] = toNum(proteinDemandByType[proteinType], 0) + qty;

    if (looksLikeGardenProduce(name)) {
      produceDemand.push({
        name,
        qty,
        unit: normText(it?.unit) || "unit",
      });
    }
  }

  return {
    contractVersion: "planner.estimate-inputs.v1",
    source: "meal-planner",
    sessionId: meta.sessionId || null,
    horizonMonths: toNum(meta.horizonMonths, 0),
    animal: {
      mealCount: meals.length,
      proteinDemandByType,
    },
    garden: {
      mealCount: meals.length,
      produceDemand,
    },
    preservation: {
      prepTaskCount: prepTasks.length,
      tasks: preservationTasks,
    },
  };
}

export default {
  mapProvisionPayloadToStorehouseNeeds,
  forwardProvisionToStorehousePlanner,
  buildHomesteadMealPlanContract,
  emitHomesteadMealPlanGenerated,
  buildEstimateInputsFromNormalizedPlan,
};
