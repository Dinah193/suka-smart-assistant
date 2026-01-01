// C:\Users\larho\suka-smart-assistant\src\services\animals\planning\buildAnimalSessionDraft.js
/* eslint-disable no-console */

import eventBus from "@/services/events/eventBus.js";
import { sessionId as stableSessionId } from "@/services/planning/ids.js";

/**
 * Animals Planning: buildAnimalSessionDraft(domain, occurrence, context)
 * -----------------------------------------------------------------------------
 * Where this fits in SSA pipeline:
 *   imports → normalize → intelligence (animal care plan) → occurrences → session drafts
 *   → acceptPlanApply persists sessions/calendar → automation runtime schedules/suggests
 *   → SessionRunner executes → emits events (animal.care.completed, health.logged, etc.)
 *   → (optional) Hub export handled by accept pipeline.
 *
 * This file is an ANIMALS-domain adapter helper used by the shared acceptance
 * pipeline (src/services/planning/acceptPlanApply.js).
 *
 * Responsibilities:
 * - Convert a normalized animal occurrence into a runnable Session Draft.
 * - Consolidate tasks across targets (animal/group/herd) into ONE comprehensive flow.
 * - Attach timers/durations when possible (from tasks or heuristics).
 * - Leave extension points for:
 *   • medication/vaccination logging
 *   • breeding tracking integration
 *   • pasture move + rotation logs
 *   • butchery prep / processing handoffs
 *   • inventory/storehouse linking (feed, minerals, meds)
 *   • biosecurity + quarantine checks
 *
 * Notes:
 * - This file does NOT persist data itself.
 * - It may emit advisory events (draft built, warnings) via eventBus.
 */

const SOURCE = "services/animals/planning/buildAnimalSessionDraft";

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

function makeStep({
  id,
  title,
  text,
  kind,
  timers,
  targetId,
  targetName,
  targetType,
  meta,
}) {
  return {
    id,
    title: title || null,
    text: text || "",
    kind: kind || "care",
    timers: Array.isArray(timers) ? timers.filter(Boolean) : [],
    targetId: targetId || null,
    targetName: targetName || null,
    targetType: targetType || null, // "animal" | "group" | "herd"
    meta: meta || null,
  };
}

function makeStableStepId(sessionId, targetKey, stepIndex, phase = "care") {
  const t = targetKey ? String(targetKey) : "global";
  return `${sessionId}::${t}::${phase}::${stepIndex}`;
}

/* ------------------------------ Normalization ------------------------------ */

function normalizeTargetsFromOccurrence(occurrence) {
  const targets = asArray(occurrence?.meta?.targets).filter(Boolean);

  const out = [];
  const seen = new Set();

  for (const t of targets) {
    const type =
      typeof t === "string"
        ? "animal"
        : t?.type || t?.targetType || (t?.animalIds ? "group" : "animal");
    const id =
      typeof t === "string"
        ? t
        : t?.id || t?.targetId || t?.animalId || t?.groupId || t?.name || null;
    const name =
      typeof t === "string"
        ? t
        : t?.name ||
          t?.label ||
          t?.tag ||
          t?.title ||
          (id ? String(id) : "Target");

    const key = `${String(type)}::${String(id || name || "")}`.trim();
    if (!key || key.endsWith("::")) continue;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      id: id ? String(id) : null,
      name: String(name),
      type,
      species:
        typeof t === "string" ? null : t?.species || t?.animalType || null,
      animalIds: Array.isArray(t?.animalIds) ? t.animalIds.map(String) : null,
      meta: typeof t === "string" ? null : t?.meta || null,
    });
  }

  return out;
}

function normalizeTasksFromOccurrence(occurrence) {
  const tasks = asArray(occurrence?.meta?.tasks).filter(Boolean);

  const out = [];
  for (const t of tasks) {
    if (typeof t === "string") {
      out.push({
        id: null,
        text: t,
        minutes: null,
        timer: null,
        targetId: null,
        kind: null,
        priority: null,
        meta: null,
      });
      continue;
    }

    if (isObj(t)) {
      const text = toText(
        t.text || t.title || t.name || t.label || t.type || t.instruction
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
        targetId: t.targetId || t.animalId || t.groupId || t.target || null,
        kind: t.kind || t.type || null, // feed | water | check | meds | vaccinate | pasture_move | trim | etc.
        priority: t.priority ?? null,
        meta: t.meta || null,
      });
    }
  }

  return out;
}

/**
 * If tasks have no durations, infer rough durations from keywords.
 * (Extension point: replace with learned durations per household.)
 */
function inferTaskMinutes(text) {
  const s = String(text || "").toLowerCase();
  if (!s) return null;

  if (s.includes("feed")) return 12;
  if (s.includes("water")) return 8;
  if (s.includes("check") || s.includes("inspect") || s.includes("health"))
    return 10;
  if (s.includes("clean stall") || s.includes("muck")) return 25;
  if (s.includes("hoof") || s.includes("trim")) return 20;
  if (
    s.includes("med") ||
    s.includes("vaccine") ||
    s.includes("shot") ||
    s.includes("dose")
  )
    return 15;
  if (s.includes("pasture") || s.includes("move fence") || s.includes("rotate"))
    return 30;
  if (s.includes("weigh") || s.includes("tag")) return 10;
  if (s.includes("breeding") || s.includes("heat") || s.includes("pair"))
    return 15;
  if (
    s.includes("butchery") ||
    s.includes("slaughter") ||
    s.includes("processing")
  )
    return 60;

  return 10;
}

function groupTasksByTarget(tasks, targets) {
  const targetNameById = new Map();
  for (const t of targets) {
    const key = String(t?.id || t?.name || "");
    if (key) targetNameById.set(key, t?.name || key);
  }

  const grouped = new Map(); // targetKey -> tasks[]
  const put = (targetKey, task) => {
    const k = targetKey || "global";
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k).push(task);
  };

  for (const task of tasks) {
    const targetKey = task.targetId ? String(task.targetId) : "global";
    put(targetKey, task);
  }

  return { grouped, targetNameById };
}

/* ------------------------------ Step builder ------------------------------ */

function buildConsolidatedSteps({
  sessionId,
  occurrence,
  targets,
  tasks,
  context,
}) {
  const steps = [];

  const careType = occurrence?.meta?.careType || "daily";
  const supplies = asArray(occurrence?.meta?.supplies).filter(Boolean);
  const equipment = asArray(occurrence?.meta?.equipment).filter(Boolean);
  const location = occurrence?.meta?.location || null;

  // Global biosecurity/setup step
  steps.push(
    makeStep({
      id: makeStableStepId(sessionId, "global", 0, "prep"),
      title: "Set up & biosecurity",
      text: "Gather supplies/equipment, review targets, and follow biosecurity steps (hand wash, boot dip, quarantine rules) before entering animal areas.",
      kind: "prep",
      timers: [],
      meta: {
        phase: "prep",
        careType,
        location,
        supplies,
        equipment,
        biosecurity: occurrence?.meta?.biosecurity || null,
        // forward hooks:
        weatherAware: occurrence?.meta?.weatherAware ?? true,
        seasonality: occurrence?.meta?.seasonality || null,
      },
    })
  );

  const hasTasks = Array.isArray(tasks) && tasks.length > 0;

  const { grouped, targetNameById } = groupTasksByTarget(tasks, targets);

  // Determine order:
  // - global tasks first
  // - then each target in provided order (if any)
  const targetKeys =
    targets.length > 0
      ? targets.map((t) => String(t?.id || t?.name)).filter(Boolean)
      : Array.from(grouped.keys());

  const orderedTargetKeys = [
    "global",
    ...targetKeys.filter((k) => k !== "global"),
  ].filter((k, idx, arr) => arr.indexOf(k) === idx);

  let globalIndex = 0;

  for (const tk of orderedTargetKeys) {
    const isGlobal = tk === "global";
    const target = isGlobal
      ? null
      : targets.find((t) => String(t?.id || t?.name) === tk) || null;

    const targetName = isGlobal
      ? "All Targets"
      : target?.name || targetNameById.get(tk) || tk;
    const targetType = isGlobal ? null : target?.type || null;

    // Target header
    steps.push(
      makeStep({
        id: makeStableStepId(sessionId, tk, globalIndex++, "target"),
        title: isGlobal ? "Whole-workflow tasks" : `Target: ${targetName}`,
        text: isGlobal
          ? "Do shared tasks first to reduce backtracking (fill buckets, stage feed, prep meds)."
          : "Work calmly and safely. Observe behavior, posture, and appetite before handling.",
        kind: "target",
        targetId: isGlobal ? null : target?.id || tk,
        targetName,
        targetType,
        timers: [],
        meta: {
          phase: "target_start",
          species: target?.species || null,
          animalIds: target?.animalIds || null,
        },
      })
    );

    const tTasks = grouped.get(tk) || [];

    // If no tasks, provide default daily care pattern (especially useful for quick-start)
    if (!hasTasks && !isGlobal) {
      const defaults = [
        `Check water for ${targetName}`,
        `Feed ${targetName}`,
        `Quick health check for ${targetName} (eyes, nose, coat, gait)`,
        `Check fencing/shelter for ${targetName}`,
        `Log observations for ${targetName}`,
      ];

      defaults.forEach((txt) => {
        const min = inferTaskMinutes(txt);
        steps.push(
          makeStep({
            id: makeStableStepId(sessionId, tk, globalIndex++, "care"),
            title: targetName,
            text: txt,
            kind: "care",
            targetId: target?.id || tk,
            targetName,
            targetType,
            timers: min ? [{ label: "Timer", ms: minutesToMs(min) }] : [],
            meta: { inferred: true, minutes: min, careType: "daily" },
          })
        );
      });

      continue;
    }

    // Explicit tasks
    for (let i = 0; i < tTasks.length; i += 1) {
      const t = tTasks[i];
      const txt = toText(t?.text || t?.title);
      if (!txt) continue;

      const inferredMin = t?.minutes || inferTaskMinutes(txt);
      const timer =
        t?.timer ||
        (inferredMin ? { label: "Timer", ms: minutesToMs(inferredMin) } : null);

      // Special note for meds/vaccines (forward hook: structured logging UI)
      const isMeds =
        String(t?.kind || "")
          .toLowerCase()
          .includes("med") ||
        txt.toLowerCase().includes("vaccine") ||
        txt.toLowerCase().includes("dose");

      steps.push(
        makeStep({
          id: makeStableStepId(sessionId, tk, globalIndex++, "care"),
          title: targetName,
          text: txt,
          kind: t?.kind || "care",
          targetId: isGlobal ? null : target?.id || tk,
          targetName,
          targetType,
          timers: timer ? [timer] : [],
          meta: {
            taskId: t?.id || null,
            priority: t?.priority ?? null,
            minutes: inferredMin || null,
            isMedication: isMeds,
            rawMeta: t?.meta || null,
          },
        })
      );
    }
  }

  // Closeout step: logs, restock, alerts
  steps.push(
    makeStep({
      id: makeStableStepId(sessionId, "global", globalIndex++, "closeout"),
      title: "Closeout & log",
      text: "Log observations (health, behavior, intake), restock supplies, sanitize tools, and note any shortages (feed/minerals/meds).",
      kind: "closeout",
      timers: [],
      meta: {
        phase: "closeout",
        // forward hooks:
        inventoryLinking: true,
        healthLogging: true,
        breedingLogging: careType === "breeding",
        pastureMoveLogging: careType === "pasture",
        butcheryHandoff: occurrence?.meta?.butchery || null,
      },
    })
  );

  return steps;
}

/* ------------------------------ Public API ---------------------------------- */

/**
 * buildAnimalSessionDraft(domain, occurrence, context)
 * ---------------------------------------------------------------------------
 * Called by shared acceptPlanApply:
 *   buildSessionDraft(domain, occurrence, context)
 */
export default function buildAnimalSessionDraft(
  domain,
  occurrence,
  context = {}
) {
  if (!domain || typeof domain !== "string") {
    emit("animals.session.draft.error", {
      ok: false,
      error: "domain is required",
    });
    return null;
  }
  if (!occurrence || typeof occurrence !== "object") {
    emit("animals.session.draft.error", {
      ok: false,
      domain,
      error: "occurrence is required",
    });
    return null;
  }

  const sid = stableSessionId(domain, occurrence);

  const targets = normalizeTargetsFromOccurrence(occurrence);
  const tasks = normalizeTasksFromOccurrence(occurrence);

  const steps = buildConsolidatedSteps({
    sessionId: sid,
    occurrence,
    targets,
    tasks,
    context,
  });

  const title = occurrence?.title || "Animal care session";
  const startAt = occurrence?.startAt || null;
  const endAt = occurrence?.endAt || null;

  const supplies = asArray(occurrence?.meta?.supplies).filter(Boolean);
  const equipment = asArray(occurrence?.meta?.equipment).filter(Boolean);

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
      adapter: "animals",
      source: "buildAnimalSessionDraft",
      careType: occurrence?.meta?.careType || "daily",
      priority: occurrence?.meta?.priority ?? null,
      targets,
      taskCount: tasks.length,
      supplies,
      equipment,
      location: occurrence?.meta?.location || null,
      constraints:
        occurrence?.meta?.constraints || context?.constraints || null,
      biosecurity: occurrence?.meta?.biosecurity || null,
      weatherAware: occurrence?.meta?.weatherAware ?? true,
      seasonality: occurrence?.meta?.seasonality || null,

      // forward hooks for cross-domain intelligence:
      inventoryLinking: {
        enabled: true,
        // feed/minerals/meds can tie into storehouse/inventory:
        // suggest | reserve | decrement-on-complete
        mode: context?.inventoryLinkMode || "suggest",
      },
      healthLogging: {
        enabled: true,
        // connect later to AnimalProfiles/Health module:
        // e.g. context.healthRepo.log(...)
      },
      breedingLogging: {
        enabled: true,
        // connect later to BreedingTracker:
        // e.g. heat checks, pairing, pregnancy checks
      },
      butcheryHandoff: {
        enabled: true,
        details: occurrence?.meta?.butchery || null,
      },
    },
  };

  emit("animals.session.draft.built", {
    ok: true,
    domain,
    sessionId: sid,
    occurrenceId: occurrence?.id || null,
    targetCount: targets.length,
    taskCount: tasks.length,
    stepCount: steps.length,
  });

  if (!tasks.length && !targets.length) {
    emit("animals.session.draft.warning", {
      domain,
      sessionId: sid,
      occurrenceId: occurrence?.id || null,
      message:
        "No targets or tasks were found; session uses a generic workflow.",
    });
  }

  return draft;
}
