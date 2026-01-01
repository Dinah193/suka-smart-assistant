// File: src/components/meals/collector/TaggingPanel.jsx
// Purpose: Compact tagging popup for recipes/ingredients in the Collector.
// Features:
// - Narrow popup with search, create, select/deselect tags (chips)
// - AI suggestions (automation.runTemplate) when available
// - Emits eventBus signals for audit/undo
// - Works if app stores are missing (localStorage fallback)
// - Keyboard: Enter=create/accept, Esc=close, ↑/↓ navigate, ⌘/Ctrl+K close

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

/* ----------------------------- Alias-safe shims ----------------------------- */
const softRequire = (id) => {
  try {
    const req = typeof require === "function" ? require : (0, eval)("require");
    return req ? req(id) : null;
  } catch {
    return null;
  }
};
const alias = (p) => "@" + "/" + p; // avoid static resolution

/* ---------------------------------- Icons ---------------------------------- */
let Icons = softRequire("lucide-react") || {};
const mkIcon = (name) => (props) => (
  <span aria-hidden className={props?.className || "inline-block w-4 h-4"} data-icon={name} />
);
const {
  Tag = mkIcon("Tag"),
  X = mkIcon("X"),
  Plus = mkIcon("Plus"),
  Check = mkIcon("Check"),
  Sparkles = mkIcon("Sparkles"),
  Search = mkIcon("Search"),
  Hash = mkIcon("Hash"),
  Trash2 = mkIcon("Trash2"),
  Edit3 = mkIcon("Edit3"),
  Palette = mkIcon("Palette"),
} = Icons;

/* -------------------------------- Integrations ------------------------------ */
let eventBus = { emit: () => {}, on: () => {}, off: () => {} };
try {
  const mod = softRequire(alias("services/eventBus"));
  if (mod?.eventBus) eventBus = mod.eventBus;
} catch {}

let automation = null;
try {
  const mod = softRequire(alias("services/automation/runtime"));
  automation = mod?.automation || null;
} catch {}

// Optional Tag store (provide shim)
let useTagStore = () => ({
  tags: [], // { id, name, color, emoji }
  createTag: async (_data) => ({ id: String(Date.now()), ..._data }),
  renameTag: async (_id, _name) => {},
  recolorTag: async (_id, _color) => {},
  deleteTag: async (_id) => {},
  assignTags: async (_items, _tagIds) => {},
  removeTags: async (_items, _tagIds) => {},
});
try {
  const mod = softRequire(alias("store/TagStore"));
  if (mod?.useTagStore) useTagStore = mod.useTagStore;
} catch {}

/* ------------------------------- Fallbacks --------------------------------- */
const LS_KEY = "suka_tags_fallback";
const colors = ["#ef4444","#f97316","#f59e0b","#10b981","#06b6d4","#3b82f6","#8b5cf6","#ec4899","#6b7280"];
const pickColor = (i) => colors[i % colors.length];
const slug = (s="") => s.toLowerCase().trim().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"");
const uniqBy = (arr, key) => Object.values(arr.reduce((acc, x)=> (acc[x[key]] = x, acc), {}));

function loadFallbackTags() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || "[]"); } catch { return []; }
}
function saveFallbackTags(tags) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(tags)); } catch {}
}

/* --------------------------------- Helpers --------------------------------- */
const filterTags = (tags, q) => {
  const t = q.toLowerCase().trim();
  if (!t) return tags;
  return tags.filter(tag =>
    (tag.name || "").toLowerCase().includes(t) ||
    (tag.emoji || "").toLowerCase().includes(t) ||
    (tag.id || "").toLowerCase().includes(t)
  );
};

const startsWithTag = (q) => q.startsWith("#") ? q.slice(1).trim() : q.trim();

const paletteClass = "inline-flex items-center gap-1 px-2 py-1 rounded border bg-white hover:bg-gray-50";

/* -------------------------------- Component -------------------------------- */
export default function TaggingPanel({
  mode = "recipes",           // "recipes" | "ingredients"
  selected = [],              // selected items
  initialOpen = false,
  onClose,
  onApply,                    // ( { added:[ids], removed:[ids], items:[...] } ) => void
  align = "right",            // "left" | "right"
  size = "md",                // "sm" | "md" | "lg"
  buttonLabel = "Tag…",
  buttonClassName = "",
  context = {},               // optional extra context (source, plan, etc.)
}) {
  const wrapRef = useRef(null);
  const inputRef = useRef(null);
  const [open, setOpen] = useState(initialOpen);
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [suggesting, setSuggesting] = useState(false);

  const { tags, createTag, renameTag, recolorTag, deleteTag, assignTags, removeTags } = useTagStore();
  const [fallbackTags, setFallbackTags] = useState(loadFallbackTags());

  const appTags = tags?.length ? tags : fallbackTags;

  const width =
    size === "sm" ? "max-w-[300px]" : size === "lg" ? "max-w-[420px]" : "max-w-[360px]";

  const selectedTagIds = useMemo(() => {
    // Expect selected items to hold tags: array of ids or names; normalize to string ids via slug
    const raw = selected.flatMap(x => x.tags || []);
    const norm = raw.map(v => typeof v === "string" ? slug(v) : slug(v?.id || v?.name || ""));
    return Array.from(new Set(norm.filter(Boolean)));
  }, [selected]);

  const filtered = useMemo(() => filterTags(appTags, startsWithTag(query)), [appTags, query]);
  const exists = useMemo(() => appTags.some(t => t.name.toLowerCase() === startsWithTag(query).toLowerCase()), [appTags, query]);

  const toggleOpen = () => setOpen(o => !o);
  const close = useCallback(() => { setOpen(false); onClose?.(); }, [onClose]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (!wrapRef.current?.contains(e.target)) close(); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, close]);

  // Keyboard
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") close();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); close(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  useEffect(() => { if (open) setTimeout(()=> inputRef.current?.focus(), 0); }, [open]);

  /* ------------------------------ CRUD helpers ------------------------------ */
  const runCreateTag = async (name) => {
    const data = { id: slug(name), name, color: pickColor(appTags.length), emoji: "🏷️" };
    let created = data;
    try {
      if (tags?.length) created = await createTag(data);
      else {
        const next = uniqBy([...fallbackTags, data], "id");
        setFallbackTags(next); saveFallbackTags(next);
      }
      eventBus.emit("tags.created", { tag: created });
      return created;
    } catch (e) { console.error(e); return null; }
  };

  const runRenameTag = async (id, name) => {
    try {
      if (tags?.length) await renameTag(id, name);
      else {
        const next = fallbackTags.map(t => t.id === id ? { ...t, name } : t);
        setFallbackTags(next); saveFallbackTags(next);
      }
      eventBus.emit("tags.renamed", { id, name });
    } catch (e) { console.error(e); }
  };

  const runRecolorTag = async (id, color) => {
    try {
      if (tags?.length) await recolorTag(id, color);
      else {
        const next = fallbackTags.map(t => t.id === id ? { ...t, color } : t);
        setFallbackTags(next); saveFallbackTags(next);
      }
      eventBus.emit("tags.recolored", { id, color });
    } catch (e) { console.error(e); }
  };

  const runDeleteTag = async (id) => {
    try {
      if (tags?.length) await deleteTag(id);
      else {
        const next = fallbackTags.filter(t => t.id !== id);
        setFallbackTags(next); saveFallbackTags(next);
      }
      eventBus.emit("tags.deleted", { id });
    } catch (e) { console.error(e); }
  };

  const applyToSelection = async (nextSelectedIds) => {
    // Compute delta
    const added = nextSelectedIds.filter(id => !selectedTagIds.includes(id));
    const removed = selectedTagIds.filter(id => !nextSelectedIds.includes(id));

    try {
      if (tags?.length) {
        if (added.length) await assignTags(selected, added);
        if (removed.length) await removeTags(selected, removed);
      }
      // Fallback: just emit (caller updates)
      eventBus.emit("tags.applied", { items: selected, added, removed });
      onApply?.({ items: selected, added, removed });
    } catch (e) { console.error(e); }
  };

  /* ------------------------------ Suggest (AI) ------------------------------- */
  const suggestAI = async () => {
    if (!automation?.runTemplate) return;
    try {
      setSuggesting(true);
      const res = await automation.runTemplate("tags.suggest.forSelection", {
        mode, selected,
        existing: appTags.map(t => ({ id: t.id, name: t.name })),
        context,
      });
      const names = (res?.tags || []).map(x => (x.name || x)).filter(Boolean);
      if (!names.length) return;

      // Ensure tags exist, collect their ids, then apply
      const ensured = [];
      for (const n of names) {
        const found = appTags.find(t => t.name.toLowerCase() === n.toLowerCase());
        if (found) ensured.push(found.id);
        else {
          const created = await runCreateTag(n);
          if (created) ensured.push(created.id);
        }
      }
      await applyToSelection(Array.from(new Set([...selectedTagIds, ...ensured])));
    } catch (e) {
      console.warn("[TaggingPanel] AI suggest failed", e);
    } finally { setSuggesting(false); }
  };

  /* --------------------------------- Render --------------------------------- */
  const onToggle = async (tag) => {
    const set = new Set(selectedTagIds);
    if (set.has(tag.id)) set.delete(tag.id); else set.add(tag.id);
    await applyToSelection(Array.from(set));
  };

  const onCreate = async () => {
    const name = startsWithTag(query);
    if (!name || exists) return;
    const created = await runCreateTag(name);
    if (!created) return;
    await applyToSelection(Array.from(new Set([...selectedTagIds, created.id])));
    setQuery("");
  };

  return (
    <div className="relative inline-block" ref={wrapRef}>
      <button
        type="button"
        onClick={toggleOpen}
        className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-md border bg-white hover:bg-gray-50 ${buttonClassName}`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Tag className="w-4 h-4" />
        <span>{buttonLabel}</span>
      </button>

      {open && (
        <div className={`absolute ${align === "right" ? "right-0" : "left-0"} mt-2 z-[70] w-[92vw] ${width}`}>
          <div className="rounded-lg border bg-white shadow-xl overflow-hidden">
            {/* Header */}
            <div className="flex items-center gap-2 px-3 py-2 border-b bg-gray-50">
              <div className="text-sm font-medium">Tags</div>
              <div className="ml-auto flex items-center gap-1">
                {automation?.runTemplate && (
                  <button
                    className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded border ${suggesting ? "opacity-60" : "hover:bg-white"}`}
                    onClick={suggestAI}
                    disabled={suggesting}
                    title="Suggest tags (AI)"
                  >
                    <Sparkles className="w-3.5 h-3.5" /> Suggest
                  </button>
                )}
                <button className="p-1 rounded hover:bg-gray-100" onClick={close} aria-label="Close">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Search/Create */}
            <div className="px-3 py-2 border-b">
              <div className="flex items-center gap-2">
                <Search className="w-4 h-4 text-gray-400" />
                <input
                  ref={inputRef}
                  className="w-full text-sm outline-none"
                  placeholder="Search or create (type and press Enter)…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && startsWithTag(query) && !exists) onCreate();
                  }}
                />
                {startsWithTag(query) && !exists && (
                  <button onClick={onCreate} className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded border hover:bg-gray-50">
                    <Plus className="w-3.5 h-3.5" /> Create “{startsWithTag(query)}”
                  </button>
                )}
              </div>
            </div>

            {/* Tag list */}
            <ul role="menu" className="max-h-[60vh] overflow-auto py-1">
              {filtered.map((t) => {
                const active = selectedTagIds.includes(t.id);
                return (
                  <li key={t.id} role="menuitem" className="group">
                    <div className="flex items-center justify-between gap-2 px-3 py-2 hover:bg-indigo-50">
                      <button
                        onClick={() => onToggle(t)}
                        className="flex items-center gap-3"
                        title={t.name}
                      >
                        <span className="inline-flex items-center justify-center w-4 h-4 rounded-sm border" style={{ backgroundColor: t.color }} />
                        <span className="text-sm">{t.emoji ? `${t.emoji} ` : ""}{t.name}</span>
                      </button>

                      <div className="flex items-center gap-2">
                        {active && <Check className="w-4 h-4 text-indigo-600" />}
                        {/* Inline edit controls (show on hover) */}
                        <div className="opacity-0 group-hover:opacity-100 transition-opacity inline-flex items-center gap-1">
                          <button
                            className={paletteClass}
                            title="Rename"
                            onClick={() => setEditingId(t.id)}
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                          </button>
                          <ColorDropdown current={t.color} onPick={(c) => runRecolorTag(t.id, c)} />
                          <button
                            className={paletteClass}
                            title="Delete tag"
                            onClick={() => runDeleteTag(t.id)}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                    {editingId === t.id && (
                      <RenameRow
                        initial={t.name}
                        onDone={async (val) => { await runRenameTag(t.id, val); setEditingId(null); }}
                        onCancel={() => setEditingId(null)}
                      />
                    )}
                  </li>
                );
              })}
              {filtered.length === 0 && (
                <li className="px-3 py-4 text-sm text-gray-500">No tags match. Press Enter to create “{startsWithTag(query)}”.</li>
              )}
            </ul>

            {/* Footer */}
            <div className="px-3 py-2 border-t text-[11px] text-gray-500 flex items-center justify-between">
              <span>Tip: Prefix with <kbd className="px-1.5 py-0.5 border rounded bg-white">#</kbd> if you like — we’ll ignore it.</span>
              <span><kbd className="px-1.5 py-0.5 border rounded bg-white">Esc</kbd> closes · <kbd className="px-1.5 py-0.5 border rounded bg-white">Ctrl/⌘</kbd> + <kbd className="px-1.5 py-0.5 border rounded bg-white">K</kbd> hides</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* --------------------------------- Pieces ---------------------------------- */
function RenameRow({ initial, onDone, onCancel }) {
  const [val, setVal] = useState(initial || "");
  return (
    <div className="px-3 pb-2">
      <div className="flex items-center gap-2">
        <Hash className="w-4 h-4 text-gray-400" />
        <input
          className="w-full text-sm border rounded px-2 py-1"
          value={val}
          onChange={(e)=> setVal(e.target.value)}
          onKeyDown={(e)=> {
            if (e.key === "Enter") onDone?.(val.trim());
            if (e.key === "Escape") onCancel?.();
          }}
          autoFocus
        />
        <button className="text-xs px-2 py-1 rounded border hover:bg-gray-50" onClick={()=> onDone?.(val.trim())}>Save</button>
        <button className="text-xs px-2 py-1 rounded border hover:bg-gray-50" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function ColorDropdown({ current, onPick }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button className={paletteClass} onClick={()=> setOpen(o=> !o)} title="Color">
        <Palette className="w-3.5 h-3.5" />
      </button>
      {open && (
        <div className="absolute right-0 mt-1 z-[80] rounded-md border bg-white shadow p-2 grid grid-cols-9 gap-1">
          {colors.map(c => (
            <button
              key={c}
              className="w-5 h-5 rounded border"
              style={{ backgroundColor: c }}
              onClick={() => { onPick?.(c); setOpen(false); }}
              aria-label={`Color ${c}`}
            />
          ))}
          <button className="col-span-9 text-[11px] mt-1 px-2 py-1 rounded border hover:bg-gray-50" onClick={()=> setOpen(false)}>Close</button>
        </div>
      )}
    </div>
  );
}

/* --------------------------------- Notes -----------------------------------
Usage:

<TaggingPanel
  mode="recipes"                // or "ingredients"
  selected={selectedCards}      // array of selected items; each can have tags: []
  onApply={({ added, removed, items }) => console.log({ added, removed, items })}
  buttonLabel="Tag…"
  size="md"                     // sm | md | lg
  align="right"
/>

Events emitted:
- tags.created { tag }
- tags.renamed { id, name }
- tags.recolored { id, color }
- tags.deleted { id }
- tags.applied { items, added, removed }

Automation (optional):
- tags.suggest.forSelection { mode, selected, existing:[{id,name}], context }

If TagStore isn’t present, component uses localStorage for tags so the UI remains functional in preview/sandbox.
--------------------------------------------------------------------------- */
