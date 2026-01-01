// C:\Users\larho\suka-smart-assistant\src\features\calculators\calendar\ScripturalYearLengthCalculator\ScripturalYearLengthCalculator.shim.js

/**
 * ScripturalYearLengthCalculator.shim.js
 *
 * How this fits:
 * - This is a lightweight “shim” module for the Planning Graph.
 * - It consumes normalized calculator input (per ScripturalYearLengthCalculator.schema.json)
 *   and returns a structured year layout for downstream planners:
 *   - FeastDayAlignmentCalculator
 *   - garden/planting planners
 *   - preservation / storehouse planners
 *   - session generators for cooking/cleaning around high days.
 *
 * - It does NOT talk directly to UI; it is pure logic + event emission.
 * - It is safe to call from:
 *   - a Reasoner agent,
 *   - a PlanningGraph executor,
 *   - or any feature that wants year-length data.
 */

const MODULE_ID = "calendar.ScripturalYearLengthCalculator";

// Optional soft imports (defensive so shim never hard-crashes if modules move)
let eventBusEmit = null;
try {
  // eslint-disable-next-line global-require
  const bus = require("@/services/eventBus");
  eventBusEmit = typeof bus.emit === "function" ? bus.emit : null;
} catch {
  eventBusEmit = null;
}

/**
 * @template TInput
 * @typedef {Object} ReasonerShimRequest
 * @property {string} [id]          - Optional request id (for tracing).
 * @property {string} [source]      - Caller id (e.g. "planner.graph", "ui.debug").
 * @property {TInput} input         - Calculator input matching the schema.
 * @property {Object} [context]     - Optional execution context, e.g. { budgetMs, locale }.
 */

/**
 * @template TInput
 * @template TOutput
 * @typedef {Object} ReasonerShimResponse
 * @property {boolean} ok
 * @property {string|null} error
 * @property {string} moduleId
 * @property {TInput|null} input
 * @property {TOutput|null} output
 * @property {Object} meta
 */

/**
 * @typedef {Object} ScripturalYearLengthInput
 * @property {"solar"|"lunar"|"luniSolar"} cycleType
 * @property {number} referenceYear
 * @property {number} referenceMonth
 * @property {number} referenceDay
 * @property {"fullMoon"|"firstVisibleCrescent"|"conjunction"|"moonDoesNotCrossMeridian"} monthStartMethod
 * @property {boolean} [avivRuleEnabled]
 * @property {"auto"|"noLeap"|"forceLeap"} [intercalationRule]
 * @property {string} [baseMonthStartDate]    ISO date string
 * @property {{ lat:number, lon:number, tz:string }} [location]
 */

/**
 * @typedef {Object} ScripturalMonth
 * @property {number} index
 * @property {string} name
 * @property {string} startDate   ISO date
 * @property {string} endDate     ISO date
 * @property {number} days
 * @property {boolean} [isIntercalary]
 */

/**
 * @typedef {Object} ScripturalYearLengthOutput
 * @property {string} yearLabel
 * @property {number} daysInYear
 * @property {boolean} isLeapYear
 * @property {ScripturalMonth[]} months
 * @property {{
 *   yearStart: string,
 *   midYearMarker: string,
 *   yearEnd: string
 * }} anchorDates
 * @property {{
 *   computedAt?: string,
 *   sourceMonthStartMethod?: string,
 *   notes?: string
 * }} [meta]
 */

/**
 * Shim entrypoint.
 * This is the function the Planning Graph / Reasoner should call.
 *
 * @param {ReasonerShimRequest<ScripturalYearLengthInput>} request
 * @returns {Promise<ReasonerShimResponse<ScripturalYearLengthInput, ScripturalYearLengthOutput>>}
 */
async function runScripturalYearLengthCalculator(request) {
  const startedAt = new Date().toISOString();

  if (!request || typeof request !== "object") {
    return {
      ok: false,
      error: "INVALID_REQUEST",
      moduleId: MODULE_ID,
      input: null,
      output: null,
      meta: { startedAt, finishedAt: new Date().toISOString() }
    };
  }

  const input = request.input;

  try {
    const validationError = validateInput(input);
    if (validationError) {
      return {
        ok: false,
        error: validationError,
        moduleId: MODULE_ID,
        input,
        output: null,
        meta: { startedAt, finishedAt: new Date().toISOString() }
      };
    }

    const output = computeScripturalYearStructure(input);

    safeEmit("planningGraph.calculator.executed", {
      moduleId: MODULE_ID,
      ts: new Date().toISOString(),
      data: {
        input,
        output,
        requestId: request.id || null,
        source: request.source || null
      }
    });

    return {
      ok: true,
      error: null,
      moduleId: MODULE_ID,
      input,
      output,
      meta: {
        startedAt,
        finishedAt: new Date().toISOString()
      }
    };
  } catch (err) {
    safeEmit("planningGraph.calculator.error", {
      moduleId: MODULE_ID,
      ts: new Date().toISOString(),
      data: {
        message: err && err.message ? err.message : String(err),
        stack: err && err.stack ? err.stack : null,
        input
      }
    });

    return {
      ok: false,
      error: "INTERNAL_ERROR",
      moduleId: MODULE_ID,
      input,
      output: null,
      meta: { startedAt, finishedAt: new Date().toISOString() }
    };
  }
}

/**
 * Basic shape validation to avoid hard crashes inside the calculator logic.
 *
 * @param {ScripturalYearLengthInput} input
 * @returns {string|null}
 */
function validateInput(input) {
  if (!input) return "MISSING_INPUT";

  const requiredNums = ["referenceYear", "referenceMonth", "referenceDay"];
  for (const key of requiredNums) {
    if (typeof input[key] !== "number" || Number.isNaN(input[key])) {
      return `INVALID_${key.toUpperCase()}`;
    }
  }

  if (!["solar", "lunar", "luniSolar"].includes(input.cycleType)) {
    return "INVALID_CYCLE_TYPE";
  }

  if (
    ![
      "fullMoon",
      "firstVisibleCrescent",
      "conjunction",
      "moonDoesNotCrossMeridian"
    ].includes(input.monthStartMethod)
  ) {
    return "INVALID_MONTH_START_METHOD";
  }

  if (
    input.intercalationRule &&
    !["auto", "noLeap", "forceLeap"].includes(input.intercalationRule)
  ) {
    return "INVALID_INTERCALATION_RULE";
  }

  if (input.baseMonthStartDate) {
    const d = new Date(input.baseMonthStartDate);
    if (Number.isNaN(d.getTime())) {
      return "INVALID_BASE_MONTH_START_DATE";
    }
  }

  return null;
}

/**
 * Core calculator logic.
 * This is deliberately simple and deterministic:
 * - For solar years: 12 Gregorian-like months from the base start date.
 * - For lunar / luniSolar: 12 or 13 months of 29/30-day alternating pattern.
 *
 * All real astronomy is intentionally abstracted out; later you can swap
 * this with a more precise engine while keeping the same contract.
 *
 * @param {ScripturalYearLengthInput} input
 * @returns {ScripturalYearLengthOutput}
 */
function computeScripturalYearStructure(input) {
  const {
    cycleType,
    referenceYear,
    referenceMonth,
    referenceDay,
    monthStartMethod,
    avivRuleEnabled = true,
    intercalationRule = "auto",
    baseMonthStartDate
  } = input;

  const baseStart = resolveBaseStartDate(
    referenceYear,
    referenceMonth,
    referenceDay,
    baseMonthStartDate
  );

  const isLeapYear = determineLeapYearFlag(
    cycleType,
    intercalationRule,
    avivRuleEnabled
  );

  const months =
    cycleType === "solar"
      ? buildSolarMonths(baseStart)
      : buildLunarMonths(baseStart, cycleType, isLeapYear);

  const daysInYear = months.reduce((sum, m) => sum + m.days, 0);

  const yearStart = months[0].startDate;
  const yearEnd = months[months.length - 1].endDate;
  const midYearMarker = computeMidYearMarker(yearStart, yearEnd);

  const yearLabel = buildYearLabel(
    cycleType,
    referenceYear,
    months[0],
    isLeapYear
  );

  return {
    yearLabel,
    daysInYear,
    isLeapYear,
    months,
    anchorDates: {
      yearStart,
      midYearMarker,
      yearEnd
    },
    meta: {
      computedAt: new Date().toISOString(),
      sourceMonthStartMethod: monthStartMethod,
      notes: buildNotes(cycleType, intercalationRule, avivRuleEnabled)
    }
  };
}

/**
 * Resolve base start date from explicit override or reference anchor.
 *
 * @param {number} year
 * @param {number} month
 * @param {number} day
 * @param {string|undefined} baseMonthStartDate
 * @returns {Date}
 */
function resolveBaseStartDate(year, month, day, baseMonthStartDate) {
  if (baseMonthStartDate) {
    const d = new Date(baseMonthStartDate);
    if (!Number.isNaN(d.getTime())) return startOfDay(d);
  }

  return startOfDay(new Date(year, month - 1, day));
}

/**
 * Determine leap-year flag for scriptural logic.
 * This is intentionally simple:
 * - solar: never leap (handled by Gregorian month lengths)
 * - lunar: never leap (fixed 12 lunar months)
 * - luniSolar:
 *   - forceLeap => always leap
 *   - noLeap    => never leap
 *   - auto      => leap every 3rd year-ish as a simple stand-in pattern
 *
 * @param {"solar"|"lunar"|"luniSolar"} cycleType
 * @param {"auto"|"noLeap"|"forceLeap"} intercalationRule
 * @param {boolean} avivRuleEnabled
 * @returns {boolean}
 */
function determineLeapYearFlag(cycleType, intercalationRule, avivRuleEnabled) {
  if (cycleType === "solar") return false;
  if (cycleType === "lunar") return false;

  // luniSolar
  if (intercalationRule === "forceLeap") return true;
  if (intercalationRule === "noLeap") return false;

  // auto pattern:
  // simple 3-year approximation; you can wire a real rule later.
  if (!avivRuleEnabled) return false;

  const gregYear = new Date().getUTCFullYear();
  return gregYear % 3 === 0;
}

/**
 * Build “solar” scriptural months based on real Gregorian month lengths,
 * starting at the base start date and stepping forward 12 months.
 *
 * @param {Date} baseStart
 * @returns {ScripturalMonth[]}
 */
function buildSolarMonths(baseStart) {
  /** @type {ScripturalMonth[]} */
  const months = [];
  let cursor = new Date(baseStart);

  for (let i = 1; i <= 12; i += 1) {
    const start = new Date(cursor);
    const nextMonth = new Date(start.getFullYear(), start.getMonth() + 1, 1);
    const end = new Date(nextMonth.getTime() - 24 * 60 * 60 * 1000); // day before

    const days = Math.round(
      (end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)
    ) + 1;

    months.push({
      index: i,
      name: `Month ${i}`,
      startDate: toIsoDate(start),
      endDate: toIsoDate(end),
      days
    });

    cursor = nextMonth;
  }

  return months;
}

/**
 * Build “lunar / luniSolar” scriptural months with 29/30-day alternating pattern.
 * - baseline: 12 months
 * - leap year adds a 13th month
 *
 * @param {Date} baseStart
 * @param {"lunar"|"luniSolar"} cycleType
 * @param {boolean} isLeapYear
 * @returns {ScripturalMonth[]}
 */
function buildLunarMonths(baseStart, cycleType, isLeapYear) {
  const baseMonthCount = 12;
  const totalMonths = isLeapYear ? baseMonthCount + 1 : baseMonthCount;

  /** @type {ScripturalMonth[]} */
  const months = [];
  let cursor = new Date(baseStart);

  for (let i = 1; i <= totalMonths; i += 1) {
    const isEven = i % 2 === 0;
    const days = isEven ? 29 : 30; // simple 29/30 pattern

    const start = new Date(cursor);
    const end = new Date(start.getTime() + (days - 1) * 24 * 60 * 60 * 1000);

    const isIntercalary = isLeapYear && i === totalMonths;

    months.push({
      index: i,
      name: isIntercalary ? `Month ${i} (Leap)` : `Month ${i}`,
      startDate: toIsoDate(start),
      endDate: toIsoDate(end),
      days,
      isIntercalary
    });

    cursor = new Date(end.getTime() + 24 * 60 * 60 * 1000);
  }

  return months;
}

/**
 * Compute a mid-year marker as the halfway point between yearStart and yearEnd.
 *
 * @param {string} yearStartIso
 * @param {string} yearEndIso
 * @returns {string}
 */
function computeMidYearMarker(yearStartIso, yearEndIso) {
  const start = new Date(yearStartIso);
  const end = new Date(yearEndIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return yearStartIso;
  }

  const mid = new Date((start.getTime() + end.getTime()) / 2);
  return toIsoDate(mid);
}

/**
 * Build a friendly year label like:
 *   - "Solar Year 2026 starting Month 1 (2026-03-21)"
 *   - "LuniSolar Year 2026 (Leap) starting Month 1 (2026-03-30)"
 *
 * @param {"solar"|"lunar"|"luniSolar"} cycleType
 * @param {number} referenceYear
 * @param {ScripturalMonth} firstMonth
 * @param {boolean} isLeapYear
 * @returns {string}
 */
function buildYearLabel(cycleType, referenceYear, firstMonth, isLeapYear) {
  const typeLabel =
    cycleType === "solar"
      ? "Solar Year"
      : cycleType === "lunar"
      ? "Lunar Year"
      : "LuniSolar Year";

  const leapSuffix = isLeapYear ? " (Leap)" : "";
  return `${typeLabel} ${referenceYear}${leapSuffix} starting ${firstMonth.name} (${firstMonth.startDate})`;
}

/**
 * Build short human-readable notes about the rules in play.
 *
 * @param {"solar"|"lunar"|"luniSolar"} cycleType
 * @param {"auto"|"noLeap"|"forceLeap"} intercalationRule
 * @param {boolean} avivRuleEnabled
 * @returns {string}
 */
function buildNotes(cycleType, intercalationRule, avivRuleEnabled) {
  const parts = [
    `cycleType=${cycleType}`,
    `intercalationRule=${intercalationRule}`,
    `avivRuleEnabled=${avivRuleEnabled}`
  ];
  return parts.join("; ");
}

/**
 * Safe event emission helper.
 *
 * @param {string} type
 * @param {any} payload
 */
function safeEmit(type, payload) {
  if (!eventBusEmit) return;
  try {
    eventBusEmit({
      type,
      ts: new Date().toISOString(),
      source: MODULE_ID,
      data: payload
    });
  } catch {
    // swallow – calculators must never crash the app on telemetry failure
  }
}

/**
 * Normalize a date to start-of-day (local time).
 *
 * @param {Date} d
 * @returns {Date}
 */
function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Convert Date → ISO date string (YYYY-MM-DD).
 *
 * @param {Date} d
 * @returns {string}
 */
function toIsoDate(d) {
  const year = d.getFullYear();
  const month = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

module.exports = {
  MODULE_ID,
  runScripturalYearLengthCalculator,
  // Exported for unit testing / advanced usage if needed:
  _internals: {
    validateInput,
    computeScripturalYearStructure,
    resolveBaseStartDate,
    determineLeapYearFlag,
    buildSolarMonths,
    buildLunarMonths,
    computeMidYearMarker,
    buildYearLabel
  }
};
