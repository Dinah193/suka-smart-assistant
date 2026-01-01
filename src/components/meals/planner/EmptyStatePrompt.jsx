// src/components/meals/planner/EmptyStatePrompt.jsx
/* eslint-disable no-console */
import React, { useEffect, useMemo, useState } from "react";

/* ------------------------------- Defensive deps ------------------------------- */
let Icons = {};
try {
  Icons = require("lucide-react");
} catch {
  Icons = {
    Sparkles: () => null,
    FolderOpen: () => null,
    ScanText: () => null,
    ListChecks: () => null,
    Refrigerator: () => null,
    Soup: () => null,
    CalendarDays: () => null,
    ClipboardList: () => null,
    Upload: () => null,
    Download: () => null,
    Brain: () => null,
    Filter: () => null,
    ChevronRight: () => null,
    ChevronDown: () => null,
    Stars: () => null,
    Clock: () => null,
    Layers: () => null,
    Search: () => null,
    Settings2: () => null,
  };
}

let eventBus = { emit: () => {}, on: () => {}, off: () => {} };
try {
  eventBus = require("@/services/eventBus").eventBus || eventBus;
} catch {}

let automation = null;
try {
  automation = require("@/services/automation/runtime").automation || null;
} catch {}

let InventoryMonitor = {
  getPantrySnapshot: () => ({ status: "unknown", itemsOnHand: 0 }),
  suggestFromPantry: () => [],
};
try {
  InventoryMonitor =
    require("@/managers/InventoryMonitor").default ||
    require("@/managers/InventoryMonitor") ||
    InventoryMonitor;
} catch {}

let usePersonalFoodStandards = () => ({ standards: {} });
try {
  usePersonalFoodStandards =
    require("@/app/context/HouseholdSettingsContext").usePersonalFoodStandards ||
    usePersonalFoodStandards;
} catch {}

let useBatchQueue = () => ({ count: 0, startSession: () => {} });
try {
  useBatchQueue =
    require("@/features/meals/BatchQueueProvider").useBatchQueue || useBatchQueue;
} catch {}

let useMealPlanStore = () => ({
  // optional hooks your store may provide
  recommended: [],
  addFromRecipe: () => {},
  hydrateFromTemplates: () => {},
  buildFromRules: () => {},
});
try {
  useMealPlanStore = require("@/store/MealPlanStore").useMealPlanStore || useMealPlanStore;
} catch {}

/* --------------------------------- Utilities -------------------------------- */
const cx = (...xs) => xs.filter(Boolean).join(" ");
const fmt = (n) => new Intl.NumberFormat().format(n);

/* ---------------------------------- Component -------------------------------- */
export default function EmptyStatePrompt({
  scope = "week", // 'day' | 'week' | 'month'
  onAction,       // optional callback (actionId) => void
  className,
}) {
  const {
    Sparkles, FolderOpen, ScanText, ListChecks, Refrigerator, Soup, CalendarDays,
    ClipboardList, Upload, Download, Brain, Filter, ChevronRight, Search, Settings2, Clock, Layers
  } = Icons;

  const { standards } = usePersonalFoodStandards();
  const batch = useBatchQueue();
  const mealPlan = useMealPlanStore();

  const [pantry, setPantry] = useState({ status: "unknown", itemsOnHand: 0 });
  useEffect(() => {
    try {
      const snap = InventoryMonitor.getPantrySnapshot?.() || pantry;
      setPantry(snap);
    } catch (e) {
      console.warn("[EmptyStatePrompt] pantry snapshot failed:", e);
    }
  }, []);

  // Lightweight recommendations from pantry + standards
  const pantryIdeas = useMemo(() => {
    try {
      const list = InventoryMonitor.suggestFromPantry?.({ standards, max: 6 }) || [];
      return Array.isArray(list) ? list.slice(0, 6) : [];
    } catch {
      return [];
    }
  }, [standards]);

  // Feature flags (soft detection so we never crash)
  const hasScanner = !!automation?.runTemplate;
  const hasTemplates = typeof mealPlan?.hydrateFromTemplates === "function";
  const hasAIBuilder = typeof mealPlan?.buildFromRules === "function" || !!automation?.runTemplate;

  // Quick CTA definitions
  const actions = [
    {
      id: "open-vault",
      label: "Open Recipe Vault",
      desc: "Pick meals to add to your plan.",
      icon: FolderOpen,
      tone: "primary",
      onClick: () => {
        eventBus.emit("meals.vault.open", { source: "EmptyStatePrompt" });
        onAction?.("open-vault");
      },
    },
    hasScanner && {
      id: "scan-recipes",
      label: "Scan or Import",
      desc: "Capture from web, photos, or files.",
      icon: ScanText,
      onClick: () => {
        automation.runTemplate?.("meals.collector.openScanner", { source: "EmptyStatePrompt" });
        onAction?.("scan-recipes");
      },
    },
    {
      id: "pantry-suggest",
      label: "Generate from Pantry",
      desc: pantry.itemsOnHand > 0
        ? `Use ${fmt(pantry.itemsOnHand)} on-hand items`
        : "Use what you already have",
      icon: Refrigerator,
      onClick: () => {
        eventBus.emit("meals.plan.generateFromPantry", { scope, standards });
        onAction?.("pantry-suggest");
      },
    },
    {
      id: "batch-session",
      label: "Start Batch Session",
      desc: batch.count ? `Queue has ${batch.count} recipe(s)` : "Cook ahead for the week",
      icon: Soup,
      onClick: () => {
        batch.startSession?.();
        eventBus.emit("meals.batch.start", { source: "EmptyStatePrompt" });
        onAction?.("batch-session");
      },
    },
    hasTemplates && {
      id: "apply-template",
      label: "Apply a Template",
      desc: "Drop in a proven weekly structure",
      icon: ClipboardList,
      onClick: () => {
        try { mealPlan.hydrateFromTemplates?.({ scope }); } catch {}
        eventBus.emit("meals.plan.applyTemplate", { scope });
        onAction?.("apply-template");
      },
    },
    hasAIBuilder && {
      id: "ai-builder",
      label: "Use AI Meal Builder",
      desc: "Build a plan from rules & targets",
      icon: Brain,
      onClick: () => {
        // Prefer your store builder; fall back to an automation template
        if (typeof mealPlan.buildFromRules === "function") {
          mealPlan.buildFromRules({ scope, standards, source: "EmptyStatePrompt" });
        } else {
          automation.runTemplate?.("meals.ai.builder.open", { scope, standards });
        }
        eventBus.emit("meals.ai.builder.requested", { scope });
        onAction?.("ai-builder");
      },
    },
    {
      id: "calendar-slots",
      label: "See Calendar Slots",
      desc: "Pick dates & times first",
      icon: CalendarDays,
      onClick: () => {
        eventBus.emit("meals.calendar.peek", { scope });
        onAction?.("calendar-slots");
      },
    },
  ].filter(Boolean);

  /* ----------------------------------- UI ----------------------------------- */
  return (
    <div
      className={cx(
        "rounded-2xl border border-dashed border-gray-300 bg-white p-6 md:p-8 text-center",
        "shadow-sm",
        className
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-center gap-2">
        <Sparkles className="w-5 h-5 text-emerald-600" />
        <h3 className="text-lg md:text-xl font-semibold text-gray-900">
          Let’s build your {scope === "day" ? "day" : scope} meal plan
        </h3>
      </div>
      <p className="mt-2 text-sm text-gray-600">
        Start with what you have, pull favorites from your vault, or let the system propose a balanced plan.
      </p>

      {/* Collect • Decide • Plan */}
      <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3 text-left">
        <ModeCard
          mode="Collect"
          icon={Search}
          bullets={[
            "Add recipes from Vault or Scanner",
            "Tag by type, cuisine, batch-ready",
            "Save your shortlists as Collections",
          ]}
          onClick={() => {
            eventBus.emit("meals.mode.select", { mode: "Collect" });
            eventBus.emit("meals.vault.open", { source: "EmptyStatePrompt" });
            onAction?.("mode-collect");
          }}
        />
        <ModeCard
          mode="Decide"
          icon={Filter}
          bullets={[
            "Use filters: rating, time, macros",
            "Personal Food Standards applied",
            "Pin 7–10 for the week",
          ]}
          onClick={() => {
            eventBus.emit("meals.mode.select", { mode: "Decide" });
            onAction?.("mode-decide");
          }}
        />
        <ModeCard
          mode="Plan"
          icon={CalendarDays}
          bullets={[
            "Drag pins to calendar slots",
            "Auto-check inventory & conflicts",
            "Generate grocery list",
          ]}
          onClick={() => {
            eventBus.emit("meals.mode.select", { mode: "Plan" });
            onAction?.("mode-plan");
          }}
        />
      </div>

      {/* Smart actions */}
      <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 text-left">
        {actions.map((a) => (
          <ActionButton key={a.id} {...a} />
        ))}
      </div>

      {/* Pantry suggestions (if any) */}
      {pantryIdeas.length > 0 && (
        <div className="mt-6 text-left">
          <div className="flex items-center gap-2 mb-2">
            <Refrigerator className="w-4 h-4 text-gray-600" />
            <h4 className="text-sm font-semibold text-gray-800">Quick ideas from your pantry</h4>
          </div>
          <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {pantryIdeas.map((r, idx) => (
              <li
                key={`${r.id || r.title || "idea"}-${idx}`}
                className="flex items-center justify-between gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2"
              >
                <div className="truncate">
                  <div className="text-sm font-medium text-gray-900 truncate">{r.title || "Recipe"}</div>
                  {r.badge ? <div className="text-[11px] text-gray-600">{r.badge}</div> : null}
                </div>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-xs bg-white border-gray-300 text-gray-800 hover:bg-gray-50"
                  onClick={() => {
                    try { mealPlan.addFromRecipe?.(r); } catch {}
                    eventBus.emit("meals.plan.add", { id: r.id, title: r.title, source: "EmptyStatePrompt" });
                  }}
                >
                  Add <ChevronRight className="w-3 h-3" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Tips row */}
      <div className="mt-6 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-gray-500">
        <div className="flex items-center gap-2">
          <Settings2 className="w-3 h-3" />
          Tip: set defaults in <span className="font-medium">Settings → Meals</span> (e.g., auto-apply standards, default plan scope).
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden sm:inline">Shortcuts:</span>
          <kbd className="px-1 border rounded bg-white">/</kbd> focus search
          <kbd className="px-1 border rounded bg-white">P</kbd> open planner
          <kbd className="px-1 border rounded bg-white">B</kbd> batch session
        </div>
      </div>
    </div>
  );
}

/* --------------------------------- Subparts --------------------------------- */

function ActionButton({ id, label, desc, icon: Icon, tone = "default", onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "group w-full rounded-xl border px-4 py-3 transition text-left",
        tone === "primary"
          ? "bg-emerald-600 border-emerald-600 text-white hover:bg-emerald-700"
          : "bg-white border-gray-200 hover:bg-gray-50"
      )}
      aria-label={label}
    >
      <div className="flex items-center gap-3">
        <div
          className={cx(
            "rounded-lg p-2 border",
            tone === "primary" ? "bg-emerald-700/20 border-emerald-500" : "bg-gray-100 border-gray-200"
          )}
        >
          {Icon ? (
            <Icon className={cx("w-5 h-5", tone === "primary" ? "text-white" : "text-gray-700")} />
          ) : null}
        </div>
        <div className="flex-1">
          <div className={cx("font-medium", tone === "primary" ? "text-white" : "text-gray-900")}>
            {label}
          </div>
          <div className={cx("text-xs", tone === "primary" ? "text-emerald-50/90" : "text-gray-600")}>
            {desc}
          </div>
        </div>
        <Icons.ChevronRight
          className={cx(
            "w-4 h-4 transition-opacity",
            tone === "primary" ? "text-white/80" : "text-gray-500",
            "group-hover:opacity-100 opacity-80"
          )}
        />
      </div>
    </button>
  );
}

function ModeCard({ mode, icon: Icon, bullets = [], onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-xl border border-gray-200 bg-white p-4 hover:bg-gray-50 text-left transition"
      aria-label={`Switch to ${mode}`}
    >
      <div className="flex items-center gap-2">
        {Icon ? <Icon className="w-5 h-5 text-gray-700" /> : null}
        <div className="text-sm font-semibold text-gray-900">{mode}</div>
      </div>
      <ul className="mt-2 space-y-1 text-xs text-gray-600">
        {bullets.map((b, i) => (
          <li key={`${mode}-b-${i}`} className="flex items-start gap-2">
            <span className="mt-[6px] inline-block h-1.5 w-1.5 rounded-full bg-emerald-600" />
            <span>{b}</span>
          </li>
        ))}
      </ul>
    </button>
  );
}
