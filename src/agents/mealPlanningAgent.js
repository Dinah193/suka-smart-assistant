// File: src/agents/mealPlanningShim.js
// Purpose: Compatibility facade for legacy imports.
// Some pages still import "@/agents/mealPlanningAgent" (no extension).
// This file re-exports the shim-based implementation so builds don’t break.

import * as ShimModule from "./shims/mealPlanningShim.js";

// Re-export named exports (if any) from the shim
export * from "./shims/mealPlanningShim.js";

/**
 * Default export:
 * - If mealPlanningShim.js has a default export, forward it.
 * - Otherwise export the entire module namespace as an object.
 *
 * This keeps the facade tolerant of multiple calling styles:
 *   import agent from "@/agents/mealPlanningAgent"
 *   import { planMeals } from "@/agents/mealPlanningAgent"
 */
const defaultExport = ShimModule?.default ?? ShimModule;
export default defaultExport;
