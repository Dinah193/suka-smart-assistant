// src/utils/rhythmCadence.js
import { DateTime, Interval } from "luxon";

/** is every Nth day from a start date (e.g., ADF step=2 returns true on start, start+2, ...) */
export function isNthDay(dt, cfg) {
  const start = DateTime.fromISO(cfg.start, { zone: dt.zone });
  if (!start.isValid) return false;
  const diff = dt.startOf("day").diff(start.startOf("day"), "days").days;
  return diff >= 0 && (diff % (cfg.step || 2) === 0);
}

/** fiveTwo fast day checker: pick two index days (0..6) relative to rolling week from 'start' */
export function isFiveTwoFast(dt, cfg) {
  const start = DateTime.fromISO(cfg.start, { zone: dt.zone }).startOf("day");
  const diff = dt.startOf("day").diff(start, "days").days;
  const idxInWeek = ((diff % 7) + 7) % 7; // 0..6
  return (cfg.fastDays || []).includes(idxInWeek);
}

/* -------------------------------------------------------------------------- */
/* Intermittent Fasting helpers                                               */
/* -------------------------------------------------------------------------- */

/**
 * Compose feeding windows for a specific date given a daily IF window.
 * Supports windows crossing midnight (e.g., 16:8 feeding 12:00–20:00, or late windows).
 * @returns Array of { start: DateTime, end: DateTime }
 */
export function composeDailyFeedingWindows(dateISO, tz, daily) {
  if (!daily?.start || !daily?.end) return [];
  const day = DateTime.fromISO(dateISO, { zone: tz }).startOf("day");
  const [sh, sm] = daily.start.split(":").map(Number);
  const [eh, em] = daily.end.split(":").map(Number);

  const start = day.plus({ hours: sh || 0, minutes: sm || 0 });
  const end = day.plus({ hours: eh || 0, minutes: em || 0 });

  // If end >= start: window is within same day.
  if (end >= start) return [{ start, end }];

  // If end < start: window crosses midnight → split across two days:
  // Window1: day start..24:00; Window2: tomorrow 00:00..end
  return [
    { start, end: day.plus({ days: 1 }) },                      // late-night portion
    { start: day.plus({ days: 1 }), end: day.plus({ days: 1 }).plus({ hours: eh||0, minutes: em||0 }) } // next-day portion
  ];
}

/**
 * Check if a specific DateTime falls inside any of the provided windows.
 */
export function isDTWithinWindows(dt, windows) {
  return windows.some(w => Interval.fromDateTimes(w.start, w.end).contains(dt));
}

/**
 * Given a date/time hint, snap it INTO the nearest feeding window on that date.
 * Strategy:
 *  - If already inside a window → return same time
 *  - Else snap to the window start closest after the time; if none, to earliest window start of the day
 */
export function snapTimeIntoWindows(dateISO, tz, timeHHMM, windows) {
  const [h=12, m=0] = (timeHHMM || "12:00").split(":").map(Number);
  const target = DateTime.fromISO(`${dateISO}T00:00:00`, { zone: tz }).plus({ hours: h, minutes: m });

  if (isDTWithinWindows(target, windows)) return target.toFormat("HH:mm");

  // Find next window start >= target
  const after = windows
    .filter(w => w.start >= target)
    .sort((a,b) => a.start.toMillis() - b.start.toMillis())[0];
  if (after) return after.start.toFormat("HH:mm");

  // Otherwise, snap to earliest window of the day (if any)
  const first = windows.sort((a,b) => a.start.toMillis() - b.start.toMillis())[0];
  return first ? first.start.toFormat("HH:mm") : timeHHMM;
}

/**
 * Build repeated multi-day fasting blocks across a range.
 * cfg = { startISODateTime, durationHours, repeat: 'none'|'weekly'|'biweekly'|'monthly' }
 * Returns array of Intervals within [rangeStart, rangeEnd]
 */
export function buildFastingBlocksInRange(rangeStartISO, rangeEndISO, tz, cfg) {
  if (!cfg?.startISODateTime || !cfg?.durationHours) return [];
  const startRange = DateTime.fromISO(rangeStartISO, { zone: tz });
  const endRange   = DateTime.fromISO(rangeEndISO, { zone: tz });
  if (!startRange.isValid || !endRange.isValid || endRange < startRange) return [];

  const blocks = [];
  let cursor = DateTime.fromISO(cfg.startISODateTime, { zone: tz });
  const duration = { hours: cfg.durationHours };

  const pushIfOverlaps = (s, e) => {
    const I = Interval.fromDateTimes(s, e);
    const R = Interval.fromDateTimes(startRange, endRange.plus({ days: 1 })); // inclusive end
    const overlap = I.intersection(R);
    if (overlap) blocks.push(overlap);
  };

  // generate repeats until beyond range
  while (cursor <= endRange.plus({ days: 40 })) {
    pushIfOverlaps(cursor, cursor.plus(duration));

    const rep = cfg.repeat || "none";
    if (rep === "none") break;
    if (rep === "weekly")    cursor = cursor.plus({ weeks: 1 });
    else if (rep === "biweekly") cursor = cursor.plus({ weeks: 2 });
    else if (rep === "monthly")  cursor = cursor.plus({ months: 1 });
    else break;
  }
  return blocks;
}

/**
 * Is a given DateTime inside any multi-day fasting block?
 */
export function isWithinAnyBlock(dt, blocks) {
  return blocks.some(b => b.contains(dt));
}
