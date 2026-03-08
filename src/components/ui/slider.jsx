// File: src/components/ui/slider.jsx
// Production-ready, dependency-light Slider component (JS + React)
//
// - No external deps (no Radix required)
// - Accessible: role="slider", aria-* attributes, keyboard control
// - Controlled or uncontrolled
// - Supports:
//   - single value or range (two thumbs) via value={[min,max]}
//   - step, min, max
//   - onValueChange (live) + onValueCommit (pointer up / key up)
//   - marks (ticks) and optional labels
//   - optional label/hint/error wrappers
//
// Usage:
//   import { Slider } from "@/components/ui/slider";
//
//   <Slider
//     label="Spice level"
//     min={0}
//     max={10}
//     step={1}
//     defaultValue={[3]}
//     onValueChange={(v)=>setSpice(v[0])}
//   />
//
//   Range:
//   <Slider
//     label="Calories range"
//     min={0}
//     max={5000}
//     step={50}
//     value={[1200, 1800]}
//     onValueChange={(v)=>setRange(v)}
//   />

import * as React from "react";

/* ------------------------------ utils ------------------------------ */
function cn(...inputs) {
  const out = [];
  for (const input of inputs) {
    if (!input) continue;
    if (typeof input === "string") out.push(input);
    else if (Array.isArray(input)) out.push(cn(...input));
    else if (typeof input === "object") {
      for (const [k, v] of Object.entries(input)) if (v) out.push(k);
    }
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function roundToStep(value, step, min) {
  const s = step > 0 ? step : 1;
  const inv = 1 / s;
  // align to min
  const aligned = Math.round((value - min) * inv) / inv + min;
  // avoid floating drift
  const decimals = String(s).includes(".") ? String(s).split(".")[1].length : 0;
  return Number(aligned.toFixed(decimals));
}

function ensureArrayValue(v, { min, max, step }) {
  let arr = Array.isArray(v) ? v.slice() : [v];
  arr = arr.map((x) => (Number.isFinite(+x) ? +x : min));
  arr = arr.map((x) => roundToStep(clamp(x, min, max), step, min));
  if (arr.length === 0) arr = [min];
  if (arr.length > 2) arr = arr.slice(0, 2);
  // keep sorted for range
  if (arr.length === 2) arr.sort((a, b) => a - b);
  return arr;
}

function useControllableArray({ value, defaultValue, onChange, normalize }) {
  const controlled = value !== undefined;
  const [uncontrolled, setUncontrolled] = React.useState(defaultValue);
  const current = controlled ? value : uncontrolled;

  const set = React.useCallback(
    (next) => {
      const normalized = normalize(next);
      if (!controlled) setUncontrolled(normalized);
      if (typeof onChange === "function") onChange(normalized);
    },
    [controlled, onChange, normalize]
  );

  return [normalize(current), set, controlled];
}

function percentFromValue(v, min, max) {
  if (max <= min) return 0;
  return ((v - min) / (max - min)) * 100;
}

function valueFromClientX(clientX, trackRect, min, max, step) {
  if (!trackRect) return min;
  const x = clamp(clientX - trackRect.left, 0, trackRect.width);
  const ratio = trackRect.width ? x / trackRect.width : 0;
  const raw = min + ratio * (max - min);
  return roundToStep(clamp(raw, min, max), step, min);
}

/* ------------------------------ helpers ------------------------------ */
export const SliderLabel = React.forwardRef(function SliderLabel(
  { className, ...props },
  ref
) {
  return (
    <label
      ref={ref}
      data-ui="slider-label"
      className={cn("block text-sm font-medium text-slate-800 mb-1", className)}
      {...props}
    />
  );
});
SliderLabel.displayName = "SliderLabel";

export const SliderHint = React.forwardRef(function SliderHint(
  { className, ...props },
  ref
) {
  return (
    <p
      ref={ref}
      data-ui="slider-hint"
      className={cn("mt-1 text-xs text-slate-500", className)}
      {...props}
    />
  );
});
SliderHint.displayName = "SliderHint";

export const SliderError = React.forwardRef(function SliderError(
  { className, ...props },
  ref
) {
  return (
    <p
      ref={ref}
      data-ui="slider-error"
      className={cn("mt-1 text-xs text-red-600", className)}
      {...props}
    />
  );
});
SliderError.displayName = "SliderError";

/* ------------------------------ Slider ------------------------------ */
/**
 * Slider
 *
 * Props:
 * - value?: number[]   (controlled)  length 1 or 2
 * - defaultValue?: number[] (uncontrolled)
 * - onValueChange?: (value:number[]) => void
 * - onValueCommit?: (value:number[]) => void (fires on pointer up / key up)
 * - min, max, step
 * - disabled
 * - orientation: "horizontal" only (vertical not implemented)
 * - label, hint, error
 * - showValue: boolean (renders current values)
 * - formatValue: (n)=>string
 * - marks: number[] or {value,label}[] for ticks
 */
export const Slider = React.forwardRef(function Slider(
  {
    className,
    trackClassName,
    rangeClassName,
    thumbClassName,
    wrapperClassName,

    value,
    defaultValue = [0],
    onValueChange,
    onValueCommit,

    min = 0,
    max = 100,
    step = 1,

    disabled = false,

    label,
    hint,
    error,

    showValue = false,
    formatValue = (n) => String(n),

    marks,

    name, // optional for forms: emits hidden inputs
    id,

    ...props
  },
  ref
) {
  const normalize = React.useCallback(
    (v) => ensureArrayValue(v ?? defaultValue, { min, max, step }),
    [defaultValue, min, max, step]
  );

  const [vals, setVals] = useControllableArray({
    value,
    defaultValue,
    onChange: onValueChange,
    normalize,
  });

  const isRange = vals.length === 2;
  const sliderId = id || name || undefined;

  const trackRef = React.useRef(null);
  const mergedRef = React.useCallback(
    (node) => {
      trackRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref]
  );

  const [activeThumb, setActiveThumb] = React.useState(0); // 0 or 1
  const isDraggingRef = React.useRef(false);
  const lastCommittedRef = React.useRef(vals);

  React.useEffect(() => {
    lastCommittedRef.current = vals;
  }, [vals]);

  const commit = React.useCallback(
    (next) => {
      if (typeof onValueCommit === "function") onValueCommit(next);
    },
    [onValueCommit]
  );

  const setAt = React.useCallback(
    (index, nextValue, { commitNow = false } = {}) => {
      const next = vals.slice();
      if (index === 0) next[0] = nextValue;
      else {
        // ensure a second thumb exists
        if (next.length === 1) next.push(next[0]);
        next[1] = nextValue;
      }

      // enforce ordering for range
      const normalizedNext = ensureArrayValue(next, { min, max, step });

      // If user is dragging a thumb and crosses over, we swap active thumb
      if (normalizedNext.length === 2) {
        const was = vals;
        const now = normalizedNext;
        const crossed =
          (index === 0 &&
            was[0] !== undefined &&
            was[1] !== undefined &&
            now[0] > was[1]) ||
          (index === 1 &&
            was[0] !== undefined &&
            was[1] !== undefined &&
            now[1] < was[0]);
        // The normalized array sorts, so we detect crossing by comparing intended index movement.
        // A simpler approach: if range and nextValue is closer to other side, allow swap:
        if (crossed) setActiveThumb(index === 0 ? 1 : 0);
      }

      setVals(normalizedNext);
      if (commitNow) commit(normalizedNext);
    },
    [vals, min, max, step, setVals, commit]
  );

  const pickClosestThumb = React.useCallback(
    (v) => {
      if (!isRange) return 0;
      const d0 = Math.abs(v - vals[0]);
      const d1 = Math.abs(v - vals[1]);
      return d0 <= d1 ? 0 : 1;
    },
    [isRange, vals]
  );

  const handlePointerDown = (e) => {
    if (disabled) return;
    const track = trackRef.current;
    if (!track) return;

    const rect = track.getBoundingClientRect();
    const nextVal = valueFromClientX(e.clientX, rect, min, max, step);

    const which = pickClosestThumb(nextVal);
    setActiveThumb(which);
    isDraggingRef.current = true;
    track.setPointerCapture?.(e.pointerId);

    setAt(which, nextVal);
  };

  const handlePointerMove = (e) => {
    if (disabled) return;
    if (!isDraggingRef.current) return;
    const track = trackRef.current;
    if (!track) return;

    const rect = track.getBoundingClientRect();
    const nextVal = valueFromClientX(e.clientX, rect, min, max, step);
    setAt(activeThumb, nextVal);
  };

  const handlePointerUp = (e) => {
    if (disabled) return;
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;
    const latest = lastCommittedRef.current;
    commit(latest);
  };

  const onThumbKeyDown = (index) => (e) => {
    if (disabled) return;

    let delta = 0;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") delta = -step;
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") delta = +step;
    else if (e.key === "Home") {
      e.preventDefault();
      setActiveThumb(index);
      setAt(index, min);
      return;
    } else if (e.key === "End") {
      e.preventDefault();
      setActiveThumb(index);
      setAt(index, max);
      return;
    } else if (e.key === "PageDown") delta = -step * 10;
    else if (e.key === "PageUp") delta = +step * 10;
    else return;

    e.preventDefault();
    setActiveThumb(index);
    const next = roundToStep(clamp(vals[index] + delta, min, max), step, min);
    setAt(index, next);
  };

  const onThumbKeyUp = (e) => {
    if (disabled) return;
    // Commit on key up after keyboard adjustments
    if (
      e.key === "ArrowLeft" ||
      e.key === "ArrowRight" ||
      e.key === "ArrowUp" ||
      e.key === "ArrowDown" ||
      e.key === "Home" ||
      e.key === "End" ||
      e.key === "PageUp" ||
      e.key === "PageDown"
    ) {
      commit(vals);
    }
  };

  // Visuals
  const p0 = percentFromValue(vals[0], min, max);
  const p1 = isRange ? percentFromValue(vals[1], min, max) : p0;

  const leftPct = isRange ? Math.min(p0, p1) : 0;
  const rightPct = isRange ? 100 - Math.max(p0, p1) : 100 - p0;
  const rangeWidth = isRange ? 100 - leftPct - rightPct : p0;

  const baseTrack = "relative h-2 w-full rounded-full bg-slate-200";
  const baseRange = "absolute h-2 rounded-full bg-slate-900";
  const baseThumb =
    "absolute top-1/2 -translate-y-1/2 h-5 w-5 rounded-full bg-white border border-slate-300 " +
    "shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 " +
    "focus-visible:ring-slate-400/40 ring-offset-white";

  const disabledCls = disabled
    ? "opacity-50 cursor-not-allowed"
    : "cursor-pointer";
  const errorCls = error ? "ring-1 ring-red-400/60" : "";

  const helpId =
    (hint || error) && (sliderId || "slider")
      ? `${sliderId || "slider"}-help`
      : undefined;

  const renderMarks = () => {
    if (!marks) return null;

    const items = Array.isArray(marks) ? marks : [];
    const normalizedMarks = items
      .map((m) =>
        typeof m === "number"
          ? { value: m, label: null }
          : { value: m?.value, label: m?.label ?? null }
      )
      .filter((m) => Number.isFinite(m.value))
      .map((m) => ({
        value: clamp(+m.value, min, max),
        label: m.label,
        pct: percentFromValue(clamp(+m.value, min, max), min, max),
      }));

    return (
      <div className="relative mt-3">
        <div className="relative h-3">
          {normalizedMarks.map((m) => (
            <span
              key={`mark-${m.value}`}
              className="absolute top-1/2 -translate-y-1/2 h-2 w-0.5 bg-slate-300"
              style={{ left: `${m.pct}%` }}
              aria-hidden="true"
            />
          ))}
        </div>
        {normalizedMarks.some((m) => m.label != null) ? (
          <div className="relative mt-1 text-[11px] text-slate-500">
            {normalizedMarks.map((m) =>
              m.label != null ? (
                <span
                  key={`mark-label-${m.value}`}
                  className="absolute -translate-x-1/2"
                  style={{ left: `${m.pct}%` }}
                >
                  {m.label}
                </span>
              ) : null
            )}
            {/* spacer to give the labels room */}
            <span className="invisible">.</span>
          </div>
        ) : null}
      </div>
    );
  };

  const valuesDisplay = showValue ? (
    <div className="mt-1 text-xs text-slate-600">
      {isRange
        ? `${formatValue(vals[0])} – ${formatValue(vals[1])}`
        : formatValue(vals[0])}
    </div>
  ) : null;

  return (
    <div className={cn("w-full", wrapperClassName)} data-ui="slider-root">
      {label ? <SliderLabel htmlFor={sliderId}>{label}</SliderLabel> : null}

      {/* Hidden inputs for forms */}
      {name ? (
        <>
          <input type="hidden" name={`${name}[0]`} value={String(vals[0])} />
          {isRange ? (
            <input type="hidden" name={`${name}[1]`} value={String(vals[1])} />
          ) : null}
        </>
      ) : null}

      <div
        ref={mergedRef}
        id={sliderId}
        className={cn(
          "relative w-full touch-none select-none",
          disabledCls,
          className
        )}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        aria-describedby={helpId || undefined}
        data-ui="slider"
        {...props}
      >
        {/* Track */}
        <div
          className={cn(baseTrack, errorCls, trackClassName)}
          aria-hidden="true"
        >
          {/* Range highlight */}
          <div
            className={cn(baseRange, rangeClassName)}
            style={{
              left: `${isRange ? leftPct : 0}%`,
              width: `${isRange ? rangeWidth : p0}%`,
            }}
          />
          {/* Thumbs */}
          <button
            type="button"
            role="slider"
            aria-label="Slider thumb"
            aria-valuemin={min}
            aria-valuemax={isRange ? vals[1] : max}
            aria-valuenow={vals[0]}
            aria-disabled={disabled ? "true" : undefined}
            aria-invalid={error ? "true" : undefined}
            tabIndex={disabled ? -1 : 0}
            className={cn(baseThumb, thumbClassName)}
            style={{ left: `${p0}%`, transform: "translate(-50%, -50%)" }}
            onKeyDown={onThumbKeyDown(0)}
            onKeyUp={onThumbKeyUp}
            onFocus={() => setActiveThumb(0)}
          />
          {isRange ? (
            <button
              type="button"
              role="slider"
              aria-label="Slider thumb"
              aria-valuemin={vals[0]}
              aria-valuemax={max}
              aria-valuenow={vals[1]}
              aria-disabled={disabled ? "true" : undefined}
              aria-invalid={error ? "true" : undefined}
              tabIndex={disabled ? -1 : 0}
              className={cn(baseThumb, thumbClassName)}
              style={{ left: `${p1}%`, transform: "translate(-50%, -50%)" }}
              onKeyDown={onThumbKeyDown(1)}
              onKeyUp={onThumbKeyUp}
              onFocus={() => setActiveThumb(1)}
            />
          ) : null}
        </div>

        {valuesDisplay}
        {renderMarks()}
      </div>

      {error ? (
        <SliderError id={helpId}>{error}</SliderError>
      ) : hint ? (
        <SliderHint id={helpId}>{hint}</SliderHint>
      ) : null}
    </div>
  );
});

Slider.displayName = "Slider";

export default Slider;
