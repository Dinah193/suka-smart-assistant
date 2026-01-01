// src/ui/PlanningBadge.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * PlanningBadge — dynamic corner ribbon.
 *
 * Props (all optional; sensible defaults keep legacy look):
 * - text: string = "PLANNING"
 * - state: "planning" | "running" | "paused" | "success" | "error" | "sabbath" | "offline"
 * - corner: "tr" | "tl" | "br" | "bl"                (top-right default)
 * - variant: "solid" | "soft"                        (solid default)
 * - pulse: boolean                                   (true for planning/running by default)
 * - progressPct: number (0-100)                      (tiny inline bar below text)
 * - count: number                                    (e.g., active tasks)
 * - href: string                                     (renders as link)
 * - onClick: () => void                              (renders as button)
 * - tooltip: string                                  (title + aria-label)
 * - visible: boolean                                 (default true)
 * - autoHideAfterMs: number                          (auto dismiss after ms)
 * - dismissible: boolean                             (shows small ×)
 * - onDismiss: () => void
 * - className: string                                (extra classes)
 * - zIndexClass: string                              (default "z-50")
 */

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(!!mq.matches);
    onChange();
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}

const CORNER = {
  tr: "top-0 right-0 translate-x-4 -translate-y-4 rotate-45 origin-top-right",
  tl: "top-0 left-0 -translate-x-4 -translate-y-4 -rotate-45 origin-top-left",
  br: "bottom-0 right-0 translate-x-4 translate-y-4 -rotate-45 origin-bottom-right",
  bl: "bottom-0 left-0 -translate-x-4 translate-y-4 rotate-45 origin-bottom-left",
};

const TONE = {
  planning:  { bg: "bg-yellow-300", text: "text-pink-700", soft: "bg-yellow-200 text-yellow-900" },
  running:   { bg: "bg-emerald-500", text: "text-white",    soft: "bg-emerald-100 text-emerald-800" },
  paused:    { bg: "bg-amber-400",   text: "text-amber-900",soft: "bg-amber-100 text-amber-900" },
  success:   { bg: "bg-emerald-600", text: "text-white",    soft: "bg-emerald-100 text-emerald-900" },
  error:     { bg: "bg-rose-600",    text: "text-white",    soft: "bg-rose-100 text-rose-900" },
  sabbath:   { bg: "bg-indigo-500",  text: "text-white",    soft: "bg-indigo-100 text-indigo-900" },
  offline:   { bg: "bg-stone-400",   text: "text-stone-900",soft: "bg-stone-200 text-stone-800" },
  default:   { bg: "bg-yellow-300",  text: "text-pink-700", soft: "bg-yellow-200 text-yellow-900" },
};

export default function PlanningBadge({
  text = "PLANNING",
  state = "planning",
  corner = "tr",
  variant = "solid",
  pulse,
  progressPct,
  count,
  href,
  onClick,
  tooltip,
  visible = true,
  autoHideAfterMs,
  dismissible = false,
  onDismiss,
  className = "",
  zIndexClass = "z-50",
}) {
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(!!visible);
  const hideTimerRef = useRef(null);

  // Keep in sync with `visible` prop
  useEffect(() => setOpen(!!visible), [visible]);

  // Auto-hide when requested
  useEffect(() => {
    if (!autoHideAfterMs || !open) return;
    clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      setOpen(false);
      onDismiss?.();
    }, autoHideAfterMs);
    return () => clearTimeout(hideTimerRef.current);
  }, [autoHideAfterMs, open, onDismiss]);

  // Default pulsing logic by state (unless explicitly set via prop)
  const shouldPulse = useMemo(() => {
    if (typeof pulse === "boolean") return pulse;
    return (state === "planning" || state === "running") && !reduced;
  }, [pulse, state, reduced]);

  const tone = TONE[state] || TONE.default;
  const colorClasses =
    variant === "soft"
      ? `${tone.soft}`
      : `${tone.bg} ${tone.text} shadow-md`;

  const cornerClasses = CORNER[corner] || CORNER.tr;

  const RibbonTag = href ? "a" : onClick ? "button" : "div";
  const ribbonCommon = `absolute ${cornerClasses} ${colorClasses} px-6 py-1 font-bold text-sm tracking-wide ${
    shouldPulse ? "pulse" : ""
  } ${zIndexClass} select-none`;
  const interactive =
    href || onClick
      ? "focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
      : "";

  // A11y
  const ariaLabel = tooltip || text;
  const ariaLive =
    state === "error" || state === "success" ? "polite" : "off";

  if (!open) return null;

  return (
    <RibbonTag
      className={[ribbonCommon, "rounded", "whitespace-nowrap", interactive, className].join(" ")}
      title={tooltip || text}
      aria-label={ariaLabel}
      aria-live={ariaLive}
      href={href}
      onClick={onClick}
      // Button accessibility when rendered as a button
      type={RibbonTag === "button" ? "button" : undefined}
      // Link safety defaults
      target={href ? "_blank" : undefined}
      rel={href ? "noopener noreferrer" : undefined}
    >
      <span className="flex items-center gap-2">
        {/* State icon hint */}
        <StateIcon state={state} />

        {/* Text */}
        <span>{text}</span>

        {/* Optional counter */}
        {typeof count === "number" && (
          <span className="ml-1 inline-flex items-center justify-center min-w-[1.25rem] h-[1.1rem] px-1.5 rounded-full bg-black/10 text-[11px]">
            {count}
          </span>
        )}

        {/* Dismiss button */}
        {dismissible && (
          <button
            type="button"
            className="ml-2 inline-flex items-center justify-center w-4 h-4 rounded hover:bg-black/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onDismiss?.();
            }}
            aria-label="Dismiss badge"
            title="Dismiss"
          >
            ×
          </button>
        )}
      </span>

      {/* Tiny inline progress bar (if provided) */}
      {typeof progressPct === "number" && (
        <div className="mt-1 w-full bg-black/10 rounded-full h-1 overflow-hidden">
          <div
            className="h-1 bg-black/30 transition-all duration-500 ease-out"
            style={{ width: `${Math.max(0, Math.min(100, Math.round(progressPct)))}%` }}
            aria-hidden
          />
        </div>
      )}
    </RibbonTag>
  );
}

/* ----------------------- Small helpers ----------------------- */

function StateIcon({ state }) {
  // Minimal, emoji-based to avoid icon deps; swap to your icon set if desired.
  const map = {
    planning: "🗓️",
    running: "▶️",
    paused: "⏸️",
    success: "✅",
    error: "⚠️",
    sabbath: "🕯️",
    offline: "📴",
  };
  const glyph = map[state] || "🗓️";
  return <span aria-hidden="true" className="leading-none">{glyph}</span>;
}
