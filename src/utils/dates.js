// File: src/utils/dates.js
/**
 * dates.js (SSA)
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Hardened date/time utilities for SSA (browser-safe).
 *  - Handles ISO parsing, ranges, formatting helpers, safe arithmetic, and
 *    "quiet hours" / Sabbath-like guard helpers without hardcoding doctrine.
 *  - Includes a *connector stub* for the SSA Hebrew Calendar engine/app so other
 *    modules can resolve Hebrew-mapped dates without directly importing the
 *    calendar implementation (keeps coupling low).
 *
 * Design goals
 *  - Never throw on invalid inputs; return null/undefined/fallback.
 *  - Prefer ISO-8601 strings for persistence and cross-module contracts.
 *  - Avoid heavy i18n libs; use Intl when available.
 *  - Connector is optional and NOT wired by default (no implicit imports).
 *
 * Notes
 *  - All computations are in local time unless explicitly UTC.
 *  - SSA typically stores ISO strings in UTC (toISOString()) but displays in local.
 *  - Hebrew connector here is a "port" only:
 *      • setHebrewCalendarConnector(connector)
 *      • getHebrewCalendarConnector()
 *      • hebrew() (namespaced helpers that call connector if installed)
 */

const DEFAULT_TIMEOUT_MS = 45_000;

/* --------------------------------- Guards ---------------------------------- */

export function isValidDate(d) {
  return d instanceof Date && !Number.isNaN(d.getTime());
}

export function toDate(v) {
  if (v instanceof Date) return isValidDate(v) ? new Date(v.getTime()) : null;
  if (typeof v === "number") {
    const d = new Date(v);
    return isValidDate(d) ? d : null;
  }
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    const d = new Date(s);
    return isValidDate(d) ? d : null;
  }
  return null;
}

export function toISO(v, fallback = null) {
  const d = toDate(v);
  return d ? d.toISOString() : fallback;
}

/**
 * formatISO (SSA compatibility)
 * -----------------------------------------------------------------------------
 * Compatibility export for modules expecting `formatISO` from "@/utils/dates".
 *
 * - By default returns full ISO string (UTC) via Date#toISOString().
 * - If opts.dateOnly === true OR opts.representation === "date",
 *   returns "YYYY-MM-DD" (UTC) which is stable for storage keys.
 *
 * Safe: never throws; returns fallback on invalid input.
 */
export function formatISO(v, opts = {}) {
  const d = toDate(v);
  if (!d) return opts?.fallback ?? "";
  try {
    const dateOnly =
      opts?.dateOnly === true || String(opts?.representation || "") === "date";
    return dateOnly ? d.toISOString().slice(0, 10) : d.toISOString();
  } catch {
    return opts?.fallback ?? "";
  }
}

/**
 * Returns "YYYY-MM-DD" derived from a date-like value.
 * - Safe: never throws; returns fallback on invalid input.
 * - Uses UTC by slicing Date#toISOString() (stable for storage keys).
 */
export function toISODate(v, fallback = null) {
  const d = toDate(v);
  if (!d) return fallback;
  try {
    return d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  } catch {
    return fallback;
  }
}

/**
 * isSameDay (SSA helper)
 * -----------------------------------------------------------------------------
 * Compare two date-like values by calendar day.
 * - Default compares in local time (more intuitive for UI).
 * - If opts.utc === true, compares in UTC.
 */
export function isSameDay(a, b, { utc = false } = {}) {
  const da = toDate(a);
  const db = toDate(b);
  if (!da || !db) return false;

  if (utc) {
    return (
      da.getUTCFullYear() === db.getUTCFullYear() &&
      da.getUTCMonth() === db.getUTCMonth() &&
      da.getUTCDate() === db.getUTCDate()
    );
  }

  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

/**
 * Parse a date-only ISO string "YYYY-MM-DD" into a local Date at start of day.
 * - If given a full ISO datetime, Date, or ms, it falls back to toDate().
 * - Safe: returns null on invalid inputs.
 */
export function parseISODate(v) {
  if (!v) return null;
  if (v instanceof Date || typeof v === "number") return toDate(v);

  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;

    // Date-only
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (m) {
      const y = Number(m[1]);
      const mo = Number(m[2]) - 1;
      const da = Number(m[3]);
      const d = new Date(y, mo, da, 0, 0, 0, 0); // local start-of-day
      return isValidDate(d) ? d : null;
    }

    // Otherwise let the platform parse (full ISO, RFC, etc.)
    return toDate(s);
  }

  return null;
}

export function isISODateString(v) {
  if (typeof v !== "string") return false;
  // broad ISO matcher; allows timezone "Z" or offsets
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(
    v.trim()
  );
}

export function parseISO(v) {
  if (!v) return null;
  return toDate(v);
}

export function nowISO() {
  return new Date().toISOString();
}

export function nowMs() {
  return Date.now();
}

/* ------------------------------ Basic Helpers ------------------------------ */

export function ms(n) {
  return Number(n) || 0;
}

export function seconds(n) {
  return ms(n) * 1000;
}

export function minutes(n) {
  return seconds(n) * 60;
}

export function hours(n) {
  return minutes(n) * 60;
}

export function days(n) {
  return hours(n) * 24;
}

export function addMs(dateLike, deltaMs) {
  const d = toDate(dateLike);
  if (!d) return null;
  const out = new Date(d.getTime() + (Number(deltaMs) || 0));
  return isValidDate(out) ? out : null;
}

export function addDays(dateLike, deltaDays) {
  return addMs(dateLike, days(deltaDays));
}

export function addMinutes(dateLike, deltaMinutes) {
  return addMs(dateLike, minutes(deltaMinutes));
}

export function startOfDay(dateLike) {
  const d = toDate(dateLike);
  if (!d) return null;
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  return isValidDate(out) ? out : null;
}

export function endOfDay(dateLike) {
  const d = toDate(dateLike);
  if (!d) return null;
  const out = new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    23,
    59,
    59,
    999
  );
  return isValidDate(out) ? out : null;
}

// Legacy aliases expected by existing modules.
export const startOfDayLocal = startOfDay;
export const endOfDayLocal = endOfDay;

export function startOfWeek(dateLike, { weekStartsOn = 0 } = {}) {
  // weekStartsOn: 0 Sunday, 1 Monday, ...
  const d = startOfDay(dateLike);
  if (!d) return null;
  const w = Math.max(0, Math.min(6, Math.trunc(Number(weekStartsOn) || 0)));
  const day = d.getDay();
  const diff = (day - w + 7) % 7;
  return addDays(d, -diff);
}

export function endOfWeek(dateLike, opts = {}) {
  const s = startOfWeek(dateLike, opts);
  if (!s) return null;
  return endOfDay(addDays(s, 6));
}

export function startOfMonth(dateLike) {
  const d = toDate(dateLike);
  if (!d) return null;
  const out = new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
  return isValidDate(out) ? out : null;
}

export function endOfMonth(dateLike) {
  const d = toDate(dateLike);
  if (!d) return null;
  const out = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
  return isValidDate(out) ? out : null;
}

export function differenceMs(a, b) {
  const da = toDate(a);
  const db = toDate(b);
  if (!da || !db) return null;
  return da.getTime() - db.getTime();
}

export function differenceMinutes(a, b) {
  const m = differenceMs(a, b);
  return m == null ? null : Math.round(m / 60000);
}

export function differenceDays(a, b) {
  const m = differenceMs(a, b);
  return m == null ? null : Math.round(m / (1000 * 60 * 60 * 24));
}

/**
 * diffDays (SSA alias)
 * -----------------------------------------------------------------------------
 * Compatibility alias for modules that import `diffDays` from "@/utils/dates".
 * - Delegates to differenceDays.
 * - Returns number | null (same contract as differenceDays).
 */
export function diffDays(a, b) {
  return differenceDays(a, b);
}

export function clampDate(dateLike, minLike, maxLike) {
  const d = toDate(dateLike);
  if (!d) return null;
  const min = toDate(minLike);
  const max = toDate(maxLike);
  const t = d.getTime();
  const tMin = min ? min.getTime() : null;
  const tMax = max ? max.getTime() : null;

  if (tMin != null && t < tMin) return new Date(tMin);
  if (tMax != null && t > tMax) return new Date(tMax);
  return d;
}

/* ------------------------------ Ranges / Lists ------------------------------ */

export function isBetween(
  dateLike,
  startLike,
  endLike,
  { inclusive = true } = {}
) {
  const d = toDate(dateLike);
  const s = toDate(startLike);
  const e = toDate(endLike);
  if (!d || !s || !e) return false;
  const t = d.getTime();
  const a = s.getTime();
  const b = e.getTime();
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return inclusive ? t >= lo && t <= hi : t > lo && t < hi;
}

export function eachDayOfInterval(startLike, endLike) {
  const s = startOfDay(startLike);
  const e = startOfDay(endLike);
  if (!s || !e) return [];
  const out = [];
  const step = s.getTime() <= e.getTime() ? 1 : -1;
  let cur = s;
  while (true) {
    out.push(new Date(cur.getTime()));
    if (cur.getTime() === e.getTime()) break;
    cur = addDays(cur, step);
    if (!cur) break;
    // safety
    if (out.length > 5000) break;
  }
  return out;
}

export function eachHourOfInterval(startLike, endLike) {
  const s = toDate(startLike);
  const e = toDate(endLike);
  if (!s || !e) return [];
  const out = [];
  const step = s.getTime() <= e.getTime() ? 1 : -1;
  let cur = new Date(s.getTime());
  cur.setMinutes(0, 0, 0);
  const end = new Date(e.getTime());
  end.setMinutes(0, 0, 0);

  while (true) {
    out.push(new Date(cur.getTime()));
    if (cur.getTime() === end.getTime()) break;
    cur = addMs(cur, step * 3600000);
    if (!cur) break;
    if (out.length > 20000) break;
  }
  return out;
}

/* ------------------------------ Formatting --------------------------------- */

function safeIntlDateTimeFormat(locale, options) {
  try {
    if (typeof Intl === "undefined" || !Intl.DateTimeFormat) return null;
    return new Intl.DateTimeFormat(locale || undefined, options || undefined);
  } catch {
    return null;
  }
}

export function formatDate(dateLike, opts = {}) {
  const d = toDate(dateLike);
  if (!d) return "";
  const {
    locale,
    year = "numeric",
    month = "short",
    day = "2-digit",
    timeZone,
  } = opts;

  const fmt = safeIntlDateTimeFormat(locale, { year, month, day, timeZone });
  if (!fmt) return d.toLocaleDateString();
  return fmt.format(d);
}

export function formatTime(dateLike, opts = {}) {
  const d = toDate(dateLike);
  if (!d) return "";
  const {
    locale,
    hour = "numeric",
    minute = "2-digit",
    second,
    hour12,
    timeZone,
  } = opts;

  const fmt = safeIntlDateTimeFormat(locale, {
    hour,
    minute,
    ...(second ? { second } : {}),
    ...(hour12 != null ? { hour12 } : {}),
    timeZone,
  });

  if (!fmt) return d.toLocaleTimeString();
  return fmt.format(d);
}

export function formatDateTime(dateLike, opts = {}) {
  const d = toDate(dateLike);
  if (!d) return "";
  const {
    locale,
    year = "numeric",
    month = "short",
    day = "2-digit",
    hour = "numeric",
    minute = "2-digit",
    second,
    hour12,
    timeZone,
  } = opts;

  const fmt = safeIntlDateTimeFormat(locale, {
    year,
    month,
    day,
    hour,
    minute,
    ...(second ? { second } : {}),
    ...(hour12 != null ? { hour12 } : {}),
    timeZone,
  });

  if (!fmt) return d.toLocaleString();
  return fmt.format(d);
}

/**
 * Simple "relative" format (best-effort, no Intl.RelativeTimeFormat dependency).
 */
export function formatRelative(fromLike, toLike = new Date()) {
  const from = toDate(fromLike);
  const to = toDate(toLike);
  if (!from || !to) return "";
  const diff = from.getTime() - to.getTime(); // future positive
  const abs = Math.abs(diff);

  const units = [
    { name: "day", ms: 86400000 },
    { name: "hour", ms: 3600000 },
    { name: "minute", ms: 60000 },
    { name: "second", ms: 1000 },
  ];

  for (const u of units) {
    if (abs >= u.ms || u.name === "second") {
      const n = Math.round(abs / u.ms);
      const plural = n === 1 ? "" : "s";
      return diff >= 0
        ? `in ${n} ${u.name}${plural}`
        : `${n} ${u.name}${plural} ago`;
    }
  }
  return "";
}

/* ---------------------------- Parsing / Tokens ------------------------------ */

export function pad2(n) {
  const x = Math.trunc(Number(n) || 0);
  return String(x).padStart(2, "0");
}

/**
 * Returns "YYYY-MM-DD" in local time.
 */
export function localDateKey(dateLike) {
  const d = toDate(dateLike);
  if (!d) return "";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * Returns "YYYY-MM" in local time.
 */
export function localMonthKey(dateLike) {
  const d = toDate(dateLike);
  if (!d) return "";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

/**
 * Parse "YYYY-MM-DD" to a local Date at start of day.
 */
export function parseLocalDateKey(key) {
  if (typeof key !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const da = Number(m[3]);
  const d = new Date(y, mo, da, 0, 0, 0, 0);
  return isValidDate(d) ? d : null;
}

/* ----------------------------- Quiet Hours Guard ---------------------------- */

/**
 * Determine if a date/time falls within "quiet hours".
 * Example config:
 *  { enabled: true, start: "21:00", end: "07:00" }  // crosses midnight
 */
export function isWithinQuietHours(dateLike, quiet = {}) {
  const d = toDate(dateLike);
  if (!d) return false;
  const enabled = quiet?.enabled !== false;
  if (!enabled) return false;

  const start = String(quiet?.start || "21:00");
  const end = String(quiet?.end || "07:00");

  const parseHHMM = (s) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim());
    if (!m) return null;
    const hh = Math.max(0, Math.min(23, Number(m[1])));
    const mm = Math.max(0, Math.min(59, Number(m[2])));
    return { hh, mm };
  };

  const s = parseHHMM(start);
  const e = parseHHMM(end);
  if (!s || !e) return false;

  const mins = d.getHours() * 60 + d.getMinutes();
  const sM = s.hh * 60 + s.mm;
  const eM = e.hh * 60 + e.mm;

  if (sM === eM) return true; // whole day
  if (sM < eM) {
    // same-day window
    return mins >= sM && mins < eM;
  }
  // crosses midnight
  return mins >= sM || mins < eM;
}

/* ----------------------------- Sabbath-like Guard --------------------------- */

/**
 * Generic "day-of-week window" guard.
 * - Example: block on Saturday (6) and Sunday (0):
 *   { enabled: true, days: [0,6] }
 * - Example: block Friday sundown → Saturday sundown is *not* computed here.
 *   That requires astronomical rules. This helper is only day-of-week based.
 */
export function isBlockedDay(dateLike, rule = {}) {
  const d = toDate(dateLike);
  if (!d) return false;
  const enabled = rule?.enabled !== false;
  if (!enabled) return false;

  const days = Array.isArray(rule?.days) ? rule.days : [];
  const set = new Set(
    days.map((x) => Math.max(0, Math.min(6, Math.trunc(Number(x)))))
  );
  return set.has(d.getDay());
}

/* ----------------------------- Human Durations ------------------------------ */

export function msToParts(msValue) {
  const total = Math.max(0, Number(msValue) || 0);
  const s = Math.floor(total / 1000);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  return { days, hours, minutes, seconds };
}

export function formatDuration(msValue, { compact = false } = {}) {
  const { days, hours, minutes, seconds } = msToParts(msValue);
  if (compact) {
    if (days) return `${days}d ${pad2(hours)}:${pad2(minutes)}`;
    return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
  }
  const parts = [];
  if (days) parts.push(`${days} day${days === 1 ? "" : "s"}`);
  if (hours) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  if (minutes) parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
  if (!parts.length) parts.push(`${seconds} second${seconds === 1 ? "" : "s"}`);
  return parts.join(", ");
}

/* --------------------------- Safe Scheduling Helpers ------------------------- */

export function nextOccurrenceAtTime(dateLike, hhmm, { fromLike } = {}) {
  // Returns next Date occurring at local hh:mm, relative to fromLike (default now)
  const base = toDate(fromLike || new Date());
  const d = toDate(dateLike || base);
  if (!base || !d) return null;

  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || "").trim());
  if (!m) return null;
  const hh = Math.max(0, Math.min(23, Number(m[1])));
  const mm = Math.max(0, Math.min(59, Number(m[2])));

  const candidate = new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    hh,
    mm,
    0,
    0
  );
  if (!isValidDate(candidate)) return null;

  if (candidate.getTime() > base.getTime()) return candidate;

  // otherwise next day
  return addDays(candidate, 1);
}

export function withTimeout(
  promise,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  { signal } = {}
) {
  const t = Math.max(1, Math.trunc(Number(timeoutMs) || 1));

  return new Promise((resolve, reject) => {
    let done = false;
    let timer = null;

    const onAbort = () => {
      if (done) return;
      done = true;
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (signal && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", onAbort);
      }
    };

    if (signal?.aborted) return onAbort();
    if (signal && typeof signal.addEventListener === "function") {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    timer = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error(`Timed out after ${t}ms`));
    }, t);

    Promise.resolve(promise)
      .then((v) => {
        if (done) return;
        done = true;
        cleanup();
        resolve(v);
      })
      .catch((e) => {
        if (done) return;
        done = true;
        cleanup();
        reject(e);
      });
  });
}

/* =============================================================================
 * Hebrew Calendar Connector (PORT ONLY — NOT WIRED)
 * =============================================================================
 * This file intentionally does NOT import the Hebrew Calendar engine.
 *
 * You will install the connector elsewhere (e.g., app boot, calendar module)
 * using setHebrewCalendarConnector().
 *
 * Why:
 *  - Prevent circular imports (calendar ↔ dates).
 *  - Keep dates.js usable for all modules even when calendar code is lazy-loaded.
 *
 * Expected Connector Shape (duck-typed; implement what you need):
 *
 *  {
 *    // Resolve Gregorian -> Hebrew mapping (SSA fixed Hebrew grid)
 *    // input can be Date | ISO | ms
 *    toHebrew: (gregorianLike, opts?) => ({
 *      year: number,
 *      monthIndex: number,      // 0-based in your engine OR 1-based, but be consistent
 *      monthName?: string,
 *      day: number,             // Hebrew day-of-month (1..N)
 *      dayIndex?: number,       // 0-based if your grid uses indexes
 *      isIntercalary?: boolean,
 *      meta?: any
 *    }) | null,
 *
 *    // Resolve Hebrew -> Gregorian date (usually Day 1 anchors + month day offsets)
 *    toGregorian: (hebrewSpec, opts?) => Date | null,
 *    // where hebrewSpec could be:
 *    // { year, monthIndex, day } or { yearKey, monthKey, day } etc.
 *
 *    // Optional helpers for your fixed grid
 *    getYearSpec?: (year) => any,
 *    getMonthLength?: (year, monthIndex, opts?) => number | null,
 *    isHolyDay?: (hebrewSpec, opts?) => ({ id, name, hebrewDay, ... } | null),
 *
 *    // Validation
 *    validateHebrewSpec?: (hebrewSpec, opts?) => ({ ok: boolean, error?: string }),
 *
 *    // Debug/meta
 *    key?: string, // identifier for connector implementation
 *    version?: string|number
 *  }
 */

let _hebrewConnector = null;

/**
 * Install (or clear) the Hebrew calendar connector.
 * This does NOT perform any wiring beyond storing a reference.
 */
export function setHebrewCalendarConnector(connector) {
  _hebrewConnector = connector || null;
}

/**
 * Read the currently installed connector (if any).
 */
export function getHebrewCalendarConnector() {
  return _hebrewConnector;
}

/**
 * Namespaced Hebrew helpers that safely no-op if connector not installed.
 * Use like: dates.hebrew().toHebrew(date)
 */
export function hebrew() {
  const c = _hebrewConnector;

  const safeCall = (fnName, ...args) => {
    try {
      const fn = c && typeof c[fnName] === "function" ? c[fnName] : null;
      return fn ? fn(...args) : null;
    } catch {
      return null;
    }
  };

  const safeBool = (fnName, ...args) => {
    const v = safeCall(fnName, ...args);
    return !!v;
  };

  return {
    /**
     * Convert Gregorian-like input to Hebrew mapping.
     * Returns null if connector missing or conversion fails.
     */
    toHebrew(gregorianLike, opts) {
      return safeCall("toHebrew", gregorianLike, opts);
    },

    /**
     * Convert Hebrew spec to Gregorian Date.
     * Returns null if connector missing or conversion fails.
     */
    toGregorian(hebrewSpec, opts) {
      return safeCall("toGregorian", hebrewSpec, opts);
    },

    /**
     * Returns month length for a Hebrew month in a year.
     * Returns null if connector doesn't provide it.
     */
    getMonthLength(year, monthIndex, opts) {
      return safeCall("getMonthLength", year, monthIndex, opts);
    },

    /**
     * Check if a Hebrew date is a holy day (connector-defined).
     * Returns object or null.
     */
    isHolyDay(hebrewSpec, opts) {
      return safeCall("isHolyDay", hebrewSpec, opts);
    },

    /**
     * Validate a Hebrew spec (connector-defined).
     * Returns { ok, error? } or { ok:false } if not available.
     */
    validateHebrewSpec(hebrewSpec, opts) {
      const v = safeCall("validateHebrewSpec", hebrewSpec, opts);
      if (v && typeof v.ok === "boolean") return v;
      return { ok: safeBool("validateHebrewSpec", hebrewSpec, opts) };
    },

    /**
     * Expose connector metadata if present.
     */
    info() {
      if (!c) return { installed: false };
      return {
        installed: true,
        key: c.key || "hebrew-connector",
        version: c.version,
      };
    },
  };
}
