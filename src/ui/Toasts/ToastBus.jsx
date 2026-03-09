/**
 * src/ui/Toasts/ToastBus.jsx
 * -----------------------------------------------------------------------------
 * ToastBus shim
 *
 * Purpose
 * - Centralized, lightweight toast system that:
 *   • renders a portal-based toast stack (top-right)
 *   • exposes imperative helpers to spawn toasts from anywhere
 *   • listens to session lifecycle events and shows contextual toasts
 *   • provides optional action buttons (Pause / Next / Resume) that emit intents
 *
 * How this fits
 * - Mount <ToastBus /> once at the app root (e.g., in App.jsx). Because it sits
 *   at the top of the tree, it survives route changes and continues running in
 *   the background while sessions run in the SessionRunner.
 * - This file acts as a UI shim: it bridges the global eventBus + internal bus
 *   into visible toasts without owning any domain logic.
 *
 * Events
 * - Listens to canonical events from session.events.js:
 *     session.started, session.step.changed, session.paused, session.resumed,
 *     session.completed, session.aborted, session.exported
 * - Emits *optional* control intents for Runner to handle:
 *     session.intent.pause, session.intent.resume, session.intent.next,
 *     session.intent.prev
 *   with payload { type, ts, source, data: { sessionId } }.
 *
 * Accessibility
 * - Uses aria-live="polite" and role="status" for toasts.
 * - Escape closes a toast; close button is keyboard-accessible.
 *
 * © Suka Smart Assistant
 * -----------------------------------------------------------------------------
 */

import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import eventBus from "@/services/events/eventBus";
import { SESSION_EVENTS } from "@/features/session/session.events";

// ------------------------------- Internal Bus --------------------------------

/**
 * Tiny local bus so any module can call `toast(...)` without React context.
 * This is intentionally minimal and UI-agnostic (shim-like).
 */
const _bus = typeof window !== "undefined" ? new EventTarget() : null;

/**
 * Spawn a toast anywhere in the app (imperative).
 *
 *   import { toast } from "@/ui/Toasts/ToastBus";
 *   toast.success("Saved!");
 *
 * @param {Object} opts
 */
export function toast(opts = {}) {
  if (!_bus) return;
  const ev = new CustomEvent("toast:add", { detail: normalizeOpts(opts) });
  _bus.dispatchEvent(ev);
}

/** Convenience helpers */
toast.info = (message, title = "Info", opts = {}) =>
  toast({ ...opts, kind: "info", message, title });

toast.success = (message, title = "Success", opts = {}) =>
  toast({ ...opts, kind: "success", message, title });

toast.warn = (message, title = "Heads up", opts = {}) =>
  toast({ ...opts, kind: "warn", message, title });

toast.error = (message, title = "Error", opts = {}) =>
  toast({ ...opts, kind: "error", message, title });

// ------------------------------- Styles --------------------------------------

const STYLE = {
  wrap: {
    position: "fixed",
    top: 16,
    right: 16,
    zIndex: 80000,
    display: "grid",
    gap: 10,
    width: "min(440px, 92vw)",
    pointerEvents: "none",
  },
  cardBase: {
    pointerEvents: "auto",
    display: "grid",
    gridTemplateColumns: "auto 1fr auto",
    gap: 10,
    alignItems: "start",
    padding: "12px 12px",
    borderRadius: 12,
    border: "1px solid",
    boxShadow: "0 10px 30px rgba(0,0,0,0.22)",
    background: "#0f1115",
    color: "#e9eef5",
  },
  kinds: {
    info: { borderColor: "#224c8a", background: "#0e1a28" },
    success: { borderColor: "#1f6e49", background: "#0e1914" },
    warn: { borderColor: "#8a5a22", background: "#1a140c" },
    error: { borderColor: "#8a2222", background: "#1a0e0e" },
  },
  icon: {
    width: 22,
    height: 22,
    display: "grid",
    placeItems: "center",
    fontSize: 16,
    opacity: 0.9,
  },
  title: { fontWeight: 800, fontSize: 14, lineHeight: "18px" },
  msg: { fontSize: 13, lineHeight: "18px", opacity: 0.9, marginTop: 2 },
  actionsRow: { display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" },
  btn: {
    all: "unset",
    cursor: "pointer",
    padding: "6px 10px",
    borderRadius: 8,
    border: "1px solid #2a3442",
    background: "#101923",
    color: "#e9eef5",
    fontWeight: 700,
  },
  close: {
    all: "unset",
    cursor: "pointer",
    width: 28,
    height: 28,
    borderRadius: 8,
    display: "grid",
    placeItems: "center",
    border: "1px solid rgba(255,255,255,0.15)",
    color: "rgba(255,255,255,0.8)",
  },
};

// ------------------------------- Utils ---------------------------------------

function iconForKind(kind) {
  switch (kind) {
    case "success":
      return "✅";
    case "warn":
      return "⚠️";
    case "error":
      return "⛔";
    default:
      return "ℹ️";
  }
}

function normalizeOpts(o) {
  const id =
    o.id || `t_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  return {
    id: String(id),
    title: o.title || "",
    message: o.message || "",
    kind: o.kind || "info",
    durationMs: Number.isFinite(o.durationMs) ? o.durationMs : 4800,
    icon: o.icon || iconForKind(o.kind),
    actions: Array.isArray(o.actions) ? o.actions : [],
  };
}

function isoNow() {
  return new Date().toISOString();
}

// ------------------------------ Intent Emitters ------------------------------

/**
 * Bridge toast action intents → global eventBus so SessionRunner (or other
 * shims) can listen and react (pause/resume/next/prev).
 */
function emitIntent(type, data) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({ type, ts: isoNow(), source: "ToastBus", data });
  } catch {
    // no-op
  }
}

// ------------------------------ Session → Toasts -----------------------------

/**
 * Map session lifecycle events into user-friendly toasts.
 * Expects SSA envelope: { type, ts, source, data }.
 */
function handleSessionEvent(evt) {
  if (!evt) return;
  const type = evt.type;
  const data = evt.data || {};

  if (!type) return;

  if (type === SESSION_EVENTS.STARTED) {
    const sessionId = data.sessionId;
    const domain = data.domain;
    toast.success(`Session started (${domain || "unknown"})`, "Let’s go!", {
      durationMs: 2600,
      id: `sess_${sessionId || "unknown"}_start`,
    });
    return;
  }

  if (type === SESSION_EVENTS.STEP_CHANGED) {
    const sessionId = data.sessionId;
    const nextStepIndex = Number(data.nextStepIndex || 0);
    const step = data.step || null;
    const title = (step && step.title) || "Next step";
    const minutes =
      step && typeof step.durationSec === "number"
        ? Math.round(step.durationSec / 60)
        : null;
    const label =
      "Step " + (nextStepIndex + 1) + (minutes ? " • " + minutes + " min" : "");

    toast({
      id: `sess_${sessionId || "unknown"}_step_${nextStepIndex}`,
      kind: "info",
      title,
      message: label,
      durationMs: 7000,
      icon: "⏭️",
      actions: [
        { label: "Pause", intent: "pause", sessionId },
        { label: "Next", intent: "next", sessionId },
      ],
    });
    return;
  }

  if (type === SESSION_EVENTS.PAUSED) {
    const sessionId = data.sessionId;
    const reason = data.reason || "unknown";
    toast.warn(`Paused: ${reason}`, "Session", {
      durationMs: 4000,
      id: `sess_${sessionId || "unknown"}_paused`,
      actions: [{ label: "Resume", intent: "resume", sessionId }],
      icon: "⏸️",
    });
    return;
  }

  if (type === SESSION_EVENTS.RESUMED) {
    const sessionId = data.sessionId;
    toast.info("Resumed", "Session", {
      durationMs: 2500,
      id: `sess_${sessionId || "unknown"}_resumed`,
      icon: "▶️",
    });
    return;
  }

  if (type === SESSION_EVENTS.COMPLETED) {
    const sessionId = data.sessionId;
    toast.success("Nice work! Session completed.", "All done", {
      durationMs: 5000,
      id: `sess_${sessionId || "unknown"}_done`,
      icon: "🎉",
    });
    return;
  }

  if (type === SESSION_EVENTS.ABORTED) {
    const sessionId = data.sessionId;
    const reason = data.reason;
    toast.error(reason ? "Aborted: " + reason : "Session aborted", "Stopped", {
      durationMs: 6000,
      id: `sess_${sessionId || "unknown"}_aborted`,
    });
    return;
  }

  if (type === SESSION_EVENTS.EXPORTED) {
    const sessionId = data.sessionId;
    toast.success("Exported to Hub", "Family Fund", {
      durationMs: 2800,
      id: `sess_${sessionId || "unknown"}_exported`,
      icon: "📤",
    });
    return;
  }

  // Optional: handle warnings/errors if you want toast surfacing.
  if (type === SESSION_EVENTS.WARNING) {
    const code = data.code || "warning";
    const message = data.message || "";
    toast.warn(message || code, "Session warning", {
      durationMs: 4500,
      id: `sess_warn_${code}_${Date.now()}`,
    });
  }

  if (type === SESSION_EVENTS.ERROR) {
    const code = data.code || "error";
    const message = data.message || "";
    toast.error(message || code, "Session error", {
      durationMs: 6000,
      id: `sess_err_${code}_${Date.now()}`,
    });
  }
}

// ------------------------------ Toast Components -----------------------------

function ToastCard({ item, onClose }) {
  const { id, title, message, kind, icon, actions } = item;

  const style = {
    ...STYLE.cardBase,
    ...(STYLE.kinds[kind] || STYLE.kinds.info),
    outline: "none",
  };

  return (
    <div
      role="status"
      aria-live="polite"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose && onClose(id);
      }}
      style={style}
    >
      <div style={STYLE.icon} aria-hidden="true">
        {icon}
      </div>
      <div style={{ minWidth: 0 }}>
        {title ? <div style={STYLE.title}>{title}</div> : null}
        {message ? <div style={STYLE.msg}>{message}</div> : null}
        {Array.isArray(actions) && actions.length > 0 && (
          <div style={STYLE.actionsRow}>
            {actions.map((a, idx) => (
              <button
                key={id + "_act_" + idx}
                style={STYLE.btn}
                onClick={() => {
                  try {
                    if (typeof a.onClick === "function") a.onClick();
                  } catch {
                    // ignore handler errors
                  }
                  if (a.intent && a.sessionId) {
                    const typeMap = {
                      pause: "session.intent.pause",
                      resume: "session.intent.resume",
                      next: "session.intent.next",
                      prev: "session.intent.prev",
                    };
                    const intentType = typeMap[a.intent];
                    if (intentType) {
                      emitIntent(intentType, { sessionId: a.sessionId });
                    }
                  }
                  onClose && onClose(id);
                }}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <button
        aria-label="Close toast"
        style={STYLE.close}
        onClick={() => onClose && onClose(id)}
      >
        ✕
      </button>
    </div>
  );
}

// ------------------------------ Root Container -------------------------------

/**
 * ToastBus React shim — mount once at app root.
 * - Creates a portal host div in document.body.
 * - Subscribes to the internal `_bus` (for toast()).
 * - Subscribes to session events via eventBus.
 */
export default function ToastBus() {
  const [list, setList] = useState([]); // [{id,title,message,kind,durationMs,icon,actions}]
  const timersRef = useRef({}); // id -> timeout
  const hostRef = useRef(null);

  // Create a host node for the portal on first mount
  useEffect(() => {
    if (typeof document === "undefined") return;
    const host = document.createElement("div");
    host.setAttribute("id", "ssa-toast-host");
    document.body.appendChild(host);
    hostRef.current = host;

    return () => {
      try {
        document.body.removeChild(host);
      } catch {
        // already removed
      }
    };
  }, []);

  // Internal bus listener: handle toast() calls
  useEffect(() => {
    if (!_bus) return;

    const onAdd = (e) => {
      const t = e.detail || {};
      setList((prev) => {
        const existingIndex = prev.findIndex((x) => x.id === t.id);
        if (existingIndex >= 0) {
          const next = prev.slice();
          next[existingIndex] = { ...prev[existingIndex], ...t };
          return next;
        }
        const merged = [t, ...prev];
        // cap stack size a bit
        if (merged.length > 6) merged.length = 6;
        return merged;
      });
      scheduleAutoClose(t.id, t.durationMs);
    };

    _bus.addEventListener("toast:add", onAdd);
    return () => _bus.removeEventListener("toast:add", onAdd);
  }, []);

  // Wire global session events → toasts
  useEffect(() => {
    if (!eventBus || typeof eventBus.on !== "function") return;

    const handler = (evt) => handleSessionEvent(evt);
    const types = Object.values(SESSION_EVENTS);

    types.forEach((t) => eventBus.on(t, handler));

    return () => {
      types.forEach((t) => {
        try {
          eventBus.off(t, handler);
        } catch {
          // ignore off errors
        }
      });
    };
  }, []);

  function scheduleAutoClose(id, ms) {
    if (!id) return;
    clearTimeout(timersRef.current[id]);
    if (!Number.isFinite(ms) || ms <= 0) return;
    timersRef.current[id] = setTimeout(() => close(id), ms);
  }

  function close(id) {
    if (!id) return;
    clearTimeout(timersRef.current[id]);
    delete timersRef.current[id];
    setList((prev) => prev.filter((x) => x.id !== id));
  }

  if (!hostRef.current) return null;

  const wrap = (
    <div style={STYLE.wrap} aria-live="polite" aria-atomic="false">
      {list.map((item) => (
        <ToastCard key={item.id} item={item} onClose={close} />
      ))}
    </div>
  );

  return createPortal(wrap, hostRef.current);
}

// -----------------------------------------------------------------------------
// Named export summary
// -----------------------------------------------------------------------------
// Programmatic API:
//   import ToastBus, { toast } from "@/ui/Toasts/ToastBus";
//   <ToastBus />  // once at app root (App.jsx)
//   toast.success("Saved!");
//   toast({ title: "Step 2", message: "Boil water", kind: "info", actions: [...] })
