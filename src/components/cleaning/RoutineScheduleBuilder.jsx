// src/components/cleaning/RoutineScheduleBuilder.jsx
import React, { useEffect, useMemo, useState, useCallback } from "react";
import { Trash2, CalendarDays, Clock, Plus, Timer, Wrench, Droplet, AlertTriangle } from "lucide-react";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import { v4 as uuidv4 } from "uuid";

/** ----------------------------------------------------------------------
 * RoutineScheduleBuilder — weekly board with inventory-aware task cards
 * -----------------------------------------------------------------------
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
const DEFAULT_WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const KEY_STORAGE = "routineSchedule.v1";
const iso = (d = new Date()) => new Date(d).toISOString();

function prettyKey(k = "") { return k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()); }
function keyOf(x) { return (x && (x.key || x.id)) || ""; }
function setFrom(list = []) { const s = new Set(); list.forEach((x) => s.add(keyOf(x))); return s; }
function isSabbath(dateObj, { saturdayAsSabbath = false, hebrewDayOfWeek } = {}) {
  if (saturdayAsSabbath) return dateObj.getDay() === 6; // Saturday
  if (typeof hebrewDayOfWeek === "function") return hebrewDayOfWeek(dateObj) === 7; // Hebrew Day-7
  return false;
}
function computeMissing(task = {}, invSet = new Set(), equipSet = new Set()) {
  const supplies = Array.isArray(task.supplies) ? task.supplies : [];
  const tools = Array.isArray(task.tools) ? task.tools : [];
  return {
    missingSupplies: supplies.filter((k) => !invSet.has(k)).map((k) => ({ key: k, name: prettyKey(k) })),
    missingTools: tools.filter((k) => !equipSet.has(k)).map((k) => ({ key: k, name: prettyKey(k) })),
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
    const seed = initialRoutine || Object.fromEntries(defaultWeekdays.map((d) => [d, []]));
    return seed;
  });

  // inventory/tool sets for quick checks
  const invSet = useMemo(() => setFrom(inventory), [inventory]);
  const equipSet = useMemo(() => setFrom(equipment), [equipment]);

  // persistence
  useEffect(() => {
    try { localStorage.setItem(KEY_STORAGE, JSON.stringify(routine)); } catch {}
    try { onChange && onChange(routine); } catch {}
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
    setRoutine((r) => ({ ...r, [selectedDay]: [...(r[selectedDay] || []), newTask] }));
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

  const onDragEnd = useCallback((result) => {
    const { source, destination } = result;
    if (!destination) return;
    const sourceDay = source.droppableId;
    const destDay = destination.droppableId;

    setRoutine((r) => {
      const from = [...(r[sourceDay] || [])];
      const [dragged] = from.splice(source.index, 1);
      const to = [...(r[destDay] || [])];
      to.splice(destination.index, 0, dragged);
      return { ...r, [sourceDay]: from, [destDay]: to };
    });
  }, []);

  // helpers
  function dayTotalMin(day) {
    return (routine[day] || []).reduce((a, t) => a + (Number(t.estMin) || 0), 0);
  }
  function dayMissingCounts(day) {
    const tasks = routine[day] || [];
    let ms = 0, mt = 0;
    tasks.forEach((t) => {
      const gaps = computeMissing(t, invSet, equipSet);
      ms += gaps.missingSupplies.length;
      mt += gaps.missingTools.length;
    });
    return { supplies: ms, tools: mt };
  }

  const sabbathHintActive = useMemo(() => isSabbath(new Date(), { saturdayAsSabbath, hebrewDayOfWeek }), [saturdayAsSabbath, hebrewDayOfWeek]);

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
    const payload = { source: "RoutineScheduleBuilder", createdAt: iso(), tasks: batch };
    try { bus.emit && bus.emit("tasks/createBatch", payload); } catch {}
    try { onExport && onExport(payload); } catch {}
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
    const payload = { source: "RoutineScheduleBuilder", schedules, requireApproval: true };
    try { bus.emit && bus.emit("calendar/scheduleWeeklyTemplates", payload); } catch {}
  }

  return (
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
            <option key={day} value={day}>{day}</option>
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
        >
          <Plus size={16} /> Add Task
        </button>
      </div>

      <DragDropContext onDragEnd={onDragEnd}>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {defaultWeekdays.map((day, idx) => {
            const isSaturday = day === "Saturday";
            const dropDisabled = saturdayAsSabbath && isSaturday;
            const totals = dayTotalMin(day);
            const missing = dayMissingCounts(day);
            return (
              <Droppable key={day} droppableId={day} isDropDisabled={dropDisabled}>
                {(provided, snapshot) => (
                  <div
                    ref={provided.innerRef}
                    {...provided.droppableProps}
                    className={`mb-5 rounded p-4 border transition-colors
                      ${dropDisabled ? "bg-slate-50 border-slate-200 opacity-75"
                                      : snapshot.isDraggingOver ? "bg-yellow-50 border-yellow-300"
                                      : "bg-yellow-50/70 border-yellow-200"}`}
                    aria-disabled={dropDisabled}
                  >
                    <h3 className="text-lg font-semibold text-yellow-700 mb-2 flex items-center gap-2">
                      <CalendarDays size={20} /> {day}
                      <span className="text-xs text-stone-500">• {routine[day]?.length || 0} task{(routine[day]?.length || 0) !== 1 ? "s" : ""}</span>
                      {totals > 0 ? <span className="text-xs text-stone-500">• {totals} min</span> : null}
                      {(missing.supplies + missing.tools) > 0 ? (
                        <span className="text-[11px] inline-flex items-center gap-1 text-amber-700 ml-2">
                          <AlertTriangle size={14} /> {missing.tools} tool{missing.tools !== 1 ? "s" : ""} • {missing.supplies} supply
                        </span>
                      ) : null}
                      {dropDisabled && sabbathHintActive && (
                        <span className="ml-auto text-[11px] text-emerald-700">Sabbath (drop disabled)</span>
                      )}
                    </h3>

                    {routine[day]?.length === 0 ? (
                      <p className="text-stone-400 italic">No tasks scheduled</p>
                    ) : (
                      <ul className="space-y-2">
                        {(routine[day] || []).map((task, idx) => (
                          <Draggable key={task.id} draggableId={task.id} index={idx}>
                            {(dragProvided, dragSnapshot) => (
                              <li
                                ref={dragProvided.innerRef}
                                {...dragProvided.draggableProps}
                                {...dragProvided.dragHandleProps}
                                className={`flex items-start justify-between p-3 bg-white border rounded shadow-sm
                                            ${dragSnapshot.isDragging ? "border-yellow-300 shadow-md" : "border-yellow-300"}`}
                              >
                                <div className="min-w-0 pr-3">
                                  <span className="block font-medium text-stone-700 truncate">{task.name}</span>
                                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                                    {task.estMin ? <Badge icon={Timer} title={`Estimated ${task.estMin} min`}>{task.estMin}m</Badge> : null}
                                    {Array.isArray(task.tools) && task.tools.length ? (
                                      <Badge icon={Wrench} title={`${task.tools.length} tool(s)`}>{task.tools.length}</Badge>
                                    ) : null}
                                    {Array.isArray(task.supplies) && task.supplies.length ? (
                                      <Badge icon={Droplet} title={`${task.supplies.length} supply item(s)`}>{task.supplies.length}</Badge>
                                    ) : null}
                                    {(() => {
                                      const gaps = computeMissing(task, invSet, equipSet);
                                      const needCount = gaps.missingSupplies.length + gaps.missingTools.length;
                                      return needCount ? (
                                        <Badge icon={AlertTriangle} title="Requirements missing">
                                          {gaps.missingTools.length ? `${gaps.missingTools.length} tool` : ""}
                                          {gaps.missingTools.length && gaps.missingSupplies.length ? " • " : ""}
                                          {gaps.missingSupplies.length ? `${gaps.missingSupplies.length} supply` : ""}
                                        </Badge>
                                      ) : null;
                                    })()}
                                  </div>
                                </div>

                                <div className="flex items-center gap-2 shrink-0">
                                  <input
                                    type="time"
                                    value={task.time || ""}
                                    onChange={(e) => updateTime(day, idx, e.target.value)}
                                    className="border border-stone-300 rounded px-2 py-1"
                                    aria-label={`Time for ${task.name}`}
                                  />
                                  <button
                                    onClick={() => removeTask(day, idx)}
                                    className="text-red-500 hover:text-red-700"
                                    aria-label={`Remove ${task.name}`}
                                    title="Remove"
                                  >
                                    <Trash2 size={18} />
                                  </button>
                                </div>
                              </li>
                            )}
                          </Draggable>
                        ))}
                        {provided.placeholder}
                      </ul>
                    )}
                  </div>
                )}
              </Droppable>
            );
          })}
        </div>
      </DragDropContext>

      {/* Automation Trigger */}
      <div className="mt-6 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div className="p-4 bg-yellow-100 rounded border border-yellow-300 text-sm text-yellow-800">
          <Clock className="inline-block mr-2" size={16} />
          This schedule can be linked to notifications, reminders, or routine sessions.
        </div>
        <div className="flex gap-2">
          <button
            onClick={sendToTaskBoard}
            className="px-3 py-2 rounded border bg-white hover:bg-slate-50"
          >
            Send Week to Task Board
          </button>
          <button
            onClick={scheduleOnCalendar}
            className="px-3 py-2 rounded border bg-white hover:bg-slate-50"
          >
            Schedule (Template)
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Tiny self-tests (run once in dev-like environments) */
(function runSelfTests() {
  try {
    // Missing requirement detection
    const invSet = setFrom([{ key: "sr_all_purpose", qty: 1 }]);
    const eqSet = setFrom([{ key: "tl_microfiber", qty: 4 }, { key: "tl_bucket", qty: 1 }]);
    const task = {
      id: "t1",
      name: "Fridge Deep Clean",
      estMin: 40,
      supplies: ["sr_all_purpose", "sr_powder_scrub"],
      tools: ["tl_microfiber", "tl_bucket", "tl_squeegee"],
    };
    const gaps = computeMissing(task, invSet, eqSet);
    console.assert(gaps.missingSupplies.length === 1 && gaps.missingSupplies[0].key === "sr_powder_scrub", "[TEST] detects missing supply");
    console.assert(gaps.missingTools.length === 1 && gaps.missingTools[0].key === "tl_squeegee", "[TEST] detects missing tool");

    // Sabbath logic (proxy Saturday)
    const sat = new Date("2025-10-11T12:00:00Z"); // Saturday
    console.assert(isSabbath(sat, { saturdayAsSabbath: true }) === true, "[TEST] saturdayAsSabbath works");
    console.assert(isSabbath(sat, { hebrewDayOfWeek: () => 7 }) === true, "[TEST] hebrewDayOfWeek works");
  } catch (e) {
    if (typeof console !== "undefined") console.warn("RoutineScheduleBuilder self-tests skipped/failed:", e?.message || e);
  }
})();
