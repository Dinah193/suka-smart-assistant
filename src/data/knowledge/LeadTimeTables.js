// C:\Users\larho\suka-smart-assistant\src\data\knowledge\LeadTimeTables.js
/**
 * LeadTimeTables (SSA Knowledge)
 * -----------------------------------------------------------------------------
 * Purpose:
 *  - Provide a fixed, deterministic (non-AI) knowledge base for estimating lead times
 *    in days across household procurement + homestead production planning.
 *
 * Design goals:
 *  - Browser-safe (pure data + pure functions; no Node imports).
 *  - Conservative defaults: when uncertain, prefer longer lead times.
 *  - Extensible: add new categories/items/suppliers without breaking callers.
 *
 * How to use:
 *  - import LeadTimeTables, { estimateLeadTimeDays } from "@/data/knowledge/LeadTimeTables.js"
 *  - estimateLeadTimeDays({ category: "food:dry", itemKey: "rice", supplierType: "online", shippingSpeed: "standard" })
 *
 * Notes:
 *  - Lead time = time from "decision to acquire" until "usable in household plan".
 *  - For homestead production (garden/animals), this includes growth/finish time.
 *  - Values are "days", integers.
 */

/* -------------------------------------------------------------------------- */
/* Versioning                                                                 */
/* -------------------------------------------------------------------------- */

export const LEAD_TIME_TABLES_VERSION = "1.0.0";
export const LEAD_TIME_TABLES_LAST_UPDATED_ISO = "2026-01-01T00:00:00.000Z";

/* -------------------------------------------------------------------------- */
/* Utilities                                                                  */
/* -------------------------------------------------------------------------- */

const clampInt = (n, min, max) => {
  const x = Number.isFinite(Number(n)) ? Math.round(Number(n)) : NaN;
  if (!Number.isFinite(x)) return min;
  return Math.min(max, Math.max(min, x));
};

const asLower = (v) => (typeof v === "string" ? v.toLowerCase().trim() : "");

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

const safe = (fn, fallback) => {
  try {
    const v = fn();
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
};

/** Simple additive buffer in days to reduce underestimation risk. */
const conservativeBuffer = (baseDays, bufferPolicy) => {
  const b = bufferPolicy || {};
  const fixed = Number.isFinite(b.fixedDays) ? b.fixedDays : 0;
  const pct = Number.isFinite(b.percent) ? b.percent : 0; // e.g., 0.1 = +10%
  const buff = Math.round(baseDays * pct + fixed);
  return clampInt(baseDays + buff, 0, 3650);
};

/* -------------------------------------------------------------------------- */
/* Core enumerations (keep aligned with SSA UI selections)                    */
/* -------------------------------------------------------------------------- */

/**
 * Supplier types (coarse) for procurement lead time.
 * - local: walk-in/pickup same day
 * - regional: within state/region delivery
 * - national: domestic shipping
 * - international: customs + longer transit
 * - farm: direct farm pickup/delivery schedules
 * - co_op: coop ordering cycles
 */
export const SUPPLIER_TYPES = Object.freeze([
  "local",
  "regional",
  "national",
  "international",
  "farm",
  "co_op",
]);

/**
 * Shipping speeds (if applicable).
 * - pickup: no shipping
 * - same_day: courier
 * - express: 1–2 business days typical
 * - standard: 3–7 business days typical
 * - freight: larger items
 */
export const SHIPPING_SPEEDS = Object.freeze([
  "pickup",
  "same_day",
  "express",
  "standard",
  "freight",
]);

/**
 * Seasonal context: influences some categories (e.g., plants, construction, certain foods).
 */
export const SEASONS = Object.freeze(["winter", "spring", "summer", "fall"]);

/**
 * Demand pressure context: affects delays.
 */
export const DEMAND_PRESSURE = Object.freeze(["low", "normal", "high", "peak"]);

/* -------------------------------------------------------------------------- */
/* Baseline procurement lead times (days)                                     */
/* -------------------------------------------------------------------------- */

/**
 * Baseline delivery lead-time by supplier + shipping speed.
 * This is ONLY the transit/fulfillment portion (not "prep" or "processing").
 */
export const PROCUREMENT_TRANSIT_DAYS = Object.freeze({
  local: {
    pickup: 0,
    same_day: 0,
    express: 1,
    standard: 2,
    freight: 3,
  },
  regional: {
    pickup: 0,
    same_day: 1,
    express: 2,
    standard: 4,
    freight: 6,
  },
  national: {
    pickup: 0,
    same_day: 2,
    express: 3,
    standard: 6,
    freight: 10,
  },
  international: {
    pickup: 0,
    same_day: 5,
    express: 7,
    standard: 14,
    freight: 21,
  },
  farm: {
    pickup: 0,
    same_day: 1,
    express: 2,
    standard: 4,
    freight: 7,
  },
  co_op: {
    pickup: 0,
    same_day: 2,
    express: 4,
    standard: 7,
    freight: 12,
  },
});

/**
 * Order cycle / batching delays common to certain supplier types.
 * Example: co-op orders only place weekly; farms deliver on a route day.
 */
export const PROCUREMENT_CYCLE_DAYS = Object.freeze({
  local: 0,
  regional: 0,
  national: 0,
  international: 0,
  farm: 2, // route / harvest coordination
  co_op: 5, // weekly ordering cycle (conservative)
});

/**
 * Demand multipliers. Applied to the procurement portion.
 * Example: during peak demand, delays increase.
 */
export const DEMAND_MULTIPLIERS = Object.freeze({
  low: 0.9,
  normal: 1.0,
  high: 1.15,
  peak: 1.35,
});

/**
 * Season multipliers by category group (coarse).
 * - winter can slow construction and outdoor procurement routes
 * - spring/summer can shorten produce availability but increase shipping congestion
 */
export const SEASON_MULTIPLIERS = Object.freeze({
  // for general procurement
  procurement: {
    winter: 1.1,
    spring: 1.0,
    summer: 1.05,
    fall: 1.02,
  },
  // for garden planting/seed/starts (availability + shipping)
  garden_inputs: {
    winter: 1.05,
    spring: 1.2, // spring rush
    summer: 1.1,
    fall: 1.0,
  },
  // for construction/building materials
  construction: {
    winter: 1.2,
    spring: 1.05,
    summer: 1.0,
    fall: 1.05,
  },
});

/* -------------------------------------------------------------------------- */
/* Knowledge tables: category + item-level defaults                            */
/* -------------------------------------------------------------------------- */

/**
 * Each item entry can specify:
 * - baseDays: baseline lead time (if not using procurement model)
 * - procurement: override procurement model parameters (cycle/transit)
 * - prepDays: extra days after delivery before "usable" (e.g., curing, acclimation)
 * - notes: UI hint
 *
 * For procurement-based categories, baseDays is computed:
 *   cycleDays + transitDays, then season/demand modifiers, then +prepDays, then buffer
 *
 * For production categories (garden/animals), baseDays typically includes growth time.
 */
export const LEAD_TIME_CATEGORIES = Object.freeze({
  /* ------------------------------ Food (store) ----------------------------- */
  "food:fresh": {
    label: "Food (Fresh)",
    group: "procurement",
    defaultItem: { prepDays: 0, buffer: { percent: 0.1, fixedDays: 0 } },
    items: {
      // Fresh foods are typically acquired locally; keep transit minimal.
      produce: { notes: "Local produce availability varies by season." },
      "leafy-greens": { notes: "Short shelf-life; plan close to use." },
      "root-vegetables": { notes: "Often available year-round." },
      meat: { prepDays: 0, notes: "Assumes retail purchase; not butchering." },
      fish: { prepDays: 0, notes: "Assumes retail purchase." },
      dairy: { prepDays: 0, notes: "Assumes retail purchase." },
      eggs: { prepDays: 0, notes: "Assumes retail purchase." },
    },
  },

  "food:dry": {
    label: "Food (Dry / Pantry)",
    group: "procurement",
    defaultItem: { prepDays: 0, buffer: { percent: 0.1, fixedDays: 0 } },
    items: {
      rice: { notes: "Staple dry good." },
      beans: { notes: "Staple dry good." },
      flour: { notes: "Staple dry good." },
      oats: { notes: "Staple dry good." },
      pasta: { notes: "Staple dry good." },
      salt: { notes: "Staple dry good." },
      sugar: { notes: "Staple dry good." },
      spices: {
        notes: "Varies by supplier; specialty spices can take longer.",
      },
    },
  },

  "food:frozen": {
    label: "Food (Frozen)",
    group: "procurement",
    defaultItem: { prepDays: 0, buffer: { percent: 0.1, fixedDays: 0 } },
    items: {
      "frozen-veg": { notes: "Assumes retail freezer section." },
      "frozen-fruit": { notes: "Assumes retail freezer section." },
      "frozen-meat": { notes: "Assumes retail freezer section." },
    },
  },

  /* --------------------------- Preservation inputs -------------------------- */
  "preservation:supplies": {
    label: "Preservation Supplies",
    group: "procurement",
    defaultItem: { prepDays: 0, buffer: { percent: 0.15, fixedDays: 0 } },
    items: {
      "canning-jars": {
        notes: "Seasonal demand spikes (late summer/fall).",
        buffer: { percent: 0.2, fixedDays: 1 },
      },
      "canning-lids": {
        notes: "Often delayed during peak canning season.",
        buffer: { percent: 0.25, fixedDays: 1 },
      },
      "pressure-canner": { buffer: { percent: 0.25, fixedDays: 2 } },
      dehydrator: { buffer: { percent: 0.2, fixedDays: 2 } },
      freezer: { buffer: { percent: 0.25, fixedDays: 3 } },
      "vacuum-sealer": { buffer: { percent: 0.2, fixedDays: 2 } },
    },
  },

  /* ------------------------------- Garden inputs ---------------------------- */
  "garden:inputs": {
    label: "Garden Inputs (Seeds, Starts, Soil, Tools)",
    group: "procurement:garden_inputs",
    defaultItem: { prepDays: 0, buffer: { percent: 0.15, fixedDays: 0 } },
    items: {
      seeds: { notes: "Spring rush can delay seed shipments." },
      "seed-potatoes": { buffer: { percent: 0.2, fixedDays: 1 } },
      "onion-sets": { buffer: { percent: 0.2, fixedDays: 1 } },
      "plant-starts": { buffer: { percent: 0.2, fixedDays: 1 } },
      compost: { notes: "Local delivery often faster than bag shipment." },
      "raised-bed-kit": { buffer: { percent: 0.25, fixedDays: 2 } },
      "irrigation-kit": { buffer: { percent: 0.2, fixedDays: 2 } },
    },
  },

  /* -------------------------- Garden production (grow) ---------------------- */
  "garden:production": {
    label: "Garden Production (Time to Harvest)",
    group: "production",
    defaultItem: { prepDays: 0, buffer: { percent: 0.1, fixedDays: 2 } },
    items: {
      // These are typical days-to-harvest from planting/transplant to usable harvest.
      // You can override with your own cultivar tables later.
      "leafy-greens": {
        baseDays: 35,
        notes: "Typical leafy greens harvest window.",
      },
      lettuce: { baseDays: 45 },
      spinach: { baseDays: 40 },
      kale: { baseDays: 60 },
      tomatoes: { baseDays: 85 },
      peppers: { baseDays: 90 },
      cucumbers: { baseDays: 55 },
      squash: { baseDays: 60 },
      okra: { baseDays: 60 },
      carrots: { baseDays: 75 },
      potatoes: { baseDays: 100 },
      onions: { baseDays: 120 },
      garlic: { baseDays: 240, notes: "Often fall-planted; long season." },
      corn: { baseDays: 80 },
      beans: { baseDays: 55 },
      peas: { baseDays: 65 },
      wheat: { baseDays: 120 },
    },
  },

  /* --------------------------- Animals: procurement ------------------------- */
  "animals:inputs": {
    label: "Animal Inputs (Feed, Bedding, Supplies)",
    group: "procurement",
    defaultItem: { prepDays: 0, buffer: { percent: 0.15, fixedDays: 0 } },
    items: {
      feed: { notes: "Bulk feed delivery can take longer (freight)." },
      bedding: { notes: "Often local; delivery varies." },
      "fencing-supplies": { buffer: { percent: 0.2, fixedDays: 2 } },
      "waterers-feeders": { buffer: { percent: 0.2, fixedDays: 2 } },
    },
  },

  /* -------------------------- Animals: production (grow) -------------------- */
  "animals:production": {
    label: "Animal Production (Raise to Butchering/Use)",
    group: "production",
    defaultItem: { prepDays: 0, buffer: { percent: 0.1, fixedDays: 7 } },
    items: {
      // Conservative typical timelines (days) from acquisition to usable milestone.
      // (These are placeholders you can tune per breed/management later.)
      chickens_broiler: { baseDays: 56, notes: "Typical broiler grow-out." },
      chickens_layers: { baseDays: 140, notes: "To start laying (approx.)." },
      ducks_meat: { baseDays: 70 },
      turkeys: { baseDays: 140 },
      rabbits: { baseDays: 90 },
      goats_meat: { baseDays: 240 },
      sheep_meat: { baseDays: 240 },
      cattle_finish: {
        baseDays: 540,
        notes: "Finishing timeline can vary widely.",
      },
    },
  },

  /* ------------------------------- Construction ----------------------------- */
  "construction:materials": {
    label: "Construction Materials",
    group: "procurement:construction",
    defaultItem: { prepDays: 0, buffer: { percent: 0.2, fixedDays: 2 } },
    items: {
      lumber: { notes: "May be constrained seasonally/regionally." },
      concrete: {
        notes: "Local availability matters; set by delivery schedules.",
      },
      gravel: { notes: "Often local deliveries." },
      "roofing-materials": { buffer: { percent: 0.25, fixedDays: 3 } },
      "windows-doors": {
        buffer: { percent: 0.35, fixedDays: 5 },
        notes: "Often special order.",
      },
      appliances: { buffer: { percent: 0.25, fixedDays: 3 } },
    },
  },

  /* ------------------------------- Household goods -------------------------- */
  "household:cleaning": {
    label: "Household (Cleaning Supplies)",
    group: "procurement",
    defaultItem: { prepDays: 0, buffer: { percent: 0.1, fixedDays: 0 } },
    items: {
      detergents: {},
      "paper-goods": {},
      "trash-bags": {},
      "soap-making-inputs": { buffer: { percent: 0.15, fixedDays: 1 } },
    },
  },

  "household:hygiene": {
    label: "Household (Hygiene Supplies)",
    group: "procurement",
    defaultItem: { prepDays: 0, buffer: { percent: 0.1, fixedDays: 0 } },
    items: {
      toiletries: {},
      "feminine-care": {},
      "first-aid": { buffer: { percent: 0.15, fixedDays: 1 } },
    },
  },

  /* --------------------------------- Default ------------------------------- */
  "generic:procurement": {
    label: "Generic Procurement",
    group: "procurement",
    defaultItem: { prepDays: 0, buffer: { percent: 0.15, fixedDays: 0 } },
    items: {
      generic: { notes: "Fallback item for unknown procurement." },
    },
  },

  "generic:production": {
    label: "Generic Production",
    group: "production",
    defaultItem: { prepDays: 0, buffer: { percent: 0.1, fixedDays: 3 } },
    items: {
      generic: { baseDays: 30, notes: "Fallback production duration." },
    },
  },
});

/* -------------------------------------------------------------------------- */
/* Public API: Estimation                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Resolve a category table safely.
 * @param {string} category
 */
export function getCategoryTable(category) {
  const key =
    category in LEAD_TIME_CATEGORIES ? category : "generic:procurement";
  return LEAD_TIME_CATEGORIES[key];
}

/**
 * Resolve an item table safely.
 * @param {object} categoryTable
 * @param {string} itemKey
 */
export function getItemEntry(categoryTable, itemKey) {
  const k = asLower(itemKey) || "generic";
  const items = categoryTable?.items || {};
  // direct match
  if (items[k]) return items[k];
  // try normalizations (e.g., "leafyGreens" -> "leafy-greens")
  const dashed = k.replace(/_/g, "-").replace(/\s+/g, "-");
  if (items[dashed]) return items[dashed];
  // fallback
  return items.generic || {};
}

/**
 * Compute procurement-based lead time.
 */
function computeProcurementDays({
  supplierType = "local",
  shippingSpeed = "pickup",
  season = null,
  demand = "normal",
  categoryGroup = "procurement",
  prepDays = 0,
  buffer = null,
}) {
  const s = asLower(supplierType) || "local";
  const sp = asLower(shippingSpeed) || "pickup";
  const dem = asLower(demand) || "normal";
  const sea = asLower(season);

  const transitDays = safe(() => PROCUREMENT_TRANSIT_DAYS[s][sp], null);
  const cycleDays = safe(() => PROCUREMENT_CYCLE_DAYS[s], null);

  const transit = Number.isFinite(transitDays) ? transitDays : 6;
  const cycle = Number.isFinite(cycleDays) ? cycleDays : 0;

  const base = clampInt(cycle + transit, 0, 3650);

  const demMult = DEMAND_MULTIPLIERS[dem] ?? 1.0;
  const seasonMult =
    sea && SEASON_MULTIPLIERS?.[categoryGroup]?.[sea]
      ? SEASON_MULTIPLIERS[categoryGroup][sea]
      : sea && SEASON_MULTIPLIERS?.procurement?.[sea]
      ? SEASON_MULTIPLIERS.procurement[sea]
      : 1.0;

  const modified = clampInt(Math.round(base * demMult * seasonMult), 0, 3650);
  const withPrep = clampInt(modified + clampInt(prepDays, 0, 3650), 0, 3650);

  return conservativeBuffer(withPrep, buffer);
}

/**
 * Compute production-based lead time (garden/animals/etc.).
 */
function computeProductionDays({ baseDays, prepDays = 0, buffer = null }) {
  const base = clampInt(baseDays, 0, 3650);
  const withPrep = clampInt(base + clampInt(prepDays, 0, 3650), 0, 3650);
  return conservativeBuffer(withPrep, buffer);
}

/**
 * Main estimation function.
 *
 * @param {object} params
 * @param {string} params.category - Category key (e.g., "food:dry", "garden:production")
 * @param {string} params.itemKey - Item key inside category (e.g., "rice", "tomatoes")
 * @param {string} [params.supplierType] - PROCUREMENT only
 * @param {string} [params.shippingSpeed] - PROCUREMENT only
 * @param {string} [params.season] - Optional
 * @param {string} [params.demand] - Optional
 * @param {object} [params.buffer] - Override buffer policy { percent, fixedDays }
 * @param {number} [params.overrideBaseDays] - Hard override (useful for calibrated tables)
 * @returns {number} estimated lead time in days
 */
export function estimateLeadTimeDays(params = {}) {
  const {
    category = "generic:procurement",
    itemKey = "generic",
    supplierType = "local",
    shippingSpeed = "pickup",
    season = null,
    demand = "normal",
    buffer = null,
    overrideBaseDays = null,
  } = params || {};

  const cat = getCategoryTable(category);
  const item = getItemEntry(cat, itemKey);

  const defaultItem = cat?.defaultItem || {};
  const effectivePrepDays = Number.isFinite(item?.prepDays)
    ? item.prepDays
    : Number.isFinite(defaultItem?.prepDays)
    ? defaultItem.prepDays
    : 0;

  const effectiveBuffer = buffer ||
    item?.buffer ||
    defaultItem?.buffer || { percent: 0.15, fixedDays: 0 };

  // If a caller supplies overrideBaseDays, treat as production duration directly.
  if (Number.isFinite(overrideBaseDays)) {
    return computeProductionDays({
      baseDays: overrideBaseDays,
      prepDays: effectivePrepDays,
      buffer: effectiveBuffer,
    });
  }

  // Production categories use baseDays from item or fallback
  if (cat?.group === "production") {
    const baseDays = Number.isFinite(item?.baseDays)
      ? item.baseDays
      : safe(() => cat.items?.generic?.baseDays, 30);

    return computeProductionDays({
      baseDays,
      prepDays: effectivePrepDays,
      buffer: effectiveBuffer,
    });
  }

  // Procurement categories: determine group for season multipliers
  const group = asLower(cat?.group || "procurement");
  const categoryGroup =
    group === "procurement:garden_inputs"
      ? "garden_inputs"
      : group === "procurement:construction"
      ? "construction"
      : "procurement";

  return computeProcurementDays({
    supplierType,
    shippingSpeed,
    season,
    demand,
    categoryGroup,
    prepDays: effectivePrepDays,
    buffer: effectiveBuffer,
  });
}

/**
 * Convenience helper for callers that want an object with explanation.
 * Useful for UI tooltips or logs.
 */
export function explainLeadTime(params = {}) {
  const {
    category = "generic:procurement",
    itemKey = "generic",
    supplierType = "local",
    shippingSpeed = "pickup",
    season = null,
    demand = "normal",
    buffer = null,
    overrideBaseDays = null,
  } = params || {};

  const cat = getCategoryTable(category);
  const item = getItemEntry(cat, itemKey);
  const defaultItem = cat?.defaultItem || {};

  const effectivePrepDays = Number.isFinite(item?.prepDays)
    ? item.prepDays
    : Number.isFinite(defaultItem?.prepDays)
    ? defaultItem.prepDays
    : 0;

  const effectiveBuffer = buffer ||
    item?.buffer ||
    defaultItem?.buffer || { percent: 0.15, fixedDays: 0 };

  const est = estimateLeadTimeDays(params);

  const notes = []
    .concat(cat?.label ? [`Category: ${cat.label}`] : [])
    .concat(item?.notes ? [`Item note: ${item.notes}`] : [])
    .concat(
      overrideBaseDays != null
        ? [`Override base days: ${overrideBaseDays}`]
        : []
    )
    .concat(
      cat?.group === "production" ? ["Mode: production"] : ["Mode: procurement"]
    )
    .concat(
      cat?.group !== "production"
        ? [
            `Supplier: ${supplierType || "local"} / Shipping: ${
              shippingSpeed || "pickup"
            }`,
          ]
        : []
    )
    .concat(season ? [`Season: ${season}`] : [])
    .concat(demand ? [`Demand: ${demand}`] : [])
    .concat(effectivePrepDays ? [`Prep days: ${effectivePrepDays}`] : [])
    .concat(
      effectiveBuffer
        ? [
            `Buffer: ${(effectiveBuffer.percent ?? 0) * 100}% + ${
              effectiveBuffer.fixedDays ?? 0
            }d`,
          ]
        : []
    );

  return {
    estimateDays: est,
    categoryKey: category,
    itemKey,
    group: cat?.group || "procurement",
    supplierType,
    shippingSpeed,
    season,
    demand,
    prepDays: effectivePrepDays,
    buffer: effectiveBuffer,
    notes,
  };
}

/* -------------------------------------------------------------------------- */
/* Optional: Quick lookup helpers                                              */
/* -------------------------------------------------------------------------- */

/**
 * Return a flat list of category keys for UI dropdowns.
 */
export function listLeadTimeCategories() {
  return Object.keys(LEAD_TIME_CATEGORIES);
}

/**
 * Return a flat list of item keys for a category.
 */
export function listLeadTimeItems(category) {
  const cat = getCategoryTable(category);
  return Object.keys(cat?.items || {});
}

/* -------------------------------------------------------------------------- */
/* Default export                                                             */
/* -------------------------------------------------------------------------- */

const LeadTimeTables = Object.freeze({
  version: LEAD_TIME_TABLES_VERSION,
  lastUpdatedISO: LEAD_TIME_TABLES_LAST_UPDATED_ISO,

  enums: Object.freeze({
    supplierTypes: SUPPLIER_TYPES,
    shippingSpeeds: SHIPPING_SPEEDS,
    seasons: SEASONS,
    demandPressure: DEMAND_PRESSURE,
  }),

  procurement: Object.freeze({
    transitDays: PROCUREMENT_TRANSIT_DAYS,
    cycleDays: PROCUREMENT_CYCLE_DAYS,
    demandMultipliers: DEMAND_MULTIPLIERS,
    seasonMultipliers: SEASON_MULTIPLIERS,
  }),

  categories: LEAD_TIME_CATEGORIES,

  api: Object.freeze({
    getCategoryTable,
    getItemEntry,
    estimateLeadTimeDays,
    explainLeadTime,
    listLeadTimeCategories,
    listLeadTimeItems,
  }),
});

export default LeadTimeTables;
