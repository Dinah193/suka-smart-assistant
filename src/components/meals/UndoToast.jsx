// src/components/meals/UndoToast.jsx
// A dynamic, accessible Undo/Redo toast for Suka's meals UI.
// - Keyboard shortcuts: Ctrl/⌘+Z (undo), Ctrl/⌘+Y or Ctrl/⌘+Shift+Z (redo)
// - Shows last action label, remaining undo/redo counts, and optional peek preview
// - Auto-hide with pause-on-hover; ARIA live announcements
// - No alias imports; pure React + Tailwind utility classes

import React, { useEffect, useMemo, useRef, useState } from "react";

const cx = (...xs) => xs.filter(Boolean).join(" ");

/**
 * Props
 * - canUndo: boolean
 * - canRedo: boolean
 * - onUndo: () => void
 * - onRedo: () => void
 * - lastActionLabel?: string  // description of last committed action, e.g., "Added tag 'Fish' to Tue Dinner"
 * - historyLen?: number       // undo stack length
 * - futureLen?: number        // redo stack length
 * - autoHideMs?: number       // default 4000ms
 * - position?: "bottom-right" | "bottom-left" | "top-right" | "top-left"
 * - compact?: boolean         // small footprint style
 * - onPeek?: (direction: "undo" | "redo") => React.ReactNode | void  // optional hover preview renderer
 */
export default function UndoToast({
  canUndo = false,
  canRedo = false,
  onUndo,
  onRedo,
  lastActionLabel = "",
  historyLen = 0,
  futureLen = 0,
  autoHideMs = 4000,
  position = "bottom-right",
  compact = false,
  onPeek,
}) {
  const [visible, setVisible] = useState(false);
  const [lastAction, setLastAction] = useState("");
  const hoverRef = useRef(false);
  const timerRef = useRef(null);

  // When lastActionLabel changes or new history is pushed, show toast
  useEffect(() => {
    if (!lastActionLabel && !canUndo) return;
    setLastAction(lastActionLabel || (canUndo ? "Change made" : ""));
    setVisible(true);
    scheduleHide();
    // announce via aria-live container
  }, [lastActionLabel, canUndo]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e) => {
      const isMeta = e.metaKey || e.ctrlKey;
      if (!isMeta) return;
      // Redo: Ctrl+Y or Ctrl+Shift+Z
      if ((e.key === "y" || e.key === "Y") && canRedo) {
        e.preventDefault();
        onRedo?.();
        toastAfter("Redo");
        return;
      }
      if ((e.key === "z" || e.key === "Z") && e.shiftKey && canRedo) {
        e.preventDefault();
        onRedo?.();
        toastAfter("Redo");
        return;
      }
      // Undo: Ctrl+Z
      if ((e.key === "z" || e.key === "Z") && canUndo) {
        e.preventDefault();
        onUndo?.();
        toastAfter("Undo");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [canUndo, canRedo, onUndo, onRedo]);

  const toastAfter = (verb) => {
    setLastAction(verb + (lastActionLabel ? `: ${lastActionLabel}` : ""));
    setVisible(true);
    scheduleHide();
  };

  const scheduleHide = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (autoHideMs <= 0) return;
    timerRef.current = setTimeout(() => {
      if (hoverRef.current) return scheduleHide();
      setVisible(false);
    }, autoHideMs);
  };

  // Mouse hover to pause auto-hide
  const onEnter = () => { hoverRef.current = true; if (timerRef.current) clearTimeout(timerRef.current); };
  const onLeave = () => { hoverRef.current = false; scheduleHide(); };

  useEffect(() => () => timerRef.current && clearTimeout(timerRef.current), []);

  const posClass = useMemo(() => {
    const base = "fixed z-40";
    const map = {
      "bottom-right": `${base} bottom-3 right-3`,
      "bottom-left": `${base} bottom-3 left-3`,
      "top-right": `${base} top-3 right-3`,
      "top-left": `${base} top-3 left-3`,
    };
    return map[position] || map["bottom-right"];
  }, [position]);

  const badge = (n) => (
    <span className={cx(
      "inline-flex items-center justify-center rounded-full border border-base-300 bg-base-100",
      compact ? "text-[10px] w-5 h-5" : "text-[11px] w-6 h-6"
    )}>{n}</span>
  );

  const peekContent = (dir) => {
    if (!onPeek) return null;
    const node = onPeek(dir);
    return node ? (
      <div className="absolute -left-2 -top-2 translate-y-[-100%] min-w-[220px] max-w-[80vw] rounded-xl border bg-base-100 shadow p-2 text-xs">
        {node}
      </div>
    ) : null;
  };

  return (
    <div className={posClass} aria-live="polite" aria-atomic="true">
      <div
        className={cx(
          "transition-all duration-200",
          visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2 pointer-events-none"
        )}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
      >
        <div className={cx(
          "rounded-2xl shadow-xl border bg-base-100/95 backdrop-blur p-2",
          compact ? "min-w-[220px]" : "min-w-[280px]"
        )}>
          <div className="flex items-center gap-2">
            <span className="inline-flex w-6 h-6 items-center justify-center rounded-md border text-[11px]">↺</span>
            <div className="flex-1 min-w-0">
              <div className="truncate text-xs">
                {lastAction || (canUndo ? "Change made" : "Nothing to undo")}
              </div>
              <div className="flex items-center gap-2 text-[10px] opacity-70 mt-0.5">
                <span className="inline-flex items-center gap-1">Undo {badge(historyLen)}</span>
                <span className="inline-flex items-center gap-1">Redo {badge(futureLen)}</span>
                <span className="ml-auto hidden sm:inline">Ctrl/⌘+Z · Ctrl/⌘+Y</span>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                className={cx("btn btn-xs", !canUndo && "btn-disabled opacity-50")}
                onClick={() => { if (!canUndo) return; onUndo?.(); toastAfter("Undo"); }}
                aria-disabled={!canUndo}
                title="Undo"
              >Undo</button>
              <button
                className={cx("btn btn-xs", !canRedo && "btn-disabled opacity-50")}
                onClick={() => { if (!canRedo) return; onRedo?.(); toastAfter("Redo"); }}
                aria-disabled={!canRedo}
                title="Redo (Ctrl/⌘+Y)"
              >Redo</button>
            </div>
          </div>
          {/* Optional hover peek */}
          <div className="relative mt-2 flex gap-2 text-[10px]">
            <div className={cx("group relative", !canUndo && "pointer-events-none opacity-50")}
                 onMouseEnter={() => !canUndo || !onPeek ? null : undefined}>
              {canUndo && peekContent("undo")}
              <span className="opacity-70">Hover undo for preview</span>
            </div>
            <div className={cx("group relative ml-auto", !canRedo && "pointer-events-none opacity-50")}
                 onMouseEnter={() => !canRedo || !onPeek ? null : undefined}>
              {canRedo && peekContent("redo")}
              <span className="opacity-70">Hover redo for preview</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------
   Lightweight helpers & tests (non-UI)
   We can't unit test React UI here; instead we test key mapping utilities.
---------------------------------------------------------------------------- */
export function parseKeyCombo(e) {
  return {
    metaOrCtrl: !!(e.metaKey || e.ctrlKey),
    shift: !!e.shiftKey,
    key: (e.key || "").toLowerCase(),
  };
}
export function isUndoCombo(combo) { return combo.metaOrCtrl && combo.key === "z" && !combo.shift; }
export function isRedoCombo(combo) { return combo.metaOrCtrl && (combo.key === "y" || (combo.key === "z" && combo.shift)); }

function assert(name, cond) { if (!cond) throw new Error("Test failed: " + name); }
export function runUndoToastTests() {
  const z = (overrides={}) => ({ key: "z", ctrlKey: true, metaKey: false, shiftKey: false, ...overrides });
  const Zs = (overrides={}) => ({ key: "z", ctrlKey: true, metaKey: false, shiftKey: true, ...overrides });
  const y = (overrides={}) => ({ key: "y", ctrlKey: true, metaKey: false, shiftKey: false, ...overrides });

  assert("parseKeyCombo meta/ctrl", parseKeyCombo(z()).metaOrCtrl === true);
  assert("isUndoCombo true for Ctrl+Z", isUndoCombo(parseKeyCombo(z())) === true);
  assert("isRedoCombo true for Ctrl+Y", isRedoCombo(parseKeyCombo(y())) === true);
  assert("isRedoCombo true for Ctrl+Shift+Z", isRedoCombo(parseKeyCombo(Zs())) === true);
  assert("isUndoCombo false when shift held", isUndoCombo(parseKeyCombo(Zs())) === false);
}

if (typeof process === "undefined" || process?.env?.NODE_ENV !== "production") {
  try { runUndoToastTests(); } catch (e) { console.error("UndoToast tests:", e); }
}
