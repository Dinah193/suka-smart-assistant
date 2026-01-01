// src/services/templates/batchSessionBuilder.js

import * as BatchQueueStore from "@/store/BatchQueueStore";
import * as RecipeStore from "@/store/RecipeStore";
import generateCookingSession from "@/services/planning/generateCookingSession";
import {
  useTimers,
  createTimer,
  startTimer,
  pauseTimer,
  completeTimer,
  removeTimer,
} from "@/store/MultiTimerManager";
import * as timeUtils from "@/utils/timeUtils";
import * as inventoryUtils from "@/utils/inventoryUtils";
import ReminderManager from "@/managers/ReminderManager";

/**
 * Template metadata (contract-compliant)
 * - Adds visible drafts, inventory reservations, label printer hook, batch planner link
 * - Voice + toast alerts on step changes (opt-in)
 */
export const template = {
  id: "batch_session_builder_2h_v2",
  version: "2.2.0",
  purpose:
    "One tap builds a 2-hour power cook from queued recipes with oven/stovetop clustering, timers, labels, and inventory sync.",
  triggers: [
    "ui::BatchSessionPlanner.jsx.open",
    "ui::RecipeVault.added_to_batch",
    "time::SU_14_00_local",
  ],
  inputs: {
    required: ["BatchQueueStore", "inventorySnapshot", "applianceAvail"],
    optional: [
      "userPrefs", // {voiceAlerts?:bool, toastAlerts?:bool, applyDrafts?:bool}
      "reservedInventory", // previous holds you may want to clear
    ],
  },
  logic: {
    selectors: [
      "BatchQueueStore.getAllQueued()",
      "RecipeStore.getById(id)",
      "inventoryUtils.missingIngredients(recipe, inventorySnapshot)",
      "applianceAvail = { ovenCapacity, burners, sheetPans, racks, freezerSpace? }",
    ],
    rules: [
      "Greedy-pack recipes to fill oven & stovetop within 120 minutes.",
      "Cluster by oven temperatures; co-bake where temps match or are close within ±15°F/±8°C.",
      "Prefer high inventory fit, short active time, and shared prep steps (chop, sauté, bake).",
      "Parallelize timers safely; respect burner & rack capacities.",
      "If capacity exceeded → split into Block A & Block B (auto-remind for Block B).",
    ],
    llm_roles: [],
  },
  actions: [
    "dispatch:generateCookingSession(batch=true)",
    "open:StorageLabeler.jsx#print",
    "open:InventorySyncModal#multi",
    "notify:ReminderManager.schedule(cool_down + preservation follow-ups + blockB)",
    "toast:session_start",
    "voice:step_prompts",
  ],
  outputs: {
    ui: ["StorageLabeler.jsx", "MultiTimerPanel", "InventorySyncModal"],
    data: ["sessionGantt", "timers", "labels", "draftReservations"],
    alerts: ["step_voice", "step_toast", "cool_down", "preservation_prompts"],
  },
  fallbacks: [
    "If capacity exceeded → split into two 2-hour blocks and schedule the second block automatically.",
    "If inventory gaps → surface InventorySyncModal with multi-select mapping to alternatives.",
  ],
  success_message: "2-hour power cook drafted. Timers and labels are ready for review.",
  used_by: ["batchCookingAgent"],
};

/* ----------------------------------------------------------------------------
   Config + helpers
---------------------------------------------------------------------------- */
const MAX_MIN = 120;
const TEMP_TOLERANCE_F = 15; // ±15°F grouping
const TEMP_TOLERANCE_C = 8; // ±8°C grouping
const SEC = (m) => Math.max(1, Math.round(m * 60));

const toNumber = (x, fb = 0) => (Number.isFinite(Number(x)) ? Number(x) : fb);
const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

function getOvenTemp(recipe) {
  const v =
    recipe.ovenTemp ??
    recipe.oven?.temp ??
    recipe.bakeTemp ??
    recipe.steps?.find((s) => s.type === "oven" || /bake/i.test(s.text))?.temp;
  return toNumber(v, 0);
}
function usesOven(r) {
  return !!(r.ovenTime || r.bakeTime || r.oven || r.steps?.some((s) => s.type === "oven"));
}
function burnerCount(r) {
  const explicit = toNumber(r.burners ?? r.stovetopBurners, NaN);
  if (Number.isFinite(explicit)) return explicit;
  // Heuristic: if no oven and has cook step, assume 1 burner
  const hasCook = r.steps?.some((s) => /sauté|simmer|boil|sear|pan/i.test(s.text));
  return usesOven(r) ? 0 : hasCook ? 1 : 0;
}
function totalTimeMin(r) {
  const t = toNumber(r.totalTime ?? r.activeTime ?? r.time, 30);
  return Math.max(5, Math.min(180, t));
}
function invFit(recipe, inventorySnapshot) {
  const missing = inventoryUtils.missingIngredients?.(recipe, inventorySnapshot) || [];
  const need = (recipe.ingredients || []).length || 1;
  return Math.max(0, 1 - missing.length / need); // 1 = fully covered
}
function sameTempCluster(tempA, tempB, units = "F") {
  if (!tempA || !tempB) return false;
  const tol = units === "C" ? TEMP_TOLERANCE_C : TEMP_TOLERANCE_F;
  return Math.abs(tempA - tempB) <= tol;
}

/**
 * Cluster by oven temperature to increase co-baking opportunities.
 */
function groupByOvenTemp(recipes, units = "F") {
  const groups = [];
  recipes.forEach((r) => {
    const t = getOvenTemp(r);
    if (!t) {
      groups.push({ key: `no-oven-${r.id || Math.random()}`, temp: 0, items: [r] });
      return;
    }
    let placed = false;
    for (const g of groups) {
      if (g.temp && sameTempCluster(g.temp, t, units)) {
        g.items.push(r);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push({ key: `temp-${t}`, temp: t, items: [r] });
  });
  // Sort groups: oven clusters first (higher temp first), then no-oven
  return groups.sort((a, b) => (b.temp || 0) - (a.temp || 0));
}

/**
 * Greedy packer for 2-hour window with oven + stovetop constraints and temp clusters.
 */
function packTwoHours(candidates, inventorySnapshot, applianceAvail, units = "F") {
  const burnersMax = toNumber(applianceAvail?.burners, 2);
  const ovenRacks = toNumber(applianceAvail?.ovenCapacity, 2);

  // Base score: inventory fit > shorter time > uses oven (to allow co-bake clustering)
  const scored = [...candidates].map((r) => ({
    r,
    score:
      invFit(r, inventorySnapshot) * 0.6 +
      Math.max(0, 1 - Math.min(90, Math.abs(totalTimeMin(r) - 40)) / 90) * 0.25 +
      (usesOven(r) ? 0.15 : 0),
  }));

  const groups = groupByOvenTemp(
    scored.sort((a, b) => b.score - a.score).map((x) => x.r),
    units
  );

  const selection = [];
  let usedMinutes = 0;
  let burnersInUse = 0;
  let racksInUse = 0;
  let lastClusterTemp = null;

  // Walk groups: try to place co-bake items together
  for (const g of groups) {
    for (const r of g.items) {
      const tMin = Math.min(totalTimeMin(r), 60); // cap contribution per recipe
      const needOven = usesOven(r);
      const burnersNeed = burnerCount(r);
      const t = getOvenTemp(r) || lastClusterTemp;

      const fitTime = usedMinutes + tMin <= MAX_MIN;
      const fitBurners = burnersInUse + burnersNeed <= burnersMax;
      const fitOven = needOven ? racksInUse + 1 <= ovenRacks : true;

      if (fitTime && fitBurners && fitOven) {
        selection.push(r);
        usedMinutes += tMin;
        burnersInUse = Math.min(burnersMax, burnersInUse + burnersNeed);
        if (needOven) {
          racksInUse = Math.min(ovenRacks, racksInUse + 1);
          lastClusterTemp = lastClusterTemp ?? (getOvenTemp(r) || t);
        }
      }

      // Light decay to allow additional picks (models overlap)
      burnersInUse = Math.max(0, burnersInUse - 1);
      if (racksInUse > 0) racksInUse -= 1;
    }
  }

  return { selection, usedMinutes };
}

/**
 * Build label data (basic): name, date, portion, reheat notes.
 */
function buildLabels(recipes) {
  const now = new Date();
  return recipes.map((r, i) => ({
    id: r.id || `batch_${i}`,
    name: r.name,
    date: now.toISOString().slice(0, 10),
    portion: r.servings || r.portions || 2,
    notes: r.reheat || r.storageNote || "Reheat until steaming hot.",
  }));
}

/**
 * Voice & toast helpers (no-ops if not supported)
 */
function speak(text) {
  try {
    if ("speechSynthesis" in window) {
      const u = new SpeechSynthesisUtterance(text);
      window.speechSynthesis.speak(u);
    }
  } catch {}
}
function toast(text) {
  try {
    window.dispatchEvent(new CustomEvent("ui:toast", { detail: { text, type: "info" } }));
  } catch {}
}

/**
 * Schedule cool-down + preservation follow-ups.
 * If ctx.runTemplate exists, chain preservation flows.
 */
async function scheduleFollowUps(session, ctx, when = new Date()) {
  const coolEnd =
    timeUtils?.addMinutes?.(when, Math.round((session?.totalMinutes || 90) + 30)) ||
    new Date(when.getTime() + 120 * 60000);

  ReminderManager.schedule?.({
    at: coolEnd,
    title: "Batch cool-down complete",
    message: "Time to label and store. Consider canning, freezing or dehydrating.",
    tags: ["batch", "cool_down"],
  });

  // Optional: chain preservation flows (pressure canning, freezing, dehydrating, curing)
  if (ctx?.runTemplate) {
    const items = (session?.portions || []).map((p) => ({
      name: p.name,
      qty: p.qty,
      type: p.type,
    }));
    await ctx.runTemplate(
      "harvest-preservation-sync", // prefer your kitchen template to balance capacity
      {
        harvestForecasts: [], // not required when pushing direct items; template supports empty
        // You can extend runTemplate to accept direct items for immediate preservation
        directItems: items,
      },
      { dtstart: coolEnd }
    );
  }
}

/**
 * Start synchronized multi-timers from a timeline using MultiTimerManager store API.
 * Adds optional voice/toast at step boundaries.
 */
function startFromTimeline(
  enrichedTimeline,
  {
    label = "Batch Session",
    voiceAlerts = false,
    toastAlerts = true,
    onStepBegin,
    onStepMiss,
  } = {}
) {
  const sessionId = `batch_${Date.now()}`;
  const steps = Array.isArray(enrichedTimeline?.steps) ? enrichedTimeline.steps : [];

  let cursor = 0;
  const planned = steps.map((s, i) => {
    const startAtSec = Number.isFinite(s.startAtSec) ? Math.max(0, s.startAtSec) : cursor;
    const durationSec = SEC(s.duration ?? 1);
    cursor = Math.max(cursor, startAtSec) + durationSec;

    const id = `${sessionId}_${i}`;
    const stepLabel = (s.calmText || s.text || `Step ${i + 1}`).slice(0, 110);

    createTimer(id, stepLabel, durationSec);

    setTimeout(() => {
      if (voiceAlerts) speak(`Start: ${stepLabel}`);
      if (toastAlerts) toast(`Start: ${stepLabel}`);
      try {
        if (typeof onStepBegin === "function") onStepBegin(i, stepLabel);
      } catch {}
      startTimer(id);
    }, Math.max(0, startAtSec) * 1000);

    // “Missed step” nudge 12s after planned start (if still not started/paused)
    if (typeof onStepMiss === "function") {
      setTimeout(() => {
        try {
          onStepMiss(i, stepLabel);
        } catch {}
      }, Math.max(0, startAtSec + 12) * 1000);
    }

    // End-of-step voice/ toast
    setTimeout(() => {
      if (voiceAlerts) speak(`Complete: ${stepLabel}`);
      if (toastAlerts) toast(`Complete: ${stepLabel}`);
    }, Math.max(0, startAtSec + durationSec) * 1000);

    return { id, label: stepLabel, startAtSec, durationSec };
  });

  return { timers: planned, sessionId };
}

/* ----------------------------------------------------------------------------
   EXECUTE
---------------------------------------------------------------------------- */
/**
 * Execute the template.
 * @param {Object} payload
 * @param {Object} payload.inventorySnapshot
 * @param {Object} payload.applianceAvail - { ovenCapacity, burners, sheetPans, racks, freezerSpace? }
 * @param {Object} [payload.userPrefs] - {voiceAlerts?:bool, toastAlerts?:bool, applyDrafts?:bool, tempUnits?:'F'|'C'}
 * @param {Object} [ctx] - { openUI?, runTemplate?, now?, openModal?, linkBatchPlanner?, printLabels? }
 */
export async function execute(payload, ctx = {}) {
  const {
    inventorySnapshot,
    applianceAvail,
    userPrefs = { voiceAlerts: true, toastAlerts: true, applyDrafts: false, tempUnits: "F" },
  } = payload;
  const {
    openUI,
    runTemplate,
    openModal,
    linkBatchPlanner,
    printLabels,
    now = new Date(),
  } = ctx;

  // 1) Gather queued recipes
  const queuedIds = BatchQueueStore.getAllQueued?.() || [];
  const candidates = queuedIds
    .map((id) => RecipeStore.getById?.(id))
    .filter(Boolean);

  if (!candidates.length) {
    throw new Error("batchSessionBuilder: No recipes in the batch queue.");
  }

  // 2) Warn about inventory gaps + prep a multi-sync modal draft
  const gaps = [];
  for (const r of candidates) {
    const missing = inventoryUtils.missingIngredients?.(r, inventorySnapshot) || [];
    if (missing.length) {
      gaps.push({ recipeId: r.id, recipe: r.name, missing });
    }
  }
  if (gaps.length && typeof openModal === "function") {
    // Open InventorySyncModal in draft mode (multi-select + alt mapping)
    openModal("InventorySyncModal", {
      mode: "draft",
      gaps,
      allowMultiSelect: true,
      allowQtyAdjust: true,
      returnAction: "resume_batch_planning",
    });
  }

  // 3) Greedy pack for a 2-hour window (with temp clustering)
  const { selection, usedMinutes } = packTwoHours(
    candidates,
    inventorySnapshot,
    applianceAvail,
    userPrefs.tempUnits || "F"
  );

  if (!selection.length) {
    throw new Error(
      "batchSessionBuilder: Nothing fits into the 2-hour window with current capacity."
    );
  }

  // 4) If over capacity (heuristic), split into two blocks
  const exceedsCap =
    usedMinutes > MAX_MIN ||
    selection.length >
      ((applianceAvail?.ovenCapacity ?? 2) + (applianceAvail?.burners ?? 2) * 2);

  let blockA = selection;
  let blockB = [];
  if (exceedsCap) {
    // Keep oven-cluster balance by alternating
    const alt = [];
    const evens = selection.filter((_, i) => i % 2 === 0);
    const odds = selection.filter((_, i) => i % 2 === 1);
    while (evens.length || odds.length) {
      if (evens.length) alt.push(evens.shift());
      if (odds.length) alt.push(odds.shift());
    }
    const mid = Math.ceil(alt.length / 2);
    blockA = alt.slice(0, mid);
    blockB = alt.slice(mid);
  }

  // 5) Generate the cooking session (Block A)
  const sessionA = await generateCookingSession({
    recipes: blockA,
    batch: true,
    applianceAvail,
    context: { mode: "batch-2h-power" },
  });

  // 6) Start multi-timers + voice/toast
  const { timers, sessionId } = startFromTimeline(sessionA.timeline, {
    label: "Batch 2-Hour Power Cook",
    voiceAlerts: !!userPrefs.voiceAlerts,
    toastAlerts: !!userPrefs.toastAlerts,
    onStepBegin: (i, label) => {
      window.dispatchEvent(
        new CustomEvent("batch:stepBegin", { detail: { sessionId, stepIndex: i, label } })
      );
    },
    onStepMiss: (i, label) => {
      window.dispatchEvent(
        new CustomEvent("batch:stepMiss", { detail: { sessionId, stepIndex: i, label } })
      );
    },
  });

  // 7) Labels (and optional immediate printing)
  const labels = buildLabels(blockA);
  if (typeof printLabels === "function") {
    printLabels(labels);
  } else if (typeof openUI === "function") {
    openUI("StorageLabeler", { labels, sessionId, draft: true });
  } else {
    window.dispatchEvent(
      new CustomEvent("ui:navigate", {
        detail: { route: "StorageLabeler", params: { labels, sessionId, draft: true } },
      })
    );
  }

  // 8) Reserve inventory for selected recipes (draft holds)
  const draftReservations = [];
  for (const r of blockA) {
    const reservation = inventoryUtils.reserveForRecipe?.(r, { draft: true });
    if (reservation?.items?.length) draftReservations.push({ recipeId: r.id, ...reservation });
  }
  if (draftReservations.length) {
    window.dispatchEvent(
      new CustomEvent("inventory:draftReserved", { detail: { sessionId, draftReservations } })
    );
  }

  // 9) Link Batch Session Planner (so it shows prefilled session)
  if (typeof linkBatchPlanner === "function") {
    linkBatchPlanner({
      sessionId,
      recipes: blockA.map((r) => ({ id: r.id, name: r.name })),
      timeline: sessionA.timeline,
    });
  } else {
    window.dispatchEvent(
      new CustomEvent("ui:link", {
        detail: {
          route: "/tier2/household/meals#batch-session-planner",
          params: { sessionId, recipes: blockA.map((r) => ({ id: r.id, name: r.name })) },
        },
      })
    );
  }

  // 10) Schedule cool-down + preservation follow-ups
  await scheduleFollowUps(sessionA, { ...ctx, runTemplate }, now);

  // 11) If we split, auto-schedule Block B in 2.5 hours (buffer)
  let secondBlock = null;
  if (blockB.length) {
    const startB =
      timeUtils?.addMinutes?.(now, 150) || new Date(now.getTime() + 150 * 60000);

    ReminderManager.schedule?.({
      at: startB,
      title: "Start Batch — Block 2",
      message: `Second batch block is ready. ${blockB.length} recipes queued.`,
      tags: ["batch", "second_block"],
    });

    secondBlock = {
      plannedStart: startB,
      recipeIds: blockB.map((r) => r.id),
      note: "Auto-scheduled because capacity exceeded.",
    };
  }

  // 12) Return visible-draft result (orchestrator may applyDrafts immediately if user setting)
  const result = {
    ok: true,
    sessionId,
    sessionGantt: sessionA.timeline,
    timers,
    labels,
    draftReservations,
    secondBlock,
    message: template.success_message,
    draft: true,
    applyDrafts: !!userPrefs.applyDrafts,
  };

  return result;
}

export default {
  template,
  execute,
};
