// C:\Users\larho\suka-smart-assistant\src\features\import\ImportService.js
// High-level import orchestrator / router
// -----------------------------------------------------------------------------
// Sits *above* ImportNormalizer.js and handles:
//  - where the payload came from (bookmarklet, file upload, linked account,
//    scan-compare-trust CSV/PDF, Pinterest → Planner, Garden/Seed, Cleaning,
//    Storehouse, Animal Planner reverse, etc.)
//  - how it should be dispatched (to automation runtime, to engines, to UI)
//  - user-owned favorites + schedules
//  - reverse generation (export/share to other households / community / co-op)
//  - shared orchestration bus integration (window.__suka?.eventBus + DOM)
//  - ANALYTICS (importAnalyticsService) so your dashboards can show “what’s
//    getting imported across meals / cleaning / garden / storehouse / animals”
//
// UPDATED to support:
//  - cleaning-plan / declutter / zone routines
//  - garden-plan (seeds, zone, co-op)
//  - garden-care / maintenance tasks
//  - garden-harvest / yield logs
//  - STOREHOUSE STOCK PLANNING (grocery sections for inspiration)
//  - meal planning
//  - animal acquisition / care / butchery
//  - broadcast to domain dashboards so “these updates must be editable on the
//    other pages as well.”
//  - user-owned favorites AND user-owned schedules (not just system ones)
//  - reverse generation events forwarded to analytics
// -----------------------------------------------------------------------------

import { ImportNormalizer } from "./ImportNormalizer";

const isBrowser = typeof window !== "undefined";

// in-memory + local storage for “recent imports”
const RECENTS_KEY = "suka.import.recents.v1";
const MAX_RECENTS = 25;

/* -------------------------------------------------------------------------- */
/* lazy analytics loader (defensive)                                          */
/* -------------------------------------------------------------------------- */
let importAnalyticsPromise = null;
async function getImportAnalytics() {
  if (!importAnalyticsPromise) {
    // keep it optional so SSR / test / older builds don’t break
    importAnalyticsPromise = (async () => {
      try {
        const mod = await import("@/services/importAnalyticsService");
        return mod.default || mod;
      } catch (err) {
        console.warn("[ImportService] analytics not available:", err?.message || err);
        return null;
      }
    })();
  }
  return importAnalyticsPromise;
}

/* -------------------------------------------------------------------------- */
/* tiny storage helpers                                                       */
/* -------------------------------------------------------------------------- */
function loadRecents() {
  if (!isBrowser) return [];
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveRecents(list) {
  if (!isBrowser) return;
  try {
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(list));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[ImportService] failed to save recents:", err);
  }
}

function addRecent(entry) {
  const recents = loadRecents();
  const next = [entry, ...recents].slice(0, MAX_RECENTS);
  saveRecents(next);
  return next;
}

/* -------------------------------------------------------------------------- */
/* unified emitter (DOM + bus)                                                */
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
    console.warn("[ImportService] bus emit failed:", err);
  }
}

/* -------------------------------------------------------------------------- */
/* source registry                                                            */
/* -------------------------------------------------------------------------- */
const sourceHandlers = Object.create(null);

/**
 * Register a new source handler.
 * @param {string} sourceType e.g. "bookmarklet", "pinterest", "allrecipes", "scan-compare-trust"
 * @param {(payload:any, opts?:object) => Promise<any>|any} handler
 */
function registerSource(sourceType, handler) {
  sourceHandlers[sourceType] = handler;
}

/* -------------------------------------------------------------------------- */
/* helper: map normalized.type to analytics domain                            */
/* -------------------------------------------------------------------------- */
function domainFromNormalized(normalized) {
  const t = normalized?.type || normalized?.kind;
  switch (t) {
    case "recipe":
    case "recipes":
    case "mealPlan":
    case "meal-plan":
      return "meals";
    case "cleaningSession":
    case "cleaning":
      return "cleaning";
    case "gardenPlan":
    case "garden":
    case "gardenCare":
    case "garden-care":
    case "gardenHarvest":
    case "garden-harvest":
      return "garden";
    case "storehouseGoal":
    case "storehouseStockPlan":
    case "storehouse-stock-plan":
      return "storehouse";
    case "animalPlan":
    case "animal-plan":
    case "animals":
      return "animals";
    case "inventoryUpdate":
    case "inventory":
      // inventories often roll up to storehouse in your system
      return "storehouse";
    default:
      return "unknown";
  }
}

/* -------------------------------------------------------------------------- */
/* DEFAULT / BUILT-IN SOURCE HANDLERS                                         */
/* -------------------------------------------------------------------------- */

// 1. bookmarklet (browser)
registerSource("bookmarklet", async (payload, opts = {}) => {
  const normalized = ImportNormalizer.normalize({
    ...payload,
    source: {
      kind: "bookmarklet",
      url: payload.url || opts.url || "",
      title: payload.pageTitle || "",
    },
  });

  addRecent({
    id: normalized.id,
    type: normalized.type,
    title: normalized.title,
    source: "bookmarklet",
    at: Date.now(),
  });

  return normalized;
});

// 2. file upload (CSV, JSON, PDF parsed text, etc.)
registerSource("file", async (payload, opts = {}) => {
  const normalized = ImportNormalizer.normalize({
    ...payload,
    source: {
      kind: "file",
      filename: opts.filename || payload.filename || "",
      mime: opts.mime || payload.mime || "",
    },
  });

  addRecent({
    id: normalized.id,
    type: normalized.type,
    title: normalized.title,
    source: "file",
    at: Date.now(),
  });

  return normalized;
});

// 3. scan-compare-trust → inventory / pricebook
registerSource("scan-compare-trust", async (payload, opts = {}) => {
  const normalized = ImportNormalizer.normalize({
    ...payload,
    __importType: payload.__importType || "inventoryUpdate",
    source: {
      kind: "scan-compare-trust",
      store: payload.store || opts.store || "",
      circularDate: payload.circularDate || opts.circularDate || "",
    },
  });

  // inventory/pricebook refresh automation
  emit("automation.schedule.request", {
    source: "import:scan-compare-trust",
    normalized,
    schedule: null,
    session: {
      domain: "pricing",
      action: "pricebook-recalc",
      payload: normalized,
    },
  });

  addRecent({
    id: normalized.id,
    type: normalized.type,
    title: normalized.title,
    source: "scan-compare-trust",
    at: Date.now(),
  });

  return normalized;
});

// 4. pinterest → meal/garden/cleaning/garden-care/garden-harvest/storehouse
registerSource("pinterest", async (payload, opts = {}) => {
  // detect board intent
  const pins = payload.pins || payload.items || [];
  const detectedGardenCare = pins.some((p) =>
    /water|weed|fertiliz|pest|garden care|mulch|trellis|prune/i.test(p?.title || "")
  );
  const detectedHarvest = pins.some((p) =>
    /harvest|pick|preserv|canning|freeze|dehydrat/i.test(p?.title || "")
  );
  const detectedStorehouse = pins.some((p) =>
    /pantry|storehouse|stock up|prepper|grocery|food storage/i.test(p?.title || "")
  );

  let detectedType =
    payload.detectedType ||
    payload.__importType ||
    (detectedStorehouse
      ? "storehouseStockPlan"
      : detectedGardenCare
        ? "gardenCare"
        : detectedHarvest
          ? "gardenHarvest"
          : "mealPlan");

  const normalized = ImportNormalizer.normalize({
    ...payload,
    __importType: detectedType,
    source: {
      kind: "pinterest",
      boardTitle: payload.boardTitle || "",
      boardUrl: payload.boardUrl || "",
    },
  });

  addRecent({
    id: normalized.id,
    type: normalized.type,
    title: normalized.title,
    source: "pinterest",
    at: Date.now(),
  });

  return normalized;
});

// 5. social-recipe (YT/TikTok/FB)
registerSource("social-recipe", async (payload, opts = {}) => {
  const normalized = ImportNormalizer.normalize({
    ...payload,
    __importType: "recipe",
    source: {
      kind: "social-recipe",
      platform: opts.platform || payload.platform || "",
      url: payload.url || "",
    },
  });

  addRecent({
    id: normalized.id,
    type: normalized.type,
    title: normalized.title,
    source: "social-recipe",
    at: Date.now(),
  });

  return normalized;
});

// 6. garden plan (explicit)
registerSource("garden-plan", async (payload, opts = {}) => {
  const normalized = ImportNormalizer.normalize({
    ...payload,
    __importType: "gardenPlan",
    source: {
      kind: "garden-plan",
      device: opts.device || "web",
    },
  });

  addRecent({
    id: normalized.id,
    type: normalized.type,
    title: normalized.title,
    source: "garden-plan",
    at: Date.now(),
  });

  return normalized;
});

// 7. garden care / maintenance (explicit)
registerSource("garden-care", async (payload, opts = {}) => {
  const normalized = ImportNormalizer.normalize({
    ...payload,
    __importType: "gardenCare",
    source: {
      kind: "garden-care",
      device: opts.device || "web",
    },
  });

  addRecent({
    id: normalized.id,
    type: normalized.type,
    title: normalized.title,
    source: "garden-care",
    at: Date.now(),
  });

  // scheduleable by default if user sent a rule
  if (opts.schedule || payload.schedule) {
    emit("automation.schedule.request", {
      source: "import:garden-care",
      normalized,
      schedule: opts.schedule || payload.schedule || null,
      session: null,
    });
  }

  return normalized;
});

// 8. garden harvest / yield (explicit)
registerSource("garden-harvest", async (payload, opts = {}) => {
  const normalized = ImportNormalizer.normalize({
    ...payload,
    __importType: "gardenHarvest",
    source: {
      kind: "garden-harvest",
      device: opts.device || "web",
    },
  });

  addRecent({
    id: normalized.id,
    type: normalized.type,
    title: normalized.title,
    source: "garden-harvest",
    at: Date.now(),
  });

  // harvest → usually implies follow-up
  if (opts.schedule || payload.schedule) {
    emit("automation.schedule.request", {
      source: "import:garden-harvest",
      normalized,
      schedule: opts.schedule || payload.schedule || null,
      session: {
        domain: "cooking",
        action: "preserve-from-garden",
        payload: normalized,
      },
    });
  }

  return normalized;
});

// 9. cleaning / declutter / zone
registerSource("cleaning-plan", async (payload, opts = {}) => {
  const normalized = ImportNormalizer.normalize({
    ...payload,
    __importType: "cleaningSession",
    source: {
      kind: "cleaning-plan",
      device: opts.device || "web",
    },
  });

  addRecent({
    id: normalized.id,
    type: normalized.type,
    title: normalized.title,
    source: "cleaning-plan",
    at: Date.now(),
  });

  if (opts.schedule || payload.schedule) {
    emit("automation.schedule.request", {
      source: "import:cleaning-plan",
      normalized,
      schedule: opts.schedule || payload.schedule || null,
      session: {
        domain: "cleaning",
        action: "run-cleaning-session",
        payload: normalized,
      },
    });
  }

  return normalized;
});

// 10. storehouse GOAL (goal-style, not sectioned)
registerSource("storehouse-goal", async (payload, opts = {}) => {
  const normalized = ImportNormalizer.normalize({
    ...payload,
    __importType: "storehouseGoal",
    source: {
      kind: "storehouse-goal",
      device: opts.device || "web",
    },
  });

  addRecent({
    id: normalized.id,
    type: normalized.type,
    title: normalized.title,
    source: "storehouse-goal",
    at: Date.now(),
  });

  return normalized;
});

// 11. storehouse STOCK PLAN (grocery sections)
registerSource("storehouse-stock-plan", async (payload, opts = {}) => {
  const normalized = ImportNormalizer.normalize({
    ...payload,
    __importType: "storehouseStockPlan",
    source: {
      kind: "storehouse-stock-plan",
      device: opts.device || "web",
    },
  });

  addRecent({
    id: normalized.id,
    type: normalized.type,
    title: normalized.title,
    source: "storehouse-stock-plan",
    at: Date.now(),
  });

  return normalized;
});

// 12. animals / livestock / butchery
registerSource("animal-plan", async (payload, opts = {}) => {
  const normalized = ImportNormalizer.normalize({
    ...payload,
    __importType: "animalPlan",
    source: {
      kind: "animal-plan",
      device: opts.device || "web",
    },
  });

  addRecent({
    id: normalized.id,
    type: normalized.type,
    title: normalized.title,
    source: "animal-plan",
    at: Date.now(),
  });

  return normalized;
});

/* -------------------------------------------------------------------------- */
/* MAIN orchestrator                                                          */
/* -------------------------------------------------------------------------- */
/**
 * Orchestrates an import from a specific sourceType.
 *
 * @param {string} sourceType
 * @param {any} payload
 * @param {object} opts - {
 *    saveAsFavorite,
 *    schedule,
 *    session,
 *    platform,
 *    filename,
 *    mime,
 *    device,
 *    reverse,             // NEW: triggers analytics reverse gen too
 *    sharedWith,          // NEW: for co-op planning
 *    sellable             // NEW: if user wants to sell their plan to community
 * }
 */
async function importFromSource(sourceType, payload, opts = {}) {
  const handler = sourceHandlers[sourceType];

  // run handler or direct normalize
  let normalized;
  if (!handler) {
    normalized = ImportNormalizer.normalize({
      ...payload,
      source: { kind: sourceType },
    });
  } else {
    normalized = await handler(payload, opts);
  }

  // always keep recents
  addRecent({
    id: normalized.id,
    type: normalized.type,
    title: normalized.title,
    source: sourceType,
    at: Date.now(),
  });

  // schedule? (user-owned schedules)
  if (opts.schedule || opts.session) {
    emit("automation.schedule.request", {
      source: `import:${sourceType}`,
      normalized,
      schedule: opts.schedule || null,
      session: opts.session || null,
      meta: {
        userOwned: true,
        device: opts.device || "web",
      },
    });
  }

  // favorite? (user-owned)
  if (opts.saveAsFavorite) {
    ImportNormalizer.saveFavorite(normalized);
  }

  // ANALYTICS: record this import across domains
  const analytics = await getImportAnalytics();
  let analyticsRecord = null;
  if (analytics?.recordImport) {
    analyticsRecord = await analytics.recordImport({
      ...normalized,
      userOwned: !!opts.saveAsFavorite,
      scheduleId: opts.schedule ? `sch_${Date.now()}` : null,
      planId: normalized.id || null,
      source: sourceType,
    });
  }

  // if user wanted it to be a favorite in analytics too
  if (opts.saveAsFavorite && analyticsRecord && analytics?.favoriteFromImport) {
    await analytics.favoriteFromImport(analyticsRecord.id, {
      label: normalized.title || normalized.name || `Favorite ${domainFromNormalized(normalized)}`,
      userScheduleId: opts.schedule ? analyticsRecord.scheduleId : null,
      sharedWith: Array.isArray(opts.sharedWith) ? opts.sharedWith : [],
      sellable: !!opts.sellable,
    });
  }

  // reverse generation? let analytics tell UI what to import next
  if (opts.reverse && analytics?.reverseGenerate) {
    const domain = domainFromNormalized(normalized);
    analytics.reverseGenerate({
      domain,
      plan: normalized,
    });
  }

  // broadcast completion (for dashboards)
  emit("import.service.completed", {
    sourceType,
    normalized,
    opts,
  });

  return normalized;
}

/* -------------------------------------------------------------------------- */
/* reverse generation (normalized → shareable/import-like)                    */
/* -------------------------------------------------------------------------- */
async function reverse(normalized) {
  const reversed = ImportNormalizer.reverse(normalized);

  const withShareMeta = {
    ...reversed,
    share: {
      canShare: true,
      suggestedTarget: "family-fund-hub",
      createdAt: Date.now(),
    },
  };

  emit("import.service.reverse", {
    normalized,
    reversed: withShareMeta,
  });

  // also tell analytics that a reverse happened
  const analytics = await getImportAnalytics();
  if (analytics?.reverseGenerate) {
    const domain = domainFromNormalized(normalized);
    analytics.reverseGenerate({ domain, plan: withShareMeta });
  }

  return withShareMeta;
}

/* -------------------------------------------------------------------------- */
/* favorites (user-owned)                                                     */
/* -------------------------------------------------------------------------- */
function saveAsFavorite(normalized) {
  const favs = ImportNormalizer.saveFavorite(normalized);
  emit("import.service.favorite.saved", { normalized, favorites: favs });
  return favs;
}

function getFavorites() {
  return ImportNormalizer.getFavorites();
}

/* -------------------------------------------------------------------------- */
/* recents                                                                    */
/* -------------------------------------------------------------------------- */
function getRecent() {
  return loadRecents();
}

/* -------------------------------------------------------------------------- */
/* broadcast to domain dashboards / pages                                     */
/* -------------------------------------------------------------------------- */
function broadcastToDomain(normalized) {
  const domain = normalized?.type;
  if (!domain) return;

  switch (domain) {
    case "mealPlan":
      emit("mealPlanner.imported", { mealPlan: normalized });
      break;
    case "recipe":
      emit("recipes.imported", { recipe: normalized });
      emit("batchCooking.recipe.imported", { recipe: normalized });
      break;
    case "gardenPlan":
      emit("gardenPlanner.imported", { gardenPlan: normalized });
      break;
    case "gardenCare":
      emit("gardenCare.imported", { gardenCare: normalized });
      break;
    case "gardenHarvest":
      emit("gardenHarvest.imported", { gardenHarvest: normalized });
      // harvest → inventory/cooking board might want to react too
      emit("inventory.harvest.imported", { gardenHarvest: normalized });
      emit("cooking.garden-harvest.imported", { gardenHarvest: normalized });
      break;
    case "cleaningSession":
      emit("cleaning.imported", { cleaningSession: normalized });
      break;
    case "storehouseGoal":
      emit("storehouse.imported", { storehouseGoal: normalized });
      break;
    case "storehouseStockPlan":
      emit("storehouse.stockPlan.imported", { stockPlan: normalized });
      break;
    case "animalPlan":
      emit("animalPlanner.imported", { animalPlan: normalized });
      break;
    case "inventoryUpdate":
      emit("inventory.imported", { update: normalized });
      break;
    default:
      break;
  }
}

/* -------------------------------------------------------------------------- */
/* wrapper that imports *and* broadcasts                                      */
/* -------------------------------------------------------------------------- */
async function importAndBroadcast(sourceType, payload, opts = {}) {
  const normalized = await importFromSource(sourceType, payload, opts);
  broadcastToDomain(normalized);
  return normalized;
}

/* -------------------------------------------------------------------------- */
/* PUBLIC API                                                                 */
/* -------------------------------------------------------------------------- */
export const ImportService = {
  importFromSource,
  importAndBroadcast,
  registerSource,
  reverse,
  saveAsFavorite,
  getFavorites,
  getRecent,
  emit,
};
