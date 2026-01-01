// C:\Users\larho\suka-smart-assistant\src\services\animals\planning\buildAnimalOccurrences.js
/* eslint-disable no-console */

import { normalizeOccurrence } from "@/services/planning/normalizeOccurrence.js";

/**
 * Animals Planning: buildAnimalOccurrences(domain, plan, draft)
 * -----------------------------------------------------------------------------
 * Where this fits in SSA pipeline:
 *   imports → normalize → intelligence (animal care plan) → occurrences → accept → sessions/calendar
 *   → automation runtime schedules/suggests → SessionRunner executes → emits events
 *   → (optional) Hub export handled by accept pipeline.
 *
 * This file is an ANIMALS-domain adapter helper used by the shared acceptance
 * pipeline (src/services/planning/acceptPlanApply.js).
 *
 * Responsibilities:
 * - Expand an animal care plan into time-bounded occurrences (one per care block,
 *   per herd/group, per animal, or per scheduled routine).
 * - Be defensive: tolerate partial plan shapes and drafts.
 * - Forward-thinking: supports new animal workflows:
 *   • daily care (feed/water/check)
 *   • health (meds, vaccines, hoof trim, parasite control)
 *   • breeding (heat checks, pairing, pregnancy checks)
 *   • butchery (pre-slaughter prep, processing blocks)
 *   • seasonal/rotational (pasture moves, shelter winterization)
 *
 * Notes:
 * - This file does NOT persist anything and does NOT export to Hub.
 * - IDs are made stable via normalizeOccurrence + ids.js.
 */

const ADAPTER_NAME = "animals";

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

function buildTitle(plan, slot, targets, tasks) {
  const base =
    slot?.title ||
    slot?.name ||
    slot?.label ||
    plan?.title ||
    plan?.name ||
    plan?.label ||
    "Animal care session";

  const targetNames = (targets || [])
    .slice(0, 3)
    .map((t) => t?.name || t?.label || t?.tag || t?.id)
    .filter(Boolean);

  const taskNames = (tasks || [])
    .slice(0, 2)
    .map((t) => t?.name || t?.title || t?.label || t?.text || t?.type)
    .filter(Boolean);

  const suffixParts = [];
  if (targetNames.length)
    suffixParts.push(
      targetNames.join(", ") + ((targets || []).length > 3 ? "…" : "")
    );
  if (taskNames.length)
    suffixParts.push(
      taskNames.join(", ") + ((tasks || []).length > 2 ? "…" : "")
    );

  if (!suffixParts.length) return base;

  const suffix = suffixParts.join(" — ");
  const baseLower = String(base).toLowerCase();
  const anyContained = targetNames.some((n) =>
    baseLower.includes(String(n).toLowerCase())
  );
  return anyContained ? base : `${base}: ${suffix}`;
}

/**
 * Targets can be:
 * - animals: [{id,name,species,...}]
 * - herd/groups: [{id,name,animalIds,...}]
 * - plan.targets: [{type:"animal"|"group"|"herd", ...}]
 * - draft.selectedAnimals / draft.selectedGroups
 * - slot.targets / slot.animals / slot.groups
 */
function collectTargets(plan, draft, slot) {
  const out = [];

  const push = (t, typeHint = null) => {
    if (!t) return;

    if (typeof t === "string") {
      out.push({ id: t, name: t, type: typeHint || "animal" });
      return;
    }

    if (isObj(t)) {
      const type =
        t.type ||
        t.targetType ||
        typeHint ||
        (t.animalIds ? "group" : "animal");
      out.push({ ...t, type });
    }
  };

  // plan-level
  asArray(plan?.targets).forEach((t) => push(t, null));
  asArray(plan?.animals).forEach((t) => push(t, "animal"));
  asArray(plan?.groups).forEach((t) => push(t, "group"));
  asArray(plan?.herds).forEach((t) => push(t, "herd"));

  // slot-level
  asArray(slot?.targets).forEach((t) => push(t, null));
  asArray(slot?.animals).forEach((t) => push(t, "animal"));
  asArray(slot?.groups).forEach((t) => push(t, "group"));
  asArray(slot?.herds).forEach((t) => push(t, "herd"));

  // draft-level
  asArray(draft?.selectedAnimals).forEach((t) => push(t, "animal"));
  asArray(draft?.selectedGroups).forEach((t) => push(t, "group"));
  asArray(draft?.selectedHerds).forEach((t) => push(t, "herd"));

  // De-dupe by (type + id/name)
  const seen = new Set();
  const deduped = [];
  for (const t of out) {
    const key = `${String(t?.type || "")}::${String(
      t?.id || t?.name || t?.label || ""
    )}`.trim();
    if (!key || key === "::") continue;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({
      id: t?.id ? String(t.id) : null,
      name: t?.name || t?.label || t?.tag || (t?.id ? String(t.id) : null),
      type: t?.type || "animal",
      species: t?.species || t?.animalType || null,
      animalIds: Array.isArray(t?.animalIds) ? t.animalIds.map(String) : null,
      meta: t?.meta || null,
    });
  }

  return deduped;
}

/**
 * Tasks can be:
 * - plan.tasks / slot.tasks
 * - plan.routines / slot.routines
 * - plan.checklist / slot.checklist
 * Supports:
 * - string (treated as text)
 * - { type/name/title, minutes, targetId/zoneId/etc }
 */
function collectTasks(plan, slot, targets) {
  const out = [];

  const push = (t, targetHint = null) => {
    if (!t) return;
    if (typeof t === "string") {
      out.push({ text: t, minutes: null, targetId: targetHint });
      return;
    }
    if (isObj(t)) {
      out.push({
        ...t,
        text: t.text || t.title || t.name || t.label || t.type || "",
        minutes:
          Number.isFinite(Number(t.minutes)) && Number(t.minutes) > 0
            ? Math.round(Number(t.minutes))
            : null,
        targetId: t.targetId || t.animalId || t.groupId || targetHint || null,
        kind: t.kind || t.type || null,
      });
    }
  };

  asArray(plan?.tasks).forEach((t) => push(t, null));
  asArray(plan?.routines).forEach((t) => push(t, null));
  asArray(plan?.checklist).forEach((t) => push(t, null));

  asArray(slot?.tasks).forEach((t) => push(t, null));
  asArray(slot?.routines).forEach((t) => push(t, null));
  asArray(slot?.checklist).forEach((t) => push(t, null));

  // Per-target tasks (if present)
  for (const trg of targets || []) {
    asArray(trg?.tasks).forEach((t) => push(t, trg.id || trg.name || null));
    asArray(trg?.checklist).forEach((t) => push(t, trg.id || trg.name || null));
  }

  // De-dupe by (targetId + text/kind/id)
  const seen = new Set();
  const deduped = [];
  for (const t of out) {
    const key = `${String(t?.targetId || "")}::${String(
      t?.id || t?.kind || t?.text || ""
    )}`.trim();
    if (!key || key === "::") continue;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(t);
  }

  return deduped;
}

/**
 * Estimate duration:
 * - prefer explicit durationMin on slot/plan
 * - else derive from task count and target count
 */
function estimateDurationMin(plan, slot, tasks, targets, draft) {
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
    : 8;
  const targetMinEach = Number.isFinite(Number(plan?.targetMinEach))
    ? Number(plan.targetMinEach)
    : 5;

  const est =
    (tasks?.length || 0) * taskMinEach + (targets?.length || 0) * targetMinEach;

  // Animal care can vary widely; keep sane bounds
  return clamp(Math.round(est || 40), 15, 300);
}

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

function detectCareType(plan, slot) {
  // "daily" | "health" | "breeding" | "pasture" | "butchery" | "seasonal" | "training"
  return (
    slot?.careType || plan?.careType || slot?.type || plan?.type || "daily"
  );
}

function detectPriority(plan, slot) {
  return slot?.priority ?? plan?.priority ?? null;
}

/* ------------------------------ Main function ------------------------------ */

/**
 * buildAnimalOccurrences(domain, plan, draft)
 * ---------------------------------------------------------------------------
 * Returns occurrences (normalized when possible).
 * The shared acceptance pipeline will still normalize (safe to re-normalize).
 */
export default function buildAnimalOccurrences(domain, plan, draft) {
  if (!domain || typeof domain !== "string") {
    console.warn("[buildAnimalOccurrences] Missing domain");
    return [];
  }
  if (!plan || typeof plan !== "object") {
    console.warn("[buildAnimalOccurrences] Missing plan object");
    return [];
  }

  // Accept precomputed occurrences if provided
  const provided = Array.isArray(plan.occurrences) ? plan.occurrences : null;

  // Slot sources if occurrences not provided:
  // - plan.schedule / plan.slots / plan.blocks
  // - plan.routines (each routine becomes an occurrence)
  // - plan.targets (split into per-target occurrences if desired)
  const scheduleSlots = asArray(plan?.schedule).length
    ? asArray(plan?.schedule)
    : asArray(plan?.slots).length
    ? asArray(plan?.slots)
    : asArray(plan?.blocks).length
    ? asArray(plan?.blocks)
    : asArray(plan?.routines).length
    ? asArray(plan?.routines)
    : [];

  const planTargets = collectTargets(plan, draft, null);

  const baseMeta = {
    careType: detectCareType(plan, null),
    priority: detectPriority(plan, null),
    targets: planTargets,
    supplies: asArray(plan?.supplies).filter(Boolean), // feed, minerals, meds, etc.
    equipment: asArray(plan?.equipment).filter(Boolean), // halter, syringes, hoof trimmers, etc.
    location: plan?.location || null, // barn/pasture ID
    constraints: plan?.constraints || draft?.constraints || null,
    // forward hooks:
    biosecurity: plan?.biosecurity || null,
    weatherAware: plan?.weatherAware ?? true,
    seasonality: plan?.seasonality || null,
  };

  if (provided && provided.length) {
    return provided.map((occ) => {
      const targets = collectTargets(plan, draft, occ);
      const tasks = collectTasks(plan, occ, targets);

      const startAt = resolveStartAt(plan, draft, occ);
      const durationMin = estimateDurationMin(plan, occ, tasks, targets, draft);
      const endAt =
        isoOrNull(occ?.endAt) ||
        isoOrNull(occ?.end) ||
        (durationMin ? addMsToIso(startAt, minutesToMs(durationMin)) : null);

      const title = buildTitle(plan, occ, targets, tasks);

      const rawOccurrence = {
        startAt,
        endAt,
        title,
        meta: {
          ...baseMeta,
          ...occ?.meta,
          careType: detectCareType(plan, occ),
          priority: detectPriority(plan, occ),
          durationMin,
          targets,
          tasks,
          supplies: occ?.supplies || baseMeta.supplies,
          equipment: occ?.equipment || baseMeta.equipment,
          location: occ?.location || baseMeta.location,
          // forward hooks:
          meds: occ?.meds || null,
          observations: occ?.observations || null,
          pastureMove: occ?.pastureMove || null,
          butchery: occ?.butchery || null,
        },
      };

      try {
        return normalizeOccurrence(domain, plan, rawOccurrence, ADAPTER_NAME);
      } catch {
        return rawOccurrence;
      }
    });
  }

  // Build from schedule slots
  if (scheduleSlots.length) {
    const occs = [];

    for (const slot of scheduleSlots) {
      if (!slot) continue;

      const targets = collectTargets(plan, draft, slot);
      const tasks = collectTasks(plan, slot, targets);

      const startAt = resolveStartAt(plan, draft, slot);
      const durationMin = estimateDurationMin(
        plan,
        slot,
        tasks,
        targets,
        draft
      );
      const endAt =
        isoOrNull(slot?.endAt) ||
        isoOrNull(slot?.end) ||
        (durationMin ? addMsToIso(startAt, minutesToMs(durationMin)) : null);

      const title = buildTitle(plan, slot, targets, tasks);

      const rawOccurrence = {
        startAt,
        endAt,
        title,
        meta: {
          ...baseMeta,
          ...slot?.meta,
          careType: detectCareType(plan, slot),
          priority: detectPriority(plan, slot),
          durationMin,
          targets,
          tasks,
          supplies: slot?.supplies || baseMeta.supplies,
          equipment: slot?.equipment || baseMeta.equipment,
          location: slot?.location || baseMeta.location,
          // forward hooks:
          cadence: slot?.cadence || plan?.cadence || null, // daily/weekly/monthly/etc
          checklistTemplateId:
            slot?.checklistTemplateId || plan?.checklistTemplateId || null,
          healthWindow: slot?.healthWindow || null,
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
          normalizeOccurrence(
            domain,
            plan,
            {
              startAt: resolveStartAt(plan, draft, null),
              endAt: null,
              title: buildTitle(plan, null, planTargets, []),
              meta: {
                ...baseMeta,
                durationMin: 40,
                tasks: collectTasks(plan, null, planTargets),
              },
            },
            ADAPTER_NAME
          ),
        ];
  }

  // No schedule slots:
  // If multiple targets and plan.splitByTarget=true, create per-target occurrences.
  const splitByTarget = plan?.splitByTarget ?? true; // default true because animal work is often per animal/group
  if (splitByTarget && planTargets.length > 1) {
    const startAtBase = resolveStartAt(plan, draft, null);
    return planTargets.map((t, idx) => {
      const offsetMin = idx * 45; // naive spacing; automation runtime can rebalance later
      const startAt =
        addMsToIso(startAtBase, minutesToMs(offsetMin)) || startAtBase;

      const targets = [t];
      const tasks = collectTasks(plan, null, targets);

      const durationMin = estimateDurationMin(
        plan,
        null,
        tasks,
        targets,
        draft
      );
      const endAt = durationMin
        ? addMsToIso(startAt, minutesToMs(durationMin))
        : null;

      const rawOccurrence = {
        startAt,
        endAt,
        title: buildTitle(plan, { title: t?.name || "Target" }, targets, tasks),
        meta: {
          ...baseMeta,
          careType: detectCareType(plan, null),
          durationMin,
          targets,
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
  const targets = planTargets;
  const tasks = collectTasks(plan, null, targets);
  const durationMin = estimateDurationMin(plan, null, tasks, targets, draft);
  const endAt = durationMin
    ? addMsToIso(startAt, minutesToMs(durationMin))
    : null;

  const fallbackOcc = {
    startAt,
    endAt,
    title: buildTitle(plan, null, targets, tasks),
    meta: {
      ...baseMeta,
      durationMin,
      targets,
      tasks,
    },
  };

  try {
    return [normalizeOccurrence(domain, plan, fallbackOcc, ADAPTER_NAME)];
  } catch {
    return [fallbackOcc];
  }
}
