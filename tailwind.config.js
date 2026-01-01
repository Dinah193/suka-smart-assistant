// tailwind.config.js
/* eslint-disable @typescript-eslint/no-var-requires */
const colors = require("tailwindcss/colors");
const plugin = require("tailwindcss/plugin");

/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ["class"], // use <html class="dark">, toggled in your settings
  important: false,    // flip to true if you embed widgets in 3rd-party DOM
  content: [
    "./index.html",
    "./src/**/*.{js,jsx,ts,tsx}",
    "./components/**/*.{js,jsx,ts,tsx}",
    "./app/**/*.{js,jsx,ts,tsx}",
    // shadcn/ui paths (if you’re using it)
    "./src/components/ui/**/*.{js,jsx,ts,tsx}",
  ],

  safelist: [
    // Dynamic palettes used by generators (inventory, recipes, timers, maps)
    {
      pattern:
        /(bg|text|border|ring|fill|stroke|from|via|to)-(brand|skin|success|warn|danger|zinc|neutral|stone|sky|teal|emerald|amber|rose|indigo|purple|pink)-(50|100|200|300|400|500|600|700|800|900)/,
    },
    // Grid and span utilities produced by dashboard builders
    { pattern: /(grid-cols|col-span|row-span|order|z)-\d+/ },
    // Width/height buckets for cards, modals, panels
    { pattern: /(w|h|min-w|min-h|max-w|max-h)-(\\d+|screen|full)/ },
    // Opacity and blur variations for overlays
    { pattern: /(backdrop-blur|blur|opacity)-\d+/ },
    // Rotations/scales/translates for drag/drop + animations
    { pattern: /(scale|rotate|translate|skew)-[xyz]?-\d+/ },
  ],

  theme: {
    container: {
      center: true,
      padding: "1rem",
      screens: {
        sm: "640px",
        md: "768px",
        lg: "1100px", // matches --container-max
        xl: "1280px",
        "2xl": "1440px",
      },
    },
    extend: {
      // Font Family
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "Segoe UI", "Roboto"],
        display: ["Inter", "ui-sans-serif", "system-ui"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Monaco", "Consolas"],
      },

      // Color System — CSS-variable friendly (for theme switching)
      // Use with classes like bg-background text-foreground (shadcn-style tokens)
      colors: {
        // Tailwind core extensions you actually use
        zinc: colors.zinc,
        neutral: colors.neutral,
        stone: colors.stone,
        sky: colors.sky,
        emerald: colors.emerald,
        amber: colors.amber,
        rose: colors.rose,
        indigo: colors.indigo,
        purple: colors.purple,
        pink: colors.pink,
        yellow: colors.yellow,

        // Brand tokens (HSL variables let you theme from :root easily)
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",

        brand: {
          DEFAULT: "hsl(var(--brand))",      // --brand: 255 100% 66%  (example)
          ink: "hsl(var(--brand-ink))",
          weak: "hsl(var(--brand-weak))",
        },
        skin: {
          deep: "hsl(var(--skin-deep))",
          rich: "hsl(var(--skin-rich))",
          warm: "hsl(var(--skin-warm))",
          hi: "hsl(var(--skin-hi))",
        },
        success: "hsl(var(--success))",
        warn: "hsl(var(--warn))",
        danger: "hsl(var(--danger))",

        // UI semantic aliases
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
      },

      // Radius scale (works with shadcn)
      borderRadius: {
        lg: "var(--radius-lg, 12px)",
        md: "var(--radius-md, 10px)",
        sm: "var(--radius-sm, 8px)",
        xl: "var(--radius-xl, 16px)",
        "2xl": "var(--radius-2xl, 20px)",
        chip: "9999px",
      },

      // Shadows
      boxShadow: {
        card: "0 10px 20px rgba(0,0,0,.06)",
        soft:
          "0 1px 2px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.04)",
        glow: "0 0 0 3px hsl(var(--brand)/.15)",
      },

      // Spacing shortcuts for stacked forms/lists
      spacing: {
        "stack-sm": "0.5rem",
        "stack-md": "0.75rem",
        "stack-lg": "1rem",
      },

      // Animations
      keyframes: {
        fadeInUp: {
          "0%": { opacity: "0", transform: "translateY(20px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        bounceOnce: {
          "0%, 100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-15px)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        accordionDown: {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        accordionUp: {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
      },
      animation: {
        "fade-in-up": "fadeInUp 0.6s ease-out forwards",
        "bounce-once": "bounceOnce 0.5s ease",
        shimmer:
          "shimmer 1.25s linear infinite; background-size: 200% 100%;",
        "accordion-down": "accordionDown 0.2s ease-out",
        "accordion-up": "accordionUp 0.2s ease-out",
      },

      // Typography fine-tuning for readable “visible drafts”
      typography: (theme) => ({
        DEFAULT: {
          css: {
            "--tw-prose-bullets": theme("colors.brand.DEFAULT"),
            a: { textDecoration: "none" },
            "a:hover": { textDecoration: "underline" },
            h1: { fontWeight: "800", letterSpacing: "-0.02em" },
            h2: { fontWeight: "700", letterSpacing: "-0.01em" },
            code: { fontWeight: "600" },
          },
        },
        invert: {
          css: {
            "--tw-prose-bullets": theme("colors.brand.weak"),
          },
        },
      }),
    },
  },

  plugins: [
    // Official
    require("@tailwindcss/forms"),
    require("@tailwindcss/typography"),
    require("@tailwindcss/aspect-ratio"),
    require("@tailwindcss/line-clamp"),

    // Lightweight animate helpers (optional, remove if not installed)
    // require("tailwindcss-animate"),

    // DaisyUI for rapid theming (optional – comment out if not using)
    // require("daisyui"),

    // Custom variants/utilities we rely on across modules
    plugin(({ addVariant, addUtilities, matchUtilities, theme, e }) => {
      // Hover+focus together
      addVariant("hocus", ["&:hover", "&:focus"]);
      addVariant("group-hocus", [":merge(.group):hover &", ":merge(.group):focus &"]);
      addVariant("child", "& > *");
      addVariant("children", "& *");
      addVariant("scrollbar", "&::-webkit-scrollbar");
      addVariant("scrollbar-thumb", "&::-webkit-scrollbar-thumb");

      // Scrollbar utilities
      addUtilities({
        ".scrollbar-thin": { "scrollbar-width": "thin" },
        ".scrollbar-none": { "scrollbar-width": "none" },
      });

      // Shimmer utility (skeleton loaders)
      addUtilities({
        ".suka-shimmer": {
          background:
            "linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,.35) 50%, rgba(255,255,255,0) 100%)",
          backgroundSize: "200% 100%",
          animation: "shimmer 1.25s linear infinite",
        },
      });

      // Ring utilities mapped to brand
      matchUtilities(
        {
          "ring-brand": (value) => ({
            boxShadow: `0 0 0 ${value} hsl(var(--brand))`,
          }),
        },
        { values: theme("spacing") }
      );
    }),
  ],

  // DaisyUI themes (uncomment plugin above to use)
  // daisyui: {
  //   themes: [
  //     {
  //       sacredVillage: {
  //         primary: "#6b4eff",
  //         "primary-content": "#fff",
  //         secondary: "#a3654f",
  //         accent: "#f59e0b",
  //         neutral: "#2b2466",
  //         "base-100": "#faf8f5",
  //         info: "#0ea5e9",
  //         success: "#10b981",
  //         warning: "#f59e0b",
  //         error: "#ef4444",
  //       },
  //     },
  //     {
  //       strongholdFitness: {
  //         primary: "#0ea5e9",
  //         "primary-content": "#061119",
  //         secondary: "#22c55e",
  //         accent: "#f97316",
  //         neutral: "#0b1020",
  //         "base-100": "#0f172a",
  //         info: "#38bdf8",
  //         success: "#22c55e",
  //         warning: "#f59e0b",
  //         error: "#ef4444",
  //       },
  //     },
  //     "light",
  //     "dark",
  //   ],
  // },
};
