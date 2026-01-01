// C:\Users\larho\suka-smart-assistant\src\services\calculators\calculatorRegistry.js

/**
 * Calculator Registry
 *
 * How this fits:
 * - Central lookup table for ALL calculators in SSA:
 *   - Macro / BMI / micronutrients
 *   - Meat breakdown / storehouse-meals
 *   - Seed viability / garden planning
 *   - Hair / body nutrition, etc.
 * - Bridges:
 *   - View layer (React components under src/features/calculators/**)
 *   - Logic layer (shim modules under src/services/calculators/shims/**)
 *   - Planning Graph + SessionRunner (via `supportsSessions`, `toSessionSteps`)
 *
 * Why:
 * - One place to:
 *   - Discover calculators (for menus, dashboards, Planning Graph).
 *   - Lazy-load the correct view + shim.
 *   - Attach domain tags and “feedsInto” metadata.
 *
 * Design:
 * - This file has NO direct React imports.
 * - It exposes async “loader” functions that consumer code can wrap
 *   with React.lazy / Suspense as needed.
 *
 * ID convention:
 *   "<domain>.<category>.<name>"
 *   Examples:
 *     "health.bmi"
 *     "health.macro"
 *     "health.micronutrients"
 *     "storehouse.meals.meatBreakdown"
 *     "garden.seeds.viability"
 *     "health.hairNutrition"
 *
 * Each registry entry looks like:
 * {
 *   id: string;
 *   label: string;
 *   shortLabel?: string;
 *   description?: string;
 *   domains: string[];
 *   category: "health"|"storehouse"|"garden"|"animals"|"planning"|"other";
 *   tags: string[];
 *   // For Planning Graph / orchestration:
 *   feedsInto?: string[];
 *   // Whether this calculator can emit a SessionRunner session:
 *   supportsSessions?: boolean;
 *   // Async loaders:
 *   loadView: () => Promise<React.ComponentType<any>>;
 *   loadShim: () => Promise<any>;
 *   // Optional helper that shims can implement to turn a result into a session:
 *   toSessionSteps?: (result: any) => import("../sessions/sessionTypes").Session | null;
 * }
 *
 * NOTE:
 * - Paths here assume “feature-first” folder structure and shim files.
 * - If any path doesn’t exist yet, create the referenced files later.
 * - All loaders are defensive: they fall back to a no-op component or shim.
 */

/** @typedef {import("./types").CalculatorRegistryEntry} CalculatorRegistryEntry */
// If you don't have ./types yet, you can either create it or treat the JSDoc
// above as informal documentation.

/** ------------------------------------------------------------------------
 *  Internal registry map
 * --------------------------------------------------------------------- */

/** @type {Record<string, CalculatorRegistryEntry>} */
const REGISTRY = {
  /* ----------------------------------------------------------------------
   *  HEALTH: BMI
   * ------------------------------------------------------------------- */
  "health.bmi": {
    id: "health.bmi",
    label: "Body Mass Index (BMI)",
    shortLabel: "BMI",
    description:
      "Quickly estimate Body Mass Index to support health and activity planning.",
    domains: ["health", "meals", "planning"],
    category: "health",
    tags: ["bmi", "health", "weight", "planning"],
    feedsInto: ["planningGraph.healthProfile", "planningGraph.activityLevel"],
    supportsSessions: false,
    loadView: () =>
      safeDynamicImport(
        () =>
          import(
            "@/features/calculators/BMI/BMICalculator.view.jsx"
            /* webpackChunkName: "calc-bmi-view" */
          ),
        "BMICalculatorView"
      ),
    loadShim: () =>
      safeDynamicImport(
        () =>
          import(
            "@/services/calculators/shims/bmiCalculatorShim.js"
            /* webpackChunkName: "calc-bmi-shim" */
          ),
        "bmiCalculatorShim"
      ),
  },

  /* ----------------------------------------------------------------------
   *  HEALTH: Macro Calculator
   * ------------------------------------------------------------------- */
  "health.macro": {
    id: "health.macro",
    label: "Macro Requirements",
    shortLabel: "Macros",
    description:
      "Calculates daily macronutrient targets to align meals with health goals.",
    domains: ["health", "meals", "storehouse", "planning"],
    category: "health",
    tags: ["macros", "protein", "carbs", "fat", "planning"],
    feedsInto: [
      "planningGraph.mealPlan",
      "planningGraph.storehouseGoals",
      "planningGraph.activityLevel",
    ],
    supportsSessions: false,
    loadView: () =>
      safeDynamicImport(
        () =>
          import(
            "@/features/calculators/MacroCalculator/MacroCalculator.view.jsx"
            /* webpackChunkName: "calc-macro-view" */
          ),
        "MacroCalculatorView"
      ),
    loadShim: () =>
      safeDynamicImport(
        () =>
          import(
            "@/services/calculators/shims/macroCalculatorShim.js"
            /* webpackChunkName: "calc-macro-shim" */
          ),
        "macroCalculatorShim"
      ),
  },

  /* ----------------------------------------------------------------------
   *  HEALTH: Daily Micronutrient Requirements
   *  (replacing single-calcium calculator)
   * ------------------------------------------------------------------- */
  "health.micronutrients": {
    id: "health.micronutrients",
    label: "Daily Micronutrient Requirements",
    shortLabel: "Micronutrients",
    description:
      "Computes daily target ranges for key vitamins and minerals to guide meals and storehouse planning.",
    domains: ["health", "meals", "storehouse", "planning"],
    category: "health",
    tags: ["vitamins", "minerals", "nutrition", "planning"],
    feedsInto: [
      "planningGraph.mealPlan",
      "planningGraph.storehouseGoals",
      "planningGraph.supplementCheck",
    ],
    supportsSessions: false,
    loadView: () =>
      safeDynamicImport(
        () =>
          import(
            "@/features/calculators/MicronutrientCalculator/MicronutrientCalculator.view.jsx"
            /* webpackChunkName: "calc-micro-view" */
          ),
        "MicronutrientCalculatorView"
      ),
    loadShim: () =>
      safeDynamicImport(
        () =>
          import(
            "@/services/calculators/shims/micronutrientCalculatorShim.js"
            /* webpackChunkName: "calc-micro-shim" */
          ),
        "micronutrientCalculatorShim"
      ),
  },

  /* ----------------------------------------------------------------------
   *  HEALTH: Hair Nutrition / Growth Support
   * ------------------------------------------------------------------- */
  "health.hairNutrition": {
    id: "health.hairNutrition",
    label: "Hair Nutrition Support",
    shortLabel: "Hair Nutrition",
    description:
      "Maps hair health goals (growth, strength, shedding) to nutrient profiles and meal suggestions.",
    domains: ["health", "meals", "planning"],
    category: "health",
    tags: ["hair", "nutrition", "growth", "beauty"],
    feedsInto: [
      "planningGraph.healthProfile",
      "planningGraph.mealPlan",
      "planningGraph.micronutrientTargets",
    ],
    supportsSessions: false,
    loadView: () =>
      safeDynamicImport(
        () =>
          import(
            "@/features/calculators/HairNutrition/HairNutritionCalculator.view.jsx"
            /* webpackChunkName: "calc-hair-view" */
          ),
        "HairNutritionCalculatorView"
      ),
    loadShim: () =>
      safeDynamicImport(
        () =>
          import(
            "@/services/calculators/shims/hairNutritionCalculatorShim.js"
            /* webpackChunkName: "calc-hair-shim" */
          ),
        "hairNutritionCalculatorShim"
      ),
  },

  /* ----------------------------------------------------------------------
   *  STOREHOUSE / MEALS: Meat Breakdown
   * ------------------------------------------------------------------- */
  "storehouse.meals.meatBreakdown": {
    id: "storehouse.meals.meatBreakdown",
    label: "Meat Breakdown & Cut Planner",
    shortLabel: "Meat Breakdown",
    description:
      "Takes whole-animal weights and yields, then maps them to cuts and storehouse meals.",
    domains: ["animals", "storehouse", "meals", "planning"],
    category: "storehouse",
    tags: [
      "meat",
      "butchery",
      "yield",
      "storehouse",
      "meal planning",
      "cuts",
    ],
    feedsInto: [
      "planningGraph.storehouseGoals",
      "planningGraph.mealPlan",
      "planningGraph.animalYieldCurves",
      "planningGraph.batchCooking",
    ],
    supportsSessions: true,
    // View: UI for entering carcass weights, cut ratios, and viewing results.
    loadView: () =>
      safeDynamicImport(
        () =>
          import(
            "@/features/calculators/storehouseMeals/MeatBreakdownCalculator/MeatBreakdownCalculator.view.jsx"
            /* webpackChunkName: "calc-meatbreakdown-view" */
          ),
        "MeatBreakdownCalculatorView"
      ),
    // Shim: core logic + Planning Graph wiring + optional toSessionSteps.
    loadShim: () =>
      safeDynamicImport(
        () =>
          import(
            "@/services/calculators/shims/meatBreakdownCalculatorShim.js"
            /* webpackChunkName: "calc-meatbreakdown-shim" */
          ),
        "meatBreakdownCalculatorShim"
      ),
  },

  /* ----------------------------------------------------------------------
   *  GARDEN: Seed Viability
   * ------------------------------------------------------------------- */
  "garden.seeds.viability": {
    id: "garden.seeds.viability",
    label: "Seed Viability & Germination",
    shortLabel: "Seed Viability",
    description:
      "Estimates remaining germination rates and recommended sowing adjustments based on seed age and storage.",
    domains: ["garden", "planning", "storehouse"],
    category: "garden",
    tags: [
      "seeds",
      "viability",
      "germination",
      "garden planning",
      "storehouse",
    ],
    feedsInto: [
      "planningGraph.gardenPlan",
      "planningGraph.storehouseGoals",
      "planningGraph.seedOrdering",
    ],
    supportsSessions: false,
    loadView: () =>
      safeDynamicImport(
        () =>
          import(
            "@/features/calculators/garden/SeedViabilityCalculator/SeedViabilityCalculator.view.jsx"
            /* webpackChunkName: "calc-seedviability-view" */
          ),
        "SeedViabilityCalculatorView"
      ),
    loadShim: () =>
      safeDynamicImport(
        () =>
          import(
            "@/services/calculators/shims/seedViabilityCalculatorShim.js"
            /* webpackChunkName: "calc-seedviability-shim" */
          ),
        "seedViabilityCalculatorShim"
      ),
  },

  /* ----------------------------------------------------------------------
   *  ANIMALS: Feed / Weight / Yield planner (placeholder-ready)
   * ------------------------------------------------------------------- */
  "animals.feedYield": {
    id: "animals.feedYield",
    label: "Animal Feed & Yield Planner",
    shortLabel: "Feed & Yield",
    description:
      "Projects animal feed requirements and expected yield over time to align animals, garden, and storehouse goals.",
    domains: ["animals", "storehouse", "garden", "planning"],
    category: "animals",
    tags: ["animals", "feed", "yield", "planning", "storehouse"],
    feedsInto: [
      "planningGraph.animalYieldCurves",
      "planningGraph.storehouseGoals",
      "planningGraph.gardenPlan",
    ],
    supportsSessions: false,
    loadView: () =>
      safeDynamicImport(
        () =>
          import(
            "@/features/calculators/animals/FeedYieldCalculator/FeedYieldCalculator.view.jsx"
            /* webpackChunkName: "calc-feedyield-view" */
          ),
        "FeedYieldCalculatorView"
      ),
    loadShim: () =>
      safeDynamicImport(
        () =>
          import(
            "@/services/calculators/shims/feedYieldCalculatorShim.js"
            /* webpackChunkName: "calc-feedyield-shim" */
          ),
        "feedYieldCalculatorShim"
      ),
  },
};

/** ------------------------------------------------------------------------
 *  Public API
 * --------------------------------------------------------------------- */

/**
 * Get a calculator registry entry by ID.
 *
 * @param {string} id
 * @returns {CalculatorRegistryEntry | null}
 */
export function getCalculator(id) {
  if (!id || typeof id !== "string") return null;
  const entry = REGISTRY[id];
  return entry || null;
}

/**
 * List all calculators, optionally filtered by category or domain.
 *
 * @param {{ category?: string; domain?: string; tag?: string }} [opts]
 * @returns {CalculatorRegistryEntry[]}
 */
export function listCalculators(opts = {}) {
  const { category, domain, tag } = opts;
  const all = Object.values(REGISTRY);

  return all.filter((entry) => {
    if (category && entry.category !== category) return false;
    if (domain && !entry.domains.includes(domain)) return false;
    if (tag && !entry.tags.includes(tag)) return false;
    return true;
  });
}

/**
 * Convenience: list calculators relevant to a SessionRunner domain
 * (cooking, cleaning, garden, animals, preservation, storehouse).
 *
 * This lets domain dashboards show “related calculators” near
 * the “Now” buttons.
 *
 * @param {"cooking"|"cleaning"|"garden"|"animals"|"preservation"|"storehouse"} sessionDomain
 * @returns {CalculatorRegistryEntry[]}
 */
export function listCalculatorsForSessionDomain(sessionDomain) {
  if (!sessionDomain) return [];
  // Allow loose matching: domain lists may contain “meals”, “storehouse”, etc.
  const all = Object.values(REGISTRY);
  return all.filter((entry) => {
    if (sessionDomain === "cooking") {
      return entry.domains.includes("meals") || entry.domains.includes("health");
    }
    if (sessionDomain === "storehouse") {
      return entry.domains.includes("storehouse");
    }
    if (sessionDomain === "garden") {
      return entry.domains.includes("garden");
    }
    if (sessionDomain === "animals") {
      return entry.domains.includes("animals");
    }
    if (sessionDomain === "cleaning") {
      // Future: cleaning chemistry / dilution calculators.
      return entry.domains.includes("cleaning");
    }
    if (sessionDomain === "preservation") {
      // Future: pH / salt / brine / canning-time calculators.
      return entry.domains.includes("preservation") || entry.domains.includes("storehouse");
    }
    return false;
  });
}

/**
 * Get the async view loader for a calculator.
 *
 * Typical usage with React.lazy:
 *
 *   const entry = getCalculator("health.macro");
 *   const MacroCalcView = React.lazy(entry.loadView);
 *
 * @param {string} id
 * @returns {(() => Promise<any>) | null}
 */
export function getCalculatorViewLoader(id) {
  const entry = getCalculator(id);
  if (!entry) return null;
  return entry.loadView;
}

/**
 * Get the async shim loader for a calculator.
 *
 * The shim is where pure calculator logic lives and where you can
 * connect to the Planning Graph, Dexie, and SessionRunner.
 *
 * @param {string} id
 * @returns {(() => Promise<any>) | null}
 */
export function getCalculatorShimLoader(id) {
  const entry = getCalculator(id);
  if (!entry) return null;
  return entry.loadShim;
}

/**
 * Quick helper: does a calculator support emitting sessions?
 *
 * This allows Planning Graph nodes to automatically show a
 * “Create Session” or “Run Session” CTA after a calculation.
 *
 * @param {string} id
 * @returns {boolean}
 */
export function calculatorSupportsSessions(id) {
  const entry = getCalculator(id);
  return !!entry && !!entry.supportsSessions;
}

/**
 * Expose the raw registry (read-only). Useful for settings pages
 * and debugging, but should not be mutated at runtime.
 *
 * @returns {Record<string, CalculatorRegistryEntry>}
 */
export function getCalculatorRegistrySnapshot() {
  return { ...REGISTRY };
}

/** ------------------------------------------------------------------------
 *  Internal helpers
 * --------------------------------------------------------------------- */

/**
 * Safe dynamic import wrapper.
 *
 * - Calls the given loader (which returns a dynamic import Promise).
 * - Returns `mod.default` if present; otherwise returns the module itself.
 * - On error, logs a warning and returns a simple identity function or
 *   a no-op shim.
 *
 * @template T
 * @param {() => Promise<T>} loader
 * @param {string} label
 * @returns {Promise<any>}
 */
async function safeDynamicImport(loader, label) {
  try {
    const mod = await loader();
    if (mod && typeof mod === "object" && "default" in mod) {
      return mod.default;
    }
    return mod;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[calculatorRegistry] Failed to load module for",
      label,
      "error:",
      err
    );

    // Fallback view: simple component-like function for React.
    if (label && label.toLowerCase().includes("view")) {
      // eslint-disable-next-line no-unused-vars
      return function FallbackCalculatorView(props) {
        return (
          // This JSX is safe; if you prefer pure JS, replace this with
          // React.createElement in a dedicated fallback component file
          // and import that instead.
          null
        );
      };
    }

    // Fallback shim: no-op.
    return {
      run: () => null,
    };
  }
}

export default {
  getCalculator,
  listCalculators,
  listCalculatorsForSessionDomain,
  getCalculatorViewLoader,
  getCalculatorShimLoader,
  calculatorSupportsSessions,
  getCalculatorRegistrySnapshot,
};
