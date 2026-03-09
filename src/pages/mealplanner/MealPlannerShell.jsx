// C:\Users\larho\suka-smart-assistant\src\pages\MealPlanning\MealPlannerShell.jsx
import React, {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { addDays, startOfWeek, format, isSameDay } from "date-fns";

/**
 * MealPlannerShell.jsx — Unified Meal Planning Hub (dynamic, alias-safe)
 * -----------------------------------------------------------------------------
 * Highlights (new/updated):
 * - **State memory & deep-linking**: tab/period/anchor/custom dates persist in localStorage
 *   and can be controlled via URL (?tab=groceries&period=month&anchor=2025-10-01&cs=2025-10-03&ce=2025-10-27).
 * - **Keyboard nav** like Linear/Notion:
 *     [ / ]  → previous/next period
 *     g      → Groceries,  p → Preview, c → Cycle, s → Sync, n → Nutrition, v → Plan View,
 *     b      → Batch Linker, i → Inventory, **d → Decide For Me**
 * - **Plugin tabs**: other modules can register panels at runtime via eventBus
 *   (“mealplanner.tabs.register”), each item { key,label, localPath, aliasPath }.
 * - **Sabbath guard banner** (hands-off) with Preferences CTA; propagates to children via props.
 * - **Consistent period semantics** with CalendarPreview:
 *     Month = full calendar weeks (padded), Quarter = true calendar quarter.
 * - **Quick actions** area emits standard events: generate draft / decide for me / sync calendar / open vault.
 * - **Defensive soft imports** so this file runs even if some modules are missing.
 */

/* ---------- Tiny UI (no external alias) ---------- */
const cx = (...a) => a.filter(Boolean).join(" ");
const Button = ({
  variant = "solid",
  size = "md",
  className,
  children,
  ...props
}) => {
  const v =
    {
      solid: "bg-black text-white hover:opacity-90 disabled:opacity-50",
      outline: "border hover:bg-zinc-50",
      ghost: "hover:bg-zinc-100",
      subtle: "bg-zinc-100 text-zinc-900 hover:bg-zinc-200",
    }[variant] || "";
  const s =
    { sm: "h-8 px-2 text-sm", md: "h-10 px-3 text-sm", icon: "h-9 w-9 p-0" }[
      size
    ] || "";
  return (
    <button
      className={cx("rounded-xl transition-colors", v, s, className)}
      {...props}
    >
      {children}
    </button>
  );
};
const Card = ({ className, children }) => (
  <div className={cx("rounded-2xl border bg-white", className)}>{children}</div>
);
const Input = (props) => (
  <input className="h-9 rounded-xl border px-3 text-sm" {...props} />
);
const Badge = ({ children, className, tone = "zinc" }) => (
  <span
    className={cx(
      "inline-flex items-center rounded px-2 py-0.5 text-xs",
      tone === "zinc" && "bg-zinc-900 text-white",
      tone === "violet" && "bg-violet-100 text-violet-900",
      className
    )}
  >
    {children}
  </span>
);

/* ---------- Soft imports (eventBus + prefs) ---------- */
let eventBus = { on: () => {}, off: () => {}, emit: () => {} };
try {
  // Prefer new events path, fall back to older one if present
  eventBus = require("@/services/events/eventBus");
} catch {
  try {
    eventBus = require("@/services/events/eventBus").eventBus || eventBus;
  } catch {}
}

let PreferencesStore = {};
try {
  PreferencesStore = require("@/store/PreferencesStore");
} catch {}

/* ---------- Lazy panels (alias-safe, with fallbacks) ---------- */
function lazyEither(localPath, aliasPath, fallback) {
  return React.lazy(async () => {
    try {
      return { default: (await import(/* @vite-ignore */ localPath)).default };
    } catch {}
    try {
      return { default: (await import(/* @vite-ignore */ aliasPath)).default };
    } catch {}
    return {
      default:
        fallback ||
        (() => (
          <div className="p-4 text-sm text-zinc-600">Panel not available.</div>
        )),
    };
  });
}

const CalendarPreview = lazyEither(
  "./CalendarPreview.jsx",
  "@/pages/MealPlanning/CalendarPreview.jsx"
);
const MealCyclePlanner = lazyEither(
  "./MealCyclePlannerCalendar.jsx",
  "@/pages/MealPlanning/MealCyclePlannerCalendar.jsx"
);
const GroceryListPanel = lazyEither(
  "./GroceryListPanel.jsx",
  "@/pages/MealPlanning/GroceryListPanel.jsx"
);
const CalendarSyncPanel = lazyEither(
  "./CalendarSyncPanel.jsx",
  "@/pages/MealPlanning/CalendarSyncPanel.jsx"
);
const MealPlanEditorModal = lazyEither(
  "./MealPlanEditorModal.jsx",
  "@/pages/MealPlanning/MealPlanEditorModal.jsx",
  () => null
);
const MealPlanNutritionPeek = lazyEither(
  "./MealPlanNutritionPeek.jsx",
  "@/pages/MealPlanning/MealPlanNutritionPeek.jsx"
);
const MealPlanView = lazyEither(
  "./MealPlanView.jsx",
  "@/pages/MealPlanning/MealPlanView.jsx"
);
const PrepChecklistGen = lazyEither(
  "./PrepChecklistGenerator.jsx",
  "@/pages/MealPlanning/PrepChecklistGenerator.jsx"
);
const BatchSessionLinker = lazyEither(
  "./BatchSessionLinker.jsx",
  "@/pages/MealPlanning/BatchSessionLinker.jsx"
);
const BatchInventoryMap = lazyEither(
  "./BatchInventoryMap.jsx",
  "@/pages/MealPlanning/BatchInventoryMap.jsx"
);

/* ---------- Period semantics (suite parity) ---------- */
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
function quarterStart(d) {
  const m = d.getMonth();
  return new Date(d.getFullYear(), Math.floor(m / 3) * 3, 1);
}
function enumerate(anchor, spec, custom) {
  if (spec === "custom") return (custom || []).slice().sort((a, b) => a - b);

  if (spec === "month-full") {
    // Full calendar month padded to whole weeks (Sun–Sat)
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const last = lastDayOfMonth(anchor.getFullYear(), anchor.getMonth());
    const start = startOfWeek(first, { weekStartsOn: 0 }); // Sun
    const endPad = addDays(last, (6 - last.getDay() + 7) % 7); // to Sat
    const out = [];
    for (let d = new Date(start); d <= endPad; d = addDays(d, 1))
      out.push(new Date(d));
    return out; // 35 or 42 days
  }

  if (spec === "quarter") {
    const s = quarterStart(anchor);
    const e = new Date(s.getFullYear(), s.getMonth() + 3, 0);
    const out = [];
    for (let d = new Date(s); d <= e; d = addDays(d, 1)) out.push(new Date(d));
    return out;
  }

  if (typeof spec === "number") {
    const s = startOfWeek(anchor, { weekStartsOn: 0 });
    return Array.from({ length: spec }, (_, i) => addDays(s, i));
  }
  return [];
}

/* ---------- Sabbath guard ---------- */
const sabbathStatus = () => {
  try {
    const p = PreferencesStore?.getPreferences?.() || {};
    const active = p?.torahProfile?.sabbath?.isActive;
    const handsOff = p?.torahProfile?.sabbath?.handsOffCooking === true;
    return {
      active: !!active,
      handsOff: !!handsOff,
      blocked: !!(active && handsOff),
    };
  } catch {
    return { active: false, handsOff: false, blocked: false };
  }
};

/* ---------- Built-in tabs ---------- */
const CORE_TABS = [
  { key: "preview", label: "Calendar Preview" },
  { key: "cycle", label: "Meal Cycle (Calendar)" },
  { key: "groceries", label: "Groceries" },
  { key: "sync", label: "Calendar Sync" },
  { key: "nutrition", label: "Nutrition Peek" },
  { key: "planview", label: "Plan View" },
  { key: "prep", label: "Prep Checklist" },
  { key: "linker", label: "Batch Session Linker" },
  { key: "inventory", label: "Batch Inventory Map" },
];

/* ---------- URL helpers & storage ---------- */
const toIso = (d) => format(d, "yyyy-MM-dd");
const fromIso = (s) => {
  const d = new Date(s);
  return isNaN(d) ? null : d;
};

function readUrlState() {
  if (typeof window === "undefined") return {};
  const u = new URL(window.location.href);
  const q = u.searchParams;
  return {
    tab: q.get("tab") || undefined,
    period: q.get("period") || undefined,
    anchor: fromIso(q.get("anchor") || "") || undefined,
    cs: fromIso(q.get("cs") || "") || undefined,
    ce: fromIso(q.get("ce") || "") || undefined,
  };
}
function writeUrlState({ tab, period, anchor, cs, ce }) {
  if (typeof window === "undefined") return;
  const u = new URL(window.location.href);
  const q = u.searchParams;
  tab ? q.set("tab", tab) : q.delete("tab");
  period ? q.set("period", period) : q.delete("period");
  anchor ? q.set("anchor", toIso(anchor)) : q.delete("anchor");
  cs ? q.set("cs", toIso(cs)) : q.delete("cs");
  ce ? q.set("ce", toIso(ce)) : q.delete("ce");
  window.history.replaceState({}, "", `${u.pathname}?${q.toString()}${u.hash}`);
}
const safeLS = {
  get(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch {}
  },
};

/* ---------- Shell ---------- */
export default function MealPlannerShell() {
  const urlSeed = readUrlState();

  const today = new Date();
  const [activeTab, setActiveTab] = useState(
    () => urlSeed.tab || safeLS.get("mp.tab", "preview")
  );
  const [anchor, setAnchor] = useState(
    () =>
      urlSeed.anchor ||
      fromIso(safeLS.get("mp.anchor", "")) ||
      startOfWeek(today, { weekStartsOn: 0 })
  );
  const [periodKey, setPeriodKey] = useState(
    () => urlSeed.period || safeLS.get("mp.period", "week")
  );

  const spec = useMemo(
    () => PERIODS.find((p) => p.key === periodKey)?.spec,
    [periodKey]
  );

  const [customStart, setCustomStart] = useState(() =>
    urlSeed.cs ? toIso(urlSeed.cs) : safeLS.get("mp.cs", "")
  );
  const [customEnd, setCustomEnd] = useState(() =>
    urlSeed.ce ? toIso(urlSeed.ce) : safeLS.get("mp.ce", "")
  );

  // Dynamic (plugin) tabs registry
  const [extraTabs, setExtraTabs] = useState([]); // [{key,label, localPath, aliasPath}]
  const [lazyCache, setLazyCache] = useState({}); // key -> React.lazy component

  // Persist & reflect in URL
  useEffect(() => {
    safeLS.set("mp.tab", activeTab);
    safeLS.set("mp.period", periodKey);
    safeLS.set("mp.anchor", toIso(anchor));
    safeLS.set("mp.cs", customStart || "");
    safeLS.set("mp.ce", customEnd || "");
    writeUrlState({
      tab: activeTab,
      period: periodKey,
      anchor,
      cs: customStart ? new Date(customStart) : undefined,
      ce: customEnd ? new Date(customEnd) : undefined,
    });
  }, [activeTab, periodKey, anchor, customStart, customEnd]);

  // Build custom dates
  const customDates = useMemo(() => {
    if (spec !== "custom" || !customStart || !customEnd) return [];
    const s = new Date(customStart),
      e = new Date(customEnd);
    if (isNaN(s) || isNaN(e) || s > e) return [];
    const out = [];
    for (let d = new Date(s); d <= e; d = addDays(d, 1)) out.push(new Date(d));
    return out;
  }, [spec, customStart, customEnd]);

  const days = useMemo(
    () => enumerate(anchor, spec, customDates),
    [anchor, spec, customDates]
  );
  const range = useMemo(() => {
    const start = days[0] || anchor;
    const end = days[days.length - 1] || addDays(anchor, 6);
    return { start, end, days };
  }, [anchor, days]);

  const sabbath = sabbathStatus();

  // Decide For Me: slot inference (time-of-day)
  const inferSlotByNow = () => {
    const h = new Date().getHours();
    if (h < 11) return "breakfast";
    if (h < 16) return "lunch";
    return "dinner";
  };

  // Event bus: tab switch & plugin register
  useEffect(() => {
    const handler = (p) => {
      if (!p) return;
      const map = {
        CalendarPreview: "preview",
        MealCyclePlanner: "cycle",
        GroceryList: "groceries",
        CalendarSync: "sync",
        NutritionPeek: "nutrition",
        MealPlanView: "planview",
        PrepChecklistGenerator: "prep",
        BatchSessionLinker: "linker",
        BatchInventoryMap: "inventory",
      };
      const tab = p.tab || map[p.panel];
      if (tab) setActiveTab(tab);
      if (p.anchor) setAnchor(new Date(p.anchor));
      if (p.periodKey) setPeriodKey(p.periodKey);
    };
    eventBus.on?.("ui.open", handler);

    // Allow external modules to add tabs at runtime
    const register = (payload = {}) => {
      const items = Array.isArray(payload.items) ? payload.items : [payload];
      setExtraTabs((prev) => {
        const keys = new Set(prev.map((t) => t.key));
        const added = items.filter((i) => i && i.key && !keys.has(i.key));
        return [...prev, ...added];
      });
      setLazyCache((prev) => {
        const next = { ...prev };
        for (const i of items) {
          if (i?.key && !next[i.key])
            next[i.key] = lazyEither(i.localPath, i.aliasPath);
        }
        return next;
      });
    };
    eventBus.on?.("mealplanner.tabs.register", register);

    return () => {
      eventBus.off?.("ui.open", handler);
      eventBus.off?.("mealplanner.tabs.register", register);
    };
  }, []);

  // Period navigation
  const jumpPrev = useCallback(() => {
    if (spec === "month-full")
      setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1));
    else if (spec === "quarter")
      setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() - 3, 1));
    else if (typeof spec === "number") setAnchor(addDays(anchor, -spec));
    else setAnchor(addDays(anchor, -7));
  }, [anchor, spec]);

  const jumpNext = useCallback(() => {
    if (spec === "month-full")
      setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1));
    else if (spec === "quarter")
      setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + 3, 1));
    else if (typeof spec === "number") setAnchor(addDays(anchor, spec));
    else setAnchor(addDays(anchor, 7));
  }, [anchor, spec]);

  const ctx = useMemo(
    () => ({ periodKey, range, sabbathBlocked: sabbath.blocked }),
    [periodKey, range, sabbath.blocked]
  );

  /* ---------- Quick actions (emit only; panels handle work) ---------- */
  const handleGenerate = useCallback(
    () =>
      eventBus.emit?.("mealplan.generate.requested", {
        at: new Date().toISOString(),
        range,
        periodKey,
      }),
    [range, periodKey]
  );

  const handleSync = useCallback(
    () =>
      eventBus.emit?.("calendar.sync.requested", {
        at: new Date().toISOString(),
        range,
        mode: "manual",
      }),
    [range]
  );

  const openVault = () => eventBus.emit?.("ui.open", { panel: "RecipeVault" });

  // Decide For Me (opens RecipeDeciderPanel and triggers auto-pick)
  const handleDecideForMe = useCallback(() => {
    const slot = inferSlotByNow();
    eventBus.emit?.("ui.open", {
      panel: "RecipeDecider",
      date: new Date(), // or range.start if you prefer anchoring to current period
      slot,
      intent: "single",
      autoPick: true,
    });
    eventBus.emit?.("decider.decide.requested", { range, periodKey, slot });
  }, [range, periodKey]);

  // Keyboard shortcuts (includes Decide For Me = "d")
  useEffect(() => {
    const onKey = (e) => {
      if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
      const k = e.key.toLowerCase();
      if (k === "[") jumpPrev();
      if (k === "]") jumpNext();
      if (k === "g") setActiveTab("groceries");
      if (k === "p") setActiveTab("preview");
      if (k === "c") setActiveTab("cycle");
      if (k === "s") setActiveTab("sync");
      if (k === "n") setActiveTab("nutrition");
      if (k === "v") setActiveTab("planview");
      if (k === "b") setActiveTab("linker");
      if (k === "i") setActiveTab("inventory");
      if (k === "d") handleDecideForMe();
      if (k === "/") eventBus.emit?.("ui.find.open", { scope: "mealplanner" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [anchor, periodKey, handleDecideForMe, jumpNext, jumpPrev]);

  /* ---------- Render ---------- */
  const ALL_TABS = [...CORE_TABS, ...extraTabs];

  return (
    <section className="flex min-h-[70vh] flex-col gap-4">
      {/* Sticky Header */}
      <Card className="sticky top-0 z-20 border-b bg-white/95 p-3 backdrop-blur supports-[backdrop-filter]:bg-white/70">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <div className="h-5 w-5 rounded bg-zinc-900" />
            <div className="truncate text-lg font-semibold">Meal Planning</div>
            <Badge className="ml-1">
              {format(range.start, "MMM d")}–{format(range.end, "MMM d, yyyy")}
            </Badge>
            {sabbath.blocked && (
              <span className="ml-2 rounded-xl border border-violet-300 bg-violet-50 px-2 py-0.5 text-xs text-violet-900">
                Sabbath: hands-off
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                onClick={jumpPrev}
                aria-label="Previous"
              >
                ←
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={jumpNext}
                aria-label="Next"
              >
                →
              </Button>
            </div>

            <select
              className="h-9 rounded-xl border px-2 text-sm"
              value={periodKey}
              onChange={(e) => setPeriodKey(e.target.value)}
              aria-label="Planning period"
            >
              {PERIODS.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>

            {periodKey === "custom" && (
              <div className="flex items-center gap-2">
                <Input
                  type="date"
                  value={customStart}
                  onChange={(e) => setCustomStart(e.target.value)}
                />
                <span className="text-sm text-zinc-500">to</span>
                <Input
                  type="date"
                  value={customEnd}
                  onChange={(e) => setCustomEnd(e.target.value)}
                />
              </div>
            )}
          </div>
        </div>

        {/* Tabs + Quick Actions */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-1">
            {ALL_TABS.map((t) => (
              <button
                key={t.key}
                className={cx(
                  "rounded-xl px-3 py-2 text-sm",
                  activeTab === t.key
                    ? "bg-zinc-900 text-white"
                    : "border hover:bg-zinc-50"
                )}
                onClick={() => setActiveTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="subtle" onClick={openVault}>
              Open Recipe Vault
            </Button>
            <Button
              variant="outline"
              onClick={handleGenerate}
              disabled={sabbath.blocked}
            >
              Generate Draft
            </Button>
            <Button
              variant="outline"
              onClick={handleDecideForMe}
              disabled={sabbath.blocked}
            >
              Decide For Me
            </Button>
            <Button onClick={handleSync} disabled={sabbath.blocked}>
              Sync Calendar
            </Button>
          </div>
        </div>
      </Card>

      {/* Active panel */}
      <Card className="p-3">
        <Suspense
          fallback={<div className="p-4 text-sm text-zinc-600">Loading…</div>}
        >
          {activeTab === "preview" && (
            <CalendarPreview
              initialRange={{ start: range.start, end: range.end }}
              periodKey={periodKey}
              context={ctx}
            />
          )}
          {activeTab === "cycle" && (
            <MealCyclePlanner
              initialRange={{ start: range.start, end: range.end }}
              context={ctx}
            />
          )}
          {activeTab === "groceries" && (
            <GroceryListPanel
              initialRange={{ start: range.start, end: range.end }}
              include={{ meals: true, batches: true, household: true }}
              defaultStoreId="any"
              context={ctx}
            />
          )}
          {activeTab === "sync" && (
            <CalendarSyncPanel
              mode="manual"
              defaultCalendarId="primary"
              initialRange={{ start: range.start, end: range.end }}
              context={ctx}
            />
          )}
          {activeTab === "nutrition" && (
            <MealPlanNutritionPeek
              initialRange={{ start: range.start, end: range.end }}
              periodKey={periodKey}
              context={ctx}
            />
          )}
          {activeTab === "planview" && (
            <MealPlanView
              initialRange={{ start: range.start, end: range.end }}
              periodKey={periodKey}
              context={ctx}
            />
          )}
          {activeTab === "prep" && (
            <PrepChecklistGen
              initialRange={{ start: range.start, end: range.end }}
              context={ctx}
            />
          )}
          {activeTab === "linker" && (
            <BatchSessionLinker
              initialRange={{ start: range.start, end: range.end }}
              context={ctx}
            />
          )}
          {activeTab === "inventory" && (
            <BatchInventoryMap
              initialRange={{ start: range.start, end: range.end }}
              context={ctx}
            />
          )}

          {/* Plugin tab mounts */}
          {extraTabs.map((t) => {
            const Cmp = lazyCache[t.key];
            return activeTab === t.key && Cmp ? (
              <Cmp
                key={t.key}
                initialRange={{ start: range.start, end: range.end }}
                context={ctx}
              />
            ) : null;
          })}
        </Suspense>
      </Card>

      {/* Inline editor modal, opened by other panels via eventBus */}
      <Suspense fallback={null}>
        <EditorPortal periodKey={periodKey} />
      </Suspense>
    </section>
  );
}

/* ---------- Editor modal portal ---------- */
function EditorPortal({ periodKey }) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(new Date());
  const [initialDay, setInitialDay] = useState({
    breakfast: [],
    lunch: [],
    dinner: [],
    snack: [],
  });

  useEffect(() => {
    const handler = (p) => {
      if (p?.panel !== "MealPlanEditor") return;
      setDate(p?.date ? new Date(p.date) : new Date());
      setInitialDay(
        p?.day || { breakfast: [], lunch: [], dinner: [], snack: [] }
      );
      setOpen(true);
    };
    eventBus.on?.("ui.open", handler);
    return () => eventBus.off?.("ui.open", handler);
  }, []);

  return (
    <Suspense fallback={null}>
      <MealPlanEditorModal
        open={open}
        date={date}
        periodKey={periodKey}
        initialDay={initialDay}
        onClose={() => setOpen(false)}
        onSave={() => setOpen(false)}
      />
    </Suspense>
  );
}

/* ---------- Lightweight tests ---------- */
(function runMealPlannerShellRefsOnce() {
  if (typeof window === "undefined") return;
  if (window.__MEAL_PLANNER_SHELL_REFS__) return;
  window.__MEAL_PLANNER_SHELL_REFS__ = true;

  const ok = (c, m) =>
    c
      ? console.log("[MealPlannerShell TEST PASS]", m)
      : console.error("[MealPlannerShell TEST FAIL]", m);

  // Period enumerate sanity
  const w = enumerate(new Date(2025, 0, 14), 7).length;
  ok(w === 7, "Week enumerates 7 days");

  // Month padded weeks: June 2025 starts Sun (5) and has 30 days → 5 weeks = 35 cells
  const june = new Date(2025, 5, 10);
  const mFull = enumerate(june, "month-full").length;
  ok(mFull === 35 || mFull === 42, "Month full calendar pads to 35/42 days");

  const qs = quarterStart(new Date(2025, 6, 5));
  ok(
    qs.getMonth() % 3 === 0 && qs.getDate() === 1,
    "Quarter start aligns to Q*-01"
  );

  // URL read/write smoke
  const seed = readUrlState();
  ok(typeof seed === "object", "URL state parses");
})();
