// C:\Users\larho\suka-smart-assistant\src\services\analytics\scenarios.js
/* eslint-disable no-console */
/**
 * Suka Smart Assistant — Analytics / Scenarios (dynamic)
 *
 * Purpose:
 *  - Define and run "what-if" scenarios across meals, inventory, calendar, garden, animals, marketplace.
 *  - Compare outcomes with a configurable scoring model.
 *  - Coalition-aware (multiple households) & creator-aware (buyer–seller insights).
 *  - Event-driven; auto-marks results stale when upstream signals change.
 *  - Undo for registry/mutation; persistence; export helpers; UI-ready nudges.
 *
 * Inspirations: Linear’s speed, Notion’s simplicity, Shopify’s analytics clarity.
 */

import EventEmitter from "eventemitter3";

/* -----------------------------------------------------------------------------
   Defensive optional imports (aligns with other analytics files)
----------------------------------------------------------------------------- */
let automation;
let eventBus;
let PreferencesStore, CoalitionStore, GroupStore, MarketplaceStore;
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
  ({ useCoalitionStore: CoalitionStore } = await import(
    "@/store/CoalitionStore"
  ));
} catch {}
try {
  ({ useGroupStore: GroupStore } = await import("@/store/GroupStore"));
} catch {}
try {
  ({ useMarketplaceStore: MarketplaceStore } = await import(
    "@/store/MarketplaceStore"
  ));
} catch {}

/* -----------------------------------------------------------------------------
   Tiny platform helpers
----------------------------------------------------------------------------- */
const isBrowser = typeof window !== "undefined";
const now = () => Date.now();
const dayMs = 86_400_000;
const round2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

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
  const key = "suka::scenarios::state";
  if (isBrowser && window.localStorage) {
    return {
      load: () => safeJSON.parse(localStorage.getItem(key), null),
      save: (v) => localStorage.setItem(key, safeJSON.stringify(v)),
      clear: () => localStorage.removeItem(key),
    };
  }
  let mem = null;
  return { load: () => mem, save: (v) => (mem = v), clear: () => (mem = null) };
})();

/* -----------------------------------------------------------------------------
   Event shims (works even if automation isn’t loaded)
----------------------------------------------------------------------------- */
function emit(topic, payload) {
  try {
    if (automation?.emitEvent) return automation.emitEvent(topic, payload);
    if (eventBus?.emit) return eventBus.emit(topic, payload);
  } catch {}
  return false;
}
function on(topic, handler) {
  let unsubs = [];
  try {
    if (automation?.on) {
      const h = (evt) => {
        const t = evt?.topic || evt?.type;
        if (t === topic) handler(evt);
      };
      automation.on("event", h);
      unsubs.push(() => automation.off?.("event", h));
    }
    if (eventBus?.on) {
      eventBus.on(topic, handler);
      unsubs.push(() => eventBus.off?.(topic, handler));
    }
  } catch {}
  return () =>
    unsubs.forEach((u) => {
      try {
        u();
      } catch {}
    });
}

/* -----------------------------------------------------------------------------
   IA hooks (routes/nav for “Scenarios Center”)
----------------------------------------------------------------------------- */
function registerIA() {
  emit("shell.routes.register", {
    base: "/analytics/scenarios",
    children: [
      { path: "", element: "ScenarioOverview" },
      { path: "create", element: "ScenarioCreate" },
      { path: "compare", element: "ScenarioCompare" },
      { path: "history", element: "ScenarioHistory" },
      { path: "coalition", element: "ScenarioCoalition" },
    ],
  });

  emit("shell.nav.register", {
    section: "Analytics",
    items: [
      { to: "/analytics/scenarios", label: "Scenarios", icon: "beaker" },
      {
        to: "/analytics/scenarios/create",
        label: "New Scenario",
        icon: "plus-circle",
      },
      { to: "/analytics/scenarios/compare", label: "Compare", icon: "scales" },
      {
        to: "/analytics/scenarios/coalition",
        label: "Coalitions",
        icon: "users",
      },
    ],
  });
}

/* -----------------------------------------------------------------------------
   Registry + state + undo + persistence
----------------------------------------------------------------------------- */
const REGISTRY = new Map(); // id -> ScenarioDef
const RUNS = new Map(); // runId -> ScenarioRun
const COMPARISONS = new Map(); // cmpId -> { id, runIds, summary, at }
const UNDO = [];
let __booted = false;

function snap(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function persist() {
  storage.save({
    REGISTRY: Array.from(REGISTRY.entries()),
    RUNS: Array.from(RUNS.entries()),
    COMPARISONS: Array.from(COMPARISONS.entries()),
  });
}
function restore() {
  const s = storage.load();
  if (!s) return;
  try {
    REGISTRY.clear();
    RUNS.clear();
    COMPARISONS.clear();
    (s.REGISTRY || []).forEach(([k, v]) => REGISTRY.set(k, v));
    (s.RUNS || []).forEach(([k, v]) => RUNS.set(k, v));
    (s.COMPARISONS || []).forEach(([k, v]) => COMPARISONS.set(k, v));
  } catch (e) {
    console.warn("[scenarios] restore failed:", e?.message || e);
  }
}

function mutate(fn, meta = { reason: "unknown" }) {
  const prev = {
    REGISTRY: Array.from(REGISTRY.entries()),
    RUNS: Array.from(RUNS.entries()),
    COMPARISONS: Array.from(COMPARISONS.entries()),
  };
  fn();
  persist();
  UNDO.push(() => {
    REGISTRY.clear();
    RUNS.clear();
    COMPARISONS.clear();
    prev.REGISTRY.forEach(([k, v]) => REGISTRY.set(k, v));
    prev.RUNS.forEach(([k, v]) => RUNS.set(k, v));
    prev.COMPARISONS.forEach(([k, v]) => COMPARISONS.set(k, v));
    persist();
    emit("analytics.scenarios.changed", { meta: { reason: "undo" } });
  });
  emit("analytics.scenarios.changed", { meta });
}

export function undoScenarioChange() {
  const u = UNDO.pop();
  if (u) u();
}

/* -----------------------------------------------------------------------------
   Public API: registry
   ScenarioDef: {
     id, label, tags?: string[], inputs?: object,
     evaluator(context, inputs, helpers) -> ScenarioMetrics | Promise<...>,
     guard?(context, inputs) -> boolean|Promise<boolean>
   }
----------------------------------------------------------------------------- */
export function registerScenario(def) {
  if (!def?.id || typeof def?.evaluator !== "function")
    throw new Error("Invalid scenario definition");
  mutate(() => REGISTRY.set(def.id, def), {
    reason: "registerScenario",
    id: def.id,
  });
}
export function listScenarios({ tag } = {}) {
  const all = Array.from(REGISTRY.values());
  return tag ? all.filter((s) => (s.tags || []).includes(tag)) : all;
}
export function removeScenario(id) {
  mutate(() => REGISTRY.delete(id), { reason: "removeScenario", id });
}

/* -----------------------------------------------------------------------------
   Metrics model / scoring model (configurable weights)
----------------------------------------------------------------------------- */
/**
 * ScenarioMetrics (partial tolerated):
 * {
 *   cost: { total, perMeal? },
 *   availability: { missingItems?: any[], substitutionCount?: number },
 *   diversity: { uniqueCuisines?: number, uniqueProteins?: number },
 *   time: { prepMinutes?: number, cookMinutes?: number },
 *   storehouse?: { used?: Record<string,number>, added?: Record<string,number> },
 *   labels?: { needed?: number },
 *   menu?: { recipeIds?: string[] },               // helps compare overlap/variety later
 *   macros?: { calories?: number, protein?: number, carbs?: number, fat?: number },
 *   marketplace?: { estPrice?: number, fitScore?: number }, // creator-facing
 *   notes?: string[]
 * }
 */
function scoringWeights() {
  // allow Preferences override
  try {
    const prefs = PreferencesStore?.();
    const w = prefs?.analytics?.scenarioWeights;
    if (w)
      return {
        ...{ cost: 0.35, time: 0.25, availability: 0.25, diversity: 0.15 },
        ...w,
      };
  } catch {}
  return { cost: 0.35, time: 0.25, availability: 0.25, diversity: 0.15 };
}

/* -----------------------------------------------------------------------------
   Run + Compare
----------------------------------------------------------------------------- */
export async function runScenario({
  scenarioId,
  inputs = {},
  contextProvider,
  timeoutMs = 15000,
}) {
  const def = REGISTRY.get(scenarioId);
  if (!def) throw new Error(`Scenario "${scenarioId}" not found`);

  const context =
    typeof contextProvider === "function" ? await contextProvider() : {};
  if (def.guard) {
    try {
      const ok = await def.guard(context, inputs);
      if (!ok) throw new Error("Scenario guard prevented execution");
    } catch (e) {
      throw new Error(e?.message || "Scenario guard failed");
    }
  }

  const helpers = {
    sum,
    uniq,
    uniqBy,
    estimateRecipeCost,
    detectMissing,
    round: round2,
    clamp,
  };
  const exec = Promise.resolve(
    def.evaluator(context, { ...(def.inputs || {}), ...inputs }, helpers)
  );
  const metrics = await withTimeout(
    exec,
    timeoutMs,
    `Scenario "${scenarioId}" timed out`
  );

  const id = crypto.randomUUID?.() || `run_${Date.now()}`;
  mutate(() => RUNS.set(id, { id, scenarioId, inputs, metrics, at: now() }), {
    reason: "runScenario",
    scenarioId,
  });
  suggestAfterRun(def, metrics);
  return RUNS.get(id);
}

export function listRuns({ scenarioId } = {}) {
  const all = Array.from(RUNS.values()).sort((a, b) => b.at - a.at);
  return scenarioId ? all.filter((r) => r.scenarioId === scenarioId) : all;
}

export function compareRuns(runIds = []) {
  const runs = runIds.map((id) => RUNS.get(id)).filter(Boolean);
  if (runs.length < 2) throw new Error("Need at least two runs to compare");
  const summary = buildComparisonSummary(runs);
  const id = crypto.randomUUID?.() || `cmp_${Date.now()}`;
  mutate(() => COMPARISONS.set(id, { id, runIds, summary, at: now() }), {
    reason: "compareRuns",
    runCount: runs.length,
  });
  suggestAfterCompare(summary);
  return COMPARISONS.get(id);
}

export function listComparisons() {
  return Array.from(COMPARISONS.values()).sort((a, b) => b.at - a.at);
}

/* -----------------------------------------------------------------------------
   Comparison logic
----------------------------------------------------------------------------- */
function buildComparisonSummary(runs) {
  const W = scoringWeights();

  const scored = runs.map((r) => {
    const m = r.metrics || {};
    const cost = Number(m.cost?.total ?? 0);
    const time =
      Number(m.time?.prepMinutes ?? 0) + Number(m.time?.cookMinutes ?? 0);
    const shortage = Number(m.availability?.missingItems?.length ?? 0);
    const subs = Number(m.availability?.substitutionCount ?? 0);
    const diversity =
      Number(m.diversity?.uniqueCuisines ?? 0) +
      Number(m.diversity?.uniqueProteins ?? 0);

    // normalize → higher is better
    // caps keep scale sane for UI
    const score =
      (1000 - clamp(cost, 0, 1000)) * W.cost +
      (100 - clamp(time, 0, 100)) * W.time +
      (100 - clamp(shortage * 10 + subs * 5, 0, 100)) * W.availability +
      clamp(diversity, 0, 100) * W.diversity;

    return {
      runId: r.id,
      scenarioId: r.scenarioId,
      label: REGISTRY.get(r.scenarioId)?.label || r.scenarioId,
      metrics: m,
      score: round2(score),
    };
  });

  scored.sort((a, b) => b.score - a.score);
  const winner = scored[0];
  const deltas = buildDeltas(scored);
  const radar = buildRadar(scored);

  // Menu overlap signal (helps shared family planning & creator bundles)
  const overlap = menuOverlap(
    scored.map((s) => ({
      runId: s.runId,
      ids: s.metrics?.menu?.recipeIds || [],
    }))
  );

  return { scored, winner, deltas, radar, overlap };
}

function buildDeltas(scored) {
  if (scored.length < 2) return [];
  const base = scored[0];
  const bm = base.metrics || {};
  const bCost = bm.cost?.total ?? 0;
  const bTime = (bm.time?.prepMinutes ?? 0) + (bm.time?.cookMinutes ?? 0);
  const bShort = bm.availability?.missingItems?.length ?? 0;
  const bDiv =
    (bm.diversity?.uniqueCuisines ?? 0) + (bm.diversity?.uniqueProteins ?? 0);

  return scored.slice(1).map((s) => {
    const m = s.metrics || {};
    return {
      runId: s.runId,
      vsWinner: {
        score: round2(base.score - s.score),
        costDiff: round2((m.cost?.total ?? 0) - bCost),
        timeDiff: round2(
          (m.time?.prepMinutes ?? 0) + (m.time?.cookMinutes ?? 0) - bTime
        ),
        shortageDiff: (m.availability?.missingItems?.length ?? 0) - bShort,
        diversityDiff:
          (m.diversity?.uniqueCuisines ?? 0) +
          (m.diversity?.uniqueProteins ?? 0) -
          bDiv,
      },
    };
  });
}

function buildRadar(scored) {
  // For a nice chart: normalize axes to 0..100 for each run
  return scored.map((s) => {
    const m = s.metrics || {};
    const costAxis = 100 - clamp((m.cost?.total ?? 0) / 10, 0, 100);
    const timeAxis =
      100 -
      clamp((m.time?.prepMinutes ?? 0) + (m.time?.cookMinutes ?? 0), 0, 100);
    const availAxis =
      100 - clamp((m.availability?.missingItems?.length ?? 0) * 10, 0, 100);
    const divAxis = clamp(
      (m.diversity?.uniqueCuisines ?? 0) + (m.diversity?.uniqueProteins ?? 0),
      0,
      100
    );
    return {
      runId: s.runId,
      axes: {
        cost: round2(costAxis),
        time: round2(timeAxis),
        availability: round2(availAxis),
        diversity: round2(divAxis),
      },
    };
  });
}

function menuOverlap(entries) {
  // Jaccard-esque overlap across runs to surface “anchor dinners”
  const sets = entries.map((e) => new Set(e.ids));
  const all = new Set(entries.flatMap((e) => e.ids));
  const freq = new Map();
  for (const id of all) {
    let n = 0;
    for (const st of sets) if (st.has(id)) n++;
    freq.set(id, n);
  }
  const shared = Array.from(freq.entries())
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1]);
  const overlapIndex = all.size ? round2(shared.length / all.size) : 0;
  return {
    overlapIndex,
    topShared: shared
      .slice(0, 6)
      .map(([recipeId, runs]) => ({ recipeId, runs })),
  };
}

/* -----------------------------------------------------------------------------
   Nudges (next best actions)
----------------------------------------------------------------------------- */
function suggest(message, actions = [], source = "analytics.scenarios") {
  emit("analytics.nudge", { at: now(), message, actions, source });
}
function suggestAfterRun(def, metrics) {
  const actions = [];
  const miss = metrics?.availability?.missingItems?.length ?? 0;
  if (miss > 0)
    actions.push({
      label: `Fix ${miss} missing items`,
      topic: "grocery.generate.request",
      payload: { horizonDays: 7 },
    });
  if ((metrics?.labels?.needed ?? 0) > 0)
    actions.push({ label: "Print labels", topic: "export.labels.open" });
  if (
    metrics?.storehouse &&
    (Object.keys(metrics.storehouse.used || {}).length ||
      Object.keys(metrics.storehouse.added || {}).length)
  ) {
    actions.push({ label: "Update storehouse", topic: "inventory.open" });
  }
  actions.push(
    { label: "Share with family", topic: "share.open" },
    { label: "Add tasks to calendar", topic: "calendar.create.bulk" }
  );
  suggest(
    `Scenario "${def.label}" evaluated. Next step?`,
    actions,
    "scenario.run"
  );
}
function suggestAfterCompare(summary) {
  const winnerLabel = summary?.winner?.label || "Best option";
  const shared = (summary?.overlap?.topShared || [])
    .slice(0, 3)
    .map((x) => x.recipeId);
  const actions = [
    { label: "Apply to Meal Plan", topic: "mealplan.apply.fromScenario" },
    { label: "Save as Preset", topic: "scenario.savePreset.open" },
    { label: "Share Decision", topic: "share.open" },
  ];
  if (shared.length)
    actions.unshift({
      label: "Set Anchor Dinners",
      topic: "mealplan.anchors.set",
      payload: { recipeIds: shared },
    });
  suggest(
    `${winnerLabel} wins. Apply, save, or set anchors?`,
    actions,
    "scenario.compare"
  );
}

/* -----------------------------------------------------------------------------
   Default scenarios (domain-light, swappable later)
----------------------------------------------------------------------------- */
registerDefaultScenario({
  id: "diet.shellfish.toggle",
  label: "Diet Rule: Shellfish Allowed vs Disallowed",
  tags: ["meals", "diet"],
  inputs: { allowed: true },
  evaluator: (
    ctx,
    { allowed },
    { estimateRecipeCost, detectMissing, uniq }
  ) => {
    const recipes = (ctx.mealPlan?.recipes || []).filter(
      (r) => allowed || !(r.tags || []).includes("shellfish")
    );
    const cost = recipes.reduce(
      (sum, r) => sum + (estimateRecipeCost(r, ctx) || 0),
      0
    );
    const missingItems = detectMissing(recipes, ctx.inventory);
    const time = {
      prepMinutes: sum(recipes.map((r) => r.prepMinutes || 10)),
      cookMinutes: sum(recipes.map((r) => r.cookMinutes || 20)),
    };
    return {
      cost: {
        total: round2(cost),
        perMeal: round2(cost / Math.max(recipes.length, 1)),
      },
      availability: { missingItems, substitutionCount: 0 },
      diversity: {
        uniqueCuisines: uniq(recipes.map((r) => r.cuisine)).length,
        uniqueProteins: uniq(recipes.map((r) => r.protein)).length,
      },
      time,
      menu: { recipeIds: recipes.map((r) => r.id) },
      notes: [
        allowed
          ? "Broader menu may reduce substitutions."
          : "Filtered to compliant dishes.",
      ],
    };
  },
});

registerDefaultScenario({
  id: "budget.tiers",
  label: "Budget Tier: Tight / Normal / Abundant",
  tags: ["meals", "budget"],
  inputs: { tier: "normal" },
  evaluator: (ctx, { tier }, { estimateRecipeCost, detectMissing, uniq }) => {
    const mult = tier === "tight" ? 0.9 : tier === "abundant" ? 1.15 : 1.0;
    const recipes = ctx.mealPlan?.recipes || [];
    const baseCost = recipes.reduce(
      (sum, r) => sum + (estimateRecipeCost(r, ctx) || 0),
      0
    );
    const missingItems = detectMissing(recipes, ctx.inventory);
    return {
      cost: {
        total: round2(baseCost * mult),
        perMeal: round2((baseCost * mult) / Math.max(recipes.length, 1)),
      },
      availability: { missingItems, substitutionCount: 0 },
      diversity: {
        uniqueCuisines: uniq(recipes.map((r) => r.cuisine)).length,
        uniqueProteins: uniq(recipes.map((r) => r.protein)).length,
      },
      time: {
        prepMinutes: sum(recipes.map((r) => r.prepMinutes || 10)),
        cookMinutes: sum(recipes.map((r) => r.cookMinutes || 20)),
      },
      menu: { recipeIds: recipes.map((r) => r.id) },
      notes: [
        `"${tier}" tier adjusts expected spend by ${(mult * 100 - 100).toFixed(
          0
        )}%.`,
      ],
    };
  },
});

registerDefaultScenario({
  id: "sourcing.local_vs_store",
  label: "Sourcing: Seasonal/Local vs Store-bought",
  tags: ["meals", "sourcing"],
  inputs: { mode: "local" },
  evaluator: (ctx, { mode }, { estimateRecipeCost, detectMissing, uniq }) => {
    const recipes = ctx.mealPlan?.recipes || [];
    const localBonus = mode === "local" ? -0.08 : 0.05;
    const cost =
      recipes.reduce((sum, r) => sum + (estimateRecipeCost(r, ctx) || 0), 0) *
      (1 + localBonus);
    const seasonal = ctx.seasons?.inSeasonIds || [];
    const missingItems =
      mode === "local"
        ? detectMissing(recipes, ctx.inventory, seasonal)
        : detectMissing(recipes, ctx.inventory);
    return {
      cost: {
        total: round2(cost),
        perMeal: round2(cost / Math.max(recipes.length, 1)),
      },
      availability: { missingItems, substitutionCount: 0 },
      diversity: {
        uniqueCuisines: uniq(recipes.map((r) => r.cuisine)).length,
        uniqueProteins: uniq(recipes.map((r) => r.protein)).length,
      },
      time: {
        prepMinutes: sum(recipes.map((r) => r.prepMinutes || 10)),
        cookMinutes: sum(recipes.map((r) => r.cookMinutes || 20)),
      },
      menu: { recipeIds: recipes.map((r) => r.id) },
      notes: [
        mode === "local"
          ? "Seasonality may increase missing items."
          : "Relaxed seasonality; availability often improves at higher cost.",
      ],
    };
  },
});

registerDefaultScenario({
  id: "time.window",
  label: "Time Window: Weeknight vs Weekend",
  tags: ["meals", "time"],
  inputs: { window: "weeknight" },
  evaluator: (ctx, { window }, { estimateRecipeCost, detectMissing, uniq }) => {
    const recipes = (ctx.mealPlan?.recipes || []).filter((r) => {
      const total = (r.prepMinutes || 10) + (r.cookMinutes || 20);
      return window === "weeknight" ? total <= 45 : true;
    });
    const cost = recipes.reduce(
      (sum, r) => sum + (estimateRecipeCost(r, ctx) || 0),
      0
    );
    const missingItems = detectMissing(recipes, ctx.inventory);
    return {
      cost: {
        total: round2(cost),
        perMeal: round2(cost / Math.max(recipes.length, 1)),
      },
      availability: { missingItems, substitutionCount: 0 },
      diversity: {
        uniqueCuisines: uniq(recipes.map((r) => r.cuisine)).length,
        uniqueProteins: uniq(recipes.map((r) => r.protein)).length,
      },
      time: {
        prepMinutes: sum(recipes.map((r) => r.prepMinutes || 10)),
        cookMinutes: sum(recipes.map((r) => r.cookMinutes || 20)),
      },
      menu: { recipeIds: recipes.map((r) => r.id) },
      notes: [
        window === "weeknight"
          ? "≤45 minutes for easier evenings."
          : "Weekend allows longer cooks and more variety.",
      ],
    };
  },
});

/* -----------------------------------------------------------------------------
   Creator-aware scenario (buyer–seller fit)
----------------------------------------------------------------------------- */
registerDefaultScenario({
  id: "creator.bundle.fit",
  label: "Creator: Bundle Fit & Price Test",
  tags: ["creator", "marketplace"],
  inputs: { price: 9.99 },
  evaluator: (ctx, { price }) => {
    // Very lightweight: estimate fit by overlap with “popular” recipes & macro-friendly bias
    const popularIds = new Set(
      (ctx.market?.popularRecipeIds || []).slice(0, 20)
    );
    const planIds = (ctx.mealPlan?.recipes || []).map((r) => r.id);
    const overlap =
      planIds.filter((id) => popularIds.has(id)).length /
      Math.max(1, planIds.length);
    const macroBias = ctx.preferences?.cooking?.macroBias || "balanced"; // e.g., high-protein
    const macroFit = macroBias === "balanced" ? 0.9 : 0.8; // placeholder

    const fitScore = round2(clamp(overlap * 0.6 + macroFit * 0.4, 0, 1));
    return {
      cost: { total: price },
      marketplace: { estPrice: price, fitScore },
      notes: [`Bundle fit ≈ ${Math.round(fitScore * 100)}% for audience.`],
      menu: { recipeIds: planIds },
    };
  },
});

/* -----------------------------------------------------------------------------
   Coalition helpers (optional)
----------------------------------------------------------------------------- */
async function resolveMemberKitchen(userId) {
  try {
    return await CoalitionStore?.getMemberKitchen?.(userId);
  } catch {}
  try {
    return await GroupStore?.getMemberKitchen?.(userId);
  } catch {}
  return null;
}

/* -----------------------------------------------------------------------------
   Event-driven glue (mark stale + helpful nudges)
----------------------------------------------------------------------------- */
function registerListeners() {
  const refreshEvents = [
    "mealplan.created",
    "meals.plan.updated",
    "recipes.updated",
    "batch.session.completed",
    "inventory.updated",
    "calendar.updated",
    "garden.plan.updated",
    "animals.updated",
    "marketplace.listing.updated",
    "marketplace.sale.logged",
  ];

  refreshEvents.forEach((evtType) => {
    on(evtType, (evt) => {
      emit("analytics.scenarios.stale", { at: now(), source: evtType });
      emit("analytics.nudge", {
        at: now(),
        source: "analytics.scenarios",
        message:
          "Context changed. Re-run your scenarios to keep decisions sharp.",
        actions: [
          {
            label: "Open Scenarios",
            topic: "ui.goto",
            payload: { to: "/analytics/scenarios" },
          },
          {
            label: "Compare Runs",
            topic: "ui.goto",
            payload: { to: "/analytics/scenarios/compare" },
          },
        ],
      });
    });
  });

  on("analytics.scenarios.undo", () => undoScenarioChange());
}

/* -----------------------------------------------------------------------------
   Bootstrap
----------------------------------------------------------------------------- */
export function bootstrapScenarioAnalytics() {
  if (__booted) return;
  __booted = true;

  restore();
  registerIA();
  registerListeners();

  if (REGISTRY.size === 0) {
    emit("analytics.empty", {
      message:
        "No scenarios yet. Try a quick one (Shellfish toggle, Budget tiers).",
      actions: [
        {
          label: "Create Scenario",
          topic: "ui.goto",
          payload: { to: "/analytics/scenarios/create" },
        },
        {
          label: "Browse Defaults",
          topic: "ui.goto",
          payload: { to: "/analytics/scenarios" },
        },
      ],
    });
  }

  emit("analytics.scenarios.changed", { meta: { reason: "boot" } });
  if (import.meta?.env?.DEV) console.debug("[analytics.scenarios] booted");
}

/* -----------------------------------------------------------------------------
   Optional getters for widgets
----------------------------------------------------------------------------- */
export function getScenarioRegistrySnapshot() {
  return snap(Array.from(REGISTRY.values()));
}
export function getRunsSnapshot() {
  return snap(Array.from(RUNS.values()).sort((a, b) => b.at - a.at));
}
export function getComparisonsSnapshot() {
  return snap(Array.from(COMPARISONS.values()).sort((a, b) => b.at - a.at));
}

/* -----------------------------------------------------------------------------
   Utilities & estimators (swappable with domain logic)
----------------------------------------------------------------------------- */
function sum(arr) {
  return (arr || []).reduce((a, b) => a + (Number(b) || 0), 0);
}
function uniq(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}
function uniqBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const it of arr || []) {
    const key = keyFn(it);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(it);
    }
  }
  return out;
}
function estimateRecipeCost(recipe, ctx) {
  const priceList = ctx.prices || {};
  return (recipe?.ingredients || []).reduce((sum, ing) => {
    const key = (ing.itemId || ing.name || "").toLowerCase();
    const price = Number(priceList[key]?.unitPrice ?? 2);
    const qty = Number(ing.qty ?? 1);
    return sum + price * qty;
  }, 0);
}
function detectMissing(recipes, inventory, requireInSeasonIds) {
  const inv = new Map(
    (inventory?.items || []).map((row) => [
      String(row.itemId || row.name).toLowerCase(),
      Number(row.qty || 0),
    ])
  );
  const missing = [];
  (recipes || []).forEach((r) => {
    (r.ingredients || []).forEach((ing) => {
      const key = (ing.itemId || ing.name || "").toLowerCase();
      const needed = Number(ing.qty ?? 1);
      const have = inv.get(key) ?? 0;
      if (Array.isArray(requireInSeasonIds) && requireInSeasonIds.length > 0) {
        const inSeason = requireInSeasonIds.includes(ing.itemId);
        if (!inSeason)
          missing.push({
            itemId: ing.itemId,
            name: ing.name,
            reason: "off-season",
          });
      }
      if (have < needed)
        missing.push({
          itemId: ing.itemId,
          name: ing.name,
          reason: "insufficient",
        });
    });
  });
  return uniqBy(missing, (m) => `${m.itemId || m.name}:${m.reason}`);
}
async function withTimeout(promise, ms, msg = "Timed out") {
  if (!ms || ms <= 0) return promise;
  let t;
  const timeout = new Promise(
    (_, rej) => (t = setTimeout(() => rej(new Error(msg)), ms))
  );
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(t);
  }
}

/* -----------------------------------------------------------------------------
   Automation integration (daily refresh)
----------------------------------------------------------------------------- */
(function registerAutomation() {
  if (!automation?.registerTemplate) return;
  automation.register([
    {
      id: "scenarios.daily-refresh",
      title: "Scenarios: Daily Refresh",
      description: "Remind user to re-run key scenarios when inputs drift.",
      tags: ["analytics", "scenarios"],
      schedule: { at: "08:15" },
      async run({ emit: rtEmit }) {
        const runs = getRunsSnapshot().slice(0, 5);
        rtEmit?.("analytics.scenarios.daily", { runs, ts: now() });
        if (!runs.length) {
          emit("analytics.nudge", {
            at: now(),
            source: "analytics.scenarios",
            message: "No recent scenario runs. Want to try a quick scenario?",
            actions: [
              {
                label: "Open Scenarios",
                topic: "ui.goto",
                payload: { to: "/analytics/scenarios" },
              },
            ],
          });
        }
        return { ok: true, count: runs.length };
      },
    },
  ]);
})();
