// src/components/cleaning/DraggableTaskBank.jsx
import React, { useMemo, useState, useEffect, useCallback } from "react";
import { Draggable, Droppable } from "@hello-pangea/dnd";
import {
  Search,
  Filter,
  X,
  Timer,
  Wrench,
  Droplet,
  AlertTriangle,
  Info,
  Sparkles,
} from "lucide-react";

/**
 * DraggableTaskBank — dynamic, searchable, inventory-aware task palette
 * -----------------------------------------------------------------------------
 * Backward compatible props:
 *  - taskBank: Array<{
 *      id: string, name: string,
 *      estMin?: number,
 *      supplies?: string[],
 *      tools?: string[],
 *      deep?: boolean,
 *      zoneId?: string,
 *      tags?: string[]
 *    }>
 *
 * New optional props (all safe to omit):
 *  - title?: string                         // defaults to "🧰 Task Bank"
 *  - searchable?: boolean                   // default true
 *  - filterable?: boolean                   // default true
 *  - defaultDeepOnly?: boolean              // default false
 *  - inventory?: Array<{key|id:string, qty:number}>   // for supply badges
 *  - equipment?: Array<{key|id:string, qty?:number}>  // for tool badges
 *  - onClickTask?: (task) => void
 *  - onEditTask?: (task) => void
 *  - renderTaskMeta?: (task) => ReactNode   // custom metadata renderer
 *
 * UX inspiration: Linear/Trello palettes — fast scanning, compact badges,
 * keyboard-friendly, subtle affordances.
 */

function keyOf(x) { return (x && (x.key || x.id)) || ""; }
function setFrom(list = []) { const s = new Set(); list.forEach((x) => s.add(keyOf(x))); return s; }
function prettyKey(k = "") { return k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()); }

function computeMissing(task = {}, invSet = new Set(), equipSet = new Set()) {
  const supplies = Array.isArray(task.supplies) ? task.supplies : [];
  const tools = Array.isArray(task.tools) ? task.tools : [];
  return {
    missingSupplies: supplies.filter((k) => !invSet.has(k)).map((k) => ({ key: k, name: prettyKey(k) })),
    missingTools: tools.filter((k) => !equipSet.has(k)).map((k) => ({ key: k, name: prettyKey(k) })),
  };
}

function Badge({ icon: Icon, title, children }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] leading-tight
                 border-slate-200 text-slate-600 bg-slate-50"
      title={title}
      aria-label={title}
    >
      {Icon ? <Icon size={12} aria-hidden /> : null}
      {children}
    </span>
  );
}

export default function DraggableTaskBank({
  taskBank,
  title = "🧰 Task Bank",
  searchable = true,
  filterable = true,
  defaultDeepOnly = false,
  inventory = [],
  equipment = [],
  onClickTask,
  onEditTask,
  renderTaskMeta,
}) {
  const invSet = useMemo(() => setFrom(inventory), [inventory]);
  const equipSet = useMemo(() => setFrom(equipment), [equipment]);

  // UI state (persisted to localStorage to feel “sticky” like well-executed sites)
  const [q, setQ] = useState(() => {
    try { return localStorage.getItem("taskBank.q") || ""; } catch { return ""; }
  });
  const [deepOnly, setDeepOnly] = useState(() => {
    try {
      const fromStore = localStorage.getItem("taskBank.deepOnly");
      return fromStore == null ? defaultDeepOnly : JSON.parse(fromStore);
    } catch { return defaultDeepOnly; }
  });
  const [showMissingOnly, setShowMissingOnly] = useState(() => {
    try { return JSON.parse(localStorage.getItem("taskBank.missingOnly") || "false"); } catch { return false; }
  });

  useEffect(() => { try { localStorage.setItem("taskBank.q", q); } catch {} }, [q]);
  useEffect(() => { try { localStorage.setItem("taskBank.deepOnly", JSON.stringify(deepOnly)); } catch {} }, [deepOnly]);
  useEffect(() => { try { localStorage.setItem("taskBank.missingOnly", JSON.stringify(showMissingOnly)); } catch {} }, [showMissingOnly]);

  const filtered = useMemo(() => {
    const text = q.trim().toLowerCase();
    return (Array.isArray(taskBank) ? taskBank : []).filter((t) => {
      if (deepOnly && !t.deep) return false;

      // inventory/equipment gating
      const gaps = computeMissing(t, invSet, equipSet);
      if (showMissingOnly && !gaps.missingSupplies.length && !gaps.missingTools.length) return false;

      if (!text) return true;
      const hay = [
        t.name,
        ...(t.tags || []),
        ...(t.supplies || []),
        ...(t.tools || []),
        t.zoneId || "",
      ].join(" ").toLowerCase();
      return hay.includes(text);
    });
  }, [taskBank, q, deepOnly, showMissingOnly, invSet, equipSet]);

  const totalMin = useMemo(
    () => filtered.reduce((a, t) => a + (Number(t.estMin) || 0), 0),
    [filtered]
  );

  const renderMeta = useCallback((task) => {
    if (typeof renderTaskMeta === "function") return renderTaskMeta(task);

    const est = Number(task.estMin) || 0;
    const needs = computeMissing(task, invSet, equipSet);
    const hasMissing = needs.missingSupplies.length || needs.missingTools.length;

    return (
      <div className="flex flex-wrap items-center gap-2 mt-1">
        {est > 0 ? <Badge icon={Timer} title={`Estimated ${est} min`}>{est}m</Badge> : null}
        {Array.isArray(task.tools) && task.tools.length ? (
          <Badge icon={Wrench} title={`${task.tools.length} tool(s)`}>{task.tools.length}</Badge>
        ) : null}
        {Array.isArray(task.supplies) && task.supplies.length ? (
          <Badge icon={Droplet} title={`${task.supplies.length} supply item(s)`}>{task.supplies.length}</Badge>
        ) : null}
        {hasMissing ? (
          <Badge icon={AlertTriangle} title="Requirements missing">
            {needs.missingTools.length ? `${needs.missingTools.length} tool` : ""}
            {needs.missingTools.length && needs.missingSupplies.length ? " • " : ""}
            {needs.missingSupplies.length ? `${needs.missingSupplies.length} supply` : ""}
          </Badge>
        ) : null}
      </div>
    );
  }, [invSet, equipSet, renderTaskMeta]);

  return (
    <Droppable droppableId="taskBank" isDropDisabled>
      {(provided) => (
        <div
          className="rounded-xl border bg-stone-50 p-4"
          ref={provided.innerRef}
          {...provided.droppableProps}
          aria-label="Task bank palette"
        >
          {/* Header: title + roll-up */}
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <h3 className="font-semibold text-stone-800">{title}</h3>
              <span className="text-xs text-stone-500">
                • {filtered.length} task{filtered.length !== 1 ? "s" : ""}
              </span>
              {totalMin > 0 ? (
                <span className="text-xs text-stone-500">• {totalMin} min</span>
              ) : null}
            </div>
            <Sparkles size={16} className="text-amber-500" aria-hidden />
          </div>

          {/* Controls: search + filters */}
          {(searchable || filterable) && (
            <div className="flex flex-wrap items-center gap-2 mb-3">
              {searchable && (
                <label className="relative flex-1 min-w-[180px]" aria-label="Search task bank">
                  <Search
                    size={14}
                    className="absolute left-2 top-1/2 -translate-y-1/2 text-stone-400"
                    aria-hidden
                  />
                  <input
                    type="text"
                    className="w-full pl-7 pr-6 py-1.5 text-sm rounded-md border border-stone-200 bg-white"
                    placeholder="Search by name, tag, zone, supply, or tool…"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                  />
                  {q ? (
                    <button
                      className="absolute right-1 top-1/2 -translate-y-1/2 p-1 text-stone-400 hover:text-stone-600"
                      onClick={() => setQ("")}
                      aria-label="Clear search"
                    >
                      <X size={14} />
                    </button>
                  ) : null}
                </label>
              )}
              {filterable && (
                <div className="flex items-center gap-2 text-xs">
                  <span className="inline-flex items-center gap-1 text-stone-500">
                    <Filter size={12} /> Filters:
                  </span>
                  <label className="inline-flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={deepOnly}
                      onChange={(e) => setDeepOnly(e.target.checked)}
                    />
                    Deep-only
                  </label>
                  <label className="inline-flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={showMissingOnly}
                      onChange={(e) => setShowMissingOnly(e.target.checked)}
                    />
                    Show missing reqs
                  </label>
                </div>
              )}
            </div>
          )}

          {/* Items */}
          {filtered.length === 0 ? (
            <EmptyState query={q} />
          ) : (
            filtered.map((task, index) => (
              <Draggable key={task.id} draggableId={task.id} index={index}>
                {(dragProvided, snapshot) => (
                  <div
                    ref={dragProvided.innerRef}
                    {...dragProvided.draggableProps}
                    {...dragProvided.dragHandleProps}
                    className={`bg-white px-3 py-2 mb-2 rounded border cursor-move
                                ${snapshot.isDragging ? "shadow-md border-amber-300" : "shadow-sm border-stone-200"}`}
                    role="button"
                    tabIndex={0}
                    onClick={onClickTask ? () => onClickTask(task) : undefined}
                    onKeyDown={(e) => {
                      if ((e.key === "Enter" || e.key === " ") && onClickTask) {
                        e.preventDefault();
                        onClickTask(task);
                      }
                    }}
                    aria-label={`${task.name}${task.estMin ? `, ${task.estMin} minutes` : ""}`}
                    title="Drag to a day"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-stone-800 truncate">{task.name}</span>
                          {task.deep ? (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-200">
                              DEEP
                            </span>
                          ) : null}
                          {Array.isArray(task.tags) && task.tags.length ? (
                            <span className="text-[10px] px-1 py-0.5 rounded bg-stone-50 text-stone-600 border border-stone-200 truncate max-w-[120px]">
                              {task.tags.slice(0, 2).join(" • ")}
                              {task.tags.length > 2 ? " +" + (task.tags.length - 2) : ""}
                            </span>
                          ) : null}
                        </div>
                        {/* Meta badges */}
                        {renderMeta(task)}
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        {onEditTask ? (
                          <button
                            className="text-stone-500 hover:text-stone-700"
                            onClick={(e) => { e.stopPropagation(); onEditTask(task); }}
                            aria-label="Task details"
                            title="Details"
                          >
                            <Info size={16} />
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                )}
              </Draggable>
            ))
          )}

          {provided.placeholder}
        </div>
      )}
    </Droppable>
  );
}

function EmptyState({ query }) {
  return (
    <div
      className="rounded-md border border-stone-200 bg-white text-xs text-stone-500 p-3"
      role="status"
      aria-live="polite"
    >
      {query
        ? <>No tasks match <span className="font-medium">“{query}”</span>. Try different keywords.</>
        : <>No tasks to show yet. Add tasks or import from your routines.</>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Tiny self-tests (run once in dev-like environments) */
(function runSelfTests() {
  try {
    const invSet = setFrom([{ key: "sr_all_purpose", qty: 1 }]);
    const eqSet = setFrom([{ key: "tl_microfiber", qty: 4 }, { key: "tl_bucket", qty: 1 }]);
    const task = {
      id: "t1",
      name: "Fridge Deep Clean",
      estMin: 40,
      deep: true,
      supplies: ["sr_all_purpose", "sr_powder_scrub"],
      tools: ["tl_microfiber", "tl_bucket", "tl_squeegee"],
      tags: ["kitchen", "fridge"],
    };
    const gaps = computeMissing(task, invSet, eqSet);
    console.assert(gaps.missingSupplies.length === 1 && gaps.missingSupplies[0].key === "sr_powder_scrub", "[TEST] detects missing supply");
    console.assert(gaps.missingTools.length === 1 && gaps.missingTools[0].key === "tl_squeegee", "[TEST] detects missing tool");

    const bank = [
      task,
      { id: "t2", name: "Baseboards pass", estMin: 20, deep: false, tools: ["tl_microfiber"], tags: ["common"] },
    ];
    const q = "fridge";
    const filtered = bank.filter((t) => {
      const hay = [t.name, ...(t.tags || []), ...(t.supplies || []), ...(t.tools || []), t.zoneId || ""].join(" ").toLowerCase();
      return hay.includes(q);
    });
    console.assert(filtered.length === 1 && filtered[0].id === "t1", "[TEST] search filter by keyword");
  } catch (e) {
    if (typeof console !== "undefined") console.warn("DraggableTaskBank self-tests skipped/failed:", e?.message || e);
  }
})();
