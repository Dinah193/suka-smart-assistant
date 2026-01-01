// src/ui/InteractiveIcon.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import { motion, useReducedMotion } from "framer-motion";

/**
 * InteractiveIcon — animated, accessible, theme-friendly icon button
 *
 * Backwards-compatible props:
 *   - icon, label, onClick, size (tailwind text-*), color, hoverColor, animate
 *
 * New capabilities (all optional):
 *   - as: 'button' | 'a' | 'div' (default 'button'); href/target/rel for links
 *   - variant: 'ghost' | 'soft' | 'solid'  (visual chrome)
 *   - tone: 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info'
 *   - shape: 'circle' | 'rounded' | 'square'  (default 'circle')
 *   - hitArea: 'sm' | 'md' | 'lg' (min touch target; default 'md' ≈ 40px)
 *   - disabled, loading
 *   - pressed / defaultPressed + onToggle (toggleable icon)
 *   - badge: number | true (dot)
 *   - ping: boolean (subtle attention pulse)
 *   - ripple: boolean (ink ripple on tap)
 *   - longPressMs (default 500) + onLongPress
 *   - throttleMs (guard double taps)
 */

const SIZES = {
  sm: "h-8 w-8",
  md: "h-10 w-10",   // ~40px target
  lg: "h-12 w-12",
};

const RADII = {
  circle: "rounded-full",
  rounded: "rounded-xl",
  square: "rounded-none",
};

const VARIANT = {
  ghost: "bg-transparent hover:bg-black/5 dark:hover:bg-white/10",
  soft: "bg-black/[.04] hover:bg-black/[.08] dark:bg-white/[.06] dark:hover:bg-white/[.12]",
  solid: "bg-black/[.08] hover:bg-black/[.14] dark:bg-white/[.16] dark:hover:bg-white/[.22] text-white",
};

const TONE = {
  neutral: "",
  primary: "text-blue-600 hover:text-blue-700",
  success: "text-emerald-600 hover:text-emerald-700",
  warning: "text-amber-600 hover:text-amber-700",
  danger: "text-rose-600 hover:text-rose-700",
  info: "text-sky-600 hover:text-sky-700",
};

const SPINNER = (
  <span
    className="absolute inset-0 grid place-items-center"
    aria-hidden
  >
    <span className="animate-spin h-4 w-4 border-2 border-current border-t-transparent rounded-full" />
  </span>
);

const MotionButton = React.forwardRef(function MotionButton(props, ref) {
  const { as = "button", ...rest } = props;
  if (as === "a") return <motion.a ref={ref} {...rest} />;
  if (as === "div") return <motion.div ref={ref} {...rest} />;
  return <motion.button ref={ref} type="button" {...rest} />;
});

export default function InteractiveIcon({
  icon,
  label = "",
  onClick = () => {},
  size = "text-xl",          // legacy tailwind font-size
  color = "text-stone-700",  // legacy tailwind text color
  hoverColor = "hover:text-stone-900", // legacy hover text color
  animate = true,

  // New
  as = "button",
  href,
  target,
  rel,

  variant = "ghost",
  tone = "neutral",
  shape = "circle",
  hitArea = "md",

  disabled = false,
  loading = false,

  // Toggle (controlled/uncontrolled)
  pressed,
  defaultPressed = false,
  onToggle,

  // UX affordances
  badge,           // number | true (dot)
  ping = false,
  ripple = false,

  longPressMs = 500,
  onLongPress,
  throttleMs = 250,
}) {
  const reduced = useReducedMotion();
  const [internalPressed, setInternalPressed] = useState(defaultPressed);
  const isPressed = pressed ?? internalPressed;

  const lastTapRef = useRef(0);
  const longPressRef = useRef(null);
  const hostRef = useRef(null);
  const [ripples, setRipples] = useState([]);

  // Compose classes: container chrome + legacy typography colors
  const chrome = `${VARIANT[variant] || ""} ${TONE[tone] || ""} ${RADII[shape] || ""} ${
    SIZES[hitArea] || SIZES.md
  }`;
  const legacyTypography = `${size} ${color} ${hoverColor}`;

  // Motion variants (respect reduced motion)
  const whileHover = animate && !reduced && !disabled ? { scale: 1.08, rotate: 0.0001 } : {};
  const whileTap   = animate && !reduced && !disabled ? { scale: 0.95, rotate: 0 } : {};

  // Toggle handling
  const handleToggle = () => {
    const next = !isPressed;
    if (pressed === undefined) setInternalPressed(next);
    onToggle?.(next);
  };

  // Ripple (simple framer-motion circle)
  const spawnRipple = (e) => {
    if (!ripple || reduced || disabled) return;
    try {
      const rect = hostRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = (e.clientX ?? 0) - rect.left;
      const y = (e.clientY ?? 0) - rect.top;
      const size = Math.max(rect.width, rect.height) * 1.4;
      const id = `${Date.now()}-${Math.random()}`;
      setRipples((r) => [...r, { id, x, y, size }]);
      setTimeout(() => setRipples((r) => r.filter((it) => it.id !== id)), 450);
    } catch {}
  };

  // Long press
  const handlePointerDown = (e) => {
    if (!onLongPress || disabled) return;
    clearTimeout(longPressRef.current);
    longPressRef.current = setTimeout(() => {
      onLongPress?.(e);
    }, longPressMs);
  };
  const handlePointerUp = () => {
    clearTimeout(longPressRef.current);
  };

  // Click with throttle + optional toggle
  const handleActivate = (e) => {
    if (disabled || loading) return;
    const now = Date.now();
    if (now - lastTapRef.current < throttleMs) return;
    lastTapRef.current = now;

    if (onToggle) handleToggle();
    onClick?.(e);
  };

  // Keyboard activation for non-button hosts
  const onKeyDown = (e) => {
    if (disabled || loading) return;
    if (as !== "button" && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      handleActivate(e);
    }
  };

  // ARIA
  const ariaProps = {
    "aria-label": label || undefined,
    "aria-pressed": onToggle ? !!isPressed : undefined,
    "aria-busy": loading ? "true" : undefined,
    "aria-disabled": disabled ? "true" : undefined,
    role: as === "div" ? "button" : undefined,
    tabIndex: as === "div" ? 0 : undefined,
    title: label || undefined,
  };

  // Link props
  const linkProps = as === "a" ? { href, target, rel } : {};

  return (
    <MotionButton
      as={as}
      {...linkProps}
      ref={hostRef}
      className={[
        "relative inline-grid place-items-center select-none outline-none",
        chrome,
        legacyTypography,
        disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer",
        loading ? "pointer-events-none" : "",
        // Focus ring
        "focus-visible:ring-2 focus-visible:ring-emerald-500/70 focus-visible:outline-none",
        // Subtle pulse if requested
        ping ? "animate-soft-pulse" : "",
      ].filter(Boolean).join(" ")}
      style={{ lineHeight: 0 }} // tighter icon centering
      whileHover={whileHover}
      whileTap={whileTap}
      onClick={(e) => {
        spawnRipple(e);
        handleActivate(e);
      }}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onKeyDown={onKeyDown}
      disabled={as === "button" ? disabled : undefined}
      {...ariaProps}
    >
      {/* Icon */}
      <span className={`grid place-items-center ${loading ? "opacity-0" : ""}`} aria-hidden={loading}>
        {icon}
      </span>

      {/* Loading spinner overlay */}
      {loading && SPINNER}

      {/* Badge (number or dot) */}
      {badge ? (
        <span
          className={[
            "absolute -top-1 -right-1 min-w-[1.1rem] h-[1.1rem] px-1",
            "rounded-full bg-rose-600 text-white text-[10px] leading-[1.1rem]",
            "grid place-items-center",
            badge === true ? "min-w-[0.5rem] w-[0.5rem] h-[0.5rem] p-0 leading-none" : "",
          ].join(" ")}
          aria-label={typeof badge === "number" ? `${badge} notifications` : "notification"}
        >
          {badge === true ? "" : String(badge)}
        </span>
      ) : null}

      {/* Ripple effects */}
      {ripple && ripples.map((r) => (
        <motion.span
          key={r.id}
          className="absolute rounded-full pointer-events-none bg-current/20"
          style={{
            left: r.x - r.size / 2,
            top: r.y - r.size / 2,
            width: r.size,
            height: r.size,
          }}
          initial={{ scale: 0, opacity: 0.35 }}
            animate={{ scale: 1, opacity: 0 }}
            transition={{ duration: reduced ? 0.05 : 0.45, ease: "easeOut" }}
        />
      ))}
    </MotionButton>
  );
}

InteractiveIcon.propTypes = {
  icon: PropTypes.node.isRequired,
  label: PropTypes.string,
  onClick: PropTypes.func,
  size: PropTypes.string,
  color: PropTypes.string,
  hoverColor: PropTypes.string,
  animate: PropTypes.bool,

  as: PropTypes.oneOf(["button", "a", "div"]),
  href: PropTypes.string,
  target: PropTypes.string,
  rel: PropTypes.string,

  variant: PropTypes.oneOf(["ghost", "soft", "solid"]),
  tone: PropTypes.oneOf(["neutral", "primary", "success", "warning", "danger", "info"]),
  shape: PropTypes.oneOf(["circle", "rounded", "square"]),
  hitArea: PropTypes.oneOf(["sm", "md", "lg"]),

  disabled: PropTypes.bool,
  loading: PropTypes.bool,

  pressed: PropTypes.bool,
  defaultPressed: PropTypes.bool,
  onToggle: PropTypes.func,

  badge: PropTypes.oneOfType([PropTypes.bool, PropTypes.number]),
  ping: PropTypes.bool,
  ripple: PropTypes.bool,

  longPressMs: PropTypes.number,
  onLongPress: PropTypes.func,
  throttleMs: PropTypes.number,
};
