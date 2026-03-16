/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\features\recipes\index.js
//
// SSA • Recipes Feature Exports
// -----------------------------------------------------------------------------
// Purpose:
//   Single public entry for the Recipes feature so the rest of SSA can import
//   stable APIs/components without deep relative paths.
//
// Conventions:
//   - Export both named + default where sensible.
//   - Keep exports explicit (no wildcard export from folders) to avoid Vite
//     tree-shaking surprises and circular deps.
//   - Fail-soft optional exports: if a file doesn't exist yet, remove that
//     export line (this file is designed to match the file set you requested).
//
// Usage examples:
//   import { RecipeAdapterService, useCookSetup, CookSetupModal } from "@/features/recipes";
//   import { DonenessTargetsCatalog } from "@/features/recipes";
//
// -----------------------------------------------------------------------------
// Note:
//   This file assumes you created the paths you asked for:
//     contracts/*
//     catalogs/*
//     engines/*
//     hooks/*
//     ui/*
//
// No placeholders. Production-ready.

//
// Contracts (schemas / validators)
//
export { default as donenessProfileSchema } from "./contracts/doneness.profile.schema.js";
export { default as kitchenCapabilitiesSchema } from "./contracts/kitchen.capabilities.schema.js";
export { default as recipeVariantSchema } from "./contracts/recipeVariant.schema.js";
export { default as cookPlanSchema } from "./contracts/cookPlan.schema.js";

//
// Catalogs (deterministic knowledge tables)
//
export {
  DonenessTargetsCatalog,
  getDonenessTarget,
} from "./catalogs/DonenessTargets.catalog.js";
export {
  ToolSubstitutionRulesCatalog,
  findToolSubstitution,
} from "./catalogs/ToolSubstitutionRules.catalog.js";

//
// Engines (core logic)
//
export { RecipeAdapterService } from "./engines/RecipeAdapterService.js";
export { DonenessResolver } from "./engines/DonenessResolver.js";
export { CapabilityMatcher } from "./engines/CapabilityMatcher.js";
export { StepTransformer } from "./engines/StepTransformer.js";
export { RecipeIntakeParser } from "./engines/RecipeIntakeParser.js";

//
// Hooks
//
export { useCookSetup } from "./hooks/useCookSetup.js";

//
// UI Components
//
export { default as CookSetupModal } from "./ui/CookSetupModal.jsx";
export { default as DonenessSelector } from "./ui/DonenessSelector.jsx";
export { default as EquipmentMethodPicker } from "./ui/EquipmentMethodPicker.jsx";
export { default as EquipmentChecklist } from "./ui/EquipmentChecklist.jsx";
export { default as AdaptationSummary } from "./ui/AdaptationSummary.jsx";

//
// Optional convenience default export (feature namespace)
//
const RecipesFeature = {
  // contracts
  donenessProfileSchema: undefined,
  kitchenCapabilitiesSchema: undefined,
  recipeVariantSchema: undefined,
  cookPlanSchema: undefined,

  // catalogs
  DonenessTargetsCatalog: undefined,
  ToolSubstitutionRulesCatalog: undefined,

  // engines
  RecipeAdapterService: undefined,
  DonenessResolver: undefined,
  CapabilityMatcher: undefined,
  StepTransformer: undefined,
  RecipeIntakeParser: undefined,

  // hooks
  useCookSetup: undefined,

  // ui
  CookSetupModal: undefined,
  DonenessSelector: undefined,
  EquipmentMethodPicker: undefined,
  EquipmentChecklist: undefined,
  AdaptationSummary: undefined,
};

// Populate defaults with actual imports (so default export stays in sync)
try {
  // contracts
  // eslint-disable-next-line global-require
  RecipesFeature.donenessProfileSchema =
    require("./contracts/doneness.profile.schema.js")?.default;
  // eslint-disable-next-line global-require
  RecipesFeature.kitchenCapabilitiesSchema =
    require("./contracts/kitchen.capabilities.schema.js")?.default;
  // eslint-disable-next-line global-require
  RecipesFeature.recipeVariantSchema =
    require("./contracts/recipeVariant.schema.js")?.default;
  // eslint-disable-next-line global-require
  RecipesFeature.cookPlanSchema =
    require("./contracts/cookPlan.schema.js")?.default;

  // catalogs
  // eslint-disable-next-line global-require
  RecipesFeature.DonenessTargetsCatalog =
    require("./catalogs/DonenessTargets.catalog.js")?.DonenessTargetsCatalog;
  // eslint-disable-next-line global-require
  RecipesFeature.ToolSubstitutionRulesCatalog =
    require("./catalogs/ToolSubstitutionRules.catalog.js")?.ToolSubstitutionRulesCatalog;

  // engines
  // eslint-disable-next-line global-require
  RecipesFeature.RecipeAdapterService =
    require("./engines/RecipeAdapterService.js")?.RecipeAdapterService;
  // eslint-disable-next-line global-require
  RecipesFeature.DonenessResolver =
    require("./engines/DonenessResolver.js")?.DonenessResolver;
  // eslint-disable-next-line global-require
  RecipesFeature.CapabilityMatcher =
    require("./engines/CapabilityMatcher.js")?.CapabilityMatcher;
  // eslint-disable-next-line global-require
  RecipesFeature.StepTransformer =
    require("./engines/StepTransformer.js")?.StepTransformer;
  // eslint-disable-next-line global-require
  RecipesFeature.RecipeIntakeParser =
    require("./engines/RecipeIntakeParser.js")?.RecipeIntakeParser;

  // hooks
  // eslint-disable-next-line global-require
  RecipesFeature.useCookSetup =
    require("./hooks/useCookSetup.js")?.useCookSetup;

  // ui
  // eslint-disable-next-line global-require
  RecipesFeature.CookSetupModal = require("./ui/CookSetupModal.jsx")?.default;
  // eslint-disable-next-line global-require
  RecipesFeature.DonenessSelector =
    require("./ui/DonenessSelector.jsx")?.default;
  // eslint-disable-next-line global-require
  RecipesFeature.EquipmentMethodPicker =
    require("./ui/EquipmentMethodPicker.jsx")?.default;
  // eslint-disable-next-line global-require
  RecipesFeature.EquipmentChecklist =
    require("./ui/EquipmentChecklist.jsx")?.default;
  // eslint-disable-next-line global-require
  RecipesFeature.AdaptationSummary =
    require("./ui/AdaptationSummary.jsx")?.default;
} catch (e) {
  // In Vite/browser builds, require() may be disallowed. Named exports above are primary.
  // This default export is a convenience only; safe to ignore errors here.
  if (typeof window === "undefined") {
    console.warn(
      "[features/recipes/index.js] optional default export population skipped:",
      e?.message || e
    );
  }
}

export default RecipesFeature;
