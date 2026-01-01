// src/components/cleaning/RoutineDropZone.jsx
import React, { useMemo, useState, useEffect, useCallback } from "react";
import { Droppable, Draggable } from "@hello-pangea/dnd";
import {
  Trash2,
  GripVertical,
  Timer,
  Wrench,
  Droplet,
  AlertTriangle,
  PlayCircle,
  PauseCircle,
  Info,
} from "lucide-react";

/**
 * RoutineDropZone — dynamic, inventory-aware, Sabbath-friendly drop column
 * -----------------------------------------------------------------------------
 * Backward compatible props:
 *  - day: string (droppableId)
 *  - tasks: Array<{ uid: string, name: string, estMin?: number, supplies?: string[], tools?: string[] }>
 *  - onRemove: (day: string, taskIndex: number) => void
 *
 * New optional props (all safe to omit):
 *  - title?: string                   // custom heading; defaults to `day`
 *  - disabled?: boolean               // disables dropping (e.g., Sabbath)
 *  - highlightSabbath?: boolean       // shows subtle UI cue when disabled for Sabbath
 *  - inventory?: Array<{key|id:string, qty:number}>   // consumables/ingredients
 *  - equipment?: Array<{key|id:string, qty?:number}>  // tools/equipment
 *  - showMeta?: boolean               // show est. time + badges (default true)
 *  - onClickTask?: (task) => void     // click handler
 *  - onEdit?: (task) => void          // edit handler
 *  - renderTaskMeta?: (task) => ReactNode // custom metadata renderer (overrides badges)
 *
 * UX inspiration: Trello/Linear/Notion columns — clear hierarchy, subtle badges, strong a11y.
 */

function prettyName(key = "") {
  // minimal prettifier for snake_case keys
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function byKey(item) {
  return (item && (item.key || item.id)) || "";
}

function listToKeySet(list = []) {
  const s = new Set();
  list.forEach((x) => s.add(byKey(x)));
  return s;
}

function computeMissingForTask(task = {}, invSet = new Set(), equipSet = new Set()) {
  const supplies = Array.isArray(task.supplies) ? task.supplies : [];
  const tools = Array.isArray(task.tools) ? task.tools : [];

  const missingSupplies = supplies.filter((k) => !invSet.has(k)).map((k) => ({ key: k, name: prettyName(k) }));
  const missingTools = tools.filter((k) => !equipSet.has(k)).map((k) => ({ key: k, name: prettyName(k) }));

  return { missingSupplies, missingTools };
}

function Badge({ icon: Icon, children, title }) {
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

export default function RoutineDropZone({
  day,
  tasks,
  onRemove,
  title,
  disabled = false,
  highlightSabbath = false,
  inventory = [],   // consumables
  equipment = [],   // tools
  showMeta = true,
  onClickTask,
  onEdit,
  renderTaskMeta,
}) {
  // Collapsible (remember per day)
  const storageKey = `RoutineDropZone.collapsed:${day}`;
  const [collapsed, setCollapsed] = useState(() => {
    try { return JSON.parse(localStorage.getItem(storageKey) || "false"); } catch { return false; }
  });
  useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify(collapsed)); } catch {} }, [collapsed, storageKey]);

  const invSet = useMemo(() => listToKeySet(inventory), [inventory]);
  const equipSet = useMemo(() => listToKeySet(equipment), [equipment]);

  const totalMin = useMemo(
    () => (Array.isArray(tasks) ? tasks.reduce((a, t) => a + (Number(t.estMin) || 0), 0) : 0),
    [tasks]
  );

  const columnClass = useMemo(() => {
    const base = "rounded-xl p-3 mb-4 border transition-colors";
    if (disabled) {
      return `${base} bg-slate-50 border-slate-200 opacity-75`;
    }
    return `${base} bg-amber-50/60 border-amber-300`;
  }, [disabled]);

  const headerClass = useMemo(() => {
    const base = "flex items-center justify-between mb-2";
    return highlightSabbath && disabled ? `${base} text-emerald-700` : base;
  }, [highlightSabbath, disabled]);

  const renderBadges = useCallback(
    (task) => {
      if (typeof renderTaskMeta === "function") return renderTaskMeta(task);

      const est = Number(task.estMin) || 0;
      const needs = computeMissingForTask(task, invSet, equipSet);
      const hasMissing = needs.missingSupplies.length || needs.missingTools.length;

      return (
        <div className="flex flex-wrap items-center gap-2 mt-1">
          {showMeta && est > 0 ? (
            <Badge icon={Timer} title={`Estimated ${est} min`}>{est}m</Badge>
          ) : null}
          {showMeta && Array.isArray(task.tools) && task.tools.length ? (
            <Badge icon={Wrench} title={`${task.tools.length} tool(s)`}>{task.tools.length}</Badge>
          ) : null}
          {showMeta && Array.isArray(task.supplies) && task.supplies.length ? (
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
    },
    [invSet, equipSet, showMeta, renderTaskMeta]
  );

  return (
    <Droppable droppableId={day} isDropDisabled={disabled}>
      {(dropProvided, dropSnapshot) => (
        <div
          ref={dropProvided.innerRef}
          {...dropProvided.droppableProps}
          className={columnClass}
          aria-disabled={disabled}
          aria-label={`${title || day} drop zone`}
        >
          <div className={headerClass}>
            <div className="flex items-center gap-2">
              <h4 className="text-amber-800 font-semibold">
                {title || day}
              </h4>
              <span className="text-xs text-slate-500">• {tasks.length} task{tasks.length !== 1 ? "s" : ""}</span>
              {totalMin > 0 ? <span className="text-xs text-slate-500">• {totalMin} min</span> : null}
              {disabled && highlightSabbath ? (
                <span className="ml-2 text-[11px] text-emerald-700 inline-flex items-center gap-1">
                  <PauseCircle size={14} /> Sabbath (drop disabled)
                </span>
              ) : null}
            </div>
            <button
              className="text-xs text-slate-600 hover:text-slate-800"
              onClick={() => setCollapsed((c) => !c)}
              aria-expanded={!collapsed}
              title={collapsed ? "Expand" : "Collapse"}
            >
              {collapsed ? "Show" : "Hide"}
            </button>
          </div>

          {!collapsed && tasks.length === 0 ? (
            <EmptyState isDraggingOver={dropSnapshot.isDraggingOver} disabled={disabled} />
          ) : null}

          {!collapsed &&
            tasks.map((task, idx) => (
              <Draggable key={task.uid} draggableId={task.uid} index={idx}>
                {(dragProvided, dragSnapshot) => {
                  const dragging = dragSnapshot.isDragging;
                  return (
                    <div
                      ref={dragProvided.innerRef}
                      {...dragProvided.draggableProps}
                      {...dragProvided.dragHandleProps}
                      className={`bg-white rounded-lg p-2 mb-2 shadow-sm border
                                  ${dragging ? "shadow-md border-amber-300" : "border-slate-200"}`}
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
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <GripVertical size={14} className="text-slate-400" aria-hidden />
                            <span className="font-medium text-slate-800 truncate">{task.name}</span>
                          </div>
                          {renderBadges(task)}
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          {onEdit ? (
                            <button
                              className="text-slate-500 hover:text-slate-700"
                              onClick={(e) => { e.stopPropagation(); onEdit(task); }}
                              title="Details"
                              aria-label="Details"
                            >
                              <Info size={16} />
                            </button>
                          ) : null}
                          <button
                            onClick={(e) => { e.stopPropagation(); onRemove(day, idx); }}
                            className="text-red-500 hover:text-red-600"
                            aria-label={`Remove ${task.name}`}
                            title="Remove"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                }}
              </Draggable>
            ))}

          {dropProvided.placeholder}
        </div>
      )}
    </Droppable>
  );
}

function EmptyState({ isDraggingOver, disabled }) {
  return (
    <div
      className={`rounded-md border text-xs p-3 mb-2
                  ${disabled ? "border-slate-200 text-slate-400 bg-white" : isDraggingOver ? "border-amber-300 text-amber-700 bg-amber-50/50" : "border-slate-200 text-slate-500 bg-white"}`}
      role="status"
      aria-live="polite"
    >
      {disabled ? (
        <div className="flex items-center gap-2">
          <PauseCircle size={14} /> Drop disabled.
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <PlayCircle size={14} /> Drag tasks here to add to this day.
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Tiny self-tests: inventory/tool awareness (runs once in dev) */
(function runSelfTests() {
  try {
    const invSet = listToKeySet([{ key: "sr_all_purpose", qty: 1 }]);
    const eqSet = listToKeySet([{ key: "tl_microfiber", qty: 4 }, { key: "tl_bucket", qty: 1 }]);

    const task = {
      uid: "a1",
      name: "Fridge Deep Clean",
      estMin: 40,
      supplies: ["sr_all_purpose", "sr_powder_scrub"],
      tools: ["tl_microfiber", "tl_bucket", "tl_squeegee"],
    };
    const gaps = computeMissingForTask(task, invSet, eqSet);
    console.assert(gaps.missingSupplies.length === 1 && gaps.missingSupplies[0].key === "sr_powder_scrub", "[TEST] detects missing supply");
    console.assert(gaps.missingTools.length === 1 && gaps.missingTools[0].key === "tl_squeegee", "[TEST] detects missing tool");
  } catch (e) {
    if (typeof console !== "undefined") console.warn("RoutineDropZone self-tests skipped/failed:", e?.message || e);
  }
})();
