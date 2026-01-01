// C:\Users\larho\suka-smart-assistant\src\services\analytics\mealPlanAnalytics.js
/* ============================================================================
   mealPlanAnalytics — Planning KPIs, forecasts, coalitions & nudges
   - Event-driven & defensive (works even if some Stores/Agents are absent)
   - UI-ready dashboard cards + “Next Best Action” (NBA) suggestions
   - Ties together: Meal Plans, Recipe Vault, Inventory, Preferences, Calendar
   - Computes (single household): plan adherence, horizon coverage, grocery delta,
       macro coverage, variety score, repeat rate, prep load balance
   - Coalitions (multi-household): adoption, menu overlap (shared family plans),
       fairness, coordination (anchor dinners / bulk-prep), marketplace analytics
       for creators (bundles, revenue roll-ups, “fit” across buyer types)
   - Automation Runtime integration (daily/weekly schedules + triggers)
   - Inspired by clean analytics UX (Linear, Notion, Shopify)
============================================================================ */

import EventEmitter from "eventemitter3";

/* -----------------------------------------------------------------------------
   Defensive optional imports (no hard coupling)
----------------------------------------------------------------------------- */
let automation;
let eventBus;
let PreferencesStore, MealPlanStore, InventoryStore, RecipeStore, HealthStore, CalendarStore;
let CoalitionStore, GroupStore, MarketplaceStore, PaymentsStore;
try { ({ automation } = await import("@/services/automation/runtime")); } catch {}
try { ({ eventBus } = await import("@/services/events/eventBus")); } catch {}
try { ({ usePreferencesStore: PreferencesStore } = await import("@/store/PreferencesStore")); } catch {}
try { ({ useMealPlanStore: MealPlanStore } = await import("@/store/MealPlanStore")); } catch {}
try { ({ useInventoryStore: InventoryStore } = await import("@/store/InventoryStore")); } catch {}
try { ({ useRecipeStore: RecipeStore } = await import("@/store/RecipeStore")); } catch {}
try { ({ useHealthStore: HealthStore } = await import("@/store/HealthStore")); } catch {}
try { ({ useCalendarStore: CalendarStore } = await import("@/store/CalendarStore")); } catch {}
try { ({ useCoalitionStore: CoalitionStore } = await import("@/store/CoalitionStore")); } catch {}
try { ({ useGroupStore: GroupStore } = await import("@/store/GroupStore")); } catch {}
try { ({ useMarketplaceStore: MarketplaceStore } = await import("@/store/MarketplaceStore")); } catch {}
try { ({ usePaymentsStore: PaymentsStore } = await import("@/store/PaymentsStore")); } catch {}

/* -----------------------------------------------------------------------------
   Small utils
----------------------------------------------------------------------------- */
const isBrowser = typeof window !== "undefined";
const now = () => Date.now();
const dayMs = 86_400_000;
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const round2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const avg = (xs) => (xs.length ? sum(xs) / xs.length : 0);

const safeJSON = {
  parse: (s, f = null) => { try { return JSON.parse(s); } catch { return f; } },
  stringify: (o) => { try { return JSON.stringify(o); } catch { return ""; } },
};

const storage = (() => {
  const key = "suka::mealPlanAnalytics::snap";
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
  const key = "suka::mealPlanAnalytics::coalitions";
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
function readPrefs()      { try { return PreferencesStore?.() || {}; } catch { return {}; } }
function readHealth()     { try { return HealthStore?.() || {}; } catch { return {}; } }
function readMealPlan()   { try { return MealPlanStore?.() || {}; } catch { return {}; } }
function readInventory()  { try { return InventoryStore?.() || {}; } catch { return {}; } }
function readRecipes()    { try { return RecipeStore?.() || {}; } catch { return {}; } }
function readCalendar()   { try { return CalendarStore?.() || {}; } catch { return {}; } }
function readCoalitions() { try { return CoalitionStore?.() || { coalitions: [] }; } catch { return { coalitions: [] }; } }
function readGroups()     { try { return GroupStore?.() || { groups: [] }; } catch { return { groups: [] }; } }
function readMarketplace(){ try { return MarketplaceStore?.() || { listings: [], sales: [] }; } catch { return { listings: [], sales: [] }; } }
function readPayments()   { try { return PaymentsStore?.() || { payouts: [] }; } catch { return { payouts: [] }; } }

/* -----------------------------------------------------------------------------
   Shapes we analyze (defensive, optional):
   - mealPlan.schedule: [{ ts/dateTs, recipeId, mealType, servings, planId? }]
   - mealPlan.logs:     [{ ts, recipeId, servings, cost, macros, durationMin }]
   - inventory.items:   [{ name, sku, qty, servings }]
   - recipes.all:       [{ id, name, cuisine, protein, prepMin, servings, macros, ingredients: [{name, qty}] }]
   - marketplace:       { listings: [{planId, title, price, createdTs, authorId}], sales: [{planId, buyerId, ts, price}] }
----------------------------------------------------------------------------- */

/* =============================================================================
   SINGLE-HOUSEHOLD SNAPSHOT
============================================================================= */
export function computeMealPlanSnapshot({
  prefs = readPrefs(),
  health = readHealth(),
  mealPlan = readMealPlan(),
  inventory = readInventory(),
  recipes = readRecipes(),
  calendar = readCalendar(),
} = {}) {
  const schedule = mealPlan?.schedule || [];
  const logs = mealPlan?.logs || [];
  const recipeById = new Map((recipes?.all || []).map(r => [r.id, r]));

  const horizonDays = Number(prefs?.cooking?.planHorizonDays || 7);
  const since7 = Date.now() - 7 * dayMs;
  const since30 = Date.now() - 30 * dayMs;

  // 1) Adherence (planned vs actually cooked, last 7d)
  const planned7 = schedule.filter(d => (d.ts || d.dateTs) >= since7);
  const cooked7  = logs.filter(l => l.ts >= since7);
  const hits7 = cooked7.filter(l => wasPlannedFor(planned7, l)).length;
  const onPlanPct = planned7.length ? hits7 / planned7.length : 0;

  // 2) Horizon coverage (days with any meal within horizon)
  const nextHorizon = schedule.filter(d => (d.ts || d.dateTs) <= (Date.now() + horizonDays * dayMs));
  const coverageDays = countDaysWithMeals(nextHorizon);

  // 3) Grocery budget delta (last 30d planned est vs logged cost)
  const plannedCost30 = estimatePlannedCost(schedule.filter(d => (d.ts || d.dateTs) >= since30), recipeById);
  const loggedCost30  = sum(logs.filter(l => l.ts >= since30).map(l => Number(l.cost || 0)));
  const groceryDelta30 = round2((plannedCost30 || 0) - (loggedCost30 || 0)); // positive = under budget

  // 4) Macro coverage vs target (avg per-day coverage implied by plan next horizon)
  const macroTarget = macroTargetFrom(prefs, health);
  const plannedMacros = estimatePlannedMacros(nextHorizon, recipeById);
  const perDayPlanned = scaleMacros(plannedMacros, 1 / Math.max(1, coverageDays));
  const macroCoverage = macroAdherencePct(perDayPlanned, macroTarget);

  // 5) Variety score (distinct cuisines & proteins planned in horizon)
  const { varietyScore, cuisines, proteins } = computeVariety(nextHorizon, recipeById);

  // 6) Repeat rate in horizon
  const repeatRate = computeRepeatRate(nextHorizon.map(d => d.recipeId));

  // 7) Prep load balance
  const prepBalance = computePrepBalance(nextHorizon, recipeById);

  // 8) Plan outline for coalitions/creators
  const horizonRecipeIds = Array.from(new Set(nextHorizon.map(d => d.recipeId).filter(Boolean)));
  const avgServingsPlanned = avg(nextHorizon.map(d => Number(d.servings || 0)).filter(Boolean)) || 0;

  // 9) Upcoming calendar conflicts
  const conflicts = estimateConflicts(nextHorizon, calendar);

  // 10) Marketplace summary (if selling)
  const market = summarizeMarketplace(mealPlan?.activePlanId, readMarketplace(), readPayments());

  return {
    ts: now(),
    horizonDays,
    adherence: { hits7, planned7: planned7.length, onPlanPct: round2(onPlanPct) },
    coverage: { daysWithMeals: coverageDays },
    grocery:  { plannedCost30: round2(plannedCost30), actualCost30: round2(loggedCost30), delta30: groceryDelta30 },
    macros:   { target: macroTarget, perDayPlanned, coverage: macroCoverage },
    variety:  { score: varietyScore, cuisines, proteins, repeatRate: round2(repeatRate) },
    prep:     { balanceStd: round2(prepBalance.std), avgDailyPrepMin: round2(prepBalance.avg) },
    conflicts,
    marketplace: market,
    plan: { horizonRecipeIds, avgServingsPlanned }, // NEW
  };
}

/* --------------------------------- Helpers --------------------------------- */
function wasPlannedFor(plannedDays, log) {
  const d = new Date(log.ts); d.setHours(0,0,0,0);
  const dayKey = d.getTime();
  return plannedDays.some(p => {
    const pt = new Date(p.ts || p.dateTs); pt.setHours(0,0,0,0);
    return pt.getTime() === dayKey && (!p.recipeId || p.recipeId === log.recipeId);
  });
}
function countDaysWithMeals(entries=[]) {
  const s = new Set();
  entries.forEach(d => { const t = new Date(d.ts || d.dateTs); t.setHours(0,0,0,0); s.add(t.getTime()); });
  return s.size;
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
function scaleMacros(m, k) {
  return { calories: m.calories * k, protein: m.protein * k, carbs: m.carbs * k, fat: m.fat * k };
}
function macroAdherencePct(avgPerDay, target) {
  const pct = (a, t) => (t ? clamp(a / t, 0, 2) : 0);
  const p = {
    calories: pct(avgPerDay.calories, target.calories),
    protein:  pct(avgPerDay.protein,  target.protein),
    carbs:    pct(avgPerDay.carbs,    target.carbs),
    fat:      pct(avgPerDay.fat,      target.fat),
  };
  p.overall = round2((p.calories + p.protein + p.carbs + p.fat) / 4);
  return p;
}
function estimatePlannedCost(entries, recipeById) {
  return sum(entries.map(e => {
    const r = recipeById.get(e.recipeId);
    if (!r) return 0;
    const cost = Number(r.costEstimate || 0) || (Number(r.prepMin || 20) * 0.3);
    const servings = Number(e.servings || 4);
    return cost * (servings / Number(r.servings || 4));
  }));
}
function estimatePlannedMacros(entries, recipeById) {
  return entries.reduce((acc, e) => {
    const r = recipeById.get(e.recipeId) || {};
    const base = r.macros || {};
    const factor = (e.servings || 4) / Number(r.servings || 4);
    acc.calories += Number(base.calories || 0) * factor;
    acc.protein  += Number(base.protein  || 0) * factor;
    acc.carbs    += Number(base.carbs    || 0) * factor;
    acc.fat      += Number(base.fat      || 0) * factor;
    return acc;
  }, { calories: 0, protein: 0, carbs: 0, fat: 0 });
}
function computeVariety(entries, recipeById) {
  const cuisines = new Set(); const proteins = new Set();
  entries.forEach(e => {
    const r = recipeById.get(e.recipeId) || {};
    if (r.cuisine) cuisines.add(r.cuisine.toLowerCase());
    if (r.protein) proteins.add(r.protein.toLowerCase());
  });
  const c = cuisines.size; const p = proteins.size;
  const score = Math.min(100, Math.round(((c + p) / Math.max(2, entries.length / 2)) * 50));
  return { varietyScore: score, cuisines: Array.from(cuisines), proteins: Array.from(proteins) };
}
function computeRepeatRate(recipeIds=[]) {
  const counts = recipeIds.reduce((m, id) => (m[id] = (m[id] || 0) + 1, m), {});
  const repeats = Object.values(counts).filter(n => n > 1).reduce((a, b) => a + (b - 1), 0);
  return recipeIds.length ? repeats / recipeIds.length : 0;
}
function computePrepBalance(entries, recipeById) {
  const perDay = new Map();
  entries.forEach(e => {
    const key = dayKey(e.ts || e.dateTs);
    const r = recipeById.get(e.recipeId) || {};
    const mins = Number(r.prepMin || 20) * (Number(e.servings || 4) / Number(r.servings || 4));
    perDay.set(key, (perDay.get(key) || 0) + mins);
  });
  const arr = Array.from(perDay.values());
  const mean = avg(arr);
  const variance = arr.length ? avg(arr.map(x => (x - mean) ** 2)) : 0;
  return { avg: mean, std: Math.sqrt(variance) };
}
function dayKey(ts) { const d = new Date(ts); d.setHours(0,0,0,0); return d.getTime(); }
function estimateConflicts(entries, calendar) {
  const events = calendar?.events || [];
  const windowStartH = 17, windowEndH = 19;
  const byDay = new Set(entries.map(e => dayKey(e.ts || e.dateTs)));
  return events
    .filter(ev => {
      const start = new Date(ev.startTs || ev.start).getTime();
      const end   = new Date(ev.endTs || ev.end).getTime();
      const d = new Date(start); const k = (d.setHours(0,0,0,0), d.getTime());
      if (!byDay.has(k)) return false;
      const ws = new Date(k); ws.setHours(windowStartH,0,0,0);
      const we = new Date(k); we.setHours(windowEndH,0,0,0);
      return Math.max(start, ws.getTime()) < Math.min(end, we.getTime());
    })
    .map(ev => ({ title: ev.title, startTs: ev.startTs || ev.start, endTs: ev.endTs || ev.end }));
}
function summarizeMarketplace(activePlanId, marketplace, _payments) {
  if (!activePlanId) return { listed: false };
  const listings = (marketplace?.listings || []).filter(x => x.planId === activePlanId);
  const sales = (marketplace?.sales || []).filter(x => x.planId === activePlanId);
  const revenue = sum(sales.map(s => Number(s.price || 0)));
  const lastSaleTs = sales.length ? sales[sales.length - 1].ts : null;
  return { listed: listings.length > 0, price: listings[0]?.price || null, sales: sales.length, revenue: round2(revenue), lastSaleTs };
}

/* -----------------------------------------------------------------------------
   UI Cards (single household)
----------------------------------------------------------------------------- */
export function toDashboardCards(snapshot) {
  if (!snapshot) return [];
  return [
    {
      id: "adherence",
      title: "On-Plan (7d)",
      value: `${Math.round((snapshot.adherence.onPlanPct || 0) * 100)}%`,
      meta: `${snapshot.adherence.hits7}/${snapshot.adherence.planned7} meals`,
      intent: snapshot.adherence.onPlanPct >= 0.7 ? "success" : snapshot.adherence.onPlanPct >= 0.5 ? "info" : "warning",
    },
    {
      id: "coverage",
      title: "Horizon Coverage",
      value: `${snapshot.coverage.daysWithMeals}/${snapshot.horizonDays} days`,
      meta: "Days with at least 1 planned meal",
      intent: snapshot.coverage.daysWithMeals >= snapshot.horizonDays - 1 ? "success" : snapshot.coverage.daysWithMeals >= Math.ceil(snapshot.horizonDays * 0.7) ? "info" : "warning",
    },
    {
      id: "macro-coverage",
      title: "Macro Coverage",
      value: `${Math.round((snapshot.macros.coverage.overall || 0) * 100)}%`,
      meta: `P:${Math.round(snapshot.macros.coverage.protein*100)} C:${Math.round(snapshot.macros.coverage.carbs*100)} F:${Math.round(snapshot.macros.coverage.fat*100)}`,
      intent: snapshot.macros.coverage.overall >= 0.9 ? "success" : snapshot.macros.coverage.overall >= 0.7 ? "info" : "warning",
    },
    {
      id: "variety",
      title: "Variety",
      value: `${snapshot.variety.score}/100`,
      meta: `${snapshot.variety.cuisines.length} cuisines · ${snapshot.variety.proteins.length} proteins · ${Math.round(snapshot.variety.repeatRate*100)}% repeats`,
      intent: snapshot.variety.score >= 70 ? "success" : "info",
    },
    {
      id: "grocery",
      title: "Grocery Δ (30d)",
      value: `$${snapshot.grocery.delta30}`,
      meta: `Planned $${snapshot.grocery.plannedCost30} · Actual $${snapshot.grocery.actualCost30}`,
      intent: snapshot.grocery.delta30 >= 0 ? "success" : "warning",
    },
    {
      id: "prep-balance",
      title: "Prep Balance",
      value: `${snapshot.prep.avgDailyPrepMin}m avg`,
      meta: `Std dev ${snapshot.prep.balanceStd}m`,
      intent: snapshot.prep.balanceStd <= 20 ? "success" : snapshot.prep.balanceStd <= 40 ? "info" : "warning",
    },
  ];
}

/* =============================================================================
   COALITIONS — Multiple households planning for shared goals
   Replaces “pooled shortages” with:
   - menuOverlap: % of overlapping recipes across households
   - macroFit: average plan→target macro fit across households
   - bundleOps: buyer–seller insights (high co-plan pairs → creator bundles)
   - coordination: anchor dinner standardization & bulk-prep suggestions
============================================================================= */

// Resolve another member’s planning context
async function getMemberKitchen(userId) {
  try { return await CoalitionStore?.getMemberKitchen?.(userId); } catch {}
  try { return await GroupStore?.getMemberKitchen?.(userId); } catch {}
  try { return coalitionCache.get()[`kitchen:${userId}`] || null; } catch { return null; }
}

/**
 * computeCoalitionMealPlanSnapshot — aggregate independent households
 * toward shared planning goals (events, food trains, or plan sharing/sales)
 */
export async function computeCoalitionMealPlanSnapshot({
  coalitionId,
  horizonDays = 30,
  memberResolver = getMemberKitchen,
  coalitions = readCoalitions(),
  groups = readGroups(),
} = {}) {
  if (!coalitionId) return null;

  const coalition =
    (coalitions.coalitions || []).find(c => String(c.id) === String(coalitionId)) ||
    (groups.groups || []).find(g => String(g.id) === String(coalitionId) && (g.type === "meal_coalition" || g.type === "coalition" || g.kind === "coalition")) ||
    { id: coalitionId, name: "Meal Planning Coalition", members: [], pooledDemand: {}, fairness: { basis: "servings" } };

  const members = coalition.members || [];
  const memberSnaps = [];

  for (const m of members) {
    const ctx = await memberResolver(m.userId);
    if (!ctx) { memberSnaps.push({ userId: m.userId, name: m.displayName || m.userId, error: "unavailable" }); continue; }
    const snap = computeMealPlanSnapshot({
      prefs: ctx.prefs || {},
      health: ctx.health || {},
      mealPlan: ctx.mealPlan || {},
      inventory: ctx.inventory || {},
      recipes: ctx.recipes || {},
      calendar: ctx.calendar || {},
    });
    memberSnaps.push({ userId: m.userId, name: m.displayName || m.userId, snapshot: snap });
  }

  const agg = aggregateCoalitionMealPlans(memberSnaps, coalition, horizonDays);
  const alerts = buildCoalitionMealPlanAlerts(agg);

  return {
    ts: now(),
    scope: "coalition-mealplans",
    coalitionId,
    name: coalition.name,
    horizonDays,
    members: memberSnaps,
    pooled: agg.pooled,       // adoption, overlap, macro fit, marketplace roll-up
    fairness: agg.fairness,   // contribution balance
    coordination: agg.coord,  // anchor dinners / bulk-prep / swaps
    marketplace: agg.market,  // creator analytics
    alerts,
  };
}

function aggregateCoalitionMealPlans(memberSnaps, coalition, _horizonDays) {
  const pooled = {
    adoptionRate: 0,
    avgOnPlanPct: 0,
    minCoverageDays: null,
    avgVarietyScore: 0,
    repeatRateAvg: 0,
    menuOverlap: { overlapIndex: 0, sharedRecipeCount: 0, uniqueRecipeCount: 0, topSharedRecipes: [] },
    macroFit: { avgFit: 0, lowFitMembers: [] },
  };

  const perMember = [];
  const recipeFreq = new Map(); // recipeId -> households count
  const pairFreq = new Map();   // "idA|idB" -> households that co-planned pair
  let adopters = 0;
  let macroFitSum = 0;
  const lowFit = [];

  for (const m of memberSnaps) {
    const s = m.snapshot; if (!s) continue;

    pooled.avgOnPlanPct += Number(s.adherence?.onPlanPct || 0);
    pooled.avgVarietyScore += Number(s.variety?.score || 0);
    pooled.repeatRateAvg += Number(s.variety?.repeatRate || 0);

    const cov = Number(s.coverage?.daysWithMeals || 0);
    pooled.minCoverageDays = pooled.minCoverageDays == null ? cov : Math.min(pooled.minCoverageDays, cov);
    if (cov >= Math.ceil((s.horizonDays || 7) * 0.7)) adopters++;

    // menu overlap inputs
    const ids = (s.plan?.horizonRecipeIds || []).filter(Boolean);
    const setIds = new Set(ids);
    for (const id of setIds) recipeFreq.set(id, (recipeFreq.get(id) || 0) + 1);
    // co-plan pairs per household
    const arr = Array.from(setIds);
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i], b = arr[j];
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        pairFreq.set(key, (pairFreq.get(key) || 0) + 1);
      }
    }

    // macro fit
    const fit = Number(s.macros?.coverage?.overall || 0);
    macroFitSum += fit;
    if (fit < 0.75) lowFit.push({ userId: m.userId, name: m.name, fit: round2(fit) });

    // contribution basis
    const basis = coalition?.fairness?.basis || "servings";
    const basisValue =
      basis === "plans"    ? cov :
      basis === "time"     ? Number(s.prep?.avgDailyPrepMin || 0) :
                             Math.round((s.horizonDays || 7) * (s.adherence?.onPlanPct || 0));
    perMember.push({ userId: m.userId, name: m.name, basisValue: round2(basisValue) });
  }

  const n = memberSnaps.filter(m => !!m.snapshot).length || 1;
  pooled.avgOnPlanPct = round2(pooled.avgOnPlanPct / n);
  pooled.avgVarietyScore = Math.round(pooled.avgVarietyScore / n);
  pooled.repeatRateAvg = round2(pooled.repeatRateAvg / n);
  pooled.adoptionRate = n ? round2(adopters / n) : 0;

  // Build overlap metrics
  const shared = Array.from(recipeFreq.entries()).filter(([, c]) => c >= 2);
  const uniqueCount = recipeFreq.size;
  const sharedCount = shared.length;
  const overlapIndex = uniqueCount ? round2(sharedCount / uniqueCount) : 0;
  const topSharedRecipes = shared
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([recipeId, households]) => ({ recipeId, households }));

  pooled.menuOverlap = {
    overlapIndex,
    sharedRecipeCount: sharedCount,
    uniqueRecipeCount: uniqueCount,
    topSharedRecipes,
  };

  // Macro fit roll-up
  const avgFit = n ? round2(macroFitSum / n) : 0;
  pooled.macroFit = { avgFit, lowFitMembers: lowFit.slice(0, 8) };

  // Creator bundle opportunities (high-frequency co-plan pairs)
  const bundleOps = Array.from(pairFreq.entries())
    .filter(([, c]) => c >= Math.max(2, Math.ceil(n * 0.4))) // present in ≥40% households (or ≥2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([pair, households]) => {
      const [a, b] = pair.split("|");
      return { pair: [a, b], households };
    });

  // Coordination suggestions
  const coord = coalitionCoordinationMealPlans({ memberSnaps, coalition, pooled, bundleOps });

  // Marketplace roll-up if any member lists their plan
  const market = aggregateMarketplace(memberSnaps, bundleOps);

  const fairness = coalitionFairness(perMember, coalition);

  return { pooled, fairness, coord, market };
}

function coalitionFairness(perMember, coalition) {
  const basis = coalition?.fairness?.basis || "servings";
  const values = perMember.map(m => Number(m.basisValue || 0));
  const mean = avg(values);
  const mad = avg(values.map(v => Math.abs(v - mean)));
  const imbalanceIdx = mean ? round2(mad / mean) : 0;
  return {
    basis, mean: round2(mean), imbalanceIdx,
    members: perMember.map(m => ({ ...m })),
  };
}

function coalitionCoordinationMealPlans({ memberSnaps, pooled, bundleOps }) {
  const suggestions = [];

  // Low overlap → propose “anchor dinners” (shared recipes across households)
  if ((pooled.menuOverlap.overlapIndex || 0) < 0.25) {
    const recommend = (pooled.menuOverlap.topSharedRecipes || []).slice(0, 3);
    suggestions.push({
      type: "anchor_dinners",
      note: "Low shared-menu overlap. Standardize 2–3 anchor dinners for bulk prep.",
      anchors: recommend.map(r => r.recipeId),
    });
  }

  // Macro fit low → prompt adjustments
  if ((pooled.macroFit.avgFit || 0) < 0.8) {
    const low = pooled.macroFit.lowFitMembers.slice(0, 5);
    if (low.length) {
      suggestions.push({
        type: "macro_adjust",
        note: "Several households have low macro fit. Offer higher-protein or lower-carb swaps.",
        to: low,
      });
    }
  }

  // Bundle opportunities for creators (high co-plan pairs)
  if (bundleOps.length) {
    suggestions.push({
      type: "creator_bundle",
      note: "High-frequency co-planned pairs detected. Package as a mini-bundle for buyers.",
      pairs: bundleOps,
    });
  }

  return { suggestions };
}

function aggregateMarketplace(memberSnaps, bundleOps) {
  const entries = memberSnaps
    .map(m => ({ userId: m.userId, name: m.name, mp: m.snapshot?.marketplace }))
    .filter(x => x?.mp?.listed);
  const totalRevenue = round2(sum(entries.map(e => e.mp.revenue || 0)));
  const totalSales = sum(entries.map(e => e.mp.sales || 0));

  // Lightweight creator insights
  const creatorInsights = {
    listedCreators: entries.length,
    totalRevenue,
    totalSales,
    bundleCandidates: bundleOps, // hints to author new SKUs
  };
  return creatorInsights;
}

function buildCoalitionMealPlanAlerts(agg) {
  const alerts = [];

  if ((agg?.pooled?.adoptionRate || 0) < 0.6) {
    alerts.push({
      level: "info",
      code: "LOW_ADOPTION",
      message: "Coalition plan adoption is low. Share a quick-start template.",
      actions: [{ label: "Share Template", topic: "mealplan.coalition.template.share.open" }],
    });
  }
  if ((agg?.pooled?.minCoverageDays ?? 0) < 3) {
    alerts.push({
      level: "warning",
      code: "COVERAGE_LOW",
      message: "Some households have <3 days covered. Assign catch-up plans.",
      actions: [{ label: "Assign Catch-Up", topic: "mealplan.coalition.assign.open" }],
    });
  }
  if ((agg?.pooled?.menuOverlap?.overlapIndex || 0) < 0.2) {
    alerts.push({
      level: "info",
      code: "LOW_OVERLAP",
      message: "Shared menu overlap is low. Add 2 anchor dinners for bulk prep.",
      actions: [{ label: "Pick Anchors", topic: "mealplan.coalition.anchors.pick.open" }],
    });
  }
  if ((agg?.pooled?.macroFit?.avgFit || 0) < 0.75) {
    alerts.push({
      level: "info",
      code: "LOW_MACRO_FIT",
      message: "Average macro fit is low. Suggest higher-fit swaps.",
      actions: [{ label: "Suggest Swaps", topic: "mealplan.coalition.macros.suggest.open" }],
    });
  }
  return alerts;
}

/* -----------------------------------------------------------------------------
   UI Cards (coalition)
----------------------------------------------------------------------------- */
export function toCoalitionCards(coalSnap) {
  if (!coalSnap) return [];
  const a = coalSnap.pooled?.adoptionRate || 0;
  const covMin = coalSnap.pooled?.minCoverageDays ?? 0;
  const imb = coalSnap.fairness?.imbalanceIdx || 0;
  const overlap = coalSnap.pooled?.menuOverlap?.overlapIndex || 0;
  const fit = coalSnap.pooled?.macroFit?.avgFit || 0;

  return [
    {
      id: "coalition-adoption",
      title: "Coalition · Adoption",
      value: `${Math.round(a * 100)}%`,
      meta: "Households with ≥70% coverage of their horizon",
      intent: a >= 0.8 ? "success" : a >= 0.6 ? "info" : "warning",
    },
    {
      id: "coalition-coverage",
      title: "Coalition · Coverage Floor",
      value: `${covMin} days`,
      meta: "Min days covered among members",
      intent: covMin < 3 ? "warning" : "info",
    },
    {
      id: "coalition-overlap",
      title: "Coalition · Menu Overlap",
      value: `${Math.round(overlap * 100)}%`,
      meta: "Shared recipes across households (higher → easier bulk prep)",
      intent: overlap >= 0.35 ? "success" : overlap >= 0.2 ? "info" : "warning",
    },
    {
      id: "coalition-macrofit",
      title: "Coalition · Macro Fit",
      value: `${Math.round(fit * 100)}%`,
      meta: "Avg plan→target macro coverage",
      intent: fit >= 0.9 ? "success" : fit >= 0.75 ? "info" : "warning",
    },
    {
      id: "coalition-fairness",
      title: "Coalition · Fairness",
      value: `${Math.round(imb * 100)} MAD%`,
      meta: "Lower = more balanced contribution",
      intent: imb > 0.35 ? "warning" : imb > 0.2 ? "info" : "success",
    },
  ];
}

/* -----------------------------------------------------------------------------
   Event-driven analytics bus
----------------------------------------------------------------------------- */
class MealPlanAnalytics extends EventEmitter {
  constructor() {
    super();
    this._snapshot = storage.get();
    this._coalitions = coalitionCache.get(); // { [id]: snapshot }
    this._hooked = false;
  }
  get snapshot() { return this._snapshot; }
  get coalitionSnaps() { return this._coalitions; }

  recompute() {
    const snap = computeMealPlanSnapshot({});
    this._snapshot = snap;
    storage.set(snap);
    this.emit("updated", snap);
    automation?.emitEvent?.("mealplan.analytics.updated", { snapshot: snap });
    try { this._maybeNBA(snap); } catch {}
    return snap;
  }

  async recomputeCoalition(coalitionId) {
    const snap = await computeCoalitionMealPlanSnapshot({ coalitionId });
    if (!snap) return null;
    this._coalitions[coalitionId] = snap;
    coalitionCache.set(this._coalitions);
    this.emit("coalition.updated", { coalitionId, snapshot: snap });
    automation?.emitEvent?.("mealplan.coalition.analytics.updated", { coalitionId, snapshot: snap });
    try { this._maybeNBACoalition(snap); } catch {}
    return snap;
  }

  _maybeNBA(snap) {
    if (!automation?.emitEvent) return;

    // Low coverage → suggest quick-add plan
    if ((snap.coverage?.daysWithMeals || 0) < Math.ceil((snap.horizonDays || 7) * 0.6)) {
      automation.emitEvent("nba", {
        topic: "nba",
        kind: "plan-low-coverage",
        message: "Your plan has low coverage. Add a quick 3-day plan?",
        actions: [{ label: "Quick Add", topic: "mealplan.quickadd.open", payload: { days: 3 } }],
        ts: now(),
      });
    }

    // High repeats → propose variety packs
    if ((snap.variety?.repeatRate || 0) > 0.3) {
      automation.emitEvent("nba", {
        topic: "nba",
        kind: "variety-suggest",
        message: "Repeats are high. Want a 5-recipe variety pack (≤30m)?",
        actions: [{ label: "Suggest Pack", topic: "mealplan.variety.suggest.open" }],
        ts: now(),
      });
    }

    // Conflicts → move meals
    if ((snap.conflicts || []).length) {
      automation.emitEvent("nba", {
        topic: "nba",
        kind: "conflicts",
        message: "Calendar conflicts detected during cook windows. Shift those meals?",
        actions: [{ label: "Resolve Conflicts", topic: "mealplan.conflicts.resolve.open" }],
        ts: now(),
      });
    }

    // Marketplace: listed & good adherence → promote plan
    if (snap.marketplace?.listed && (snap.adherence?.onPlanPct || 0) >= 0.7) {
      automation.emitEvent("nba", {
        topic: "nba",
        kind: "market-promote",
        message: "Your plan performs well. Promote it on the marketplace?",
        actions: [{ label: "Promote Plan", topic: "marketplace.plan.promote", payload: { planId: readMealPlan()?.activePlanId } }],
        ts: now(),
      });
    }
  }

  _maybeNBACoalition(coalSnap) {
    if (!automation?.emitEvent) return;

    if ((coalSnap?.pooled?.adoptionRate || 0) < 0.6) {
      automation.emitEvent("nba", {
        topic: "nba",
        kind: "meal-coalition-adoption",
        message: "Coalition plan adoption is low. Share a ready-made template?",
        actions: [{ label: "Share Template", topic: "mealplan.coalition.template.share.open", payload: { coalitionId: coalSnap.coalitionId } }],
        ts: now(),
      });
    }

    if ((coalSnap?.pooled?.menuOverlap?.overlapIndex || 0) < 0.25) {
      automation.emitEvent("nba", {
        topic: "nba",
        kind: "meal-coalition-anchors",
        message: "Shared menu overlap is low. Pick 2–3 anchor dinners for bulk prep?",
        actions: [{ label: "Pick Anchors", topic: "mealplan.coalition.anchors.pick.open", payload: { coalitionId: coalSnap.coalitionId } }],
        ts: now(),
      });
    }

    if ((coalSnap?.market?.bundleCandidates?.length || 0) >= 2) {
      automation.emitEvent("nba", {
        topic: "nba",
        kind: "creator-bundle-op",
        message: "Frequent co-planned pairs detected. Package them as a mini-bundle?",
        actions: [{ label: "Create Bundle", topic: "marketplace.bundle.create.open", payload: { coalitionId: coalSnap.coalitionId } }],
        ts: now(),
      });
    }
  }

  hookEvents() {
    if (this._hooked) return;
    this._hooked = true;

    const watch = (topic) => automation?.onTopic?.(topic, () => { try { this.recompute(); } catch {} });

    [
      "meals.plan.updated",
      "meals.plan.applied",
      "recipe.added",
      "recipe.updated",
      "inventory.updated",
      "inventory.delta",
      "grocery.list.generated",
      "calendar.updated",
      "cooking.meal.logged",
      "marketplace.listing.updated",
      "marketplace.sale.logged",
    ].forEach(t => watch(t));

    // Coalition events
    const coalTopics = [
      "coalition.membership.updated",
      "coalition.memberKitchen.updated",
      "coalition.targets.updated",
      "coalition.demand.updated",
    ];
    coalTopics.forEach(t => automation?.onTopic?.(t, async (evt) => {
      const cid = evt?.payload?.coalitionId;
      if (cid) try { await this.recomputeCoalition(cid); } catch {}
    }));

    // Local fallback bus
    if (eventBus?.on) {
      [
        "meals.plan.updated","inventory.updated","grocery.list.generated","calendar.updated",
        ...coalTopics,
      ].forEach(t => eventBus.on(t, async (payload) => {
        const cid = payload?.coalitionId ?? null;
        if (cid) await this.recomputeCoalition(cid);
        else this.recompute();
      }));
    }
  }
}

export const mealPlanAnalytics = new MealPlanAnalytics();

/* -----------------------------------------------------------------------------
   Automation templates & triggers
----------------------------------------------------------------------------- */
function registerAutomationTemplates() {
  if (!automation?.registerTemplate) return;

  automation.register([
    {
      id: "mealplan.daily-kpis",
      title: "Meal Plan: Daily KPIs",
      description: "Compute planning KPIs; nudge for conflicts or low coverage.",
      tags: ["mealplan", "analytics"],
      schedule: { at: "07:30" },
      timeoutMs: 12000,
      async run({ emit }) {
        const snap = mealPlanAnalytics.recompute();
        emit?.("mealplan.analytics.daily", { snapshot: snap });
        return { ok: true, snapshot: snap };
      },
    },
    {
      id: "mealplan.weekly-refresh",
      title: "Meal Plan: Weekly Refresh",
      description: "Check next 7 days coverage and generate a quick-add if needed.",
      tags: ["mealplan", "analytics", "forecast"],
      schedule: { days: [0], at: "09:00" }, // Sundays
      timeoutMs: 15000,
      async run({ emit }) {
        const snap = mealPlanAnalytics.snapshot || computeMealPlanSnapshot({});
        if ((snap.coverage?.daysWithMeals || 0) < Math.ceil((snap.horizonDays || 7) * 0.7)) {
          emit?.("nba", {
            topic: "nba",
            kind: "plan-low-coverage",
            message: "Weekly check: coverage looks light. Add a quick 3-day plan?",
            actions: [{ label: "Quick Add", topic: "mealplan.quickadd.open", payload: { days: 3 } }],
            ts: now(),
          });
        }
        return { ok: true };
      },
    },
    {
      id: "mealplan.coalition-daily",
      title: "Meal Plan: Coalition KPIs",
      description: "Aggregate multi-household analytics & creator insights (no pooled shortages).",
      tags: ["mealplan", "analytics", "coalition"],
      schedule: { at: "07:40" },
      timeoutMs: 30000,
      async run({ emit }) {
        const coalitions = (readCoalitions().coalitions || []).concat(
          (readGroups().groups || []).filter(g => g.type === "meal_coalition" || g.type === "coalition" || g.kind === "coalition")
        );
        for (const c of coalitions) {
          const snap = await mealPlanAnalytics.recomputeCoalition(c.id);
          emit?.("mealplan.coalition.analytics.daily", { coalitionId: c.id, snapshot: snap });
        }
        return { ok: true, coalitions: coalitions.length };
      },
    },
  ]);

  // Triggers
  automation.registerTrigger(() => {
    const topics = [
      "meals.plan.updated","recipe.updated","inventory.updated","grocery.list.generated",
      "calendar.updated","cooking.meal.logged","inventory.delta",
      "marketplace.listing.updated","marketplace.sale.logged",
      "coalition.membership.updated","coalition.memberKitchen.updated","coalition.targets.updated","coalition.demand.updated",
    ];
    const unsubs = topics.map(t => automation.onTopic?.(t, async (evt) => {
      const cid = evt?.payload?.coalitionId ?? null;
      if (cid) await mealPlanAnalytics.recomputeCoalition(cid);
      else mealPlanAnalytics.recompute();
    }));
    return () => unsubs.forEach(u => u?.());
  });
}

registerAutomationTemplates();
mealPlanAnalytics.hookEvents();

/* -----------------------------------------------------------------------------
   Public helpers
----------------------------------------------------------------------------- */
export function getSnapshot() {
  return mealPlanAnalytics.snapshot || mealPlanAnalytics.recompute();
}
export function getDashboardCards() {
  return toDashboardCards(getSnapshot());
}
export async function getCoalitionSnapshot(coalitionId) {
  return mealPlanAnalytics.coalitionSnaps?.[coalitionId] || await mealPlanAnalytics.recomputeCoalition(coalitionId);
}
export function getCoalitionCards(coalitionId) {
  const snap = mealPlanAnalytics.coalitionSnaps?.[coalitionId];
  return toCoalitionCards(snap);
}
export function exportMealPlanAnalytics({ format = "json", coalitionId = null } = {}) {
  if (coalitionId) {
    const snap = mealPlanAnalytics.coalitionSnaps?.[coalitionId];
    if (!snap) return null;
    if (format === "json") return safeJSON.stringify(snap);
    if (format === "csv") {
      const row = [
        ["ts", snap.ts],
        ["scope", snap.scope],
        ["coalitionId", snap.coalitionId],
        ["adoptionRate", snap.pooled?.adoptionRate ?? 0],
        ["minCoverageDays", snap.pooled?.minCoverageDays ?? 0],
        ["avgVarietyScore", snap.pooled?.avgVarietyScore ?? 0],
        ["repeatRateAvg", snap.pooled?.repeatRateAvg ?? 0],
        ["overlapIndex", snap.pooled?.menuOverlap?.overlapIndex ?? 0],
        ["macroFit", snap.pooled?.macroFit?.avgFit ?? 0],
        ["imbalanceIdx", snap.fairness?.imbalanceIdx ?? 0],
      ];
      return row.map(r => r.join(",")).join("\n");
    }
    return null;
  }

  const snap = getSnapshot();
  if (format === "json") return safeJSON.stringify(snap);
  if (format === "csv") {
    const rows = [
      ["ts", snap.ts],
      ["horizonDays", snap.horizonDays],
      ["onPlanPct7", Math.round((snap.adherence.onPlanPct || 0) * 100)],
      ["coverageDays", snap.coverage.daysWithMeals],
      ["macroCoverage", Math.round((snap.macros.coverage.overall || 0) * 100)],
      ["varietyScore", snap.variety.score],
      ["repeatRate", Math.round((snap.variety.repeatRate || 0) * 100)],
      ["groceryDelta30", snap.grocery.delta30],
      ["prepAvgDailyMin", snap.prep.avgDailyPrepMin],
      ["prepStd", snap.prep.balanceStd],
    ];
    return rows.map(r => r.join(",")).join("\n");
  }
  return null;
}
