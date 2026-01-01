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
//

import { DateTime, Interval } from "luxon";
import { useMealRhythmStore } from "@/store/MealRhythmStore";
import * as cadence from "@/utils/rhythmCadence";

// Optional existing modules if present
let MealPlanStore, RecipeStore, CalendarSyncModule, EventBus;
try { MealPlanStore = require("@/store/MealPlanStore"); } catch {}
try { RecipeStore = require("@/store/RecipeStore"); } catch {}
try { CalendarSyncModule = require("@/services/calendar/CalendarSyncModule").default; } catch {}
try { EventBus = require("@/services/events/eventBus").eventBus; } catch {}

function dayKey(dt) { return dt.toISODate(); }

function matchesRule(dt, rule, calendarTagsForDay = []) {
  const d = dt.weekday % 7; // 1..7 → 0..6
  const isWeekend = (d === 0 || d === 6);
  const isWeekday = !isWeekend;
  const iso = dt.toISODate();

  if (rule.match?.weekend && !isWeekend) return false;
  if (rule.match?.weekday && !isWeekday) return false;
  if (rule.match?.daysOfWeek && !rule.match.daysOfWeek.includes(d)) return false;

  if (rule.match?.dateRange) {
    const { start, end } = rule.match.dateRange;
    if (iso < start || iso > end) return false;
  }

  if (rule.match?.everyNthDayFrom) {
    if (!cadence.isNthDay(dt, rule.match.everyNthDayFrom)) return false;
  }

  if (rule.match?.fiveTwo) {
    // evaluated later to transform slots → keep as possible match
  }

  if (rule.match?.calendarTags?.length) {
    const hasAny = rule.match.calendarTags.some(tag => calendarTagsForDay.includes(tag));
    if (!hasAny) return false;
  }

  // exceptions override
  if (rule.except) {
    if (rule.except.weekend && isWeekend) return false;
    if (rule.except.weekday && isWeekday) return false;
    if (rule.except.daysOfWeek?.includes(d)) return false;
    if (rule.except.dates?.includes(iso)) return false;
    if (rule.except.calendarTags?.some(t => calendarTagsForDay.includes(t))) return false;
  }

  return true;
}

/* ------------------------------- IF Derivation ------------------------------- */
/**
 * Derive feeding windows from a concise pattern when rule.ifWindowDaily is not provided.
 * Examples:
 *  - "16:8"  → 8-hour window centered midday (12:00–20:00 by default)
 *  - "18:6"  → 6-hour window default 12:00–18:00
 *  - "20:4"  → 4-hour window default 14:00–18:00
 *  - "OMAD"  → one window of 1 hour at 17:00–18:00
 *  - "36h"   → extended fast handled via multiDayFast (no daily windows)
 *  Options on rule.ifPattern:
 *    { pattern: "16:8", anchor?: "12:00" }  // anchor = window start
 */
function deriveWindowsFromIfPattern(iso, tz, ifPattern) {
  if (!ifPattern) return [];
  const base = typeof ifPattern === "string" ? { pattern: ifPattern } : { ...ifPattern };
  const pattern = (base.pattern || "").toUpperCase().trim();

  // extended fast patterns -> no daily windows (handled by multi-day fast blocks)
  if (/\b(24H|36H|48H|72H)\b/.test(pattern)) return [];

  const anchor = base.anchor || "12:00";
  const [ah = 12, am = 0] = anchor.split(":").map(Number);
  const start = DateTime.fromISO(`${iso}T00:00:00`, { zone: tz }).plus({ hours: ah, minutes: am });

  let lengthHours = 0;
  if (pattern === "OMAD") lengthHours = 1;
  else if (/^\d{1,2}:\d{1,2}$/.test(pattern)) {
    // e.g., 16:8 → open window is the second number
    const [, eatingHours] = pattern.split(":").map(Number);
    lengthHours = eatingHours;
  } else if (/^\d{1,2}H:\d{1,2}H$/.test(pattern)) {
    const [, eatH] = pattern.toLowerCase().split("h:").map(Number);
    lengthHours = eatH;
  }

  if (lengthHours <= 0) return [];
  return [{ start, end: start.plus({ hours: lengthHours }) }];
}

/* ------------------------------ Profile Helpers ------------------------------ */

function chooseProfileForDate(dt, tags, profiles = []) {
  // profiles: [{ name, match: {...}, dayMacroTarget, dietTags, slotTemplate, overrides }]
  // First match by explicit calendar tags/dow ranges/weekday/weekend etc.
  // Highest priority profile first (if provided); else first match wins.
  const prioritized = [...profiles].sort((a, b) => (b?.priority ?? 0) - (a?.priority ?? 0));
  for (const p of prioritized) {
    if (!p?.match) continue;
    const fakeRule = { match: p.match, except: p.except };
    if (matchesRule(dt, fakeRule, tags)) return p;
  }
  // fallback: null
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
  injectSabbathAsRest = true
} = {}) {
  const rhythmState = useMealRhythmStore.getState?.() ?? {};
  const rules = (rhythmState.rules ?? [])
    .filter(r => r.enabled)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  const profiles = rhythmState.profiles ?? []; // optional

  const start = DateTime.fromISO(startISO, { zone: tz }).startOf("day");
  const end   = DateTime.fromISO(endISO,   { zone: tz }).startOf("day");
  if (!start.isValid || !end.isValid || end < start) throw new Error("Invalid date range.");

  // Precompute multi-day fasting blocks (across all rules)
  const multiDayBlocks = [];
  if (respectIF) {
    for (const r of rules) {
      // r.multiDayFast can be:
      //  - { pattern: "ADF" } (alternate-day fasting)
      //  - { pattern: "36h" } or "48h", start: "2025-09-01T18:00", cadence: "weekly|custom"
      //  - { fiveTwo: { lowDaysPerWeek: 2, startISO?: "..." } }
      if (r.multiDayFast) {
        const blocks = cadence.buildFastingBlocksInRange(startISO, endISO, tz, r.multiDayFast);
        multiDayBlocks.push(...blocks);
      }
    }
  }

  const days = {};
  for (let dt = start; dt <= end; dt = dt.plus({ days: 1 })) {
    const iso = dayKey(dt);
    const tags = await calendarTagLookup(iso);
    const dayObj = {
      date: iso,
      tz,
      tags,
      slots: [],
      dayMacroTarget: null,
      feedingWindows: [],
      isWithinMultiDayFast: false,
      profile: null,
      dietTags: [],
      notes: []
    };

    // Apply profile (weekday/weekend, tag-based, etc.)
    dayObj.profile = chooseProfileForDate(dt, tags, profiles);
    if (dayObj.profile?.dayMacroTarget) {
      dayObj.dayMacroTarget = { ...dayObj.profile.dayMacroTarget };
    }
    if (Array.isArray(dayObj.profile?.dietTags)) {
      dayObj.dietTags = [...dayObj.profile.dietTags];
    }

    // If Sabbath/Feast tags present & desired, simplify slot pattern unless overridden
    const isSabbath = tags.includes("SABBATH") || tags.includes("SHABBAT");
    const isFeast   = tags.includes("FEAST") || tags.includes("MOED") || tags.includes("HIGH_HOLY_DAY");
    const restDay   = injectSabbathAsRest && (isSabbath || isFeast);

    // Determine if this calendar day intersects a multi-day fasting block
    if (respectIF && multiDayBlocks.length) {
      // consider overlap if any portion of the day falls within a block
      const dayInterval = Interval.fromDateTimes(dt.startOf("day"), dt.endOf("day"));
      dayObj.isWithinMultiDayFast = cadence.doesAnyBlockOverlap(dayInterval, multiDayBlocks);
    }

    // Collect rules that match the day; they can contribute slots, macros, windows, ifPatterns
    const matchedRules = rules.filter(r => matchesRule(dt, r, tags));

    // Compose slots from matched rules or profile.slotTemplate (profile wins if provided)
    if (dayObj.profile?.slotTemplate?.length) {
      dayObj.slots.push(...cloneSlots(dayObj.profile.slotTemplate));
    } else {
      for (const rule of matchedRules) {
        for (const s of (rule.slots || [])) {
          if (!dayObj.slots.some(x => x.slotId === s.slotId)) {
            dayObj.slots.push({ ...s });
          }
        }
      }
    }

    // If rest day (Sabbath/Feast) and no explicit override, simplify to 2 meals + optional dessert
    if (restDay && !dayObj.profile?.overrides?.keepFullSlotsOnRestDay) {
      dayObj.notes.push(isFeast ? "Feast day: simplified celebratory meals." : "Sabbath: simplified restful meals.");
      dayObj.slots = simplifyToRestDaySlots(dayObj.slots);
    }

    // 5:2 handling per rule (convert applicable day to low-cal/fast)
    let fiveTwoTrigger = false;
    for (const rule of matchedRules) {
      if (rule.match?.fiveTwo && cadence.isFiveTwoFast(dt, rule.match.fiveTwo)) {
        fiveTwoTrigger = true;
      }
    }
    if (fiveTwoTrigger) {
      dayObj.slots = dayObj.slots.map((s) => ({ ...s, kind: "fast", timeHint: undefined }));
      dayObj.notes.push("5:2 low-intake/fast day.");
    }

    // Day macro target: profile has priority; otherwise first matching rule with target
    if (!dayObj.dayMacroTarget) {
      const rWithMacro = matchedRules.find(r => r.dayMacroTarget);
      if (rWithMacro) dayObj.dayMacroTarget = { ...rWithMacro.dayMacroTarget };
    }

    // IF windows:
    // - union of all rule.ifWindowDaily windows
    // - OR derived from rule.ifPattern if ifWindowDaily absent
    if (respectIF) {
      for (const rule of matchedRules) {
        let windows = [];
        if (rule.ifWindowDaily) {
          windows = cadence.composeDailyFeedingWindows(iso, tz, rule.ifWindowDaily);
        } else if (rule.ifPattern) {
          windows = deriveWindowsFromIfPattern(iso, tz, rule.ifPattern);
        }
        if (windows?.length) dayObj.feedingWindows.push(...windows);
      }

      // merge windows
      if (dayObj.feedingWindows.length > 1) {
        dayObj.feedingWindows.sort((a, b) => a.start.toMillis() - b.start.toMillis());
        const merged = [];
        for (const w of dayObj.feedingWindows) {
          const last = merged[merged.length - 1];
          if (last && w.start <= last.end) {
            last.end = w.end > last.end ? w.end : last.end;
          } else merged.push({ ...w });
        }
        dayObj.feedingWindows = merged;
      }
    }

    // Apply IF rules to slots
    if (respectIF) {
      if (dayObj.isWithinMultiDayFast) {
        dayObj.slots = dayObj.slots.map(s => ({ ...s, kind: "fast", timeHint: undefined }));
        dayObj.notes.push("Within extended fast block.");
      } else if (dayObj.feedingWindows.length) {
        const windows = dayObj.feedingWindows;
        dayObj.slots = dayObj.slots.flatMap(s => {
          if (s.kind === "fast") return [s];
          const t = s.timeHint || defaultAnchorTimeFor(preferWindowAnchor, windows);
          const [hh = 12, mm = 0] = String(t).split(":").map(Number);
          const dtSlot = DateTime.fromISO(`${iso}T00:00:00`, { zone: tz }).plus({ hours: hh, minutes: mm });
          const inside = cadence.isDTWithinWindows(dtSlot, windows);

          if (inside) return [s];

          if (slotOutsideIF === "drop") return [];
          if (slotOutsideIF === "convert") return [{ ...s, kind: "fast", timeHint: undefined }];

          // default: shift (snap) into a window
          const snapped = cadence.snapTimeIntoWindows(iso, tz, t, windows, preferWindowAnchor);
          return [{ ...s, timeHint: snapped }];
        });
      }
    }

    // Final sort by time if present
    dayObj.slots.sort((a, b) => (a.timeHint || "99:99").localeCompare(b.timeHint || "99:99"));

    // Attach
    days[iso] = dayObj;
  }

  /* -------------------- Optional Recipe Assignment (Pluggable) -------------------- */
  // If RecipeStore/MealPlanStore exist, try a best-effort recipe assignment that respects:
  // - slot.kind (meal/snack)
  // - dayMacroTarget (calories/macros)
  // - dayObj.dietTags (e.g., keto, dairy-free)
  // - Recipe allergens/tags (avoid if conflicts)
  if (MealPlanStore && RecipeStore) {
    for (const iso of Object.keys(days)) {
      const dayObj = days[iso];
      for (const slot of dayObj.slots) {
        if (slot.kind === "meal" || slot.kind === "snack") {
          try {
            const recipe = await pickRecipeForSlot({
              slot,
              dayObj,
              RecipeStore
            });
            if (recipe && MealPlanStore.assign) {
              await MealPlanStore.assign(iso, slot.slotId ?? slot.label ?? `${slot.kind}-${slot.timeHint ?? ""}`, recipe);
            }
          } catch (e) {
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
          color: "#a78bfa"
        });
      } else if (day.feedingWindows.length) {
        day.feedingWindows.forEach(w => {
          events.push({
            title: "Feeding Window",
            start: w.start.toISO(),
            end: w.end.toISO(),
            source: "MealRhythm",
            color: "#60a5fa"
          });
        });
      }

      day.slots.forEach((slot) => {
        if (slot.kind === "fast") {
          events.push({
            title: "Fast",
            start: `${iso}T08:00:00`,
            end:   `${iso}T20:00:00`,
            source: "MealRhythm",
            color: "#c4b5fd"
          });
        } else {
          const t = slot.timeHint || "12:00";
          events.push({
            title: slot.label ?? (slot.kind === "snack" ? "Snack" : "Meal"),
            start: `${iso}T${t}:00`,
            end:   `${iso}T${t}:00`,
            source: "MealRhythm",
            color: slot.kind === "snack" ? "#60a5fa" : "#34d399"
          });
        }
      });
    }
    try { await CalendarSyncModule.createMealEventsBatch({ events }); } catch {}
  }

  // Emit an event for other modules (dashboards, GroceryListGenerator, etc.)
  try {
    EventBus?.emit?.("mealplan:generated", { range: { startISO, endISO }, tz, days });
  } catch {}

  return { days };
}

/* --------------------------------- Utilities --------------------------------- */

function cloneSlots(template = []) {
  return template.map(s => ({ ...s }));
}

function simplifyToRestDaySlots(slots = []) {
  // Choose up to two primary meals; keep one snack (dessert) if present; otherwise synthesize
  const meals = slots.filter(s => s.kind === "meal");
  const snacks = slots.filter(s => s.kind === "snack");

  const out = [];
  if (meals.length >= 2) {
    out.push(
      { ...meals[0], label: meals[0].label ?? "Meal 1", timeHint: meals[0].timeHint ?? "12:30" },
      { ...meals[1], label: meals[1].label ?? "Meal 2", timeHint: meals[1].timeHint ?? "17:30" }
    );
  } else if (meals.length === 1) {
    out.push(
      { ...meals[0], label: meals[0].label ?? "Meal", timeHint: meals[0].timeHint ?? "15:00" }
    );
  } else {
    out.push(
      { kind: "meal", label: "Meal 1", slotId: "meal-1", timeHint: "12:30" },
      { kind: "meal", label: "Meal 2", slotId: "meal-2", timeHint: "17:30" }
    );
  }

  const dessert = snacks[0] ?? { kind: "snack", label: "Dessert", slotId: "snack-1", timeHint: "19:00" };
  out.push(dessert);
  return out;
}

function defaultAnchorTimeFor(anchor = "start", windows = []) {
  if (!windows?.length) return "12:00";
  const w = windows[0];
  if (anchor === "end") {
    const end = w.end.toFormat("HH:mm");
    return end;
  }
  if (anchor === "mid") {
    const mid = w.start.plus(w.end.diff(w.start).dividedBy(2));
    return mid.toFormat("HH:mm");
  }
  return w.start.toFormat("HH:mm"); // start
}

/**
 * Best-effort recipe picker that respects diet/allergen tags.
 * Expected RecipeStore interface (loosely):
 *   - RecipeStore.findCandidates({ kind, dietTags, avoidAllergens, macrosTarget }) → Recipe[]
 *   - RecipeStore.pickOne(candidates, criteria) → Recipe
 */
async function pickRecipeForSlot({ slot, dayObj, RecipeStore }) {
  const avoidAllergens = (dayObj.profile?.avoidAllergens ?? []).concat(dayObj.profile?.allergensToAvoid ?? []);
  const criteria = {
    kind: slot.kind,                               // 'meal' | 'snack'
    dietTags: dayObj.dietTags,                     // e.g., ['keto','dairy-free']
    avoidAllergens,                                // e.g., ['gluten','peanuts']
    macrosTarget: dayObj.dayMacroTarget || null,   // { kcal, protein, carbs, fat }
    timeHint: slot.timeHint
  };

  let candidates = [];
  if (RecipeStore.findCandidates) {
    candidates = await RecipeStore.findCandidates(criteria);
  } else if (RecipeStore.pickFor) {
    // older interface—falls back to simple picker
    return await RecipeStore.pickFor(slot, dayObj.dayMacroTarget);
  }

  if (!candidates?.length && RecipeStore.fallbackCandidates) {
    candidates = await RecipeStore.fallbackCandidates(criteria);
  }
  if (!candidates?.length) return null;

  if (RecipeStore.pickOne) return await RecipeStore.pickOne(candidates, criteria);
  return candidates[0];
}
