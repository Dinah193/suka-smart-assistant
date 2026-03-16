// C:\Users\larho\suka-smart-assistant\src\features\calculators\gardenAnimal\GardenPlantingCalendarCalculator\GardenPlantingCalendarCalculator.hooks.js

/**
 * GardenPlantingCalendarCalculator.hooks
 *
 * Hooks to:
 * 1. Run the Garden Planting Calendar calculator shim from anywhere (planner, calendar, etc.).
 * 2. Transform calculator outputs into Garden Planner tasks.
 * 3. Emit SSA events that SessionRunner and other subsystems can listen to.
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import { runGardenPlantingCalendarCalculatorShim } from "./GardenPlantingCalendarCalculator.shim";
import eventBus from "@/services/events/eventBus";
import * as featureFlags from "@/config/featureFlags";

// ---------------------------------------------------------------------------
// Hook: useGardenPlantingCalendarCalculator
// Centralized state + recompute for the planting calendar node.
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} GardenPlantingCalendarPayload
 * @property {Object} context
 * @property {Object} inputs
 * @property {Object|null} outputs
 */

/**
 * Hook to manage planting calendar payload/result and trigger recomputes via shim.
 *
 * @param {GardenPlantingCalendarPayload|undefined} initialPayload
 * @returns {{
 *   payload: GardenPlantingCalendarPayload,
 *   setPayload: (next: GardenPlantingCalendarPayload) => void,
 *   result: GardenPlantingCalendarPayload|null,
 *   isComputing: boolean,
 *   error: string,
 *   recalc: () => Promise<void>
 * }}
 */
export function useGardenPlantingCalendarCalculator(initialPayload) {
  const [payload, setPayload] = useState(() =>
    initialPayload && typeof initialPayload === "object"
      ? initialPayload
      : getDefaultPayload()
  );
  const [result, setResult] = useState(() =>
    initialPayload && initialPayload.outputs ? initialPayload : null
  );
  const [isComputing, setIsComputing] = useState(false);
  const [error, setError] = useState("");

  const familyFundMode = (featureFlags && featureFlags.familyFundMode) || false;

  const recalc = useCallback(async () => {
    setIsComputing(true);
    setError("");
    try {
      const next = await runGardenPlantingCalendarCalculatorShim(payload, {
        eventBus,
        featureFlags: { familyFundMode },
      });

      setResult(next);
      setPayload(next);

      // Emit a generic planning node update event so the Planning Graph
      // can observe and update other dependent nodes.
      safeEmit({
        type: "planningNode.updated",
        source:
          "calculators/garden/GardenPlantingCalendarCalculator.hooks.recalc",
        data: {
          nodeKey: "gardenPlantingCalendar",
          payload: next,
        },
      });
    } catch (err) {
      console.error("[useGardenPlantingCalendarCalculator] error:", err);
      setError("Unable to recompute planting calendar. Please check inputs.");
    } finally {
      setIsComputing(false);
    }
  }, [payload, familyFundMode]);

  // Initial compute if we start with no outputs.
  useEffect(() => {
    if (!result || !result.outputs) {
      recalc().catch((err) => {
        console.warn(
          "[useGardenPlantingCalendarCalculator] initial recalc failed:",
          err
        );
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    payload,
    setPayload,
    result,
    isComputing,
    error,
    recalc,
  };
}

// ---------------------------------------------------------------------------
// Hook: useGardenPlannerIntegration
// Bridge between calculator outputs and Garden Planner tasks.
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} GardenPlannerTask
 * @property {string} id
 * @property {"planting"|"harvest"|"event"} kind
 * @property {string} label
 * @property {string} date
 * @property {string=} endDate
 * @property {string=} cropName
 * @property {string=} bedId
 * @property {Object} links
 * @property {string=} links.windowId
 * @property {string=} links.eventId
 * @property {Object=} meta
 */

/**
 * Hook to map planting calendar outputs into Garden Planner tasks
 * and provide helpers to request sessions from those tasks.
 *
 * @param {GardenPlantingCalendarPayload|null} calculatorResult
 * @param {{ autoEmitEvents?: boolean }} [options]
 * @returns {{
 *   tasks: GardenPlannerTask[],
 *   plantingTasks: GardenPlannerTask[],
 *   harvestTasks: GardenPlannerTask[],
 *   calendarEventTasks: GardenPlannerTask[],
 *   requestSessionForTask: (task: GardenPlannerTask) => void
 * }}
 */
export function useGardenPlannerIntegration(calculatorResult, options) {
  const { autoEmitEvents = true } = options || {};

  const outputs =
    calculatorResult && calculatorResult.outputs
      ? calculatorResult.outputs
      : {
          plantingWindows: [],
          harvestWindows: [],
          calendarEvents: [],
        };

  const plantingTasks = useMemo(
    () =>
      Array.isArray(outputs.plantingWindows)
        ? outputs.plantingWindows.map(toPlannerPlantingTask)
        : [],
    [outputs.plantingWindows]
  );

  const harvestTasks = useMemo(
    () =>
      Array.isArray(outputs.harvestWindows)
        ? outputs.harvestWindows.map(toPlannerHarvestTask)
        : [],
    [outputs.harvestWindows]
  );

  const calendarEventTasks = useMemo(
    () =>
      Array.isArray(outputs.calendarEvents)
        ? outputs.calendarEvents.map(toPlannerCalendarEventTask)
        : [],
    [outputs.calendarEvents]
  );

  const tasks = useMemo(
    () => [...plantingTasks, ...harvestTasks, ...calendarEventTasks],
    [plantingTasks, harvestTasks, calendarEventTasks]
  );

  // Optionally emit a single aggregated event whenever tasks change.
  useEffect(() => {
    if (!autoEmitEvents) return;

    if (!tasks.length) return;

    safeEmit({
      type: "garden.planner.tasks.generated",
      source:
        "calculators/garden/GardenPlantingCalendarCalculator.hooks.integration",
      data: {
        nodeKey: "gardenPlantingCalendar",
        counts: {
          total: tasks.length,
          planting: plantingTasks.length,
          harvest: harvestTasks.length,
          events: calendarEventTasks.length,
        },
        tasks,
      },
    });
  }, [tasks, plantingTasks, harvestTasks, calendarEventTasks, autoEmitEvents]);

  /**
   * Request a runnable session for a given planner task.
   * This emits "session.requested" for SessionRunner to consume.
   *
   * @param {GardenPlannerTask} task
   */
  const requestSessionForTask = useCallback((task) => {
    if (!task || !task.kind) return;
    const ts = new Date().toISOString();

    const session = buildGardenSessionFromPlannerTask(task);

    safeEmit({
      type: "session.requested",
      ts,
      source:
        "calculators/garden/GardenPlantingCalendarCalculator.hooks.requestSession",
      data: { session },
    });
  }, []);

  return {
    tasks,
    plantingTasks,
    harvestTasks,
    calendarEventTasks,
    requestSessionForTask,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getDefaultPayload() {
  const now = new Date();
  return {
    context: {
      nodeKey: "gardenPlantingCalendar",
      version: "1.0.0",
    },
    inputs: {
      climate: {
        lastFrostDate: "",
        firstFrostDate: "",
        zone: "",
        notes: "",
      },
      calendar: {
        year: now.getFullYear(),
        alignWithFeastDays: true,
        feastDays: [],
      },
      crops: [],
      gardenLayout: {
        beds: [],
      },
    },
    outputs: null,
  };
}

/**
 * Safe eventBus emit wrapper.
 * @param {{ type: string, ts?: string, source: string, data?: any }} evt
 */
function safeEmit(evt) {
  if (!evt || !evt.type || !evt.source) return;
  const ts = evt.ts || new Date().toISOString();

  try {
    if (eventBus && typeof eventBus.emit === "function") {
      eventBus.emit({
        type: evt.type,
        ts,
        source: evt.source,
        data: evt.data,
      });
    }
  } catch (err) {
    console.warn("[GardenPlantingCalendarCalculator.hooks] emit failed:", err);
  }
}

// ---------- Mapping helpers: outputs -> GardenPlannerTask --------------------

/**
 * @param {any} w
 * @returns {GardenPlannerTask}
 */
function toPlannerPlantingTask(w) {
  const id = w.windowId || `planting-${Math.random().toString(36).slice(2, 9)}`;
  return {
    id,
    kind: "planting",
    label: `Plant ${w.cropName || "crops"}`,
    date: w.startDate || "",
    endDate: w.endDate || "",
    cropName: w.cropName || "",
    bedId: w.bedId || "",
    links: {
      windowId: w.windowId || "",
      eventId: "",
    },
    meta: {
      season: w.season || "",
      flags: Array.isArray(w.flags) ? w.flags : [],
      successionIndex: w.successionIndex ?? 0,
      earliestSafeDate: w.earliestSafeDate || "",
      latestSafeDate: w.latestSafeDate || "",
    },
  };
}

/**
 * @param {any} w
 * @returns {GardenPlannerTask}
 */
function toPlannerHarvestTask(w) {
  const id = w.windowId || `harvest-${Math.random().toString(36).slice(2, 9)}`;
  return {
    id,
    kind: "harvest",
    label: `Harvest ${w.cropName || "crops"}`,
    date: w.startDate || "",
    endDate: w.endDate || "",
    cropName: w.cropName || "",
    bedId: w.bedId || "",
    links: {
      windowId: w.windowId || "",
      eventId: "",
    },
    meta: {
      targetUse: w.targetUse || "mixed",
      alignedFeastDays: Array.isArray(w.alignedFeastDays)
        ? w.alignedFeastDays
        : [],
    },
  };
}

/**
 * @param {any} ev
 * @returns {GardenPlannerTask}
 */
function toPlannerCalendarEventTask(ev) {
  const id = ev.eventId || `cal-ev-${Math.random().toString(36).slice(2, 9)}`;
  return {
    id,
    kind: ev.kind === "harvest" || ev.kind === "planting" ? ev.kind : "event",
    label: ev.title || "Garden event",
    date: ev.date || "",
    endDate: "",
    cropName: ev.cropName || "",
    bedId: ev.bedId || "",
    links: {
      windowId: ev.windowId || "",
      eventId: ev.eventId || "",
    },
    meta: {
      notes: ev.notes || "",
      raw: ev,
    },
  };
}

// ---------- Session builder from planner task ------------------------------

/**
 * Build a minimal garden session from a planner task.
 * This mirrors the logic used in the .view file, but keeps hooks decoupled
 * from UI components.
 *
 * @param {GardenPlannerTask} task
 * @returns {object} session compatible with SessionRunner
 */
function buildGardenSessionFromPlannerTask(task) {
  const id = `garden-session-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 6)}`;
  const isPlanting = task.kind === "planting";
  const isHarvest = task.kind === "harvest";

  const title = task.label || "Garden task";

  const baseStepId = (name) =>
    `${id}-${name}-${Math.random().toString(36).slice(2, 7)}`;

  const steps = [];

  if (isPlanting) {
    steps.push(
      {
        id: baseStepId("prep-bed"),
        title: "Prep bed / containers",
        desc: "Weed, amend soil, and set up irrigation for this bed before planting.",
        durationSec: 20 * 60,
        blockers: ["weather", "inventory"],
        metadata: {
          tempTargetF: 0,
          donenessCue: "timer",
          cueNotes: "Stop when bed is level, moist, and free of large clumps.",
        },
      },
      {
        id: baseStepId("sow"),
        title: "Sow seeds / transplant seedlings",
        desc: "Plant according to packet depth and spacing. Label rows clearly.",
        durationSec: 25 * 60,
        blockers: ["weather"],
        metadata: {
          tempTargetF: 0,
          donenessCue: "timer",
          cueNotes: "Ensure firm seed-to-soil contact and good spacing.",
        },
      },
      {
        id: baseStepId("water-in"),
        title: "Water in planting",
        desc: "Water gently until soil is evenly moist but not waterlogged.",
        durationSec: 10 * 60,
        blockers: ["weather"],
        metadata: {
          tempTargetF: 0,
          donenessCue: "timer",
          cueNotes: "Check for pooling; adjust flow as needed.",
        },
      }
    );
  } else if (isHarvest) {
    steps.push(
      {
        id: baseStepId("inspect"),
        title: "Inspect crop for ripeness",
        desc: "Check color, firmness, and aroma. Harvest only what is ripe.",
        durationSec: 15 * 60,
        blockers: ["weather"],
        metadata: {
          tempTargetF: 0,
          donenessCue: "texture",
          cueNotes: "Skip any damaged or diseased produce.",
        },
      },
      {
        id: baseStepId("harvest"),
        title: "Harvest and sort",
        desc: "Harvest into clean containers. Sort for fresh use vs. preservation.",
        durationSec: 30 * 60,
        blockers: ["weather"],
        metadata: {
          tempTargetF: 0,
          donenessCue: "timer",
          cueNotes: "Keep produce shaded and cool while working.",
        },
      }
    );
  } else {
    steps.push({
      id: baseStepId("task"),
      title,
      desc:
        task.meta && task.meta.notes
          ? task.meta.notes
          : "Garden task from planting calendar.",
      durationSec: 20 * 60,
      blockers: ["weather"],
      metadata: {
        tempTargetF: 0,
        donenessCue: "timer",
        cueNotes: "",
      },
    });
  }

  return {
    id,
    domain: "garden",
    title,
    source: {
      type: "gardenPlan",
      refId:
        (task.links && (task.links.windowId || task.links.eventId)) || null,
    },
    steps,
    prefs: { voiceGuidance: true, haptic: true, autoAdvance: false },
    status: "pending",
    progress: {
      currentStepIndex: 0,
      elapsedSec: 0,
      startedAt: null,
      pausedAt: null,
    },
    analytics: {
      skippedSteps: [],
      adjustments: [],
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
