// File: src/engines/estimates/estimateEngine.js
// SSA — Estimate Engine (production-ready)
//
// Purpose
// - Provide a deterministic, non-AI estimation engine to support SSA’s “web of meaning”
//   across cooking, meal planning, storehouse, garden, animals, cleaning, and sessions.
// - Compute time/cost/quantity estimates from fixed catalogs + user/household overrides.
// - Keep it modular so it can be called from session engines, planners, and KPIs.
//
// Design Principles
// - Pure-ish and deterministic: all outputs derived from inputs, with transparent reasons.
// - Works offline: no network calls; accepts injected data providers.
// - Plug-in resolvers: domain-specific estimators can be registered.
// - Evidence trail: every estimate returns a breakdown and confidence.
//
// Inputs
// - artifact/intent/task objects can be free-form; engine normalizes to a request envelope.
// - engine can optionally consult SSA “layer spine” tables (method_maps -> blueprints) via a provider.
//
// Dependencies
// - None. (Optional integration points accept injected providers; no Dexie import here.)
//
// Export
// - createEstimateEngine(options) -> { estimate(), registerEstimator(), listEstimators() }
// - estimateOnce(options, request)
//
// Common usage
// const engine = createEstimateEngine({ providers: { catalogs, overrides, prices } })
// const result = await engine.estimate({ domain:"meal", kind:"batch_cook", items:[...] })
//
// Result shape
// {
//   ok: true,
//   requestId,
//   domain, kind,
//   summary: { durationMin, cost, calories, servings, ... },
//   confidence: 0..1,
//   breakdown: [{ key, label, value, unit, basis, confidence }],
//   warnings: [],
//   notes: [],
//   meta: { usedOverrides:[], usedCatalogs:[], timestamps... }
// }

import {
  clamp,
  isFiniteNumber,
  nowMs,
  safeDate,
  toDate,
  toISODateTimeLocal,
} from "@/engines/scheduling/scheduleHelpers";

/* ------------------------------ utils ------------------------------ */

function uid(prefix = "est") {
  return `${prefix}_${Math.random()
    .toString(16)
    .slice(2)}_${Date.now().toString(16)}`;
}

function asArray(v) {
  return Array.isArray(v) ? v : v ? [v] : [];
}

function safeNum(v, fallback = 0) {
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : fallback;
}

function round(n, digits = 2) {
  const nn = safeNum(n, 0);
  const p = Math.pow(10, digits);
  return Math.round(nn * p) / p;
}

function mergeDeep(a, b) {
  if (!a) return structuredCloneSafe(b);
  if (!b) return structuredCloneSafe(a);

  if (Array.isArray(a) || Array.isArray(b)) return structuredCloneSafe(b);

  if (typeof a === "object" && typeof b === "object") {
    const out = { ...a };
    for (const k of Object.keys(b)) {
      const av = a[k];
      const bv = b[k];
      if (
        typeof av === "object" &&
        av &&
        typeof bv === "object" &&
        bv &&
        !Array.isArray(av) &&
        !Array.isArray(bv)
      ) {
        out[k] = mergeDeep(av, bv);
      } else {
        out[k] = structuredCloneSafe(bv);
      }
    }
    return out;
  }

  return structuredCloneSafe(b);
}

function structuredCloneSafe(obj) {
  try {
    // modern browsers/node
    return structuredClone(obj);
  } catch {
    return JSON.parse(JSON.stringify(obj));
  }
}

function addWarn(warnings, msg, code = "warn") {
  if (!msg) return;
  warnings.push({ code, message: String(msg) });
}

function addNote(notes, msg) {
  if (!msg) return;
  notes.push(String(msg));
}

function normalizeMoney(v) {
  const n = safeNum(v, 0);
  return round(n, 2);
}

function normalizeUnit(unit) {
  return (unit || "").trim() || "unit";
}

function normalizeDomain(d) {
  return String(d || "generic")
    .trim()
    .toLowerCase();
}

function normalizeKind(k) {
  return String(k || "generic")
    .trim()
    .toLowerCase();
}

function combineConfidence(...parts) {
  // Multiply, but keep in [0,1], with slight floor for partial signal
  const vals = parts
    .map((x) => (typeof x === "number" ? x : 1))
    .map((x) => clamp(x, 0, 1));
  if (!vals.length) return 0.5;
  let prod = 1;
  for (const v of vals) prod *= v;
  // soften: sqrt to avoid overly harsh drop
  return clamp(Math.sqrt(prod), 0, 1);
}

/* ------------------------------ providers contract ------------------------------ */
/**
providers = {
  // optional; any may be sync or async
  catalogs: {
    getMethodCatalog(domain): object|null
    getEstimateProfiles(domain): object|null
  },
  overrides: {
    // for a household/user
    getHouseholdOverrides(domain, householdId): object|null
    getUserOverrides(domain, userId): object|null
  },
  prices: {
    // for cost estimation
    getPrice(itemKey, context): { unitPrice, unit, source, confidence }|null
  },
  nutrition: {
    // optional
    getNutrition(itemKey, context): { calories, protein_g, carbs_g, fat_g, micros?, confidence }|null
  },
  layers: {
    // optional; for intent->method->blueprint pipelines
    resolveBlueprintForArtifact(artifactId): blueprint|null
  }
}
*/

/* ------------------------------ estimator interface ------------------------------ */
/**
Estimator:
{
  id: "meal.batch" (unique),
  domain: "meal",
  kind: "batch_cook",
  canHandle(request): boolean,
  estimate(request, ctx): Promise<EstimateResultPartial>|EstimateResultPartial
}

EstimateResultPartial:
{
  summary?: { durationMin?, cost?, servings?, ... }
  breakdown?: BreakdownLine[]
  confidence?: number
  warnings?: []
  notes?: []
  meta?: {}
}
*/

/* ------------------------------ built-in estimators ------------------------------ */

function createBuiltInEstimators() {
  return [
    createGenericTimeCostEstimator(),
    createMealPlanEstimator(),
    createCookingEstimator(),
    createCleaningEstimator(),
    createGardenEstimator(),
    createAnimalsEstimator(),
  ];
}

// A fallback estimator that tries to compute duration + cost from common fields.
// If no signals exist, returns low-confidence.
function createGenericTimeCostEstimator() {
  return {
    id: "generic.time_cost",
    domain: "generic",
    kind: "generic",
    canHandle: () => true,
    estimate: (req, ctx) => {
      const warnings = [];
      const notes = [];
      const breakdown = [];

      const durationMin =
        safeNum(req?.durationMin, NaN) ||
        safeNum(req?.duration_min, NaN) ||
        safeNum(req?.minutes, NaN);

      const baseCost =
        safeNum(req?.cost, NaN) ||
        safeNum(req?.costUsd, NaN) ||
        safeNum(req?.cost_usd, NaN);

      let durationOut = Number.isFinite(durationMin)
        ? round(durationMin, 0)
        : null;
      let costOut = Number.isFinite(baseCost) ? normalizeMoney(baseCost) : null;

      if (durationOut != null) {
        breakdown.push({
          key: "duration",
          label: "Duration",
          value: durationOut,
          unit: "min",
          basis: "request",
          confidence: 0.6,
        });
      }

      if (costOut != null) {
        breakdown.push({
          key: "cost",
          label: "Estimated cost",
          value: costOut,
          unit: "USD",
          basis: "request",
          confidence: 0.6,
        });
      }

      // Try compute cost from items if provided
      const items = asArray(req?.items || req?.ingredients || req?.lines);
      if (costOut == null && items.length && ctx?.providers?.prices?.getPrice) {
        let sum = 0;
        let confParts = [];
        let hits = 0;

        for (const it of items) {
          const key = it?.itemKey || it?.key || it?.sku || it?.id || it?.name;
          const qty = safeNum(it?.qty ?? it?.quantity ?? 1, 1);
          if (!key) continue;
          const p =
            ctx.providers.prices.getPrice(key, {
              domain: req.domain,
              kind: req.kind,
            }) || null;
          if (!p || !Number.isFinite(p.unitPrice)) continue;
          const line = p.unitPrice * qty;
          sum += line;
          hits += 1;
          confParts.push(clamp(safeNum(p.confidence, 0.6), 0, 1));
          breakdown.push({
            key: `cost:${String(key)}`,
            label: `Cost — ${String(key)}`,
            value: round(line, 2),
            unit: "USD",
            basis: p.source || "priceProvider",
            confidence: clamp(safeNum(p.confidence, 0.6), 0, 1),
          });
        }

        if (hits) {
          costOut = normalizeMoney(sum);
          breakdown.push({
            key: "cost_total",
            label: "Total cost",
            value: costOut,
            unit: "USD",
            basis: "sum(items)",
            confidence: combineConfidence(...confParts),
          });
        }
      }

      let conf = 0.25;
      if (durationOut != null && costOut != null) conf = 0.55;
      else if (durationOut != null || costOut != null) conf = 0.4;

      if (durationOut == null && costOut == null) {
        addWarn(
          warnings,
          "Generic estimator found no duration/cost signals. Provide durationMin/cost or item lines.",
          "no_signal"
        );
      }

      return {
        summary: {
          ...(durationOut != null ? { durationMin: durationOut } : {}),
          ...(costOut != null ? { cost: costOut, currency: "USD" } : {}),
        },
        breakdown,
        confidence: conf,
        warnings,
        notes,
        meta: { estimator: "generic.time_cost" },
      };
    },
  };
}

// Meal planning: estimate prep burden, variety, and total servings from planned meals.
function createMealPlanEstimator() {
  return {
    id: "meal.plan",
    domain: "meal",
    kind: "plan",
    canHandle: (req) =>
      req.domain === "meal" &&
      (req.kind === "plan" || req.kind === "meal_plan"),
    estimate: (req, ctx) => {
      const warnings = [];
      const notes = [];
      const breakdown = [];

      const meals = asArray(req?.meals || req?.plannedMeals || req?.entries);
      if (!meals.length) {
        addWarn(
          warnings,
          "No meals provided for meal plan estimation.",
          "no_meals"
        );
        return {
          summary: {},
          breakdown,
          confidence: 0.2,
          warnings,
          notes,
          meta: { estimator: "meal.plan" },
        };
      }

      let servings = 0;
      let durationMin = 0;
      let diversitySet = new Set();
      let confParts = [];

      for (const m of meals) {
        const sv = safeNum(m?.servings ?? m?.serves ?? 0, 0);
        servings += sv;

        const d = safeNum(
          m?.durationMin ?? m?.minutes ?? m?.prepMinutes ?? NaN,
          NaN
        );
        if (Number.isFinite(d)) durationMin += d;

        const key = m?.recipeId || m?.templateId || m?.name || m?.title;
        if (key) diversitySet.add(String(key));

        // if meal has internal confidence, factor it
        confParts.push(clamp(safeNum(m?.confidence, 0.75), 0, 1));
      }

      servings = round(servings, 0);
      durationMin = round(durationMin, 0);

      breakdown.push({
        key: "meals_count",
        label: "Meals in plan",
        value: meals.length,
        unit: "count",
        basis: "request.meals",
        confidence: 0.8,
      });

      breakdown.push({
        key: "diversity",
        label: "Meal diversity",
        value: diversitySet.size,
        unit: "unique",
        basis: "unique(recipe/template keys)",
        confidence: 0.7,
      });

      if (servings > 0) {
        breakdown.push({
          key: "servings",
          label: "Total servings",
          value: servings,
          unit: "servings",
          basis: "sum(meal.servings)",
          confidence: 0.75,
        });
      } else {
        addNote(
          notes,
          "No explicit servings found in meals; consider adding servings for better planning estimates."
        );
      }

      if (durationMin > 0) {
        breakdown.push({
          key: "duration",
          label: "Total cook time (reported)",
          value: durationMin,
          unit: "min",
          basis: "sum(meal.durationMin)",
          confidence: 0.65,
        });
      } else {
        addNote(
          notes,
          "No explicit duration found in meals; consider adding durationMin or deriving from recipe methods."
        );
      }

      // Heuristic: prep burden score (0-100)
      // Based on number of meals, diversity, and total time.
      const burden = clamp(
        round(
          meals.length * 6 +
            diversitySet.size * 4 +
            (durationMin > 0 ? durationMin / 10 : 10),
          0
        ),
        0,
        100
      );
      breakdown.push({
        key: "prep_burden",
        label: "Prep burden score",
        value: burden,
        unit: "score",
        basis: "heuristic(meals,diversity,duration)",
        confidence: 0.55,
      });

      const conf = combineConfidence(
        0.75,
        confParts.length ? combineConfidence(...confParts) : 0.75
      );

      return {
        summary: {
          mealsCount: meals.length,
          diversity: diversitySet.size,
          ...(servings > 0 ? { servings } : {}),
          ...(durationMin > 0 ? { durationMin } : {}),
          prepBurdenScore: burden,
        },
        breakdown,
        confidence: conf,
        warnings,
        notes,
        meta: { estimator: "meal.plan" },
      };
    },
  };
}

// Cooking: estimate duration and cost from recipe steps, methods, ingredient lines, and batch scale.
function createCookingEstimator() {
  return {
    id: "meal.cooking",
    domain: "meal",
    kind: "cook",
    canHandle: (req) =>
      req.domain === "meal" &&
      ["cook", "cooking", "batch_cook", "batch", "session_cook"].includes(
        req.kind
      ),
    estimate: async (req, ctx) => {
      const warnings = [];
      const notes = [];
      const breakdown = [];

      const scale = clamp(
        safeNum(req?.scale ?? req?.batchScale ?? 1, 1),
        0.1,
        100
      );
      const servings = safeNum(req?.servings ?? req?.serves ?? 0, 0);

      const steps = asArray(req?.steps || req?.instructions || req?.taskSteps);
      const items = asArray(req?.items || req?.ingredients || req?.lines);

      // Duration: sum of step durations if present; else fallback to request duration; else heuristic
      let durationMin = safeNum(req?.durationMin ?? req?.minutes ?? NaN, NaN);
      let stepSum = 0;
      let stepHits = 0;

      for (const s of steps) {
        const d = safeNum(
          s?.durationMin ?? s?.minutes ?? s?.timeMin ?? NaN,
          NaN
        );
        if (Number.isFinite(d)) {
          stepSum += d;
          stepHits += 1;
        }
      }

      if (!Number.isFinite(durationMin) && stepHits) {
        durationMin = stepSum;
        breakdown.push({
          key: "duration_steps",
          label: "Duration from steps",
          value: round(durationMin, 0),
          unit: "min",
          basis: "sum(steps.durationMin)",
          confidence: 0.75,
        });
      } else if (Number.isFinite(durationMin)) {
        breakdown.push({
          key: "duration_request",
          label: "Duration (provided)",
          value: round(durationMin, 0),
          unit: "min",
          basis: "request",
          confidence: 0.6,
        });
      }

      if (!Number.isFinite(durationMin)) {
        // heuristic: 12 min base + 4 min per step + 3 min per ingredient line, scaled lightly
        const heuristic = 12 + steps.length * 4 + items.length * 3;
        durationMin = heuristic * (1 + Math.log2(scale + 1) * 0.15);
        breakdown.push({
          key: "duration_heuristic",
          label: "Duration (heuristic)",
          value: round(durationMin, 0),
          unit: "min",
          basis: "12 + 4*steps + 3*items (scaled)",
          confidence: 0.35,
        });
        addNote(
          notes,
          "Cooking duration estimated heuristically; add step durations for higher accuracy."
        );
      }

      durationMin = round(durationMin, 0);

      // Cost from items (if available)
      let cost = safeNum(req?.cost ?? req?.costUsd ?? NaN, NaN);
      let costConf = 0.4;

      if (
        !Number.isFinite(cost) &&
        items.length &&
        ctx?.providers?.prices?.getPrice
      ) {
        let sum = 0;
        let confParts = [];
        let hits = 0;

        for (const it of items) {
          const key = it?.itemKey || it?.key || it?.sku || it?.id || it?.name;
          if (!key) continue;

          const qty = safeNum(it?.qty ?? it?.quantity ?? 1, 1) * scale;
          const p =
            (await ctx.providers.prices.getPrice(key, {
              domain: req.domain,
              kind: req.kind,
            })) || null;
          if (!p || !Number.isFinite(p.unitPrice)) continue;

          const line = p.unitPrice * qty;
          sum += line;
          hits += 1;

          const c = clamp(safeNum(p.confidence, 0.6), 0, 1);
          confParts.push(c);

          breakdown.push({
            key: `cost:${String(key)}`,
            label: `Cost — ${String(key)}`,
            value: round(line, 2),
            unit: "USD",
            basis: p.source || "priceProvider",
            confidence: c,
          });
        }

        if (hits) {
          cost = normalizeMoney(sum);
          costConf = combineConfidence(...confParts);
          breakdown.push({
            key: "cost_total",
            label: "Total cost",
            value: cost,
            unit: "USD",
            basis: "sum(items * scale)",
            confidence: costConf,
          });
        }
      } else if (Number.isFinite(cost)) {
        cost = normalizeMoney(cost);
        breakdown.push({
          key: "cost_request",
          label: "Cost (provided)",
          value: cost,
          unit: "USD",
          basis: "request",
          confidence: 0.6,
        });
      }

      // Nutrition (optional)
      let calories = safeNum(req?.calories ?? NaN, NaN);
      let nutritionConf = 0.4;

      if (
        !Number.isFinite(calories) &&
        items.length &&
        ctx?.providers?.nutrition?.getNutrition
      ) {
        let sumCal = 0;
        let hits = 0;
        let confParts = [];

        for (const it of items) {
          const key = it?.itemKey || it?.key || it?.sku || it?.id || it?.name;
          if (!key) continue;
          const qty = safeNum(it?.qty ?? it?.quantity ?? 1, 1) * scale;

          const n =
            (await ctx.providers.nutrition.getNutrition(key, {
              domain: req.domain,
              kind: req.kind,
            })) || null;
          if (!n || !Number.isFinite(n.calories)) continue;
          // assume n.calories is per "unit" provided by nutrition provider; multiply by qty
          const line = n.calories * qty;
          sumCal += line;
          hits += 1;
          confParts.push(clamp(safeNum(n.confidence, 0.6), 0, 1));
        }

        if (hits) {
          calories = round(sumCal, 0);
          nutritionConf = combineConfidence(...confParts);
          breakdown.push({
            key: "calories_total",
            label: "Calories (estimated)",
            value: calories,
            unit: "kcal",
            basis: "sum(nutrition * qty)",
            confidence: nutritionConf,
          });
        }
      } else if (Number.isFinite(calories)) {
        calories = round(calories, 0);
        breakdown.push({
          key: "calories_request",
          label: "Calories (provided)",
          value: calories,
          unit: "kcal",
          basis: "request",
          confidence: 0.6,
        });
      }

      const conf = combineConfidence(
        0.6,
        durationMin ? 0.7 : 0.3,
        Number.isFinite(cost) ? costConf : 0.5,
        Number.isFinite(calories) ? nutritionConf : 0.5
      );

      return {
        summary: {
          durationMin,
          ...(Number.isFinite(cost) ? { cost, currency: "USD" } : {}),
          ...(servings > 0 ? { servings: round(servings * scale, 0) } : {}),
          ...(Number.isFinite(calories) ? { calories } : {}),
          scale,
        },
        breakdown,
        confidence: conf,
        warnings,
        notes,
        meta: { estimator: "meal.cooking" },
      };
    },
  };
}

// Cleaning: estimate minutes based on area/room type + soil level + method profile.
function createCleaningEstimator() {
  return {
    id: "cleaning.task",
    domain: "cleaning",
    kind: "task",
    canHandle: (req) => req.domain === "cleaning",
    estimate: async (req, ctx) => {
      const warnings = [];
      const notes = [];
      const breakdown = [];

      const roomType = String(
        req?.roomType || req?.room || req?.spaceType || "generic"
      ).toLowerCase();
      const soil = clamp(safeNum(req?.soilLevel ?? req?.soil ?? 2, 2), 0, 5); // 0=light, 5=heavy
      const areaSqft = safeNum(req?.areaSqft ?? req?.sqft ?? NaN, NaN);

      // Pull default profiles from catalogs (optional)
      const profiles =
        (await ctx?.providers?.catalogs?.getEstimateProfiles?.("cleaning")) ||
        null;
      const base = profiles?.rooms?.[roomType] ||
        profiles?.rooms?.generic || { baseMin: 10, per100SqftMin: 6 };
      const baseMin = clamp(safeNum(base.baseMin, 10), 1, 600);
      const per100 = clamp(safeNum(base.per100SqftMin, 6), 0, 120);

      let durationMin = baseMin;
      let areaFactor = 1;

      if (Number.isFinite(areaSqft) && areaSqft > 0) {
        areaFactor = areaSqft / 100;
        durationMin += per100 * areaFactor;
        breakdown.push({
          key: "area",
          label: "Area factor",
          value: round(areaSqft, 0),
          unit: "sqft",
          basis: "request.areaSqft",
          confidence: 0.75,
        });
      } else {
        addNote(
          notes,
          "No areaSqft provided; using base estimate for room type."
        );
      }

      // Soil level increases time
      const soilMultiplier = 1 + soil * 0.12;
      durationMin *= soilMultiplier;

      // Optional “method” complexity
      const methodKey = req?.methodKey || req?.methodId || null;
      if (methodKey && profiles?.methods?.[methodKey]?.multiplier) {
        durationMin *= clamp(
          safeNum(profiles.methods[methodKey].multiplier, 1),
          0.5,
          3
        );
        breakdown.push({
          key: "method",
          label: "Method multiplier",
          value: round(profiles.methods[methodKey].multiplier, 2),
          unit: "x",
          basis: "catalog.estimateProfiles.cleaning.methods",
          confidence: 0.7,
        });
      }

      durationMin = round(durationMin, 0);

      breakdown.push({
        key: "duration",
        label: "Estimated duration",
        value: durationMin,
        unit: "min",
        basis: "base + area + soil + method",
        confidence: 0.6,
      });

      const conf = combineConfidence(
        0.65,
        Number.isFinite(areaSqft) ? 0.8 : 0.55
      );

      return {
        summary: {
          durationMin,
          roomType,
          soilLevel: soil,
          ...(Number.isFinite(areaSqft) ? { areaSqft } : {}),
        },
        breakdown,
        confidence: conf,
        warnings,
        notes,
        meta: { estimator: "cleaning.task" },
      };
    },
  };
}

// Garden: estimate yield/inputs/time from planting plan lines.
function createGardenEstimator() {
  return {
    id: "garden.plan",
    domain: "garden",
    kind: "plan",
    canHandle: (req) => req.domain === "garden",
    estimate: async (req, ctx) => {
      const warnings = [];
      const notes = [];
      const breakdown = [];

      const lines = asArray(req?.lines || req?.crops || req?.items);
      if (!lines.length) {
        addWarn(
          warnings,
          "No garden lines provided (crops/items).",
          "no_lines"
        );
        return {
          summary: {},
          breakdown,
          confidence: 0.2,
          warnings,
          notes,
          meta: { estimator: "garden.plan" },
        };
      }

      const profiles =
        (await ctx?.providers?.catalogs?.getEstimateProfiles?.("garden")) ||
        null;

      let totalMinutes = 0;
      let totalCost = 0;
      let totalYield = 0;
      let confParts = [];

      for (const line of lines) {
        const crop = String(
          line?.crop || line?.name || line?.itemKey || "crop"
        ).toLowerCase();
        const qty = clamp(safeNum(line?.qty ?? line?.count ?? 1, 1), 0, 100000);
        const prof =
          profiles?.crops?.[crop] || profiles?.crops?.generic || null;

        // time
        const baseMin = clamp(safeNum(prof?.baseMin, 12), 0, 600);
        const perUnit = clamp(safeNum(prof?.perUnitMin, 2), 0, 120);
        const minutes = baseMin + perUnit * qty;
        totalMinutes += minutes;

        // yield (unitless or pounds)
        const yieldPer = safeNum(
          prof?.yieldPerUnit ?? prof?.yield_lb_per_unit ?? NaN,
          NaN
        );
        if (Number.isFinite(yieldPer)) totalYield += yieldPer * qty;

        // cost from seed price provider if available
        if (ctx?.providers?.prices?.getPrice) {
          const p =
            (await ctx.providers.prices.getPrice(crop, {
              domain: "garden",
              kind: "inputs",
            })) || null;
          if (p && Number.isFinite(p.unitPrice)) {
            const c = clamp(safeNum(p.confidence, 0.55), 0, 1);
            totalCost += p.unitPrice * qty;
            confParts.push(c);
          }
        }

        breakdown.push({
          key: `crop:${crop}`,
          label: `Crop — ${crop}`,
          value: round(minutes, 0),
          unit: "min",
          basis: "base + perUnit * qty",
          confidence: prof ? 0.65 : 0.45,
        });
      }

      const durationMin = round(totalMinutes, 0);
      const cost =
        Number.isFinite(totalCost) && totalCost > 0
          ? normalizeMoney(totalCost)
          : null;
      const yieldTotal =
        Number.isFinite(totalYield) && totalYield > 0
          ? round(totalYield, 1)
          : null;

      const conf = combineConfidence(
        0.6,
        cost != null
          ? combineConfidence(...(confParts.length ? confParts : [0.55]))
          : 0.5,
        yieldTotal != null ? 0.65 : 0.5
      );

      return {
        summary: {
          durationMin,
          ...(cost != null ? { cost, currency: "USD" } : {}),
          ...(yieldTotal != null ? { expectedYield: yieldTotal } : {}),
          linesCount: lines.length,
        },
        breakdown,
        confidence: conf,
        warnings,
        notes,
        meta: { estimator: "garden.plan" },
      };
    },
  };
}

// Animals: estimate feed cost + labor minutes for husbandry tasks.
function createAnimalsEstimator() {
  return {
    id: "animals.husbandry",
    domain: "animals",
    kind: "task",
    canHandle: (req) => req.domain === "animals" || req.domain === "livestock",
    estimate: async (req, ctx) => {
      const warnings = [];
      const notes = [];
      const breakdown = [];

      const tasks = asArray(req?.tasks || req?.lines || req?.items);
      const animalType = String(
        req?.animalType || req?.species || "generic"
      ).toLowerCase();
      const count = clamp(
        safeNum(req?.count ?? req?.headCount ?? 1, 1),
        0,
        100000
      );

      const profiles =
        (await ctx?.providers?.catalogs?.getEstimateProfiles?.("animals")) ||
        null;
      const prof = profiles?.species?.[animalType] ||
        profiles?.species?.generic || {
          baseMinPerHead: 1.5,
          feedLbPerHeadDay: 2.5,
        };

      let durationMin = 0;
      let cost = 0;
      let confParts = [];

      // Base labor
      const baseMinPerHead = clamp(safeNum(prof.baseMinPerHead, 1.5), 0, 60);
      durationMin += baseMinPerHead * count;

      breakdown.push({
        key: "labor_base",
        label: "Base labor",
        value: round(durationMin, 0),
        unit: "min",
        basis: "baseMinPerHead * headCount",
        confidence: prof ? 0.65 : 0.45,
      });

      // Task add-ons
      for (const t of tasks) {
        const mins = safeNum(t?.durationMin ?? t?.minutes ?? NaN, NaN);
        if (Number.isFinite(mins)) {
          durationMin += mins;
          breakdown.push({
            key: `task:${t?.key || t?.name || "task"}`,
            label: `Task — ${t?.name || t?.key || "task"}`,
            value: round(mins, 0),
            unit: "min",
            basis: "request.task.duration",
            confidence: 0.6,
          });
        }
      }

      // Feed estimate (optional)
      const feedDays = clamp(
        safeNum(req?.feedDays ?? req?.days ?? 1, 1),
        0,
        3650
      );
      const feedLbPerHeadDay = clamp(
        safeNum(prof.feedLbPerHeadDay, 2.5),
        0,
        200
      );
      const feedLb = feedLbPerHeadDay * count * feedDays;

      if (feedLb > 0) {
        breakdown.push({
          key: "feed_qty",
          label: "Feed quantity",
          value: round(feedLb, 1),
          unit: "lb",
          basis: "feedLbPerHeadDay * headCount * days",
          confidence: prof ? 0.6 : 0.4,
        });

        // Cost using price provider if available
        if (ctx?.providers?.prices?.getPrice) {
          const p =
            (await ctx.providers.prices.getPrice(`${animalType}:feed`, {
              domain: "animals",
              kind: "feed",
            })) || null;
          if (p && Number.isFinite(p.unitPrice)) {
            const c = clamp(safeNum(p.confidence, 0.55), 0, 1);
            // assume unitPrice per lb unless provider indicates otherwise
            cost += p.unitPrice * feedLb;
            confParts.push(c);
            breakdown.push({
              key: "feed_cost",
              label: "Feed cost",
              value: round(p.unitPrice * feedLb, 2),
              unit: "USD",
              basis: p.source || "priceProvider",
              confidence: c,
            });
          } else {
            addNote(
              notes,
              "Feed cost unavailable (no price found). Add a price entry for '<species>:feed'."
            );
          }
        }
      }

      durationMin = round(durationMin, 0);
      const costOut = cost > 0 ? normalizeMoney(cost) : null;

      const conf = combineConfidence(
        0.6,
        prof ? 0.7 : 0.5,
        costOut != null
          ? combineConfidence(...(confParts.length ? confParts : [0.55]))
          : 0.5
      );

      return {
        summary: {
          durationMin,
          species: animalType,
          headCount: count,
          ...(costOut != null ? { cost: costOut, currency: "USD" } : {}),
          ...(feedLb > 0 ? { feedLb: round(feedLb, 1), feedDays } : {}),
        },
        breakdown,
        confidence: conf,
        warnings,
        notes,
        meta: { estimator: "animals.husbandry" },
      };
    },
  };
}

/* ------------------------------ engine ------------------------------ */

// ✅ FIXED normalizeRequest(req) to prevent duplicate "domain"/"kind" keys
function normalizeRequest(req) {
  const r = req || {};

  // normalize from incoming fields
  const domain = normalizeDomain(r.domain || r.area || r.type);
  const kind = normalizeKind(r.kind || r.intent || r.action);

  // IMPORTANT:
  // Prevent duplicate keys in the returned object literal by removing any
  // incoming domain/kind from the spread payload.
  const {
    domain: _incomingDomain,
    kind: _incomingKind,
    area: _incomingArea,
    type: _incomingType,
    intent: _incomingIntent,
    action: _incomingAction,
    ...rest
  } = r;

  return {
    requestId: r.requestId || r.id || uid("req"),
    householdId: r.householdId || r.household_id || null,
    userId: r.userId || r.user_id || null,
    artifactId: r.artifactId || r.artifact_id || null,
    createdAt: r.createdAt || r.created_at || toISODateTimeLocal(new Date()),
    ...rest,
    domain,
    kind,
  };
}

async function collectOverrides(req, providers) {
  const out = {};
  const used = [];

  if (!providers?.overrides) return { overrides: out, used };

  const hid = req.householdId || null;
  const uid = req.userId || null;

  if (hid && typeof providers.overrides.getHouseholdOverrides === "function") {
    const o = await providers.overrides.getHouseholdOverrides(req.domain, hid);
    if (o) {
      out.household = o;
      used.push({ scope: "household", domain: req.domain, id: hid });
    }
  }

  if (uid && typeof providers.overrides.getUserOverrides === "function") {
    const o = await providers.overrides.getUserOverrides(req.domain, uid);
    if (o) {
      out.user = o;
      used.push({ scope: "user", domain: req.domain, id: uid });
    }
  }

  return { overrides: out, used };
}

async function collectCatalogs(req, providers) {
  const out = {};
  const used = [];

  if (!providers?.catalogs) return { catalogs: out, used };

  if (typeof providers.catalogs.getMethodCatalog === "function") {
    const c = await providers.catalogs.getMethodCatalog(req.domain);
    if (c) {
      out.methodCatalog = c;
      used.push({ kind: "methodCatalog", domain: req.domain });
    }
  }

  if (typeof providers.catalogs.getEstimateProfiles === "function") {
    const p = await providers.catalogs.getEstimateProfiles(req.domain);
    if (p) {
      out.estimateProfiles = p;
      used.push({ kind: "estimateProfiles", domain: req.domain });
    }
  }

  return { catalogs: out, used };
}

function applyOverridesToRequest(req, overrides) {
  // Conservative: only apply a known 'estimate' namespace, otherwise leave request untouched.
  // Users can store overrides like:
  // { estimate: { durationMultiplier: 1.15, costMultiplier: 0.9, defaults:{...}} }
  const o = overrides || {};
  const merged = { ...req };

  const householdEstimate = o?.household?.estimate || null;
  const userEstimate = o?.user?.estimate || null;

  // Merge defaults in order: catalog defaults -> household -> user
  merged.__estimate = mergeDeep(householdEstimate || {}, userEstimate || {});

  return merged;
}

function applyMultipliers(result, req) {
  const est = req?.__estimate || {};
  const durMult = clamp(
    safeNum(est.durationMultiplier ?? est.duration_mult ?? 1, 1),
    0.1,
    10
  );
  const costMult = clamp(
    safeNum(est.costMultiplier ?? est.cost_mult ?? 1, 1),
    0.1,
    10
  );

  const out = structuredCloneSafe(result);

  if (
    out?.summary?.durationMin != null &&
    isFiniteNumber(out.summary.durationMin)
  ) {
    out.summary.durationMin = round(out.summary.durationMin * durMult, 0);
    out.breakdown = out.breakdown || [];
    out.breakdown.push({
      key: "multiplier:duration",
      label: "Duration multiplier",
      value: durMult,
      unit: "x",
      basis: "overrides.estimate.durationMultiplier",
      confidence: 0.85,
    });
  }

  if (out?.summary?.cost != null && isFiniteNumber(out.summary.cost)) {
    out.summary.cost = normalizeMoney(out.summary.cost * costMult);
    out.breakdown = out.breakdown || [];
    out.breakdown.push({
      key: "multiplier:cost",
      label: "Cost multiplier",
      value: costMult,
      unit: "x",
      basis: "overrides.estimate.costMultiplier",
      confidence: 0.85,
    });
  }

  // update confidence slightly downward if multipliers are extreme
  const penalty =
    (Math.abs(durMult - 1) > 0.5 ? 0.92 : 1) *
    (Math.abs(costMult - 1) > 0.5 ? 0.92 : 1);

  out.confidence = clamp(safeNum(out.confidence, 0.5) * penalty, 0, 1);

  return out;
}

function normalizeResult(req, partial, ctx) {
  const warnings = [];
  const notes = [];

  for (const w of asArray(partial?.warnings)) warnings.push(w);
  for (const n of asArray(partial?.notes)) notes.push(n);

  const breakdown = asArray(partial?.breakdown);

  const summary = partial?.summary || {};
  const confidence = clamp(safeNum(partial?.confidence, 0.5), 0, 1);

  return {
    ok: true,
    requestId: req.requestId,
    domain: req.domain,
    kind: req.kind,
    summary,
    confidence,
    breakdown,
    warnings,
    notes,
    meta: {
      engine: "estimateEngine",
      estimatorId:
        partial?.meta?.estimator || partial?.meta?.estimatorId || null,
      resolvedAtMs: nowMs(),
      resolvedAt: toISODateTimeLocal(new Date()),
      ...(partial?.meta || {}),
      providersUsed: ctx?.meta?.providersUsed || {},
    },
  };
}

/* ------------------------------ public API ------------------------------ */

export function createEstimateEngine(options = {}) {
  const opts = options || {};
  const providers = opts.providers || {};
  const builtIns = createBuiltInEstimators();

  const registry = new Map();
  for (const e of builtIns) registry.set(e.id, e);

  // allow custom estimators
  for (const e of asArray(opts.estimators)) {
    if (e?.id) registry.set(e.id, e);
  }

  function listEstimators() {
    return Array.from(registry.values()).map((e) => ({
      id: e.id,
      domain: e.domain,
      kind: e.kind,
    }));
  }

  function registerEstimator(estimator) {
    if (!estimator || !estimator.id) {
      throw new Error(
        "registerEstimator requires an estimator with a unique id."
      );
    }
    registry.set(estimator.id, estimator);
  }

  async function estimate(request) {
    const req = normalizeRequest(request);

    const ctx = {
      providers,
      meta: {
        providersUsed: {
          catalogs: [],
          overrides: [],
          layers: [],
        },
      },
    };

    // Optional: resolve blueprint if artifactId exists
    if (req.artifactId && providers?.layers?.resolveBlueprintForArtifact) {
      try {
        const bp = await providers.layers.resolveBlueprintForArtifact(
          req.artifactId
        );
        if (bp) {
          req.blueprint = bp;
          ctx.meta.providersUsed.layers.push({
            kind: "blueprint",
            artifactId: req.artifactId,
          });
        }
      } catch (e) {
        // Non-fatal
      }
    }

    const { catalogs, used: usedCatalogs } = await collectCatalogs(
      req,
      providers
    );
    ctx.meta.providersUsed.catalogs.push(...usedCatalogs);

    const { overrides, used: usedOverrides } = await collectOverrides(
      req,
      providers
    );
    ctx.meta.providersUsed.overrides.push(...usedOverrides);

    // Attach catalogs to ctx for estimators to consult
    ctx.catalogs = catalogs;
    ctx.overrides = overrides;

    const reqWithOverrides = applyOverridesToRequest(req, overrides);

    // Choose estimator: the first that canHandle(req)
    const candidates = Array.from(registry.values());

    let chosen = null;
    for (const e of candidates) {
      try {
        if (
          typeof e.canHandle === "function" &&
          e.canHandle(reqWithOverrides, ctx)
        ) {
          chosen = e;
          break;
        }
      } catch {
        // ignore and keep searching
      }
    }

    if (!chosen) {
      // should never happen because generic estimator canHandle always true
      chosen = createGenericTimeCostEstimator();
    }

    let partial = null;
    try {
      partial = await chosen.estimate(reqWithOverrides, ctx);
    } catch (err) {
      const warnings = [];
      addWarn(
        warnings,
        `Estimator '${chosen.id}' threw an error: ${
          err?.message || String(err)
        }`,
        "estimator_error"
      );
      partial = {
        summary: {},
        breakdown: [],
        confidence: 0.15,
        warnings,
        notes: [],
        meta: { estimator: chosen.id, error: String(err?.message || err) },
      };
    }

    // Apply global multipliers/overrides (duration/cost)
    const finalized = applyMultipliers(
      normalizeResult(reqWithOverrides, partial, ctx),
      reqWithOverrides
    );

    // Add trace of chosen estimator
    finalized.meta = finalized.meta || {};
    finalized.meta.chosenEstimator = chosen.id;
    finalized.meta.request = {
      domain: reqWithOverrides.domain,
      kind: reqWithOverrides.kind,
      householdId: reqWithOverrides.householdId || null,
      userId: reqWithOverrides.userId || null,
    };

    // Provide a simple stability guard: never negative numbers
    if (finalized.summary && isFiniteNumber(finalized.summary.durationMin)) {
      finalized.summary.durationMin = Math.max(
        0,
        round(finalized.summary.durationMin, 0)
      );
    }
    if (finalized.summary && isFiniteNumber(finalized.summary.cost)) {
      finalized.summary.cost = Math.max(
        0,
        normalizeMoney(finalized.summary.cost)
      );
    }

    return finalized;
  }

  return {
    estimate,
    registerEstimator,
    listEstimators,
  };
}

// Convenience one-shot call
export async function estimateOnce(engineOptions, request) {
  const engine = createEstimateEngine(engineOptions);
  return engine.estimate(request);
}

/* ------------------------------ optional: tiny self-test (safe) ------------------------------ */
// This is intentionally not auto-executed. You can import and run in a dev console if needed.
export function __demoEstimateEngine() {
  const engine = createEstimateEngine({
    providers: {
      prices: {
        getPrice: (key) => {
          const table = {
            "chicken breast": {
              unitPrice: 4.25,
              confidence: 0.7,
              source: "demo",
            },
            rice: { unitPrice: 1.1, confidence: 0.7, source: "demo" },
          };
          return table[String(key).toLowerCase()] || null;
        },
      },
      nutrition: {
        getNutrition: (key) => {
          const table = {
            "chicken breast": { calories: 165, confidence: 0.7 },
            rice: { calories: 200, confidence: 0.7 },
          };
          return table[String(key).toLowerCase()] || null;
        },
      },
    },
  });

  return engine.estimate({
    domain: "meal",
    kind: "batch_cook",
    scale: 2,
    items: [
      { name: "chicken breast", qty: 3 },
      { name: "rice", qty: 2 },
    ],
    steps: [{ durationMin: 15 }, { durationMin: 25 }],
  });
}
