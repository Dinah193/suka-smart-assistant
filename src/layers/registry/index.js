// src/layers/registry/index.js
// SSA Fixed Layers Registry (Foundations)
// Lightweight: do not import heavy runtime deps here.
//
// You can keep this explicit list (stable) OR generate at build time.
// Explicit is best for cache invalidation and deterministic loading.

export const REGISTRY_META = Object.freeze({
  id: "ssa.fixedLayers.registry",
  version: "1.0.0",
  updatedAt: "2025-12-27",
});

// Explicit lexicon asset list (paths relative to repo root)
export const LEXICON_FILES = [
  // Planning router + overlays + Lean
  "src/layers/lexicons/planning.lexicon.json",
  "src/layers/lexicons/cultural.lexicon.json",
  "src/layers/lexicons/lean.lexicon.json",

  // Domain lexicons (examples)
  "src/layers/lexicons/meals.lexicon.json",
  "src/layers/lexicons/storehouse.lexicon.json",
  "src/layers/lexicons/homestead.lexicon.json",
];

// Explicit catalog asset list (paths relative to repo root)
export const CATALOG_FILES = [
  // Planning catalogs (examples)
  "src/layers/catalogs/planning/meals/index.json",
  "src/layers/catalogs/planning/storehouse/index.json",
  "src/layers/catalogs/planning/homestead/index.json",

  // Add pattern files here (or use folder discovery)
  // "src/layers/catalogs/planning/meals/patterns/weekly_batch.json",
];

// Optional folder-based discovery map (build tooling can expand this)
export const CATALOG_DISCOVERY = Object.freeze({
  meals: "src/layers/catalogs/planning/meals/patterns",
  storehouse: "src/layers/catalogs/planning/storehouse/patterns",
  homestead: "src/layers/catalogs/planning/homestead/patterns",
});

// Group metadata used by UI pickers
export const CATALOG_GROUPS = [
  { id: "meals", label: "Meals", domain: "meals", root: "src/layers/catalogs/planning/meals" },
  { id: "storehouse", label: "Storehouse", domain: "storehouse", root: "src/layers/catalogs/planning/storehouse" },
  { id: "homestead", label: "Homestead", domain: "homestead", root: "src/layers/catalogs/planning/homestead" },
];
