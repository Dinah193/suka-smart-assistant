// src/utils/rhythmCadence.js
// NOTE: Build fix — remove hard dependency on "luxon" (Rollup couldn't resolve it).
// We implement the same behaviors using native Date + simple interval helpers.

const MS_DAY = 24 * 60 * 60 * 1000;

function pad2(n) {
  return String(n).padStart(2, "0");
}

function parseHHMM(hhmm) {
  const [hStr, mStr] = String(hhmm || "00:00").split(":");
  const h = Number.parseInt(hStr, 10);
  const m = Number.parseInt(mStr, 10);
  return {
    h: Number.isFinite(h) ? h : 0,
    m: Number.isFinite(m) ? m : 0,
  };
}

/**
 * Parse an ISO string into a Date.
 * - If the string includes a timezone offset or Z, Date will interpret it correctly.
 * - If it is date-only "YYYY-MM-DD", Date treats it as UTC midnight; we keep behavior stable.
 */
function parseISOToDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Start of day in local time for the given Date */
function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function addMinutes(d, minutes) {
  return new Date(d.getTime() + minutes * 60 * 1000);
}

function addHours(d, hours) {
  return new Date(d.getTime() + hours * 60 * 60 * 1000);
}

function addDays(d, days) {
  return new Date(d.getTime() + days * MS_DAY);
}

function addWeeks(d, weeks) {
  return addDays(d, weeks * 7);
}

function addMonths(d, months) {
  const out = new Date(d.getTime());
  const day = out.getDate();
  out.setMonth(out.getMonth() + months);

  // If month roll caused date to jump (e.g., Jan 31 -> Mar 2), clamp to last day of target month
  if (out.getDate() !== day) {
    out.setDate(0);
  }
  return out;
}

function diffDays(a, b) {
  const aa = startOfDay(a).getTime();
  const bb = startOfDay(b).getTime();
  return (aa - bb) / MS_DAY;
}

function formatHHMM(d) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function clampToValidDateISO(dateISO) {
  // Accept "YYYY-MM-DD" only; otherwise try Date parse.
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(dateISO))) return dateISO;
  const d = parseISOToDate(dateISO);
  if (!d) return null;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * Create a Date for dateISO at 00:00 local time, then add time.
 * tz param is accepted for API-compatibility but not used (native Date is local).
 */
function dateAtLocalTime(dateISO, tz, hh, mm) {
  const dISO = clampToValidDateISO(dateISO);
  if (!dISO) return null;
  const [y, mo, da] = dISO.split("-").map((n) => Number.parseInt(n, 10));
  const base = new Date(y, (mo || 1) - 1, da || 1, 0, 0, 0, 0);
  return addMinutes(addHours(base, hh || 0), mm || 0);
}

/** Interval helpers (replacement for Luxon Interval) */
function intervalContains(start, end, dt) {
  const t = dt.getTime();
  return t >= start.getTime() && t < end.getTime();
}

function intervalIntersection(aStart, aEnd, bStart, bEnd) {
  const s = new Date(Math.max(aStart.getTime(), bStart.getTime()));
  const e = new Date(Math.min(aEnd.getTime(), bEnd.getTime()));
  return e.getTime() > s.getTime() ? { start: s, end: e } : null;
}

/** is every Nth day from a start date (e.g., ADF step=2 returns true on start, start+2, ...) */
export function isNthDay(dt, cfg) {
  const start = parseISOToDate(cfg?.start);
  if (!start || !(dt instanceof Date) || Number.isNaN(dt.getTime()))
    return false;
  const diff = diffDays(dt, start);
  const step = Number(cfg?.step || 2);
  return diff >= 0 && Number.isFinite(step) && step > 0 && diff % step === 0;
}

/** fiveTwo fast day checker: pick two index days (0..6) relative to rolling week from 'start' */
export function isFiveTwoFast(dt, cfg) {
  const start = parseISOToDate(cfg?.start);
  if (!start || !(dt instanceof Date) || Number.isNaN(dt.getTime()))
    return false;
  const diff = diffDays(dt, start);
  const idxInWeek = ((diff % 7) + 7) % 7; // 0..6
  const days = Array.isArray(cfg?.fastDays) ? cfg.fastDays : [];
  return days.includes(idxInWeek);
}

/* -------------------------------------------------------------------------- */
/* Intermittent Fasting helpers                                               */
/* -------------------------------------------------------------------------- */

/**
 * Compose feeding windows for a specific date given a daily IF window.
 * Supports windows crossing midnight (e.g., 16:8 feeding 12:00–20:00, or late windows).
 * @returns Array of { start: Date, end: Date }
 */
export function composeDailyFeedingWindows(dateISO, tz, daily) {
  if (!daily?.start || !daily?.end) return [];
  const { h: sh, m: sm } = parseHHMM(daily.start);
  const { h: eh, m: em } = parseHHMM(daily.end);

  const start = dateAtLocalTime(dateISO, tz, sh, sm);
  const end = dateAtLocalTime(dateISO, tz, eh, em);
  if (!start || !end) return [];

  // If end >= start: window is within same day.
  if (end.getTime() >= start.getTime()) return [{ start, end }];

  // If end < start: window crosses midnight → split across two days:
  // Window1: start..tomorrow 00:00; Window2: tomorrow 00:00..tomorrow+endTime
  const tomorrow = addDays(startOfDay(start), 1);
  const endTomorrow = dateAtLocalTime(
    `${tomorrow.getFullYear()}-${pad2(tomorrow.getMonth() + 1)}-${pad2(
      tomorrow.getDate()
    )}`,
    tz,
    eh,
    em
  );

  return [
    { start, end: tomorrow }, // late-night portion
    { start: tomorrow, end: endTomorrow || addMinutes(tomorrow, 0) }, // next-day portion
  ].filter((w) => w.start && w.end && w.end.getTime() > w.start.getTime());
}

/**
 * Check if a specific Date falls inside any of the provided windows.
 */
export function isDTWithinWindows(dt, windows) {
  if (!(dt instanceof Date) || Number.isNaN(dt.getTime())) return false;
  const ws = Array.isArray(windows) ? windows : [];
  return ws.some(
    (w) => w?.start && w?.end && intervalContains(w.start, w.end, dt)
  );
}

/**
 * Given a date/time hint, snap it INTO the nearest feeding window on that date.
 * Strategy:
 *  - If already inside a window → return same time
 *  - Else snap to the window start closest after the time; if none, to earliest window start of the day
 */
export function snapTimeIntoWindows(dateISO, tz, timeHHMM, windows) {
  const { h, m } = parseHHMM(timeHHMM || "12:00");
  const target = dateAtLocalTime(dateISO, tz, h, m);
  if (!target) return timeHHMM;

  const ws = (Array.isArray(windows) ? windows : [])
    .filter((w) => w?.start && w?.end)
    .slice();

  if (isDTWithinWindows(target, ws)) return formatHHMM(target);

  // Find next window start >= target
  const after = ws
    .filter((w) => w.start.getTime() >= target.getTime())
    .sort((a, b) => a.start.getTime() - b.start.getTime())[0];

  if (after) return formatHHMM(after.start);

  // Otherwise, snap to earliest window of the day (if any)
  const first = ws.sort((a, b) => a.start.getTime() - b.start.getTime())[0];
  return first ? formatHHMM(first.start) : timeHHMM;
}

/**
 * Build repeated multi-day fasting blocks across a range.
 * cfg = { startISODateTime, durationHours, repeat: 'none'|'weekly'|'biweekly'|'monthly' }
 * Returns array of { start: Date, end: Date } blocks within [rangeStart, rangeEnd]
 */
export function buildFastingBlocksInRange(rangeStartISO, rangeEndISO, tz, cfg) {
  if (!cfg?.startISODateTime || !cfg?.durationHours) return [];

  const startRange = parseISOToDate(rangeStartISO);
  const endRange = parseISOToDate(rangeEndISO);
  if (!startRange || !endRange || endRange.getTime() < startRange.getTime())
    return [];

  const blocks = [];
  let cursor = parseISOToDate(cfg.startISODateTime);
  if (!cursor) return [];

  const durationHours = Number(cfg.durationHours);
  if (!Number.isFinite(durationHours) || durationHours <= 0) return [];

  const rangeInclusiveEnd = addDays(endRange, 1); // inclusive end

  const pushIfOverlaps = (s, e) => {
    const overlap = intervalIntersection(s, e, startRange, rangeInclusiveEnd);
    if (overlap) blocks.push(overlap);
  };

  // generate repeats until beyond range (+40 days safety)
  const stopAt = addDays(endRange, 40);

  while (cursor.getTime() <= stopAt.getTime()) {
    const end = addHours(cursor, durationHours);
    pushIfOverlaps(cursor, end);

    const rep = cfg.repeat || "none";
    if (rep === "none") break;
    if (rep === "weekly") cursor = addWeeks(cursor, 1);
    else if (rep === "biweekly") cursor = addWeeks(cursor, 2);
    else if (rep === "monthly") cursor = addMonths(cursor, 1);
    else break;
  }

  return blocks;
}

/**
 * Is a given Date inside any multi-day fasting block?
 */
export function isWithinAnyBlock(dt, blocks) {
  if (!(dt instanceof Date) || Number.isNaN(dt.getTime())) return false;
  const bs = Array.isArray(blocks) ? blocks : [];
  return bs.some(
    (b) => b?.start && b?.end && intervalContains(b.start, b.end, dt)
  );
}
