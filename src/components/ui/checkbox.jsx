// File: src/components/ui/checkbox.jsx
// Production-ready, dependency-light Checkbox components (JS + React)
//
// - Accessible: uses native <input type="checkbox"> for best compatibility.
// - Supports controlled/uncontrolled, indeterminate state, and form usage.
// - Optional label/hint/error helpers (common SSA form patterns).
// - No external deps.
//
// Usage:
//   import { Checkbox } from "@/components/ui/checkbox";
//
//   <Checkbox
//     label="Include leftovers"
//     checked={include}
//     onCheckedChange={setInclude}
//     hint="Adds leftover-aware lunch suggestions."
//   />
//
//   <Checkbox defaultChecked> ... </Checkbox>
//
//   Indeterminate:
//     <Checkbox checked="indeterminate" onCheckedChange={...} label="Select all" />

import * as React from "react";

/** Tiny className merge helper (avoids external deps). */
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

function useControllableChecked({ checked, defaultChecked = false, onChange }) {
  const controlled = checked !== undefined;
  const [uncontrolled, setUncontrolled] = React.useState(defaultChecked);

  const current = controlled ? checked : uncontrolled;

  const set = React.useCallback(
    (next) => {
      if (!controlled) setUncontrolled(next);
      if (typeof onChange === "function") onChange(next);
    },
    [controlled, onChange]
  );

  return [current, set, controlled];
}

function normalizeChecked(v) {
  if (v === "indeterminate") return "indeterminate";
  return !!v;
}

function CheckIcon({ className }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="currentColor"
      className={cn("h-4 w-4", className)}
    >
      <path
        fillRule="evenodd"
        d="M16.704 5.29a1 1 0 0 1 0 1.414l-7.07 7.07a1 1 0 0 1-1.415 0l-3.535-3.535a1 1 0 1 1 1.414-1.414l2.828 2.828 6.364-6.364a1 1 0 0 1 1.414 0Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function MinusIcon({ className }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="currentColor"
      className={cn("h-4 w-4", className)}
    >
      <path d="M5 10a1 1 0 0 1 1-1h8a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1Z" />
    </svg>
  );
}

export const CheckboxLabel = React.forwardRef(function CheckboxLabel(
  { className, ...props },
  ref
) {
  return (
    <label
      ref={ref}
      data-ui="checkbox-label"
      className={cn("text-sm font-medium text-slate-800", className)}
      {...props}
    />
  );
});
CheckboxLabel.displayName = "CheckboxLabel";

export const CheckboxHint = React.forwardRef(function CheckboxHint(
  { className, ...props },
  ref
) {
  return (
    <p
      ref={ref}
      data-ui="checkbox-hint"
      className={cn("text-xs text-slate-500", className)}
      {...props}
    />
  );
});
CheckboxHint.displayName = "CheckboxHint";

export const CheckboxError = React.forwardRef(function CheckboxError(
  { className, ...props },
  ref
) {
  return (
    <p
      ref={ref}
      data-ui="checkbox-error"
      className={cn("text-xs text-red-600", className)}
      {...props}
    />
  );
});
CheckboxError.displayName = "CheckboxError";

/**
 * Checkbox
 *
 * Props:
 * - checked: boolean | "indeterminate" (controlled)
 * - defaultChecked: boolean (uncontrolled)
 * - onCheckedChange(next): (boolean) => void
 *   - note: indeterminate resolves to boolean when user toggles
 * - disabled
 * - required
 * - name, value (form support)
 * - label, hint, error: helper UI
 * - size: "sm" | "md" | "lg"
 * - align: "start" | "center" (align label block relative to box)
 *
 * Also supports passing children as label content:
 *   <Checkbox checked={x} onCheckedChange={setX}>My label</Checkbox>
 */
export const Checkbox = React.forwardRef(function Checkbox(
  {
    className,
    boxClassName,
    wrapperClassName,

    id,
    name,
    value,

    checked,
    defaultChecked = false,
    onCheckedChange,

    disabled = false,
    required = false,

    label,
    children,
    hint,
    error,

    size = "md",
    align = "center",

    // Native input callbacks
    onChange,
    onBlur,
    onFocus,

    ...props
  },
  ref
) {
  const [state, setState] = useControllableChecked({
    checked,
    defaultChecked,
    onChange: onCheckedChange,
  });

  const normalized = normalizeChecked(state);
  const isIndeterminate = normalized === "indeterminate";
  const isChecked = normalized === true;

  const inputRef = React.useRef(null);
  const mergedRef = React.useCallback(
    (node) => {
      inputRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref]
  );

  // Keep native indeterminate property in sync
  React.useEffect(() => {
    if (!inputRef.current) return;
    inputRef.current.indeterminate = isIndeterminate;
  }, [isIndeterminate]);

  const checkboxId = id || name || undefined;
  const helpId =
    (hint || error) && (checkboxId || "checkbox")
      ? `${checkboxId || "checkbox"}-help`
      : undefined;

  const sizes = {
    sm: { box: "h-4 w-4", icon: "h-3.5 w-3.5" },
    md: { box: "h-5 w-5", icon: "h-4 w-4" },
    lg: { box: "h-6 w-6", icon: "h-5 w-5" },
  };
  const s = sizes[size] || sizes.md;

  const wrapperAlign = align === "start" ? "items-start" : "items-center";

  const boxBase =
    "relative inline-flex shrink-0 items-center justify-center rounded-md border " +
    "transition-colors focus-within:outline-none";

  const boxColors =
    isChecked || isIndeterminate
      ? "bg-slate-900 border-slate-900"
      : "bg-white border-slate-300";

  const focusRing =
    "ring-offset-white focus-within:ring-2 focus-within:ring-slate-400/40 focus-within:ring-offset-2";

  const errorRing = error ? "border-red-400 focus-within:ring-red-500/30" : "";

  const disabledCls = disabled
    ? "opacity-50 cursor-not-allowed"
    : "cursor-pointer";

  const labelText = label ?? (children ? children : null);

  const handleChange = (e) => {
    // native checkbox always yields boolean
    const next = !!e.target.checked;

    // If we were indeterminate, clicking resolves to checked=true (browser sets checked)
    // We just propagate next boolean.
    setState(next);

    if (typeof onChange === "function") onChange(e);
  };

  return (
    <div className={cn("w-full", wrapperClassName)} data-ui="checkbox-root">
      <div className={cn("flex gap-3", wrapperAlign)}>
        <span
          className={cn(
            boxBase,
            s.box,
            boxColors,
            focusRing,
            errorRing,
            disabledCls,
            boxClassName
          )}
          data-ui="checkbox-box"
          aria-hidden="true"
        >
          {/* The input is visually hidden but focusable for accessibility */}
          <input
            ref={mergedRef}
            id={checkboxId}
            name={name}
            value={value}
            type="checkbox"
            className={cn(
              "absolute inset-0 h-full w-full cursor-pointer opacity-0",
              disabled && "cursor-not-allowed"
            )}
            checked={
              checked !== undefined ? (isChecked ? true : false) : undefined
            }
            defaultChecked={
              checked === undefined ? !!defaultChecked : undefined
            }
            disabled={disabled}
            required={required}
            aria-invalid={error ? "true" : undefined}
            aria-describedby={helpId || undefined}
            onChange={handleChange}
            onBlur={onBlur}
            onFocus={onFocus}
            {...props}
          />

          {/* Icon */}
          {(isChecked || isIndeterminate) && (
            <span className="text-white">
              {isIndeterminate ? (
                <MinusIcon className={s.icon} />
              ) : (
                <CheckIcon className={s.icon} />
              )}
            </span>
          )}
        </span>

        {labelText ? (
          <div className="min-w-0 flex-1">
            {/* If we have an id, clicking label should toggle */}
            {checkboxId ? (
              <CheckboxLabel
                htmlFor={checkboxId}
                className={cn(disabled && "opacity-60")}
              >
                {labelText}
              </CheckboxLabel>
            ) : (
              <div
                className={cn(
                  "text-sm font-medium text-slate-800",
                  disabled && "opacity-60"
                )}
              >
                {labelText}
              </div>
            )}

            {error ? (
              <CheckboxError id={helpId}>{error}</CheckboxError>
            ) : hint ? (
              <CheckboxHint id={helpId}>{hint}</CheckboxHint>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
});

Checkbox.displayName = "Checkbox";

export default Checkbox;
