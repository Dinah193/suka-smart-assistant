// C:\Users\larho\suka-smart-assistant\src\services\clock\time.js
/* eslint-disable no-console */

/**
 * SSA Clock Helpers
 * -----------------------------------------------------------------------------
 * Role in pipeline:
 * - Imports → Intelligence → Automation → (optional) Hub export
 * - Deterministic, DST-safe time utilities for planning & scheduling:
 *   • UTC-first helpers (ISO-8601)
 *   • Time zone conversions without external libs
 *   • Start/end-of-day in a given zone (critical for sessions & calendars)
 *   • Human-friendly formatting for UI and notifications
 *
 * Notes:
 * - This module is pure (no household data changed), so it does NOT export to Hub.
 * - It’s defensive and works in modern browsers & Node without `Temporal`.
 * - Engines like CalendarsRepo, SessionsRepo, and automation runtimes should
 *   use these helpers to avoid subtle DST bugs.
 */

let eventBus = { emit: () => {}, on: () => () => {} };
try {
  // Optional: we emit small diagnostics on tz-math edges; safe if missing.
  const eb = require("@/services/eventBus");
  eventBus = eb?.default || eb?.eventBus || eventBus;
} catch {}

/* ----------------------------------------------------------------------------
 * Basic UTC helpers
 * -------------------------------------------------------------------------- */

/** ISO timestamp in UTC (no milliseconds trimming) */
export function isoNow() {
  return new Date().toISOString();
}

/** Returns a Date; accepts Date | number | string (ISO) */
export function asDate(input = null) {
  if (input instanceof Date) return new Date(input.getTime());
  if (typeof input === "number") return new Date(input);
  if (typeof input === "string") {
    const d = new Date(input);
    if (Number.isFinite(d.getTime())) return d;
  }
  return new Date(); // fallback: now
}

/** Returns a UTC ISO string for the given input */
export function toUTCISO(input) {
  return asDate(input).toISOString();
}

/** Adds a duration to a UTC instant; returns UTC ISO */
export function addDurationUTC(utcISO, { days = 0, hours = 0, minutes = 0, seconds = 0, ms = 0 } = {}) {
  const t =
    days * 86400000 +
    hours * 3600000 +
    minutes * 60000 +
    seconds * 1000 +
    ms;
  return new Date(new Date(utcISO).getTime() + t).toISOString();
}

/** Start of UTC day for the given instant (00:00:00.000Z) */
export function startOfDayUTC(utcISO) {
  const d = new Date(utcISO);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

/** End of UTC day (exclusive bound) = start of next day */
export function endOfDayUTC(utcISO) {
  return addDurationUTC(startOfDayUTC(utcISO), { days: 1 });
}

/* ----------------------------------------------------------------------------
 * Time zone math (DST-safe without Temporal)
 * -------------------------------------------------------------------------- */

/**
 * offsetMinutesForZoneAt(utcMillis, timeZone)
 * - Returns the numeric offset (minutes) that *timeZone* had at *utcMillis*.
 * - Positive east of UTC (e.g., +120), negative west (e.g., -360).
 */
export function offsetMinutesForZoneAt(utcMillis, timeZone) {
  if (!Intl || !Intl.DateTimeFormat) return -new Date(utcMillis).getTimezoneOffset();
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

    const parts = dtf.formatToParts(new Date(utcMillis));
    const map = {};
    for (const p of parts) map[p.type] = p.value;

    // Build a “wall time” that formatter showed in the zone.
    const y = Number(map.year);
    const m = Number(map.month);
    const d = Number(map.day);
    const H = Number(map.hour);
    const M = Number(map.minute);
    const S = Number(map.second);

    // Interpret that wall time as if it were UTC to get a comparable epoch.
    const asIfUTC = Date.UTC(y, m - 1, d, H, M, S);

    // The difference tells us the zone offset (in ms) at that instant.
    const offsetMs = asIfUTC - utcMillis;
    return Math.round(offsetMs / 60000);
  } catch {
    // Fallback to system offset if the zone isn't supported.
    return -new Date(utcMillis).getTimezoneOffset();
  }
}

/**
 * fromUTCToZoned(utcISO, timeZone)
 * - Converts a UTC instant to a wall-clock representation in the target zone.
 * - Returns { wallISO, parts, offsetMinutes }
 */
export function fromUTCToZoned(utcISO, timeZone) {
  const t = new Date(utcISO).getTime();
  const offsetMin = offsetMinutesForZoneAt(t, timeZone);
  const wallMs = t + offsetMin * 60000;
  const wallDate = new Date(wallMs);

  const parts = {
    year: wallDate.getUTCFullYear(),
    month: wallDate.getUTCMonth() + 1,
    day: wallDate.getUTCDate(),
    hour: wallDate.getUTCHours(),
    minute: wallDate.getUTCMinutes(),
    second: wallDate.getUTCSeconds(),
    millisecond: wallDate.getUTCMilliseconds(),
  };

  const wallISO = new Date(Date.UTC(
    parts.year, parts.month - 1, parts.day,
    parts.hour, parts.minute, parts.second, parts.millisecond
  )).toISOString();

  return { wallISO, parts, offsetMinutes: offsetMin };
}

/**
 * fromZonedToUTC(wall, timeZone, { disambiguation })
 * - Converts a *wall* time in *timeZone* to UTC ISO.
 * - `wall` accepts:
 *     * a string "YYYY-MM-DDTHH:mm[:ss[.SSS]]"
 *     * an object { year, month, day, hour=0, minute=0, second=0, millisecond=0 }
 * - DST rules:
 *     • disambiguation: 'earliest' | 'latest' (for repeated times at fall-back)
 *     • for skipped times (spring-forward gap), chooses 'next' valid instant
 * - Returns { utcISO, offsetMinutes }.
 */
export function fromZonedToUTC(wall, timeZone, { disambiguation = "earliest" } = {}) {
  const w = typeof wall === "string" ? parseWallString(wall) : wallObject(wall);
  const wallAsUTC = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second, w.millisecond);

  // Guess offset using the instant we'd get if this wall time actually existed.
  let guessOffset = guessOffsetForWall(w, timeZone);
  // Convert guess to UTC by subtracting the zone offset.
  let utcMs = wallAsUTC - guessOffset * 60000;

  // Recompute the actual offset at that UTC ms and iterate once to settle.
  const actualOffset = offsetMinutesForZoneAt(utcMs, timeZone);
  if (actualOffset !== guessOffset) {
    // Adjust by the difference.
    utcMs = wallAsUTC - actualOffset * 60000;

    // Handle ambiguous (repeated) wall times: two UTC instants map to same wall.
    if (disambiguation === "latest") {
      const altOffset = offsetMinutesForZoneAt(utcMs - 60000, timeZone);
      if (altOffset !== actualOffset) {
        // Pick the later mapping by nudging one minute earlier in UTC, then re-evaluating.
        utcMs = wallAsUTC - Math.min(actualOffset, altOffset) * 60000;
      }
    }

    // Handle skipped wall times (gap). If computed UTC maps to a different wall hour,
    // push forward until we land on/after the desired wall time.
    const check = fromUTCToZoned(new Date(utcMs).toISOString(), timeZone);
    const cmp = compareWall(check.parts, w);
    if (cmp < 0) {
      // We landed before the intended wall time due to a gap; push forward.
      const nextOffset = offsetMinutesForZoneAt(utcMs + 60 * 60000, timeZone);
      if (nextOffset !== actualOffset) {
        // Jump to the start of valid time after the gap by reusing the desired wall as anchor.
        utcMs = wallAsUTC - nextOffset * 60000;
        eventBus.emit?.({ type: "clock.dst_gap.adjusted", ts: isoNow(), source: "services/clock/time", data: { timeZone, wall, usedOffset: nextOffset } });
      }
    }
  }

  return { utcISO: new Date(utcMs).toISOString(), offsetMinutes: offsetMinutesForZoneAt(utcMs, timeZone) };
}

/**
 * startOfZonedDayUTC(referenceUTC, timeZone)
 * - For a UTC instant, returns the UTC ISO for 00:00 at that *local* day.
 */
export function startOfZonedDayUTC(referenceUTC, timeZone) {
  const local = fromUTCToZoned(referenceUTC, timeZone).parts;
  const { utcISO } = fromZonedToUTC({ year: local.year, month: local.month, day: local.day, hour: 0, minute: 0, second: 0, millisecond: 0 }, timeZone);
  return utcISO;
}

/** endOfZonedDayUTC = start of next local day (exclusive bound) */
export function endOfZonedDayUTC(referenceUTC, timeZone) {
  const start = startOfZonedDayUTC(referenceUTC, timeZone);
  const nextLocalMidnight = addZonedDaysUTC(start, timeZone, 1);
  return nextLocalMidnight;
}

/**
 * addZonedDaysUTC(utcISO, timeZone, days)
 * - Adds whole *local* days and returns the resulting UTC instant of local 00:00.
 */
export function addZonedDaysUTC(utcISO, timeZone, days = 1) {
  const baseStart = startOfZonedDayUTC(utcISO, timeZone);
  const baseLocal = fromUTCToZoned(baseStart, timeZone).parts;
  const target = { ...baseLocal, day: baseLocal.day + days, hour: 0, minute: 0, second: 0, millisecond: 0 };
  return fromZonedToUTC(target, timeZone).utcISO;
}

/* ----------------------------------------------------------------------------
 * Formatting helpers
 * -------------------------------------------------------------------------- */

/**
 * formatZoned(utcISO, timeZone, options)
 * - Friendly rendering in a given zone (DST-safe).
 * - options: Intl.DateTimeFormat options (localeAware); defaults sensible.
 */
export function formatZoned(utcISO, timeZone, options = {}) {
  const locale = options.locale || undefined;
  const fmt = new Intl.DateTimeFormat(locale, {
    timeZone,
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    ...options,
  });
  return fmt.format(new Date(utcISO));
}

/** "Nov 08, 2025, 18:30 — America/Chicago (UTC-06:00)" style label */
export function formatZonedWithTZ(utcISO, timeZone, options = {}) {
  const label = formatZoned(utcISO, timeZone, options);
  const offMin = offsetMinutesForZoneAt(new Date(utcISO).getTime(), timeZone);
  const sign = offMin >= 0 ? "+" : "-";
  const h = String(Math.floor(Math.abs(offMin) / 60)).padStart(2, "0");
  const m = String(Math.abs(offMin) % 60).padStart(2, "0");
  return `${label} — ${timeZone} (UTC${sign}${h}:${m})`;
}

/** Returns a stable, localized time zone name (e.g., "Central Time") when possible */
export function getTimeZoneName(timeZone, { locale, style = "long" } = {}) {
  try {
    const fmt = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: style, year: "numeric" });
    const parts = fmt.formatToParts(new Date());
    const tzPart = parts.find(p => p.type === "timeZoneName");
    return tzPart?.value || timeZone;
  } catch {
    return timeZone;
  }
}

/* ----------------------------------------------------------------------------
 * Utilities (private-ish)
 * -------------------------------------------------------------------------- */

function parseWallString(s) {
  // Accept "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm[:ss[.SSS]]"
  const [dPart, tPart = "00:00:00.000"] = s.split("T");
  const [y, m, d] = dPart.split("-").map(n => Number(n));
  let ms = 0, H = 0, M = 0, S = 0;
  if (tPart) {
    const [hh, mm, rest = "0"] = tPart.split(":");
    H = Number(hh || 0);
    M = Number(mm || 0);
    if (rest.includes(".")) {
      const [ss, mss] = rest.split(".");
      S = Number(ss || 0);
      ms = Number(mss || 0);
    } else {
      S = Number(rest || 0);
    }
  }
  return wallObject({ year: y, month: m, day: d, hour: H, minute: M, second: S, millisecond: ms });
}

function wallObject(o = {}) {
  const year = Number(o.year), month = Number(o.month), day = Number(o.day);
  const hour = Number(o.hour || 0), minute = Number(o.minute || 0), second = Number(o.second || 0), millisecond = Number(o.millisecond || 0);
  return { year, month, day, hour, minute, second, millisecond };
}

function guessOffsetForWall(w, timeZone) {
  // Guess using the offset of the *previous* UTC midnight mapped to the zone.
  // This yields stable results around DST transitions.
  const approxUTC = Date.UTC(w.year, w.month - 1, w.day, 0, 0, 0);
  return offsetMinutesForZoneAt(approxUTC, timeZone);
}

function compareWall(a, b) {
  // Compare two wall time parts (a vs b). Returns -1,0,1
  const seq = ["year", "month", "day", "hour", "minute", "second", "millisecond"];
  for (const k of seq) {
    const d = (a[k] || 0) - (b[k] || 0);
    if (d < 0) return -1;
    if (d > 0) return 1;
  }
  return 0;
}

/* ----------------------------------------------------------------------------
 * Tiny diagnostics (optional)
 * -------------------------------------------------------------------------- */

/** Emits a heartbeat tick (purely informational) */
export function emitTick(label = "clock.tick") {
  try {
    eventBus.emit({ type: label, ts: isoNow(), source: "services/clock/time", data: {} });
  } catch {}
}

/* ----------------------------------------------------------------------------
 * Default export (named functions are preferred)
 * -------------------------------------------------------------------------- */
export default {
  isoNow,
  asDate,
  toUTCISO,
  addDurationUTC,
  startOfDayUTC,
  endOfDayUTC,
  offsetMinutesForZoneAt,
  fromUTCToZoned,
  fromZonedToUTC,
  startOfZonedDayUTC,
  endOfZonedDayUTC,
  addZonedDaysUTC,
  formatZoned,
  formatZonedWithTZ,
  getTimeZoneName,
  emitTick,
};
