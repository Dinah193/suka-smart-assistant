// C:\Users\larho\suka-smart-assistant\src\services\cleaning\planning\buildCleaningOccurrences.js
/* eslint-disable no-console */

import { normalizeOccurrence } from "@/services/planning/normalizeOccurrence.js";

/**
 * Cleaning Planning: buildCleaningOccurrences(domain, plan, draft)
 * -----------------------------------------------------------------------------
 * Where this fits in SSA pipeline:
 *   imports → normalize → intelligence (cleaning plan) → occurrences → accept → sessions/calendar
 *   → automation runtime schedules/suggests → SessionRunner executes → events → (optional) Hub export.
 *
 * This file is a CLEANING-domain adapter helper used by the shared acceptance
 * pipeline (src/services/planning/acceptPlanApply.js).
 *
 * Responsibilities:
 * - Take a cleaning plan (and optional draft UI state) and expand it into a list
 *   of time-bounded "occurrences" (one per cleaning block / room run / zone loop).
 * - Be defensive: tolerate partial plan shapes and drafts.
 * - Forward-thinking: support new cleaning plan types (deep clean cycles,
 *   maintenance loops, whole-home resets, move-in/out, seasonal rotations).
 *
 * Notes:
 * - This file does NOT persist anything and does NOT export to Hub.
 * - IDs are made stable downstream via normalizeOccurrence + ids.js.
 */

const ADAPTER_NAME = "cleaning";

/* ------------------------------ Small helpers ------------------------------ */

function nowIso() {
  return new Date().toISOString();
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

function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

function buildTitle(plan, slot, zones) {
  const base =
    slot?.title ||
    slot?.name ||
    slot?.label ||
    plan?.title ||
    plan?.name ||
    plan?.label ||
    "Cleaning session";

  const zNames = (zones || [])
    .slice(0, 3)
    .map((z) => z?.name || z?.title || z?.label || z?.id)
    .filter(Boolean);

  if (zNames.length) {
    const suffix = zNames.join(", ") + ((zones || []).length > 3 ? "…" : "");
    const baseLower = String(base).toLowerCase();
    const anyContained = zNames.some((n) =>
      baseLower.includes(String(n).toLowerCase())
    );
    return anyContained ? base : `${base}: ${suffix}`;
  }

  return base;
}

/**
 * Zones/rooms/areas can appear as:
 * - plan.zones: [{id,name,tasks...}]
 * - plan.rooms: [...]
 * - plan.areas: [...]
 * - slot.zones/slot.rooms/slot.areas
 * - draft.selectedZones
 */
function collectZones(plan, draft, slot) {
  const out = [];

  const push = (z) => {
    if (!z) return;
    if (typeof z === "string") out.push({ id: z, name: z });
    else if (isObj(z)) out.push(z);
  };

  asArray(plan?.zones).forEach(push);
  asArray(plan?.rooms).forEach(push);
  asArray(plan?.areas).forEach(push);

  asArray(slot?.zones).forEach(push);
  asArray(slot?.rooms).forEach(push);
  asArray(slot?.areas).forEach(push);

  asArray(draft?.selectedZones).forEach(push);

  // De-dupe by id/name
  const seen = new Set();
  const deduped = [];
  for (const z of out) {
    const key = String(z?.id || z?.name || z?.title || "").trim();
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(z);
  }
  return deduped;
}

/**
 * Tasks can appear as:
 * - plan.tasks / slot.tasks
 * - plan.checklist / slot.checklist
 * - per-zone tasks
 * Supports strings or objects.
 */
function collectTasks(plan, slot, zones) {
  const out = [];

  const push = (t, zoneId = null) => {
    if (!t) return;
    if (typeof t === "string") out.push({ text: t, zoneId });
    else if (isObj(t)) out.push({ ...t, zoneId: t.zoneId ?? zoneId });
  };

  asArray(plan?.tasks).forEach((t) => push(t, null));
  asArray(plan?.checklist).forEach((t) => push(t, null));

  asArray(slot?.tasks).forEach((t) => push(t, null));
  asArray(slot?.checklist).forEach((t) => push(t, null));

  for (const z of zones || []) {
    const zid = z?.id || z?.zoneId || z?.name || null;
    asArray(z?.tasks).forEach((t) => push(t, zid));
    asArray(z?.checklist).forEach((t) => push(t, zid));
  }

  // De-dupe by (zoneId + text/title/id)
  const seen = new Set();
  const deduped = [];
  for (const t of out) {
    const key = `${String(t?.zoneId || "")}::${String(
      t?.id || t?.title || t?.text || ""
    )}`.trim();
    if (!key || key === "::") continue;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(t);
  }

  return deduped;
}

/**
 * Estimate duration (minutes):
 * - prefer plan.durationMin / slot.durationMin
 * - else derive from task count (default 7 min per task) + zones (default 10 min per zone)
 * - clamp to sane bounds
 */
function estimateDurationMin(plan, slot, tasks, zones, draft) {
  const direct =
    slot?.durationMin ??
    slot?.durationMinutes ??
    plan?.durationMin ??
    plan?.durationMinutes ??
    plan?.estimatedMinutes ??
    draft?.durationMin ??
    draft?.estimatedMinutes;

  const n = Number(direct);
  if (Number.isFinite(n) && n > 0) return Math.round(n);

  const taskMinEach = Number.isFinite(Number(plan?.taskMinEach))
    ? Number(plan.taskMinEach)
    : 7;
  const zoneMinEach = Number.isFinite(Number(plan?.zoneMinEach))
    ? Number(plan.zoneMinEach)
    : 10;

  const est =
    (tasks?.length || 0) * taskMinEach + (zones?.length || 0) * zoneMinEach;
  return clamp(Math.round(est || 45), 20, 240);
}

/**
 * Resolve a schedule "startAt" for an occurrence:
 * - prefer explicit per-slot startAt
 * - else plan.startAt / plan.date / plan.day
 * - else draft.startAt
 * - else now
 */
function resolveStartAt(plan, draft, slot) {
  return (
    isoOrNull(slot?.startAt) ||
    isoOrNull(slot?.start) ||
    isoOrNull(plan?.startAt) ||
    isoOrNull(plan?.date) ||
    isoOrNull(plan?.day) ||
    isoOrNull(draft?.startAt) ||
    nowIso()
  );
}

function detectCleanType(plan, slot) {
  // e.g. "maintenance" | "deep" | "reset" | "move_in_out" | "seasonal"
  return (
    slot?.cleanType ||
    plan?.cleanType ||
    slot?.type ||
    plan?.type ||
    "maintenance"
  );
}

function detectPriority(plan, slot) {
  return slot?.priority ?? plan?.priority ?? null;
}

/* ------------------------------ Main function ------------------------------ */

/**
 * buildCleaningOccurrences(domain, plan, draft)
 * ---------------------------------------------------------------------------
 * Returns an array of occurrences (already normalized when possible).
 * The shared acceptance pipeline will still normalize (safe to re-normalize).
 */
export default function buildCleaningOccurrences(domain, plan, draft) {
  if (!domain || typeof domain !== "string") {
    console.warn("[buildCleaningOccurrences] Missing domain");
    return [];
  }
  if (!plan || typeof plan !== "object") {
    console.warn("[buildCleaningOccurrences] Missing plan object");
    return [];
  }

  // Accept precomputed occurrences (from a higher-level planner), but enrich.
  const provided = Array.isArray(plan.occurrences) ? plan.occurrences : null;

  // Supported slot sources if occurrences not provided:
  // - plan.schedule / plan.slots
  // - plan.blocks (cleaning blocks)
  // - plan.zones (each zone becomes an occurrence if no schedule)
  const scheduleSlots = asArray(plan?.schedule).length
    ? asArray(plan?.schedule)
    : asArray(plan?.slots).length
    ? asArray(plan?.slots)
    : asArray(plan?.blocks).length
    ? asArray(plan?.blocks)
    : [];

  // If plan has no schedule but has zones, optionally create one occurrence per zone
  const planZones = collectZones(plan, draft, null);

  // Default “session meta” to carry forward into occurrences
  const baseMeta = {
    cleanType: detectCleanType(plan, null),
    priority: detectPriority(plan, null),
    zones: planZones.map((z) => ({
      id: z?.id || z?.zoneId || null,
      name: z?.name || z?.title || z?.label || null,
    })),
    supplies: asArray(plan?.supplies).filter(Boolean), // e.g. vinegar, baking soda, mop pads
    equipment: asArray(plan?.equipment).filter(Boolean), // e.g. vacuum, steam mop
    constraints: plan?.constraints || draft?.constraints || null, // e.g. "quiet hours", "no bleach"
    householdRules: plan?.householdRules || null,
    // Forward hooks:
    allergens: plan?.allergens || null,
    pets: plan?.pets || null,
  };

  if (provided && provided.length) {
    return provided.map((occ) => {
      const zones = collectZones(plan, draft, occ);
      const tasks = collectTasks(plan, occ, zones);
      const startAt = resolveStartAt(plan, draft, occ);
      const durationMin = estimateDurationMin(plan, occ, tasks, zones, draft);
      const endAt =
        isoOrNull(occ?.endAt) ||
        isoOrNull(occ?.end) ||
        (durationMin ? addMsToIso(startAt, minutesToMs(durationMin)) : null);

      const title = buildTitle(plan, occ, zones);

      const rawOccurrence = {
        startAt,
        endAt,
        title,
        meta: {
          ...baseMeta,
          ...occ?.meta,
          cleanType: detectCleanType(plan, occ),
          priority: detectPriority(plan, occ),
          durationMin,
          zones: zones.map((z) => ({
            id: z?.id || z?.zoneId || null,
            name: z?.name || z?.title || z?.label || null,
          })),
          tasks,
          // Slot-level overrides
          supplies: occ?.supplies || baseMeta.supplies,
          equipment: occ?.equipment || baseMeta.equipment,
        },
      };

      try {
        return normalizeOccurrence(domain, plan, rawOccurrence, ADAPTER_NAME);
      } catch {
        return rawOccurrence;
      }
    });
  }

  // If we have schedule slots, build one occurrence per slot
  if (scheduleSlots.length) {
    const occs = [];

    for (const slot of scheduleSlots) {
      if (!slot) continue;

      const zones = collectZones(plan, draft, slot);
      const tasks = collectTasks(plan, slot, zones);

      const startAt = resolveStartAt(plan, draft, slot);
      const durationMin = estimateDurationMin(plan, slot, tasks, zones, draft);
      const endAt =
        isoOrNull(slot?.endAt) ||
        isoOrNull(slot?.end) ||
        (durationMin ? addMsToIso(startAt, minutesToMs(durationMin)) : null);

      const title = buildTitle(plan, slot, zones);

      const rawOccurrence = {
        startAt,
        endAt,
        title,
        meta: {
          ...baseMeta,
          ...slot?.meta,
          cleanType: detectCleanType(plan, slot),
          priority: detectPriority(plan, slot),
          durationMin,
          zones: zones.map((z) => ({
            id: z?.id || z?.zoneId || null,
            name: z?.name || z?.title || z?.label || null,
          })),
          tasks,
          supplies: slot?.supplies || baseMeta.supplies,
          equipment: slot?.equipment || baseMeta.equipment,
          // forward hooks:
          cadence: slot?.cadence || plan?.cadence || null, // e.g. weekly/biweekly/monthly
          checklistTemplateId:
            slot?.checklistTemplateId || plan?.checklistTemplateId || null,
        },
      };

      try {
        occs.push(
          normalizeOccurrence(domain, plan, rawOccurrence, ADAPTER_NAME)
        );
      } catch {
        occs.push(rawOccurrence);
      }
    }

    return occs.length
      ? occs
      : [
          // fallback single occurrence
          normalizeOccurrence(
            domain,
            plan,
            {
              startAt: resolveStartAt(plan, draft, null),
              endAt: null,
              title: buildTitle(plan, null, planZones),
              meta: {
                ...baseMeta,
                durationMin: 45,
                tasks: collectTasks(plan, null, planZones),
              },
            },
            ADAPTER_NAME
          ),
        ];
  }

  // No schedule slots: if multiple zones exist, create one occurrence per zone (optional)
  if (planZones.length > 1) {
    return planZones.map((z, idx) => {
      const startAt = resolveStartAt(plan, draft, null);
      const offsetMin = idx * 60; // naive spacing; automation runtime can adjust later
      const startAtOffset =
        addMsToIso(startAt, minutesToMs(offsetMin)) || startAt;

      const zones = [z];
      const tasks = collectTasks(plan, null, zones);

      const durationMin = estimateDurationMin(plan, null, tasks, zones, draft);
      const endAt = durationMin
        ? addMsToIso(startAtOffset, minutesToMs(durationMin))
        : null;

      const rawOccurrence = {
        startAt: startAtOffset,
        endAt,
        title: buildTitle(
          plan,
          { title: z?.name || z?.title || "Zone clean" },
          zones
        ),
        meta: {
          ...baseMeta,
          cleanType: detectCleanType(plan, null),
          durationMin,
          zones: zones.map((zz) => ({
            id: zz?.id || zz?.zoneId || null,
            name: zz?.name || zz?.title || zz?.label || null,
          })),
          tasks,
        },
      };

      try {
        return normalizeOccurrence(domain, plan, rawOccurrence, ADAPTER_NAME);
      } catch {
        return rawOccurrence;
      }
    });
  }

  // Final fallback: single occurrence
  const startAt = resolveStartAt(plan, draft, null);
  const tasks = collectTasks(plan, null, planZones);
  const durationMin = estimateDurationMin(plan, null, tasks, planZones, draft);
  const endAt = durationMin
    ? addMsToIso(startAt, minutesToMs(durationMin))
    : null;

  const fallbackOcc = {
    startAt,
    endAt,
    title: buildTitle(plan, null, planZones),
    meta: {
      ...baseMeta,
      durationMin,
      zones: planZones.map((z) => ({
        id: z?.id || z?.zoneId || null,
        name: z?.name || z?.title || z?.label || null,
      })),
      tasks,
    },
  };

  try {
    return [normalizeOccurrence(domain, plan, fallbackOcc, ADAPTER_NAME)];
  } catch {
    return [fallbackOcc];
  }
}
