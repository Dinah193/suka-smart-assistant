// src/components/meals/MealDayCard.jsx
import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { sabbathGuard } from "@/services/guardrails/sabbathGuard";
import { automation, emitProgress } from "@/services/automation/runtime";
import { classNames as cx } from "@/utils/css";
import { eventBus } from "@/services/events/eventBus";

let TargetsBadge, NBAToolbar, MealSlot, UndoToast, RecipePickerDrawer;
try { TargetsBadge = require("./TargetsBadge.jsx").default; } catch {}
try { NBAToolbar  = require("./NBAToolbar.jsx").default; } catch {}
try { MealSlot     = require("./MealSlot.jsx").default; } catch {}
try { UndoToast    = require("./UndoToast.jsx").default; } catch {}
try { RecipePickerDrawer = require("./RecipePickerDrawer.jsx").default; } catch {}

// Optional stores (component works fine without them)
let useFoodStore, usePreferencesStore, useMealPlanStore, useRecipeStore;
try { useFoodStore = require("@/store/FoodStore").useFoodStore; } catch {}
try { usePreferencesStore = require("@/store/PreferencesStore").usePreferencesStore; } catch {}
try { useMealPlanStore = require("@/store/MealPlanStore").useMealPlanStore; } catch {}
try { useRecipeStore = require("@/store/RecipeStore").useRecipeStore; } catch {}

/**
 * MealDayCard
 * - Shows a single day's meals in 4 slots (Breakfast/Lunch/Dinner/Snack).
 * - Drag & drop recipes between slots and across days.
 * - Inline add/remove/duplicate/swap; Undo remove.
 * - Macro totals vs. goals using TargetsBadge and progress bars.
 * - NBA toolbar for "Auto-fill day", "Balance macros", and "Copy from..."
 */
export default function MealDayCard({
  date,                 // JS Date or ISO string
  dayKey,               // stable id for this day (e.g., '2025-10-11')
  slots = ["Breakfast", "Lunch", "Dinner", "Snack"],
  itemsBySlot = {},     // { Breakfast:[recipeRef], Lunch:[], ... }
  mode = "auto",        // "auto" | "manual"
  editable = true,      // allow interactions
  compact = false,      // denser UI
  onRequestEdit,        // optional callback to open day editor
  onChangeDay,          // (patch) external notify
}) {
  const prefs = usePreferencesStore?.() || {};
  const food  = useFoodStore?.() || {};
  const meal  = useMealPlanStore?.() || {};
  const recipesStore = useRecipeStore?.();

  const [openPickerSlot, setOpenPickerSlot] = useState(null);
  const [toast, setToast] = useState(null);
  const [busy, setBusy] = useState(false);

  // Internal state mirror so we can optimistically update with undo support.
  const [slotsState, setSlotsState] = useState(() => seedSlots(slots, itemsBySlot));
  useEffect(() => setSlotsState(seedSlots(slots, itemsBySlot)), [slots, itemsBySlot]);

  // Respond to external updates
  useEffect(() => {
    const offA = eventBus?.on?.("mealPlan.updated", (e) => {
      if (!e || e.dayKey === dayKey || e.scope === "all") {
        setSlotsState(seedSlots(slots, itemsBySlot));
      }
    });
    const offB = eventBus?.on?.("preferences.changed", () => forceRerender());
    return () => { offA?.(); offB?.(); };
  }, [dayKey, slots, itemsBySlot]);

  const forceRerender = () => setSlotsState((prev) => ({ ...prev }));

  // Derived: All recipe IDs for this day
  const allRecipeRefs = useMemo(() => {
    const out = [];
    for (const s of slots) out.push(...(slotsState[s] || []));
    return out;
  }, [slotsState, slots]);

  // Derived: nutrition totals for the day
  const totals = useMemo(() => sumNutrition(allRecipeRefs, recipesStore), [allRecipeRefs, recipesStore]);

  // Goals (USDA defaults from prefs/food stores; fallback numbers)
  const goals = useMemo(() => {
    const g = prefs?.nutritionGoals || food?.goals || {};
    return {
      calories: safeNum(g.calories, 2000),
      protein: safeNum(g.protein, 75),
      carbs: safeNum(g.carbs, 250),
      fat: safeNum(g.fat, 70),
      // percentages (macro split) for badges
      macroPct: {
        protein: clampPct(g.macroPct?.protein ?? 25),
        carbs: clampPct(g.macroPct?.carbs ?? 45),
        fat: clampPct(g.macroPct?.fat ?? 30),
      },
    };
  }, [prefs?.nutritionGoals, food?.goals]);

  const macroPctActual = useMemo(() => {
    const { protein, carbs, fat } = totals;
    const calFromProtein = protein * 4;
    const calFromCarbs   = carbs * 4;
    const calFromFat     = fat * 9;
    const denom = Math.max(1, calFromProtein + calFromCarbs + calFromFat);
    return {
      protein: Math.round((calFromProtein / denom) * 100),
      carbs:   Math.round((calFromCarbs   / denom) * 100),
      fat:     Math.round((calFromFat     / denom) * 100),
    };
  }, [totals]);

  // NBA (Next Best Action) suggestions
  const nbaActions = useMemo(() => {
    return [
      {
        key: "autofill",
        label: "Auto-fill Day",
        tooltip: "Use preferences, inventory, and rhythm to fill this day",
        intent: "primary",
        onClick: () => runAutoFill(),
        disabled: !editable || busy,
      },
      {
        key: "balance",
        label: "Balance Macros",
        tooltip: "Suggest swaps to match your macro targets",
        onClick: () => runBalanceMacros(),
        disabled: !editable || busy || !allRecipeRefs.length,
      },
      {
        key: "copyPrev",
        label: "Copy From Previous",
        onClick: () => copyFromPrevious(),
        disabled: !editable || busy,
      },
    ];
  }, [editable, busy, allRecipeRefs]);

  // DnD handlers (simple HTML5)
  const dragPayloadRef = useRef(null);
  const onDragStart = (sourceSlot, idx, item) => (e) => {
    dragPayloadRef.current = { sourceSlot, idx, item, dayKey };
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", JSON.stringify({ t: "RECIPE_CARD", id: item.id }));
  };
  const onDragOver = (targetSlot) => (e) => {
    if (!editable) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };
  const onDrop = (targetSlot) => (e) => {
    if (!editable) return;
    e.preventDefault();
    const payload = dragPayloadRef.current;
    if (!payload) return;
    // Allow cross-day drops by emitting a bus event if dayKey differs.
    if (payload.dayKey !== dayKey) {
      eventBus?.emit?.("mealPlan.moveRecipe", { from: payload, to: { dayKey, targetSlot } });
      dragPayloadRef.current = null;
      return;
    }
    // Same-day move
    setSlotsState((prev) => {
      const next = cloneSlots(prev);
      const [moved] = next[payload.sourceSlot].splice(payload.idx, 1);
      if (moved) next[targetSlot].push(moved);
      return next;
    });
    emitDayChanged("recipe.moved");
    dragPayloadRef.current = null;
  };

  // Slot operations
  const addRecipeToSlot = (slot, recipe) => {
    setSlotsState((prev) => {
      const next = cloneSlots(prev);
      next[slot] = [...next[slot], recipe];
      return next;
    });
    emitDayChanged("recipe.added");
  };

  const removeRecipeFromSlot = (slot, idx) => {
    const removed = slotsState[slot]?.[idx];
    setSlotsState((prev) => {
      const next = cloneSlots(prev);
      next[slot].splice(idx, 1);
      return next;
    });
    setToast({
      message: `Removed “${removed?.title || "recipe"}” from ${slot}`,
      actionLabel: "Undo",
      onUndo: () => {
        setSlotsState((curr) => {
          const next = cloneSlots(curr);
          next[slot].splice(idx, 0, removed);
          return next;
        });
        emitDayChanged("undo.remove");
      },
    });
    emitDayChanged("recipe.removed");
  };

  const duplicateRecipeInSlot = (slot, idx) => {
    const item = slotsState[slot]?.[idx];
    if (!item) return;
    setSlotsState((prev) => {
      const next = cloneSlots(prev);
      next[slot].splice(idx + 1, 0, { ...item, id: `${item.id}-dup-${Date.now()}` });
      return next;
    });
    emitDayChanged("recipe.duplicated");
  };

  const swapRecipesBetweenSlots = (slotA, idxA, slotB, idxB) => {
    setSlotsState((prev) => {
      const next = cloneSlots(prev);
      const a = next[slotA][idxA];
      const b = next[slotB][idxB];
      next[slotA][idxA] = b;
      next[slotB][idxB] = a;
      return next;
    });
    emitDayChanged("recipe.swapped");
  };

  const clearSlot = (slot) => {
    const before = [...(slotsState[slot] || [])];
    setSlotsState((prev) => ({ ...prev, [slot]: [] }));
    setToast({
      message: `Cleared ${slot}`,
      actionLabel: "Undo",
      onUndo: () => {
        setSlotsState((curr) => ({ ...curr, [slot]: before }));
        emitDayChanged("undo.clearSlot");
      },
    });
    emitDayChanged("slot.cleared");
  };

  // Automations
  const runAutoFill = async () => {
    setBusy(true);
    const fn = async () => {
      const payload = { dayKey, date: asISO(date), slots: Object.keys(slotsState) };
      const result = await automation?.("meal.autofillDay", payload);
      if (Array.isArray(result?.slots)) {
        const next = {};
        for (const s of result.slots) next[s.name] = (s.items || []).map(mkRecipeRef);
        setSlotsState(next);
        emitDayChanged("autoFill.applied", next);
      }
      setBusy(false);
    };
    await sabbathGuard(fn)();
  };

  const runBalanceMacros = async () => {
    if (!allRecipeRefs.length) return;
    setBusy(true);
    const fn = async () => {
      const payload = {
        dayKey,
        current: serializeDay(slotsState),
        goals,
      };
      const result = await automation?.("meal.balanceMacros", payload);
      if (result?.patch) {
        applyDayPatch(result.patch);
        emitDayChanged("macros.balanced");
      }
      setBusy(false);
    };
    await sabbathGuard(fn)();
  };

  const copyFromPrevious = async () => {
    setBusy(true);
    const fn = async () => {
      const prev = await automation?.("meal.copyPreviousDay", { dayKey, date: asISO(date) });
      if (prev?.slots) {
        const next = {};
        for (const s of Object.keys(prev.slots)) next[s] = (prev.slots[s] || []).map(mkRecipeRef);
        setSlotsState(next);
        emitDayChanged("day.copied");
      }
      setBusy(false);
    };
    await sabbathGuard(fn)();
  };

  // Patch apply
  const applyDayPatch = (patch) => {
    setSlotsState((prev) => {
      const next = cloneSlots(prev);
      for (const [slot, items] of Object.entries(patch)) next[slot] = items.map(mkRecipeRef);
      return next;
    });
  };

  // Emit external change
  const emitDayChanged = (reason, data) => {
    const state = serializeDay(slotsState);
    onChangeDay?.({ dayKey, reason, state });
    eventBus?.emit?.("mealPlan.updated", { scope: "day", dayKey, reason, state, data });
    emitProgress?.("meal.day.changed", { dayKey, reason });
  };

  // Picker submit
  const handlePickRecipe = (slot, picked) => {
    if (!picked) return setOpenPickerSlot(null);
    addRecipeToSlot(slot, mkRecipeRef(picked));
    setOpenPickerSlot(null);
  };

  // UI
  const dayTitle = useMemo(() => formatDayTitle(date), [date]);

  return (
    <div className={cx(
      "rounded-2xl border border-base-200 bg-base-100 shadow-md",
      compact ? "p-3" : "p-5"
    )}>
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-semibold">{dayTitle}</h3>
            <ModeBadge mode={mode} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* Targets badge comparing actual macro % to goal % */}
            {TargetsBadge ? (
              <TargetsBadge actual={macroPctActual} target={goals.macroPct} />
            ) : (
              <FallbackTargets actual={macroPctActual} target={goals.macroPct} />
            )}
          </div>
        </div>

        {NBAToolbar && (
          <NBAToolbar actions={nbaActions} />
        )}
      </div>

      {/* Day totals vs goals */}
      <DayTotals totals={totals} goals={goals} />

      {/* Slots */}
      <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
        {slots.map((slotName) => (
          <SlotCard
            key={slotName}
            title={slotName}
            items={slotsState[slotName] || []}
            editable={editable}
            onAddClick={() => setOpenPickerSlot(slotName)}
            onClear={() => clearSlot(slotName)}
            onDragOver={onDragOver(slotName)}
            onDrop={onDrop(slotName)}
          >
            {(slotsState[slotName] || []).length === 0 ? (
              <EmptySlotHint />
            ) : (
              (slotsState[slotName] || []).map((item, idx) => (
                <MealItemRow
                  key={item.id}
                  item={item}
                  draggable={editable}
                  onDragStart={onDragStart(slotName, idx, item)}
                  onRemove={() => removeRecipeFromSlot(slotName, idx)}
                  onDuplicate={() => duplicateRecipeInSlot(slotName, idx)}
                />
              ))
            )}
          </SlotCard>
        ))}
      </div>

      {/* Drawer for adding recipes */}
      {RecipePickerDrawer && openPickerSlot && (
        <RecipePickerDrawer
          open={Boolean(openPickerSlot)}
          onClose={() => setOpenPickerSlot(null)}
          onSelect={(r) => handlePickRecipe(openPickerSlot, r)}
          defaultFilters={{ mealSlot: openPickerSlot }}
        />
      )}

      {/* Toast */}
      {UndoToast && toast && (
        <UndoToast
          message={toast.message}
          actionLabel={toast.actionLabel}
          onAction={() => { toast.onUndo?.(); setToast(null); }}
          onClose={() => setToast(null)}
        />
      )}
    </div>
  );
}

/* --------------------------------------------
 * Subcomponents
 * ------------------------------------------*/
function ModeBadge({ mode }) {
  const isAuto = mode === "auto";
  return (
    <span className={cx(
      "badge",
      isAuto ? "badge-info" : "badge-warning"
    )}>
      {isAuto ? "AUTO" : "MANUAL"}
    </span>
  );
}

function DayTotals({ totals, goals }) {
  const rows = [
    { key: "calories", label: "Calories", unit: "kcal" },
    { key: "protein",  label: "Protein",  unit: "g"   },
    { key: "carbs",    label: "Carbs",    unit: "g"   },
    { key: "fat",      label: "Fat",      unit: "g"   },
  ];
  return (
    <div className="mt-3 rounded-xl border border-base-200 p-3 bg-base-100/60">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {rows.map(r => {
          const val = Math.round(totals[r.key] || 0);
          const goal = Math.max(1, Math.round(goals[r.key] || 0));
          const pct = Math.min(100, Math.round((val / goal) * 100));
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

function SlotCard({ title, items, editable, onAddClick, onClear, onDragOver, onDrop, children }) {
  return (
    <div
      className="rounded-xl border border-base-200 bg-base-100 p-3"
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="font-semibold">{title}</div>
        {editable && (
          <div className="flex items-center gap-2">
            <button className="btn btn-ghost btn-xs" onClick={onAddClick}>Add</button>
            <button className="btn btn-ghost btn-xs text-error" onClick={onClear}>Clear</button>
          </div>
        )}
      </div>
      <div className="space-y-2 min-h-12">{children}</div>
    </div>
  );
}

function MealItemRow({ item, draggable, onDragStart, onRemove, onDuplicate }) {
  return (
    <div
      draggable={draggable}
      onDragStart={onDragStart}
      className="flex items-center justify-between gap-2 rounded-lg border border-base-200 p-2 bg-base-100/70"
      title={item?.title || item?.name}
    >
      <div className="flex items-center gap-2">
        {draggable && <span className="cursor-grab select-none">⋮⋮</span>}
        <div className="font-medium line-clamp-1">{item.title || item.name || "Recipe"}</div>
        {item.servings && <span className="badge badge-ghost">{item.servings} sv</span>}
      </div>
      <div className="flex items-center gap-1">
        <button className="btn btn-ghost btn-xs" onClick={onDuplicate} title="Duplicate">Copy</button>
        <button className="btn btn-ghost btn-xs text-error" onClick={onRemove} title="Remove">Remove</button>
      </div>
    </div>
  );
}

function FallbackTargets({ actual, target }) {
  const parts = [
    ["Protein", actual.protein, target.protein],
    ["Carbs", actual.carbs, target.carbs],
    ["Fat", actual.fat, target.fat],
  ];
  return (
    <div className="text-xs text-base-content/70 flex flex-wrap items-center gap-2">
      {parts.map(([k, a, t]) => (
        <span key={k} className="badge badge-ghost">
          {k}: {a}% / {t}%
        </span>
      ))}
    </div>
  );
}

function EmptySlotHint() {
  return (
    <div className="text-sm text-base-content/60 italic">
      No items. Click <span className="not-italic font-medium">Add</span> or drop a recipe here.
    </div>
  );
}

/* --------------------------------------------
 * Helpers
 * ------------------------------------------*/
function seedSlots(slots, itemsBySlot) {
  const out = {};
  for (const s of slots) out[s] = (itemsBySlot?.[s] || []).map(mkRecipeRef);
  return out;
}

function cloneSlots(slotsState) {
  const out = {};
  for (const [k, v] of Object.entries(slotsState)) out[k] = [...v];
  return out;
}

function mkRecipeRef(any) {
  if (!any) return { id: `recipe-${Math.random().toString(36).slice(2, 9)}`, title: "Recipe" };
  // Normalize common fields: id, title/name, servings, nutrition
  return {
    id: any.id || any._id || `recipe-${Math.random().toString(36).slice(2, 9)}`,
    title: any.title || any.name || "Recipe",
    servings: any.servings || any.yield || 1,
    nutrition: any.nutrition || any.macros || null, // {calories, protein, carbs, fat}
  };
}

function sumNutrition(refs, recipesStore) {
  let calories = 0, protein = 0, carbs = 0, fat = 0;
  for (const r of refs) {
    const full = resolveRecipe(r, recipesStore);
    const n = full?.nutrition || r.nutrition || null;
    if (!n) continue;
    calories += safeNum(n.calories, 0);
    protein  += safeNum(n.protein, 0);
    carbs    += safeNum(n.carbs, 0);
    fat      += safeNum(n.fat, 0);
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

function formatDayTitle(date) {
  try {
    const d = typeof date === "string" ? new Date(date) : date;
    return d?.toLocaleDateString?.(undefined, { weekday: "short", month: "short", day: "numeric" }) || "Day";
  } catch { return "Day"; }
}

function asISO(date) {
  try {
    const d = typeof date === "string" ? new Date(date) : date;
    return d?.toISOString?.() || "";
  } catch { return ""; }
}
