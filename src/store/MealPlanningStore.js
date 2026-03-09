// File: src/store/MealPlanningStore.js
// Purpose: Compatibility facade for legacy imports.
//
// Build error expects:
//   import { useMealPlanningStore } from "@/store/MealPlanningStore"
//
// Actual store is at:
//   src/store/MealPlanStore (no extension in import)

import * as StoreModule from "./MealPlanStore";

// Re-export any named exports from the real store
export * from "./MealPlanStore";

// Provide a stable named hook for consumers that expect it.
export const useMealPlanningStore =
  StoreModule?.useMealPlanningStore ||
  StoreModule?.useMealPlanStore ||
  StoreModule?.useStore ||
  StoreModule?.default?.useMealPlanningStore ||
  StoreModule?.default?.useMealPlanStore ||
  StoreModule?.default?.useStore ||
  null;

// Default export compatibility:
// - If MealPlanStore has a default export, forward it.
// - Otherwise export the whole module namespace.
const defaultExport = StoreModule?.default ?? StoreModule;
export default defaultExport;
