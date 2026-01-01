// src/components/meals/library/CollectionsView.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";

/* ------------------------------- Defensive deps ------------------------------- */
let Icons = {};
try { Icons = require("lucide-react"); } catch {}

let eventBus = null;
try { eventBus = require("@/services/eventBus").eventBus || null; } catch {}

let automation = null;
try { automation = require("@/services/automation/runtime").automation || null; } catch {}

let useLibraryStore = () => null;
try {
  // Optional global recipes library store
  const mod = require("@/store/LibraryStore");
  useLibraryStore = mod.useLibraryStore || useLibraryStore;
} catch {}

let SendToMenu = null;
try {
  SendToMenu = require("../collector/SendToMenu.jsx").default || null;
} catch {}

let TaggingPanel = null;
try {
  TaggingPanel = require("../collector/TaggingPanel.jsx").default || null;
} catch {}

let toast = { success: console.log, info: console.log, error: console.error, warn: console.warn };
try { toast = require("react-toastify").toast || toast; } catch {}

/* --------------------------------- Utilities --------------------------------- */
const cx = (...xs) => xs.filter(Boolean).join(" ");
const clamp = (n, a = 0, b = Infinity) => Math.max(a, Math.min(b, Number.isFinite(+n) ? +n : a));
const uniq = (arr) => Array.from(new Set(arr || []));
const fmtCount = (n) => (Number.isFinite(n) ? n : 0);

/* ---------------------------------- Types ------------------------------------
Collection shape (we’re defensive if fields are missing):
{
  id: string,
  name: string,
  coverUrls?: string[],           // up to 3 images
  recipeCount?: number,
  tags?: string[],
  createdAt?: number,
  updatedAt?: number,
  attributionCount?: number,      // recipes with provenance
}
----------------------------------------------------------------------------- */

/* --------------------------------- Skeletons --------------------------------- */
const CardSkeleton = () => (
  <div className="rounded-2xl border p-2 bg-white/60 animate-pulse">
    <div className="grid grid-cols-3 gap-1 h-28">
      <div className="bg-gray-200 rounded" />
      <div className="bg-gray-200 rounded" />
      <div className="bg-gray-200 rounded" />
    </div>
    <div className="h-4 w-2/3 bg-gray-200 rounded mt-2" />
    <div className="h-3 w-1/2 bg-gray-200 rounded mt-1" />
  </div>
);

/* -------------------------------- Tag pill ---------------------------------- */
const TagPill = ({ t }) => (
  <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] border bg-gray-50 text-gray-700 mr-1 mb-1">
    {t}
  </span>
);

/* ------------------------------- Cover Mosaic -------------------------------- */
const CoverMosaic = ({ urls = [] }) => {
  const images = (urls || []).slice(0, 3);
  const Placeholder = () => (
    <div className="w-full h-full rounded bg-gray-100 border flex items-center justify-center text-gray-400 text-xs">
      No cover
    </div>
  );
  if (!images.length) return <Placeholder />;
  if (images.length === 1) {
    return (
      <div className="w-full h-full">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={images[0]} alt="" className="w-full h-full object-cover rounded" loading="lazy" />
      </div>
    );
  }
  return (
    <div className="grid grid-cols-3 grid-rows-2 gap-1 h-full">
      {/* main left spans rows */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={images[0]} alt="" className="col-span-2 row-span-2 w-full h-full object-cover rounded" loading="lazy" />
      {/* top-right */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={images[1]} alt="" className="w-full h-full object-cover rounded" loading="lazy" />
      {/* bottom-right */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={images[2] || images[1]} alt="" className="w-full h-full object-cover rounded" loading="lazy" />
    </div>
  );
};

/* ------------------------------ Collection Card ------------------------------ */
const CollectionCard = ({
  c,
  selected,
  onToggleSelect,
  onOpen,
  onRename,
  onDelete,
  onMergePick,
  dense = false,
}) => {
  const {
    FolderOpenDot = () => null,
    Tags = () => null,
    Pencil = () => null,
    Trash2 = () => null,
    GitMerge = () => null,
    CheckSquare = () => null,
    Square = () => null,
    Link2 = () => null,
  } = Icons;
  const recipes = fmtCount(c?.recipeCount);
  const atts = fmtCount(c?.attributionCount);

  return (
    <div className="rounded-2xl border p-2 bg-white/80 backdrop-blur hover:shadow-sm transition">
      <div className="relative h-28">
        <button
          type="button"
          onClick={() => onOpen?.(c)}
          className="absolute inset-0 rounded overflow-hidden"
          title={`Open ${c?.name || "Collection"}`}
        >
          <CoverMosaic urls={c?.coverUrls} />
        </button>
        <button
          type="button"
          className="absolute top-1 left-1 p-1 rounded-md bg-white/80 border hover:bg-white"
          onClick={() => onToggleSelect?.(c)}
          aria-label={selected ? "Unselect collection" : "Select collection"}
          title={selected ? "Unselect" : "Select"}
        >
          {selected ? <CheckSquare className="w-4 h-4 text-emerald-600" /> : <Square className="w-4 h-4 text-gray-500" />}
        </button>
      </div>

      <div className="mt-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-semibold truncate">{c?.name || "Untitled collection"}</div>
          <div className="text-[11px] text-gray-600 mt-0.5 flex items-center gap-2">
            <span className="inline-flex items-center gap-1"><FolderOpenDot className="w-3.5 h-3.5" /> {recipes} recipe{recipes === 1 ? "" : "s"}</span>
            <span className="inline-flex items-center gap-1"><Link2 className="w-3.5 h-3.5" /> {atts} attributed</span>
          </div>
        </div>
        <div className="shrink-0 inline-flex items-center gap-1">
          <button className="px-2 py-1 rounded-md border hover:bg-gray-50 text-xs" onClick={() => onRename?.(c)} title="Rename">
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button className="px-2 py-1 rounded-md border hover:bg-gray-50 text-xs" onClick={() => onMergePick?.(c)} title="Merge into…">
            <GitMerge className="w-3.5 h-3.5" />
          </button>
          <button className="px-2 py-1 rounded-md border hover:bg-rose-50 text-rose-700 text-xs" onClick={() => onDelete?.(c)} title="Delete">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* tags preview */}
      <div className="mt-2">
        {(c?.tags || []).slice(0, 6).map((t) => <TagPill key={t} t={t} />)}
        {(c?.tags?.length || 0) > 6 ? <span className="text-[11px] text-gray-500 ml-1">+{c.tags.length - 6}</span> : null}
      </div>

      {dense ? null : (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => onOpen?.(c)}
            className="w-full px-2 py-1.5 rounded-md border hover:bg-gray-50 text-sm"
          >
            View recipes
          </button>
        </div>
      )}
    </div>
  );
};

/* --------------------------------- Main View --------------------------------- */
/**
 * CollectionsView
 *
 * Props:
 * - collections?: Collection[]           (controlled list; if omitted, read from store)
 * - loading?: boolean
 * - error?: string
 * - onOpenCollection?: (collection) => void
 * - onChange?: (nextCollections) => void      // after local edits (rename/delete/merge)
 * - onEvent?: (type, payload) => void         // after eventBus/automation emits
 * - householdId?: string
 * - dense?: boolean
 */
const CollectionsView = ({
  collections,
  loading = false,
  error = "",
  onOpenCollection,
  onChange,
  onEvent,
  householdId = "default",
  dense = false,
}) => {
  const lib = useLibraryStore ? useLibraryStore() : null;

  const initial = useMemo(
    () => collections || lib?.collections || [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(collections || lib?.collections || [])]
  );

  const [items, setItems] = useState(initial);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState("updated"); // updated | created | name | count
  const [sortDir, setSortDir] = useState("desc");
  const [filterTags, setFilterTags] = useState([]);

  useEffect(() => setItems(initial), [initial]);

  const emit = (type, payload) => {
    try { eventBus?.emit?.(type, payload); } catch {}
    try { automation?.runTemplate?.(type, payload); } catch {}
    onEvent?.(type, payload);
  };

  /* --------------------------------- Derived --------------------------------- */
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let arr = (items || []).slice();
    if (q) arr = arr.filter((c) => `${c?.name || ""} ${(c?.tags || []).join(" ")}`.toLowerCase().includes(q));
    if (filterTags?.length) {
      const set = new Set(filterTags);
      arr = arr.filter((c) => (c?.tags || []).some((t) => set.has(t)));
    }
    const dir = sortDir === "asc" ? 1 : -1;
    arr.sort((a, b) => {
      if (sortBy === "name") return a.name?.localeCompare?.(b.name || "") * dir;
      if (sortBy === "count") return (fmtCount(a.recipeCount) - fmtCount(b.recipeCount)) * dir;
      const av = sortBy === "created" ? (a.createdAt || 0) : (a.updatedAt || 0);
      const bv = sortBy === "created" ? (b.createdAt || 0) : (b.updatedAt || 0);
      return (av - bv) * dir;
    });
    return arr;
  }, [items, query, filterTags, sortBy, sortDir]);

  /* --------------------------------- Handlers -------------------------------- */
  const applyChange = (next) => {
    setItems(next);
    onChange?.(next);
  };

  const toggleSelect = (c) => {
    const next = new Set(selectedIds);
    next.has(c.id) ? next.delete(c.id) : next.add(c.id);
    setSelectedIds(next);
  };

  const clearSelection = () => setSelectedIds(new Set());

  const createCollection = () => {
    const name = prompt("New collection name?");
    if (!name) return;
    const id = `col_${Math.random().toString(36).slice(2, 9)}`;
    const col = { id, name, recipeCount: 0, tags: [], createdAt: Date.now(), updatedAt: Date.now() };
    const next = [col, ...items];
    applyChange(next);
    try { lib?.createCollection?.(col); } catch {}
    toast.success(`Created “${name}”.`);
    emit("library.collection.created", { id, name, householdId });
  };

  const renameCollection = (c) => {
    const name = prompt("Rename collection", c?.name || "");
    if (!name || name === c.name) return;
    const next = items.map((x) => (x.id === c.id ? { ...x, name, updatedAt: Date.now() } : x));
    applyChange(next);
    try { lib?.renameCollection?.(c.id, name); } catch {}
    toast.info(`Renamed to “${name}”.`);
    emit("library.collection.renamed", { id: c.id, name, householdId });
  };

  const deleteCollection = (c) => {
    if (!confirm(`Delete “${c?.name}”? Recipes remain in your library.`)) return;
    const next = items.filter((x) => x.id !== c.id);
    applyChange(next);
    try { lib?.deleteCollection?.(c.id); } catch {}
    toast.warn(`Deleted “${c?.name}”.`);
    emit("library.collection.deleted", { id: c.id, householdId });
    setSelectedIds((s) => { const n = new Set(s); n.delete(c.id); return n; });
  };

  const mergeInto = (source, target) => {
    if (!source || !target || source.id === target.id) return;
    try { lib?.mergeCollections?.(source.id, target.id); } catch {}
    const next = items
      .map((x) => (x.id === target.id ? { ...x, recipeCount: fmtCount(x.recipeCount) + fmtCount(source.recipeCount), updatedAt: Date.now() } : x))
      .filter((x) => x.id !== source.id);
    applyChange(next);
    toast.success(`Merged “${source.name}” → “${target.name}”.`);
    emit("library.collection.merged", { from: source.id, to: target.id, householdId });
    setSelectedIds((s) => { const n = new Set(s); n.delete(source.id); return n; });
  };

  const openCollection = (c) => {
    onOpenCollection?.(c);
    emit("library.collection.opened", { id: c?.id, householdId });
  };

  /* ----------------------------- Bulk actions bar ---------------------------- */
  const BulkBar = () => {
    const sel = items.filter((x) => selectedIds.has(x.id));
    const ids = sel.map((x) => x.id);
    const {
      Send = () => null,
      Trash2 = () => null,
      GitMerge = () => null,
      X = () => null,
      Download = () => null,
    } = Icons;

    const doBulkDelete = () => {
      if (!ids.length) return;
      if (!confirm(`Delete ${ids.length} collection${ids.length === 1 ? "" : "s"}?`)) return;
      const next = items.filter((x) => !selectedIds.has(x.id));
      applyChange(next);
      try { ids.forEach((id) => lib?.deleteCollection?.(id)); } catch {}
      clearSelection();
      toast.warn(`Deleted ${ids.length} collections.`);
      emit("library.collections.deleted", { ids, householdId });
    };

    const doBulkExport = () => {
      emit("library.collections.export.requested", { ids, format: "json", householdId });
      toast.info("Export requested.");
    };

    const pickMergeTarget = () => {
      const options = items.filter((x) => !selectedIds.has(x.id));
      const names = options.map((o) => o.name).join(", ");
      const name = prompt(`Merge selected into which collection?\n\nOptions: ${names}`);
      const target = options.find((o) => o.name === name);
      if (!target) return;
      sel.forEach((s) => mergeInto(s, target));
    };

    return (
      <div className="sticky top-1 z-10 rounded-xl border bg-white/90 backdrop-blur px-2 py-2 mb-2 flex items-center gap-2">
        <div className="text-sm font-medium">{ids.length} selected</div>
        <button className="px-2 py-1 rounded-md border hover:bg-gray-50 text-xs" onClick={pickMergeTarget} title="Merge into…">
          <GitMerge className="w-3.5 h-3.5 inline-block mr-1" /> Merge
        </button>
        {SendToMenu ? (
          <SendToMenu
            compact
            triggerClassName="px-2 py-1 rounded-md border hover:bg-gray-50 text-xs inline-flex items-center gap-1"
            triggerLabel={<><Send className="w-3.5 h-3.5" /> Send to…</>}
            payload={{ type: "collections", ids }}
            onSent={(dest) => emit("library.collections.sent", { ids, dest, householdId })}
          />
        ) : (
          <button className="px-2 py-1 rounded-md border hover:bg-gray-50 text-xs">
            <Send className="w-3.5 h-3.5 inline-block mr-1" /> Send to…
          </button>
        )}
        <button className="px-2 py-1 rounded-md border hover:bg-gray-50 text-xs" onClick={doBulkExport} title="Export">
          <Download className="w-3.5 h-3.5 inline-block mr-1" /> Export
        </button>
        <button className="ml-auto px-2 py-1 rounded-md border hover:bg-rose-50 text-rose-700 text-xs" onClick={doBulkDelete} title="Delete">
          <Trash2 className="w-3.5 h-3.5 inline-block mr-1" /> Delete
        </button>
        <button className="px-2 py-1 rounded-md border hover:bg-gray-50 text-xs" onClick={clearSelection} title="Clear">
          <X className="w-3.5 h-3.5 inline-block mr-1" /> Clear
        </button>
      </div>
    );
  };

  /* ---------------------------------- Toolbar -------------------------------- */
  const Toolbar = () => {
    const {
      Search = () => null,
      Plus = () => null,
      SlidersHorizontal = () => null,
      SortDesc = () => null,
      Filter = () => null,
    } = Icons;

    return (
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 px-3 py-2 rounded-md border flex-1 min-w-[220px] bg-white/80">
          <Search className="w-4 h-4 opacity-70" />
          <input
            className="w-full text-sm outline-none bg-transparent"
            placeholder="Search collections or tags…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="flex items-center gap-2 px-3 py-2 rounded-md border bg-white/80">
          <SortDesc className="w-4 h-4 opacity-70" />
          <select
            className="text-sm outline-none bg-transparent"
            value={`${sortBy}:${sortDir}`}
            onChange={(e) => {
              const [b, d] = e.target.value.split(":");
              setSortBy(b); setSortDir(d);
            }}
            title="Sort"
          >
            <option value="updated:desc">Recent</option>
            <option value="created:desc">New → Old</option>
            <option value="created:asc">Old → New</option>
            <option value="name:asc">Name A–Z</option>
            <option value="name:desc">Name Z–A</option>
            <option value="count:desc">Most recipes</option>
            <option value="count:asc">Fewest recipes</option>
          </select>
        </div>

        <button type="button" className="inline-flex items-center gap-2 px-3 py-2 rounded-md border hover:bg-gray-50" onClick={createCollection}>
          <Plus className="w-4 h-4" /> New
        </button>

        <div className="inline-flex items-center gap-2 px-3 py-2 rounded-md border">
          <SlidersHorizontal className="w-4 h-4 opacity-70" />
          <span className="text-sm">Filters</span>
        </div>
      </div>
    );
  };

  /* ---------------------------------- Filters -------------------------------- */
  const Filters = () => (
    <div className="rounded-xl border p-2 bg-white/70 backdrop-blur mb-2">
      {TaggingPanel ? (
        <TaggingPanel value={filterTags} onChange={(v) => setFilterTags(v)} compact />
      ) : (
        <input
          className="w-full border rounded px-2 py-2 text-sm"
          placeholder="Filter by tags (comma-separated)"
          value={filterTags.join(", ")}
          onChange={(e) =>
            setFilterTags(
              e.target.value
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean)
            )
          }
        />
      )}
    </div>
  );

  /* -------------------------------- Merge picker ------------------------------ */
  const [mergeSource, setMergeSource] = useState(null);
  const MergePicker = () => {
    if (!mergeSource) return null;
    const opts = items.filter((x) => x.id !== mergeSource.id);
    const { GitMerge = () => null, X = () => null } = Icons;
    return (
      <div className="rounded-xl border p-3 bg-white/80 mb-2">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">
            <GitMerge className="w-4 h-4 inline-block mr-1" />
            Merge “{mergeSource.name}” into…
          </div>
          <button className="px-2 py-1 rounded-md border hover:bg-gray-50 text-xs" onClick={() => setMergeSource(null)}>
            <X className="w-3.5 h-3.5 inline-block mr-1" /> Cancel
          </button>
        </div>
        <div className="mt-2 grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2">
          {opts.map((o) => (
            <button
              key={o.id}
              className="px-2 py-2 rounded-md border hover:bg-gray-50 text-sm text-left"
              onClick={() => { mergeInto(mergeSource, o); setMergeSource(null); }}
            >
              {o.name}
              <div className="text-[11px] text-gray-600">{fmtCount(o.recipeCount)} recipes</div>
            </button>
          ))}
        </div>
      </div>
    );
  };

  /* ----------------------------------- UI ------------------------------------ */
  if (error) {
    return <div className="rounded-2xl border p-4 bg-rose-50 border-rose-200 text-rose-800 text-sm">{error}</div>;
  }

  if (loading && (!items || items.length === 0)) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {Array.from({ length: 6 }).map((_, i) => <CardSkeleton key={i} />)}
      </div>
    );
  }

  const selectionActive = selectedIds.size > 0;

  return (
    <section className="rounded-2xl border p-3 bg-white/70 backdrop-blur">
      <Toolbar />
      <Filters />
      {selectionActive ? <BulkBar /> : <MergePicker />}

      {filtered.length === 0 ? (
        <div className="text-sm text-gray-600 border rounded-xl p-6 text-center bg-white/70">
          No collections match. Try clearing filters or creating a new one.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {filtered.map((c) => (
            <CollectionCard
              key={c.id}
              c={c}
              dense={dense}
              selected={selectedIds.has(c.id)}
              onToggleSelect={toggleSelect}
              onOpen={openCollection}
              onRename={renameCollection}
              onDelete={deleteCollection}
              onMergePick={setMergeSource}
            />
          ))}
        </div>
      )}
    </section>
  );
};

export default CollectionsView;
