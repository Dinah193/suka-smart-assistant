import React from "react";

function fieldState(error, success, disabled) {
  if (disabled) return "border-[var(--ssa-disabled-border)] bg-[var(--ssa-disabled-bg)] text-[var(--ssa-disabled-fg)]";
  if (error) return "border-[var(--ssa-status-danger)]";
  if (success) return "border-[var(--ssa-status-success)]";
  return "border-[var(--ssa-border-default)] bg-[var(--ssa-surface-elevated)]";
}

function fieldBase(stateClass) {
  return [
    "w-full rounded-[var(--ssa-radius-chip)] border px-3 py-2 text-sm",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ssa-focus-ring-color)]",
    stateClass,
  ].join(" ");
}

export function SSAField({ label, hint, error, success, children }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-semibold text-[var(--ssa-text-secondary)]">{label}</span>
      {children}
      {error ? <span role="alert" className="text-xs text-[var(--ssa-status-danger)]">{error}</span> : null}
      {!error && hint ? <span className="text-xs text-[var(--ssa-text-secondary)]">{hint}</span> : null}
      {!error && success ? <span className="text-xs text-[var(--ssa-status-success)]">{success}</span> : null}
    </label>
  );
}

export function SSAInput(props) {
  const cls = fieldBase(fieldState(props.error, props.success, props.disabled));
  return <input {...props} className={`${cls} ${props.className || ""}`} />;
}

export function SSATextarea(props) {
  const cls = fieldBase(fieldState(props.error, props.success, props.disabled));
  return <textarea {...props} className={`${cls} ${props.className || ""}`} />;
}

export function SSASelect(props) {
  const cls = fieldBase(fieldState(props.error, props.success, props.disabled));
  return <select {...props} className={`${cls} ${props.className || ""}`} />;
}

export function SSAToggle({ checked, onChange, label, disabled }) {
  const handleToggle = () => {
    if (disabled) return;
    onChange?.(!checked);
  };

  const handleKeyDown = (event) => {
    if (disabled) return;
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      onChange?.(!checked);
    }
  };

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={handleToggle}
      onKeyDown={handleKeyDown}
      className="inline-flex items-center gap-2"
    >
      <span
        className={`relative h-6 w-11 rounded-full border transition-colors ${
          checked ? "bg-[var(--ssa-action-primary-bg)] border-[var(--ssa-action-primary-bg)]" : "bg-[var(--ssa-surface-1)] border-[var(--ssa-border-default)]"
        }`}
      >
        <span
          className={`absolute top-0.5 h-4.5 w-4.5 rounded-full bg-white transition-transform ${checked ? "translate-x-5" : "translate-x-0.5"}`}
        />
      </span>
      <span className="text-sm text-[var(--ssa-text-primary)]">{label}</span>
    </button>
  );
}

export function SSACheckbox({ checked, onChange, label, disabled }) {
  return (
    <label className="inline-flex items-center gap-2 text-sm text-[var(--ssa-text-primary)]">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.checked)}
      />
      {label}
    </label>
  );
}

export function SSARadio({ name, value, checked, onChange, label, disabled }) {
  return (
    <label className="inline-flex items-center gap-2 text-sm text-[var(--ssa-text-primary)]">
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.value)}
      />
      {label}
    </label>
  );
}
