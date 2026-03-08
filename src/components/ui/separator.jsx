// File: src/components/ui/separator.jsx
//
// SSA UI Kit — Separator
// -----------------------------------------------------------------------------
// Goals:
// - Drop-in compatible with shadcn-style imports:
//     import { Separator } from "@/components/ui/separator";
// - Works with Vite + React (JavaScript, not TypeScript)
// - Accessible (ARIA-friendly) and orientation-aware
// - Tailwind-first styling with graceful degradation
//
// -----------------------------------------------------------------------------

import * as React from "react";

/** Safe className joiner */
function cn(...parts) {
  return parts
    .flatMap((p) => {
      if (!p) return [];
      if (Array.isArray(p)) return p;
      return [p];
    })
    .filter(Boolean)
    .join(" ");
}

/**
 * Separator
 *
 * @param {Object} props
 * @param {"horizontal"|"vertical"} [props.orientation="horizontal"]
 * @param {boolean} [props.decorative=true]
 * @param {string} [props.className]
 * @param {any} props.rest
 *
 * Usage:
 *   <Separator />
 *   <Separator className="my-4" />
 *   <Separator orientation="vertical" className="mx-3 h-8" />
 */
export const Separator = React.forwardRef(function Separator(
  { orientation = "horizontal", decorative = true, className = "", ...props },
  ref
) {
  const isVertical = orientation === "vertical";

  return (
    <div
      ref={ref}
      role={decorative ? "presentation" : "separator"}
      aria-orientation={decorative ? undefined : orientation}
      className={cn(
        // base color
        "shrink-0 bg-slate-200 dark:bg-slate-800",
        // orientation sizing
        isVertical ? "h-full w-px" : "h-px w-full",
        className
      )}
      {...props}
    />
  );
});

export default Separator;
