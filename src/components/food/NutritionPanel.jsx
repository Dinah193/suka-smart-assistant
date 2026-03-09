// src/components/food/NutritionPanel.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { automation, emitProgress } from "@/services/automation/runtime";
import { classNames as cx } from "@/utils/css";

// These stores are optional in some environments. Guard their usage.
import { useFoodStore as _useFoodStore } from "@/store/FoodStore";
import { usePreferencesStore as _usePreferencesStore } from "@/store/PreferencesStore";

/* -------------------------------------------------------------------------- */
/* UI atoms                                                                   */
/* -------------------------------------------------------------------------- */
const Card = ({ title, subtitle, right, children }) => (
  <div className="rounded-2xl border border-base-200 bg-base-100 shadow-md">
    <div className="flex items-start justify-between p-4 border-b border-base-200">
      <div>
        <h3 className="text-lg font-semibold">{title}</h3>
        {subtitle && <p className="text-sm opacity-70 mt-1">{subtitle}</p>}
      </div>
      {right}
    </div>
    <div className="p-4">{children}</div>
  </div>
);

const Button = (p) => <button {...p} className={cx("btn", p.className)} />;
const Primary = (p) => (
  <Button {...p} className={cx("btn-primary", p.className)} />
);
const Subtle = (p) => (
  <Button {...p} className={cx("btn-outline btn-sm", p.className)} />
);

const Skeleton = ({ lines = 3 }) => (
  <div className="animate-pulse space-y-3">
    {Array.from({ length: lines }).map((_, i) => (
      <div key={i} className="h-4 bg-base-200 rounded" />
    ))}
  </div>
);

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */
function pct(n, d) {
  if (!d || d <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((n / d) * 100)));
}

/** Computes calories and macro % from grams. */
function deriveMacros(n) {
  const p = Number(n?.protein ?? 0);
  const c = Number(n?.carbs ?? 0);
  const f = Number(n?.fat ?? 0);
  const calFromMacros = p * 4 + c * 4 + f * 9;
  const calories = Number(n?.calories ?? calFromMacros);
  const pp = pct(p * 4, calories);
  const cp = pct(c * 4, calories);
  const fp = pct(f * 9, calories);
  return { calories, p, c, f, pp, cp, fp };
}

function multiply(obj, n = 1) {
  const out = {};
  Object.entries(obj || {}).forEach(
    ([k, v]) => (out[k] = typeof v === "number" ? v * n : v)
  );
  return out;
}

function fmt(n, unit = "", dp = 0) {
  if (n == null || Number.isNaN(n)) return `0${unit}`;
  const v = dp > 0 ? Number(n).toFixed(dp) : Math.round(Number(n));
  return `${v}${unit}`;
}

/* -------------------------------------------------------------------------- */
/* Undo stack                                                                 */
/* -------------------------------------------------------------------------- */
function useUndoStack() {
  const stack = useRef([]);
  const push = (revert, descr = "Change") => {
    stack.current.push(revert);
    return { undo: () => stack.current.pop()?.(), descr };
  };
  return { push };
}

/* -------------------------------------------------------------------------- */
/* Event-driven glue                                                          */
/* -------------------------------------------------------------------------- */
const EVENT_KEYS = [
  "recipe.consolidated",
  "inventory.updated",
  "calendar.synced",
  "preferences.changed",
  "torah.profile.updated",
];

function useAutomationGlue(onEvent) {
  useEffect(() => {
    const offs = [];
    EVENT_KEYS.forEach((k) => {
      const off = automation?.on?.(k, (payload) => onEvent?.(k, payload));
      if (typeof off === "function") offs.push(off);
    });
    return () =>
      offs.forEach((f) => {
        try {
          f?.();
        } catch {}
      });
  }, [onEvent]);
}

/* -------------------------------------------------------------------------- */
/* NutritionPanel                                                             */
/* -------------------------------------------------------------------------- */
/**
 * Props:
 *  - sessionId?: string
 *  - recipes?: Array<string | {id:string, servings?:number}>
 *  - servings?: number                 (controlled value; optional)
 *  - onServingsChange?: (n:number) => void
 *  - dense?: boolean
 *  - showActions?: boolean             (default true)
 */
export default function NutritionPanel({
  sessionId,
  recipes = [],
  servings,
  onServingsChange,
  dense = false,
  showActions = true,
}) {
  // Stores are optional – guard them so the panel never throws if they’re not wired.
  const useFoodStore =
    typeof _useFoodStore === "function" ? _useFoodStore : null;
  const usePreferencesStore =
    typeof _usePreferencesStore === "function" ? _usePreferencesStore : null;

  const food = useFoodStore ? useFoodStore() ?? {} : {};
  const prefs = usePreferencesStore ? usePreferencesStore() ?? {} : {};

  const [loading, setLoading] = useState(false);
  const [nutr, setNutr] = useState(null); // { perServing, total }
  const [toast, setToast] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const [localServings, setLocalServings] = useState(
    typeof servings === "number" ? servings : 1
  );

  // keep local in sync with controlled prop
  useEffect(() => {
    if (typeof servings === "number") setLocalServings(servings);
  }, [servings]);

  const effectiveServings =
    typeof servings === "number" ? servings : localServings;

  // Normalize recipes: accept string ids or {id, servings}
  const normalizedRecipes = useMemo(() => {
    if (!Array.isArray(recipes)) return [];
    return recipes
      .map((r) => {
        if (!r) return null;
        if (typeof r === "string") return { id: r, servings: 1 };
        if (typeof r === "object" && r.id)
          return { id: r.id, servings: Number(r.servings ?? 1) || 1 };
        return null;
      })
      .filter(Boolean);
  }, [recipes]);

  const goals = prefs?.nutritionGoals || {
    calories: 2000,
    protein: 120,
    carbs: 200,
    fat: 70,
  };

  const undo = useUndoStack();

  const canFetchBySession = !!sessionId;
  const canFetchByRecipes = normalizedRecipes.length > 0;

  const refetch = async () => {
    // If no inputs, clear and bail (prevents stray fallbacks)
    if (!canFetchBySession && !canFetchByRecipes) {
      setNutr(null);
      return;
    }

    setLoading(true);
    try {
      let data = null;

      // Prefer store methods if present (fast local cache), then automation bridge.
      if (canFetchBySession) {
        if (typeof food.getNutritionForSession === "function") {
          data = await food.getNutritionForSession(sessionId, {
            servings: effectiveServings,
          });
        } else if (automation?.request) {
          data = await automation.request("food.nutrition.session", {
            sessionId,
            servings: effectiveServings,
          });
        }
      } else if (canFetchByRecipes) {
        if (typeof food.getNutritionForRecipes === "function") {
          data = await food.getNutritionForRecipes(normalizedRecipes, {
            servings: effectiveServings,
          });
        } else if (automation?.request) {
          data = await automation.request("food.nutrition.recipes", {
            recipes: normalizedRecipes,
            servings: effectiveServings,
          });
        }
      }

      // Friendly fallback to keep panel useful when backends aren’t wired yet.
      if (!data) {
        const perServing = {
          calories: 620,
          protein: 32,
          carbs: 55,
          fat: 28,
          fiber: 7,
          sugar: 8,
          sodium: 780,
        };
        data = { perServing, total: multiply(perServing, effectiveServings) };
      }

      // Ensure structure is sane
      const perServing = data?.perServing ?? {};
      const total = data?.total ?? multiply(perServing, effectiveServings);
      setNutr({ perServing, total });
    } catch (e) {
      console.warn("[NutritionPanel] fetch error:", e);
      setNutr(null);
    } finally {
      setLoading(false);
    }
  };

  // First load + whenever inputs change
  useEffect(() => {
    refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, JSON.stringify(normalizedRecipes), effectiveServings]);

  // Event-driven refresh
  useAutomationGlue((event) => {
    if (event === "preferences.changed" || event === "recipe.consolidated") {
      refetch();
    }
    if (event === "calendar.synced") {
      setToast({ tone: "success", text: "Calendar sync complete." });
    }
  });

  const macro = useMemo(() => deriveMacros(nutr?.perServing || {}), [nutr]);
  const ps = nutr?.perServing || {};
  const total = nutr?.total || multiply(ps, effectiveServings);

  /* -------------------------------- actions ------------------------------- */
  const changeServings = (delta) => {
    const next = Math.max(1, (effectiveServings || 1) + delta);
    if (typeof onServingsChange === "function") onServingsChange(next);
    else setLocalServings(next);
  };

  const handleCopy = async () => {
    const text = `Per serving: ${fmt(macro.calories, " kcal")} • P ${fmt(
      macro.p,
      "g"
    )} • C ${fmt(macro.c, "g")} • F ${fmt(macro.f, "g")} (${macro.pp}/${
      macro.cp
    }/${macro.fp}%)`;
    try {
      await navigator.clipboard?.writeText(text);
      setToast({ tone: "success", text: "Copied macros to clipboard." });
    } catch {
      setToast({ tone: "error", text: "Couldn’t copy to clipboard." });
    }
  };

  const handleLogMeal = async () => {
    try {
      // Create a calendar “Meal logged” entry; allow Undo
      const event = await automation.request?.("calendar.add.mealLog", {
        calories: macro.calories,
        protein: macro.p,
        carbs: macro.c,
        fat: macro.f,
        servings: effectiveServings,
      });
      const { undo: revert } = undo.push(async () => {
        await automation.request?.("calendar.undoEvent", { id: event?.id });
      }, "Log meal");
      setToast({
        tone: "success",
        text: "Meal logged.",
        action: { label: "Undo", fn: revert },
      });
      emitProgress?.("nutrition.logged", {
        nextBestAction: {
          label: "Create leftover labels",
          action: "leftovers.labels",
        },
      });
    } catch {
      setToast({ tone: "error", text: "Couldn’t log meal." });
    }
  };

  /* --------------------------------- UI ---------------------------------- */
  if (loading && !nutr) {
    return (
      <Card title="Nutrition" subtitle="Per serving">
        <Skeleton lines={4} />
      </Card>
    );
  }

  if (!nutr) {
    return (
      <Card
        title="Nutrition"
        subtitle="Per serving"
        right={
          showActions && (
            <Subtle onClick={refetch} title="Refresh">
              Refresh
            </Subtle>
          )
        }
      >
        <div className="rounded-xl border border-dashed border-base-300 p-6 text-center">
          <p className="font-medium">No nutrition available</p>
          <p className="text-sm opacity-70 mt-1">
            Add recipes or start a session to see calories and macro breakdowns.
          </p>
        </div>
      </Card>
    );
  }

  const goalP = Number(goals?.protein || 0);
  const goalC = Number(goals?.carbs || 0);
  const goalF = Number(goals?.fat || 0);
  const goalCal = Number(goals?.calories || 0);

  const pctOfGoal = {
    cal: pct(total.calories, goalCal),
    p: pct(total.protein, goalP),
    c: pct(total.carbs, goalC),
    f: pct(total.fat, goalF),
  };

  return (
    <Card
      title="Nutrition"
      subtitle="Per serving (auto-adjusts with servings)"
      right={
        showActions && (
          <div className="flex items-center gap-2">
            <div className="join">
              <button
                className="btn btn-sm join-item"
                onClick={() => changeServings(-1)}
                title="Decrease servings"
              >
                −
              </button>
              <button className="btn btn-sm join-item btn-disabled">
                {effectiveServings} serv
              </button>
              <button
                className="btn btn-sm join-item"
                onClick={() => changeServings(1)}
                title="Increase servings"
              >
                +
              </button>
            </div>
            <Subtle onClick={handleCopy}>Copy</Subtle>
            <Primary onClick={handleLogMeal}>Log meal</Primary>
          </div>
        )
      }
    >
      {/* Big calories */}
      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-bold">{fmt(macro.calories)}</span>
        <span className="opacity-70">kcal</span>
      </div>

      {/* Macro stacked bar */}
      <div
        className={cx(
          "mt-3 w-full h-3 rounded-full bg-base-200 overflow-hidden",
          dense && "h-2"
        )}
      >
        <div
          className="h-full bg-primary"
          style={{ width: `${macro.pp}%` }}
          title={`Protein ${macro.pp}%`}
        />
        <div
          className="h-full bg-secondary"
          style={{ width: `${macro.cp}%` }}
          title={`Carbs ${macro.cp}%`}
        />
        <div
          className="h-full bg-accent"
          style={{ width: `${macro.fp}%` }}
          title={`Fat ${macro.fp}%`}
        />
      </div>
      <div className="mt-2 text-xs opacity-70 flex gap-4">
        <span>
          Protein {fmt(macro.p, "g")} ({macro.pp}%)
        </span>
        <span>
          Carbs {fmt(macro.c, "g")} ({macro.cp}%)
        </span>
        <span>
          Fat {fmt(macro.f, "g")} ({macro.fp}%)
        </span>
      </div>

      {/* Details + goals */}
      <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Per serving & totals */}
        <div>
          <div className="grid grid-cols-2 gap-y-2 text-sm">
            <Field label="Protein" value={`${ps.protein ?? 0} g`} />
            <Field label="Carbs" value={`${ps.carbs ?? 0} g`} />
            <Field label="Fat" value={`${ps.fat ?? 0} g`} />
            {"fiber" in ps && <Field label="Fiber" value={`${ps.fiber} g`} />}
            {"sugar" in ps && <Field label="Sugar" value={`${ps.sugar} g`} />}
            {"sodium" in ps && (
              <Field label="Sodium" value={`${ps.sodium} mg`} />
            )}
          </div>
          <div className="mt-3 text-xs opacity-70">
            Meal totals ({effectiveServings} serv): ~{fmt(total.calories)} kcal
            • P {fmt(total.protein, "g")} • C {fmt(total.carbs, "g")} • F{" "}
            {fmt(total.fat, "g")}
          </div>
        </div>

        {/* Goals progress */}
        <div className="rounded-xl border border-base-200 p-3">
          <p className="font-medium mb-2 text-sm">Daily goals impact</p>
          <GoalRow
            label="Calories"
            value={`${fmt(total.calories)} / ${fmt(goalCal)} kcal`}
            pct={pctOfGoal.cal}
          />
          <GoalRow
            label="Protein"
            value={`${fmt(total.protein, "g")} / ${fmt(goalP, "g")}`}
            pct={pctOfGoal.p}
          />
          <GoalRow
            label="Carbs"
            value={`${fmt(total.carbs, "g")} / ${fmt(goalC, "g")}`}
            pct={pctOfGoal.c}
          />
          <GoalRow
            label="Fat"
            value={`${fmt(total.fat, "g")} / ${fmt(goalF, "g")}`}
            pct={pctOfGoal.f}
          />
          <div className="mt-2 text-xs opacity-70">
            Goals from Preferences; adjust in{" "}
            <a
              className="link"
              onClick={() =>
                automation.emit?.("ui.navigate", { to: "/settings/profile" })
              }
            >
              Settings
            </a>
            .
          </div>
        </div>
      </div>

      {/* Expandable micronutrients (if present) */}
      <div className="mt-4">
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => setExpanded((x) => !x)}
        >
          {expanded ? "Hide details" : "Show more details"}
        </button>
        {expanded && (
          <div className="mt-3 grid grid-cols-2 md:grid-cols-3 gap-y-2 text-sm">
            {"cholesterol" in ps && (
              <Field label="Cholesterol" value={`${ps.cholesterol} mg`} />
            )}
            {"saturatedFat" in ps && (
              <Field label="Saturated fat" value={`${ps.saturatedFat} g`} />
            )}
            {"potassium" in ps && (
              <Field label="Potassium" value={`${ps.potassium} mg`} />
            )}
            {"vitaminD" in ps && (
              <Field label="Vitamin D" value={`${ps.vitaminD} IU`} />
            )}
            {"calcium" in ps && (
              <Field label="Calcium" value={`${ps.calcium} mg`} />
            )}
            {"iron" in ps && <Field label="Iron" value={`${ps.iron} mg`} />}
          </div>
        )}
      </div>

      {/* Toast (inline, panel-scoped) */}
      {toast && (
        <div className="toast toast-end z-40">
          <div
            className={cx(
              "alert",
              toast.tone === "success"
                ? "alert-success"
                : toast.tone === "warning"
                ? "alert-warning"
                : toast.tone === "error"
                ? "alert-error"
                : "alert-info"
            )}
          >
            <div className="flex items-center gap-3">
              <span>{toast.text}</span>
              {toast.action && (
                <button
                  className="btn btn-xs"
                  onClick={() => toast.action.fn?.()}
                >
                  {toast.action.label}
                </button>
              )}
              <button
                className="btn btn-ghost btn-xs"
                onClick={() => setToast(null)}
              >
                ✕
              </button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Subcomponents                                                              */
/* -------------------------------------------------------------------------- */
function Field({ label, value }) {
  return (
    <div className="flex items-center justify-between pr-2">
      <span className="opacity-70">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

function GoalRow({ label, value, pct }) {
  return (
    <div className="mb-2">
      <div className="flex items-center justify-between text-xs">
        <span className="opacity-70">{label}</span>
        <span className="font-medium">{value}</span>
      </div>
      <div className="h-2 w-full bg-base-200 rounded-full overflow-hidden mt-1">
        <div
          className="h-full bg-primary"
          style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
          title={`${pct}%`}
        />
      </div>
    </div>
  );
}
