"use strict";

const { PlannerEvents, publishPlannerEvent } = require("../../../eventBus/plannerEventBus");

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normText(value) {
  return String(value || "").trim();
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

function buildEstimateInputsFromPlannerOutput({ plannerOutput = {}, meta = {} } = {}) {
  const shoppingList = asArray(plannerOutput?.shoppingList);
  const meals = asArray(plannerOutput?.meals);
  const prepTasks = asArray(plannerOutput?.prepTasks);

  const proteinDemandByType = {};
  const produceDemand = [];
  const preservationTasks = prepTasks
    .filter((t) => looksLikePreservationPrep(t))
    .map((t, i) => mapPrepTaskToPreservationTask(t, i))
    .filter(Boolean);

  for (const item of shoppingList) {
    const name = normText(typeof item === "string" ? item : item?.name);
    if (!name) continue;
    const qty = toNum(typeof item === "string" ? 1 : item?.qty ?? item?.neededQty, 1);

    const proteinType = guessProteinType(name);
    proteinDemandByType[proteinType] = toNum(proteinDemandByType[proteinType], 0) + qty;

    if (looksLikeGardenProduce(name)) {
      produceDemand.push({
        name,
        qty,
        unit: normText(item?.unit) || "unit",
      });
    }
  }

  return {
    contractVersion: "planner.estimate-inputs.v1",
    source: "meal-planner-backend",
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

function buildPlannerGapsFromEstimateInputs({ estimateInputs = {}, plannerOutput = {}, mealPlanId = null } = {}) {
  const shopping = asArray(plannerOutput?.shoppingList);
  const produceDemand = asArray(estimateInputs?.garden?.produceDemand);
  const proteinDemand = estimateInputs?.animal?.proteinDemandByType || {};

  const baseFromShopping = shopping
    .map((item, idx) => {
      const label = normText(typeof item === "string" ? item : item?.name);
      if (!label) return null;
      const qty = toNum(typeof item === "string" ? 1 : item?.qty ?? item?.neededQty, 1);
      return {
        id: `gap-shopping-${idx + 1}`,
        key: label.toLowerCase(),
        name: label,
        unit: normText(typeof item === "string" ? "unit" : item?.unit) || "unit",
        missingQty: qty,
        severity: qty >= 3 ? "hard" : "soft",
        dueWindow: "next-cycle",
      };
    })
    .filter(Boolean);

  const produceGaps = produceDemand
    .map((row, idx) => {
      const name = normText(row?.name);
      if (!name) return null;
      const qty = toNum(row?.qty, 1);
      return {
        id: `gap-produce-${idx + 1}`,
        key: name.toLowerCase(),
        name,
        unit: normText(row?.unit) || "unit",
        missingQty: qty,
        severity: qty >= 2 ? "hard" : "soft",
        dueWindow: "next-cycle",
        sourceSignal: "garden.produceDemand",
      };
    })
    .filter(Boolean);

  const proteinGaps = Object.entries(proteinDemand)
    .map(([kind, qty], idx) => {
      const n = toNum(qty, 0);
      if (n <= 0) return null;
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

  const gaps = [...baseFromShopping, ...produceGaps, ...proteinGaps].map((gap) => {
    const isHard = String(gap.severity || "").toLowerCase() === "hard";
    return {
      ...gap,
      recommendedSourcing: isHard
        ? [
            { sourceTier: "community-marketplace", confidence: 0.8 },
            { sourceTier: "outside-sources", confidence: 0.5 },
          ]
        : [{ sourceTier: "storehouse-existing", confidence: 0.7 }],
    };
  });

  const hardGapCount = gaps.filter((g) => String(g.severity || "").toLowerCase() === "hard").length;

  return {
    contractVersion: "planner.gaps.v1",
    source: "mealplanner:backendOrchestration",
    mealPlanId: mealPlanId || null,
    generatedAt: new Date().toISOString(),
    summary: {
      totalGapCount: gaps.length,
      hardGapCount,
      softGapCount: Math.max(0, gaps.length - hardGapCount),
    },
    gaps,
  };
}

function buildStorehouseIngestContract({ plannerGaps = {}, sessionId = null } = {}) {
  const hardGaps = asArray(plannerGaps?.gaps).filter(
    (g) => String(g?.severity || "").toLowerCase() === "hard"
  );

  const needs = hardGaps.map((gap, idx) => ({
    id: `need-gap-${idx + 1}`,
    name: normText(gap?.name || gap?.key),
    qty: toNum(gap?.missingQty, 1),
    unit: normText(gap?.unit) || "unit",
    category: "planner-gap",
    priority: 1,
    tags: ["planner-gap", "hard", "backend-fanout"],
    source: "meal-planner-backend",
  }));

  return {
    contractVersion: "storehouse.ingest.v1",
    source: "meal-planner-backend",
    sessionId: sessionId || null,
    count: needs.length,
    needs,
  };
}

function buildHomesteadMealPlanContract({ mealPayload = {}, mealSaveResult = {} } = {}) {
  const plannerOutput = mealPayload?.plannerOutput || {};
  return {
    contractVersion: "homestead.mealplan.v1",
    source: "meal-planner-backend",
    generatedAt: new Date().toISOString(),
    plan: {
      title: mealPayload?.title || "Meal plan",
      summary: normText(plannerOutput?.summary || ""),
      mealCount: asArray(plannerOutput?.meals).length,
      shoppingCount: asArray(plannerOutput?.shoppingList).length,
      prepTaskCount: asArray(plannerOutput?.prepTasks).length,
      budget: plannerOutput?.budget || {},
      macros: plannerOutput?.macros || {},
    },
    routing: {
      mealPlanId: mealSaveResult?.id || mealPayload?.id || null,
      householdId: mealSaveResult?.householdId || mealPayload?.householdId || null,
    },
  };
}

async function orchestrateMealPlanFanout({
  mealPayload = {},
  mealSaveResult = {},
  persistContracts = null,
  syncProjection = null,
} = {}) {
  const mealPlanId = String(mealSaveResult?.id || mealPayload?.id || "").trim() || null;
  const householdId =
    String(mealSaveResult?.householdId || mealPayload?.householdId || "").trim() ||
    "default-household";

  const estimateInputs = buildEstimateInputsFromPlannerOutput({
    plannerOutput: mealPayload?.plannerOutput || {},
    meta: {
      sessionId: mealPlanId,
      horizonMonths: mealPayload?.plannerOutput?.context?.horizonMonths,
    },
  });

  const plannerGaps = buildPlannerGapsFromEstimateInputs({
    estimateInputs,
    plannerOutput: mealPayload?.plannerOutput || {},
    mealPlanId,
  });

  const storehouseIngest = buildStorehouseIngestContract({
    plannerGaps,
    sessionId: mealPlanId,
  });

  const homesteadContract = buildHomesteadMealPlanContract({
    mealPayload,
    mealSaveResult,
  });

  const contracts = [
    { eventType: "planner.estimateInputs.updated", contract: estimateInputs },
    { eventType: "planner.gaps.updated", contract: plannerGaps },
    { eventType: "storehouse.planner.ingest.requested", contract: storehouseIngest },
    { eventType: "homestead.planner.mealPlan.generated", contract: homesteadContract },
  ];

  for (const item of contracts) {
    publishPlannerEvent(item.eventType, item.contract, {
      source: "MealPlannerOrchestrationService.orchestrateMealPlanFanout",
      correlationId: mealPlanId,
    });
  }

  publishPlannerEvent(PlannerEvents.PLANNER_RECOMMENDATIONS_UPDATED, {
    planner: "meal",
    householdId,
    updateType: "meal.fanout",
    counts: {
      estimateSignals: 1,
      gapSignals: asArray(plannerGaps?.gaps).length,
      storehouseNeeds: asArray(storehouseIngest?.needs).length,
    },
  }, {
    source: "MealPlannerOrchestrationService.orchestrateMealPlanFanout",
    correlationId: mealPlanId,
  });

  const durable =
    typeof persistContracts === "function"
      ? await persistContracts({ mealPlanId, householdId, contracts })
      : { queuedCount: 0, queuedContracts: [] };

  const projectionSync =
    typeof syncProjection === "function"
      ? await syncProjection({ mealPlanId, householdId, contracts, plannerGaps, storehouseIngest })
      : { ok: false, skipped: true, reason: "projection_sync_unavailable" };

  return {
    ok: true,
    mealPlanId,
    householdId,
    contracts,
    durable,
    projectionSync,
    summary: {
      contractsCount: contracts.length,
      hardGapCount: toNum(plannerGaps?.summary?.hardGapCount, 0),
      storehouseNeedsCount: toNum(storehouseIngest?.count, 0),
    },
  };
}

module.exports = {
  buildEstimateInputsFromPlannerOutput,
  buildPlannerGapsFromEstimateInputs,
  buildStorehouseIngestContract,
  buildHomesteadMealPlanContract,
  orchestrateMealPlanFanout,
};
