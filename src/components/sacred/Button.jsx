import React from "react";
import { classNames as cx } from "@/utils/css";

const TONES = {
  primary:
    "btn btn-primary border-0 bg-[#4F46E5] text-white shadow-md shadow-indigo-200/70 hover:-translate-y-0.5 hover:scale-[1.02] hover:bg-[#4338CA] focus-visible:ring-[#4F46E5]/40",
  secondary:
    "btn btn-outline border-[#4F46E5]/25 bg-white text-[#312E81] hover:-translate-y-0.5 hover:scale-[1.02] hover:border-[#4F46E5] hover:bg-[#EEF2FF] focus-visible:ring-[#4F46E5]/35",
  accent:
    "btn border-0 bg-gradient-to-r from-[#10B981] to-[#059669] text-white shadow-md shadow-emerald-200/70 hover:-translate-y-0.5 hover:scale-[1.02] hover:from-[#059669] hover:to-[#047857] focus-visible:ring-[#10B981]/35",
};

const SIZES = {
  sm: "h-9 px-3 text-xs",
  md: "h-11 px-4 text-sm",
  lg: "h-12 px-5 text-base",
};

export default function Button({
  children,
  tone = "primary",
  size = "md",
  loading = false,
  className,
  disabled,
  leftIcon,
  rightIcon,
  ...props
}) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition-all duration-200 focus:outline-none focus-visible:ring-2 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60",
        TONES[tone] || TONES.primary,
        SIZES[size] || SIZES.md,
        className
      )}
      {...props}
    >
      {loading ? <span className="loading loading-spinner loading-xs" aria-hidden="true" /> : leftIcon}
      <span>{children}</span>
      {!loading ? rightIcon : null}
    </button>
  );
}
