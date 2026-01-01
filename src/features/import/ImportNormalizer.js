// C:\Users\larho\suka-smart-assistant\src\features\import\ImportNormalizer.js
// Unified / dynamic import normalizer
// -----------------------------------------------------------------------------
// This sits in front of all the different “import” surfaces (browser bookmarklet,
// Pinterest → Planner, Allrecipes/TikTok/YT/Facebook recipe pulls, garden/seed
// data, storehouse templates, scan-compare-trust CSV/PDF pulls, cleaning plans,
// animal/livestock plans, meal plans, and co-op style storehouse stock plans).
//
// UPDATED to include:
//  - cleaning plans (zones, rooms, declutter sessions)
//  - garden planning (seeds/rows/zone/co-op)
//  - garden CARE / MAINTENANCE (watering, weeding, fertilizing, pest)
//  - garden HARVEST (yield logs → inventory/cooking later)
//  - storehouse GOALS **and** storehouse STOCK PLANS (grocery-section style)
//  - meal planning (days/week layouts)
//  - animal acquisition, care, and butchery (not just final products)
//  - user-owned favorites on import
//  - shared orchestration events
//
// GOALS (from project chats):
// 1. Everything that gets imported should be normalized into ONE of the system
//    domain shapes: recipe, mealPlan, cleaningSession, gardenPlan, gardenCare,
//    gardenHarvest, animalPlan, storehouseGoal, storehouseStockPlan,
//    inventoryUpdate, pricebookEntry, communityShare, etc.
// 2. Users must be able to SAVE their own favorite sessions and schedules
//    (NOT just the system-provided ones).
// 3. It must support **reverse generation**.
// 4. It must integrate with shared orchestration / buses.
// 5. It should be defensive and pluggable.

import { v4 as uuidv4 } from "uuid";

const isBrowser = typeof window !== "undefined";

// local user-owned favorites (can be swapped for Dexie later)
const FAVORITES_KEY = "suka.import.favorites.v1";

/* -------------------------------------------------------------------------- */
/* shared event emitter (DOM + in-app bus)                                    */
/* -------------------------------------------------------------------------- */
function emit(eventName, detail = {}) {
  if (isBrowser) {
    try {
      window.dispatchEvent(new CustomEvent(eventName, { detail }));
    } catch {
      /* noop */
    }
  }
  try {
    const bus = isBrowser ? window.__suka?.eventBus : null;
    if (bus?.emit) bus.emit(eventName, detail);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[ImportNormalizer] bus emit failed:", err);
  }
}

/* -------------------------------------------------------------------------- */
/* favorites helpers                                                          */
/* -------------------------------------------------------------------------- */
function loadFavorites() {
  if (!isBrowser) return [];
  try {
    const raw = window.localStorage.getItem(FAVORITES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveFavorites(favs) {
  if (!isBrowser) return;
  try {
    window.localStorage.setItem(FAVORITES_KEY, JSON.stringify(favs));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[ImportNormalizer] failed to persist favorites:", err);
  }
}

function addFavorite(normalized) {
  const favs = loadFavorites();
  const next = [
    {
      id: normalized.id || uuidv4(),
      type: normalized.type,
      title: normalized.title || normalized.name || "Untitled import",
      createdAt: Date.now(),
      payload: normalized,
    },
    ...favs,
  ];
  saveFavorites(next);
  return next;
}

/* -------------------------------------------------------------------------- */
/* SHAPES                                                                     */
/* -------------------------------------------------------------------------- */

// recipe / cooking
function recipeShape(input) {
  return {
    id: input.id || uuidv4(),
    type: "recipe",
    title: input.title || input.name || "Imported Recipe",
    source: input.source || {},
    ingredients: input.ingredients || [],
    steps: input.steps || input.directions || [],
    tags: input.tags || [],
    crosslinks: {
      mealPlanner: true,
      batchCooking: true,
      // hook to “Generate Animal Plan from Recipes”
      animalPlanner: !!input.usesAnimalProduct || !!input.requiresButchery,
      storehouse: true,
    },
    meta: {
      importAt: Date.now(),
      raw: input.raw || input,
    },
  };
}

// meal plan (days array)
function mealPlanShape(input) {
  return {
    id: input.id || uuidv4(),
    type: "mealPlan",
    title: input.title || "Imported Meal Plan",
    days: input.days || [], // [{date, meals:[recipeIds or inlineRecipe]}]
    source: input.source || {},
    meta: {
      importAt: Date.now(),
      raw: input.raw || input,
      collaborative: true, // “plan with others”
    },
  };
}

// garden plan
function gardenPlanShape(input) {
  return {
    id: input.id || uuidv4(),
    type: "gardenPlan",
    title: input.title || "Imported Garden Plan",
    rows: input.rows || [],
    seeds: input.seeds || input.seedData || input.items || [],
    zone: input.zone || input.growingZone || null,
    source: input.source || {},
    meta: {
      importAt: Date.now(),
      raw: input.raw || input,
      coop: true,
    },
  };
}

// garden care / maintenance
function gardenCareShape(input) {
  return {
    id: input.id || uuidv4(),
    type: "gardenCare",
    title: input.title || "Imported Garden Care Tasks",
    tasks: (input.tasks || input.items || []).map((t) => ({
      id: t.id || uuidv4(),
      task: t.task || t.title || t.name || "Garden Care Task",
      notes: t.notes || t.description || "",
      when: t.when || t.date || null,
      zone: t.zone || t.bed || null,
    })),
    source: input.source || {},
    meta: {
      importAt: Date.now(),
      raw: input.raw || input,
      scheduleable: true,
    },
  };
}

// garden harvest / yield
function gardenHarvestShape(input) {
  return {
    id: input.id || uuidv4(),
    type: "gardenHarvest",
    title: input.title || "Imported Garden Harvest",
    harvest: (input.harvest || input.items || []).map((h) => ({
      id: h.id || uuidv4(),
      crop: h.crop || h.name || h.title || "Harvest Item",
      qty: h.qty ?? h.quantity ?? 1,
      unit: h.unit || "ea",
      notes: h.notes || h.description || "",
      harvestedAt: h.harvestedAt || h.date || null,
    })),
    source: input.source || {},
    meta: {
      importAt: Date.now(),
      raw: input.raw || input,
      toInventory: true,
      toCooking: true,
    },
  };
}

// storehouse GOAL (your “Goals Planner”)
function storehouseGoalShape(input) {
  return {
    id: input.id || uuidv4(),
    type: "storehouseGoal",
    title: input.title || "Imported Storehouse Goal",
    items: input.items || [],
    source: input.source || {},
    meta: {
      importAt: Date.now(),
      raw: input.raw || input,
      target: "storehouse",
    },
  };
}

// NEW: storehouse STOCK PLAN (grocery sections for inspiration)
function storehouseStockPlanShape(input) {
  // we expect something like:
  // { title, grocerySections: [ { name: "Produce", items: [...] }, ... ] }
  const sections = (input.grocerySections || input.sections || input.items || []).map((sec) => ({
    id: sec.id || uuidv4(),
    name: sec.name || sec.section || "Section",
    items: (sec.items || []).map((it) => ({
      id: it.id || uuidv4(),
      name: it.name || it.title || "Item",
      qty: it.qty ?? it.quantity ?? 1,
      unit: it.unit || "ea",
    })),
  }));

  return {
    id: input.id || uuidv4(),
    type: "storehouseStockPlan",
    title: input.title || "Imported Storehouse Stock Plan",
    sections,
    source: input.source || {},
    meta: {
      importAt: Date.now(),
      raw: input.raw || input,
      target: "storehouse",
      style: "grocery-sections",
    },
  };
}

// animals (acquisition, care, butchery, products)
function animalPlanShape(input) {
  // input could be: { animals: [...] } or { items: [...], type: "animal-butchery" }
  const animals =
    input.animals ||
    (input.items || []).map((it) => ({
      id: it.id || uuidv4(),
      name: it.name || it.title || "Animal Item",
      qty: it.qty ?? it.quantity ?? 1,
      unit: it.unit || "ea",
      // preserve intent: acquisition / care / butchery
      role: it.role || input.type || "animal",
      notes: it.notes || it.description || "",
    }));

  return {
    id: input.id || uuidv4(),
    type: "animalPlan",
    title: input.title || "Imported Animal Plan",
    animals,
    reverseFrom: input.reverseFrom || null, // for “Generate Animal Plan from Recipes”
    breedsByGeo: input.breedsByGeo || input.meatBreedsForGeo || [], // “meat animal estimates and breeds”
    source: input.source || {},
    meta: {
      importAt: Date.now(),
      raw: input.raw || input,
    },
  };
}

// inventory update (scan-compare-trust, pricebook CSV, harvest→inventory)
function inventoryUpdateShape(input) {
  return {
    id: input.id || uuidv4(),
    type: "inventoryUpdate",
    updates: input.updates || [],
    source: input.source || {},
    meta: {
      importAt: Date.now(),
      raw: input.raw || input,
    },
  };
}

// cleaning / declutter / zone routines
function cleaningSessionShape(input) {
  return {
    id: input.id || uuidv4(),
    type: "cleaningSession",
    title: input.title || "Imported Cleaning Plan",
    tasks: (input.tasks || input.items || input.zones || []).map((t) => ({
      id: t.id || uuidv4(),
      task: t.task || t.title || t.name || "Cleaning Task",
      room: t.room || t.zone || null,
      freq: t.freq || t.frequency || null,
      notes: t.notes || t.description || "",
    })),
    source: input.source || {},
    meta: {
      importAt: Date.now(),
      raw: input.raw || input,
      scheduleable: true,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* registry of normalizers                                                    */
/* -------------------------------------------------------------------------- */
const registry = {
  // recipes from: Allrecipes, Love&Lemons, TikTok, YT, FB
  recipe: {
    normalize: (raw) => recipeShape(raw),
    reverse: (norm) => ({
      kind: "recipe-export",
      title: norm.title,
      ingredients: norm.ingredients,
      steps: norm.steps,
      tags: norm.tags,
      sourceHint: norm.source?.url || "",
    }),
  },

  mealPlan: {
    normalize: (raw) => mealPlanShape(raw),
    reverse: (norm) => ({
      kind: "mealPlan-export",
      title: norm.title,
      days: norm.days,
    }),
  },

  gardenPlan: {
    normalize: (raw) => gardenPlanShape(raw),
    reverse: (norm) => ({
      kind: "gardenPlan-export",
      title: norm.title,
      seeds: norm.seeds,
      zone: norm.zone,
    }),
  },

  gardenCare: {
    normalize: (raw) => gardenCareShape(raw),
    reverse: (norm) => ({
      kind: "gardenCare-export",
      title: norm.title,
      tasks: norm.tasks,
    }),
  },

  gardenHarvest: {
    normalize: (raw) => gardenHarvestShape(raw),
    reverse: (norm) => ({
      kind: "gardenHarvest-export",
      title: norm.title,
      harvest: norm.harvest,
    }),
  },

  storehouseGoal: {
    normalize: (raw) => storehouseGoalShape(raw),
    reverse: (norm) => ({
      kind: "storehouseGoal-export",
      title: norm.title,
      items: norm.items,
    }),
  },

  // NEW: storehouse stock plan (grocery sections)
  storehouseStockPlan: {
    normalize: (raw) => storehouseStockPlanShape(raw),
    reverse: (norm) => ({
      kind: "storehouseStockPlan-export",
      title: norm.title,
      sections: norm.sections,
    }),
  },

  animalPlan: {
    normalize: (raw) => animalPlanShape(raw),
    reverse: (norm) => ({
      kind: "animalPlan-export",
      title: norm.title,
      animals: norm.animals,
      reverseFrom: norm.reverseFrom,
      breedsByGeo: norm.breedsByGeo,
    }),
  },

  inventoryUpdate: {
    normalize: (raw) => inventoryUpdateShape(raw),
    reverse: (norm) => ({
      kind: "inventoryUpdate-export",
      updates: norm.updates,
    }),
  },

  cleaningSession: {
    normalize: (raw) => cleaningSessionShape(raw),
    reverse: (norm) => ({
      kind: "cleaning-export",
      title: norm.title,
      tasks: norm.tasks,
    }),
  },
};

/* -------------------------------------------------------------------------- */
/* dynamic registration                                                       */
/* -------------------------------------------------------------------------- */
function register(type, handlers) {
  registry[type] = handlers;
}

/* -------------------------------------------------------------------------- */
/* smart guesser                                                              */
/* -------------------------------------------------------------------------- */
function guessType(raw = {}) {
  // explicit hint wins
  if (raw.__importType && registry[raw.__importType]) return raw.__importType;
  if (raw.type && registry[raw.type]) return raw.type;

  // cleaning hints
  if (
    raw.type === "cleaning-plan" ||
    raw.type === "declutter-plan" ||
    raw.type === "room-routine" ||
    raw.type === "zone-cleaning"
  ) {
    return "cleaningSession";
  }

  // garden care hints
  if (
    raw.type === "garden-care" ||
    raw.type === "garden-maintenance" ||
    raw.type === "garden-tasks" ||
    raw.type === "garden-calendar"
  ) {
    return "gardenCare";
  }

  // garden harvest hints
  if (raw.type === "garden-harvest" || raw.type === "harvest-log" || raw.type === "garden-yield") {
    return "gardenHarvest";
  }

  // meal plan-ish
  if (Array.isArray(raw.days)) return "mealPlan";

  // storehouse stock plan (grocery sections)
  if (
    raw.type === "storehouse-stock-plan" ||
    raw.type === "stock-plan" ||
    raw.kind === "storehouseStockPlan" ||
    raw.grocerySections
  ) {
    return "storehouseStockPlan";
  }

  // storehouse goals
  if (Array.isArray(raw.items) && raw.target === "storehouse") return "storehouseGoal";
  // generic “items, no updates” often still means storehouse template
  if (Array.isArray(raw.items) && !raw.updates && !raw.grocerySections) return "storehouseGoal";

  // animal / livestock / butchery
  if (
    raw.type === "animal-products" ||
    raw.type === "animal-acquisition" ||
    raw.type === "animal-care-plan" ||
    raw.type === "animal-butchery" ||
    raw.type === "livestock-processing"
  ) {
    return "animalPlan";
  }

  // garden plan-ish
  if (raw.seeds || raw.seedData || raw.growingZone || raw.zone) return "gardenPlan";

  // scan-compare-trust exports (inventory CSV) → inventoryUpdate
  if (Array.isArray(raw.updates)) return "inventoryUpdate";

  // recipe-ish
  if (Array.isArray(raw.ingredients) && (Array.isArray(raw.steps) || Array.isArray(raw.directions))) {
    return "recipe";
  }

  // fallback
  return "recipe";
}

/* -------------------------------------------------------------------------- */
/* MAIN: normalize                                                            */
/* -------------------------------------------------------------------------- */
export function normalizeImport(raw) {
  const type = guessType(raw);
  const entry = registry[type];

  if (!entry || typeof entry.normalize !== "function") {
    // eslint-disable-next-line no-console
    console.warn("[ImportNormalizer] no normalizer for type:", type, "raw:", raw);
    const fallback = recipeShape({ ...raw, title: raw.title || "Imported Item (fallback)" });

    emit("import.normalized", { normalized: fallback, raw, type: "recipe" });
    return fallback;
  }

  const normalized = entry.normalize(raw);

  // tell UI / other pages
  emit("import.normalized", { normalized, raw, type });

  // auto-schedule if payload said so
  if (raw.schedule || raw.session) {
    emit("automation.schedule.request", {
      source: "import",
      normalized,
      schedule: raw.schedule || null,
      session: raw.session || null,
    });
  }

  // user wanted it as favorite immediately
  if (raw.saveAsFavorite) {
    addFavorite(normalized);
    emit("import.favorite.saved", { normalized });
  }

  return normalized;
}

/* -------------------------------------------------------------------------- */
/* REVERSE: normalized → shareable/import-like                                */
/* -------------------------------------------------------------------------- */
export function reverseGenerate(normalized) {
  if (!normalized || typeof normalized !== "object") {
    return { kind: "unknown", payload: normalized };
  }

  const entry = registry[normalized.type];
  if (!entry || typeof entry.reverse !== "function") {
    const generic = {
      kind: "generic-export",
      title: normalized.title || normalized.name || "Exported Item",
      payload: normalized,
    };
    emit("import.reverse.generated", { normalized, reversed: generic });
    return generic;
  }

  const reversed = entry.reverse(normalized);
  emit("import.reverse.generated", { normalized, reversed });
  return reversed;
}

/* -------------------------------------------------------------------------- */
/* EXPLICIT FAVORITE SAVE                                                     */
/* -------------------------------------------------------------------------- */
export function saveFavorite(normalized) {
  const favs = addFavorite(normalized);
  emit("import.favorite.saved", { normalized, favorites: favs });
  return favs;
}

/* -------------------------------------------------------------------------- */
/* GET FAVORITES                                                              */
/* -------------------------------------------------------------------------- */
export function getFavorites() {
  return loadFavorites();
}

/* -------------------------------------------------------------------------- */
/* EXPORT REGISTRY API                                                        */
/* -------------------------------------------------------------------------- */
export const ImportNormalizer = {
  normalize: normalizeImport,
  reverse: reverseGenerate,
  saveFavorite,
  getFavorites,
  register,
  guessType,
};
