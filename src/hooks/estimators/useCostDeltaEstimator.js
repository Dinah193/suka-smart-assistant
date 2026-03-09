// C:\Users\larho\suka-smart-assistant\src\hooks\estimators\useCostDeltaEstimator.js

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHomesteadProfile } from "../homestead/useHomesteadProfile";
import { useHomesteadVisibility } from "../homestead/useHomesteadVisibility";

/**
 * useCostDeltaEstimator
 * -----------------------------------------------------------------------------
 * Deterministic estimator for "cost delta" and "budget reduction" as a household
 * increases scratch cooking and homesteading.
 *
 * Plain-language goal:
 * - Compare baseline grocery spending vs. "scratch/homestead" spending using
 *   default valuation assumptions and (optionally) user price data.
 * - Output directional savings (weekly/monthly) and explain what drives them.
 *
 * Key constraints:
 * - No AI.
 * - Works with incomplete data (defaults).
 * - Adapters are pluggable (Dexie/Zustand/etc.).
 *
 * Designed to show ONLY when homesteading is opted-in (level > 0),
 * using the visibility gate.
 *
 * -----------------------------------------------------------------------------
 * Inputs (adapters; optional)
 * - getPrices(): price map snapshot
 * - getMealPlan(): planned meals
 * - getInventory(): pantry snapshot (used to reduce “need to buy”)
 * - getProduction(): garden/animals/preservation production snapshot (optional)
 * - emit(eventName, payload) optional
 *
 * -----------------------------------------------------------------------------
 * Outputs
 * - weeklySavings, monthlySavings
 * - baselineCost, scratchCost
 * - drivers[] (plain-language, deterministic)
 * - confidence score
 */

export function useCostDeltaEstimator(options = {}) {
  const {
    context = null,
    profileOptions = undefined,
    visibilityOptions = undefined,

    adapters = {},

    // A deterministic "component cost" table:
    // - used if no price map is provided
    // - you should eventually pass: src/catalogs/estimators/cost_delta_defaults.catalog.json
    defaults = DEFAULTS,

    // Optional "value map" for meal components (servings/units)
    valuationMap = DEFAULT_VALUATION_MAP,

    autoRun = true,
    debounceMs = 350,

    includeInventoryOffset = true,
    includeProductionOffset = true,

    estimatorId = "estimators.cost_delta",
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

  const gatedOn = Boolean(vis?.showCostDeltaEstimator);

  const status = useMemo(
    () => ({
      loading: phase === "loading",
      ready: phase === "ready",
      error,
      phase,
      gatedOn,
      source: {
        profile: profileStatus?.source || "default",
        prices: adapters?.getPrices ? "adapter" : "defaults",
        mealPlan: adapters?.getMealPlan ? "adapter" : "defaults",
        inventory: adapters?.getInventory ? "adapter" : "none",
        production: adapters?.getProduction ? "adapter" : "none",
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
        const householdSize = clampNumber(
          profile?.household?.size ?? defaults.householdSize,
          1,
          50,
        );
        const homesteadLevel = clampNumber(
          profile?.homestead?.level ?? 0,
          0,
          10,
        );

        // Data adapters (sync or async)
        const [rawPrices, rawMealPlan, rawInventory, rawProduction] =
          await Promise.all([
            resolveMaybeAsync(adapters?.getPrices?.({ profile, context })),
            resolveMaybeAsync(adapters?.getMealPlan?.({ profile, context })),
            resolveMaybeAsync(adapters?.getInventory?.({ profile, context })),
            resolveMaybeAsync(adapters?.getProduction?.({ profile, context })),
          ]);

        const prices = normalizePriceMap(rawPrices);
        const mealPlan = normalizeMealPlanSnapshot(rawMealPlan);
        const inventory = includeInventoryOffset
          ? normalizeInventorySnapshot(rawInventory)
          : { items: [] };
        const production = includeProductionOffset
          ? normalizeProductionSnapshot(rawProduction)
          : { credits: [] };

        const assumptions = buildAssumptions({
          defaults,
          householdSize,
          homesteadLevel,
          hasPrices: prices.entries.length > 0,
          includeInventoryOffset,
          includeProductionOffset,
        });

        // 1) Determine "weekly demand bundle" (what the household typically buys)
        const weeklyBundle = computeWeeklyDemandBundle({
          mealPlan,
          householdSize,
          assumptions,
          defaults,
          valuationMap,
        });

        // 2) Baseline costs: more convenience / more store-bought
        const baseline = priceBundle({
          bundle: weeklyBundle,
          prices,
          defaults,
          mode: "baseline",
          assumptions,
        });

        // 3) Scratch costs: more raw ingredients, less convenience
        const scratch = priceBundle({
          bundle: weeklyBundle,
          prices,
          defaults,
          mode: "scratch",
          assumptions,
        });

        // 4) Offsets: inventory on-hand + home production credits
        const offsets = computeOffsets({
          bundle: weeklyBundle,
          inventory,
          production,
          prices,
          defaults,
          assumptions,
        });

        // Apply offsets (cannot go below 0)
        const baselineNet = Math.max(
          0,
          baseline.weeklyCost -
            offsets.weeklyOffsetValue * assumptions.offsetAffectsBaseline,
        );
        const scratchNet = Math.max(
          0,
          scratch.weeklyCost - offsets.weeklyOffsetValue,
        );

        const weeklySavings = roundTo(baselineNet - scratchNet, 2);
        const monthlySavings = roundTo(weeklySavings * 4.345, 2); // average weeks per month

        const drivers = buildDrivers({
          baseline,
          scratch,
          offsets,
          assumptions,
          weeklySavings,
          pricesUsed: prices.entries.length > 0,
        });

        const confidence = computeConfidence({
          prices,
          mealPlan,
          inventory,
          production,
          assumptions,
        });

        const next = {
          schemaVersion: "1.0.0",
          updatedAt: new Date().toISOString(),
          meta: {
            id: estimatorId,
            type: "estimator_result",
            domain: "estimators",
            locale: "en-US",
            label: "Cost Delta",
            description:
              "Estimates budget impact when shifting from convenience groceries to scratch cooking and homesteading, using defaults and optional local price data.",
          },
          run: {
            id: makeRunId(),
            createdAt: startedAt,
            context: sanitizeContext(context),
            inputs: {
              householdSize,
              homesteadLevel,
              includeInventoryOffset: Boolean(includeInventoryOffset),
              includeProductionOffset: Boolean(includeProductionOffset),
              priceEntries: prices.entries.length,
              mealPlanCount: mealPlan.items.length,
              inventoryCount: inventory.items.length,
              productionCredits: production.credits.length,
            },
            assumptions,
          },
          outputs: {
            weeklySavings,
            monthlySavings,
            baselineWeeklyCost: roundTo(baselineNet, 2),
            scratchWeeklyCost: roundTo(scratchNet, 2),
            baselineGrossWeeklyCost: roundTo(baseline.weeklyCost, 2),
            scratchGrossWeeklyCost: roundTo(scratch.weeklyCost, 2),

            bundle: weeklyBundle.summary,
            offsets: {
              weeklyOffsetValue: roundTo(offsets.weeklyOffsetValue, 2),
              inventoryOffsetValue: roundTo(offsets.inventoryOffsetValue, 2),
              productionOffsetValue: roundTo(offsets.productionOffsetValue, 2),
            },

            drivers,
            confidence,
          },
        };

        setResult(next);
        setPhase("ready");
        safeEmit(adapters?.emit, "estimators.cost_delta.ran", {
          result: next,
          meta,
        });

        return next;
      } catch (e) {
        setError(e);
        setPhase("error");
        safeEmit(adapters?.emit, "estimators.cost_delta.error", {
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
      includeInventoryOffset,
      includeProductionOffset,
      profile,
      valuationMap,
    ],
  );

  const refresh = run;

  // Auto-run when gated visible and stable inputs change.
  useEffect(() => {
    if (!autoRun) return;
    if (!gatedOn) return;

    const householdSize = clampNumber(
      profile?.household?.size ?? defaults.householdSize,
      1,
      50,
    );
    const level = clampNumber(profile?.homestead?.level ?? 0, 0, 10);

    const priceKey = adapters?.getPricesKey?.({ profile, context }) || "prices";
    const planKey = adapters?.getMealPlanKey?.({ profile, context }) || "plan";
    const invKey = adapters?.getInventoryKey?.({ profile, context }) || "inv";
    const prodKey =
      adapters?.getProductionKey?.({ profile, context }) || "prod";

    const runKey = JSON.stringify({
      householdSize,
      level,
      includeInventoryOffset: Boolean(includeInventoryOffset),
      includeProductionOffset: Boolean(includeProductionOffset),
      priceKey,
      planKey,
      invKey,
      prodKey,
      defaultsVersion: String(defaults.defaultsVersion || "1"),
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
    includeInventoryOffset,
    includeProductionOffset,
    profile?.household?.size,
    profile?.homestead?.level,
    defaults.householdSize,
    defaults.defaultsVersion,
  ]);

  return useMemo(
    () => ({
      status,
      gatedOn,
      result,
      explain,
      run,
      refresh,
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
  defaultsVersion: "1",

  householdSize: 4,

  // Weekly demand bundle size (if no meal plan provided):
  weeklyMealsFallback: 10, // meals cooked at home per week
  servingsPerMealPerPerson: 1,

  // How much “convenience premium” baseline has vs scratch:
  // baseline uses more processed/convenience items; scratch uses more staples.
  baselineConvenienceMultiplier: 1.18, // 18% premium
  scratchEfficiencyMultiplier: 0.92, // 8% savings for scratch vs baseline input costs

  // Homestead level impacts:
  // higher level => higher offset due to production and reduced buying.
  // This is deterministic and intentionally modest.
  homesteadLevelSavingsFactor: {
    0: 0.0,
    1: 0.05,
    2: 0.08,
    3: 0.12,
    4: 0.15,
    5: 0.18,
    6: 0.2,
    7: 0.22,
    8: 0.24,
    9: 0.26,
    10: 0.28,
  },

  // Offsets:
  // - inventory/production reduce scratch costs first (more direct)
  // - baseline is partially affected because baseline includes more convenience
  //   items that don't map 1:1 to pantry items.
  offsetAffectsBaseline: 0.45,

  // Fallback component costs (USD) for weekly staples (directional).
  // Keys are deterministic categories and common items.
  fallbackPrices: {
    // staples
    "rice.white": 0.9, // per "unit" in valuation map (e.g., 5 lb bag) => price per unit
    "beans.dry": 1.2,
    oats: 3.5,
    pasta: 1.6,
    flour: 6.0,
    oil: 5.0,
    "veg.frozen": 4.0,
    "beans.canned": 1.2,
    // proteins
    eggs: 3.0,
    "beef.ground": 5.0,
    "chicken.whole": 8.0,
    "goat.meat": 14.0,
  },

  // Max number of driver statements
  maxDrivers: 8,
};

/**
 * DEFAULT_VALUATION_MAP
 * -----------------------------------------------------------------------------
 * "Unit" definitions for demand bundling. Reuse from Food Security estimator,
 * but kept local so hook can run standalone.
 */
const DEFAULT_VALUATION_MAP = {
  "rice.white": { unit: "5 lb bag", category: "grains" },
  "beans.dry": { unit: "5 lb bag", category: "legumes" },
  oats: { unit: "42 oz container", category: "grains" },
  pasta: { unit: "1 lb box", category: "grains" },
  flour: { unit: "10 lb bag", category: "grains" },
  oil: { unit: "48 oz bottle", category: "fats" },
  "veg.frozen": { unit: "2 lb bag", category: "produce" },
  "beans.canned": { unit: "15 oz can", category: "legumes" },
  eggs: { unit: "dozen", category: "protein" },
  "beef.ground": { unit: "1 lb", category: "protein" },
  "chicken.whole": { unit: "whole chicken", category: "protein" },
  "goat.meat": { unit: "2 lb", category: "protein" },
};

/* =============================================================================
   Core computations
============================================================================= */

function buildAssumptions({
  defaults,
  householdSize,
  homesteadLevel,
  hasPrices,
  includeInventoryOffset,
  includeProductionOffset,
}) {
  const servingsPerMealPerPerson = clampNumber(
    defaults.servingsPerMealPerPerson,
    0.5,
    4,
  );
  const weeklyMealsFallback = clampNumber(defaults.weeklyMealsFallback, 1, 28);

  return {
    householdSize,
    homesteadLevel,
    hasPrices,
    includeInventoryOffset,
    includeProductionOffset,
    weeklyMealsFallback,
    servingsPerMealPerPerson,
    baselineConvenienceMultiplier: clampNumber(
      defaults.baselineConvenienceMultiplier,
      1,
      2,
    ),
    scratchEfficiencyMultiplier: clampNumber(
      defaults.scratchEfficiencyMultiplier,
      0.6,
      1.2,
    ),
    levelSavingsFactor: getLevelSavingsFactor(defaults, homesteadLevel),
    offsetAffectsBaseline: clampNumber(defaults.offsetAffectsBaseline, 0, 1),
  };
}

/**
 * computeWeeklyDemandBundle
 * -----------------------------------------------------------------------------
 * Returns a deterministic weekly bundle of "units" the household tends to need.
 *
 * If meal plan is present, we can:
 * - count planned meals and scale a base bundle
 * If not:
 * - use fallback weeklyMealsFallback.
 *
 * Bundle format:
 * {
 *   units: { key -> qtyUnits },
 *   summary: { mealCount, householdSize, rationale }
 * }
 */
function computeWeeklyDemandBundle({
  mealPlan,
  householdSize,
  assumptions,
  defaults,
  valuationMap,
}) {
  const planMeals = Array.isArray(mealPlan?.items) ? mealPlan.items.length : 0;
  const mealCount = planMeals > 0 ? planMeals : assumptions.weeklyMealsFallback;

  // A base bundle per 10 meals (tweakable). Deterministic.
  const basePer10Meals = {
    "rice.white": 1,
    "beans.dry": 1,
    oats: 0.4,
    pasta: 0.6,
    flour: 0.35,
    oil: 0.3,
    "veg.frozen": 1,
    eggs: 1,
    "beef.ground": 0.8,
    "chicken.whole": 0.7,
  };

  // Scale by mealCount/10 and household size relative to 4
  const mealScale = mealCount / 10;
  const hhScale = householdSize / 4;

  const units = {};
  for (const [k, q] of Object.entries(basePer10Meals)) {
    const qty = roundTo(q * mealScale * hhScale, 2);
    if (qty > 0) units[k] = qty;
  }

  // If homestead level is higher, slightly shift toward staples (less convenience)
  // We do not need a "convenience" key; we just reflect that staples cover more meals.
  const levelBoost = assumptions.levelSavingsFactor; // 0..~0.28
  if (levelBoost > 0) {
    // increase staples slightly, reduce proteins slightly (assumes more legumes/grains used)
    units["rice.white"] = roundTo(
      (units["rice.white"] || 0) * (1 + levelBoost * 0.6),
      2,
    );
    units["beans.dry"] = roundTo(
      (units["beans.dry"] || 0) * (1 + levelBoost * 0.9),
      2,
    );
    units["beef.ground"] = roundTo(
      (units["beef.ground"] || 0) * (1 - levelBoost * 0.35),
      2,
    );
    units["chicken.whole"] = roundTo(
      (units["chicken.whole"] || 0) * (1 - levelBoost * 0.2),
      2,
    );
  }

  return {
    units,
    summary: {
      mealCount,
      householdSize,
      rationale:
        planMeals > 0
          ? "Scaled from your planned meals."
          : "Used default weekly meals (no meal plan detected).",
    },
  };
}

/**
 * priceBundle
 * -----------------------------------------------------------------------------
 * Convert a bundle of units into weekly cost using:
 * - user price map if present
 * - fallbackPrices otherwise
 *
 * Mode:
 * - baseline: add convenience premium
 * - scratch: apply scratch efficiency multiplier
 */
function priceBundle({ bundle, prices, defaults, mode, assumptions }) {
  const units = bundle?.units || {};
  const entries = Object.entries(units);

  let weeklyCost = 0;
  const breakdown = [];

  for (const [k, qtyUnits] of entries) {
    const unitPrice = lookupPrice(prices, k, defaults);
    const cost = qtyUnits * unitPrice;
    weeklyCost += cost;
    breakdown.push({
      key: k,
      qtyUnits: roundTo(qtyUnits, 2),
      unitPrice: roundTo(unitPrice, 2),
      cost: roundTo(cost, 2),
    });
  }

  // Apply deterministic mode adjustment
  let adjusted = weeklyCost;

  if (mode === "baseline") {
    adjusted *= assumptions.baselineConvenienceMultiplier;
  } else if (mode === "scratch") {
    adjusted *= assumptions.scratchEfficiencyMultiplier;
  }

  return {
    weeklyCost: roundTo(adjusted, 2),
    weeklyCostRaw: roundTo(weeklyCost, 2),
    breakdown,
    mode,
  };
}

/**
 * computeOffsets
 * -----------------------------------------------------------------------------
 * Offset value reduces the "need to buy" and thus cost.
 * We estimate offset value in dollars using:
 * - inventory items that match bundle keys
 * - production credits that match bundle keys
 *
 * Production snapshot supported:
 * - credits: [{ key, qtyUnits, valueUsd? }]
 */
function computeOffsets({
  bundle,
  inventory,
  production,
  prices,
  defaults,
  assumptions,
}) {
  const bundleUnits = bundle?.units || {};
  const needKeys = Object.keys(bundleUnits);

  const invSupply = supplyByKey(inventory?.items || []);
  const invOffsetValue = estimateOffsetValue({
    supply: invSupply,
    needed: bundleUnits,
    prices,
    defaults,
  });

  const prodOffsetValue = estimateProductionValue({
    production,
    needed: bundleUnits,
    prices,
    defaults,
  });

  // Homestead level adds a deterministic modest "efficiency" factor (you waste less / substitute better)
  const levelFactor = 1 + assumptions.levelSavingsFactor;

  const weeklyOffsetValue = roundTo(
    (invOffsetValue + prodOffsetValue) * levelFactor,
    2,
  );

  return {
    weeklyOffsetValue,
    inventoryOffsetValue: roundTo(invOffsetValue, 2),
    productionOffsetValue: roundTo(prodOffsetValue, 2),
    keysConsidered: needKeys.slice(0, 30),
  };
}

function estimateOffsetValue({ supply, needed, prices, defaults }) {
  let value = 0;

  for (const [k, demandUnits] of Object.entries(needed || {})) {
    const haveUnits = supply.get(k) || 0;
    if (haveUnits <= 0 || demandUnits <= 0) continue;
    const usedUnits = Math.min(haveUnits, demandUnits);
    const unitPrice = lookupPrice(prices, k, defaults);
    value += usedUnits * unitPrice;
  }

  return value;
}

function estimateProductionValue({ production, needed, prices, defaults }) {
  const credits = Array.isArray(production?.credits) ? production.credits : [];
  let value = 0;

  for (const c of credits) {
    const k = normalizeKey(c.key || c.id || c.label || "");
    const qtyUnits = clampNumber(
      c.qtyUnits ?? c.qty ?? c.quantity ?? 0,
      0,
      1e12,
    );
    if (!k || qtyUnits <= 0) continue;

    // If credit provides an explicit value, use it; else price it.
    if (Number.isFinite(Number(c.valueUsd))) {
      value += Number(c.valueUsd);
      continue;
    }

    // Only count production against needed keys (avoid inflating with unrelated harvests)
    const demandUnits = needed?.[k] || 0;
    if (demandUnits <= 0) continue;

    const usedUnits = Math.min(qtyUnits, demandUnits);
    const unitPrice = lookupPrice(prices, k, defaults);
    value += usedUnits * unitPrice;
  }

  return value;
}

function buildDrivers({
  baseline,
  scratch,
  offsets,
  assumptions,
  weeklySavings,
  pricesUsed,
}) {
  const drivers = [];

  // Core delta
  const grossDelta = roundTo(baseline.weeklyCost - scratch.weeklyCost, 2);
  if (grossDelta !== 0) {
    drivers.push(
      grossDelta > 0
        ? `Scratch cooking reduces weekly cost by about ${formatCurrency(grossDelta)} before offsets (less convenience premium).`
        : `Scratch cooking increases weekly cost by about ${formatCurrency(Math.abs(grossDelta))} before offsets (rare; check assumptions).`,
    );
  }

  // Offsets
  if (offsets.weeklyOffsetValue > 0) {
    drivers.push(
      `Inventory + home production reduce buying by about ${formatCurrency(offsets.weeklyOffsetValue)}/week at your current level.`,
    );
  } else {
    drivers.push(
      "No inventory/production offsets were detected yet, so savings are mostly from buying less convenience food.",
    );
  }

  // Homestead level factor
  if (assumptions.homesteadLevel > 0) {
    drivers.push(
      `Homestead level ${assumptions.homesteadLevel} applies a modest savings factor (better substitution + less buying).`,
    );
  }

  // Prices vs defaults
  drivers.push(
    pricesUsed
      ? "This estimate used your price data when available."
      : "This estimate used SSA default prices (add price data for tighter accuracy).",
  );

  // Net result
  drivers.push(
    weeklySavings >= 0
      ? `Estimated net savings: about ${formatCurrency(weeklySavings)}/week.`
      : `Estimated net increase: about ${formatCurrency(Math.abs(weeklySavings))}/week (review data and assumptions).`,
  );

  return drivers.slice(0, clampNumber(DEFAULTS.maxDrivers, 1, 20));
}

function computeConfidence({
  prices,
  mealPlan,
  inventory,
  production,
  assumptions,
}) {
  const priceCoverage = prices.entries.length > 0 ? 0.45 : 0.15;

  const planCoverage = (mealPlan?.items?.length || 0) > 0 ? 0.2 : 0.08;
  const invCoverage = (inventory?.items?.length || 0) > 0 ? 0.18 : 0.05;
  const prodCoverage = (production?.credits?.length || 0) > 0 ? 0.12 : 0.04;

  const levelBoost = clampNumber(assumptions.levelSavingsFactor, 0, 0.3) * 0.2;

  return roundTo(
    clamp01(
      priceCoverage + planCoverage + invCoverage + prodCoverage + levelBoost,
    ),
    3,
  );
}

/* =============================================================================
   Normalizers
============================================================================= */

function normalizePriceMap(raw) {
  // Supported:
  // - { entries: [{ key, price }] }
  // - { key -> price }
  // - [{ key, price }]
  const entries = [];

  if (!raw) return { entries };

  if (Array.isArray(raw)) {
    for (const r of raw) {
      if (!r || typeof r !== "object") continue;
      const key = normalizeKey(r.key || r.id || r.label || "");
      const price = firstNumber(r.price, r.value, r.usd, r.amount);
      if (key && Number.isFinite(price))
        entries.push({ key, price: Number(price) });
    }
    return { entries };
  }

  if (raw && typeof raw === "object") {
    if (Array.isArray(raw.entries)) {
      for (const r of raw.entries) {
        if (!r || typeof r !== "object") continue;
        const key = normalizeKey(r.key || r.id || r.label || "");
        const price = firstNumber(r.price, r.value, r.usd, r.amount);
        if (key && Number.isFinite(price))
          entries.push({ key, price: Number(price) });
      }
      return { entries };
    }

    // Object map
    for (const [k, v] of Object.entries(raw)) {
      const key = normalizeKey(k);
      const price = firstNumber(v);
      if (key && Number.isFinite(price))
        entries.push({ key, price: Number(price) });
    }
  }

  return { entries };
}

function normalizeMealPlanSnapshot(raw) {
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
      };
    })
    .filter(Boolean);

  return { items };
}

function normalizeInventorySnapshot(raw) {
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

  const quantity = firstNumber(x.quantity, x.qty, x.count, x.amount?.value);
  const unit = String(x.unit || x.amount?.unit || x.uom || "unit").trim();

  return {
    label:
      label || (ingredientId ? String(ingredientId) : sku ? String(sku) : ""),
    ingredientId: ingredientId ? String(ingredientId) : null,
    sku: sku ? String(sku) : null,
    quantity: Number.isFinite(quantity) ? quantity : 0,
    unit,
  };
}

function normalizeProductionSnapshot(raw) {
  // Supported:
  // - { credits: [{ key, qtyUnits, valueUsd? }] }
  // - array of credits
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.credits)
      ? raw.credits
      : [];
  const credits = list
    .map((c) => {
      if (!c || typeof c !== "object") return null;
      const key = normalizeKey(c.key || c.id || c.label || "");
      const qtyUnits = firstNumber(
        c.qtyUnits,
        c.qty,
        c.quantity,
        c.amount?.value,
      );
      const valueUsd = firstNumber(c.valueUsd, c.value, c.usd);
      if (!key || !Number.isFinite(qtyUnits)) return null;
      return {
        key,
        qtyUnits: Number(qtyUnits),
        valueUsd: Number.isFinite(valueUsd) ? Number(valueUsd) : null,
      };
    })
    .filter(Boolean);

  return { credits };
}

/* =============================================================================
   Explain builder
============================================================================= */

function buildExplain({ result, gatedOn, vis, profile }) {
  if (!gatedOn) {
    return {
      title: "Cost & Savings estimate is hidden",
      body: "This estimate only appears when you opt into homesteading (choose a starting level), so the meal planner stays simple unless you want the extra detail.",
      bullets: [
        "Go to Homestead Planner.",
        "Pick a level (1+).",
        "Then SSA will show estimated weekly/monthly savings.",
      ],
    };
  }

  if (!result) {
    return {
      title: "Cost & Savings estimate is ready",
      body: "Run the estimate to see a directional weekly and monthly budget impact from scratch cooking and homesteading.",
      bullets: [],
    };
  }

  const hh = clampNumber(profile?.household?.size ?? 4, 1, 50);
  const ws = result?.outputs?.weeklySavings;
  const ms = result?.outputs?.monthlySavings;

  return {
    title: "What this estimate means",
    body:
      `SSA compares a “baseline” grocery path against a “scratch/homestead” path and estimates the difference. ` +
      `Household size: ${hh}. Estimated savings: ${ws != null ? formatCurrency(ws) : "—"}/week (~${ms != null ? formatCurrency(ms) : "—"}/month).`,
    bullets: [
      "Baseline includes a convenience premium (more prepared food).",
      "Scratch assumes more raw ingredients and better substitution.",
      "Inventory + home production can reduce what you need to buy.",
    ],
    details: {
      confidence: result?.outputs?.confidence,
      baselineWeeklyCost: result?.outputs?.baselineWeeklyCost,
      scratchWeeklyCost: result?.outputs?.scratchWeeklyCost,
      reason: vis?.reason,
    },
  };
}

/* =============================================================================
   Utilities
============================================================================= */

function supplyByKey(items) {
  const m = new Map();
  for (const it of items || []) {
    const k = pickKey(it);
    if (!k) continue;
    m.set(k, (m.get(k) || 0) + clampNumber(it.quantity ?? 0, 0, 1e12));
  }
  return m;
}

function pickKey(item) {
  const iid = (item?.ingredientId || "").trim();
  if (iid) return normalizeKey(iid);
  const sku = (item?.sku || "").trim();
  if (sku) return normalizeKey(sku);
  return normalizeKey(item?.label || "");
}

function lookupPrice(prices, key, defaults) {
  const k = normalizeKey(key);
  const entry = (prices?.entries || []).find((e) => e.key === k);
  if (entry && Number.isFinite(Number(entry.price))) return Number(entry.price);

  const fallback = defaults?.fallbackPrices?.[k];
  if (Number.isFinite(Number(fallback))) return Number(fallback);

  // If no fallback, use a very small placeholder to avoid NaN explosions.
  return 1.0;
}

function getLevelSavingsFactor(defaults, level) {
  const lvl = clampNumber(level, 0, 10);
  const map = defaults?.homesteadLevelSavingsFactor || {};
  const v = map[lvl];
  if (Number.isFinite(Number(v))) return Number(v);
  // linear fallback
  return roundTo(clamp01(lvl / 30), 3);
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
  const allowed = ["mode", "plannerMode", "screen", "route", "origin"];
  const out = {};
  for (const k of allowed) {
    if (context[k] != null) out[k] = String(context[k]);
  }
  return out;
}

function normalizeKey(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^\w.-]/g, "")
    .slice(0, 120);
}

function makeRunId() {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function formatCurrency(n) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    const x = Number(n) || 0;
    return `$${Math.round(x)}`;
  }
}
