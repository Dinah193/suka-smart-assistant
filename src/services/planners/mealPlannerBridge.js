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

export function buildPlannerGapsFromEstimateInputs({
  estimateInputs,
  normalizedPlan,
  meta = {},
} = {}) {
  const shopping = Array.isArray(normalizedPlan?.shoppingList)
    ? normalizedPlan.shoppingList
    : [];

  const produceDemand = Array.isArray(estimateInputs?.garden?.produceDemand)
    ? estimateInputs.garden.produceDemand
    : [];
  const proteinDemand =
    estimateInputs?.animal?.proteinDemandByType &&
    typeof estimateInputs.animal.proteinDemandByType === "object"
      ? estimateInputs.animal.proteinDemandByType
      : {};

  const baseFromShopping = shopping
    .map((item, idx) => {
      const label = String(typeof item === "string" ? item : item?.name || "").trim();
      if (!label) return null;
      const qty = Number(typeof item === "string" ? 1 : item?.qty ?? item?.neededQty ?? 1);
      const missingQty = Number.isFinite(qty) && qty > 0 ? qty : 1;
      const severity = missingQty >= 3 ? "hard" : "soft";
      return {
        id: `gap-shopping-${idx + 1}`,
        key: label.toLowerCase(),
        name: label,
        unit: String((typeof item === "string" ? "unit" : item?.unit) || "unit"),
        missingQty,
        severity,
        dueWindow: "next-cycle",
      };
    })
    .filter(Boolean);

  const produceGaps = produceDemand
    .map((row, idx) => {
      const name = String(row?.name || "").trim();
      if (!name) return null;
      const qty = Number(row?.qty || 0);
      const missingQty = Number.isFinite(qty) && qty > 0 ? qty : 1;
      return {
        id: `gap-produce-${idx + 1}`,
        key: name.toLowerCase(),
        name,
        unit: String(row?.unit || "unit"),
        missingQty,
        severity: missingQty >= 2 ? "hard" : "soft",
        dueWindow: "next-cycle",
        sourceSignal: "garden.produceDemand",
      };
    })
    .filter(Boolean);

  const proteinGaps = Object.entries(proteinDemand)
    .map(([kind, qty], idx) => {
      const n = Number(qty || 0);
      if (!Number.isFinite(n) || n <= 0) return null;
      const typeLabel = String(kind || "other").replace(/[-_]/g, " ");
      return {
        id: `gap-protein-${idx + 1}`,
        key: `protein:${String(kind || "other").toLowerCase()}`,
        name: `${typeLabel} protein supply`,
        unit: "serving",
        missingQty: n,
        severity: n >= 3 ? "hard" : "soft",
        dueWindow: "next-cycle",
        sourceSignal: "animal.proteinDemandByType",
      };
    })
    .filter(Boolean);

  const merged = [...baseFromShopping, ...produceGaps, ...proteinGaps];
  const dedup = new Map();
  for (const gap of merged) {
    if (!gap?.key) continue;
    if (!dedup.has(gap.key)) {
      dedup.set(gap.key, gap);
      continue;
    }
    const cur = dedup.get(gap.key);
    dedup.set(gap.key, {
      ...cur,
      missingQty: Number(cur.missingQty || 0) + Number(gap.missingQty || 0),
      severity:
        cur.severity === "hard" || gap.severity === "hard" ? "hard" : "soft",
    });
  }

  const gaps = Array.from(dedup.values()).map((gap) => {
    const n = Number(gap?.missingQty || 0);
    const severity = gap?.severity || (n >= 3 ? "hard" : "soft");
    return {
      ...gap,
      missingQty: Number.isFinite(n) && n > 0 ? n : 1,
      severity,
      recommendedSourcing: [
        {
          sourceTier: "community-marketplace",
          priority: 1,
          rationale: "Prioritize local/community exchanges for self-sufficiency.",
        },
        {
          sourceTier: "outside-sources",
          priority: 2,
          rationale: "Fallback when community supply is unavailable or delayed.",
        },
      ],
    };
  });

  const hardGaps = gaps.filter((g) => g.severity === "hard");
  const softGaps = gaps.filter((g) => g.severity !== "hard");

  return {
    contractVersion: "planner.gaps.v1",
    source: "meal-planner",
    generatedAt: new Date().toISOString(),
    sessionId: meta?.sessionId || null,
    summary: {
      totalGaps: gaps.length,
      hardGapCount: hardGaps.length,
      softGapCount: softGaps.length,
      escalationRequired: hardGaps.length > 0,
      mealCount: Array.isArray(normalizedPlan?.meals) ? normalizedPlan.meals.length : 0,
      shoppingCount: shopping.length,
    },
    gaps,
    hardGapsOnly: hardGaps,
    productionOffsets: {
      preservationTasks: Array.isArray(estimateInputs?.preservation?.tasks)
        ? estimateInputs.preservation.tasks.length
        : 0,
    },
  };
}

export function emitPlannerGapsUpdated({
  estimateInputs,
  normalizedPlan,
  meta = {},
  eventBusEmit,
} = {}) {
  if (typeof eventBusEmit !== "function") {
    return { ok: false, error: "eventBusEmit_missing" };
  }

  const plannerGaps = buildPlannerGapsFromEstimateInputs({
    estimateInputs,
    normalizedPlan,
    meta,
  });

  eventBusEmit("planner.gaps.updated", {
    source: "mealplanner:onGenerate",
    plannerGaps,
    estimateInputs,
  });

  return { ok: true, plannerGaps };
}

export default {
  mapProvisionPayloadToStorehouseNeeds,
  forwardProvisionToStorehousePlanner,
  buildHomesteadMealPlanContract,
  emitHomesteadMealPlanGenerated,
  buildEstimateInputsFromNormalizedPlan,
  buildPlannerGapsFromEstimateInputs,
  emitPlannerGapsUpdated,
};
