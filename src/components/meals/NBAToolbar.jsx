// src/components/meals/NBAToolbar.jsx
import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { classNames as cx } from "@/utils/css";

let sabbathGuard;
try { sabbathGuard = require("@/services/guardrails/sabbathGuard").sabbathGuard; } catch {}

/**
 * actions: Array<{
 *   key: string;
 *   label: string;
 *   tooltip?: string;
 *   icon?: React.ReactNode;              // optional left icon
 *   onClick: () => (void | Promise<void>);
 *   disabled?: boolean;
 *   loading?: boolean;                   // external control
 *   intent?: "primary"|"success"|"warning"|"danger"|"ghost"|"outline";
 *   hotkey?: string;                     // e.g., "g", "ctrl+enter"
 *   confirm?: string;                    // if set, shows confirm dialog
 *   guardSabbath?: boolean;              // wrap handler with sabbathGuard if available
 * } >
 *
 * Props:
 * - actions: required
 * - size?: "xs"|"sm"|"md" (default "sm")
 * - maxVisible?: number (fallback cap if ResizeObserver not supported)
 * - align?: "start"|"end" (menu alignment)
 * - dense?: boolean (less gap)
 * - ariaLabel?: string
 */
export default function NBAToolbar({
  actions = [],
  size = "sm",
  maxVisible = 4,
  align = "end",
  dense = false,
  ariaLabel = "Next best actions",
}) {
  const containerRef = useRef(null);
  const [visibleCount, setVisibleCount] = useState(maxVisible);
  const [localLoading, setLocalLoading] = useState({}); // { [key]: boolean }

  // Merge external loading flags
  const mergedActions = useMemo(() => {
    return actions.map(a => ({
      ...a,
      _loading: Boolean(localLoading[a.key] || a.loading),
    }));
  }, [actions, localLoading]);

  // Auto overflow using ResizeObserver (best effort)
  useEffect(() => {
    if (!containerRef.current || typeof ResizeObserver === "undefined") {
      setVisibleCount(Math.min(maxVisible, actions.length));
      return;
    }
    const el = containerRef.current;
    const ro = new ResizeObserver(() => {
      // heuristic: each button ≈ 110–140px; use container width to estimate
      const w = el.clientWidth || 0;
      const approxPer = size === "xs" ? 96 : size === "md" ? 136 : 118;
      const capacity = Math.max(1, Math.floor((w - 40) / approxPer)); // leave room for overflow trigger
      setVisibleCount(Math.min(capacity, actions.length));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [actions.length, size, maxVisible]);

  // Keyboard shortcuts
  useEffect(() => {
    const keymap = new Map();
    for (const a of actions) if (a.hotkey) keymap.set(normalizeHotkey(a.hotkey), a);
    if (!keymap.size) return;

    const handler = (e) => {
      const combo = eventToCombo(e);
      const action = keymap.get(combo);
      if (!action || action.disabled) return;
      e.preventDefault();
      safeInvoke(action);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [actions]);

  const safeInvoke = useCallback(async (action) => {
    if (!action || action.disabled) return;
    if (action.confirm && !window.confirm(action.confirm)) return;

    const runner = async () => {
      const maybePromise = action.onClick?.();
      if (maybePromise && typeof maybePromise.then === "function") {
        setLocalLoading((m) => ({ ...m, [action.key]: true }));
        try { await maybePromise; } finally {
          setLocalLoading((m) => ({ ...m, [action.key]: false }));
        }
      }
    };

    if (action.guardSabbath && sabbathGuard) {
      await sabbathGuard(runner)();
    } else {
      await runner();
    }
  }, []);

  const inline = mergedActions.slice(0, visibleCount);
  const overflow = mergedActions.slice(visibleCount);

  return (
    <div
      ref={containerRef}
      className={cx(
        "flex items-center",
        dense ? "gap-1" : "gap-2",
      )}
      aria-label={ariaLabel}
      role="toolbar"
    >
      {inline.map((a) => (
        <NBABtn
          key={a.key}
          action={a}
          size={size}
          onClick={() => safeInvoke(a)}
        />
      ))}

      {overflow.length > 0 && (
        <OverflowMenu
          items={overflow}
          size={size}
          align={align}
          onSelect={(a) => safeInvoke(a)}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------
 * Button
 * -------------------------------------------*/
function NBABtn({ action, size, onClick }) {
  const intentClass = intentToBtnClass(action.intent, size);
  const content = (
    <>
      {action.icon ? <span className="mr-1.5 inline-flex">{action.icon}</span> : null}
      <span className="truncate">{action.label}</span>
      {action._loading && <Spinner size={size} className="ml-1" />}
    </>
  );

  return (
    <button
      type="button"
      className={cx(intentClass, "whitespace-nowrap")}
      title={action.tooltip || action.label}
      aria-label={action.label}
      aria-disabled={action.disabled || action._loading}
      disabled={action.disabled || action._loading}
      onClick={onClick}
    >
      {content}
    </button>
  );
}

/* ---------------------------------------------
 * Overflow menu (popover)
 * -------------------------------------------*/
function OverflowMenu({ items, onSelect, size, align }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        className={cx(intentToBtnClass("ghost", size), "px-2")}
        title="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        ⋯
      </button>

      {open && (
        <div
          role="menu"
          className={cx(
            "absolute z-30 min-w-44 rounded-xl border border-base-200 bg-base-100 shadow-lg p-1",
            align === "start" ? "left-0 mt-1" : "right-0 mt-1"
          )}
        >
          {items.map((a) => (
            <button
              key={a.key}
              role="menuitem"
              className={cx(
                "w-full text-left px-3 py-2 rounded-lg hover:bg-base-200 focus:bg-base-200 transition",
                a.disabled && "opacity-60 cursor-not-allowed"
              )}
              disabled={a.disabled}
              title={a.tooltip || a.label}
              onClick={() => { setOpen(false); if (!a.disabled) onSelect?.(a); }}
            >
              <div className="flex items-center gap-2">
                {a.icon ? <span className="inline-flex">{a.icon}</span> : <span className="opacity-70">•</span>}
                <span className="flex-1 truncate">{a.label}</span>
                {a._loading && <Spinner size="xs" />}
              </div>
              {a.hotkey && (
                <div className="text-[10px] text-base-content/60 pl-6 mt-0.5">
                  {prettyHotkey(a.hotkey)}
                </div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------
 * Spinner + helpers
 * -------------------------------------------*/
function Spinner({ size = "sm", className }) {
  const dims = size === "xs" ? "w-3 h-3" : size === "md" ? "w-4 h-4" : "w-3.5 h-3.5";
  return (
    <span className={cx("loading loading-spinner", dims, className)} aria-hidden="true" />
  );
}

function intentToBtnClass(intent = "ghost", size = "sm") {
  const sizeCls = size === "xs" ? "btn-xs" : size === "md" ? "btn-md" : "btn-sm";
  const map = {
    primary: `btn btn-primary ${sizeCls}`,
    success: `btn btn-success ${sizeCls}`,
    warning: `btn btn-warning ${sizeCls}`,
    danger:  `btn btn-error ${sizeCls}`,
    outline: `btn btn-outline ${sizeCls}`,
    ghost:   `btn btn-ghost ${sizeCls}`,
  };
  return map[intent] || map.ghost;
}

/* ---------------------------------------------
 * Hotkeys
 * -------------------------------------------*/
function normalizeHotkey(s) {
  return s.trim().toLowerCase().replace(/\s+/g, "");
}
function prettyHotkey(s) {
  const x = s.toLowerCase();
  return x.replace("ctrl", "Ctrl").replace("alt", "Alt").replace("shift", "Shift").replace("+", " + ");
}
function eventToCombo(e) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  const k = e.key?.toLowerCase();
  // Normalize Enter/Escape/etc.
  const printable = (k === "enter" || k === "escape" || k === " ") ? (k === " " ? "space" : k) : k;
  parts.push(printable);
  return parts.join("");
}
