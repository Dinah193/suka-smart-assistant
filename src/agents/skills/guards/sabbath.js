/**
 * @file src/agents/skills/guards/sabbath.js
 *
 * Sabbath rule check for Suka Smart Assistant (SSA).
 *
 * HOW THIS FITS:
 * - This module is a small, focused helper that decides whether “right now”
 *   falls inside the Sabbath window.
 * - It is used by:
 *   - the Sabbath guard in `guardsEvaluate.js` (which consumes a simple
 *     `env.isSabbath` boolean), and
 *   - any higher-level automation that must avoid starting sessions during
 *     Sabbath (e.g., scheduling, “Now” resolvers).
 *
 * DESIGN:
 * - Configurable modes:
 *   1. `fixedClock` (default): Friday evening → Saturday night by fixed hours.
 *   2. `sunsetToSunset`: Use precomputed sunset times (e.g., from your
 *      Hebrew calendar engine / timeanddate.com integration).
 * - Defensive fallbacks:
 *   - If config is missing/invalid, we fall back to a simple “all day
 *     Saturday is Sabbath” rule.
 * - Non-UI:
 *   - This file does not show any UI.
 *   - It emits a telemetry-style `sabbath.evaluated` event on the eventBus
 *     for debugging/analytics (optional).
 */

import { emit } from '../../../services/eventBus';

/**
 * @typedef {'fixedClock'|'sunsetToSunset'} SabbathMode
 */

/**
 * Fixed-clock Sabbath configuration.
 *
 * Example:
 * {
 *   mode: 'fixedClock',
 *   sabbathStartDay: 5,   // Friday (0 = Sunday)
 *   sabbathEndDay: 6,     // Saturday
 *   startHour: 18,        // 6:00 PM local
 *   startMinute: 0,
 *   endHour: 21,          // 9:00 PM local Saturday
 *   endMinute: 0
 * }
 *
 * @typedef {Object} FixedClockConfig
 * @property {SabbathMode} mode
 * @property {number} [sabbathStartDay] Day of week (0–6; default 5 = Friday)
 * @property {number} [sabbathEndDay] Day of week (0–6; default 6 = Saturday)
 * @property {number} [startHour] Local hour when Sabbath begins (0–23; default 18)
 * @property {number} [startMinute] Local minute when Sabbath begins (0–59; default 0)
 * @property {number} [endHour] Local hour when Sabbath ends (0–23; default 21)
 * @property {number} [endMinute] Local minute when Sabbath ends (0–59; default 0)
 */

/**
 * Sunset-based Sabbath configuration.
 *
 * You are expected to pass precomputed sunset times (ISO strings) for
 * specific Gregorian dates. These can come from your Hebrew calendar engine
 * that already integrates with timeanddate.com, etc.
 *
 * Example:
 * {
 *   mode: 'sunsetToSunset',
 *   sunsetByDate: {
 *     '2025-11-14': '2025-11-14T17:03:00-06:00', // Friday sunset
 *     '2025-11-15': '2025-11-15T17:02:00-06:00'  // Saturday sunset
 *   }
 * }
 *
 * NOTE:
 * - Keys must be in local YYYY-MM-DD format (they should match `getLocalDateKey`).
 * - The value should be an ISO 8601 string for the **local** sunset time.
 *
 * @typedef {Object} SunsetConfig
 * @property {SabbathMode} mode
 * @property {Record<string, string>} sunsetByDate
 */

/**
 * High-level Sabbath configuration.
 *
 * @typedef {Object} SabbathConfig
 * @property {boolean} [enabled] Global toggle; defaults to true
 * @property {SabbathMode} [mode] 'fixedClock' or 'sunsetToSunset'
 * @property {FixedClockConfig} [fixedClock] Fixed-clock settings
 * @property {SunsetConfig} [sunset] Sunset-to-sunset settings
 */

/**
 * Result of a Sabbath evaluation.
 *
 * @typedef {Object} SabbathEvaluationResult
 * @property {boolean} isSabbath        True if now is inside Sabbath window
 * @property {string|null} windowStart  ISO string for Sabbath start (if known)
 * @property {string|null} windowEnd    ISO string for Sabbath end (if known)
 * @property {string} reasonCode        'disabled'|'fixedClock.inWindow'|'fixedClock.outside'|'sunset.inWindow'|'sunset.outside'|'fallback.saturday'|'fallback.unknown'
 * @property {string[]} warnings        Non-fatal config or data issues
 */

/**
 * Evaluate whether it is currently Sabbath, using the given configuration.
 *
 * Basic usage:
 * ```js
 * const { isSabbath } = evaluateSabbath();
 * // or
 * const { isSabbath } = evaluateSabbath({ mode: 'fixedClock' });
 * ```
 *
 * With sunset data:
 * ```js
 * const result = evaluateSabbath({
 *   mode: 'sunsetToSunset',
 *   sunset: {
 *     mode: 'sunsetToSunset',
 *     sunsetByDate: {
 *       '2025-11-14': '2025-11-14T17:03:00-06:00',
 *       '2025-11-15': '2025-11-15T17:02:00-06:00'
 *     }
 *   }
 * });
 * ```
 *
 * @param {SabbathConfig} [config]
 * @param {Date} [now] Optional current time override (for tests)
 * @returns {SabbathEvaluationResult}
 */
export function evaluateSabbath(config = {}, now = new Date()) {
  /** @type {SabbathEvaluationResult} */
  const baseResult = {
    isSabbath: false,
    windowStart: null,
    windowEnd: null,
    reasonCode: 'fallback.unknown',
    warnings: []
  };

  if (!config || typeof config !== 'object') {
    const res = applyFallbackSaturdayRule(baseResult, now, 'Config missing or not an object.');
    safeEmitSabbathEvaluated(res);
    return res;
  }

  const enabled = typeof config.enabled === 'boolean' ? config.enabled : true;
  if (!enabled) {
    const res = {
      ...baseResult,
      isSabbath: false,
      reasonCode: 'disabled'
    };
    safeEmitSabbathEvaluated(res);
    return res;
  }

  const mode = config.mode === 'sunsetToSunset' || config.mode === 'fixedClock'
    ? config.mode
    : 'fixedClock';

  let result;
  if (mode === 'sunsetToSunset' && config.sunset && isValidSunsetConfig(config.sunset)) {
    result = evaluateSunsetMode(config.sunset, now, baseResult);
  } else if (mode === 'sunsetToSunset') {
    // Mode says sunset, but config is invalid: log a warning + fallback.
    result = applyFallbackSaturdayRule(
      baseResult,
      now,
      'Sunset mode requested but sunset config is missing or invalid; using Saturday fallback.'
    );
  } else {
    // fixedClock (default)
    result = evaluateFixedClockMode(config.fixedClock, now, baseResult);
  }

  safeEmitSabbathEvaluated(result);
  return result;
}

/**
 * Simple convenience wrapper that returns only a boolean.
 *
 * @param {SabbathConfig} [config]
 * @param {Date} [now]
 * @returns {boolean}
 */
export function isSabbathNow(config, now) {
  return evaluateSabbath(config, now).isSabbath;
}

/* -------------------------------------------------------------------------- */
/*  Fixed Clock Sabbath: Friday evening → Saturday night (configurable)       */
/* -------------------------------------------------------------------------- */

/**
 * Evaluate Sabbath using fixed-clock rules.
 *
 * @param {FixedClockConfig|undefined} fixedCfg
 * @param {Date} now
 * @param {SabbathEvaluationResult} baseResult
 * @returns {SabbathEvaluationResult}
 */
function evaluateFixedClockMode(fixedCfg, now, baseResult) {
  const res = { ...baseResult };

  const cfg = normalizeFixedClockConfig(fixedCfg);
  const localDay = now.getDay(); // 0 = Sunday
  const hour = now.getHours();
  const minute = now.getMinutes();

  // Build approximate window start/end as ISO for debugging/analytics
  const { startDate, endDate } = deriveFixedWindowDates(now, cfg);
  const windowStart = buildLocalDateWithTime(startDate, cfg.startHour, cfg.startMinute);
  const windowEnd = buildLocalDateWithTime(endDate, cfg.endHour, cfg.endMinute);

  res.windowStart = windowStart.toISOString();
  res.windowEnd = windowEnd.toISOString();

  const withinWindow = now >= windowStart && now < windowEnd;

  // If not strictly using start/end windows, you may also want to
  // permit all of Saturday as Sabbath. The window check already
  // covers most cases; localDay checks are more for human intuition.
  if (withinWindow) {
    res.isSabbath = true;
    res.reasonCode = 'fixedClock.inWindow';
    return res;
  }

  // Fallback: entire Sabbath end day is Sabbath if you want to be generous.
  if (localDay === cfg.sabbathEndDay) {
    res.isSabbath = true;
    res.reasonCode = 'fixedClock.inWindow';
    res.warnings.push(
      'Now is outside the configured fixed-clock window but on the Sabbath end day; treating as Sabbath.'
    );
    return res;
  }

  res.isSabbath = false;
  res.reasonCode = 'fixedClock.outside';
  return res;
}

/**
 * Normalize fixed-clock config with safe defaults.
 *
 * @param {FixedClockConfig|undefined} cfg
 * @returns {Required<FixedClockConfig>}
 */
function normalizeFixedClockConfig(cfg) {
  const safe = cfg || /** @type {FixedClockConfig} */ ({ mode: 'fixedClock' });

  const sabbathStartDay = isValidDayIndex(safe.sabbathStartDay) ? safe.sabbathStartDay : 5; // Friday
  const sabbathEndDay = isValidDayIndex(safe.sabbathEndDay) ? safe.sabbathEndDay : 6; // Saturday

  const startHour = isValidHour(safe.startHour) ? safe.startHour : 18;
  const startMinute = isValidMinute(safe.startMinute) ? safe.startMinute : 0;
  const endHour = isValidHour(safe.endHour) ? safe.endHour : 21;
  const endMinute = isValidMinute(safe.endMinute) ? safe.endMinute : 0;

  return {
    mode: 'fixedClock',
    sabbathStartDay,
    sabbathEndDay,
    startHour,
    startMinute,
    endHour,
    endMinute
  };
}

/**
 * Derive which dates the fixed Sabbath window spans based on current date.
 *
 * - If today is the Sabbath start day before startHour, we assume the
 *   window starts later today and ends on the next day.
 * - If today is the Sabbath end day, or beyond, we assume the window
 *   started on the previous day and ends today.
 *
 * This keeps things intuitive across timezone shifts without having to
 * know anything about Hebrew calendar months.
 *
 * @param {Date} now
 * @param {Required<FixedClockConfig>} cfg
 * @returns {{ startDate: Date, endDate: Date }}
 */
function deriveFixedWindowDates(now, cfg) {
  const today = stripTime(now);
  const localDay = now.getDay();

  let startDate = new Date(today);
  let endDate = new Date(today);

  if (localDay === cfg.sabbathStartDay) {
    // Friday: start today, end next day
    startDate = new Date(today);
    endDate = addDays(today, 1);
  } else if (localDay === cfg.sabbathEndDay) {
    // Saturday: start previous day, end today
    startDate = addDays(today, -1);
    endDate = new Date(today);
  } else {
    // Default: assume nearest weekend pair (startDay -> endDay)
    const offsetToStart = (cfg.sabbathStartDay - localDay + 7) % 7;
    startDate = addDays(today, offsetToStart);
    endDate = addDays(startDate, 1);
  }

  return { startDate, endDate };
}

/* -------------------------------------------------------------------------- */
/*  Sunset-based Sabbath: sunset → next sunset                                */
/* -------------------------------------------------------------------------- */

/**
 * Validate sunset config.
 *
 * @param {SunsetConfig} cfg
 * @returns {boolean}
 */
function isValidSunsetConfig(cfg) {
  return (
    cfg &&
    cfg.mode === 'sunsetToSunset' &&
    cfg.sunsetByDate &&
    typeof cfg.sunsetByDate === 'object'
  );
}

/**
 * Evaluate Sabbath using a sunset-to-sunset rule.
 *
 * Requires:
 * - sunsetByDate['YYYY-MM-DD'] = ISO string for sunset of that day.
 *
 * We compute:
 * - Friday sunset (Sabbath start) and Saturday sunset (Sabbath end)
 *   by looking at the current and adjacent dates.
 *
 * If data is missing, we fall back to Saturday-only rule with a warning.
 *
 * @param {SunsetConfig} cfg
 * @param {Date} now
 * @param {SabbathEvaluationResult} baseResult
 * @returns {SabbathEvaluationResult}
 */
function evaluateSunsetMode(cfg, now, baseResult) {
  const res = { ...baseResult, reasonCode: 'sunset.outside' };

  const today = stripTime(now);
  const localDay = now.getDay(); // 0 = Sunday, 5 = Friday, 6 = Saturday

  const todayKey = getLocalDateKey(today);
  const prevKey = getLocalDateKey(addDays(today, -1));
  const nextKey = getLocalDateKey(addDays(today, 1));

  // We’re primarily concerned with Friday/Saturday windows, but if
  // your community follows a different pattern, you can adjust here.
  const fridayKey =
    localDay === 5 ? todayKey :
    localDay === 6 ? prevKey :
    // “nearest Friday” heuristic for other days
    findNearestWeekdayKey(today, 5);

  const saturdayKey =
    localDay === 5 ? nextKey :
    localDay === 6 ? todayKey :
    // “nearest Saturday” heuristic for other days
    findNearestWeekdayKey(today, 6);

  const fridaySunsetIso = cfg.sunsetByDate[fridayKey] || null;
  const saturdaySunsetIso = cfg.sunsetByDate[saturdayKey] || null;

  if (!fridaySunsetIso || !saturdaySunsetIso) {
    const msg = 'Missing sunset data for Friday or Saturday; using Saturday fallback.';
    res.warnings.push(msg);
    return applyFallbackSaturdayRule(res, now, msg);
  }

  const start = new Date(fridaySunsetIso);
  const end = new Date(saturdaySunsetIso);

  res.windowStart = start.toISOString();
  res.windowEnd = end.toISOString();

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    const msg = 'Invalid sunset ISO strings; using Saturday fallback.';
    res.warnings.push(msg);
    return applyFallbackSaturdayRule(res, now, msg);
  }

  if (now >= start && now < end) {
    res.isSabbath = true;
    res.reasonCode = 'sunset.inWindow';
    return res;
  }

  res.isSabbath = false;
  res.reasonCode = 'sunset.outside';
  return res;
}

/**
 * Find a date key near `baseDate` that corresponds to a given weekday.
 *
 * E.g., nearest Friday (5) or Saturday (6).
 *
 * @param {Date} baseDate
 * @param {number} targetDay
 * @returns {string}
 */
function findNearestWeekdayKey(baseDate, targetDay) {
  let bestDate = baseDate;
  let smallestOffset = Infinity;

  for (let offset = -3; offset <= 3; offset += 1) {
    const candidate = addDays(baseDate, offset);
    const candidateDay = candidate.getDay();
    if (candidateDay === targetDay && Math.abs(offset) < smallestOffset) {
      bestDate = candidate;
      smallestOffset = Math.abs(offset);
    }
  }

  return getLocalDateKey(bestDate);
}

/* -------------------------------------------------------------------------- */
/*  Fallback: simple Saturday-only Sabbath                                    */
/* -------------------------------------------------------------------------- */

/**
 * Simple fallback: treat all of local Saturday as Sabbath.
 *
 * @param {SabbathEvaluationResult} baseResult
 * @param {Date} now
 * @param {string} [warning]
 * @returns {SabbathEvaluationResult}
 */
function applyFallbackSaturdayRule(baseResult, now, warning) {
  const res = { ...baseResult, reasonCode: 'fallback.saturday' };
  if (warning) {
    res.warnings = [...(baseResult.warnings || []), warning];
  }

  const today = stripTime(now);
  const localDay = now.getDay(); // 6 = Saturday

  const start = buildLocalDateWithTime(today, 0, 0);
  const end = addDays(start, 1);

  res.windowStart = start.toISOString();
  res.windowEnd = end.toISOString();

  if (localDay === 6) {
    res.isSabbath = true;
  } else {
    res.isSabbath = false;
  }

  return res;
}

/* -------------------------------------------------------------------------- */
/*  Event emission                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Emit a telemetry-style `sabbath.evaluated` event.
 *
 * Payload:
 * {
 *   type: 'sabbath.evaluated',
 *   ts: ISO8601,
 *   source: 'guards.sabbath',
 *   data: SabbathEvaluationResult
 * }
 *
 * @param {SabbathEvaluationResult} result
 */
function safeEmitSabbathEvaluated(result) {
  try {
    if (typeof emit !== 'function') return;
    emit({
      type: 'sabbath.evaluated',
      ts: new Date().toISOString(),
      source: 'guards.sabbath',
      data: result
    });
  } catch (_err) {
    // Never crash guard logic because of eventBus failures.
    // console.warn('[guards.sabbath] Failed to emit sabbath.evaluated', _err);
  }
}

/* -------------------------------------------------------------------------- */
/*  Small helpers                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Strip time-of-day, leaving local midnight.
 *
 * @param {Date} d
 * @returns {Date}
 */
function stripTime(d) {
  const res = new Date(d);
  res.setHours(0, 0, 0, 0);
  return res;
}

/**
 * Add N days to a date, preserving local time-of-day.
 *
 * @param {Date} d
 * @param {number} days
 * @returns {Date}
 */
function addDays(d, days) {
  const res = new Date(d);
  res.setDate(res.getDate() + days);
  return res;
}

/**
 * Build a new Date at local date with specific hour/minute.
 *
 * @param {Date} baseDate
 * @param {number} hour
 * @param {number} minute
 * @returns {Date}
 */
function buildLocalDateWithTime(baseDate, hour, minute) {
  const res = new Date(baseDate);
  res.setHours(hour, minute, 0, 0);
  return res;
}

/**
 * Get YYYY-MM-DD string for local date.
 *
 * @param {Date} d
 * @returns {string}
 */
function getLocalDateKey(d) {
  const year = d.getFullYear();
  const month = d.getMonth() + 1; // 0-based
  const day = d.getDate();

  const mm = month < 10 ? `0${month}` : String(month);
  const dd = day < 10 ? `0${day}` : String(day);

  return `${year}-${mm}-${dd}`;
}

/**
 * Valid day index (0–6).
 *
 * @param {number|undefined} v
 * @returns {boolean}
 */
function isValidDayIndex(v) {
  return Number.isInteger(v) && v >= 0 && v <= 6;
}

/**
 * Valid hour (0–23).
 *
 * @param {number|undefined} v
 * @returns {boolean}
 */
function isValidHour(v) {
  return Number.isInteger(v) && v >= 0 && v <= 23;
}

/**
 * Valid minute (0–59).
 *
 * @param {number|undefined} v
 * @returns {boolean}
 */
function isValidMinute(v) {
  return Number.isInteger(v) && v >= 0 && v <= 59;
}
