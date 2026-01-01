// src/ui/AnimatedProgressBar.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import "./AnimatedProgressBar.css"; // provides variables, stripes, indeterminate, stacked, etc.

/**
 * AnimatedProgressBar
 * - Backwards compatible with your old props (value, max, label, color, height, showPercentage).
 * - Adds:
 *   • indeterminate mode
 *   • stacked segments
 *   • striped & animated stripes
 *   • reduced-motion friendly animation
 *   • state colors (success/warning/danger/info)
 *   • optional label inside the bar
 *   • onComplete callback
 *   • data-attributes for no-Tailwind styling
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

const clamp01 = (n) => (isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);

export default function AnimatedProgressBar({
  /* Legacy props (kept) */
  value = 0,
  max = 100,
  label = "",
  color = "bg-green-500",   // Tailwind class (legacy) OR let CSS handle via data-color
  height = "h-4",           // Tailwind height (legacy) OR use size="md"
  showPercentage = true,

  /* New props (optional) */
  size,                     // "sm" | "md" | "lg" | "xl"  (maps to CSS vars)
  indeterminate = false,
  striped = false,
  animatedStripes = true,
  state,                    // "success" | "warning" | "danger" | "info" | "neutral"
  insideLabel = false,      // render label/percentage inside the bar
  labelRenderer,            // (pct:number) => ReactNode
  ariaLabel,                // accessible label if no visible text label provided
  rounded = true,

  segments,                 // stacked mode: [{ value, max?, color?, state?, label? }, ...]
  onComplete,               // callback when progress hits 100%
  durationMs = 700,         // animation duration for width changes
  easing = "cubic-bezier(.4,0,.2,1)",

  /* Style overrides via CSS variables (rare) */
  style,
  className = "",
}) {
  const reducedMotion = useReducedMotion();

  const targetPct = useMemo(() => {
    if (segments && segments.length) return null;
    const pct = max > 0 ? (value / max) : 0;
    return Math.round(clamp01(pct) * 100);
  }, [value, max, segments]);

  const [pct, setPct] = useState(targetPct ?? 0);
  const lastPctRef = useRef(pct);

  // Smooth animate toward new % (respect reduced-motion)
  useEffect(() => {
    if (targetPct == null) return; // stacked or indeterminate, skip
    if (reducedMotion || durationMs <= 1) {
      setPct(targetPct);
      lastPctRef.current = targetPct;
      return;
    }
    const start = performance.now();
    const from = lastPctRef.current;
    const to = targetPct;
    const dur = durationMs;

    let raf;
    const tick = (t) => {
      const k = Math.min(1, (t - start) / dur);
      // simple ease-out (mirrors CSS easing visually enough)
      const eased = 1 - Math.pow(1 - k, 3);
      const cur = Math.round(from + (to - from) * eased);
      setPct(cur);
      if (k < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        lastPctRef.current = to;
        if (to >= 100 && typeof onComplete === "function") onComplete();
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetPct, reducedMotion, durationMs]);

  // A11y values
  const ariaMin = 0;
  const ariaMax = 100;
  const ariaNow = indeterminate ? undefined : (segments ? undefined : pct);
  const ariaValueText = useMemo(() => {
    if (indeterminate) return "Loading";
    if (segments && segments.length) {
      const sum = segments.reduce((acc, s) => {
        const m = s.max ?? max ?? 100;
        return acc + clamp01((s.value ?? 0) / (m || 100));
      }, 0);
      const p = Math.round(clamp01(sum) * 100);
      return `${p}%`;
    }
    return `${pct}%`;
  }, [indeterminate, segments, pct, max]);

  // Classes & data-attrs (work with our CSS; Tailwind remains optional)
  const containerClasses = [
    "progress", // our CSS base
    rounded ? "" : "rounded-none",
    striped ? "progress--striped" : "",
    animatedStripes ? "progress--animated" : "",
    size === "sm" ? "progress--sm" : "",
    size === "lg" ? "progress--lg" : "",
    size === "xl" ? "progress--xl" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const containerData = {
    "data-color": state || undefined,
    "data-state": state || undefined,
    "data-indeterminate": indeterminate ? "true" : undefined,
  };

  const containerStyle = {
    ...style,
    // Allow JS to override timing to match our internal tween
    "--pb-duration": reducedMotion ? "1ms" : `${durationMs}ms`,
    "--pb-ease": easing,
  };

  const labelNode = (() => {
    if (typeof labelRenderer === "function") {
      const v =
        segments && segments.length
          ? ariaValueText
          : `${pct}%`;
      return labelRenderer(Number(String(v).replace("%", "")) || 0);
    }
    if (showPercentage) {
      return `${segments && segments.length ? ariaValueText : `${pct}%`}`;
    }
    return null;
  })();

  // Legacy Tailwind color classes support (for your existing code)
  const legacyFillClass = color; // e.g., "bg-green-500"
  const tailwindHeight = height; // e.g., "h-4"

  return (
    <div className="w-full">
      {/* Visible heading/label above bar (legacy behavior) */}
      {label && (
        <div className="text-sm font-medium mb-1 text-stone-700">
          {label}
        </div>
      )}

      {/* Container */}
      <div
        role="progressbar"
        aria-label={ariaLabel || (label || "Progress")}
        aria-valuemin={indeterminate ? undefined : ariaMin}
        aria-valuemax={indeterminate ? undefined : ariaMax}
        aria-valuenow={ariaNow}
        aria-valuetext={ariaValueText}
        className={`${containerClasses} ${tailwindHeight}`}
        {...containerData}
        style={containerStyle}
      >
        {/* Determinate single fill */}
        {!indeterminate && !segments && (
          <>
            <div
              className={`progress-bar-fill ${legacyFillClass} ${tailwindHeight}`}
              style={{ width: `${pct}%` }}
            />
            {insideLabel && (
              <div className="progress__label">{labelNode}</div>
            )}
          </>
        )}

        {/* Indeterminate fill — CSS anim handles width/position */}
        {indeterminate && (
          <>
            <div className={`progress-bar-fill ${legacyFillClass} ${tailwindHeight}`} />
            {insideLabel && <div className="progress__label">…</div>}
          </>
        )}

        {/* Stacked segments */}
        {!indeterminate && Array.isArray(segments) && segments.length > 0 && (
          <div className="progress--stacked" style={{ height: "100%" }}>
            {segments.map((seg, i) => {
              const m = seg.max ?? max ?? 100;
              const segPct = Math.round(clamp01((seg.value ?? 0) / (m || 100)) * 100);
              const segData = {
                "data-color": seg.state || undefined,
              };
              return (
                <div
                  key={i}
                  className={`progress-segment ${tailwindHeight} ${seg.color || ""}`}
                  style={{ width: `${segPct}%` }}
                  {...segData}
                  title={seg.label || undefined}
                />
              );
            })}
            {insideLabel && (
              <div className="progress__label">{labelNode}</div>
            )}
          </div>
        )}
      </div>

      {/* Legacy below-the-bar percentage (kept for compatibility) */}
      {!insideLabel && showPercentage && !indeterminate && !segments && (
        <div className="text-xs text-stone-500 text-right mt-1">
          {labelNode}
        </div>
      )}
    </div>
  );
}
