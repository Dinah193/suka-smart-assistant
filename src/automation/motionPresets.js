// src/automation/motionPresets.js

/**
 * Suka Motion Presets
 * - Library-agnostic motion primitives w/ automatic reduced-motion.
 * - Optional Framer Motion support (if installed).
 * - Web Animations API + RAF fallbacks.
 *
 * Usage (Framer present):
 *   import { motion } from "framer-motion";
 *   import { variants, transitions } from "@/automation/motionPresets";
 *   <motion.section variants={variants.page} initial="initial" animate="enter" exit="exit" />
 *
 * Usage (no Framer):
 *   import { animateIn, animateOut, countUp } from "@/automation/motionPresets";
 *   animateIn(ref, "fadeInUp");
 *   const cleanup = countUp(el, { to: 42 });
 */

const hasWindow = typeof window !== "undefined";
const prefersReduced = () =>
  hasWindow && window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* -------------------------------------------------------------------------- */
/* EASING / TIMING TOKENS                                                     */
/* -------------------------------------------------------------------------- */
export const easings = {
  standard: [0.2, 0.0, 0.2, 1], // ease-in-out-ish
  entrance: [0.16, 1, 0.3, 1],  // fast in, soft settle
  exit: [0.4, 0, 1, 1],         // smooth out
  bounce: [0.34, 1.56, 0.64, 1],// tiny playful bounce
};

export const durations = {
  fast: 0.18,
  base: 0.28,
  slow: 0.45,
  xslow: 0.75,
};

export const springs = {
  gentle: { type: "spring", stiffness: 240, damping: 26, mass: 0.9 },
  snappy: { type: "spring", stiffness: 420, damping: 30, mass: 0.8 },
  floaty: { type: "spring", stiffness: 180, damping: 24, mass: 1.1 },
};

/* -------------------------------------------------------------------------- */
/* STAGGER HELPERS                                                            */
/* -------------------------------------------------------------------------- */
export const stagger = (each = 0.04, from = 0) => ({
  staggerChildren: prefersReduced() ? 0 : each,
  delayChildren: prefersReduced() ? 0 : from,
});

/* -------------------------------------------------------------------------- */
/* VARIANTS (Framer-friendly)                                                 */
/* -------------------------------------------------------------------------- */
export const transitions = {
  quick: { duration: durations.fast, ease: easings.standard },
  base: { duration: durations.base, ease: easings.standard },
  slow: { duration: durations.slow, ease: easings.standard },
  enter: { duration: durations.base, ease: easings.entrance },
  exit: { duration: durations.base, ease: easings.exit },
  spring: springs.gentle,
  springSnappy: springs.snappy,
  springFloaty: springs.floaty,
};

const reduce = (full, reduced) => (prefersReduced() ? reduced : full);

export const variants = {
  /* Page entrance/exit */
  page: {
    initial: reduce({ opacity: 0, y: 16 }, { opacity: 1, y: 0 }),
    enter: { opacity: 1, y: 0, transition: { ...transitions.enter } },
    exit: reduce({ opacity: 0, y: -8, transition: transitions.exit }, { opacity: 1 }),
  },

  /* Section/Card reveal */
  section: {
    initial: reduce({ opacity: 0, y: 12, scale: 0.99 }, { opacity: 1, y: 0, scale: 1 }),
    enter: { opacity: 1, y: 0, scale: 1, transition: { ...transitions.enter } },
    exit: reduce({ opacity: 0, y: -6, transition: transitions.exit }, { opacity: 1 }),
  },

  /* List item + stagger-friendly */
  item: {
    initial: reduce({ opacity: 0, y: 10 }, { opacity: 1, y: 0 }),
    enter: { opacity: 1, y: 0, transition: transitions.enter },
    exit: reduce({ opacity: 0, y: 10, transition: transitions.exit }, { opacity: 1 }),
  },

  /* Modal/Sheet */
  overlay: {
    initial: reduce({ opacity: 0 }, { opacity: 1 }),
    enter: { opacity: 1, transition: transitions.base },
    exit: reduce({ opacity: 0, transition: transitions.exit }, { opacity: 1 }),
  },
  modal: {
    initial: reduce({ opacity: 0, scale: 0.96 }, { opacity: 1, scale: 1 }),
    enter: { opacity: 1, scale: 1, transition: springs.gentle },
    exit: reduce({ opacity: 0, scale: 0.96, transition: transitions.exit }, { opacity: 1 }),
  },
  sheet: {
    initial: reduce({ y: "100%" }, { y: 0 }),
    enter: { y: 0, transition: springs.snappy },
    exit: reduce({ y: "100%", transition: transitions.exit }, { y: 0 }),
  },

  /* Dropdown / Tooltip */
  pop: {
    initial: reduce({ opacity: 0, y: 6, scale: 0.98 }, { opacity: 1, y: 0, scale: 1 }),
    enter: { opacity: 1, y: 0, scale: 1, transition: transitions.base },
    exit: reduce({ opacity: 0, y: 4, scale: 0.98, transition: transitions.exit }, { opacity: 1 }),
  },

  /* Accordion (height) — pairs with your Tailwind keyframes for CSS fallback */
  accordion: {
    collapsed: { height: 0, opacity: reduce(0.0, 1.0) },
    expanded: { height: "auto", opacity: 1, transition: transitions.quick },
  },
};

/* -------------------------------------------------------------------------- */
/* CSS CLASS HELPERS (pure Tailwind animation path)                           */
/* -------------------------------------------------------------------------- */
export const cssAnims = {
  fadeInUp: "animate-fade-in-up",
  bounceOnce: "animate-bounce-once",
  shimmer: "suka-shimmer",
  accordionDown: "animate-accordion-down",
  accordionUp: "animate-accordion-up",
};

export function addAnim(el, className, ms = 600) {
  if (!el) return () => {};
  if (prefersReduced()) return () => {};
  el.classList.add(className);
  const t = setTimeout(() => el.classList.remove(className), ms);
  return () => clearTimeout(t);
}

/* -------------------------------------------------------------------------- */
/* WEB ANIMATIONS API FALLBACKS                                               */
/* -------------------------------------------------------------------------- */
const WA_EASE = "cubic-bezier(0.16, 1, 0.3, 1)";

const WA_PRESETS = {
  fadeInUp: (el, opts) =>
    el.animate(
      [
        { opacity: 0, transform: "translateY(20px)" },
        { opacity: 1, transform: "translateY(0)" },
      ],
      { duration: (opts && opts.duration) || 600, easing: WA_EASE, fill: "both" }
    ),
  fadeOutDown: (el, opts) =>
    el.animate(
      [
        { opacity: 1, transform: "translateY(0)" },
        { opacity: 0, transform: "translateY(10px)" },
      ],
      { duration: (opts && opts.duration) || 300, easing: "cubic-bezier(0.4,0,1,1)", fill: "both" }
    ),
  pop: (el, opts) =>
    el.animate(
      [
        { opacity: 0, transform: "translateY(6px) scale(.98)" },
        { opacity: 1, transform: "translateY(0) scale(1)" },
      ],
      { duration: (opts && opts.duration) || 280, easing: WA_EASE, fill: "both" }
    ),
  overlayIn: (el, opts) =>
    el.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: (opts && opts.duration) || 240,
      easing: "linear",
      fill: "both",
    }),
  overlayOut: (el, opts) =>
    el.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: (opts && opts.duration) || 220,
      easing: "linear",
      fill: "both",
    }),
  sheetIn: (el, opts) =>
    el.animate([{ transform: "translateY(100%)" }, { transform: "translateY(0)" }], {
      duration: (opts && opts.duration) || 320,
      easing: WA_EASE,
      fill: "both",
    }),
  sheetOut: (el, opts) =>
    el.animate([{ transform: "translateY(0)" }, { transform: "translateY(100%)" }], {
      duration: (opts && opts.duration) || 260,
      easing: "cubic-bezier(0.4,0,1,1)",
      fill: "both",
    }),
};

export function animateIn(el, kind = "fadeInUp", opts = {}) {
  if (!el || prefersReduced()) return null;
  const fn = WA_PRESETS[kind];
  if (fn && el.animate) return fn(el, opts);
  return addAnim(el, cssAnims.fadeInUp, 600);
}
export function animateOut(el, kind = "fadeOutDown", opts = {}) {
  if (!el || prefersReduced()) return null;
  const fn = WA_PRESETS[kind];
  if (fn && el.animate) return fn(el, opts);
  return addAnim(el, cssAnims.fadeInUp, 300);
}

/* -------------------------------------------------------------------------- */
/* MICRO-INTERACTIONS                                                         */
/* -------------------------------------------------------------------------- */
export function pressRipple(el) {
  // Uses the CSS ::before trick you already wired; here we just toggle class.
  return addAnim(el, "is-pressed", 250);
}

export function hocus(el) {
  if (!el || prefersReduced()) return;
  el.addEventListener("pointerenter", () => el.classList.add("ring-brand-2"));
  el.addEventListener("pointerleave", () => el.classList.remove("ring-brand-2"));
  return () => {
    el.removeEventListener("pointerenter", () => {});
    el.removeEventListener("pointerleave", () => {});
  };
}

/* -------------------------------------------------------------------------- */
/* COUNT UP (KPI / METRIC TWEEN)                                              */
/* -------------------------------------------------------------------------- */
export function countUp(el, { from = 0, to = 100, duration = 900, formatter } = {}) {
  if (!el) return () => {};
  if (prefersReduced()) {
    el.textContent = formatNum(to, formatter);
    return () => {};
  }
  let raf;
  const start = performance.now();
  const diff = to - from;

  function frame(t) {
    const p = Math.min(1, (t - start) / duration);
    const eased = cubicOut(p);
    const val = from + diff * eased;
    el.textContent = formatNum(val, formatter);
    if (p < 1) raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(raf);
}

function cubicOut(t) {
  const f = t - 1;
  return f * f * f + 1;
}
function formatNum(v, formatter) {
  if (typeof formatter === "function") return formatter(v);
  return Math.round(v).toString();
}

/* -------------------------------------------------------------------------- */
/* STAGGER UTILS FOR PLAIN DOM                                                */
/* -------------------------------------------------------------------------- */
export function staggerIn(nodes, kind = "fadeInUp", { each = 60 } = {}) {
  if (!nodes || prefersReduced()) return [];
  const cleanups = [];
  nodes.forEach((node, i) => {
    const c = setTimeout(() => cleanups.push(animateIn(node, kind)), i * each);
    cleanups.push(() => clearTimeout(c));
  });
  return cleanups;
}

/* -------------------------------------------------------------------------- */
/* ACCORDION HELPERS                                                          */
/* -------------------------------------------------------------------------- */
export function accordionOpen(el) {
  if (!el) return;
  if (prefersReduced()) {
    el.style.height = "auto";
    return;
  }
  el.style.height = "0px";
  const h = el.scrollHeight;
  el.style.transition = `height ${durations.quick || 0.18}s`;
  requestAnimationFrame(() => {
    el.style.height = h + "px";
  });
  const done = () => {
    el.style.height = "auto";
    el.removeEventListener("transitionend", done);
  };
  el.addEventListener("transitionend", done);
}
export function accordionClose(el) {
  if (!el) return;
  if (prefersReduced()) {
    el.style.height = "0px";
    return;
  }
  const h = el.scrollHeight;
  el.style.height = h + "px";
  el.style.transition = `height ${durations.quick || 0.18}s`;
  requestAnimationFrame(() => {
    el.style.height = "0px";
  });
}

/* -------------------------------------------------------------------------- */
/* GUARDS: OPTIONAL FRAMER SUPPORT (DYNAMIC)                                   */
/* -------------------------------------------------------------------------- */
export async function framerSafeImport() {
  try {
    // If framer-motion is installed, this resolves; otherwise we stay library-agnostic.
    const mod = await import(/* @vite-ignore */ "framer-motion");
    return mod;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* CONVENIENCE BUNDLES                                                        */
/* -------------------------------------------------------------------------- */
export const Motion = {
  easings,
  durations,
  springs,
  transitions,
  variants,
  cssAnims,
  stagger,
  animateIn,
  animateOut,
  pressRipple,
  hocus,
  countUp,
  staggerIn,
  accordionOpen,
  accordionClose,
  framerSafeImport,
};

export default Motion;
