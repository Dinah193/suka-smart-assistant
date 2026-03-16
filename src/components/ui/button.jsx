// File: src/components/ui/button.jsx
// SSA UI: shadcn-style Button (dependency-free, React 19 compatible)

import React from "react";

/** Lightweight className joiner (no deps) */
function cn(...parts) {
  return parts
    .flatMap((p) => (Array.isArray(p) ? p : [p]))
    .filter(Boolean)
    .join(" ");
}

const VARIANT = {
  default: "bg-slate-900 text-white hover:bg-slate-800 active:bg-slate-900/90",
  secondary:
    "bg-slate-100 text-slate-900 hover:bg-slate-200 active:bg-slate-200/80",
  outline:
    "border border-slate-200 bg-white text-slate-900 hover:bg-slate-50 active:bg-slate-50/80",
  ghost:
    "bg-transparent text-slate-900 hover:bg-slate-100 active:bg-slate-100/70",
  destructive: "bg-red-600 text-white hover:bg-red-700 active:bg-red-700/90",
  link: "bg-transparent text-slate-900 underline-offset-4 hover:underline",
};

const SIZE = {
  default: "h-10 px-4 py-2",
  sm: "h-9 px-3",
  lg: "h-11 px-6",
  icon: "h-10 w-10 p-0",
};

/**
 * Button
 * Props:
 * - variant: default | secondary | outline | ghost | destructive | link
 * - size: default | sm | lg | icon
 * - asChild: if true, clones the only child element and applies button props
 */
const Button = React.forwardRef(function Button(
  {
    className,
    variant = "default",
    size = "default",
    asChild = false,
    type,
    disabled,
    children,
    ...props
  },
  ref
) {
  const classes = cn(
    "inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium",
    "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2",
    "disabled:pointer-events-none disabled:opacity-50 ring-offset-white",
    VARIANT[variant] || VARIANT.default,
    SIZE[size] || SIZE.default,
    className
  );

  // Minimal Slot behavior (no dependency)
  if (asChild && React.isValidElement(children)) {
    return React.cloneElement(children, {
      ...props,
      ref,
      className: cn(children.props.className, classes),
      disabled,
    });
  }

  return (
    <button
      ref={ref}
      type={type || "button"}
      className={classes}
      disabled={disabled}
      {...props}
    >
      {children}
    </button>
  );
});

export { Button };
export default Button;
