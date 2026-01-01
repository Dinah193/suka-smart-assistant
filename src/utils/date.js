/* eslint-disable no-console */
// utils/date.js — timezone-safe date helpers for Suka Smart Assistant
// - Human-friendly formatting (Notion/Google Calendar style ranges)
// - ISO <-> Local conversions, add/diff, rounding, week/day helpers
// - Offset parsing: "+20m", "PT1H30M", "tomorrow 5pm" (defers to offsetParser if available)
// - RRULE/VEVENT builders for reminders/schedules
// - Guard helpers: Sabbath/quiet hours windows (configurable)
// - Astronomy hooks (injector) to support full-moon month starts for Hebrew calendar

/* -------------------------------- constants -------------------------------- */
const isBrowser = typeof window !== "undefined";
const DEFAULT_TZ =
  (isBrowser && Intl.DateTimeFormat().resolvedOptions().timeZone) || "America/New_York";

// Week starts Monday by default; you can switch to Sunday if needed
const WEEK_START = 1; // 0 = Sunday, 1 = Monday

/* --------------------------- defensive dependencies ------------------------ */
let offsetParser = null;
try {
  // Prefer your shared parser for "+20m", "PT1H", etc.
  const mod = require("@/services/session/utils/offsetParser");
  offsetParser = mod.default || mod;
} catch (_e) {}

let eventBus = { emit(){}, on(){}, off(){} };
try {
  const eb = require("@/services/eventBus");
  eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
} catch (_e) {}

/* ----------------------------- astronomy provider -------------------------- */
// Pluggable provider { getFullMoon(dateISO, tz) -> ISO string }
let astronomyProvider = null;
export function registerAstronomyProvider(provider) { astronomyProvider = provider; }
function getFullMoonISO(anchorISO, tz = DEFAULT_TZ) {
  if (astronomyProvider?.getFullMoon) {
    try { return astronomyProvider.getFullMoon(anchorISO, tz); } catch (_e) {}
  }
  // Fallback: return the same date at 00:00—real implementation should be injected
  return toISO(startOfDay(parseISO(anchorISO), tz));
}

/* --------------------------------- parsing --------------------------------- */
export function parseISO(iso) {
  if (!iso) return new Date(NaN);
  const d = new Date(iso);
  return isNaN(d.getTime()) ? new Date(NaN) : d;
}

export function toISO(d = new Date()) {
  try {
    if (d instanceof Date) return d.toISOString();
    return new Date(d).toISOString();
  } catch (_e) { return new Date().toISOString(); }
}

export function safeDate(input) {
  if (!input) return new Date();
  if (input instanceof Date) return input;
  const d = new Date(input);
  return isNaN(d) ? new Date() : d;
}

export function localNow(tz = DEFAULT_TZ) {
  // Return a Date positioned at "now" for formatting; actual Date is always UTC-based
  // Use tz only in formatting functions
  return new Date();
}

/* --------------------------------- math ------------------------------------ */
export function add(d, delta = {}) {
  const base = safeDate(d);
  const out = new Date(base);
  if (delta.years) out.setFullYear(out.getFullYear() + delta.years);
  if (delta.months) out.setMonth(out.getMonth() + delta.months);
  if (delta.weeks) out.setDate(out.getDate() + delta.weeks * 7);
  if (delta.days) out.setDate(out.getDate() + delta.days);
  if (delta.hours) out.setHours(out.getHours() + delta.hours);
  if (delta.minutes) out.setMinutes(out.getMinutes() + delta.minutes);
  if (delta.seconds) out.setSeconds(out.getSeconds() + delta.seconds);
  if (delta.milliseconds) out.setMilliseconds(out.getMilliseconds() + delta.milliseconds);
  return out;
}

export function diffMs(a, b) {
  const da = safeDate(a);
  const db = safeDate(b);
  return da.getTime() - db.getTime();
}

export function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/* ------------------------------ start/end utils ---------------------------- */
export function startOfDay(d, _tz = DEFAULT_TZ) {
  const x = safeDate(d);
  return new Date(x.getFullYear(), x.getMonth(), x.getDate(), 0, 0, 0, 0);
}
export function endOfDay(d, _tz = DEFAULT_TZ) {
  const x = safeDate(d);
  return new Date(x.getFullYear(), x.getMonth(), x.getDate(), 23, 59, 59, 999);
}
export function startOfWeek(d, weekStart = WEEK_START) {
  const x = startOfDay(d);
  const day = x.getDay(); // 0..6 (Sun..Sat)
  const diff = (day < weekStart ? 7 : 0) + day - weekStart;
  return add(x, { days: -diff });
}
export function endOfWeek(d, weekStart = WEEK_START) {
  return add(startOfWeek(d, weekStart), { days: 6, hours: 23, minutes: 59, seconds: 59, milliseconds: 999 });
}
export function startOfMonth(d) {
  const x = safeDate(d);
  return new Date(x.getFullYear(), x.getMonth(), 1, 0, 0, 0, 0);
}
export function endOfMonth(d) {
  const x = safeDate(d);
  return new Date(x.getFullYear(), x.getMonth() + 1, 0, 23, 59, 59, 999);
}

/* ------------------------------- formatting -------------------------------- */
function pad2(n) { return (n < 10 ? "0" : "") + n; }

export function fmtYMD(d) {
  const x = safeDate(d);
  return `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}`;
}
export function fmtClock(d) {
  const x = safeDate(d);
  let h = x.getHours(), m = x.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${pad2(m)} ${ampm}`;
}
export function fmtYMDHM(d) {
  const x = safeDate(d);
  return `${fmtYMD(x)} ${fmtClock(x)}`;
}

export function formatRangeSmart(a, b) {
  // Like Google Calendar: compact same-day ranges, otherwise show dates
  const da = safeDate(a), db = safeDate(b);
  if (fmtYMD(da) === fmtYMD(db)) {
    return `${fmtYMD(da)} • ${fmtClock(da)} – ${fmtClock(db)}`;
    }
  return `${fmtYMDHM(da)} → ${fmtYMDHM(db)}`;
}

export function humanizeMs(ms) {
  if (ms < 0) ms = -ms;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec ? `${sec}s` : ""}`.trim();
  return `${sec}s`;
}

export function relativeToNow(d) {
  const x = safeDate(d);
  const diff = x.getTime() - Date.now();
  const abs = Math.abs(diff);
  const h = Math.round(abs / 3600000);
  const m = Math.round(abs / 60000);
  const dir = diff >= 0 ? "in" : "";
  if (h >= 1) return `${dir} ${h} hour${h === 1 ? "" : "s"}`.trim();
  return `${dir} ${m} min${m === 1 ? "" : "s"}`.trim();
}

/* --------------------------- day/week helpers ------------------------------ */
export function dayName(d) {
  const x = safeDate(d);
  return ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][x.getDay()];
}
export function weekNumber(d) {
  // ISO week number
  const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = x.getUTCDay() || 7;
  x.setUTCDate(x.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(x.getUTCFullYear(),0,1));
  return Math.ceil((((x - yearStart) / 86400000) + 1) / 7);
}

/* ------------------------------ comparisons -------------------------------- */
export function isWithin(target, start, end) {
  const t = safeDate(target).getTime();
  return t >= safeDate(start).getTime() && t <= safeDate(end).getTime();
}
export function sameDay(a, b) { return fmtYMD(a) === fmtYMD(b); }

/* ----------------------------- time parsing UX ----------------------------- */
export function parseTimeOfDay(str = "") {
  // "3:30 pm", "15:45", "7am"
  const s = String(str).trim().toLowerCase();
  const m12 = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m12) return { hours: 0, minutes: 0, ok: false };
  let h = parseInt(m12[1], 10);
  const min = parseInt(m12[2] || "0", 10);
  const ap = m12[3];
  if (ap === "pm" && h !== 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h < 0 || h > 23 || min < 0 || min > 59) return { hours: 0, minutes: 0, ok: false };
  return { hours: h, minutes: min, ok: true };
}

export function combineDateAndTime(dateInput, timeStr) {
  const d = safeDate(dateInput);
  const { hours, minutes, ok } = parseTimeOfDay(timeStr);
  if (!ok) return new Date(NaN);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hours, minutes, 0, 0);
}

/* ------------------------------ offsets parser ----------------------------- */
export function parseOffset(expr, baseISO = toISO()) {
  // Prefer your dedicated offsetParser if available
  if (offsetParser?.parse) {
    try { return offsetParser.parse(expr, baseISO); } catch (_e) {}
  }
  // Minimal fallback: "+20m", "+2h", "PT1H30M"
  const s = String(expr || "").trim();
  if (!s) return { iso: baseISO, ms: 0, ok: false };

  // ISO 8601 duration (very small subset)
  if (/^PT/i.test(s)) {
    const m = s.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
    if (m) {
      const addMs = (parseInt(m[1] || "0", 10) * 3600000) +
                    (parseInt(m[2] || "0", 10) * 60000) +
                    (parseInt(m[3] || "0", 10) * 1000);
      return { iso: toISO(add(parseISO(baseISO), { milliseconds: addMs })), ms: addMs, ok: true };
    }
  }

  // Simple "+20m", "+2h", "+1d"
  const mm = s.match(/^\+?(\d+)\s*([smhdw])$/i);
  if (mm) {
    const val = parseInt(mm[1], 10);
    const unit = mm[2].toLowerCase();
    const map = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };
    const addMs = val * (map[unit] || 0);
    return { iso: toISO(add(parseISO(baseISO), { milliseconds: addMs })), ms: addMs, ok: true };
  }

  // Fallback: return base
  return { iso: baseISO, ms: 0, ok: false };
}

/* ------------------------------- scheduling -------------------------------- */
export function nextOccurrence(dow, timeStr, from = new Date()) {
  // dow: 0..6 (Sun..Sat)
  const { hours, minutes, ok } = parseTimeOfDay(timeStr);
  if (!ok) return new Date(NaN);
  let x = startOfDay(from);
  const addDays = (dow - x.getDay() + 7) % 7;
  x = add(x, { days: addDays, hours, minutes });
  if (x <= from) x = add(x, { days: 7 }); // next week
  return x;
}

export function buildVEVENT({
  title = "Reminder",
  startISO = toISO(),
  durationMinutes = 30,
  rrule = null, // e.g., "FREQ=WEEKLY;BYDAY=MO,WE,FR"
  description = "",
  location = "",
  uid = `suka-${Date.now()}`,
}) {
  const dt = parseISO(startISO);
  const end = add(dt, { minutes: durationMinutes });
  const DTSTART = fmtICS(dt);
  const DTEND = fmtICS(end);
  const lines = [
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTART:${DTSTART}`,
    `DTEND:${DTEND}`,
    `SUMMARY:${escapeICS(title)}`,
  ];
  if (location) lines.push(`LOCATION:${escapeICS(location)}`);
  if (description) lines.push(`DESCRIPTION:${escapeICS(description)}`);
  if (rrule) lines.push(`RRULE:${rrule}`);
  lines.push("END:VEVENT");
  return lines.join("\r\n");
}

export function rruleDaily({ byHour = 9, byMinute = 0, bySecond = 0 } = {}) {
  return `FREQ=DAILY;BYHOUR=${byHour};BYMINUTE=${byMinute};BYSECOND=${bySecond}`;
}
export function rruleWeekly({ byDay = ["MO"], byHour = 9, byMinute = 0, bySecond = 0 } = {}) {
  return `FREQ=WEEKLY;BYDAY=${byDay.join(",")};BYHOUR=${byHour};BYMINUTE=${byMinute};BYSECOND=${bySecond}`;
}
export function rruleMonthlyByDay({ day = 1, byHour = 9, byMinute = 0, bySecond = 0 } = {}) {
  return `FREQ=MONTHLY;BYMONTHDAY=${day};BYHOUR=${byHour};BYMINUTE=${byMinute};BYSECOND=${bySecond}`;
}

/* ------------------------------- guards (Sabbath) -------------------------- */
// Simple guard windows. For accurate sunset times, inject an astronomy provider
export function isSabbath(now = new Date(), { tz = DEFAULT_TZ, friSunset = "18:00", satSunset = "18:00" } = {}) {
  const d = safeDate(now);
  const day = d.getDay(); // 5 = Fri, 6 = Sat
  if (day === 5) {
    const friStart = combineDateAndTime(d, friSunset);
    return d >= friStart; // Fri sunset onward
  }
  if (day === 6) {
    const satEnd = combineDateAndTime(d, satSunset);
    return d < satEnd; // until Sat sunset
  }
  return false;
}

export function guardWindow(now = new Date(), opts) {
  return { sabbath: isSabbath(now, opts) };
}

/* ------------------------------- hebrew helpers ---------------------------- */
// For your "months begin at/near full moon" setting:
export function monthStartFullMoon(anchorISO = toISO(), tz = DEFAULT_TZ) {
  return getFullMoonISO(anchorISO, tz);
}

/* ------------------------------ small helpers ------------------------------ */
export function slugWithTimestamp(title) {
  const base = String(title || "plan").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  const ts = fmtYMD(new Date()) + "-" + pad2(safeDate(new Date()).getHours()) + pad2(safeDate(new Date()).getMinutes());
  return `${base}-${ts}`;
}

export function filenameTS(prefix = "export", ext = "csv") {
  const ts = new Date();
  const stamp = `${ts.getFullYear()}${pad2(ts.getMonth() + 1)}${pad2(ts.getDate())}_${pad2(ts.getHours())}${pad2(ts.getMinutes())}`;
  return `${prefix}_${stamp}.${ext}`;
}

/* ------------------------------- ICS helpers ------------------------------- */
function escapeICS(s) {
  return String(s || "")
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}
function fmtICS(d) {
  // UTC Zulu time
  const x = safeDate(d);
  return (
    x.getUTCFullYear().toString() +
    pad2(x.getUTCMonth() + 1) +
    pad2(x.getUTCDate()) +
    "T" +
    pad2(x.getUTCHours()) +
    pad2(x.getUTCMinutes()) +
    pad2(x.getUTCSeconds()) +
    "Z"
  );
}

/* --------------------------------- exports --------------------------------- */
// CJS compatibility
const api = {
  DEFAULT_TZ,
  WEEK_START,
  registerAstronomyProvider,

  parseISO,
  toISO,
  safeDate,
  localNow,

  add,
  diffMs,
  clamp,

  startOfDay,
  endOfDay,
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,

  fmtYMD,
  fmtClock,
  fmtYMDHM,
  formatRangeSmart,
  humanizeMs,
  relativeToNow,

  dayName,
  weekNumber,

  isWithin,
  sameDay,

  parseTimeOfDay,
  combineDateAndTime,

  parseOffset,

  nextOccurrence,
  buildVEVENT,
  rruleDaily,
  rruleWeekly,
  rruleMonthlyByDay,

  isSabbath,
  guardWindow,

  monthStartFullMoon,

  slugWithTimestamp,
  filenameTS,
};

export default api;

// Also provide CommonJS export for non-ESM loaders
if (typeof module !== "undefined" && module.exports) {
  module.exports = api;
}
