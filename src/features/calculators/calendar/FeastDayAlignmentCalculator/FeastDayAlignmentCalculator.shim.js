// C:\Users\larho\suka-smart-assistant\src\features\calculators\calendar\FeastDayAlignmentCalculator\FeastDayAlignmentCalculator.shim.js

/**
 * Feast Day Alignment Calculator Shim
 *
 * How this fits:
 * - Input: baseMonthStartData (from HebrewMonthStartCalendar) + year + method flags.
 * - Output: concrete Gregorian dates for the major (and optional minor) feasts,
 *   plus hints about which SSA domains should prepare sessions (cooking, cleaning,
 *   storehouse, animals, preservation, garden).
 * - This shim is pure logic and can be called by the Planning Graph engine,
 *   UI components, or automation/runtime layers.
 */

import { emit } from "@/services/eventBus";

/** @typedef {import("./FeastDayAlignmentCalculator.schema.json")} FeastSchemaType */
/** @typedef {import("./FeastDayAlignmentCalculator.schema.json").input} FeastAlignmentInput */
/** @typedef {import("./FeastDayAlignmentCalculator.schema.json").output} FeastAlignmentOutput */

const SHIM_SOURCE = "features/calculators/calendar/FeastDayAlignmentCalculator";

/**
 * Canonical feast templates used for computing Gregorian dates.
 * These are intentionally simple and can be extended later.
 * All month indices are 1-based Hebrew months within the user's system.
 */
const FEAST_TEMPLATES = [
  {
    code: "PESACH",
    label: "Pesach (Passover)",
    category: "pilgrimage",
    hebrewMonthIndex: 1, // Aviv / Nisan
    hebrewDay: 14,
    hebrewSpanDays: 1,
    requiresPrepSession: true,
    prepSessionHints: ["cooking", "storehouse", "cleaning"],
  },
  {
    code: "MATZOT",
    label: "Feast of Unleavened Bread",
    category: "pilgrimage",
    hebrewMonthIndex: 1,
    hebrewDay: 15,
    hebrewSpanDays: 7,
    requiresPrepSession: true,
    prepSessionHints: ["cooking", "storehouse", "cleaning"],
  },
  {
    code: "FIRSTFRUITS",
    label: "Firstfruits",
    category: "appointedTime",
    hebrewMonthIndex: 1,
    hebrewDay: 16,
    hebrewSpanDays: 1,
    requiresPrepSession: true,
    prepSessionHints: ["garden", "storehouse"],
  },
  {
    code: "SHAVUOT",
    label: "Shavuot (Weeks)",
    category: "pilgrimage",
    hebrewMonthIndex: 3,
    hebrewDay: 6,
    hebrewSpanDays: 1,
    requiresPrepSession: true,
    prepSessionHints: ["cooking", "storehouse", "garden"],
  },
  {
    code: "YOM_TERUAH",
    label: "Yom Teruah (Trumpets)",
    category: "sabbath",
    hebrewMonthIndex: 7,
    hebrewDay: 1,
    hebrewSpanDays: 1,
    requiresPrepSession: true,
    prepSessionHints: ["cooking", "storehouse", "cleaning"],
  },
  {
    code: "YOM_KIPPUR",
    label: "Yom Kippur (Atonement)",
    category: "sabbath",
    hebrewMonthIndex: 7,
    hebrewDay: 10,
    hebrewSpanDays: 1,
    requiresPrepSession: true,
    prepSessionHints: ["storehouse", "cleaning"],
  },
  {
    code: "SUKKOT",
    label: "Sukkot (Tabernacles)",
    category: "pilgrimage",
    hebrewMonthIndex: 7,
    hebrewDay: 15,
    hebrewSpanDays: 7,
    requiresPrepSession: true,
    prepSessionHints: ["cooking", "storehouse", "garden", "animals", "preservation"],
  },
  {
    code: "SHEMINI_ATZERET",
    label: "Shemini Atzeret",
    category: "appointedTime",
    hebrewMonthIndex: 7,
    hebrewDay: 22,
    hebrewSpanDays: 1,
    requiresPrepSession: true,
    prepSessionHints: ["cooking", "storehouse"],
  },
];

/**
 * Optional “minor” feasts that are only included when includeMinorFeasts = true.
 */
const MINOR_FEAST_TEMPLATES = [
  {
    code: "PURIM",
    label: "Purim",
    category: "memorial",
    hebrewMonthIndex: 12,
    hebrewDay: 14,
    hebrewSpanDays: 1,
    requiresPrepSession: false,
    prepSessionHints: ["cooking", "storehouse"],
  },
  {
    code: "HANUKKAH",
    label: "Hanukkah",
    category: "memorial",
    hebrewMonthIndex: 9,
    hebrewDay: 25,
    hebrewSpanDays: 8,
    requiresPrepSession: false,
    prepSessionHints: ["cooking", "storehouse"],
  },
];

/**
 * Run the Feast Day Alignment calculator.
 *
 * @param {FeastAlignmentInput} input
 * @returns {Promise<FeastAlignmentOutput>}
 */
export async function runFeastDayAlignmentCalculator(input) {
  const ts = new Date().toISOString();
  emit({
    type: "calculator.invoked",
    ts,
    source: SHIM_SOURCE,
    data: { calculatorId: "FeastDayAlignmentCalculator", inputSummary: summarizeInput(input) },
  });

  const safeInput = normalizeInput(input);
  const feasts = computeFeastAlignments(safeInput);

  /** @type {FeastAlignmentOutput} */
  const result = {
    gregorianYear: safeInput.gregorianYear,
    hebrewYear: safeInput.hebrewYear,
    monthStartMethod: safeInput.monthStartMethod,
    feasts,
  };

  emit({
    type: "calculator.completed",
    ts: new Date().toISOString(),
    source: SHIM_SOURCE,
    data: {
      calculatorId: "FeastDayAlignmentCalculator",
      gregorianYear: result.gregorianYear,
      hebrewYear: result.hebrewYear,
      feastCount: result.feasts.length,
    },
  });

  return result;
}

/**
 * Normalizes and defensively validates the input payload.
 *
 * @param {FeastAlignmentInput} raw
 * @returns {FeastAlignmentInput}
 */
function normalizeInput(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("FeastDayAlignmentCalculator: input must be an object.");
  }

  if (!Number.isInteger(raw.gregorianYear)) {
    throw new Error("FeastDayAlignmentCalculator: gregorianYear must be an integer.");
  }

  if (!Array.isArray(raw.baseMonthStartData) || raw.baseMonthStartData.length === 0) {
    throw new Error(
      "FeastDayAlignmentCalculator: baseMonthStartData must be a non-empty array from HebrewMonthStartCalendar."
    );
  }

  const monthStartMethod =
    raw.monthStartMethod ||
    /** @type {FeastAlignmentInput["monthStartMethod"]} */ ("fullMoon");

  const timezone = raw.timezone || "UTC";

  // Attempt to derive hebrewYear if not provided
  const derivedHebrewYear =
    raw.hebrewYear ||
    (raw.baseMonthStartData[0] && Number.isInteger(raw.baseMonthStartData[0].hebrewYear)
      ? raw.baseMonthStartData[0].hebrewYear
      : raw.gregorianYear);

  return {
    gregorianYear: raw.gregorianYear,
    hebrewYear: derivedHebrewYear,
    monthStartMethod,
    baseMonthStartData: raw.baseMonthStartData,
    includeMinorFeasts: Boolean(raw.includeMinorFeasts),
    timezone,
  };
}

/**
 * Compute the aligned feast dates given normalized input.
 *
 * @param {FeastAlignmentInput} input
 * @returns {FeastAlignmentOutput["feasts"]}
 */
function computeFeastAlignments(input) {
  const {
    baseMonthStartData,
    includeMinorFeasts,
    monthStartMethod,
    hebrewYear,
    timezone,
  } = input;

  const monthStartByIndex = buildMonthStartIndex(baseMonthStartData, hebrewYear);

  const templates = includeMinorFeasts
    ? FEAST_TEMPLATES.concat(MINOR_FEAST_TEMPLATES)
    : FEAST_TEMPLATES.slice();

  const results = [];

  for (const tpl of templates) {
    const monthStart = monthStartByIndex.get(tpl.hebrewMonthIndex);

    if (!monthStart) {
      // Skip if we cannot resolve the month start for this feast
      results.push({
        code: tpl.code,
        label: tpl.label,
        category: tpl.category,
        hebrewMonthIndex: tpl.hebrewMonthIndex,
        hebrewDay: tpl.hebrewDay,
        hebrewSpanDays: tpl.hebrewSpanDays,
        gregorianStartDate: null,
        gregorianEndDate: null,
        requiresPrepSession: tpl.requiresPrepSession,
        prepSessionHints: tpl.prepSessionHints,
        notes:
          "Month start data missing for this feast's Hebrew month index. Check HebrewMonthStartCalendar configuration.",
      });
      continue;
    }

    const startDate = addDays(parseISODate(monthStart.gregorianStartDate), tpl.hebrewDay - 1);
    const endDate = addDays(startDate, tpl.hebrewSpanDays - 1);

    results.push({
      code: tpl.code,
      label: tpl.label,
      category: tpl.category,
      hebrewMonthIndex: tpl.hebrewMonthIndex,
      hebrewDay: tpl.hebrewDay,
      hebrewSpanDays: tpl.hebrewSpanDays,
      gregorianStartDate: toISODateString(startDate),
      gregorianEndDate: toISODateString(endDate),
      requiresPrepSession: tpl.requiresPrepSession,
      prepSessionHints: tpl.prepSessionHints,
      notes: buildNotes(tpl, monthStart, monthStartMethod, timezone),
    });
  }

  return results;
}

/**
 * Build a map from hebrewMonthIndex -> month start info.
 *
 * @param {FeastAlignmentInput["baseMonthStartData"]} baseMonthStartData
 * @param {number} hebrewYear
 */
function buildMonthStartIndex(baseMonthStartData, hebrewYear) {
  const map = new Map();
  for (const item of baseMonthStartData) {
    if (!item || typeof item !== "object") continue;
    if (!Number.isInteger(item.hebrewMonthIndex)) continue;
    if (item.hebrewYear !== hebrewYear) continue;
    if (typeof item.gregorianStartDate !== "string") continue;

    map.set(item.hebrewMonthIndex, item);
  }
  return map;
}

/**
 * Build a human-oriented notes string for each feast.
 *
 * @param {typeof FEAST_TEMPLATES[0]} tpl
 * @param {{hebrewMonthIndex:number; gregorianStartDate:string; hebrewYear:number}} monthStart
 * @param {FeastAlignmentInput["monthStartMethod"]} monthStartMethod
 * @param {string} timezone
 * @returns {string}
 */
function buildNotes(tpl, monthStart, monthStartMethod, timezone) {
  const parts = [];
  parts.push(
    `Aligned using method '${monthStartMethod}' from month ${monthStart.hebrewMonthIndex} day ${tpl.hebrewDay}.`
  );
  parts.push(`Hebrew year: ${monthStart.hebrewYear}.`);
  parts.push(`Base month start date: ${monthStart.gregorianStartDate} (${timezone}).`);

  if (tpl.requiresPrepSession) {
    parts.push(
      `Recommended: begin preparation in the indicated domains (${tpl.prepSessionHints.join(
        ", "
      )}) a few days before the feast start date.`
    );
  }

  return parts.join(" ");
}

/**
 * Safe ISO date parser (YYYY-MM-DD).
 *
 * @param {string} isoDate
 * @returns {Date}
 */
function parseISODate(isoDate) {
  // Expect "YYYY-MM-DD"
  const d = new Date(isoDate + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) {
    throw new Error(`FeastDayAlignmentCalculator: invalid date '${isoDate}'.`);
  }
  return d;
}

/**
 * Add days to a Date, returning a new Date.
 *
 * @param {Date} date
 * @param {number} days
 * @returns {Date}
 */
function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/**
 * Convert Date to YYYY-MM-DD string.
 *
 * @param {Date} date
 * @returns {string}
 */
function toISODateString(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Compact summary for telemetry.
 *
 * @param {FeastAlignmentInput} input
 */
function summarizeInput(input) {
  return {
    gregorianYear: input?.gregorianYear ?? null,
    hebrewYear: input?.hebrewYear ?? null,
    monthStartMethod: input?.monthStartMethod ?? null,
    monthStartCount: Array.isArray(input?.baseMonthStartData)
      ? input.baseMonthStartData.length
      : 0,
    includeMinorFeasts: Boolean(input?.includeMinorFeasts),
  };
}

export default {
  id: "FeastDayAlignmentCalculator",
  run: runFeastDayAlignmentCalculator,
  source: SHIM_SOURCE,
};
