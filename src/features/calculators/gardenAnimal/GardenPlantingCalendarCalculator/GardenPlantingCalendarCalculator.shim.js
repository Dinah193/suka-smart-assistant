// GardenPlantingCalendarCalculator.shim.js
// -------------------------------------------------------------
// Shim logic for computing garden planting and harvest dates
// from climate/seasonal data and (optionally) Hebrew-feast-
// aligned calendar data.
//
// This module is designed to plug into SSA's Planning Graph:
// - Takes a payload that conforms to GardenPlantingCalendarCalculator.schema.json
// - Produces plantingWindows, harvestWindows, and calendarEvents
// - Optionally emits calculator events to the SSA eventBus
// - Optionally exports results to the Hub when familyFundMode is enabled
//
// NOTE: Hebrew calendar integration is expected to be handled
// upstream. This shim assumes that any Hebrew-based feast days
// have already been mapped to Gregorian dates in payload.inputs.calendar.feastDays.
// -------------------------------------------------------------

const SHIM_ID = "GardenPlantingCalendarCalculator";
const SHIM_SOURCE = "calculators/garden/GardenPlantingCalendarCalculator";

/**
 * @typedef {Object} ShimDeps
 * @property {{ emit?: Function }} [eventBus]       Optional SSA event bus with emit({ type, ts, source, data })
 * @property {{ familyFundMode?: boolean }} [featureFlags] Feature flags module
 * @property {(payload: any) => Promise<void>|void} [exportToHubIfEnabled] Optional Hub export helper
 */

/**
 * @typedef {Object} GardenPlantingCalendarPayload
 * @property {Object} [context]
 * @property {Object} inputs
 * @property {Object} [outputs]
 */

/**
 * Entry point for the Garden Planting Calendar Calculator shim.
 *
 * @param {GardenPlantingCalendarPayload} payload
 * @param {ShimDeps} [deps]
 * @returns {Promise<GardenPlantingCalendarPayload>}
 */
export async function runGardenPlantingCalendarCalculatorShim(payload, deps = {}) {
  const { eventBus, featureFlags, exportToHubIfEnabled } = deps;

  const ts = new Date().toISOString();
  const safePayload = payload && typeof payload === "object" ? payload : {};

  const inputs = safePayload.inputs || {};
  const context = safePayload.context || {};

  // Basic validation: we require climate, calendar, and crops to proceed.
  const climate = inputs.climate || {};
  const calendar = inputs.calendar || {};
  const crops = Array.isArray(inputs.crops) ? inputs.crops : [];
  const gardenLayout = inputs.gardenLayout || {};

  if (!climate.lastFrostDate || !climate.firstFrostDate || !calendar.year || crops.length === 0) {
    const outputs = {
      plantingWindows: [],
      harvestWindows: [],
      calendarEvents: [],
      summary: {
        totalCropsPlanned: 0,
        totalPlantingEvents: 0,
        totalHarvestWindows: 0,
        notes: "Insufficient input data: require climate.lastFrostDate, climate.firstFrostDate, calendar.year, and at least one crop."
      }
    };

    const result = { context, inputs, outputs };

    emitSafe(eventBus, {
      type: "calculator.executed",
      ts,
      source: SHIM_SOURCE,
      data: {
        shimId: SHIM_ID,
        status: "invalid-input",
        summary: outputs.summary
      }
    });

    return result;
  }

  const plantingWindows = computePlantingWindows(inputs);
  const harvestWindows = computeHarvestWindows(inputs, plantingWindows);
  const calendarEvents = buildCalendarEvents(plantingWindows, harvestWindows);

  const outputs = {
    plantingWindows,
    harvestWindows,
    calendarEvents,
    summary: {
      totalCropsPlanned: crops.length,
      totalPlantingEvents: plantingWindows.length,
      totalHarvestWindows: harvestWindows.length,
      notes: buildSummaryNotes(plantingWindows, harvestWindows, calendar)
    }
  };

  const result = { context, inputs, outputs };

  // Emit calculator event
  emitSafe(eventBus, {
    type: "calculator.executed",
    ts,
    source: SHIM_SOURCE,
    data: {
      shimId: SHIM_ID,
      status: "ok",
      summary: outputs.summary
    }
  });

  // Optional Hub export for cross-household analytics
  if (featureFlags && featureFlags.familyFundMode && typeof exportToHubIfEnabled === "function") {
    try {
      await exportToHubIfEnabled({
        kind: "calculator-result",
        calculatorId: SHIM_ID,
        ts,
        context,
        inputs,
        outputs
      });
    } catch (err) {
      // Fail silently by contract
      console.warn("[GardenPlantingCalendarCalculator] Hub export failed:", err);
    }
  }

  return result;
}

/**
 * Compute planting windows from inputs.
 *
 * @param {any} inputs
 * @returns {Array<Object>}
 */
function computePlantingWindows(inputs) {
  const climate = inputs.climate || {};
  const calendar = inputs.calendar || {};
  const crops = Array.isArray(inputs.crops) ? inputs.crops : [];
  const gardenLayout = inputs.gardenLayout || {};

  const lastFrost = parseDate(climate.lastFrostDate);
  const firstFrost = parseDate(climate.firstFrostDate);
  const feastDays = Array.isArray(calendar.feastDays) ? calendar.feastDays : [];

  const beds = Array.isArray(gardenLayout.beds) ? gardenLayout.beds : [];
  const bedMap = new Map(beds.map((b) => [b.bedId, b]));

  /** @type {Array<Object>} */
  const windows = [];

  if (!lastFrost || !firstFrost) {
    return windows;
  }

  const year = calendar.year;

  for (const crop of crops) {
    if (!crop || typeof crop !== "object") continue;
    const cropId = crop.cropId || `crop-${Math.random().toString(36).slice(2)}`;
    const cropName = crop.name || "Unnamed crop";
    const daysToMaturity = toInt(crop.daysToMaturity, 0);
    if (daysToMaturity <= 0) continue;

    const frostSensitivity = crop.frostSensitivity || "tender";
    const successionEnabled = !!crop.successionEnabled;
    const successionIntervalDays = toInt(crop.successionIntervalDays, 0);
    const maxSuccessions = Math.max(1, toInt(crop.maxSuccessions, 1));

    const preferredBedIds = Array.isArray(crop.preferredBedIds) && crop.preferredBedIds.length > 0
      ? crop.preferredBedIds
      : beds.map((b) => b.bedId).filter(Boolean);

    const baseSpringWindow = computeSpringWindow(lastFrost, frostSensitivity);
    const baseFallWindow = computeFallWindow(firstFrost, daysToMaturity, frostSensitivity);

    // For each preferred bed, generate spring and fall successions.
    for (const bedIdRaw of preferredBedIds.length ? preferredBedIds : [null]) {
      const bedId = bedIdRaw || "garden-default";
      let successionIndex = 0;

      // SPRING SUCCESSIONS
      if (baseSpringWindow) {
        const { earliest, latest } = baseSpringWindow;
        let start = new Date(earliest.getTime());
        let end = new Date(latest.getTime());

        while (successionIndex < maxSuccessions && start <= end) {
          const windowId = `spring-${cropId}-${bedId}-${successionIndex}`;
          const flags = [];

          if (diffDays(end, lastFrost) < 0) {
            flags.push("before-last-frost");
          }
          if (diffDays(earliest, lastFrost) > 21) {
            flags.push("late-spring-planting");
          }

          windows.push({
            windowId,
            cropId,
            cropName,
            bedId,
            successionIndex,
            season: "spring",
            startDate: formatDate(start),
            endDate: formatDate(end),
            earliestSafeDate: formatDate(earliest),
            latestSafeDate: formatDate(latest),
            flags
          });

          if (!successionEnabled || successionIntervalDays <= 0) break;

          start = addDays(start, successionIntervalDays);
          end = addDays(end, successionIntervalDays);
          successionIndex += 1;
        }
      }

      // FALL SUCCESSIONS
      if (baseFallWindow) {
        const { earliest, latest } = baseFallWindow;
        let start = new Date(earliest.getTime());
        let end = new Date(latest.getTime());

        let fallSuccessionIndex = 0;
        while (fallSuccessionIndex < maxSuccessions && start <= end) {
          const windowId = `fall-${cropId}-${bedId}-${fallSuccessionIndex}`;
          const flags = [];

          if (diffDays(firstFrost, end) < 10) {
            flags.push("tight-before-frost");
          }

          windows.push({
            windowId,
            cropId,
            cropName,
            bedId,
            successionIndex: fallSuccessionIndex,
            season: "fall",
            startDate: formatDate(start),
            endDate: formatDate(end),
            earliestSafeDate: formatDate(earliest),
            latestSafeDate: formatDate(latest),
            flags
          });

          if (!successionEnabled || successionIntervalDays <= 0) break;

          start = addDays(start, -successionIntervalDays);
          end = addDays(end, -successionIntervalDays);
          fallSuccessionIndex += 1;

          if (start < new Date(year, 0, 1)) break;
        }
      }
    }
  }

  return windows;
}

/**
 * Compute harvest windows based on planting windows and crop maturity.
 *
 * @param {any} inputs
 * @param {Array<Object>} plantingWindows
 * @returns {Array<Object>}
 */
function computeHarvestWindows(inputs, plantingWindows) {
  const crops = Array.isArray(inputs.crops) ? inputs.crops : [];
  const calendar = inputs.calendar || {};
  const feastDays = Array.isArray(calendar.feastDays) ? calendar.feastDays : [];

  const cropMap = new Map();
  for (const crop of crops) {
    if (crop && crop.cropId) {
      cropMap.set(crop.cropId, crop);
    }
  }

  /** @type {Array<Object>} */
  const harvestWindows = [];

  for (const pw of plantingWindows) {
    const crop = cropMap.get(pw.cropId) || {};
    const daysToMaturity = toInt(crop.daysToMaturity, 0);
    if (daysToMaturity <= 0) continue;

    const startPlant = parseDate(pw.startDate);
    if (!startPlant) continue;

    const harvestStart = addDays(startPlant, daysToMaturity);
    const harvestEnd = addDays(startPlant, daysToMaturity + 7);

    const alignedFeastDays = feastDays.filter((fd) => {
      const d = parseDate(fd.date);
      if (!d) return false;
      return d >= harvestStart && d <= harvestEnd;
    }).map((fd) => ({
      feastId: fd.id,
      name: fd.name,
      date: fd.date
    }));

    const windowId = `harvest-${pw.windowId}`;

    harvestWindows.push({
      windowId,
      cropId: pw.cropId,
      cropName: pw.cropName,
      bedId: pw.bedId,
      successionIndex: pw.successionIndex,
      startDate: formatDate(harvestStart),
      endDate: formatDate(harvestEnd),
      alignedFeastDays,
      targetUse: crop.targetUse || "mixed"
    });
  }

  return harvestWindows;
}

/**
 * Build SSA-ready calendar events from planting and harvest windows.
 *
 * @param {Array<Object>} plantingWindows
 * @param {Array<Object>} harvestWindows
 * @returns {Array<Object>}
 */
function buildCalendarEvents(plantingWindows, harvestWindows) {
  /** @type {Array<Object>} */
  const events = [];

  for (const pw of plantingWindows) {
    events.push({
      eventId: `planting-${pw.windowId}`,
      kind: "planting",
      cropId: pw.cropId,
      bedId: pw.bedId,
      date: pw.startDate,
      title: `Plant ${pw.cropName} (${pw.season}, succession ${pw.successionIndex + 1})`,
      notes: `Planting window from ${pw.startDate} to ${pw.endDate}.`
    });

    events.push({
      eventId: `bed-prep-${pw.windowId}`,
      kind: "bed-prep",
      cropId: pw.cropId,
      bedId: pw.bedId,
      date: formatDate(addDays(parseDate(pw.startDate), -3)),
      title: `Prep bed for ${pw.cropName}`,
      notes: "Weed, amend soil, and ensure irrigation is ready."
    });
  }

  for (const hw of harvestWindows) {
    const start = parseDate(hw.startDate);
    const end = parseDate(hw.endDate);
    if (!start || !end) continue;

    const mid = new Date((start.getTime() + end.getTime()) / 2);

    events.push({
      eventId: `harvest-start-${hw.windowId}`,
      kind: "harvest-start",
      cropId: hw.cropId,
      bedId: hw.bedId,
      date: hw.startDate,
      title: `Start harvesting ${hw.cropName}`,
      notes: "Begin checking daily for peak ripeness."
    });

    events.push({
      eventId: `harvest-peak-${hw.windowId}`,
      kind: "harvest-peak",
      cropId: hw.cropId,
      bedId: hw.bedId,
      date: formatDate(mid),
      title: `Peak harvest for ${hw.cropName}`,
      notes: "Ideal window for bulk harvest and preservation sessions."
    });

    events.push({
      eventId: `harvest-final-${hw.windowId}`,
      kind: "harvest-final",
      cropId: hw.cropId,
      bedId: hw.bedId,
      date: hw.endDate,
      title: `Final harvest for ${hw.cropName}`,
      notes: "Clear remaining produce and prep bed for next planting."
    });
  }

  return events;
}

/**
 * Build a high-level summary note string.
 *
 * @param {Array<Object>} plantingWindows
 * @param {Array<Object>} harvestWindows
 * @param {any} calendar
 * @returns {string}
 */
function buildSummaryNotes(plantingWindows, harvestWindows, calendar) {
  const feastAlignedCount = harvestWindows.reduce((acc, hw) => {
    if (Array.isArray(hw.alignedFeastDays) && hw.alignedFeastDays.length > 0) {
      return acc + 1;
    }
    return acc;
  }, 0);

  const parts = [];
  parts.push(`Planned ${plantingWindows.length} planting windows and ${harvestWindows.length} harvest windows.`);
  if (feastAlignedCount > 0 && calendar && calendar.alignWithFeastDays) {
    parts.push(`${feastAlignedCount} harvest windows align with one or more feast days.`);
  }

  return parts.join(" ");
}

/**
 * Compute a spring planting window based on last frost date and frost sensitivity.
 *
 * @param {Date} lastFrost
 * @param {string} frostSensitivity
 * @returns {{ earliest: Date, latest: Date }|null}
 */
function computeSpringWindow(lastFrost, frostSensitivity) {
  if (!lastFrost) return null;

  let earliestOffset = 0;
  let latestOffset = 0;

  switch (frostSensitivity) {
    case "frost-hardy":
    case "frost-tolerant":
      // Can go 2 weeks before last frost to 3 weeks after
      earliestOffset = -14;
      latestOffset = 21;
      break;
    case "very-tender":
      // Keep later: 2 to 6 weeks after last frost
      earliestOffset = 14;
      latestOffset = 42;
      break;
    case "tender":
    default:
      // Default: 1 to 5 weeks after last frost
      earliestOffset = 7;
      latestOffset = 35;
      break;
  }

  const earliest = addDays(lastFrost, earliestOffset);
  const latest = addDays(lastFrost, latestOffset);

  return { earliest, latest };
}

/**
 * Compute a fall planting window based on first frost date and days to maturity.
 *
 * @param {Date} firstFrost
 * @param {number} daysToMaturity
 * @param {string} frostSensitivity
 * @returns {{ earliest: Date, latest: Date }|null}
 */
function computeFallWindow(firstFrost, daysToMaturity, frostSensitivity) {
  if (!firstFrost || daysToMaturity <= 0) return null;

  const safetyBufferDays = frostSensitivity === "very-tender" ? 21 : 14;
  const windowWidthDays = 21; // window length before safety buffer

  // Latest safe planting is 'firstFrost - safetyBuffer'
  const latest = addDays(firstFrost, -safetyBufferDays);
  // Earliest attempted planting: enough time for maturity plus window width
  const earliest = addDays(latest, -windowWidthDays);

  return { earliest, latest };
}

// -------------------------------------------------------------
// Utility functions
// -------------------------------------------------------------

/**
 * @param {string} s
 * @returns {Date|null}
 */
function parseDate(s) {
  if (!s || typeof s !== "string") return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * @param {Date} d
 * @returns {string}
 */
function formatDate(d) {
  if (!(d instanceof Date)) return "";
  return d.toISOString().slice(0, 10);
}

/**
 * @param {Date} date
 * @param {number} days
 * @returns {Date}
 */
function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

/**
 * Difference in days (end - start).
 *
 * @param {Date} end
 * @param {Date} start
 * @returns {number}
 */
function diffDays(end, start) {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((end.getTime() - start.getTime()) / msPerDay);
}

/**
 * @param {any} value
 * @param {number} fallback
 * @returns {number}
 */
function toInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Safe event emitter.
 *
 * @param {{ emit?: Function }|undefined} eventBus
 * @param {any} event
 */
function emitSafe(eventBus, event) {
  if (!eventBus || typeof eventBus.emit !== "function") return;
  try {
    eventBus.emit(event);
  } catch (err) {
    console.warn("[GardenPlantingCalendarCalculator] event emit failed:", err);
  }
}

// Default export: shim descriptor (if you want to register it dynamically)
export default {
  id: SHIM_ID,
  source: SHIM_SOURCE,
  kind: "calculator-shim",
  run: runGardenPlantingCalendarCalculatorShim
};
