// src/components/ui/ProgressMeter.jsx
import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";

/** class combiner */
const cx = (...xs) => xs.filter(Boolean).join(" ");

/**
 * ProgressMeter
 * - Variants: "linear" | "ring" | "dots"
 * - Controlled progress (value/target) or time-driven (startTime, endTime)
 * - Milestones with labels, markers, and onReach callback
 * - Indeterminate + skeleton
 * - Automation intents: optional start/pause/reset buttons
 * - Accessible (aria-*), keyboard-safe
 *
 * Props (key):
 *  - variant?: "linear" | "ring" | "dots" (default "linear")
 *  - value?: number (current progress units)
 *  - target?: number (max units, default 100)
 *  - min?: number (default 0)
 *  - label?: string|ReactNode
 *  - sublabel?: string|ReactNode
 *  - showPercent?: boolean (default true) — formatted % in UI/aria
 *  - showValue?: boolean (default false)
 *  - color?: "brand"|"success"|"warn"|"danger"|"zinc" (semantic color)
 *  - size?: "sm"|"md"|"lg" (thickness / ring size)
 *  - indeterminate?: boolean
 *  - skeleton?: boolean
 *  - compact?: boolean (denser layout)
 *
 * Time-driven (auto progress):
 *  - startTime?: number|Date (ms or Date)
 *  - endTime?: number|Date
 *  - tickMs?: number (default 200) — animation tick
 *  - onComplete?: () => void
 *
 * Milestones / markers:
 *  - milestones?: [{ at: number (0..target), label?: string, id?: string }]
 *  - onReachMilestone?: (ms) => void
 *
 * Automation/intents (optional buttons row):
 *  - actions?: [{ label, icon?, intent?, detail?, onClick?, kind?: "primary"|"subtle"|"ghost", busyLabel? }]
 *
 * ETA:
 *  - showETA?: boolean — shows computed ETA when time-driven
 *
 * Imperative API (via ref):
 *  - start(), pause(), reset()
 */
const ProgressMeter = forwardRef(function ProgressMeter(props, ref) {
  const {
    variant = "linear",
    value: valueProp,
    target: targetProp = 100,
    min = 0,
    label,
    sublabel,
    showPercent = true,
    showValue = false,
    color = "brand",
    size = "md",
    indeterminate = false,
    skeleton = false,
    compact = false,

    startTime,
    endTime,
    tickMs = 200,
    onComplete,

    milestones = [],
    onReachMilestone,

    actions = [],
    showETA = true,
    className,
    ...rest
  } = props;

  // ----- time-driven progress engine -----
  const [running, setRunning] = useState(Boolean(startTime && endTime));
  const [now, setNow] = useState(Date.now());
  const rafRef = useRef(null);
  const tickRef = useRef(null);

  // compute value from time or controlled prop
  const timeBoundaries = useMemo(() => {
    const st = coerceTime(startTime);
    const et = coerceTime(endTime);
    return st && et && et > st ? { st, et } : null;
  }, [startTime, endTime]);

  const target = Math.max(min, targetProp);
  const computedValue = useMemo(() => {
    if (!timeBoundaries) return clamp(valueProp ?? 0, min, target);
    const { st, et } = timeBoundaries;
    const total = et - st;
    const passed = clamp(now - st, 0, total);
    const frac = total ? passed / total : 0;
    return clamp(min + frac * (target - min), min, target);
  }, [valueProp, min, target, now, timeBoundaries]);

  const pct = target > min ? ((computedValue - min) / (target - min)) * 100 : 0;
  const done = pct >= 100 - 1e-9;

  // ETA (time-driven only)
  const eta = useMemo(() => {
    if (!timeBoundaries) return null;
    return new Date(timeBoundaries.et);
  }, [timeBoundaries]);

  // milestones reached detection
  const reachedRef = useRef(new Set());
  useEffect(() => {
    if (!onReachMilestone) return;
    const current = computedValue;
    milestones.forEach((m) => {
      if (m?.at == null) return;
      const notSeen = !reachedRef.current.has(m.at);
      if (notSeen && current >= m.at) {
        reachedRef.current.add(m.at);
        try {
          onReachMilestone(m);
        } catch {}
      }
    });
  }, [computedValue, milestones, onReachMilestone]);

  // run loop if time-driven
  useEffect(() => {
    if (!timeBoundaries) return;
    if (!running) return;

    const tick = () => setNow(Date.now());
    tickRef.current = setInterval(tick, tickMs);

    return () => {
      clearInterval(tickRef.current);
      tickRef.current = null;
    };
  }, [running, timeBoundaries, tickMs]);

  // complete
  useEffect(() => {
    if (timeBoundaries && done) {
      setRunning(false);
      clearInterval(tickRef.current);
      tickRef.current = null;
      if (onComplete) onComplete();
    }
  }, [done, onComplete, timeBoundaries]);

  // imperative API
  useImperativeHandle(ref, () => ({
    start: () => setRunning(true),
    pause: () => setRunning(false),
    reset: () => {
      setRunning(false);
      reachedRef.current.clear();
      if (timeBoundaries) {
        setNow(timeBoundaries.st);
      }
    },
  }));

  // sizes
  const thickness = size === "lg" ? 14 : size === "sm" ? 6 : 10;
  const ringSize = size === "lg" ? 140 : size === "sm" ? 90 : 112;

  // color utility classes
  const colorClass = colorToClasses(color);

  // ARIA
  const ariaValNow = Math.round(computedValue);
  const ariaValMin = min;
  const ariaValMax = target;

  return (
    <section
      className={cx(
        "card",
        compact ? "p-3" : "p-4 md:p-5",
        "border border-[hsl(var(--border))] bg-[hsl(var(--card))]",
        className
      )}
      role="region"
      aria-label="Progress"
    >
      <div className={cx("flex items-start justify-between gap-3", compact ? "mb-2" : "mb-3")}>
        <div className="min-w-0">
          {label ? <div className="font-extrabold text-base md:text-lg">{label}</div> : null}
          {sublabel ? (
            <div className="text-sm text-[hsl(var(--muted-foreground))]">{sublabel}</div>
          ) : null}
        </div>

        {/* optional actions */}
        {actions?.length ? (
          <div className="flex flex-wrap items-center gap-2">
            {actions.map((a, idx) => (
              <ActionButton key={idx} {...a} />
            ))}
          </div>
        ) : null}
      </div>

      {/* meter area */}
      <div
        className={cx(
          variant === "ring" ? "flex items-center gap-4" : "",
          variant === "dots" ? "flex items-center gap-3" : ""
        )}
        aria-live="polite"
      >
        {variant === "linear" && (
          <LinearBar
            percent={pct}
            thickness={thickness}
            colorClass={colorClass}
            indeterminate={indeterminate}
            skeleton={skeleton}
            milestones={normalizeMilestones(milestones, min, target)}
          />
        )}
        {variant === "ring" && (
          <RingBar
            percent={pct}
            size={ringSize}
            stroke={thickness}
            colorClass={colorClass}
            indeterminate={indeterminate}
            skeleton={skeleton}
            centerContent={
              <div className="text-center">
                {showPercent ? (
                  <div className="text-xl md:text-2xl font-extrabold">
                    {Math.round(pct)}%
                  </div>
                ) : null}
                {showValue ? (
                  <div className="text-xs text-[hsl(var(--muted-foreground))]">
                    {formatValue(computedValue)} / {formatValue(target)}
                  </div>
                ) : null}
              </div>
            }
          />
        )}
        {variant === "dots" && (
          <DotsBar
            percent={pct}
            count={12}
            colorClass={colorClass}
            indeterminate={indeterminate}
            skeleton={skeleton}
          />
        )}

        {/* right-side info (linear only) */}
        {variant !== "ring" && (
          <div className="ml-3 min-w-[96px]">
            {showPercent ? (
              <div className="text-base font-extrabold">{Math.round(pct)}%</div>
            ) : null}
            {showValue ? (
              <div className="text-xs text-[hsl(var(--muted-foreground))]">
                {formatValue(computedValue)} / {formatValue(target)}
              </div>
            ) : null}
            {showETA && timeBoundaries ? (
              <div className="text-xs text-[hsl(var(--muted-foreground))]">
                ETA: {eta ? eta.toLocaleTimeString() : "—"}
              </div>
            ) : null}
          </div>
        )}
      </div>

      {/* markers row (linear) */}
      {variant === "linear" && milestones?.length ? (
        <MarkersRow milestones={normalizeMilestones(milestones, min, target)} />
      ) : null}

      {/* aria meter for screen readers (hidden visually) */}
      <div
        className="visually-hidden"
        role="progressbar"
        aria-valuemin={ariaValMin}
        aria-valuemax={ariaValMax}
        aria-valuenow={indeterminate ? undefined : ariaValNow}
        aria-label={typeof label === "string" ? label : "Progress"}
      >
        {indeterminate ? "Loading" : `${Math.round(pct)} percent`}
      </div>
    </section>
  );
});

export default ProgressMeter;

/* -------------------------------- subcomponents ------------------------- */

function LinearBar({ percent, thickness, colorClass, indeterminate, skeleton, milestones }) {
  return (
    <div className="w-full">
      <div
        className="relative w-full rounded-[9999px] bg-[hsl(var(--muted))/0.5] border border-[hsl(var(--border))]"
        style={{ height: thickness + 6 }}
      >
        {/* track shimmer (skeleton) */}
        {skeleton ? (
          <div className="absolute inset-0 suka-shimmer rounded-[9999px]" />
        ) : (
          <div
            className={cx(
              "absolute left-0 top-0 h-full rounded-[9999px] transition-all",
              colorClass.bg
            )}
            style={{
              width: indeterminate ? "35%" : `${Math.min(100, Math.max(0, percent))}%`,
              animation: indeterminate ? "shimmer 1.25s linear infinite" : undefined,
            }}
          />
        )}

        {/* milestone ticks */}
        {!skeleton &&
          milestones?.map((m) => (
            <div
              key={m.pos}
              className="absolute top-1/2 -translate-y-1/2 w-[2px] h-[70%] bg-[hsl(var(--border))]"
              style={{ left: `${m.pos * 100}%` }}
              title={m.label || `${Math.round(m.pos * 100)}%`}
              aria-hidden
            />
          ))}
      </div>
    </div>
  );
}

function RingBar({ percent, size, stroke, colorClass, indeterminate, skeleton, centerContent }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = c * Math.min(1, Math.max(0, percent / 100));
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="block">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke="hsl(var(--muted)/0.5)"
          strokeWidth={stroke}
          fill="none"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          className={colorClass.stroke}
          strokeWidth={stroke}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={c}
          strokeDashoffset={skeleton ? c : c - dash}
          style={{
            transition: "stroke-dashoffset .25s ease",
            animation: indeterminate ? "spin 1s linear infinite" : undefined,
            transformOrigin: "50% 50%",
          }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center">{centerContent}</div>
    </div>
  );
}

function DotsBar({ percent, count = 12, colorClass, indeterminate, skeleton }) {
  const active = Math.round((percent / 100) * count);
  return (
    <div className="flex items-center gap-1.5">
      {Array.from({ length: count }).map((_, i) => (
        <span
          key={i}
          className={cx(
            "inline-block rounded-full",
            i < active ? colorClass.bg : "bg-[hsl(var(--muted))/0.6]"
          )}
          style={{
            width: 10,
            height: 10,
            animation: indeterminate ? `bounceOnce .9s ease ${i * 0.06}s infinite` : undefined,
            opacity: skeleton ? 0.4 : 1,
          }}
          aria-hidden
        />
      ))}
    </div>
  );
}

function MarkersRow({ milestones }) {
  return (
    <div className="mt-2 grid grid-cols-12 gap-1 text-[11px] text-[hsl(var(--muted-foreground))]">
      {milestones.map((m) => (
        <div
          key={m.pos}
          className="col-span-3 text-center"
          style={{ gridColumnStart: Math.max(1, Math.round(m.pos * 12)) }}
          title={m.label}
        >
          {m.label || `${Math.round(m.pos * 100)}%`}
        </div>
      ))}
    </div>
  );
}

function ActionButton({ label, icon, kind = "subtle", busyLabel, intent, detail, onClick }) {
  const [busy, setBusy] = useState(false);
  const classMap = { primary: "btn primary", subtle: "btn subtle", ghost: "btn" };
  return (
    <button
      type="button"
      className={classMap[kind] || classMap.subtle}
      aria-busy={busy ? "true" : "false"}
      onMouseDown={(e) => e.currentTarget.classList.add("is-pressed")}
      onMouseUp={(e) => e.currentTarget.classList.remove("is-pressed")}
      onClick={async () => {
        try {
          setBusy(true);
          if (onClick) {
            await onClick();
          } else if (intent) {
            window.dispatchEvent(new CustomEvent("automation:intent", { detail: { intent, ...(detail || {}) } }));
            try {
              const mod = await import(/* @vite-ignore */ "@/services/automation/runtime").catch(() => null);
              const runtime = mod?.automation || mod?.default || null;
              if (runtime?.emitIntent) await runtime.emitIntent(intent, detail || {});
            } catch {}
          }
        } finally {
          setBusy(false);
        }
      }}
      title={typeof label === "string" ? label : undefined}
    >
      {icon ? <span aria-hidden>{icon}</span> : null}
      <span className="label">{busy && busyLabel ? busyLabel : label}</span>
    </button>
  );
}

/* -------------------------------- utils ---------------------------------- */

function coerceTime(t) {
  if (!t) return null;
  if (t instanceof Date) return t.getTime();
  if (typeof t === "number") return t;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
function formatValue(v) {
  if (v == null) return "—";
  if (v % 1 === 0) return String(v);
  return v.toFixed(1);
}
function normalizeMilestones(ms = [], min = 0, target = 100) {
  return ms
    .map((m) => {
      const at = typeof m?.at === "number" ? m.at : null;
      if (at == null) return null;
      const pos = clamp((at - min) / (target - min), 0, 1); // 0..1
      return { ...m, pos };
    })
    .filter(Boolean)
    .sort((a, b) => a.pos - b.pos);
}
function colorToClasses(c) {
  switch (c) {
    case "success":
      return { bg: "bg-[hsl(var(--success))]", stroke: "stroke-[hsl(var(--success))]" };
    case "warn":
      return { bg: "bg-[hsl(var(--warn))]", stroke: "stroke-[hsl(var(--warn))]" };
    case "danger":
      return { bg: "bg-[hsl(var(--danger))]", stroke: "stroke-[hsl(var(--danger))]" };
    case "zinc":
      return { bg: "bg-zinc-600", stroke: "stroke-zinc-600" };
    case "brand":
    default:
      return { bg: "bg-[hsl(var(--brand))]", stroke: "stroke-[hsl(var(--brand))]" };
  }
}

/* -------------------------------- prop types ------------------------------ */
ProgressMeter.propTypes = {
  variant: PropTypes.oneOf(["linear", "ring", "dots"]),
  value: PropTypes.number,
  target: PropTypes.number,
  min: PropTypes.number,
  label: PropTypes.node,
  sublabel: PropTypes.node,
  showPercent: PropTypes.bool,
  showValue: PropTypes.bool,
  color: PropTypes.oneOf(["brand", "success", "warn", "danger", "zinc"]),
  size: PropTypes.oneOf(["sm", "md", "lg"]),
  indeterminate: PropTypes.bool,
  skeleton: PropTypes.bool,
  compact: PropTypes.bool,
  startTime: PropTypes.oneOfType([PropTypes.number, PropTypes.string, PropTypes.instanceOf(Date)]),
  endTime: PropTypes.oneOfType([PropTypes.number, PropTypes.string, PropTypes.instanceOf(Date)]),
  tickMs: PropTypes.number,
  onComplete: PropTypes.func,
  milestones: PropTypes.arrayOf(
    PropTypes.shape({
      at: PropTypes.number.isRequired, // in same units as value/target, NOT percent
      label: PropTypes.string,
      id: PropTypes.string,
    })
  ),
  onReachMilestone: PropTypes.func,
  actions: PropTypes.arrayOf(
    PropTypes.shape({
      label: PropTypes.node.isRequired,
      icon: PropTypes.node,
      intent: PropTypes.string,
      detail: PropTypes.object,
      onClick: PropTypes.func,
      kind: PropTypes.oneOf(["primary", "subtle", "ghost"]),
      busyLabel: PropTypes.string,
    })
  ),
  showETA: PropTypes.bool,
  className: PropTypes.string,
};

/* -------------------------------- usage examples --------------------------
1) Linear (meal prep task progress):
<ProgressMeter
  label="Meal Prep — Weeknight Batch"
  sublabel="Chopping & marinating"
  value={42}
  target={100}
  color="brand"
  milestones={[{ at: 25, label: "Veg done" }, { at: 50, label: "Protein marinated" }, { at: 90, label: "Box up" }]}
/>

2) Ring (fasting window timer):
<ProgressMeter
  variant="ring"
  label="Fasting (16:8)"
  sublabel="Ends"
  startTime={Date.now()}
  endTime={Date.now() + 16*60*60*1000}
  size="lg"
  color="success"
  showValue={false}
  showPercent
  showETA
  onComplete={()=> alert("Fasting window complete!")}
/>

3) Dots (cleaning sprint):
<ProgressMeter variant="dots" label="Cleaning Sprint" sublabel="90-min focus" value={60} target={90} />

4) With automation actions:
<ProgressMeter
  label="Batch Session"
  sublabel="Smoker running"
  startTime={session.start}
  endTime={session.end}
  actions={[
    { label: "Pause", icon: "⏸️", intent: "timer/pause", busyLabel: "Pausing…" },
    { label: "Reset", icon: "↺", intent: "timer/reset" },
  ]}
/>
--------------------------------------------------------------------------- */
