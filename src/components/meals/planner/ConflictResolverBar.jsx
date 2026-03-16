// src/components/meals/planner/ConflictResolverBar.jsx
/* eslint-disable no-console */
import React, { useEffect, useMemo, useRef, useState } from "react";

/* ------------------------------- Defensive deps ------------------------------- */
let Icons = {};
try {
  Icons = require("lucide-react");
} catch {
  Icons = {
    TriangleAlert: () => null,
    CheckCircle2: () => null,
    XCircle: () => null,
    Clock: () => null,
    CalendarClock: () => null,
    ShoppingCart: () => null,
    ChefHat: () => null,
    Scale: () => null,
    Dumbbell: () => null,
    RefreshCcw: () => null,
    Sparkles: () => null,
    ListChecks: () => null,
    Layers: () => null,
    Replace: () => null,
    MoveRight: () => null,
    Plus: () => null,
    Minus: () => null,
    ChevronDown: () => null,
    ChevronUp: () => null,
    Settings2: () => null,
    ShieldAlert: () => null,
    Ban: () => null,
  };
}

let eventBus = { emit: () => {}, on: () => {}, off: () => {} };
try {
  eventBus = require("@/services/events/eventBus").eventBus || eventBus;
} catch {}

let automation = null;
try {
  automation = require("@/services/automation/runtime").automation || null;
} catch {}

let InventoryMonitor = {
  checkRecipe: () => ({ status: "unknown", missingCount: 0, missing: [] }),
  addToGroceryList: () => {},
};
try {
  InventoryMonitor =
    require("@/managers/InventoryMonitor").default ||
    require("@/managers/InventoryMonitor") ||
    InventoryMonitor;
} catch {}

let useMealPlanStore = () => ({
  swapRecipe: () => {},
  moveMeal: () => {},
  changeServings: () => {},
  markResolved: () => {},
  getConflicts: () => [],
});
try {
  useMealPlanStore =
    require("@/store/MealPlanStore").useMealPlanStore || useMealPlanStore;
} catch {}

let useHouseholdCalendar = () => ({ events: [] });
try {
  useHouseholdCalendar =
    require("@/store/HouseholdCalendarStore").useHouseholdCalendar ||
    useHouseholdCalendar;
} catch {}

let usePersonalFoodStandards = () => ({ standards: {} });
try {
  usePersonalFoodStandards =
    require("@/app/context/HouseholdSettingsContext")
      .usePersonalFoodStandards || usePersonalFoodStandards;
} catch {}

/* --------------------------------- Helpers ---------------------------------- */
const cx = (...xs) => xs.filter(Boolean).join(" ");
const STORAGE_KEY = "suka.mealplanner.conflictbar.v1";

const SEVERITY_COLORS = {
  high: "bg-rose-100 text-rose-800 border-rose-200",
  med: "bg-amber-100 text-amber-800 border-amber-200",
  low: "bg-sky-100 text-sky-800 border-sky-200",
};

function persistUI(state) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ expanded: state.expanded })
    );
  } catch {}
}
function loadUI() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

/** Minimal standards check (aligns with RecipeCard/LibraryFilters logic) */
function standardsViolation(recipe = {}, standards = {}) {
  const title = recipe?.title || "";
  const tags = new Set(
    (recipe?.tags || []).map((t) => (typeof t === "string" ? t : t?.id))
  );
  if (standards?.noPork && (tags.has("pork") || /pork/i.test(title))) {
    return "Contains pork";
  }
  if (standards?.lambBeefOnly) {
    const forbidden =
      tags.has("chicken") ||
      tags.has("turkey") ||
      tags.has("fish") ||
      tags.has("seafood") ||
      /chicken|fish|turkey|seafood/i.test(title);
    if (forbidden) return "Not lamb/beef only";
  }
  return null;
}

/** When no store-provided conflicts exist, derive a lightweight set */
function deriveConflicts(planItems = [], standards = {}, calendarEvents = []) {
  const conflicts = [];

  // 1) Time overlap within plan (same day+slot collision)
  const seen = new Map();
  for (const m of planItems) {
    const key = `${m.date}|${m.slot || "unslotted"}`;
    if (seen.has(key)) {
      conflicts.push({
        id: `dup-${key}`,
        type: "time-overlap",
        severity: "med",
        message: `Multiple meals planned for ${m.slot || "unslotted"} on ${
          m.date
        }`,
        context: { date: m.date, slot: m.slot, items: [seen.get(key), m] },
        fixes: [
          { label: "Auto move to next slot", action: "reschedule-next-slot" },
        ],
      });
    } else {
      seen.set(key, m);
    }
  }

  // 2) Standards violation
  for (const m of planItems) {
    const reason = standardsViolation(m.recipe, standards);
    if (reason) {
      conflicts.push({
        id: `std-${m.id}`,
        type: "standards",
        severity: "high",
        message: `${reason}: ${m.recipe?.title || "Recipe"}`,
        context: { item: m },
        fixes: [
          { label: "Swap recipe", action: "swap" },
          { label: "Remove", action: "remove" },
        ],
      });
    }
  }

  // 3) Inventory gaps (shallow)
  for (const m of planItems) {
    try {
      const inv = InventoryMonitor.checkRecipe(m.recipe);
      if (inv?.status === "missing" && inv?.missing?.length) {
        conflicts.push({
          id: `inv-${m.id}`,
          type: "inventory",
          severity: "med",
          message: `${inv.missing.length} ingredient(s) missing for ${
            m.recipe?.title || "meal"
          }`,
          context: { item: m, missing: inv.missing },
          fixes: [
            { label: "Add to Grocery", action: "add-missing-grocery" },
            { label: "Suggest substitutes", action: "suggest-substitutes" },
          ],
        });
      }
    } catch {}
  }

  // 4) Calendar hard conflict (household events colliding with meal prep)
  for (const m of planItems) {
    const prepWindow = m.prepMinutes || m.recipe?.prepMinutes || 0;
    if (!prepWindow || !m.date || !m.time) continue;
    const target = new Date(`${m.date}T${m.time}`);
    const start = new Date(target.getTime() - prepWindow * 60000);
    const end = new Date(
      target.getTime() + (m.recipe?.cookMinutes || 0) * 60000
    );
    const hit = calendarEvents.find((ev) => {
      const evStart = new Date(
        ev.start || ev.startTime || ev.startsAt || ev.dtStart || ev
      );
      const evEnd = new Date(
        ev.end || ev.endTime || ev.endsAt || ev.dtEnd || evStart
      );
      return start < evEnd && end > evStart;
    });
    if (hit) {
      conflicts.push({
        id: `cal-${m.id}`,
        type: "calendar",
        severity: "med",
        message: `Prep/meal overlaps "${hit.title || "event"}"`,
        context: { item: m, event: hit },
        fixes: [
          { label: "Shift prep earlier", action: "shift-prep-earlier" },
          { label: "Reschedule meal", action: "reschedule-day" },
        ],
      });
    }
  }

  return conflicts;
}

/* ---------------------------------- UI bits --------------------------------- */
const Badge = ({ children, tone = "med" }) => {
  const cls = SEVERITY_COLORS[tone] || SEVERITY_COLORS.med;
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] border",
        cls
      )}
    >
      {children}
    </span>
  );
};

const Row = ({ icon: Icon, title, subtitle, tone = "med", actions = [] }) => (
  <div className="flex items-start justify-between gap-3 p-3 rounded-lg border border-gray-200 bg-white">
    <div className="flex items-start gap-3">
      {Icon ? <Icon className="w-5 h-5 mt-0.5 text-gray-600" /> : null}
      <div>
        <div className="text-sm font-medium text-gray-900">{title}</div>
        {subtitle ? (
          <div className="text-xs text-gray-600 mt-0.5">{subtitle}</div>
        ) : null}
      </div>
    </div>
    {actions?.length ? (
      <div className="flex flex-wrap gap-2">
        {actions.map((a, idx) => (
          <button
            key={idx}
            type="button"
            onClick={a.onClick}
            className={cx(
              "inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-xs transition",
              a.tone === "primary"
                ? "bg-emerald-600 border-emerald-600 text-white"
                : "bg-white border-gray-300 text-gray-800 hover:bg-gray-50"
            )}
            title={a.title || a.label}
          >
            {a.icon ? <a.icon className="w-4 h-4" /> : null}
            {a.label}
          </button>
        ))}
      </div>
    ) : null}
  </div>
);

/* --------------------------------- Component -------------------------------- */
export default function ConflictResolverBar({
  /** Optional external conflicts; if omitted we derive from store/inventory/standards */
  conflicts: conflictsProp,
  /** Current plan items (for derivation when conflictsProp not provided) */
  planItems = [],
  /** Called when a conflict is resolved (id, meta) */
  onResolved,
  /** Called after "Resolve All" */
  onResolveAll,
}) {
  const {
    TriangleAlert,
    CheckCircle2,
    XCircle,
    Clock,
    CalendarClock,
    ShoppingCart,
    ChefHat,
    Scale,
    RefreshCcw,
    Sparkles,
    ListChecks,
    Layers,
    Replace,
    MoveRight,
    Plus,
    Minus,
    ChevronDown,
    ChevronUp,
    Settings2,
    ShieldAlert,
    Ban,
  } = Icons;

  const { standards } = usePersonalFoodStandards();
  const cal = useHouseholdCalendar();
  const mealPlan = useMealPlanStore();

  const saved = loadUI();
  const [expanded, setExpanded] = useState(saved.expanded ?? false);
  const [busy, setBusy] = useState(false);

  // Live conflicts
  const conflicts = useMemo(() => {
    const base = Array.isArray(conflictsProp)
      ? conflictsProp
      : (mealPlan?.getConflicts?.() || []).length
      ? mealPlan.getConflicts()
      : deriveConflicts(planItems, standards, cal?.events || []);

    // Normalize structure
    return base.map((c, i) => ({
      id: c.id || `conf-${i}`,
      type: c.type || "generic",
      severity: c.severity || "med",
      message: c.message || "Needs attention",
      context: c.context || {},
      fixes: c.fixes || [],
      resolved: !!c.resolved,
    }));
  }, [conflictsProp, mealPlan, planItems, standards, cal?.events]);

  const counts = useMemo(() => {
    const all = conflicts.filter((c) => !c.resolved);
    return {
      total: all.length,
      high: all.filter((c) => c.severity === "high").length,
      med: all.filter((c) => c.severity === "med").length,
      low: all.filter((c) => c.severity === "low").length,
      byType: all.reduce(
        (acc, c) => ((acc[c.type] = (acc[c.type] || 0) + 1), acc),
        {}
      ),
      open: all,
    };
  }, [conflicts]);

  useEffect(() => {
    persistUI({ expanded });
  }, [expanded]);

  useEffect(() => {
    // Announce counts for NBA
    eventBus.emit("meals.planner.conflicts.summary", {
      total: counts.total,
      high: counts.high,
      med: counts.med,
      low: counts.low,
      byType: counts.byType,
    });
  }, [counts]);

  /* ------------------------------ Quick resolvers ----------------------------- */
  const resolveOne = async (conf) => {
    if (!conf || conf.resolved) return;
    try {
      setBusy(true);
      const ctx = conf.context || {};
      switch (conf.type) {
        case "inventory": {
          // Default action: add missing to grocery list
          try {
            if (ctx?.missing?.length) {
              InventoryMonitor.addToGroceryList?.(ctx.missing, {
                note: `Auto-added for ${ctx.item?.recipe?.title || "meal"}`,
              });
            }
          } catch (e) {
            console.warn("[ConflictResolver] addToGrocery failed:", e);
          }
          break;
        }
        case "time-overlap": {
          // Move second item to next logical slot/day
          const items = ctx.items || [];
          const move = items[1] || items[0];
          mealPlan.moveMeal?.(move?.id, { strategy: "next-slot" });
          break;
        }
        case "calendar": {
          // Shift prep earlier by 30m
          const it = ctx.item;
          mealPlan.moveMeal?.(it?.id, { strategy: "shift-prep", minutes: -30 });
          break;
        }
        case "standards": {
          // Swap recipe: let store choose a similar one
          const it = ctx.item;
          mealPlan.swapRecipe?.(it?.id, {
            strategy: "match-tags-with-standards",
          });
          break;
        }
        case "macros":
        case "servings":
        default: {
          // Mark resolved in store as fallback
          mealPlan.markResolved?.(conf.id);
        }
      }

      onResolved?.(conf.id, { type: conf.type });
      eventBus.emit("meals.planner.conflict.resolved", {
        id: conf.id,
        type: conf.type,
      });
    } finally {
      setBusy(false);
    }
  };

  const resolveAll = async () => {
    if (!counts.total) return;
    try {
      setBusy(true);
      // naive serial; stores can optimize internally
      for (const c of counts.open) {
        // eslint-disable-next-line no-await-in-loop
        await resolveOne(c);
      }
      onResolveAll?.();
      eventBus.emit("meals.planner.conflict.resolveAll", {
        total: counts.total,
      });
      if (automation?.runTemplate) {
        // Optionally trigger post-resolve automation (e.g., regenerate grocery list)
        automation.runTemplate("meals.postResolve.regenerateDerivedLists", {
          source: "ConflictResolverBar",
        });
      }
    } finally {
      setBusy(false);
    }
  };

  /* ------------------------------ Row render map ------------------------------ */
  function rowFor(conf) {
    const title = conf.message;
    const tone =
      conf.severity === "high"
        ? "high"
        : conf.severity === "low"
        ? "low"
        : "med";
    const common = [
      {
        label: "Resolve",
        icon: CheckCircle2,
        tone: "primary",
        onClick: () => resolveOne(conf),
      },
    ];

    switch (conf.type) {
      case "inventory": {
        const missing = conf.context?.missing || [];
        return (
          <Row
            key={conf.id}
            icon={ShoppingCart}
            title={title}
            subtitle={
              missing.length
                ? `Missing: ${missing.map((m) => m.name || m).join(", ")}`
                : null
            }
            tone={tone}
            actions={[
              {
                label: "Add to Grocery",
                icon: ListChecks,
                onClick: () => {
                  try {
                    InventoryMonitor.addToGroceryList?.(missing, {
                      note: `Auto-added for ${
                        conf.context?.item?.recipe?.title || "meal"
                      }`,
                    });
                    eventBus.emit("meals.grocery.added", {
                      count: missing.length,
                    });
                  } catch {}
                },
              },
              {
                label: "Suggest substitutes",
                icon: Replace,
                onClick: () =>
                  eventBus.emit("meals.substitutes.request", conf.context),
              },
              ...common,
            ]}
          />
        );
      }
      case "time-overlap":
        return (
          <Row
            key={conf.id}
            icon={Clock}
            title={title}
            tone={tone}
            actions={[
              {
                label: "Move to next slot",
                icon: MoveRight,
                onClick: () =>
                  mealPlan.moveMeal?.(
                    conf.context?.items?.[1]?.id ||
                      conf.context?.items?.[0]?.id,
                    {
                      strategy: "next-slot",
                    }
                  ),
              },
              ...common,
            ]}
          />
        );
      case "calendar":
        return (
          <Row
            key={conf.id}
            icon={CalendarClock}
            title={title}
            tone={tone}
            actions={[
              {
                label: "Shift prep -30m",
                icon: MoveRight,
                onClick: () =>
                  mealPlan.moveMeal?.(conf.context?.item?.id, {
                    strategy: "shift-prep",
                    minutes: -30,
                  }),
              },
              {
                label: "Reschedule day",
                icon: Layers,
                onClick: () =>
                  eventBus.emit("meals.reschedule.modal", conf.context),
              },
              ...common,
            ]}
          />
        );
      case "standards":
        return (
          <Row
            key={conf.id}
            icon={ShieldAlert}
            title={title}
            tone="high"
            actions={[
              {
                label: "Swap similar",
                icon: Replace,
                onClick: () =>
                  mealPlan.swapRecipe?.(conf.context?.item?.id, {
                    strategy: "match-tags-with-standards",
                  }),
              },
              {
                label: "Remove",
                icon: Ban,
                onClick: () =>
                  mealPlan.swapRecipe?.(conf.context?.item?.id, {
                    strategy: "remove",
                  }),
              },
              ...common,
            ]}
          />
        );
      case "servings":
        return (
          <Row
            key={conf.id}
            icon={Scale}
            title={title}
            tone={tone}
            actions={[
              {
                label: "− Servings",
                icon: Minus,
                onClick: () =>
                  mealPlan.changeServings?.(conf.context?.item?.id, {
                    delta: -1,
                    floor: 1,
                  }),
              },
              {
                label: "+ Servings",
                icon: Plus,
                onClick: () =>
                  mealPlan.changeServings?.(conf.context?.item?.id, {
                    delta: +1,
                  }),
              },
              ...common,
            ]}
          />
        );
      case "macros":
        return (
          <Row
            key={conf.id}
            icon={Dumbbell}
            title={title}
            tone={tone}
            actions={[
              {
                label: "Swap leaner",
                icon: Replace,
                onClick: () =>
                  mealPlan.swapRecipe?.(conf.context?.item?.id, {
                    strategy: "leaner-alt",
                  }),
              },
              ...common,
            ]}
          />
        );
      default:
        return (
          <Row
            key={conf.id}
            icon={TriangleAlert}
            title={title}
            tone={tone}
            actions={common}
          />
        );
    }
  }

  /* ----------------------------------- UI ----------------------------------- */
  return (
    <div
      className={cx(
        "sticky bottom-0 z-30 border-t bg-white/85 backdrop-blur supports-[backdrop-filter]:bg-white",
        "shadow-[0_-6px_12px_-8px_rgba(0,0,0,0.12)]"
      )}
    >
      <div className="max-w-7xl mx-auto px-4">
        {/* Bar */}
        <div className="flex items-center gap-3 py-2">
          {/* Status badge */}
          {counts.total ? (
            <Badge tone={counts.high ? "high" : counts.med ? "med" : "low"}>
              <TriangleAlert className="w-4 h-4" />
              {counts.total} conflict{counts.total !== 1 ? "s" : ""}
              {counts.high ? (
                <span className="ml-2 inline-flex items-center gap-1">
                  <ShieldAlert className="w-3 h-3" /> {counts.high} high
                </span>
              ) : null}
            </Badge>
          ) : (
            <Badge tone="low">
              <CheckCircle2 className="w-4 h-4" /> All clear
            </Badge>
          )}

          {/* Breakdown */}
          {counts.total ? (
            <div className="text-xs text-gray-600 flex items-center gap-3">
              <span>Inv: {counts.byType.inventory || 0}</span>
              <span>Time: {counts.byType["time-overlap"] || 0}</span>
              <span>Calendar: {counts.byType.calendar || 0}</span>
              <span>Standards: {counts.byType.standards || 0}</span>
              <span>Macros: {counts.byType.macros || 0}</span>
              <span>Servings: {counts.byType.servings || 0}</span>
            </div>
          ) : null}

          <div className="ml-auto flex items-center gap-2">
            {/* Resolve all */}
            {counts.total ? (
              <button
                type="button"
                onClick={resolveAll}
                disabled={busy}
                className={cx(
                  "inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm border transition",
                  "bg-emerald-600 border-emerald-600 text-white disabled:opacity-60"
                )}
                title="Attempt automatic fixes for all conflicts"
              >
                <Sparkles className="w-4 h-4" />
                Resolve all
              </button>
            ) : null}

            {/* Refresh (re-scan) */}
            <button
              type="button"
              onClick={() => {
                eventBus.emit("meals.planner.conflicts.rescan");
                if (automation?.runTemplate) {
                  automation.runTemplate("meals.conflicts.rescan", {
                    source: "ConflictResolverBar",
                  });
                }
              }}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border text-sm bg-white border-gray-300 text-gray-800 hover:bg-gray-50"
              title="Re-scan conflicts"
            >
              <RefreshCcw className="w-4 h-4" />
              Re-scan
            </button>

            {/* Expand */}
            <button
              type="button"
              onClick={() => setExpanded((s) => !s)}
              className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg border text-sm bg-white border-gray-300 text-gray-800 hover:bg-gray-50"
              aria-expanded={expanded}
              title={expanded ? "Hide details" : "Show details"}
            >
              {expanded ? (
                <ChevronDown className="w-4 h-4" />
              ) : (
                <ChevronUp className="w-4 h-4" />
              )}
              {expanded ? "Hide" : "Details"}
            </button>
          </div>
        </div>

        {/* Drawer */}
        {expanded && counts.total ? (
          <div className="pb-3">
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {counts.open.map((c) => rowFor(c))}
            </div>

            {/* Hints */}
            <div className="mt-3 text-[11px] text-gray-500 flex items-center gap-3">
              <Settings2 className="w-3 h-3" />
              Tip: You can set default auto-fix rules in Settings → Meals →
              Planner (e.g., “auto add missing to grocery”).
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
