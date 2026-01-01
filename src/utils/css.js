// src/utils/css.js
/**
 * Suka Design Utilities
 * - Consistent, dependency-free helpers to compose classes + variants.
 * - Ships opinionated variant builders for Suka's "sv-*" design tokens.
 *
 * Usage:
 *   import { classNames as cx, buttonCx } from "@/utils/css";
 *   <button className={buttonCx({ variant: "outline", size: "sm" })}>Save</button>
 *
 *   const pill = variants({ base:"sv-pill", variants:{ tone:{info:"sv-pill--info", danger:"sv-pill--danger"} }});
 *   <span className={pill({ tone: "danger", className:"w-full" })}>!</span>
 */

/* ----------------------------------------------------------------------------
 * Core: classNames (cx)
 * ---------------------------------------------------------------------------- */

function _flatten(input, out) {
  if (!input) return out;
  if (typeof input === "string") {
    input
      .split(/\s+/)
      .filter(Boolean)
      .forEach((t) => out.push(t));
  } else if (Array.isArray(input)) {
    input.forEach((x) => _flatten(x, out));
  } else if (typeof input === "object") {
    for (const [k, v] of Object.entries(input)) {
      if (!k) continue;
      if (typeof v === "boolean") {
        if (v) out.push(k);
      } else if (v != null) {
        out.push(k);
      }
    }
  }
  return out;
}

/**
 * classNames(...inputs)
 * - Accepts strings, arrays, objects ({ className: boolean }), null/undefined.
 * - Dedupe exact tokens to keep Tailwind utility order stable.
 */
export function classNames(...inputs) {
  const tokens = _flatten(inputs, []);
  const seen = new Set();
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out.join(" ");
}

/** Alias used across the codebase */
export const cx = classNames;

/** Shallow merge for inline styles */
export function mergeStyles(a, b) {
  return { ...(a || {}), ...(b || {}) };
}

/* ----------------------------------------------------------------------------
 * Variants (mini CVA)
 * ---------------------------------------------------------------------------- */

/**
 * variants(config) -> (props) => string
 * Simple, typed variant builder.
 *
 * config = {
 *   base: "sv-btn",
 *   variants: {
 *     variant: { primary: "sv-btn--primary", outline: "sv-btn--outline" },
 *     size: { sm: "sv-btn--sm", md: "", lg: "sv-btn--lg" },
 *     state: { loading: "is-loading", disabled: "is-disabled" },
 *   },
 *   defaultVariants: { variant: "primary", size: "md" },
 *   compoundVariants: [{ variant: "outline", state: "disabled", class: "opacity-60" }]
 * }
 */
export function variants(config) {
  const { base = "", variants = {}, defaultVariants = {}, compoundVariants = [] } = config || {};
  return (props = {}) => {
    const classes = [base];
    const resolved = { ...defaultVariants, ...props };

    // Per-variant classes
    for (const key of Object.keys(variants)) {
      const table = variants[key] || {};
      const val = resolved[key];
      // allow boolean variants: true/false
      const vKey = typeof val === "boolean" ? String(val) : val;
      if (vKey != null && table[vKey]) classes.push(table[vKey]);
    }

    // Compound variants (all match)
    for (const entry of compoundVariants) {
      const { class: c, ...conds } = entry;
      const ok = Object.keys(conds).every((k) => {
        const left = resolved[k];
        const right = conds[k];
        return left === right;
      });
      if (ok && c) classes.push(c);
    }

    if (resolved.className) classes.push(resolved.className);
    return classNames(classes);
  };
}

/* ----------------------------------------------------------------------------
 * A11y & small helpers
 * ---------------------------------------------------------------------------- */

export const srOnly =
  "sr-only absolute w-px h-px -m-px overflow-hidden whitespace-nowrap border-0 p-0";

export function focusRing({ inset = false } = {}) {
  return classNames(
    "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/70",
    inset ? "focus-visible:ring-inset" : ""
  );
}

/** Useful for `data-*` attributes: data-active={dataAttr(active)} */
export function dataAttr(value) {
  if (value === true) return "";
  if (value === false || value == null) return undefined;
  return String(value);
}

/**
 * Apply CSS variables to :root and notify UI.
 * vars: { "--color-primary": "#7c3aed", "--radius": "12px" }
 */
export function applyThemeVars(vars = {}) {
  if (typeof document !== "undefined" && vars && typeof vars === "object") {
    const root = document.documentElement;
    Object.entries(vars).forEach(([k, v]) => {
      try {
        root.style.setProperty(k, String(v));
      } catch {}
    });
  }
  // Soft notify (optional bus); consumers can listen for live theme updates.
  try {
    const { automation } = require("@/services/automation/runtime");
    automation?.emit?.("ui.theme.changed", { vars });
  } catch {
    /* no runtime bus in SSR/tests */
  }
}

/* ----------------------------------------------------------------------------
 * Opinionated "sv-*" variant builders for consistency (buttons, cards, etc.)
 * ---------------------------------------------------------------------------- */

export const buttonCx = variants({
  base: classNames("sv-btn", focusRing()),
  variants: {
    variant: {
      primary: "sv-btn--primary",
      outline: "sv-btn--outline",
      ghost: "sv-btn--ghost",
      subtle: "sv-btn--subtle",
      danger: "sv-btn--danger",
    },
    size: { sm: "sv-btn--sm", md: "", lg: "sv-btn--lg" },
    state: { loading: "is-loading", disabled: "is-disabled" },
    full: { true: "w-full", false: "" },
  },
  defaultVariants: { variant: "primary", size: "md" },
  compoundVariants: [
    { variant: "outline", state: "disabled", class: "opacity-60" },
    { variant: "ghost", state: "disabled", class: "opacity-50" },
  ],
});

export const cardCx = variants({
  base: "sv-card",
  variants: {
    tone: {
      default: "",
      info: "sv-card--info",
      success: "sv-card--success",
      warning: "sv-card--warning",
      danger: "sv-card--danger",
    },
    padded: { true: "sv-pad", false: "" },
    elevated: { true: "shadow-md", false: "" },
  },
  defaultVariants: { tone: "default", padded: true, elevated: true },
});

export const fieldCx = variants({
  base: "sv-field",
  variants: {
    invalid: { true: "is-invalid", false: "" },
    required: { true: "is-required", false: "" },
    density: { compact: "sv-field--compact", comfy: "" },
  },
  defaultVariants: { invalid: false, required: false, density: "comfy" },
});

export const chipCx = variants({
  base: classNames("sv-chip", focusRing()),
  variants: {
    active: { true: "is-active", false: "" },
    tone: { default: "", info: "sv-chip--info", success: "sv-chip--success", danger: "sv-chip--danger" },
    size: { sm: "sv-chip--sm", md: "", lg: "sv-chip--lg" },
  },
  defaultVariants: { active: false, tone: "default", size: "md" },
});

export const badgeCx = variants({
  base: "sv-badge",
  variants: {
    tone: {
      neutral: "sv-badge--neutral",
      info: "sv-badge--info",
      success: "sv-badge--success",
      warning: "sv-badge--warning",
      danger: "sv-badge--danger",
    },
    hollow: { true: "sv-badge--hollow", false: "" },
  },
  defaultVariants: { tone: "neutral", hollow: false },
});

export const bannerCx = variants({
  base: "sv-banner",
  variants: {
    tone: { info: "sv-banner--info", success: "sv-banner--success", warning: "sv-banner--warning", danger: "sv-banner--danger" },
    closable: { true: "sv-banner--closable", false: "" },
  },
  defaultVariants: { tone: "info", closable: true },
});

export const toastCx = variants({
  base: "sv-toast",
  variants: {
    tone: { info: "sv-toast--info", success: "sv-toast--success", warning: "sv-toast--warning", error: "sv-toast--error" },
  },
  defaultVariants: { tone: "info" },
});

/* ----------------------------------------------------------------------------
 * Default export
 * ---------------------------------------------------------------------------- */
export default classNames;
