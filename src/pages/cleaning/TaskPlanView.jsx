/* eslint-disable no-console */
// src/components/tasks/TaskPlanView.jsx
//
// TaskPlanView — unified slot/task board with jump-to-task navigation
// - Shows tasks (meals, cleaning, animal care/butchery, garden, errands, etc.) grouped by time “slots”
// - Keyboard & UI “jump-to-task” search to focus/scroll to a task
// - “Start” action emits events, starts a local timer, and guards Sabbath if enabled
// - Defensive against missing services/contexts; degrades gracefully
// - Empty states, filters, and quick actions (Next Best Action hinting if available)
// - Inspired by clean, card-based list UIs (Linear, Notion, Asana) with concise metadata badges

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { format, isToday, isPast, parseISO, addMinutes, isAfter } from "date-fns";

// ---------- Optional services/contexts (defensive imports) ----------
let eventBus;
try {
  // Optional: your global event bus
  // Expected to support eventBus.emit(name, payload)
  // e.g., src/services/eventBus.js
  // eslint-disable-next-line global-require
  eventBus = require("../../services/eventBus").default;
} catch (_) {
  eventBus = { emit: (...args) => console.debug("[TaskPlanView:eventBus.emit]", ...args) };
}

let useMilestoneState;
try {
  // Optional: emits milestone progress, next-best-action, etc.
  // eslint-disable-next-line global-require
  useMilestoneState = require("../../app/hooks/useMilestoneState").default;
} catch (_) {
  useMilestoneState = () => ({ progressMap: {}, recordMilestone: () => {} });
}

let SettingsContext;
try {
  // Optional: global app settings including sabbath guard, timezone prefs, etc.
  // eslint-disable-next-line global-require
  SettingsContext = require("../../components/context/SettingsContext").SettingsContext;
} catch (_) {
  SettingsContext = React.createContext({
    sabbathGuard: false,
    sabbathWindow: { startDow: 5, startHour: 18, endDow: 6, endHour: 19 }, // Fri 6p → Sat 7p (approx)
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
}

let PlanDraftContext;
try {
  // Optional: plan-level data (selected day, tasks, constraints, etc.)
  // eslint-disable-next-line global-require
  PlanDraftContext = require("../../components/context/PlanDraftContext").PlanDraftContext;
} catch (_) {
  PlanDraftContext = React.createContext({
    selectedDateISO: new Date().toISOString(),
    tasks: [],
    setTasks: () => {},
  });
}

let VisionContext;
try {
  // Optional: for “Next Best Action” nudges aligned with user goals
  // eslint-disable-next-line global-require
  VisionContext = require("../../components/context/VisionContext").VisionContext;
} catch (_) {
  VisionContext = React.createContext({ priorities: [], getPriorityFor: () => null });
}

let scheduleHelpers = {};
try {
  // Optional: reminder helpers (defrost/marinate/preheat etc.)
  // eslint-disable-next-line global-require
  scheduleHelpers = require("../../engines/scheduling/scheduleHelpers.js");
} catch (_) {
  scheduleHelpers = {
    getLeadTimeBadges: () => [],
  };
}

let estimateEngine;
try {
  // Optional: cost/time estimates
  // eslint-disable-next-line global-require
  estimateEngine = require("../../engines/estimates/estimateEngine.js");
} catch (_) {
  estimateEngine = {
    estimate: () => ({ cost: null, timeMinutes: null }),
  };
}

// ---------- Utilities ----------
const CLASS_DOMAIN = {
  meal: "bg-emerald-100 text-emerald-800",
  cleaning: "bg-sky-100 text-sky-800",
  animal: "bg-amber-100 text-amber-800",
  butchery: "bg-red-100 text-red-800",
  garden: "bg-lime-100 text-lime-800",
  errand: "bg-violet-100 text-violet-800",
  default: "bg-gray-100 text-gray-800",
};

const prettyTime = (iso) => {
  try {
    return format(parseISO(iso), "h:mmaaa");
  } catch {
    return "";
  }
};

const withinSabbath = (now = new Date(), window = { startDow: 5, startHour: 18, endDow: 6, endHour: 19 }) => {
  // Simple, local-approximation guard. For precise halachic times, integrate your astronomy rules.
  const dow = now.getDay(); // 0=Sun .. 6=Sat
  const hour = now.getHours();
  if (dow === window.startDow && hour >= window.startHour) return true;
  if (dow === window.endDow && hour < window.endHour) return true;
  return false;
};

const groupBySlot = (tasks) => {
  // slot key = “HH:MM” of start
  const map = new Map();
  (tasks || []).forEach((t) => {
    const key = t.start ? format(parseISO(t.start), "HH:mm") : "unscheduled";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(t);
  });
  // Sort slots chronologically (unscheduled last)
  const entries = [...map.entries()].sort((a, b) => {
    if (a[0] === "unscheduled") return 1;
    if (b[0] === "unscheduled") return -1;
    return a[0].localeCompare(b[0]);
  });
  return entries;
};

const defaultFilters = {
  showPast: false,
  domains: new Set(["meal", "cleaning", "animal", "butchery", "garden", "errand"]),
  onlyConflicts: false,
  onlyHighPriority: false,
};

// ---------- Component ----------
export default function TaskPlanView({
  dateISO,                 // optional; defaults to PlanDraftContext.selectedDateISO or today
  tasks: tasksProp,        // optional; defaults to PlanDraftContext.tasks
  onStartTask,             // optional callback(task)
  onNavigateToTask,        // optional callback(taskId) for deep-links
  readOnly = false,
}) {
  const { sabbathGuard, sabbathWindow } = React.useContext(SettingsContext);
  const { selectedDateISO, tasks: planTasks } = React.useContext(PlanDraftContext);
  const { priorities, getPriorityFor } = React.useContext(VisionContext);
  const { recordMilestone } = useMilestoneState();

  const effectiveDateISO = dateISO || selectedDateISO || new Date().toISOString();
  const baseTasks = tasksProp || planTasks || [];

  // Derived tasks for the day
  const todaysTasks = useMemo(() => {
    const dayStr = format(parseISO(effectiveDateISO), "yyyy-MM-dd");
    return (baseTasks || []).filter((t) => {
      if (!t?.date) return true; // if no explicit date, keep (shown as unscheduled)
      const d = format(parseISO(t.date), "yyyy-MM-dd");
      return d === dayStr;
    });
  }, [baseTasks, effectiveDateISO]);

  const [filters, setFilters] = useState(defaultFilters);
  const [query, setQuery] = useState("");
  const [activeTaskId, setActiveTaskId] = useState(null);
  const [timer, setTimer] = useState({ taskId: null, endAt: null, remaining: 0 });
  const [expanded, setExpanded] = useState(() => new Set()); // expanded card descriptions
  const [jumpOpen, setJumpOpen] = useState(false);

  // Refs for jump-to
  const slotRefs = useRef({});
  const taskRefs = useRef({});

  // Keyboard: Cmd/Ctrl+K opens jump palette
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setJumpOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Filter logic
  const filteredTasks = useMemo(() => {
    const now = new Date();
    let arr = todaysTasks;

    if (!filters.showPast) {
      arr = arr.filter((t) => {
        if (!t.start) return true;
        try {
          const start = parseISO(t.start);
          return isAfter(addMinutes(start, t.estMinutes || 0), now);
        } catch {
          return true;
        }
      });
    }

    if (filters.domains && filters.domains.size) {
      arr = arr.filter((t) => filters.domains.has(t.domain || "default"));
    }

    if (filters.onlyHighPriority && typeof getPriorityFor === "function") {
      arr = arr.filter((t) => {
        const p = getPriorityFor(t) || t.priority;
        return p === "high" || p === "urgent";
      });
    }

    if (query.trim()) {
      const q = query.toLowerCase();
      arr = arr.filter((t) => {
        const hay = [
          t.title,
          t.domain,
          t.location,
          ...(t.tags || []),
          ...(t.ppe || []),
          ...(t.flags || []),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      });
    }

    // Conflict filter (very basic overlap check)
    if (filters.onlyConflicts) {
      const overlaps = new Set();
      const ts = arr
        .filter((t) => t.start)
        .map((t) => ({
          id: t.id,
          start: parseISO(t.start),
          end: t.estMinutes ? addMinutes(parseISO(t.start), t.estMinutes) : addMinutes(parseISO(t.start), 30),
        }))
        .sort((a, b) => a.start - b.start);

      for (let i = 0; i < ts.length - 1; i++) {
        const a = ts[i];
        const b = ts[i + 1];
        if (a.end > b.start) {
          overlaps.add(a.id);
          overlaps.add(b.id);
        }
      }
      arr = arr.filter((t) => overlaps.has(t.id));
    }

    return arr;
  }, [todaysTasks, filters, query, getPriorityFor]);

  const slots = useMemo(() => groupBySlot(filteredTasks), [filteredTasks]);

  // Timer tick
  useEffect(() => {
    if (!timer.endAt) return;
    const id = setInterval(() => {
      const remaining = Math.max(0, Math.floor((timer.endAt - Date.now()) / 1000));
      setTimer((prev) => ({ ...prev, remaining }));
      if (remaining <= 0) {
        clearInterval(id);
        eventBus.emit("task.timer.completed", { taskId: timer.taskId });
        recordMilestone?.({ key: "task_timer_completed", meta: { taskId: timer.taskId } });
      }
    }, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timer.taskId, timer.endAt]);

  const handleStart = useCallback(
    (task) => {
      const now = new Date();
      if (sabbathGuard && withinSabbath(now, sabbathWindow)) {
        eventBus.emit("guard.sabbath.blocked", { reason: "sabbath_guard", taskId: task.id });
        return;
      }

      const estMinutes = task.estMinutes || estimateEngine.estimate(task).timeMinutes || 30;
      const endAt = Date.now() + estMinutes * 60 * 1000;

      setActiveTaskId(task.id);
      setTimer({ taskId: task.id, endAt, remaining: estMinutes * 60 });

      eventBus.emit("task.started", { taskId: task.id, at: now.toISOString() });
      recordMilestone?.({ key: "task_started", meta: { taskId: task.id } });
      onStartTask?.(task);
    },
    [onStartTask, sabbathGuard, sabbathWindow, recordMilestone]
  );

  const handleJumpToTask = useCallback((taskId) => {
    const el = taskRefs.current[taskId];
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      setActiveTaskId(taskId);
      onNavigateToTask?.(taskId);
    }
  }, [onNavigateToTask]);

  const handleJumpToSlot = useCallback((slotKey) => {
    const el = slotRefs.current[slotKey];
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);

  const toggleExpanded = useCallback((id) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // ---------- Render helpers ----------
  const Badge = ({ children, className = "" }) => (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${className}`}>{children}</span>
  );

  const DomainBadge = ({ domain }) => {
    const cls = CLASS_DOMAIN[domain] || CLASS_DOMAIN.default;
    return <Badge className={cls}>{domain || "task"}</Badge>;
  };

  const PPEBadges = ({ ppe = [] }) =>
    ppe?.length ? (
      <div className="flex flex-wrap gap-1">
        {ppe.map((p) => (
          <Badge key={p} className="bg-gray-100 text-gray-700 border border-gray-200">
            {p}
          </Badge>
        ))}
      </div>
    ) : null;

  const LeadTimeBadges = ({ task }) => {
    const leads = scheduleHelpers.getLeadTimeBadges?.(task) || [];
    if (!leads.length) return null;
    return (
      <div className="flex flex-wrap gap-1">
        {leads.map((l) => (
          <Badge key={l.key} className="bg-indigo-50 text-indigo-700 border border-indigo-100">
            {l.label}
          </Badge>
        ))}
      </div>
    );
  };

  const TimerChip = ({ task }) => {
    if (timer.taskId !== task.id) return null;
    const mins = Math.floor(timer.remaining / 60);
    const secs = timer.remaining % 60;
    return (
      <Badge className="bg-black text-white">
        {mins}:{secs.toString().padStart(2, "0")}
      </Badge>
    );
  };

  const ConflictChip = ({ conflict }) =>
    conflict ? <Badge className="bg-red-50 text-red-700 border border-red-200">Conflict</Badge> : null;

  const PriorityChip = ({ priority }) =>
    priority ? <Badge className="bg-yellow-50 text-yellow-700 border border-yellow-200 capitalize">{priority}</Badge> : null;

  const CostChip = ({ task }) => {
    const est = estimateEngine.estimate?.(task) || {};
    if (!est.cost && !est.timeMinutes) return null;
    return (
      <div className="flex items-center gap-2">
        {est.timeMinutes ? <Badge className="bg-slate-100 text-slate-700">{est.timeMinutes}m</Badge> : null}
        {est.cost ? <Badge className="bg-slate-100 text-slate-700">${est.cost}</Badge> : null}
      </div>
    );
  };

  const TaskCard = ({ task, conflict = false }) => {
    const isActive = activeTaskId === task.id;
    const overdue =
      task.start &&
      !isActive &&
      isPast(addMinutes(parseISO(task.start), Number(task.estMinutes || 0)));

    return (
      <div
        ref={(el) => (taskRefs.current[task.id] = el)}
        className={[
          "rounded-2xl border p-4 shadow-sm transition",
          isActive ? "border-black ring-2 ring-black" : "border-gray-200",
          overdue ? "bg-rose-50" : "bg-white",
        ].join(" ")}
        id={`task-${task.id}`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-semibold text-gray-900 truncate">{task.title || "Untitled task"}</h3>
              <DomainBadge domain={task.domain} />
              <PriorityChip priority={task.priority} />
              <ConflictChip conflict={conflict} />
              <TimerChip task={task} />
            </div>
            <div className="mt-1 text-sm text-gray-600 flex flex-wrap gap-3">
              {task.start ? (
                <span title={task.start}>
                  {prettyTime(task.start)}
                  {task.estMinutes ? ` · ${task.estMinutes}m` : ""}
                </span>
              ) : (
                <span className="italic text-gray-400">Unscheduled</span>
              )}
              {task.location ? <span>• {task.location}</span> : null}
              {task.assignee ? <span>• @{task.assignee}</span> : null}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {!readOnly ? (
              <button
                type="button"
                onClick={() => handleStart(task)}
                className={[
                  "rounded-xl px-3 py-1.5 text-sm font-medium border",
                  sabbathGuard && withinSabbath(new Date(), sabbathWindow)
                    ? "bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed"
                    : "bg-gray-900 text-white border-black hover:opacity-90",
                ].join(" ")}
                disabled={sabbathGuard && withinSabbath(new Date(), sabbathWindow)}
                title={sabbathGuard && withinSabbath(new Date(), sabbathWindow) ? "Sabbath guard is enabled" : "Start task"}
              >
                {timer.taskId === task.id ? "Running…" : "Start"}
              </button>
            ) : null}

            <button
              type="button"
              onClick={() => toggleExpanded(task.id)}
              className="rounded-xl px-3 py-1.5 text-sm font-medium border bg-white hover:bg-gray-50"
            >
              {expanded.has(task.id) ? "Hide" : "Details"}
            </button>
          </div>
        </div>

        {expanded.has(task.id) ? (
          <div className="mt-3 grid gap-3 text-sm">
            {task.description ? <p className="text-gray-700 whitespace-pre-wrap">{task.description}</p> : null}

            <div className="flex flex-wrap items-center gap-2">
              <CostChip task={task} />
              <LeadTimeBadges task={task} />
              <PPEBadges ppe={task.ppe} />
              {(task?.tags || []).length ? (
                <div className="flex flex-wrap gap-1">
                  {task.tags.map((tg) => (
                    <Badge key={tg} className="bg-gray-50 text-gray-700 border border-gray-200">
                      #{tg}
                    </Badge>
                  ))}
                </div>
              ) : null}
            </div>

            {Array.isArray(task.checklist) && task.checklist.length ? (
              <ul className="mt-1 list-disc pl-6 space-y-1">
                {task.checklist.map((c, idx) => (
                  <li key={`${task.id}-c-${idx}`} className="text-gray-700">
                    {c}
                  </li>
                ))}
              </ul>
            ) : null}

            {Array.isArray(task.dependencies) && task.dependencies.length ? (
              <div className="text-gray-700">
                <span className="font-medium">Depends on:</span>{" "}
                {task.dependencies.map((d, i) => (
                  <button
                    key={`${task.id}-dep-${i}`}
                    type="button"
                    onClick={() => handleJumpToTask(d)}
                    className="underline decoration-dotted hover:decoration-solid"
                  >
                    {d}
                    {i < task.dependencies.length - 1 ? ", " : ""}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  };

  // Compute conflicts (simple overlap by start-end on filtered set)
  const conflictSet = useMemo(() => {
    const overlaps = new Set();
    const ts = filteredTasks
      .filter((t) => t.start)
      .map((t) => ({
        id: t.id,
        start: parseISO(t.start),
        end: t.estMinutes ? addMinutes(parseISO(t.start), t.estMinutes) : addMinutes(parseISO(t.start), 30),
      }))
      .sort((a, b) => a.start - b.start);

    for (let i = 0; i < ts.length - 1; i++) {
      const a = ts[i];
      const b = ts[i + 1];
      if (a.end > b.start) {
        overlaps.add(a.id);
        overlaps.add(b.id);
      }
    }
    return overlaps;
  }, [filteredTasks]);

  // ---------- Empty state ----------
  const Empty = () => (
    <div className="rounded-2xl border border-dashed p-10 text-center text-gray-600">
      <div className="text-lg font-semibold">No tasks match your filters.</div>
      <div className="mt-1">Try clearing the query or enabling more domains.</div>
      <div className="mt-4 flex justify-center gap-2">
        <button
          type="button"
          onClick={() => setQuery("")}
          className="rounded-xl px-3 py-1.5 text-sm font-medium border bg-white hover:bg-gray-50"
        >
          Clear search
        </button>
        <button
          type="button"
          onClick={() => setFilters(defaultFilters)}
          className="rounded-xl px-3 py-1.5 text-sm font-medium border bg-white hover:bg-gray-50"
        >
          Reset filters
        </button>
      </div>
    </div>
  );

  // ---------- Jump palette ----------
  const jumpList = useMemo(() => {
    return filteredTasks
      .slice()
      .sort((a, b) => {
        const aS = a.start ? parseISO(a.start) : new Date(8640000000000000); // unscheduled last
        const bS = b.start ? parseISO(b.start) : new Date(8640000000000000);
        return aS - bS;
      })
      .map((t) => ({
        id: t.id,
        label: t.title || "Untitled",
        meta: `${t.domain || "task"}${t.start ? " • " + prettyTime(t.start) : ""}`,
      }));
  }, [filteredTasks]);

  // ---------- Render ----------
  const dayHeader = useMemo(() => {
    try {
      const d = parseISO(effectiveDateISO);
      return `${format(d, "EEEE, MMM d")} ${isToday(d) ? "(Today)" : ""}`;
    } catch {
      return "Planned Tasks";
    }
  }, [effectiveDateISO]);

  const domains = ["meal", "cleaning", "animal", "butchery", "garden", "errand"];

  return (
    <div className="w-full max-w-7xl mx-auto p-4 sm:p-6">
      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{dayHeader}</h1>
          <p className="text-gray-600">
            Slot/task board with quick jump, timers, and priority/lead-time hints.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="relative">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search (Ctrl/Cmd + K to jump)…"
              className="w-64 rounded-xl border px-3 py-2 text-sm"
            />
            <button
              type="button"
              onClick={() => setJumpOpen(true)}
              className="absolute right-1.5 top-1.5 rounded-lg border bg-white px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
              title="Open jump palette"
            >
              Jump
            </button>
          </div>

          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={filters.showPast}
                onChange={(e) => setFilters((f) => ({ ...f, showPast: e.target.checked }))}
              />
              Show past
            </label>

            <label className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={filters.onlyConflicts}
                onChange={(e) => setFilters((f) => ({ ...f, onlyConflicts: e.target.checked }))}
              />
              Conflicts only
            </label>

            <label className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={filters.onlyHighPriority}
                onChange={(e) => setFilters((f) => ({ ...f, onlyHighPriority: e.target.checked }))}
              />
              High priority
            </label>
          </div>
        </div>
      </div>

      {/* Domain toggles */}
      <div className="mt-3 flex flex-wrap gap-2">
        {domains.map((d) => {
          const on = filters.domains.has(d);
          return (
            <button
              key={d}
              type="button"
              onClick={() =>
                setFilters((f) => {
                  const next = new Set(f.domains);
                  if (next.has(d)) next.delete(d);
                  else next.add(d);
                  return { ...f, domains: next };
                })
              }
              className={[
                "rounded-full border px-3 py-1.5 text-sm",
                on ? "bg-gray-900 text-white border-black" : "bg-white hover:bg-gray-50",
              ].join(" ")}
            >
              {d}
            </button>
          );
        })}
      </div>

      {/* Slots & tasks */}
      <div className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-8">
          {!slots.length ? (
            <Empty />
          ) : (
            slots.map(([slotKey, items]) => (
              <section key={slotKey}>
                <div
                  ref={(el) => (slotRefs.current[slotKey] = el)}
                  className="mb-2 flex items-baseline justify-between"
                >
                  <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wider">
                    {slotKey === "unscheduled" ? "Unscheduled" : format(parseISO(`${format(parseISO(effectiveDateISO), "yyyy-MM-dd")}T${slotKey}:00`), "h:mmaaa")}
                  </h2>
                  <button
                    type="button"
                    onClick={() => handleJumpToSlot(slotKey)}
                    className="text-xs text-gray-500 underline decoration-dotted hover:decoration-solid"
                  >
                    Link
                  </button>
                </div>
                <div className="grid gap-3">
                  {items.map((task) => (
                    <TaskCard key={task.id} task={task} conflict={conflictSet.has(task.id)} />
                  ))}
                </div>
              </section>
            ))
          )}
        </div>

        {/* Right rail: Jump list & Today anchors */}
        <aside className="lg:col-span-1 space-y-4">
          <div className="rounded-2xl border p-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">Jump to</h3>
              <button
                type="button"
                onClick={() => setJumpOpen((v) => !v)}
                className="text-xs underline decoration-dotted hover:decoration-solid"
              >
                Open palette
              </button>
            </div>
            <ul className="mt-3 max-h-[320px] overflow-auto space-y-1">
              {jumpList.map((j) => (
                <li key={j.id}>
                  <button
                    type="button"
                    onClick={() => handleJumpToTask(j.id)}
                    className="w-full text-left text-sm hover:bg-gray-50 rounded-lg px-2 py-1"
                    title={j.meta}
                  >
                    <div className="truncate font-medium">{j.label}</div>
                    <div className="truncate text-xs text-gray-500">{j.meta}</div>
                  </button>
                </li>
              ))}
              {!jumpList.length ? <li className="text-sm text-gray-500">No tasks</li> : null}
            </ul>
          </div>

          <div className="rounded-2xl border p-4">
            <h3 className="font-semibold">Shortcuts</h3>
            <div className="mt-2 grid gap-2">
              <button
                type="button"
                onClick={() => {
                  // Find next task (by start) and jump
                  const next = filteredTasks
                    .filter((t) => t.start)
                    .sort((a, b) => parseISO(a.start) - parseISO(b.start))
                    .find((t) => isAfter(parseISO(t.start), new Date()));
                  if (next) handleJumpToTask(next.id);
                }}
                className="rounded-xl border bg-white hover:bg-gray-50 px-3 py-2 text-sm text-left"
              >
                Jump to next task
              </button>

              <button
                type="button"
                onClick={() => {
                  // Jump to current/closest slot
                  const nowStr = format(new Date(), "HH:mm");
                  handleJumpToSlot(nowStr);
                }}
                className="rounded-xl border bg-white hover:bg-gray-50 px-3 py-2 text-sm text-left"
              >
                Jump to now
              </button>
            </div>
          </div>

          {sabbathGuard ? (
            <div className="rounded-2xl border p-4 bg-amber-50">
              <h3 className="font-semibold text-amber-900">Sabbath Guard</h3>
              <p className="mt-1 text-sm text-amber-800">
                Starting tasks may be disabled during Sabbath hours.
              </p>
            </div>
          ) : null}
        </aside>
      </div>

      {/* Jump Palette Modal */}
      {jumpOpen ? (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4"
          role="dialog"
          aria-modal="true"
          onClick={() => setJumpOpen(false)}
        >
          <div
            className="w-full max-w-xl rounded-2xl bg-white shadow-xl border"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-b px-4 py-3">
              <input
                autoFocus
                placeholder="Type to filter tasks…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="w-full rounded-xl border px-3 py-2 text-sm"
              />
            </div>
            <div className="max-h-[50vh] overflow-auto p-2">
              {jumpList.length ? (
                <ul className="space-y-1">
                  {jumpList.map((j) => (
                    <li key={`jump-${j.id}`}>
                      <button
                        type="button"
                        onClick={() => {
                          handleJumpToTask(j.id);
                          setJumpOpen(false);
                        }}
                        className="w-full text-left rounded-lg px-3 py-2 hover:bg-gray-50"
                      >
                        <div className="font-medium">{j.label}</div>
                        <div className="text-xs text-gray-500">{j.meta}</div>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="p-4 text-sm text-gray-500">No matches.</div>
              )}
            </div>
            <div className="border-t px-4 py-3 flex items-center justify-between text-xs text-gray-500">
              <span>Enter to jump • Esc to close</span>
              <span>Ctrl/Cmd + K</span>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Expected task shape (flexible):
 * {
 *   id: string,
 *   title: string,
 *   domain: "meal"|"cleaning"|"animal"|"butchery"|"garden"|"errand",
 *   date: ISODateOnly,               // "2025-10-21"
 *   start: ISODateTime,              // "2025-10-21T09:30:00"
 *   estMinutes: number,              // optional
 *   location: string,                // optional
 *   assignee: string,                // optional @username
 *   description: string,             // optional
 *   priority: "low"|"normal"|"high"|"urgent", // optional
 *   tags: string[],                  // optional
 *   ppe: string[],                   // optional (animal/butchery)
 *   flags: string[],                 // optional (raw-meat, biohazard, chill-chain, heavy-lift, etc.)
 *   checklist: string[],             // optional
 *   dependencies: string[],          // optional (task IDs)
 * }
 *
 * Integration notes:
 * - Provide tasks via props or PlanDraftContext; both work.
 * - Hook up eventBus listeners for external “jump-to-task”:
 *     eventBus.emit("ui.task.jump", { taskId })
 *   and inside this component you may add:
 *     useEffect(() => {
 *       const off = eventBus.on?.("ui.task.jump", ({ taskId }) => handleJumpToTask(taskId));
 *       return () => off?.();
 *     }, [handleJumpToTask]);
 * - To extend: add drag-and-drop reorder, inline editing, assignment pickers, etc.
 */
