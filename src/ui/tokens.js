/* eslint-disable no-console */
/**
 * Suka Smart Assistant — UI Tokens
 *
 * Purpose:
 *  - Single source of truth for spacing, radii, shadows, sizes, and semantic colors.
 *  - Apply tokens to CSS variables for easy use across Tailwind/DaisyUI and custom CSS.
 *  - Provide theme switching with UNDO and emit user-facing nudges after success.
 *  - Light event-driven accents: adjust an intent-accent variable when core modules change.
 *
 * Assumptions:
 *  - Event bus: on(type, handler), emit(type, payload) from "@/services/automation/runtime"
 *  - Tailwind can reference CSS vars via utilities (e.g., bg-[var(--color-surface)])
 */

import { on, emit } from "@/services/automation/runtime";

/* ------------------------------------------------------------------ */
/* Core Scales                                                         */
/* ------------------------------------------------------------------ */

const spacing = {
  px: "1px",
  0: "0px",
  0.5: "0.125rem",
  1: "0.25rem",
  1.5: "0.375rem",
  2: "0.5rem",
  2.5: "0.625rem",
  3: "0.75rem",
  3.5: "0.875rem",
  4: "1rem",
  5: "1.25rem",
  6: "1.5rem",
  7: "1.75rem",
  8: "2rem",
  9: "2.25rem",
  10: "2.5rem",
  12: "3rem",
  16: "4rem",
  20: "5rem",
  24: "6rem",
  32: "8rem",
  40: "10rem",
};

const radii = {
  none: "0px",
  sm: "0.25rem",
  md: "0.5rem",
  lg: "0.75rem",
  xl: "1rem",
  "2xl": "1.25rem",
  pill: "9999px",
};

const shadows = {
  xs: "0 1px 2px rgba(0,0,0,0.05)",
  sm: "0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.06)",
  md: "0 4px 6px rgba(0,0,0,0.08), 0 2px 4px rgba(0,0,0,0.06)",
  lg: "0 10px 15px rgba(0,0,0,0.10), 0 4px 6px rgba(0,0,0,0.05)",
  xl: "0 20px 25px rgba(0,0,0,0.12), 0 10px 10px rgba(0,0,0,0.04)",
  focus: "0 0 0 3px rgba(59,130,246,0.4)", // blue-500/40
};

const sizes = {
  container: {
    sm: "640px",
    md: "768px",
    lg: "1024px",
    xl: "1280px",
    "2xl": "1440px",
  },
  font: {
    xs: "0.75rem",
    sm: "0.875rem",
    md: "1rem",
    lg: "1.125rem",
    xl: "1.25rem",
    "2xl": "1.5rem",
    "3xl": "1.875rem",
    "4xl": "2.25rem",
  },
  icon: {
    xs: "16px",
    sm: "18px",
    md: "20px",
    lg: "24px",
    xl: "28px",
  },
  z: {
    base: 1,
    dropdown: 10,
    overlay: 20,
    modal: 30,
    toast: 40,
    tooltip: 50,
  },
};

/* ------------------------------------------------------------------ */
/* Themes (Semantic Colors + Surfaces)                                 */
/* ------------------------------------------------------------------ */

const themes = {
  light: {
    meta: { name: "light", dark: false },
    color: {
      text: "#1f2937",        // gray-800
      textMuted: "#6b7280",   // gray-500
      surface: "#ffffff",
      surfaceAlt: "#f9fafb",  // gray-50
      border: "#e5e7eb",      // gray-200

      primary: "#2563eb",     // blue-600
      primaryAlt: "#1d4ed8",  // blue-700
      success: "#16a34a",     // green-600
      warning: "#d97706",     // amber-600
      danger:  "#dc2626",     // red-600
      info:    "#0891b2",     // cyan-600
      neutral: "#6b7280",     // gray-500

      // component-focused aliases
      cardBg: "#ffffff",
      cardBorder: "#e5e7eb",
      buttonTextOnPrimary: "#ffffff",
      link: "#2563eb",
      linkHover: "#1d4ed8",

      // dynamic accent updated by event glue
      intentAccent: "#2563eb",
    },
  },

  dark: {
    meta: { name: "dark", dark: true },
    color: {
      text: "#e5e7eb",         // gray-200
      textMuted: "#9ca3af",    // gray-400
      surface: "#0b0f14",      // near black with blue tint
      surfaceAlt: "#0f172a",   // slate-900
      border: "#1f2937",       // gray-800

      primary: "#3b82f6",      // blue-500
      primaryAlt: "#2563eb",   // blue-600
      success: "#22c55e",      // green-500
      warning: "#f59e0b",      // amber-500
      danger:  "#ef4444",      // red-500
      info:    "#06b6d4",      // cyan-500
      neutral: "#9ca3af",      // gray-400

      cardBg: "#111827",       // gray-900
      cardBorder: "#1f2937",
      buttonTextOnPrimary: "#0b0f14",
      link: "#93c5fd",
      linkHover: "#bfdbfe",

      intentAccent: "#3b82f6",
    },
  },
};

/* ------------------------------------------------------------------ */
/* Internal State + Undo                                               */
/* ------------------------------------------------------------------ */

let currentTheme = "light";
const UNDO = [];

function snapshotVars() {
  const styles = getComputedStyle(document.documentElement);
  const m = {};
  // Capture key vars to enable UNDO (not every single one for perf)
  [
    "--color-text",
    "--color-text-muted",
    "--color-surface",
    "--color-surface-alt",
    "--color-border",
    "--color-primary",
    "--color-primary-alt",
    "--color-success",
    "--color-warning",
    "--color-danger",
    "--color-info",
    "--color-neutral",
    "--card-bg",
    "--card-border",
    "--link",
    "--link-hover",
    "--intent-accent",
  ].forEach((k) => (m[k] = styles.getPropertyValue(k)));
  return m;
}

function applyVars(vars) {
  const root = document.documentElement;
  Object.entries(vars).forEach(([k, v]) => root.style.setProperty(k, v));
}

/* ------------------------------------------------------------------ */
/* CSS Variable Builder                                                */
/* ------------------------------------------------------------------ */

function buildCSSVars(theme) {
  const t = themes[theme] || themes.light;
  const vars = {
    // Colors
    "--color-text": t.color.text,
    "--color-text-muted": t.color.textMuted,
    "--color-surface": t.color.surface,
    "--color-surface-alt": t.color.surfaceAlt,
    "--color-border": t.color.border,

    "--color-primary": t.color.primary,
    "--color-primary-alt": t.color.primaryAlt,
    "--color-success": t.color.success,
    "--color-warning": t.color.warning,
    "--color-danger": t.color.danger,
    "--color-info": t.color.info,
    "--color-neutral": t.color.neutral,

    "--card-bg": t.color.cardBg,
    "--card-border": t.color.cardBorder,
    "--link": t.color.link,
    "--link-hover": t.color.linkHover,

    "--intent-accent": t.color.intentAccent,

    // Radii
    "--radius-sm": radii.sm,
    "--radius-md": radii.md,
    "--radius-lg": radii.lg,
    "--radius-xl": radii.xl,
    "--radius-2xl": radii["2xl"],
    "--radius-pill": radii.pill,

    // Spacing shortcuts (a few high-usage entries)
    "--space-2": spacing[2],
    "--space-3": spacing[3],
    "--space-4": spacing[4],
    "--space-6": spacing[6],
    "--space-8": spacing[8],
    "--space-12": spacing[12],

    // Shadows
    "--shadow-xs": shadows.xs,
    "--shadow-sm": shadows.sm,
    "--shadow-md": shadows.md,
    "--shadow-lg": shadows.lg,
    "--shadow-xl": shadows.xl,
    "--shadow-focus": shadows.focus,

    // Sizes
    "--container-sm": sizes.container.sm,
    "--container-md": sizes.container.md,
    "--container-lg": sizes.container.lg,
    "--container-xl": sizes.container.xl,
    "--container-2xl": sizes.container["2xl"],

    "--font-xs": sizes.font.xs,
    "--font-sm": sizes.font.sm,
    "--font-md": sizes.font.md,
    "--font-lg": sizes.font.lg,
    "--font-xl": sizes.font.xl,
    "--font-2xl": sizes.font["2xl"],
    "--font-3xl": sizes.font["3xl"],
    "--font-4xl": sizes.font["4xl"],

    "--icon-xs": sizes.icon.xs,
    "--icon-sm": sizes.icon.sm,
    "--icon-md": sizes.icon.md,
    "--icon-lg": sizes.icon.lg,
    "--icon-xl": sizes.icon.xl,

    "--z-dropdown": sizes.z.dropdown,
    "--z-overlay": sizes.z.overlay,
    "--z-modal": sizes.z.modal,
    "--z-toast": sizes.z.toast,
    "--z-tooltip": sizes.z.tooltip,
  };
  return vars;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Apply a theme and emit UI nudges with a next-best action.
 * Provides UNDO of the last token change.
 */
export function setTheme(themeName) {
  const theme = themes[themeName] ? themeName : "light";
  const before = snapshotVars();
  const vars = buildCSSVars(theme);
  applyVars(vars);
  currentTheme = theme;

  // Push undo
  UNDO.push(() => applyVars(before));

  // Inform app shell & components
  emit("ui.tokens.changed", { theme, vars });

  // Nudge: suggest saving preference or previewing dark/light
  emit("ui.nudge", {
    at: Date.now(),
    message: `Theme switched to “${theme}”. Keep it as your default?`,
    actions: [
      { label: "Save as Default", href: "/settings/appearance" },
      { label: theme === "dark" ? "Try Light" : "Try Dark", href: "/settings/appearance#toggle" },
    ],
    source: "ui.tokens",
  });
}

export function undoThemeChange() {
  const fn = UNDO.pop();
  if (fn) {
    fn();
    emit("ui.tokens.changed", { theme: currentTheme, vars: snapshotVars() });
  }
}

export function getTokensSnapshot() {
  return {
    theme: currentTheme,
    spacing,
    radii,
    shadows,
    sizes,
    themeVars: buildCSSVars(currentTheme),
  };
}

/* ------------------------------------------------------------------ */
/* Event-driven accents (glue)                                         */
/* ------------------------------------------------------------------ */
/**
 * Subtly adjusts --intent-accent (used for badges/borders/cta outlines)
 * when core modules change. This gives a live, “connected” feel without
 * jarring full-theme changes.
 */
export function registerTokenEventGlue() {
  const root = document.documentElement;

  const setAccent = (hex) => {
    root.style.setProperty("--intent-accent", hex);
    emit("ui.tokens.changed", { theme: currentTheme, vars: { "--intent-accent": hex } });
  };

  on("mealplan.created", () => setAccent(getThemeColor("primary")));
  on("recipes.updated", () => setAccent(getThemeColor("info")));
  on("batch.completed", () => setAccent(getThemeColor("success")));
  on("inventory.updated", (evt) =>
    setAccent(evt?.payload?.lowStockCount > 0 ? getThemeColor("warning") : getThemeColor("info"))
  );
  on("calendar.events.updated", () => setAccent(getThemeColor("primaryAlt")));

  // Provide a global undo as well
  on("ui.tokens.undo", () => undoThemeChange());
}

function getThemeColor(key) {
  const t = themes[currentTheme] || themes.light;
  return t.color[key] || t.color.primary;
}

/* ------------------------------------------------------------------ */
/* Boot (empty state nudge on first apply)                             */
/* ------------------------------------------------------------------ */

let _booted = false;
export function bootstrapTokens() {
  if (_booted) return;
  _booted = true;

  // Apply initial theme
  setTheme(currentTheme);

  // If truly first load, emit empty-state guidance for appearance settings
  emit("ui.tokens.empty", {
    message: "Customize your look & feel. Switch themes, radius, and shadow depth.",
    actions: [
      { label: "Appearance Settings", href: "/settings/appearance" },
      { label: "Try Dark Theme", href: "/settings/appearance#toggle" },
    ],
  });

  // Register event-driven glue
  registerTokenEventGlue();

  if (import.meta?.env?.DEV) console.debug("[ui/tokens] booted");
}

/* ------------------------------------------------------------------ */
/* Convenience: apply minimal base styles (optional)                   */
/* ------------------------------------------------------------------ */
/**
 * Call this once if you want a base style element that provides variable fallbacks
 * for non-Tailwind surfaces (cards/buttons). You may already have this in global CSS.
 */
export function ensureBaseStyleSheet() {
  const id = "suka-ui-token-base";
  if (document.getElementById(id)) return;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = `
    :root {
      color: var(--color-text);
      background: var(--color-surface);
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: var(--radius-xl);
      box-shadow: var(--shadow-sm);
      padding: var(--space-4);
    }
    .btn {
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-xs);
    }
    .btn:focus-visible {
      outline: none;
      box-shadow: var(--shadow-focus);
    }
    a { color: var(--link); }
    a:hover { color: var(--link-hover); }
    .intent-accent-ring { box-shadow: 0 0 0 3px color-mix(in srgb, var(--intent-accent) 40%, transparent); }
  `;
  document.head.appendChild(style);
}

/* ------------------------------------------------------------------ */
/* Named export of base scales (optional usage in JS)                  */
/* ------------------------------------------------------------------ */

export const TOKENS = {
  spacing,
  radii,
  shadows,
  sizes,
  themes: Object.keys(themes),
};
