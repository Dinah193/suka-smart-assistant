// src/copy/home.copy.js
/**
 * Home copy (centralized strings)
 * Keep your JSX clean + make future tone updates easy.
 *
 * Usage:
 *   import { HOME_COPY } from "@/copy/home.copy";
 *   HOME_COPY.hero.title
 */
export const HOME_COPY = {
  hero: {
    title: "Your Household Today",
    subtitle:
      "A calm command center for meals, cleaning, cooking sessions, garden, and animals.",
    primaryCta: "Quick Add",
    secondary: {
      mealPlanning: "Meal Planning",
      cleaning: "Cleaning",
      cooking: "Cooking",
      garden: "Garden",
      animals: "Animals",
    },
    chips: {
      ready: "Ready for today",
      focus: "Today’s focus",
    },
  },

  kpis: {
    meals: { label: "Meals planned", title: "Go to Meal Planning" },
    cleaning: { label: "Today's cleaning", title: "Go to Cleaning" },
    cooking: { label: "Cooking sessions", title: "Go to Cooking Schedule" },
    garden: { label: "Garden tasks", title: "Go to Garden" },
    animals: { label: "Animal tasks", title: "Go to Animals" },
  },

  ingestHub: {
    title: "Bring Things Into Your Household",
    subtitle:
      "Capture inputs from your real home—scans, seed packets, and recipes—and let SSA turn them into plans, inventory, and sessions.",
    scan: {
      title: "Scan • Compare • Trust",
      subtitle:
        "Scan items; we’ll check pricing, coupons, recalls, and ingredients automatically. Results can flow to Meals and Inventory.",
      primary: "Open Full Scan View",
      secondary: "Clear Last",
      saveFavorite: "Save Scan Favorite",
      saveWatch: "Save Watchlist",
    },
    seed: {
      title: "Seed Packet → Garden Plan",
      subtitle:
        "OCR seed packets to auto-fill variety, sowing window, and spacing. Applies to Garden Planner and syncs tasks.",
      apply: "Apply to Garden Planner",
      openPlanner: "Open Garden Planner",
      generateFromSeeds: "Generate Plan from Seeds on Hand",
    },
    recipe: {
      title: "Recipe Importer",
      subtitle:
        "Paste a Pinterest pin/board or any recipe URL — or upload a photo. Imported items flow to the Collector and can auto-feed Meals, Garden, and Animals.",
      pinterestLabel: "Pinterest board or pin",
      anyUrlLabel: "Any recipe/article URL",
      photoLabel: "Photo to recipe",
      import: "Import",
      clear: "Clear",
      scanPhoto: "Scan Photo",
      uploading: "Uploading…",
      photoHelp:
        "We’ll OCR the photo, extract ingredients/steps, and send to the Collector.",
    },
  },

  activity: {
    title: "Activity",
    subtitle:
      "Inline tools update your other pages automatically. Here are your latest actions.",
    empty: "No recent activity yet.",
  },
};
