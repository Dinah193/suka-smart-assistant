// src/ui/Checklist.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Checklist
 * --------------------------------------------------------------------------
 * Backwards compatible with:
 *  - items: Array<{ id, label, completed }>
 *  - onChange(updatedItems)
 *  - title
 *
 * Enhancements (all optional):
 *  - persistKey: string → saves/restores to localStorage
 *  - allowAdd: boolean (default true) → quick-add input
 *  - allowEdit: boolean (default true) → inline rename on double-click / pencil
 *  - allowRemove: boolean (default true) → delete an item
 *  - allowReorder: boolean (default true) → drag & drop sorting
 *  - searchable: boolean (default true) → quick filter box
 *  - showProgress: boolean (default true) → progress bar + counts
 *  - onToggle(id, nextItem)
 *  - onReorder(nextItems)
 *  - onRemove(id)
 *
 * Items also support (optional) fields now:
 *  - note?: string, tags?: string[], disabled?: boolean, priority?: 1|2|3
 */

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// Shallow-normalize incoming items for safety
function normalize(items) {
  return (Array.isArray(items) ? items : []).map((it) => ({
    id: String(it?.id ?? uid()),
    label: String(it?.label ?? "").trim(),
    completed: !!it?.completed,
    disabled: !!it?.disabled,
    note: it?.note ?? "",
    tags: Array.isArray(it?.tags) ? it.tags : [],
    priority: it?.priority ?? 2,
  }));
}

export default function Checklist({
  items = [],
  onChange = () => {},
  onToggle,
  onReorder,
  onRemove,

  title = "Checklist",

  persistKey,          // e.g., "suka.checklist.preservation"
  allowAdd = true,
  allowEdit = true,
  allowRemove = true,
  allowReorder = true,
  searchable = true,
  showProgress = true,
}) {
  const mountedRef = useRef(false);

  // Hydrate from props or localStorage (persistKey takes precedence)
  const initial = useMemo(() => {
    if (!persistKey) return normalize(items);
    try {
      const raw = localStorage.getItem(persistKey);
      if (raw) return normalize(JSON.parse(raw));
    } catch {}
    return normalize(items);
  }, [items, persistKey]);

  const [checklist, setChecklist] = useState(initial);
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editingText, setEditingText] = useState("");

  // Keep internal list in sync when `items` prop changes and no persistence
  useEffect(() => {
    if (persistKey) return; // persistence is the source of truth
    setChecklist(normalize(items));
  }, [items, persistKey]);

  // Persist to localStorage and notify parent
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    if (persistKey) {
      try {
        localStorage.setItem(persistKey, JSON.stringify(checklist));
      } catch {}
    }
    onChange(checklist);
  }, [checklist, onChange, persistKey]);

  // Filtered view
  const filtered = useMemo(() => {
    if (!query.trim()) return checklist;
    const q = query.trim().toLowerCase();
    return checklist.filter(
      (i) =>
        i.label.toLowerCase().includes(q) ||
        (i.note || "").toLowerCase().includes(q) ||
        (i.tags || []).some((t) => String(t).toLowerCase().includes(q))
    );
  }, [checklist, query]);

  // Progress
  const { total, done } = useMemo(() => {
    const t = checklist.length;
    const d = checklist.filter((i) => i.completed).length;
    return { total: t, done: d };
  }, [checklist]);

  /* ---------------------- item operations ---------------------- */
  const toggleItem = (id) => {
    setChecklist((prev) =>
      prev.map((item) =>
        item.id === id && !item.disabled
          ? { ...item, completed: !item.completed }
          : item
      )
    );
    const nextItem = checklist.find((i) => i.id === id);
    onToggle?.(id, nextItem ? { ...nextItem, completed: !nextItem.completed } : undefined);
  };

  const addItem = (label) => {
    const name = String(label || "").trim();
    if (!name) return;
    const newItem = { id: uid(), label: name, completed: false, tags: [] };
    setChecklist((prev) => [...prev, newItem]);
  };

  const removeItem = (id) => {
    setChecklist((prev) => prev.filter((i) => i.id !== id));
    onRemove?.(id);
  };

  const startEdit = (id, current) => {
    if (!allowEdit) return;
    setEditingId(id);
    setEditingText(current);
  };

  const commitEdit = () => {
    const text = editingText.trim();
    const id = editingId;
    setEditingId(null);
    if (!id) return;
    if (!text) {
      // empty → remove
      if (allowRemove) removeItem(id);
      return;
    }
    setChecklist((prev) =>
      prev.map((i) => (i.id === id ? { ...i, label: text } : i))
    );
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditingText("");
  };

  const clearCompleted = () => {
    setChecklist((prev) => prev.filter((i) => !i.completed));
  };

  const toggleAll = (checked) => {
    setChecklist((prev) => prev.map((i) => (i.disabled ? i : { ...i, completed: checked })));
  };

  /* ---------------------- drag & drop reorder ---------------------- */
  const dragIdRef = useRef(null);

  const onDragStart = (e, id) => {
    if (!allowReorder) return;
    dragIdRef.current = id;
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", id); } catch {}
  };

  const onDragOver = (e) => {
    if (!allowReorder) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };

  const onDrop = (e, overId) => {
    if (!allowReorder) return;
    e.preventDefault();
    const fromId = dragIdRef.current;
    dragIdRef.current = null;
    if (!fromId || fromId === overId) return;

    setChecklist((prev) => {
      const fromIdx = prev.findIndex((i) => i.id === fromId);
      const toIdx = prev.findIndex((i) => i.id === overId);
      if (fromIdx < 0 || toIdx < 0) return prev;
      const next = prev.slice();
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      onReorder?.(next);
      return next;
    });
  };

  /* ---------------------- UI helpers ---------------------- */
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div className="bg-white border border-stone-200 rounded p-4 shadow-md w-full max-w-lg">
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-xl font-semibold text-stone-800 flex-1">{title}</h2>

        {/* Toggle-all checkbox (indeterminate when some but not all) */}
        {total > 0 && (
          <div className="flex items-center gap-2">
            <input
              id="chk-all"
              type="checkbox"
              className="w-4 h-4 accent-emerald-600"
              checked={done === total}
              ref={(el) => {
                if (el) el.indeterminate = done > 0 && done < total;
              }}
              onChange={(e) => toggleAll(e.target.checked)}
              aria-label="Toggle all"
            />
          </div>
        )}
      </div>

      {/* Progress */}
      {showProgress && (
        <div className="mb-3">
          <div className="w-full bg-stone-200 rounded-full h-2 overflow-hidden">
            <div
              className="bg-emerald-500 h-2 transition-all duration-500 ease-out"
              style={{ width: `${pct}%` }}
              aria-hidden
            />
          </div>
          <div className="mt-1 text-xs text-stone-500 flex justify-between">
            <span>
              {done}/{total} done
            </span>
            <span>{pct}%</span>
          </div>
        </div>
      )}

      {/* Search / Quick add */}
      {(searchable || allowAdd) && (
        <div className="flex items-center gap-2 mb-3">
          {searchable && (
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter…"
              className="flex-1 border border-stone-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
              aria-label="Filter checklist"
            />
          )}
          {allowAdd && (
            <QuickAdd onAdd={addItem} />
          )}
        </div>
      )}

      {/* List */}
      <ul className="space-y-2" role="list" aria-live="polite">
        {filtered.map((item) => {
          const checkboxId = `item-${item.id}`;
          const isEditing = editingId === item.id;
          return (
            <li
              key={item.id}
              role="listitem"
              className="flex items-start gap-3 p-2 rounded hover:bg-stone-50 animate-fade-in-up"
              draggable={allowReorder}
              onDragStart={(e) => onDragStart(e, item.id)}
              onDragOver={onDragOver}
              onDrop={(e) => onDrop(e, item.id)}
            >
              <input
                id={checkboxId}
                type="checkbox"
                checked={!!item.completed}
                disabled={!!item.disabled}
                onChange={() => toggleItem(item.id)}
                className="mt-0.5 w-5 h-5 text-green-600 rounded focus:ring-2 focus:ring-green-500 accent-emerald-600"
              />

              <div className="flex-1 min-w-0">
                {!isEditing ? (
                  <label
                    htmlFor={checkboxId}
                    className={`block text-sm break-words ${
                      item.completed ? "line-through text-stone-400" : "text-stone-700"
                    }`}
                    onDoubleClick={() => startEdit(item.id, item.label)}
                    title={item.note || undefined}
                  >
                    {item.label}
                  </label>
                ) : (
                  <input
                    autoFocus
                    type="text"
                    value={editingText}
                    onChange={(e) => setEditingText(e.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitEdit();
                      if (e.key === "Escape") cancelEdit();
                    }}
                    className="w-full text-sm border border-stone-300 rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                )}

                {/* Note / tags (optional) */}
                {(item.note || (item.tags && item.tags.length)) && (
                  <div className="mt-1 flex items-center gap-2 flex-wrap">
                    {item.note ? (
                      <span className="text-xs text-stone-500">{item.note}</span>
                    ) : null}
                    {(item.tags || []).map((t) => (
                      <span
                        key={t}
                        className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2">
                {allowEdit && !isEditing && (
                  <button
                    className="text-xs px-2 py-1 rounded border border-stone-300 hover:bg-stone-100"
                    onClick={() => startEdit(item.id, item.label)}
                    aria-label={`Edit ${item.label}`}
                  >
                    Edit
                  </button>
                )}
                {allowRemove && (
                  <button
                    className="text-xs px-2 py-1 rounded border border-stone-300 text-rose-600 hover:bg-rose-50"
                    onClick={() => removeItem(item.id)}
                    aria-label={`Remove ${item.label}`}
                  >
                    Remove
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {/* Footer actions */}
      <div className="mt-4 flex items-center justify-between">
        <div className="text-xs text-stone-500">
          {filtered.length} shown {filtered.length !== checklist.length ? `of ${checklist.length}` : ""}
        </div>
        <div className="flex items-center gap-2">
          <button
            className="text-xs px-2 py-1 rounded border border-stone-300 hover:bg-stone-100"
            onClick={clearCompleted}
            disabled={!checklist.some((i) => i.completed)}
          >
            Clear completed
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------------- QuickAdd subcomponent ---------------------- */
function QuickAdd({ onAdd }) {
  const [val, setVal] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onAdd?.(val);
        setVal("");
      }}
      className="flex items-center gap-2"
      aria-label="Add checklist item"
    >
      <input
        type="text"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        placeholder="Add item…"
        className="border border-stone-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
      />
      <button
        type="submit"
        className="text-xs px-2 py-1 rounded border border-stone-300 bg-emerald-600 text-white hover:bg-emerald-700"
        disabled={!val.trim()}
      >
        Add
      </button>
    </form>
  );
}
