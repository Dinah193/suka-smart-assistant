// C:\Users\larho\suka-smart-assistant\src\services\cleaning\planning\buildCleaningSessionDraft.js
/* eslint-disable no-console */

import eventBus from "@/services/events/eventBus.js";
import { sessionId as stableSessionId } from "@/services/planning/ids.js";

/**
 * Cleaning Planning: buildCleaningSessionDraft(domain, occurrence, context)
 * -----------------------------------------------------------------------------
 * Where this fits in SSA pipeline:
 *   imports → normalize → intelligence (cleaning plan) → occurrences → session drafts
 *   → acceptPlanApply persists sessions/calendar → automation runtime schedules/suggests
 *   → SessionRunner executes → emits events → (optional) Hub export handled by accept pipeline.
 *
 * This file is a CLEANING-domain adapter helper used by the shared acceptance
 * pipeline (src/services/planning/acceptPlanApply.js).
 *
 * Responsibilities:
 * - Convert a normalized cleaning occurrence into a runnable Cleaning Session Draft.
 * - Consolidate tasks across zones/rooms into ONE comprehensive session flow.
 * - Attach durations/timers where possible (from tasks or heuristics).
 * - Leave extension points for: supply checks, inventory linking, quiet-hours guards,
 *   child/pet safety constraints, “whole-home reset” patterns, and seasonal rotations.
 *
 * Notes:
 * - This file does NOT persist anything itself.
 * - It may emit advisory events (draft built, warnings) using eventBus.
 */

const SOURCE = "services/cleaning/planning/buildCleaningSessionDraft";

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

function toText(v) {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (isObj(v) && typeof v.text === "string") return v.text.trim();
  return String(v).trim();
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

function normalizeTimer(raw) {
  // Accept:
  // - number minutes
  // - { minutes } / { seconds } / { ms }
  // - { label, minutes/seconds/ms }
  if (raw == null) return null;

  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return { label: "Timer", ms: Math.round(raw * 60 * 1000) };
  }

  if (!isObj(raw)) return null;

  const label = raw.label || raw.name || "Timer";

  const ms =
    (Number.isFinite(Number(raw.ms)) &&
      Number(raw.ms) > 0 &&
      Math.round(Number(raw.ms))) ||
    (Number.isFinite(Number(raw.seconds)) &&
      Number(raw.seconds) > 0 &&
      Math.round(Number(raw.seconds) * 1000)) ||
    (Number.isFinite(Number(raw.minutes)) &&
      Number(raw.minutes) > 0 &&
      Math.round(Number(raw.minutes) * 60 * 1000));

  if (!ms) return null;
  return { label: String(label), ms };
}

function makeStep({ id, title, text, kind, timers, zoneId, zoneName, meta }) {
  return {
    id,
    title: title || null,
    text: text || "",
    kind: kind || "clean",
    timers: Array.isArray(timers) ? timers.filter(Boolean) : [],
    zoneId: zoneId || null,
    zoneName: zoneName || null,
    meta: meta || null,
  };
}

function makeStableStepId(sessionId, zoneKey, stepIndex, phase = "clean") {
  const z = zoneKey ? String(zoneKey) : "global";
  return `${sessionId}::${z}::${phase}::${stepIndex}`;
}

/* ------------------------------ Extraction logic ------------------------------ */

function normalizeZonesFromOccurrence(occurrence) {
  const zones = asArray(occurrence?.meta?.zones).filter(Boolean);

  // Allow zones to be strings or objects
  const out = [];
  const seen = new Set();

  for (const z of zones) {
    const zid =
      typeof z === "string"
        ? z
        : z?.id || z?.zoneId || z?.name || z?.title || null;
    const zname =
      typeof z === "string"
        ? z
        : z?.name || z?.title || z?.label || (zid ? String(zid) : "Zone");
    const key = String(zid || zname || "").trim();
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: zid ? String(zid) : null, name: String(zname) });
  }

  return out;
}

function normalizeTasksFromOccurrence(occurrence) {
  const tasks = asArray(occurrence?.meta?.tasks).filter(Boolean);

  // Tasks can be:
  // - string
  // - { text/title, minutes, timer, zoneId }
  const out = [];
  for (const t of tasks) {
    if (typeof t === "string")
      out.push({ text: t, minutes: null, timer: null, zoneId: null });
    else if (isObj(t)) {
      const text = toText(
        t.text || t.title || t.label || t.task || t.instruction
      );
      if (!text) continue;

      const minutes =
        Number.isFinite(Number(t.minutes)) && Number(t.minutes) > 0
          ? Math.round(Number(t.minutes))
          : null;

      const timer =
        normalizeTimer(t.timer) ||
        normalizeTimer(t.timers?.[0]) ||
        normalizeTimer(t.duration) ||
        normalizeTimer(t.time) ||
        (minutes ? { label: "Timer", ms: minutesToMs(minutes) } : null);

      out.push({
        id: t.id || null,
        text,
        minutes,
        timer,
        zoneId: t.zoneId || t.zone || null,
        kind: t.kind || t.type || null, // "declutter" | "wipe" | "vacuum" | etc.
        priority: t.priority ?? null,
        meta: t.meta || null,
      });
    }
  }

  return out;
}

/**
 * If tasks have no durations, derive rough durations:
 * - default 7 min per task
 * - certain keywords get more time (vacuum/mop/bathroom/declutter)
 */
function inferTaskMinutes(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return null;

  if (t.includes("bathroom") || t.includes("shower") || t.includes("toilet"))
    return 15;
  if (t.includes("vacuum")) return 12;
  if (t.includes("mop")) return 15;
  if (t.includes("dust")) return 8;
  if (t.includes("declutter")) return 20;
  if (t.includes("laundry")) return 10;
  if (t.includes("dishes")) return 10;
  if (t.includes("windows")) return 15;

  return 7;
}

function groupTasksByZone(tasks, zones) {
  const zoneNameById = new Map();
  for (const z of zones) {
    const key = String(z?.id || z?.name || "");
    if (key) zoneNameById.set(key, z?.name || key);
  }

  const grouped = new Map(); // zoneKey -> tasks[]
  const put = (zoneKey, task) => {
    const k = zoneKey || "global";
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k).push(task);
  };

  for (const task of tasks) {
    const zoneKey = task.zoneId ? String(task.zoneId) : "global";
    put(zoneKey, task);
  }

  return { grouped, zoneNameById };
}

/* ------------------------------ Draft builder ------------------------------ */

function buildConsolidatedSteps({
  sessionId,
  occurrence,
  zones,
  tasks,
  context,
}) {
  const steps = [];

  const cleanType = occurrence?.meta?.cleanType || "maintenance";
  const supplies = asArray(occurrence?.meta?.supplies).filter(Boolean);
  const equipment = asArray(occurrence?.meta?.equipment).filter(Boolean);

  // Global setup / safety step
  steps.push(
    makeStep({
      id: makeStableStepId(sessionId, "global", 0, "prep"),
      title: "Set up & safety",
      text: "Gather supplies, set timers, open windows if using strong cleaners, and keep kids/pets safe. Clear a staging bin for items that belong elsewhere.",
      kind: "prep",
      timers: [],
      meta: {
        phase: "prep",
        cleanType,
        supplies,
        equipment,
        // forward hooks:
        quietHoursGuard: !!context?.quietHours,
        allergenAware: !!occurrence?.meta?.allergens,
      },
    })
  );

  // If no tasks, fallback to zone-based “standard sweep”
  const hasTasks = Array.isArray(tasks) && tasks.length > 0;

  const { grouped, zoneNameById } = groupTasksByZone(tasks, zones);

  let globalIndex = 0;

  // If zones exist, add zone headers and then tasks
  const zoneKeys =
    zones.length > 0
      ? zones.map((z) => String(z?.id || z?.name)).filter(Boolean)
      : Array.from(grouped.keys());

  // Ensure "global" tasks go first
  const orderedZoneKeys = [
    "global",
    ...zoneKeys.filter((k) => k !== "global"),
  ].filter((k, idx, arr) => arr.indexOf(k) === idx);

  for (const zk of orderedZoneKeys) {
    const zoneName =
      zk === "global" ? "Whole Home" : zoneNameById.get(zk) || zk;

    // Zone header step (optional)
    steps.push(
      makeStep({
        id: makeStableStepId(sessionId, zk, globalIndex++, "zone"),
        title: `Zone: ${zoneName}`,
        text:
          zk === "global"
            ? "Work through the whole-home items first to reduce backtracking."
            : "Focus on this zone top-to-bottom. Do quick wins first, then deeper tasks.",
        kind: "zone",
        zoneId: zk === "global" ? null : zk,
        zoneName,
        timers: [],
        meta: { phase: "zone_start", zone: zoneName },
      })
    );

    const zoneTasks = grouped.get(zk) || [];

    if (!hasTasks && zk !== "global") {
      // Default sweep for a zone if no explicit tasks:
      const defaults = [
        `Declutter surfaces in ${zoneName}`,
        `Dust/wipe surfaces in ${zoneName}`,
        `Vacuum/sweep floors in ${zoneName}`,
        `Spot mop (if needed) in ${zoneName}`,
        `Take out trash from ${zoneName}`,
      ];

      defaults.forEach((txt) => {
        const min = inferTaskMinutes(txt);
        steps.push(
          makeStep({
            id: makeStableStepId(sessionId, zk, globalIndex++, "clean"),
            title: zoneName,
            text: txt,
            kind: "clean",
            zoneId: zk,
            zoneName,
            timers: min ? [{ label: "Timer", ms: minutesToMs(min) }] : [],
            meta: { inferred: true, minutes: min },
          })
        );
      });

      continue;
    }

    // Explicit tasks
    for (let i = 0; i < zoneTasks.length; i += 1) {
      const t = zoneTasks[i];
      const txt = toText(t?.text || t?.title);
      if (!txt) continue;

      const inferredMin = t?.minutes || inferTaskMinutes(txt);
      const timer =
        t?.timer ||
        (inferredMin ? { label: "Timer", ms: minutesToMs(inferredMin) } : null);

      steps.push(
        makeStep({
          id: makeStableStepId(sessionId, zk, globalIndex++, "clean"),
          title: zoneName,
          text: txt,
          kind: t?.kind || "clean",
          zoneId: zk === "global" ? null : zk,
          zoneName,
          timers: timer ? [timer] : [],
          meta: {
            taskId: t?.id || null,
            priority: t?.priority ?? null,
            minutes: inferredMin || null,
            rawMeta: t?.meta || null,
          },
        })
      );
    }
  }

  // Closeout step
  steps.push(
    makeStep({
      id: makeStableStepId(sessionId, "global", globalIndex++, "closeout"),
      title: "Closeout",
      text: "Put supplies away, return items from the staging bin to their homes, refresh the space (air/freshen), and log any supply shortages.",
      kind: "closeout",
      timers: [],
      meta: {
        phase: "closeout",
        // forward hooks:
        supplyShortageDetection: true,
        inventoryLinking: true,
      },
    })
  );

  return steps;
}

/* ------------------------------ Public API ---------------------------------- */

/**
 * buildCleaningSessionDraft(domain, occurrence, context)
 * ---------------------------------------------------------------------------
 * Called by shared acceptPlanApply:
 *   buildSessionDraft(domain, occurrence, context)
 */
export default function buildCleaningSessionDraft(
  domain,
  occurrence,
  context = {}
) {
  if (!domain || typeof domain !== "string") {
    emit("cleaning.session.draft.error", {
      ok: false,
      error: "domain is required",
    });
    return null;
  }
  if (!occurrence || typeof occurrence !== "object") {
    emit("cleaning.session.draft.error", {
      ok: false,
      domain,
      error: "occurrence is required",
    });
    return null;
  }

  const sid = stableSessionId(domain, occurrence);

  const zones = normalizeZonesFromOccurrence(occurrence);
  const tasks = normalizeTasksFromOccurrence(occurrence);

  const steps = buildConsolidatedSteps({
    sessionId: sid,
    occurrence,
    zones,
    tasks,
    context,
  });

  const title = occurrence?.title || "Cleaning session";
  const startAt = occurrence?.startAt || null;
  const endAt = occurrence?.endAt || null;

  const draft = {
    id: sid,
    domain,
    status: "draft",
    title,
    occurrenceId: occurrence?.id || null,
    planId: occurrence?.planId || null,

    startAt,
    endAt,

    steps,

    timers: steps
      .flatMap((s) => asArray(s.timers).map((t) => ({ ...t, stepId: s.id })))
      .filter(Boolean),

    blockers: [],

    createdAt: nowIso(),
    updatedAt: nowIso(),

    meta: {
      adapter: "cleaning",
      source: "buildCleaningSessionDraft",
      cleanType: occurrence?.meta?.cleanType || "maintenance",
      priority: occurrence?.meta?.priority ?? null,
      zones,
      taskCount: tasks.length,
      supplies: asArray(occurrence?.meta?.supplies).filter(Boolean),
      equipment: asArray(occurrence?.meta?.equipment).filter(Boolean),
      constraints:
        occurrence?.meta?.constraints || context?.constraints || null,
      householdRules: occurrence?.meta?.householdRules || null,

      // forward hooks for cross-domain intelligence:
      inventoryLinking: {
        enabled: true,
        // cleaning supplies can tie into storehouse/inventory:
        // suggest | reserve | decrement-on-complete
        mode: context?.inventoryLinkMode || "suggest",
      },
      quietHours: context?.quietHours || null,
      kidsPetsSafety: {
        allergens: occurrence?.meta?.allergens || null,
        pets: occurrence?.meta?.pets || null,
      },
    },
  };

  emit("cleaning.session.draft.built", {
    ok: true,
    domain,
    sessionId: sid,
    occurrenceId: occurrence?.id || null,
    zoneCount: zones.length,
    taskCount: tasks.length,
    stepCount: steps.length,
  });

  if (!tasks.length && !zones.length) {
    emit("cleaning.session.draft.warning", {
      domain,
      sessionId: sid,
      occurrenceId: occurrence?.id || null,
      message:
        "No tasks or zones were found; session uses default whole-home structure.",
    });
  }

  return draft;
}
