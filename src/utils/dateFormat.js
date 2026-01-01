/* eslint-disable no-console */
// src/utils/dateFormat.js
// Unified time & duration formatter for Suka Smart Assistant
// - Human durations: "04:17 remaining", "2h 3m", "1d 02:05:09"
// - Relative time: "in 12 min", "3 hours ago"
// - Timestamp formatting with locale/tz
// - Optional ticking helpers that emit to the shared event bus
//
// Design goals:
//  - Defensive: works without any app stores; gracefully no-ops when deps missing
//  - DI-friendly: picks up eventBus and user prefs if present
//  - Predictable: stable defaults, clamp/rounding options, pad control
//  - Session-friendly: label helpers for "remaining" vs "elapsed"
//  - ESM + CJS interop

(function () {
  /* ----------------------------- Optional deps ------------------------------ */
  let eventBus = { emit() {}, on() {}, off() {} };
  try {
    // Try default export, then named, then raw module
    const eb = require("@/services/eventBus");
    eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
  } catch (_e) {}

  // Optional user prefs store: prefers 24h clock, locale, timezone, etc.
  // This file should NOT hard-require it.
  let getUserTimePrefs = () => ({ use24h: null, locale: null, timeZone: null });
  try {
    // Example: a tiny selector exported from your settings store
    const prefsMod = require("@/stores/prefs/timePrefs");
    if (prefsMod && (prefsMod.getTimePrefs || prefsMod.default)) {
      const api = prefsMod.getTimePrefs || prefsMod.default;
      if (typeof api === "function") getUserTimePrefs = api;
    }
  } catch (_e) {}

  /* ------------------------------ Mini helpers ------------------------------ */
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const signOf = (n) => (n < 0 ? -1 : n > 0 ? 1 : 0);
  const abs = Math.abs;

  // Normalize Date|number|string -> timestamp (ms)
  const toTs = (x) =>
    x instanceof Date ? x.getTime() : typeof x === "number" ? x : Date.parse(x);

  // Intl.RelativeTimeFormat with fallback
  const rtf = (locale) => {
    try {
      return new Intl.RelativeTimeFormat(locale || undefined, { numeric: "auto" });
    } catch {
      return null;
    }
  };

  /* ---------------------------- Duration breakdown -------------------------- */
  /**
   * Break a duration in ms into labeled parts.
   * @param {number} ms
   * @returns {{ sign: -1|0|1, days:number, hours:number, minutes:number, seconds:number, millis:number, totalMs:number }}
   */
  function durationParts(ms) {
    const sgn = signOf(ms);
    let rem = abs(ms);

    const days = Math.floor(rem / 86400000);
    rem -= days * 86400000;

    const hours = Math.floor(rem / 3600000);
    rem -= hours * 3600000;

    const minutes = Math.floor(rem / 60000);
    rem -= minutes * 60000;

    const seconds = Math.floor(rem / 1000);
    rem -= seconds * 1000;

    const millis = rem | 0;

    return { sign: sgn, days, hours, minutes, seconds, millis, totalMs: ms };
  }

  /* ---------------------------- Digital clock core -------------------------- */
  /**
   * Convert ms -> digital clock string.
   * @param {number} ms
   * @param {{
   *   padHours?: boolean,
   *   showDays?: boolean,
   *   showMillis?: boolean,
   *   clampZero?: boolean,   // if true, negatives show "00:00" (or "0:00") instead of "-00:00"
   *   maxUnit?: "auto"|"d"|"h"|"m"|"s",
   * }} [opts]
   * @returns {string}
   */
  function toDigitalClock(ms, opts = {}) {
    const {
      padHours = true,
      showDays = false,
      showMillis = false,
      clampZero: cz = true,
      maxUnit = "auto",
    } = opts;

    if (cz && ms <= 0) {
      // Pick a floor format based on showDays
      return showDays ? "0d 00:00:00" : padHours ? "00:00" : "0:00";
    }

    const d = durationParts(ms);
    const sign = d.sign < 0 && !cz ? "-" : "";

    // Promote smallest unit depending on maxUnit
    const withDays = showDays || d.days > 0 || maxUnit === "d";
    const hours = withDays ? d.hours : d.hours + d.days * 24;
    const HH = padHours ? String(hours).padStart(2, "0") : String(hours);
    const MM = String(d.minutes).padStart(2, "0");
    const SS = String(d.seconds).padStart(2, "0");
    const MS = String(d.millis).padStart(3, "0");

    if (withDays) {
      return `${sign}${d.days}d ${String(d.hours).padStart(2, "0")}:${MM}:${SS}${showMillis ? "." + MS : ""}`;
    }

    return `${sign}${HH}:${MM}${maxUnit === "m" ? "" : ":" + SS}${showMillis ? "." + MS : ""}`;
  }

  /* ------------------------------ Human duration ---------------------------- */
  /**
   * Human duration like "2h 3m", "04:17 remaining", "1d 02:05:09"
   * @param {number} ms
   * @param {{
   *   style?: "clock" | "compact" | "long",
   *   suffix?: "" | "remaining" | "elapsed",
   *   padHours?: boolean,
   *   showDays?: boolean,
   *   showMillis?: boolean,
   *   clampZero?: boolean,
   *   maxUnit?: "auto"|"d"|"h"|"m"|"s",
   * }} [opts]
   * @returns {string}
   */
  function formatDuration(ms, opts = {}) {
    const {
      style = "clock",
      suffix = "",
      padHours,
      showDays,
      showMillis,
      clampZero,
      maxUnit,
    } = opts;

    if (style === "clock") {
      const base = toDigitalClock(ms, { padHours, showDays, showMillis, clampZero, maxUnit });
      return suffix ? `${base} ${suffix}` : base;
    }

    const d = durationParts(ms);
    const parts = [];
    if (d.days) parts.push(`${d.days}d`);
    if (d.hours) parts.push(`${d.hours}h`);
    if (d.minutes) parts.push(`${d.minutes}m`);
    if (d.seconds || parts.length === 0) parts.push(`${d.seconds}s`);

    let s = style === "long"
      ? parts
          .map((p) => {
            const v = parseInt(p, 10);
            if (p.endsWith("d")) return `${v} day${v === 1 ? "" : "s"}`;
            if (p.endsWith("h")) return `${v} hour${v === 1 ? "" : "s"}`;
            if (p.endsWith("m")) return `${v} minute${v === 1 ? "" : "s"}`;
            return `${v} second${v === 1 ? "" : "s"}`;
          })
          .join(", ")
      : parts.join(" ");

    // Negative durations (elapsed) when suffix not given
    if (!suffix && d.sign < 0) {
      s += " ago";
    } else if (suffix) {
      s += ` ${suffix}`;
    }
    return s;
  }

  /* ------------------------------ Relative time ----------------------------- */
  /**
   * Relative time between a future/past date and now (or provided 'from').
   * @param {Date|string|number} date
   * @param {{ from?: Date|string|number, locale?: string }} [opts]
   * @returns {string} e.g., "in 12 min", "3 hours ago"
   */
  function formatRelative(date, opts = {}) {
    const { from, locale } = opts;
    const to = toTs(date);
    const base = from != null ? toTs(from) : Date.now();
    const diff = to - base;

    const absMs = abs(diff);
    const parts = durationParts(absMs);

    const rel = rtf(locale || getUserTimePrefs().locale);
    const valueSign = diff < 0 ? -1 : 1;

    const unit =
      parts.days >= 1
        ? "day"
        : parts.hours >= 1
        ? "hour"
        : parts.minutes >= 1
        ? "minute"
        : "second";

    const value =
      unit === "day"
        ? valueSign * (parts.days || 1)
        : unit === "hour"
        ? valueSign * (parts.hours || 1)
        : unit === "minute"
        ? valueSign * (parts.minutes || 1)
        : valueSign * (parts.seconds || 0);

    if (rel) {
      return rel.format(value, unit);
    }
    // Basic fallback
    const human = formatDuration(diff, { style: "compact" });
    return human;
  }

  /* --------------------------- Timestamp formatting ------------------------- */
  /**
   * Locale-aware timestamp formatting.
   * @param {Date|string|number} date
   * @param {{
   *   locale?: string,
   *   timeZone?: string,
   *   withTime?: boolean,
   *   use24h?: boolean|null,
   *   dateStyle?: "full"|"long"|"medium"|"short",
   *   timeStyle?: "full"|"long"|"medium"|"short",
   * }} [opts]
   * @returns {string}
   */
  function formatTimestamp(date, opts = {}) {
    const ts = toTs(date);
    const prefs = getUserTimePrefs();
    const {
      locale = prefs.locale || undefined,
      timeZone = prefs.timeZone || undefined,
      withTime = true,
      use24h = prefs.use24h,
      dateStyle = "medium",
      timeStyle = "short",
    } = opts;

    // Build options for Intl.DateTimeFormat
    const base = withTime
      ? { dateStyle, timeStyle, hour12: use24h == null ? undefined : !use24h }
      : { dateStyle };

    try {
      return new Intl.DateTimeFormat(locale, { ...base, timeZone }).format(ts);
    } catch {
      // Fallback ISO-ish
      return new Date(ts).toLocaleString();
    }
  }

  /* ------------------------------ Range helpers ----------------------------- */
  /**
   * Human schedule window: "Today 3:00–4:30 PM", "Tue 08:00–09:15"
   * Respects user 24h preference when available.
   * @param {Date|string|number} start
   * @param {Date|string|number} end
   * @param {{ locale?:string, timeZone?:string, includeWeekday?: boolean }} [opts]
   */
  function formatWindow(start, end, opts = {}) {
    const prefs = getUserTimePrefs();
    const {
      locale = prefs.locale || undefined,
      timeZone = prefs.timeZone || undefined,
      includeWeekday = true,
    } = opts;

    const dtfDay = new Intl.DateTimeFormat(locale, {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone,
    });

    const use24h = prefs.use24h;
    const tOpts = {
      hour: "2-digit",
      minute: "2-digit",
      hour12: use24h == null ? undefined : !use24h,
      timeZone,
    };
    const dtfTime = new Intl.DateTimeFormat(locale, tOpts);

    const s = new Date(toTs(start));
    const e = new Date(toTs(end));

    const dayPart = includeWeekday ? `${dtfDay.format(s)} ` : "";
    return `${dayPart}${dtfTime.format(s)}–${dtfTime.format(e)}`;
  }

  /* ----------------------------- Countdown labels --------------------------- */
  /**
   * Convenience for the common UI string: "04:17 remaining"
   * @param {number} remainingMs
   * @param {{ showDays?: boolean, clampZero?: boolean }} [opts]
   */
  function countdownLabel(remainingMs, opts = {}) {
    return formatDuration(remainingMs, {
      style: "clock",
      suffix: "remaining",
      padHours: true,
      showDays: !!opts.showDays,
      clampZero: opts.clampZero !== false, // default true
    });
  }

  /* -------------------------- Optional ticker (eventBus) --------------------- */
  /**
   * Create a lightweight countdown ticker that emits formatted labels over the eventBus.
   * Usage: const t = makeCountdownTicker({ id: "cook:step:123", until: Date.now()+300000 })
   *        t.start(); ... t.stop()
   *
   * Emits:
   *  - "time:countdown:tick" { id, remainingMs, label, done:boolean }
   *  - "time:countdown:done" { id }
   */
  function makeCountdownTicker({ id, until, interval = 1000, showDays = false } = {}) {
    let handle = null;
    const endAt = typeof until === "number" ? until : toTs(until);

    const tick = () => {
      const now = Date.now();
      const remaining = endAt - now;
      const done = remaining <= 0;
      const label = countdownLabel(remaining, { showDays, clampZero: true });
      eventBus.emit("time:countdown:tick", { id, remainingMs: remaining, label, done });
      if (done) {
        eventBus.emit("time:countdown:done", { id });
        stop();
      }
    };

    const start = () => {
      if (handle) return;
      tick();
      handle = setInterval(tick, clamp(interval, 200, 2000));
    };
    const stop = () => {
      if (handle) {
        clearInterval(handle);
        handle = null;
      }
    };
    return { start, stop };
  }

  /* ------------------------------- Exports ---------------------------------- */
  const api = {
    durationParts,
    toDigitalClock,
    formatDuration,
    formatRelative,
    formatTimestamp,
    formatWindow,
    countdownLabel,
    makeCountdownTicker,
  };

  // ESM default export
  try {
    module.exports = api; // CJS
  } catch (_e) {}
  // Also support ESM named/default when bundlers transform
  // eslint-disable-next-line no-undef
  if (typeof exports !== "undefined") {
    for (const k of Object.keys(api)) exports[k] = api[k];
    // @ts-ignore
    exports.default = api;
  }
  // Browser global (as a last resort)
  // @ts-ignore
  if (typeof window !== "undefined") window.SukaDateFormat = api;
})();
