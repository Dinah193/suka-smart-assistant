// src/services/session/utils/timeMath.js
/* eslint-disable no-console */

/**
 * timeMath.js — millisecond helpers, clamping, remaining/elapsed/progress
 * - SSR/browser/Node safe
 * - Defensive optional integration with offsetParser (+20m / PT1H parsing)
 * - Pause-aware remaining/ETA computations for sessions & timed steps
 *
 * Inspired by well-executed apps that keep timers resilient:
 *  - Calm/Headspace style simplicity for formatting
 *  - Notion/Todoist style “natural language” durations
 *  - Apple Fitness style progress & pace summaries
 */

/* -------------------------------- Env-safe now -------------------------------- */
const _now = () => Date.now();

/* --------------------------------- Constants --------------------------------- */
export const MS = Object.freeze({
  second: 1000,
  minute: 60 * 1000,
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
});

/* ---------------------------------- Clamp ----------------------------------- */
export const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
export const between = (n, min, max) => n >= min && n <= max;

/* ---------------------------- Optional offsetParser --------------------------- */
let _offsetParse = null;
try {
  // Prefer your shared parser if available (handles "+20m", "PT1H", etc.)
  // Do NOT hard fail if it isn't present.
  const maybe = require("@/src/services/session/utils/offsetParser.js");
  _offsetParse =
    (maybe && (maybe.default || maybe.parseOffset || maybe.parse)) || null;
} catch (_e) {
  /* no-op */
}

/* ------------------------- Lightweight duration parsing ----------------------- */
/**
 * parseDuration(input) → ms
 * Accepts: number (assumed ms), "500ms", "2s", "3m", "1h", "1d", "1w",
 *          "1h 30m", "90m", ISO-8601 "PT1H30M", and "+20m" (via offsetParser when present)
 */
export function parseDuration(input) {
  if (input == null) return 0;

  // If project offsetParser is present, use it for "+20m", "PT1H", etc.
  if (_offsetParse && typeof input === "string") {
    try {
      const ms = _offsetParse(String(input));
      if (Number.isFinite(ms) && ms >= 0) return ms;
    } catch (_e) {
      // fallthrough to local parsing
    }
  }

  // Numbers are treated as milliseconds already
  if (typeof input === "number" && Number.isFinite(input)) return input;

  const str = String(input).trim().toLowerCase();
  if (!str) return 0;

  // Try ISO-8601 Durations (PT#H#M#S)
  if (/^p(t)?/i.test(str)) {
    const iso = str.toUpperCase();
    // Simple ISO parser (hours/minutes/seconds only; days/weeks uncommon in sessions)
    const h = /(\d+(?:\.\d+)?)H/.exec(iso);
    const m = /(\d+(?:\.\d+)?)M/.exec(iso);
    const s = /(\d+(?:\.\d+)?)S/.exec(iso);
    const ms =
      (h ? parseFloat(h[1]) * MS.hour : 0) +
      (m ? parseFloat(m[1]) * MS.minute : 0) +
      (s ? parseFloat(s[1]) * MS.second : 0);
    if (ms > 0) return ms;
  }

  // Tokenized parser: supports "1h 30m", "90m", "45s", "500ms"
  const tokens = str.split(/[\s,]+/g);
  let total = 0;
  for (const t of tokens) {
    if (!t) continue;
    const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)?$/.exec(t);
    if (!match) continue;
    const val = parseFloat(match[1]);
    const unit = match[2] || "ms";
    switch (unit) {
      case "w":
        total += val * MS.week;
        break;
      case "d":
        total += val * MS.day;
        break;
      case "h":
        total += val * MS.hour;
        break;
      case "m":
        total += val * MS.minute;
        break;
      case "s":
        total += val * MS.second;
        break;
      case "ms":
      default:
        total += val;
        break;
    }
  }
  return Math.max(0, Math.floor(total));
}

/* ---------------------------- Millisecond helpers ---------------------------- */
export const sec = (n = 1) => n * MS.second;
export const min = (n = 1) => n * MS.minute;
export const hr = (n = 1) => n * MS.hour;
export const day = (n = 1) => n * MS.day;
export const week = (n = 1) => n * MS.week;

export const toMs = (v) => parseDuration(v);
export const addMs = (ts, delta) => ts + toMs(delta);
export const diffMs = (a, b) => Math.abs(a - b);

/* ----------------------------- Duration formatting --------------------------- */
/**
 * msParts(…ms) → { weeks, days, hours, minutes, seconds, milliseconds, sign }
 */
export function msParts(ms) {
  const sign = ms < 0 ? -1 : 1;
  let n = Math.abs(ms);

  const weeks = Math.floor(n / MS.week);
  n -= weeks * MS.week;

  const days = Math.floor(n / MS.day);
  n -= days * MS.day;

  const hours = Math.floor(n / MS.hour);
  n -= hours * MS.hour;

  const minutes = Math.floor(n / MS.minute);
  n -= minutes * MS.minute;

  const seconds = Math.floor(n / MS.second);
  n -= seconds * MS.second;

  const milliseconds = n;
  return { weeks, days, hours, minutes, seconds, milliseconds, sign };
}

/**
 * humanize(…ms, { style: "short"|"long", maxUnits: 2, showMs: false }) → "1h 30m"
 */
export function humanize(ms, opts = {}) {
  const { style = "short", maxUnits = 2, showMs = false } = opts;
  const p = msParts(ms);
  const units = [];

  const push = (v, short, long) => {
    if (!v) return;
    units.push(style === "short" ? `${v}${short}` : `${v} ${long}${v !== 1 ? "s" : ""}`);
  };

  push(p.weeks, "w", "week");
  push(p.days, "d", "day");
  push(p.hours, "h", "hour");
  push(p.minutes, "m", "minute");
  push(p.seconds, "s", "second");
  if (showMs && units.length === 0) push(Math.floor(p.milliseconds), "ms", "millisecond");

  const out = units.slice(0, Math.max(1, maxUnits)).join(style === "short" ? " " : ", ");
  return p.sign < 0 ? `-${out}` : out || (showMs ? "0ms" : (style === "short" ? "0s" : "0 seconds"));
}

/**
 * formatEta(targetTs, nowTs) → { etaMs, etaText, overdue: boolean }
 */
export function formatEta(targetTs, nowTs = _now(), opts = {}) {
  const etaMs = targetTs - nowTs;
  const overdue = etaMs < 0;
  return {
    etaMs,
    etaText: overdue ? `${humanize(-etaMs, opts)} ago` : `in ${humanize(etaMs, opts)}`,
    overdue,
  };
}

/* ----------------------------- Pause-aware math ------------------------------ */
/**
 * normalizePauses(pauses)
 * Accepts: array of { start: msEpoch, end?: msEpoch } or null/undefined.
 * - Open pause (no end) is treated as "paused now".
 * - Invalid windows are filtered out safely.
 */
export function normalizePauses(pauses, nowTs = _now()) {
  if (!Array.isArray(pauses)) return [];
  return pauses
    .map((p) => {
      const start = Number(p?.start);
      let end = p?.end == null ? nowTs : Number(p.end);
      if (!Number.isFinite(start)) return null;
      if (!Number.isFinite(end)) end = nowTs;
      if (end < start) [end, p] = [start, { start: end, end: start }]; // swap malformed
      return { start, end };
    })
    .filter(Boolean);
}

/**
 * sumIntervals(pauses) — sums durations of normalized pause windows.
 */
export function sumIntervals(pauses) {
  if (!Array.isArray(pauses) || pauses.length === 0) return 0;

  // Merge overlaps first
  const sorted = [...pauses].sort((a, b) => a.start - b.start);
  const merged = [];
  for (const w of sorted) {
    if (!merged.length) {
      merged.push({ ...w });
    } else {
      const last = merged[merged.length - 1];
      if (w.start <= last.end) {
        last.end = Math.max(last.end, w.end);
      } else {
        merged.push({ ...w });
      }
    }
  }

  return merged.reduce((acc, w) => acc + Math.max(0, w.end - w.start), 0);
}

/**
 * effectiveElapsed(startTs, nowTs, pauses) → elapsed (excluding pauses)
 */
export function effectiveElapsed(startTs, nowTs = _now(), pauses = []) {
  const windows = normalizePauses(pauses, nowTs);
  const totalPaused = sumIntervals(windows);
  return Math.max(0, (nowTs - startTs) - totalPaused);
}

/**
 * remainingProgress({ startTs, durationMs, nowTs, pauses })
 * Returns a session/step progress snapshot that is pause-aware.
 */
export function remainingProgress({
  startTs,
  durationMs,
  nowTs = _now(),
  pauses = [],
}) {
  const dur = toMs(durationMs);
  const elapsed = effectiveElapsed(startTs, nowTs, pauses);
  const remainingMs = clamp(dur - elapsed, 0, dur);
  const progress = dur > 0 ? clamp(elapsed / dur, 0, 1) : 1;
  const complete = progress >= 1 - 1e-9;

  const etaTs = complete ? nowTs : nowTs + remainingMs;
  return {
    startTs,
    nowTs,
    durationMs: dur,
    elapsedMs: elapsed,
    remainingMs,
    progress,
    complete,
    etaTs,
    eta: formatEta(etaTs, nowTs),
  };
}

/* ------------------------------ Scheduling helpers --------------------------- */
/**
 * ceilTo(msEpoch, quantumMs) — round up a timestamp to the next multiple of quantum
 * Useful for aligning reminders (e.g., every 5 minutes).
 */
export function ceilTo(msEpoch, quantumMs) {
  const q = Math.max(1, toMs(quantumMs));
  return Math.ceil(msEpoch / q) * q;
}

/**
 * floorTo(msEpoch, quantumMs) — round down a timestamp to the prior multiple of quantum
 */
export function floorTo(msEpoch, quantumMs) {
  const q = Math.max(1, toMs(quantumMs));
  return Math.floor(msEpoch / q) * q;
}

/**
 * nextTickAligned({ fromTs, everyMs }) — next aligned tick >= fromTs
 * Example: align 2m reminders to the wall clock (00, 02, 04, …).
 */
export function nextTickAligned({ fromTs = _now(), everyMs = min(2) }) {
  const q = Math.max(1, toMs(everyMs));
  const next = ceilTo(fromTs, q);
  return next;
}

/* ---------------------------- Pace & rate utilities -------------------------- */
/**
 * perHour(count, elapsedMs) → count per hour (useful for step throughput)
 */
export function perHour(count, elapsedMs) {
  const e = Math.max(1, elapsedMs);
  return (count * MS.hour) / e;
}

/**
 * estimateFinishTs({ startedAt, totalUnits, doneUnits, nowTs })
 * Given a steady rate since start, estimate finish time for remaining units.
 */
export function estimateFinishTs({ startedAt, totalUnits, doneUnits, nowTs = _now() }) {
  const done = Math.max(0, Math.min(totalUnits, doneUnits));
  if (done <= 0) return null;
  const elapsed = nowTs - startedAt;
  if (elapsed <= 0) return null;

  const rate = done / elapsed; // units per ms
  const remainingUnits = Math.max(0, totalUnits - done);
  const remainingMs = remainingUnits / rate;
  return Math.floor(nowTs + remainingMs);
}

/* ------------------------------- Quick summaries ----------------------------- */
/**
 * summarizeProgress(snapshot) → concise text for HUD/toasts
 */
export function summarizeProgress(snapshot, opts = { style: "short", maxUnits: 2 }) {
  const { progress, remainingMs, complete } = snapshot || {};
  if (complete) return "Done";
  const pct = Number.isFinite(progress) ? Math.round(progress * 100) : 0;
  return `${pct}% • ${humanize(remainingMs, opts)} left`;
}

/* ----------------------------------- Exports --------------------------------- */
const timeMath = {
  MS,
  clamp,
  between,
  sec,
  min,
  hr,
  day,
  week,
  toMs,
  addMs,
  diffMs,
  parseDuration,
  msParts,
  humanize,
  formatEta,
  normalizePauses,
  sumIntervals,
  effectiveElapsed,
  remainingProgress,
  ceilTo,
  floorTo,
  nextTickAligned,
  perHour,
  estimateFinishTs,
  summarizeProgress,
};

export default timeMath;

/* ----------------------------------- Notes -----------------------------------
Usage patterns across your system:

1) Pause-aware session timers (SessionHUD, Orchestrator)
   const snap = remainingProgress({
     startTs: session.startedAt,
     durationMs: session.targetMs,
     pauses: session.pauses, // [{start,end?}, ...]
   });
   hud.update(summarizeProgress(snap)); // "42% • 17m left"

2) Inventory/cooking prep reminders (Schedulers based on session start)
   const next = nextTickAligned({ fromTs: Date.now(), everyMs: "5m" });
   scheduleAt(next, "prep.reminder");

3) Human-friendly UI strings
   humanize("95m")  -> "1h 35m"
   humanize(87000, { style: "long" }) -> "1 minute, 27 seconds"

4) Duration parsing
   parseDuration("+20m")    // via offsetParser if present
   parseDuration("PT1H30M") // ISO-8601 fallback
   parseDuration("90m")     // token parser
-------------------------------------------------------------------------------- */
