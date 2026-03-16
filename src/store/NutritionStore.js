// File: src/store/NutritionStore.js
// Purpose: Compatibility facade for legacy imports
// Routes older imports to the current NutritionGoalsStore implementation

import * as StoreModule from "./NutritionGoalsStore.js";

// Re-export named exports
export * from "./NutritionGoalsStore.js";

/**
 * Named hook compatibility:
 * Build expects:
 *   import { useNutritionStore } from "@/store/NutritionStore"
 *
 * We alias to whatever the real store exposes.
 */
export const useNutritionStore =
  StoreModule?.useNutritionStore ||
  StoreModule?.useNutritionGoalsStore ||
  StoreModule?.useNutritionGoals ||
  StoreModule?.useStore ||
  StoreModule?.default?.useNutritionStore ||
  StoreModule?.default?.useNutritionGoalsStore ||
  StoreModule?.default?.useNutritionGoals ||
  StoreModule?.default?.useStore ||
  null;

/**
 * Default export compatibility:
 * Allows both:
 *   import NutritionStore from "@/store/NutritionStore"
 *   import { useNutritionGoals } from "@/store/NutritionStore"
 */
const defaultExport = StoreModule?.default ?? StoreModule;
export default defaultExport;
