// File: src/components/ui/textarea.jsx
// Production-ready, dependency-light Textarea component (JS + React)

import * as React from "react";

/**
 * Tiny className merge helper (avoids external deps).
 * Accepts strings, arrays, and {class: boolean} objects.
 */
function cn(...inputs) {
  const out = [];
  for (const input of inputs) {
    if (!input) continue;
    if (typeof input === "string") {
      out.push(input);
      continue;
    }
    if (Array.isArray(input)) {
      out.push(cn(...input));
      continue;
    }
    if (typeof input === "object") {
      for (const [k, v] of Object.entries(input)) if (v) out.push(k);
    }
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Textarea
 * - Tailwind-first styling
 * - Works with uncontrolled and controlled usage
 * - Optional autoResize (no scrollbars until maxRows hit)
 * - Optional maxRows / minRows
 *
 * Usage:
 *   <Textarea placeholder="Write notes..." />
 *   <Textarea value={v} onChange={...} autoResize minRows={3} maxRows={12} />
 */
export const Textarea = React.forwardRef(function Textarea(
  {
    className,
    autoResize = false,
    minRows = 3,
    maxRows = 12,
    onChange,
    onInput,
    style,
    ...props
  },
  ref
) {
  const innerRef = React.useRef(null);

  // Merge forwarded ref + local ref
  React.useImperativeHandle(ref, () => innerRef.current);

  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

  const resizeToFit = React.useCallback(() => {
    if (!autoResize) return;
    const el = innerRef.current;
    if (!el) return;

    // Ensure we have a rows baseline
    const rows = clamp(Number(el.rows || minRows), 1, 999);
    if (!el.rows) el.rows = rows;

    // Reset height to compute true scrollHeight
    el.style.height = "auto";

    // Compute line height (fallback if NaN)
    const cs = window.getComputedStyle(el);
    let lineHeight = parseFloat(cs.lineHeight);
    if (!Number.isFinite(lineHeight)) {
      const fontSize = parseFloat(cs.fontSize);
      lineHeight = Number.isFinite(fontSize) ? fontSize * 1.2 : 16 * 1.2;
    }

    const paddingTop = parseFloat(cs.paddingTop) || 0;
    const paddingBottom = parseFloat(cs.paddingBottom) || 0;

    // Convert maxRows to a maxHeight cap
    const minH =
      lineHeight * clamp(minRows, 1, 999) + paddingTop + paddingBottom;
    const maxH =
      lineHeight * clamp(maxRows, 1, 999) + paddingTop + paddingBottom;

    // scrollHeight already includes padding
    const nextH = clamp(el.scrollHeight, minH, maxH);

    el.style.height = `${nextH}px`;
    // Only show scrollbar if content exceeds max height
    el.style.overflowY = el.scrollHeight > maxH ? "auto" : "hidden";
  }, [autoResize, minRows, maxRows]);

  // Resize on mount + when toggling autoResize
  React.useEffect(() => {
    resizeToFit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoResize, minRows, maxRows]);

  const handleInput = (e) => {
    if (autoResize) resizeToFit();
    if (typeof onInput === "function") onInput(e);
  };

  const handleChange = (e) => {
    // Change fires for controlled usage; keep resize in sync too
    if (autoResize) resizeToFit();
    if (typeof onChange === "function") onChange(e);
  };

  const base =
    "flex w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm " +
    "placeholder:text-slate-400 " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40 focus-visible:ring-offset-2 " +
    "disabled:cursor-not-allowed disabled:opacity-50 " +
    "min-h-[80px]";

  // If autoResize, we manage overflow/height inline (but still allow override)
  const mergedStyle = autoResize
    ? {
        ...style,
        overflowY: style?.overflowY ?? "hidden",
        resize: style?.resize ?? "none",
      }
    : style;

  return (
    <textarea
      ref={innerRef}
      data-ui="textarea"
      rows={props.rows ?? minRows}
      className={cn(base, className)}
      onInput={handleInput}
      onChange={handleChange}
      style={mergedStyle}
      {...props}
    />
  );
});

Textarea.displayName = "Textarea";

export default Textarea;
