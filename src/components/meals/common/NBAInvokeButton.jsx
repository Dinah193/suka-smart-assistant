// src/components/meals/common/NBAInvokeButton.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * NBAInvokeButton – "Next-Best Action" trigger
 *
 * Goals:
 * - Consistent CTA to surface nudges / automations across the app
 * - Live badge count (listens to eventBus updates)
 * - Keyboard shortcut (e.g., Alt+N) and long-press to open palette
 * - Emits normalized events for automation runtime + analytics
 * - Defensive: runs without eventBus/automation/lucide present
 *
 * Events listened:
 * - nba.count.updated            { scope, count }
 * - nba.loading                  { scope, loading }
 *
 * Events emitted on click/long-press:
 * - nba.invoke                   { scope, context }
 * - nba.palette.open             { scope, context }
 *
 * Automation:
 * - automation.runTemplate("nba.invoke", payload)
 */

let Icons = {};
try { Icons = require("lucide-react"); } catch {}

let eventBus = null;
try { eventBus = require("@/services/eventBus").eventBus || null; } catch {}

let automation = null;
try { automation = require("@/services/automation/runtime").automation || null; } catch {}

/* ------------------------------- Utilities ----------------------------------- */
const cx = (...xs) => xs.filter(Boolean).join(" ");
const clamp = (n, a = 0, b = Infinity) => Math.max(a, Math.min(b, Number.isFinite(+n) ? +n : a));
const prefersReduceMotion =
  typeof window !== "undefined" &&
  window.matchMedia &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* -------------------------------- Component ---------------------------------- */
const NBAInvokeButton = ({
  label = "Get suggestions",
  scope = "meal-planner",                 // which surface this button belongs to
  context = {},                           // any context you want to pass to NBAs
  variant = "primary",                    // "primary" | "outline" | "ghost" | "pill"
  size = "md",                            // "sm" | "md" | "lg"
  badge = null,                           // initial badge number (nullable)
  badgeTitle = "New suggestions",
  loading: loadingProp = false,           // external override
  disabled = false,
  hotkey = "Alt+N",                       // display + binding (Alt+N by default)
  longPressMs = 450,                      // hold to open palette
  onInvoke,                               // callback after emit
  className = "",
  id,
}) => {
  /* ----------------------------- Internal state ------------------------------ */
  const [count, setCount] = useState(typeof badge === "number" ? badge : null);
  const [loading, setLoading] = useState(!!loadingProp);
  const pressTimer = useRef(null);
  const pressedAt = useRef(0);

  useEffect(() => setLoading(!!loadingProp), [loadingProp]);

  /* ------------------------------- Icons ------------------------------------- */
  const {
    Sparkles = () => null,
    Wand2 = () => null,
    Loader2 = () => null,
    ChevronDown = () => null,
    BellRing = () => null,
    Zap = () => null,
  } = Icons;

  /* ------------------------------- Listeners --------------------------------- */
  useEffect(() => {
    if (!eventBus?.on) return;
    const onCount = ({ scope: s, count: c }) => {
      if (!s || s === scope) setCount(Number.isFinite(c) ? clamp(c, 0, 9999) : null);
    };
    const onLoading = ({ scope: s, loading: l }) => {
      if (!s || s === scope) setLoading(!!l);
    };
    eventBus.on("nba.count.updated", onCount);
    eventBus.on("nba.loading", onLoading);
    return () => {
      eventBus.off?.("nba.count.updated", onCount);
      eventBus.off?.("nba.loading", onLoading);
    };
  }, [scope]);

  /* ------------------------------- Emits ------------------------------------- */
  const emit = (type, payload) => {
    try { eventBus?.emit?.(type, payload); } catch {}
    try { automation?.runTemplate?.(type, payload); } catch {}
  };

  const doInvoke = () => {
    if (disabled || loading) return;
    const payload = { scope, context, ts: Date.now() };
    emit("nba.invoke", payload);
    onInvoke?.(payload);
  };

  const openPalette = () => {
    if (disabled || loading) return;
    emit("nba.palette.open", { scope, context, ts: Date.now() });
  };

  /* ------------------------------ Long-press --------------------------------- */
  const onPointerDown = () => {
    if (disabled || loading) return;
    pressedAt.current = Date.now();
    clearTimeout(pressTimer.current);
    pressTimer.current = setTimeout(() => {
      openPalette();
      pressedAt.current = 0; // cancel click action after long-press
    }, Math.max(250, longPressMs));
  };
  const onPointerUp = () => {
    clearTimeout(pressTimer.current);
    const held = Date.now() - (pressedAt.current || 0);
    if (held && held < longPressMs) doInvoke();
    pressedAt.current = 0;
  };
  const onPointerLeave = () => {
    clearTimeout(pressTimer.current);
    pressedAt.current = 0;
  };

  /* ------------------------------ Hotkey bind -------------------------------- */
  useEffect(() => {
    if (!hotkey) return;
    const [mod, key] = hotkey.toLowerCase().split("+");
    const handler = (e) => {
      const k = (e.key || "").toLowerCase();
      const modOk =
        (mod === "alt" && e.altKey) ||
        (mod === "ctrl" && e.ctrlKey) ||
        (mod === "cmd" && e.metaKey) ||
        (mod === "meta" && e.metaKey);
      if (modOk && k === key) {
        e.preventDefault();
        doInvoke();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [hotkey, disabled, loading]);

  /* ------------------------------ Styling maps ------------------------------- */
  const sizeCls = {
    sm: "h-8 px-2.5 text-xs rounded-lg",
    md: "h-10 px-3 text-sm rounded-xl",
    lg: "h-12 px-4 text-base rounded-2xl",
  }[size] || "h-10 px-3 text-sm rounded-xl";

  const varCls = {
    primary:
      "bg-gray-900 text-white hover:bg-gray-800 border border-gray-900",
    outline:
      "bg-white text-gray-900 hover:bg-gray-50 border border-gray-300",
    ghost:
      "bg-transparent text-gray-900 hover:bg-gray-50 border border-transparent",
    pill:
      "bg-indigo-600 text-white hover:bg-indigo-500 border border-indigo-600",
  }[variant] || "bg-gray-900 text-white hover:bg-gray-800 border border-gray-900";

  const disabledCls = disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer";
  const ringCls = "focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500";

  /* ------------------------------- Badge pill -------------------------------- */
  const Badge = () =>
    Number.isFinite(count) && count > 0 ? (
      <span
        title={badgeTitle}
        className={cx(
          "absolute -top-1 -right-1 min-w-[18px] h-[18px] px-[4px] rounded-full",
          "bg-rose-600 text-white border border-white",
          "text-[10px] leading-[18px] text-center",
          prefersReduceMotion ? "" : "animate-[pulse_1.8s_ease-in-out_infinite]"
        )}
      >
        {count > 99 ? "99+" : count}
      </span>
    ) : null;

  /* ----------------------------------- UI ------------------------------------ */
  return (
    <div className="relative inline-block">
      <button
        id={id}
        type="button"
        className={cx(
          "inline-flex items-center gap-2 select-none transition shadow-sm",
          sizeCls,
          varCls,
          ringCls,
          disabledCls,
          className
        )}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerLeave}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            doInvoke();
          }
          if ((e.altKey && e.key.toLowerCase() === "p") || e.key === "ArrowDown") {
            // Alt+P or ArrowDown opens the palette
            e.preventDefault();
            openPalette();
          }
        }}
        aria-haspopup="dialog"
        aria-label={label}
        aria-busy={loading}
        disabled={disabled}
        title={`${label}${hotkey ? ` (${hotkey})` : ""}`}
      >
        {/* icon + label */}
        <span className="relative">
          {loading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : variant === "pill" ? (
            <Zap className="w-4 h-4" />
          ) : (
            <Sparkles className="w-4 h-4" />
          )}
        </span>
        <span className="font-medium whitespace-nowrap">{label}</span>
        <ChevronDown className="w-4 h-4 opacity-70" />

        {/* live badge */}
        <Badge />
      </button>

      {/* hint row (optional, subtle) */}
      <div className="mt-1 text-[10px] text-gray-500 text-center">
        {hotkey ? <span>Shortcut: {hotkey}</span> : <span>&nbsp;</span>}
      </div>

      {/* subtle attention ripple */}
      {!prefersReduceMotion ? (
        <span
          aria-hidden
          className={cx(
            "pointer-events-none absolute inset-0 rounded-[inherit] blur-xl",
            count > 0 ? "bg-rose-400/10" : "bg-indigo-400/5"
          )}
          style={{
            animation: "nbaRipple 3s ease-in-out infinite",
            maskImage:
              "radial-gradient(closest-side, rgba(0,0,0,0.6), rgba(0,0,0,0))",
          }}
        />
      ) : null}

      {/* keyframes */}
      <style>{`
        @keyframes nbaRipple {
          0% { opacity: .3; transform: scale(0.98); }
          50% { opacity: .5; transform: scale(1.02); }
          100% { opacity: .3; transform: scale(0.98); }
        }
      `}</style>
    </div>
  );
};

export default NBAInvokeButton;
