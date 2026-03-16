/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\ui\AccessibleField.jsx
import React, { useId, useMemo } from "react";

/**
 * AccessibleField — consistent labeled form control for SSA
 * -----------------------------------------------------------------------------
 * PIPELINE FIT
 * Imports → Intelligence → Automation → (optional) Hub Export
 *
 * This component is UI-only. It does not mutate household data.
 * - Ensures every field has an accessible <label> linked via id/for.
 * - Adds aria-describedby for hint/error text, and aria-invalid for errors.
 * - (Optional) Emits UI telemetry to the shared eventBus so analytics/automation
 *   can observe user interactions uniformly.
 *
 * CANONICAL EVENT SHAPE { type, ts, source, data }
 *   app.ui.field.focus    | app.ui.field.blur | app.ui.field.changed
 */

// ----------------------------- Soft Imports ---------------------------------
let eventBus = null;
try {
  eventBus =
    require("@/services/events/eventBus").default ??
    require("@/services/events/eventBus");
} catch {
  /* optional */
}

// ------------------------------ Utilities -----------------------------------
const nowISO = () => new Date().toISOString();
function emit(type, source, data) {
  const payload = { type, ts: nowISO(), source, data };
  try {
    eventBus?.emit?.(type, payload);
    window?.dispatchEvent?.(new CustomEvent(type, { detail: payload }));
  } catch (e) {
    if (process.env.NODE_ENV !== "production")
      console.debug("[AccessibleField] emit failed:", e);
  }
  return payload;
}

function clsx(...parts) {
  return parts.filter(Boolean).join(" ");
}

// ------------------------------- Component -----------------------------------
/**
 * Props
 * -----------------------------------------------------------------------------
 * label: string (required for visible or visually-hidden label)
 * labelVisuallyHidden?: boolean (keep label for a11y, hide visually)
 * as?: 'input' | 'select' | 'textarea' (default: 'input')
 * type?: input type (text, number, date, etc.) — only for as='input'
 * id?: string (auto-generated if not provided)
 * name?: string
 * value?: any
 * defaultValue?: any
 * placeholder?: string
 * required?: boolean
 * disabled?: boolean
 * readOnly?: boolean
 * autoComplete?: string
 * pattern?: string
 * min/max/step?: number | string (as applicable)
 * onChange?: (value or event) => void
 * onBlur?/onFocus?
 * error?: string | ReactNode
 * hint?: string | ReactNode
 * className?: string (wrapper)
 * inputClassName?: string (control)
 * labelClassName?: string
 * emitUIEvents?: boolean (default false) — if true, emits focus/blur/change telemetry
 * source?: string (for telemetry, default 'AccessibleField')
 *
 * For <select>, pass children <option/> nodes.
 * For <textarea>, 'rows' prop is supported (via rest props).
 */
export default function AccessibleField({
  label,
  labelVisuallyHidden = false,
  as = "input",
  type = "text",

  id: forcedId,
  name,
  value,
  defaultValue,
  placeholder,
  required,
  disabled,
  readOnly,
  autoComplete,
  pattern,
  min,
  max,
  step,

  onChange,
  onBlur,
  onFocus,

  error,
  hint,
  className = "",
  inputClassName = "",
  labelClassName = "",
  emitUIEvents = false,
  source = "AccessibleField",

  children,
  ...rest
}) {
  if (!label) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        "[AccessibleField] Missing `label` prop — a11y may fail audits."
      );
    }
  }

  const autoId = useId();
  // React 18 useId includes colons; sanitize to ensure valid CSS selector ids
  const id = useMemo(
    () => (forcedId || `field-${autoId}`).replaceAll(":", ""),
    [forcedId, autoId]
  );

  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  const baseInputClasses =
    "w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 outline-none ring-0 " +
    "placeholder-stone-400 focus:border-lime-600 focus:ring-2 focus:ring-lime-500/40 " +
    (disabled ? "opacity-60 cursor-not-allowed " : "") +
    (error
      ? "border-rose-400 focus:border-rose-500 focus:ring-rose-400/40 "
      : "");

  const Label = (
    <label
      htmlFor={id}
      className={clsx(
        "mb-1 block text-xs font-medium",
        error ? "text-rose-700" : "text-stone-700",
        labelVisuallyHidden && "sr-only",
        labelClassName
      )}
    >
      {label}
      {required ? (
        <span aria-hidden="true" className="ml-0.5 align-super text-rose-600">
          *
        </span>
      ) : null}
    </label>
  );

  const commonProps = {
    id,
    name,
    value,
    defaultValue,
    placeholder,
    required,
    disabled,
    readOnly,
    autoComplete,
    "aria-invalid": !!error || undefined,
    "aria-describedby": describedBy,
    className: clsx(baseInputClasses, inputClassName),
    onChange: (e) => {
      if (emitUIEvents) {
        emit("app.ui.field.changed", source, {
          id,
          name,
          type: as === "input" ? type : as,
          value: getValueSnapshot(e, as),
        });
      }
      onChange?.(as === "input" && type !== "file" ? e.target.value : e);
    },
    onFocus: (e) => {
      if (emitUIEvents) emit("app.ui.field.focus", source, { id, name });
      onFocus?.(e);
    },
    onBlur: (e) => {
      if (emitUIEvents) emit("app.ui.field.blur", source, { id, name });
      onBlur?.(e);
    },
    ...rest,
  };

  let Control = null;
  if (as === "textarea") {
    Control = <textarea {...commonProps} />;
  } else if (as === "select") {
    Control = <select {...commonProps}>{children}</select>;
  } else {
    // 'input' (default)
    Control = (
      <input
        {...commonProps}
        type={type}
        pattern={pattern}
        min={min}
        max={max}
        step={step}
      />
    );
  }

  return (
    <div className={clsx("ssa-field", className)}>
      {Label}
      {Control}
      {hint ? (
        <div id={hintId} className="mt-1 text-xs text-stone-500">
          {hint}
        </div>
      ) : null}
      {error ? (
        <div id={errorId} className="mt-1 text-xs text-rose-700">
          {error}
        </div>
      ) : null}
    </div>
  );
}

// ------------------------------ Helpers -------------------------------------
function getValueSnapshot(event, as) {
  try {
    const t = event?.target;
    if (as === "select") {
      if (t?.multiple)
        return Array.from(t.selectedOptions || []).map((o) => o.value);
      return t?.value;
    }
    if (t?.type === "checkbox") return !!t.checked;
    if (t?.type === "radio") return t?.value;
    return t?.value;
  } catch {
    return undefined;
  }
}
