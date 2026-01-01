/* eslint-disable no-console */
// src/pages/animals/BarnPlanView.jsx
//
// BarnPlanView — Feed • Water • Vaccinate • Pasture Rotation • Breeding
// --------------------------------------------------------------------------------------
// Cohesive, pragmatic planner for daily/weekly animal care:
// • Slot/task board tuned for livestock chores with jump-to navigation & timers
// • Subdomain filters (feed, water, health, breeding, pasture, cleaning)
// • Shortage bridge (feed & meds) → “Jump to Grocery”
// • Pasture rotation helper (rest-day targets, next paddock suggestion, schedule move)
// • Breeding tracker (heat checks, AI windows, due dates) → quick add tasks
// • Vaccination due list → quick add tasks
// • Sabbath Guard aware, with optional “welfare override” for essential chores
//
// Inspirations: Notion (clarity), Linear (speed), FarmOS/FarmWizard (domain cues)

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { addDays, addMinutes, differenceInDays, format, isAfter, isPast, isToday, parseISO } from "date-fns";

// ---------------- Defensive service/context imports ----------------
let eventBus;
try {
  eventBus = require("../../services/eventBus").default;
} catch {
  eventBus = {
    emit: (...args) => console.debug("[BarnPlanView:eventBus.emit]", ...args),
    on: () => () => {},
  };
}

let SettingsContext;
try {
  SettingsContext = require("../../components/context/SettingsContext").SettingsContext;
} catch {
  SettingsContext = React.createContext({
    sabbathGuard: false,
    sabbathWindow: { startDow: 5, startHour: 18, endDow: 6, endHour: 19 },
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    // Essential welfare tasks are allowed even if sabbathGuard is on:
    allowWelfareDuringSabbath: true,
  });
}

let PlanDraftContext;
try {
  PlanDraftContext = require("../../components/context/PlanDraftContext").PlanDraftContext;
} catch {
  PlanDraftContext = React.createContext({
    selectedDateISO: new Date().toISOString(),
    tasks: [],
    setTasks: () => {},
  });
}

let VisionContext;
try {
  VisionContext = require("../../components/context/VisionContext").VisionContext;
} catch {
  VisionContext = React.createContext({ getPriorityFor: () => null });
}

let estimateEngine;
try {
  estimateEngine = require("../../engines/estimates/estimateEngine.js");
} catch {
  estimateEngine = { estimate: (t) => ({ timeMinutes: t?.estMinutes || 15, cost: null }) };
}

let scheduleHelpers = {};
try {
  scheduleHelpers = require("../../engines/scheduling/scheduleHelpers.js");
} catch {
  // Optional helper stubs
  scheduleHelpers = {
    getLeadTimeBadges: () => [],
    getVaccinationsDue: () => [], // (animals, dateISO) => [{animalId, name, vaccine, dueISO}]
    getBreedingWindows: () => [], // (animals, dateISO) => [{animalId, name, type:'heat|ai|due', startISO, endISO}]
  };
}

let TaskPlanView;
try {
  TaskPlanView = require("../../components/tasks/TaskPlanView.jsx").default;
} catch {
  TaskPlanView = () => (
    <div className="rounded-2xl border p-6 text-sm text-gray-600">
      TaskPlanView missing; install src/components/tasks/TaskPlanView.jsx
    </div>
  );
}

// ---------------- Utilities ----------------
const SUBDOMAIN_COLORS = {
  feed: "bg-amber-100 text-amber-800",
  water: "bg-sky-100 text-sky-800",
  health: "bg-rose-100 text-rose-800",
  breeding: "bg-fuchsia-100 text-fuchsia-800",
  pasture: "bg-emerald-100 text-emerald-800",
  cleaning: "bg-slate-100 text-slate-800",
  default: "bg-gray-100 text-gray-800",
};

const ANIMAL_EMOJI = {
  cattle: "🐄",
  sheep: "🐑",
  goat: "🐐",
  chicken: "🐔",
  duck: "🦆",
  pig: "🐖",
  horse: "🐎",
  dog: "🐕",
  cat: "🐈",
};

const prettyTime = (iso) => {
  try {
    return format(parseISO(iso), "h:mmaaa");
  } catch {
    return "";
  }
};

const withinSabbath = (now = new Date(), window = { startDow: 5, startHour: 18, endDow: 6, endHour: 19 }) => {
  const dow = now.getDay();
  const hr = now.getHours();
  if (dow === window.startDow && hr >= window.startHour) return true;
  if (dow === window.endDow && hr < window.endHour) return true;
  return false;
};

const groupBySlot = (tasks) => {
  const map = new Map();
  (tasks || []).forEach((t) => {
    const key = t.start ? format(parseISO(t.start), "HH:mm") : "unscheduled";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(t);
  });
  const entries = [...map.entries()].sort((a, b) => {
    if (a[0] === "unscheduled") return 1;
    if (b[0] === "unscheduled") return -1;
    return a[0].localeCompare(b[0]);
  });
  return entries;
};

const dayHeaderPretty = (iso) => {
  try {
    const d = parseISO(iso);
    return `${format(d, "EEEE, MMM d")} ${isToday(d) ? "(Today)" : ""}`;
  } catch {
    return "Planned Barn Tasks";
  }
};

// ---------------- Component ----------------
export default function BarnPlanView({
  dateISO,              // optional override
  tasks: tasksProp,     // optional array of animal-related tasks
  animals = [],         // optional: [{id, name, species, group, pen}]
  paddocks = [],        // optional: [{id, name, lastGrazedISO, restDaysTarget}]
  onStartTask,          // optional callback
  readOnly = false,
}) {
  const { sabbathGuard, sabbathWindow, allowWelfareDuringSabbath } = React.useContext(SettingsContext);
  const { selectedDateISO, tasks: planTasks } = React.useContext(PlanDraftContext);
  const { getPriorityFor } = React.useContext(VisionContext);

  const effectiveDateISO = dateISO || selectedDateISO || new Date().toISOString();
  const baseTasks = tasksProp || planTasks || [];

  // Filter to the day (or show unscheduled)
  const todaysTasks = useMemo(() => {
    const dayStr = format(parseISO(effectiveDateISO), "yyyy-MM-dd");
    return (baseTasks || []).filter((t) => {
      if (!t?.date) return true; // unscheduled are allowed
      const d = format(parseISO(t.date), "yyyy-MM-dd");
      return d === dayStr;
    });
  }, [baseTasks, effectiveDateISO]);

  // UI state
  const [filters, setFilters] = useState({
    showPast: false,
    subdomains: new Set(["feed", "water", "health", "breeding", "pasture", "cleaning"]),
    onlyHighPriority: false,
  });
  const [query, setQuery] = useState("");
  const [activeTaskId, setActiveTaskId] = useState(null);
  const [timer, setTimer] = useState({ taskId: null, endAt: null, remaining: 0 });

  const [shortageCount, setShortageCount] = useState(0);
  const [feedShortage, setFeedShortage] = useState(0);
  const [medShortage, setMedShortage] = useState(0);

  // Pasture & breeding computed helpers
  const rotation = useMemo(() => computeRotation(paddocks), [paddocks]);
  const vaccinationsDue = useMemo(() => scheduleHelpers.getVaccinationsDue?.(animals, effectiveDateISO) || [], [animals, effectiveDateISO]);
  const breedingWindows = useMemo(() => scheduleHelpers.getBreedingWindows?.(animals, effectiveDateISO) || [], [animals, effectiveDateISO]);

  // Subscribe for shortages
  useEffect(() => {
    const off = eventBus.on?.("supplies.shortages.update", (payload) => {
      const list = Array.isArray(payload?.items) ? payload.items : [];
      const animalNeeds = list.filter((r) => r.domain === "animal");
      setShortageCount(animalNeeds.length);
      setFeedShortage(animalNeeds.filter((r) => /feed|grain|hay|pellet/i.test(r.name || "")).length);
      setMedShortage(animalNeeds.filter((r) => /syringe|vaccine|deworm|antibiotic|electrolyte/i.test(r.name || "")).length);
    });
    return () => off?.();
  }, []);

  // Timer tick
  useEffect(() => {
    if (!timer.endAt) return;
    const id = setInterval(() => {
      const remaining = Math.max(0, Math.floor((timer.endAt - Date.now()) / 1000));
      setTimer((prev) => ({ ...prev, remaining }));
      if (remaining <= 0) clearInterval(id);
      eventBus.emit("task.timer.tick", { taskId: timer.taskId, remaining });
    }, 1000);
    return () => clearInterval(id);
  }, [timer.taskId, timer.endAt]);

  // Filtering
  const filteredTasks = useMemo(() => {
    const now = new Date();
    let arr = todaysTasks;

    if (!filters.showPast) {
      arr = arr.filter((t) => {
        if (!t.start) return true;
        try {
          const start = parseISO(t.start);
          const end = addMinutes(start, t.estMinutes || 0);
          return isAfter(end, now);
        } catch {
          return true;
        }
      });
    }

    if (filters.subdomains?.size) {
      arr = arr.filter((t) => filters.subdomains.has(t.subdomain || "default"));
    }

    if (filters.onlyHighPriority) {
      arr = arr.filter((t) => {
        const p = getPriorityFor?.(t) || t.priority;
        return p === "high" || p === "urgent";
      });
    }

    if (query.trim()) {
      const q = query.toLowerCase();
      arr = arr.filter((t) => {
        const hay = [
          t.title,
          t.domain,
          t.subdomain,
          t.pen,
          t.group,
          t.animalId,
          ...(t.tags || []),
          ...(t.flags || []),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      });
    }

    return arr;
  }, [todaysTasks, filters, query, getPriorityFor]);

  const slots = useMemo(() => groupBySlot(filteredTasks), [filteredTasks]);

  // Start handler with Sabbath guard (welfare override)
  const handleStart = useCallback(
    (task) => {
      const now = new Date();
      const inSabbath = sabbathGuard && withinSabbath(now, sabbathWindow);
      const welfare = ["feed", "water", "health"].includes(task.subdomain || "");
      if (inSabbath && !(allowWelfareDuringSabbath && welfare)) {
        eventBus.emit("ui.toast", { variant: "warning", message: "Sabbath guard: action blocked." });
        return;
      }

      const estMinutes = task.estMinutes || estimateEngine.estimate(task).timeMinutes || 15;
      const endAt = Date.now() + estMinutes * 60 * 1000;
      setActiveTaskId(task.id);
      setTimer({ taskId: task.id, endAt, remaining: estMinutes * 60 });
      eventBus.emit("task.started", { taskId: task.id, at: now.toISOString() });
      onStartTask?.(task);
    },
    [onStartTask, sabbathGuard, sabbathWindow, allowWelfareDuringSabbath]
  );

  // Refs
  const slotRefs = useRef({});
  const taskRefs = useRef({});

  // ---------- Render helpers ----------
  const Badge = ({ children, className = "" }) => (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${className}`}>{children}</span>
  );

  const SubdomainBadge = ({ subdomain }) => {
    const cls = SUBDOMAIN_COLORS[subdomain] || SUBDOMAIN_COLORS.default;
    return <Badge className={cls}>{subdomain || "task"}</Badge>;
  };

  const AnimalChip = ({ animal }) => {
    if (!animal) return null;
    const icon = ANIMAL_EMOJI[(animal.species || "").toLowerCase()] || "🐾";
    return <Badge className="bg-gray-50 text-gray-700 border border-gray-200">{icon} {animal.name || animal.species}</Badge>;
  };

  const TimerChip = ({ task }) => {
    if (timer.taskId !== task.id) return null;
    const mins = Math.floor(timer.remaining / 60);
    const secs = timer.remaining % 60;
    return <Badge className="bg-black text-white">{mins}:{String(secs).padStart(2, "0")}</Badge>;
  };

  // Quick map for animal lookup
  const animalMap = useMemo(() => {
    const map = new Map();
    for (const a of animals || []) map.set(a.id, a);
    return map;
  }, [animals]);

  const TaskCard = ({ task }) => {
    const isActive = activeTaskId === task.id;
    const overdue =
      task.start &&
      !isActive &&
      isPast(addMinutes(parseISO(task.start), Number(task.estMinutes || 0)));

    const animal = task.animalId ? animalMap.get(task.animalId) : null;

    return (
      <div
        ref={(el) => (taskRefs.current[task.id] = el)}
        className={[
          "rounded-2xl border p-4 shadow-sm transition bg-white",
          isActive ? "border-black ring-2 ring-black" : "border-gray-200",
          overdue ? "bg-rose-50" : "bg-white",
        ].join(" ")}
        id={`task-${task.id}`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-semibold text-gray-900 truncate">{task.title || "Untitled task"}</h3>
              <SubdomainBadge subdomain={task.subdomain} />
              {task.pen ? <Badge className="bg-gray-100 text-gray-700 border border-gray-200">Pen: {task.pen}</Badge> : null}
              {task.group ? <Badge className="bg-gray-100 text-gray-700 border border-gray-200">{task.group}</Badge> : null}
              <AnimalChip animal={animal} />
              <TimerChip task={task} />
            </div>
            <div className="mt-1 text-sm text-gray-600 flex flex-wrap gap-3">
              {task.start ? <span title={task.start}>{prettyTime(task.start)}{task.estMinutes ? ` · ${task.estMinutes}m` : ""}</span> : <span className="italic text-gray-400">Unscheduled</span>}
              {task.location ? <span>• {task.location}</span> : null}
              {task.assignee ? <span>• @{task.assignee}</span> : null}
            </div>
          </div>

          {!readOnly ? (
            <button
              type="button"
              onClick={() => handleStart(task)}
              className={[
                "rounded-xl px-3 py-1.5 text-sm font-medium border",
                "bg-gray-900 text-white border-black hover:opacity-90",
              ].join(" ")}
              title="Start task"
            >
              {timer.taskId === task.id ? "Running…" : "Start"}
            </button>
          ) : null}
        </div>

        {/* Details */}
        {(task?.tags?.length || task?.ration || task?.dosage || task?.notes) ? (
          <div className="mt-3 grid gap-2 text-sm">
            {task.ration ? <div className="text-gray-700"><span className="font-medium">Ration:</span> {task.ration}</div> : null}
            {task.dosage ? <div className="text-gray-700"><span className="font-medium">Dosage:</span> {task.dosage}</div> : null}
            {task.tags?.length ? (
              <div className="flex flex-wrap gap-1">
                {task.tags.map((tg) => <Badge key={tg} className="bg-gray-50 text-gray-700 border border-gray-200">#{tg}</Badge>)}
              </div>
            ) : null}
            {task.notes ? <p className="text-gray-700 whitespace-pre-wrap">{task.notes}</p> : null}
          </div>
        ) : null}
      </div>
    );
  };

  // ---------- Render ----------
  const dayHeader = dayHeaderPretty(effectiveDateISO);
  const subdomains = ["feed", "water", "health", "breeding", "pasture", "cleaning"];

  return (
    <div className="w-full max-w-7xl mx-auto p-4 sm:p-6">
      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Barn Plan</h1>
          <p className="text-gray-600">{dayHeader} • Feed, water, health, breeding, pasture rotation.</p>
        </div>

        <div className="flex items-center gap-2">
          {/* Shortage Bridge */}
          <button
            type="button"
            onClick={() => {
              eventBus.emit("ui.navigate", { panel: "SuppliesPanel" });
              eventBus.emit("ui.panel.open", { id: "SUPPLIES" });
            }}
            className="rounded-xl border px-3 py-2 text-sm bg-white hover:bg-gray-50"
            title="Review feed & medical supplies"
          >
            Supplies {shortageCount ? `(${shortageCount})` : ""}
          </button>
          <button
            type="button"
            onClick={() => {
              eventBus.emit("ui.navigate", { panel: "GroceryListPanel" });
              eventBus.emit("ui.panel.open", { id: "GROCERY_LIST" });
            }}
            className="rounded-xl border border-black bg-gray-900 text-white px-3 py-2 text-sm hover:opacity-90"
            title="Jump to Grocery"
          >
            Jump to Grocery
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <div className="relative">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search task, pen, animal, tag…"
            className="w-72 rounded-xl border px-3 py-2 text-sm"
          />
        </div>

        {subdomains.map((d) => {
          const on = filters.subdomains.has(d);
          return (
            <button
              key={d}
              type="button"
              onClick={() =>
                setFilters((f) => {
                  const n = new Set(f.subdomains);
                  if (n.has(d)) n.delete(d);
                  else n.add(d);
                  return { ...f, subdomains: n };
                })
              }
              className={[
                "rounded-full border px-3 py-1.5 text-sm capitalize",
                on ? "bg-gray-900 text-white border-black" : "bg-white hover:bg-gray-50",
              ].join(" ")}
            >
              {d}
            </button>
          );
        })}

        <label className="ml-auto flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={filters.showPast}
            onChange={(e) => setFilters((f) => ({ ...f, showPast: e.target.checked }))}
          />
          Show past
        </label>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={filters.onlyHighPriority}
            onChange={(e) => setFilters((f) => ({ ...f, onlyHighPriority: e.target.checked }))}
          />
          High priority
        </label>
      </div>

      {/* Summary row */}
      <div className="mt-3 grid grid-cols-1 md:grid-cols-4 gap-4">
        <InfoCard label="Animal shortages" value={shortageCount} hint={`${feedShortage} feed • ${medShortage} meds`} tone={shortageCount ? "amber" : "slate"} />
        <InfoCard label="Vaccinations due" value={vaccinationsDue.length} onClick={() => scrollToSection("vaccines")} />
        <InfoCard label="Breeding windows" value={breedingWindows.length} onClick={() => scrollToSection("breeding")} />
        <InfoCard label="Pasture: ready paddocks" value={rotation.ready.length} onClick={() => scrollToSection("pasture")} />
      </div>

      {/* Main grid */}
      <div className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Plan board */}
        <div className="lg:col-span-2">
          <div className="rounded-2xl border p-4">
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wider">Today’s Barn Tasks</h2>
              <div className="text-xs text-gray-500">{filteredTasks.length} item{filteredTasks.length !== 1 ? "s" : ""}</div>
            </div>

            <div className="mt-3 grid gap-6">
              {!slots.length ? (
                <div className="rounded-xl border border-dashed p-8 text-center text-gray-600">
                  No tasks match your filters.
                </div>
              ) : (
                slots.map(([slotKey, items]) => (
                  <section key={slotKey}>
                    <div
                      ref={(el) => (slotRefs.current[slotKey] = el)}
                      className="mb-2 flex items-baseline justify-between"
                    >
                      <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wider">
                        {slotKey === "unscheduled"
                          ? "Unscheduled"
                          : format(parseISO(`${format(parseISO(effectiveDateISO), "yyyy-MM-dd")}T${slotKey}:00`), "h:mmaaa")}
                      </h3>
                    </div>
                    <div className="grid gap-3">
                      {items.map((t) => (
                        <TaskCard key={t.id} task={t} />
                      ))}
                    </div>
                  </section>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Right rail: Animal tools */}
        <aside className="space-y-4">
          {/* Vaccinations due */}
          <div id="vaccines" className="rounded-2xl border p-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">Vaccinations due</h3>
              <span className="text-xs text-gray-500">{vaccinationsDue.length}</span>
            </div>
            <ul className="mt-2 grid gap-2">
              {vaccinationsDue.slice(0, 6).map((v, i) => (
                <li key={`v-${i}`} className="rounded-xl border p-3 bg-white">
                  <div className="text-sm">
                    <span className="font-medium">{v.name}</span> • {v.vaccine}
                  </div>
                  <div className="text-xs text-gray-600">Due {format(parseISO(v.dueISO), "PP")}</div>
                  <div className="mt-2">
                    <button
                      type="button"
                      onClick={() => createHealthTask(v)}
                      className="rounded-lg border bg-white hover:bg-gray-50 px-3 py-1.5 text-xs"
                    >
                      Add task
                    </button>
                  </div>
                </li>
              ))}
              {!vaccinationsDue.length ? <li className="text-sm text-gray-600">None due.</li> : null}
            </ul>
          </div>

          {/* Breeding */}
          <div id="breeding" className="rounded-2xl border p-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">Breeding</h3>
              <span className="text-xs text-gray-500">{breedingWindows.length}</span>
            </div>
            <ul className="mt-2 grid gap-2">
              {breedingWindows.slice(0, 6).map((b, i) => (
                <li key={`b-${i}`} className="rounded-xl border p-3 bg-white">
                  <div className="text-sm">
                    <span className="font-medium">{b.name}</span> • {b.type.toUpperCase()}
                  </div>
                  <div className="text-xs text-gray-600">
                    {format(parseISO(b.startISO), "PPp")} → {format(parseISO(b.endISO), "PPp")}
                  </div>
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      onClick={() => createBreedingTask(b)}
                      className="rounded-lg border bg-white hover:bg-gray-50 px-3 py-1.5 text-xs"
                    >
                      Schedule check
                    </button>
                    <button
                      type="button"
                      onClick={() => logBreedingEvent(b)}
                      className="rounded-lg border bg-white hover:bg-gray-50 px-3 py-1.5 text-xs"
                    >
                      Log event
                    </button>
                  </div>
                </li>
              ))}
              {!breedingWindows.length ? <li className="text-sm text-gray-600">No windows today.</li> : null}
            </ul>
          </div>

          {/* Pasture rotation */}
          <div id="pasture" className="rounded-2xl border p-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">Pasture rotation</h3>
              <span className="text-xs text-gray-500">{rotation.all.length} paddocks</span>
            </div>
            {rotation.ready.length ? (
              <div className="mt-2">
                <div className="text-sm font-medium">Ready to graze</div>
                <ul className="mt-1 grid gap-2">
                  {rotation.ready.map((p) => (
                    <li key={p.id} className="rounded-xl border p-3 bg-white">
                      <div className="text-sm">
                        <span className="font-medium">{p.name}</span>{" "}
                        <span className="text-gray-600">• {p.daysRest}d rest / target {p.restDaysTarget}d</span>
                      </div>
                      <div className="mt-2">
                        <button
                          type="button"
                          onClick={() => scheduleMoveToPaddock(p)}
                          className="rounded-lg border bg-white hover:bg-gray-50 px-3 py-1.5 text-xs"
                        >
                          Schedule move
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="mt-2 text-sm text-gray-600">No paddocks at target rest yet.</div>
            )}

            {rotation.recovering.length ? (
              <div className="mt-3">
                <div className="text-sm font-medium">Recovering</div>
                <ul className="mt-1 grid gap-2">
                  {rotation.recovering.map((p) => (
                    <li key={p.id} className="rounded-xl border p-3 bg-white">
                      <div className="text-sm">
                        <span className="font-medium">{p.name}</span>{" "}
                        <span className="text-gray-600">• {p.daysRest}d rest / target {p.restDaysTarget}d</span>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </aside>
      </div>
    </div>
  );

  // --------------- Actions ---------------
  function createHealthTask(v) {
    const start = new Date();
    const task = {
      id: `health:${v.animalId}:${v.vaccine}:${start.getTime()}`,
      title: `Vaccinate ${v.name} (${v.vaccine})`,
      domain: "animal",
      subdomain: "health",
      animalId: v.animalId,
      date: format(start, "yyyy-MM-dd"),
      start: format(start, "yyyy-MM-dd'T'HH:mm:ss"),
      estMinutes: 10,
      tags: ["vaccination"],
    };
    eventBus.emit("tasks.add", { task });
    eventBus.emit("ui.toast", { variant: "success", message: "Vaccination task added" });
  }

  function createBreedingTask(b) {
    const start = parseISO(b.startISO);
    const task = {
      id: `breed:${b.animalId}:${start.getTime()}`,
      title: `${b.type === "ai" ? "AI" : "Heat"} check: ${b.name}`,
      domain: "animal",
      subdomain: "breeding",
      animalId: b.animalId,
      date: format(start, "yyyy-MM-dd"),
      start: format(start, "yyyy-MM-dd'T'HH:mm:ss"),
      estMinutes: 10,
      tags: ["breeding"],
    };
    eventBus.emit("tasks.add", { task });
    eventBus.emit("ui.toast", { variant: "success", message: "Breeding check scheduled" });
  }

  function logBreedingEvent(b) {
    eventBus.emit("animals.breeding.log", { animalId: b.animalId, window: b, at: new Date().toISOString() });
    eventBus.emit("ui.toast", { variant: "success", message: "Breeding event logged" });
  }

  function scheduleMoveToPaddock(p) {
    const start = new Date();
    const task = {
      id: `pasture:${p.id}:${start.getTime()}`,
      title: `Move herd to ${p.name}`,
      domain: "animal",
      subdomain: "pasture",
      date: format(start, "yyyy-MM-dd"),
      start: format(start, "yyyy-MM-dd'T'HH:mm:ss"),
      estMinutes: 20,
      tags: ["rotation"],
      pen: p.name,
    };
    eventBus.emit("tasks.add", { task });
    eventBus.emit("ui.toast", { variant: "success", message: `Scheduled move to ${p.name}` });
  }

  function scrollToSection(id) {
    const el = document.getElementById(id);
    if (el?.scrollIntoView) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

// ---------------- Small components ----------------
function InfoCard({ label, value, hint, tone = "slate", onClick }) {
  const toneMap = {
    slate: "bg-slate-50 text-slate-900 border-slate-200",
    amber: "bg-amber-50 text-amber-900 border-amber-200",
    rose: "bg-rose-50 text-rose-900 border-rose-200",
    sky: "bg-sky-50 text-sky-900 border-sky-200",
    emerald: "bg-emerald-50 text-emerald-900 border-emerald-200",
  };
  return (
    <button type="button" onClick={onClick} className={`rounded-2xl border p-4 text-left ${toneMap[tone] || toneMap.slate}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
      {hint ? <div className="mt-1 text-xs text-gray-600">{hint}</div> : null}
    </button>
  );
}

// ---------------- Barn helpers ----------------
function computeRotation(paddocks = []) {
  const today = new Date();
  const all = (paddocks || []).map((p) => {
    const last = p.lastGrazedISO ? parseISO(p.lastGrazedISO) : addDays(today, -999);
    const daysRest = Math.max(0, differenceInDays(today, last));
    return { ...p, daysRest };
  });
  const ready = all.filter((p) => (p.restDaysTarget ? p.daysRest >= p.restDaysTarget : p.daysRest >= 21));
  const recovering = all.filter((p) => !ready.find((r) => r.id === p.id));
  ready.sort((a, b) => b.daysRest - a.daysRest);
  recovering.sort((a, b) => a.daysRest - b.daysRest);
  return { all, ready, recovering };
}

/**
 * Expected animal task shape (flexible):
 * {
 *   id: string,
 *   title: string,
 *   domain: "animal",
 *   subdomain: "feed"|"water"|"health"|"breeding"|"pasture"|"cleaning",
 *   date: "YYYY-MM-DD",
 *   start?: ISODateTime,
 *   estMinutes?: number,
 *   pen?: string,
 *   group?: string,          // e.g., "ewes", "ram lambs", "calves"
 *   animalId?: string,       // link to animals[]
 *   tags?: string[],
 *   ration?: string,         // for feed
 *   dosage?: string,         // for health (meds/vaccines)
 *   notes?: string,
 *   assignee?: string,
 *   location?: string,
 *   priority?: "low"|"normal"|"high"|"urgent",
 * }
 *
 * Integrations:
 * - Shortages: listen to `supplies.shortages.update` {items:[...]} (domain === "animal")
 * - Add tasks: eventBus.emit("tasks.add", { task })
 * - Navigate: eventBus.emit("ui.navigate", { panel: "SuppliesPanel" | "GroceryListPanel" | ... })
 *
 * Extend:
 * - Add ration calculator (bodyweight × %DM) and auto-fill `ration`
 * - Hook `getVaccinationsDue` and `getBreedingWindows` to real herd records
 * - Emit `animals.herd.move` when a pasture move task completes
 */
