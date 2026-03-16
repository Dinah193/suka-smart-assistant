// C:\Users\larho\suka-smart-assistant\src\features\calculators\calendar\HebrewMonthStartCalendar\HebrewMonthStartCalendar.shim.js

/**
 * HebrewMonthStartCalendar Shim
 *
 * How this fits:
 * - This is a Planning Graph *calculator shim* for SSA.
 * - It takes astronomical/calendar options (rulePresetId, location, year, etc.)
 *   and produces a list of Hebrew month start dates + summary.
 * - Outputs are shaped according to HebrewMonthStartCalendar.schema.json.
 * - Results can be consumed by:
 *   - Calendar UI (month grid)
 *   - Feast planner
 *   - Storehouse planning (aligns sessions and batch cooking with feast cycle)
 *   - SessionRunner “Now” flows for feast prep & holy day routines
 *
 * This shim is intentionally conservative and uses a simple lunar-approximation
 * (29/30-day cycle) plus a configurable window. A future astro module can replace
 * `generateHebrewMonths()` with real sun/moon/star computations without changing
 * the external contract.
 */

import { emit } from "@/services/events/eventBus";
import { familyFundMode } from "@/config/featureFlags";

// Optional hub helpers – if your project already wires these differently,
// you can safely adjust or no-op the export function below.
import { HubPacketFormatter } from "@/services/hub/HubPacketFormatter";
import { FamilyFundConnector } from "@/services/hub/FamilyFundConnector";

/**
 * @typedef {Object} HebrewMonthStartInputs
 * @property {"fullMoon"|"newMoonAstronomical"|"firstVisibleCrescent"|"noMeridianCrossing"} rulePresetId
 * @property {{ lat: number, lon: number, tz: string }} location
 * @property {number} gregorianYear
 * @property {string} [epochStartDate]  // YYYY-MM-DD
 * @property {string} [epochEndDate]    // YYYY-MM-DD
 * @property {{
 *   allowThirteenthMonth?: boolean,
 *   includeStarCheck?: boolean,
 *   maxMonthCount?: number
 * }} [options]
 *
 * @typedef {Object} HebrewMonthStartOutputsMonth
 * @property {number} monthIndex
 * @property {string} gregorianStartDate
 * @property {"fullMoon"|"newMoonAstronomical"|"firstVisibleCrescent"|"noMeridianCrossing"} rulePresetId
 * @property {{ lat: number, lon: number, tz: string }} location
 * @property {string[]} [flags]
 * @property {string} [notes]
 *
 * @typedef {Object} HebrewMonthStartOutputsSummary
 * @property {number} [firstMonthIndex]
 * @property {number} [lastMonthIndex]
 * @property {string} [firstGregorianDate]
 * @property {string} [lastGregorianDate]
 * @property {"fullMoon"|"newMoonAstronomical"|"firstVisibleCrescent"|"noMeridianCrossing"} [rulePresetId]
 *
 * @typedef {Object} HebrewMonthStartOutputs
 * @property {HebrewMonthStartOutputsMonth[]} months
 * @property {HebrewMonthStartOutputsSummary} [summary]
 *
 * @typedef {Object} ShimContext
 * @property {string} [householdId]
 * @property {string} [requestId]
 * @property {string} [invokedBy]     // e.g. "calendar.ui", "api", "batch-job"
 * @property {string} [source]        // freeform tag for origin
 * @property {boolean} [debug]
 *
 * @typedef {Object} ShimRequest
 * @property {string} calculatorId    // should be "calendar.hebrewMonthStart"
 * @property {string} nodeKey         // planning graph node key
 * @property {HebrewMonthStartInputs} inputs
 * @property {ShimContext} [context]
 *
 * @typedef {Object} ShimResponse
 * @property {boolean} ok
 * @property {string} calculatorId
 * @property {string} nodeKey
 * @property {HebrewMonthStartInputs} inputs
 * @property {HebrewMonthStartOutputs|null} outputs
 * @property {{ calculatedAt: string, source?: string, warnings?: string[] }} metadata
 * @property {{ code: string, message: string }|null} error
 */

/**
 * Main entrypoint for the Hebrew Month Start calculator shim.
 *
 * @param {ShimRequest} request
 * @returns {Promise<ShimResponse>}
 */
export async function runHebrewMonthStartCalendarShim(request) {
  const ts = new Date().toISOString();
  const warnings = [];

  // Basic defensive validation
  if (!request || typeof request !== "object") {
    return {
      ok: false,
      calculatorId: "calendar.hebrewMonthStart",
      nodeKey:
        request && request.nodeKey
          ? request.nodeKey
          : "calendar.hebrewMonthStart",
      inputs: /** @type {any} */ ({}),
      outputs: null,
      metadata: {
        calculatedAt: ts,
        warnings: ["Shim invoked with empty or invalid request object."],
      },
      error: {
        code: "INVALID_REQUEST",
        message: "HebrewMonthStartCalendar shim requires a request object.",
      },
    };
  }

  const {
    calculatorId = "calendar.hebrewMonthStart",
    nodeKey,
    inputs,
    context = {},
  } = request;

  const safeNodeKey = nodeKey || "calendar.hebrewMonthStart";

  emitSafe("planningGraph.calculator.invoked", {
    calculatorId,
    nodeKey: safeNodeKey,
    inputs,
    context,
  });

  // Validate calculatorId (soft)
  if (calculatorId !== "calendar.hebrewMonthStart") {
    warnings.push(
      `calculatorId was '${calculatorId}', expected 'calendar.hebrewMonthStart'. Proceeding anyway.`
    );
  }

  // Validate minimal inputs
  const validationError = validateInputs(inputs);
  if (validationError) {
    const response = {
      ok: false,
      calculatorId: "calendar.hebrewMonthStart",
      nodeKey: safeNodeKey,
      inputs,
      outputs: null,
      metadata: {
        calculatedAt: ts,
        source: context.source || "HebrewMonthStartCalendar.shim",
        warnings: [...warnings, validationError],
      },
      error: {
        code: "INVALID_INPUTS",
        message: validationError,
      },
    };

    emitSafe("planningGraph.calculator.failed", {
      calculatorId,
      nodeKey: safeNodeKey,
      inputs,
      error: response.error,
      metadata: response.metadata,
    });

    return response;
  }

  // Compute window + months
  const window = computePlanningWindow(inputs);
  const outputs = generateHebrewMonths(inputs, window, warnings);

  const metadata = {
    calculatedAt: ts,
    source: context.source || "HebrewMonthStartCalendar.shim",
    warnings,
  };

  const response = {
    ok: true,
    calculatorId: "calendar.hebrewMonthStart",
    nodeKey: safeNodeKey,
    inputs,
    outputs,
    metadata,
    error: null,
  };

  emitSafe("planningGraph.calculator.completed", {
    calculatorId,
    nodeKey: safeNodeKey,
    inputs,
    outputs,
    metadata,
  });

  // Optional Hub export when familyFundMode is enabled
  if (familyFundMode) {
    exportToHubIfEnabled({
      calculatorId: "calendar.hebrewMonthStart",
      nodeKey: safeNodeKey,
      inputs,
      outputs,
      metadata,
      context,
    });
  }

  return response;
}

/**
 * Validate input object according to the HebrewMonthStartCalendar.schema.json
 *
 * @param {HebrewMonthStartInputs} inputs
 * @returns {string|undefined} errorMessage
 */
function validateInputs(inputs) {
  if (!inputs || typeof inputs !== "object") {
    return "inputs object is required.";
  }

  const { rulePresetId, location, gregorianYear } = inputs;

  const allowedRules = [
    "fullMoon",
    "newMoonAstronomical",
    "firstVisibleCrescent",
    "noMeridianCrossing",
  ];

  if (!allowedRules.includes(rulePresetId)) {
    return `rulePresetId must be one of ${allowedRules.join(", ")}.`;
  }

  if (!location || typeof location !== "object") {
    return "location (lat, lon, tz) is required.";
  }

  if (typeof location.lat !== "number" || typeof location.lon !== "number") {
    return "location.lat and location.lon must be numbers.";
  }

  if (!location.tz || typeof location.tz !== "string") {
    return "location.tz must be a valid timezone string (e.g. 'America/Chicago').";
  }

  if (
    typeof gregorianYear !== "number" ||
    !Number.isInteger(gregorianYear) ||
    gregorianYear < 1900 ||
    gregorianYear > 2500
  ) {
    return "gregorianYear must be an integer between 1900 and 2500.";
  }

  return undefined;
}

/**
 * Determine the planning window (start/end Gregorian dates) used for month generation.
 *
 * @param {HebrewMonthStartInputs} inputs
 * @returns {{ start: Date, end: Date }}
 */
function computePlanningWindow(inputs) {
  const { gregorianYear, epochStartDate, epochEndDate } = inputs;

  let start;
  let end;

  if (epochStartDate) {
    const s = new Date(epochStartDate + "T00:00:00");
    if (!isNaN(s.getTime())) {
      start = s;
    }
  }

  if (epochEndDate) {
    const e = new Date(epochEndDate + "T23:59:59");
    if (!isNaN(e.getTime())) {
      end = e;
    }
  }

  // Fallbacks if not provided or invalid
  if (!start) {
    start = new Date(gregorianYear, 0, 1, 0, 0, 0);
  }

  if (!end) {
    // End is the first moment of next year; we’ll use < end comparison.
    end = new Date(gregorianYear + 1, 0, 1, 0, 0, 0);
  }

  // Safety: ensure start < end
  if (start >= end) {
    // Swap or expand by default 365-day window from start
    const tmp = new Date(start.getTime());
    tmp.setDate(tmp.getDate() + 365);
    end = tmp;
  }

  return { start, end };
}

/**
 * Approximate generation of Hebrew month start dates.
 *
 * NOTE: This is a placeholder lunar approximation:
 * - Uses alternating 30/29 day months (starting with 30).
 * - Respects options.maxMonthCount and allowThirteenthMonth.
 * - Applies the same rulePresetId across all months for now.
 * - Marks each month with "approximate" flag to signal non-astronomical output.
 *
 * Later, real astronomical logic can replace this implementation without
 * changing the surrounding shim contract.
 *
 * @param {HebrewMonthStartInputs} inputs
 * @param {{ start: Date, end: Date }} window
 * @param {string[]} warnings
 * @returns {HebrewMonthStartOutputs}
 */
function generateHebrewMonths(inputs, window, warnings) {
  const { rulePresetId, location, options = {} } = inputs;

  const allowThirteenthMonth =
    typeof options.allowThirteenthMonth === "boolean"
      ? options.allowThirteenthMonth
      : true;

  const maxMonthCount = Math.min(
    Math.max(options.maxMonthCount || 13, 12),
    allowThirteenthMonth ? 13 : 12
  );

  /** @type {HebrewMonthStartOutputsMonth[]} */
  const months = [];

  let current = new Date(window.start.getTime());
  let monthIndex = 1;
  let toggleLongMonth = true; // 30, then 29, etc.

  while (monthIndex <= maxMonthCount && current < window.end) {
    const dateStr = toISODate(current);

    months.push({
      monthIndex,
      gregorianStartDate: dateStr,
      rulePresetId,
      location: {
        lat: location.lat,
        lon: location.lon,
        tz: location.tz,
      },
      flags: ["approximate"],
      notes:
        "Approximate lunar month start (29/30-day cycle). Replace with precise astronomical calculation when the astro module is available.",
    });

    // Advance current date by 30 or 29 days alternately
    const stepDays = toggleLongMonth ? 30 : 29;
    toggleLongMonth = !toggleLongMonth;

    current = addDays(current, stepDays);
    monthIndex++;
  }

  if (months.length === 0) {
    warnings.push("No months were generated within the requested window.");
  }

  const summary = buildSummaryFromMonths(months, rulePresetId);

  return { months, summary };
}

/**
 * Build convenient summary from generated months.
 *
 * @param {HebrewMonthStartOutputsMonth[]} months
 * @param {"fullMoon"|"newMoonAstronomical"|"firstVisibleCrescent"|"noMeridianCrossing"} rulePresetId
 * @returns {HebrewMonthStartOutputsSummary}
 */
function buildSummaryFromMonths(months, rulePresetId) {
  if (!months.length) {
    return {};
  }

  const first = months[0];
  const last = months[months.length - 1];

  return {
    firstMonthIndex: first.monthIndex,
    lastMonthIndex: last.monthIndex,
    firstGregorianDate: first.gregorianStartDate,
    lastGregorianDate: last.gregorianStartDate,
    rulePresetId,
  };
}

/**
 * Safe wrapper for emitting events to SSA's event bus.
 *
 * @param {string} type
 * @param {any} data
 */
function emitSafe(type, data) {
  try {
    emit({
      type,
      ts: new Date().toISOString(),
      source: "calculators/calendar/HebrewMonthStartCalendar",
      data,
    });
  } catch {
    // Silent fail – shim should never crash the app due to telemetry
  }
}

/**
 * Best-effort hub export. If hub wiring isn’t present, this no-ops.
 *
 * @param {object} payload
 */
function exportToHubIfEnabled(payload) {
  try {
    if (!familyFundMode || !HubPacketFormatter || !FamilyFundConnector) {
      return;
    }

    const packet = HubPacketFormatter.formatCalculatorRun({
      calculatorId: payload.calculatorId,
      nodeKey: payload.nodeKey,
      domain: "storehouse",
      inputs: payload.inputs,
      outputs: payload.outputs,
      metadata: payload.metadata,
      context: payload.context,
    });

    FamilyFundConnector.exportCalculatorResult(packet).catch(() => {
      // Intentionally ignore hub export errors; SSA must remain local-first.
    });
  } catch {
    // Swallow hub errors; they should never break local calculations.
  }
}

/**
 * Add days to a Date without mutating the original.
 *
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
 * Format a Date as YYYY-MM-DD.
 *
 * @param {Date} date
 * @returns {string}
 */
function toISODate(date) {
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  return `${year}-${month}-${day}`;
}

/**
 * Left-pad integer to 2-digit string.
 *
 * @param {number} n
 * @returns {string}
 */
function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

export default runHebrewMonthStartCalendarShim;
