// File: src/components/ui/select.jsx
// Production-ready, dependency-light Select components (JS + React)
//
// Goals:
// - Works as a *native* <select> by default (fast, accessible, no deps).
// - Optional "styled wrapper" with Chevron icon.
// - Includes tiny utilities: cn(), coerceValue(), option helpers.
// - Supports placeholder via first disabled <option> (native select pattern).
// - ✅ Shadcn-compat exports: SelectTrigger/SelectValue/SelectContent/SelectItem
//   so older pages importing those names won't crash builds.
//
// Shadcn-compat usage supported (renders as native select):
//   <Select value={diet} onValueChange={setDiet}>
//     <SelectTrigger>
//       <SelectValue placeholder="Choose diet" />
//     </SelectTrigger>
//     <SelectContent>
//       <SelectItem value="balanced">Balanced</SelectItem>
//       <SelectItem value="keto">Keto</SelectItem>
//     </SelectContent>
//   </Select>
//
// Native usage still supported:
//   <Select label="Store" value={store} onChange={(e)=>...} options={[...]} />

import * as React from "react";

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
 * Coerces value to string (native select uses strings).
 * Allows passing numbers/booleans while keeping controlled behavior stable.
 */
function coerceValue(value) {
  if (value === undefined || value === null) return "";
  return String(value);
}

/**
 * @typedef {{ value: string|number|boolean, label: React.ReactNode, disabled?: boolean }} SelectOption
 */

/* -----------------------------------------------------------------------------
 * Helper UI bits
 * -------------------------------------------------------------------------- */

export const SelectLabel = React.forwardRef(function SelectLabel(
  { className, ...props },
  ref
) {
  return (
    <label
      ref={ref}
      data-ui="select-label"
      className={cn("block text-sm font-medium text-slate-800 mb-1", className)}
      {...props}
    />
  );
});
SelectLabel.displayName = "SelectLabel";

export const SelectHint = React.forwardRef(function SelectHint(
  { className, ...props },
  ref
) {
  return (
    <p
      ref={ref}
      data-ui="select-hint"
      className={cn("mt-1 text-xs text-slate-500", className)}
      {...props}
    />
  );
});
SelectHint.displayName = "SelectHint";

export const SelectError = React.forwardRef(function SelectError(
  { className, ...props },
  ref
) {
  return (
    <p
      ref={ref}
      data-ui="select-error"
      className={cn("mt-1 text-xs text-red-600", className)}
      {...props}
    />
  );
});
SelectError.displayName = "SelectError";

function ChevronDownIcon({ className }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="currentColor"
      className={cn("h-4 w-4", className)}
    >
      <path
        fillRule="evenodd"
        d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 10.94l3.71-3.71a.75.75 0 1 1 1.06 1.06l-4.24 4.24a.75.75 0 0 1-1.06 0L5.21 8.29a.75.75 0 0 1 .02-1.08z"
        clipRule="evenodd"
      />
    </svg>
  );
}

/* -----------------------------------------------------------------------------
 * Shadcn-compat marker components
 * (They are "declarative config"; Select() will parse them and render native.)
 * -------------------------------------------------------------------------- */

export function SelectTrigger() {
  return null;
}
SelectTrigger.displayName = "SelectTrigger";

export function SelectContent() {
  return null;
}
SelectContent.displayName = "SelectContent";

export function SelectValue() {
  return null;
}
SelectValue.displayName = "SelectValue";

export function SelectItem() {
  return null;
}
SelectItem.displayName = "SelectItem";

/**
 * Parse a shadcn-like Select tree and return:
 * - placeholder (from SelectValue placeholder)
 * - items array (from SelectItem value/children)
 */
function parseShadcnChildren(children) {
  /** @type {{ placeholder?: string, items: Array<{value:any,label:any,disabled?:boolean}> }} */
  const acc = { placeholder: undefined, items: [] };

  const walk = (node) => {
    if (node === null || node === undefined) return;
    if (typeof node === "string" || typeof node === "number") return;
    if (!React.isValidElement(node)) return;

    const t = node.type;

    // placeholder
    if (t === SelectValue) {
      const ph = node.props?.placeholder;
      if (typeof ph === "string" && ph.trim()) acc.placeholder = ph.trim();
    }

    // items
    if (t === SelectItem) {
      const v = node.props?.value;
      acc.items.push({
        value: v,
        label: node.props?.children,
        disabled: !!node.props?.disabled,
      });
    }

    // recurse
    const kids = node.props?.children;
    if (kids) {
      React.Children.forEach(kids, (c) => walk(c));
    }
  };

  React.Children.forEach(children, (c) => walk(c));

  return acc;
}

function hasShadcnMarkers(children) {
  let found = false;

  const walk = (node) => {
    if (found) return;
    if (!React.isValidElement(node)) return;
    const t = node.type;
    if (
      t === SelectTrigger ||
      t === SelectContent ||
      t === SelectItem ||
      t === SelectValue
    ) {
      found = true;
      return;
    }
    const kids = node.props?.children;
    if (kids) React.Children.forEach(kids, (c) => walk(c));
  };

  React.Children.forEach(children, (c) => walk(c));
  return found;
}

/* -----------------------------------------------------------------------------
 * Select (native renderer + shadcn-compat parser)
 * -------------------------------------------------------------------------- */

export const Select = React.forwardRef(function Select(
  {
    className,
    wrapperClassName,
    options,
    placeholder,
    label,
    hint,
    error,
    id,
    name,
    value,
    defaultValue,
    disabled,
    required,
    children,
    onChange,

    // shadcn-ish prop name support:
    onValueChange,

    ...props
  },
  ref
) {
  const selectId = id || name || undefined;

  // Detect shadcn-like composed children and convert to native options.
  const useCompat = children && hasShadcnMarkers(children);
  const compat = useCompat ? parseShadcnChildren(children) : null;

  const effectivePlaceholder =
    placeholder || (compat && compat.placeholder) || undefined;

  /** @type {SelectOption[]|undefined} */
  const effectiveOptions =
    Array.isArray(options) && options.length
      ? options
      : compat && Array.isArray(compat.items) && compat.items.length
      ? compat.items
      : undefined;

  // Controlled vs uncontrolled: honor `value`/`defaultValue` first.
  const isControlled = value !== undefined;
  const coercedValue = isControlled ? coerceValue(value) : undefined;
  const coercedDefaultValue =
    !isControlled && defaultValue !== undefined
      ? coerceValue(defaultValue)
      : undefined;

  const base =
    "block w-full appearance-none rounded-md border border-slate-300 bg-white " +
    "px-3 py-2 pr-10 text-sm text-slate-900 " +
    "placeholder:text-slate-400 " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40 focus-visible:ring-offset-2 " +
    "disabled:cursor-not-allowed disabled:opacity-50";

  const errorRing = error ? "border-red-400 focus-visible:ring-red-500/30" : "";

  const handleChange = (e) => {
    if (typeof onChange === "function") onChange(e);
    if (typeof onValueChange === "function") onValueChange(e.target.value);
  };

  // If compat markers exist, we ignore their rendering and output a single native select.
  // If there are no compat markers:
  // - if children are provided, we render them directly (native <option> children)
  // - else we render `options` prop
  const renderOptions = () => {
    if (useCompat) {
      // Render from effectiveOptions only
      return (
        <>
          {effectivePlaceholder ? (
            <option value="" disabled={required} hidden={required}>
              {effectivePlaceholder}
            </option>
          ) : null}

          {Array.isArray(effectiveOptions)
            ? effectiveOptions.map((opt, idx) => (
                <option
                  key={`${String(opt.value)}-${idx}`}
                  value={coerceValue(opt.value)}
                  disabled={!!opt.disabled}
                >
                  {opt.label}
                </option>
              ))
            : null}
        </>
      );
    }

    // Non-compat (original behavior)
    return (
      <>
        {effectivePlaceholder ? (
          <option value="" disabled={required} hidden={required}>
            {effectivePlaceholder}
          </option>
        ) : null}

        {children
          ? children
          : Array.isArray(effectiveOptions)
          ? effectiveOptions.map((opt, idx) => (
              <option
                key={`${String(opt.value)}-${idx}`}
                value={coerceValue(opt.value)}
                disabled={!!opt.disabled}
              >
                {opt.label}
              </option>
            ))
          : null}
      </>
    );
  };

  return (
    <div className={cn("w-full", wrapperClassName)} data-ui="select-root">
      {label ? <SelectLabel htmlFor={selectId}>{label}</SelectLabel> : null}

      <div className="relative">
        <select
          ref={ref}
          id={selectId}
          name={name}
          className={cn(base, errorRing, className)}
          value={coercedValue}
          defaultValue={coercedDefaultValue}
          disabled={disabled}
          required={required}
          onChange={handleChange}
          data-ui="select"
          aria-invalid={error ? "true" : undefined}
          aria-describedby={
            hint || error ? `${selectId || "select"}-help` : undefined
          }
          {...props}
        >
          {renderOptions()}
        </select>

        <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-slate-500">
          <ChevronDownIcon />
        </span>
      </div>

      {error ? (
        <SelectError id={`${selectId || "select"}-help`}>{error}</SelectError>
      ) : hint ? (
        <SelectHint id={`${selectId || "select"}-help`}>{hint}</SelectHint>
      ) : null}
    </div>
  );
});
Select.displayName = "Select";

/* -----------------------------------------------------------------------------
 * Utilities
 * -------------------------------------------------------------------------- */

export function toOptions(values, { disabledValues = new Set() } = {}) {
  if (!Array.isArray(values)) return [];
  const disSet =
    disabledValues instanceof Set ? disabledValues : new Set(disabledValues);
  return values.map((v) => ({
    value: v,
    label: v,
    disabled: disSet.has(v),
  }));
}

export function fromMap(mapObj) {
  if (!mapObj || typeof mapObj !== "object") return [];
  return Object.entries(mapObj).map(([value, label]) => ({
    value,
    label,
  }));
}

export default Select;
