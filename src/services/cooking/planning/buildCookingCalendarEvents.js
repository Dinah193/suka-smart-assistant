// C:\Users\larho\suka-smart-assistant\src\services\cooking\planning\buildCookingCalendarEvents.js
/* eslint-disable no-console */

import eventBus from "@/services/events/eventBus.js";
import { calendarEventId as stableCalendarEventId } from "@/services/planning/ids.js";

/**
 * Cooking Planning: buildCookingCalendarEvents(domain, occurrence, context)
 * -----------------------------------------------------------------------------
 * Where this fits in SSA pipeline:
 *   imports → normalize → intelligence (meal/cooking plan) → occurrences → calendar events
 *   → acceptPlanApply persists sessions/calendar → automation runtime schedules/suggests
 *   → SessionRunner executes → events → (optional) Hub export handled by accept pipeline.
 *
 * This file is a COOKING-domain adapter helper used by the shared acceptance
 * pipeline (src/services/planning/acceptPlanApply.js).
 *
 * Responsibilities:
 * - Convert a normalized cooking occurrence into one or more calendar events.
 * - Include optional “prep” and “cook” blocks, reminders, and metadata
 *   that support automation and user notifications.
 * - Be defensive: tolerate missing dates; emit advisory warnings.
 *
 * Notes:
 * - This file does NOT persist anything and does NOT export to Hub.
 * - CalendarRepo.upsertMany is called by acceptPlanApply.
 */

const SOURCE = "services/cooking/planning/buildCookingCalendarEvents";

/* ------------------------------ Small helpers ------------------------------ */

function nowIso() {
  return new Date().toISOString();
}

function emit(type, data) {
  try {
    eventBus.emit({ type, ts: nowIso(), source: SOURCE, data });
  } catch (e) {
    console.warn(`[${SOURCE}] eventBus.emit failed: ${type}`, e);
  }
}

function isObj(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function asArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function isoOrNull(v) {
  if (!v) return null;
  if (typeof v === "string") return v;
  try {
    const d = v instanceof Date ? v : new Date(v);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch {
    return null;
  }
}

function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

function minutesToMs(min) {
  const n = Number(min);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 60 * 1000);
}

function addMsToIso(iso, ms) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t + ms).toISOString();
}

function subMsFromIso(iso, ms) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t - ms).toISOString();
}

function summarizeRecipes(occurrence) {
  const refs = asArray(occurrence?.meta?.recipes).filter(Boolean);
  const titles = refs
    .map((r) => {
      if (typeof r === "string") return r;
      return r?.title || r?.name || r?.label || r?.id || r?.recipeId || null;
    })
    .filter(Boolean);

  return {
    count: titles.length,
    titles: titles.slice(0, 5),
    summary: titles.length
      ? titles.slice(0, 3).join(", ") + (titles.length > 3 ? "…" : "")
      : "",
  };
}

function buildReminders(context, phase /* "prep" | "cook" */) {
  // Default reminders can be overridden by context.calendarReminders or domain settings.
  // Shapes supported:
  // - context.calendarReminders: [{ minutesBefore, method, label }]
  // - context.cookingCalendar: { prepMinutesBefore, cookMinutesBefore, remindersByPhase }
  const cfg = context?.cookingCalendar || {};
  const base = asArray(context?.calendarReminders);

  const byPhase =
    isObj(cfg.remindersByPhase) && Array.isArray(cfg.remindersByPhase[phase])
      ? cfg.remindersByPhase[phase]
      : null;

  if (byPhase) return byPhase.map((r) => ({ ...r }));

  if (base.length) return base.map((r) => ({ ...r }));

  // Fall back to simple defaults
  if (phase === "prep")
    return [
      { minutesBefore: 60, method: "notification", label: "Prep reminder" },
    ];
  return [
    { minutesBefore: 15, method: "notification", label: "Cooking reminder" },
  ];
}

function buildTitle(baseTitle, phase, recipesSummary) {
  const recipeSuffix = recipesSummary?.summary
    ? ` — ${recipesSummary.summary}`
    : "";
  if (phase === "prep") return `Prep: ${baseTitle}${recipeSuffix}`;
  if (phase === "cook") return `Cook: ${baseTitle}${recipeSuffix}`;
  return `${baseTitle}${recipeSuffix}`;
}

/**
 * Calendar event object shape (flexible):
 * {
 *   id, domain, planId, occurrenceId,
 *   title, startAt, endAt,
 *   kind: "prep"|"cook",
 *   reminders: [{minutesBefore, method, label}],
 *   meta: {...}
 * }
 */
function makeEvent({
  id,
  domain,
  planId,
  occurrenceId,
  title,
  startAt,
  endAt,
  kind,
  reminders,
  meta,
}) {
  return {
    id,
    domain,
    planId,
    occurrenceId,
    title,
    startAt,
    endAt,
    kind: kind || "cook",
    reminders: Array.isArray(reminders) ? reminders : [],
    updatedAt: nowIso(),
    meta: meta || null,
  };
}

/* ------------------------------ Public API ---------------------------------- */

/**
 * buildCookingCalendarEvents(domain, occurrence, context)
 * ---------------------------------------------------------------------------
 * Called by shared acceptPlanApply:
 *   buildCalendarEvents(domain, occurrence, context)
 */
export default function buildCookingCalendarEvents(
  domain,
  occurrence,
  context = {}
) {
  if (!domain || typeof domain !== "string") {
    emit("cooking.calendar.warning", {
      ok: false,
      error: "domain is required",
    });
    return [];
  }
  if (!occurrence || typeof occurrence !== "object") {
    emit("cooking.calendar.warning", {
      ok: false,
      domain,
      error: "occurrence is required",
    });
    return [];
  }

  const startAt = isoOrNull(occurrence.startAt) || null;
  const endAt = isoOrNull(occurrence.endAt) || null;

  // If no startAt, we cannot create a meaningful calendar event.
  if (!startAt) {
    emit("cooking.calendar.warning", {
      domain,
      occurrenceId: occurrence?.id || null,
      message: "Occurrence missing startAt; calendar events not created.",
    });
    return [];
  }

  const planId = occurrence?.planId || null;
  const occId = occurrence?.id || null;
  const baseTitle = occurrence?.title || "Cooking session";

  const recipesSummary = summarizeRecipes(occurrence);

  // Durations and splits
  const cfg = context?.cookingCalendar || {};
  const totalMinFromMeta = Number(occurrence?.meta?.durationMin);
  const totalMin =
    Number.isFinite(totalMinFromMeta) && totalMinFromMeta > 0
      ? Math.round(totalMinFromMeta)
      : null;

  const defaultTotalMin = 60;
  const effectiveTotalMin = totalMin || defaultTotalMin;

  // Prep block:
  // - If explicit prepMin exists, use it.
  // - Else use a fraction of total (default 25%), clamped.
  const prepMinOverride = Number(cfg.prepMinutes);
  const prepMinFromMeta = Number(occurrence?.meta?.prepMin);
  const prepMin =
    (Number.isFinite(prepMinFromMeta) &&
      prepMinFromMeta >= 0 &&
      Math.round(prepMinFromMeta)) ||
    (Number.isFinite(prepMinOverride) &&
      prepMinOverride >= 0 &&
      Math.round(prepMinOverride)) ||
    clamp(Math.round(effectiveTotalMin * 0.25), 10, 90);

  const cookMin = Math.max(10, effectiveTotalMin - prepMin);

  // If endAt exists, try to respect it by back-calculating windows.
  // Otherwise, compute endAt from startAt + totalMin.
  const effectiveEndAt =
    endAt || addMsToIso(startAt, minutesToMs(effectiveTotalMin));

  // Build time windows:
  // - cook window ends at effectiveEndAt, lasts cookMin
  // - prep window precedes cook window, lasts prepMin
  const cookEndAt = effectiveEndAt;
  const cookStartAt = subMsFromIso(cookEndAt, minutesToMs(cookMin)) || startAt;

  const prepEndAt = cookStartAt;
  const prepStartAt = subMsFromIso(prepEndAt, minutesToMs(prepMin)) || startAt;

  // If user explicitly wants “single block” calendar entries, support it.
  const mode = cfg.mode || context?.calendarMode || "split"; // "split" | "single"
  const includePrep = cfg.includePrep !== false; // default true
  const includeCook = cfg.includeCook !== false; // default true

  const events = [];

  if (mode === "single") {
    const eid = stableCalendarEventId(domain, occurrence, "cook-main");
    events.push(
      makeEvent({
        id: eid,
        domain,
        planId,
        occurrenceId: occId,
        title: buildTitle(baseTitle, "cook", recipesSummary),
        startAt,
        endAt: effectiveEndAt,
        kind: "cook",
        reminders: buildReminders(context, "cook"),
        meta: {
          adapter: "cooking",
          mode: "single",
          mealSlot: occurrence?.meta?.mealSlot || null,
          recipes: recipesSummary,
          equipment: asArray(occurrence?.meta?.equipment),
          ingredientsCount:
            asArray(occurrence?.meta?.ingredients).length || null,
        },
      })
    );
  } else {
    // split mode: create prep + cook blocks
    if (includePrep && prepMin > 0) {
      const eid = stableCalendarEventId(domain, occurrence, "prep");
      events.push(
        makeEvent({
          id: eid,
          domain,
          planId,
          occurrenceId: occId,
          title: buildTitle(baseTitle, "prep", recipesSummary),
          startAt: prepStartAt,
          endAt: prepEndAt,
          kind: "prep",
          reminders: buildReminders(context, "prep"),
          meta: {
            adapter: "cooking",
            phase: "prep",
            mealSlot: occurrence?.meta?.mealSlot || null,
            recipes: recipesSummary,
            equipment: asArray(occurrence?.meta?.equipment),
            // forward hooks
            inventoryCheck: true,
          },
        })
      );
    }

    if (includeCook) {
      const eid = stableCalendarEventId(domain, occurrence, "cook");
      events.push(
        makeEvent({
          id: eid,
          domain,
          planId,
          occurrenceId: occId,
          title: buildTitle(baseTitle, "cook", recipesSummary),
          startAt: cookStartAt,
          endAt: cookEndAt,
          kind: "cook",
          reminders: buildReminders(context, "cook"),
          meta: {
            adapter: "cooking",
            phase: "cook",
            mealSlot: occurrence?.meta?.mealSlot || null,
            recipes: recipesSummary,
            equipment: asArray(occurrence?.meta?.equipment),
            ingredientsCount:
              asArray(occurrence?.meta?.ingredients).length || null,
            // forward hooks
            startSessionCta: true,
          },
        })
      );
    }
  }

  // Advisory event: built calendar events
  emit("cooking.calendar.events.built", {
    ok: true,
    domain,
    occurrenceId: occId,
    planId,
    count: events.length,
    ids: events.map((e) => e.id),
    mode,
  });

  return events;
}
