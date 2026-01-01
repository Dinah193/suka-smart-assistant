// C:\Users\larho\suka-smart-assistant\src\features\calculators\gardenAnimal\GardenYieldCalculator\GardenYieldCalculator.shim.js

/**
 * GardenYieldCalculator Shim
 *
 * How this fits:
 * - This is a lightweight, side-effect-aware shim that turns the
 *   GardenYieldCalculator schema payload into derived yield and harvest
 *   load metrics.
 * - It is safe to call from the Planning Graph runtime or directly from
 *   pages/forms. It does NOT do any UI work.
 * - It emits a single telemetry event on success so SessionRunner / Hub
 *   integrations can consume the outputs if desired.
 *
 * Contract:
 * - Input:  payload that matches GardenYieldCalculator.schema.json:
 *   {
 *     context: { nodeKey: "gardenYield", version: "1.0.0" },
 *     inputs: { crops: [...], plantingWindows: [...], harvestWindows: [...], ... },
 *     outputs?: any
 *   }
 * - Output: the same payload object, with `outputs` filled:
 *   {
 *     ...,
 *     outputs: {
 *       yieldEstimates: [...],
 *       harvestLoadByWeek: [...],
 *       preservationLoad: [...],
 *       storehouseCoverage: [...],
 *       summary: {...}
 *     }
 *   }
 *
 * env (2nd argument):
 * - eventBus?: { emit: (evt) => void }
 * - featureFlags?: { familyFundMode?: boolean }
 * - exportToHubIfEnabled?: (envelope) => Promise<void> | void
 */

/**
 * @typedef {Object} ShimEnv
 * @property {{ emit?: (evt: any) => void }=} eventBus
 * @property {{ familyFundMode?: boolean }=} featureFlags
 * @property {(envelope: any) => Promise<void> | void=} exportToHubIfEnabled
 */

/**
 * Entry point for the Garden Yield Calculator shim.
 *
 * @param {any} payload
 * @param {ShimEnv} [env]
 * @returns {Promise<any>}
 */
export async function runGardenYieldCalculatorShim(payload, env = {}) {
  const startedAt = performance.now ? performance.now() : Date.now();
  const safePayload = ensureBasePayload(payload);

  const inputs = safePayload.inputs || {};
  const crops = Array.isArray(inputs.crops) ? inputs.crops : [];
  const plantingWindows = Array.isArray(inputs.plantingWindows)
    ? inputs.plantingWindows
    : [];
  const harvestWindows = Array.isArray(inputs.harvestWindows)
    ? inputs.harvestWindows
    : [];
  const storehouseTargets = (inputs.storehouseTargets || {}).targetsByCrop || [];
  const assumptions = inputs.assumptions || {};

  // 1. Yield estimates per crop
  const yieldEstimates = computeYieldEstimates(crops, assumptions);

  // 2. Map yields onto harvest windows and bucket by week
  const harvestLoadByWeek = computeHarvestLoadByWeek(
    yieldEstimates,
    harvestWindows,
    assumptions
  );

  // 3. Preservation load groupings (batches)
  const preservationLoad = computePreservationLoad(
    yieldEstimates,
    harvestWindows,
    assumptions
  );

  // 4. Storehouse coverage vs targets
  const storehouseCoverage = computeStorehouseCoverage(
    yieldEstimates,
    storehouseTargets
  );

  // 5. Summary metrics
  const summary = computeSummary(
    yieldEstimates,
    harvestLoadByWeek,
    preservationLoad
  );

  /** @type {any} */
  const outputs = {
    yieldEstimates,
    harvestLoadByWeek,
    preservationLoad,
    storehouseCoverage,
    summary
  };

  const nextPayload = {
    ...safePayload,
    outputs
  };

  const finishedAt = performance.now ? performance.now() : Date.now();
  const runtimeMs = finishedAt - startedAt;

  emitShimEvent(nextPayload, runtimeMs, env);

  // Optional Hub export
  if (env.featureFlags && env.featureFlags.familyFundMode && env.exportToHubIfEnabled) {
    try {
      await env.exportToHubIfEnabled({
        kind: "gardenYield.calculated",
        ts: new Date().toISOString(),
        source: "calculators/garden/GardenYieldCalculator.shim",
        payload: {
          context: nextPayload.context,
          summary: outputs.summary,
          storehouseCoverage: outputs.storehouseCoverage
        }
      });
    } catch (err) {
      // Fail silently per spec
      console.warn(
        "[GardenYieldCalculator.shim] exportToHubIfEnabled failed:",
        err
      );
    }
  }

  return nextPayload;
}

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

/**
 * Ensure the payload has a minimal valid context + inputs object.
 *
 * @param {any} payload
 * @returns {any}
 */
function ensureBasePayload(payload) {
  const now = new Date();
  const base = payload && typeof payload === "object" ? payload : {};

  const context = {
    nodeKey: "gardenYield",
    version: "1.0.0",
    ...base.context
  };

  const inputs = {
    crops: [],
    plantingWindows: [],
    harvestWindows: [],
    storehouseTargets: {
      year: now.getFullYear(),
      targetsByCrop: []
    },
    assumptions: {
      lossFactor: 0.15,
      laborHoursPerUnit: 0.25,
      batchSizeDefaults: {
        canning: 10,
        freezing: 10,
        dehydrating: 8,
        fermenting: 8,
        rootCellar: 12,
        unit: "lbs"
      }
    },
    ...base.inputs
  };

  return {
    ...base,
    context,
    inputs
  };
}

/**
 * Compute per-crop yield estimates.
 *
 * @param {any[]} crops
 * @param {any} assumptions
 * @returns {any[]}
 */
function computeYieldEstimates(crops, assumptions) {
  const lossFactor = clampNumber(assumptions.lossFactor, 0, 1, 0.15);

  return crops.map((crop) => {
    const rowFeet = safeNumber(crop.rowFeet, 0);
    const plantsPerFoot = safeNumber(crop.plantsPerFoot, 0);
    const expectedYieldPerPlant = safeNumber(crop.expectedYieldPerPlant, 0);
    const successionCount = Math.max(1, safeNumber(crop.successionCount, 1));

    const totalPlants = rowFeet * plantsPerFoot * successionCount;
    const rawTotalYield = totalPlants * expectedYieldPerPlant;

    const targetUse = crop.targetUse || "mixed";
    const preservationRatio = derivePreservationRatio(
      targetUse,
      crop.preservationRatio
    );

    const forPreservation = rawTotalYield * preservationRatio;
    const forFresh = rawTotalYield - forPreservation;
    const forSeed = targetUse === "seed" ? rawTotalYield * 0.2 : 0;

    const adjustedForLoss = rawTotalYield * (1 - lossFactor);

    return {
      cropId: String(crop.cropId || ""),
      cropName: String(crop.name || ""),
      bedId: crop.bedId || "",
      totalPlants,
      expectedYieldPerPlant,
      expectedTotalYield: rawTotalYield,
      yieldUnit: crop.yieldUnit || "lbs",
      forFresh,
      forPreservation,
      forSeed,
      adjustedForLoss,
      notes: crop.notes || ""
    };
  });
}

/**
 * Compute weekly harvest load by projecting yield onto harvest windows.
 *
 * @param {any[]} yieldEstimates
 * @param {any[]} harvestWindows
 * @param {any} assumptions
 * @returns {any[]}
 */
function computeHarvestLoadByWeek(yieldEstimates, harvestWindows, assumptions) {
  if (!Array.isArray(harvestWindows) || harvestWindows.length === 0) return [];

  const laborHoursPerUnit = safeNumber(assumptions.laborHoursPerUnit, 0.25);

  // Map cropId -> estimate
  const byCrop = new Map();
  for (const est of yieldEstimates) {
    if (!est.cropId) continue;
    byCrop.set(est.cropId, est);
  }

  // 1. Compute total harvest window durations per crop
  /** @type {Map<string, number>} */
  const totalDaysByCrop = new Map();
  for (const w of harvestWindows) {
    const cropId = String(w.cropId || "");
    const est = byCrop.get(cropId);
    if (!est) continue;
    const days = windowDurationInDays(w.startDate, w.endDate);
    if (days <= 0) continue;
    totalDaysByCrop.set(cropId, (totalDaysByCrop.get(cropId) || 0) + days);
  }

  // 2. Spread adjustedForLoss across windows, then bucket by week
  /** @type {Map<string, {weekStartDate: string, weekEndDate: string, totalYield: number, yieldUnit: string, estimatedLaborHours: number, crops: any[], notes?: string}>} */
  const buckets = new Map();

  for (const w of harvestWindows) {
    const cropId = String(w.cropId || "");
    const est = byCrop.get(cropId);
    if (!est) continue;

    const totalDays = totalDaysByCrop.get(cropId) || 0;
    if (totalDays <= 0) continue;

    const durationDays = windowDurationInDays(w.startDate, w.endDate);
    if (durationDays <= 0) continue;

    // Pro-rate yield for this window
    const windowYield =
      (est.adjustedForLoss || est.expectedTotalYield || 0) *
      (durationDays / totalDays);

    // Bucket each day into its week
    const days = listDatesBetween(w.startDate, w.endDate);
    const perDayYield = windowYield / Math.max(days.length, 1);

    for (const day of days) {
      const weekStart = startOfWeek(day);
      const weekEnd = endOfWeek(weekStart);
      const key = weekStart;

      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          weekStartDate: weekStart,
          weekEndDate: weekEnd,
          totalYield: 0,
          yieldUnit: est.yieldUnit || "lbs",
          estimatedLaborHours: 0,
          crops: [],
          notes: ""
        };
        buckets.set(key, bucket);
      }

      bucket.totalYield += perDayYield;
      const laborThisDay = perDayYield * laborHoursPerUnit;
      bucket.estimatedLaborHours += laborThisDay;

      // track by crop
      let cropEntry = bucket.crops.find((c) => c.cropId === cropId);
      if (!cropEntry) {
        cropEntry = {
          cropId,
          cropName: est.cropName || "",
          yield: 0
        };
        bucket.crops.push(cropEntry);
      }
      cropEntry.yield += perDayYield;
    }
  }

  const result = Array.from(buckets.values());
  result.sort((a, b) =>
    (a.weekStartDate || "").localeCompare(b.weekStartDate || "")
  );
  return result;
}

/**
 * Compute preservation load groupings based on yield and harvest windows.
 *
 * @param {any[]} yieldEstimates
 * @param {any[]} harvestWindows
 * @param {any} assumptions
 * @returns {any[]}
 */
function computePreservationLoad(yieldEstimates, harvestWindows, assumptions) {
  if (!yieldEstimates.length) return [];

  const batchDefaults = assumptions.batchSizeDefaults || {};
  const batchUnit = batchDefaults.unit || "lbs";

  /** @type {Map<string, { method: string, cropId: string, cropName: string, totalForPreservation: number, yieldUnit: string, linkedHarvestWindows: string[] }>} */
  const groups = new Map();

  // Map cropId -> expected preserved amount
  const preservedByCrop = new Map();
  for (const est of yieldEstimates) {
    preservedByCrop.set(est.cropId, est.forPreservation || 0);
  }

  // Decide preservation "method" per crop
  for (const est of yieldEstimates) {
    const cropId = est.cropId;
    const preservedTotal = preservedByCrop.get(cropId) || 0;
    if (preservedTotal <= 0) continue;

    const method = pickPreservationMethodForCrop(est);
    const key = `${method}:${cropId}`;

    let group = groups.get(key);
    if (!group) {
      group = {
        method,
        cropId,
        cropName: est.cropName || "",
        totalForPreservation: 0,
        yieldUnit: est.yieldUnit || batchUnit,
        linkedHarvestWindows: []
      };
      groups.set(key, group);
    }
    group.totalForPreservation += preservedTotal;
  }

  // Link harvest windows
  for (const w of harvestWindows) {
    const cropId = String(w.cropId || "");
    if (!preservedByCrop.has(cropId)) continue;
    const est = yieldEstimates.find((e) => e.cropId === cropId);
    if (!est) continue;
    const method = pickPreservationMethodForCrop(est);
    const key = `${method}:${cropId}`;
    const group = groups.get(key);
    if (!group) continue;
    if (w.windowId && !group.linkedHarvestWindows.includes(w.windowId)) {
      group.linkedHarvestWindows.push(w.windowId);
    }
  }

  // Turn into array with batch counts
  const result = [];
  for (const [key, group] of groups) {
    const method = group.method;
    const defaultBatchSize =
      safeNumber(batchDefaults[method], 0) || group.totalForPreservation;
    const idealBatchSize = defaultBatchSize || group.totalForPreservation;
    const expectedBatchCount =
      idealBatchSize > 0
        ? group.totalForPreservation / idealBatchSize
        : 1;

    result.push({
      batchGroupId: key,
      method,
      cropId: group.cropId,
      cropName: group.cropName,
      totalForPreservation: group.totalForPreservation,
      yieldUnit: group.yieldUnit,
      idealBatchSize,
      expectedBatchCount,
      linkedHarvestWindows: group.linkedHarvestWindows,
      notes: ""
    });
  }

  return result;
}

/**
 * Compute storehouse coverage vs targets.
 *
 * @param {any[]} yieldEstimates
 * @param {any[]} targetsByCrop
 * @returns {any[]}
 */
function computeStorehouseCoverage(yieldEstimates, targetsByCrop) {
  if (!Array.isArray(targetsByCrop) || !targetsByCrop.length) return [];

  const byCrop = new Map();
  for (const est of yieldEstimates) {
    byCrop.set(est.cropId, est);
  }

  return targetsByCrop.map((t) => {
    const est = byCrop.get(String(t.cropId || "")) || {};
    const expectedPreservedAmount = est.forPreservation || 0;
    const targetAmount = safeNumber(t.targetAmount, 0);
    const coveragePercent =
      targetAmount > 0 ? (expectedPreservedAmount / targetAmount) * 100 : 0;

    let status = "below-target";
    if (coveragePercent >= 100 && coveragePercent < 120) {
      status = "meets-target";
    } else if (coveragePercent >= 120) {
      status = "exceeds-target";
    }

    return {
      cropId: String(t.cropId || ""),
      cropName: t.cropName || est.cropName || "",
      targetAmount,
      targetUnit: String(t.unit || est.yieldUnit || "lbs"),
      expectedPreservedAmount,
      coveragePercent,
      status
    };
  });
}

/**
 * Compute summary metrics for dashboard display.
 *
 * @param {any[]} yieldEstimates
 * @param {any[]} harvestLoadByWeek
 * @param {any[]} preservationLoad
 * @returns {any}
 */
function computeSummary(yieldEstimates, harvestLoadByWeek, preservationLoad) {
  const totalCrops = yieldEstimates.length;
  let totalExpectedYield = 0;
  let yieldUnit = "lbs";

  for (const est of yieldEstimates) {
    totalExpectedYield += safeNumber(est.expectedTotalYield, 0);
    if (est.yieldUnit && yieldUnit === "lbs") {
      yieldUnit = est.yieldUnit;
    }
  }

  let busiestWeekStartDate = null;
  let busiestWeekTotalYield = 0;

  for (const week of harvestLoadByWeek) {
    const y = safeNumber(week.totalYield, 0);
    if (y > busiestWeekTotalYield) {
      busiestWeekTotalYield = y;
      busiestWeekStartDate = week.weekStartDate;
    }
  }

  const totalPreservationBatches = preservationLoad.reduce(
    (acc, pl) => acc + safeNumber(pl.expectedBatchCount, 0),
    0
  );

  return {
    totalCrops,
    totalExpectedYield,
    yieldUnit,
    totalPreservationBatches,
    busiestWeekStartDate: busiestWeekStartDate || null,
    busiestWeekTotalYield,
    notes: ""
  };
}

/**
 * Emit a shim execution event for observability.
 *
 * @param {any} payload
 * @param {number} runtimeMs
 * @param {ShimEnv} env
 */
function emitShimEvent(payload, runtimeMs, env) {
  const eventBus = env.eventBus;
  if (!eventBus || typeof eventBus.emit !== "function") return;

  try {
    eventBus.emit({
      type: "calculator.gardenYield.executed",
      ts: new Date().toISOString(),
      source: "calculators/garden/GardenYieldCalculator.shim",
      data: {
        nodeKey: payload.context && payload.context.nodeKey,
        version: payload.context && payload.context.version,
        runtimeMs,
        summary: payload.outputs && payload.outputs.summary
      }
    });
  } catch (err) {
    console.warn("[GardenYieldCalculator.shim] event emit failed:", err);
  }
}

// ---------------------------------------------------------------------------
// Utility helpers (pure, re-usable)
// ---------------------------------------------------------------------------

/**
 * Derive preservation ratio from targetUse & optional explicit ratio.
 *
 * @param {string} targetUse
 * @param {number} explicit
 * @returns {number}
 */
function derivePreservationRatio(targetUse, explicit) {
  if (typeof explicit === "number" && explicit >= 0 && explicit <= 1) {
    return explicit;
  }

  switch (targetUse) {
    case "fresh":
      return 0;
    case "preservation":
      return 1;
    case "seed":
      return 0.3;
    case "mixed":
    default:
      return 0.5;
  }
}

/**
 * Choose a default preservation method for a crop.
 * This is intentionally simple and can be extended later.
 *
 * @param {any} est
 * @returns {"canning"|"freezing"|"dehydrating"|"fermenting"|"rootCellar"}
 */
function pickPreservationMethodForCrop(est) {
  const name = (est.cropName || "").toLowerCase();

  if (/tomato|salsa|sauce/.test(name)) return "canning";
  if (/bean|pea|corn/.test(name)) return "freezing";
  if (/herb|pepper|onion|garlic/.test(name)) return "dehydrating";
  if (/cabbage|kraut|kimchi/.test(name)) return "fermenting";
  if (/potato|carrot|beet|turnip|apple/.test(name)) return "rootCellar";

  // default
  return "canning";
}

/**
 * Parse a date string (YYYY-MM-DD) into a Date, safely.
 *
 * @param {string} dateStr
 * @returns {Date|null}
 */
function safeDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Returns the duration in days between start and end (inclusive).
 *
 * @param {string} start
 * @param {string} end
 * @returns {number}
 */
function windowDurationInDays(start, end) {
  const s = safeDate(start);
  const e = safeDate(end);
  if (!s || !e) return 0;
  const ms = e.getTime() - s.getTime();
  if (ms < 0) return 0;
  return Math.floor(ms / 86400000) + 1;
}

/**
 * List all dates (YYYY-MM-DD) between start and end inclusive.
 *
 * @param {string} start
 * @param {string} end
 * @returns {string[]}
 */
function listDatesBetween(start, end) {
  const s = safeDate(start);
  const e = safeDate(end);
  if (!s || !e || e < s) return [];
  const result = [];
  const cur = new Date(s.getTime());
  while (cur <= e) {
    result.push(cur.toISOString().slice(0, 10));
    cur.setDate(cur.getDate() + 1);
  }
  return result;
}

/**
 * Get Monday as the start of the week for a given YYYY-MM-DD.
 *
 * @param {string} dateStr
 * @returns {string}
 */
function startOfWeek(dateStr) {
  const d = safeDate(dateStr);
  if (!d) return dateStr;
  const day = d.getDay(); // 0=Sun .. 6=Sat
  const diff = (day === 0 ? -6 : 1) - day; // Monday as start
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}

/**
 * End of week (Sunday) for a Monday start date.
 *
 * @param {string} weekStartStr
 * @returns {string}
 */
function endOfWeek(weekStartStr) {
  const d = safeDate(weekStartStr);
  if (!d) return weekStartStr;
  d.setDate(d.getDate() + 6);
  return d.toISOString().slice(0, 10);
}

/**
 * Safely coerce a value to number.
 *
 * @param {any} value
 * @param {number} fallback
 * @returns {number}
 */
function safeNumber(value, fallback) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Clamp a number between min and max with fallback.
 *
 * @param {any} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function clampNumber(value, min, max, fallback) {
  const n = safeNumber(value, fallback);
  return Math.min(max, Math.max(min, n));
}
