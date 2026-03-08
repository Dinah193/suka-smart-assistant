// File: src/components/ui/switch.jsx
// Production-ready, dependency-light Switch (toggle) component (JS + React)
//
// - Accessible: role="switch", aria-checked, keyboard support (Space/Enter)
// - Controlled or uncontrolled
// - Optional label / hint / error helpers
// - No external deps (no Radix required)
//
// Usage:
//   import { Switch } from "@/components/ui/switch";
//
//   <Switch
//     label="Quiet hours"
//     checked={quiet}
//     onCheckedChange={setQuiet}
//     hint="Prevents loud alerts during Sabbath/quiet hours."
//   />
//
//   <Switch defaultChecked onCheckedChange={(v)=>console.log(v)} />

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

function useControllableBoolean({ value, defaultValue = false, onChange }) {
  const isControlled = value !== undefined;
  const [uncontrolled, setUncontrolled] = React.useState(!!defaultValue);
  const current = isControlled ? !!value : uncontrolled;

  const set = React.useCallback(
    (next) => {
      const v = !!next;
      if (!isControlled) setUncontrolled(v);
      if (typeof onChange === "function") onChange(v);
    },
    [isControlled, onChange]
  );

  return [current, set, isControlled];
}

export const SwitchLabel = React.forwardRef(function SwitchLabel(
  { className, ...props },
  ref
) {
  return (
    <label
      ref={ref}
      data-ui="switch-label"
      className={cn("text-sm font-medium text-slate-800", className)}
      {...props}
    />
  );
});
SwitchLabel.displayName = "SwitchLabel";

export const SwitchHint = React.forwardRef(function SwitchHint(
  { className, ...props },
  ref
) {
  return (
    <p
      ref={ref}
      data-ui="switch-hint"
      className={cn("text-xs text-slate-500", className)}
      {...props}
    />
  );
});
SwitchHint.displayName = "SwitchHint";

export const SwitchError = React.forwardRef(function SwitchError(
  { className, ...props },
  ref
) {
  return (
    <p
      ref={ref}
      data-ui="switch-error"
      className={cn("text-xs text-red-600", className)}
      {...props}
    />
  );
});
SwitchError.displayName = "SwitchError";

/**
 * Switch
 *
 * Props:
 * - checked / defaultChecked
 * - onCheckedChange(nextBool)
 * - disabled
 * - id / name
 * - label / hint / error (optional helpers)
 * - size: "sm" | "md" | "lg"
 * - align: "start" | "center" (alignment within helper wrapper)
 *
 * Note:
 * - This renders a button with role="switch" for accessibility.
 * - Also renders a hidden checkbox input for forms (optional via name).
 */
export const Switch = React.forwardRef(function Switch(
  {
    className,
    trackClassName,
    thumbClassName,
    wrapperClassName,

    id,
    name,

    checked,
    defaultChecked = false,
    onCheckedChange,

    disabled = false,
    required = false,

    label,
    hint,
    error,

    size = "md",
    align = "center",

    // For advanced usage you can control click handling
    onClick,
    onKeyDown,

    ...props
  },
  ref
) {
  const [isOn, setIsOn] = useControllableBoolean({
    value: checked,
    defaultValue: defaultChecked,
    onChange: onCheckedChange,
  });

  const switchId = id || name || undefined;

  const sizes = {
    sm: { track: "h-5 w-9", thumb: "h-4 w-4", shift: "translate-x-4" },
    md: { track: "h-6 w-11", thumb: "h-5 w-5", shift: "translate-x-5" },
    lg: { track: "h-7 w-14", thumb: "h-6 w-6", shift: "translate-x-7" },
  };

  const s = sizes[size] || sizes.md;

  const baseTrack =
    "relative inline-flex shrink-0 cursor-pointer rounded-full border transition-colors " +
    "focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 " +
    "disabled:cursor-not-allowed disabled:opacity-50";

  const trackColors = isOn
    ? "bg-slate-900 border-slate-900 focus-visible:ring-slate-900/30 ring-offset-white"
    : "bg-slate-200 border-slate-300 focus-visible:ring-slate-400/30 ring-offset-white";

  const trackError = error
    ? "border-red-400 focus-visible:ring-red-500/30"
    : "";

  const baseThumb =
    "pointer-events-none absolute left-0.5 top-1/2 -translate-y-1/2 rounded-full bg-white shadow " +
    "transition-transform";

  const thumbPos = isOn ? s.shift : "translate-x-0";

  const wrapperAlign = align === "start" ? "items-start" : "items-center";

  const helpId =
    (hint || error) && (switchId || "switch")
      ? `${switchId || "switch"}-help`
      : undefined;

  const handleToggle = (e) => {
    if (disabled) return;
    const next = !isOn;
    setIsOn(next);
    if (typeof onClick === "function") onClick(e);
  };

  const handleKey = (e) => {
    if (typeof onKeyDown === "function") onKeyDown(e);
    if (disabled) return;

    // Space/Enter toggles
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      setIsOn(!isOn);
    }
  };

  return (
    <div className={cn("w-full", wrapperClassName)} data-ui="switch-root">
      <div className={cn("flex gap-3", wrapperAlign)}>
        {/* Hidden input for forms */}
        {name ? (
          <input
            type="checkbox"
            name={name}
            checked={isOn}
            readOnly
            required={required}
            hidden
          />
        ) : null}

        <button
          ref={ref}
          id={switchId}
          type="button"
          role="switch"
          aria-checked={isOn}
          aria-disabled={disabled ? "true" : undefined}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={helpId || undefined}
          disabled={disabled}
          onClick={handleToggle}
          onKeyDown={handleKey}
          className={cn(
            baseTrack,
            s.track,
            trackColors,
            trackError,
            className,
            trackClassName
          )}
          data-ui="switch"
          data-state={isOn ? "checked" : "unchecked"}
          data-size={size}
          {...props}
        >
          <span
            className={cn(baseThumb, s.thumb, thumbPos, thumbClassName)}
            data-ui="switch-thumb"
          />
        </button>

        {label || hint || error ? (
          <div className="min-w-0 flex-1">
            {label ? (
              <SwitchLabel
                htmlFor={switchId}
                className={cn(disabled && "opacity-60")}
              >
                {label}
              </SwitchLabel>
            ) : null}

            {error ? (
              <SwitchError id={helpId}>{error}</SwitchError>
            ) : hint ? (
              <SwitchHint id={helpId}>{hint}</SwitchHint>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
});

Switch.displayName = "Switch";

export default Switch;
