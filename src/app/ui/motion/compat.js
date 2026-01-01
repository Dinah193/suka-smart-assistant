// C:\Users\larho\suka-smart-assistant\src\app\ui\motion\compat.js
//
// Motion Compatibility Layer for SSA
// ----------------------------------
// This module centralizes all motion/animation wiring for Suka Smart Assistant.
// It gives you:
//
//   • SSA-safe exports of Framer Motion primitives (MotionDiv, MotionSection, …)
//   • A shared hook for respecting "prefers-reduced-motion"
//   • A single place to evolve motion behavior (feature flags, theme, etc.)
//   • Optional UI telemetry via eventBus (non-household, purely UX)
//
// How this fits into the SSA pipeline
// -----------------------------------
// imports → intelligence → automation → (optional) hub export
//
// This file sits at the **UI shell** layer, not the household data layer:
//   • It does NOT change inventory, storehouse, or sessions.
//   • It does NOT write to Dexie.
//   • It only emits *UI-level* events (`ui.motion.preference.changed`) so the
//     rest of SSA can react (e.g., SessionRunner can tone down animations).
//
// Because it never mutates household data, it deliberately does **not**
// call exportToHubIfEnabled. Hub mirroring for motion telemetry is not needed.

"use client";

import React, { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import eventBus from "../../../services/events/eventBus";

/**
 * @typedef {"reduce" | "no-preference" | "unknown"} MotionPrefValue
 */

/**
 * Get the current prefers-reduced-motion setting from the browser, if any.
 *
 * @returns {MotionPrefValue}
 */
function detectPrefersReducedMotion() {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return "unknown";
  }

  try {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    return mq.matches ? "reduce" : "no-preference";
  } catch {
    return "unknown";
  }
}

/**
 * Emit a structured UI motion event onto the shared eventBus.
 *
 * @param {MotionPrefValue} pref
 */
function emitMotionPreferenceChanged(pref) {
  if (!eventBus || typeof eventBus.emit !== "function") return;

  eventBus.emit({
    type: "ui.motion.preference.changed",
    ts: new Date().toISOString(),
    source: "ui.motion.compat",
    data: {
      preference: pref,
      enabled: pref !== "reduce", // our default interpretation
    },
  });
}

/**
 * React hook to track whether **animated motion** should be enabled.
 *
 * Logic:
 *   • If prefers-reduced-motion: reduce → we treat that as "disabled".
 *   • If "no-preference" or unknown → we treat that as "enabled".
 *
 * It:
 *   • Subscribes to (prefers-reduced-motion) changes
 *   • Emits a `ui.motion.preference.changed` event on any change
 *
 * @returns {{ enabled: boolean, preference: MotionPrefValue }}
 */
export function useMotionPreference() {
  const initialPref = detectPrefersReducedMotion();
  const [preference, setPreference] = useState(initialPref);

  useEffect(() => {
    // Emit initial value once on mount (useful for SessionRunner / dashboards)
    emitMotionPreferenceChanged(initialPref);

    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }

    let mq;
    try {
      mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    } catch {
      return;
    }

    const handler = (event) => {
      const nextPref = event.matches ? "reduce" : "no-preference";
      setPreference(nextPref);
      emitMotionPreferenceChanged(nextPref);
    };

    // Modern API
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    }

    // Fallback for older browsers
    if (typeof mq.addListener === "function") {
      mq.addListener(handler);
      return () => mq.removeListener(handler);
    }

    return () => {};
  }, [initialPref]);

  return {
    preference,
    enabled: preference !== "reduce",
  };
}

/**
 * Utility that, given a Framer Motion variants object, returns a **safe**
 * variant set that respects the user's motion preference.
 *
 * If motion is disabled, we strip out initial/animate/exit transitions.
 *
 * Usage:
 *   const { enabled } = useMotionPreference();
 *   const safeVariants = withReducedMotionVariants(variants, !enabled);
 *
 * @template T
 * @param {T} variants
 * @param {boolean} disableMotion
 * @returns {T | { initial: false; animate: false; exit: false; transition: { duration: 0 } }}
 */
export function withReducedMotionVariants(variants, disableMotion) {
  if (!disableMotion) return variants;
  return {
    initial: false,
    animate: false,
    exit: false,
    transition: { duration: 0 },
  };
}

/**
 * SSA-standard fade-in-up variant, used for modals, cards, etc.
 * Use with AnimatePresence.
 */
export const fadeInUp = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: 12 },
  transition: { duration: 0.2 },
};

/**
 * SSA-standard subtle fade (no movement).
 */
export const fadeIn = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.18 },
};

/**
 * SSA-standard scale-in for small panels/tooltips.
 */
export const scaleIn = {
  initial: { opacity: 0, scale: 0.96 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.96 },
  transition: { duration: 0.18 },
};

// ---------------------------------------------------------------------------
// Motion component aliases
// ---------------------------------------------------------------------------
//
// We re-export Framer Motion primitives through **SSA-named** aliases so:
//   • You can later swap implementation if needed.
//   • You keep imports consistent and easy to grep.
//   • You get a single place to add future wrappers (e.g., auto-disable).
//
// Example usage in SSA:
//
//   import { MotionDiv, AnimatePresence, fadeInUp } from "src/app/ui/motion/compat";
//
//   <AnimatePresence>
//     {open && (
//       <MotionDiv
//         className="my-modal"
//         initial="initial"
//         animate="animate"
//         exit="exit"
//         variants={safeVariants}
//       >
//         ...
//       </MotionDiv>
//     )}
//   </AnimatePresence>
//

export const MotionDiv = motion.div;
export const MotionSection = motion.section;
export const MotionSpan = motion.span;
export const MotionButton = motion.button;
export const MotionHeader = motion.header;
export const MotionFooter = motion.footer;
export const MotionMain = motion.main;

// Re-export AnimatePresence so pages can use it without importing framer-motion directly.
export { AnimatePresence };

/**
 * Convenience component that auto-disables motion when the user prefers
 * reduced motion. Wraps `motion.div` with the `useMotionPreference` hook.
 *
 * Usage:
 *   <SmartMotionDiv variants={fadeInUp} {...rest}>...</SmartMotionDiv>
 *
 * @param {import("react").ComponentProps<typeof motion.div>} props
 */
export function SmartMotionDiv(props) {
  const { enabled } = useMotionPreference();
  const { variants, ...rest } = props;

  const safeVariants =
    variants && typeof variants === "object"
      ? withReducedMotionVariants(variants, !enabled)
      : variants;

  return (
    <motion.div
      {...rest}
      variants={safeVariants}
      // If motion disabled and no explicit variants, kill implicit transitions
      initial={enabled ? rest.initial : false}
      animate={enabled ? rest.animate : false}
      exit={enabled ? rest.exit : false}
      transition={
        enabled ? rest.transition : rest.transition || { duration: 0 } // no-op transitions
      }
    />
  );
}
