/* eslint-disable no-console */
// offsetParser.js — shared "+20m" / "T+5m" / "PT1H" (ISO 8601) and friends
// Also parses window shorthand "20m?" (returns windowMs) and a few ergonomic forms.
//
// Goals:
//  - Single source of truth for offset → milliseconds parsing across guards/scheduler
//  - Friendly: supports "+1h30m", "1.5h", "90s", "08:30", "tomorrow 7am"
//  - Optional: snap to "next unquiet" if Sabbath/quiet-hours are active
//
// Exports:
//  - parseOffset(expr, opts?) -> { ms, targetTs, windowMs?, kind, normalized }
//  - parseWindow(expr) -> windowMs | null
//  - parseRange(expr) -> { startMs, endMs } | null   (e.g., "10..20m", "10-20m")
//  - toMs(expr) -> number|null                        (number passthrough, string parsed)
//  - formatMs(ms) -> "1h 20m"                         (human-ish)
//  - snapToUnquiet(ts, helpers?) -> ts'               (optional Sabbath/quiet-hours snap)
//
// Notes:
//  - baseTs defaults to Date.now() for relative forms.
//  - If expr includes a "?" suffix (e.g., "25m?"), windowMs is filled.
//  - "T+5m" behaves like "+5m" (the "T+" prefix is ignored).
//  - ISO 8601 duration "PT..." supported for hours/minutes/seconds/days.

(function () {
  const isBrowser = typeof window !== "undefined";
  const now = () => Date.now();

  // Lazy optional helper import (quiet hours/Sabbath)
  let scheduleHelpers = null;
  try { scheduleHelpers = require("@/services/scheduleHelpers"); } catch (_e) {}

  // ------------------------------ Utilities -----------------------------------
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  function safeLower(s) { return (s || "").toString().trim().toLowerCase(); }

  function num(n, d = 0) {
    const v = Number(n);
    return Number.isFinite(v) ? v : d;
  }

  function isIsoDuration(s) {
    return /^P(T(?=[\dHMS])(?:\d+H)?(?:\d+M)?(?:\d+S)?|\d+D(?:T(?:\d+H)?(?:\d+M)?(?:\d+S)?)?)$/i.test(safeLower(s));
  }

  // "1h 30m", "90m", "1.5h", "45s", "2h30m", "PT1H30M"
  function parseRelativeChunk(str) {
    const s = safeLower(str).replace(/^t\+\s*/i, "").replace(/^\+/, "");
    if (!s) return 0;

    // ISO 8601 duration
    if (isIsoDuration(s)) return isoDurationToMs(s);

    // Compact forms: "2h30m", "1h20m15s"
    const compact = s.match(/^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m)?\s*(?:(\d+(?:\.\d+)?)\s*s)?$/i);
    if (compact && (compact[1] || compact[2] || compact[3])) {
      const h = num(compact[1]); const m = num(compact[2]); const sec = num(compact[3]);
      return h * 3600000 + m * 60000 + sec * 1000;
    }

    // Single unit like "90m", "45s", "1.5h"
    const single = s.match(/^(\d+(?:\.\d+)?)(\s*(ms|s|m|h|d))?$/i);
    if (single) {
      const n = parseFloat(single[1]);
      const unit = (single[3] || "ms").toLowerCase();
      const mult = unit === "d" ? 86400000 : unit === "h" ? 3600000 : unit === "m" ? 60000 : unit === "s" ? 1000 : 1;
      return n * mult;
    }

    // Natural-ish: "10 min", "2 hours", "1 hr 20"
    const natural = s
      .replace(/mins?/g, "m").replace(/minutes?/g, "m")
      .replace(/hours?/g, "h").replace(/\bhr(s)?\b/g, "h")
      .replace(/secs?/g, "s").replace(/seconds?/g, "s")
      .trim();
    if (natural !== s) {
      return parseRelativeChunk(natural);
    }

    // Clock forms "mm:ss" or "h:mm"
    const clock = s.match(/^(\d{1,2}):(\d{2})$/);
    if (clock) {
      const a = num(clock[1]);
      const b = num(clock[2]);
      // Heuristic: if first part >= 2, treat as hours:minutes else minutes:seconds
      if (a >= 2) return a * 3600000 + b * 60000;
      return a * 60000 + b * 1000;
    }

    return NaN; // fall through
  }

  function isoDurationToMs(iso) {
    const s = safeLower(iso);
    const m = s.match(/^p(?:(\d+)d)?(?:t(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?)?$/i);
    if (!m) return NaN;
    const d = num(m[1]), h = num(m[2]), min = num(m[3]), sec = num(m[4]);
    return d * 86400000 + h * 3600000 + min * 60000 + sec * 1000;
  }

  // Absolute times (today/tomorrow HH:mm, 12h “7:30 pm”, bare "08:15")
  function parseAbsoluteTarget(expr, baseTs) {
    const s = safeLower(expr).trim();
    const d = new Date(baseTs || now());

    // tomorrow HH:mm / today HH:mm
    const m1 = s.match(/^(today|tomorrow)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
    if (m1) {
      const when = m1[1];
      let h = num(m1[2]);
      const mm = num(m1[3]);
      const ap = (m1[4] || "").toLowerCase();
      if (ap) {
        if (ap === "pm" && h < 12) h += 12;
        if (ap === "am" && h === 12) h = 0;
      }
      const target = new Date(d);
      if (when === "tomorrow") target.setDate(target.getDate() + 1);
      target.setHours(h, mm, 0, 0);
      return target.getTime();
    }

    // HH:mm or h:mm am/pm
    const m2 = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
    if (m2) {
      let h = num(m2[1]);
      const mm = num(m2[2]);
      const ap = (m2[3] || "").toLowerCase();
      if (ap) {
        if (ap === "pm" && h < 12) h += 12;
        if (ap === "am" && h === 12) h = 0;
      }
      const target = new Date(d);
      target.setHours(h, mm, 0, 0);
      // If target already passed today, roll to tomorrow
      if (target.getTime() <= (baseTs || now())) {
        target.setDate(target.getDate() + 1);
      }
      return target.getTime();
    }

    return NaN;
  }

  function stripWindowSuffix(expr) {
    const s = (expr || "").toString().trim();
    const m = s.match(/^(.*?)(\?)$/);
    return m ? { core: m[1].trim(), hasWindow: true } : { core: s, hasWindow: false };
  }

  // "20m?" -> 20m window
  function parseWindow(expr) {
    if (typeof expr === "number") return null;
    const { core, hasWindow } = stripWindowSuffix(expr);
    if (!hasWindow) return null;
    const ms = parseRelativeChunk(core);
    return Number.isFinite(ms) ? ms : null;
  }

  // "10..20m" / "10-20m"
  function parseRange(expr) {
    const s = safeLower(expr).replace(/\s/g, "");
    const m = s.match(/^(\+)?(\d+(?:\.\d+)?)(ms|s|m|h|d)?(?:\.{2}|-)(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/i);
    if (!m) return null;
    const n1 = parseFloat(m[2]);
    const u1 = (m[3] || m[5] || "m").toLowerCase();
    const n2 = parseFloat(m[4]);
    const u2 = (m[5] || u1).toLowerCase();
    const mult = (u) => u === "d" ? 86400000 : u === "h" ? 3600000 : u === "m" ? 60000 : u === "s" ? 1000 : 1;
    return { startMs: n1 * mult(u1), endMs: n2 * mult(u2) };
  }

  // ------------------------------ Public: parseOffset --------------------------
  /**
   * parseOffset("+20m"), parseOffset("PT1H"), parseOffset("08:30"), parseOffset("tomorrow 7am")
   * opts:
   *  - baseTs: reference timestamp (default: Date.now())
   *  - snapUnquiet: boolean (default false)
   *  - helpers: override { isSabbath(ts), inQuietHours(ts), nextUnquiet(ts) }
   */
  function parseOffset(expr, opts = {}) {
    if (expr == null || expr === "") return { ms: 0, targetTs: opts.baseTs || now(), windowMs: null, kind: "zero", normalized: "0ms" };
    if (typeof expr === "number") {
      const ms = expr;
      const targetTs = (opts.baseTs || now()) + ms;
      const finalTs = opts.snapUnquiet ? snapToUnquiet(targetTs, opts.helpers) : targetTs;
      return { ms, targetTs: finalTs, windowMs: null, kind: "relative", normalized: formatMs(ms) };
    }

    const baseTs = opts.baseTs || now();
    const src = ("" + expr).trim();

    // Extract window suffix if present
    const windowMs = parseWindow(src);

    // +/- sign handling; allow leading "+" or "-"
    const signMatch = src.match(/^\s*([+-])\s*(.*)$/);
    const sign = signMatch ? (signMatch[1] === "-" ? -1 : 1) : +1;
    const coreRaw = signMatch ? signMatch[2] : src;

    // If it contains "?" we already parsed window — drop it for core parsing
    const { core } = stripWindowSuffix(coreRaw);

    // 1) Absolute forms
    const absTs = parseAbsoluteTarget(core, baseTs);
    if (Number.isFinite(absTs)) {
      const targetTs = absTs;
      const finalTs = opts.snapUnquiet ? snapToUnquiet(targetTs, opts.helpers) : targetTs;
      const ms = Math.max(0, finalTs - baseTs);
      return { ms, targetTs: finalTs, windowMs, kind: "absolute", normalized: ms === 0 ? "0ms" : formatMs(ms) };
    }

    // 2) Range (return ms on start; window gets ignored here, use parseRange directly when needed)
    const range = parseRange(core);
    if (range) {
      const ms = sign * range.startMs;
      const targetTs = baseTs + ms;
      const finalTs = opts.snapUnquiet ? snapToUnquiet(targetTs, opts.helpers) : targetTs;
      return { ms, targetTs: finalTs, windowMs, kind: "range-start", normalized: formatMs(ms) };
    }

    // 3) Relative duration (includes ISO 8601 and our shorthands)
    const relMs = parseRelativeChunk(core);
    if (Number.isFinite(relMs)) {
      const ms = sign * relMs;
      const targetTs = baseTs + ms;
      const finalTs = opts.snapUnquiet ? snapToUnquiet(targetTs, opts.helpers) : targetTs;
      return { ms, targetTs: finalTs, windowMs, kind: "relative", normalized: formatMs(ms) };
    }

    // If we get here, parsing failed
    return { ms: NaN, targetTs: NaN, windowMs: null, kind: "invalid", normalized: "" };
  }

  function toMs(expr, opts = {}) {
    if (typeof expr === "number") return expr;
    const out = parseOffset(expr, opts);
    return Number.isFinite(out.ms) ? out.ms : null;
  }

  // ------------------------------ Quiet-hours snap -----------------------------
  function snapToUnquiet(ts, helpers) {
    const H = helpers || scheduleHelpers || {};
    try {
      const sab = H.isSabbath && H.isSabbath(ts);
      const qh = H.inQuietHours && H.inQuietHours(ts);
      if (sab || qh) {
        const next = H.nextUnquiet && H.nextUnquiet(ts);
        if (Number.isFinite(next) && next > ts) return next;
      }
    } catch (_e) {}
    return ts;
  }

  // ------------------------------ Formatting ----------------------------------
  function formatMs(ms) {
    if (!Number.isFinite(ms)) return "";
    const neg = ms < 0;
    let n = Math.abs(ms);
    const d = Math.floor(n / 86400000); n -= d * 86400000;
    const h = Math.floor(n / 3600000);  n -= h * 3600000;
    const m = Math.floor(n / 60000);    n -= m * 60000;
    const s = Math.floor(n / 1000);

    const parts = [];
    if (d) parts.push(`${d}d`);
    if (h) parts.push(`${h}h`);
    if (m) parts.push(`${m}m`);
    if (s && parts.length === 0) parts.push(`${s}s`); // only show seconds if small
    if (parts.length === 0) parts.push("0ms");
    return (neg ? "-" : "") + parts.join(" ");
  }

  // ------------------------------ Export --------------------------------------
  const offsetParser = {
    parseOffset,
    parseWindow,
    parseRange,
    toMs,
    formatMs,
    snapToUnquiet,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { offsetParser };
  } else {
    // @ts-ignore
    window.offsetParser = offsetParser;
  }

  // ------------------------------ Tiny self-tests (dev only) ------------------
  // Uncomment to sanity check in dev:
  // if (isBrowser) {
  //   const base = Date.now();
  //   console.log("offset +20m", offsetParser.parseOffset("+20m", { baseTs: base }));
  //   console.log("offset T+5m", offsetParser.parseOffset("T+5m", { baseTs: base }));
  //   console.log("offset PT1H30M", offsetParser.parseOffset("PT1H30M", { baseTs: base }));
  //   console.log("window 20m?", offsetParser.parseWindow("20m?"));
  //   console.log("range 10..20m", offsetParser.parseRange("10..20m"));
  //   console.log("absolute 08:30", offsetParser.parseOffset("08:30", { baseTs: base }));
  //   console.log("absolute tomorrow 7am", offsetParser.parseOffset("tomorrow 7am", { baseTs: base }));
  // }
})();
