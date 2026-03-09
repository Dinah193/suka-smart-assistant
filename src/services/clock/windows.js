// C:\Users\larho\suka-smart-assistant\src\services\clock\windows.js
/* eslint-disable no-console */

/**
 * SSA Clock – Success Windows & T-x Readiness Ladders
 * -----------------------------------------------------------------------------
 * Role in pipeline:
 * - Imports → Intelligence → Automation → (optional) Hub export
 * - This module provides *pure* time-planning helpers used by engines and the
 *   scheduler to:
 *    1) Compute DST-safe “success windows” (when a block can run and still
 *       meet constraints like earliestStart, latestFinish, buffers, DND, and
 *       resource availability).
 *    2) Generate a T-x “readiness ladder” (what to do at T-5m, T-10m, etc.)
 *       before T0 (scheduled start) so the session succeeds.
 *
 * Notes:
 * - No household mutations and no Hub export here. We emit small diagnostics
 *   on the shared eventBus using the standard payload shape.
 */

import {
  isoNow,
  fromZonedToUTC,
  fromUTCToZoned,
  startOfZonedDayUTC,
  endOfZonedDayUTC,
  offsetMinutesForZoneAt,
} from "./time";

let eventBus = { emit: () => {}, on: () => () => {} };
try {
  const eb = require("@/services/events/eventBus");
  eventBus = eb?.default || eb?.eventBus || eventBus;
} catch {}

/* ----------------------------------------------------------------------------
 * Types (JSDoc)
 * -------------------------------------------------------------------------- */
/**
 * @typedef {Object} Interval
 * @property {string} start ISO-8601 UTC inclusive
 * @property {string} end   ISO-8601 UTC exclusive
 */

/**
 * @typedef {Object} SuccessWindowInput
 * @property {string} timeZone                IANA zone (e.g., "America/Chicago")
 * @property {string|null} scheduledStartUTC  Desired T0 (UTC). If null, compute widest feasible window.
 * @property {number} durationSec             Required contiguous duration in seconds
 * @property {number} [preBufferSec=0]        Guard-band before T0
 * @property {number} [postBufferSec=0]       Guard-band after T0
 * @property {string|null} earliestStartUTC   Hard lower bound, if any
 * @property {string|null} latestFinishUTC    Hard upper bound, if any (exclusive)
 * @property {Interval[]} [availability=[]]   Allowed intervals (union). If empty → always allowed.
 * @property {Interval[]} [dnd=[]]            Do-not-disturb intervals (to subtract)
 * @property {Interval[]} [busy=[]]           External busy intervals (calendars/resources)
 * @property {Object}     [metadata]          Free-form context for diagnostics
 */

/**
 * @typedef {Object} LadderRule
 * @property {string} id
 * @property {string} label
 * @property {number} offsetSec  Negative = before T0, Positive = after T0
 * @property {('soft'|'hard')} [criticality='soft']
 * @property {Object} [match]    // future extensibility for step/equipment matching
 */

/* ----------------------------------------------------------------------------
 * Public API
 * -------------------------------------------------------------------------- */

/**
 * computeSuccessWindow
 * - Intersects availability, removes DND & busy, applies buffers and hard bounds.
 * - If scheduledStartUTC is given: returns the *nearest feasible* [start,end) that
 *   contains [scheduledStart - preBuffer, scheduledStart + duration + postBuffer).
 * - If T0 is null: returns the *widest* feasible window within hard bounds.
 */
export function computeSuccessWindow(input) {
  const {
    timeZone,
    scheduledStartUTC = null,
    durationSec,
    preBufferSec = 0,
    postBufferSec = 0,
    earliestStartUTC = null,
    latestFinishUTC = null,
    availability = [],
    dnd = [],
    busy = [],
    metadata = {},
  } = sanitizeWindowArgs(input);

  // 1) Base window from hard bounds (default: local day bounds)
  const base = baseHardWindow(timeZone, earliestStartUTC, latestFinishUTC);

  // 2) Apply availability union (if provided) → intersect with base
  const availUnion = unionIntervals(
    availability.length ? normalizeIntervals(availability) : [base]
  );
  let feasible = intersectMany([base, ...availUnion]);

  // 3) Subtract DND & Busy
  feasible = subtractMany(feasible, normalizeIntervals(dnd));
  feasible = subtractMany(feasible, normalizeIntervals(busy));

  // 4) If T0 provided, carve out the needed block with buffers
  const needMs = (preBufferSec + durationSec + postBufferSec) * 1000;

  /** @type {Interval[]} */
  const resultCandidates = [];
  for (const f of feasible) {
    const fMs = spanMs(f);
    if (fMs < needMs) continue;

    if (!scheduledStartUTC) {
      // No T0: we’ll return the widest feasible segment (first, since feasible is merged/sorted)
      resultCandidates.push({
        start: f.start,
        end: f.end,
        reason: "widest-feasible",
      });
      break;
    }

    // With T0: try to place [T0 - pre, T0 + dur + post] inside f
    const t0 = new Date(scheduledStartUTC).getTime();
    const wantStart = t0 - preBufferSec * 1000;
    const wantEnd = t0 + (durationSec + postBufferSec) * 1000;

    const fStart = new Date(f.start).getTime();
    const fEnd = new Date(f.end).getTime();

    if (wantStart >= fStart && wantEnd <= fEnd) {
      // Fits as-is
      resultCandidates.push({
        start: new Date(wantStart).toISOString(),
        end: new Date(wantEnd).toISOString(),
        reason: "fits",
      });
      break;
    }

    // Slide inside feasible window (choose nearest placement keeping duration)
    const slideStart = clamp(
      wantStart,
      fStart,
      Math.max(fEnd - needMs, fStart)
    );
    const slideEnd = slideStart + needMs;
    if (slideEnd <= fEnd) {
      resultCandidates.push({
        start: new Date(slideStart).toISOString(),
        end: new Date(slideEnd).toISOString(),
        reason: "slid",
      });
      break;
    }
  }

  const selected = resultCandidates[0] || null;

  const payload = {
    action: "computeSuccessWindow",
    timeZone,
    scheduledStartUTC,
    durationSec,
    preBufferSec,
    postBufferSec,
    earliestStartUTC,
    latestFinishUTC,
    availability: availability.length,
    dnd: dnd.length,
    busy: busy.length,
    selected,
    feasibleCount: feasible.length,
    metadata,
  };
  emit("clock.success_window_computed", payload);

  return {
    ok: !!selected || !scheduledStartUTC,
    data: {
      feasible,
      selected, // may be null if T0 doesn’t fit anywhere
    },
  };
}

/**
 * buildReadinessLadder
 * - Produces DST-safe checkpoints around T0 (T-x style).
 * - Inputs:
 *    • t0UTC: scheduled start
 *    • rules: array of LadderRule (offsetSec < 0 → before T0)
 *    • extras: { enforceUniqueLabels?, clampToWindow?, window?: Interval }
 * - Output: sorted list with { id, label, atUTC, offsetSec, criticality }
 */
export function buildReadinessLadder({ t0UTC, rules = [], extras = {} }) {
  if (!t0UTC) return { ok: false, error: "t0UTC required" };

  const defaultRules = rules.length ? rules : DEFAULT_LADDER_RULES;
  const ladder = [];

  for (const r of defaultRules) {
    const at = new Date(
      new Date(t0UTC).getTime() + r.offsetSec * 1000
    ).toISOString();
    ladder.push({
      id: r.id,
      label: r.label,
      atUTC: at,
      offsetSec: r.offsetSec,
      criticality: r.criticality || "soft",
      source: "rule",
    });
  }

  // Optional: clamp checkpoints inside a success window
  if (extras?.clampToWindow && extras.window) {
    const w = toInterval(extras.window);
    for (const item of ladder) {
      if (isBefore(item.atUTC, w.start)) item.atUTC = w.start;
      if (!isBefore(item.atUTC, w.end)) item.atUTC = shiftMs(w.end, -1); // keep < end
    }
  }

  // Unique labels if requested
  const final = extras?.enforceUniqueLabels ? uniquifyLabels(ladder) : ladder;

  final.sort(
    (a, b) => new Date(a.atUTC).getTime() - new Date(b.atUTC).getTime()
  );
  emit("clock.readiness_ladder_built", {
    action: "buildReadinessLadder",
    t0UTC,
    count: final.length,
  });

  return { ok: true, data: final };
}

/**
 * nextChecklistItem
 * - Given a ladder and "nowUTC", picks the next due item and T-minus label.
 */
export function nextChecklistItem(ladder, nowUTC = isoNow()) {
  if (!Array.isArray(ladder))
    return { ok: false, error: "ladder must be an array" };
  const now = new Date(nowUTC).getTime();
  const upcoming =
    ladder.find((i) => new Date(i.atUTC).getTime() > now) || null;
  if (!upcoming) return { ok: true, data: null };

  const deltaSec = Math.round(
    (new Date(upcoming.atUTC).getTime() - now) / 1000
  );
  return {
    ok: true,
    data: {
      item: upcoming,
      tMinus: fmtTMinus(deltaSec),
      deltaSec,
    },
  };
}

/**
 * deriveAvailabilityForDay
 * - Utility to convert local availability windows (e.g., “9:00–18:00” local)
 *   into UTC intervals for a given reference day in timeZone.
 */
export function deriveAvailabilityForDay({
  timeZone,
  referenceUTC = isoNow(),
  windows = [],
}) {
  const startDayUTC = startOfZonedDayUTC(referenceUTC, timeZone);
  const endDayUTC = endOfZonedDayUTC(referenceUTC, timeZone);

  const intervals = [];
  for (const w of windows) {
    // each w: { start: "HH:mm", end: "HH:mm" } local
    const [sH, sM] = (w.start || "00:00").split(":").map(Number);
    const [eH, eM] = (w.end || "24:00").split(":").map(Number);

    const sLocal = wallLocalFromDay(startDayUTC, timeZone, sH, sM);
    const eLocal = wallLocalFromDay(
      startDayUTC,
      timeZone,
      eH,
      eM >= 60 ? 59 : eM
    );

    const sUTC = fromZonedToUTC(sLocal, timeZone).utcISO;
    const eUTC = fromZonedToUTC(eLocal, timeZone).utcISO;

    const clamped = intersect(
      toInterval({ start: sUTC, end: eUTC }),
      toInterval({ start: startDayUTC, end: endDayUTC })
    );
    if (clamped) intervals.push(clamped);
  }

  const merged = unionIntervals(intervals);
  emit("clock.availability_derived", {
    action: "deriveAvailabilityForDay",
    count: merged.length,
    timeZone,
  });
  return merged;
}

/* ----------------------------------------------------------------------------
 * Defaults & presets
 * -------------------------------------------------------------------------- */

const DEFAULT_LADDER_RULES = [
  {
    id: "check-inventory",
    label: "Check required items on hand",
    offsetSec: -45 * 60,
    criticality: "soft",
  },
  {
    id: "prep-surface",
    label: "Clear & stage workspace",
    offsetSec: -20 * 60,
    criticality: "soft",
  },
  {
    id: "preheat-or-water",
    label: "Preheat / Start water to boil",
    offsetSec: -12 * 60,
    criticality: "hard",
  },
  {
    id: "gather-tools",
    label: "Gather tools & equipment",
    offsetSec: -8 * 60,
    criticality: "soft",
  },
  {
    id: "final-brief",
    label: "Re-read first 2 steps",
    offsetSec: -3 * 60,
    criticality: "soft",
  },
  { id: "t0", label: "Start session (T0)", offsetSec: 0, criticality: "hard" },
];

/* ----------------------------------------------------------------------------
 * Internal helpers — intervals
 * -------------------------------------------------------------------------- */

function sanitizeWindowArgs(input = {}) {
  const obj = { ...input };
  if (!obj.timeZone) obj.timeZone = "UTC";
  if (!Number.isFinite(obj.durationSec)) obj.durationSec = 0;
  obj.preBufferSec = Number(obj.preBufferSec || 0);
  obj.postBufferSec = Number(obj.postBufferSec || 0);
  obj.availability = Array.isArray(obj.availability) ? obj.availability : [];
  obj.dnd = Array.isArray(obj.dnd) ? obj.dnd : [];
  obj.busy = Array.isArray(obj.busy) ? obj.busy : [];
  return obj;
}

function baseHardWindow(timeZone, earliestStartUTC, latestFinishUTC) {
  const now = isoNow();
  const start = earliestStartUTC || startOfZonedDayUTC(now, timeZone);
  const end = latestFinishUTC || endOfZonedDayUTC(now, timeZone);
  return toInterval({ start, end });
}

function toInterval(i) {
  if (!i) return null;
  const start = new Date(i.start).toISOString();
  const end = new Date(i.end).toISOString();
  if (!(new Date(end).getTime() > new Date(start).getTime())) return null;
  return { start, end };
}

function normalizeIntervals(list) {
  const out = [];
  for (const i of list) {
    const n = toInterval(i);
    if (n) out.push(n);
  }
  return unionIntervals(out);
}

function spanMs(i) {
  return new Date(i.end).getTime() - new Date(i.start).getTime();
}

function unionIntervals(intervals) {
  if (!intervals.length) return [];
  const sorted = [...intervals].sort(
    (a, b) => new Date(a.start) - new Date(b.start)
  );
  const merged = [];
  let cur = { ...sorted[0] };
  for (let k = 1; k < sorted.length; k++) {
    const nx = sorted[k];
    if (new Date(nx.start) <= new Date(cur.end)) {
      if (new Date(nx.end) > new Date(cur.end)) cur.end = nx.end;
    } else {
      merged.push(cur);
      cur = { ...nx };
    }
  }
  merged.push(cur);
  return merged;
}

function intersect(a, b) {
  const s = new Date(
    Math.max(new Date(a.start), new Date(b.start))
  ).toISOString();
  const eMs = Math.min(new Date(a.end).getTime(), new Date(b.end).getTime());
  if (eMs <= new Date(s).getTime()) return null;
  return { start: s, end: new Date(eMs).toISOString() };
}

function intersectMany(list) {
  if (!list.length) return [];
  let acc = [list[0]];
  for (let i = 1; i < list.length; i++) {
    const next = [];
    for (const a of acc) {
      const x = intersect(a, list[i]);
      if (x) next.push(x);
    }
    acc = next;
    if (!acc.length) break;
  }
  return acc;
}

function subtract(A, B) {
  // Return A - B (can split A)
  const res = [];
  const aS = new Date(A.start).getTime();
  const aE = new Date(A.end).getTime();
  const bS = new Date(B.start).getTime();
  const bE = new Date(B.end).getTime();

  // No overlap
  if (bE <= aS || bS >= aE) return [A];

  // Left piece
  if (bS > aS)
    res.push({
      start: new Date(aS).toISOString(),
      end: new Date(bS).toISOString(),
    });
  // Right piece
  if (bE < aE)
    res.push({
      start: new Date(bE).toISOString(),
      end: new Date(aE).toISOString(),
    });
  return res;
}

function subtractMany(baseList, subtractList) {
  if (!subtractList.length) return baseList;
  let acc = [...baseList];
  for (const b of subtractList) {
    const next = [];
    for (const a of acc) next.push(...subtract(a, b));
    acc = next;
    if (!acc.length) break;
  }
  return unionIntervals(acc);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function isBefore(aISO, bISO) {
  return new Date(aISO).getTime() < new Date(bISO).getTime();
}

function shiftMs(iso, deltaMs) {
  return new Date(new Date(iso).getTime() + deltaMs).toISOString();
}

/* ----------------------------------------------------------------------------
 * Internal helpers — formatting & labels
 * -------------------------------------------------------------------------- */

function fmtTMinus(deltaSec) {
  const sign = deltaSec >= 0 ? "-" : "+";
  const s = Math.abs(deltaSec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `T${sign}${h}h${String(m).padStart(2, "0")}`;
  if (m > 0) return `T${sign}${m}m`;
  return `T${sign}${sec}s`;
}

function uniquifyLabels(items) {
  const seen = new Map();
  for (const it of items) {
    const base = it.label;
    if (!seen.has(base)) {
      seen.set(base, 1);
      continue;
    }
    const n = seen.get(base) + 1;
    seen.set(base, n);
    it.label = `${base} (#${n})`;
  }
  return items;
}

function wallLocalFromDay(dayStartUTC, timeZone, hour, minute) {
  // Returns a wall-time object for local day with given HH:mm
  const localDay = fromUTCToZoned(dayStartUTC, timeZone).parts;
  return {
    year: localDay.year,
    month: localDay.month,
    day: localDay.day,
    hour,
    minute,
    second: 0,
    millisecond: 0,
  };
}

/* ----------------------------------------------------------------------------
 * Diagnostics
 * -------------------------------------------------------------------------- */

function emit(type, data) {
  try {
    eventBus.emit({
      type,
      ts: isoNow(),
      source: "services/clock/windows",
      data,
    });
  } catch {}
}

/* ----------------------------------------------------------------------------
 * Example extension points (kept here for future domains)
 * -------------------------------------------------------------------------- */
/**
 * deriveDomainLadder(steps, domain) -> LadderRule[]
 * - In the future, we can inspect steps & parameters (e.g., equipment) and
 *   auto-generate smarter T-x ladders: preheat if oven present, “bring jars
 *   to simmer” if preservation, “sanitize tools” if butchery, etc.
 * - For now, callers can pass explicit rules; this slot is intentionally left.
 */

export default {
  computeSuccessWindow,
  buildReadinessLadder,
  nextChecklistItem,
  deriveAvailabilityForDay,
};
