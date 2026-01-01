// src/components/meals/MealWeekGrid.jsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { classNames as cx } from "@/utils/css";
import { sabbathGuard } from "@/services/guardrails/sabbathGuard";
import { automation, emitProgress } from "@/services/automation/runtime";
import { eventBus } from "@/services/events/eventBus";

let MealDayCard, NBAToolbar, UndoToast, TargetsBadge;
try { MealDayCard  = require("./MealDayCard.jsx").default; } catch {}
try { NBAToolbar   = require("./NBAToolbar.jsx").default; } catch {}
try { UndoToast    = require("./UndoToast.jsx").default; } catch {}
try { TargetsBadge = require("./TargetsBadge.jsx").default; } catch {}

// Optional stores (component still works without them)
let useMealPlanStore, usePreferencesStore, useFoodStore, useRecipeStore;
try { useMealPlanStore   = require("@/store/MealPlanStore").useMealPlanStore; } catch {}
try { usePreferencesStore= require("@/store/PreferencesStore").usePreferencesStore; } catch {}
try { useFoodStore       = require("@/store/FoodStore").useFoodStore; } catch {}
try { useRecipeStore     = require("@/store/RecipeStore").useRecipeStore; } catch {}

export default function MealWeekGrid({
  // Props
  weekStartDate: weekStartDateProp, // JS Date or ISO; defaults to current week's start (Mon)
  days = 7,
  mode = "auto",                    // "auto" | "manual"
  compact = false,
  editable = true,
  // Optional: external change hook
  onWeekChange,                     // ({ weekStartISO, reason, state }) => void
}) {
  const meal  = useMealPlanStore?.() || { getWeekPlan: () => null, setDay: () => {}, activeWeek: null };
  const prefs = usePreferencesStore?.() || {};
  const food  = useFoodStore?.() || {};
  const recipesStore = useRecipeStore?.();

  const [weekStart, setWeekStart] = useState(() => normalizeWeekStart(weekStartDateProp));
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);

  // derive array of day objects for rendering
  const daysArr = useMemo(() => {
    const start = new Date(weekStart);
    return Array.from({ length: days }, (_, i) => {
      const d = new Date(start); d.setDate(start.getDate() + i);
      return d;
    });
  }, [weekStart, days]);

  // week state from store or local
  const [weekState, setWeekState] = useState(() => getWeekSnapshot(meal, weekStart, days));
  useEffect(() => setWeekState(getWeekSnapshot(meal, weekStart, days)), [meal?.activeWeek, weekStart, days]);

  // respond to external mutations via eventBus
  useEffect(() => {
    const offA = eventBus?.on?.("mealPlan.updated", (e) => {
      // refresh on any relevant changes
      if (!e || e.scope === "all" || e.scope === "day" || e.scope === "slot") {
        setWeekState(getWeekSnapshot(meal, weekStart, days));
      }
    });
    const offB = eventBus?.on?.("preferences.changed", () => forceRerender());
    return () => { offA?.(); offB?.(); };
  }, [meal, weekStart, days]);

  const forceRerender = () => setWeekState((prev) => ({ ...prev }));

  // totals for the whole week
  const weeklyTotals = useMemo(() => {
    return sumWeekNutrition(weekState, recipesStore);
  }, [weekState, recipesStore]);

  // goals (USDA defaults + user overrides)
  const goals = useMemo(() => {
    const g = prefs?.nutritionGoals || food?.goals || {};
    // Daily goals scaled up to the week display (for progress bars)
    const daily = {
      calories: safeNum(g.calories, 2000),
      protein:  safeNum(g.protein,   75),
      carbs:    safeNum(g.carbs,    250),
      fat:      safeNum(g.fat,       70),
    };
    return {
      daily,
      weekly: {
        calories: daily.calories * days,
        protein:  daily.protein  * days,
        carbs:    daily.carbs    * days,
        fat:      daily.fat      * days,
      },
      macroPct: {
        protein: clampPct(g.macroPct?.protein ?? 25),
        carbs:   clampPct(g.macroPct?.carbs   ?? 45),
        fat:     clampPct(g.macroPct?.fat     ?? 30),
      },
    };
  }, [prefs?.nutritionGoals, food?.goals, days]);

  const actualPct = useMemo(() => {
    const { protein, carbs, fat } = weeklyTotals;
    const cp = protein * 4, cc = carbs * 4, cf = fat * 9;
    const denom = Math.max(1, cp + cc + cf);
    return {
      protein: Math.round((cp / denom) * 100),
      carbs:   Math.round((cc / denom) * 100),
      fat:     Math.round((cf / denom) * 100),
    };
  }, [weeklyTotals]);

  // NBA toolbar
  const nbaActions = useMemo(() => ([
    {
      key: "autoWeek",
      label: "Auto-fill Week",
      tooltip: "Use rhythm, inventory & preferences to fill the whole week",
      intent: "primary",
      onClick: () => autofillWeek(),
      disabled: busy || !editable,
    },
    {
      key: "balanceWeek",
      label: "Balance Macros",
      tooltip: "Suggest swaps to nudge weekly macros toward your targets",
      onClick: () => balanceWeek(),
      disabled: busy || !editable,
    },
    {
      key: "copyPrevWeek",
      label: "Copy Previous",
      onClick: () => copyPreviousWeek(),
      disabled: busy || !editable,
    },
    {
      key: "export",
      label: "Export PDF",
      onClick: () => exportWeekPDF(),
      disabled: busy,
    },
  ]), [busy, editable]);

  // Navigation
  const goPrev = () => setWeekStart((d) => offsetDays(d, -7));
  const goNext = () => setWeekStart((d) => offsetDays(d, 7));
  const goToday = () => setWeekStart(normalizeWeekStart(new Date()));

  // Day change handler from children
  const handleDayChange = ({ dayKey, reason, state }) => {
    // Persist if store provides a setter
    meal.setDay?.(dayKey, state);
    // Update local mirror
    setWeekState((prev) => ({ ...prev, [dayKey]: state }));
    // bubble to parent if needed
    onWeekChange?.({ weekStartISO: toISODate(weekStart), reason: `day.${reason}`, state: getWeekSnapshot(meal, weekStart, days) });
  };

  // Automations
  const autofillWeek = async () => {
    setBusy(true);
    const fn = async () => {
      const payload = { weekStartISO: toISODate(weekStart), days };
      const result = await automation?.("meal.autofillWeek", payload);
      if (result?.week) {
        applyWeekPatch(result.week);
        emitWeekChanged("autoWeek.applied");
      }
      setBusy(false);
    };
    await sabbathGuard(fn)();
  };

  const balanceWeek = async () => {
    setBusy(true);
    const fn = async () => {
      const payload = {
        weekStartISO: toISODate(weekStart),
        days,
        current: weekState,
        goals,
      };
      const result = await automation?.("meal.balanceWeek", payload);
      if (result?.patch) {
        applyWeekPatch(result.patch);
        emitWeekChanged("macros.balanced");
      }
      setBusy(false);
    };
    await sabbathGuard(fn)();
  };

  const copyPreviousWeek = async () => {
    setBusy(true);
    const fn = async () => {
      const prevStart = offsetDays(weekStart, -7);
      const result = await automation?.("meal.copyWeek", { fromWeekStartISO: toISODate(prevStart), toWeekStartISO: toISODate(weekStart) });
      if (result?.week) {
        applyWeekPatch(result.week);
        emitWeekChanged("week.copied");
      }
      setBusy(false);
    };
    await sabbathGuard(fn)();
  };

  const exportWeekPDF = async () => {
    setBusy(true);
    const payload = {
      title: `Meal Plan • ${formatWeekRange(weekStart, days)}`,
      weekStartISO: toISODate(weekStart),
      days,
      state: weekState,
      totals: weeklyTotals,
      goals,
    };
    await automation?.("export.pdf", payload);
    setBusy(false);
    setToast({ message: "Exported meal plan as PDF" });
  };

  // Apply patch util
  const applyWeekPatch = (patch) => {
    // patch: { dayISO: { slots: { Breakfast:[], ... } } }
    setWeekState((prev) => {
      const next = { ...prev };
      for (const [dayKey, dayState] of Object.entries(patch || {})) {
        next[dayKey] = normalizeDay(dayState);
        // write-through to store if available
        meal.setDay?.(dayKey, next[dayKey]);
      }
      return next;
    });
  };

  const emitWeekChanged = (reason) => {
    emitProgress?.("meal.week.changed", { weekStartISO: toISODate(weekStart), reason });
    eventBus?.emit?.("mealPlan.updated", { scope: "all", weekStartISO: toISODate(weekStart), reason });
    onWeekChange?.({ weekStartISO: toISODate(weekStart), reason, state: weekState });
  };

  // Header display
  const weekTitle = formatWeekRange(weekStart, days);

  const emptyWeek = useMemo(() => {
    return Object.values(weekState || {}).every((d) => !d || Object.values(d?.slots || {}).every((arr) => !arr?.length));
  }, [weekState]);

  return (
    <div className={cx("rounded-2xl border border-base-200 bg-base-100 shadow-md", compact ? "p-3" : "p-5")}>
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-semibold leading-tight">{weekTitle}</h2>
            <ModeBadge mode={mode} />
          </div>
          {/* Weekly macro percentage vs targets */}
          {TargetsBadge ? (
            <TargetsBadge actual={actualPct} target={goals.macroPct} />
          ) : (
            <FallbackTargets actual={actualPct} target={goals.macroPct} />
          )}
        </div>

        <div className="flex items-center gap-2">
          <NavButton onClick={goPrev} ariaLabel="Previous week">←</NavButton>
          <button className="btn btn-ghost btn-sm" onClick={goToday}>This Week</button>
          <NavButton onClick={goNext} ariaLabel="Next week">→</NavButton>

          {NBAToolbar ? (
            <div className="ml-2">
              <NBAToolbar actions={nbaActions} />
            </div>
          ) : (
            <div className="ml-2 flex items-center gap-2">
              <button className="btn btn-primary btn-sm" onClick={autofillWeek} disabled={busy || !editable}>Auto-fill</button>
              <button className="btn btn-ghost btn-sm" onClick={balanceWeek} disabled={busy || !editable}>Balance</button>
              <button className="btn btn-ghost btn-sm" onClick={copyPreviousWeek} disabled={busy || !editable}>Copy Prev</button>
              <button className="btn btn-outline btn-sm" onClick={exportWeekPDF} disabled={busy}>Export PDF</button>
            </div>
          )}
        </div>
      </div>

      {/* Weekly totals vs weekly goals */}
      <WeekTotals totals={weeklyTotals} goalsWeekly={goals.weekly} />

      {/* Empty state */}
      {emptyWeek && (
        <div className="mt-4">
          <EmptyWeek onAutoFill={autofillWeek} />
        </div>
      )}

      {/* Grid of days */}
      <div className="mt-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {daysArr.map((date) => {
          const dayKey = toISODate(date);
          const dayState = weekState?.[dayKey] || normalizeDay();
          return (
            <MealDayCard
              key={dayKey}
              date={date}
              dayKey={dayKey}
              slots={Object.keys(dayState.slots)}
              itemsBySlot={dayState.slots}
              editable={editable}
              compact={compact}
              mode={dayState.mode || mode}
              onChangeDay={handleDayChange}
            />
          );
        })}
      </div>

      {/* Toast for exports etc. */}
      {UndoToast && toast && (
        <UndoToast
          message={toast.message}
          onClose={() => setToast(null)}
        />
      )}
    </div>
  );
}

/* ----------------------------------------------------------------------------
   Subcomponents
---------------------------------------------------------------------------- */
function WeekTotals({ totals, goalsWeekly }) {
  const rows = [
    { key: "calories", label: "Calories", unit: "kcal" },
    { key: "protein",  label: "Protein",  unit: "g"   },
    { key: "carbs",    label: "Carbs",    unit: "g"   },
    { key: "fat",      label: "Fat",      unit: "g"   },
  ];
  return (
    <div className="mt-3 rounded-xl border border-base-200 p-3 bg-base-100/60">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {rows.map((r) => {
          const val = Math.round(totals[r.key] || 0);
          const goal = Math.max(1, Math.round(goalsWeekly[r.key] || 0));
          const pct  = Math.min(100, Math.round((val / goal) * 100));
          return (
            <div key={r.key}>
              <div className="flex items-center justify-between mb-1 text-sm">
                <span className="font-medium">{r.label}</span>
                <span className="text-base-content/70">{val} / {goal} {r.unit}</span>
              </div>
              <div className="w-full bg-base-200 rounded-full h-2 overflow-hidden">
                <div className="h-2 rounded-full bg-primary" style={{ width: `${pct}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ModeBadge({ mode }) {
  const isAuto = mode === "auto";
  return (
    <span className={cx("badge", isAuto ? "badge-info" : "badge-warning")}>
      {isAuto ? "AUTO" : "MANUAL"}
    </span>
  );
}

function NavButton({ onClick, ariaLabel, children }) {
  return (
    <button
      className="btn btn-ghost btn-sm"
      aria-label={ariaLabel}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function EmptyWeek({ onAutoFill }) {
  return (
    <div className="rounded-xl border border-dashed border-base-300 p-8 text-center bg-base-100">
      <div className="text-lg font-semibold">No meals planned this week</div>
      <p className="text-sm text-base-content/70 mt-1">
        Start by auto-filling from your preferences & inventory, or add meals day by day.
      </p>
      <div className="mt-4 flex items-center justify-center gap-2">
        <button className="btn btn-primary btn-sm" onClick={onAutoFill}>Auto-fill Week</button>
      </div>
    </div>
  );
}

function FallbackTargets({ actual, target }) {
  const chips = [
    ["Protein", actual.protein, target.protein],
    ["Carbs",   actual.carbs,   target.carbs],
    ["Fat",     actual.fat,     target.fat],
  ];
  return (
    <div className="text-xs text-base-content/70 flex flex-wrap items-center gap-2">
      {chips.map(([k, a, t]) => (
        <span key={k} className="badge badge-ghost">{k}: {a}% / {t}%</span>
      ))}
    </div>
  );
}

/* ----------------------------------------------------------------------------
   Helpers
---------------------------------------------------------------------------- */
function normalizeWeekStart(any) {
  const d = (typeof any === "string" || typeof any === "number") ? new Date(any) : (any || new Date());
  // Start of week = Monday; adjust from current day (Sun=0..Sat=6)
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1 - day); // move to Monday
  const start = new Date(d);
  start.setHours(0,0,0,0);
  start.setDate(d.getDate() + diff);
  return start;
}
function offsetDays(base, n) {
  const d = new Date(base);
  d.setDate(d.getDate() + n);
  return normalizeWeekStart(d);
}
function toISODate(d) {
  const x = new Date(d); x.setHours(0,0,0,0);
  const z = new Date(x.getTime() - x.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0,10);
}
function formatWeekRange(weekStart, days) {
  const start = new Date(weekStart);
  const end = new Date(weekStart); end.setDate(start.getDate() + days - 1);
  const s = start.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const e = end.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${s} – ${e}`;
}

function normalizeDay(day) {
  // shape: { mode?: "auto"|"manual", slots: { Breakfast:[], Lunch:[], Dinner:[], Snack:[] } }
  const base = { Breakfast: [], Lunch: [], Dinner: [], Snack: [] };
  const slots = { ...base, ...(day?.slots || {}) };
  return { mode: day?.mode || "auto", slots };
}

function getWeekSnapshot(mealStore, weekStart, days) {
  const out = {};
  const start = new Date(weekStart);
  for (let i = 0; i < days; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const key = toISODate(d);
    const fromStore = mealStore?.getDay?.(key) || mealStore?.getWeekPlan?.(toISODate(weekStart))?.days?.[key] || null;
    out[key] = normalizeDay(fromStore);
  }
  return out;
}

function sumWeekNutrition(weekState, recipesStore) {
  let calories = 0, protein = 0, carbs = 0, fat = 0;
  for (const day of Object.values(weekState || {})) {
    for (const items of Object.values(day?.slots || {})) {
      for (const r of items || []) {
        const full = resolveRecipe(r, recipesStore);
        const n = full?.nutrition || r?.nutrition || null;
        if (!n) continue;
        calories += safeNum(n.calories, 0);
        protein  += safeNum(n.protein,  0);
        carbs    += safeNum(n.carbs,    0);
        fat      += safeNum(n.fat,      0);
      }
    }
  }
  return { calories, protein, carbs, fat };
}
function resolveRecipe(ref, recipesStore) {
  if (!recipesStore?.getById || !ref?.id) return ref;
  return recipesStore.getById(ref.id) || ref;
}
function safeNum(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function clampPct(n) {
  const v = Math.round(Number(n) || 0);
  return Math.min(100, Math.max(0, v));
}
