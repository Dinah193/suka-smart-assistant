// src/components/pinboard/PinSelectorGrid.jsx
/* eslint-disable no-console */
import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";

/* ------------------------------- Defensive deps ------------------------------- */
let Icons = {};
try {
  Icons = require("lucide-react");
} catch {
  Icons = {
    Pin: () => null,
    PinOff: () => null,
    PlusCircle: () => null,
    UtensilsCrossed: () => null,
    Soup: () => null,
    Check: () => null,
    X: () => null,
    Search: () => null,
    SortAsc: () => null,
    SortDesc: () => null,
    Filter: () => null,
    Clock: () => null,
    Star: () => null,
    StarOff: () => null,
    Sparkles: () => null,
    ListChecks: () => null,
    AlertTriangle: () => null,
    Shield: () => null,
    ChevronLeft: () => null,
    ChevronRight: () => null,
    MoreHorizontal: () => null,
  };
}

let eventBus = { emit: () => {}, on: () => {}, off: () => {} };
try {
  eventBus = require("@/services/eventBus").eventBus || eventBus;
} catch {}

let InventoryMonitor = {
  checkRecipe: () => ({ status: "unknown", missingCount: 0 }),
};
try {
  InventoryMonitor =
    require("@/managers/InventoryMonitor").default ||
    require("@/managers/InventoryMonitor") ||
    InventoryMonitor;
} catch {}

let useBatchQueue = () => ({ addMany: () => {}, count: 0 });
try {
  useBatchQueue = require("@/features/meals/BatchQueueProvider").useBatchQueue || useBatchQueue;
} catch {}

let usePersonalFoodStandards = () => ({ standards: {} });
try {
  usePersonalFoodStandards =
    require("@/app/context/HouseholdSettingsContext").usePersonalFoodStandards ||
    usePersonalFoodStandards;
} catch {}

let VariableSizeGrid = null;
try {
  VariableSizeGrid = require("react-window").VariableSizeGrid || null;
} catch {}

/* ---------------------------------- Helpers --------------------------------- */
const cx = (...xs) => xs.filter(Boolean).join(" ");
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number(n) || 0));
const safeArr = (x) => (Array.isArray(x) ? x : x ? [x] : []);

function standardsBadge(recipe = {}, standards = {}) {
  const title = recipe?.title || "";
  const tags = new Set((recipe?.tags || []).map((t) => (typeof t === "string" ? t : t?.id)));
  if (standards?.noPork && (tags.has("pork") || /pork/i.test(title))) return { ok: false, label: "No pork" };
  if (standards?.lambBeefOnly) {
    const bad =
      /chicken|fish|turkey|seafood/i.test(title) ||
      ["chicken", "turkey", "fish", "seafood"].some((t) => tags.has(t));
    if (bad) return { ok: false, label: "Lamb/Beef only" };
  }
  return { ok: true, label: "Fits standards" };
}

const STORAGE_KEY = "suka.pinboard.grid.v1";

/* ---------------------------------- Component -------------------------------- */
export default function PinSelectorGrid({
  /** Array of pinned items (recipes/meals). Minimal shape: {id, title, image?, rating?, prepMinutes?, cookMinutes?, tags?, macros?} */
  items = [],
  /** Pre-filtered by parent; we also offer local search/sort */
  initialQuery = "",
  /** Called when user sends selected items to planner */
  onPlanMany, // (ids | items) => void
  /** Called when user adds selected items to batch queue */
  onBatchMany, // (ids | items) => void
  /** Called when user toggles pin(s) off */
  onUnpinMany, // (ids) => void
  /** Called when user opens one item */
  onOpenItem, // (item) => void
  /** Optional: show inventory/standards badges */
  inventoryAware = true,
  standardsAware = true,
  className,
}) {
  const {
    PinOff, PlusCircle, UtensilsCrossed, Soup, Check, X, Search, SortAsc, SortDesc, Filter,
    Clock, Star, StarOff, Sparkles, ListChecks, AlertTriangle, Shield, ChevronLeft, ChevronRight, MoreHorizontal
  } = Icons;

  const ChevronRightIcon = Icons.ChevronRight || (() => null); // <-- fix for TSX member expression

  const { standards } = usePersonalFoodStandards();
  const batch = useBatchQueue();

  /* ------------------------------- UI state -------------------------------- */
  const [q, setQ] = useState(initialQuery);
  const [sortKey, setSortKey] = useState("recent"); // recent|rating|time|title
  const [sortDir, setSortDir] = useState("desc");
  const [page, setPage] = useState(1);
  const [sel, setSel] = useState(() => new Set());
  const [lastFocusId, setLastFocusId] = useState(null);

  // Persist basic UI
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      if (saved.sortKey) setSortKey(saved.sortKey);
      if (saved.sortDir) setSortDir(saved.sortDir);
    } catch {}
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ sortKey, sortDir }));
    } catch {}
  }, [sortKey, sortDir]);

  /* ------------------------------- Filtering -------------------------------- */
  const filtered = useMemo(() => {
    const needle = (q || "").trim().toLowerCase();
    let arr = items;
    if (needle) {
      arr = items.filter((it) => {
        const hay = [
          it.title,
          ...(safeArr(it.tags).map((t) => (typeof t === "string" ? t : t?.label || t?.id))),
          it.cuisine,
          it.mealType,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return hay.includes(needle);
      });
    }
    // Sort
    const keyFn = (it) => {
      switch (sortKey) {
        case "rating":
          return Number(it.rating || 0);
        case "time":
          return Number(it.totalMinutes || 0) || (it.prepMinutes || 0) + (it.cookMinutes || 0);
        case "title":
          return (it.title || "").toLowerCase();
        case "recent":
        default:
          return Number(new Date(it.updatedAt || it.createdAt || 0).getTime());
      }
    };
    const sorted = [...arr].sort((a, b) => {
      const av = keyFn(a);
      const bv = keyFn(b);
      if (typeof av === "string" || typeof bv === "string") {
        const cmp = String(av).localeCompare(String(bv));
        return sortDir === "asc" ? cmp : -cmp;
      }
      return sortDir === "asc" ? av - bv : bv - av;
    });
    return sorted;
  }, [items, q, sortKey, sortDir]);

  /* ------------------------------- Pagination -------------------------------- */
  const perPage = 36; // responsive card grid; virtualize later if needed
  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const pageItems = filtered.slice((page - 1) * perPage, page * perPage);

  useEffect(() => {
    // Reset page if filter changes
    setPage(1);
  }, [q, sortKey, sortDir, items.length]);

  /* ------------------------------- Selection -------------------------------- */
  const toggleSelect = useCallback(
    (id, e) => {
      setSel((prev) => {
        const next = new Set(prev);
        const additive = !!(e?.metaKey || e?.ctrlKey);
        const range = !!e?.shiftKey && lastFocusId != null;

        if (range) {
          // Range select based on current page ordering
          const ids = pageItems.map((i) => i.id);
          const a = ids.indexOf(lastFocusId);
          const b = ids.indexOf(id);
          if (a !== -1 && b !== -1) {
            const [lo, hi] = [Math.min(a, b), Math.max(a, b)];
            for (let i = lo; i <= hi; i++) next.add(ids[i]);
          } else {
            // fallback to single select
            if (next.has(id)) next.delete(id);
            else next.add(id);
          }
        } else if (additive) {
          if (next.has(id)) next.delete(id);
          else next.add(id);
        } else {
          if (next.size === 1 && next.has(id)) {
            next.clear(); // deselect if already the only selected
          } else {
            next.clear();
            next.add(id);
          }
        }

        return next;
      });
      setLastFocusId(id);
    },
    [pageItems, lastFocusId]
  );

  const clearSelection = () => setSel(new Set());
  const selectedItems = useMemo(() => pageItems.filter((it) => sel.has(it.id)), [pageItems, sel]);

  /* --------------------------------- Actions -------------------------------- */
  function doPlan() {
    const pick = selectedItems.length ? selectedItems : pageItems;
    onPlanMany?.(pick);
    eventBus.emit("pinboard.plan", { count: pick.length, ids: pick.map((x) => x.id) });
  }
  function doBatch() {
    const pick = selectedItems.length ? selectedItems : pageItems;
    if (typeof onBatchMany === "function") onBatchMany(pick);
    else batch.addMany?.(pick);
    eventBus.emit("pinboard.batch", { count: pick.length, ids: pick.map((x) => x.id) });
  }
  function doUnpin() {
    const ids = selectedItems.length ? selectedItems.map((x) => x.id) : pageItems.map((x) => x.id);
    onUnpinMany?.(ids);
    eventBus.emit("pinboard.unpin", { count: ids.length, ids });
    clearSelection();
  }

  /* ---------------------------- Inventory/Standards -------------------------- */
  const invCacheRef = useRef(new Map());
  const getInv = useCallback(
    (item) => {
      if (!inventoryAware || !InventoryMonitor?.checkRecipe)
        return { status: "unknown", missingCount: 0 };
      if (invCacheRef.current.has(item.id)) return invCacheRef.current.get(item.id);
      try {
        const res = InventoryMonitor.checkRecipe(item);
        invCacheRef.current.set(item.id, res || { status: "unknown", missingCount: 0 });
        return res || { status: "unknown", missingCount: 0 };
      } catch {
        return { status: "unknown", missingCount: 0 };
      }
    },
    [inventoryAware]
  );

  /* -------------------------------- Keyboard UX ------------------------------ */
  const containerRef = useRef(null);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onKey = (e) => {
      if (e.key === "a" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        // select all on page
        setSel(new Set(pageItems.map((i) => i.id)));
      }
      if (e.key === "Escape") clearSelection();
      if (e.key.toLowerCase() === "b") doBatch();
      if (e.key.toLowerCase() === "p") doPlan();
      if (e.key.toLowerCase() === "u") doUnpin();
      if (e.key === "ArrowRight" && page < totalPages) setPage((p) => p + 1);
      if (e.key === "ArrowLeft" && page > 1) setPage((p) => p - 1);
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, [pageItems, page, totalPages]);

  /* ---------------------------------- UI bits -------------------------------- */
  const SelectionBar = () => {
    const count = selectedItems.length;
    if (!count) return null;
    return (
      <div className="sticky top-[56px] z-20 mb-2 rounded-xl border bg-white/85 backdrop-blur px-3 py-2 shadow-sm flex items-center gap-2">
        <span className="text-sm">
          <strong>{count}</strong> selected
        </span>
        <button
          onClick={doPlan}
          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-xs bg-white border-gray-300 hover:bg-gray-50"
        >
          <UtensilsCrossed className="w-4 h-4" /> Plan
        </button>
        <button
          onClick={doBatch}
          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-xs bg-white border-gray-300 hover:bg-gray-50"
        >
          <Soup className="w-4 h-4" /> Batch
        </button>
        <button
          onClick={doUnpin}
          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-xs text-rose-700 bg-white border-rose-300 hover:bg-rose-50"
        >
          <PinOff className="w-4 h-4" /> Unpin
        </button>
        <button
          onClick={clearSelection}
          className="ml-auto inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-xs bg-white border-gray-300 hover:bg-gray-50"
        >
          <X className="w-4 h-4" /> Clear
        </button>
      </div>
    );
  };

  const Toolbar = () => (
    <div className="flex flex-col md:flex-row md:items-center gap-2 mb-3">
      {/* Search */}
      <div className="relative flex-1">
        <Search className="w-4 h-4 text-gray-500 absolute left-3 top-2.5" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search pins… (title, tags, cuisine)"
          className="w-full pl-9 pr-3 py-2 rounded-lg border border-gray-300 focus:outline-none focus:ring-2 focus:ring-emerald-500"
        />
      </div>

      {/* Sort */}
      <div className="flex items-center gap-2">
        <label className="text-xs text-gray-500">Sort</label>
        <select
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value)}
          className="px-2 py-1 rounded border border-gray-300 text-sm"
        >
          <option value="recent">Recent</option>
          <option value="rating">Rating</option>
          <option value="time">Prep/Cook time</option>
          <option value="title">Title</option>
        </select>
        <button
          type="button"
          onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
          className="inline-flex items-center gap-1 px-2 py-1 rounded border border-gray-300 text-sm bg-white hover:bg-gray-50"
          title="Toggle sort direction"
        >
          {sortDir === "asc" ? <SortAsc className="w-4 h-4" /> : <SortDesc className="w-4 h-4" />}
          {sortDir.toUpperCase()}
        </button>
      </div>

      {/* Bulk quick actions (act on selection if any, else page) */}
      <div className="md:ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={doPlan}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border bg-white border-gray-300 hover:bg-gray-50 text-sm"
          title="Add selected (or page) to plan"
        >
          <UtensilsCrossed className="w-4 h-4" />
          Plan
        </button>
        <button
          type="button"
          onClick={doBatch}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border bg-white border-gray-300 hover:bg-gray-50 text-sm"
          title="Add selected (or page) to batch queue"
        >
          <Soup className="w-4 h-4" />
          Batch
        </button>
        <button
          type="button"
          onClick={doUnpin}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border bg-white border-rose-300 hover:bg-rose-50 text-rose-700 text-sm"
          title="Unpin selected (or page)"
        >
          <PinOff className="w-4 h-4" />
          Unpin
        </button>
      </div>
    </div>
  );

  /* --------------------------------- Grid cell ------------------------------- */
  const Card = ({ item }) => {
    const inv = getInv(item);
    const std = standardsAware ? standardsBadge(item, standards) : { ok: true, label: "" };
    const selected = sel.has(item.id);
    const rating = clamp(Number(item.rating || 0), 0, 5);
    const totalMinutes =
      Number(item.totalMinutes || 0) || (item.prepMinutes || 0) + (item.cookMinutes || 0);

    return (
      <div
        role="button"
        tabIndex={0}
        onClick={(e) => toggleSelect(item.id, e)}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && toggleSelect(item.id, e)}
        className={cx(
          "group relative rounded-2xl border bg-white shadow-sm hover:shadow-md transition overflow-hidden",
          selected ? "border-emerald-600 ring-2 ring-emerald-500" : "border-gray-200"
        )}
        aria-label={`Select ${item.title}`}
      >
        {/* Selection check */}
        {selected ? (
          <div className="absolute left-2 top-2 z-10 inline-flex items-center justify-center w-6 h-6 rounded-full bg-emerald-600 text-white">
            <Check className="w-4 h-4" />
          </div>
        ) : null}

        {/* Media */}
        <div className="h-32 bg-gray-100 overflow-hidden">
          {item.image ? (
            <img
              src={item.image}
              alt=""
              className="w-full h-full object-cover transition group-hover:scale-[1.02]"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-xs text-gray-500">
              No photo
            </div>
          )}
        </div>

        {/* Body */}
        <div className="p-3">
          <div className="line-clamp-2 font-semibold text-gray-900 text-sm">
            {item.title || "Untitled"}
          </div>

          {/* Badges */}
          <div className="mt-2 flex flex-wrap items-center gap-1">
            {/* rating */}
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] bg-gray-50 border-gray-200">
              {Array.from({ length: 5 }).map((_, i) =>
                i < rating ? (
                  <Star key={i} className="w-3 h-3 text-amber-500" />
                ) : (
                  <StarOff key={i} className="w-3 h-3 text-gray-300" />
                )
              )}
            </span>
            {/* time */}
            {totalMinutes ? (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] bg-gray-50 border-gray-200">
                <Clock className="w-3 h-3 text-gray-600" />
                {totalMinutes}m
              </span>
            ) : null}
            {/* inventory */}
            {inventoryAware ? (
              inv.status === "ok" ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] bg-emerald-50 border-emerald-200 text-emerald-700">
                  <ListChecks className="w-3 h-3" /> On hand
                </span>
              ) : inv.status === "missing" ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] bg-amber-50 border-amber-200 text-amber-700">
                  <AlertTriangle className="w-3 h-3" /> {inv.missingCount || 1} missing
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] bg-gray-50 border-gray-200 text-gray-600">
                  <ListChecks className="w-3 h-3" /> Check inv.
                </span>
              )
            ) : null}
            {/* standards */}
            {standardsAware ? (
              std.ok ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] bg-emerald-50 border-emerald-200 text-emerald-700">
                  <Shield className="w-3 h-3" /> OK
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] bg-rose-50 border-rose-200 text-rose-700">
                  <Shield className="w-3 h-3" /> {std.label}
                </span>
              )
            ) : null}
          </div>

          {/* Footer actions */}
          <div className="mt-2 flex items-center justify-between">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpenItem?.(item);
                eventBus.emit("pinboard.open", { id: item.id });
              }}
              className="text-xs inline-flex items-center gap-1 px-2 py-1.5 rounded-lg border bg-white border-gray-300 hover:bg-gray-50"
            >
              <MoreHorizontal className="w-4 h-4" /> Open
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onPlanMany?.([item]);
                  eventBus.emit("pinboard.plan", { count: 1, ids: [item.id] });
                }}
                className="text-xs inline-flex items-center gap-1 px-2 py-1.5 rounded-lg border bg-white border-gray-300 hover:bg-gray-50"
              >
                <UtensilsCrossed className="w-4 h-4" /> Plan
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  if (typeof onBatchMany === "function") onBatchMany([item]);
                  else batch.addMany?.([item]);
                  eventBus.emit("pinboard.batch", { count: 1, ids: [item.id] });
                }}
                className="text-xs inline-flex items-center gap-1 px-2 py-1.5 rounded-lg border bg-white border-gray-300 hover:bg-gray-50"
              >
                <Soup className="w-4 h-4" /> Batch
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  /* ------------------------------ Virtualization ----------------------------- */
  // If many items and react-window exists, we can offer a simple virtual grid fallback.
  const useVirtual = VariableSizeGrid && filtered.length > 200;

  /* ----------------------------------- JSX ----------------------------------- */
  return (
    <section
      ref={containerRef}
      tabIndex={0}
      className={cx("outline-none", className)}
      aria-label="Pinned items selection grid"
    >
      <Toolbar />
      <SelectionBar />

      {/* Grid */}
      {!useVirtual ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
          {pageItems.map((item) => (
            <Card key={item.id} item={item} />
          ))}
          {pageItems.length === 0 ? (
            <div className="col-span-full rounded-xl border border-dashed p-6 text-center text-sm text-gray-600 bg-white">
              No pins match your search. Try adjusting filters or pin more items from the Recipe Vault.
            </div>
          ) : null}
        </div>
      ) : (
        <VirtualGrid items={filtered} Card={Card} />
      )}

      {/* Pagination */}
      {!useVirtual && totalPages > 1 ? (
        <div className="mt-3 flex items-center justify-center gap-2">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border bg-white border-gray-300 text-sm disabled:opacity-50"
          >
            <ChevronLeft className="w-4 h-4" />
            Prev
          </button>
          <div className="text-xs text-gray-700">
            Page <strong>{page}</strong> / {totalPages}
          </div>
          <button
            type="button"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border bg-white border-gray-300 text-sm disabled:opacity-50"
          >
            Next
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      ) : null}

      {/* Tips */}
      <div className="mt-3 text-[11px] text-gray-500 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Sparkles className="w-3 h-3" />
          Tip: <kbd className="px-1 border rounded bg-white">Ctrl/Cmd+A</kbd> select page •
          <kbd className="px-1 border rounded bg-white">Shift+Click</kbd> range select •
          <kbd className="px-1 border rounded bg-white">B</kbd> batch •
          <kbd className="px-1 border rounded bg-white">P</kbd> plan •
          <kbd className="px-1 border rounded bg-white">U</kbd> unpin.
        </div>
        <div className="hidden sm:flex items-center gap-2">
          <Filter className="w-3 h-3" />
          Sorting: {sortKey}/{sortDir}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------ Virtual grid (opt) --------------------------- */
function VirtualGrid({ items, Card }) {
  if (!items?.length || !VariableSizeGrid) return null;

  // Basic layout assumptions; responsive-ish via container width
  const COLS = 6;
  const GAP = 12; // px
  const rowCount = Math.ceil(items.length / COLS);

  const gridRef = useRef(null);
  const [width, setWidth] = useState(1024);
  const containerRef = useRef(null);

  useEffect(() => {
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(e.contentRect.width);
    });
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  const colWidth = Math.floor((width - GAP * (COLS - 1)) / COLS);
  const rowHeight = 260; // approx card height

  const itemAt = (row, col) => {
    const idx = row * COLS + col;
    return items[idx];
  };

  return (
    <div ref={containerRef} className="w-full">
      <VariableSizeGrid
        ref={gridRef}
        columnCount={COLS}
        rowCount={rowCount}
        columnWidth={() => colWidth}
        rowHeight={() => rowHeight}
        width={width}
        height={Math.min(900, rowCount * rowHeight)}
        style={{ overflowX: "hidden" }}
      >
        {({ columnIndex, rowIndex, style }) => {
          const item = itemAt(rowIndex, columnIndex);
          return (
            <div style={{ ...style, paddingRight: GAP, paddingBottom: GAP }}>
              {item ? <Card item={item} /> : null}
            </div>
          );
        }}
      </VariableSizeGrid>
    </div>
  );
}
