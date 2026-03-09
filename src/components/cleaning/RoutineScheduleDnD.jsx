// src/components/cleaning/RoutineScheduleDnD.jsx
import React, { useEffect, useMemo, useState, useCallback } from "react";
import { DndProvider, useDrag, useDrop } from "react-dnd";
import { HTML5Backend } from "react-dnd-html5-backend";
import { v4 as uuidv4 } from "uuid";
import {
  Play,
  Save,
  RefreshCcw,
  CalendarPlus,
  Sparkles,
  Undo2,
  Redo2,
  Trash2,
  Shield,
  DoorOpen,
  Inbox,
  Leaf,
} from "lucide-react";

import DraggableTaskBank from "./DraggableTaskBank";
import RoutineDropZone from "./RoutineDropZone";

/* --------------------------- Defensive dynamic imports --------------------------- */
let eventBus = { emit: () => {}, on: () => () => {} };
let automation = { queue: () => {}, invoke: async () => {} };
let CleaningPlanManager = null;
let PreferencesStore = {
  getState: () => ({ timezone: "America/New_York", sabbathAware: true }),
};
let deepCleanCadenceToRRULE = (x) =>
  "RRULE:FREQ=YEARLY;BYHOUR=9;BYMINUTE=0;BYSECOND=0";
let materializeStrategy = async () => ({ tasks: [] });

(async () => {
  try {
    ({ eventBus } = await import("@/services/events/eventBus"));
  } catch {}
  try {
    ({ automation } = await import("@/services/automation/runtime"));
  } catch {}
  try {
    ({ default: CleaningPlanManager } = await import(
      "@/managers/CleaningPlanManager"
    ));
  } catch {}
  try {
    const s = await import("@/data/organizingStrategies");
    deepCleanCadenceToRRULE =
      s?.deepCleanCadenceToRRULE || deepCleanCadenceToRRULE;
    materializeStrategy = s?.materializeStrategy || materializeStrategy;
  } catch {}
  try {
    const p = await import("@/store/PreferencesStore");
    PreferencesStore = p?.usePreferencesStore || PreferencesStore;
  } catch {}
})();

/* --------------------------------- Constants --------------------------------- */
const weekdays = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const LKEY = "suka:cleaning:routine-schedule:v1";

const DEFAULT_BANK = [
  { id: "task-1", name: "Sweep kitchen", area: "kitchen", estMinutes: 5 },
  { id: "task-2", name: "Wipe counters", area: "kitchen", estMinutes: 4 },
  {
    id: "task-3",
    name: "Disinfect doorknobs",
    area: "entry",
    estMinutes: 3,
    cadence: "weekly",
  },
  { id: "task-4", name: "Vacuum hallway", area: "living", estMinutes: 7 },
  { id: "task-5", name: "Take out trash", area: "kitchen", estMinutes: 3 },
  // Strategy-aligned seeds
  {
    id: "task-6",
    name: "Mail to basket (no counters)",
    area: "entry",
    estMinutes: 1,
    tags: ["paper-inbox"],
  },
  {
    id: "task-7",
    name: "Crumb wipe near pet bowls",
    area: "kitchen",
    estMinutes: 4,
    cadence: "monthly",
    tags: ["bug-shield"],
  },
  {
    id: "task-8",
    name: "Harvest basket to sink",
    area: "kitchen",
    estMinutes: 5,
    tags: ["harvest"],
  },
];

const cadenceOptions = [
  "daily",
  "weekly",
  "monthly",
  "quarterly",
  "bi-annual",
  "annual",
  "none",
];

/* --------------------------------- Utilities --------------------------------- */
const TZ = () => {
  try {
    return PreferencesStore.getState()?.timezone || "America/New_York";
  } catch {
    return "America/New_York";
  }
};
const SABBATH_AWARE = () => {
  try {
    return !!PreferencesStore.getState()?.sabbathAware;
  } catch {
    return true;
  }
};
const isSabbathApprox = (
  d = new Date(),
  tz = "America/New_York",
  aware = true
) => {
  if (!aware) return false;
  const dow = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    timeZone: tz,
  }).format(d);
  return dow === "Sat";
};
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const uid = () => uuidv4();

/* --------------------------------- Persistence -------------------------------- */
function loadState() {
  try {
    const raw = localStorage.getItem(LKEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function saveState(state) {
  try {
    localStorage.setItem(LKEY, JSON.stringify(state));
  } catch {}
}

/* --------------------------------- Undo/Redo --------------------------------- */
function useHistory(initial) {
  const [stack, setStack] = useState([initial]);
  const [i, setI] = useState(0);
  const value = stack[i];
  const canUndo = i > 0;
  const canRedo = i < stack.length - 1;
  const set = (next) => {
    const arr = stack.slice(0, i + 1).concat([next]);
    setStack(arr);
    setI(arr.length - 1);
  };
  const undo = () => canUndo && setI(i - 1);
  const redo = () => canRedo && setI(i + 1);
  return { value, set, undo, redo, canUndo, canRedo };
}

/* ------------------------------- react-dnd types ------------------------------ */
const DND_TYPE = "ROUTINE_TASK";

/* --------------------------------- Component --------------------------------- */
export default function RoutineScheduleDnD() {
  const tz = useMemo(() => TZ(), []);
  const sabbathAware = useMemo(() => SABBATH_AWARE(), []);
  const sabbathActive = isSabbathApprox(new Date(), tz, sabbathAware);

  const persisted = loadState();
  const [taskBank, setTaskBank] = useState(persisted?.taskBank || DEFAULT_BANK);

  const initialRoutine =
    persisted?.routine || Object.fromEntries(weekdays.map((day) => [day, []]));

  const routineHistory = useHistory(initialRoutine);
  const routine = routineHistory.value;

  const [name, setName] = useState(persisted?.name || "Weekly Home Rhythm");
  const [busy, setBusy] = useState(false);

  const totals = useMemo(() => {
    const map = {};
    for (const d of weekdays) {
      map[d] = (routine[d] || []).reduce(
        (acc, t) => acc + (t.estMinutes || 3),
        0
      );
    }
    return map;
  }, [routine]);

  useEffect(() => {
    saveState({ taskBank, routine, name });
  }, [taskBank, routine, name]);

  // Keyboard: Ctrl+S save, G generate, Ctrl+Z/Y undo/redo
  useEffect(() => {
    const onKey = (e) => {
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === "s") {
        e.preventDefault();
        handleSave();
      }
      if (!e.repeat && k === "g") handleGenerateRoutine();
      if ((e.ctrlKey || e.metaKey) && k === "z") {
        e.preventDefault();
        routineHistory.undo();
      }
      if (
        (e.ctrlKey || e.metaKey) &&
        (k === "y" || (k === "z" && e.shiftKey))
      ) {
        e.preventDefault();
        routineHistory.redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routine, name]);

  /* --------------------------------- DnD logic --------------------------------- */
  const setDay = useCallback(
    (day, list) => routineHistory.set({ ...routine, [day]: list }),
    [routine, routineHistory]
  );

  const moveTask = useCallback(
    (fromDay, toDay, fromIndex, toIndex) => {
      routineHistory.set(
        (() => {
          const r = routine;

          const src = Array.from(r[fromDay] || []);
          if (fromIndex < 0 || fromIndex >= src.length) return r;

          const [moved] = src.splice(fromIndex, 1);

          const dst = fromDay === toDay ? src : Array.from(r[toDay] || []);
          const safeIndex =
            typeof toIndex === "number"
              ? Math.max(0, Math.min(toIndex, dst.length))
              : dst.length;
          dst.splice(safeIndex, 0, moved);

          if (fromDay === toDay) {
            return { ...r, [toDay]: dst };
          }
          return { ...r, [fromDay]: src, [toDay]: dst };
        })()
      );
    },
    [routine, routineHistory]
  );

  const copyFromBankToDay = useCallback(
    (bankId, destDay, destIndex) => {
      const draggedTask = taskBank.find((t) => t.id === bankId);
      if (!draggedTask) return;

      const newTask = {
        uid: uid(),
        name: draggedTask.name,
        area: draggedTask.area || "entry",
        estMinutes: draggedTask.estMinutes || 3,
        cadence: draggedTask.cadence || null,
        sabbathBlocked: true,
        trigger: "onEntry",
        role: "household",
        tags: draggedTask.tags || [],
      };

      const list = Array.from(routine[destDay] || []);
      const safeIndex =
        typeof destIndex === "number"
          ? Math.max(0, Math.min(destIndex, list.length))
          : list.length;
      list.splice(safeIndex, 0, newTask);
      routineHistory.set({ ...routine, [destDay]: list });
    },
    [taskBank, routine, routineHistory]
  );

  /* --------------------------------- Helpers --------------------------------- */
  const applyCadenceToDay = (day, cadence) => {
    const list = (routine[day] || []).map((t) => ({
      ...t,
      cadence: cadence === "none" ? null : cadence,
    }));
    setDay(day, list);
    eventBus.emit("ui:toast", {
      type: "success",
      message: `Applied ${cadence} cadence to ${day}`,
    });
  };

  const clearDay = (day) => {
    const prev = routine;
    const next = { ...routine, [day]: [] };
    routineHistory.set(next);
    eventBus.emit("ui:toast:undo", {
      message: `Cleared ${day}`,
      actionLabel: "Undo",
      onAction: () => routineHistory.set(prev),
    });
  };

  const clearAll = () => {
    const prev = routine;
    const next = Object.fromEntries(weekdays.map((d) => [d, []]));
    routineHistory.set(next);
    eventBus.emit("ui:toast:undo", {
      message: "Cleared all days",
      actionLabel: "Undo",
      onAction: () => routineHistory.set(prev),
    });
  };

  const handleRemove = (day, idx) => {
    const list = Array.from(routine[day] || []);
    list.splice(idx, 1);
    setDay(day, list);
  };

  const handleSave = () => {
    saveState({ taskBank, routine, name });
    eventBus.emit("ui:toast", { type: "success", message: "Routine saved." });
  };

  const buildTasksForPlan = () => {
    const tasks = [];
    weekdays.forEach((day) => {
      (routine[day] || []).forEach((t) => {
        if (sabbathActive && t.sabbathBlocked) return; // guard
        tasks.push({
          id: t.uid || uid(),
          title: `${t.name} (${day})`,
          area: t.area || "entry",
          estMinutes: clamp(t.estMinutes || 3, 1, 180),
          priority: 2,
          cadence: t.cadence || null,
          meta: {
            trigger: t.trigger || "onEntry",
            role: t.role || "household",
            sabbathBlocked: !!t.sabbathBlocked,
            tags: t.tags || [],
            day,
          },
        });
      });
    });
    return tasks;
  };

  const scheduleCadenceTasks = (tasks) => {
    tasks
      .filter((t) => !!t.cadence)
      .forEach((t) => {
        const rrule = deepCleanCadenceToRRULE(t.cadence);
        eventBus.emit("calendar:create:rrule", {
          title: `Routine: ${t.title}`,
          area: t.area,
          rrule,
          tz,
          meta: {
            source: "RoutineScheduleDnD",
            cadence: t.cadence,
            day: t.meta?.day,
          },
        });
      });
  };

  const handleGenerateRoutine = async () => {
    const tasks = buildTasksForPlan();
    if (!tasks.length) {
      eventBus.emit("ui:toast", {
        type: "warning",
        message: "Add tasks to at least one day first.",
      });
      return;
    }
    // Create ad-hoc plan
    if (CleaningPlanManager?.createAdhocPlan) {
      try {
        const plan = CleaningPlanManager.createAdhocPlan({
          title: `${name} (Weekly)`,
          tasks,
          meta: {
            source: "RoutineScheduleDnD",
            createdAt: new Date().toISOString(),
          },
        });
        eventBus.emit("cleaning:plan:created", {
          planId: plan?.id,
          source: "routine-schedule",
        });
      } catch (e) {
        console.error(e);
        eventBus.emit("ui:toast", {
          type: "error",
          message: "Could not create cleaning plan.",
        });
      }
    }
    scheduleCadenceTasks(tasks);

    // Nudges
    if (tasks.some((t) => (t.meta?.tags || []).includes("paper-inbox"))) {
      automation.queue?.("UI:Nudge", {
        message: "Pin a weekly ‘Paper Inbox Zero’ block on your calendar?",
        actions: [
          { label: "Open Calendar", event: "ui:navigate", to: "/calendar" },
        ],
      });
    }
    if (tasks.some((t) => (t.meta?.tags || []).includes("harvest"))) {
      automation.queue?.("Inventory:SyncFromHarvestLog", { mode: "append" });
    }

    eventBus.emit("ui:toast", {
      type: "success",
      message: "Routine generated. Open Live Session to begin.",
    });
  };

  /* ------------------------------ Strategy shortcuts ------------------------------ */
  const injectStrategy = async (strategyId) => {
    setBusy(true);
    try {
      const res = await materializeStrategy(strategyId, {
        blockOnSabbath: true,
      });
      const tasks = res?.tasks || [];
      if (!tasks.length) {
        eventBus.emit("ui:toast", {
          type: "info",
          message: "No tasks returned from strategy.",
        });
        return;
      }
      // Put into Monday by default; user can drag around
      const mapped = tasks.map((t) => ({
        uid: t.id || uid(),
        name: t.title,
        area: t.area || "entry",
        estMinutes: clamp(t.estMinutes || 5, 1, 180),
        cadence: t.cadence || null,
        sabbathBlocked: t.meta?.sabbathBlocked !== false,
        trigger: t.meta?.trigger || "onEntry",
        role: t.meta?.role || "household",
        tags: t.meta?.tags || [],
      }));
      routineHistory.set({
        ...routine,
        Monday: [...(routine.Monday || []), ...mapped],
      });
      eventBus.emit("ui:toast", {
        type: "success",
        message:
          "Added suggested tasks to Monday. Drag to other days as needed.",
      });
    } catch (e) {
      console.error(e);
      eventBus.emit("ui:toast", {
        type: "error",
        message: "Could not add strategy tasks.",
      });
    } finally {
      setBusy(false);
    }
  };

  /* ----------------------------------- UI ----------------------------------- */
  return (
    <DndProvider backend={HTML5Backend}>
      <div className="p-4 md:p-6 bg-white border border-yellow-200 rounded-xl shadow-md">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <div className="flex items-center gap-2">
            <CalendarPlus className="w-5 h-5 text-gray-700" />
            <h2 className="text-lg font-semibold">
              Routine Schedule (Drag & Drop)
            </h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              className="btn"
              onClick={() => routineHistory.undo()}
              disabled={!routineHistory.canUndo}
            >
              <Undo2 className="w-4 h-4 mr-1" /> Undo
            </button>
            <button
              className="btn"
              onClick={() => routineHistory.redo()}
              disabled={!routineHistory.canRedo}
            >
              <Redo2 className="w-4 h-4 mr-1" /> Redo
            </button>
            <button className="btn" onClick={handleSave}>
              <Save className="w-4 h-4 mr-1" /> Save
            </button>
            <button className="btn btn-primary" onClick={handleGenerateRoutine}>
              <Play className="w-4 h-4 mr-1" /> Generate Routine
            </button>
          </div>
        </div>

        {/* Meta row */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
          <div className="p-3 border rounded-xl">
            <label className="text-xs text-gray-500">Routine name</label>
            <input
              className="w-full border rounded-lg px-3 py-2 mt-1"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Weekly Home Rhythm"
            />
          </div>
          <div className="p-3 border rounded-xl flex items-center justify-between">
            <div className="text-sm text-gray-700">
              Sabbath Guard: {sabbathAware ? "On" : "Off"}{" "}
              {sabbathActive && (
                <span className="ml-2 text-amber-600">(active now)</span>
              )}
            </div>
            <button
              className="btn"
              onClick={() => {
                const pref = PreferencesStore.getState?.() || {};
                if (PreferencesStore.setState) {
                  PreferencesStore.setState({
                    ...pref,
                    sabbathAware: !pref.sabbathAware,
                  });
                }
                eventBus.emit("ui:toast", {
                  type: "info",
                  message: "Toggled Sabbath guard in preferences.",
                });
              }}
            >
              Toggle
            </button>
          </div>
          <div className="p-3 border rounded-xl">
            <div className="text-xs text-gray-500 mb-1">
              Quick Add from Strategies
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                className="btn"
                disabled={busy}
                onClick={() => injectStrategy("daily-reset")}
              >
                <DoorOpen className="w-4 h-4 mr-1" /> Daily Reset
              </button>
              <button
                className="btn"
                disabled={busy}
                onClick={() => injectStrategy("bug-shield-perimeter")}
              >
                <Shield className="w-4 h-4 mr-1" /> Bug-Shield
              </button>
              <button
                className="btn"
                disabled={busy}
                onClick={() => injectStrategy("paper-inbox-zero")}
              >
                <Inbox className="w-4 h-4 mr-1" /> Paper Inbox
              </button>
              <button
                className="btn"
                disabled={busy}
                onClick={() => injectStrategy("garden-to-pantry")}
              >
                <Leaf className="w-4 h-4 mr-1" /> Harvest → Pantry
              </button>
            </div>
          </div>
        </div>

        {/* Task bank */}
        <BankWrapper taskBank={taskBank} />

        {/* Schedule grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mt-4">
          {weekdays.map((day) => (
            <DayPanel
              key={day}
              day={day}
              totals={totals[day]}
              tasks={routine[day]}
              sabbathActive={sabbathActive}
              onDropFromBank={(bankId, idx) =>
                copyFromBankToDay(bankId, day, idx)
              }
              onMoveTask={(fromDay, fromIndex, toIndex) =>
                moveTask(fromDay, day, fromIndex, toIndex)
              }
              onRemove={handleRemove}
              onApplyCadence={(cad) => applyCadenceToDay(day, cad)}
              onClear={() => clearDay(day)}
              cadenceOptions={cadenceOptions}
            />
          ))}
        </div>

        {/* Footer bar */}
        <div className="mt-4 p-3 border rounded-2xl bg-white">
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="btn"
              onClick={() =>
                eventBus.emit("ui:navigate", {
                  to: "/tier2/household/cleaning/live",
                })
              }
            >
              <Play className="w-4 h-4 mr-1" /> Open Live Session
            </button>
            <button
              className="btn"
              onClick={() => {
                const tasks = buildTasksForPlan();
                scheduleCadenceTasks(tasks);
                eventBus.emit("ui:toast", {
                  type: "success",
                  message: "Cadence items scheduled.",
                });
              }}
            >
              <CalendarPlus className="w-4 h-4 mr-1" /> Schedule Cadence
            </button>
            <button className="btn btn-danger" onClick={clearAll}>
              <Trash2 className="w-4 h-4 mr-1" /> Clear All
            </button>
            <button
              className="btn"
              onClick={() =>
                eventBus.emit("ui:refresh", { scope: "routine-schedule" })
              }
            >
              <RefreshCcw className="w-4 h-4 mr-1" /> Refresh
            </button>
            <div className="ml-auto text-sm text-gray-600 flex items-center gap-2">
              <Sparkles className="w-4 h-4" />
              Drag from the bank to any day. Use “Generate Routine” to create an
              ad-hoc plan.
            </div>
          </div>
        </div>

        <StyleSeed />
      </div>
    </DndProvider>
  );
}

/* ---------------------------- Bank wrapper (DnD) ---------------------------- */
/**
 * DraggableTaskBank already uses react-dnd primitives (Draggable/Droppable in that file).
 * So here we just render it inside the same DndProvider tree.
 */
function BankWrapper({ taskBank }) {
  return <DraggableTaskBank taskBank={taskBank} />;
}

/* ------------------------------- Day panel ------------------------------- */
function DayPanel({
  day,
  totals,
  tasks,
  sabbathActive,
  onDropFromBank,
  onMoveTask,
  onRemove,
  onApplyCadence,
  onClear,
  cadenceOptions,
}) {
  // Column drop: allow dropping to end of day
  const [{ isOver, canDrop }, dropRef] = useDrop(
    () => ({
      accept: DND_TYPE,
      drop: (item, monitor) => {
        if (monitor.didDrop()) return;
        if (!item) return;

        // item from bank
        if (item.from === "taskBank" && item.bankId) {
          onDropFromBank(item.bankId, (tasks || []).length);
          return;
        }

        // item from another day (or same day)
        if (item.fromDay && typeof item.fromIndex === "number") {
          onMoveTask(item.fromDay, item.fromIndex, (tasks || []).length);
          item.fromDay = day;
          item.fromIndex = (tasks || []).length - 1;
        }
      },
      collect: (monitor) => ({
        isOver: monitor.isOver({ shallow: true }),
        canDrop: monitor.canDrop(),
      }),
    }),
    [day, tasks, onDropFromBank, onMoveTask]
  );

  return (
    <div
      ref={dropRef}
      className={`border rounded-2xl p-3 ${
        isOver && canDrop ? "bg-yellow-50" : ""
      }`}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="font-medium">{day}</div>
        <div className="text-xs text-gray-500">{totals} min</div>
      </div>

      <RoutineDropZone
        day={day}
        tasks={tasks}
        onRemove={onRemove}
        // We rely on RoutineDropZone to render items; it must be react-dnd based elsewhere.
        // If RoutineDropZone is still @hello-pangea/dnd based, you will need the same conversion there too.
        onMoveTask={onMoveTask}
        onDropFromBank={onDropFromBank}
        sabbathActive={sabbathActive}
      />

      {/* Day actions */}
      <div className="mt-3 flex flex-wrap gap-2">
        <select
          className="border rounded-lg px-2 py-1 text-sm"
          onChange={(e) => onApplyCadence(e.target.value)}
          defaultValue="__"
        >
          <option value="__">Apply cadence…</option>
          {cadenceOptions.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <button className="btn" onClick={onClear}>
          <Trash2 className="w-4 h-4 mr-1" /> Clear
        </button>
      </div>
    </div>
  );
}

/* ------------------------------- Inline styles ------------------------------- */
function StyleSeed() {
  if (typeof document === "undefined") return null;
  const id = "routine-schedule-inline-styles";
  if (document.getElementById(id)) return null;
  const style = document.createElement("style");
  style.id = id;
  style.innerHTML = `
    .btn {
      display:inline-flex;align-items:center;justify-content:center;
      border:1px solid rgb(229,231,235);border-radius:0.75rem;
      padding:0.5rem 0.75rem;font-size:0.875rem;background:white;color:rgb(55,65,81);
    }
    .btn:hover { background: rgb(249,250,251); }
    .btn-primary { background: rgb(17,24,39); color: white; border-color: rgb(17,24,39); }
    .btn-primary:hover { background: black; }
    .btn-danger { color: rgb(220,38,38); border-color: rgb(252,165,165); }
  `;
  document.head.appendChild(style);
  return null;
}
