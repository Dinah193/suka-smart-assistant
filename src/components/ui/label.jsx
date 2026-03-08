// File: src/components/ui/label.jsx
// SSA UI: accessible label component (Radix-free, dependency-free)
// Compatible with React 18/19.
// Works with Tailwind (your project already uses Tailwind).
//
// Usage:
//   import { Label } from "@/components/ui/label";
//   <Label htmlFor="email">Email</Label>
//
// Notes:
// - Supports `required` prop to append an asterisk.
// - Supports `srOnly` for screen-reader-only labels.
// - Supports `hint` text rendered inline (optional).

import * as React from "react";

function cn(...parts) {
  return parts
    .flatMap((p) => (Array.isArray(p) ? p : [p]))
    .filter(Boolean)
    .join(" ");
}

export const Label = React.forwardRef(function Label(
  {
    className,
    children,
    required = false,
    srOnly = false,
    hint,
    hintClassName,
    ...props
  },
  ref
) {
  return (
    <label
      ref={ref}
      className={cn(
        "text-sm font-medium leading-none text-slate-900",
        "peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
        srOnly && "sr-only",
        className
      )}
      {...props}
    >
      <span className={cn("inline-flex items-center gap-2")}>
        <span>
          {children}
          {required ? (
            <span
              aria-hidden="true"
              className="ml-1 text-red-600 font-semibold"
              title="Required"
            >
              *
            </span>
          ) : null}
        </span>

        {hint ? (
          <span
            className={cn(
              "text-xs text-slate-500 font-normal leading-none",
              hintClassName
            )}
          >
            {hint}
          </span>
        ) : null}
      </span>
    </label>
  );
});

export default Label;
