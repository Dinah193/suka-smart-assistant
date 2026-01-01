// C:\Users\larho\suka-smart-assistant\src\services\gardening\planning\buildGardenOccurrences.js
/* eslint-disable no-console */

import { normalizeOccurrence } from "@/services/planning/normalizeOccurrence.js";

/**
 * Gardening Planning: buildGardenOccurrences(domain, plan, draft)
 * -----------------------------------------------------------------------------
 * Where this fits in SSA pipeline:
 *   imports → normalize → intelligence (garden plan: sow/plant/weed/harvest/preserve)
 *   → occurrences → accept → sessions/calendar → automation runtime schedules/suggests
 *   → SessionRunner executes → emits events (garden.harvest.logged, garden.task.completed)
 *   → (optional) Hub export handled by accept pipeline.
 *
 * This file is a GARDEN-domain adapter helper used by the shared acceptance
 * pipeline (src/services/planning/acceptPlanApply.js).
 *
 * Responsibilities:
 * - Expand a garden plan into time-bounded occurrences:
 *   • bed/plot routines (weeding, watering, mulching)
 *   • crop-specific tasks (sow, transplant, prune, trellis)
 *   • harvest blocks (with yield estimates)
 *   • seasonal actions (cover crops, frost protection, bed prep)
 * - Be defensive: tolerate partial plan shapes and drafts.
 * - Forward-thinking: supports extension to seed viability imports, lunar/seasonal timing,
 *   and preservation handoffs (freeze/can/dehydrate).
 *
 * Notes:
 * - This file does NOT persist anything and does NOT export to Hub.
 * - IDs are made stable via normalizeOccurrence + ids.js.
 */

const ADAPTER_NAME = "gardening";

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

function buildTitle(plan, slot, plots, crops, tasks) {
  const base =
    slot?.title ||
    slot?.name ||
    slot?.label ||
    plan?.title ||
    plan?.name ||
    plan?.label ||
    "Garden session";

  const plotNames = (plots || [])
    .slice(0, 2)
    .map((p) => p?.name || p?.title || p?.label || p?.id)
    .filter(Boolean);

  const cropNames = (crops || [])
    .slice(0, 3)
    .map((c) => c?.name || c?.crop || c?.label || c?.id)
    .filter(Boolean);

  const taskNames = (tasks || [])
    .slice(0, 2)
    .map((t) => t?.name || t?.title || t?.label || t?.text || t?.type)
    .filter(Boolean);

  const parts = [];
  if (plotNames.length)
    parts.push(plotNames.join(", ") + ((plots || []).length > 2 ? "…" : ""));
  if (cropNames.length)
    parts.push(cropNames.join(", ") + ((crops || []).length > 3 ? "…" : ""));
  if (taskNames.length)
    parts.push(taskNames.join(", ") + ((tasks || []).length > 2 ? "…" : ""));

  if (!parts.length) return base;

  const suffix = parts.join(" — ");
  const baseLower = String(base).toLowerCase();
  const anyContained = plotNames.some((n) =>
    baseLower.includes(String(n).toLowerCase())
  );
  return anyContained ? base : `${base}: ${suffix}`;
}

/**
 * Plots/beds/areas can appear as:
 * - plan.plots / plan.beds / plan.areas
 * - slot.plots / slot.beds / slot.areas
 * - draft.selectedPlots
 */
function collectPlots(plan, draft, slot) {
  const out = [];

  const push = (p) => {
    if (!p) return;
    if (typeof p === "string") out.push({ id: p, name: p });
    else if (isObj(p)) out.push(p);
  };

  asArray(plan?.plots).forEach(push);
  asArray(plan?.beds).forEach(push);
  asArray(plan?.areas).forEach(push);

  asArray(slot?.plots).forEach(push);
  asArray(slot?.beds).forEach(push);
  asArray(slot?.areas).forEach(push);

  asArray(draft?.selectedPlots).forEach(push);

  const seen = new Set();
  const deduped = [];
  for (const p of out) {
    const key = String(p?.id || p?.name || p?.title || "").trim();
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({
      id: p?.id ? String(p.id) : null,
      name: p?.name || p?.title || p?.label || (p?.id ? String(p.id) : null),
      size: p?.size || p?.area || null,
      meta: p?.meta || null,
    });
  }
  return deduped;
}

/**
 * Crops can appear as:
 * - plan.crops / plan.plantings / plan.seedings
 * - slot.crops / slot.plantings
 * - per-plot crops
 * - draft.selectedCrops
 */
function collectCrops(plan, draft, slot, plots) {
  const out = [];

  const push = (c, plotId = null) => {
    if (!c) return;
    if (typeof c === "string") out.push({ id: c, name: c, plotId });
    else if (isObj(c)) out.push({ ...c, plotId: c.plotId ?? plotId });
  };

  asArray(plan?.crops).forEach((c) => push(c, null));
  asArray(plan?.plantings).forEach((c) => push(c, null));
  asArray(plan?.seedings).forEach((c) => push(c, null));

  asArray(slot?.crops).forEach((c) => push(c, null));
  asArray(slot?.plantings).forEach((c) => push(c, null));

  asArray(draft?.selectedCrops).forEach((c) => push(c, null));

  for (const p of plots || []) {
    const pid = p?.id || p?.name || null;
    asArray(p?.crops).forEach((c) => push(c, pid));
    asArray(p?.plantings).forEach((c) => push(c, pid));
  }

  const seen = new Set();
  const deduped = [];
  for (const c of out) {
    const id =
      typeof c === "string"
        ? c
        : c?.id || c?.cropId || c?.name || c?.crop || null;
    const name =
      typeof c === "string"
        ? c
        : c?.name || c?.crop || c?.label || (id ? String(id) : "Crop");
    const plotId = c?.plotId || null;

    const key = `${String(plotId || "")}::${String(id || name || "")}`.trim();
    if (!key || key === "::") continue;
    if (seen.has(key)) continue;
    seen.add(key);

    deduped.push({
      id: id ? String(id) : null,
      name: String(name),
      plotId: plotId ? String(plotId) : null,
      variety: typeof c === "string" ? null : c?.variety || null,
      stage: typeof c === "string" ? null : c?.stage || c?.growthStage || null, // seedling/transplant/fruiting/etc
      meta: typeof c === "string" ? null : c?.meta || null,
    });
  }

  return deduped;
}

/**
 * Tasks can be:
 * - plan.tasks / slot.tasks
 * - plan.checklist / slot.checklist
 * - plan.routines / slot.routines
 * - per-plot/per-crop tasks
 */
function collectTasks(plan, slot, plots, crops) {
  const out = [];

  const push = (t, plotId = null, cropId = null) => {
    if (!t) return;
    if (typeof t === "string") {
      out.push({ text: t, minutes: null, plotId, cropId });
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
        plotId: t.plotId || t.bedId || plotId || null,
        cropId: t.cropId || t.plantingId || cropId || null,
        kind: t.kind || t.type || null, // sow | transplant | weed | water | harvest | prune | mulch | amend | etc.
      });
    }
  };

  asArray(plan?.tasks).forEach((t) => push(t, null, null));
  asArray(plan?.checklist).forEach((t) => push(t, null, null));
  asArray(plan?.routines).forEach((t) => push(t, null, null));

  asArray(slot?.tasks).forEach((t) => push(t, null, null));
  asArray(slot?.checklist).forEach((t) => push(t, null, null));
  asArray(slot?.routines).forEach((t) => push(t, null, null));

  for (const p of plots || []) {
    const pid = p?.id || p?.name || null;
    asArray(p?.tasks).forEach((t) => push(t, pid, null));
    asArray(p?.checklist).forEach((t) => push(t, pid, null));
  }

  for (const c of crops || []) {
    const pid = c?.plotId || null;
    const cid = c?.id || c?.name || null;
    asArray(c?.tasks).forEach((t) => push(t, pid, cid));
    asArray(c?.checklist).forEach((t) => push(t, pid, cid));
  }

  // De-dupe by (plotId + cropId + text/kind/id)
  const seen = new Set();
  const deduped = [];
  for (const t of out) {
    const key = `${String(t?.plotId || "")}::${String(
      t?.cropId || ""
    )}::${String(t?.id || t?.kind || t?.text || "")}`.trim();
    if (!key || key === "::::") continue;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(t);
  }

  return deduped;
}

function estimateDurationMin(plan, slot, tasks, plots, crops, draft) {
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
    : 10;
  const plotMinEach = Number.isFinite(Number(plan?.plotMinEach))
    ? Number(plan.plotMinEach)
    : 8;
  const cropMinEach = Number.isFinite(Number(plan?.cropMinEach))
    ? Number(plan.cropMinEach)
    : 4;

  const est =
    (tasks?.length || 0) * taskMinEach +
    (plots?.length || 0) * plotMinEach +
    (crops?.length || 0) * cropMinEach;

  // Garden work can get long, but keep reasonable bounds for a “session”
  return clamp(Math.round(est || 45), 15, 360);
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

function detectGardenType(plan, slot) {
  // "maintenance" | "planting" | "harvest" | "bed_prep" | "seasonal" | "irrigation" | "pest_control"
  return (
    slot?.gardenType ||
    plan?.gardenType ||
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
 * buildGardenOccurrences(domain, plan, draft)
 * ---------------------------------------------------------------------------
 * Returns occurrences (normalized when possible).
 * The shared acceptance pipeline will still normalize (safe to re-normalize).
 */
export default function buildGardenOccurrences(domain, plan, draft) {
  if (!domain || typeof domain !== "string") {
    console.warn("[buildGardenOccurrences] Missing domain");
    return [];
  }
  if (!plan || typeof plan !== "object") {
    console.warn("[buildGardenOccurrences] Missing plan object");
    return [];
  }

  // Accept precomputed occurrences (from a planner), but enrich.
  const provided = Array.isArray(plan.occurrences) ? plan.occurrences : null;

  // Slot sources if occurrences not provided:
  // - plan.schedule / plan.slots / plan.blocks
  // - plan.routines
  const scheduleSlots = asArray(plan?.schedule).length
    ? asArray(plan?.schedule)
    : asArray(plan?.slots).length
    ? asArray(plan?.slots)
    : asArray(plan?.blocks).length
    ? asArray(plan?.blocks)
    : asArray(plan?.routines).length
    ? asArray(plan?.routines)
    : [];

  const planPlots = collectPlots(plan, draft, null);
  const planCrops = collectCrops(plan, draft, null, planPlots);

  const baseMeta = {
    gardenType: detectGardenType(plan, null),
    priority: detectPriority(plan, null),
    plots: planPlots,
    crops: planCrops,
    supplies: asArray(plan?.supplies).filter(Boolean), // seeds, compost, mulch, fertilizer
    equipment: asArray(plan?.equipment).filter(Boolean), // hoe, rake, drip parts
    location: plan?.location || null, // garden zone/site id
    constraints: plan?.constraints || draft?.constraints || null,
    // forward hooks:
    weatherAware: plan?.weatherAware ?? true,
    seasonality: plan?.seasonality || null,
    lunarTiming: plan?.lunarTiming || null,
    irrigation: plan?.irrigation || null,
    pestPressure: plan?.pestPressure || null,
  };

  if (provided && provided.length) {
    return provided.map((occ) => {
      const plots = collectPlots(plan, draft, occ);
      const crops = collectCrops(plan, draft, occ, plots);
      const tasks = collectTasks(plan, occ, plots, crops);

      const startAt = resolveStartAt(plan, draft, occ);
      const durationMin = estimateDurationMin(
        plan,
        occ,
        tasks,
        plots,
        crops,
        draft
      );
      const endAt =
        isoOrNull(occ?.endAt) ||
        isoOrNull(occ?.end) ||
        (durationMin ? addMsToIso(startAt, minutesToMs(durationMin)) : null);

      const title = buildTitle(plan, occ, plots, crops, tasks);

      const rawOccurrence = {
        startAt,
        endAt,
        title,
        meta: {
          ...baseMeta,
          ...occ?.meta,
          gardenType: detectGardenType(plan, occ),
          priority: detectPriority(plan, occ),
          durationMin,
          plots,
          crops,
          tasks,
          supplies: occ?.supplies || baseMeta.supplies,
          equipment: occ?.equipment || baseMeta.equipment,
          location: occ?.location || baseMeta.location,
          // forward hooks:
          harvest: occ?.harvest || null, // { expectedYield, units, destination }
          preservationHandoff: occ?.preservationHandoff || null,
        },
      };

      try {
        return normalizeOccurrence(domain, plan, rawOccurrence, ADAPTER_NAME);
      } catch {
        return rawOccurrence;
      }
    });
  }

  // Build one occurrence per schedule slot
  if (scheduleSlots.length) {
    const occs = [];

    for (const slot of scheduleSlots) {
      if (!slot) continue;

      const plots = collectPlots(plan, draft, slot);
      const crops = collectCrops(plan, draft, slot, plots);
      const tasks = collectTasks(plan, slot, plots, crops);

      const startAt = resolveStartAt(plan, draft, slot);
      const durationMin = estimateDurationMin(
        plan,
        slot,
        tasks,
        plots,
        crops,
        draft
      );
      const endAt =
        isoOrNull(slot?.endAt) ||
        isoOrNull(slot?.end) ||
        (durationMin ? addMsToIso(startAt, minutesToMs(durationMin)) : null);

      const title = buildTitle(plan, slot, plots, crops, tasks);

      const rawOccurrence = {
        startAt,
        endAt,
        title,
        meta: {
          ...baseMeta,
          ...slot?.meta,
          gardenType: detectGardenType(plan, slot),
          priority: detectPriority(plan, slot),
          durationMin,
          plots,
          crops,
          tasks,
          supplies: slot?.supplies || baseMeta.supplies,
          equipment: slot?.equipment || baseMeta.equipment,
          location: slot?.location || baseMeta.location,
          // forward hooks:
          cadence: slot?.cadence || plan?.cadence || null,
          checklistTemplateId:
            slot?.checklistTemplateId || plan?.checklistTemplateId || null,
          harvest: slot?.harvest || null,
          preservationHandoff:
            slot?.preservationHandoff || plan?.preservationHandoff || null,
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
              title: buildTitle(plan, null, planPlots, planCrops, []),
              meta: {
                ...baseMeta,
                durationMin: 45,
                tasks: collectTasks(plan, null, planPlots, planCrops),
              },
            },
            ADAPTER_NAME
          ),
        ];
  }

  // No schedule slots:
  // If multiple plots and plan.splitByPlot=true (default true), create per-plot occurrences.
  const splitByPlot = plan?.splitByPlot ?? true;
  if (splitByPlot && planPlots.length > 1) {
    const startAtBase = resolveStartAt(plan, draft, null);
    return planPlots.map((p, idx) => {
      const offsetMin = idx * 60; // naive spacing; automation runtime can rebalance later
      const startAt =
        addMsToIso(startAtBase, minutesToMs(offsetMin)) || startAtBase;

      const plots = [p];
      const crops = collectCrops(plan, draft, null, plots);
      const tasks = collectTasks(plan, null, plots, crops);

      const durationMin = estimateDurationMin(
        plan,
        null,
        tasks,
        plots,
        crops,
        draft
      );
      const endAt = durationMin
        ? addMsToIso(startAt, minutesToMs(durationMin))
        : null;

      const rawOccurrence = {
        startAt,
        endAt,
        title: buildTitle(
          plan,
          { title: p?.name || "Plot" },
          plots,
          crops,
          tasks
        ),
        meta: {
          ...baseMeta,
          gardenType: detectGardenType(plan, null),
          durationMin,
          plots,
          crops,
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
  const tasks = collectTasks(plan, null, planPlots, planCrops);
  const durationMin = estimateDurationMin(
    plan,
    null,
    tasks,
    planPlots,
    planCrops,
    draft
  );
  const endAt = durationMin
    ? addMsToIso(startAt, minutesToMs(durationMin))
    : null;

  const fallbackOcc = {
    startAt,
    endAt,
    title: buildTitle(plan, null, planPlots, planCrops, tasks),
    meta: {
      ...baseMeta,
      durationMin,
      plots: planPlots,
      crops: planCrops,
      tasks,
    },
  };

  try {
    return [normalizeOccurrence(domain, plan, fallbackOcc, ADAPTER_NAME)];
  } catch {
    return [fallbackOcc];
  }
}
