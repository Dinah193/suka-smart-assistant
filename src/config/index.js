// C:\Users\larho\suka-smart-assistant\src\config\index.js
// Central config accessor; merges env + feature flags + domain defaults
// ---------------------------------------------------------------------
// WHY THIS FILE EXISTS
// - SSA is SSA-first: it must run even if the Hub is offline.
// - We have two sources of truth:
//      1) env (Vite env + src/config/env.js fallback)
//      2) featureFlags.json (structured, rule-based, per-domain)
// - This file pulls them together and gives the rest of the app ONE place to read from.
//
// HOW IT FITS THE PIPELINE
// imports → intelligence → automation → (optional) hub export
// - imports: need to know what sources are allowed (bookmarklet, csv, garden, cleaning…)
// - intelligence: needs to know which domains are enabled, and if “import-all-domains” is on
// - automation: needs sabbath + quietHours + runtime hints + event bus channel
// - hub export: needs to know if familyFundMode=true BEFORE trying to format/send
//
// ASSUMPTIONS
// - featureFlags.json already has the big structure we built earlier.
// - src/config/env.js exists and can return plain JS env if import.meta.env is missing.
//
// USAGE (two styles)
//   1) Full config:
//      import config from "../config/index.js";
//      const cfg = config.getConfig({ tier: "hub", role: "admin" });
//   2) Tiny bridge for code that only needs booleans (e.g., HubPacketFormatter):
//      import { featureFlags } from "../config/index.js";
//      if (featureFlags.familyFundMode) { … }

import rawFlags from "./featureFlags.json";
import envModule from "./env.js";

// ---------------------------------------------------------------------
// tiny helpers
// ---------------------------------------------------------------------
const hasStructuredClone =
  typeof structuredClone === "function" ||
  (typeof globalThis !== "undefined" && typeof globalThis.structuredClone === "function");

const toBool = (v) => {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.toLowerCase() === "true";
  return false;
};

function safeClone(obj) {
  if (!obj) return {};
  if (hasStructuredClone) {
    return (globalThis.structuredClone || structuredClone)(obj);
  }
  return JSON.parse(JSON.stringify(obj));
}

function readViteEnv() {
  // prefer Vite env (client/runtime build)
  if (typeof import.meta !== "undefined" && import.meta.env) {
    return import.meta.env;
  }
  // fallback to our env.js (SSR/tests/node)
  return envModule || {};
}

function deepAssign(target, source) {
  if (!source) return target;
  for (const key of Object.keys(source)) {
    const sv = source[key];
    if (sv && typeof sv === "object" && !Array.isArray(sv)) {
      if (!target[key] || typeof target[key] !== "object") {
        target[key] = {};
      }
      deepAssign(target[key], sv);
    } else {
      target[key] = sv;
    }
  }
  return target;
}

// Merge defaults with environment overlay from featureFlags.json
function withEnvOverlay(flags, mode) {
  const clone = safeClone(flags);
  const envOverlay = clone?.environments?.[mode];
  if (envOverlay && clone.defaults) {
    deepAssign(clone.defaults, envOverlay);
  }
  return clone;
}

// ---------------------------------------------------------------------
// rules engine: apply featureFlags.json "rules" for a given context
// supports: { "context.tier": "hub" }, { "context.role": { "$in": [...] } }, { "$ne": ... }
// ---------------------------------------------------------------------
function matchCondition(cond, ctx) {
  const entries = Object.entries(cond);
  for (const [key, expected] of entries) {
    const path = key.split(".");
    // we expect "context.something"
    let current = ctx;
    for (let i = 1; i < path.length; i++) {
      current = current?.[path[i]];
    }

    if (expected && typeof expected === "object") {
      if ("$in" in expected) {
        if (!expected.$in.includes(current)) return false;
      } else if ("$ne" in expected) {
        if (current === expected.$ne) return false;
      } else {
        // unknown operator → ignore
      }
    } else {
      if (current !== expected) return false;
    }
  }
  return true;
}

function applyRules(base, ctx = {}) {
  const clone = safeClone(base);
  const rules = Array.isArray(base.rules) ? base.rules : [];
  for (const rule of rules) {
    const cond = rule.if || {};
    const matches = matchCondition(cond, ctx);
    if (matches && rule.set) {
      deepAssign(clone.defaults, rule.set);
    }
  }
  return clone;
}

// ---------------------------------------------------------------------
// domain builders (env hints → domain config, with fallback to flags)
// ---------------------------------------------------------------------
function buildCleaning(env, flags) {
  const ff = flags?.cleaning || {};
  return {
    enabled: toBool(env.VITE_FEATURE_ENABLE_CLEANING ?? ff.enabled),
    engines: {
      cleaningSessionEngine: !!ff.engines?.cleaningSessionEngine,
      declutterEngine: !!ff.engines?.declutterEngine,
      zoneRoutineEngine: !!ff.engines?.zoneRoutineEngine
    },
    imports: {
      fromPinterest: toBool(env.VITE_CLEANING_IMPORT_FROM_PINTEREST ?? ff.imports?.fromPinterest),
      fromCSV: toBool(env.VITE_CLEANING_IMPORT_FROM_CSV ?? ff.imports?.fromCSV),
      fromVideo: toBool(env.VITE_CLEANING_IMPORT_FROM_VIDEO ?? ff.imports?.fromVideo ?? false)
    },
    ui: {
      showDashboardWidget: toBool(env.VITE_CLEANING_UI_SHOW_DASHBOARD_WIDGET ?? ff.ui?.showDashboardWidget),
      showSessionPlanner: toBool(env.VITE_CLEANING_UI_SHOW_SESSION_PLANNER ?? ff.ui?.showSessionPlanner),
      showTemplates: toBool(ff.ui?.showTemplates)
    },
    allowUserFavorites: toBool(env.VITE_CLEANING_ALLOW_USER_FAVORITES ?? ff.allowUserFavorites),
    allowUserSchedules: toBool(env.VITE_CLEANING_ALLOW_USER_SCHEDULES ?? ff.allowUserSchedules),
    sabbathAware: toBool(env.VITE_CLEANING_SABBATH_AWARE ?? ff.sabbathAware),
    quietHoursAware: toBool(env.VITE_CLEANING_QUIET_HOURS_AWARE ?? ff.quietHoursAware)
  };
}

function buildGarden(env, flags) {
  const ff = flags?.garden || {};
  return {
    enabled: toBool(env.VITE_FEATURE_ENABLE_GARDEN ?? ff.enabled),
    engines: {
      gardenPlanEngine: !!ff.engines?.gardenPlanEngine,
      gardenQueueEngine: !!ff.engines?.gardenQueueEngine,
      careAndHarvestEngine: !!ff.engines?.careAndHarvestEngine
    },
    imports: {
      fromSeedSites: toBool(env.VITE_GARDEN_IMPORT_FROM_SEED_SITES ?? ff.imports?.fromSeedSites),
      fromBookmarklet: toBool(env.VITE_GARDEN_IMPORT_FROM_BOOKMARKLET ?? ff.imports?.fromBookmarklet),
      fromCSV: toBool(env.VITE_GARDEN_IMPORT_FROM_CSV ?? ff.imports?.fromCSV),
      fromVideo: toBool(env.VITE_GARDEN_IMPORT_FROM_VIDEO ?? ff.imports?.fromVideo ?? false)
    },
    ui: {
      showDashboardWidget: toBool(env.VITE_GARDEN_UI_SHOW_DASHBOARD_WIDGET ?? ff.ui?.showDashboardWidget),
      showSeasonalView: toBool(env.VITE_GARDEN_UI_SHOW_SEASONAL_VIEW ?? ff.ui?.showSeasonalView),
      showCareAndHarvestTabs: toBool(env.VITE_GARDEN_UI_SHOW_CARE_HARVEST_TABS ?? ff.ui?.showCareAndHarvestTabs)
    },
    allowUserFavorites: toBool(env.VITE_GARDEN_ALLOW_USER_FAVORITES ?? ff.allowUserFavorites),
    allowUserSchedules: toBool(env.VITE_GARDEN_ALLOW_USER_SCHEDULES ?? ff.allowUserSchedules),
    collab: {
      enabled: toBool(env.VITE_GARDEN_COLLAB_ENABLED ?? ff.collab?.enabled),
      coOpPlanning: toBool(env.VITE_GARDEN_COOP_PLANNING_ENABLED ?? ff.collab?.coOpPlanning),
      shareablePlans: toBool(ff.collab?.shareablePlans)
    },
    sabbathAware: true,
    quietHoursAware: true
  };
}

function buildStorehouse(env, flags) {
  const ff = flags?.storehouse || {};
  return {
    enabled: toBool(env.VITE_FEATURE_ENABLE_STOREHOUSE ?? ff.enabled),
    engines: {
      storehouseGoalEngine: !!ff.engines?.storehouseGoalEngine,
      storehouseStockPlanner: !!ff.engines?.storehouseStockPlanner
    },
    imports: {
      fromGrocerySections: toBool(env.VITE_STOREHOUSE_IMPORT_FROM_GROCERY_SECTIONS ?? ff.imports?.fromGrocerySections),
      fromShoppingLists: toBool(env.VITE_STOREHOUSE_IMPORT_FROM_SHOPPING_LISTS ?? ff.imports?.fromShoppingLists),
      fromMealPlans: toBool(env.VITE_STOREHOUSE_IMPORT_FROM_MEAL_PLANS ?? ff.imports?.fromMealPlans)
    },
    ui: {
      showGrocerySectionInspiration: toBool(env.VITE_STOREHOUSE_UI_SHOW_GROCERY_SECTION_INSPO ?? ff.ui?.showGrocerySectionInspiration),
      showPantryTargets: toBool(env.VITE_STOREHOUSE_UI_SHOW_PANTRY_TARGETS ?? ff.ui?.showPantryTargets),
      showRotationNeeds: toBool(env.VITE_STOREHOUSE_UI_SHOW_ROTATION_NEEDS ?? ff.ui?.showRotationNeeds)
    },
    allowUserFavorites: toBool(env.VITE_STOREHOUSE_ALLOW_USER_FAVORITES ?? ff.allowUserFavorites),
    allowUserSchedules: toBool(env.VITE_STOREHOUSE_ALLOW_USER_SCHEDULES ?? ff.allowUserSchedules),
    coOp: {
      enabled: toBool(env.VITE_STOREHOUSE_COOP_ENABLED ?? ff.coOp?.enabled),
      linkedHouseholds: toBool(ff.coOp?.linkedHouseholds),
      bulkBuyEvents: toBool(env.VITE_STOREHOUSE_BULK_BUY_EVENTS_ENABLED ?? ff.coOp?.bulkBuyEvents)
    },
    reverseGeneration: {
      toGarden: toBool(ff.reverseGeneration?.toGarden ?? false),
      toAnimals: toBool(ff.reverseGeneration?.toAnimals ?? false)
    }
  };
}

function buildMeals(env, flags) {
  const ff = flags?.meals || {};
  return {
    enabled: toBool(env.VITE_FEATURE_ENABLE_MEALS ?? ff.enabled),
    engines: {
      mealPlanEngine: !!ff.engines?.mealPlanEngine,
      cookingSessionEngine: !!ff.engines?.cookingSessionEngine
    },
    imports: {
      fromAllrecipes: toBool(env.VITE_MEALS_IMPORT_FROM_ALLRECIPES ?? ff.imports?.fromAllrecipes),
      fromLoveAndLemons: toBool(env.VITE_MEALS_IMPORT_FROM_LOVEANDLEMONS ?? ff.imports?.fromLoveAndLemons),
      fromTikTok: toBool(env.VITE_MEALS_IMPORT_FROM_TIKTOK ?? ff.imports?.fromTikTok),
      fromYouTube: toBool(env.VITE_MEALS_IMPORT_FROM_YOUTUBE ?? ff.imports?.fromYouTube),
      fromFacebook: toBool(env.VITE_MEALS_IMPORT_FROM_FACEBOOK ?? ff.imports?.fromFacebook),
      fromPinterestBoards: toBool(env.VITE_MEALS_IMPORT_FROM_PINTEREST_BOARDS ?? ff.imports?.fromPinterestBoards)
    },
    ui: {
      showRecipeConsolidator: toBool(env.VITE_MEALS_UI_SHOW_RECIPE_CONSOLIDATOR ?? ff.ui?.showRecipeConsolidator),
      showMealPlanner: toBool(env.VITE_MEALS_UI_SHOW_MEAL_PLANNER ?? ff.ui?.showMealPlanner),
      showBatchCookingAccordion: toBool(env.VITE_MEALS_UI_SHOW_BATCH_COOKING ?? ff.ui?.showBatchCookingAccordion)
    },
    allowUserFavorites: toBool(env.VITE_MEALS_ALLOW_USER_FAVORITES ?? ff.allowUserFavorites),
    allowUserSchedules: toBool(env.VITE_MEALS_ALLOW_USER_SCHEDULES ?? ff.allowUserSchedules),
    reverseGeneration: {
      toAnimalPlanner: toBool(env.VITE_MEALS_REVERSE_TO_ANIMAL_PLANNER ?? ff.reverseGeneration?.toAnimalPlanner),
      toStorehouse: toBool(env.VITE_MEALS_REVERSE_TO_STOREHOUSE ?? ff.reverseGeneration?.toStorehouse),
      toShoppingList: toBool(env.VITE_MEALS_REVERSE_TO_SHOPPING_LIST ?? ff.reverseGeneration?.toShoppingList),
      toPreservation: toBool(env.VITE_MEALS_REVERSE_TO_PRESERVATION ?? ff.reverseGeneration?.toPreservation ?? false)
    }
  };
}

function buildAnimals(env, flags) {
  const ff = flags?.animals || {};
  return {
    enabled: toBool(env.VITE_FEATURE_ENABLE_ANIMALS ?? ff.enabled),
    engines: {
      animalPlannerEngine: !!ff.engines?.animalPlannerEngine,
      animalCareEngine: !!ff.engines?.animalCareEngine,
      butcherySessionEngine: !!ff.engines?.butcherySessionEngine
    },
    imports: {
      fromRecipesReverse: toBool(env.VITE_ANIMALS_IMPORT_FROM_RECIPES_REVERSE ?? ff.imports?.fromRecipesReverse),
      fromBreedLibraries: toBool(env.VITE_ANIMALS_IMPORT_FROM_BREED_LIBRARIES ?? ff.imports?.fromBreedLibraries),
      fromLocalMarkets: toBool(env.VITE_ANIMALS_IMPORT_FROM_LOCAL_MARKETS ?? ff.imports?.fromLocalMarkets),
      fromVideo: toBool(env.VITE_ANIMALS_IMPORT_FROM_VIDEO ?? ff.imports?.fromVideo ?? false)
    },
    ui: {
      showDashboardWidget: toBool(env.VITE_ANIMALS_UI_SHOW_DASHBOARD_WIDGET ?? ff.ui?.showDashboardWidget),
      showBreedSuggestions: toBool(env.VITE_ANIMALS_UI_SHOW_BREED_SUGGESTIONS ?? ff.ui?.showBreedSuggestions),
      showAcquisitionPlanner: toBool(env.VITE_ANIMALS_UI_SHOW_ACQUISITION_PLANNER ?? ff.ui?.showAcquisitionPlanner),
      showButcheryLog: toBool(env.VITE_ANIMALS_UI_SHOW_BUTCHERY_LOG ?? ff.ui?.showButcheryLog)
    },
    allowUserFavorites: toBool(env.VITE_ANIMALS_ALLOW_USER_FAVORITES ?? ff.allowUserFavorites),
    allowUserSchedules: toBool(env.VITE_ANIMALS_ALLOW_USER_SCHEDULES ?? ff.allowUserSchedules),
    reverseDirection: {
      generateAnimalPlanFromRecipes: toBool(env.VITE_ANIMALS_REVERSE_GENERATE_FROM_RECIPES ?? ff.reverseDirection?.generateAnimalPlanFromRecipes)
    },
    geoAwareBreeds: {
      enabled: toBool(env.VITE_ANIMALS_GEO_AWARE_BREEDS_ENABLED ?? ff.geoAwareBreeds?.enabled),
      defaultSource: env.VITE_ANIMALS_GEO_DEFAULT_SOURCE || ff.geoAwareBreeds?.defaultSource || "general-hardy-breeds",
      fallback: ff.geoAwareBreeds?.fallback || "general-hardy-breeds"
    }
  };
}

function buildPreservation(env, flags) {
  const ff = flags?.preservation || {};
  return {
    enabled: toBool(env.VITE_FEATURE_ENABLE_PRESERVATION ?? ff.enabled),
    engines: {
      preservationPlannerEngine: !!ff.engines?.preservationPlannerEngine,
      preservationSessionEngine: !!ff.engines?.preservationSessionEngine
    },
    imports: {
      fromMealPlans: toBool(env.VITE_PRESERVATION_IMPORT_FROM_MEAL_PLANS ?? ff.imports?.fromMealPlans),
      fromStorehouseRotation: toBool(env.VITE_PRESERVATION_IMPORT_FROM_STOREHOUSE_ROTATION ?? ff.imports?.fromStorehouseRotation),
      fromGardenHarvests: toBool(env.VITE_PRESERVATION_IMPORT_FROM_GARDEN_HARVESTS ?? ff.imports?.fromGardenHarvests),
      fromVideo: toBool(env.VITE_PRESERVATION_IMPORT_FROM_VIDEO ?? ff.imports?.fromVideo ?? false)
    },
    ui: {
      showDashboardWidget: toBool(env.VITE_PRESERVATION_UI_SHOW_DASHBOARD_WIDGET ?? ff.ui?.showDashboardWidget),
      showMethodsTabs: toBool(env.VITE_PRESERVATION_UI_SHOW_METHODS_TABS ?? ff.ui?.showMethodsTabs),
      showBatchSessions: toBool(env.VITE_PRESERVATION_UI_SHOW_BATCH_SESSIONS ?? ff.ui?.showBatchSessions)
    },
    allowUserFavorites: toBool(env.VITE_PRESERVATION_ALLOW_USER_FAVORITES ?? ff.allowUserFavorites),
    allowUserSchedules: toBool(env.VITE_PRESERVATION_ALLOW_USER_SCHEDULES ?? ff.allowUserSchedules),
    reverseGeneration: {
      toStorehouse: toBool(env.VITE_PRESERVATION_REVERSE_TO_STOREHOUSE ?? ff.reverseGeneration?.toStorehouse),
      toMeals: toBool(env.VITE_PRESERVATION_REVERSE_TO_MEALS ?? ff.reverseGeneration?.toMeals)
    }
  };
}

function buildImport(env, flags) {
  const ff = flags?.import || {};
  return {
    enabled: toBool(env.VITE_IMPORT_ENABLED ?? ff.enabled),
    sources: {
      bookmarklet: toBool(env.VITE_IMPORT_SOURCE_BOOKMARKLET ?? ff.sources?.bookmarklet),
      fileUpload: toBool(env.VITE_IMPORT_SOURCE_FILE_UPLOAD ?? ff.sources?.fileUpload),
      linkedAccounts: toBool(env.VITE_IMPORT_SOURCE_LINKED_ACCOUNTS ?? ff.sources?.linkedAccounts),
      scanCompareTrust: toBool(env.VITE_IMPORT_SOURCE_SCAN_COMPARE_TRUST ?? ff.sources?.scanCompareTrust),
      pinterestToPlanner: toBool(env.VITE_IMPORT_SOURCE_PINTEREST_TO_PLANNER ?? ff.sources?.pinterestToPlanner),
      gardenSeedPlan: toBool(env.VITE_IMPORT_SOURCE_GARDEN_SEED_PLAN ?? ff.sources?.gardenSeedPlan),
      cleaningPlan: toBool(env.VITE_IMPORT_SOURCE_CLEANING_PLAN ?? ff.sources?.cleaningPlan),
      storehouseStock: toBool(env.VITE_IMPORT_SOURCE_STOREHOUSE_STOCK ?? ff.sources?.storehouseStock),
      animalPlanReverse: toBool(env.VITE_IMPORT_SOURCE_ANIMAL_PLAN_REVERSE ?? ff.sources?.animalPlanReverse),
      preservationPlan: toBool(env.VITE_IMPORT_SOURCE_PRESERVATION_PLAN ?? ff.sources?.preservationPlan ?? false),
      videoHowTo: toBool(env.VITE_IMPORT_SOURCE_VIDEO_HOWTO ?? ff.sources?.videoHowTo ?? false)
    },
    ui: {
      showImportLanding: !!ff.ui?.showImportLanding,
      showImportPreview: !!ff.ui?.showImportPreview,
      showImportSettings: !!ff.ui?.showImportSettings
    },
    sessions: {
      allowUserFavorites: toBool(env.VITE_IMPORT_ALLOW_USER_FAVORITES ?? ff.sessions?.allowUserFavorites),
      allowUserSchedules: toBool(env.VITE_IMPORT_ALLOW_USER_SCHEDULES ?? ff.sessions?.allowUserSchedules)
    },
    sharedBus: toBool(env.VITE_IMPORT_SHARED_BUS_ENABLED ?? true),
    domChannel: env.VITE_IMPORT_DOM_CHANNEL || "window.__suka?.eventBus"
  };
}

// ---------------------------------------------------------------------
// main accessor
// ---------------------------------------------------------------------
export function getConfig(context = {}) {
  const viteEnv = readViteEnv();
  const MODE =
    (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.MODE) ||
    viteEnv.MODE ||
    process.env.NODE_ENV ||
    "development";

  // 1) Apply environment overlay from featureFlags.json (environments[MODE])
  const flagsWithEnv = withEnvOverlay(rawFlags, MODE);

  // 2) Apply rule engine with provided context (tier/role/deviceProfile)
  const flagged = applyRules(flagsWithEnv, {
    context: {
      tier: context.tier || viteEnv.VITE_APP_TIER || "ssa",
      role: context.role || "user",
      deviceProfile: context.deviceProfile || "browser"
    }
  });

  const d = flagged.defaults || {};

  // high-level toggles (env can override JSON)
  const toggles = {
    "import-all-domains": toBool(viteEnv.VITE_TOGGLE_IMPORT_ALL_DOMAINS ?? d.toggles?.["import-all-domains"] ?? true),
    familyFundMode: toBool(viteEnv.VITE_TOGGLE_FAMILY_FUND_MODE ?? d.toggles?.familyFundMode ?? d.familyFundMode ?? false),
    analytics: toBool(viteEnv.VITE_TOGGLE_ANALYTICS ?? d.toggles?.analytics ?? true),
    commerce: toBool(viteEnv.VITE_TOGGLE_COMMERCE ?? d.toggles?.commerce ?? false),
    verboseEvents: toBool(viteEnv.VITE_VERBOSE_EVENTS ?? d.toggles?.verboseEvents ?? d.verboseEvents ?? false)
  };

  // global user ownership
  const allowUserFavorites = toBool(viteEnv.VITE_ALLOW_USER_FAVORITES ?? d.allowUserFavorites);
  const allowUserSchedules = toBool(viteEnv.VITE_ALLOW_USER_SCHEDULES ?? d.allowUserSchedules);

  // runtime / orchestration
  const runtimeHints = {
    events: Array.isArray(d.runtimeHints?.events) ? d.runtimeHints.events : [],
    domains: Array.isArray(d.runtimeHints?.domains) ? d.runtimeHints.domains : [],
    sharedBus: d.runtimeHints?.sharedBus ?? true,
    domChannel: d.runtimeHints?.domChannel || "window.__suka?.eventBus",
    payloadShape: d.runtimeHints?.payloadShape || {
      type: "string",
      ts: "ISO-8601",
      source: "string",
      data: "object"
    }
  };

  // guards
  const sabbathGuard = {
    enabled: toBool(viteEnv.VITE_SABBATH_GUARD_ENABLED ?? d.sabbathGuard?.enabled),
    startHint: viteEnv.VITE_SABBATH_GUARD_START_HINT || d.sabbathGuard?.startHint || "Fri 18:00",
    endHint: viteEnv.VITE_SABBATH_GUARD_END_HINT || d.sabbathGuard?.endHint || "Sat 21:00"
  };
  const quietHours = [
    Number(viteEnv.VITE_QUIET_HOURS_START ?? d.quietHours?.[0] ?? 22),
    Number(viteEnv.VITE_QUIET_HOURS_END ?? d.quietHours?.[1] ?? 7)
  ];

  // build domain views
  const cleaning = buildCleaning(viteEnv, d);
  const garden = buildGarden(viteEnv, d);
  const storehouse = buildStorehouse(viteEnv, d);
  const meals = buildMeals(viteEnv, d);
  const animals = buildAnimals(viteEnv, d);
  const preservation = buildPreservation(viteEnv, d);
  const imports = buildImport(viteEnv, d);

  // hub / export info (SSA must still run if blank)
  const hub = {
    enabled: toggles.familyFundMode || d.familyFundMode || false,
    apiBase: viteEnv.VITE_HUB_API_BASE || "",
    token: viteEnv.VITE_HUB_API_TOKEN || "",
    queueIfOffline: toBool(viteEnv.VITE_HUB_QUEUE_IF_OFFLINE ?? d.hubExport?.queueIfOffline ?? true),
    formatPackets: toBool(viteEnv.VITE_HUB_FORMAT_PACKETS ?? d.hubExport?.enabled ?? true)
  };

  return {
    mode: MODE,
    env: viteEnv,
    flags: flagged,
    toggles,
    // for convenience in places that want the booleans right here
    familyFundMode: !!toggles.familyFundMode,
    verboseEvents: !!toggles.verboseEvents,
    allowUserFavorites,
    allowUserSchedules,
    sabbathGuard,
    quietHours,
    runtimeHints,
    hub,
    domains: {
      cleaning,
      garden,
      storehouse,
      meals,
      animals,
      preservation,
      import: imports
    },
    gating: d.gating || {},
    rollouts: d.rollouts || {},
    /**
     * UI/helper guard
     * can("meals", "showMealPlanner") → bool
     */
    can(domain, feature) {
      const dom = this.domains?.[domain];
      if (!dom) return false;
      if (feature in dom) return !!dom[feature];
      if (dom.ui && feature in dom.ui) return !!dom.ui[feature];
      return false;
    },
    /**
     * getToggle("import-all-domains") → boolean
     * getToggle("commerce") → boolean
     */
    getToggle(name, fallback = false) {
      if (!this.toggles) return fallback;
      if (typeof this.toggles[name] === "undefined") return fallback;
      return !!this.toggles[name];
    }
  };
}

// ---------------------------------------------------------------------
// Tiny bridge export — for modules that only need booleans.
// This matches the "bridge" behavior discussed earlier.
// ---------------------------------------------------------------------
function computeFeatureFlags() {
  const cfg = getConfig(); // default context; env overlays + rules already applied
  return {
    familyFundMode: !!cfg.familyFundMode,
    verboseEvents: !!cfg.verboseEvents,
    mode: cfg.mode,
    raw: rawFlags,       // original JSON
    resolved: cfg.flags  // flags after overlays + rules
  };
}

// Named export for convenience in small consumers (e.g., HubPacketFormatter)
export const featureFlags = computeFeatureFlags();

// default export for full access
export default {
  getConfig
};
