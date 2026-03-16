// src/services/planning/forecastFoodProduction.js
/**
 * forecastFoodProduction
 * ----------------------
 * Forecast garden + animal production into a weekly (or daily) timeline,
 * split into fresh-use vs preservation, and summarized for meal planning.
 *
 * Backward-compatible with the original API (same export name & defaults).
 * You can pass an optional `options` bag to unlock richer behaviors.
 *
 * Install: npm i dayjs
 *
 * IMPORTANT BUILD FIX:
 * - Some ES-module callers import this as a DEFAULT export:
 *     import forecastFoodProduction from "@/services/planning/forecastFoodProduction";
 * - This file previously used CommonJS `module.exports = { forecastFoodProduction }`
 *   which does NOT provide a default export for Vite ESM imports.
 * - To keep all other logic the same while fixing the build, we:
 *     1) Keep CommonJS exports for any legacy require() callers.
 *     2) ALSO add ESM exports (default + named) at the bottom.
 */

const dayjs = require("dayjs");

// IMPORTANT: We intentionally avoid dayjs plugins (like isBetween, isoWeek)
// so this runs zero-config. We implement comparisons manually.

// =============================================================================
// Options (all optional, backward-compatible)
// =============================================================================
const DEFAULT_OPTIONS = {
  /** 'week' (default) | 'day' */
  granularity: "week",
  /** Enable a simple climate/zone adjust (affects maturity) e.g., "6a" */
  zone: null,
  /** Include simple uncertainty bands (p10/p90) with ±15% default spread */
  includeUncertainty: false,
  /** Include cumulative totals in meta (up to each bucket) */
  includeCumulative: false,
};

// =============================================================================
// Coarse Defaults & Tables (extend as you grow)
// =============================================================================

// Yield tables (very coarse, per plant or per unit over a harvest window)
const CROP_YIELDS = {
  tomato: {
    unit: "lb",
    perPlant: 10,
    harvestWeeks: 8,
    startAfterDays: 70,
    spread: 0.18,
  },
  cucumber: {
    unit: "lb",
    perPlant: 6,
    harvestWeeks: 6,
    startAfterDays: 55,
    spread: 0.2,
  },
  zucchini: {
    unit: "lb",
    perPlant: 8,
    harvestWeeks: 8,
    startAfterDays: 50,
    spread: 0.18,
  },
  pepper: {
    unit: "lb",
    perPlant: 4,
    harvestWeeks: 8,
    startAfterDays: 70,
    spread: 0.18,
  },
  lettuce: {
    unit: "head",
    perPlant: 1,
    harvestWeeks: 1,
    startAfterDays: 45,
    spread: 0.1,
  },
  spinach: {
    unit: "lb",
    perSqft: 0.5,
    harvestWeeks: 2,
    startAfterDays: 40,
    spread: 0.15,
  },
  kale: {
    unit: "lb",
    perPlant: 3,
    harvestWeeks: 10,
    startAfterDays: 60,
    spread: 0.2,
  },
  bean: {
    unit: "lb",
    perPlant: 1.2,
    harvestWeeks: 6,
    startAfterDays: 55,
    spread: 0.22,
  },
  potato: {
    unit: "lb",
    perPlant: 3,
    harvestWeeks: 1,
    startAfterDays: 90,
    spread: 0.12,
  },
  onion: {
    unit: "lb",
    perPlant: 0.5,
    harvestWeeks: 1,
    startAfterDays: 90,
    spread: 0.12,
  },
  carrot: {
    unit: "lb",
    perPlant: 0.3,
    harvestWeeks: 1,
    startAfterDays: 70,
    spread: 0.12,
  },
};

const ANIMAL_MODELS = {
  // eggs/hen/week varies by season; meat birds harvested once; dairy per day
  chicken_layer: {
    type: "eggs",
    eggsPerHenPerWeek: { winter: 2, spring: 5, summer: 6, fall: 4 },
  },
  chicken_meat: {
    type: "meat",
    weeksToHarvest: 8,
    carcassLbPerBird: 4.0,
  },
  goat_dairy: {
    type: "milk",
    quartsPerDoePerDay: 2, // ~0.5 gal/day
    lactationWeeks: 40,
  },
  bee_honey: {
    type: "honey",
    lbPerHivePerSeason: 40, // coarse; split across late spring/summer
  },
};

const NUTRITION = {
  // per unit in calories + protein grams (very coarse)
  tomato_lb: { kcal: 82, protein: 4 },
  cucumber_lb: { kcal: 68, protein: 3 },
  zucchini_lb: { kcal: 72, protein: 5 },
  pepper_lb: { kcal: 90, protein: 3 },
  lettuce_head: { kcal: 15, protein: 1 },
  spinach_lb: { kcal: 104, protein: 12 },
  kale_lb: { kcal: 227, protein: 15 },
  bean_lb: { kcal: 610, protein: 38 },
  potato_lb: { kcal: 349, protein: 9 },
  onion_lb: { kcal: 182, protein: 4 },
  carrot_lb: { kcal: 186, protein: 4 },

  egg_each: { kcal: 70, protein: 6 },
  chicken_lb: { kcal: 748, protein: 88 }, // cooked meat, per lb edible
  milk_quart: { kcal: 600, protein: 32 },
  honey_lb: { kcal: 1390, protein: 0 },
};

const PRESERVATION = {
  // lossFactor applies to preserved portion; shelfLifeDays suggests rotation
  freeze: { lossFactor: 0.05, shelfLifeDays: 365 },
  can: { lossFactor: 0.1, shelfLifeDays: 730 },
  dehydrate: { lossFactor: 0.15, shelfLifeDays: 540 },
  ferment: { lossFactor: 0.1, shelfLifeDays: 180 },
};

// Household defaults if prefs not provided
const DEFAULT_PREFS = {
  meals: {
    portions: { default: 4 },
  },
  garden: {
    preservation: { defaultMethods: ["freeze", "can", "dehydrate", "ferment"] },
  },
};

// =============================================================================
// Utility helpers
// =============================================================================

function cmpInRange(date, start, end) {
  // true if start <= date <= end (inclusive)
  return (
    (date.isAfter(start) || date.isSame(start)) &&
    (date.isBefore(end) || date.isSame(end))
  );
}

function makeBuckets(startISO, endISO, granularity = "week") {
  const out = [];
  let cursor =
    dayjs(startISO)[granularity === "day" ? "startOf" : "startOf"](granularity);
  const end =
    dayjs(endISO)[granularity === "day" ? "endOf" : "endOf"](granularity);
  while (cursor.isBefore(end) || cursor.isSame(end)) {
    const start = cursor.startOf(granularity);
    const endB = cursor.endOf(granularity);
    out.push({
      key: start.format("YYYY-MM-DD"), // stable key = bucket start (avoids iso-week plugins)
      start,
      end: endB,
      items: [],
      nutrition: { kcal: 0, protein: 0 },
    });
    cursor = cursor.add(1, granularity === "day" ? "day" : "week");
  }
  return out;
}

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

function seasonOf(date) {
  const m = dayjs(date).month(); // 0-11
  if (m <= 1 || m === 11) return "winter";
  if (m >= 2 && m <= 4) return "spring";
  if (m >= 5 && m <= 7) return "summer";
  return "fall";
}

function addNutrition(rollup, itemKey, qty) {
  const meta = NUTRITION[itemKey];
  if (!meta) return;
  rollup.kcal += (meta.kcal || 0) * qty;
  rollup.protein += (meta.protein || 0) * qty;
}

function normPrefs(prefs) {
  return { ...DEFAULT_PREFS, ...(prefs || {}) };
}

function parseZoneNumber(zone) {
  // "8a" -> 8 ; "6" -> 6 ; else null
  if (!zone) return null;
  const n = parseInt(String(zone), 10);
  return Number.isFinite(n) ? n : null;
}

function climateAdjustMaturity(daysToMaturity, zone) {
  // Very coarse heuristic: zones >= 8 => -10% maturity, zones <= 5 => +10%
  const z = parseZoneNumber(zone);
  if (!z) return daysToMaturity;
  if (z >= 8) return Math.round(daysToMaturity * 0.9);
  if (z <= 5) return Math.round(daysToMaturity * 1.1);
  return daysToMaturity;
}

// Gaussian-ish weight curve (rise → plateau → fall)
function harvestWeights(weeks) {
  if (weeks <= 1) return [1];
  const w = [];
  const mid = (weeks - 1) / 2;
  for (let i = 0; i < weeks; i++) {
    const x = (i - mid) / (mid || 1);
    // bell-ish: e^{-x^2}
    w.push(Math.exp(-x * x));
  }
  const sum = w.reduce((a, b) => a + b, 0);
  return w.map((v) => v / (sum || 1));
}

// Succession expansion
function expandSuccessions(plantings = []) {
  const out = [];
  for (const p of plantings) {
    const base = { ...p };
    const succ = p.succession;
    if (!succ?.times || !succ?.intervalDays) {
      out.push(base);
      continue;
    }
    const times = clamp(Number(succ.times), 1, 52);
    const step = clamp(Number(succ.intervalDays), 1, 180);
    for (let i = 0; i < times; i++) {
      const shifted = { ...base };
      // shift sow/transplant/plantedOn by interval * i
      const fields = ["sowDate", "transplantDate", "plantedOn"];
      for (const f of fields) {
        if (shifted[f])
          shifted[f] = dayjs(shifted[f])
            .add(step * i, "day")
            .format("YYYY-MM-DD");
      }
      shifted.id = `${base.id || base.crop || "planting"}#${i + 1}`;
      out.push(shifted);
    }
  }
  return out;
}

// =============================================================================
// Garden Forecaster
// =============================================================================

/**
 * plantings: [
 *  { crop:'tomato', method:'transplant', qty:12, unit:'plants',
 *    sowDate:'2025-04-10', daysToMaturity:75, expectedPerPlant:12, succession?:{times,intervalDays} }
 * ]
 */
function forecastGarden(
  plantings = [],
  range,
  granularity = "week",
  { zone = null, includeUncertainty = false } = {}
) {
  const buckets = makeBuckets(range.start, range.end, granularity);
  const plan = expandSuccessions(plantings);

  for (const p of plan) {
    const cropKey = (p.crop || "").toLowerCase();
    const model = CROP_YIELDS[cropKey];
    if (!model) continue;

    // Determine start of harvest window
    const baseDate =
      p.transplantDate || p.sowDate || p.plantedOn || range.start;
    const rawD2M = Number(p.daysToMaturity || model.startAfterDays || 60);
    const d2m = climateAdjustMaturity(rawD2M, zone);
    const firstHarvest = dayjs(baseDate).add(d2m, "day");

    // Determine quantity basis
    let totalYield = 0;
    const unitLabel = model.unit;
    if (p.unit === "plants" && (p.expectedPerPlant || model.perPlant)) {
      totalYield = (p.expectedPerPlant ?? model.perPlant) * Number(p.qty || 0);
    } else if (p.unit === "sqft" && model.perSqft) {
      totalYield = model.perSqft * Number(p.qty || 0);
    } else if (p.expectedTotal) {
      totalYield = Number(p.expectedTotal);
    } else if (model.perPlant && p.qty != null) {
      totalYield = model.perPlant * Number(p.qty);
    }

    if (totalYield <= 0) continue;

    const weeks = clamp(
      Number(p.harvestWeeks || model.harvestWeeks || 6),
      1,
      20
    );
    const weights = harvestWeights(weeks);

    // Place yields into buckets
    for (let i = 0; i < weeks; i++) {
      const bucketDate = firstHarvest.add(i, "week");
      for (const b of buckets) {
        if (cmpInRange(bucketDate, b.start, b.end)) {
          const qty = totalYield * (weights[i] || 0);
          const item = {
            id: `garden:${cropKey}:${p.id || i}:${b.key}`,
            source: "garden",
            date: bucketDate.toISOString(),
            name: p.variety ? `${p.crop} (${p.variety})` : p.crop,
            crop: cropKey,
            qty,
            unit: unitLabel,
            meta: {
              plantingId: p.id || null,
              variety: p.variety || null,
            },
          };

          if (includeUncertainty) {
            const spread =
              typeof p.spread === "number" ? p.spread : model.spread || 0.15;
            item.ci = {
              p10: Math.max(0, qty * (1 - spread)),
              p90: qty * (1 + spread),
            };
          }

          b.items.push(item);
          addNutrition(b.nutrition, `${cropKey}_${unitLabel}`, qty);
          break;
        }
      }
    }
  }

  return buckets;
}

// =============================================================================
// Animal Forecaster
// =============================================================================

/**
 * animals: [
 *  { species:'chicken', purpose:'layer', count:12, startDate:'2025-03-01' },
 *  { species:'chicken', purpose:'meat',  count:20, startDate:'2025-05-01', harvestDate:'2025-06-26' },
 *  { species:'goat',    purpose:'dairy', count:2,  freshenDate:'2025-04-15' },
 *  { species:'bee',     purpose:'honey', hives:2 }
 * ]
 */
function forecastAnimals(
  animals = [],
  range,
  granularity = "week",
  { includeUncertainty = false } = {}
) {
  const buckets = makeBuckets(range.start, range.end, granularity);

  for (const a of animals) {
    const species = (a.species || "").toLowerCase();
    const purpose = (a.purpose || "").toLowerCase();

    // CHICKEN LAYERS
    if (species === "chicken" && purpose === "layer") {
      const count = Number(a.count || a.hens || 0);
      if (!count) continue;
      for (const b of buckets) {
        const season = seasonOf(b.start);
        const model = ANIMAL_MODELS.chicken_layer;
        const eggsPerHen = model.eggsPerHenPerWeek[season] || 4;
        const eggs = eggsPerHen * count;
        const item = {
          id: `animal:eggs:${b.key}`,
          source: "animal",
          date: b.start.toISOString(),
          name: "Chicken eggs",
          qty: eggs,
          unit: "each",
          meta: { species, purpose, count },
        };
        if (includeUncertainty) {
          item.ci = { p10: eggs * 0.85, p90: eggs * 1.15 };
        }
        b.items.push(item);
        addNutrition(b.nutrition, "egg_each", eggs);
      }
      continue;
    }

    // CHICKEN MEAT BIRDS
    if (species === "chicken" && purpose === "meat") {
      const count = Number(a.count || 0);
      if (!count) continue;
      const model = ANIMAL_MODELS.chicken_meat;
      const baseStart = a.startDate ? dayjs(a.startDate) : dayjs(range.start);
      const harvestDate = a.harvestDate
        ? dayjs(a.harvestDate)
        : baseStart.add(model.weeksToHarvest, "week");
      const carcass = model.carcassLbPerBird * count;
      for (const b of buckets) {
        if (cmpInRange(harvestDate, b.start, b.end)) {
          const item = {
            id: `animal:chicken_meat:${b.key}`,
            source: "animal",
            date: harvestDate.toISOString(),
            name: "Chicken (whole/cuts)",
            qty: carcass,
            unit: "lb",
            meta: { species, purpose, count },
          };
          if (includeUncertainty) {
            item.ci = { p10: carcass * 0.9, p90: carcass * 1.1 };
          }
          b.items.push(item);
          addNutrition(b.nutrition, "chicken_lb", carcass);
          break;
        }
      }
      continue;
    }

    // GOAT DAIRY
    if (species === "goat" && purpose === "dairy") {
      const count = Number(a.count || a.does || 0);
      if (!count) continue;
      const model = ANIMAL_MODELS.goat_dairy;
      const start = dayjs(a.freshenDate || range.start);
      const end = start.add(model.lactationWeeks, "week");
      for (const b of buckets) {
        // If the bucket overlaps lactation
        const inLactation = b.end.isAfter(start) && b.start.isBefore(end);
        if (!inLactation) continue;
        const days = granularity === "day" ? 1 : 7;
        const quarts = model.quartsPerDoePerDay * days * count;
        const item = {
          id: `animal:goat_milk:${b.key}`,
          source: "animal",
          date: b.start.toISOString(),
          name: "Goat milk",
          qty: quarts,
          unit: "quart",
          meta: { species, purpose, count },
        };
        if (includeUncertainty) {
          item.ci = { p10: quarts * 0.9, p90: quarts * 1.1 };
        }
        b.items.push(item);
        addNutrition(b.nutrition, "milk_quart", quarts);
      }
      continue;
    }

    // HONEY
    if (
      (species === "bee" || species === "bees" || species === "honeybee") &&
      (purpose === "honey" || !purpose)
    ) {
      const hives = Number(a.hives || a.count || 0);
      if (!hives) continue;
      const total = ANIMAL_MODELS.bee_honey.lbPerHivePerSeason * hives;
      // Split across June-August
      const drops = [
        { month: 6, share: 0.35 },
        { month: 7, share: 0.45 },
        { month: 8, share: 0.2 },
      ];
      for (const d of drops) {
        const dt = dayjs(range.start)
          .month(d.month - 1)
          .date(15);
        for (const b of buckets) {
          if (cmpInRange(dt, b.start, b.end)) {
            const qty = total * d.share;
            const item = {
              id: `animal:honey:${b.key}`,
              source: "animal",
              date: dt.toISOString(),
              name: "Honey",
              qty,
              unit: "lb",
              meta: { species: "bee", purpose: "honey", hives },
            };
            if (includeUncertainty) {
              item.ci = { p10: qty * 0.85, p90: qty * 1.15 };
            }
            b.items.push(item);
            addNutrition(b.nutrition, "honey_lb", qty);
            break;
          }
        }
      }
      continue;
    }
  }

  return buckets;
}

// =============================================================================
// Preservation Planner
// =============================================================================

/**
 * Splits each bucket's items into fresh-use vs preserve based on:
 * - household fresh capacity (servings per week)
 * - item perishability (leafy greens -> more fresh)
 * - prefs garden.preservation.defaultMethods
 */
function splitFreshVsPreserve(buckets, prefs = DEFAULT_PREFS) {
  const P = normPrefs(prefs);
  const servingsPerMeal = Number(P.meals?.portions?.default || 4);
  const assumedMealsUsingProduce = 7; // one produce-forward slot per day
  const weeklyFreshServingCapacity = servingsPerMeal * assumedMealsUsingProduce;

  // Very coarse perishability bias (higher = prefer fresh)
  const perishBias = (name) => {
    const k = (name || "").toLowerCase();
    if (k.includes("lettuce") || k.includes("spinach")) return 1.0;
    if (k.includes("kale") || k.includes("zucchini") || k.includes("cucumber"))
      return 0.6;
    if (k.includes("tomato") || k.includes("pepper") || k.includes("bean"))
      return 0.5;
    if (k.includes("milk") || k.includes("egg")) return 0.7;
    return 0.3;
  };

  const defaultMethods = P.garden?.preservation?.defaultMethods || [
    "freeze",
    "can",
    "dehydrate",
    "ferment",
  ];

  for (const b of buckets) {
    let freshBudget = weeklyFreshServingCapacity;
    for (const it of b.items) {
      // serving estimate: 0.25 lb produce per serving, 2 eggs per serving, 1 cup milk per serving (0.25 quart)
      let servings = 0;
      if (it.unit === "lb") servings = it.qty / 0.25;
      else if (it.unit === "each") servings = it.qty / 2;
      else if (it.unit === "quart") servings = it.qty / 0.25;
      else if (it.unit === "head") servings = it.qty * 2; // 2 servings per head
      else servings = it.qty; // fallback

      const bias = perishBias(it.name);
      const toFreshServings = clamp(
        Math.min(servings, freshBudget) * bias +
          Math.min(servings * (1 - bias), freshBudget * 0.3),
        0,
        servings
      );
      const toPreserveServings = clamp(servings - toFreshServings, 0, servings);

      // Convert servings back to qty
      let freshQty = 0,
        preserveQty = 0;
      if (it.unit === "lb") {
        freshQty = toFreshServings * 0.25;
        preserveQty = toPreserveServings * 0.25;
      } else if (it.unit === "each") {
        freshQty = toFreshServings * 2;
        preserveQty = toPreserveServings * 2;
      } else if (it.unit === "quart") {
        freshQty = toFreshServings * 0.25;
        preserveQty = toPreserveServings * 0.25;
      } else if (it.unit === "head") {
        freshQty = toFreshServings / 2;
        preserveQty = toPreserveServings / 2;
      } else {
        const ratio = toFreshServings / (servings || 1);
        freshQty = it.qty * ratio;
        preserveQty = it.qty - freshQty;
      }

      freshQty = clamp(freshQty, 0, it.qty);
      preserveQty = clamp(preserveQty, 0, it.qty - freshQty);
      freshBudget = clamp(
        freshBudget - toFreshServings,
        0,
        weeklyFreshServingCapacity
      );

      it.split = {
        freshQty,
        preserveQty,
        methods: preserveQty > 0 ? defaultMethods : [],
      };

      // Attach nutrition splits
      const tmpRoll = { kcal: 0, protein: 0 };
      const nutKey = `${(it.crop || it.name || "").toLowerCase()}_${
        it.unit
      }`.replace(/\s+/g, "");
      addNutrition(tmpRoll, nutKey, it.qty);
      const ratioF = it.qty ? freshQty / it.qty : 0;
      const ratioP = it.qty ? preserveQty / it.qty : 0;
      it.nutrition = {
        total: tmpRoll,
        fresh: {
          kcal: tmpRoll.kcal * ratioF,
          protein: tmpRoll.protein * ratioF,
        },
        preserved: {
          kcal: tmpRoll.kcal * ratioP,
          protein: tmpRoll.protein * ratioP,
        },
      };
    }
  }

  return buckets;
}

/**
 * Estimate preservation losses & produce task suggestions.
 */
function planPreservationTasks(buckets, prefs = DEFAULT_PREFS) {
  const P = normPrefs(prefs);
  const methods = P.garden?.preservation?.defaultMethods || ["freeze", "can"];

  const tasks = [];
  for (const b of buckets) {
    for (const it of b.items) {
      const pq = it.split?.preserveQty || 0;
      if (!pq || methods.length === 0) continue;

      // Simple method selection by item name
      const name = (it.name || "").toLowerCase();
      let method = methods[0];
      if (name.includes("tomato"))
        method = methods.includes("can") ? "can" : method;
      else if (
        name.includes("zucchini") ||
        name.includes("kale") ||
        name.includes("spinach")
      )
        method = methods.includes("dehydrate") ? "dehydrate" : method;
      else if (name.includes("cucumber"))
        method = methods.includes("ferment") ? "ferment" : method;
      else if (name.includes("milk"))
        method = methods.includes("ferment") ? "ferment" : method;

      const loss = PRESERVATION[method]?.lossFactor || 0.1;
      const keepQty = pq * (1 - loss);

      it.preservation = {
        method,
        lossFactor: loss,
        keptQty: keepQty,
        shelfLifeDays: PRESERVATION[method]?.shelfLifeDays || 180,
      };
      tasks.push({
        dateWindow: { start: b.start.toISOString(), end: b.end.toISOString() },
        item: it.name,
        qty: pq,
        unit: it.unit,
        method,
        expectedKeptQty: keepQty,
        shelfLifeDays: PRESERVATION[method]?.shelfLifeDays || 180,
      });
    }
  }

  return { buckets, tasks };
}

// =============================================================================
// Nutrition & Servings Summary
// =============================================================================

function summarize(buckets, { includeCumulative = false } = {}) {
  const totals = { kcal: 0, protein: 0 };
  const byItem = {};
  const timeline = [];
  let running = { kcal: 0, protein: 0 };

  for (const b of buckets) {
    const weekSum = { kcal: 0, protein: 0 };
    const fresh = { kcal: 0, protein: 0 };
    const preserved = { kcal: 0, protein: 0 };

    for (const it of b.items) {
      weekSum.kcal += it.nutrition?.total?.kcal || 0;
      weekSum.protein += it.nutrition?.total?.protein || 0;

      fresh.kcal += it.nutrition?.fresh?.kcal || 0;
      fresh.protein += it.nutrition?.fresh?.protein || 0;

      preserved.kcal += it.nutrition?.preserved?.kcal || 0;
      preserved.protein += it.nutrition?.preserved?.protein || 0;

      const key = `${(it.crop || it.name).toLowerCase()}_${it.unit}`;
      byItem[key] = byItem[key] || { qty: 0, unit: it.unit, name: it.name };
      byItem[key].qty += it.qty;
    }

    totals.kcal += weekSum.kcal;
    totals.protein += weekSum.protein;

    if (includeCumulative) {
      running = {
        kcal: running.kcal + weekSum.kcal,
        protein: running.protein + weekSum.protein,
      };
    }

    timeline.push({
      key: b.key,
      start: b.start.toISOString(),
      end: b.end.toISOString(),
      items: b.items,
      nutrition: {
        total: weekSum,
        fresh,
        preserved,
        cumulative: includeCumulative ? running : undefined,
      },
    });
  }

  return { totals, byItem, timeline };
}

// =============================================================================
/* Public API */
// =============================================================================

/**
 * Forecast both garden and animals, split into fresh/preserve, add nutrition.
 *
 * @param {Object} args
 * @param {Array<Object>} args.plantings
 * @param {Array<Object>} args.animals
 * @param {Object} args.prefs (optional; merged with defaults)
 * @param {String} args.startDate (ISO)
 * @param {String} args.endDate (ISO)
 * @param {'week'|'day'} args.granularity  (back-compat; prefer options.granularity)
 * @param {Object} options Optional richer options:
 *    - granularity: 'week' | 'day'
 *    - zone: '6a' | '8a' | ...
 *    - includeUncertainty: boolean
 *    - includeCumulative: boolean
 */
async function forecastFoodProduction(
  {
    plantings = [],
    animals = [],
    prefs = null,
    startDate,
    endDate,
    granularity,
  } = {},
  options = {}
) {
  const opt = { ...DEFAULT_OPTIONS, ...(options || {}) };
  const usedGranularity = granularity || opt.granularity || "week";

  const range = {
    start: startDate ? dayjs(startDate) : dayjs().startOf(usedGranularity),
    end: endDate
      ? dayjs(endDate)
      : dayjs()
          .add(12, usedGranularity === "day" ? "week" : "week")
          .endOf(usedGranularity),
  };

  // Build two independent forecasts then merge per bucket key
  const g = forecastGarden(plantings, range, usedGranularity, {
    zone: opt.zone,
    includeUncertainty: opt.includeUncertainty,
  });
  const a = forecastAnimals(animals, range, usedGranularity, {
    includeUncertainty: opt.includeUncertainty,
  });

  // Merge buckets by key
  const map = new Map();
  for (const b of [...g, ...a]) {
    if (!map.has(b.key)) {
      map.set(b.key, {
        key: b.key,
        start: b.start,
        end: b.end,
        items: [],
        nutrition: { kcal: 0, protein: 0 },
      });
    }
    const tgt = map.get(b.key);
    tgt.items.push(...b.items);
    tgt.nutrition.kcal += b.nutrition.kcal;
    tgt.nutrition.protein += b.nutrition.protein;
  }

  const mergedBuckets = [...map.values()].sort(
    (x, y) => x.start.valueOf() - y.start.valueOf()
  );

  // Split fresh vs preserve and attach nutrition splits
  splitFreshVsPreserve(mergedBuckets, prefs || DEFAULT_PREFS);

  // Plan preservation tasks with losses and shelf life
  const { buckets: planned, tasks } = planPreservationTasks(
    mergedBuckets,
    prefs || DEFAULT_PREFS
  );

  // Summaries
  const { totals, byItem, timeline } = summarize(planned, {
    includeCumulative: opt.includeCumulative,
  });

  return {
    range: { start: range.start.toISOString(), end: range.end.toISOString() },
    granularity: usedGranularity,
    timeline,
    totals,
    byItem,
    preservationTasks: tasks,
    meta: {
      options: opt,
      plantingsExpanded: expandSuccessions(plantings).length,
    },
  };
}

// =============================================================================
/* Exports */
// =============================================================================

// CommonJS (legacy) — keep as-is for require() callers
module.exports = {
  forecastFoodProduction,
  // exposed helpers (useful for tests or UI exploration)
  forecastGarden,
  forecastAnimals,
  splitFreshVsPreserve,
  planPreservationTasks,
  summarize,
  tables: { CROP_YIELDS, ANIMAL_MODELS, NUTRITION, PRESERVATION },
};

// ESM exports (Vite/Rollup) — added to fix default import failures
export default forecastFoodProduction;
export {
  forecastFoodProduction,
  forecastGarden,
  forecastAnimals,
  splitFreshVsPreserve,
  planPreservationTasks,
  summarize,
  CROP_YIELDS,
  ANIMAL_MODELS,
  NUTRITION,
  PRESERVATION,
};
