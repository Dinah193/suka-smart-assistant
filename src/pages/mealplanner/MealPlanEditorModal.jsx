// src/pages/MealPlanning/MealPlanEditorModal.jsx
import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";

/**
 * MealPlanEditorModal — alias-safe, event-driven, undo-friendly
 * --------------------------------------------------------------
 * Purpose
 *  Inline modal editor for a single day's (or date range's) meal slots:
 *  Breakfast / Lunch / Dinner / Snack. Intended to be opened from Calendar
 *  Preview, Meal Cycle Planner, or Grocery List panels.
 *
 * Highlights
 *  - Alias-safe: runs without "@/..." by falling back to local stubs
 *  - Sabbath guard: blocks create/sync during hands-off windows
 *  - Slots editor with servings, notes, tags, and nutrition fields
 *  - Fast recipe search (local store if available; demo fallback)
 *  - Leftovers planning: mark yields & carry to future days
 *  - Undo (stack) + lightweight toasts
 *  - Emits events: `mealplan.day.updated`, `grocery.needs.updated`, `leftovers.generated`
 *  - Next Best Action: “Send ingredients to list”
 *
 * Props
 *  - open: boolean
 *  - date: Date | string (ISO) — primary date being edited
 *  - range?: { start: Date|string, end: Date|string }  // optional multi-day edit
 *  - initialDay?: { breakfast: [], lunch: [], dinner: [], snack: [] }
 *  - onClose: () => void
 *  - onSave?: (payload) => void
 *  - periodKey?: "week" | "2w" | "month" | "quarter" | "custom"
 */

const classNames = (...xs) => xs.filter(Boolean).join(" ");
const toISO = (d) => (typeof d === "string" ? d : d?.toISOString?.() || new Date().toISOString());

/* ------------------------------ UI kit (local) ------------------------------ */
function Button({ variant = "default", size = "md", className, children, ...props }) {
  const variants = {
    default: "bg-gray-900 text-white hover:bg-gray-800",
    outline: "border border-gray-300 hover:bg-gray-50",
    ghost: "hover:bg-gray-100",
    danger: "bg-red-600 text-white hover:bg-red-700",
    success: "bg-emerald-600 text-white hover:bg-emerald-700",
  };
  const sizes = { sm: "h-8 px-2 text-sm", md: "h-10 px-3 text-sm", icon: "h-9 w-9 p-0" };
  return (
    <button className={classNames("rounded-md transition-colors disabled:opacity-50", variants[variant], sizes[size], className)} {...props}>
      {children}
    </button>
  );
}
function Input(props) {
  return <input {...props} className={classNames("h-9 w-full rounded-md border border-gray-300 bg-white px-3 text-sm focus:outline-none", props.className)} />;
}
function TextArea(props) {
  return <textarea {...props} className={classNames("min-h-[72px] w-full rounded-md border border-gray-300 bg-white p-3 text-sm focus:outline-none", props.className)} />;
}
function Badge({ children, className }) {
  return <span className={classNames("inline-flex items-center rounded border border-gray-300 bg-gray-50 px-2 py-0.5 text-xs text-gray-700", className)}>{children}</span>;
}
function Pill({ children }) {
  return <span className="inline-flex items-center rounded-full border border-gray-300 bg-white px-2 py-0.5 text-[11px] text-gray-700">{children}</span>;
}

/* ---------------------------- Toast (lightweight) --------------------------- */
function useToast() {
  const [t, setT] = useState(null); // {type,msg,actionLabel,onAction}
  const push = (toast) => setT(toast);
  useEffect(() => {
    if (!t) return;
    const id = setTimeout(() => setT(null), 3000);
    return () => clearTimeout(id);
  }, [t]);
  const View = () =>
    t ? (
      <div
        className={classNames(
          "fixed bottom-4 right-4 z-50 max-w-sm rounded-md px-4 py-3 shadow",
          t.type === "success" && "bg-emerald-600 text-white",
          t.type === "warning" && "bg-yellow-600 text-white",
          t.type === "error" && "bg-red-600 text-white",
          t.type === "info" && "bg-gray-900 text-white"
        )}
      >
        <div className="text-sm">{t.msg}</div>
        {t.actionLabel && t.onAction && (
          <button onClick={t.onAction} className="mt-2 rounded border border-white/25 px-2 py-1 text-xs hover:bg-white/10">
            {t.actionLabel}
          </button>
        )}
      </div>
    ) : null;
  return { toast: push, ToastView: View };
}

/* -------------------------- Alias-safe soft imports ------------------------- */
let eventBus = { on: () => {}, off: () => {}, emit: () => {} };
try {
  const eb = require("@/services/events/eventBus");
  eventBus = eb?.emit ? eb : eventBus;
} catch {}

let PreferencesStore = {};
try {
  PreferencesStore = require("@/store/PreferencesStore");
} catch {}

let RecipeStore = {};
try {
  RecipeStore = require("@/store/RecipeStore");
} catch {}

let InventoryStore = {};
try {
  InventoryStore = require("@/store/InventoryStore");
} catch {}

/* ------------------------------- Sabbath guard ------------------------------ */
const sabbathGuard = () => {
  try {
    const prefs = PreferencesStore?.getPreferences?.() || {};
    const active = prefs?.torahProfile?.sabbath?.isActive;
    const handsOff = prefs?.torahProfile?.sabbath?.handsOffCooking === true;
    if (active && handsOff) return { ok: false, reason: "Sabbath hands-off is active." };
  } catch {}
  if (typeof window !== "undefined" && window.__SABBATH__) {
    return { ok: false, reason: "Sabbath period: actions paused." };
  }
  return { ok: true };
};

/* ------------------------------- Recipes (fast) ----------------------------- */
async function searchRecipesLocal(q) {
  // Try your store first
  try {
    const useStore = RecipeStore.default || RecipeStore.useRecipeStore;
    if (typeof useStore === "function") {
      const st = useStore.getState ? useStore.getState() : useStore();
      const all = st?.recipes || [];
      const norm = all.map((r) => ({
        id: r.id,
        title: r.name || r.title || "Recipe",
        kcal: r.nutrition?.kcal ?? r.kcal ?? null,
        protein: r.nutrition?.protein ?? null,
        carbs: r.nutrition?.carbs ?? null,
        fat: r.nutrition?.fat ?? null,
        tags: r.tags || [],
        ingredients: r.ingredients || [],
      }));
      if (!q) return norm.slice(0, 50);
      return norm.filter((r) => r.title.toLowerCase().includes(q.toLowerCase()) || r.tags?.some((t) => t.toLowerCase().includes(q.toLowerCase()))).slice(0, 50);
    }
  } catch {}
  // Fallback demo data if store not available
  const demo = [
    { id: "r1", title: "Oatmeal & Berries", kcal: 280, protein: 12, carbs: 38, fat: 5, tags: ["veg"], ingredients: [{ name: "Oats", qty: 1, unit: "cup" }, { name: "Berries", qty: 1, unit: "cup" }] },
    { id: "r2", title: "Chicken Salad", kcal: 330, protein: 30, carbs: 10, fat: 14, tags: ["gf"], ingredients: [{ name: "Chicken", qty: 200, unit: "g" }, { name: "Lettuce", qty: 1, unit: "head" }] },
    { id: "r3", title: "Lamb Doner Bowl", kcal: 520, protein: 34, carbs: 42, fat: 18, tags: ["fusion"], ingredients: [{ name: "Lamb", qty: 200, unit: "g" }, { name: "Rice", qty: 1, unit: "cup" }] },
    { id: "r4", title: "Greek Yogurt", kcal: 150, protein: 17, carbs: 8, fat: 4, tags: ["snack"], ingredients: [{ name: "Yogurt", qty: 1, unit: "cup" }] },
  ];
  if (!q) return demo;
  return demo.filter((r) => r.title.toLowerCase().includes(q.toLowerCase()) || r.tags?.some((t) => t.toLowerCase().includes(q.toLowerCase())));
}

/* --------------------------------- Helpers --------------------------------- */
const SLOT_META = [
  { key: "breakfast", label: "Breakfast", icon: "🍎" },
  { key: "lunch", label: "Lunch", icon: "🥪" },
  { key: "dinner", label: "Dinner", icon: "🍖" },
  { key: "snack", label: "Snack", icon: "🍪" },
];

const emptyDay = () => ({ breakfast: [], lunch: [], dinner: [], snack: [] });

/* ------------------------------ Main component ----------------------------- */
export default function MealPlanEditorModal({
  open,
  date,
  range,
  initialDay,
  onClose,
  onSave = () => {},
  periodKey = "week",
}) {
  const { toast, ToastView } = useToast();
  const guard = sabbathGuard();

  // Local working copy
  const [day, setDay] = useState(() => initialDay || emptyDay());
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [servings, setServings] = useState(4);
  const [notes, setNotes] = useState("");
  const [includeToGrocery, setIncludeToGrocery] = useState(true);
  const [yieldPortions, setYieldPortions] = useState(0); // leftovers yield
  const [yieldDays, setYieldDays] = useState(0); // spread across N future days
  const [undoStack, setUndoStack] = useState([]);
  const [loading, setLoading] = useState(false);

  // Load search results (debounced-ish)
  useEffect(() => {
    let alive = true;
    (async () => {
      const res = await searchRecipesLocal(query);
      if (!alive) return;
      setResults(res);
    })();
    return () => {
      alive = false;
    };
  }, [query]);

  // When initialDay changes (or modal opens), reset local copy
  useEffect(() => {
    if (!open) return;
    setDay(initialDay || emptyDay());
    setNotes("");
    setYieldPortions(0);
    setYieldDays(0);
    setUndoStack([]);
    setQuery("");
  }, [open, initialDay]);

  // Basic macros preview for the current day
  const macros = useMemo(() => {
    let p = 0, c = 0, f = 0, kcal = 0;
    Object.values(day).forEach((arr) =>
      arr.forEach((m) => {
        p += m.protein ?? 0;
        c += m.carbs ?? 0;
        f += m.fat ?? 0;
        kcal += m.kcal ?? 0;
      })
    );
    const total = p + c + f || 1;
    return { p: Math.round((p / total) * 100), c: Math.round((c / total) * 100), f: Math.round((f / total) * 100), kcal: Math.round(kcal) };
  }, [day]);

  const addMeal = (slotKey, recipe) => {
    const newMeal = {
      id: `m_${Math.random().toString(36).slice(2)}`,
      title: recipe.title,
      kcal: recipe.kcal ?? 0,
      protein: recipe.protein ?? 0,
      carbs: recipe.carbs ?? 0,
      fat: recipe.fat ?? 0,
      tags: recipe.tags || [],
      recipeId: recipe.id,
      servings,
    };
    const prev = structuredClone(day);
    const next = structuredClone(day);
    next[slotKey] = [...(next[slotKey] || []), newMeal];
    setDay(next);
    setUndoStack((s) => [...s, { type: "add", prev }]);
    toast({ type: "success", msg: `Added "${recipe.title}" to ${slotKey}.` });
  };

  const removeMeal = (slotKey, id) => {
    const prev = structuredClone(day);
    const next = structuredClone(day);
    next[slotKey] = (next[slotKey] || []).filter((m) => m.id !== id);
    setDay(next);
    setUndoStack((s) => [...s, { type: "remove", prev }]);
  };

  const updateMeal = (slotKey, id, patch) => {
    const prev = structuredClone(day);
    const next = structuredClone(day);
    next[slotKey] = (next[slotKey] || []).map((m) => (m.id === id ? { ...m, ...patch } : m));
    setDay(next);
    setUndoStack((s) => [...s, { type: "update", prev }]);
  };

  const undo = () => {
    const last = undoStack[undoStack.length - 1];
    if (!last) return;
    setUndoStack((s) => s.slice(0, -1));
    setDay(last.prev);
    toast({ type: "info", msg: "Undone." });
  };

  const sendNeedsToGrocery = () => {
    if (!includeToGrocery) return;
    const items = [];
    // Aggregate minimal ingredients if present on recipes
    Object.values(day).forEach((arr) =>
      arr.forEach((m) => {
        (m.ingredients || []).forEach((i) => {
          items.push({
            name: i.name || "Item",
            qty: i.qty ?? 1,
            unit: i.unit || "",
          });
        });
      })
    );
    if (!items.length) {
      toast({ type: "info", msg: "No ingredient data available to send." });
      return;
    }
    eventBus.emit("grocery.needs.updated", {
      at: toISO(new Date()),
      from: "MealPlanEditor",
      date: toISO(date),
      items,
      periodKey,
    });
    toast({ type: "success", msg: "Sent to grocery list." });
  };

  const createLeftovers = () => {
    if (!yieldPortions || !yieldDays) {
      toast({ type: "info", msg: "Set yield portions and days." });
      return;
    }
    eventBus.emit("leftovers.generated", {
      at: toISO(new Date()),
      sourceDate: toISO(date),
      portions: yieldPortions,
      days: yieldDays,
    });
    toast({ type: "success", msg: `Leftovers will populate for ${yieldDays} day(s).` });
  };

  const save = async () => {
    if (!open) return;
    if (!sabbathGuard().ok) {
      toast({ type: "warning", msg: "Sabbath hands-off is active. Save paused." });
      return;
    }
    try {
      setLoading(true);
      const payload = { date: toISO(date), range: range ? { start: toISO(range.start), end: toISO(range.end) } : null, day, notes, periodKey };
      onSave?.(payload);
      eventBus.emit("mealplan.day.updated", payload);
      sendNeedsToGrocery();
      setTimeout(() => onClose?.(), 10);
    } finally {
      setLoading(false);
    }
  };

  if (!open) return null;

  /* ------------------------------- Render ----------------------------------- */
  return (
    <>
      <ToastView />
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-3">
        <div className="w-full max-w-5xl rounded-xl border bg-white shadow-2xl">
          {/* Header */}
          <div className="flex items-center justify-between border-b px-4 py-3">
            <div className="flex items-center gap-2">
              <div className="h-5 w-5 rounded bg-gray-900" />
              <div className="text-sm font-semibold">Edit Meal Plan</div>
              <Badge>{new Date(date).toLocaleDateString()}</Badge>
              {range?.start && range?.end && (
                <Badge className="ml-1">
                  {new Date(range.start).toLocaleDateString()} – {new Date(range.end).toLocaleDateString()}
                </Badge>
              )}
              {!guard.ok && <Badge className="border-violet-300 bg-violet-50 text-violet-900">Sabbath: hands-off</Badge>}
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={undo} disabled={!undoStack.length}>
                Undo
              </Button>
              <Button variant="ghost" onClick={onClose}>Close</Button>
              <Button variant="success" onClick={save} disabled={loading}>{loading ? "Saving…" : "Save changes"}</Button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-12">
            {/* Left: slot editor */}
            <div className="md:col-span-7 space-y-3">
              {SLOT_META.map(({ key, label, icon }) => {
                const items = day[key] || [];
                return (
                  <div key={key} className="rounded-xl border">
                    <div className="flex items-center justify-between border-b px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span>{icon}</span>
                        <span className="text-sm font-semibold">{label}</span>
                        <Pill>{items.length} item(s)</Pill>
                      </div>
                      <div className="flex items-center gap-2">
                        <label className="hidden items-center gap-1 text-xs md:flex">
                          <span>Servings</span>
                          <input
                            type="number"
                            min={1}
                            value={servings}
                            className="h-7 w-16 rounded border border-gray-300 px-2 text-xs"
                            onChange={(e) => setServings(Math.max(1, Number(e.target.value || 1)))}
                          />
                        </label>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            if (!results.length) {
                              toast({ type: "info", msg: "Search or pick from results on the right." });
                              return;
                            }
                            addMeal(key, results[0]);
                          }}
                        >
                          + Quick add top result
                        </Button>
                      </div>
                    </div>

                    <div className="p-3">
                      {!items.length ? (
                        <div className="rounded border border-dashed p-3 text-xs text-gray-600">
                          Empty — search on the right and click <strong>Add</strong>, or use “Quick add”.
                        </div>
                      ) : (
                        <ul className="space-y-2">
                          {items.map((m) => (
                            <li key={m.id} className="rounded-lg border p-2">
                              <div className="flex items-start justify-between gap-2">
                                <div>
                                  <div className="text-sm font-medium">{m.title}</div>
                                  <div className="text-[11px] text-gray-500">
                                    {m.kcal ? `${m.kcal} kcal` : "—"} • P{m.protein ?? 0}/C{m.carbs ?? 0}/F{m.fat ?? 0} • {m.tags?.join(" · ")}
                                  </div>
                                </div>
                                <div className="flex items-center gap-2">
                                  <input
                                    type="number"
                                    min={1}
                                    value={m.servings ?? 1}
                                    className="h-8 w-16 rounded border border-gray-300 px-2 text-xs"
                                    title="Servings"
                                    onChange={(e) => updateMeal(key, m.id, { servings: Math.max(1, Number(e.target.value || 1)) })}
                                  />
                                  <Button variant="ghost" size="sm" onClick={() => removeMeal(key, m.id)}>
                                    Remove
                                  </Button>
                                </div>
                              </div>
                              <div className="mt-2">
                                <TextArea
                                  placeholder="Notes (e.g., no onions, double batch…) "
                                  value={m._notes || ""}
                                  onChange={(e) => updateMeal(key, m.id, { _notes: e.target.value })}
                                />
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Right: search, macros, actions */}
            <div className="md:col-span-5 space-y-3">
              <div className="rounded-xl border">
                <div className="flex items-center justify-between border-b px-3 py-2">
                  <div className="text-sm font-semibold">Find a recipe</div>
                  <Button size="sm" variant="outline" onClick={() => setQuery("")}>Clear</Button>
                </div>
                <div className="p-3">
                  <Input placeholder="Search recipes or tags…" value={query} onChange={(e) => setQuery(e.target.value)} />
                </div>
                <ul className="max-h-[320px] space-y-2 overflow-auto p-3 pt-0">
                  {results.map((r) => (
                    <li key={r.id} className="rounded-lg border p-2">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="text-sm font-medium">{r.title}</div>
                          <div className="text-[11px] text-gray-500">
                            {r.kcal ? `${r.kcal} kcal` : "—"} • P{r.protein ?? 0}/C{r.carbs ?? 0}/F{r.fat ?? 0} • {r.tags?.join(" · ")}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button size="sm" variant="outline" onClick={() => addMeal("breakfast", r)}>+ Breakfast</Button>
                          <Button size="sm" variant="outline" onClick={() => addMeal("lunch", r)}>+ Lunch</Button>
                          <Button size="sm" variant="outline" onClick={() => addMeal("dinner", r)}>+ Dinner</Button>
                          <Button size="sm" variant="outline" onClick={() => addMeal("snack", r)}>+ Snack</Button>
                        </div>
                      </div>
                    </li>
                  ))}
                  {results.length === 0 && <li className="p-3 text-xs text-gray-600">No matches.</li>}
                </ul>
              </div>

              <div className="rounded-xl border">
                <div className="border-b px-3 py-2 text-sm font-semibold">Day nutrition</div>
                <div className="p-3">
                  <div className="mb-2 flex h-2 w-full overflow-hidden rounded bg-gray-200">
                    <div title={`Protein ${macros.p}%`} style={{ width: `${macros.p}%` }} className="bg-gray-900" />
                    <div title={`Carbs ${macros.c}%`} style={{ width: `${macros.c}%` }} className="bg-gray-500" />
                    <div title={`Fat ${macros.f}%`} style={{ width: `${macros.f}%` }} className="bg-gray-300" />
                  </div>
                  <div className="flex items-center justify-between text-xs text-gray-600">
                    <span>P {macros.p}% • C {macros.c}% • F {macros.f}%</span>
                    <span>{macros.kcal} kcal</span>
                  </div>
                </div>
              </div>

              <div className="rounded-xl border">
                <div className="border-b px-3 py-2 text-sm font-semibold">Notes & options</div>
                <div className="space-y-3 p-3">
                  <TextArea placeholder="Day notes (visible in calendar / share)…" value={notes} onChange={(e) => setNotes(e.target.value)} />
                  <label className="flex items-center gap-2 text-xs">
                    <input type="checkbox" checked={includeToGrocery} onChange={(e) => setIncludeToGrocery(e.target.checked)} />
                    Send needed ingredients to Grocery List on save
                  </label>
                  <div className="flex items-center gap-2 text-xs">
                    <span className="font-medium">Leftovers:</span>
                    <input type="number" min={0} value={yieldPortions} onChange={(e) => setYieldPortions(Math.max(0, Number(e.target.value || 0)))} className="h-8 w-16 rounded border border-gray-300 px-2" />
                    <span>portions over</span>
                    <input type="number" min={0} value={yieldDays} onChange={(e) => setYieldDays(Math.max(0, Number(e.target.value || 0)))} className="h-8 w-16 rounded border border-gray-300 px-2" />
                    <span>day(s)</span>
                    <Button size="sm" variant="outline" onClick={createLeftovers}>Schedule</Button>
                  </div>
                </div>
              </div>

              <div className="rounded-xl border bg-gray-50 p-3">
                <div className="flex items-center justify-between text-sm">
                  <div><span className="font-semibold">Next Best Action:</span> Send ingredients to list</div>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" onClick={sendNeedsToGrocery}>Send to list</Button>
                    <Button variant="outline" onClick={() => eventBus.emit("ui.open", { panel: "CalendarPreview" })}>Open calendar</Button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between border-t px-4 py-3">
            <div className="text-xs text-gray-500">
              Period: <span className="font-medium">{periodKey}</span> • Date: <span className="font-medium">{new Date(date).toDateString()}</span>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
              <Button variant="success" onClick={save} disabled={loading}>{loading ? "Saving…" : "Save changes"}</Button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/* ===========================
   Lightweight TESTS (dev only)
   =========================== */
(function runMealPlanEditorModalTestsOnce() {
  if (typeof window === "undefined") return;
  if (window.__MEAL_PLAN_EDITOR_MODAL_TESTS__) return;
  window.__MEAL_PLAN_EDITOR_MODAL_TESTS__ = true;

  const expect = (cond, msg) => (cond ? console.log("[MealPlanEditor TEST PASS]", msg) : console.error("[MealPlanEditor TEST FAIL]", msg));

  // Macros tally sanity
  const sampleDay = {
    breakfast: [{ protein: 10, carbs: 20, fat: 10, kcal: 240 }],
    lunch: [{ protein: 15, carbs: 10, fat: 10, kcal: 220 }],
    dinner: [{ protein: 25, carbs: 30, fat: 20, kcal: 500 }],
    snack: [],
  };
  let p = 0, c = 0, f = 0, kcal = 0;
  Object.values(sampleDay).forEach((arr) => arr.forEach((m) => { p += m.protein; c += m.carbs; f += m.fat; kcal += m.kcal; }));
  const total = p + c + f;
  const P = Math.round((p / total) * 100), C = Math.round((c / total) * 100), F = Math.round((f / total) * 100);
  expect(P + C + F >= 99 && P + C + F <= 101, "Macros percentages sum to ~100");
  expect(kcal === 960, "Calories aggregate correctly");
})();
