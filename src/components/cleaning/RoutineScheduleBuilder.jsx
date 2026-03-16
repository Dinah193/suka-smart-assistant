// src/components/cleaning/RoutineScheduleBuilder.jsx
import React, { useEffect, useMemo, useState, useCallback } from "react";
import {
  Trash2,
  CalendarDays,
  Clock,
  Plus,
  Timer,
  Wrench,
  Droplet,
  AlertTriangle,
} from "lucide-react";
import { DndProvider, useDrag, useDrop } from "react-dnd";
import { HTML5Backend } from "react-dnd-html5-backend";
import { v4 as uuidv4 } from "uuid";

/** ----------------------------------------------------------------------
 * RoutineScheduleBuilder — weekly board with inventory-aware task cards
 * -----------------------------------------------------------------------
 * BUILD FIX:
 *  - Removes dependency on "@hello-pangea/dnd" (not resolving in prod build)
 *  - Uses react-dnd (already present in your build output)
 *
 * Backward compatible: no props required.
 *
 * Optional props (all safe to omit):
 *  - initialRoutine?: Record<Weekday, Task[]>
 *  - defaultWeekdays?: string[]               // fallback to Sun..Sat
 *  - inventory?: Array<{key|id:string, qty:number}>
 *  - equipment?: Array<{key|id:string, qty?:number}>
 *  - saturdayAsSabbath?: boolean              // lock Saturday column for drop
 *  - hebrewDayOfWeek?: (Date) => number       // if provided, UI hint uses Hebrew Day-7
 *  - onChange?: (routine) => void             // called after any change
 *  - onExport?: (payload) => void             // when “Send to Task Board” runs
 *  - title?: string
 *
 * Task shape (flexible):
 *  { id, name, time?: "HH:MM", estMin?: number, supplies?: string[], tools?: string[], tags?: string[] }
 */

// ------------------------- utilities -------------------------
const DEFAULT_WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const KEY_STORAGE = "routineSchedule.v1";
const iso = (d = new Date()) => new Date(d).toISOString();

function prettyKey(k = "") {
  return k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
function keyOf(x) {
  return (x && (x.key || x.id)) || "";
}
function setFrom(list = []) {
  const s = new Set();
  list.forEach((x) => s.add(keyOf(x)));
  return s;
}
function isSabbath(
  dateObj,
  { saturdayAsSabbath = false, hebrewDayOfWeek } = {}
) {
  if (saturdayAsSabbath) return dateObj.getDay() === 6; // Saturday
  if (typeof hebrewDayOfWeek === "function")
    return hebrewDayOfWeek(dateObj) === 7; // Hebrew Day-7
  return false;
}
function computeMissing(task = {}, invSet = new Set(), equipSet = new Set()) {
  const supplies = Array.isArray(task.supplies) ? task.supplies : [];
  const tools = Array.isArray(task.tools) ? task.tools : [];
  return {
    missingSupplies: supplies
      .filter((k) => !invSet.has(k))
      .map((k) => ({ key: k, name: prettyKey(k) })),
    missingTools: tools
      .filter((k) => !equipSet.has(k))
      .map((k) => ({ key: k, name: prettyKey(k) })),
  };
}
function Badge({ icon: Icon, title, children }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] leading-tight
                 border-slate-200 text-slate-600 bg-slate-50"
      title={title}
      aria-label={title}
    >
      {Icon ? <Icon size={12} aria-hidden /> : null}
      {children}
    </span>
  );
}

// Safe, sandbox-friendly bus shims
async function _useAutomationBus() {
  return { emit: () => {}, invoke: async () => {} };
}

const DND_TYPE = "ROUTINE_TASK";

// ------------------------- DnD helpers -------------------------

function DayColumn({
  day,
  idx,
  dropDisabled,
  snapshotHint,
  header,
  children,
  onDropToEnd,
}) {
  const [{ isOver, canDrop }, dropRef] = useDrop(
    () => ({
      accept: DND_TYPE,
      canDrop: () => !dropDisabled,
      drop: (item, monitor) => {
        if (monitor.didDrop()) return;
        if (dropDisabled) return;
        onDropToEnd(item);
      },
      collect: (monitor) => ({
        isOver: monitor.isOver({ shallow: true }),
        canDrop: monitor.canDrop(),
      }),
    }),
    [dropDisabled, onDropToEnd]
  );

  const bgClass = dropDisabled
    ? "bg-slate-50 border-slate-200 opacity-75"
    : isOver && canDrop
    ? "bg-yellow-50 border-yellow-300"
    : "bg-yellow-50/70 border-yellow-200";

  return (
    <div
      ref={dropRef}
      className={`mb-5 rounded p-4 border transition-colors ${bgClass}`}
      aria-disabled={dropDisabled}
      data-weekday={day}
      data-weekday-index={idx}
      title={dropDisabled ? snapshotHint || "" : undefined}
    >
      {header}
      {children}
    </div>
  );
}

function DraggableTaskRow({
  task,
  day,
  idx,
  invSet,
  equipSet,
  updateTime,
  removeTask,
  moveTask,
  dropDisabled,
}) {
  const [{ isDragging }, dragRef] = useDrag(
    () => ({
      type: DND_TYPE,
      item: {
        id: task.id,
        fromDay: day,
        fromIndex: idx,
      },
      canDrag: () => !dropDisabled,
      collect: (monitor) => ({
        isDragging: monitor.isDragging(),
      }),
    }),
    [task.id, day, idx, dropDisabled]
  );

  const [{ isOver, canDrop }, dropRef] = useDrop(
    () => ({
      accept: DND_TYPE,
      canDrop: (item) => {
        // allow reordering across days unless destination day is locked
        return !dropDisabled;
      },
      hover: (item, monitor) => {
        if (!monitor.isOver({ shallow: true })) return;
        if (dropDisabled) return;

        const fromDay = item.fromDay;
        const fromIndex = item.fromIndex;

        const toDay = day;
        const toIndex = idx;

        // No-op if same position
        if (fromDay === toDay && fromIndex === toIndex) return;

        // Move task in state
        moveTask(fromDay, toDay, fromIndex, toIndex);

        // Mutate the drag item so subsequent hovers are consistent
        item.fromDay = toDay;
        item.fromIndex = toIndex;
      },
      collect: (monitor) => ({
        isOver: monitor.isOver({ shallow: true }),
        canDrop: monitor.canDrop(),
      }),
    }),
    [day, idx, moveTask, dropDisabled]
  );

  const gaps = computeMissing(task, invSet, equipSet);
  const needCount = gaps.missingSupplies.length + gaps.missingTools.length;

  const borderClass = dropDisabled
    ? "border-slate-200"
    : isOver && canDrop
    ? "border-yellow-300 shadow-md"
    : "border-yellow-300";

  const opacityClass = isDragging ? "opacity-70" : "";

  return (
    <li
      ref={(node) => {
        // compose refs: drop target + drag source on same node
        dropRef(node);
        dragRef(node);
      }}
      className={`flex items-start justify-between p-3 bg-white border rounded shadow-sm ${borderClass} ${opacityClass}`}
      aria-grabbed={isDragging}
    >
      <div className="min-w-0 pr-3">
        <span className="block font-medium text-stone-700 truncate">
          {task.name}
        </span>
        <div className="flex items-center gap-2 mt-1 flex-wrap">
          {task.estMin ? (
            <Badge icon={Timer} title={`Estimated ${task.estMin} min`}>
              {task.estMin}m
            </Badge>
          ) : null}
          {Array.isArray(task.tools) && task.tools.length ? (
            <Badge icon={Wrench} title={`${task.tools.length} tool(s)`}>
              {task.tools.length}
            </Badge>
          ) : null}
          {Array.isArray(task.supplies) && task.supplies.length ? (
            <Badge
              icon={Droplet}
              title={`${task.supplies.length} supply item(s)`}
            >
              {task.supplies.length}
            </Badge>
          ) : null}
          {needCount ? (
            <Badge icon={AlertTriangle} title="Requirements missing">
              {gaps.missingTools.length
                ? `${gaps.missingTools.length} tool`
                : ""}
              {gaps.missingTools.length && gaps.missingSupplies.length
                ? " • "
                : ""}
              {gaps.missingSupplies.length
                ? `${gaps.missingSupplies.length} supply`
                : ""}
            </Badge>
          ) : null}
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <input
          type="time"
          value={task.time || ""}
          onChange={(e) => updateTime(day, idx, e.target.value)}
          className="border border-stone-300 rounded px-2 py-1"
          aria-label={`Time for ${task.name}`}
          disabled={false}
        />
        <button
          onClick={() => removeTask(day, idx)}
          className="text-red-500 hover:text-red-700"
          aria-label={`Remove ${task.name}`}
          title="Remove"
          type="button"
        >
          <Trash2 size={18} />
        </button>
      </div>
    </li>
  );
}

// ------------------------- component -------------------------
export default function RoutineScheduleBuilder({
  initialRoutine,
  defaultWeekdays = DEFAULT_WEEKDAYS,
  inventory = [],
  equipment = [],
  saturdayAsSabbath = false,
  hebrewDayOfWeek,
  onChange,
  onExport,
  title = "🧹 Weekly Cleaning Routine Builder",
}) {
  const [selectedDay, setSelectedDay] = useState("Monday");
  const [taskInput, setTaskInput] = useState("");
  const [estInput, setEstInput] = useState(""); // minutes (optional)
  const [routine, setRoutine] = useState(() => {
    try {
      const restored = JSON.parse(localStorage.getItem(KEY_STORAGE) || "null");
      if (restored && typeof restored === "object") return restored;
    } catch {}
    const seed =
      initialRoutine || Object.fromEntries(defaultWeekdays.map((d) => [d, []]));
    return seed;
  });

  // inventory/tool sets for quick checks
  const invSet = useMemo(() => setFrom(inventory), [inventory]);
  const equipSet = useMemo(() => setFrom(equipment), [equipment]);

  // persistence
  useEffect(() => {
    try {
      localStorage.setItem(KEY_STORAGE, JSON.stringify(routine));
    } catch {}
    try {
      onChange && onChange(routine);
    } catch {}
  }, [routine, onChange]);

  const addTask = useCallback(() => {
    if (!taskInput.trim()) return;
    const est = Number(estInput);
    const newTask = {
      id: uuidv4(),
      name: taskInput.trim(),
      time: "",
      estMin: Number.isFinite(est) && est > 0 ? est : undefined,
      // callers may enrich via edit UI elsewhere (supplies/tools/tags)
    };
    setRoutine((r) => ({
      ...r,
      [selectedDay]: [...(r[selectedDay] || []), newTask],
    }));
    setTaskInput("");
    setEstInput("");
  }, [taskInput, estInput, selectedDay]);

  const removeTask = useCallback((day, idx) => {
    setRoutine((r) => {
      const clone = { ...r, [day]: [...(r[day] || [])] };
      clone[day].splice(idx, 1);
      return clone;
    });
  }, []);

  const updateTime = useCallback((day, idx, time) => {
    setRoutine((r) => {
      const list = [...(r[day] || [])];
      list[idx] = { ...list[idx], time };
      return { ...r, [day]: list };
    });
  }, []);

  const moveTask = useCallback((fromDay, toDay, fromIndex, toIndex) => {
    setRoutine((r) => {
      const fromList = [...(r[fromDay] || [])];
      const toList = fromDay === toDay ? fromList : [...(r[toDay] || [])];

      if (fromIndex < 0 || fromIndex >= fromList.length) return r;

      const [dragged] = fromList.splice(fromIndex, 1);

      const safeIndex =
        typeof toIndex === "number"
          ? Math.max(0, Math.min(toIndex, toList.length))
          : toList.length;

      toList.splice(safeIndex, 0, dragged);

      if (fromDay === toDay) {
        return { ...r, [toDay]: toList };
      }

      return { ...r, [fromDay]: fromList, [toDay]: toList };
    });
  }, []);

  // helpers
  function dayTotalMin(day) {
    return (routine[day] || []).reduce(
      (a, t) => a + (Number(t.estMin) || 0),
      0
    );
  }
  function dayMissingCounts(day) {
    const tasks = routine[day] || [];
    let ms = 0,
      mt = 0;
    tasks.forEach((t) => {
      const gaps = computeMissing(t, invSet, equipSet);
      ms += gaps.missingSupplies.length;
      mt += gaps.missingTools.length;
    });
    return { supplies: ms, tools: mt };
  }

  const sabbathHintActive = useMemo(
    () => isSabbath(new Date(), { saturdayAsSabbath, hebrewDayOfWeek }),
    [saturdayAsSabbath, hebrewDayOfWeek]
  );

  // exports
  async function sendToTaskBoard() {
    const bus = await _useAutomationBus();
    const batch = [];
    defaultWeekdays.forEach((day) => {
      (routine[day] || []).forEach((t) => {
        batch.push({
          id: t.id,
          title: `${t.name} — ${day}${t.time ? ` @ ${t.time}` : ""}`,
          labels: ["cleaning", "routine", day.toLowerCase()],
          estMin: t.estMin || 10,
          when: t.time || null,
          supplies: t.supplies || [],
          tools: t.tools || [],
        });
      });
    });
    const payload = {
      source: "RoutineScheduleBuilder",
      createdAt: iso(),
      tasks: batch,
    };
    try {
      bus.emit && bus.emit("tasks/createBatch", payload);
    } catch {}
    try {
      onExport && onExport(payload);
    } catch {}
  }

  async function scheduleOnCalendar() {
    const bus = await _useAutomationBus();
    // Create a simple weekly schedule (no RRULE to keep sandbox-safe)
    const schedules = [];
    defaultWeekdays.forEach((day, dayIndex) => {
      (routine[day] || []).forEach((t) => {
        schedules.push({
          title: `Routine: ${t.name}`,
          weekdayIndex: dayIndex, // consumer can interpret 0..6 (Sun..Sat)
          time: t.time || "09:00",
          durationMin: t.estMin || 30,
          metadata: { supplies: t.supplies || [], tools: t.tools || [] },
        });
      });
    });
    const payload = {
      source: "RoutineScheduleBuilder",
      schedules,
      requireApproval: true,
    };
    try {
      bus.emit && bus.emit("calendar/scheduleWeeklyTemplates", payload);
    } catch {}
  }

  return (
    <DndProvider backend={HTML5Backend}>
      <div className="p-6 bg-white rounded-xl border border-yellow-300 shadow-md">
        <h2 className="text-2xl font-bold text-yellow-700 mb-4">{title}</h2>

        {/* Task Assignment */}
        <div className="flex flex-col md:flex-row gap-4 mb-6">
          <select
            value={selectedDay}
            onChange={(e) => setSelectedDay(e.target.value)}
            className="border border-stone-300 px-3 py-2 rounded"
            aria-label="Select day to add task to"
          >
            {defaultWeekdays.map((day) => (
              <option key={day} value={day}>
                {day}
              </option>
            ))}
          </select>

          <input
            type="text"
            placeholder="e.g. Sweep kitchen, Dust shelves"
            value={taskInput}
            onChange={(e) => setTaskInput(e.target.value)}
            className="flex-1 border border-stone-300 px-3 py-2 rounded"
            aria-label="Task name"
          />

          <input
            type="number"
            min={0}
            inputMode="numeric"
            placeholder="min"
            value={estInput}
            onChange={(e) => setEstInput(e.target.value)}
            className="w-[100px] border border-stone-300 px-3 py-2 rounded"
            aria-label="Estimated minutes (optional)"
          />

          <button
            onClick={addTask}
            className="bg-yellow-500 hover:bg-yellow-600 text-white px-4 py-2 rounded inline-flex items-center gap-2"
            aria-label="Add task"
            type="button"
          >
            <Plus size={16} /> Add Task
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {defaultWeekdays.map((day, columnIndex) => {
            const isSaturday = day === "Saturday";
            const dropDisabled = saturdayAsSabbath && isSaturday;

            const totals = dayTotalMin(day);
            const missing = dayMissingCounts(day);

            const header = (
              <h3 className="text-lg font-semibold text-yellow-700 mb-2 flex items-center gap-2">
                <CalendarDays size={20} /> {day}
                <span className="text-xs text-stone-500">
                  • {routine[day]?.length || 0} task
                  {(routine[day]?.length || 0) !== 1 ? "s" : ""}
                </span>
                {totals > 0 ? (
                  <span className="text-xs text-stone-500">• {totals} min</span>
                ) : null}
                {missing.supplies + missing.tools > 0 ? (
                  <span className="text-[11px] inline-flex items-center gap-1 text-amber-700 ml-2">
                    <AlertTriangle size={14} /> {missing.tools} tool
                    {missing.tools !== 1 ? "s" : ""} • {missing.supplies} supply
                  </span>
                ) : null}
                {dropDisabled && sabbathHintActive && (
                  <span className="ml-auto text-[11px] text-emerald-700">
                    Sabbath (drop disabled)
                  </span>
                )}
              </h3>
            );

            return (
              <DayColumn
                key={day}
                day={day}
                idx={columnIndex}
                dropDisabled={dropDisabled}
                snapshotHint="Sabbath (drop disabled)"
                header={header}
                onDropToEnd={(item) => {
                  // if user drops into column (not onto a task), append to end
                  if (dropDisabled) return;
                  const fromDay = item?.fromDay;
                  const fromIndex = item?.fromIndex;
                  if (!fromDay || typeof fromIndex !== "number") return;
                  moveTask(
                    fromDay,
                    day,
                    fromIndex,
                    (routine[day] || []).length
                  );
                  // update drag item for consistency
                  item.fromDay = day;
                  item.fromIndex = (routine[day] || []).length - 1;
                }}
              >
                {routine[day]?.length === 0 ? (
                  <p className="text-stone-400 italic">No tasks scheduled</p>
                ) : (
                  <ul className="space-y-2">
                    {(routine[day] || []).map((task, taskIndex) => (
                      <DraggableTaskRow
                        key={task.id}
                        task={task}
                        day={day}
                        idx={taskIndex}
                        invSet={invSet}
                        equipSet={equipSet}
                        updateTime={updateTime}
                        removeTask={removeTask}
                        moveTask={moveTask}
                        dropDisabled={dropDisabled}
                      />
                    ))}
                  </ul>
                )}
              </DayColumn>
            );
          })}
        </div>

        {/* Automation Trigger */}
        <div className="mt-6 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div className="p-4 bg-yellow-100 rounded border border-yellow-300 text-sm text-yellow-800">
            <Clock className="inline-block mr-2" size={16} />
            This schedule can be linked to notifications, reminders, or routine
            sessions.
          </div>
          <div className="flex gap-2">
            <button
              onClick={sendToTaskBoard}
              className="px-3 py-2 rounded border bg-white hover:bg-slate-50"
              type="button"
            >
              Send Week to Task Board
            </button>
            <button
              onClick={scheduleOnCalendar}
              className="px-3 py-2 rounded border bg-white hover:bg-slate-50"
              type="button"
            >
              Schedule (Template)
            </button>
          </div>
        </div>
      </div>
    </DndProvider>
  );
}

/* ------------------------------------------------------------------ */
/* Tiny self-tests (run once in dev-like environments) */
(function runSelfTests() {
  try {
    // Missing requirement detection
    const invSet = setFrom([{ key: "sr_all_purpose", qty: 1 }]);
    const eqSet = setFrom([
      { key: "tl_microfiber", qty: 4 },
      { key: "tl_bucket", qty: 1 },
    ]);
    const task = {
      id: "t1",
      name: "Fridge Deep Clean",
      estMin: 40,
      supplies: ["sr_all_purpose", "sr_powder_scrub"],
      tools: ["tl_microfiber", "tl_bucket", "tl_squeegee"],
    };
    const gaps = computeMissing(task, invSet, eqSet);
    console.assert(
      gaps.missingSupplies.length === 1 &&
        gaps.missingSupplies[0].key === "sr_powder_scrub",
      "[TEST] detects missing supply"
    );
    console.assert(
      gaps.missingTools.length === 1 &&
        gaps.missingTools[0].key === "tl_squeegee",
      "[TEST] detects missing tool"
    );

    // Sabbath logic (proxy Saturday)
    const sat = new Date("2025-10-11T12:00:00Z"); // Saturday
    console.assert(
      isSabbath(sat, { saturdayAsSabbath: true }) === true,
      "[TEST] saturdayAsSabbath works"
    );
    console.assert(
      isSabbath(sat, { hebrewDayOfWeek: () => 7 }) === true,
      "[TEST] hebrewDayOfWeek works"
    );
  } catch (e) {
    if (typeof console !== "undefined")
      console.warn(
        "RoutineScheduleBuilder self-tests skipped/failed:",
        e?.message || e
      );
  }
})();
