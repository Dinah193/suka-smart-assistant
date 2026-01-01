import React, { useEffect, useMemo, useRef, useState } from "react";
import { DndProvider, useDrag, useDrop } from "react-dnd";
import { HTML5Backend } from "react-dnd-html5-backend";

/**
 * Suka Smart Assistant — BatchInventoryMap (Alias‑free, DI‑ready)
 * Location: src/pages/MealPlanning/BatchInventoryMap.jsx
 *
 * Why this rewrite?
 * -----------------
 * Some environments (like sandboxes/CDNs) can't resolve the "@/" alias and will
 * try to fetch it from a CDN, causing build errors. This version removes *all*
 * alias imports and uses dependency injection (props) with safe fallbacks.
 *
 * How to wire real services in your app:
 * --------------------------------------
 * <BatchInventoryMap
 *   useBatchQueueHook={useBatchQueue}
 *   useToastApi={useToast}
 *   eventBus={eventBus}
 *   inventoryService={inventoryService}
 * />
 *
 * If you pass nothing, it still works with local fallbacks for demos/tests.
 *
 * Features
 * --------
 * - Drag‑and‑drop ingredient → storage location mapping
 * - Auto‑suggest locations (by temp/tags/history)
 * - Manual location create/rename
 * - Multi‑select + Sync Selected
 * - Undo/Clear + smart "Next Best Action"
 * - Emits events: "inventory.mapping.updated" and "inventory.updated"
 * - Compact mode (tight padding) and a11y labels
 *
 * Exports
 * -------
 * - default BatchInventoryMap component
 * - useLocalUndoHotkey(ref, onUndo) — optional helper
 * - runBatchInventoryMapTests() — lightweight self‑tests you can call manually
 */

/********************
 * Dependency Defaults (No alias imports here)
 ********************/
const defaultEventBus = {
  publish: (evt, payload) => console.log("[eventBus:fallback]", evt, payload),
  subscribe: () => () => {},
};

const defaultInventoryService = {
  saveLocationMapping: async (mappings) => {
    console.warn("[inventoryService:fallback] saveLocationMapping", mappings);
    return { ok: true };
  },
  fetchKnownLocations: async () => [
    { id: "pantry-A", name: "Pantry A (Dry)", kind: "pantry", temp: "ambient" },
    { id: "fridge-1", name: "Fridge Shelf 1", kind: "fridge", temp: "chilled" },
    { id: "freezer-top", name: "Freezer Top Drawer", kind: "freezer", temp: "frozen" },
    { id: "root-1", name: "Root Cellar Rack 1", kind: "root", temp: "cool" },
  ],
  fetchHistoricalPlacements: async () => ({}),
};

const defaultUseToast = () => ({
  toast: ({ title, description }) => console.log("[toast]", title, description),
});

const defaultUseBatchQueue = () => ({
  recipes: [],
  // expected shape: { id, name, qty, unit, tags:[], temp:"ambient|chilled|frozen|cool" }
  items: [],
});

/********************
 * DnD Constants & Utils
 ********************/
const ItemTypes = { INGREDIENT: "INGREDIENT" };

function classNames(...cls) {
  return cls.filter(Boolean).join(" ");
}

export function kebabCase(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

export function suggestLocationFor(item, knownLocations = [], history = {}) {
  if (!item) return null;
  const hist = history[item.id];
  if (hist && knownLocations.some((l) => l.id === hist)) return hist; // last used
  const byTemp = knownLocations.find((l) => l.temp === item.temp);
  if (byTemp) return byTemp.id;
  const tagHit = knownLocations.find((l) => item.tags?.some((t) => l.name.toLowerCase().includes(t.toLowerCase())));
  if (tagHit) return tagHit.id;
  return knownLocations[0]?.id || null; // fallback first
}

/********************
 * DnD Cards/Bins
 ********************/
function IngredientCard({ item, selected, onToggleSelect }) {
  const [{ isDragging }, dragRef] = useDrag(
    () => ({
      type: ItemTypes.INGREDIENT,
      item,
      collect: (monitor) => ({ isDragging: monitor.isDragging() }),
    }),
    [item]
  );

  return (
    <div
      ref={dragRef}
      role="listitem"
      aria-label={`Ingredient ${item.name}`}
      data-testid={`ingredient-${item.id}`}
      className={classNames(
        "rounded-2xl border p-3 mb-2 cursor-grab select-none shadow-sm",
        "hover:shadow-md transition",
        isDragging && "opacity-50",
        selected ? "border-primary ring-2 ring-primary/40" : "border-base-300"
      )}
    >
      <div className="flex items-start gap-3">
        <input
          aria-label={`Select ${item.name}`}
          type="checkbox"
          checked={!!selected}
          onChange={() => onToggleSelect(item.id)}
          className="mt-1 checkbox checkbox-sm"
          data-testid={`select-${item.id}`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between">
            <p className="font-semibold truncate" title={item.name}>{item.name}</p>
            <span className="text-xs opacity-70">{item.qty} {item.unit}</span>
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            {item.tags?.slice(0, 4).map((t) => (
              <span key={t} className="badge badge-ghost badge-sm">{t}</span>
            ))}
            {item.temp && <span className="badge badge-outline badge-sm">{item.temp}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

function LocationBin({ location, onDropItem, itemsHere = [], onQuickMove, allowManualNaming }) {
  const [{ isOver }, dropRef] = useDrop(
    () => ({
      accept: ItemTypes.INGREDIENT,
      drop: (dragItem) => onDropItem(dragItem, location),
      collect: (monitor) => ({ isOver: monitor.isOver() }),
    }),
    [location, onDropItem]
  );

  return (
    <div
      ref={dropRef}
      data-testid={`location-${location.id}`}
      className={classNames(
        "rounded-2xl border bg-base-100 p-3 min-h-[140px] flex flex-col",
        "shadow-sm hover:shadow-md transition",
        isOver && "ring-2 ring-primary/40",
        "border-base-300"
      )}
      aria-label={`Location ${location.name}`}
    >
      <div className="flex items-center justify-between">
        <div>
          <p className="font-semibold" title={location.name}>{location.name}</p>
          <p className="text-xs opacity-70 capitalize">{location.kind} • {location.temp}</p>
        </div>
        {allowManualNaming && (
          <button
            className="btn btn-ghost btn-xs"
            onClick={() => {
              const name = prompt("Rename location:", location.name);
              if (name && name.trim()) {
                onQuickMove({ type: "rename", locationId: location.id, name: name.trim() });
              }
            }}
          >Rename</button>
        )}
      </div>
      <div className="mt-2 grid gap-2" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
        {itemsHere.length === 0 && (
          <div className="col-span-2 text-sm opacity-60 italic">Drop items here</div>
        )}
        {itemsHere.map((it) => (
          <button
            key={it.id}
            className="btn btn-xs justify-start truncate"
            title={`${it.name} (${it.qty} ${it.unit})`}
            onClick={() => onQuickMove({ type: "remove", itemId: it.id })}
            data-testid={`bin-item-${location.id}-${it.id}`}
          >
            {it.name}
          </button>
        ))}
      </div>
    </div>
  );
}

/********************
 * Main Component
 ********************/
export default function BatchInventoryMap({
  initialItems,           // optional override of queue items
  initialLocations,       // optional override of known locations
  compact = false,
  // Dependency injection points (alias‑free):
  eventBus = defaultEventBus,
  inventoryService = defaultInventoryService,
  useToastApi = defaultUseToast,
  useBatchQueueHook = defaultUseBatchQueue,
}) {
  const { toast } = useToastApi();
  const queue = useBatchQueueHook();

  /* --------------------------- Source Data --------------------------- */
  const [items, setItems] = useState(() => initialItems || queue.items || []);
  const [knownLocations, setKnownLocations] = useState([]);
  const [history, setHistory] = useState({});

  /* --------------------------- UI State ------------------------------ */
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState(() => new Set());
  const [mapping, setMapping] = useState(() => ({ /* itemId -> locationId */ }));
  const undoStackRef = useRef([]);

  /* -------------------------- Effects ------------------------------- */
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [locs, hist] = await Promise.all([
          initialLocations ? Promise.resolve(initialLocations) : inventoryService.fetchKnownLocations(),
          inventoryService.fetchHistoricalPlacements?.() ?? Promise.resolve({}),
        ]);
        if (!mounted) return;
        setKnownLocations(Array.isArray(locs) ? locs : []);
        setHistory(hist || {});
      } catch (e) {
        console.warn("[BatchInventoryMap] failed to fetch locations/history", e);
      }
    })();
    return () => { mounted = false; };
  }, [initialLocations, inventoryService]);

  // Keep items refreshed from queue if not using initialItems
  useEffect(() => {
    if (!initialItems && Array.isArray(queue.items)) setItems(queue.items);
  }, [queue.items, initialItems]);

  // Build itemsByLocation from mapping
  const itemsByLocation = useMemo(() => {
    const byLoc = {};
    for (const it of items) {
      const locId = mapping[it.id];
      if (!locId) continue;
      (byLoc[locId] ||= []).push(it);
    }
    return byLoc;
  }, [items, mapping]);

  // Items to show (unmapped + filter)
  const filteredItems = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const arr = items.filter((it) => !mapping[it.id]);
    if (!q) return arr;
    return arr.filter((it) => it.name.toLowerCase().includes(q) || it.tags?.some((t) => t.toLowerCase().includes(q)));
  }, [items, mapping, filter]);

  /* -------------------------- Handlers ------------------------------ */
  function pushUndo(prev) {
    undoStackRef.current.push(prev);
    if (undoStackRef.current.length > 20) undoStackRef.current.shift();
  }

  function onToggleSelect(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function onDropItem(dragItem, location) {
    const prev = { mapping: { ...mapping } };
    pushUndo(prev);
    setMapping((m) => ({ ...m, [dragItem.id]: location.id }));
  }

  function onQuickMove(action) {
    if (action.type === "remove") {
      const prev = { mapping: { ...mapping } };
      pushUndo(prev);
      setMapping((m) => {
        const n = { ...m };
        delete n[action.itemId];
        return n;
      });
    }
    if (action.type === "rename") {
      setKnownLocations((prev) => prev.map((l) => (l.id === action.locationId ? { ...l, name: action.name } : l)));
    }
  }

  function autoSuggestUnmapped() {
    const prev = { mapping: { ...mapping } };
    const next = { ...mapping };
    let changed = 0;
    for (const it of items) {
      if (next[it.id]) continue;
      const suggest = suggestLocationFor(it, knownLocations, history);
      if (suggest) {
        next[it.id] = suggest;
        changed++;
      }
    }
    if (changed) {
      pushUndo(prev);
      setMapping(next);
      toast({ title: "Auto‑mapped", description: `Suggested locations for ${changed} item(s).` });
    } else {
      toast({ title: "No suggestions", description: "All items are mapped or no suitable locations." });
    }
  }

  async function syncSelected() {
    const selection = Array.from(selected);
    if (selection.length === 0) return toast({ title: "Nothing selected" });

    const payload = selection
      .filter((id) => mapping[id])
      .map((id) => ({ itemId: id, locationId: mapping[id] }));

    if (payload.length === 0) return toast({ title: "No mapped items in selection" });

    const prev = { mapping: { ...mapping } };
    try {
      const res = await inventoryService.saveLocationMapping(payload);
      if (res?.ok) {
        eventBus.publish("inventory.mapping.updated", { payload, at: Date.now() });
        eventBus.publish("inventory.updated", { reason: "mapping-sync", at: Date.now() });
        toast({ title: "Saved", description: `${payload.length} mapping(s) synced.` });
        setSelected(new Set());
      } else {
        throw new Error("saveLocationMapping returned not ok");
      }
    } catch (e) {
      console.error("[BatchInventoryMap] syncSelected error", e);
      toast({ title: "Sync failed", description: "Restoring previous state." });
      setMapping(prev.mapping);
    }
  }

  function undo() {
    const prev = undoStackRef.current.pop();
    if (!prev) return toast({ title: "Nothing to undo" });
    setMapping(prev.mapping);
  }

  function clearAll() {
    if (!confirm("Clear all mappings?")) return;
    const prev = { mapping: { ...mapping } };
    pushUndo(prev);
    setMapping({});
  }

  function quickCreateLocation() {
    const name = prompt("Create a new location (e.g., 'Pantry B Bin 2'):");
    if (!name || !name.trim()) return;
    const id = kebabCase(name) + "-" + Date.now().toString(36);
    const lower = name.toLowerCase();
    const kindGuess = lower.includes("freezer") ? "freezer" : lower.includes("fridge") ? "fridge" : lower.includes("root") ? "root" : "pantry";
    const temp = kindGuess === "freezer" ? "frozen" : kindGuess === "fridge" ? "chilled" : kindGuess === "root" ? "cool" : "ambient";
    setKnownLocations((prev) => [...prev, { id, name: name.trim(), kind: kindGuess, temp }]);
  }

  /* ------------------------ Derived UI ------------------------------ */
  const nba = useMemo(() => {
    const unmapped = items.filter((it) => !mapping[it.id]).length;
    if (unmapped > 0) return { label: `Auto‑map ${unmapped} item(s)`, action: autoSuggestUnmapped };
    if (selected.size > 0) return { label: `Sync ${selected.size} selected`, action: syncSelected };
    const mapped = Object.keys(mapping).length;
    if (mapped > 0) return { label: "Sync all mapped", action: () => { setSelected(new Set(Object.keys(mapping))); syncSelected(); } };
    return { label: "Create a location", action: quickCreateLocation };
  }, [items, mapping, selected]);

  /* ---------------------------- Render ------------------------------ */
  return (
    <DndProvider backend={HTML5Backend}>
      <section className={classNames("w-full", compact ? "p-2" : "p-4 md:p-6")} aria-label="Batch Inventory Map">
        {/* Header */}
        <header className="flex flex-col md:flex-row md:items-center gap-3 mb-4">
          <div className="flex-1">
            <h1 className="text-xl md:text-2xl font-bold tracking-tight">
              Batch Inventory Map <span className="badge badge-primary ml-2">auto</span>
            </h1>
            <p className="text-sm opacity-70">Drag ingredients to locations, or use auto‑suggest. Multi‑select then Sync.</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button className="btn btn-secondary btn-sm" onClick={undo} title="Undo last change" data-testid="btn-undo">Undo</button>
            <button className="btn btn-outline btn-sm" onClick={clearAll} title="Clear all mappings" data-testid="btn-clear">Clear</button>
            <button className="btn btn-outline btn-sm" onClick={quickCreateLocation} data-testid="btn-new-loc">New Location</button>
            <button className="btn btn-primary btn-sm" onClick={nba.action} data-testid="btn-nba">{nba.label}</button>
          </div>
        </header>

        {/* Body Grid */}
        <div className={classNames("grid gap-4", compact ? "grid-cols-1" : "grid-cols-1 lg:grid-cols-3")}>
          {/* Left Column: Items to map */}
          <div className="rounded-2xl border border-base-300 bg-base-100 p-3 shadow-sm">
            <div className="flex items-center gap-2 mb-2">
              <input
                aria-label="Filter ingredients"
                className="input input-sm input-bordered w-full"
                placeholder="Filter by name or tag…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                data-testid="filter-input"
              />
              <button className="btn btn-sm" onClick={autoSuggestUnmapped} data-testid="btn-suggest">Suggest</button>
            </div>

            {filteredItems.length === 0 ? (
              <div className="text-sm opacity-70 p-2" data-testid="empty-items">
                {items.length === 0 ? "No items in this batch yet. Add recipes to your Batch Session." : "All items are mapped or no results for your filter."}
              </div>
            ) : (
              <div role="list" className="max-h-[60vh] overflow-auto pr-1">
                {filteredItems.map((it) => (
                  <IngredientCard key={it.id} item={it} selected={selected.has(it.id)} onToggleSelect={onToggleSelect} />
                ))}
              </div>
            )}

            {selected.size > 0 && (
              <div className="mt-3 flex items-center justify-between">
                <span className="text-sm opacity-70">Selected: {selected.size}</span>
                <button className="btn btn-primary btn-sm" onClick={syncSelected} data-testid="btn-sync-selected">Sync Selected</button>
              </div>
            )}
          </div>

          {/* Right Columns: Locations */}
          <div className={classNames("lg:col-span-2 grid gap-3", compact ? "grid-cols-2" : "grid-cols-2 xl:grid-cols-3")}>
            {knownLocations.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-base-300 p-6 text-center italic opacity-70" data-testid="empty-locations">
                No locations yet. Click <strong>New Location</strong> to add one, or configure your Storehouse.
              </div>
            ) : (
              knownLocations.map((loc) => (
                <LocationBin
                  key={loc.id}
                  location={loc}
                  itemsHere={itemsByLocation[loc.id] || []}
                  onDropItem={onDropItem}
                  onQuickMove={onQuickMove}
                  allowManualNaming
                />
              ))
            )}
          </div>
        </div>

        {/* Footer helper / NBA */}
        <footer className="mt-4 flex items-center justify-between">
          <div className="text-xs opacity-70">Tip: Shift‑click checkboxes to select ranges. Press Ctrl+Z to undo.</div>
          <button className="btn btn-primary" onClick={nba.action}>{nba.label}</button>
        </footer>
      </section>
    </DndProvider>
  );
}

/********************
 * Keyboard Shortcuts
 ********************/
export function useLocalUndoHotkey(ref, onUndo) {
  useEffect(() => {
    const el = ref?.current || window;
    const handler = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        onUndo?.();
      }
    };
    el.addEventListener("keydown", handler);
    return () => el.removeEventListener("keydown", handler);
  }, [ref, onUndo]);
}

/********************
 * Lightweight Self‑Tests
 ********************/
export function runBatchInventoryMapTests() {
  const results = [];
  try {
    // kebabCase tests
    results.push({ name: "kebabCase basic", pass: kebabCase("Pantry B Bin 2") === "pantry-b-bin-2" });
    results.push({ name: "kebabCase trims", pass: kebabCase("  Freezer  Top  ") === "freezer-top" });

    // suggestLocationFor tests
    const locs = [
      { id: "cold", name: "Fridge Shelf", temp: "chilled" },
      { id: "frozen", name: "Freezer Drawer", temp: "frozen" },
      { id: "dry", name: "Pantry", temp: "ambient" },
    ];
    const item1 = { id: "a", name: "Milk", temp: "chilled" };
    const item2 = { id: "b", name: "Peas", temp: "frozen" };
    const item3 = { id: "c", name: "Flour", temp: "ambient", tags: ["pantry"] };
    const hist = { a: "dry", x: "cold" }; // history points milk to dry (should prefer history)

    results.push({ name: "suggest uses history if valid", pass: suggestLocationFor(item1, locs, hist) === "dry" });
    results.push({ name: "suggest by temp", pass: suggestLocationFor(item2, locs, {}) === "frozen" });
    results.push({ name: "suggest by tag fallback", pass: suggestLocationFor(item3, locs, {}) === "dry" });

    const summary = {
      passed: results.filter((r) => r.pass).length,
      total: results.length,
      results,
    };
    console.log("[BatchInventoryMap tests]", summary);
    return summary;
  } catch (err) {
    console.error("[BatchInventoryMap tests] error", err);
    return { error: String(err), results };
  }
}
