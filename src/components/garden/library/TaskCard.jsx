// src/components/garden/library/TaskCard.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";

/* ------------------------------ Defensive imports ------------------------------ */
let automation = null;
try {
  // @ts-ignore
  automation = require("@/services/automation/runtime").automation || null;
} catch (_) {}

let GardenQueueManager = null;
try {
  // @ts-ignore
  GardenQueueManager = require("@/managers/GardenQueueManager").default || null;
} catch (_) {}

let ReminderManager = null;
try {
  // @ts-ignore
  ReminderManager = require("@/managers/ReminderManager").default || null;
} catch (_) {}

let estimateEngine = null;
try {
  // @ts-ignore
  estimateEngine = require("@/engines/estimateEngine").default || null;
} catch (_) {}

let scheduleHelpers = null;
try {
  // @ts-ignore
  scheduleHelpers = require("@/engines/scheduleHelpers").default || require("@/engines/scheduleHelpers") || null;
} catch (_) {}

let NBAInvokeButton = null;
try {
  // Try any shared NBA buttons
  NBAInvokeButton =
    (require("@/components/animals/common/NBAInvokeButton.jsx").default) ||
    (require("@/components/cleaning/common/NBAInvokeButton.jsx").default) ||
    (require("@/components/meals/common/NBAInvokeButton.jsx").default) ||
    null;
} catch (_) {}

/* ----------------------------------- Utils ----------------------------------- */
const emit = (type, detail) => {
  if (automation?.emit) automation.emit(type, detail);
  window.dispatchEvent(new CustomEvent(type, { detail }));
};

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

const fmtDate = (d) => {
  if (!d) return "—";
  const x = d instanceof Date ? d : new Date(d);
  if (isNaN(+x)) return "—";
  return x.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
};

const minutesLabel = (m) => (m ? `${m}m` : "—");

/** Normalize task shape from flexible inputs */
function access(task) {
  const id = task.id || task.key || `${task.crop || task.cropName || "Unknown"}:${task.kind || task.type || "task"}`;
  const kind = (task.kind || task.type || "task").toString().toLowerCase(); // sow | transplant | prune | harvest | seed-saving
  const crop = task.cropName || task.crop || task.variety || task.name || "Unknown crop";
  const bed = task.bedName || task.plotName || task.bed || task.plot || "Unassigned";
  const date = task.targetDate || task.date || task.when || null;
  const notes = task.notes || task.note || "";
  const tags = Array.isArray(task.tags) ? task.tags : [];
  const frostSafe = !!(task.frostSafe ?? task.isFrostTolerant ?? false);
  const requiresPrep = !!(task.requiresPrep ?? task.needsPreStep ?? false);
  const conflicts = Array.isArray(task.conflicts) ? task.conflicts : [];
  const priority = Number.isFinite(task.priority) ? task.priority : (task.importance ?? 0);
  const score = Number.isFinite(task.score) ? task.score : (Number(task.rank) || 0);
  const effort = Number.isFinite(task.effort) ? task.effort : (Number(task.effortLevel) || null); // 1..5
  const durationMin =
    Number.isFinite(task.durationMin) ? task.durationMin :
    Number.isFinite(task.minutes) ? task.minutes :
    (estimateEngine?.duration?.(task) ?? null);

  // Optional timer (for pre-sprout, soak, proof, etc.)
  const timer = task.timer || null; // { startedAt: ISO, durationSec: number }
  return {
    id, kind, crop, bed, date, notes, tags,
    frostSafe, requiresPrep, conflicts, priority, score, effort, durationMin, timer,
    raw: task
  };
}

/* ----------------------------------- Icons ----------------------------------- */
/** Minimal icon set without external deps (emojis for broad support) */
function KindIcon({ kind }) {
  const k = (kind || "").toLowerCase();
  const map = {
    sow: "🌱",           // seeding
    transplant: "🪴",    // transplanting
    prune: "✂️",         // pruning
    harvest: "🧺",       // harvest
    "seed-saving": "🌾", // seed saving
    weeding: "🧤",
    water: "💧",
    fertilize: "🧪",
  };
  const emoji = map[k] || "🧰";
  return <span aria-hidden className="mr-1">{emoji}</span>;
}

/* --------------------------------- Badges ---------------------------------- */
function Badge({ children, kind = "default", title }) {
  const styles = {
    default: "border-gray-300 text-gray-700",
    good: "border-green-300 text-green-700 bg-green-50",
    warn: "border-amber-300 text-amber-700 bg-amber-50",
    danger: "border-red-300 text-red-700 bg-red-50",
    info: "border-blue-300 text-blue-700 bg-blue-50",
  }[kind] || "border-gray-300 text-gray-700";
  return (
    <span title={title} className={`inline-block text-[10px] border px-2 py-0.5 rounded-full ${styles}`}>
      {children}
    </span>
  );
}

/* ------------------------------ Countdown / Timer ------------------------------ */
function useCountdown(timer) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!timer?.startedAt || !timer?.durationSec) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [timer?.startedAt, timer?.durationSec]);

  if (!timer?.startedAt || !timer?.durationSec) return { pct: 0, leftSec: null, done: false };
  const start = new Date(timer.startedAt).getTime();
  const end = start + timer.durationSec * 1000;
  const leftMs = Math.max(0, end - now);
  const pct = clamp(1 - leftMs / (timer.durationSec * 1000), 0, 1);
  return { pct, leftSec: Math.floor(leftMs / 1000), done: leftMs === 0 };
}

function ProgressBar({ pct }) {
  return (
    <div className="h-1.5 w-full bg-gray-100 rounded-full overflow-hidden">
      <div
        className="h-1.5 bg-gray-900"
        style={{ width: `${clamp(Math.round(pct * 100), 0, 100)}%` }}
        aria-hidden
      />
    </div>
  );
}

/* ---------------------------------- Card ---------------------------------- */
export default function TaskCard({
  task,
  dense = false,
  onAdd,       // (task) => void  (optional override)
  onRemind,    // (task) => void
  onDetails,   // (task) => void
  onEdit,      // (task) => void
  onDelete,    // (task) => void
}) {
  const a = useMemo(() => access(task), [task]);
  const effort = clamp(a.effort ?? 3, 1, 5);
  const conflictCount = a.conflicts?.length || 0;
  const { pct, leftSec, done } = useCountdown(a.timer);

  /* ------------------------------ Actions / wiring ----------------------------- */
  const addToPlan = () => {
    if (onAdd) return onAdd(task);
    if (GardenQueueManager?.queue) {
      GardenQueueManager.queue({ type: "planner.add.tasks", payload: [task] });
    }
    emit("garden.planner.add", { count: 1, item: task });
    emit("ui.toast", { kind: "success", message: "Added to plan." });
    emit("ui.undo", {
      message: "Task added to plan.",
      actionLabel: "Undo",
      action: { type: "planner.remove.tasks", payload: [a.id] }
    });
  };

  const scheduleReminder = () => {
    if (onRemind) return onRemind(task);
    if (!ReminderManager?.schedule) {
      emit("garden.reminder.simulated", { count: 1, item: task });
      emit("ui.toast", { kind: "info", message: "Reminder simulated (manager missing)." });
      return;
    }
    const when =
      a.date ? new Date(a.date) :
      (scheduleHelpers?.nextWindow?.({ scope: "garden", kind: a.kind }) ?? new Date(Date.now() + 86400000));

    ReminderManager.schedule({
      title: `${a.kind}: ${a.crop} → ${a.bed}`,
      notes: a.notes || "Scheduled from TaskCard",
      date: when,
      tags: ["garden", "task"]
    });
    emit("garden.reminders.scheduled", { count: 1, item: task });
    emit("ui.toast", { kind: "success", message: "Reminder scheduled." });
  };

  const openDetails = () => {
    if (onDetails) return onDetails(task);
    emit("garden.task.open", { id: a.id, item: task });
    if (conflictCount > 0) emit("garden.decider.conflict.request", { id: a.id, item: task });
  };

  const editTask = () => {
    if (onEdit) return onEdit(task);
    emit("garden.task.edit.request", { id: a.id, item: task });
  };

  const deleteTask = () => {
    if (onDelete) return onDelete(task);
    emit("garden.task.delete.request", { id: a.id, item: task });
    emit("ui.toast", { kind: "warn", message: "Task archived (pending confirm)." });
    emit("ui.undo", {
      message: "Task archived.",
      actionLabel: "Undo",
      action: { type: "garden.task.restore", payload: [a.id] }
    });
  };

  /* ----------------------------------- UI ----------------------------------- */
  return (
    <article
      className={`relative rounded-2xl border bg-white ${dense ? "p-3" : "p-4"} shadow-sm hover:shadow transition`}
      aria-label={`${a.kind} ${a.crop} in ${a.bed}`}
    >
      {/* Checkbox slot (optional: selection in parent lists) */}
      <div className="absolute top-2 right-2 flex items-center gap-2">
        {NBAInvokeButton ? (
          <NBAInvokeButton
            scope="garden"
            intent="task.card"
            label="NBA"
            payload={{ id: a.id, kind: a.kind }}
            className="!px-2 !py-1 text-xs"
          />
        ) : (
          <button
            className="rounded-md border px-2 py-1 text-xs hover:bg-gray-50"
            onClick={() => emit("nba.requested", { scope: "garden", from: "TaskCard", id: a.id })}
            title="Request Next Best Action"
          >
            NBA
          </button>
        )}
      </div>

      {/* Header */}
      <header className="mb-1">
        <div className="flex items-center gap-2">
          <div className="text-sm font-semibold text-gray-900 flex items-center">
            <KindIcon kind={a.kind} />
            <span className="capitalize">{a.kind}</span>
          </div>
          <div className="text-xs text-gray-500">• {fmtDate(a.date)}</div>
        </div>
        <div className="text-xs text-gray-600">
          {a.crop} <span className="text-gray-400">→</span> {a.bed}
        </div>
      </header>

      {/* Meta line */}
      <div className="text-[11px] text-gray-500 mb-2">
        Score {Math.round(a.score)} • Effort {effort}/5 • {minutesLabel(a.durationMin)}
        {a.priority > 0 ? <> • Priority +{a.priority}</> : null}
      </div>

      {/* Badges */}
      <div className="flex flex-wrap gap-1 mb-2">
        {a.frostSafe && <Badge kind="good" title="Catalog: frost tolerant">frost-safe</Badge>}
        {a.requiresPrep && <Badge kind="info" title="Requires pre-steps (soak, tray, pre-mix, etc.)">prep</Badge>}
        {!!conflictCount && <Badge kind="danger" title={`${conflictCount} potential conflicts`}>conflict</Badge>}
        {(a.tags || []).slice(0, 4).map((t) => <Badge key={t}>{t}</Badge>)}
      </div>

      {/* Notes */}
      {a.notes ? <p className="text-[12px] text-gray-700 mb-3 line-clamp-3">{a.notes}</p> : null}

      {/* Timer / Countdown (if present) */}
      {a.timer ? (
        <div className="mb-3">
          <ProgressBar pct={pct} />
          <div className="mt-1 text-[11px] text-gray-500">
            {done ? "Timer complete" : `Timer: ${Math.floor((leftSec || 0) / 60)}m ${(leftSec || 0) % 60}s left`}
          </div>
        </div>
      ) : null}

      {/* Actions */}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50"
          onClick={addToPlan}
          title="Add this task to the plan"
        >
          Add
        </button>
        <button
          type="button"
          className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50"
          onClick={scheduleReminder}
          title="Schedule reminder"
        >
          Remind
        </button>
        <button
          type="button"
          className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50"
          onClick={openDetails}
          title="Open details / conflict resolver"
        >
          Details
        </button>
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50"
            onClick={editTask}
            title="Edit task"
          >
            Edit
          </button>
          <button
            type="button"
            className="rounded-lg border px-3 py-1.5 text-sm hover:bg-red-50 border-red-200 text-red-700"
            onClick={deleteTask}
            title="Archive / delete"
          >
            Delete
          </button>
        </div>
      </div>

      {/* Footer hint */}
      <footer className="mt-2 text-[11px] text-gray-500">
        Tip: Use “Details” to resolve conflicts or attach pre-steps (soak/sterilize/tray mix) with timers.
      </footer>
    </article>
  );
}
