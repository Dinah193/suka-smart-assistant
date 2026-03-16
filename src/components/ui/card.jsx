// File: src/components/ui/card.jsx
// SSA UI: shadcn-style Card primitives (dependency-free)

import React from "react";

/** Lightweight className joiner (no deps) */
function cn(...parts) {
  return parts
    .flatMap((p) => (Array.isArray(p) ? p : [p]))
    .filter(Boolean)
    .join(" ");
}

/**
 * Card container
 */
const Card = React.forwardRef(function Card({ className, ...props }, ref) {
  return (
    <div
      ref={ref}
      className={cn(
        "rounded-lg border border-slate-200 bg-white text-slate-950 shadow-sm",
        className
      )}
      {...props}
    />
  );
});

/**
 * Optional header wrapper (title/description)
 */
const CardHeader = React.forwardRef(function CardHeader(
  { className, ...props },
  ref
) {
  return (
    <div
      ref={ref}
      className={cn("flex flex-col space-y-1.5 p-6", className)}
      {...props}
    />
  );
});

/**
 * Title text
 */
const CardTitle = React.forwardRef(function CardTitle(
  { className, ...props },
  ref
) {
  return (
    <h3
      ref={ref}
      className={cn(
        "text-lg font-semibold leading-none tracking-tight",
        className
      )}
      {...props}
    />
  );
});

/**
 * Description text
 */
const CardDescription = React.forwardRef(function CardDescription(
  { className, ...props },
  ref
) {
  return (
    <p
      ref={ref}
      className={cn("text-sm text-slate-600", className)}
      {...props}
    />
  );
});

/**
 * Body/content wrapper
 */
const CardContent = React.forwardRef(function CardContent(
  { className, ...props },
  ref
) {
  return <div ref={ref} className={cn("p-6 pt-0", className)} {...props} />;
});

/**
 * Footer wrapper (buttons / actions)
 */
const CardFooter = React.forwardRef(function CardFooter(
  { className, ...props },
  ref
) {
  return (
    <div
      ref={ref}
      className={cn("flex items-center p-6 pt-0", className)}
      {...props}
    />
  );
});

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardDescription,
  CardContent,
};
export default Card;
