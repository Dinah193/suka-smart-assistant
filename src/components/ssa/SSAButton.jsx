import React from "react";

function cx(...parts) {
  return parts.filter(Boolean).join(" ");
}

const baseClass =
  "inline-flex items-center justify-center gap-2 select-none rounded-[var(--ssa-radius-chip)] px-3 py-2 text-sm font-semibold transition-all duration-150 ease-[var(--ssa-ease-standard)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ssa-focus-ring-color)] focus-visible:ring-offset-2 active:translate-y-[1px] disabled:pointer-events-none disabled:bg-[var(--ssa-disabled-bg)] disabled:text-[var(--ssa-disabled-fg)] disabled:border-[var(--ssa-disabled-border)]";

const variantClass = {
  primary:
    "border border-transparent bg-[var(--ssa-action-primary-bg)] text-[var(--ssa-action-primary-fg)] shadow-[var(--ssa-shadow-1)] hover:-translate-y-[1px] hover:bg-[var(--ssa-action-primary-hover)] hover:shadow-[var(--ssa-shadow-2)] active:bg-[var(--ssa-action-primary-pressed)]",
  secondary:
    "border border-[var(--ssa-border-default)] bg-[var(--ssa-surface-elevated)] text-[var(--ssa-text-primary)] shadow-[var(--ssa-shadow-1)] hover:-translate-y-[1px] hover:bg-[var(--ssa-surface-1)] hover:shadow-[var(--ssa-shadow-2)] active:bg-[var(--ssa-surface-2)]",
  icon:
    "h-10 w-10 border border-[var(--ssa-border-default)] bg-[var(--ssa-surface-elevated)] p-0 text-[var(--ssa-text-primary)] hover:bg-[var(--ssa-surface-1)]",
  floating:
    "fixed bottom-4 right-4 z-40 border border-transparent bg-[var(--ssa-action-primary-bg)] text-[var(--ssa-action-primary-fg)] shadow-[var(--ssa-shadow-3)] hover:-translate-y-[2px] hover:bg-[var(--ssa-action-primary-hover)] active:bg-[var(--ssa-action-primary-pressed)]",
};

export function SSAButton({
  children,
  className = "",
  variant = "primary",
  loading = false,
  disabled = false,
  ariaLabel,
  type = "button",
  ...props
}) {
  const isDisabled = disabled || loading;
  return (
    <button
      type={type}
      aria-label={ariaLabel}
      aria-busy={loading || undefined}
      disabled={isDisabled}
      className={cx(baseClass, variantClass[variant] || variantClass.primary, className)}
      {...props}
    >
      {loading ? <span className="animate-pulse">Loading...</span> : children}
    </button>
  );
}

export default SSAButton;
