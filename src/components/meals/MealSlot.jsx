// src/components/meals/MealSlot.jsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { classNames as cx } from "@/utils/css";
import { sabbathGuard } from "@/services/guardrails/sabbathGuard";
import { automation, emitProgress } from "@/services/automation/runtime";
import { eventBus } from "@/services/events/eventBus";

let UndoToast, RecipePickerDrawer, NBAToolbar;
try { UndoToast = require("./UndoToast.jsx").default; } catch {}
try { RecipePickerDrawer = require("./RecipePickerDrawer.jsx").default; } catch {}
try { NBAToolbar = require("./NBAToolbar.jsx").default; } catch {}

// Optional stores; component works without them.
let useRecipeStore, usePreferencesStore, useFoodStore;
try { useRecipeStore = require("@/store/RecipeStore").useRecipeStore; } catch {}
try { usePreferencesStore = require("@/store/PreferencesStore").usePreferencesStore; } catch {}
try { useFoodStore = require("@/store/FoodStore").useFoodStore; } catch {}

export default function MealSlot({
  /* Identity */
  dayKey,                 // e.g. '2025-10-11'
  slotName = "Meal",      // e.g. 'Breakfast'

  /* Data */
  items = [],             // array of {id,title,servings,nutrition?}
  editable = true,
  compact = false,
  showMacros = true,

  /* DnD: you can pass external handlers or let internal handle it */
  onDragOver,             // (event) => void
  onDrop,                 // (event) => void

  /* Events outward */
  onItemsChange,          // (nextItems, reason) => void
}) {
  const prefs = usePreferencesStore?.() || {};
  const food  = useFoodStore?.() || {};
  const recipesStore = useRecipeStore?.();

  const [local, setLocal] = useState(() => items.map(mkRecipeRef));
  const [openPicker, setOpenPicker] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setLocal(items.map(mkRecipeRef)), [items]);

  const totals = useMemo(() => sumNutrition(local, recipesStore), [local, recipesStore]);

  const goals = useMemo(() => {
    const g = prefs?.nutritionGoals || food?.goals || {};
    return {
      calories: safeNum(g.calories, 2000),
      protein:  safeNum(g.protein,   75),
      carbs:    safeNum(g.carbs,    250),
      fat:      safeNum(g.fat,       70),
    };
  }, [prefs?.nutritionGoals, food?.goals]);

  /* ----------------------------
     DnD (internal default)
  -----------------------------*/
  const dragPayloadRef = useRef(null);
  const onDragStart = (idx, item) => (e) => {
    dragPayloadRef.current = { dayKey, slotName, idx, item };
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", JSON.stringify({ t: "RECIPE_CARD", id: item.id }));
  };
  const handleDragOver = (e) => {
    if (!editable) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    onDragOver?.(e);
  };
  const handleDrop = (e) => {
    if (!editable) return;
    e.preventDefault();
    // If another MealDayCard is handling cross-day, they'll emit an event. We only handle local drops here.
    const payload = dragPayloadRef.current;
    if (!payload || payload.dayKey !== dayKey || payload.slotName !== slotName) {
      onDrop?.(e);
      return;
    }
    dragPayloadRef.current = null;
  };

  /* ----------------------------
     CRUD actions
  -----------------------------*/
  const addItem = (recipe) => {
    const next = [...local, mkRecipeRef(recipe)];
    commit(next, "recipe.added");
  };

  const removeAt = (idx) => {
    const removed = local[idx];
    const next = [...local.slice(0, idx), ...local.slice(idx + 1)];
    commit(next, "recipe.removed");
    setToast({
      message: `Removed “${removed?.title || "recipe"}”`,
      actionLabel: "Undo",
      onUndo: () => commit([...local], "undo.remove"),
    });
  };

  const duplicateAt = (idx) => {
    const item = local[idx];
    if (!item) return;
    const clone = { ...item, id: `${item.id}-dup-${Date.now()}` };
    const next = [...local.slice(0, idx + 1), clone, ...local.slice(idx + 1)];
    commit(next, "recipe.duplicated");
  };

  const clearSlot = () => {
    if (!local.length) return;
    const snapshot = [...local];
    commit([], "slot.cleared");
    setToast({
      message: `Cleared ${slotName}`,
      actionLabel: "Undo",
      onUndo: () => commit(snapshot, "undo.clearSlot"),
    });
  };

  /* ----------------------------
     Automations (sabbath-guarded)
  -----------------------------*/
  const autoFill = async () => {
    setBusy(true);
    const fn = async () => {
      const result = await automation?.("meal.autofillSlot", { dayKey, slotName });
      if (Array.isArray(result?.items)) {
        const next = result.items.map(mkRecipeRef);
        commit(next, "autoFill.applied");
      }
      setBusy(false);
    };
    await sabbathGuard(fn)();
  };

  const balanceSlot = async () => {
    if (!local.length) return;
    setBusy(true);
    const fn = async () => {
      const result = await automation?.("meal.balanceSlot", {
        dayKey,
        slotName,
        current: local,
        goals,
      });
      if (Array.isArray(result?.items)) {
        commit(result.items.map(mkRecipeRef), "macros.balanced");
      }
      setBusy(false);
    };
    await sabbathGuard(fn)();
  };

  const nbaActions = useMemo(() => [
    { key: "autofill", label: "Auto-fill", intent: "primary", onClick: autoFill, disabled: busy || !editable },
    { key: "balance",  label: "Balance",    onClick: balanceSlot, disabled: busy || !editable || !local.length },
    { key: "clear",    label: "Clear",      onClick: clearSlot, disabled: !local.length || !editable },
  ], [busy, editable, local]);

  /* ----------------------------
     Commit helper
  -----------------------------*/
  const commit = (nextItems, reason) => {
    setLocal(nextItems);
    onItemsChange?.(nextItems, reason);
    eventBus?.emit?.("mealPlan.updated", { scope: "slot", dayKey, slotName, reason, items: nextItems });
    emitProgress?.("meal.slot.changed", { dayKey, slotName, reason });
  };

  /* ----------------------------
     UI
  -----------------------------*/
  const totalsRows = useMemo(() => ([
    { key: "calories", label: "kcal", value: Math.round(totals.calories || 0), goal: Math.max(1, Math.round(goals.calories || 0)) },
    { key: "protein",  label: "P",    value: Math.round(totals.protein  || 0), goal: Math.max(1, Math.round(goals.protein  || 0)) },
    { key: "carbs",    label: "C",    value: Math.round(totals.carbs    || 0), goal: Math.max(1, Math.round(goals.carbs    || 0)) },
    { key: "fat",      label: "F",    value: Math.round(totals.fat      || 0), goal: Math.max(1, Math.round(goals.fat      || 0)) },
  ]), [totals, goals]);

  // simple outside-click to close menu
  const menuRef = useRef(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  return (
    <div
      className={cx(
        "rounded-xl border border-base-200 bg-base-100 p-3",
        editable && "hover:border-base-300 transition-colors"
      )}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <div className="flex items-center justify-between">
        <div className="font-semibold">{slotName}</div>
        <div className="flex items-center gap-2">
          {NBAToolbar ? (
            <NBAToolbar actions={nbaActions} size="xs" />
          ) : (
            <>
              <button className="btn btn-ghost btn-xs" onClick={autoFill} disabled={busy || !editable}>Auto</button>
              <button className="btn btn-ghost btn-xs" onClick={balanceSlot} disabled={busy || !editable || !local.length}>Balance</button>
              <button className="btn btn-ghost btn-xs text-error" onClick={clearSlot} disabled={!local.length || !editable}>Clear</button>
            </>
          )}
          {editable && (
            <div className="relative" ref={menuRef}>
              <button className="btn btn-ghost btn-xs" onClick={() => setMenuOpen((v) => !v)} title="More">⋯</button>
              {menuOpen && (
                <div className="absolute right-0 mt-1 w-40 rounded-lg border border-base-200 bg-base-100 shadow-lg z-20">
                  <button className="w-full text-left px-3 py-2 hover:bg-base-200" onClick={() => { setOpenPicker(true); setMenuOpen(false); }}>
                    Add from recipes…
                  </button>
                  <button className="w-full text-left px-3 py-2 hover:bg-base-200" onClick={() => { autoFill(); setMenuOpen(false); }}>
                    Auto-fill suggestions
                  </button>
                  <button className="w-full text-left px-3 py-2 hover:bg-base-200" onClick={() => { balanceSlot(); setMenuOpen(false); }} disabled={!local.length}>
                    Balance macros
                  </button>
                  <div className="border-t border-base-200" />
                  <button className="w-full text-left px-3 py-2 text-error hover:bg-base-200" onClick={() => { clearSlot(); setMenuOpen(false); }} disabled={!local.length}>
                    Clear slot
                  </button>
                </div>
              )}
            </div>
          )}
          {editable && (
            <button className="btn btn-primary btn-xs" onClick={() => setOpenPicker(true)}>Add</button>
          )}
        </div>
      </div>

      {/* Empty state */}
      {!local.length && (
        <div className="mt-2 text-sm text-base-content/60 italic">
          No items. Click <span className="not-italic font-medium">Add</span>, use <span className="not-italic font-medium">Auto</span>, or drop a recipe here.
        </div>
      )}

      {/* Items */}
      <div className="mt-2 space-y-2">
        {local.map((item, idx) => (
          <MealItemRow
            key={item.id}
            item={item}
            draggable={editable}
            compact={compact}
            onDragStart={onDragStart(idx, item)}
            onDuplicate={() => duplicateAt(idx)}
            onRemove={() => removeAt(idx)}
            showMacros={showMacros}
            recipesStore={recipesStore}
          />
        ))}
      </div>

      {/* Slot macro mini-peek */}
      {showMacros && (
        <div className="mt-3">
          <MiniMacroStrip rows={totalsRows} compact={compact} />
        </div>
      )}

      {/* Picker Drawer */}
      {RecipePickerDrawer && openPicker && (
        <RecipePickerDrawer
          open={openPicker}
          onClose={() => setOpenPicker(false)}
          onSelect={(r) => { if (r) addItem(r); setOpenPicker(false); }}
          defaultFilters={{ mealSlot: slotName }}
        />
      )}

      {/* Undo */}
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
function MealItemRow({ item, draggable, compact, onDragStart, onDuplicate, onRemove, showMacros, recipesStore }) {
  const full = useMemo(() => resolveRecipe(item, recipesStore), [item, recipesStore]);
  const n = full?.nutrition || item?.nutrition || null;

  return (
    <div
      draggable={draggable}
      onDragStart={onDragStart}
      className={cx(
        "flex items-start justify-between gap-2 rounded-lg border border-base-200 p-2 bg-base-100/70",
        draggable && "cursor-grab"
      )}
      title={full?.title || full?.name}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          {draggable && <span className="select-none text-base-content/60">⋮⋮</span>}
          <div className="font-medium truncate">{full?.title || full?.name || "Recipe"}</div>
          {full?.servings ? <span className="badge badge-ghost">{full.servings} sv</span> : null}
        </div>
        {showMacros && n && (
          <div className={cx("mt-1 text-xs text-base-content/70", compact && "text-[11px]")}>
            {Math.round(n.calories || 0)} kcal • P{Math.round(n.protein || 0)} / C{Math.round(n.carbs || 0)} / F{Math.round(n.fat || 0)}
          </div>
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button className="btn btn-ghost btn-xs" onClick={onDuplicate} title="Duplicate">Copy</button>
        <button className="btn btn-ghost btn-xs text-error" onClick={onRemove} title="Remove">Remove</button>
      </div>
    </div>
  );
}

function MiniMacroStrip({ rows, compact }) {
  return (
    <div className="grid grid-cols-4 gap-2">
      {rows.map((r) => {
        const pct = Math.min(100, Math.round((r.value / r.goal) * 100));
        return (
          <div key={r.key}>
            <div className={cx("flex items-center justify-between mb-1 text-xs", compact && "text-[11px]")}>
              <span className="font-medium">{r.label}</span>
              <span className="text-base-content/70">{r.value}/{r.goal}</span>
            </div>
            <div className="w-full bg-base-200 rounded-full h-1.5 overflow-hidden">
              <div className="h-1.5 rounded-full bg-primary" style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* --------------------------------------------
 * Helpers
 * ------------------------------------------*/
function mkRecipeRef(any) {
  if (!any) return { id: `recipe-${Math.random().toString(36).slice(2, 9)}`, title: "Recipe" };
  return {
    id: any.id || any._id || `recipe-${Math.random().toString(36).slice(2, 9)}`,
    title: any.title || any.name || "Recipe",
    servings: any.servings || any.yield || 1,
    nutrition: any.nutrition || any.macros || null, // {calories, protein, carbs, fat}
  };
}

function resolveRecipe(ref, recipesStore) {
  if (!recipesStore?.getById || !ref?.id) return ref;
  return recipesStore.getById(ref.id) || ref;
}

function sumNutrition(refs, recipesStore) {
  let calories = 0, protein = 0, carbs = 0, fat = 0;
  for (const r of refs || []) {
    const full = resolveRecipe(r, recipesStore);
    const n = full?.nutrition || r?.nutrition || null;
    if (!n) continue;
    calories += safeNum(n.calories, 0);
    protein  += safeNum(n.protein, 0);
    carbs    += safeNum(n.carbs, 0);
    fat      += safeNum(n.fat, 0);
  }
  return { calories, protein, carbs, fat };
}

function safeNum(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
