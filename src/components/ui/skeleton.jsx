// File: src/components/ui/skeleton.jsx
// Production-ready, dependency-light Skeleton loader (JS + React)
//
// - Uses Tailwind-friendly shimmer animation (works even without custom keyframes)
// - Accepts any element props; default is <div>
// - Optional "asChild" pattern for wrapping existing elements
//
// Usage:
//   import { Skeleton } from "@/components/ui/skeleton";
//
//   <Skeleton className="h-6 w-40" />
//   <Skeleton className="h-10 w-full rounded-md" />
//   <Skeleton className="h-24 w-24 rounded-full" />
//
//   <Skeleton asChild>
//     <div className="h-8 w-32 rounded" />
//   </Skeleton>

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

/**
 * Skeleton
 * Props:
 * - asChild: if true, clones the single child and injects skeleton styles
 * - shimmer: boolean (default true)
 * - rounded: optional convenience ("sm"|"md"|"lg"|"full"|"none")
 */
export const Skeleton = React.forwardRef(function Skeleton(
  { className, asChild = false, shimmer = true, rounded, style, ...props },
  ref
) {
  const roundedCls =
    rounded === "none"
      ? "rounded-none"
      : rounded === "sm"
      ? "rounded-sm"
      : rounded === "md"
      ? "rounded-md"
      : rounded === "lg"
      ? "rounded-lg"
      : rounded === "full"
      ? "rounded-full"
      : "";

  // Base skeleton styling:
  // - background "base" + subtle overlay gradient
  // - shimmer uses background-size and animate-pulse-ish motion
  //
  // Works best with Tailwind. If you don't have animate utilities,
  // it still shows a nice static placeholder.
  const base =
    "relative overflow-hidden bg-slate-200/80 " +
    "before:absolute before:inset-0 " +
    "before:-translate-x-full " +
    "before:bg-gradient-to-r before:from-transparent before:via-white/35 before:to-transparent";

  const shimmerCls = shimmer
    ? "before:animate-[skeleton-shimmer_1.2s_infinite]"
    : "";

  // Provide the keyframes via inline <style> once per page render.
  // We inject a tiny global style tag only if shimmer is enabled.
  // This avoids requiring tailwind.config keyframes.
  React.useEffect(() => {
    if (!shimmer) return;
    const id = "ssa-skeleton-shimmer-keyframes";
    if (document.getElementById(id)) return;

    const styleEl = document.createElement("style");
    styleEl.id = id;
    styleEl.textContent = `
@keyframes skeleton-shimmer {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(100%); }
}
`;
    document.head.appendChild(styleEl);

    return () => {
      // Keep it (shared) – don't remove to avoid flicker on remounts
    };
  }, [shimmer]);

  if (asChild) {
    const child = React.Children.only(props.children);
    if (!React.isValidElement(child)) return null;

    return React.cloneElement(child, {
      ref,
      "data-ui": "skeleton",
      "aria-busy": "true",
      "aria-live": "polite",
      className: cn(
        child.props.className,
        base,
        shimmerCls,
        roundedCls,
        className
      ),
      style: { ...child.props.style, ...style },
      ...("children" in child.props ? { children: child.props.children } : {}),
    });
  }

  return (
    <div
      ref={ref}
      data-ui="skeleton"
      aria-busy="true"
      aria-live="polite"
      className={cn(base, shimmerCls, roundedCls, className)}
      style={style}
      {...props}
    />
  );
});

Skeleton.displayName = "Skeleton";

export default Skeleton;
