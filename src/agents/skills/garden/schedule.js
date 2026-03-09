/**
 * schedule.js
 * -----------
 * How this fits:
 * - Lives under: src/agents/skills/garden/schedule.js
 * - Used by: Garden Planner pages, Homestead Planner, Automation runtime.
 * - Responsibility: Given crops + frost dates, compute sowing/planting windows and
 *   structured “swap options” (Early / Standard / Late) that a root-mounted
 *   Garden Schedule swap modal can display and keep running while the user navigates.
 *
 * NOTES:
 * - This file is pure logic + events + Hub export. It does NOT render UI.
 * - The UI (e.g. GardenScheduleSwapModal) should:
 *    • subscribe to the returned schedule data,
 *    • let users choose between Early/Standard/Late windows,
 *    • persist chosen option IDs in Dexie,
 *    • stay mounted at app root so it’s resilient to navigation.
 */

import { db } from "../../../services/db";
import { emitEvent } from "../../../services/events/eventBus";
import { familyFundMode } from "../../../config/featureFlags";
import { HubPacketFormatter } from "@/services/hub/HubPacketFormatter";
import { FamilyFundConnector } from "@/services/hub/FamilyFundConnector";

/**
 * @typedef {"cool"|"warm"} CropSeason
 * @typedef {"direct"|"indoor"|"transplant"} SowType
 */

/**
 * Minimal crop contract for scheduling.
 * Extend as needed in your garden schema.
 *
 * @typedef {Object} GardenCrop
 * @property {string} id
 * @property {string} name
 * @property {string} [variety]
 * @property {CropSeason} [season]          - "cool" or "warm"
 * @property {SowType} [sowType]            - "direct" | "indoor" | "transplant"
 * @property {number} [daysToMaturity]      - Days from sow to harvest (approx).
 * @property {number} [successionCount]     - Number of successions (optional).
 * @property {number} [successionInterval]  - Days between successions.
 * @property {string} [bedId]               - Garden bed / zone id.
 * @property {string[]} [tags]
 * @property {string} [notes]
 */

/**
 * Frost dates for a location.
 *
 * @typedef {Object} FrostDates
 * @property {string|null} lastSpringFrost  - ISO date string (YYYY-MM-DD or full ISO).
 * @property {string|null} firstFallFrost   - ISO date string (YYYY-MM-DD or full ISO).
 */

/**
 * A planned sowing/planting window for a crop.
 *
 * @typedef {Object} GardenSowWindow
 * @property {string} id
 * @property {number} index                  - succession index (0-based).
 * @property {"sow"|"plantOut"} phase
 * @property {SowType} sowType
 * @property {string} windowStart            - ISO date (YYYY-MM-DD).
 * @property {string} windowEnd              - ISO date (YYYY-MM-DD).
 * @property {string} targetDate             - ISO date (YYYY-MM-DD) (center of window).
 * @property {string[]} blockers             - ["weather","sabbath","equipment","inventory"] etc (planned guards).
 * @property {string} [notes]
 */

/**
 * Swap option for sow window (used by UI swap modal).
 *
 * @typedef {Object} GardenSowSwapOption
 * @property {string} id
 * @property {string} label                  - "Early window", "Standard window", etc.
 * @property {"early"|"standard"|"late"} variant
 * @property {string} windowStart            - ISO date (YYYY-MM-DD).
 * @property {string} windowEnd              - ISO date (YYYY-MM-DD).
 * @property {string} targetDate             - ISO date (YYYY-MM-DD).
 * @property {boolean} autoSelected
 * @property {string[]} badges               - e.g. ["FROST-SAFE","AGGRESSIVE","CONSERVATIVE"].
 */

/**
 * Schedule result for a single crop.
 *
 * @typedef {Object} GardenScheduleCropResult
 * @property {GardenCrop} crop
 * @property {FrostDates} frost
 * @property {GardenSowWindow[]} windows
 * @property {Record<string,GardenSowSwapOption[]>} swapOptionsByWindowId
 * @property {Record<string,string|null>} chosenSwapByWindowId
 * @property {string|null} error
 */

/**
 * Options for the schedule planner.
 *
 * @typedef {Object} GardenScheduleOptions
 * @property {string} [eventSource="garden"]
 * @property {number} [nowTs]                - Timestamp; defaults to Date.now().
 * @property {FrostDates} [frostDates]       - Override frost dates explicitly.
 * @property {string} [zoneId]               - Garden zone / location id for DB lookup.
 * @property {Record<string,string>} [chosenSwapByWindowId] - Resume choices.
 */

/* -------------------------------------------------------------------------- */
/* Utilities                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * SSA event wrapper.
 * @param {string} type
 * @param {string} source
 * @param {any} data
 */
function emit(type, source, data) {
  try {
    emitEvent({
      type,
      ts: new Date().toISOString(),
      source,
      data,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[garden/schedule] Failed to emit event:", type, err);
  }
}

/**
 * Convert an ISO-like string to a Date (date-only; time set to noon to avoid TZ issues).
 * @param {string|null|undefined} iso
 * @returns {Date|null}
 */
function isoToDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  // Normalize to "local noon" for stability.
  d.setHours(12, 0, 0, 0);
  return d;
}

/**
 * Convert Date to YYYY-MM-DD string.
 * @param {Date} d
 * @returns {string}
 */
function dateToYMD(d) {
  const year = d.getFullYear();
  const month = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Add days to a Date, returning a new Date.
 * @param {Date} d
 * @param {number} days
 * @returns {Date}
 */
function addDays(d, days) {
  const out = new Date(d.getTime());
  out.setDate(out.getDate() + days);
  return out;
}

/**
 * Clamp a date to be <= max.
 * @param {Date} d
 * @param {Date} max
 * @returns {Date}
 */
function clampToBefore(d, max) {
  return d.getTime() > max.getTime() ? new Date(max.getTime()) : d;
}

/* -------------------------------------------------------------------------- */
/* Frost date lookup                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Attempt to read frost dates from Dexie using a garden meta/zone table.
 * This is a best-effort stub; adapt to your actual schema.
 *
 * Expected Dexie tables (optional):
 * - db.gardenMeta (single record with frost dates)
 * - or db.gardenZones with { id, lastSpringFrost, firstFallFrost }
 *
 * @param {GardenScheduleOptions} options
 * @returns {Promise<FrostDates>}
 */
async function resolveFrostDatesFromDb(options) {
  const fallback = { lastSpringFrost: null, firstFallFrost: null };

  if (!db) return fallback;

  try {
    // Prefer zone-specific record if available.
    if (options.zoneId && db.gardenZones && db.gardenZones.get) {
      const zone = await db.gardenZones.get(options.zoneId);
      if (zone && (zone.lastSpringFrost || zone.firstFallFrost)) {
        return {
          lastSpringFrost: zone.lastSpringFrost || null,
          firstFallFrost: zone.firstFallFrost || null,
        };
      }
    }

    // Fallback: single meta record.
    if (db.gardenMeta && db.gardenMeta.toCollection) {
      const metas = await db.gardenMeta.toCollection().limit(1).toArray();
      const meta = metas[0];
      if (meta && (meta.lastSpringFrost || meta.firstFallFrost)) {
        return {
          lastSpringFrost: meta.lastSpringFrost || null,
          firstFallFrost: meta.firstFallFrost || null,
        };
      }
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[garden/schedule] Failed to read frost dates from DB:", err);
  }

  return fallback;
}

/**
 * Resolve the frost dates to use (options override DB).
 * @param {GardenScheduleOptions} options
 * @returns {Promise<FrostDates>}
 */
async function resolveFrostDates(options) {
  const override = options.frostDates || {};
  const base = await resolveFrostDatesFromDb(options);

  return {
    lastSpringFrost: override.lastSpringFrost || base.lastSpringFrost,
    firstFallFrost: override.firstFallFrost || base.firstFallFrost,
  };
}

/* -------------------------------------------------------------------------- */
/* Core scheduling logic                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Compute base sow/plant window for the *first* succession of a crop.
 * Uses simple heuristics based on season, frost dates, and sowType.
 *
 * @param {GardenCrop} crop
 * @param {FrostDates} frost
 * @returns {GardenSowWindow|null}
 */
function computePrimaryWindow(crop, frost) {
  const season = crop.season || "warm";
  const sowType = crop.sowType || "direct";

  const lastFrost = isoToDate(frost.lastSpringFrost);
  const firstFrost = isoToDate(frost.firstFallFrost);

  const daysToMaturity = Number.isFinite(crop.daysToMaturity)
    ? crop.daysToMaturity
    : season === "cool"
    ? 55
    : 75;

  // If no frost info, fall back to simple "start now" window.
  if (!lastFrost && !firstFrost) {
    const now = new Date();
    const start = addDays(now, 3);
    const end = addDays(now, 21);
    const target = addDays(now, 10);

    return {
      id: `w_${crop.id}_0`,
      index: 0,
      phase: "sow",
      sowType,
      windowStart: dateToYMD(start),
      windowEnd: dateToYMD(end),
      targetDate: dateToYMD(target),
      blockers: ["weather"],
      notes: "Approximate sowing window (frost dates unknown).",
    };
  }

  // Determine safe "latest harvest start" based on first fall frost.
  let lastSafeSowDate = null;
  if (firstFrost) {
    // 2-week buffer before frost.
    lastSafeSowDate = addDays(firstFrost, -(daysToMaturity + 14));
  }

  // Heuristics:
  // - Cool season: aim for harvest before heat; early sow/before last frost.
  // - Warm season: sow after last frost (or slightly before if indoor).
  let baseStart;
  let baseEnd;
  let phase = "sow";

  if (season === "cool") {
    if (lastFrost) {
      baseStart = addDays(lastFrost, -42); // 6 weeks before last frost
      baseEnd = addDays(lastFrost, -7); // 1 week before last frost
    } else {
      const now = new Date();
      baseStart = addDays(now, 0);
      baseEnd = addDays(now, 28);
    }
  } else {
    // warm
    if (lastFrost) {
      if (sowType === "indoor") {
        // Start seeds indoors 4–6 weeks before transplanting out (1 week after last frost).
        const plantOutTarget = addDays(lastFrost, 7);
        const sowStart = addDays(plantOutTarget, -42);
        const sowEnd = addDays(plantOutTarget, -28);
        baseStart = sowStart;
        baseEnd = sowEnd;
        phase = "sow"; // indoor sow
      } else if (sowType === "transplant") {
        const plantOutTarget = addDays(lastFrost, 7);
        baseStart = addDays(plantOutTarget, -3);
        baseEnd = addDays(plantOutTarget, 7);
        phase = "plantOut";
      } else {
        // direct sow warm: after frost, spread across 3 weeks.
        baseStart = addDays(lastFrost, 7);
        baseEnd = addDays(lastFrost, 28);
      }
    } else {
      const now = new Date();
      baseStart = addDays(now, 7);
      baseEnd = addDays(now, 28);
    }
  }

  if (lastSafeSowDate) {
    baseEnd = clampToBefore(baseEnd, lastSafeSowDate);
  }

  const midTs = (baseStart.getTime() + baseEnd.getTime()) / 2;
  const target = new Date(midTs);

  return {
    id: `w_${crop.id}_0`,
    index: 0,
    phase,
    sowType,
    windowStart: dateToYMD(baseStart),
    windowEnd: dateToYMD(baseEnd),
    targetDate: dateToYMD(target),
    blockers: ["weather"],
    notes: null,
  };
}

/**
 * Generate succession sowing windows based on primary window.
 *
 * @param {GardenCrop} crop
 * @param {FrostDates} frost
 * @param {GardenSowWindow} primary
 * @returns {GardenSowWindow[]}
 */
function computeSuccessionWindows(crop, frost, primary) {
  const count = Number.isFinite(crop.successionCount)
    ? Math.max(1, crop.successionCount)
    : 1;
  const interval = Number.isFinite(crop.successionInterval)
    ? Math.max(7, crop.successionInterval)
    : 14;

  if (count <= 1) return [primary];

  const firstStart = isoToDate(primary.windowStart);
  const firstEnd = isoToDate(primary.windowEnd);
  if (!firstStart || !firstEnd) return [primary];

  const firstFrost = isoToDate(frost.firstFallFrost);
  const daysToMaturity = Number.isFinite(crop.daysToMaturity)
    ? crop.daysToMaturity
    : 70;

  /** @type {GardenSowWindow[]} */
  const windows = [primary];

  for (let i = 1; i < count; i += 1) {
    const offset = i * interval;
    let start = addDays(firstStart, offset);
    let end = addDays(firstEnd, offset);

    if (firstFrost) {
      const lastSafeSow = addDays(firstFrost, -(daysToMaturity + 7));
      start = clampToBefore(start, lastSafeSow);
      end = clampToBefore(end, lastSafeSow);
      if (end.getTime() < firstStart.getTime()) {
        // If the window collapses before the first sow, stop creating further windows.
        break;
      }
    }

    const midTs = (start.getTime() + end.getTime()) / 2;
    const target = new Date(midTs);

    windows.push({
      id: `w_${crop.id}_${i}`,
      index: i,
      phase: primary.phase,
      sowType: primary.sowType,
      windowStart: dateToYMD(start),
      windowEnd: dateToYMD(end),
      targetDate: dateToYMD(target),
      blockers: [...primary.blockers],
      notes: "Succession sowing window.",
    });
  }

  return windows;
}

/* -------------------------------------------------------------------------- */
/* Swap option building (for swap modal)                                      */
/* -------------------------------------------------------------------------- */

/**
 * Create Early/Standard/Late swap options for a window.
 * - Standard = original window.
 * - Early = shift -7 days.
 * - Late  = shift +7 days (clamped to not exceed frost safety if available).
 *
 * @param {GardenSowWindow} window
 * @param {FrostDates} frost
 * @returns {GardenSowSwapOption[]}
 */
function buildSwapOptionsForWindow(window, frost) {
  const start = isoToDate(window.windowStart);
  const end = isoToDate(window.windowEnd);
  const target = isoToDate(window.targetDate);
  if (!start || !end || !target) return [];

  const firstFrost = isoToDate(frost.firstFallFrost);

  // Shift helpers
  const earlyStart = addDays(start, -7);
  const earlyEnd = addDays(end, -7);
  const earlyTarget = addDays(target, -7);

  let lateStart = addDays(start, 7);
  let lateEnd = addDays(end, 7);
  let lateTarget = addDays(target, 7);

  if (firstFrost) {
    const lastSafe = addDays(firstFrost, -7);
    lateStart = clampToBefore(lateStart, lastSafe);
    lateEnd = clampToBefore(lateEnd, lastSafe);
    lateTarget = clampToBefore(lateTarget, lastSafe);
  }

  /** @type {GardenSowSwapOption[]} */
  const options = [
    {
      id: `${window.id}:early`,
      label: "Early window",
      variant: "early",
      windowStart: dateToYMD(earlyStart),
      windowEnd: dateToYMD(earlyEnd),
      targetDate: dateToYMD(earlyTarget),
      autoSelected: false,
      badges: ["AGGRESSIVE"],
    },
    {
      id: `${window.id}:standard`,
      label: "Standard window",
      variant: "standard",
      windowStart: dateToYMD(start),
      windowEnd: dateToYMD(end),
      targetDate: dateToYMD(target),
      autoSelected: true,
      badges: ["BALANCED", "DEFAULT"],
    },
    {
      id: `${window.id}:late`,
      label: "Late window",
      variant: "late",
      windowStart: dateToYMD(lateStart),
      windowEnd: dateToYMD(lateEnd),
      targetDate: dateToYMD(lateTarget),
      autoSelected: false,
      badges: ["CONSERVATIVE"],
    },
  ];

  // You could add logic here to remove options that fall before "now" or after frost safety.

  return options;
}

/* -------------------------------------------------------------------------- */
/* Hub export                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Export garden schedule to the Hub (if familyFundMode is enabled).
 * @param {GardenScheduleCropResult[]} schedule
 * @param {string} eventSource
 */
async function exportGardenScheduleToHub(schedule, eventSource) {
  if (!familyFundMode || !schedule || !schedule.length) return;

  try {
    const payload = HubPacketFormatter.formatGardenSchedule(schedule, {
      source: eventSource,
      exportedAt: new Date().toISOString(),
    });
    await FamilyFundConnector.send(payload);
    emit("garden.schedule.exported", eventSource, {
      crops: schedule.length,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[garden/schedule] Hub export failed (soft):", err);
  }
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Plan sowing / planting windows for a list of crops.
 *
 * Emits:
 * - garden.schedule.requested
 * - garden.schedule.cropPlanned (per crop)
 * - garden.schedule.swapOptions.built (per crop)
 * - garden.schedule.completed
 * - garden.schedule.exported (on successful Hub export)
 *
 * Swap modal integration:
 * - The returned `schedule` contains:
 *   • windows[] per crop
 *   • swapOptionsByWindowId[window.id] → GardenSowSwapOption[]
 *   • chosenSwapByWindowId[window.id]   → selected option id (resume-aware)
 * - Your GardenScheduleSwapModal should:
 *   • render options for each window,
 *   • allow picking Early/Standard/Late,
 *   • persist chosenSwapByWindowId in Dexie,
 *   • keep itself mounted at app root so it survives navigation.
 *
 * @param {GardenCrop[]} crops
 * @param {GardenScheduleOptions} [options]
 * @returns {Promise<{ schedule: GardenScheduleCropResult[], meta: { crops: number, errors: number } }>}
 */
export async function planGardenSchedule(crops, options = {}) {
  const {
    eventSource = "garden",
    nowTs = Date.now(),
    chosenSwapByWindowId = {},
  } = options;

  const safeCrops = Array.isArray(crops) ? crops : [];
  emit("garden.schedule.requested", eventSource, {
    crops: safeCrops.length,
  });

  const frost = await resolveFrostDates(options);

  /** @type {GardenScheduleCropResult[]} */
  const schedule = [];
  let errorCount = 0;

  for (const crop of safeCrops) {
    /** @type {GardenScheduleCropResult} */
    const result = {
      crop,
      frost,
      windows: [],
      swapOptionsByWindowId: {},
      chosenSwapByWindowId: {},
      error: null,
    };

    try {
      const primary = computePrimaryWindow(crop, frost);
      if (!primary) {
        result.error =
          "Unable to compute primary sowing window (check frost dates and crop data).";
        errorCount += 1;
        schedule.push(result);
        continue;
      }

      const windows = computeSuccessionWindows(crop, frost, primary);
      result.windows = windows;

      for (const w of windows) {
        const optionsForWindow = buildSwapOptionsForWindow(w, frost);
        result.swapOptionsByWindowId[w.id] = optionsForWindow;

        const resumeId = chosenSwapByWindowId[w.id];
        const chosen =
          (resumeId && optionsForWindow.find((opt) => opt.id === resumeId)) ||
          optionsForWindow.find((opt) => opt.autoSelected) ||
          optionsForWindow[0] ||
          null;

        result.chosenSwapByWindowId[w.id] = chosen ? chosen.id : null;

        emit("garden.schedule.swapOptions.built", eventSource, {
          cropId: crop.id,
          windowId: w.id,
          optionsCount: optionsForWindow.length,
          autoSelectedId:
            optionsForWindow.find((opt) => opt.autoSelected)?.id || null,
        });
      }

      emit("garden.schedule.cropPlanned", eventSource, {
        cropId: crop.id,
        windows: windows.length,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        "[garden/schedule] Failed to plan crop schedule:",
        crop,
        err
      );
      result.error = err?.message || String(err);
      errorCount += 1;
    }

    schedule.push(result);
  }

  emit("garden.schedule.completed", eventSource, {
    crops: schedule.length,
    errors: errorCount,
    ts: new Date(nowTs).toISOString(),
  });

  // Fire-and-forget Hub export
  exportGardenScheduleToHub(schedule, eventSource).catch(() => {});

  return {
    schedule,
    meta: {
      crops: schedule.length,
      errors: errorCount,
    },
  };
}

/**
 * Convenience helper:
 * Get schedule + swap options for a single crop.
 *
 * @param {GardenCrop} crop
 * @param {GardenScheduleOptions} [options]
 * @returns {Promise<GardenScheduleCropResult|null>}
 */
export async function planSingleCropSchedule(crop, options = {}) {
  const { schedule } = await planGardenSchedule([crop], options);
  return schedule[0] || null;
}
