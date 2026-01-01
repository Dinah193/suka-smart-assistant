import React, { useCallback, useEffect, useMemo, useState } from "react";
import { addDays, startOfWeek, format, isSameDay } from "date-fns";

/**
 * CalendarPreview.jsx — dynamic, alias-safe, multi-range + compact view
 * Highlights
 * - Periods: Week, 2 Weeks, Month (full calendar), Quarter (true calendar quarter), Custom (inclusive).
 * - Compact View toggle: condensed list rendering (per your “condensed lists” feedback).
 * - NBA (Next Best Action) surfacing.
 * - Sabbath guard with visible badge & soft-blocking of actions.
 * - Defensive hooks into your real automation runtime/event bus if available.
 * - Prep-time estimator (quick heuristic) + Export/Share hooks.
 */

/***********************************\
|* Minimal UI primitives (no alias) *|
\***********************************/
const classNames = (...xs) => xs.filter(Boolean).join(" ");

function Button({ variant = "default", size = "md", className, children, ...props }) {
  const variants = {
    default: "bg-blue-600 text-white hover:bg-blue-700",
    outline: "border border-gray-300 hover:bg-gray-50",
    secondary: "bg-gray-900 text-white hover:bg-gray-800",
    ghost: "hover:bg-gray-100",
    danger: "bg-red-600 text-white hover:bg-red-700",
  };
  const sizes = { sm: "h-8 px-2", md: "h-10 px-4", icon: "h-9 w-9 p-0" };
  return (
    <button
      className={classNames(
        "inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus:outline-none disabled:opacity-50 disabled:pointer-events-none",
        variants[variant],
        sizes[size],
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
}

function Card({ className, children }) {
  return <div className={classNames("rounded-xl border bg-white shadow-sm", className)}>{children}</div>;
}
function CardHeader({ className, children }) {
  return <div className={classNames("px-4 pt-4", className)}>{children}</div>;
}
function CardTitle({ className, children }) {
  return <div className={classNames("text-lg font-semibold", className)}>{children}</div>;
}
function CardContent({ className, children }) {
  return <div className={classNames("px-4 pb-4", className)}>{children}</div>;
}
function Badge({ variant = "default", className, children, ...props }) {
  const variants = {
    default: "bg-gray-900 text-white",
    secondary: "bg-gray-200 text-gray-900",
    outline: "border border-gray-300 text-gray-700",
    warn: "bg-amber-500/90 text-black",
  };
  return (
    <span className={classNames("inline-flex items-center rounded px-2 py-0.5 text-xs", variants[variant], className)} {...props}>
      {children}
    </span>
  );
}
function Input({ className, ...props }) {
  return (
    <input
      className={classNames(
        "h-9 w-full rounded-md border border-gray-300 bg-white px-3 text-sm placeholder:text-gray-400 focus:outline-none",
        className
      )}
      {...props}
    />
  );
}

/**********************\
|* Tiny toast manager *|
\**********************/
function useToast() {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((t) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((xs) => [...xs, { id, ...t }]);
    setTimeout(() => setToasts((xs) => xs.filter((y) => y.id !== id)), 3200);
  }, []);
  const ToastViewport = () => (
    <div className="fixed right-4 top-4 z-50 flex max-w-sm flex-col gap-2">
      {toasts.map((t) => (
        <div key={t.id} className="rounded-md border border-gray-200 bg-white p-3 shadow">
          <div className="text-sm font-medium">{t.title}</div>
          {t.description && <div className="mt-0.5 text-xs text-gray-600">{t.description}</div>}
          {t.action && <div className="mt-2">{t.action}</div>}
        </div>
      ))}
    </div>
  );
  return { toast: push, ToastViewport };
}

/*******************\
|* Event bus (def) *|
\*******************/
let on = (e, fn) => () => {};
let off = () => {};
let emit = () => {};
try {
  // If your real bus exists, use it; else fall back to local micro-bus.
  const bus = require("@/services/eventBus");
  on = bus.on || on;
  off = bus.off || off;
  emit = bus.emit || emit;
} catch {
  const listeners = {};
  on = (event, handler) => {
    listeners[event] = listeners[event] || [];
    listeners[event].push(handler);
    return () => off(event, handler);
  };
  off = (event, handler) => {
    listeners[event] = (listeners[event] || []).filter((fn) => fn !== handler);
  };
  emit = (event, payload) => (listeners[event] || []).forEach((fn) => fn(payload));
}

/*********************************\
|* Sabbath guard (simple + badge) |
\*********************************/
async function sabbathGuard() {
  if (typeof window !== "undefined" && window.__SABBATH__) {
    return { ok: false, reason: "Sabbath period: actions temporarily paused." };
  }
  return { ok: true };
}

/****************************************\
|* Automation runtime (defensive import) |
\****************************************/
let automation = {
  mealPlanner: {
    async generateWeekDraft({ start, prefs }) {
      await new Promise((r) => setTimeout(r, 250));
      return `draft_${Date.now()}`;
    },
  },
  calendar: {
    async syncMealPlan({ weekStart }) {
      await new Promise((r) => setTimeout(r, 250));
      return { count: 21 };
    },
    async revertMealPlanWeek() {
      await new Promise((r) => setTimeout(r, 150));
      return true;
    },
  },
};
try {
  const mod = require("@/services/automation/runtime");
  automation = mod.automation || automation;
} catch {}

/****************************************\
|* Local model + period support          *|
\****************************************/
const MEAL_SLOTS = [
  { key: "breakfast", label: "Breakfast", icon: "🍎" },
  { key: "lunch", label: "Lunch", icon: "🥪" },
  { key: "dinner", label: "Dinner", icon: "🍖" },
  { key: "snack", label: "Snack", icon: "🍪" },
];

const PERIODS = [
  { key: "week", label: "Week", days: 7 },
  { key: "2w", label: "2 Weeks", days: 14 },
  { key: "month", label: "Month", days: "month-full" },   // FULL calendar weeks
  { key: "quarter", label: "Quarter", days: "quarter" },  // TRUE calendar quarter
  { key: "custom", label: "Custom", days: "custom" },
];

// Helpers for month/quarter
function lastDayOfMonth(y, m) { return new Date(y, m + 1, 0); }
function quarterStart(date) {
  const m = date.getMonth();
  const qStart = Math.floor(m / 3) * 3;
  return new Date(date.getFullYear(), qStart, 1);
}
function quarterEnd(date) {
  const qs = quarterStart(date);
  return new Date(qs.getFullYear(), qs.getMonth() + 3, 0); // last day of quarter
}

function enumerateDates(anchor, period, customRange) {
  if (period === "custom") {
    return (customRange || []).slice().sort((a, b) => a - b);
  }
  if (period === "month-full") {
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const last = lastDayOfMonth(anchor.getFullYear(), anchor.getMonth());
    const start = startOfWeek(first, { weekStartsOn: 0 }); // Sun
    const endPad = addDays(last, (6 - last.getDay() + 7) % 7); // to Sat
    const dates = [];
    for (let d = new Date(start); d <= endPad; d = addDays(d, 1)) dates.push(new Date(d));
    return dates;
  }
  if (period === "quarter") {
    const start = quarterStart(anchor);
    const end = quarterEnd(anchor);
    const dates = [];
    for (let d = new Date(start); d <= end; d = addDays(d, 1)) dates.push(new Date(d));
    return dates;
  }
  if (typeof period === "number") {
    const start = startOfWeek(anchor, { weekStartsOn: 0 });
    const dates = [];
    for (let i = 0; i < period; i++) dates.push(addDays(start, i));
    return dates;
  }
  return [];
}

function makeEmptyRange(anchor, period, customRange) {
  const days = {};
  const list = enumerateDates(anchor, period, customRange);
  list.forEach((d) => {
    const key = format(d, "yyyy-MM-dd");
    days[key] = { breakfast: [], lunch: [], dinner: [], snack: [] };
  });
  return { days };
}

function computeWeekMacrosFromWeek(week) {
  let protein = 0, carbs = 0, fat = 0, kcal = 0;
  Object.values(week?.days || {}).forEach((day) => {
    Object.values(day).forEach((arr) => {
      arr.forEach((m) => {
        protein += m.protein ?? 0;
        carbs += m.carbs ?? 0;
        fat += m.fat ?? 0;
        kcal += m.kcal ?? 0;
      });
    });
  });
  const total = protein + carbs + fat || 1;
  return {
    proteinPct: (protein / total) * 100,
    carbPct: (carbs / total) * 100,
    fatPct: (fat / total) * 100,
    kcal,
  };
}

/****************\
|* Heuristics   *|
\****************/
function estimatePrepMinutes(plan) {
  // Heuristic: baseline 5 min per snack, 10 per breakfast, 20 per lunch, 30 per dinner.
  let minutes = 0;
  Object.values(plan.days).forEach((day) => {
    minutes += (day.breakfast?.length || 0) * 10;
    minutes += (day.lunch?.length || 0) * 20;
    minutes += (day.dinner?.length || 0) * 30;
    minutes += (day.snack?.length || 0) * 5;
  });
  return minutes;
}

/****************\
|* Macros bar   *|
\****************/
function MacrosBar({ macros }) {
  const p = Math.max(0, Math.min(100, Math.round(macros?.proteinPct ?? 0)));
  const c = Math.max(0, Math.min(100, Math.round(macros?.carbPct ?? 0)));
  const f = Math.max(0, Math.min(100, Math.round(macros?.fatPct ?? 0)));
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs text-gray-600">
        <span>Period Macros</span>
        <span>{Math.round(Math.min(100, p + c + f))}%</span>
      </div>
      <div className="flex h-2 w-full overflow-hidden rounded bg-gray-200">
        <div title={`Protein ${p}%`} style={{ width: `${p}%` }} className="h-full bg-gray-900" />
        <div title={`Carb ${c}%`} style={{ width: `${c}%` }} className="h-full bg-gray-500" />
        <div title={`Fat ${f}%`} style={{ width: `${f}%` }} className="h-full bg-gray-300" />
      </div>
      <div className="flex gap-3 text-xs text-gray-600">
        <span>P {p}%</span>
        <span>C {c}%</span>
        <span>F {f}%</span>
        <span className="ml-auto">{Math.round(macros?.kcal ?? 0)} kcal</span>
      </div>
    </div>
  );
}

/****************\
|* Day cell      *|
\****************/
function DayCell({ date, meals, onAdd, onRemove }) {
  return (
    <Card className="h-full">
      <CardHeader className="py-2">
        <CardTitle className="text-sm font-medium flex items-center justify-between">
          <span>{format(date, "EEE d")}</span>
          <Badge variant="outline" className="text-[10px]">
            {isSameDay(date, new Date()) ? "Today" : "Planned"}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {MEAL_SLOTS.map(({ key, label, icon }) => {
          const items = meals?.[key] || [];
          return (
            <div key={key} className="rounded-lg border p-2">
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-base">{icon}</span>
                  <span className="text-xs font-medium">{label}</span>
                </div>
                <Button variant="ghost" size="icon" aria-label={`Add ${label}`} onClick={() => onAdd(date, key)}>
                  +
                </Button>
              </div>

              {items.length === 0 && (
                <div className="text-xs text-gray-500">Empty — click + to add</div>
              )}

              {items.map((m) => (
                <div key={m.id} className="mb-1 flex items-center justify-between rounded bg-gray-100 p-2">
                  <div className="flex flex-col">
                    <span className="text-xs font-medium">{m.title}</span>
                    <span className="text-[10px] text-gray-500">
                      {(m.kcal ?? "")} kcal{m.tags?.length ? ` • ${m.tags.join(" · ")}` : ""}
                    </span>
                  </div>
                  <Button variant="ghost" size="icon" aria-label="Remove meal" onClick={() => onRemove(date, key, m)}>
                    ↩
                  </Button>
                </div>
              ))}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

/****************
 * Main component *
 ****************/
export default function CalendarPreview() {
  const today = new Date();
  const [periodKey, setPeriodKey] = useState("week"); // week | 2w | month | quarter | custom
  const [customStart, setCustomStart] = useState("");  // yyyy-MM-dd
  const [customEnd, setCustomEnd] = useState("");
  const [anchor, setAnchor] = useState(startOfWeek(today, { weekStartsOn: 0 }));
  const [compact, setCompact] = useState(false);       // NEW: condensed list view
  const [mode, setMode] = useState("auto");            // auto | manual
  const [query, setQuery] = useState("");
  const { toast, ToastViewport } = useToast();

  const periodSpec = useMemo(() => PERIODS.find((p) => p.key === periodKey)?.days, [periodKey]);

  // Build custom date list if needed
  const customDates = useMemo(() => {
    if (periodSpec !== "custom" || !customStart || !customEnd) return [];
    const start = new Date(customStart);
    const end = new Date(customEnd);
    if (isNaN(start) || isNaN(end) || start > end) return [];
    const out = [];
    for (let d = new Date(start); d <= end; d = addDays(d, 1)) out.push(new Date(d));
    return out;
  }, [periodSpec, customStart, customEnd]);

  const [plan, setPlan] = useState(() => makeEmptyRange(anchor, periodSpec, customDates));
  const [loading, setLoading] = useState(false);

  // Rebuild when anchor/period/custom changes
  useEffect(() => {
    setPlan(makeEmptyRange(anchor, periodSpec, customDates));
  }, [anchor, periodSpec, customDates]);

  // Mutators
  const addMeal = useCallback(({ date, slot, meal }) => {
    setPlan((prev) => {
      const key = format(date, "yyyy-MM-dd");
      const copy = structuredClone(prev);
      copy.days[key] = copy.days[key] || { breakfast: [], lunch: [], dinner: [], snack: [] };
      const newMeal = { id: `m_${Math.random().toString(36).slice(2)}`, ...meal };
      copy.days[key][slot] = [...(copy.days[key][slot] || []), newMeal];
      return copy;
    });
  }, []);

  const removeMeal = useCallback(({ date, slot, id }) => {
    setPlan((prev) => {
      const key = format(date, "yyyy-MM-dd");
      const copy = structuredClone(prev);
      copy.days[key][slot] = (copy.days[key][slot] || []).filter((m) => m.id !== id);
      return copy;
    });
  }, []);

  const replacePlan = useCallback((newPlan) => setPlan(newPlan), []);

  // Derived macros, prep estimate, filtered view
  const macros = useMemo(() => computeWeekMacrosFromWeek(plan), [plan]);
  const prepMinutes = useMemo(() => estimatePrepMinutes(plan), [plan]);

  const visibleMeals = useMemo(() => {
    if (!query) return plan;
    const filtered = { days: {} };
    Object.keys(plan.days).forEach((key) => {
      const day = plan.days[key] ?? {};
      const out = {};
      MEAL_SLOTS.forEach(({ key: slotKey }) => {
        out[slotKey] = (day?.[slotKey] ?? []).filter(
          (m) =>
            m.title?.toLowerCase().includes(query.toLowerCase()) ||
            m.tags?.some((t) => t.toLowerCase().includes(query.toLowerCase()))
        );
      });
      filtered.days[key] = out;
    });
    return filtered;
  }, [plan, query]);

  // Events (defensive)
  useEffect(() => {
    const unsubs = [
      on("recipe.consolidated", () => setPlan((w) => structuredClone(w))),
      on("inventory.updated", () => setPlan((w) => structuredClone(w))),
      on("calendar.synced", () => toast({ title: "Calendar synced", description: "Meals are now on your calendar." })),
      on("preferences.changed", () => setPlan((w) => structuredClone(w))),
    ].filter(Boolean);
    return () => unsubs.forEach((fn) => fn && fn());
  }, [toast]);

  // Generate (auto)
  const handleGenerate = useCallback(async () => {
    const guarded = await sabbathGuard();
    if (!guarded.ok) {
      toast({ title: "Sabbath mode", description: guarded.reason, action: <span className="text-xs">OK</span> });
      return;
    }
    try {
      setLoading(true);
      const draftId = await automation.mealPlanner.generateWeekDraft({
        start: anchor,
        prefs: { period: periodKey, customStart, customEnd },
      });
      const auto = makeEmptyRange(anchor, periodSpec, customDates);
      const demoMeals = [
        { title: "Oatmeal & Berries", protein: 12, carbs: 38, fat: 5, kcal: 280, tags: ["veg"] },
        { title: "Chicken Salad", protein: 30, carbs: 10, fat: 14, kcal: 330, tags: ["gluten-free"] },
        { title: "Lamb Doner Bowl", protein: 34, carbs: 42, fat: 18, kcal: 520, tags: ["fusion"] },
        { title: "Greek Yogurt", protein: 17, carbs: 8, fat: 4, kcal: 150, tags: ["snack"] },
      ];
      Object.keys(auto.days).forEach((key, i) => {
        auto.days[key].breakfast.push({ id: `m_b_${i}`, ...demoMeals[0] });
        auto.days[key].lunch.push({ id: `m_l_${i}`, ...demoMeals[1] });
        auto.days[key].dinner.push({ id: `m_d_${i}`, ...demoMeals[2] });
        auto.days[key].snack.push({ id: `m_s_${i}`, ...demoMeals[3] });
      });
      replacePlan(auto);
      emit("mealplan.draft.created", { weekStart: anchor, draftId, period: periodKey, customStart, customEnd });
      const label = PERIODS.find((p) => p.key === periodKey)?.label || "Period";
      toast({ title: "Draft generated", description: `Auto plan for ${label}.` });
      setMode("auto");
    } finally {
      setLoading(false);
    }
  }, [anchor, periodKey, periodSpec, customDates, customStart, customEnd, replacePlan, toast]);

  // Sync
  const handleSync = useCallback(async () => {
    const guarded = await sabbathGuard();
    if (!guarded.ok) {
      toast({ title: "Sabbath mode", description: guarded.reason });
      return;
    }
    setLoading(true);
    const prev = structuredClone(plan);
    try {
      const res = await automation.calendar.syncMealPlan({ weekStart: anchor });
      emit("calendar.synced", { weekStart: anchor, count: res?.count });
      toast({
        title: "Synced to Calendar",
        description: `${res?.count ?? 0} events created.`,
        action: (
          <Button variant="secondary" size="sm" onClick={async () => {
            await automation.calendar.revertMealPlanWeek({ weekStart: anchor });
            replacePlan(prev);
            toast({ title: "Sync reverted", description: "Calendar events removed." });
          }}>
            Undo
          </Button>
        ),
      });
    } finally {
      setLoading(false);
    }
  }, [anchor, plan, replacePlan, toast]);

  // Manual add/remove
  const handleAddMeal = useCallback(
    (date, slot) => {
      setMode("manual");
      const title = typeof window !== "undefined" ? window.prompt(`Add a ${slot} title:`) : "Custom Meal";
      if (!title) return;
      const meal = { title, protein: 10, carbs: 20, fat: 10, kcal: 240, tags: ["custom"] };
      const optimisticId = Math.random().toString(36).slice(2);
      addMeal({ date, slot, meal: { id: optimisticId, ...meal } });
      toast({
        title: "Meal added",
        description: `${title} added to ${format(date, "EEE d")} ${slot}.`,
        action: (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => removeMeal({ date, slot, id: optimisticId })}
          >
            Undo
          </Button>
        ),
      });
    },
    [addMeal, removeMeal, toast]
  );

  const handleRemoveMeal = useCallback(
    (date, slot, meal) => {
      removeMeal({ date, slot, id: meal.id });
      toast({
        title: "Meal removed",
        description: `${meal.title} removed.`,
        action: (
          <Button variant="secondary" size="sm" onClick={() => addMeal({ date, slot, meal })}>
            Undo
          </Button>
        ),
      });
    },
    [addMeal, removeMeal, toast]
  );

  // NBA
  const nextBestAction = useMemo(() => {
    const hasAny = Object.values(plan.days).some((d) => MEAL_SLOTS.some((s) => (d[s.key] || []).length));
    if (!hasAny) return { label: "Generate plan", action: handleGenerate };
    return { label: "Sync to calendar", action: handleSync };
  }, [plan, handleGenerate, handleSync]);

  // Period navigation
  const goPrev = () => {
    if (periodSpec === "month-full") setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1));
    else if (periodSpec === "quarter") setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() - 3, 1));
    else if (typeof periodSpec === "number") setAnchor(addDays(anchor, -periodSpec));
    else setAnchor(addDays(anchor, -7));
  };
  const goNext = () => {
    if (periodSpec === "month-full") setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1));
    else if (periodSpec === "quarter") setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + 3, 1));
    else if (typeof periodSpec === "number") setAnchor(addDays(anchor, periodSpec));
    else setAnchor(addDays(anchor, 7));
  };

  // Sorted date keys for rendering
  const sortedKeys = useMemo(() => Object.keys(visibleMeals?.days || {}).sort(), [visibleMeals]);

  const isSabbath = typeof window !== "undefined" && !!window.__SABBATH__;

  return (
    <div className="flex flex-col gap-4">
      <ToastViewport />

      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="h-5 w-5 rounded bg-gray-900" />
          <h2 className="text-xl font-semibold">Meal Calendar Preview</h2>
          <Badge variant={mode === "auto" ? "default" : "secondary"} className="ml-1">
            {mode === "auto" ? "auto" : "manual"}
          </Badge>
          {isSabbath && <Badge variant="warn" className="ml-2">Sabbath mode</Badge>}
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" onClick={goPrev} aria-label="Previous period">←</Button>
            <Button variant="ghost" size="icon" onClick={goNext} aria-label="Next period">→</Button>
          </div>

          <div className="hidden items-center gap-2 md:flex">
            <select
              aria-label="Planning period"
              className="h-9 w-40 rounded-md border border-gray-300 bg-white px-2 text-sm"
              value={periodKey}
              onChange={(e) => setPeriodKey(e.target.value)}
            >
              {PERIODS.map((p) => (
                <option key={p.key} value={p.key}>{p.label}</option>
              ))}
            </select>

            {periodKey === "custom" && (
              <div className="flex items-center gap-2">
                <Input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} />
                <span className="text-sm text-gray-500">to</span>
                <Input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} />
              </div>
            )}

            <Input
              placeholder="Filter meals…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-9 w-48"
            />
            <Button variant="outline" size="sm" onClick={() => emit("ui.panel.open", { id: "NutritionPanel" })}>
              Options
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCompact((v) => !v)}
              aria-pressed={compact}
              aria-label="Toggle compact list view"
              title="Toggle compact list view"
            >
              {compact ? "Grid View" : "Compact View"}
            </Button>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={handleGenerate} disabled={loading || isSabbath}>
          {loading ? "Generating…" : "Generate Plan (Auto)"}
        </Button>
        <Button variant="outline" onClick={() => setMode("manual")}>+ Add Meals (Manual)</Button>
        <Button variant="secondary" onClick={handleSync} disabled={loading || isSabbath}>Sync to Calendar</Button>
        <Button variant="ghost" onClick={() => emit("sharing.plan.open", { weekStart: anchor, period: periodKey, customStart, customEnd })}>
          Share / Co-Plan
        </Button>
        <Button variant="ghost" onClick={() => emit("plan.export.requested", { anchor, periodKey, customStart, customEnd })}>
          Export
        </Button>
        {nextBestAction && (
          <Badge className="ml-auto cursor-pointer" onClick={nextBestAction.action}>
            {nextBestAction.label}
          </Badge>
        )}
      </div>

      {/* Summary & Layout */}
      <Card>
        <CardContent className="grid grid-cols-1 gap-4 py-4 md:grid-cols-4">
          {/* Main */}
          <div className="md:col-span-3">
            {!compact ? (
              <div className="grid grid-cols-7 gap-2">
                {sortedKeys.map((key) => {
                  const [y, m, d] = key.split("-").map((n) => parseInt(n, 10));
                  const date = new Date(y, m - 1, d);
                  const meals = visibleMeals?.days?.[key];
                  return (
                    <div key={key} className="min-h-[360px]">
                      <DayCell date={date} meals={meals} onAdd={handleAddMeal} onRemove={handleRemoveMeal} />
                    </div>
                  );
                })}
              </div>
            ) : (
              /* Compact list view */
              <div className="divide-y">
                {sortedKeys.map((key) => {
                  const [y, m, d] = key.split("-").map((n) => parseInt(n, 10));
                  const date = new Date(y, m - 1, d);
                  const meals = visibleMeals?.days?.[key] || {};
                  const hasAny = MEAL_SLOTS.some((s) => (meals[s.key] || []).length);
                  return (
                    <div key={key} className="py-3">
                      <div className="mb-1 flex items-center justify-between">
                        <div className="text-sm font-semibold">{format(date, "EEE, MMM d")}</div>
                        <div className="flex items-center gap-2">
                          {isSameDay(date, new Date()) && <Badge variant="outline">Today</Badge>}
                          <Button variant="outline" size="sm" onClick={() => handleAddMeal(date, "dinner")}>+ Quick Add</Button>
                        </div>
                      </div>
                      {!hasAny && <div className="text-xs text-gray-500">No meals — Quick Add to start.</div>}
                      {MEAL_SLOTS.map(({ key: slotKey, label }) => {
                        const items = meals[slotKey] || [];
                        if (!items.length) return null;
                        return (
                          <div key={slotKey} className="ml-1">
                            <div className="text-[11px] font-semibold text-gray-600">{label}</div>
                            <ul className="mt-1 grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
                              {items.map((m) => (
                                <li key={m.id} className="flex items-center justify-between rounded border px-2 py-1 text-xs">
                                  <span className="truncate">{m.title}</span>
                                  <button
                                    className="ml-2 text-gray-500 hover:text-gray-800"
                                    onClick={() => handleRemoveMeal(date, slotKey, m)}
                                    aria-label="Remove"
                                    title="Remove"
                                  >
                                    ✕
                                  </button>
                                </li>
                              ))}
                            </ul>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Sidebar */}
          <div className="space-y-4">
            <Card>
              <CardHeader className="py-3">
                <CardTitle className="text-sm">Nutrition Peek</CardTitle>
              </CardHeader>
              <CardContent>
                <MacrosBar macros={macros} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="py-3">
                <CardTitle className="text-sm">Prep Signals</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm text-gray-700">
                <div className="flex items-center justify-between">
                  <span>Estimated prep time</span>
                  <span className="font-semibold">{prepMinutes} min</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Total days in view</span>
                  <span className="font-semibold">{sortedKeys.length}</span>
                </div>
                <Button
                  size="sm"
                  className="w-full"
                  onClick={() => emit("grocerylist.requested", { anchor, periodKey, customStart, customEnd })}
                >
                  Generate Grocery List
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="py-3">
                <CardTitle className="text-sm">Tips</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm text-gray-600">
                <p>Month view shows a <strong>full calendar</strong> (padded to whole weeks). Quarter is a <strong>true quarter</strong>.</p>
                <p>Use <em>Compact View</em> for quick review or printing.</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() => emit("household.rhythm.apply.requested", { scope: "mealplan", anchor, periodKey })}
                >
                  Apply Household Rhythm
                </Button>
              </CardContent>
            </Card>
          </div>
        </CardContent>
      </Card>

      {/* Empty state */}
      {(() => {
        const hasAny = Object.values(plan.days).some((d) => MEAL_SLOTS.some((s) => (d[s.key] || []).length));
        if (hasAny) return null;
        return (
          <Card className="border-dashed">
            <CardContent className="py-10 text-center text-gray-600">
              <p>No meals planned for this period yet.</p>
              <div className="mt-4 flex items-center justify-center gap-2">
                <Button onClick={handleGenerate} disabled={isSabbath}>Generate a draft</Button>
                <Button variant="outline" onClick={() => setMode("manual")}>Plan manually</Button>
              </div>
            </CardContent>
          </Card>
        );
      })()}
    </div>
  );
}

/***********************\
|* Lightweight TESTS   *|
\***********************/
(function runCalendarPreviewTestsOnce() {
  if (typeof window === "undefined") return;
  if (window.__CAL_PREVIEW_TESTS__) return;
  window.__CAL_PREVIEW_TESTS__ = true;

  const expect = (cond, msg) => {
    if (!cond) console.error("[CalendarPreview TEST FAIL]", msg);
    else console.log("[CalendarPreview TEST PASS]", msg);
  };

  // Test 1: macros should sum to ~100
  const week = { days: { "2025-01-01": { breakfast: [{ protein: 10, carbs: 20, fat: 30, kcal: 400 }], lunch: [], dinner: [], snack: [] } } };
  const m = computeWeekMacrosFromWeek(week);
  const sumPct = Math.round(m.proteinPct + m.carbPct + m.fatPct);
  expect(sumPct === 100, `Macros sum to ~100 (got ${sumPct})`);
  expect(m.kcal === 400, `Kcal aggregates (got ${m.kcal})`);

  // Test 2a: 7-day range
  const r7 = makeEmptyRange(new Date(2025, 5, 10), 7);
  expect(Object.keys(r7.days).length === 7, "7-day range has 7 days");

  // Test 2b: 14-day range
  const r14 = makeEmptyRange(new Date(2025, 5, 10), 14);
  expect(Object.keys(r14.days).length === 14, "14-day range has 14 days");

  // Test 2c: FULL month (June 2025 starts Sun and has 30 days → 5 full weeks = 35 days)
  const june = new Date(2025, 5, 10);
  const rM = makeEmptyRange(june, "month-full");
  expect(Object.keys(rM.days).length === 35, "June 2025 full calendar is 35 days");

  // Test 2d: TRUE quarter Q1 2025 = Jan 1 .. Mar 31 = 90 days
  const q1 = makeEmptyRange(new Date(2025, 0, 15), "quarter");
  expect(Object.keys(q1.days).length === 90, "Q1 2025 has 90 days");

  // Test 2e: Custom range inclusive count (Mar 1–Mar 03 = 3)
  const cStart = new Date(2025, 2, 1), cEnd = new Date(2025, 2, 3);
  const cR = makeEmptyRange(new Date(2025, 2, 1), "custom", [cStart, new Date(2025, 2, 2), cEnd]);
  expect(Object.keys(cR.days).length === 3, "Custom inclusive 3 days");
})();
