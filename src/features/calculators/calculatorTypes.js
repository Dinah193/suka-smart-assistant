// src/features/calculators/calculatorTypes.js

/**
 * Suka Smart Assistant (SSA) – Calculator Types & Domains
 *
 * HOW THIS FITS:
 * ---------------------------------------------------------------------------
 * This module centralizes:
 *   - Calculator "domains" (Health, Storehouse & Meals, Garden, Animals, etc.)
 *   - Individual calculator type configs (id, label, route, planningGraph node)
 *
 * It is used by:
 *   - Router / navigation: to build calculator menus and links.
 *   - Dashboards: to show grouped calculator tiles per domain.
 *   - Planning Graph integration: to connect calculators to nodeIds.
 *   - SessionRunner & planners: to discover which calculator supports a node.
 *
 * This file is intentionally side-effect free:
 *   - Pure constants + tiny helper functions.
 *   - Safe to import anywhere in SSA (UI, services, agents).
 */

/**
 * @typedef {Object} CalculatorTypeConfig
 * @property {string} id                     Stable machine id (e.g., "bmi").
 * @property {string} label                  Human-friendly name.
 * @property {string} domain                 One of CALCULATOR_DOMAINS.*.
 * @property {string=} description           Optional description for tooltips/help.
 * @property {string=} nodeId                Optional Planning Graph node id (e.g., "node.health.bmi").
 * @property {string=} route                 Primary route for this calculator page.
 * @property {string=} icon                  Icon token for shared icon system.
 * @property {boolean=} experimental         Flag for in-progress/hidden calculators.
 */

/**
 * Calculator domain constants.
 * These align with Planning Graph high-level groupings where possible.
 */
export const CALCULATOR_DOMAINS = Object.freeze({
  HEALTH: "health",
  STOREHOUSE_MEALS: "storehouseMeals",
  GARDEN: "garden",
  ANIMALS: "animals",
  STABILITY: "stability",
  CALENDAR: "calendar",
  PRESERVATION: "preservation",
  UTILITIES: "utilities",
  OTHER: "other"
});

/**
 * Central registry of calculator types used in SSA.
 * Keep this in sync with:
 *   - planningGraph.nodes.json
 *   - planningGraph.mappings.json
 *   - Router definitions for calculator pages
 *
 * NOTE:
 * - Keys are friendly identifiers used in code.
 * - Each config includes at least: id, label, domain.
 * - nodeId should match a Planning Graph node where applicable.
 *
 * @type {{[key: string]: CalculatorTypeConfig}}
 */
export const CALCULATOR_TYPES = Object.freeze({
  // ---------------------------------------------------------------------------
  // Health & Nutrition
  // ---------------------------------------------------------------------------
  BMI: {
    id: "bmi",
    label: "BMI Calculator",
    domain: CALCULATOR_DOMAINS.HEALTH,
    description: "Body Mass Index for quick body composition screening.",
    nodeId: "node.health.bmi",
    route: "/tier2/calculators/bmi",
    icon: "bmi"
  },
  DAILY_ENERGY_REQUIREMENT: {
    id: "dailyEnergyRequirement",
    label: "Daily Energy Requirement",
    domain: CALCULATOR_DOMAINS.HEALTH,
    description: "Estimate daily calories needed for your activity level.",
    nodeId: "node.health.dailyEnergyRequirement",
    route: "/tier2/calculators/daily-energy",
    icon: "fire"
  },
  DAILY_MICRONUTRIENT_REQUIREMENT: {
    id: "dailyMicronutrientRequirement",
    label: "Daily Micronutrient Requirement",
    domain: CALCULATOR_DOMAINS.HEALTH,
    description: "Micronutrient coverage target based on age, sex, and goals.",
    nodeId: "node.health.dailyMicronutrientRequirement",
    route: "/tier2/calculators/daily-micronutrients",
    icon: "sparkles"
  },
  HAIR_NUTRITION: {
    id: "hairNutrition",
    label: "Hair Nutrition Score",
    domain: CALCULATOR_DOMAINS.HEALTH,
    description: "Score how well your current diet supports hair growth and strength.",
    nodeId: "node.health.hairNutritionScore",
    route: "/tier2/calculators/hair-nutrition",
    icon: "hair"
  },

  // ---------------------------------------------------------------------------
  // Storehouse & Meals
  // ---------------------------------------------------------------------------
  STOREHOUSE_MEALS_CAPACITY: {
    id: "storehouseMealsCapacity",
    label: "Storehouse Meals Capacity",
    domain: CALCULATOR_DOMAINS.STOREHOUSE_MEALS,
    description: "Estimate how many full meals your current storehouse can provide.",
    nodeId: "node.storehouse.storehouseMealsCapacity",
    route: "/tier2/storehouse/meals-capacity",
    icon: "warehouse-meals"
  },
  MEAT_BREAKDOWN: {
    id: "meatBreakdown",
    label: "Meat Breakdown Calculator",
    domain: CALCULATOR_DOMAINS.STOREHOUSE_MEALS,
    description: "Convert carcass weight into realistic cuts and servings.",
    nodeId: "node.storehouse.meatBreakdownCalculator",
    route: "/tier2/calculators/meat-breakdown",
    icon: "meat"
  },
  MONTHS_OF_COVER: {
    id: "storehouseMonthsOfCover",
    label: "Months of Cover",
    domain: CALCULATOR_DOMAINS.STOREHOUSE_MEALS,
    description: "How many months your storehouse can feed your household.",
    nodeId: "node.storehouse.storehouseMonthsOfCover",
    route: "/tier2/storehouse/months-of-cover",
    icon: "calendar-range"
  },

  // ---------------------------------------------------------------------------
  // Garden & Production
  // ---------------------------------------------------------------------------
  SEED_VIABILITY: {
    id: "seedViability",
    label: "Seed Viability",
    domain: CALCULATOR_DOMAINS.GARDEN,
    description: "Estimate germination strength based on storage conditions and tests.",
    nodeId: "node.garden.seedViabilityCalculator",
    route: "/tier2/garden/seed-viability",
    icon: "seedling"
  },
  HARVEST_YIELD_PROJECTION: {
    id: "harvestYieldProjection",
    label: "Harvest Yield Projection",
    domain: CALCULATOR_DOMAINS.GARDEN,
    description: "Project future harvests based on plantings, varieties, and conditions.",
    nodeId: "node.garden.harvestYieldProjection",
    route: "/tier2/garden/yield-projection",
    icon: "chart-areaspline"
  },

  // ---------------------------------------------------------------------------
  // Animals
  // ---------------------------------------------------------------------------
  ANIMAL_FEED_SUPPORT: {
    id: "animalFeedSupport",
    label: "Garden → Animal Feed Support",
    domain: CALCULATOR_DOMAINS.ANIMALS,
    description: "How much of animal feed needs can be met from your garden.",
    nodeId: "node.garden.animalFeedSupport",
    route: "/tier2/garden/animal-feed-support",
    icon: "cow"
  },

  // ---------------------------------------------------------------------------
  // Preservation
  // ---------------------------------------------------------------------------
  PRESERVATION_PLANNER: {
    id: "preservationPlanner",
    label: "Preservation Planner",
    domain: CALCULATOR_DOMAINS.PRESERVATION,
    description: "Plan canning, drying, freezing, and other preservation batches.",
    nodeId: "node.garden.preservationPlanner",
    route: "/tier2/garden/preservation-planner",
    icon: "jar"
  },

  // ---------------------------------------------------------------------------
  // Stability & Utilities (examples; flesh out as you implement)
  // ---------------------------------------------------------------------------
  INCOME_STABILITY_INDEX: {
    id: "incomeStabilityIndex",
    label: "Income Stability Index",
    domain: CALCULATOR_DOMAINS.STABILITY,
    description: "Score how predictable and resilient your household income is.",
    nodeId: "node.stability.incomeStabilityIndex",
    route: "/tier2/stability/income",
    icon: "income"
  },
  STOREHOUSE_STABILITY_INDEX: {
    id: "storehouseStabilityIndex",
    label: "Storehouse Stability Index",
    domain: CALCULATOR_DOMAINS.STABILITY,
    description: "Blend of months-of-cover, diversity, and dependency on external food.",
    nodeId: "node.stability.storehouseStabilityIndex",
    route: "/tier2/stability/storehouse",
    icon: "shield-home"
  },

  // ---------------------------------------------------------------------------
  // Calendar / Rhythm (session density, coverage, etc.)
  // ---------------------------------------------------------------------------
  MEAL_CALENDAR_COVERAGE: {
    id: "mealCalendarCoverage",
    label: "Meal Calendar Coverage",
    domain: CALCULATOR_DOMAINS.CALENDAR,
    description: "Shows how many days are planned vs. uncovered in your meal calendar.",
    nodeId: "node.calendar.mealCalendarCoverage",
    route: "/tier2/calendar/meals",
    icon: "calendar-meal"
  },
  BATCH_SESSION_DENSITY: {
    id: "batchSessionDensity",
    label: "Batch Session Density",
    domain: CALCULATOR_DOMAINS.CALENDAR,
    description: "How often you are using batch sessions for cooking, cleaning, and preservation.",
    nodeId: "node.calendar.batchSessionDensity",
    route: "/tier2/calendar/batch-sessions",
    icon: "calendar-batch"
  },

  // ---------------------------------------------------------------------------
  // Fallback / miscellaneous calculators can use OTHER domain
  // ---------------------------------------------------------------------------
  GENERIC_TIME_SAVINGS: {
    id: "genericTimeSavings",
    label: "Generic Time Savings Calculator",
    domain: CALCULATOR_DOMAINS.OTHER,
    description: "Estimate time saved by using SSA automations and batch sessions.",
    nodeId: undefined,
    route: "/tier2/calculators/time-savings",
    icon: "clock"
  }
});

/**
 * Flat list of all calculator configs.
 * Useful for iterating in menus, dashboards, admin tools, etc.
 *
 * @type {CalculatorTypeConfig[]}
 */
export const CALCULATOR_LIST = Object.freeze(
  Object.values(CALCULATOR_TYPES)
);

/**
 * Precomputed map from domain → array of calculator configs.
 *
 * @type {{[domain: string]: CalculatorTypeConfig[]}}
 */
export const CALCULATORS_BY_DOMAIN = (() => {
  /** @type {{[domain: string]: CalculatorTypeConfig[]}} */
  const map = {};
  for (const calc of CALCULATOR_LIST) {
    if (!map[calc.domain]) {
      map[calc.domain] = [];
    }
    map[calc.domain].push(calc);
  }
  // Freeze nested arrays to keep the structure immutable-ish
  Object.keys(map).forEach((domain) => {
    Object.freeze(map[domain]);
  });
  return Object.freeze(map);
})();

/**
 * Get a calculator config by its id.
 *
 * @param {string} id
 * @returns {CalculatorTypeConfig | undefined}
 */
export function getCalculatorConfig(id) {
  if (!id) return undefined;
  return CALCULATOR_TYPES[id] || undefined;
}

/**
 * Get all calculator configs for a given domain.
 *
 * @param {string} domainId One of CALCULATOR_DOMAINS.*.
 * @returns {CalculatorTypeConfig[]} Immutable array (do not mutate).
 */
export function getCalculatorsByDomain(domainId) {
  if (!domainId) return [];
  return CALCULATORS_BY_DOMAIN[domainId] || [];
}

/**
 * Find a calculator config by its Planning Graph node id.
 *
 * @param {string} nodeId Planning Graph node id (e.g., "node.health.bmi").
 * @returns {CalculatorTypeConfig | undefined}
 */
export function findCalculatorByNodeId(nodeId) {
  if (!nodeId) return undefined;
  return CALCULATOR_LIST.find((calc) => calc.nodeId === nodeId);
}

/**
 * Resolve the calculator domain for a given Planning Graph node id.
 *
 * @param {string} nodeId
 * @returns {string | undefined} domainId or undefined if not found.
 */
export function getDomainForNodeId(nodeId) {
  const calc = findCalculatorByNodeId(nodeId);
  return calc ? calc.domain : undefined;
}

/**
 * Simple type guard to check if a given value is a known domain id.
 *
 * @param {string} maybeDomain
 * @returns {boolean}
 */
export function isKnownCalculatorDomain(maybeDomain) {
  return Object.values(CALCULATOR_DOMAINS).includes(maybeDomain);
}
