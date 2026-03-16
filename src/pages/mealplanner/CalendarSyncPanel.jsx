// src/pages/MealPlanning/CalendarSyncPanel.jsx
import React, { useEffect, useMemo, useState, useCallback } from "react";
import { addDays, startOfWeek, format } from "date-fns";

/**
 * CalendarSyncPanel — dynamic, alias-safe, multi-range
 * ------------------------------------------------------------------
 * Purpose:
 *  Preview & push meal plan items, batch sessions, and prep tasks to the user's calendar.
 *
 * Highlights:
 *  - Auto vs Manual (tag)
 *  - Dry-run preview with conflict detection & de-dupe
 *  - Sabbath-aware guard (hands-off)
 *  - Next Best Action: "Share schedule"
 *  - Event-driven glue (listens & emits)
 *  - Undo pattern for last sync batch
 *  - Empty states with helpful tips
 *  - Multi-range support to match CalendarPreview:
 *    Week (7), 2 Weeks (14), Month (FULL padded weeks), Quarter (true calendar Q),
 *    Custom (date range picker)
 *
 * Props (optional):
 *  - mode: "auto" | "manual"                    // default "manual"
 *  - defaultCalendarId: string                  // e.g. "primary"
 *  - initialRange: { start: Date|ISO, end: Date|ISO }
 *  - onSynced: (payload) => void
 *  - include: { meals?: boolean, batches?: boolean, tasks?: boolean } // optional category toggles
 */

// ---------- Minimal UI (alias-free) ----------
const cx = (...a) => a.filter(Boolean).join(" ");
const Btn = ({ variant = "solid", size = "md", className, ...props }) => {
  const v = {
    solid: "bg-black text-white hover:opacity-90 disabled:opacity-50",
    outline: "border hover:bg-zinc-50",
    ghost: "hover:bg-zinc-100",
  }[variant];
  const s = {
    sm: "h-8 px-2 text-sm",
    md: "h-10 px-3 text-sm",
    icon: "h-9 w-9 p-0",
  }[size];
  return <button className={cx("rounded-xl", v, s, className)} {...props} />;
};
const Tag = ({ children, tone = "zinc" }) => (
  <span
    className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium border-${tone}-300 text-${tone}-700 bg-${tone}-50`}
  >
    {children}
  </span>
);
const SectionCard = ({ title, count, children, footer }) => (
  <div className="rounded-2xl border p-4">
    <div className="mb-3 flex items-center justify-between">
      <div className="text-sm font-semibold">
        {title} <span className="text-zinc-400">({count})</span>
      </div>
      {footer}
    </div>
    {children}
  </div>
);

// ---------- Soft imports with graceful fallbacks ----------
let eventBus = { on: () => {}, off: () => {}, emit: () => {} };
try {
  // preferred location per your other files
  eventBus = require("@/services/events/eventBus");
  if (eventBus.emit && !eventBus.on) {
    // support both { emit, on, off } or default export
    eventBus = { on: eventBus.on, off: eventBus.off, emit: eventBus.emit };
  }
} catch {}

let automation = {};
let emitProgress = () => {};
try {
  const rt = require("@/services/automation/runtime");
  automation = rt.automation ?? {};
  emitProgress = rt.emitProgress ?? (() => {});
} catch {}

let PreferencesStore = {};
try {
  PreferencesStore = require("@/store/PreferencesStore");
} catch {}

let MealPlanStore = {};
try {
  MealPlanStore = require("@/store/MealPlanStore");
} catch {}

let TasksStore = {};
try {
  TasksStore = require("@/store/TasksStore");
} catch {}

let BatchStore = {};
try {
  BatchStore = require("@/store/BatchStore");
} catch {}

let fmt = {
  time: (iso) => new Date(iso).toLocaleString(),
  date: (iso) => new Date(iso).toLocaleDateString(),
  range: (s, e) =>
    `${new Date(s).toLocaleString()} – ${new Date(e).toLocaleString()}`,
};
try {
  const f = require("@/utils/format");
  fmt = { ...fmt, ...f };
} catch {}

const nowIso = () => new Date().toISOString();
const toISO = (d) =>
  typeof d === "string" ? d : d?.toISOString?.() || nowIso();
const arrayify = (v) => (Array.isArray(v) ? v : v ? [v] : []);

// ---------- Period helpers (match CalendarPreview semantics) ----------
const PERIODS = [
  { key: "week", label: "Week", spec: 7 },
  { key: "2w", label: "2 Weeks", spec: 14 },
  { key: "month", label: "Month (Full Calendar)", spec: "month-full" },
  { key: "quarter", label: "Quarter (True Calendar)", spec: "quarter" },
  { key: "custom", label: "Custom", spec: "custom" },
];

function lastDayOfMonth(y, m) {
  return new Date(y, m + 1, 0);
}
function quarterStart(date) {
  const m = date.getMonth();
  const qStart = Math.floor(m / 3) * 3;
  return new Date(date.getFullYear(), qStart, 1);
}
function quarterEnd(date) {
  const qs = quarterStart(date);
  return new Date(qs.getFullYear(), qs.getMonth() + 3, 0);
}

function enumerateDates(anchor, spec, custom) {
  if (spec === "custom") {
    return (custom || []).slice().sort((a, b) => a - b);
  }
  if (spec === "month-full") {
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const last = lastDayOfMonth(anchor.getFullYear(), anchor.getMonth());
    const start = startOfWeek(first, { weekStartsOn: 0 });
    const endPad = addDays(last, (6 - last.getDay() + 7) % 7);
    const dates = [];
    for (let d = new Date(start); d <= endPad; d = addDays(d, 1))
      dates.push(new Date(d));
    return dates;
  }
  if (spec === "quarter") {
    const start = quarterStart(anchor);
    const end = quarterEnd(anchor);
    const dates = [];
    for (let d = new Date(start); d <= end; d = addDays(d, 1))
      dates.push(new Date(d));
    return dates;
  }
  if (typeof spec === "number") {
    const start = startOfWeek(anchor, { weekStartsOn: 0 });
    return Array.from({ length: spec }, (_, i) => addDays(start, i));
  }
  return [];
}

// ---------- Guards ----------
const sabbathGuard = (prefs) => {
  const active = prefs?.torahProfile?.sabbath?.isActive;
  const handsOff = prefs?.torahProfile?.sabbath?.handsOffCooking === true;
  return !(active && handsOff);
};

// ---------- Normalizers ----------
const normalizeMealEvents = (meals = []) =>
  meals.filter(Boolean).map((m) => ({
    id: m.id || `meal_${Math.random().toString(36).slice(2)}`,
    type: "meal",
    title: m.title || m.name || "Meal",
    start: toISO(m.start || m.when || nowIso()),
    end: toISO(m.end || m.until || new Date(Date.now() + 60 * 60 * 1000)),
    meta: {
      tags: m.tags || [],
      people: m.people || [],
      calories: m.nutrition?.calories,
    },
  }));

const normalizeBatchEvents = (batches = []) =>
  batches.filter(Boolean).map((b) => ({
    id: b.id || `batch_${Math.random().toString(36).slice(2)}`,
    type: "batch",
    title: b.title || "Batch Cooking Session",
    start: toISO(b.start || b.createdAt || nowIso()),
    end: toISO(
      b.end ||
        (b.estimates?.totalMinutes
          ? new Date(Date.now() + (b.estimates.totalMinutes || 60) * 60 * 1000)
          : new Date(Date.now() + 90 * 60 * 1000))
    ),
    meta: {
      recipesCount: b.recipes?.length || 0,
      totalMinutes: b.estimates?.totalMinutes,
      macro: {
        proteinPct: b.nutritionTotals?.proteinPct,
        carbsPct: b.nutritionTotals?.carbsPct,
        fatPct: b.nutritionTotals?.fatPct,
      },
    },
  }));

const normalizeTaskEvents = (tasks = []) =>
  tasks.filter(Boolean).map((t) => ({
    id: t.id || `task_${Math.random().toString(36).slice(2)}`,
    type: "task",
    title: t.title || t.name || "Task",
    start: toISO(t.start || nowIso()),
    end: toISO(t.end || new Date(Date.now() + 30 * 60 * 1000)),
    meta: { kind: t.kind || "prep", priority: t.priority || "normal" },
  }));

const dedupeByKey = (items) => {
  const map = new Map();
  for (const ev of items) {
    const key = `${ev.type}:${ev.title}:${ev.start}`;
    if (!map.has(key)) map.set(key, ev);
  }
  return Array.from(map.values());
};

const detectConflicts = (events) => {
  const sorted = [...events].sort(
    (a, b) => new Date(a.start) - new Date(b.start)
  );
  const conflicts = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const cur = sorted[i];
    const next = sorted[i + 1];
    if (new Date(cur.end) > new Date(next.start)) {
      conflicts.push({ a: cur, b: next });
    }
  }
  return conflicts;
};

// ---------- Component ----------
export default function CalendarSyncPanel({
  mode = "manual",
  defaultCalendarId = "primary",
  initialRange = undefined,
  onSynced = () => {},
  include = { meals: true, batches: true, tasks: true },
}) {
  // Preferences (sabbath guard, etc.)
  const [prefs, setPrefs] = useState(() => {
    try {
      return PreferencesStore?.getPreferences?.() || {};
    } catch {
      return {};
    }
  });

  // Period & custom range to mirror CalendarPreview
  const today = new Date();
  const [periodKey, setPeriodKey] = useState("week"); // week | 2w | month | quarter | custom
  const periodSpec = useMemo(
    () => PERIODS.find((p) => p.key === periodKey)?.spec,
    [periodKey]
  );

  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const customDates = useMemo(() => {
    if (periodSpec !== "custom" || !customStart || !customEnd) return [];
    const s = new Date(customStart);
    const e = new Date(customEnd);
    if (isNaN(s) || isNaN(e) || s > e) return [];
    const out = [];
    for (let d = new Date(s); d <= e; d = addDays(d, 1)) out.push(new Date(d));
    return out;
  }, [periodSpec, customStart, customEnd]);

  const [anchor, setAnchor] = useState(startOfWeek(today, { weekStartsOn: 0 }));
  const [calendarId, setCalendarId] = useState(defaultCalendarId);

  // Preview & UI
  const [preview, setPreview] = useState({
    meals: [],
    batches: [],
    tasks: [],
    all: [],
    conflicts: [],
  });
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null); // {type, msg, actionLabel, onAction}
  const [undoStack, setUndoStack] = useState([]);
  const isSabbathBlocked = useMemo(() => !sabbathGuard(prefs), [prefs]);

  // Pull data from stores with the resolved period range (graceful if missing)
  const resolvedRange = useMemo(() => {
    if (initialRange?.start && initialRange?.end) return initialRange;
    const dates = enumerateDates(anchor, periodSpec, customDates);
    const start = dates[0] || anchor;
    const end = dates[dates.length - 1] || addDays(anchor, 6);
    return { start, end };
  }, [initialRange, anchor, periodSpec, customDates]);

  const meals = useMemo(() => {
    try {
      if (!include.meals) return [];
      return arrayify(
        MealPlanStore?.getMealsInRange?.(
          resolvedRange.start,
          resolvedRange.end
        ) ||
          MealPlanStore?.getMeals?.() ||
          []
      );
    } catch {
      return [];
    }
  }, [resolvedRange, include.meals]);

  const batches = useMemo(() => {
    try {
      if (!include.batches) return [];
      return arrayify(
        BatchStore?.getDrafts?.() || BatchStore?.getPlanned?.() || []
      );
    } catch {
      return [];
    }
  }, [include.batches]);

  const tasks = useMemo(() => {
    try {
      if (!include.tasks) return [];
      return arrayify(
        TasksStore?.getPending?.({ kind: "prep" }) ||
          TasksStore?.getAll?.() ||
          []
      );
    } catch {
      return [];
    }
  }, [include.tasks]);

  // Build preview on data/period change
  useEffect(() => {
    const mealEvents = normalizeMealEvents(meals);
    const batchEvents = normalizeBatchEvents(batches);
    const taskEvents = normalizeTaskEvents(tasks);

    const all = dedupeByKey([
      ...(include.meals ? mealEvents : []),
      ...(include.batches ? batchEvents : []),
      ...(include.tasks ? taskEvents : []),
    ]);
    const conflicts = detectConflicts(all);
    setPreview({
      meals: mealEvents,
      batches: batchEvents,
      tasks: taskEvents,
      all,
      conflicts,
    });
  }, [meals, batches, tasks, include]);

  // Listen to global updates (preferences, plan, tasks, etc.)
  useEffect(() => {
    const refreshPrefs = () => {
      try {
        setPrefs(PreferencesStore?.getPreferences?.() || {});
      } catch {}
    };
    const rebuild = () => {
      try {
        const mealEvents = normalizeMealEvents(
          include.meals
            ? MealPlanStore?.getMealsInRange?.(
                resolvedRange.start,
                resolvedRange.end
              ) ||
                MealPlanStore?.getMeals?.() ||
                []
            : []
        );
        const batchEvents = include.batches
          ? normalizeBatchEvents(
              BatchStore?.getDrafts?.() || BatchStore?.getPlanned?.() || []
            )
          : [];
        const taskEvents = include.tasks
          ? normalizeTaskEvents(
              TasksStore?.getPending?.({ kind: "prep" }) ||
                TasksStore?.getAll?.() ||
                []
            )
          : [];
        const all = dedupeByKey([...mealEvents, ...batchEvents, ...taskEvents]);
        const conflicts = detectConflicts(all);
        setPreview({
          meals: mealEvents,
          batches: batchEvents,
          tasks: taskEvents,
          all,
          conflicts,
        });
      } catch {}
    };
    const handlers = [
      ["preferences.changed", refreshPrefs],
      ["mealplan.updated", rebuild],
      ["recipe.consolidated", rebuild],
      ["inventory.updated", rebuild],
      ["tasks.updated", rebuild],
      ["calendar.synced", rebuild],
    ];
    handlers.forEach(([e, fn]) => eventBus.on(e, fn));
    return () => handlers.forEach(([e, fn]) => eventBus.off(e, fn));
  }, [resolvedRange, include]);

  // Actions
  const runPreview = () => {
    if (!preview.all.length) {
      setToast({
        type: "info",
        msg: "Nothing to preview. Add meals, batch sessions, or prep tasks.",
      });
      return;
    }
    const conflicts = detectConflicts(preview.all);
    setPreview((p) => ({ ...p, conflicts }));
    setToast({
      type: conflicts.length ? "warning" : "success",
      msg: conflicts.length
        ? `Preview updated. ${conflicts.length} potential conflict(s) detected.`
        : "Preview ready. No conflicts found.",
    });
  };

  const syncNow = async () => {
    if (isSabbathBlocked) {
      setToast({
        type: "warning",
        msg: "Sabbath hands-off is active. Calendar sync is paused. You may still preview and share quietly.",
      });
      return;
    }
    if (!preview.all.length) {
      setToast({
        type: "info",
        msg: "No items to sync. Add meals, batch sessions, or prep tasks.",
      });
      return;
    }
    setBusy(true);
    try {
      emitProgress?.({
        id: "calendar.sync",
        at: nowIso(),
        message: `Syncing ${preview.all.length} item(s) to calendar…`,
        context: { calendarId, range: resolvedRange },
      });

      // Hint: pass idempotency key so backends can be safe to retry
      const idemKey = `cal_${Math.random().toString(36).slice(2)}`;

      // Emit an intent for your calendar backend.
      eventBus.emit("calendar.sync.requested", {
        at: nowIso(),
        idempotencyKey: idemKey,
        calendarId,
        range: resolvedRange,
        items: preview.all,
        conflicts: preview.conflicts,
        mode,
      });

      // Simulate success or let your listener emit "calendar.synced"
      eventBus.emit("calendar.synced", {
        at: nowIso(),
        calendarId,
        count: preview.all.length,
        ids: preview.all.map((e) => e.id),
        range: resolvedRange,
      });

      automation?.record?.("calendar.synced", {
        calendarId,
        count: preview.all.length,
        mode,
        range: resolvedRange,
      });

      setUndoStack((s) => [
        ...s,
        {
          type: "calendar.sync",
          payload: {
            calendarId,
            range: resolvedRange,
            items: preview.all,
            conflicts: preview.conflicts,
            timestamp: nowIso(),
          },
        },
      ]);

      setToast({
        type: "success",
        msg: `Synced ${preview.all.length} item(s) to calendar.`,
        actionLabel: "Share schedule",
        onAction: () =>
          eventBus.emit("sharing.open", {
            panel: "FamilySharing",
            payload: {
              calendarId,
              range: resolvedRange,
              items: preview.all,
              purpose: "meal/batch/tasks",
              autoForecasts: true,
            },
          }),
      });

      onSynced?.({ calendarId, items: preview.all, range: resolvedRange });
    } catch (err) {
      console.error("[CalendarSyncPanel] sync error", err);
      setToast({
        type: "error",
        msg: "Calendar sync failed. Please try again.",
      });
    } finally {
      setBusy(false);
    }
  };

  const undoLast = () => {
    const last = undoStack[undoStack.length - 1];
    if (!last) return;
    setUndoStack((s) => s.slice(0, -1));
    if (last.type === "calendar.sync") {
      eventBus.emit("calendar.sync.reverted", {
        at: nowIso(),
        calendarId: last.payload.calendarId,
        ids: last.payload.items.map((e) => e.id),
        range: last.payload.range,
      });
      setToast({ type: "info", msg: "Last calendar sync reverted." });
    }
  };

  // Period navigation
  const jumpPrev = () => {
    if (periodSpec === "month-full") {
      setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1));
    } else if (periodSpec === "quarter") {
      setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() - 3, 1));
    } else if (typeof periodSpec === "number") {
      setAnchor(addDays(anchor, -periodSpec));
    } else {
      setAnchor(addDays(anchor, -7)); // custom fallback nudge
    }
  };
  const jumpNext = () => {
    if (periodSpec === "month-full") {
      setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1));
    } else if (periodSpec === "quarter") {
      setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + 3, 1));
    } else if (typeof periodSpec === "number") {
      setAnchor(addDays(anchor, periodSpec));
    } else {
      setAnchor(addDays(anchor, 7));
    }
  };

  // UI bits
  const Toast = () =>
    toast ? (
      <div
        className={cx(
          "fixed bottom-4 right-4 z-50 max-w-sm rounded-xl px-4 py-3 shadow-lg",
          toast.type === "success" && "bg-green-600 text-white",
          toast.type === "warning" && "bg-yellow-600 text-white",
          toast.type === "error" && "bg-red-600 text-white",
          toast.type === "info" && "bg-zinc-900 text-white"
        )}
      >
        <div className="text-sm">{toast.msg}</div>
        {toast.actionLabel && toast.onAction ? (
          <button
            className="mt-2 rounded-lg border border-white/20 px-2 py-1 text-xs hover:bg-white/10"
            onClick={toast.onAction}
          >
            {toast.actionLabel}
          </button>
        ) : null}
      </div>
    ) : null;

  // Render
  return (
    <section className="flex flex-col gap-4">
      {/* Header */}
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">Calendar Sync</h2>
          <Tag tone={mode === "auto" ? "violet" : "zinc"}>
            {mode === "auto" ? "auto" : "manual"}
          </Tag>
        </div>

        <div className="flex items-center gap-2">
          {/* Period controls */}
          <div className="flex items-center gap-1">
            <Btn
              variant="ghost"
              size="icon"
              onClick={jumpPrev}
              aria-label="Previous period"
            >
              ←
            </Btn>
            <Btn
              variant="ghost"
              size="icon"
              onClick={jumpNext}
              aria-label="Next period"
            >
              →
            </Btn>
          </div>
          <select
            className="rounded-xl border px-2 py-2 text-sm"
            value={periodKey}
            onChange={(e) => setPeriodKey(e.target.value)}
            title="Choose planning period"
          >
            {PERIODS.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>

          {/* Custom range UI */}
          {periodKey === "custom" && (
            <div className="flex items-center gap-2">
              <input
                className="h-9 rounded-xl border px-2 text-sm"
                type="date"
                value={customStart}
                onChange={(e) => setCustomStart(e.target.value)}
              />
              <span className="text-sm text-zinc-500">to</span>
              <input
                className="h-9 rounded-xl border px-2 text-sm"
                type="date"
                value={customEnd}
                onChange={(e) => setCustomEnd(e.target.value)}
              />
            </div>
          )}

          <select
            className="rounded-xl border px-2 py-2 text-sm"
            value={calendarId}
            onChange={(e) => setCalendarId(e.target.value)}
            title="Choose calendar"
          >
            <option value="primary">Primary</option>
            <option value="meals">Meals</option>
            <option value="batches">Batch Cooking</option>
            <option value="tasks">Tasks</option>
          </select>

          <Btn
            variant="outline"
            onClick={runPreview}
            disabled={!preview.all.length}
          >
            Preview
          </Btn>
          <Btn
            variant="solid"
            onClick={syncNow}
            disabled={busy || isSabbathBlocked || !preview.all.length}
            title={
              isSabbathBlocked
                ? "Sabbath hands-off is active"
                : "Push to calendar"
            }
          >
            {busy ? "Syncing…" : "Sync Now"}
          </Btn>
          <Btn
            variant="outline"
            onClick={undoLast}
            disabled={!undoStack.length}
          >
            Undo
          </Btn>
        </div>
      </header>

      {/* Notices */}
      {isSabbathBlocked ? (
        <div className="rounded-xl border border-violet-300 bg-violet-50 px-3 py-2 text-xs text-violet-900">
          Sabbath hands-off mode prevents starting new syncs. You can still
          preview, reorder, and share quietly.
        </div>
      ) : null}

      {/* Conflict summary */}
      {preview.conflicts.length > 0 && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <div className="font-medium">
            {preview.conflicts.length} potential conflict(s) detected
          </div>
          <ul className="ml-4 list-disc text-xs">
            {preview.conflicts.slice(0, 5).map((c, idx) => (
              <li key={idx} className="mt-1">
                <span className="font-medium">{c.a.title}</span> overlaps{" "}
                <span className="font-medium">{c.b.title}</span>{" "}
                <span className="text-amber-800">
                  ({fmt.range(c.a.start, c.a.end)} vs{" "}
                  {fmt.range(c.b.start, c.b.end)})
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-2 text-xs">
            <button
              className="underline"
              onClick={() =>
                eventBus.emit("ui.open", {
                  panel: "CalendarPreview",
                  items: preview.all,
                })
              }
            >
              Open timeline preview
            </button>
          </div>
        </div>
      )}

      {/* Category toggles */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-zinc-500">Include:</span>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={!!include.meals}
            onChange={() => {}}
            readOnly
          />
          Meals
        </label>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={!!include.batches}
            onChange={() => {}}
            readOnly
          />
          Batch Sessions
        </label>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={!!include.tasks}
            onChange={() => {}}
            readOnly
          />
          Prep Tasks
        </label>
        <span className="ml-auto text-zinc-400 text-[11px]">
          {format(resolvedRange.start, "MMM d")} –{" "}
          {format(resolvedRange.end, "MMM d, yyyy")}
        </span>
      </div>

      {/* Content */}
      {!preview.all.length ? (
        <EmptyState />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          {/* Meals */}
          <div className="lg:col-span-4">
            <SectionCard
              title="Meals"
              count={preview.meals.length}
              footer={
                <button
                  className="text-xs underline"
                  onClick={() =>
                    eventBus.emit("ui.open", { panel: "MealPlanner" })
                  }
                >
                  Edit meals
                </button>
              }
            >
              {preview.meals.length === 0 ? (
                <div className="rounded-lg border border-dashed p-3 text-xs text-zinc-600">
                  No meals in this window.
                </div>
              ) : (
                <ul className="max-h-56 space-y-2 overflow-auto pr-1">
                  {preview.meals.map((m) => (
                    <li key={m.id} className="rounded-xl border p-3 text-xs">
                      <div className="flex items-center justify-between">
                        <div className="truncate font-medium">{m.title}</div>
                        <div className="shrink-0 text-zinc-500">
                          {fmt.date(m.start)}
                        </div>
                      </div>
                      <div className="mt-1 text-[11px] text-zinc-500">
                        {fmt.range(m.start, m.end)}
                        {m.meta?.calories ? ` • ${m.meta.calories} kcal` : ""}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
          </div>

          {/* Batch Sessions */}
          <div className="lg:col-span-4">
            <SectionCard
              title="Batch Sessions"
              count={preview.batches.length}
              footer={
                <button
                  className="text-xs underline"
                  onClick={() =>
                    eventBus.emit("ui.open", { panel: "BatchSessionPlanner" })
                  }
                >
                  Edit sessions
                </button>
              }
            >
              {preview.batches.length === 0 ? (
                <div className="rounded-lg border border-dashed p-3 text-xs text-zinc-600">
                  No sessions linked.
                </div>
              ) : (
                <ul className="max-h-56 space-y-2 overflow-auto pr-1">
                  {preview.batches.map((b) => (
                    <li key={b.id} className="rounded-xl border p-3 text-xs">
                      <div className="flex items-center justify-between">
                        <div className="truncate font-medium">{b.title}</div>
                        <div className="shrink-0 text-zinc-500">
                          {fmt.date(b.start)}
                        </div>
                      </div>
                      <div className="mt-1 text-[11px] text-zinc-500">
                        {fmt.range(b.start, b.end)} •{" "}
                        {b.meta?.recipesCount || 0} recipes
                      </div>
                      <div className="mt-1 text-[11px] text-zinc-500">
                        Macro: P{b.meta?.macro?.proteinPct ?? 0}% / C
                        {b.meta?.macro?.carbsPct ?? 0}% / F
                        {b.meta?.macro?.fatPct ?? 0}%
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
          </div>

          {/* Prep Tasks */}
          <div className="lg:col-span-4">
            <SectionCard
              title="Prep Tasks"
              count={preview.tasks.length}
              footer={
                <button
                  className="text-xs underline"
                  onClick={() =>
                    eventBus.emit("ui.open", {
                      panel: "PrepChecklistGenerator",
                    })
                  }
                >
                  Edit tasks
                </button>
              }
            >
              {preview.tasks.length === 0 ? (
                <div className="rounded-lg border border-dashed p-3 text-xs text-zinc-600">
                  No prep tasks generated.
                </div>
              ) : (
                <ul className="max-h-56 space-y-2 overflow-auto pr-1">
                  {preview.tasks.map((t) => (
                    <li key={t.id} className="rounded-xl border p-3 text-xs">
                      <div className="flex items-center justify-between">
                        <div className="truncate font-medium">{t.title}</div>
                        <div className="shrink-0 text-zinc-500">
                          {fmt.date(t.start)}
                        </div>
                      </div>
                      <div className="mt-1 text-[11px] text-zinc-500">
                        {fmt.range(t.start, t.end)} • {t.meta?.kind || "task"} •{" "}
                        {t.meta?.priority}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
          </div>
        </div>
      )}

      {/* Footer: NBA */}
      <div className="flex items-center justify-between rounded-2xl border bg-zinc-50 p-3">
        <div className="text-sm">
          <span className="font-semibold">Next Best Action:</span> Share
          schedule with family agrarian
        </div>
        <div className="flex items-center gap-2">
          <Btn
            variant="outline"
            onClick={() =>
              eventBus.emit("sharing.open", {
                panel: "FamilySharing",
                payload: {
                  calendarId,
                  range: resolvedRange,
                  items: preview.all,
                  purpose: "meal/batch/tasks",
                  autoForecasts: true,
                },
              })
            }
          >
            Share schedule
          </Btn>
          <Btn
            variant="outline"
            onClick={() =>
              eventBus.emit("ui.open", {
                panel: "CalendarPreview",
                items: preview.all,
              })
            }
          >
            Timeline preview
          </Btn>
        </div>
      </div>

      <Toast />
    </section>
  );
}

/* ===========================
   Lightweight TESTS (dev only)
   =========================== */
(function runCalendarSyncPanelTestsOnce() {
  if (typeof window === "undefined") return;
  if (window.__CAL_SYNC_TESTS__) return;
  window.__CAL_SYNC_TESTS__ = true;

  const expect = (cond, msg) =>
    cond
      ? console.log("[CalendarSync TEST PASS]", msg)
      : console.error("[CalendarSync TEST FAIL]", msg);

  // ISO normalization
  const iso = new Date().toISOString();
  expect(
    typeof toISO(iso) === "string" && typeof toISO(new Date()) === "string",
    "toISO normalizes Date|string"
  );

  // Dedupe logic
  const dup = [
    {
      type: "meal",
      title: "A",
      start: "2025-01-01T10:00:00Z",
      end: "2025-01-01T11:00:00Z",
    },
    {
      type: "meal",
      title: "A",
      start: "2025-01-01T10:00:00Z",
      end: "2025-01-01T11:00:00Z",
    },
  ];
  expect(dedupeByKey(dup).length === 1, "dedupeByKey collapses duplicates");

  // Conflict detection (overlap)
  const cf = [
    { start: "2025-01-01T10:00:00Z", end: "2025-01-01T11:00:00Z" },
    { start: "2025-01-01T10:30:00Z", end: "2025-01-01T12:00:00Z" },
  ];
  expect(detectConflicts(cf).length === 1, "detectConflicts finds 1 overlap");

  // Period enumeration counts
  const weekLen = enumerateDates(new Date(2025, 0, 15), 7).length;
  expect(weekLen === 7, "Week enumerates 7 days");

  const monthFullLen = enumerateDates(
    new Date(2025, 5, 10),
    "month-full"
  ).length; // June 2025 (starts Sun) -> 35 cells
  expect(monthFullLen === 35, "Full month renders padded weeks");

  const q1Len = enumerateDates(new Date(2025, 0, 15), "quarter").length; // Q1 2025 = 90 days
  expect(q1Len === 90, "True quarter enumeration length");
})();
