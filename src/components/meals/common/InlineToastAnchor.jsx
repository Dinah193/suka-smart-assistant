// src/components/meals/common/InlineToastAnchor.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * InlineToastAnchor
 *
 * Goals:
 * - Inline, stackable, unobtrusive toasts with actions (Undo, View, Open, etc.)
 * - Works with global eventBus (emit 'inline.toast' to show) and local API via ref
 * - Auto-dismiss with visible progress; pause on hover/focus; accessible controls
 * - Queues beyond maxVisible; supports scoped anchors (household/page)
 * - Emits automation templates & events for analytics/NBAs
 *
 * Usage:
 * <InlineToastAnchor scope="meal-planner" maxVisible={3} />
 *
 * Event payload shape (eventBus.emit("inline.toast", payload)):
 * {
 *   id?: string,
 *   level?: "success"|"info"|"warn"|"error",
 *   title?: string,
 *   message?: string,
 *   actions?: Array<{ id: string, label: string, intent?: "primary"|"neutral"|"danger" }>,
 *   undoToken?: string,                 // if provided, shows Undo
 *   timeoutMs?: number,                 // default 5000
 *   sticky?: boolean,                   // don't auto dismiss
 *   scope?: string,                     // route/household scope; must match <InlineToastAnchor scope=...>
 *   meta?: any                          // extra data for action handlers
 * }
 *
 * Actions emitted back out:
 * - "inline.toast.action" { id, actionId, meta }
 * - "inline.toast.undo"   { id, undoToken, meta }
 * - "inline.toast.closed" { id, reason: "timeout"|"action"|"close" }
 */

/* ------------------------------- Defensive deps ------------------------------- */
let Icons = {};
try { Icons = require("lucide-react"); } catch {}

let eventBus = null;
try { eventBus = require("@/services/eventBus").eventBus || null; } catch {}

let automation = null;
try { automation = require("@/services/automation/runtime").automation || null; } catch {}

const prefersReduceMotion =
  typeof window !== "undefined" &&
  window.matchMedia &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------------------------------- Helpers ---------------------------------- */
const cx = (...xs) => xs.filter(Boolean).join(" ");
const now = () => Date.now();
const genId = () => Math.random().toString(36).slice(2, 9);

const LEVEL_STYLES = {
  success:
    "border-emerald-200 bg-emerald-50 text-emerald-900 [&_.icon]:text-emerald-600",
  info:
    "border-blue-200 bg-blue-50 text-blue-900 [&_.icon]:text-blue-600",
  warn:
    "border-amber-200 bg-amber-50 text-amber-900 [&_.icon]:text-amber-600",
  error:
    "border-rose-200 bg-rose-50 text-rose-900 [&_.icon]:text-rose-600",
};

const ICONS_BY_LEVEL = (IconsLib) => ({
  success: IconsLib.CheckCircle2 || (() => null),
  info: IconsLib.Info || (() => null),
  warn: IconsLib.AlertTriangle || (() => null),
  error: IconsLib.XCircle || (() => null),
});

/* --------------------------------- Component --------------------------------- */
const InlineToastAnchor = React.forwardRef(
  (
    {
      scope = "default",           // only show events for this scope
      maxVisible = 3,              // stack size
      placement = "bottom-right",  // "top-right" | "top-left" | "bottom-right" | "bottom-left"
      className = "",
    },
    ref
  ) => {
    const [stack, setStack] = useState([]); // visible toasts
    const queueRef = useRef([]);            // queued toasts
    const timersRef = useRef({});           // per-toast timer state

    const {
      X = () => null,
      RotateCcw = () => null,
    } = Icons;

    const IconMap = useMemo(() => ICONS_BY_LEVEL(Icons), []);

    /* ------------------------------ Local API (ref) --------------------------- */
    React.useImperativeHandle(ref, () => ({
      push: (toastPayload) => pushToast(toastPayload),
      clear: () => clearAll(),
    }));

    /* --------------------------------- Emits ---------------------------------- */
    const emit = (type, payload) => {
      try { eventBus?.emit?.(type, payload); } catch {}
      try { automation?.runTemplate?.(type, payload); } catch {}
    };

    /* ----------------------------- Core operations ---------------------------- */
    const pushToast = (payload) => {
      const id = payload.id || genId();
      const t = {
        id,
        level: payload.level || "info",
        title: payload.title || "",
        message: payload.message || "",
        actions: Array.isArray(payload.actions) ? payload.actions.slice(0, 3) : [],
        undoToken: payload.undoToken,
        timeoutMs: payload.sticky ? 0 : Math.max(1500, payload.timeoutMs || 5000),
        sticky: !!payload.sticky,
        createdAt: now(),
        meta: payload.meta,
      };

      const enqueue = () => {
        setStack((curr) => {
          if (curr.length < maxVisible) return [...curr, t];
          queueRef.current.push(t);
          return curr;
        });
      };

      if (!payload.scope || payload.scope === scope) enqueue();
      // if scope mismatch, ignore silently
    };

    const dequeueIfNeeded = () => {
      setStack((curr) => {
        if (curr.length >= maxVisible || queueRef.current.length === 0) return curr;
        const next = [...curr, queueRef.current.shift()];
        return next;
      });
    };

    const closeToast = (id, reason = "close") => {
      setStack((curr) => curr.filter((x) => x.id !== id));
      // cleanup timer
      const t = timersRef.current[id];
      if (t) {
        clearInterval(t.interval);
        delete timersRef.current[id];
      }
      emit("inline.toast.closed", { id, reason, scope });
      // fill from queue
      setTimeout(dequeueIfNeeded, 0);
    };

    const clearAll = () => {
      Object.values(timersRef.current).forEach((t) => clearInterval(t.interval));
      timersRef.current = {};
      setStack([]);
      queueRef.current = [];
    };

    /* ------------------------------ Auto-dismiss ------------------------------ */
    useEffect(() => {
      // start timers for new toasts
      stack.forEach((t) => {
        const exists = timersRef.current[t.id];
        if (exists || t.timeoutMs === 0) return;
        timersRef.current[t.id] = {
          start: now(),
          remaining: t.timeoutMs,
          progress: 0,
          paused: false,
          interval: setInterval(() => {
            const state = timersRef.current[t.id];
            if (!state || state.paused) return;
            state.remaining = Math.max(0, t.timeoutMs - (now() - state.start));
            state.progress = t.timeoutMs === 0 ? 0 : 1 - state.remaining / t.timeoutMs;
            if (state.remaining === 0) {
              clearInterval(state.interval);
              delete timersRef.current[t.id];
              closeToast(t.id, "timeout");
            } else {
              // trigger re-render by updating dummy state via setStack no-op clone
              setStack((curr) => curr.map((x) => (x.id === t.id ? { ...x } : x)));
            }
          }, 100),
        };
      });
      // cleanup on unmount
      return () => {
        Object.values(timersRef.current).forEach((t) => clearInterval(t.interval));
        timersRef.current = {};
      };
    }, [stack]);

    const pauseTimer = (id, pause) => {
      const t = timersRef.current[id];
      if (!t) return;
      if (pause && !t.paused) {
        t.paused = true;
        // adjust baseline so resume picks up properly
        t.remaining = Math.max(0, t.remaining);
      } else if (!pause && t.paused) {
        t.paused = false;
        t.start = now() - (t.timeoutMs - t.remaining);
      }
    };

    /* ---------------------------- Listen: eventBus ---------------------------- */
    useEffect(() => {
      if (!eventBus?.on) return;
      const handler = (payload) => pushToast(payload || {});
      eventBus.on("inline.toast", handler);
      return () => eventBus.off?.("inline.toast", handler);
    }, []);

    /* -------------------------------- Handlers -------------------------------- */
    const handleAction = (toast, actionId) => {
      emit("inline.toast.action", { id: toast.id, actionId, meta: toast.meta, scope });
      closeToast(toast.id, "action");
    };

    const handleUndo = (toast) => {
      emit("inline.toast.undo", { id: toast.id, undoToken: toast.undoToken, meta: toast.meta, scope });
      closeToast(toast.id, "action");
    };

    /* -------------------------------- Placement ------------------------------- */
    const placeCls =
      placement === "top-right"
        ? "top-2 right-2"
        : placement === "top-left"
        ? "top-2 left-2"
        : placement === "bottom-left"
        ? "bottom-2 left-2"
        : "bottom-2 right-2";

    /* ---------------------------------- UI ------------------------------------ */
    return (
      <div
        className={cx(
          "pointer-events-none fixed z-50",
          placeCls,
          className
        )}
        aria-live="polite"
        aria-relevant="additions text"
      >
        <ul className="flex flex-col gap-2 max-w-[360px]">
          {stack.map((t) => {
            const Icon = IconMap[t.level] || (() => null);
            const timer = timersRef.current[t.id];
            const progress = timer ? Math.max(0, Math.min(1, timer.progress)) : 0;

            return (
              <li
                key={t.id}
                onMouseEnter={() => pauseTimer(t.id, true)}
                onMouseLeave={() => pauseTimer(t.id, false)}
                onFocus={() => pauseTimer(t.id, true)}
                onBlur={() => pauseTimer(t.id, false)}
                className={cx(
                  "pointer-events-auto rounded-2xl border shadow-sm p-3 bg-white/80 backdrop-blur",
                  LEVEL_STYLES[t.level] || LEVEL_STYLES.info,
                  prefersReduceMotion ? "" : "transition-transform duration-200",
                )}
                style={{ transform: prefersReduceMotion ? undefined : "translateZ(0)" }}
                role="status"
              >
                <div className="flex items-start gap-2">
                  <span className="icon mt-0.5">
                    <Icon className="w-4 h-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    {t.title ? <div className="text-sm font-semibold leading-tight">{t.title}</div> : null}
                    {t.message ? (
                      <div className="text-sm leading-snug mt-0.5 break-words">
                        {t.message}
                      </div>
                    ) : null}

                    {/* actions */}
                    {(t.actions?.length || t.undoToken) ? (
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        {t.undoToken ? (
                          <button
                            type="button"
                            onClick={() => handleUndo(t)}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded-md border text-xs hover:bg-white/60"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                            Undo
                          </button>
                        ) : null}
                        {t.actions?.map((a) => (
                          <button
                            key={a.id}
                            type="button"
                            onClick={() => handleAction(t, a.id)}
                            className={cx(
                              "inline-flex items-center gap-1 px-2 py-1 rounded-md border text-xs hover:bg-white/60",
                              a.intent === "primary" && "font-medium",
                              a.intent === "danger" && "border-rose-300 text-rose-800 hover:bg-rose-50"
                            )}
                          >
                            {a.label}
                          </button>
                        ))}
                      </div>
                    ) : null}

                    {/* progress */}
                    {t.timeoutMs > 0 ? (
                      <div className="mt-2 h-1 w-full rounded-full bg-white/60 overflow-hidden" aria-hidden="true">
                        <div
                          className="h-1 bg-current/40"
                          style={{ width: `${progress * 100}%` }}
                        />
                      </div>
                    ) : null}
                  </div>

                  <button
                    type="button"
                    onClick={() => closeToast(t.id, "close")}
                    className="p-1 rounded-md hover:bg-white/50"
                    aria-label="Dismiss"
                    title="Dismiss"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    );
  }
);

export default InlineToastAnchor;
