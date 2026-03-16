// C:\Users\larho\suka-smart-assistant\src\services\analytics\cookingAnalytics.js
/* ============================================================================
   cookingAnalytics — Meal & Batch Cooking KPIs, forecasts, and nudges
   - Event-driven & defensive (runs even if some Stores/Agents are absent)
   - Surfaces UI-ready dashboard cards + “Next Best Action” (NBA) suggestions
   - Ties together: Meal Plans, Recipe Vault, Batch Sessions, Inventory, Calendar
   - Computes: on-plan %, macro adherence, cost/serving, pantry coverage,
               prep time saved, waste %, top recipes, shortages forecast
   - Integrates with Automation Runtime (daily/weekly schedules + triggers)
   - Pulls inspiration from best-in-class dashboards (Shopify, Notion, Linear)
   - NEW: Coalitions — multiple households (different users) cooking individually
          toward shared goals (events, food trains, community fridges, etc.)
          with fairness scoring and coordination suggestions.
============================================================================ */

import EventEmitter from "eventemitter3";

/* -----------------------------------------------------------------------------
   Defensive optional imports (no hard coupling)
----------------------------------------------------------------------------- */
let automation;
let eventBus;
let PreferencesStore,
  MealPlanStore,
  InventoryStore,
  RecipeStore,
  HealthStore,
  CalendarStore,
  GroupStore,
  CoalitionStore;
try {
  ({ automation } = await import("@/services/automation/runtime"));
} catch {}
try {
  ({ eventBus } = await import("@/services/events/eventBus"));
} catch {}
try {
  ({ usePreferencesStore: PreferencesStore } = await import(
    "@/store/PreferencesStore"
  ));
} catch {}
try {
  ({ useMealPlanStore: MealPlanStore } = await import("@/store/MealPlanStore"));
} catch {}
try {
  ({ useInventoryStore: InventoryStore } = await import(
    "@/store/InventoryStore"
  ));
} catch {}
try {
  ({ useRecipeStore: RecipeStore } = await import("@/store/RecipeStore"));
} catch {}
try {
  ({ useHealthStore: HealthStore } = await import("@/store/HealthStore"));
} catch {}
try {
  ({ useCalendarStore: CalendarStore } = await import("@/store/CalendarStore"));
} catch {}
try {
  ({ useGroupStore: GroupStore } = await import("@/store/GroupStore"));
} catch {}
try {
  ({ useCoalitionStore: CoalitionStore } = await import(
    "@/store/CoalitionStore"
  ));
} catch {}

/* -----------------------------------------------------------------------------
   Local helpers & small utils
----------------------------------------------------------------------------- */
const isBrowser = typeof window !== "undefined";
const now = () => Date.now();
const dayMs = 86_400_000;
const round2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const avg = (xs) => (xs.length ? sum(xs) / xs.length : 0);

const safeJSON = {
  parse: (s, f = null) => {
    try {
      return JSON.parse(s);
    } catch {
      return f;
    }
  },
  stringify: (o) => {
    try {
      return JSON.stringify(o);
    } catch {
      return "";
    }
  },
};

const storage = (() => {
  const key = "suka::cookingAnalytics::snap";
  if (isBrowser && window.localStorage) {
    return {
      get: () => safeJSON.parse(localStorage.getItem(key), null),
      set: (v) => localStorage.setItem(key, safeJSON.stringify(v)),
      del: () => localStorage.removeItem(key),
    };
  }
  let mem = null;
  return { get: () => mem, set: (v) => (mem = v), del: () => (mem = null) };
})();

const coalitionCache = (() => {
  const key = "suka::cookingAnalytics::coalitions";
  if (isBrowser && window.localStorage) {
    return {
      get: () => safeJSON.parse(localStorage.getItem(key), {}),
      set: (v) => localStorage.setItem(key, safeJSON.stringify(v || {})),
    };
  }
  let mem = {};
  return { get: () => mem, set: (v) => (mem = v || {}) };
})();

/* -----------------------------------------------------------------------------
   Store accessors (defensive)
----------------------------------------------------------------------------- */
function readPrefs() {
  try {
    return PreferencesStore?.() || {};
  } catch {
    return {};
  }
}
function readHealth() {
  try {
    return HealthStore?.() || {};
  } catch {
    return {};
  }
}
function readMealPlan() {
  try {
    return MealPlanStore?.() || {};
  } catch {
    return {};
  }
}
function readInventory() {
  try {
    return InventoryStore?.() || {};
  } catch {
    return {};
  }
}
function readRecipes() {
  try {
    return RecipeStore?.() || {};
  } catch {
    return {};
  }
}
function readCalendar() {
  try {
    return CalendarStore?.() || {};
  } catch {
    return {};
  }
}
function readCoalitions() {
  try {
    return CoalitionStore?.() || { coalitions: [] };
  } catch {
    return { coalitions: [] };
  }
}
function readGroups() {
  try {
    return GroupStore?.() || { groups: [] };
  } catch {
    return { groups: [] };
  }
}

/* -----------------------------------------------------------------------------
   Expected event/log shapes we’ll analyze (defensive, optional):
   - meal.log: { ts, mealId, recipeId, servings, macros: {calories, protein, carbs, fat}, cost, durationMin }
   - batch.session: { id, createdTs, completedTs?, plannedRecipes:[], cookedRecipes:[], totalServings, totalPrepMin }
   - inventory.delta: { ts, itemId, qtyChange, reason: 'cook|waste|purchase|adjust' }
   - grocery.generated: { ts, count, totalEstimatedCost }
   - recipe.rating: { ts, recipeId, score(1-5) }
----------------------------------------------------------------------------- */

/* -----------------------------------------------------------------------------
   Primary analytics snapshot (single household)
----------------------------------------------------------------------------- */
export function computeCookingSnapshot({
  prefs = readPrefs(),
  health = readHealth(),
  mealPlan = readMealPlan(),
  inventory = readInventory(),
  recipes = readRecipes(),
  calendar = readCalendar(),
} = {}) {
  const logs = mealPlan?.logs || []; // meal.log[]
  const batches = mealPlan?.batches || []; // batch.session[]
  const deltas = inventory?.deltas || []; // inventory.delta[]
  const grocery = mealPlan?.groceryHistory || []; // grocery.generated[]
  const ratings = recipes?.ratings || []; // recipe.rating[]

  // Time windows
  const since7 = Date.now() - 7 * dayMs;
  const since30 = Date.now() - 30 * dayMs;

  /* ---------------------------- Core KPIs ---------------------------------- */

  // 1) On-plan completion rate (last 7d)
  const planned7 = (mealPlan?.schedule || []).filter(
    (d) => (d.ts || d.dateTs) >= since7
  );
  const plannedCount = planned7.length || 0;
  const completed7 = logs.filter((l) => l.ts >= since7);
  const onPlanHits = completed7.filter((l) =>
    wasPlannedFor(planned7, l)
  ).length;
  const onPlanPct = plannedCount ? onPlanHits / plannedCount : 0;

  // 2) Macro adherence vs target (last 7d average)
  const target = macroTargetFrom(prefs, health);
  const consumed7 = sumMacros(completed7);
  const days7 = Math.max(1, uniqueDays(completed7));
  const avg7 = scaleMacros(consumed7, 1 / days7); // per day average
  const macroAdherence = macroAdherencePct(avg7, target); // {calories, protein, carbs, fat, overall}

  // 3) Cost / serving (last 30d)
  const logs30 = logs.filter((l) => l.ts >= since30);
  const servings30 = sum(logs30.map((l) => l.servings || 0));
  const cost30 = sum(logs30.map((l) => Number(l.cost || 0)));
  const costPerServing = servings30 ? cost30 / servings30 : 0;

  // 4) Pantry coverage (days)
  const pantryCoverageDays = estimatePantryCoverageDays({
    inventory,
    prefs,
    health,
  });

  // 5) Prep time saved via batch sessions (last 30d)
  const batch30 = batches.filter(
    (b) => (b.completedTs || b.createdTs) >= since30
  );
  const prepSavedMin = estimatePrepSavedMin(batch30, recipes);

  // 6) Waste % (last 30d)
  const waste30 = deltas.filter((d) => d.ts >= since30 && d.reason === "waste");
  const cook30 = deltas.filter((d) => d.ts >= since30 && d.reason === "cook");
  const wasteQty = Math.abs(sum(waste30.map((d) => Number(d.qtyChange || 0))));
  const usedQty = Math.abs(sum(cook30.map((d) => Number(d.qtyChange || 0))));
  const wastePct = usedQty ? wasteQty / (wasteQty + usedQty) : 0;

  // 7) Top recipes (last 30d)
  const top = topRecipes({ logs: logs30, ratings });

  // 8) Shortages forecast next 7 days (planned meals vs inventory)
  const shortages = forecastShortages7d({ mealPlan, inventory, recipes });

  // 9) Meal satisfaction proxy
  const rating30 = ratings.filter((r) => r.ts >= since30);
  const avgRating = avg(rating30.map((r) => r.score || 0)) || 0;

  // 10) Grocery cost trend (last 3 lists)
  const recentGroceries = [...(grocery || [])]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 3);
  const groceryTrend = recentGroceries.map((g) => ({
    ts: g.ts,
    cost: Number(g.totalEstimatedCost || 0),
  }));

  // 11) Servings cooked last 7 & 30 (handy for coalitions)
  const servings7 = sum(completed7.map((l) => Number(l.servings || 0)));

  return {
    ts: now(),
    onPlan: { hits: onPlanHits, planned: plannedCount, pct: round2(onPlanPct) },
    macros: { target, avg7, adherence: macroAdherence },
    cost: {
      cost30: round2(cost30),
      servings30,
      costPerServing: round2(costPerServing),
    },
    pantry: { coverageDays: pantryCoverageDays },
    prep: { savedMin30: Math.round(prepSavedMin) },
    waste: { pct30: round2(wastePct), wastedQty: round2(wasteQty) },
    favorites: top,
    shortages,
    rating: { avg30: round2(avgRating), count30: rating30.length },
    groceryTrend,
    outputs: { servings7, servings30 },
  };
}

/* -----------------------------------------------------------------------------
   Helpers used by snapshot
----------------------------------------------------------------------------- */
function wasPlannedFor(plannedDays, log) {
  // Treat same calendar day match or recipeId presence as a “hit”
  const d = new Date(log.ts);
  d.setHours(0, 0, 0, 0);
  const dayKey = d.getTime();
  return plannedDays.some((p) => {
    const pt = new Date(p.ts || p.dateTs);
    pt.setHours(0, 0, 0, 0);
    return (
      pt.getTime() === dayKey &&
      (p.recipeId ? p.recipeId === log.recipeId : true)
    );
  });
}

function macroTargetFrom(prefs, health) {
  const t = health?.goals?.macros || prefs?.cooking?.macroTargets || {};
  if (t.calories && t.protein && t.carbs && t.fat) return t;
  const weightKg = Number(health?.metrics?.weightKg || 70);
  const calories = Math.round(14 * weightKg);
  const protein = Math.round(1.6 * weightKg); // g/day
  const fat = Math.round((0.3 * calories) / 9); // g/day
  const carbs = Math.round((calories - (protein * 4 + fat * 9)) / 4);
  return { calories, protein, carbs, fat };
}

function sumMacros(logs) {
  return logs.reduce(
    (acc, l) => {
      const m = l.macros || {};
      acc.calories += Number(m.calories || 0);
      acc.protein += Number(m.protein || 0);
      acc.carbs += Number(m.carbs || 0);
      acc.fat += Number(m.fat || 0);
      return acc;
    },
    { calories: 0, protein: 0, carbs: 0, fat: 0 }
  );
}
function scaleMacros(m, k) {
  return {
    calories: m.calories * k,
    protein: m.protein * k,
    carbs: m.carbs * k,
    fat: m.fat * k,
  };
}
function macroAdherencePct(avgPerDay, target) {
  const pct = (a, t) => (t ? clamp(a / t, 0, 2) : 0); // cap 200%
  const p = {
    calories: pct(avgPerDay.calories, target.calories),
    protein: pct(avgPerDay.protein, target.protein),
    carbs: pct(avgPerDay.carbs, target.carbs),
    fat: pct(avgPerDay.fat, target.fat),
  };
  p.overall = round2((p.calories + p.protein + p.carbs + p.fat) / 4);
  return p;
}
function uniqueDays(logs) {
  const s = new Set();
  logs.forEach((l) => {
    const d = new Date(l.ts);
    d.setHours(0, 0, 0, 0);
    s.add(d.getTime());
  });
  return s.size;
}

function estimatePantryCoverageDays({ inventory, prefs }) {
  const items = inventory?.items || [];
  const edible = items.filter(
    (i) => !/cleaner|tool|equipment/i.test(i.category || "")
  );
  const servings = sum(edible.map((i) => Number(i.servings || i.qty || 0)));
  const householdSize = Number(prefs?.household?.members || 2);
  const mealsPerDay = Number(prefs?.cooking?.mealsPerDay || 2);
  const dailyServingsNeeded = Math.max(1, householdSize * mealsPerDay);
  return Math.floor(servings / dailyServingsNeeded);
}

function estimatePrepSavedMin(batches, recipes) {
  if (!batches.length) return 0;
  const byId = new Map((recipes?.all || []).map((r) => [r.id, r]));
  const avgPrep = (ids = []) => {
    const mins = ids.map((id) => Number(byId.get(id)?.prepMin || 20));
    return avg(mins.length ? mins : [20]);
  };
  return batches.reduce((acc, b) => {
    const ids =
      (b.cookedRecipes?.length ? b.cookedRecipes : b.plannedRecipes) || [];
    const perRecipe = avgPrep(ids);
    const cookedServings = Number(b.totalServings || ids.length * 4);
    // batching reduces per-serving prep by ~33%
    return acc + cookedServings * (perRecipe / 3);
  }, 0);
}

function topRecipes({ logs, ratings }) {
  const countById = logs.reduce((acc, l) => {
    acc[l.recipeId] = (acc[l.recipeId] || 0) + 1;
    return acc;
  }, {});
  const avgRatingById = ratings.reduce((acc, r) => {
    const a = acc[r.recipeId] || { sum: 0, n: 0 };
    a.sum += Number(r.score || 0);
    a.n += 1;
    acc[r.recipeId] = a;
    return acc;
  }, {});
  const entries = Object.keys(countById).map((id) => {
    const r = avgRatingById[id] || { sum: 0, n: 0 };
    const rating = r.n ? r.sum / r.n : 0;
    return { recipeId: id, times: countById[id], rating: round2(rating) };
  });
  return entries
    .sort((a, b) => b.times - a.times || b.rating - a.rating)
    .slice(0, 8);
}

function forecastShortages7d({ mealPlan, inventory, recipes }) {
  const byId = new Map((recipes?.all || []).map((r) => [r.id, r]));
  const next7 = (mealPlan?.schedule || []).filter(
    (d) => (d.ts || d.dateTs) <= Date.now() + 7 * dayMs
  );
  const need = {};
  next7.forEach((d) => {
    const r = byId.get(d.recipeId);
    if (!r?.ingredients) return;
    r.ingredients.forEach((ing) => {
      const key = normKey(ing.name || ing.item || "");
      const qty = Number(ing.qty || 1);
      need[key] = (need[key] || 0) + qty * (d.servings || 1);
    });
  });
  const have = {};
  (inventory?.items || []).forEach((i) => {
    const key = normKey(i.name || i.sku || "");
    have[key] = (have[key] || 0) + Number(i.qty || i.servings || 0);
  });
  const shortages = [];
  Object.keys(need).forEach((k) => {
    const delta = (have[k] || 0) - need[k];
    if (delta < 0)
      shortages.push({ item: k, shortBy: Math.abs(round2(delta)) });
  });
  return shortages.sort((a, b) => b.shortBy - a.shortBy).slice(0, 20);
}
function normKey(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

/* -----------------------------------------------------------------------------
   UI Cards (single household dashboard)
----------------------------------------------------------------------------- */
export function toDashboardCards(snapshot) {
  if (!snapshot) return [];
  return [
    {
      id: "on-plan",
      title: "On-Plan (7d)",
      value: `${Math.round(snapshot.onPlan.pct * 100)}%`,
      meta: `${snapshot.onPlan.hits}/${snapshot.onPlan.planned} meals`,
      intent:
        snapshot.onPlan.pct >= 0.7
          ? "success"
          : snapshot.onPlan.pct >= 0.5
          ? "info"
          : "warning",
    },
    {
      id: "macro-adherence",
      title: "Macro Adherence",
      value: `${Math.round((snapshot.macros.adherence.overall || 0) * 100)}%`,
      meta: `P:${Math.round(
        snapshot.macros.adherence.protein * 100
      )} · C:${Math.round(
        snapshot.macros.adherence.carbs * 100
      )} · F:${Math.round(snapshot.macros.adherence.fat * 100)}`,
      intent:
        snapshot.macros.adherence.overall >= 0.9
          ? "success"
          : snapshot.macros.adherence.overall >= 0.7
          ? "info"
          : "warning",
    },
    {
      id: "cost-serving",
      title: "Cost / Serving",
      value: `$${round2(snapshot.cost.costPerServing)}`,
      meta: `30d total: $${round2(snapshot.cost.cost30)} · ${
        snapshot.cost.servings30
      } servings`,
      intent: "info",
    },
    {
      id: "pantry-coverage",
      title: "Pantry Coverage",
      value: `${snapshot.pantry.coverageDays} days`,
      meta: snapshot.shortages.length
        ? `${snapshot.shortages.length} shortages in 7d`
        : "All clear",
      intent:
        snapshot.pantry.coverageDays >= 7
          ? "success"
          : snapshot.pantry.coverageDays >= 3
          ? "info"
          : "warning",
    },
    {
      id: "prep-saved",
      title: "Prep Saved",
      value: `${snapshot.prep.savedMin30} min`,
      meta: "Last 30 days via batch sessions",
      intent: snapshot.prep.savedMin30 > 120 ? "success" : "info",
    },
    {
      id: "waste",
      title: "Waste (30d)",
      value: `${Math.round(snapshot.waste.pct30 * 100)}%`,
      meta: `${snapshot.waste.wastedQty} units discarded`,
      intent:
        snapshot.waste.pct30 <= 0.05
          ? "success"
          : snapshot.waste.pct30 <= 0.12
          ? "info"
          : "warning",
    },
  ];
}

/* =============================================================================
   COALITIONS — Multiple households for shared cooking goals
   Coalition shape (flexible):
     {
       id, name, type:'cooking_coalition'|'coalition',
       members: [{ userId, displayName }],
       pooledDemand: { servingsPerWeek?: number, event?: { dateTs, targetServings } },
       targets?: { servings?: number, costBudget?: number }, // optional horizon goals
       fairness?: { basis:'servings'|'cost'|'time' }         // default 'servings'
     }
============================================================================= */

// Resolve another member's “kitchen” data
async function getMemberKitchen(userId) {
  try {
    return await CoalitionStore?.getMemberKitchen?.(userId);
  } catch {}
  try {
    return await GroupStore?.getMemberKitchen?.(userId);
  } catch {}
  // Fallback to cache if some agent already seeded it
  try {
    return coalitionCache.get()[`kitchen:${userId}`] || null;
  } catch {
    return null;
  }
}

/**
 * computeCoalitionCookingSnapshot — aggregate independent households
 * toward pooled goals (events, food trains, etc.)
 * memberResolver should return: { prefs, health, mealPlan, inventory, recipes, calendar }
 */
export async function computeCoalitionCookingSnapshot({
  coalitionId,
  horizonDays = 30,
  memberResolver = getMemberKitchen,
  coalitions = readCoalitions(),
  groups = readGroups(),
} = {}) {
  if (!coalitionId) return null;

  const coalition = (coalitions.coalitions || []).find(
    (c) => String(c.id) === String(coalitionId)
  ) ||
    (groups.groups || []).find(
      (g) =>
        String(g.id) === String(coalitionId) &&
        (g.type === "cooking_coalition" ||
          g.type === "coalition" ||
          g.kind === "coalition")
    ) || {
      id: coalitionId,
      name: "Cooking Coalition",
      members: [],
      pooledDemand: {},
      targets: {},
      fairness: { basis: "servings" },
    };

  const members = coalition.members || [];
  const memberSnaps = [];

  for (const m of members) {
    const ctx = await memberResolver(m.userId);
    if (!ctx) {
      memberSnaps.push({
        userId: m.userId,
        name: m.displayName || m.userId,
        error: "unavailable",
      });
      continue;
    }

    const snap = computeCookingSnapshot({
      prefs: ctx.prefs || {},
      health: ctx.health || {},
      mealPlan: ctx.mealPlan || {},
      inventory: ctx.inventory || {},
      recipes: ctx.recipes || {},
      calendar: ctx.calendar || {},
    });

    memberSnaps.push({
      userId: m.userId,
      name: m.displayName || m.userId,
      snapshot: snap,
    });
  }

  const agg = aggregateCoalitionCooking(memberSnaps, coalition, horizonDays);
  const alerts = buildCoalitionCookingAlerts(agg);

  return {
    ts: now(),
    scope: "coalition-cooking",
    coalitionId,
    name: coalition.name,
    horizonDays,
    members: memberSnaps,
    pooled: agg.pooled, // servings, shortages, cost, pantry coverage
    fairness: agg.fairness, // contribution balance
    coordination: agg.coord, // dish assignments, swaps, grocery consolidation
    alerts,
  };
}

function aggregateCoalitionCooking(memberSnaps, coalition, horizonDays) {
  const pooled = {
    servings7: 0,
    servings30: 0,
    cost30: 0,
    avgCostPerServing30: 0,
    pantryCoverageMinDays: null,
    shortages7: [], // merged list
  };

  const perMember = [];

  // Merge shortages by item
  const needMap = new Map();

  for (const m of memberSnaps) {
    const s = m.snapshot;
    if (!s) continue;

    pooled.servings7 += Number(s.outputs?.servings7 || 0);
    pooled.servings30 += Number(s.outputs?.servings30 || 0);
    pooled.cost30 += Number(s.cost?.cost30 || 0);

    const coverage = Number(s.pantry?.coverageDays || 0);
    pooled.pantryCoverageMinDays =
      pooled.pantryCoverageMinDays == null
        ? coverage
        : Math.min(pooled.pantryCoverageMinDays, coverage);

    (s.shortages || []).forEach((sh) => {
      const k = sh.item;
      needMap.set(k, (needMap.get(k) || 0) + Number(sh.shortBy || 0));
    });

    // Contribution basis
    const basis = coalition?.fairness?.basis || "servings";
    const basisValue =
      basis === "cost"
        ? Number(s.cost?.cost30 || 0)
        : basis === "time"
        ? Number(s.prep?.savedMin30 || 0) // treat “saved” as contributed capacity
        : Number(s.outputs?.servings30 || 0);

    perMember.push({
      userId: m.userId,
      name: m.name,
      basisValue: round2(basisValue),
    });
  }

  pooled.avgCostPerServing30 = pooled.servings30
    ? round2(pooled.cost30 / pooled.servings30)
    : 0;
  pooled.shortages7 = Array.from(needMap.entries())
    .map(([item, shortBy]) => ({ item, shortBy: round2(shortBy) }))
    .sort((a, b) => b.shortBy - a.shortBy);

  // Demand over horizon (approx 4w) or event target
  const weeks = 4;
  const demandServings =
    Number(coalition?.pooledDemand?.servingsPerWeek || 0) * weeks ||
    Number(coalition?.targets?.servings || 0);

  const surplusDeficit = {
    servings: round2((pooled.servings30 || 0) - demandServings),
    costBudgetDelta:
      coalition?.targets?.costBudget != null
        ? round2((coalition.targets.costBudget || 0) - (pooled.cost30 || 0))
        : null,
  };

  const fairness = coalitionFairnessCooking(perMember, coalition);
  const coord = coalitionCoordinationCooking({
    memberSnaps,
    coalition,
    pooled,
    demandServings,
  });

  return { pooled, fairness, coord };
}

function coalitionFairnessCooking(perMember, coalition) {
  const basis = coalition?.fairness?.basis || "servings";
  const values = perMember.map((m) => Number(m.basisValue || 0));
  const mean = avg(values);
  const mad = avg(values.map((v) => Math.abs(v - mean)));
  const imbalanceIdx = mean ? round2(mad / mean) : 0;

  // Optional absolute target split (even share)
  let perMemberTarget = null;
  if (coalition?.targets?.servings) {
    perMemberTarget = perMember.length
      ? round2(coalition.targets.servings / perMember.length)
      : null;
  }

  const members = perMember.map((m) => ({
    ...m,
    target: perMemberTarget,
    deltaToTarget:
      perMemberTarget != null ? round2(m.basisValue - perMemberTarget) : null,
  }));

  return { basis, mean: round2(mean), imbalanceIdx, members };
}

function coalitionCoordinationCooking({
  memberSnaps,
  coalition,
  pooled,
  demandServings,
}) {
  const suggestions = [];

  // 1) If we’re short on servings, assign dishes from members with capacity (high pantry coverage or high batch time saved)
  const shortBy = Math.max(0, (demandServings || 0) - (pooled.servings30 || 0));
  if (shortBy > 0) {
    const ranked = [...memberSnaps]
      .map((m) => ({
        userId: m.userId,
        name: m.name,
        coverage: m.snapshot?.pantry?.coverageDays || 0,
        saved: m.snapshot?.prep?.savedMin30 || 0,
      }))
      .sort((a, b) => b.coverage - a.coverage || b.saved - a.saved);

    let remaining = shortBy;
    for (const r of ranked) {
      if (remaining <= 0) break;
      const alloc = round2(
        Math.max(4, Math.min(remaining, Math.floor((r.coverage / 2) * 2)))
      ); // rough: coverage/2 meals
      if (alloc > 0) {
        suggestions.push({
          type: "assign",
          toUserId: r.userId,
          toName: r.name,
          servings: alloc,
          note: "Prepare extra tray/batch for the event",
        });
        remaining = round2(remaining - alloc);
      }
    }
    if (remaining > 0) {
      suggestions.push({
        type: "purchase",
        servings: remaining,
        note: "Fill gap via catering or store-bought trays",
      });
    }
  }

  // 2) Shortage swaps: items needed by one, surplus in another (heuristic via pantry coverage)
  const itemsNeeded = new Map();
  memberSnaps.forEach((m) =>
    (m.snapshot?.shortages || []).forEach((s) => {
      itemsNeeded.set(s.item, (itemsNeeded.get(s.item) || 0) + s.shortBy);
    })
  );
  // Suggest grocery consolidation if many small shortages
  const totalShortItems = Array.from(itemsNeeded.values()).filter(
    (x) => x > 0
  ).length;
  if (totalShortItems >= 5) {
    suggestions.push({
      type: "consolidate_grocery",
      note: "Many items short across members; create one consolidated list & split cost.",
    });
  }

  // 3) Normalize dish types by ratings (ask high-rated members to cook crowd-pleasers)
  const favorites = memberSnaps.map((m) => m.snapshot?.favorites || []).flat();
  const topRecipeId = favorites.sort(
    (a, b) => b.rating - a.rating || b.times - a.times
  )[0]?.recipeId;
  if (topRecipeId) {
    suggestions.push({
      type: "feature_dish",
      recipeId: topRecipeId,
      note: "High-rated dish — assign to 2–3 members to ensure crowd-pleaser coverage.",
    });
  }

  return { suggestions };
}

function buildCoalitionCookingAlerts(agg) {
  const alerts = [];
  const sd = agg?.pooled
    ? (agg.pooled.servings30 || 0) - (agg?.pooled?.demandServings || 0)
    : 0; // demandServings held only during aggregate step
  const fairnessImb = agg?.fairness?.imbalanceIdx || 0;

  if (
    agg?.pooled &&
    agg.pooled.pantryCoverageMinDays != null &&
    agg.pooled.pantryCoverageMinDays < 3
  ) {
    alerts.push({
      level: "warning",
      code: "PANTRY_LOW",
      message:
        "Some households have low pantry coverage (<3 days). Reassign dishes or consolidate grocery.",
      actions: [
        { label: "Open Coordination", topic: "cooking.coalition.coord.open" },
      ],
    });
  }
  if (sd < 0) {
    alerts.push({
      level: "warning",
      code: "SERVINGS_DEFICIT",
      message:
        "Coalition servings likely below target. Assign trays or purchase fill-ins.",
      actions: [
        { label: "Assign Dishes", topic: "cooking.coalition.assign.open" },
      ],
    });
  }
  if (fairnessImb > 0.35) {
    alerts.push({
      level: "info",
      code: "FAIRNESS_IMBALANCE",
      message: "Contribution imbalance detected across households.",
      actions: [
        { label: "Rebalance Plan", topic: "cooking.coalition.balance.open" },
      ],
    });
  }
  if ((agg?.pooled?.shortages7?.length || 0) >= 6) {
    alerts.push({
      level: "info",
      code: "WIDE_SHORTAGES",
      message:
        "Widespread shortages predicted; consolidate grocery purchasing.",
      actions: [
        {
          label: "Consolidate List",
          topic: "grocery.coalition.generate",
          payload: { horizonDays: 7 },
        },
      ],
    });
  }
  return alerts;
}

/* -----------------------------------------------------------------------------
   Event-driven analytics bus
----------------------------------------------------------------------------- */
class CookingAnalytics extends EventEmitter {
  constructor() {
    super();
    this._snapshot = storage.get();
    this._coalitions = coalitionCache.get(); // { [id]: snapshot }
    this._hooked = false;
  }
  get snapshot() {
    return this._snapshot;
  }
  get coalitionSnaps() {
    return this._coalitions;
  }

  recompute() {
    const snap = computeCookingSnapshot({});
    this._snapshot = snap;
    storage.set(snap);

    this.emit("updated", snap);
    automation?.emitEvent?.("cooking.analytics.updated", { snapshot: snap });

    try {
      this._maybeNBA(snap);
    } catch {}
    return snap;
  }

  async recomputeCoalition(coalitionId) {
    const snap = await computeCoalitionCookingSnapshot({ coalitionId });
    if (!snap) return null;
    this._coalitions[coalitionId] = snap;
    coalitionCache.set(this._coalitions);

    this.emit("coalition.updated", { coalitionId, snapshot: snap });
    automation?.emitEvent?.("cooking.coalition.analytics.updated", {
      coalitionId,
      snapshot: snap,
    });

    try {
      this._maybeNBACoalition(snap);
    } catch {}
    return snap;
  }

  _maybeNBA(snap) {
    if (!automation?.emitEvent) return;

    // Shortages → generate grocery
    if (snap.shortages.length) {
      automation.emitEvent("nba", {
        topic: "nba",
        kind: "shortage",
        message: `${snap.shortages.length} shortages predicted in 7 days. Generate grocery list?`,
        actions: [
          {
            label: "Generate List",
            topic: "grocery.generate.request",
            payload: { horizonDays: 7 },
          },
          { label: "Swap Meals", topic: "meals.plan.swap.suggestions.open" },
        ],
        ts: now(),
      });
    }

    // Low on-plan → suggest batch session
    if (snap.onPlan.pct < 0.6) {
      automation.emitEvent("nba", {
        topic: "nba",
        kind: "batch-suggest",
        message:
          "You’ve been off-plan. Want to schedule a 60-minute batch session?",
        actions: [
          {
            label: "Plan Batch",
            topic: "batch.plan.request",
            payload: { durationMin: 60 },
          },
          { label: "Review Plan", topic: "meals.plan.open" },
        ],
        ts: now(),
      });
    }

    // Waste high → preservation/trimming tips
    if (snap.waste.pct30 > 0.12) {
      automation.emitEvent("nba", {
        topic: "nba",
        kind: "waste-high",
        message:
          "Waste is trending high. Queue a preservation session or adjust portions?",
        actions: [
          { label: "Preservation Queue", topic: "preservation.queue.open" },
          { label: "Adjust Portions", topic: "meals.portions.adjust.open" },
        ],
        ts: now(),
      });
    }
  }

  _maybeNBACoalition(coalSnap) {
    if (!automation?.emitEvent) return;

    const deficits =
      (coalSnap?.pooled?.servings30 || 0) <
      (coalSnap?.pooled?.demandServings || 0);
    if (deficits) {
      automation.emitEvent("nba", {
        topic: "nba",
        kind: "cooking-coalition-deficit",
        message: `Coalition servings likely below target. Assign trays or consolidate grocery?`,
        actions: [
          {
            label: "Assign Dishes",
            topic: "cooking.coalition.assign.open",
            payload: { coalitionId: coalSnap.coalitionId },
          },
          {
            label: "Consolidate Grocery",
            topic: "grocery.coalition.generate",
            payload: { coalitionId: coalSnap.coalitionId, horizonDays: 7 },
          },
        ],
        ts: now(),
      });
    }

    if ((coalSnap?.fairness?.imbalanceIdx || 0) > 0.35) {
      automation.emitEvent("nba", {
        topic: "nba",
        kind: "cooking-coalition-fairness",
        message:
          "Contribution imbalance across households. Rebalance assignments?",
        actions: [
          {
            label: "Rebalance Plan",
            topic: "cooking.coalition.balance.open",
            payload: { coalitionId: coalSnap.coalitionId },
          },
        ],
        ts: now(),
      });
    }
  }

  hookEvents() {
    if (this._hooked) return;
    this._hooked = true;

    const watch = (topic) =>
      automation?.onTopic?.(topic, () => {
        try {
          this.recompute();
        } catch {}
      });

    [
      "meals.plan.updated",
      "meals.plan.applied",
      "recipe.added",
      "recipe.updated",
      "recipe.rating.logged",
      "batch.session.created",
      "batch.session.completed",
      "inventory.updated",
      "inventory.delta",
      "grocery.list.generated",
      "cooking.timer.finished",
      "cooking.meal.logged",
    ].forEach((t) => watch(t));

    // Coalition changes
    const coalTopics = [
      "coalition.membership.updated",
      "coalition.targets.updated",
      "coalition.demand.updated",
      "coalition.memberKitchen.updated",
    ];
    coalTopics.forEach((t) =>
      automation?.onTopic?.(t, async (evt) => {
        const cid = evt?.payload?.coalitionId;
        if (cid)
          try {
            await this.recomputeCoalition(cid);
          } catch {}
      })
    );

    // Fallback local bus
    if (eventBus?.on) {
      [
        "meals.plan.updated",
        "batch.session.completed",
        "inventory.updated",
        "grocery.list.generated",
        "cooking.meal.logged",
        ...coalTopics,
      ].forEach((t) =>
        eventBus.on(t, async (payload) => {
          const cid = payload?.coalitionId ?? null;
          if (cid) await this.recomputeCoalition(cid);
          else this.recompute();
        })
      );
    }
  }
}

export const cookingAnalytics = new CookingAnalytics();

/* -----------------------------------------------------------------------------
   Automation templates & triggers
----------------------------------------------------------------------------- */
function registerAutomationTemplates() {
  if (!automation?.registerTemplate) return;

  automation.register([
    {
      id: "cooking.daily-kpis",
      title: "Cooking: Daily KPIs",
      description:
        "Compute daily cooking KPIs; drive NBA for shortages or waste.",
      tags: ["cooking", "analytics"],
      schedule: { at: "08:00" },
      timeoutMs: 12000,
      async run({ emit }) {
        const snap = cookingAnalytics.recompute();
        emit?.("cooking.analytics.daily", { snapshot: snap });
        return { ok: true, snapshot: snap };
      },
    },
    {
      id: "cooking.weekly-forecast",
      title: "Cooking: Weekly Shortage Forecast",
      description:
        "Predict 7-day shortages from plan vs pantry; propose grocery list.",
      tags: ["cooking", "analytics", "forecast"],
      schedule: { days: [0], at: "09:00" }, // Sundays
      timeoutMs: 15000,
      async run({ emit }) {
        const snap = cookingAnalytics.snapshot || computeCookingSnapshot({});
        if (snap.shortages?.length) {
          emit?.("nba", {
            topic: "nba",
            kind: "shortage",
            message: `Weekly check: ${snap.shortages.length} shortages predicted. Generate grocery list?`,
            actions: [
              {
                label: "Generate List",
                topic: "grocery.generate.request",
                payload: { horizonDays: 7 },
              },
            ],
            ts: now(),
          });
        }
        return { ok: true, shortages: snap.shortages || [] };
      },
    },
    {
      id: "cooking.end-of-day-log-nudge",
      title: "Cooking: End-of-Day Log Nudge",
      description: "If meals cooked but unlogged macros remain, nudge to log.",
      tags: ["cooking", "nudges"],
      schedule: { at: "20:30" },
      timeoutMs: 8000,
      async run({ emit }) {
        const snap = cookingAnalytics.snapshot || computeCookingSnapshot({});
        const adherence = snap.macros?.adherence?.overall ?? 1;
        if (adherence < 0.8) {
          emit?.("nba", {
            topic: "nba",
            kind: "macro-log",
            message: "Macros look incomplete. Log dinner or snacks?",
            actions: [{ label: "Log Meal", topic: "cooking.meal.log.open" }],
            ts: now(),
          });
        }
        return { ok: true };
      },
    },
    {
      id: "cooking.coalition-daily-kpis",
      title: "Cooking: Coalition KPIs",
      description:
        "Aggregate multi-household analytics for shared goals (events, food trains).",
      tags: ["cooking", "analytics", "coalition"],
      schedule: { at: "08:10" },
      timeoutMs: 30000,
      async run({ emit }) {
        const coalitions = (readCoalitions().coalitions || []).concat(
          (readGroups().groups || []).filter(
            (g) =>
              g.type === "cooking_coalition" ||
              g.type === "coalition" ||
              g.kind === "coalition"
          )
        );
        for (const c of coalitions) {
          const snap = await cookingAnalytics.recomputeCoalition(c.id);
          emit?.("cooking.coalition.analytics.daily", {
            coalitionId: c.id,
            snapshot: snap,
          });
        }
        return { ok: true, coalitions: coalitions.length };
      },
    },
  ]);

  // Triggers
  automation.registerTrigger(() => {
    const topics = [
      "meals.plan.updated",
      "recipe.rating.logged",
      "batch.session.completed",
      "inventory.updated",
      "grocery.list.generated",
      "cooking.meal.logged",
      "inventory.delta",
      "coalition.membership.updated",
      "coalition.targets.updated",
      "coalition.demand.updated",
      "coalition.memberKitchen.updated",
    ];
    const unsubs = topics.map((t) =>
      automation.onTopic?.(t, async (evt) => {
        const cid = evt?.payload?.coalitionId ?? null;
        if (cid) await cookingAnalytics.recomputeCoalition(cid);
        else cookingAnalytics.recompute();
      })
    );
    return () => unsubs.forEach((u) => u?.());
  });
}

registerAutomationTemplates();
cookingAnalytics.hookEvents();

/* -----------------------------------------------------------------------------
   Public helpers for consumers (pages/components)
----------------------------------------------------------------------------- */
export function getSnapshot() {
  return cookingAnalytics.snapshot || cookingAnalytics.recompute();
}
export function getDashboardCards() {
  return toDashboardCards(getSnapshot());
}
export async function getCoalitionSnapshot(coalitionId) {
  return (
    cookingAnalytics.coalitionSnaps?.[coalitionId] ||
    (await cookingAnalytics.recomputeCoalition(coalitionId))
  );
}
export function toCoalitionCards(coalSnap) {
  if (!coalSnap) return [];
  const pantryMin = coalSnap.pooled?.pantryCoverageMinDays ?? 0;
  const deficits =
    (coalSnap.pooled?.servings30 || 0) < (coalSnap.pooled?.demandServings || 0);
  const imb = coalSnap.fairness?.imbalanceIdx || 0;
  return [
    {
      id: "coalition-servings",
      title: "Coalition · Servings",
      value: `${Math.round(coalSnap.pooled?.servings30 || 0)}`,
      meta: "30-day servings across households",
      intent: "info",
    },
    {
      id: "coalition-balance",
      title: "Coalition · Balance",
      value: deficits ? "Below Target" : "On Track",
      meta: "Servings vs pooled demand/target",
      intent: deficits ? "warning" : "success",
    },
    {
      id: "coalition-fairness",
      title: "Coalition · Fairness",
      value: `${Math.round(imb * 100)} MAD%`,
      meta: "Contribution balance (lower is better)",
      intent: imb > 0.35 ? "warning" : imb > 0.2 ? "info" : "success",
    },
    {
      id: "coalition-pantry",
      title: "Coalition · Pantry Floor",
      value: `${pantryMin} days`,
      meta: "Min pantry coverage among members",
      intent: pantryMin < 3 ? "warning" : "info",
    },
  ];
}
export function exportCookingAnalytics({
  format = "json",
  coalitionId = null,
} = {}) {
  if (coalitionId) {
    const snap = cookingAnalytics.coalitionSnaps?.[coalitionId];
    if (!snap) return null;
    if (format === "json") return safeJSON.stringify(snap);
    if (format === "csv") {
      const row = [
        ["ts", snap.ts],
        ["scope", snap.scope],
        ["coalitionId", snap.coalitionId],
        ["servings30", snap.pooled?.servings30 ?? 0],
        ["cost30", snap.pooled?.cost30 ?? 0],
        ["avgCPS30", snap.pooled?.avgCostPerServing30 ?? 0],
        ["pantryMinDays", snap.pooled?.pantryCoverageMinDays ?? 0],
        ["shortagesCount7", snap.pooled?.shortages7?.length ?? 0],
        ["imbalanceIdx", snap.fairness?.imbalanceIdx ?? 0],
      ];
      return row.map((r) => r.join(",")).join("\n");
    }
    return null;
  }

  const snap = getSnapshot();
  if (format === "json") return safeJSON.stringify(snap);
  if (format === "csv") {
    const rows = [
      ["ts", snap.ts],
      ["onPlanPct", Math.round((snap.onPlan.pct || 0) * 100)],
      ["costPerServing", round2(snap.cost.costPerServing)],
      ["pantryCoverageDays", snap.pantry.coverageDays],
      ["prepSavedMin30", snap.prep.savedMin30],
      ["wastePct30", Math.round((snap.waste.pct30 || 0) * 100)],
      [
        "macroAdherence",
        Math.round((snap.macros.adherence.overall || 0) * 100),
      ],
      ["shortagesCount", (snap.shortages || []).length],
      ["avgRating30", snap.rating.avg30],
      ["servings7", snap.outputs?.servings7 || 0],
      ["servings30", snap.outputs?.servings30 || 0],
    ];
    return rows.map((r) => r.join(",")).join("\n");
  }
  return null;
}
