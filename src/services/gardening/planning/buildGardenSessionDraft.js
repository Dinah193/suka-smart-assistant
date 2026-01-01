// C:\Users\larho\suka-smart-assistant\src\services\gardening\planning\buildGardenSessionDraft.js
/* eslint-disable no-console */

import eventBus from "@/services/events/eventBus.js";
import { sessionId as stableSessionId } from "@/services/planning/ids.js";

/**
 * Gardening Planning: buildGardenSessionDraft(domain, occurrence, context)
 * -----------------------------------------------------------------------------
 * Where this fits in SSA pipeline:
 *   imports → normalize → intelligence (garden plan) → occurrences → session drafts
 *   → acceptPlanApply persists sessions/calendar → automation runtime schedules/suggests
 *   → SessionRunner executes → emits events (garden.harvest.logged, garden.task.completed)
 *   → (optional) Hub export handled by accept pipeline.
 *
 * This file is a GARDEN-domain adapter helper used by the shared acceptance
 * pipeline (src/services/planning/acceptPlanApply.js).
 *
 * Responsibilities:
 * - Convert a normalized garden occurrence into a runnable Session Draft.
 * - Consolidate tasks across plots/beds/crops into ONE comprehensive flow.
 * - Attach timers/durations where possible (from tasks or heuristics).
 * - Leave extension points for:
 *   • seed/planting logs (planting dates, varieties, germination rate)
 *   • irrigation actions + moisture checks
 *   • harvest yield logging + destination (kitchen/preservation/storehouse)
 *   • pest/disease observations + treatments
 *   • weather/seasonality guards + rescheduling hints
 *   • preservation handoff creation (freeze/can/dehydrate sessions)
 *
 * Notes:
 * - This file does NOT persist data itself.
 * - It may emit advisory events (draft built, warnings) via eventBus.
 */

const SOURCE = "services/gardening/planning/buildGardenSessionDraft";

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
  plotId,
  plotName,
  cropId,
  cropName,
  meta,
}) {
  return {
    id,
    title: title || null,
    text: text || "",
    kind: kind || "garden",
    timers: Array.isArray(timers) ? timers.filter(Boolean) : [],
    plotId: plotId || null,
    plotName: plotName || null,
    cropId: cropId || null,
    cropName: cropName || null,
    meta: meta || null,
  };
}

function makeStableStepId(sessionId, scopeKey, stepIndex, phase = "garden") {
  const k = scopeKey ? String(scopeKey) : "global";
  return `${sessionId}::${k}::${phase}::${stepIndex}`;
}

/* ------------------------------ Normalization ------------------------------ */

function normalizePlotsFromOccurrence(occurrence) {
  const plots = asArray(occurrence?.meta?.plots).filter(Boolean);

  const out = [];
  const seen = new Set();

  for (const p of plots) {
    const id =
      typeof p === "string"
        ? p
        : p?.id || p?.plotId || p?.bedId || p?.name || null;
    const name =
      typeof p === "string"
        ? p
        : p?.name || p?.title || p?.label || (id ? String(id) : "Plot");
    const key = String(id || name || "").trim();
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      id: id ? String(id) : null,
      name: String(name),
      size: typeof p === "string" ? null : p?.size || p?.area || null,
      meta: typeof p === "string" ? null : p?.meta || null,
    });
  }

  return out;
}

function normalizeCropsFromOccurrence(occurrence) {
  const crops = asArray(occurrence?.meta?.crops).filter(Boolean);

  const out = [];
  const seen = new Set();

  for (const c of crops) {
    const id =
      typeof c === "string"
        ? c
        : c?.id || c?.cropId || c?.plantingId || c?.name || c?.crop || null;
    const name =
      typeof c === "string"
        ? c
        : c?.name || c?.crop || c?.label || (id ? String(id) : "Crop");
    const plotId = typeof c === "string" ? null : c?.plotId || c?.bedId || null;

    const key = `${String(plotId || "")}::${String(id || name || "")}`.trim();
    if (!key || key === "::") continue;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      id: id ? String(id) : null,
      name: String(name),
      plotId: plotId ? String(plotId) : null,
      variety: typeof c === "string" ? null : c?.variety || null,
      stage: typeof c === "string" ? null : c?.stage || c?.growthStage || null,
      meta: typeof c === "string" ? null : c?.meta || null,
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
        plotId: null,
        cropId: null,
        kind: null,
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
        plotId: t.plotId || t.bedId || null,
        cropId: t.cropId || t.plantingId || null,
        kind: t.kind || t.type || null, // sow | transplant | weed | water | harvest | prune | amend | mulch | etc.
        meta: t.meta || null,
      });
    }
  }

  return out;
}

/**
 * Heuristic durations by keyword.
 * (Extension point: household-specific learned durations per plot/crop.)
 */
function inferTaskMinutes(text, kind) {
  const k = String(kind || "").toLowerCase();
  const s = String(text || "").toLowerCase();

  if (k.includes("harvest") || s.includes("harvest")) return 30;
  if (k.includes("water") || s.includes("water") || s.includes("irrig"))
    return 15;
  if (k.includes("weed") || s.includes("weed")) return 25;
  if (k.includes("mulch") || s.includes("mulch")) return 25;
  if (k.includes("amend") || s.includes("compost") || s.includes("fertil"))
    return 30;
  if (k.includes("sow") || s.includes("sow") || s.includes("seed")) return 20;
  if (k.includes("transplant") || s.includes("transplant")) return 30;
  if (k.includes("prune") || s.includes("prune")) return 20;
  if (k.includes("trellis") || s.includes("trellis") || s.includes("stake"))
    return 25;
  if (k.includes("pest") || s.includes("pest") || s.includes("spray"))
    return 20;

  return 15;
}

function indexPlotsById(plots) {
  const map = new Map();
  for (const p of plots || []) {
    const key = String(p?.id || p?.name || "");
    if (key) map.set(key, p);
  }
  return map;
}

function indexCropsById(crops) {
  const map = new Map();
  for (const c of crops || []) {
    const key = String(c?.id || c?.name || "");
    if (key) map.set(key, c);
  }
  return map;
}

/**
 * Group tasks in a “garden-friendly” order:
 * - global tasks first
 * - then per-plot (if plotId)
 * - then per-crop (if cropId) inside plot
 *
 * This keeps the session “flow” cohesive and reduces backtracking.
 */
function groupTasks(tasks, plots, crops) {
  const plotMap = indexPlotsById(plots);
  const cropMap = indexCropsById(crops);

  const groups = new Map(); // key -> { plotId, cropId, label, tasks[] }

  const keyFor = (plotId, cropId) =>
    `${String(plotId || "global")}::${String(cropId || "")}`;

  const ensure = (plotId, cropId) => {
    const key = keyFor(plotId, cropId);
    if (!groups.has(key)) {
      const plot = plotId ? plotMap.get(String(plotId)) : null;
      const crop = cropId ? cropMap.get(String(cropId)) : null;
      const labelParts = [];
      if (plot) labelParts.push(plot.name || plot.id);
      if (crop) labelParts.push(crop.name || crop.id);
      const label = labelParts.length ? labelParts.join(" — ") : "Whole Garden";
      groups.set(key, {
        plotId: plotId || null,
        cropId: cropId || null,
        label,
        tasks: [],
      });
    }
    return groups.get(key);
  };

  for (const t of tasks || []) {
    const g = ensure(t.plotId, t.cropId);
    g.tasks.push(t);
  }

  // Determine order: global group first, then plots in provided order, then crop groups within plot
  const orderedKeys = [];

  // global tasks
  if (groups.has(keyFor(null, null))) orderedKeys.push(keyFor(null, null));
  if (groups.has(keyFor("global", ""))) orderedKeys.push(keyFor("global", "")); // just in case

  // plot groups
  for (const p of plots || []) {
    const pid = p?.id || p?.name;
    if (!pid) continue;

    // plot-level tasks (no crop)
    const pk = keyFor(pid, null);
    if (groups.has(pk)) orderedKeys.push(pk);

    // crop-level tasks within plot
    for (const c of crops || []) {
      if (String(c?.plotId || "") !== String(pid)) continue;
      const cid = c?.id || c?.name;
      if (!cid) continue;
      const ck = keyFor(pid, cid);
      if (groups.has(ck)) orderedKeys.push(ck);
    }
  }

  // any remaining keys not covered (fallback)
  for (const k of groups.keys()) {
    if (!orderedKeys.includes(k)) orderedKeys.push(k);
  }

  return { groups, orderedKeys, plotMap, cropMap };
}

/* ------------------------------ Step builder ------------------------------ */

function buildConsolidatedSteps({
  sessionId,
  occurrence,
  plots,
  crops,
  tasks,
  context,
}) {
  const steps = [];

  const gardenType = occurrence?.meta?.gardenType || "maintenance";
  const supplies = asArray(occurrence?.meta?.supplies).filter(Boolean);
  const equipment = asArray(occurrence?.meta?.equipment).filter(Boolean);
  const location = occurrence?.meta?.location || null;

  // Setup step
  steps.push(
    makeStep({
      id: makeStableStepId(sessionId, "global", 0, "prep"),
      title: "Set up",
      text: "Gather tools and supplies, check the weather window, and review your plan. Stage a harvest bin if harvesting.",
      kind: "prep",
      timers: [],
      meta: {
        phase: "prep",
        gardenType,
        location,
        supplies,
        equipment,
        weatherAware: occurrence?.meta?.weatherAware ?? true,
        seasonality: occurrence?.meta?.seasonality || null,
        lunarTiming: occurrence?.meta?.lunarTiming || null,
      },
    })
  );

  const hasTasks = Array.isArray(tasks) && tasks.length > 0;

  // If no explicit tasks, create a default maintenance pattern (per plot)
  if (!hasTasks) {
    let idx = 0;

    for (const p of plots || []) {
      const pid = p?.id || p?.name || null;
      const pname = p?.name || pid || "Plot";

      steps.push(
        makeStep({
          id: makeStableStepId(sessionId, pid || pname, idx++, "plot"),
          title: `Plot: ${pname}`,
          text: "Work top-to-bottom: quick wins first, then deeper tasks.",
          kind: "plot",
          plotId: pid,
          plotName: pname,
          timers: [],
          meta: { phase: "plot_start" },
        })
      );

      const defaults = [
        {
          kind: "observe",
          text: `Observe plants in ${pname} (pests, wilting, fruit/flowering)`,
        },
        { kind: "weed", text: `Weed ${pname}` },
        {
          kind: "water",
          text: `Water ${pname} if soil is dry (check 1–2 inches down)`,
        },
        {
          kind: "mulch",
          text: `Spot mulch/break crust in ${pname} (if needed)`,
        },
      ];

      defaults.forEach((d) => {
        const min = inferTaskMinutes(d.text, d.kind);
        steps.push(
          makeStep({
            id: makeStableStepId(sessionId, pid || pname, idx++, "garden"),
            title: pname,
            text: d.text,
            kind: d.kind,
            plotId: pid,
            plotName: pname,
            timers: min ? [{ label: "Timer", ms: minutesToMs(min) }] : [],
            meta: { inferred: true, minutes: min },
          })
        );
      });
    }

    steps.push(
      makeStep({
        id: makeStableStepId(sessionId, "global", idx++, "closeout"),
        title: "Closeout",
        text: "Clean tools, return supplies, and log observations and shortages.",
        kind: "closeout",
        timers: [],
        meta: {
          phase: "closeout",
          inventoryLinking: true,
          harvestLogging: true,
          pestLogging: true,
        },
      })
    );

    return steps;
  }

  // Explicit tasks: group them for coherent flow
  const { groups, orderedKeys, plotMap, cropMap } = groupTasks(
    tasks,
    plots,
    crops
  );

  let stepIndex = 0;

  for (const key of orderedKeys) {
    const g = groups.get(key);
    if (!g) continue;

    const plot = g.plotId ? plotMap.get(String(g.plotId)) : null;
    const crop = g.cropId ? cropMap.get(String(g.cropId)) : null;

    const scopeKey = `${String(g.plotId || "global")}::${String(
      g.cropId || ""
    )}`;
    const plotName =
      plot?.name || plot?.id || (g.plotId ? String(g.plotId) : null);
    const cropName =
      crop?.name || crop?.id || (g.cropId ? String(g.cropId) : null);

    // Section header
    const headerTitle = cropName
      ? `Crop: ${cropName}${plotName ? ` (in ${plotName})` : ""}`
      : plotName
      ? `Plot: ${plotName}`
      : "Whole Garden";

    steps.push(
      makeStep({
        id: makeStableStepId(sessionId, scopeKey, stepIndex++, "section"),
        title: headerTitle,
        text: "Work through these tasks in order. Adjust based on weather, soil moisture, and plant condition.",
        kind: "section",
        plotId: g.plotId,
        plotName,
        cropId: g.cropId,
        cropName,
        timers: [],
        meta: { phase: "section_start" },
      })
    );

    // Tasks
    for (let i = 0; i < g.tasks.length; i += 1) {
      const t = g.tasks[i];
      const txt = toText(t?.text || t?.title);
      if (!txt) continue;

      const inferredMin = t?.minutes || inferTaskMinutes(txt, t?.kind);
      const timer =
        t?.timer ||
        (inferredMin ? { label: "Timer", ms: minutesToMs(inferredMin) } : null);

      const kind = t?.kind || "garden";

      // Harvest tasks get extra metadata hooks
      const isHarvest =
        kind.toLowerCase().includes("harvest") ||
        txt.toLowerCase().includes("harvest");

      steps.push(
        makeStep({
          id: makeStableStepId(sessionId, scopeKey, stepIndex++, "garden"),
          title: cropName || plotName || "Garden",
          text: txt,
          kind,
          plotId: g.plotId,
          plotName,
          cropId: g.cropId,
          cropName,
          timers: timer ? [timer] : [],
          meta: {
            taskId: t?.id || null,
            minutes: inferredMin || null,
            isHarvest,
            // forward hooks:
            expectedYield: isHarvest
              ? occurrence?.meta?.harvest?.expectedYield || null
              : null,
            yieldUnits: isHarvest
              ? occurrence?.meta?.harvest?.units || null
              : null,
            destination: isHarvest
              ? occurrence?.meta?.harvest?.destination || null
              : null, // kitchen|preservation|storehouse
            preservationHandoff: isHarvest
              ? occurrence?.meta?.preservationHandoff || null
              : null,
            rawMeta: t?.meta || null,
          },
        })
      );
    }
  }

  // Closeout step
  steps.push(
    makeStep({
      id: makeStableStepId(sessionId, "global", stepIndex++, "closeout"),
      title: "Closeout & log",
      text: "Clean tools, store supplies, log observations (pests/disease/moisture), and record any harvest yields and shortages.",
      kind: "closeout",
      timers: [],
      meta: {
        phase: "closeout",
        // forward hooks:
        inventoryLinking: true,
        harvestLogging: true,
        pestLogging: true,
        irrigationLogging: true,
        preservationHandoff: occurrence?.meta?.preservationHandoff || null,
      },
    })
  );

  return steps;
}

/* ------------------------------ Public API ---------------------------------- */

/**
 * buildGardenSessionDraft(domain, occurrence, context)
 * ---------------------------------------------------------------------------
 * Called by shared acceptPlanApply:
 *   buildSessionDraft(domain, occurrence, context)
 */
export default function buildGardenSessionDraft(
  domain,
  occurrence,
  context = {}
) {
  if (!domain || typeof domain !== "string") {
    emit("gardening.session.draft.error", {
      ok: false,
      error: "domain is required",
    });
    return null;
  }
  if (!occurrence || typeof occurrence !== "object") {
    emit("gardening.session.draft.error", {
      ok: false,
      domain,
      error: "occurrence is required",
    });
    return null;
  }

  const sid = stableSessionId(domain, occurrence);

  const plots = normalizePlotsFromOccurrence(occurrence);
  const crops = normalizeCropsFromOccurrence(occurrence);
  const tasks = normalizeTasksFromOccurrence(occurrence);

  const steps = buildConsolidatedSteps({
    sessionId: sid,
    occurrence,
    plots,
    crops,
    tasks,
    context,
  });

  const title = occurrence?.title || "Garden session";
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
      adapter: "gardening",
      source: "buildGardenSessionDraft",
      gardenType: occurrence?.meta?.gardenType || "maintenance",
      priority: occurrence?.meta?.priority ?? null,
      plots,
      crops,
      taskCount: tasks.length,
      supplies,
      equipment,
      location: occurrence?.meta?.location || null,
      constraints:
        occurrence?.meta?.constraints || context?.constraints || null,
      weatherAware: occurrence?.meta?.weatherAware ?? true,
      seasonality: occurrence?.meta?.seasonality || null,
      lunarTiming: occurrence?.meta?.lunarTiming || null,
      irrigation: occurrence?.meta?.irrigation || null,
      pestPressure: occurrence?.meta?.pestPressure || null,

      harvest: occurrence?.meta?.harvest || null, // { expectedYield, units, destination }
      preservationHandoff: occurrence?.meta?.preservationHandoff || null,

      // forward hooks for cross-domain intelligence:
      inventoryLinking: {
        enabled: true,
        // seeds/compost/fertilizer can tie into storehouse/inventory:
        // suggest | reserve | decrement-on-complete
        mode: context?.inventoryLinkMode || "suggest",
      },
      plantingLogging: {
        enabled: true,
        // connect later to PlantingLog / SeedInventory:
        // e.g. record planting date, variety, row length, spacing
      },
      harvestLogging: {
        enabled: true,
        // connect later to inventory & preservation planners:
        // if destination=preservation, propose a Preservation session.
      },
    },
  };

  emit("gardening.session.draft.built", {
    ok: true,
    domain,
    sessionId: sid,
    occurrenceId: occurrence?.id || null,
    plotCount: plots.length,
    cropCount: crops.length,
    taskCount: tasks.length,
    stepCount: steps.length,
  });

  if (!tasks.length && !plots.length && !crops.length) {
    emit("gardening.session.draft.warning", {
      domain,
      sessionId: sid,
      occurrenceId: occurrence?.id || null,
      message:
        "No plots/crops/tasks were found; session uses a generic garden workflow.",
    });
  }

  return draft;
}
