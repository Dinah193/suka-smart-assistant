// C:\Users\larho\suka-smart-assistant\src\hooks\estimators\useFoodSecurityEstimator.js

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHomesteadProfile } from "../homestead/useHomesteadProfile";
import { useHomesteadVisibility } from "../homestead/useHomesteadVisibility";

/**
 * useFoodSecurityEstimator
 * -----------------------------------------------------------------------------
 * Deterministic, plain SSA-friendly estimator hook.
 *
 * What it does (plain-language):
 * - Converts what you have (inventory/storehouse + optional planned meals) into
 *   "meal-servings" and estimates how many days your household can stay fed.
 * - Highlights the first things you’ll run out of (gaps) and suggests next
 *   best actions (NBA) like "buy rice" or "cook beans" based on priority.
 *
 * Key constraints:
 * - No AI required.
 * - Works with partial data (fallback defaults).
 * - Pluggable adapters for inventory/meal plan sources (Dexie/Zustand/etc.).
 *
 * Recommended integration:
 * - Gate display with `useHomesteadVisibility()`:
 *   show this estimator only when the user chooses Homestead Planner
 *   and selects a starting homestead level (>0).
 *
 * -----------------------------------------------------------------------------
 * Inputs (via adapters)
 * -----------------------------------------------------------------------------
 * inventorySnapshot: optional, from your Inventory/Storehouse module
 * mealPlanSnapshot: optional, from MealPlanStore or Planner state
 *
 * The hook does NOT assume SSA’s inventory schema; instead it expects normalized
 * shapes (see normalize helpers below). If your real schema differs, provide
 * adapters that map into these shapes.
 *
 * -----------------------------------------------------------------------------
 * Hook API
 * -----------------------------------------------------------------------------
 * const est = useFoodSecurityEstimator({ adapters, valuationMap, defaults });
 *
 * est.status.loading
 * est.status.ready
 * est.status.error
 *
 * est.result            // latest estimator result (or null)
 * est.run()             // run now
 * est.refresh()         // alias for run
 * est.explain           // plain-language explanation strings
 *
 * -----------------------------------------------------------------------------
 * Options
 * -----------------------------------------------------------------------------
 * @typedef {Object} UseFoodSecurityEstimatorOptions
 * @property {Object=} context UI context (mode/screen/route)
 * @property {Object=} profileOptions forwarded to useHomesteadProfile()
 * @property {Object=} visibilityOptions forwarded to useHomesteadVisibility()
 * @property {Object=} adapters data adapters:
 *   - getInventory: () => Promise|value
 *   - getMealPlan: () => Promise|value
 *   - getPantryTargets: () => Promise|value  (optional)
 *   - emit: (eventName, payload) => void     (optional)
 * @property {Object=} valuationMap map of inventory items to "servings"
 * @property {Object=} defaults deterministic defaults for missing data
 * @property {boolean=} autoRun if true, auto-run when gated visible (default true)
 * @property {number=} debounceMs debounce for autoRun triggers (default 300)
 * @property {boolean=} includePlannedMeals if true, uses meal plan targets as "needs" (default true)
 * @property {boolean=} includeStorehouse if true, treats storehouse/pantry as inventory too (default true)
 * @property {string=} estimatorId meta.id override
 */

export function useFoodSecurityEstimator(options = {}) {
  const {
    context = null,
    profileOptions = undefined,
    visibilityOptions = undefined,

    adapters = {},
    valuationMap = DEFAULT_VALUATION_MAP,
    defaults = DEFAULTS,

    autoRun = true,
    debounceMs = 300,

    includePlannedMeals = true,
    includeStorehouse = true,

    estimatorId = "estimators.food_security",
  } = options;

  const { profile, status: profileStatus } = useHomesteadProfile(
    profileOptions || {},
  );
  const vis = useHomesteadVisibility({
    context,
    ...(visibilityOptions || {}),
    profileOptions:
      profileOptions ||
      (visibilityOptions ? visibilityOptions.profileOptions : undefined),
  });

  const [phase, setPhase] = useState("idle"); // idle|loading|ready|error
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const runTimerRef = useRef(null);
  const lastRunKeyRef = useRef("");

  const gatedOn = Boolean(vis?.showFoodSecurityEstimator);

  const status = useMemo(
    () => ({
      loading: phase === "loading",
      ready: phase === "ready",
      error,
      phase,
      gatedOn,
      source: {
        profile: profileStatus?.source || "default",
        visibility: "local",
        inventory: adapters?.getInventory ? "adapter" : "none",
        mealPlan: adapters?.getMealPlan ? "adapter" : "none",
      },
    }),
    [phase, error, gatedOn, profileStatus?.source, adapters],
  );

  const explain = useMemo(
    () => buildExplain({ result, gatedOn, vis, profile }),
    [result, gatedOn, vis, profile],
  );

  const run = useCallback(
    async (meta = {}) => {
      setPhase("loading");
      setError(null);

      const startedAt = new Date().toISOString();

      try {
        // Pull household parameters
        const householdSize = clampNumber(
          profile?.household?.size ?? defaults.householdSize,
          1,
          50,
        );
        const mealsPerDay = clampNumber(defaults.mealsPerDay, 1, 6);

        // Pull data (adapters may be sync or async)
        const [rawInventory, rawMealPlan, rawTargets] = await Promise.all([
          resolveMaybeAsync(
            adapters?.getInventory?.({ includeStorehouse, profile, context }),
          ),
          resolveMaybeAsync(adapters?.getMealPlan?.({ profile, context })),
          resolveMaybeAsync(adapters?.getPantryTargets?.({ profile, context })),
        ]);

        const inventory = normalizeInventorySnapshot(rawInventory);
        const mealPlan = normalizeMealPlanSnapshot(rawMealPlan);

        // Deterministic assumptions
        const assumptions = {
          householdSize,
          mealsPerDay,
          servingsPerMealPerPerson: clampNumber(
            defaults.servingsPerMealPerPerson,
            0.5,
            4,
          ),
          wasteFactor: clampNumber(defaults.wasteFactor, 0, 0.5),
          unknownItemServingsFallback: clampNumber(
            defaults.unknownItemServingsFallback,
            0,
            50,
          ),
          includePlannedMeals: Boolean(includePlannedMeals),
          includeStorehouse: Boolean(includeStorehouse),
          valuationMapVersion: String(defaults.valuationMapVersion || "1"),
        };

        // Compute "available servings" from inventory via valuation map
        const available = computeAvailableServings({
          inventory,
          valuationMap,
          assumptions,
        });

        // Compute "daily serving needs"
        const dailyServingsNeeded =
          householdSize * mealsPerDay * assumptions.servingsPerMealPerPerson;

        // Coverage days (inventory-only)
        const coverageDaysRaw =
          dailyServingsNeeded > 0
            ? available.totalServings / dailyServingsNeeded
            : 0;
        const coverageDays = roundTo(coverageDaysRaw, 2);

        // Optional: compute a "plan gap" view (planned meals demand vs inventory)
        const planAnalysis = includePlannedMeals
          ? computePlannedMealGaps({
              mealPlan,
              inventory,
              valuationMap,
              assumptions,
            })
          : { gaps: [], demandServings: null, demandDays: null };

        // Pantry targets (optional) => gaps vs targets (storehouse readiness)
        const targetAnalysis = rawTargets
          ? computeTargetsGaps({
              targets: normalizePantryTargets(rawTargets),
              inventory,
              valuationMap,
              assumptions,
            })
          : { targetGaps: [] };

        const confidence = computeConfidence({
          inventory,
          valuationMap,
          assumptions,
          hasMealPlan: Boolean(mealPlan?.items?.length),
          hasTargets: Boolean(rawTargets),
        });

        const nba = buildNextBestActions({
          available,
          planAnalysis,
          targetAnalysis,
          defaults,
        });

        const next = {
          schemaVersion: "1.0.0",
          updatedAt: new Date().toISOString(),
          meta: {
            id: estimatorId,
            type: "estimator_result",
            domain: "estimators",
            locale: "en-US",
            label: "Food Security",
            description:
              "Estimates how many days your household can stay fed based on inventory + optional meal plan targets, highlighting gaps and next best actions.",
          },
          run: {
            id: makeRunId(),
            createdAt: startedAt,
            context: sanitizeContext(context),
            inputs: {
              householdSize,
              mealsPerDay,
              includePlannedMeals: Boolean(includePlannedMeals),
              includeStorehouse: Boolean(includeStorehouse),
              inventoryCount: inventory.items.length,
              mealPlanCount: mealPlan.items.length,
            },
            assumptions,
          },
          outputs: {
            coverageDays,
            dailyServingsNeeded: roundTo(dailyServingsNeeded, 2),
            totalServings: roundTo(available.totalServings, 2),
            topCategories: available.topCategories,
            gaps: planAnalysis.gaps,
            demandDays: planAnalysis.demandDays,
            targetGaps: targetAnalysis.targetGaps,
            confidence,
            nextBestActions: nba,
          },
        };

        setResult(next);
        setPhase("ready");

        safeEmit(adapters?.emit, "estimators.food_security.ran", {
          result: next,
          meta,
        });

        return next;
      } catch (e) {
        setError(e);
        setPhase("error");
        safeEmit(adapters?.emit, "estimators.food_security.error", {
          error: String(e?.message || e),
        });
        return null;
      }
    },
    [
      adapters,
      context,
      defaults,
      estimatorId,
      includePlannedMeals,
      includeStorehouse,
      profile,
      valuationMap,
    ],
  );

  const refresh = run;

  // Auto-run when gated visible and key inputs change.
  // We debounce to avoid rapid re-runs during UI edits.
  useEffect(() => {
    if (!autoRun) return;
    if (!gatedOn) return;

    const householdSize = clampNumber(
      profile?.household?.size ?? defaults.householdSize,
      1,
      50,
    );
    const level = clampNumber(profile?.homestead?.level ?? 0, 0, 10);

    // Create a stable "run key" to avoid re-running on every render.
    // Adapters can optionally provide a hash to improve correctness.
    const invKey = adapters?.getInventoryKey?.({ profile, context }) || "inv";
    const planKey = adapters?.getMealPlanKey?.({ profile, context }) || "plan";
    const targetKey =
      adapters?.getPantryTargetsKey?.({ profile, context }) || "targets";

    const runKey = JSON.stringify({
      householdSize,
      level,
      includePlannedMeals: Boolean(includePlannedMeals),
      includeStorehouse: Boolean(includeStorehouse),
      invKey,
      planKey,
      targetKey,
      valuationMapVersion: String(defaults.valuationMapVersion || "1"),
    });

    if (runKey === lastRunKeyRef.current) return;

    if (runTimerRef.current) {
      window.clearTimeout(runTimerRef.current);
      runTimerRef.current = null;
    }

    runTimerRef.current = window.setTimeout(
      () => {
        runTimerRef.current = null;
        lastRunKeyRef.current = runKey;
        run({ reason: "autoRun" });
      },
      Math.max(0, debounceMs),
    );

    return () => {
      if (runTimerRef.current) {
        window.clearTimeout(runTimerRef.current);
        runTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    autoRun,
    gatedOn,
    debounceMs,
    includePlannedMeals,
    includeStorehouse,
    profile?.household?.size,
    profile?.homestead?.level,
    defaults.householdSize,
    defaults.valuationMapVersion,
  ]);

  return useMemo(
    () => ({
      status,
      gatedOn,
      result,
      explain,
      run,
      refresh,
      // helpful context for UI wiring
      visibility: vis,
      profile,
    }),
    [status, gatedOn, result, explain, run, refresh, vis, profile],
  );
}

/* =============================================================================
   Defaults
============================================================================= */

const DEFAULTS = {
  householdSize: 4,
  mealsPerDay: 2, // SSA default rhythm can override per IF preset if you want later
  servingsPerMealPerPerson: 1, // 1 serving per meal per person
  wasteFactor: 0.08, // 8% waste/spoilage approximation
  unknownItemServingsFallback: 0, // if we can't value an item, treat as 0 servings by default
  valuationMapVersion: "1",
};

/**
 * DEFAULT_VALUATION_MAP
 * -----------------------------------------------------------------------------
 * Deterministic "servings per unit" for common pantry staples.
 * You should eventually replace/extend this with:
 *   src/catalogs/estimators/valuation.map.json
 * and pass it in via the hook options.
 *
 * Format:
 * key = normalized item key (prefer ingredientId, then sku, then label)
 * value:
 * - servingsPerUnit: number
 * - unit: string label (informational)
 * - category: for grouping
 */
const DEFAULT_VALUATION_MAP = {
  // Staples
  "rice.white": { servingsPerUnit: 20, unit: "5 lb bag", category: "grains" },
  "rice.brown": { servingsPerUnit: 20, unit: "5 lb bag", category: "grains" },
  "beans.dry": { servingsPerUnit: 25, unit: "5 lb bag", category: "legumes" },
  "beans.canned": {
    servingsPerUnit: 3,
    unit: "15 oz can",
    category: "legumes",
  },
  "lentils.dry": { servingsPerUnit: 25, unit: "5 lb bag", category: "legumes" },
  oats: { servingsPerUnit: 30, unit: "42 oz container", category: "grains" },
  pasta: { servingsPerUnit: 10, unit: "1 lb box", category: "grains" },
  flour: { servingsPerUnit: 45, unit: "10 lb bag", category: "grains" },

  // Proteins (very approximate “meal servings”)
  "chicken.whole": {
    servingsPerUnit: 8,
    unit: "whole chicken",
    category: "protein",
  },
  "beef.ground": { servingsPerUnit: 4, unit: "1 lb", category: "protein" },
  "goat.meat": { servingsPerUnit: 6, unit: "2 lb", category: "protein" },
  eggs: { servingsPerUnit: 12, unit: "dozen", category: "protein" },

  // Vegetables / fruit (approx)
  "veg.frozen": { servingsPerUnit: 8, unit: "2 lb bag", category: "produce" },
  "veg.canned": { servingsPerUnit: 3, unit: "15 oz can", category: "produce" },
  "fruit.frozen": { servingsPerUnit: 8, unit: "2 lb bag", category: "produce" },

  // Fats
  oil: { servingsPerUnit: 60, unit: "48 oz bottle", category: "fats" },

  // Pantry helpers
  salt: { servingsPerUnit: 200, unit: "26 oz", category: "seasoning" },
};

/* =============================================================================
   Core computations
============================================================================= */

function computeAvailableServings({ inventory, valuationMap, assumptions }) {
  const items = Array.isArray(inventory?.items) ? inventory.items : [];
  const wasteFactor = clampNumber(assumptions?.wasteFactor ?? 0, 0, 0.5);

  let totalServings = 0;

  const categoryTotals = new Map(); // category -> servings
  const unvalued = [];

  for (const it of items) {
    const key = pickValuationKey(it);
    const val =
      valuationMap?.[key] || valuationMap?.[normalizeKey(it.label)] || null;

    const qty = clampNumber(it.quantity ?? 0, 0, 1e12);

    if (!val || !Number.isFinite(Number(val.servingsPerUnit))) {
      const fallback = clampNumber(
        assumptions?.unknownItemServingsFallback ?? 0,
        0,
        1e6,
      );
      if (fallback > 0) {
        totalServings += qty * fallback;
      } else {
        unvalued.push({ key, label: it.label, quantity: qty, unit: it.unit });
      }
      continue;
    }

    const servingsPerUnit = Number(val.servingsPerUnit);
    const gross = qty * servingsPerUnit;
    const net = gross * (1 - wasteFactor);

    totalServings += net;

    const cat = String(val.category || it.category || "other");
    categoryTotals.set(cat, (categoryTotals.get(cat) || 0) + net);
  }

  // Build top categories list
  const topCategories = [...categoryTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([category, servings]) => ({
      category,
      servings: roundTo(servings, 2),
      pct: totalServings > 0 ? roundTo(servings / totalServings, 4) : 0,
    }));

  return {
    totalServings: roundTo(totalServings, 2),
    topCategories,
    unvalued,
  };
}

/**
 * computePlannedMealGaps
 * -----------------------------------------------------------------------------
 * If you have a planned meal list, try to compute a "demand" and detect
 * missing staples based on simple pantry keys.
 *
 * Minimal supported mealPlan snapshot:
 * {
 *   items: [{ id, title, servingsNeeded?, required?: [{ key, qty }] }]
 * }
 *
 * If servingsNeeded is absent, we approximate:
 * - each planned meal consumes householdSize * servingsPerMealPerPerson servings
 */
function computePlannedMealGaps({
  mealPlan,
  inventory,
  valuationMap,
  assumptions,
}) {
  const planItems = Array.isArray(mealPlan?.items) ? mealPlan.items : [];
  const householdSize = clampNumber(assumptions.householdSize, 1, 50);
  const servingsPerMealPerPerson = clampNumber(
    assumptions.servingsPerMealPerPerson,
    0.5,
    4,
  );

  if (!planItems.length) {
    return { gaps: [], demandServings: null, demandDays: null };
  }

  // Demand in servings
  let demandServings = 0;

  // Optional "required pantry keys" demand
  const requiredKeyDemand = new Map(); // key -> qty units (units are conceptual)
  for (const m of planItems) {
    const servingsNeeded = Number.isFinite(Number(m.servingsNeeded))
      ? Number(m.servingsNeeded)
      : householdSize * servingsPerMealPerPerson;

    demandServings += servingsNeeded;

    const req = Array.isArray(m.required) ? m.required : [];
    for (const r of req) {
      const k = normalizeKey(r.key || r.id || r.label || "");
      const q = clampNumber(r.qty ?? r.quantity ?? 0, 0, 1e9);
      if (!k || q <= 0) continue;
      requiredKeyDemand.set(k, (requiredKeyDemand.get(k) || 0) + q);
    }
  }

  const dailyServingsNeeded =
    householdSize *
    clampNumber(assumptions.mealsPerDay, 1, 6) *
    servingsPerMealPerPerson;
  const demandDays =
    dailyServingsNeeded > 0 ? demandServings / dailyServingsNeeded : null;

  // Inventory supply per key (in "units" as seen by valuation key)
  const supplyByKey = new Map();
  for (const it of inventory.items || []) {
    const k = pickValuationKey(it);
    if (!k) continue;
    supplyByKey.set(
      k,
      (supplyByKey.get(k) || 0) + clampNumber(it.quantity ?? 0, 0, 1e12),
    );
  }

  const gaps = [];

  // If the plan declared required keys, use those.
  if (requiredKeyDemand.size) {
    for (const [k, demandUnits] of requiredKeyDemand.entries()) {
      const supplyUnits = supplyByKey.get(k) || 0;
      if (supplyUnits + 1e-9 < demandUnits) {
        const missingUnits = demandUnits - supplyUnits;
        const val = valuationMap?.[k] || null;
        gaps.push({
          key: k,
          label: prettyKey(k),
          missingUnits: roundTo(missingUnits, 2),
          unit: val?.unit || "unit(s)",
          severity: missingUnits > 0 ? "high" : "low",
          reason:
            "Planned meals require this item more than your inventory currently has.",
        });
      }
    }
  } else {
    // Otherwise, infer gaps from low category diversity (simple heuristic)
    // If grains or legumes are missing in top categories, recommend stocking.
    const available = computeAvailableServings({
      inventory,
      valuationMap,
      assumptions,
    });
    const cats = new Set(
      (available.topCategories || []).map((c) => c.category),
    );
    const staples = [
      { key: "rice.white", label: "Rice", category: "grains" },
      { key: "beans.dry", label: "Beans", category: "legumes" },
      { key: "oats", label: "Oats", category: "grains" },
      { key: "pasta", label: "Pasta", category: "grains" },
    ];

    for (const s of staples) {
      if (!cats.has(s.category)) {
        gaps.push({
          key: s.key,
          label: s.label,
          missingUnits: null,
          unit: valuationMap?.[s.key]?.unit || "starter amount",
          severity: "medium",
          reason: `Your pantry looks light on ${s.category}. Stocking a staple improves coverage and meal flexibility.`,
        });
      }
    }
  }

  return {
    gaps: gaps.sort(severitySort),
    demandServings: roundTo(demandServings, 2),
    demandDays: demandDays == null ? null : roundTo(demandDays, 2),
  };
}

/**
 * computeTargetsGaps
 * -----------------------------------------------------------------------------
 * Pantry targets are optional. If present, compare target units vs inventory.
 *
 * Targets shape supported:
 * { targets: [{ key, qty, label?, unit? }] }
 */
function computeTargetsGaps({ targets, inventory, valuationMap, assumptions }) {
  const list = Array.isArray(targets?.targets) ? targets.targets : [];
  if (!list.length) return { targetGaps: [] };

  const supplyByKey = new Map();
  for (const it of inventory.items || []) {
    const k = pickValuationKey(it);
    if (!k) continue;
    supplyByKey.set(
      k,
      (supplyByKey.get(k) || 0) + clampNumber(it.quantity ?? 0, 0, 1e12),
    );
  }

  const targetGaps = [];
  for (const t of list) {
    const k = normalizeKey(t.key || t.id || t.label || "");
    const demand = clampNumber(t.qty ?? t.quantity ?? 0, 0, 1e12);
    if (!k || demand <= 0) continue;

    const supply = supplyByKey.get(k) || 0;
    if (supply + 1e-9 < demand) {
      const missing = demand - supply;
      const val = valuationMap?.[k] || null;
      targetGaps.push({
        key: k,
        label: t.label || val?.label || prettyKey(k),
        missingUnits: roundTo(missing, 2),
        unit: t.unit || val?.unit || "unit(s)",
        severity: missing > 0 ? "high" : "low",
        reason:
          "Your storehouse target is higher than what you currently have.",
      });
    }
  }

  return { targetGaps: targetGaps.sort(severitySort) };
}

function buildNextBestActions({
  available,
  planAnalysis,
  targetAnalysis,
  defaults,
}) {
  const actions = [];

  // High-priority: explicit target gaps
  for (const g of (targetAnalysis?.targetGaps || []).slice(0, 5)) {
    actions.push({
      id: `nba.target.${g.key}`,
      type: "restock",
      label: `Restock ${g.label}`,
      detail:
        g.missingUnits != null
          ? `Missing ~${g.missingUnits} ${g.unit}`
          : "Below target",
      priority: "high",
      why: g.reason,
      key: g.key,
    });
  }

  // Next: plan gaps
  for (const g of (planAnalysis?.gaps || []).slice(0, 5)) {
    actions.push({
      id: `nba.plan.${g.key}`,
      type: "buy_or_substitute",
      label: `Cover the gap: ${g.label}`,
      detail:
        g.missingUnits != null
          ? `Short ~${g.missingUnits} ${g.unit}`
          : "Pantry staple recommended",
      priority: g.severity === "high" ? "high" : "medium",
      why: g.reason,
      key: g.key,
    });
  }

  // If coverage is very low, add a general action
  if ((available?.totalServings || 0) <= 0) {
    actions.push({
      id: "nba.bootstrap",
      type: "bootstrap",
      label: "Add pantry basics",
      detail: "Start with rice, beans, oil, and frozen vegetables.",
      priority: "high",
      why: "No valued inventory was detected. Adding basics gives immediate coverage.",
    });
  }

  // De-dup by key/label
  const seen = new Set();
  const uniq = [];
  for (const a of actions) {
    const k = a.key || a.label;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(a);
  }

  return uniq.slice(0, clampNumber(defaults.maxActions ?? 8, 1, 20));
}

function computeConfidence({
  inventory,
  valuationMap,
  assumptions,
  hasMealPlan,
  hasTargets,
}) {
  const items = Array.isArray(inventory?.items) ? inventory.items : [];
  if (!items.length) return 0.15;

  let valued = 0;
  let total = 0;

  for (const it of items) {
    total += 1;
    const key = pickValuationKey(it);
    const val =
      valuationMap?.[key] || valuationMap?.[normalizeKey(it.label)] || null;
    if (val && Number.isFinite(Number(val.servingsPerUnit))) valued += 1;
  }

  const valuationCoverage = total > 0 ? valued / total : 0;
  const base = 0.25 + 0.55 * clamp01(valuationCoverage);

  const mealBoost = hasMealPlan ? 0.08 : 0;
  const targetBoost = hasTargets ? 0.08 : 0;

  // If wasteFactor is extreme, reduce confidence slightly
  const waste = clampNumber(assumptions?.wasteFactor ?? 0.08, 0, 0.5);
  const wastePenalty = waste > 0.2 ? 0.05 : 0;

  return roundTo(clamp01(base + mealBoost + targetBoost - wastePenalty), 3);
}

/* =============================================================================
   Normalization helpers (adapters can pass anything; we normalize)
============================================================================= */

function normalizeInventorySnapshot(raw) {
  // Supported shapes:
  // - { items: [...] }
  // - [...] (array of items)
  // - null/undefined
  const itemsRaw = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.items)
      ? raw.items
      : [];
  const items = itemsRaw
    .map((x) => normalizeInventoryItem(x))
    .filter((x) => x && x.label);

  return { items };
}

function normalizeInventoryItem(x) {
  if (!x || typeof x !== "object") return null;

  const label = String(x.label || x.name || x.title || "").trim();
  const ingredientId = x.ingredientId || x.ingredient_id || x.id || null;
  const sku = x.sku || x.productId || null;

  // quantity: best effort
  const quantity = firstNumber(x.quantity, x.qty, x.count, x.amount?.value);
  const unit = String(x.unit || x.amount?.unit || x.uom || "unit").trim();

  const category = x.category || x.group || null;

  return {
    label:
      label || (ingredientId ? String(ingredientId) : sku ? String(sku) : ""),
    ingredientId: ingredientId ? String(ingredientId) : null,
    sku: sku ? String(sku) : null,
    quantity: Number.isFinite(quantity) ? quantity : 0,
    unit,
    category: category ? String(category) : null,
  };
}

function normalizeMealPlanSnapshot(raw) {
  // Supported shapes:
  // - { items: [...] }
  // - [...] array
  const itemsRaw = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.items)
      ? raw.items
      : [];
  const items = itemsRaw
    .map((m) => {
      if (!m || typeof m !== "object") return null;
      return {
        id: String(m.id || m.recipeId || m.title || `meal_${Math.random()}`),
        title: String(m.title || m.name || "Planned meal"),
        servingsNeeded: Number.isFinite(Number(m.servingsNeeded))
          ? Number(m.servingsNeeded)
          : null,
        required: Array.isArray(m.required)
          ? m.required
          : Array.isArray(m.ingredients)
            ? m.ingredients
            : [],
      };
    })
    .filter(Boolean);

  return { items };
}

function normalizePantryTargets(raw) {
  // Supported:
  // - { targets: [...] }
  // - [...] array
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.targets)
      ? raw.targets
      : [];
  return {
    targets: list
      .map((t) => {
        if (!t || typeof t !== "object") return null;
        const key = normalizeKey(t.key || t.id || t.label || "");
        const qty = firstNumber(t.qty, t.quantity, t.amount?.value);
        const unit = String(t.unit || t.amount?.unit || "unit(s)");
        const label = t.label ? String(t.label) : prettyKey(key);
        return key && Number.isFinite(qty) ? { key, qty, unit, label } : null;
      })
      .filter(Boolean),
  };
}

/* =============================================================================
   Explain builder
============================================================================= */

function buildExplain({ result, gatedOn, vis, profile }) {
  if (!gatedOn) {
    return {
      title: "Food Security estimate is hidden",
      body: "This estimate only shows when you opt into homesteading (choose a starting level) to avoid overwhelming the meal planner.",
      bullets: [
        "Go to Homestead Planner.",
        "Choose a starting level (1+).",
        "Then you’ll see coverage days and pantry gaps.",
      ],
    };
  }

  if (!result) {
    return {
      title: "Food Security estimate is ready",
      body: "Run the estimate to calculate coverage days and identify the first pantry gaps.",
      bullets: [],
    };
  }

  const hh = clampNumber(profile?.household?.size ?? 4, 1, 50);
  const days = result?.outputs?.coverageDays;

  return {
    title: "What this estimate means",
    body:
      `SSA estimates how long your household can stay fed based on your inventory, using serving assumptions and pantry valuations. ` +
      `Household size: ${hh}. Estimated coverage: ${days != null ? days : "—"} day(s).`,
    bullets: [
      "Coverage days = total valued servings ÷ daily serving needs.",
      "Gaps show items you’ll run out of first (or pantry staples you’re light on).",
      "Add inventory + targets to increase accuracy.",
    ],
    details: {
      confidence: result?.outputs?.confidence,
      dailyServingsNeeded: result?.outputs?.dailyServingsNeeded,
      totalServings: result?.outputs?.totalServings,
      reason: vis?.reason,
    },
  };
}

/* =============================================================================
   Utilities
============================================================================= */

function pickValuationKey(item) {
  // Prefer deterministic keys:
  // 1) ingredientId if it already looks like a catalog key (e.g., "rice.white")
  // 2) sku/product id
  // 3) normalized label
  const iid = (item?.ingredientId || "").trim();
  if (iid) return normalizeKey(iid);

  const sku = (item?.sku || "").trim();
  if (sku) return normalizeKey(sku);

  return normalizeKey(item?.label || "");
}

function normalizeKey(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^\w.-]/g, "")
    .slice(0, 120);
}

function prettyKey(k) {
  const s = String(k || "")
    .replace(/[_\-]+/g, " ")
    .trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "Item";
}

function severitySort(a, b) {
  const rank = (x) => (x === "high" ? 3 : x === "medium" ? 2 : 1);
  return rank(b?.severity) - rank(a?.severity);
}

function clampNumber(v, min, max) {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function clamp01(v) {
  return clampNumber(v, 0, 1);
}

function roundTo(n, places = 2) {
  const x = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(x)) return 0;
  const p = Math.pow(10, places);
  return Math.round(x * p) / p;
}

function firstNumber(...vals) {
  for (const v of vals) {
    const n =
      typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}

function resolveMaybeAsync(v) {
  try {
    if (typeof v === "function") return resolveMaybeAsync(v());
    if (v && typeof v.then === "function") return v;
    return Promise.resolve(v);
  } catch (e) {
    return Promise.reject(e);
  }
}

function safeEmit(emit, name, payload) {
  try {
    if (typeof emit === "function") emit(name, payload);
  } catch {
    // ignore
  }
}

function sanitizeContext(context) {
  if (!context || typeof context !== "object") return null;
  // Keep only safe, small fields for logs
  const allowed = ["mode", "plannerMode", "screen", "route", "origin"];
  const out = {};
  for (const k of allowed) {
    if (context[k] != null) out[k] = String(context[k]);
  }
  return out;
}

function makeRunId() {
  // deterministic-enough local run id
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
