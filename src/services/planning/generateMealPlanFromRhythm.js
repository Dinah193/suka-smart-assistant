// src/services/planning/generateMealPlanFromRhythm.js
//
// Rhythm-aware Meal Plan Generator
// - Supports flexible meal “rhythms”: 3x/day, 2x/day, OMAD, snacks,
//   16:8, 18:6, 20:4, 36h extended, 5:2, alternate-day fasting, and custom.
// - Honors weekday/weekend splits and calendar tags (e.g., SABBATH, FEAST).
// - Optional “profiles” (e.g., keto weekdays, relaxed weekends) that can set
//   macro targets, diet tags, and special slot templates.
// - Snap/convert/drop slots that fall outside intermittent fasting windows.
// - Emits optional calendar “Feeding Window” / “Fast” events via CalendarSyncModule.
// - (Pluggable) Recipe assignment respects allergens/diet tags when available.
//
// Notes:
// - Designed to be defensive: works even if RecipeStore / MealPlanStore / CalendarSyncModule
//   are absent. Integrates when present without crashing.
// - Browser-safe: does NOT depend on luxon.
//

import { useMealRhythmStore } from "@/store/MealRhythmStore";

// Optional existing modules if present
let MealPlanStore, RecipeStore, CalendarSyncModule, EventBus;
try {
  MealPlanStore = require("@/store/MealPlanStore");
} catch {}
try {
  RecipeStore = require("@/store/RecipeStore");
} catch {}
try {
  CalendarSyncModule =
    require("@/services/calendar/CalendarSyncModule").default;
} catch {}
try {
  EventBus = require("@/services/events/eventBus").eventBus;
} catch {}

/* --------------------------------- Time Helpers --------------------------------- */
/**
 * We treat `startISO`/`endISO` as ISO dates: "YYYY-MM-DD"
 * We iterate days using UTC-midnight to avoid DST issues.
 * We keep `tz` in output metadata, but calculations are performed in "day-local minutes".
 */
const DAY_MS = 24 * 60 * 60 * 1000;

function isoDateFromDateUTC(d) {
  return new Date(d.getTime()).toISOString().slice(0, 10);
}
function parseISODateToUTC(iso) {
  // iso: YYYY-MM-DD
  const [y, m, d] = String(iso || "")
    .split("-")
    .map(Number);
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
}
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}
function toMinutes(hhmm) {
  const [h = 0, m = 0] = String(hhmm || "00:00")
    .split(":")
    .map(Number);
  return clamp((Number(h) || 0) * 60 + (Number(m) || 0), 0, 24 * 60);
}
function fromMinutes(min) {
  const mm = clamp(Number(min) || 0, 0, 24 * 60);
  const h = Math.floor(mm / 60);
  const m = mm % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
function weekdayIndex0to6(dateUTC) {
  // 0 Sunday .. 6 Saturday (UTC-based day)
  return dateUTC.getUTCDay();
}
function isWeekendByUTC(dateUTC) {
  const d = weekdayIndex0to6(dateUTC);
  return d === 0 || d === 6;
}
function isoNow() {
  return new Date().toISOString();
}
function addDaysUTC(dateUTC, days) {
  return new Date(dateUTC.getTime() + (Number(days) || 0) * DAY_MS);
}

/* --------------------------------- Cadence Helpers (no luxon) --------------------------------- */

/** is every Nth day from a start date (e.g., ADF step=2 returns true on start, start+2, ...) */
function isNthDay(isoDate, cfg) {
  if (!cfg?.start) return false;
  const start = parseISODateToUTC(cfg.start);
  const cur = parseISODateToUTC(isoDate);
  if (!start || !cur) return false;
  const diffDays = Math.floor((cur.getTime() - start.getTime()) / DAY_MS);
  const step = Number(cfg.step) || 2;
  return diffDays >= 0 && diffDays % step === 0;
}

/** fiveTwo fast day checker: pick two index days (0..6) relative to rolling week from 'start' */
function isFiveTwoFast(isoDate, cfg) {
  if (!cfg?.start) return false;
  const start = parseISODateToUTC(cfg.start);
  const cur = parseISODateToUTC(isoDate);
  if (!start || !cur) return false;
  const diffDays = Math.floor((cur.getTime() - start.getTime()) / DAY_MS);
  const idxInWeek = ((diffDays % 7) + 7) % 7; // 0..6
  return (cfg.fastDays || []).includes(idxInWeek);
}

/**
 * Compose feeding windows (minutes) for a specific date given a daily IF window.
 * Supports windows crossing midnight (e.g., 20:00–04:00).
 * Returns Array of { startMin, endMin } windows that apply to *that date*.
 */
function composeDailyFeedingWindowsForDay(dateISO, daily) {
  if (!daily?.start || !daily?.end) return [];
  const startMin = toMinutes(daily.start);
  const endMin = toMinutes(daily.end);

  // If end >= start: window is within same day.
  if (endMin >= startMin) return [{ startMin, endMin }];

  // If end < start: window crosses midnight.
  // For THIS day, we only keep the late-night portion start..1440.
  return [{ startMin, endMin: 24 * 60 }];
}

/**
 * Check if a specific HH:MM time falls inside any windows (minutes).
 */
function isTimeWithinWindows(timeHHMM, windows) {
  const t = toMinutes(timeHHMM);
  return (windows || []).some((w) => t >= w.startMin && t < w.endMin);
}

/**
 * Given a time hint, snap it INTO the nearest feeding window on that date.
 * Strategy:
 *  - If already inside a window → return same time
 *  - Else snap to the window start closest after the time; if none, to earliest window start
 *
 * preferWindowAnchor:
 *  - 'start' | 'mid' | 'end'
 */
function snapTimeIntoWindows(timeHHMM, windows, preferWindowAnchor = "start") {
  const t = toMinutes(timeHHMM || "12:00");
  const sorted = [...(windows || [])].sort((a, b) => a.startMin - b.startMin);
  if (!sorted.length) return timeHHMM;

  const anchorOf = (w) => {
    if (preferWindowAnchor === "end") return w.endMin;
    if (preferWindowAnchor === "mid")
      return Math.floor((w.startMin + w.endMin) / 2);
    return w.startMin;
  };

  // If within any window: keep as-is
  if (sorted.some((w) => t >= w.startMin && t < w.endMin))
    return fromMinutes(t);

  // Find next window (by anchor) after t
  const after = sorted
    .map((w) => ({ w, a: anchorOf(w) }))
    .filter((x) => x.a >= t)
    .sort((a, b) => a.a - b.a)[0];

  if (after) return fromMinutes(after.a);

  // Otherwise snap to earliest anchor
  return fromMinutes(anchorOf(sorted[0]));
}

/**
 * Build repeated multi-day fasting blocks across a range.
 * cfg = { startISODateTime, durationHours, repeat: 'none'|'weekly'|'biweekly'|'monthly' }
 * Returns array of blocks: { startMs, endMs }
 *
 * NOTE: This is best-effort without timezone libs. If `startISODateTime` includes an offset,
 * JS Date will respect it. If it doesn't, it will be interpreted as local time.
 */
function buildFastingBlocksInRange(rangeStartISO, rangeEndISO, cfg) {
  if (!cfg?.startISODateTime || !cfg?.durationHours) return [];

  const startRangeUTC = parseISODateToUTC(rangeStartISO);
  const endRangeUTC = parseISODateToUTC(rangeEndISO);
  if (!startRangeUTC || !endRangeUTC) return [];
  if (endRangeUTC.getTime() < startRangeUTC.getTime()) return [];

  const startRangeMs = startRangeUTC.getTime();
  const endRangeMs = endRangeUTC.getTime() + DAY_MS; // inclusive end day

  const blocks = [];
  let cursor = new Date(cfg.startISODateTime);
  if (Number.isNaN(cursor.getTime())) return [];

  const durMs = (Number(cfg.durationHours) || 0) * 60 * 60 * 1000;
  if (!durMs) return [];

  const rep = (cfg.repeat || "none").toLowerCase();

  const pushIfOverlaps = (sMs, eMs) => {
    const overlap = Math.max(sMs, startRangeMs) < Math.min(eMs, endRangeMs);
    if (overlap) blocks.push({ startMs: sMs, endMs: eMs });
  };

  // generate repeats until beyond range
  // (guard: at most ~200 iterations)
  for (let k = 0; k < 200; k++) {
    const sMs = cursor.getTime();
    const eMs = sMs + durMs;
    pushIfOverlaps(sMs, eMs);

    if (rep === "none") break;

    if (rep === "weekly") cursor = new Date(sMs + 7 * DAY_MS);
    else if (rep === "biweekly") cursor = new Date(sMs + 14 * DAY_MS);
    else if (rep === "monthly") {
      const d = new Date(cursor);
      d.setMonth(d.getMonth() + 1);
      cursor = d;
    } else {
      break;
    }

    if (cursor.getTime() > endRangeMs + 40 * DAY_MS) break;
  }

  return blocks;
}

function doesAnyBlockOverlap(dayStartMs, dayEndMs, blocks) {
  return (blocks || []).some(
    (b) => Math.max(dayStartMs, b.startMs) < Math.min(dayEndMs, b.endMs)
  );
}

/* --------------------------------- Core Helpers --------------------------------- */

function dayKeyFromUTCDate(dateUTC) {
  return isoDateFromDateUTC(dateUTC);
}

function matchesRule(dateUTC, rule, calendarTagsForDay = []) {
  // In legacy code this was luxon weekday%7. Here we use UTC day.
  const d0 = weekdayIndex0to6(dateUTC); // 0..6
  const isWeekend = d0 === 0 || d0 === 6;
  const isWeekday = !isWeekend;
  const iso = dayKeyFromUTCDate(dateUTC);

  if (rule.match?.weekend && !isWeekend) return false;
  if (rule.match?.weekday && !isWeekday) return false;
  if (rule.match?.daysOfWeek && !rule.match.daysOfWeek.includes(d0))
    return false;

  if (rule.match?.dateRange) {
    const { start, end } = rule.match.dateRange;
    if (iso < start || iso > end) return false;
  }

  if (rule.match?.everyNthDayFrom) {
    if (!isNthDay(iso, rule.match.everyNthDayFrom)) return false;
  }

  if (rule.match?.fiveTwo) {
    // evaluated later to transform slots → keep as possible match
  }

  if (rule.match?.calendarTags?.length) {
    const hasAny = rule.match.calendarTags.some((tag) =>
      calendarTagsForDay.includes(tag)
    );
    if (!hasAny) return false;
  }

  // exceptions override
  if (rule.except) {
    if (rule.except.weekend && isWeekend) return false;
    if (rule.except.weekday && isWeekday) return false;
    if (rule.except.daysOfWeek?.includes(d0)) return false;
    if (rule.except.dates?.includes(iso)) return false;
    if (rule.except.calendarTags?.some((t) => calendarTagsForDay.includes(t)))
      return false;
  }

  return true;
}

/* ------------------------------- IF Derivation ------------------------------- */
/**
 * Derive feeding windows from a concise pattern when rule.ifWindowDaily is not provided.
 * Examples:
 *  - "16:8"  → 8-hour window anchored at 12:00 by default
 *  - "18:6"  → 6-hour window anchored at 12:00
 *  - "20:4"  → 4-hour window anchored at 14:00 if no anchor is provided (heuristic)
 *  - "OMAD"  → one window of 1 hour at 17:00–18:00 (if anchor provided) else 17:00
 *  - "36h"   → extended fast handled via multiDayFast (no daily windows)
 */
function deriveWindowsFromIfPattern(_iso, _tz, ifPattern) {
  if (!ifPattern) return [];
  const base =
    typeof ifPattern === "string" ? { pattern: ifPattern } : { ...ifPattern };
  const pattern = String(base.pattern || "")
    .toUpperCase()
    .trim();

  // extended fast patterns -> no daily windows (handled via multi-day blocks)
  if (/\b(24H|36H|48H|72H)\b/.test(pattern)) return [];

  let anchor = base.anchor || null;

  // small heuristic defaults
  if (!anchor) {
    if (pattern === "OMAD") anchor = "17:00";
    else if (pattern === "20:4") anchor = "14:00";
    else anchor = "12:00";
  }

  const startMin = toMinutes(anchor);

  let lengthHours = 0;
  if (pattern === "OMAD") lengthHours = 1;
  else if (/^\d{1,2}:\d{1,2}$/.test(pattern)) {
    const parts = pattern.split(":").map(Number);
    lengthHours = Number(parts[1]) || 0; // eating window is second number
  } else if (/^\d{1,2}H:\d{1,2}H$/.test(pattern)) {
    const parts = pattern.toLowerCase().split("h:").map(Number);
    lengthHours = Number(parts[1]) || 0;
  }

  if (lengthHours <= 0) return [];
  const endMin = clamp(startMin + lengthHours * 60, 0, 24 * 60);

  return [{ startMin, endMin }];
}

/* ------------------------------ Profile Helpers ------------------------------ */

function chooseProfileForDate(dateUTC, tags, profiles = []) {
  const prioritized = [...profiles].sort(
    (a, b) => (b?.priority ?? 0) - (a?.priority ?? 0)
  );
  for (const p of prioritized) {
    if (!p?.match) continue;
    const fakeRule = { match: p.match, except: p.except };
    if (matchesRule(dateUTC, fakeRule, tags)) return p;
  }
  return null;
}

/* ------------------------------ Main Generator ------------------------------- */
/**
 * Options:
 * - respectIF: true | false
 * - slotOutsideIF: 'convert' | 'drop' | 'shift'  (default 'shift')
 *   convert → change to FAST placeholder
 *   drop    → remove the slot
 *   shift   → snap time into nearest feeding window for that date
 * - preferWindowAnchor: 'start' | 'mid' | 'end' (when snapping; default 'start')
 * - injectSabbathAsRest: convert meal slots to simplified set when tag includes 'SABBATH'
 */
export default async function generateMealPlanFromRhythm({
  startISO,
  endISO,
  tz = "America/Chicago",
  calendarTagLookup = async (_iso) => [],
  respectIF = true,
  slotOutsideIF = "shift",
  preferWindowAnchor = "start",
  injectSabbathAsRest = true,
} = {}) {
  const rhythmState = useMealRhythmStore.getState?.() ?? {};
  const rules = (rhythmState.rules ?? [])
    .filter((r) => r.enabled)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  const profiles = rhythmState.profiles ?? []; // optional

  const startD = parseISODateToUTC(startISO);
  const endD = parseISODateToUTC(endISO);
  if (!startD || !endD || endD.getTime() < startD.getTime()) {
    throw new Error("Invalid date range.");
  }

  // Precompute multi-day fasting blocks (across all rules)
  const multiDayBlocks = [];
  if (respectIF) {
    for (const r of rules) {
      if (r.multiDayFast) {
        const blocks = buildFastingBlocksInRange(
          startISO,
          endISO,
          r.multiDayFast
        );
        multiDayBlocks.push(...blocks);
      }
    }
  }

  const days = {};
  for (
    let d = new Date(startD);
    d.getTime() <= endD.getTime();
    d = addDaysUTC(d, 1)
  ) {
    const iso = dayKeyFromUTCDate(d);
    const tags = await calendarTagLookup(iso);

    const dayObj = {
      date: iso,
      tz,
      tags,
      slots: [],
      dayMacroTarget: null,
      feedingWindows: [], // [{ startMin, endMin }]
      isWithinMultiDayFast: false,
      profile: null,
      dietTags: [],
      notes: [],
    };

    // Apply profile (weekday/weekend, tag-based, etc.)
    dayObj.profile = chooseProfileForDate(d, tags, profiles);
    if (dayObj.profile?.dayMacroTarget) {
      dayObj.dayMacroTarget = { ...dayObj.profile.dayMacroTarget };
    }
    if (Array.isArray(dayObj.profile?.dietTags)) {
      dayObj.dietTags = [...dayObj.profile.dietTags];
    }

    // If Sabbath/Feast tags present & desired, simplify slot pattern unless overridden
    const isSabbath = tags.includes("SABBATH") || tags.includes("SHABBAT");
    const isFeast =
      tags.includes("FEAST") ||
      tags.includes("MOED") ||
      tags.includes("HIGH_HOLY_DAY");
    const restDay = injectSabbathAsRest && (isSabbath || isFeast);

    // Determine if this calendar day intersects a multi-day fasting block
    if (respectIF && multiDayBlocks.length) {
      const dayStartMs = d.getTime();
      const dayEndMs = dayStartMs + DAY_MS;
      dayObj.isWithinMultiDayFast = doesAnyBlockOverlap(
        dayStartMs,
        dayEndMs,
        multiDayBlocks
      );
    }

    // Collect rules that match the day
    const matchedRules = rules.filter((r) => matchesRule(d, r, tags));

    // Compose slots from matched rules or profile.slotTemplate (profile wins if provided)
    if (dayObj.profile?.slotTemplate?.length) {
      dayObj.slots.push(...cloneSlots(dayObj.profile.slotTemplate));
    } else {
      for (const rule of matchedRules) {
        for (const s of rule.slots || []) {
          if (!dayObj.slots.some((x) => x.slotId === s.slotId)) {
            dayObj.slots.push({ ...s });
          }
        }
      }
    }

    // If rest day (Sabbath/Feast) and no explicit override, simplify to 2 meals + optional dessert
    if (restDay && !dayObj.profile?.overrides?.keepFullSlotsOnRestDay) {
      dayObj.notes.push(
        isFeast
          ? "Feast day: simplified celebratory meals."
          : "Sabbath: simplified restful meals."
      );
      dayObj.slots = simplifyToRestDaySlots(dayObj.slots);
    }

    // 5:2 handling per rule (convert applicable day to low-cal/fast)
    let fiveTwoTrigger = false;
    for (const rule of matchedRules) {
      if (rule.match?.fiveTwo && isFiveTwoFast(iso, rule.match.fiveTwo)) {
        fiveTwoTrigger = true;
      }
    }
    if (fiveTwoTrigger) {
      dayObj.slots = dayObj.slots.map((s) => ({
        ...s,
        kind: "fast",
        timeHint: undefined,
      }));
      dayObj.notes.push("5:2 low-intake/fast day.");
    }

    // Day macro target: profile has priority; otherwise first matching rule with target
    if (!dayObj.dayMacroTarget) {
      const rWithMacro = matchedRules.find((r) => r.dayMacroTarget);
      if (rWithMacro) dayObj.dayMacroTarget = { ...rWithMacro.dayMacroTarget };
    }

    // IF windows:
    if (respectIF) {
      for (const rule of matchedRules) {
        let windows = [];
        if (rule.ifWindowDaily) {
          windows = composeDailyFeedingWindowsForDay(iso, rule.ifWindowDaily);
        } else if (rule.ifPattern) {
          windows = deriveWindowsFromIfPattern(iso, tz, rule.ifPattern);
        }
        if (windows?.length) dayObj.feedingWindows.push(...windows);
      }

      // merge windows
      if (dayObj.feedingWindows.length > 1) {
        dayObj.feedingWindows.sort((a, b) => a.startMin - b.startMin);
        const merged = [];
        for (const w of dayObj.feedingWindows) {
          const last = merged[merged.length - 1];
          if (last && w.startMin <= last.endMin) {
            last.endMin = Math.max(last.endMin, w.endMin);
          } else {
            merged.push({ ...w });
          }
        }
        dayObj.feedingWindows = merged;
      }
    }

    // Apply IF rules to slots
    if (respectIF) {
      if (dayObj.isWithinMultiDayFast) {
        dayObj.slots = dayObj.slots.map((s) => ({
          ...s,
          kind: "fast",
          timeHint: undefined,
        }));
        dayObj.notes.push("Within extended fast block.");
      } else if (dayObj.feedingWindows.length) {
        const windows = dayObj.feedingWindows;

        dayObj.slots = dayObj.slots.flatMap((s) => {
          if (s.kind === "fast") return [s];

          const t =
            s.timeHint || defaultAnchorTimeFor(preferWindowAnchor, windows);
          const inside = isTimeWithinWindows(t, windows);
          if (inside) return [s];

          if (slotOutsideIF === "drop") return [];
          if (slotOutsideIF === "convert")
            return [{ ...s, kind: "fast", timeHint: undefined }];

          // default: shift (snap) into a window
          const snapped = snapTimeIntoWindows(t, windows, preferWindowAnchor);
          return [{ ...s, timeHint: snapped }];
        });
      }
    }

    // Final sort by time if present
    dayObj.slots.sort((a, b) =>
      String(a.timeHint || "99:99").localeCompare(String(b.timeHint || "99:99"))
    );

    days[iso] = dayObj;
  }

  /* -------------------- Optional Recipe Assignment (Pluggable) -------------------- */
  if (MealPlanStore && RecipeStore) {
    for (const iso of Object.keys(days)) {
      const dayObj = days[iso];
      for (const slot of dayObj.slots) {
        if (slot.kind === "meal" || slot.kind === "snack") {
          try {
            const recipe = await pickRecipeForSlot({
              slot,
              dayObj,
              RecipeStore,
            });
            if (recipe && MealPlanStore.assign) {
              await MealPlanStore.assign(
                iso,
                slot.slotId ??
                  slot.label ??
                  `${slot.kind}-${slot.timeHint ?? ""}`,
                recipe
              );
            }
          } catch {
            // Non-fatal; leave slot unassigned
          }
        }
      }
    }
  }

  /* ------------------- Optional: Push Windows/Slots to Calendar ------------------- */
  if (CalendarSyncModule?.createMealEventsBatch) {
    const events = [];
    for (const iso of Object.keys(days)) {
      const day = days[iso];

      if (day.isWithinMultiDayFast) {
        events.push({
          title: "FAST (extended)",
          start: `${iso}T08:00:00`,
          end: `${iso}T20:00:00`,
          source: "MealRhythm",
          color: "#a78bfa",
        });
      } else if (day.feedingWindows.length) {
        day.feedingWindows.forEach((w) => {
          events.push({
            title: "Feeding Window",
            start: `${iso}T${fromMinutes(w.startMin)}:00`,
            end: `${iso}T${fromMinutes(w.endMin)}:00`,
            source: "MealRhythm",
            color: "#60a5fa",
          });
        });
      }

      day.slots.forEach((slot) => {
        if (slot.kind === "fast") {
          events.push({
            title: "Fast",
            start: `${iso}T08:00:00`,
            end: `${iso}T20:00:00`,
            source: "MealRhythm",
            color: "#c4b5fd",
          });
        } else {
          const t = slot.timeHint || "12:00";
          events.push({
            title: slot.label ?? (slot.kind === "snack" ? "Snack" : "Meal"),
            start: `${iso}T${t}:00`,
            end: `${iso}T${t}:00`,
            source: "MealRhythm",
            color: slot.kind === "snack" ? "#60a5fa" : "#34d399",
          });
        }
      });
    }
    try {
      await CalendarSyncModule.createMealEventsBatch({ events });
    } catch {}
  }

  // Emit an event for other modules (dashboards, GroceryListGenerator, etc.)
  try {
    EventBus?.emit?.("mealplan:generated", {
      range: { startISO, endISO },
      tz,
      days,
    });
  } catch {}

  return { days };
}

/* --------------------------------- Utilities --------------------------------- */

function cloneSlots(template = []) {
  return template.map((s) => ({ ...s }));
}

function simplifyToRestDaySlots(slots = []) {
  const meals = slots.filter((s) => s.kind === "meal");
  const snacks = slots.filter((s) => s.kind === "snack");

  const out = [];
  if (meals.length >= 2) {
    out.push(
      {
        ...meals[0],
        label: meals[0].label ?? "Meal 1",
        timeHint: meals[0].timeHint ?? "12:30",
      },
      {
        ...meals[1],
        label: meals[1].label ?? "Meal 2",
        timeHint: meals[1].timeHint ?? "17:30",
      }
    );
  } else if (meals.length === 1) {
    out.push({
      ...meals[0],
      label: meals[0].label ?? "Meal",
      timeHint: meals[0].timeHint ?? "15:00",
    });
  } else {
    out.push(
      { kind: "meal", label: "Meal 1", slotId: "meal-1", timeHint: "12:30" },
      { kind: "meal", label: "Meal 2", slotId: "meal-2", timeHint: "17:30" }
    );
  }

  const dessert = snacks[0] ?? {
    kind: "snack",
    label: "Dessert",
    slotId: "snack-1",
    timeHint: "19:00",
  };
  out.push(dessert);
  return out;
}

function defaultAnchorTimeFor(anchor = "start", windows = []) {
  if (!windows?.length) return "12:00";
  const w = windows[0];
  if (anchor === "end") return fromMinutes(w.endMin);
  if (anchor === "mid")
    return fromMinutes(Math.floor((w.startMin + w.endMin) / 2));
  return fromMinutes(w.startMin);
}

/**
 * Best-effort recipe picker that respects diet/allergen tags.
 * Expected RecipeStore interface (loosely):
 *   - RecipeStore.findCandidates({ kind, dietTags, avoidAllergens, macrosTarget }) → Recipe[]
 *   - RecipeStore.pickOne(candidates, criteria) → Recipe
 */
async function pickRecipeForSlot({ slot, dayObj, RecipeStore }) {
  const avoidAllergens = (dayObj.profile?.avoidAllergens ?? []).concat(
    dayObj.profile?.allergensToAvoid ?? []
  );

  const criteria = {
    kind: slot.kind, // 'meal' | 'snack'
    dietTags: dayObj.dietTags, // e.g., ['keto','dairy-free']
    avoidAllergens,
    macrosTarget: dayObj.dayMacroTarget || null, // { kcal, protein, carbs, fat }
    timeHint: slot.timeHint,
  };

  let candidates = [];
  if (RecipeStore.findCandidates) {
    candidates = await RecipeStore.findCandidates(criteria);
  } else if (RecipeStore.pickFor) {
    return await RecipeStore.pickFor(slot, dayObj.dayMacroTarget);
  }

  if (!candidates?.length && RecipeStore.fallbackCandidates) {
    candidates = await RecipeStore.fallbackCandidates(criteria);
  }
  if (!candidates?.length) return null;

  if (RecipeStore.pickOne)
    return await RecipeStore.pickOne(candidates, criteria);
  return candidates[0];
}
