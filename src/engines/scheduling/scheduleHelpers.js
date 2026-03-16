// File: src/engines/scheduling/scheduleHelpers.js
// SSA — Scheduling Helpers (production-ready)
//
// Purpose:
// - Provide a small, dependency-free scheduling toolkit for SSA.
// - Works with your "fixed planning layers" mindset and session engines.
// - Avoids timezone libraries; uses native Date + Intl with careful guards.
//
// Key ideas:
// - "schedule window" / "quiet hours" / "sabbath guard" helpers
// - recurrence helpers (daily/weekly/monthly) with deterministic behavior
// - "next run" resolution for tasks
// - human formatting and safe parsing
//
// Notes:
// - If you later add Luxon/Temporal, you can swap implementations here
//   without breaking callers, since these functions are pure and stable.
//
// Exports:
// - nowMs, clamp, isFiniteNumber
// - safeDate, toDate, toISODate, toISODateTimeLocal, parseISO
// - startOfDay, endOfDay, addDays, addWeeks, addMonths, diffMs
// - dayOfWeek, isSameDay
// - inWindow, isWithinQuietHours, isWithinSabbathGuard
// - normalizeTimeHHMM, minutesSinceMidnight, dateAtLocalTime
// - nextOccurrence (core recurrence resolver)
// - buildWeeklyRRULE (simple) + parseSimpleRRULE (simple)
// - computeNextRunFromRule
// - formatLocalDate, formatLocalDateTime
// - rankNextRunCandidates
//
// Recurrence Rule (simple):
// {
//   freq: "DAILY"|"WEEKLY"|"MONTHLY"|"ONCE",
//   interval?: number (>=1, default 1)
//   byweekday?: number[] (0-6 where 0=Sun ... 6=Sat) [for WEEKLY]
//   bymonthday?: number[] (1-31) [for MONTHLY]
//   at?: "HH:MM" local time (default "09:00")
//   start?: ISO string or Date (inclusive start boundary)
//   end?: ISO string or Date (optional end boundary)
// }
//
// Quiet hours config (simple):
// {
//   enabled: true,
//   start: "22:00",
//   end: "06:00"
// }
//
// Sabbath guard config (simple):
// {
//   enabled: true,
//   // You can treat "sabbath" as a local day-window.
//   // Default is Sat 00:00 -> Sun 00:00 local.
//   startDow: 6, // 6=Sat
//   startAt: "00:00",
//   durationHours: 24
// }
//
// All functions are safe in SSR and browser contexts.

const DEFAULT_TIME = "09:00";

/* ------------------------------ basics ------------------------------ */

export function nowMs() {
  return Date.now();
}

export function isFiniteNumber(n) {
  return typeof n === "number" && Number.isFinite(n);
}

export function clamp(n, min, max) {
  const nn = isFiniteNumber(n) ? n : min;
  return Math.min(max, Math.max(min, nn));
}

/* ------------------------------ date parsing/formatting ------------------------------ */

export function safeDate(value, fallback = null) {
  const d = toDate(value);
  if (!d) return fallback;
  return d;
}

export function toDate(value) {
  if (!value && value !== 0) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "number") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === "string") {
    // Accept ISO, local-ish, or Date.parse-compatible strings
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

export function parseISO(isoString) {
  return toDate(isoString);
}

export function toISODate(date) {
  const d = toDate(date);
  if (!d) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Local date-time string without timezone "Z" (good for UI input fields)
export function toISODateTimeLocal(date) {
  const d = toDate(date);
  if (!d) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${y}-${m}-${day}T${hh}:${mm}:${ss}`;
}

export function formatLocalDate(date, locales) {
  const d = toDate(date);
  if (!d) return "";
  try {
    return new Intl.DateTimeFormat(locales || undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
    }).format(d);
  } catch {
    return d.toLocaleDateString();
  }
}

export function formatLocalDateTime(date, locales) {
  const d = toDate(date);
  if (!d) return "";
  try {
    return new Intl.DateTimeFormat(locales || undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "numeric",
      minute: "2-digit",
    }).format(d);
  } catch {
    return d.toLocaleString();
  }
}

/* ------------------------------ date math ------------------------------ */

export function startOfDay(date) {
  const d = toDate(date);
  if (!d) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

export function endOfDay(date) {
  const d = toDate(date);
  if (!d) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

export function addDays(date, days) {
  const d = toDate(date);
  if (!d) return null;
  const n = isFiniteNumber(days) ? days : 0;
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

export function addWeeks(date, weeks) {
  return addDays(date, (isFiniteNumber(weeks) ? weeks : 0) * 7);
}

export function addMonths(date, months) {
  const d = toDate(date);
  if (!d) return null;
  const n = isFiniteNumber(months) ? months : 0;
  const out = new Date(d);
  const origDay = out.getDate();
  out.setMonth(out.getMonth() + n);

  // Guard against JS month rollover (e.g., Jan 31 + 1 month => Mar 2)
  // We clamp to last day of target month if needed.
  if (out.getDate() !== origDay) {
    out.setDate(0); // last day of previous month => last day of target month
  }
  return out;
}

export function diffMs(a, b) {
  const da = toDate(a);
  const db = toDate(b);
  if (!da || !db) return 0;
  return da.getTime() - db.getTime();
}

export function dayOfWeek(date) {
  const d = toDate(date);
  if (!d) return 0;
  return d.getDay(); // 0 Sun ... 6 Sat
}

export function isSameDay(a, b) {
  const da = toDate(a);
  const db = toDate(b);
  if (!da || !db) return false;
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

/* ------------------------------ time helpers ------------------------------ */

export function normalizeTimeHHMM(time) {
  const s = String(time || "").trim();
  // Accept "H", "HH", "H:MM", "HH:MM"
  const m = s.match(/^(\d{1,2})(?::(\d{1,2}))?$/);
  if (!m) return DEFAULT_TIME;
  const hh = clamp(parseInt(m[1], 10), 0, 23);
  const mm = clamp(parseInt(m[2] || "0", 10), 0, 59);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export function minutesSinceMidnight(date) {
  const d = toDate(date);
  if (!d) return 0;
  return d.getHours() * 60 + d.getMinutes();
}

export function dateAtLocalTime(date, hhmm) {
  const d = toDate(date);
  if (!d) return null;
  const t = normalizeTimeHHMM(hhmm);
  const [hh, mm] = t.split(":").map((x) => parseInt(x, 10));
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm, 0, 0);
}

/* ------------------------------ windows / guards ------------------------------ */

export function inWindow(date, windowStart, windowEnd) {
  const d = toDate(date);
  const s = toDate(windowStart);
  const e = toDate(windowEnd);
  if (!d || !s || !e) return false;
  const ms = d.getTime();
  return ms >= s.getTime() && ms <= e.getTime();
}

// Quiet hours that can cross midnight (e.g. 22:00 -> 06:00)
export function isWithinQuietHours(date, quietHours) {
  const d = toDate(date);
  if (!d) return false;
  const q = quietHours || {};
  if (!q.enabled) return false;

  const start = normalizeTimeHHMM(q.start || "22:00");
  const end = normalizeTimeHHMM(q.end || "06:00");

  const cur = minutesSinceMidnight(d);
  const sMin = minutesSinceMidnight(dateAtLocalTime(d, start));
  const eMin = minutesSinceMidnight(dateAtLocalTime(d, end));

  // Non-crossing window (e.g. 01:00 -> 05:00)
  if (sMin < eMin) {
    return cur >= sMin && cur < eMin;
  }

  // Crossing midnight (e.g. 22:00 -> 06:00)
  return cur >= sMin || cur < eMin;
}

// Sabbath guard as a local weekly window:
// startDow + startAt for durationHours
export function isWithinSabbathGuard(date, sabbath) {
  const d = toDate(date);
  if (!d) return false;
  const s = sabbath || {};
  if (!s.enabled) return false;

  const startDow = clamp(parseInt(s.startDow ?? 6, 10), 0, 6);
  const startAt = normalizeTimeHHMM(s.startAt || "00:00");
  const durationHours = clamp(parseInt(s.durationHours ?? 24, 10), 1, 72);

  // Find the most recent startDow at startAt at or before date
  const dStartOfDay = startOfDay(d);
  if (!dStartOfDay) return false;

  const curDow = dStartOfDay.getDay();
  // distance back to startDow: (curDow - startDow + 7) % 7
  const backDays = (curDow - startDow + 7) % 7;
  const candidateStart = dateAtLocalTime(
    addDays(dStartOfDay, -backDays),
    startAt
  );

  // If candidateStart is in the future (because startAt later today), go back 7 days
  let start = candidateStart;
  if (start && start.getTime() > d.getTime()) {
    start = addDays(start, -7);
  }

  if (!start) return false;
  const end = new Date(start.getTime() + durationHours * 60 * 60 * 1000);

  return d.getTime() >= start.getTime() && d.getTime() < end.getTime();
}

/* ------------------------------ recurrence: core resolver ------------------------------ */

// Determine if a date matches byweekday constraint
function matchesByWeekday(date, byweekday) {
  if (!Array.isArray(byweekday) || byweekday.length === 0) return true;
  const d = toDate(date);
  if (!d) return false;
  const dow = d.getDay();
  return byweekday.includes(dow);
}

// Determine if a date matches bymonthday constraint
function matchesByMonthDay(date, bymonthday) {
  if (!Array.isArray(bymonthday) || bymonthday.length === 0) return true;
  const d = toDate(date);
  if (!d) return false;
  const dom = d.getDate();
  return bymonthday.includes(dom);
}

// Next occurrence resolver for simple recurrence rules.
// - from: Date | string | number (base time to compute from)
// - rule: {freq, interval, byweekday, bymonthday, at, start, end}
// Returns: Date|null (next run strictly AFTER "from", unless from < start then from is treated as start-1ms)
export function nextOccurrence(from, rule) {
  const base = toDate(from) || new Date();
  const r = rule || {};
  const freq = String(r.freq || "ONCE").toUpperCase();
  const interval = clamp(parseInt(r.interval ?? 1, 10), 1, 365);
  const at = normalizeTimeHHMM(r.at || DEFAULT_TIME);

  const startBound = toDate(r.start) || null;
  const endBound = toDate(r.end) || null;

  // If base is before startBound, treat base as startBound - 1ms so next run can be startBound date @ at
  const baseMs = base.getTime();
  const effectiveFrom =
    startBound && baseMs < startBound.getTime()
      ? new Date(startBound.getTime() - 1)
      : base;

  // ONCE: choose start@at (or base@at if no start)
  if (freq === "ONCE") {
    const seedDay = startBound
      ? startOfDay(startBound)
      : startOfDay(effectiveFrom);
    const candidate = seedDay ? dateAtLocalTime(seedDay, at) : null;
    if (!candidate) return null;

    // must be > effectiveFrom
    let next = candidate.getTime() > effectiveFrom.getTime() ? candidate : null;

    // If startBound includes a time later than at, bump to that exact startBound time (but still must be > from)
    if (!next && startBound) {
      if (startBound.getTime() > effectiveFrom.getTime()) next = startBound;
    }

    if (next && endBound && next.getTime() > endBound.getTime()) return null;
    return next;
  }

  // DAILY / WEEKLY / MONTHLY: iterate safely with bounds.
  // We avoid infinite loops by limiting attempts.
  const MAX_STEPS = 2000;

  let cursor = new Date(effectiveFrom);
  // start from the next minute to ensure strictly-after semantics
  cursor = new Date(cursor.getTime() + 60 * 1000);

  // Start candidates on the cursor day at "at"
  let candidate = dateAtLocalTime(cursor, at);
  if (!candidate) return null;

  // If "at" is before cursor time on same day, push to next day
  if (candidate.getTime() <= effectiveFrom.getTime()) {
    candidate = addDays(candidate, 1);
    if (!candidate) return null;
    candidate = dateAtLocalTime(candidate, at);
    if (!candidate) return null;
  }

  // Helper to enforce bounds and by* matches
  const accept = (dt) => {
    if (!dt) return false;
    if (startBound && dt.getTime() < startBound.getTime()) return false;
    if (endBound && dt.getTime() > endBound.getTime()) return false;
    if (freq === "WEEKLY" && !matchesByWeekday(dt, r.byweekday)) return false;
    if (freq === "MONTHLY" && !matchesByMonthDay(dt, r.bymonthday))
      return false;
    return true;
  };

  // Build an anchor date for interval stepping:
  // - If startBound exists, anchor from its startOfDay, else from effectiveFrom startOfDay.
  const anchor =
    startOfDay(startBound || effectiveFrom) ||
    startOfDay(new Date()) ||
    new Date();

  // Compute difference in units from anchor to candidate, then check if aligned with interval.
  const isAligned = (dt) => {
    if (!dt) return false;
    if (freq === "DAILY") {
      const days = Math.floor(
        (startOfDay(dt).getTime() - startOfDay(anchor).getTime()) /
          (24 * 60 * 60 * 1000)
      );
      return days >= 0 && days % interval === 0;
    }
    if (freq === "WEEKLY") {
      const weeks = Math.floor(
        (startOfDay(dt).getTime() - startOfDay(anchor).getTime()) /
          (7 * 24 * 60 * 60 * 1000)
      );
      return weeks >= 0 && weeks % interval === 0;
    }
    if (freq === "MONTHLY") {
      const aY = anchor.getFullYear();
      const aM = anchor.getMonth();
      const dY = dt.getFullYear();
      const dM = dt.getMonth();
      const months = (dY - aY) * 12 + (dM - aM);
      return months >= 0 && months % interval === 0;
    }
    return true;
  };

  let steps = 0;
  while (steps++ < MAX_STEPS) {
    if (accept(candidate) && isAligned(candidate)) return candidate;

    // step strategy:
    if (freq === "DAILY") {
      candidate = addDays(candidate, 1);
      candidate = candidate ? dateAtLocalTime(candidate, at) : null;
      if (!candidate) return null;
      continue;
    }

    if (freq === "WEEKLY") {
      // If byweekday is set, walk day-by-day until a matching weekday within aligned weeks.
      // Else step by 1 day but only accept if week aligned.
      candidate = addDays(candidate, 1);
      candidate = candidate ? dateAtLocalTime(candidate, at) : null;
      if (!candidate) return null;
      continue;
    }

    if (freq === "MONTHLY") {
      // Walk day-by-day; accept bymonthday and month alignment.
      candidate = addDays(candidate, 1);
      candidate = candidate ? dateAtLocalTime(candidate, at) : null;
      if (!candidate) return null;
      continue;
    }

    // Unknown freq
    return null;
  }

  return null;
}

/* ------------------------------ simple RRULE helpers ------------------------------ */

// Weekly RRULE builder for SSA internal configs (not full RFC 5545).
// Example: buildWeeklyRRULE({ byweekday:[1,3,5], at:"08:30", interval:1 })
export function buildWeeklyRRULE({
  byweekday = [],
  at = DEFAULT_TIME,
  interval = 1,
} = {}) {
  const days = Array.isArray(byweekday) ? byweekday : [];
  const i = clamp(parseInt(interval ?? 1, 10), 1, 365);
  const t = normalizeTimeHHMM(at);
  return {
    freq: "WEEKLY",
    interval: i,
    byweekday: uniq(days).map((d) => clamp(parseInt(d, 10), 0, 6)),
    at: t,
  };
}

// Parse a "simple RRULE string" if you store them as strings.
// Supported subset: FREQ=;INTERVAL=;BYWEEKDAY=;BYMONTHDAY=;AT=
// BYWEEKDAY uses 0-6 or SU,MO,TU,WE,TH,FR,SA
export function parseSimpleRRULE(str) {
  const s = String(str || "").trim();
  if (!s) return null;
  const parts = s
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean);
  const out = {};
  for (const p of parts) {
    const [kRaw, vRaw] = p.split("=");
    const k = String(kRaw || "")
      .trim()
      .toUpperCase();
    const v = String(vRaw || "").trim();
    if (!k) continue;

    if (k === "FREQ") out.freq = v.toUpperCase();
    if (k === "INTERVAL") out.interval = clamp(parseInt(v, 10), 1, 365);
    if (k === "AT") out.at = normalizeTimeHHMM(v);

    if (k === "BYWEEKDAY") {
      const map = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
      out.byweekday = v
        .split(",")
        .map((x) => x.trim().toUpperCase())
        .filter(Boolean)
        .map((x) => (x in map ? map[x] : clamp(parseInt(x, 10), 0, 6)));
    }

    if (k === "BYMONTHDAY") {
      out.bymonthday = v
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => clamp(parseInt(x, 10), 1, 31));
    }
  }
  if (!out.freq) return null;
  out.at = normalizeTimeHHMM(out.at || DEFAULT_TIME);
  out.interval = clamp(parseInt(out.interval ?? 1, 10), 1, 365);
  return out;
}

/* ------------------------------ next run computation w/ guards ------------------------------ */

// Computes next run time from a recurrence rule while honoring optional guards.
// - from: Date|number|string
// - rule: as described above
// - opts: { quietHours, sabbathGuard, maxBumps }
// Returns { next: Date|null, blockedBy: string|null }
export function computeNextRunFromRule(from, rule, opts = {}) {
  const maxBumps = clamp(parseInt(opts.maxBumps ?? 400, 10), 1, 5000);
  let next = nextOccurrence(from, rule);
  if (!next) return { next: null, blockedBy: null };

  // If next lands in quiet hours or sabbath guard, bump forward until it's allowed.
  let bumps = 0;
  while (next && bumps++ < maxBumps) {
    if (opts.quietHours && isWithinQuietHours(next, opts.quietHours)) {
      // bump to end of quiet hours on that day
      const end = normalizeTimeHHMM(opts.quietHours.end || "06:00");
      const endDt = dateAtLocalTime(next, end);
      // if end is earlier than current time window (cross-midnight), move to next day at end
      const candidate =
        endDt && endDt.getTime() > next.getTime()
          ? endDt
          : dateAtLocalTime(addDays(next, 1), end);
      next = nextOccurrence(candidate || addDays(next, 1), rule);
      continue;
    }

    if (opts.sabbathGuard && isWithinSabbathGuard(next, opts.sabbathGuard)) {
      // bump to end of sabbath window
      const s = opts.sabbathGuard || {};
      const startDow = clamp(parseInt(s.startDow ?? 6, 10), 0, 6);
      const startAt = normalizeTimeHHMM(s.startAt || "00:00");
      const durationHours = clamp(parseInt(s.durationHours ?? 24, 10), 1, 72);

      // find start of the sabbath window containing next, then jump to its end
      const dStart = startOfDay(next);
      const curDow = dStart.getDay();
      const backDays = (curDow - startDow + 7) % 7;
      let start = dateAtLocalTime(addDays(dStart, -backDays), startAt);
      if (start && start.getTime() > next.getTime()) start = addDays(start, -7);
      const end = start
        ? new Date(start.getTime() + durationHours * 60 * 60 * 1000)
        : null;

      next = nextOccurrence(end || addDays(next, 1), rule);
      continue;
    }

    // allowed
    return { next, blockedBy: null };
  }

  // If we exhausted bumps, consider it blocked by guards
  if (next && opts.quietHours && isWithinQuietHours(next, opts.quietHours)) {
    return { next: null, blockedBy: "quietHours" };
  }
  if (
    next &&
    opts.sabbathGuard &&
    isWithinSabbathGuard(next, opts.sabbathGuard)
  ) {
    return { next: null, blockedBy: "sabbathGuard" };
  }

  return { next, blockedBy: "guardLoop" };
}

/* ------------------------------ ranking utilities ------------------------------ */

// Rank candidate runs (soonest first), stable.
export function rankNextRunCandidates(candidates) {
  const list = Array.isArray(candidates) ? candidates.slice() : [];
  list.sort((a, b) => {
    const ta = toDate(a?.next)?.getTime?.() ?? Number.POSITIVE_INFINITY;
    const tb = toDate(b?.next)?.getTime?.() ?? Number.POSITIVE_INFINITY;
    if (ta !== tb) return ta - tb;
    const ka = String(a?.id || a?.key || "");
    const kb = String(b?.id || b?.key || "");
    return ka.localeCompare(kb);
  });
  return list;
}
