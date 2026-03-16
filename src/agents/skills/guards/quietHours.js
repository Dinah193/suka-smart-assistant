/**
 * @file src/agents/skills/guards/quietHours.js
 *
 * Quiet hours restriction helper for Suka Smart Assistant (SSA).
 *
 * HOW THIS FITS:
 * - This module decides whether “right now” is inside user-defined Quiet Hours.
 * - It is meant to feed:
 *   - the Quiet Hours guard in `guardsEvaluate.js` (via `env.isQuietHours`),
 *   - any higher-level automation that must avoid noisy sessions at certain times.
 *
 * DESIGN:
 * - Configurable windows:
 *   - One or more time windows per week (e.g. 22:00–07:00 every day, or
 *     21:00–06:00 Sunday–Thursday, 23:00–08:00 Friday–Saturday, etc.).
 *   - Windows can cross midnight (e.g. 22:00 → 07:00).
 * - Fallback:
 *   - If config/windows are missing, default to 22:00–07:00 on all days.
 * - Non-UI:
 *   - This file does not show any UI.
 *   - It emits a `quietHours.evaluated` event for telemetry/analytics.
 *
 * The SessionRunner + guards wrapper (`guardsEvaluate.js`) should:
 * - Call `isQuietHoursNow()` (or `evaluateQuietHours()`) to compute `env.isQuietHours`.
 * - Use the result to block/allow steps that have the `quietHours` blocker.
 */

import { emit } from "../../../services/events/eventBus";

/**
 * @typedef {'fixedWindows'} QuietHoursMode
 */

/**
 * Single quiet-hours window definition.
 *
 * Example:
 * {
 *   days: [0,1,2,3,4,5,6], // 0=Sunday, 6=Saturday
 *   startHour: 22,
 *   startMinute: 0,
 *   endHour: 7,
 *   endMinute: 0,
 *   label: 'Default quiet hours'
 * }
 *
 * NOTE: Windows may cross midnight. For example:
 * - start: 22:00, end: 07:00 === every day 22:00 → next day 07:00.
 *
 * @typedef {Object} QuietHoursWindow
 * @property {number[]} days       Days of week (0–6; 0 = Sunday)
 * @property {number} startHour    Local hour (0–23)
 * @property {number} startMinute  Local minute (0–59)
 * @property {number} endHour      Local hour (0–23)
 * @property {number} endMinute    Local minute (0–59)
 * @property {string} [label]      Optional label for UI
 */

/**
 * High-level Quiet Hours configuration.
 *
 * @typedef {Object} QuietHoursConfig
 * @property {boolean} [enabled]         Global toggle (default true)
 * @property {QuietHoursMode} [mode]     Currently only 'fixedWindows'
 * @property {QuietHoursWindow[]} [windows] Array of windows
 */

/**
 * Result of a Quiet Hours evaluation.
 *
 * @typedef {Object} QuietHoursEvaluationResult
 * @property {boolean} isQuietHours        True if now falls within any window
 * @property {string|null} windowStart     ISO string representing effective window start (if any)
 * @property {string|null} windowEnd       ISO string representing effective window end (if any)
 * @property {QuietHoursWindow|null} windowDefinition  The config window that matched (if any)
 * @property {string} reasonCode           'disabled'|'inWindow'|'outside'|'fallback.defaultWindow'|'fallback.noWindows'
 * @property {string[]} warnings           Non-fatal config/data issues
 */

/**
 * Evaluate whether it is currently Quiet Hours, using the given configuration.
 *
 * Basic usage:
 * ```js
 * const result = evaluateQuietHours(userQuietConfig);
 * if (result.isQuietHours) {
 *   // Avoid starting noisy sessions, or block steps with quietHours blocker
 * }
 * ```
 *
 * @param {QuietHoursConfig} [config]
 * @param {Date} [now]
 * @returns {QuietHoursEvaluationResult}
 */
export function evaluateQuietHours(config = {}, now = new Date()) {
  /** @type {QuietHoursEvaluationResult} */
  const baseResult = {
    isQuietHours: false,
    windowStart: null,
    windowEnd: null,
    windowDefinition: null,
    reasonCode: "outside",
    warnings: [],
  };

  if (!config || typeof config !== "object") {
    const res = applyDefaultFallbackWindow(
      baseResult,
      now,
      "Config missing or not an object; using default quiet hours."
    );
    safeEmitQuietHoursEvaluated(res);
    return res;
  }

  const enabled = typeof config.enabled === "boolean" ? config.enabled : true;
  if (!enabled) {
    const res = {
      ...baseResult,
      isQuietHours: false,
      reasonCode: "disabled",
    };
    safeEmitQuietHoursEvaluated(res);
    return res;
  }

  const windows =
    Array.isArray(config.windows) && config.windows.length
      ? config.windows
      : null;

  if (!windows) {
    const res = applyDefaultFallbackWindow(
      baseResult,
      now,
      "No quiet hours windows defined; using default quiet hours."
    );
    safeEmitQuietHoursEvaluated(res);
    return res;
  }

  const normalizedWindows = windows.map(normalizeWindow).filter(Boolean);

  if (!normalizedWindows.length) {
    const res = applyDefaultFallbackWindow(
      baseResult,
      now,
      "All quiet hours windows invalid; using default quiet hours."
    );
    safeEmitQuietHoursEvaluated(res);
    return res;
  }

  const match = findMatchingWindow(now, normalizedWindows);

  if (!match) {
    const res = {
      ...baseResult,
      isQuietHours: false,
      reasonCode: "outside",
    };
    safeEmitQuietHoursEvaluated(res);
    return res;
  }

  const { start, end, window } = match;
  const res = {
    ...baseResult,
    isQuietHours: true,
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
    windowDefinition: window,
    reasonCode: "inWindow",
  };

  safeEmitQuietHoursEvaluated(res);
  return res;
}

/**
 * Convenience helper: just returns a boolean.
 *
 * @param {QuietHoursConfig} [config]
 * @param {Date} [now]
 * @returns {boolean}
 */
export function isQuietHoursNow(config, now) {
  return evaluateQuietHours(config, now).isQuietHours;
}

/* -------------------------------------------------------------------------- */
/*  Window matching logic                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Normalize a QuietHoursWindow, or return null if invalid.
 *
 * @param {QuietHoursWindow} w
 * @returns {QuietHoursWindow|null}
 */
function normalizeWindow(w) {
  if (!w || typeof w !== "object") return null;

  const days = Array.isArray(w.days) ? w.days.filter(isValidDayIndex) : [];
  if (!days.length) return null;

  const startHour = isValidHour(w.startHour) ? w.startHour : 22;
  const startMinute = isValidMinute(w.startMinute) ? w.startMinute : 0;
  const endHour = isValidHour(w.endHour) ? w.endHour : 7;
  const endMinute = isValidMinute(w.endMinute) ? w.endMinute : 0;

  return {
    days,
    startHour,
    startMinute,
    endHour,
    endMinute,
    label: typeof w.label === "string" ? w.label : undefined,
  };
}

/**
 * Find the first window that currently applies, along with concrete start/end
 * Date objects for *this* instance of that window.
 *
 * - We consider that a window applies if:
 *   - Today is in window.days and the time is between start and end, OR
 *   - Yesterday is in window.days and the window crosses midnight and we’re
 *     still before the end time.
 *
 * This allows windows like 22:00–07:00 to be treated as a single night block.
 *
 * @param {Date} now
 * @param {QuietHoursWindow[]} windows
 * @returns {{ start: Date, end: Date, window: QuietHoursWindow }|null}
 */
function findMatchingWindow(now, windows) {
  const today = stripTime(now);
  const yesterday = addDays(today, -1);
  const localDay = now.getDay();
  const localHour = now.getHours();
  const localMinute = now.getMinutes();

  for (const window of windows) {
    const crossesMidnight = doesWindowCrossMidnight(window);

    // Case 1: Same-day window that does NOT cross midnight.
    if (!crossesMidnight && window.days.includes(localDay)) {
      const start = buildLocalDateWithTime(
        today,
        window.startHour,
        window.startMinute
      );
      const end = buildLocalDateWithTime(
        today,
        window.endHour,
        window.endMinute
      );
      if (now >= start && now < end) {
        return { start, end, window };
      }
      continue;
    }

    // Case 2: Cross-midnight window, "evening" side (start day) — e.g., 22:00–24:00.
    if (crossesMidnight && window.days.includes(localDay)) {
      const start = buildLocalDateWithTime(
        today,
        window.startHour,
        window.startMinute
      );
      const end = addDays(
        buildLocalDateWithTime(today, window.endHour, window.endMinute),
        1
      );
      if (now >= start && now < end) {
        return { start, end, window };
      }
      // If current time is earlier than start, the "other side" (yesterday) might apply instead.
      // We'll check below in the "morning" case.
    }

    // Case 3: Cross-midnight window "morning" side (end day) — e.g., 00:00–07:00.
    // If yesterday was a window day and now is before the end time, we're still inside that window.
    const yesterdayDay = yesterday.getDay();
    if (crossesMidnight && window.days.includes(yesterdayDay)) {
      const start = buildLocalDateWithTime(
        yesterday,
        window.startHour,
        window.startMinute
      );
      const end = buildLocalDateWithTime(
        today,
        window.endHour,
        window.endMinute
      );
      if (now >= start && now < end) {
        return { start, end, window };
      }
    }

    // Edge case: If window is defined with the *end* day only (e.g., "Saturday 00:00–07:00"),
    // you could support that by extending this logic. For now, we assume the
    // day assignment is on the start day of the window.
  }

  return null;
}

/**
 * Determine whether a window crosses midnight.
 *
 * @param {QuietHoursWindow} w
 * @returns {boolean}
 */
function doesWindowCrossMidnight(w) {
  if (!isValidHour(w.startHour) || !isValidHour(w.endHour)) {
    return false;
  }
  // If end time is earlier than or equal to start time, we treat it as crossing midnight.
  if (w.endHour < w.startHour) return true;
  if (
    w.endHour === w.startHour &&
    isValidMinute(w.endMinute) &&
    isValidMinute(w.startMinute)
  ) {
    return w.endMinute <= w.startMinute;
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/*  Default fallback window: 22:00–07:00 on all days                          */
/* -------------------------------------------------------------------------- */

/**
 * Apply a default quiet hours rule:
 * - Every day, 22:00 → next day 07:00.
 *
 * @param {QuietHoursEvaluationResult} baseResult
 * @param {Date} now
 * @param {string} [warning]
 * @returns {QuietHoursEvaluationResult}
 */
function applyDefaultFallbackWindow(baseResult, now, warning) {
  const res = { ...baseResult, reasonCode: "fallback.defaultWindow" };
  if (warning) {
    res.warnings = [...(baseResult.warnings || []), warning];
  }

  /** @type {QuietHoursWindow} */
  const defaultWindow = {
    days: [0, 1, 2, 3, 4, 5, 6],
    startHour: 22,
    startMinute: 0,
    endHour: 7,
    endMinute: 0,
    label: "Default quiet hours (22:00–07:00)",
  };

  const match = findMatchingWindow(now, [defaultWindow]);
  if (match) {
    res.isQuietHours = true;
    res.windowStart = match.start.toISOString();
    res.windowEnd = match.end.toISOString();
    res.windowDefinition = defaultWindow;
  } else {
    res.isQuietHours = false;
    // But still expose the *next* default window for debugging if desired.
    const today = stripTime(now);
    const localDay = now.getDay();
    const start = buildLocalDateWithTime(
      today,
      defaultWindow.startHour,
      defaultWindow.startMinute
    );
    const end = addDays(
      buildLocalDateWithTime(
        today,
        defaultWindow.endHour,
        defaultWindow.endMinute
      ),
      1
    );

    // If we've already passed today's start time, shift to next day's window for clarity.
    if (now > end) {
      const nextDay = addDays(today, 1);
      res.windowStart = buildLocalDateWithTime(
        nextDay,
        defaultWindow.startHour,
        defaultWindow.startMinute
      ).toISOString();
      res.windowEnd = addDays(
        buildLocalDateWithTime(
          nextDay,
          defaultWindow.endHour,
          defaultWindow.endMinute
        ),
        1
      ).toISOString();
    } else {
      res.windowStart = start.toISOString();
      res.windowEnd = end.toISOString();
    }

    res.windowDefinition = defaultWindow;
  }

  return res;
}

/* -------------------------------------------------------------------------- */
/*  Event emission                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Emit `quietHours.evaluated` for telemetry / debugging.
 *
 * Payload:
 * {
 *   type: 'quietHours.evaluated',
 *   ts: ISO8601,
 *   source: 'guards.quietHours',
 *   data: QuietHoursEvaluationResult
 * }
 *
 * @param {QuietHoursEvaluationResult} result
 */
function safeEmitQuietHoursEvaluated(result) {
  try {
    if (typeof emit !== "function") return;
    emit({
      type: "quietHours.evaluated",
      ts: new Date().toISOString(),
      source: "guards.quietHours",
      data: result,
    });
  } catch (_err) {
    // Swallow errors so quiet-hours logic never crashes app due to eventBus issues.
    // console.warn('[guards.quietHours] Failed to emit quietHours.evaluated', _err);
  }
}

/* -------------------------------------------------------------------------- */
/*  Small helpers                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Strip time-of-day to local midnight.
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
 * Add N days to a date.
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
 * Build a local Date with specific hour/minute on given date.
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
 * Valid day index (0–6).
 *
 * @param {number} v
 * @returns {boolean}
 */
function isValidDayIndex(v) {
  return Number.isInteger(v) && v >= 0 && v <= 6;
}

/**
 * Valid hour (0–23).
 *
 * @param {number} v
 * @returns {boolean}
 */
function isValidHour(v) {
  return Number.isInteger(v) && v >= 0 && v <= 23;
}

/**
 * Valid minute (0–59).
 *
 * @param {number} v
 * @returns {boolean}
 */
function isValidMinute(v) {
  return Number.isInteger(v) && v >= 0 && v <= 59;
}
