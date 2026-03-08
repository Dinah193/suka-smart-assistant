// C:\Users\larho\suka-smart-assistant\src\components\ui\input.jsx
//
// SSA UI Kit — Input
// -----------------------------------------------------------------------------
// Goals:
// - Drop-in compatible with shadcn-style imports: `import { Input } from "@/components/ui/input"`
// - Works with Vite + React (JS, not TS)
// - Conservative, production-safe styles (Tailwind-first, but degrades gracefully)
// - Supports forwardRef, standard input props, and optional left/right adornments
//
// Notes:
// - If Tailwind is enabled, className strings provide a solid default.
// - If Tailwind is not enabled, component still renders a normal <input>.
//
// -----------------------------------------------------------------------------

import React from "react";

/** Join class names safely */
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
 * Input
 *
 * @param {Object} props
 * @param {string=} props.className - appended to base styles
 * @param {string=} props.type - input type (default "text")
 * @param {React.ReactNode=} props.left - optional left adornment (icon/text)
 * @param {React.ReactNode=} props.right - optional right adornment (icon/text)
 * @param {string=} props.wrapperClassName - className for wrapper (when using left/right)
 * @param {string=} props.inputClassName - className for the <input> itself (in addition to className)
 * @param {boolean=} props.invalid - when true, applies error styling
 * @param {string=} props.ariaLabel - convenience aria-label (if you don't pass aria-label)
 * @param {any} rest - normal <input> props
 */
export const Input = React.forwardRef(function Input(
  {
    className = "",
    type = "text",
    left = null,
    right = null,
    wrapperClassName = "",
    inputClassName = "",
    invalid = false,
    ariaLabel,
    ...rest
  },
  ref
) {
  const hasAdornment = !!left || !!right;

  const baseInput = cn(
    // Layout
    "flex h-10 w-full rounded-md border px-3 py-2 text-sm",
    // Colors
    "border-slate-300 bg-white text-slate-900 placeholder:text-slate-400",
    // Focus ring
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white",
    // Disabled
    "disabled:cursor-not-allowed disabled:opacity-50",
    // Dark mode (if enabled globally)
    "dark:border-slate-700 dark:bg-slate-950 dark:text-slate-50 dark:placeholder:text-slate-500",
    "dark:focus-visible:ring-slate-500 dark:focus-visible:ring-offset-slate-950",
    // Invalid styling
    invalid
      ? "border-rose-500 focus-visible:ring-rose-500 dark:border-rose-500 dark:focus-visible:ring-rose-500"
      : "",
    className,
    inputClassName
  );

  // If no adornments, return plain input (simpler DOM).
  if (!hasAdornment) {
    return (
      <input
        ref={ref}
        type={type}
        className={baseInput}
        aria-label={rest["aria-label"] || ariaLabel}
        aria-invalid={invalid || rest["aria-invalid"] || undefined}
        {...rest}
      />
    );
  }

  // With adornments, wrap to keep padding consistent.
  // We give the input extra left/right padding if adornments exist.
  const paddedInput = cn(baseInput, left ? "pl-10" : "", right ? "pr-10" : "");

  const wrapper = cn("relative w-full", wrapperClassName);

  const adornBase =
    "absolute inset-y-0 flex items-center text-slate-500 dark:text-slate-400";

  return (
    <div className={wrapper}>
      {left ? (
        <div className={cn(adornBase, "left-0 pl-3 pointer-events-none")}>
          {left}
        </div>
      ) : null}

      <input
        ref={ref}
        type={type}
        className={paddedInput}
        aria-label={rest["aria-label"] || ariaLabel}
        aria-invalid={invalid || rest["aria-invalid"] || undefined}
        {...rest}
      />

      {right ? (
        <div className={cn(adornBase, "right-0 pr-3")}>
          {/* right adornment is NOT pointer-events-none by default (so buttons/icons can be clickable) */}
          {right}
        </div>
      ) : null}
    </div>
  );
});

export default Input;
