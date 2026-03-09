// File: src/utils/gardenUtils.js
/**
 * gardenUtils.js (SSA)
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Browser-safe utility toolbox for SSA Garden domain.
 *  - Pure functions: no DB, no stores, no network.
 *  - Designed to support:
 *      • planting/harvest planning
 *      • garden task generation
 *      • yield estimation + preservation planning
 *      • pantry/storehouse integration hooks
 *      • seasonality + frost date reasoning (best-effort, deterministic)
 *
 * IMPORTANT
 *  - SSA avoids heavy AI usage for planning: this module provides deterministic,
 *    rule-based building blocks.
 *
 * Inputs are tolerant:
 *  - Accepts strings or objects for crops, dates, etc.
 *  - Handles missing optional data gracefully.
 */

import { isPlainObject, isArr, isStr, isNum, deepMerge } from "@/utils/obj";
import {
  parseISODate,
  toISODate,
  addDays,
  diffDays,
  clampDate,
  startOfDayLocal,
  endOfDayLocal,
} from "@/utils/dates";

const SOURCE = "utils.gardenUtils";

/* -------------------------------------------------------------------------- */
/* Compatibility: Queue helpers (used by cooking planners)                      */
/* -------------------------------------------------------------------------- */

/**
 * addToGardenQueue
 * - Backward-compatible export expected by some cooking components.
 * - Tries to enqueue "garden sourcing" needs into a GardenStore if present.
 * - Never throws; returns a small result contract for UI to react to.
 *
 * @param {Object} item  e.g. { name, amount|quantity, unit, reason, recipeId, recipeName }
 * @param {Object} opts  e.g. { householdId, source, meta }
 * @returns {{ ok: boolean, queued?: any, reason?: string }}
 */
export function addToGardenQueue(item, opts = {}) {
  try {
    const w = typeof window !== "undefined" ? window : undefined;
    const store =
      w?.SSA?.stores?.GardenStore ||
      w?.SSA?.GardenStore ||
      w?.GardenStore ||
      null;

    const payload = {
      id: `gq_${Date.now().toString(36)}_${Math.random()
        .toString(36)
        .slice(2, 8)}`,
      atISO: new Date().toISOString(),
      type: "garden.queue.add",
      item: {
        name: item?.name,
        unit: item?.unit || item?.uom || "",
        quantity: Number(item?.quantity ?? item?.amount ?? item?.qty) || 0,
      },
      reason: item?.reason || "inventory_aware_planner",
      recipeId: item?.recipeId,
      recipeName: item?.recipeName,
      householdId: opts?.householdId,
      source: opts?.source || SOURCE,
      meta: { ...(opts?.meta || {}) },
    };

    // Store API variants:
    // 1) store.addToQueue(payload)
    // 2) store.enqueue(payload)
    // 3) store.queue.push(payload) (array)
    if (store && typeof store.addToQueue === "function") {
      const r = store.addToQueue(payload);
      return { ok: true, queued: r ?? payload };
    }
    if (store && typeof store.enqueue === "function") {
      const r = store.enqueue(payload);
      return { ok: true, queued: r ?? payload };
    }
    if (store && Array.isArray(store.queue)) {
      store.queue.push(payload);
      return { ok: true, queued: payload };
    }

    // No store wired — succeed softly so UI can still proceed.
    return { ok: true, queued: payload, reason: "no_store_bound" };
  } catch {
    return { ok: false, reason: "enqueue_failed" };
  }
}

/* -------------------------------- Constants -------------------------------- */

export const GARDEN_UNITS = Object.freeze({
  AREA: Object.freeze({
    SQFT: "sqft",
    SQM: "sqm",
    ACRE: "acre",
    HECTARE: "hectare",
  }),
  WEIGHT: Object.freeze({
    LB: "lb",
    OZ: "oz",
    KG: "kg",
    G: "g",
  }),
  VOLUME: Object.freeze({
    GAL: "gal",
    QT: "qt",
    L: "l",
    ML: "ml",
  }),
});

export const SEASONS = Object.freeze(["winter", "spring", "summer", "fall"]);

export const TASK_TYPES = Object.freeze({
  PLAN: "plan",
  PREP: "prep",
  SOW: "sow",
  TRANSPLANT: "transplant",
  THIN: "thin",
  WATER: "water",
  FEED: "feed",
  WEED: "weed",
  PEST: "pest",
  PRUNE: "prune",
  TRAIN: "train",
  MULCH: "mulch",
  HARVEST: "harvest",
  PRESERVE: "preserve",
  CLEANUP: "cleanup",
  NOTE: "note",
});

/**
 * Minimal crop profile shape (you can extend in catalogs)
 * {
 *   id, name,
 *   cropType: "leaf"|"root"|"fruit"|"legume"|"grain"|"herb"|"flower"|...
 *   sowMethod: "direct"|"transplant"|"either"
 *   daysToMaturity: { min, max, avg }
 *   sowWindow: { startOffsetDays, endOffsetDays } // relative to frost or season anchors
 *   spacing: { rowIn, plantIn }
 *   succession: { intervalDays, rounds }
 *   yield: { perPlantLb, perSqftLb, notes }
 *   preservation: { can, freeze, dehydrate, ferment, cellar }
 * }
 */

export const DEFAULT_CROP_TYPE_TAGS = Object.freeze({
  leaf: ["greens", "leafy"],
  root: ["roots"],
  fruit: ["fruiting"],
  legume: ["beans"],
  grain: ["grains"],
  herb: ["herbs"],
  flower: ["flowers"],
});

/* ----------------------------- Basic Type Helpers ---------------------------- */

export function clamp01(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

export function safeNum(n, fallback = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

export function normStr(s) {
  return String(s || "").trim();
}

export function normKey(s) {
  return normStr(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function uniq(arr) {
  return Array.from(new Set(arr));
}

export function asArray(x) {
  if (!x) return [];
  return Array.isArray(x) ? x : [x];
}

/* ----------------------------- Season Computation ---------------------------- */
/**
 * Deterministic "meteorological season" from date and hemisphere.
 * - Use for UI grouping and biasing (not precise agronomy).
 */
export function seasonFromDate(
  dateISO,
  { hemisphere = "north", latitude = null } = {}
) {
  const d = parseISODate(dateISO) || new Date();
  const month = d.getMonth() + 1; // local
  const hemi = resolveHemisphere(hemisphere, latitude);

  const north =
    month === 12 || month === 1 || month === 2
      ? "winter"
      : month >= 3 && month <= 5
      ? "spring"
      : month >= 6 && month <= 8
      ? "summer"
      : "fall";

  return hemi === "south" ? invertSeason(north) : north;
}

function resolveHemisphere(hemisphere, latitude) {
  const h = normStr(hemisphere).toLowerCase();
  if (h === "south" || h === "southern") return "south";
  if (h === "north" || h === "northern") return "north";
  const lat = Number(latitude);
  if (Number.isFinite(lat)) return lat < 0 ? "south" : "north";
  return "north";
}

function invertSeason(season) {
  switch (season) {
    case "winter":
      return "summer";
    case "summer":
      return "winter";
    case "spring":
      return "fall";
    case "fall":
      return "spring";
    default:
      return "winter";
  }
}

/* -------------------------- Frost Date Reasoning (Best-effort) -------------------------- */
/**
 * SSA can accept externally-provided frost dates (from user, weather store, etc.).
 * This module only provides deterministic helpers for:
 *  - validating
 *  - shifting
 *  - building planting windows
 *
 * frostDates:
 * {
 *   lastSpringFrostISO?: "YYYY-MM-DD",
 *   firstFallFrostISO?: "YYYY-MM-DD"
 * }
 */

export function normalizeFrostDates(frostDates = {}) {
  const fd = isPlainObject(frostDates) ? frostDates : {};
  const lastSpring = toISODate(
    fd.lastSpringFrostISO || fd.lastSpringFrost || null
  );
  const firstFall = toISODate(
    fd.firstFallFrostISO || fd.firstFallFrost || null
  );

  // allow nulls (unknown)
  return {
    lastSpringFrostISO: lastSpring || null,
    firstFallFrostISO: firstFall || null,
  };
}

/**
 * Build a typical planting window for a crop relative to last spring frost.
 * offsets:
 *  - startOffsetDays: negative means before frost date, positive after
 *  - endOffsetDays
 */
export function plantingWindowFromFrost(
  frostDates,
  { startOffsetDays = -14, endOffsetDays = 14 } = {}
) {
  const fd = normalizeFrostDates(frostDates);
  if (!fd.lastSpringFrostISO) return null;

  const start = addDays(fd.lastSpringFrostISO, safeNum(startOffsetDays, -14));
  const end = addDays(fd.lastSpringFrostISO, safeNum(endOffsetDays, 14));
  return { startISO: toISODate(start), endISO: toISODate(end) };
}

/**
 * Build a fall planting window relative to first fall frost (for cool-season crops).
 */
export function fallPlantingWindowFromFrost(
  frostDates,
  { startOffsetDays = -70, endOffsetDays = -35 } = {}
) {
  const fd = normalizeFrostDates(frostDates);
  if (!fd.firstFallFrostISO) return null;

  const start = addDays(fd.firstFallFrostISO, safeNum(startOffsetDays, -70));
  const end = addDays(fd.firstFallFrostISO, safeNum(endOffsetDays, -35));
  return { startISO: toISODate(start), endISO: toISODate(end) };
}

/* ----------------------------- Crop Normalization ---------------------------- */

export function normalizeCrop(crop) {
  if (!crop) return null;

  // string -> basic crop
  if (isStr(crop)) {
    const name = normStr(crop);
    if (!name) return null;
    return {
      id: normKey(name),
      name,
      cropType: "unknown",
      sowMethod: "either",
      tags: [],
    };
  }

  if (!isPlainObject(crop)) return null;

  const name = normStr(crop.name || crop.title || crop.label || "");
  const id = normKey(crop.id || crop.key || name || `crop_${Date.now()}`);

  const cropType = normKey(crop.cropType || crop.type || "unknown");
  const sowMethod = normKey(crop.sowMethod || crop.method || "either");

  const tags = uniq([
    ...normalizeTags(crop.tags),
    ...(DEFAULT_CROP_TYPE_TAGS[cropType] || []),
  ]);

  const daysToMaturity = normalizeDaysToMaturity(crop.daysToMaturity);
  const spacing = normalizeSpacing(crop.spacing);
  const succession = normalizeSuccession(crop.succession);
  const yieldInfo = normalizeYield(crop.yield);
  const preservation = normalizePreservation(crop.preservation);

  return {
    ...crop,
    id,
    name: name || id,
    cropType: cropType || "unknown",
    sowMethod: sowMethod || "either",
    tags,
    daysToMaturity,
    spacing,
    succession,
    yield: yieldInfo,
    preservation,
  };
}

function normalizeTags(tags) {
  const arr = isArr(tags) ? tags : isStr(tags) ? [tags] : [];
  return uniq(arr.map((t) => normKey(t)).filter(Boolean));
}

function normalizeDaysToMaturity(dtm) {
  const x = isPlainObject(dtm) ? dtm : isNum(dtm) ? { avg: dtm } : {};
  const min = safeNum(x.min, null);
  const max = safeNum(x.max, null);
  const avg = safeNum(x.avg, null);

  // infer avg if missing
  let a = avg;
  if (!Number.isFinite(a)) {
    if (Number.isFinite(min) && Number.isFinite(max))
      a = Math.round((min + max) / 2);
    else if (Number.isFinite(min)) a = min;
    else if (Number.isFinite(max)) a = max;
    else a = null;
  }

  return {
    min: Number.isFinite(min) ? min : null,
    max: Number.isFinite(max) ? max : null,
    avg: Number.isFinite(a) ? a : null,
  };
}

function normalizeSpacing(spacing) {
  const x = isPlainObject(spacing) ? spacing : {};
  return {
    rowIn: Number.isFinite(Number(x.rowIn)) ? Number(x.rowIn) : null,
    plantIn: Number.isFinite(Number(x.plantIn)) ? Number(x.plantIn) : null,
    notes: normStr(x.notes || ""),
  };
}

function normalizeSuccession(succession) {
  const x = isPlainObject(succession) ? succession : {};
  const rounds = safeNum(x.rounds, 1);
  const intervalDays = safeNum(x.intervalDays, null);
  return {
    rounds: Math.max(1, Math.floor(rounds || 1)),
    intervalDays: Number.isFinite(intervalDays)
      ? Math.max(1, Math.floor(intervalDays))
      : null,
    enabled: x.enabled !== false,
  };
}

function normalizeYield(yieldInfo) {
  const x = isPlainObject(yieldInfo) ? yieldInfo : {};
  return {
    perPlantLb: Number.isFinite(Number(x.perPlantLb))
      ? Number(x.perPlantLb)
      : null,
    perSqftLb: Number.isFinite(Number(x.perSqftLb))
      ? Number(x.perSqftLb)
      : null,
    notes: normStr(x.notes || ""),
  };
}

function normalizePreservation(p) {
  const x = isPlainObject(p) ? p : {};
  const asBool = (v) => v === true;
  return {
    can: asBool(x.can),
    freeze: asBool(x.freeze),
    dehydrate: asBool(x.dehydrate),
    ferment: asBool(x.ferment),
    cellar: asBool(x.cellar),
    notes: normStr(x.notes || ""),
  };
}

/* ----------------------------- Spacing & Area Math --------------------------- */

export function sqftToSqm(sqft) {
  return safeNum(sqft, 0) * 0.092903;
}

export function sqmToSqft(sqm) {
  return safeNum(sqm, 0) / 0.092903;
}

export function acresToSqft(acres) {
  return safeNum(acres, 0) * 43560;
}

export function sqftToAcres(sqft) {
  return safeNum(sqft, 0) / 43560;
}

/**
 * Estimate number of plants for an area given spacing in inches.
 * - plant spacing is assumed on a grid of rowIn x plantIn
 * - returns integer count
 */
export function estimatePlantsForArea(areaSqft, spacingIn = {}) {
  const sqft = safeNum(areaSqft, 0);
  if (sqft <= 0) return 0;

  const rowIn = safeNum(spacingIn.rowIn, null);
  const plantIn = safeNum(spacingIn.plantIn, null);
  if (
    !Number.isFinite(rowIn) ||
    !Number.isFinite(plantIn) ||
    rowIn <= 0 ||
    plantIn <= 0
  )
    return 0;

  // inches to feet
  const rowFt = rowIn / 12;
  const plantFt = plantIn / 12;
  const sqftPerPlant = rowFt * plantFt;
  if (sqftPerPlant <= 0) return 0;

  return Math.max(0, Math.floor(sqft / sqftPerPlant));
}

/**
 * Estimate yield (lbs) based on crop yield profile and planting.
 */
export function estimateYieldLb(crop, { plants = null, areaSqft = null } = {}) {
  const c = normalizeCrop(crop);
  if (!c) return { lb: 0, method: "none", notes: "No crop data" };

  const y = c.yield || {};
  const perPlant = Number.isFinite(Number(y.perPlantLb))
    ? Number(y.perPlantLb)
    : null;
  const perSqft = Number.isFinite(Number(y.perSqftLb))
    ? Number(y.perSqftLb)
    : null;

  const p = Number.isFinite(Number(plants))
    ? Math.max(0, Number(plants))
    : null;
  const a = Number.isFinite(Number(areaSqft))
    ? Math.max(0, Number(areaSqft))
    : null;

  if (perPlant != null && p != null) {
    return { lb: perPlant * p, method: "perPlantLb", notes: y.notes || "" };
  }
  if (perSqft != null && a != null) {
    return { lb: perSqft * a, method: "perSqftLb", notes: y.notes || "" };
  }

  // fallback: infer plants from spacing + area if possible
  if (perPlant != null && a != null && c.spacing?.rowIn && c.spacing?.plantIn) {
    const estPlants = estimatePlantsForArea(a, c.spacing);
    return {
      lb: perPlant * estPlants,
      method: "perPlantLb+spacing",
      notes: y.notes || "",
    };
  }

  return { lb: 0, method: "unknown", notes: y.notes || "" };
}

/* ----------------------------- Planting Schedule ----------------------------- */

/**
 * Compute a crop's sow window (best-effort) using either:
 *  - crop.sowWindow (explicit offsets), or
 *  - generic heuristics based on cropType tags, or
 *  - provided explicit window in opts
 *
 * Returns:
 *  { startISO, endISO, anchor, notes }
 */
export function computeSowWindow(crop, opts = {}) {
  const c = normalizeCrop(crop);
  const fd = normalizeFrostDates(opts.frostDates || {});
  const season = opts.season || seasonFromDate(opts.dateISO || null, opts);

  // If caller provides explicit window, respect it
  if (opts.window && isPlainObject(opts.window)) {
    const startISO = toISODate(
      opts.window.startISO || opts.window.start || null
    );
    const endISO = toISODate(opts.window.endISO || opts.window.end || null);
    if (startISO && endISO) {
      return {
        startISO,
        endISO,
        anchor: "explicit",
        notes: "Caller-provided sow window",
      };
    }
  }

  // Crop-defined offsets
  const sowWindow = isPlainObject(c?.sowWindow) ? c.sowWindow : null;
  if (sowWindow && fd.lastSpringFrostISO) {
    const w = plantingWindowFromFrost(fd, {
      startOffsetDays: safeNum(sowWindow.startOffsetDays, -14),
      endOffsetDays: safeNum(sowWindow.endOffsetDays, 14),
    });
    if (w)
      return {
        ...w,
        anchor: "lastSpringFrost",
        notes: "Crop sowWindow offsets",
      };
  }

  // Heuristic by cropType/tags
  const tags = normalizeTags(c?.tags);
  const coolSeason =
    tags.includes("greens") || tags.includes("roots") || tags.includes("leafy");
  const heatLoving =
    tags.includes("fruiting") ||
    tags.includes("tomato") ||
    tags.includes("pepper");

  // If we have frost dates, use them
  if (fd.lastSpringFrostISO) {
    if (coolSeason) {
      // cool season can start earlier (before last frost)
      const w = plantingWindowFromFrost(fd, {
        startOffsetDays: -42,
        endOffsetDays: 14,
      });
      return {
        ...w,
        anchor: "lastSpringFrost",
        notes: "Heuristic cool-season window",
      };
    }
    if (heatLoving) {
      // heat loving after frost
      const w = plantingWindowFromFrost(fd, {
        startOffsetDays: 7,
        endOffsetDays: 42,
      });
      return {
        ...w,
        anchor: "lastSpringFrost",
        notes: "Heuristic warm-season window",
      };
    }
    // default
    const w = plantingWindowFromFrost(fd, {
      startOffsetDays: -14,
      endOffsetDays: 28,
    });
    return {
      ...w,
      anchor: "lastSpringFrost",
      notes: "Heuristic default window",
    };
  }

  // Without frost dates, use season anchors (very approximate)
  const year = (parseISODate(opts.dateISO) || new Date()).getFullYear();
  const approx = approximateSeasonWindow(year, season);
  return {
    ...approx,
    anchor: "season",
    notes: "Approx season window (no frost data)",
  };
}

function approximateSeasonWindow(year, season) {
  // Northern-ish approximate windows (can be overridden by caller)
  // We pick wide windows to reduce wrong exclusions.
  const y = Number.isFinite(Number(year))
    ? Number(year)
    : new Date().getFullYear();

  const mk = (m, d) => toISODate(new Date(y, m - 1, d));

  switch (season) {
    case "winter":
      return { startISO: mk(1, 1), endISO: mk(2, 28) };
    case "spring":
      return { startISO: mk(3, 1), endISO: mk(5, 31) };
    case "summer":
      return { startISO: mk(6, 1), endISO: mk(8, 31) };
    case "fall":
    default:
      return { startISO: mk(9, 1), endISO: mk(11, 30) };
  }
}

/**
 * Compute expected harvest window using days to maturity and sow date.
 */
export function computeHarvestWindow(crop, sowDateISO, opts = {}) {
  const c = normalizeCrop(crop);
  const sowISO = toISODate(sowDateISO);
  if (!c || !sowISO) return null;

  const dtm = c.daysToMaturity || {};
  const min = Number.isFinite(Number(dtm.min)) ? Number(dtm.min) : null;
  const max = Number.isFinite(Number(dtm.max)) ? Number(dtm.max) : null;
  const avg = Number.isFinite(Number(dtm.avg)) ? Number(dtm.avg) : null;

  // if only avg, use +/- 10%
  const a =
    avg != null
      ? avg
      : min != null && max != null
      ? Math.round((min + max) / 2)
      : null;
  if (a == null) return null;

  const minDays = min != null ? min : Math.max(1, Math.round(a * 0.9));
  const maxDays = max != null ? max : Math.max(minDays, Math.round(a * 1.1));

  const start = addDays(sowISO, minDays);
  const end = addDays(sowISO, maxDays);

  return {
    startISO: toISODate(start),
    endISO: toISODate(end),
    minDays,
    maxDays,
  };
}

/**
 * Generate succession sow dates from an initial sow date.
 */
export function generateSuccessionSowDates(crop, firstSowISO, opts = {}) {
  const c = normalizeCrop(crop);
  const first = toISODate(firstSowISO);
  if (!c || !first) return [];

  const succ = c.succession || {};
  if (succ.enabled === false) return [first];

  const rounds = Math.max(
    1,
    Math.floor(safeNum(opts.rounds ?? succ.rounds, succ.rounds || 1))
  );
  const interval = safeNum(
    opts.intervalDays ?? succ.intervalDays,
    succ.intervalDays
  );

  if (!Number.isFinite(interval) || interval <= 0 || rounds <= 1)
    return [first];

  const dates = [first];
  for (let i = 1; i < rounds; i++) {
    dates.push(toISODate(addDays(first, i * interval)));
  }
  return dates;
}

/* ----------------------------- Task Generation ------------------------------- */

/**
 * Generate a simple garden task plan for a crop + sow date.
 * Returns an array of SSA task objects (shape is compatible with TaskStore patterns):
 * {
 *   id, type, title, dueISO, domain:"garden",
 *   meta: { cropId, cropName, ... },
 *   tags: ["garden", "sow", ...],
 *   priority: 0..1,
 *   status: "open"|"done"|"skipped"
 * }
 */
export function generateGardenTasksForCrop(crop, sowDateISO, opts = {}) {
  const c = normalizeCrop(crop);
  const sowISO = toISODate(sowDateISO);
  if (!c || !sowISO) return [];

  const tasks = [];
  const baseId = `${c.id}_${sowISO}`;

  const addTask = (type, title, dueISO, extra = {}) => {
    const id =
      normKey(`${baseId}_${type}_${dueISO || "nodate"}`) || `${baseId}_${type}`;
    tasks.push({
      id,
      domain: "garden",
      type,
      title,
      dueISO: dueISO ? toISODate(dueISO) : null,
      status: "open",
      priority: safeNum(extra.priority, 0.5),
      tags: uniq(
        ["garden", type, c.cropType, ...(extra.tags || [])]
          .map(normKey)
          .filter(Boolean)
      ),
      meta: {
        cropId: c.id,
        cropName: c.name,
        sowMethod: c.sowMethod,
        ...extra.meta,
      },
    });
  };

  // Prep tasks
  addTask(TASK_TYPES.PREP, `Prepare bed for ${c.name}`, addDays(sowISO, -3), {
    priority: 0.6,
  });

  // Sow/transplant
  const sowType =
    c.sowMethod === "direct"
      ? TASK_TYPES.SOW
      : c.sowMethod === "transplant"
      ? TASK_TYPES.TRANSPLANT
      : TASK_TYPES.SOW;

  addTask(
    sowType,
    `${sowType === TASK_TYPES.TRANSPLANT ? "Transplant" : "Sow"} ${c.name}`,
    sowISO,
    { priority: 0.8 }
  );

  // Thin (if spacing indicates thinning likely)
  if (c.cropType === "leaf" || c.cropType === "root") {
    addTask(TASK_TYPES.THIN, `Thin ${c.name} seedlings`, addDays(sowISO, 14), {
      priority: 0.55,
    });
  }

  // Weeding schedule (weekly x 4)
  for (let i = 1; i <= 4; i++) {
    addTask(TASK_TYPES.WEED, `Weed around ${c.name}`, addDays(sowISO, i * 7), {
      priority: 0.45,
    });
  }

  // Watering reminders (optional; default off unless opts.enableWateringReminders)
  if (opts.enableWateringReminders) {
    const days = Math.max(7, safeNum(opts.wateringDays, 14));
    for (let i = 1; i <= days; i++) {
      addTask(
        TASK_TYPES.WATER,
        `Check moisture / water ${c.name}`,
        addDays(sowISO, i),
        {
          priority: 0.35,
        }
      );
    }
  }

  // Harvest window
  const harvest = computeHarvestWindow(c, sowISO, opts);
  if (harvest) {
    addTask(
      TASK_TYPES.HARVEST,
      `Begin harvesting ${c.name}`,
      harvest.startISO,
      {
        priority: 0.75,
        meta: { harvestWindow: harvest },
      }
    );

    // preservation follow-up (if crop indicates preservation)
    if (shouldSuggestPreservation(c, opts)) {
      addTask(
        TASK_TYPES.PRESERVE,
        `Preserve ${c.name} harvest`,
        harvest.startISO,
        {
          priority: 0.65,
          tags: ["preservation"],
          meta: { preservation: c.preservation },
        }
      );
    }
  }

  // Cleanup
  addTask(
    TASK_TYPES.CLEANUP,
    `Clear/refresh bed after ${c.name}`,
    harvest?.endISO || addDays(sowISO, 90),
    {
      priority: 0.35,
    }
  );

  // Optional: caller can post-process or inject extra tasks
  if (typeof opts.taskTransform === "function") {
    try {
      return opts.taskTransform(tasks, { crop: c, sowISO }) || tasks;
    } catch {
      return tasks;
    }
  }

  return tasks;
}

function shouldSuggestPreservation(crop, opts) {
  const c = normalizeCrop(crop);
  if (!c) return false;
  if (opts.disablePreservationSuggestions) return false;
  const p = c.preservation || {};
  return !!(p.can || p.freeze || p.dehydrate || p.ferment || p.cellar);
}

/* ----------------------------- Preservation Planning -------------------------- */

/**
 * Translate an estimated yield into preservation batch suggestions (rule-based).
 * This is intentionally simple and can be extended to your Tier2 preservation suite.
 *
 * Returns:
 * {
 *   yieldLb,
 *   suggested: [
 *     { method:"freeze"|"can"|"dehydrate"|"ferment"|"cellar", portionLb, note }
 *   ],
 *   notes:[]
 * }
 */
export function suggestPreservationPlan(crop, yieldLb, opts = {}) {
  const c = normalizeCrop(crop);
  const lb = Math.max(0, safeNum(yieldLb, 0));
  const notes = [];
  if (!c || lb <= 0) {
    return { yieldLb: lb, suggested: [], notes: ["No yield to preserve."] };
  }

  const p = c.preservation || {};
  const enabled = [
    p.freeze ? "freeze" : null,
    p.can ? "can" : null,
    p.dehydrate ? "dehydrate" : null,
    p.ferment ? "ferment" : null,
    p.cellar ? "cellar" : null,
  ].filter(Boolean);

  if (!enabled.length)
    return {
      yieldLb: lb,
      suggested: [],
      notes: ["Crop has no preservation methods set."],
    };

  // Simple default split strategy:
  // - prioritize "cellar" for roots, "ferment" for greens/cabbage, "freeze" for most,
  // - keep canning for high volume or sauces.
  const cropType = c.cropType || "unknown";
  const methods = rankPreservationMethods(enabled, cropType, c.tags);

  const split = splitByWeights(
    methods.map((m) => m.weight),
    lb
  );
  const suggested = methods.map((m, i) => ({
    method: m.method,
    portionLb: split[i],
    note: m.note,
  }));

  notes.push(`Methods: ${methods.map((m) => m.method).join(", ")}`);
  return { yieldLb: lb, suggested, notes };
}

function rankPreservationMethods(enabledMethods, cropType, tags = []) {
  const t = normalizeTags(tags);

  const base = enabledMethods.map((m) => ({ method: m, weight: 1, note: "" }));

  const bump = (method, delta, note) => {
    const x = base.find((b) => b.method === method);
    if (!x) return;
    x.weight = Math.max(0.1, x.weight + delta);
    if (note) x.note = x.note ? `${x.note}; ${note}` : note;
  };

  // Roots: cellar + can
  if (cropType === "root") {
    bump("cellar", 1.2, "Roots store well in cool/dry.");
    bump("freeze", 0.3, "Blanch/freeze for convenience.");
    bump("can", 0.4, "Pressure can where appropriate.");
    bump("ferment", 0.2, "Pickles/ferments are an option.");
  }

  // Leaf/greens: freeze + ferment
  if (cropType === "leaf") {
    bump("freeze", 0.8, "Blanch/freeze greens.");
    bump("ferment", 0.6, "Ferment/pickle for probiotic storage.");
    bump("dehydrate", 0.3, "Dry herbs/greens if applicable.");
  }

  // Fruit/canning-friendly
  if (cropType === "fruit" || t.includes("fruiting")) {
    bump("can", 0.8, "Sauces/jams are common.");
    bump("freeze", 0.6, "Freeze pieces/purees.");
    bump("dehydrate", 0.4, "Dry slices for snacks.");
  }

  // Herbs: dehydrate
  if (cropType === "herb" || t.includes("herbs")) {
    bump("dehydrate", 1.2, "Dry herbs for long storage.");
    bump("freeze", 0.3, "Freeze cubes in oil/water.");
  }

  // Keep only enabled
  const filtered = base.filter((x) => enabledMethods.includes(x.method));
  filtered.sort((a, b) => b.weight - a.weight);
  return filtered;
}

function splitByWeights(weights, total) {
  const w = weights.map((x) => Math.max(0, safeNum(x, 0)));
  const sum = w.reduce((a, b) => a + b, 0);
  if (sum <= 0) {
    const per = total / w.length;
    return w.map(() => per);
  }
  return w.map((x) => (x / sum) * total);
}

/* ----------------------------- Harvest Logging Helpers ------------------------ */

/**
 * Normalize a harvest entry for storing in Dexie or exporting.
 * harvest:
 *  { cropId, cropName, dateISO, weight, unit, notes, bedId, locationId }
 */
export function normalizeHarvestEntry(harvest) {
  if (!isPlainObject(harvest)) return null;

  const cropId = normKey(harvest.cropId || harvest.crop || harvest.id || "");
  const cropName = normStr(harvest.cropName || harvest.name || "");
  const dateISO =
    toISODate(harvest.dateISO || harvest.date || null) || toISODate(new Date());

  const unit =
    normKey(harvest.unit || GARDEN_UNITS.WEIGHT.LB) || GARDEN_UNITS.WEIGHT.LB;
  const weight = safeNum(harvest.weight ?? harvest.amount ?? 0, 0);

  return {
    id: harvest.id
      ? String(harvest.id)
      : `harvest_${cropId || "unknown"}_${dateISO}_${Date.now()}`,
    cropId: cropId || null,
    cropName: cropName || null,
    dateISO,
    weight,
    unit,
    bedId: harvest.bedId ? String(harvest.bedId) : null,
    locationId: harvest.locationId ? String(harvest.locationId) : null,
    notes: normStr(harvest.notes || ""),
    createdAt: harvest.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    meta: isPlainObject(harvest.meta) ? harvest.meta : {},
  };
}

/**
 * Convert weight units (garden-focused).
 */
export function convertWeight(value, fromUnit, toUnit) {
  const v = safeNum(value, 0);
  const from = normKey(fromUnit || "lb");
  const to = normKey(toUnit || "lb");
  if (from === to) return v;

  // Convert to grams
  let g = v;
  if (from === "lb") g = v * 453.59237;
  else if (from === "oz") g = v * 28.349523125;
  else if (from === "kg") g = v * 1000;
  else if (from === "g") g = v;

  // Convert from grams
  if (to === "lb") return g / 453.59237;
  if (to === "oz") return g / 28.349523125;
  if (to === "kg") return g / 1000;
  if (to === "g") return g;

  // Unknown unit: return original
  return v;
}

/* ----------------------------- Bed / Plot Helpers ---------------------------- */

/**
 * Normalize a garden bed/plot object.
 * bed:
 *  { id, name, areaSqft, widthFt, lengthFt, notes, tags }
 */
export function normalizeBed(bed) {
  if (!bed) return null;
  if (isStr(bed))
    return { id: normKey(bed), name: normStr(bed), areaSqft: null, tags: [] };
  if (!isPlainObject(bed)) return null;

  const id = normKey(bed.id || bed.key || bed.name || `bed_${Date.now()}`);
  const name = normStr(bed.name || id);
  const widthFt = Number.isFinite(Number(bed.widthFt))
    ? Number(bed.widthFt)
    : null;
  const lengthFt = Number.isFinite(Number(bed.lengthFt))
    ? Number(bed.lengthFt)
    : null;

  const areaSqft = Number.isFinite(Number(bed.areaSqft))
    ? Number(bed.areaSqft)
    : widthFt != null && lengthFt != null
    ? widthFt * lengthFt
    : null;

  return {
    ...bed,
    id,
    name,
    widthFt,
    lengthFt,
    areaSqft,
    notes: normStr(bed.notes || ""),
    tags: normalizeTags(bed.tags),
  };
}

/**
 * Given a list of beds, compute total garden area.
 */
export function totalGardenAreaSqft(beds) {
  const list = asArray(beds).map(normalizeBed).filter(Boolean);
  return list.reduce((sum, b) => sum + safeNum(b.areaSqft, 0), 0);
}

/* ----------------------------- Rotation / Planning --------------------------- */

/**
 * Simple crop rotation suggestion based on cropType tags (very high level).
 * - This is NOT a full agronomy model; it’s an SSA-friendly planner helper.
 *
 * previousCropType: "leaf"|"root"|"fruit"|"legume"|"grain"|...
 * Returns array of recommended next types (best-effort).
 */
export function suggestNextCropTypes(previousCropType) {
  const t = normKey(previousCropType || "unknown");
  switch (t) {
    case "legume":
      return ["leaf", "root", "fruit"];
    case "leaf":
      return ["root", "fruit", "legume"];
    case "root":
      return ["leaf", "legume", "fruit"];
    case "fruit":
      return ["legume", "leaf", "root"];
    case "grain":
      return ["legume", "leaf"];
    default:
      return ["legume", "leaf", "root", "fruit"];
  }
}

/* ----------------------------- Catalog Merge Helpers ------------------------- */

/**
 * Merge user overrides onto a crop catalog entry.
 * - Useful for "layer overrides" / household adjustments.
 */
export function applyCropOverrides(baseCrop, overrides) {
  const base = normalizeCrop(baseCrop);
  if (!base) return null;
  if (!isPlainObject(overrides)) return base;

  // deepMerge from obj.js is used here (assumes it exists in your project)
  const merged = deepMerge({ ...base }, overrides);

  // re-normalize critical nodes
  return normalizeCrop(merged);
}

/* ----------------------------- Date Convenience ------------------------------ */

/**
 * Recommend a set of date ranges for a season within a year.
 * Useful for UI filters, not strict agronomy.
 */
export function seasonDateRange(
  year,
  season,
  { hemisphere = "north", latitude = null } = {}
) {
  const y = Number.isFinite(Number(year))
    ? Number(year)
    : new Date().getFullYear();
  const s = normKey(season);
  const hemi = resolveHemisphere(hemisphere, latitude);

  // invert season in south
  const seasonKey = hemi === "south" ? invertSeason(s) : s;

  const mk = (m, d) => toISODate(new Date(y, m - 1, d));

  switch (seasonKey) {
    case "winter":
      return {
        startISO: mk(12, 1),
        endISO: mk(2, 28),
        note: "Meteorological winter (approx)",
      };
    case "spring":
      return {
        startISO: mk(3, 1),
        endISO: mk(5, 31),
        note: "Meteorological spring (approx)",
      };
    case "summer":
      return {
        startISO: mk(6, 1),
        endISO: mk(8, 31),
        note: "Meteorological summer (approx)",
      };
    case "fall":
    default:
      return {
        startISO: mk(9, 1),
        endISO: mk(11, 30),
        note: "Meteorological fall (approx)",
      };
  }
}

/* ----------------------------- Export Bundle -------------------------------- */

/**
 * Keep a small named export bundle for tree-shaking stability & debugging.
 */
export const __GARDEN_UTILS__ = Object.freeze({
  SOURCE,
  GARDEN_UNITS,
  TASK_TYPES,
  SEASONS,
});
