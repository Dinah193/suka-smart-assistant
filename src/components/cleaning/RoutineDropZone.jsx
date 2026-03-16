// C:\Users\larho\suka-smart-assistant\src\components\cleaning\RoutineDropZone.jsx
/**
 * RoutineDropZone
 * -----------------------------------------------------------------------------
 * Build fix:
 *  - Removes dependency on "@hello-pangea/dnd" (not resolving in prod build)
 *  - Uses react-dnd (already present in your build output)
 *
 * Purpose:
 *  - A resilient drop target for routine tasks/cards.
 *  - Works as a standalone drop zone OR can wrap children.
 *
 * Notes:
 *  - We embed our own DndProvider (HTML5) to avoid “missing DndProvider” runtime errors.
 *  - Nested providers are OK. This keeps the component safe anywhere it’s used.
 */

import React, { useMemo } from "react";
import { DndProvider, useDrop } from "react-dnd";
import { HTML5Backend } from "react-dnd-html5-backend";

const DEFAULT_ACCEPT = [
  "ROUTINE_TASK",
  "ROUTINE_ITEM",
  "TASK",
  "CARD",
  "RECIPE_CARD",
];

function coerceArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function isFn(x) {
  return typeof x === "function";
}

function RoutineDropZoneCore({
  id = "routine-dropzone",
  accept = DEFAULT_ACCEPT,
  disabled = false,
  canDropWhen = null, // (item, monitor) => boolean
  onDrop = null, // (item, monitor) => void
  onHover = null, // (item, monitor) => void
  className = "",
  style,
  children,
  label = "Drop here",
  hint = "Drag an item onto this zone",
  activeText = "Release to drop",
  disabledText = "Drop disabled",
  "aria-label": ariaLabel,
}) {
  const acceptList = useMemo(() => coerceArray(accept), [accept]);

  const [{ isOver, canDrop }, dropRef] = useDrop(
    () => ({
      accept: acceptList,
      canDrop: (item, monitor) => {
        if (disabled) return false;
        if (isFn(canDropWhen)) {
          try {
            return !!canDropWhen(item, monitor);
          } catch {
            return false;
          }
        }
        return true;
      },
      hover: (item, monitor) => {
        if (disabled) return;
        if (isFn(onHover)) {
          try {
            onHover(item, monitor);
          } catch {
            // ignore
          }
        }
      },
      drop: (item, monitor) => {
        if (disabled) return;
        // Avoid double-drop bubbling if nested drop zones exist
        if (monitor.didDrop()) return;

        if (isFn(onDrop)) {
          try {
            onDrop(item, monitor);
          } catch {
            // ignore
          }
        }
      },
      collect: (monitor) => ({
        isOver: monitor.isOver({ shallow: true }),
        canDrop: monitor.canDrop(),
      }),
    }),
    [acceptList, disabled, canDropWhen, onDrop, onHover]
  );

  const state = disabled
    ? "disabled"
    : isOver && canDrop
    ? "active"
    : canDrop
    ? "ready"
    : "idle";

  const base =
    "w-full rounded-xl border p-4 transition-colors select-none " +
    "flex items-center justify-center text-sm";

  const stateClass =
    state === "disabled"
      ? "bg-slate-50 border-slate-200 text-slate-400"
      : state === "active"
      ? "bg-emerald-50 border-emerald-300 text-emerald-800"
      : state === "ready"
      ? "bg-amber-50 border-amber-300 text-amber-900"
      : "bg-white border-slate-200 text-slate-600";

  const text =
    state === "disabled"
      ? disabledText
      : state === "active"
      ? activeText
      : label;

  return (
    <div
      ref={dropRef}
      id={id}
      className={`${base} ${stateClass} ${className}`}
      style={style}
      role="region"
      aria-label={ariaLabel || "Routine drop zone"}
      aria-disabled={disabled ? "true" : "false"}
      title={disabled ? disabledText : hint}
    >
      <div className="w-full">
        <div className="font-medium">{text}</div>
        {hint ? (
          <div className="mt-1 text-[12px] opacity-80">
            {disabled ? "" : hint}
          </div>
        ) : null}
        {children ? <div className="mt-3">{children}</div> : null}
      </div>
    </div>
  );
}

/**
 * Public component
 * - Wraps in a DndProvider so this file never explodes if used outside an existing provider.
 */
export default function RoutineDropZone(props) {
  return (
    <DndProvider backend={HTML5Backend}>
      <RoutineDropZoneCore {...props} />
    </DndProvider>
  );
}

export { RoutineDropZoneCore };
