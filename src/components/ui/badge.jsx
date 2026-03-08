// File: src/components/ui/badge.jsx
// Production-ready, dependency-light Badge component (JS + React)

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
 * Badge
 * - Variants: default, secondary, outline, destructive, success, warning, info
 * - Sizes: sm, md, lg
 *
 * Usage:
 *   <Badge>New</Badge>
 *   <Badge variant="success" size="sm">Saved</Badge>
 */
export const Badge = React.forwardRef(function Badge(
  {
    className,
    variant = "default",
    size = "md",
    tone, // optional alias: tone="success" == variant="success" (if variant not explicitly set)
    ...props
  },
  ref
) {
  const v = variant ?? (tone || "default");

  const base =
    "inline-flex items-center whitespace-nowrap select-none font-medium " +
    "rounded-full border leading-none " +
    "transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 " +
    "disabled:opacity-50 disabled:pointer-events-none";

  const sizes = {
    sm: "text-[11px] px-2 py-0.5 gap-1",
    md: "text-xs px-2.5 py-1 gap-1.5",
    lg: "text-sm px-3 py-1.5 gap-2",
  };

  // Tailwind-first styles; also plays nicely if you have global .chip/.badge styles.
  const variants = {
    default:
      "bg-slate-900 text-white border-slate-900 " +
      "focus-visible:ring-slate-900/30 ring-offset-white",
    secondary:
      "bg-slate-100 text-slate-900 border-slate-200 " +
      "focus-visible:ring-slate-400/30 ring-offset-white",
    outline:
      "bg-transparent text-slate-900 border-slate-300 " +
      "focus-visible:ring-slate-400/30 ring-offset-white",
    destructive:
      "bg-red-600 text-white border-red-600 " +
      "focus-visible:ring-red-600/30 ring-offset-white",
    success:
      "bg-emerald-600 text-white border-emerald-600 " +
      "focus-visible:ring-emerald-600/30 ring-offset-white",
    warning:
      "bg-amber-500 text-slate-900 border-amber-500 " +
      "focus-visible:ring-amber-500/30 ring-offset-white",
    info:
      "bg-sky-600 text-white border-sky-600 " +
      "focus-visible:ring-sky-600/30 ring-offset-white",
  };

  const safeVariant = variants[v] ? v : "default";
  const safeSize = sizes[size] ? size : "md";

  return (
    <span
      ref={ref}
      data-ui="badge"
      data-variant={safeVariant}
      data-size={safeSize}
      className={cn(base, sizes[safeSize], variants[safeVariant], className)}
      {...props}
    />
  );
});

Badge.displayName = "Badge";

export default Badge;
