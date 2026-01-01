// src/components/meals/GroceryListPanel.jsx
import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { automation, emitProgress } from "@/services/automation/runtime";
import { sabbathGuard } from "@/services/guardrails/sabbathGuard";
import { classNames as cx } from "@/utils/css";
import { eventBus } from "@/services/events/eventBus"; // expected simple pub/sub
import NBAToolbar from "./NBAToolbar.jsx";             // your existing component
import UndoToast from "./UndoToast.jsx";               // your existing component

// Optional stores — component works even if these are not present yet.
let usePreferencesStore, useInventoryStore, useMealPlanStore, useRecipeStore;
try { usePreferencesStore = require("@/store/PreferencesStore").usePreferencesStore; } catch {}
try { useInventoryStore = require("@/store/InventoryStore").useInventoryStore; } catch {}
try { useMealPlanStore  = require("@/store/MealPlanStore").useMealPlanStore; } catch {}
try { useRecipeStore    = require("@/store/RecipeStore").useRecipeStore; } catch {}

/* ----------------------------------------------------------------------------
   Types & Helpers
---------------------------------------------------------------------------- */

/** Normalize an item */
function normItem(raw) {
  if (!raw) return null;
  const id = raw.id || `${raw.name || "item"}-${raw.unit || "ea"}-${raw.aisle || "?"}-${Math.random().toString(36).slice(2, 7)}`;
  return {
    id,
    name: (raw.name || "").trim(),
    qty: Number(raw.qty ?? 1),
    unit: raw.unit || "ea",
    category: raw.category || "Other",
    aisle: raw.aisle || "",
    store: raw.store || "Any",
    notes: raw.notes || "",
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    fromInventory: Boolean(raw.fromInventory), // flagged if we can cover using on-hand inventory
    purchased: Boolean(raw.purchased),
  };
}

/** Merge items with the same (name+unit+store) and sum qty */
function mergeLike(items) {
  const map = new Map();
  for (const it of items) {
    if (!it || !it.name) continue;
    const key = `${it.name}::${it.unit}::${it.store}`;
    if (!map.has(key)) map.set(key, { ...it });
    else map.get(key).qty += it.qty || 0;
  }
  return Array.from(map.values());
}

/** Compute needed list = meal requirements minus on-hand inventory */
function diffAgainstInventory(mealItems, inventory) {
  const invMap = new Map();
  for (const inv of inventory || []) {
    const key = `${(inv.name || "").toLowerCase()}::${inv.unit || "ea"}`;
    invMap.set(key, (invMap.get(key) || 0) + Number(inv.qty ?? 0));
  }
  return mealItems.map((m) => {
    const key = `${(m.name || "").toLowerCase()}::${m.unit || "ea"}`;
    const onHand = invMap.get(key) || 0;
    const needed = Math.max(0, Number(m.qty || 0) - onHand);
    return normItem({
      ...m,
      qty: needed,
      fromInventory: onHand > 0 && needed === 0,
    });
  }).filter(Boolean);
}

/** Basic category sort weight */
const CAT_WEIGHT = {
  Produce: 1, Meat: 2, Seafood: 3, Dairy: 4, Bakery: 5, Pantry: 6,
  Frozen: 7, Beverages: 8, Household: 9, Other: 10,
};

/* ----------------------------------------------------------------------------
   Main Component
---------------------------------------------------------------------------- */

export default function GroceryListPanel({
  weekStartDate,                  // optional: anchor the active week
  planId,                         // optional: a specific plan to pull from
  compact = false,                // toggles denser layout
  defaultGrouping = "category",   // "category" | "aisle" | "store" | "none"
}) {
  // Stores (fallbacks if not present)
  const prefs = usePreferencesStore?.() || {};
  const inv   = useInventoryStore?.() || { items: [], decrementMany: () => {}, incrementMany: () => {} };
  const meal  = useMealPlanStore?.()  || { activeWeek: null, getWeekPlan: () => null, selectedRecipes: [], planItems: [] };
  const recipes = useRecipeStore?.()  || { getByIds: () => [], findIngredientsForPlan: () => [] };

  const [groupBy, setGroupBy] = useState(defaultGrouping);
  const [filter, setFilter]   = useState("");
  const [storeFilter, setStoreFilter] = useState("Any");
  const [showOnlyNeeded, setShowOnlyNeeded] = useState(true); // hide fully covered by inventory
  const [list, setList] = useState([]);          // canonical grocery list
  const [selected, setSelected] = useState(new Set()); // selected item ids
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);      // { message, actionLabel, onUndo }

  const lastActionRef = useRef(null); // for undo payloads

  /* --------------------------------------------
     Derive meal-required items from plan/recipes
  -------------------------------------------- */
  const requiredItems = useMemo(() => {
    // Prefer MealPlanStore.planItems if it exists; otherwise derive from selected recipes
    const plan = planId
      ? meal.getWeekPlan?.(planId) || meal.activeWeek || {}
      : meal.activeWeek || {};

    const planItems = Array.isArray(meal.planItems) && meal.planItems.length
      ? meal.planItems
      : deriveFromRecipes(meal.selectedRecipes, recipes);

    // Normalize and merge like items
    return mergeLike(planItems.map(normItem).filter(Boolean));
  }, [meal.activeWeek, meal.planItems, meal.selectedRecipes, planId, recipes]);

  /* --------------------------------------------
     Inventory-aware “needed” computation
  -------------------------------------------- */
  const inventoryItems = useMemo(() => (inv.items || []).map((i) => ({
    name: i.name, qty: Number(i.qty ?? 0), unit: i.unit || "ea", category: i.category || "Other",
  })), [inv.items]);

  const neededList = useMemo(() => {
    const diff = diffAgainstInventory(requiredItems, inventoryItems);
    const filtered = showOnlyNeeded ? diff.filter((d) => (d.qty || 0) > 0) : diff;
    const afterFilter = filter
      ? filtered.filter((i) => i.name.toLowerCase().includes(filter.toLowerCase()))
      : filtered;
    const afterStore = storeFilter && storeFilter !== "Any"
      ? afterFilter.filter((i) => (i.store || "Any") === storeFilter)
      : afterFilter;
    return mergeLike(afterStore);
  }, [requiredItems, inventoryItems, filter, showOnlyNeeded, storeFilter]);

  /* --------------------------------------------
     Load list (edit buffer mirrors neededList initially)
  -------------------------------------------- */
  useEffect(() => {
    setList(neededList);
    // reset selection if base list changes
    setSelected(new Set());
  }, [neededList]);

  /* --------------------------------------------
     Event glue: respond to plan/inventory changes
  -------------------------------------------- */
  useEffect(() => {
    const offA = eventBus?.on?.("mealPlan.updated", () => refresh("mealPlan.updated"));
    const offB = eventBus?.on?.("inventory.updated", () => refresh("inventory.updated"));
    const offC = eventBus?.on?.("preferences.changed", () => refresh("preferences.changed"));
    return () => { offA?.(); offB?.(); offC?.(); };
  }, []);

  const refresh = useCallback((reason) => {
    emitProgress?.("grocery.refresh", { reason, ts: Date.now() });
    // recomputation is memoized via deps; just tick state to re-render
    setList((prev) => [...prev]);
  }, []);

  /* --------------------------------------------
     Grouping & Sorting
  -------------------------------------------- */
  const grouped = useMemo(() => {
    if (groupBy === "none") {
      return [{ title: "All Items", items: sortItems(list, groupBy) }];
    }
    const groups = new Map();
    for (const it of list) {
      const key =
        groupBy === "category" ? (it.category || "Other") :
        groupBy === "aisle"    ? (it.aisle || "Unassigned") :
        groupBy === "store"    ? (it.store || "Any") :
        "All";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(it);
    }
    return Array.from(groups.entries()).sort((a, b) => {
      if (groupBy === "category") return (CAT_WEIGHT[a[0]] || 99) - (CAT_WEIGHT[b[0]] || 99);
      return a[0].localeCompare(b[0]);
    }).map(([title, items]) => ({ title, items: sortItems(items, groupBy) }));
  }, [list, groupBy]);

  function sortItems(items, mode) {
    const byName = (a, b) => a.name.localeCompare(b.name);
    const byCat  = (a, b) => (CAT_WEIGHT[a.category] || 99) - (CAT_WEIGHT[b.category] || 99) || byName(a, b);
    const byAisle= (a, b) => (a.aisle || "z").localeCompare(b.aisle || "z") || byName(a, b);
    const byStore= (a, b) => (a.store || "Any").localeCompare(b.store || "Any") || byName(a, b);
    if (mode === "category") return [...items].sort(byCat);
    if (mode === "aisle")    return [...items].sort(byAisle);
    if (mode === "store")    return [...items].sort(byStore);
    return [...items].sort(byName);
  }

  /* --------------------------------------------
     Editing
  -------------------------------------------- */
  const updateItem = useCallback((id, patch) => {
    setList((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }, []);
  const removeItem = useCallback((id) => {
    const prev = list.find((i) => i.id === id);
    setList((prevList) => prevList.filter((i) => i.id !== id));
    // enable undo
    setToast({
      message: `Removed “${prev?.name || "item"}”`,
      actionLabel: "Undo",
      onUndo: () => setList((curr) => [...curr, prev].sort((a, b) => a.name.localeCompare(b.name))),
    });
  }, [list]);

  const togglePurchased = useCallback((id) => {
    setList((prev) => prev.map((it) => (it.id === id ? { ...it, purchased: !it.purchased } : it)));
  }, []);

  /* --------------------------------------------
     Bulk actions
  -------------------------------------------- */
  const allIds = useMemo(() => new Set(list.map((i) => i.id)), [list]);

  const toggleSelect = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };
  const selectAll = () => setSelected(new Set(allIds));
  const clearSelection = () => setSelected(new Set());

  const markSelectedPurchased = () => {
    const ids = new Set(selected);
    setList((prev) => prev.map((it) => (ids.has(it.id) ? { ...it, purchased: true } : it)));
    setToast({ message: `Marked ${ids.size} item(s) as purchased` });
    clearSelection();
  };
  const removeSelected = () => {
    const removed = list.filter((it) => selected.has(it.id));
    setList((prev) => prev.filter((it) => !selected.has(it.id)));
    setToast({
      message: `Removed ${removed.length} item(s)`,
      actionLabel: "Undo",
      onUndo: () => setList((curr) => mergeLike([...curr, ...removed])),
    });
    clearSelection();
  };

  /* --------------------------------------------
     Inventory sync (decrement inventory after purchase)
  -------------------------------------------- */
  const commitPurchases = async () => {
    const purchased = list.filter((i) => i.purchased && (i.qty || 0) > 0);
    if (!purchased.length) return;
    setBusy(true);
    const fn = async () => {
      // decrementMany expects [{name, qty, unit}]
      await inv.decrementMany?.(purchased.map((i) => ({ name: i.name, qty: i.qty, unit: i.unit })));
      emitProgress?.("inventory.decrementMany", { count: purchased.length });
      setToast({ message: `Committed ${purchased.length} item(s) to inventory` });
      eventBus?.emit?.("inventory.updated", { reason: "purchases.committed" });
    };
    await sabbathGuard(fn)();
    setBusy(false);
  };

  /* --------------------------------------------
     Export & Send (hooks into automation runtime)
  -------------------------------------------- */
  const exportPDF = async () => {
    setBusy(true);
    const payload = {
      title: "Grocery List",
      generatedAt: new Date().toISOString(),
      groupBy,
      items: list.map(({ id, ...rest }) => rest),
    };
    lastActionRef.current = { type: "export.pdf", payload };
    await automation?.("export.pdf", payload);
    setBusy(false);
    setToast({ message: "Exported grocery list as PDF" });
  };

  const sendToEmail = async () => {
    setBusy(true);
    const payload = { subject: "Your Grocery List", items: list };
    lastActionRef.current = { type: "send.email", payload };
    await automation?.("send.email", payload);
    setBusy(false);
    setToast({ message: "Sent grocery list to your email" });
  };

  const sendToSMS = async () => {
    setBusy(true);
    const payload = { items: list };
    lastActionRef.current = { type: "send.sms", payload };
    await automation?.("send.sms", payload);
    setBusy(false);
    setToast({ message: "Texted grocery list to your phone" });
  };

  /* --------------------------------------------
     Next Best Action (contextual suggestions)
  -------------------------------------------- */
  const nbaActions = useMemo(() => {
    const hasItems = list.length > 0;
    return [
      {
        key: "autoGenerate",
        label: "Auto-generate from this week",
        tooltip: "Pull meals, compare to inventory, and build your list",
        onClick: () => refresh("nba.autoGenerate"),
        intent: "primary",
      },
      {
        key: "exportPdf",
        label: "Export PDF",
        onClick: exportPDF,
        disabled: !hasItems || busy,
      },
      {
        key: "sendSms",
        label: "Send to Mobile",
        onClick: sendToSMS,
        disabled: !hasItems || busy,
      },
      {
        key: "commit",
        label: "Commit Purchases → Inventory",
        onClick: commitPurchases,
        disabled: !list.some((i) => i.purchased) || busy,
      },
    ];
  }, [list, busy, refresh]);

  /* --------------------------------------------
     Render
  -------------------------------------------- */
  const stores = useMemo(() => {
    const uniq = new Set((list || []).map((i) => i.store || "Any"));
    return ["Any", ...Array.from(uniq).filter(Boolean)];
  }, [list]);

  const empty = !list.length;

  return (
    <div className={cx(
      "rounded-2xl border border-base-200 bg-base-100 shadow-md",
      compact ? "p-3" : "p-5"
    )}>
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <h2 className="text-xl font-semibold leading-tight">Grocery List</h2>
          <p className="text-sm text-base-content/70">
            Built from your meal plan and inventory. Edit, group, export, or send to your phone.
          </p>
        </div>
        <NBAToolbar actions={nbaActions} />
      </div>

      {/* Controls */}
      <div className={cx("flex flex-wrap items-center gap-2 mb-4", compact && "text-sm")}>
        <input
          type="text"
          placeholder="Filter items…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="input input-sm md:input-md input-bordered w-52"
        />
        <select
          value={groupBy}
          onChange={(e) => setGroupBy(e.target.value)}
          className="select select-sm md:select-md select-bordered"
          title="Group by"
        >
          <option value="category">Group: Category</option>
          <option value="aisle">Group: Aisle</option>
          <option value="store">Group: Store</option>
          <option value="none">Group: None</option>
        </select>
        <select
          value={storeFilter}
          onChange={(e) => setStoreFilter(e.target.value)}
          className="select select-sm md:select-md select-bordered"
          title="Filter by store"
        >
          {stores.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            className="toggle toggle-sm"
            checked={showOnlyNeeded}
            onChange={(e) => setShowOnlyNeeded(e.target.checked)}
          />
          <span className="text-sm">Hide inventory-covered</span>
        </label>

        <div className="ml-auto flex items-center gap-2">
          <button className="btn btn-ghost btn-sm" onClick={selectAll}>Select All</button>
          <button className="btn btn-ghost btn-sm" onClick={clearSelection}>Clear</button>
          <div className="divider divider-horizontal" />
          <button
            className="btn btn-outline btn-sm"
            onClick={markSelectedPurchased}
            disabled={!selected.size}
          >
            Mark Purchased
          </button>
          <button
            className="btn btn-outline btn-sm btn-error"
            onClick={removeSelected}
            disabled={!selected.size}
          >
            Remove
          </button>
        </div>
      </div>

      {/* Empty State */}
      {empty && (
        <EmptyState onGenerate={() => refresh("empty.generate")} />
      )}

      {/* Groups */}
      {!empty && (
        <div className="space-y-6">
          {grouped.map((g) => (
            <SectionCard key={g.title} title={g.title}>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {g.items.map((it) => (
                  <ItemRow
                    key={it.id}
                    item={it}
                    selected={selected.has(it.id)}
                    onToggleSelect={() => toggleSelect(it.id)}
                    onChange={updateItem}
                    onRemove={removeItem}
                    onTogglePurchased={togglePurchased}
                  />
                ))}
              </div>
            </SectionCard>
          ))}
        </div>
      )}

      {/* Footer Actions */}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm text-base-content/70">
          {list.length} item{list.length !== 1 ? "s" : ""} • {Array.from(selected).length} selected
        </div>
        <div className="flex items-center gap-2">
          <button className="btn btn-outline btn-sm" onClick={exportPDF} disabled={!list.length || busy}>
            Export PDF
          </button>
          <button className="btn btn-outline btn-sm" onClick={sendToEmail} disabled={!list.length || busy}>
            Send Email
          </button>
          <button className="btn btn-primary btn-sm" onClick={sendToSMS} disabled={!list.length || busy}>
            Send to Mobile
          </button>
        </div>
      </div>

      {/* Undo Toast */}
      {toast && (
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

/* ----------------------------------------------------------------------------
   Subcomponents
---------------------------------------------------------------------------- */

function ItemRow({ item, selected, onToggleSelect, onChange, onRemove, onTogglePurchased }) {
  const [editing, setEditing] = useState(false);
  const [temp, setTemp] = useState(item);

  useEffect(() => { setTemp(item); }, [item]);

  const commit = () => {
    onChange(item.id, {
      name: (temp.name || "").trim(),
      qty: Number(temp.qty || 0),
      unit: temp.unit || "ea",
      category: temp.category || "Other",
      aisle: temp.aisle || "",
      store: temp.store || "Any",
      notes: temp.notes || "",
    });
    setEditing(false);
  };

  return (
    <div className={cx(
      "rounded-xl border border-base-200 p-3 hover:border-base-300 transition bg-base-100/60",
      selected && "ring-2 ring-primary/40"
    )}>
      <div className="flex items-start gap-3">
        <input type="checkbox" className="checkbox checkbox-sm mt-1" checked={selected} onChange={onToggleSelect} />
        <div className="flex-1">
          <div className="flex items-center justify-between gap-2">
            {!editing ? (
              <div className="flex items-center gap-2">
                <button
                  className={cx("btn btn-xs", item.purchased ? "btn-success" : "btn-outline")}
                  onClick={() => onTogglePurchased(item.id)}
                  title={item.purchased ? "Purchased" : "Mark as purchased"}
                >
                  {item.purchased ? "✓" : "Buy"}
                </button>
                <div className="font-medium">
                  {item.name}
                  <span className="ml-1 text-sm text-base-content/70">• {item.qty} {item.unit}</span>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <input
                  className="input input-sm input-bordered w-44"
                  value={temp.name}
                  onChange={(e) => setTemp({ ...temp, name: e.target.value })}
                />
                <input
                  type="number"
                  className="input input-sm input-bordered w-20"
                  value={temp.qty}
                  onChange={(e) => setTemp({ ...temp, qty: e.target.value })}
                />
                <input
                  className="input input-sm input-bordered w-20"
                  value={temp.unit}
                  onChange={(e) => setTemp({ ...temp, unit: e.target.value })}
                />
              </div>
            )}

            <div className="flex items-center gap-1">
              {!editing ? (
                <>
                  {item.fromInventory && (
                    <span className="badge badge-soft">Covered by Inventory</span>
                  )}
                  <button className="btn btn-ghost btn-xs" onClick={() => setEditing(true)}>Edit</button>
                  <button className="btn btn-ghost btn-xs text-error" onClick={() => onRemove(item.id)}>Remove</button>
                </>
              ) : (
                <>
                  <button className="btn btn-primary btn-xs" onClick={commit}>Save</button>
                  <button className="btn btn-ghost btn-xs" onClick={() => { setTemp(item); setEditing(false); }}>Cancel</button>
                </>
              )}
            </div>
          </div>

          {/* Meta row */}
          <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
            {editing ? (
              <>
                <select
                  className="select select-sm select-bordered"
                  value={temp.category}
                  onChange={(e) => setTemp({ ...temp, category: e.target.value })}
                >
                  {["Produce","Meat","Seafood","Dairy","Bakery","Pantry","Frozen","Beverages","Household","Other"].map(c =>
                    <option key={c} value={c}>{c}</option>
                  )}
                </select>
                <input
                  className="input input-sm input-bordered"
                  placeholder="Aisle"
                  value={temp.aisle}
                  onChange={(e) => setTemp({ ...temp, aisle: e.target.value })}
                />
                <input
                  className="input input-sm input-bordered"
                  placeholder="Store"
                  value={temp.store}
                  onChange={(e) => setTemp({ ...temp, store: e.target.value })}
                />
                <input
                  className="input input-sm input-bordered col-span-2 md:col-span-1"
                  placeholder="Notes"
                  value={temp.notes}
                  onChange={(e) => setTemp({ ...temp, notes: e.target.value })}
                />
              </>
            ) : (
              <>
                <Field label="Category" value={item.category || "—"} />
                <Field label="Aisle" value={item.aisle || "—"} />
                <Field label="Store" value={item.store || "Any"} />
                <Field label="Notes" value={item.notes || "—"} />
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value }) {
  return (
    <div className="text-base-content/70">
      <span className="mr-1">{label}:</span>
      <span className="text-base-content/90">{value}</span>
    </div>
  );
}

function SectionCard({ title, children }) {
  return (
    <div className="rounded-xl border border-base-200 bg-base-100">
      <div className="px-3 py-2 border-b border-base-200">
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}

function EmptyState({ onGenerate }) {
  return (
    <div className="rounded-xl border border-dashed border-base-300 p-8 text-center bg-base-100">
      <div className="text-lg font-semibold">No items yet</div>
      <p className="text-sm text-base-content/70 mt-1">
        Generate a list from your meal plan, or add items manually in the planner.
      </p>
      <div className="mt-4 flex items-center justify-center gap-2">
        <button className="btn btn-primary btn-sm" onClick={onGenerate}>Auto-Generate</button>
        <button className="btn btn-outline btn-sm" onClick={() => { /* optional: open RecipePickerDrawer */ }}>
          Add from Recipes
        </button>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
   Derivers
---------------------------------------------------------------------------- */

function deriveFromRecipes(selectedRecipes, recipesStore) {
  if (!Array.isArray(selectedRecipes) || !selectedRecipes.length || !recipesStore?.getByIds) return [];
  const recs = recipesStore.getByIds(selectedRecipes);
  const flat = [];
  for (const r of recs) {
    const ings = (r?.ingredients || []).map((ing) => ({
      name: ing.name,
      qty: ing.qty,
      unit: ing.unit,
      category: ing.category || r.category || "Other",
      aisle: ing.aisle || "",
      store: ing.store || "Any",
      notes: (ing.notes || "").trim(),
      tags: ["fromRecipe"],
    }));
    flat.push(...ings);
  }
  return flat;
}
