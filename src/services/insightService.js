// C:\Users\larho\suka-smart-assistant\src\services\insightService.js
// Suka Smart Assistant – Insight Service
// -----------------------------------------------------------------------------
// PURPOSE
// - Turn *events* and *normalized imports* into household insights.
// - Central spot to answer: “What did we learn from that recipe / cleaning plan / garden
//   care article / animal butchery guide?”
// - Feeds your automation runtime (Next Best Action), dashboards, and (optionally)
//   the Suka Village Family Fund Hub.
//
// HOW IT FITS THE PIPELINE
// imports → intelligence → automation → (optional) hub export
// 1. scraperService / ImportRouter produce a normalized import
// 2. schemaValidator checks it
// 3. insightService looks at the payload + events (import.parsed, inventory.updated, …)
// 4. insightService extracts: ingredient patterns, equipment, seasonality, “needs storehouse”,
//    “garden has no matching seed”, “animal care requires butchery session”, etc.
// 5. insightService persists insights locally (storageService / localStorage)
// 6. insightService emits events: insight.created, insight.updated, insight.flush.requested
// 7. if familyFundMode=true, we format and send insights to the Hub (but SSA still owns data)
//
// GOALS
// - Forward-thinking: new domains (preservation, animal, storehouse) can register their
//   own extractors without touching this file.
// - Event-driven: everything emitted is in shape
//     { type, ts, source, data }
// - Defensive: if storage or Hub is not ready, don’t break the pipeline.
// -----------------------------------------------------------------------------

/* eslint-disable no-console */

const isBrowser = typeof window !== "undefined";
const SOURCE = "insightService";

// ------------------------------ Defensive imports ----------------------------
let eventBus = { emit() {}, on() {}, off() {} };
try {
  // eslint-disable-next-line global-require
  const eb = require("@/services/events/eventBus");
  eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
} catch (_e) {}

let storageService = null;
try {
  // eslint-disable-next-line global-require
  storageService = require("@/services/storageService");
  if (storageService && storageService.storageService) {
    storageService = storageService.storageService;
  }
} catch (_e) {}

let featureFlags = { familyFundMode: false };
try {
  // eslint-disable-next-line global-require
  const ff = require("@/config/featureFlags.json");
  featureFlags = ff || featureFlags;
} catch (_e) {}

let dataGateway = null;
try {
  // eslint-disable-next-line global-require
  const dg = require("@/services/dataGateway");
  dataGateway = dg.dataGateway || dg.default || dg || null;
} catch (_e) {}

let securityService = null;
try {
  // eslint-disable-next-line global-require
  const ss = require("@/services/securityService");
  securityService = ss.securityService || ss.default || ss || null;
} catch (_e) {}

// ------------------------------ Local storage keys ---------------------------
const STORE_KEY = "suka.insights.v1"; // fallback if storageService missing

// in-memory cache so we don't roundtrip for every event
const INSIGHT_CACHE = {
  byId: {}, // { [insightId]: insightObj }
  order: [], // keep chronological ids
};

// ------------------------------ Utils ----------------------------------------
function nowIso() {
  return new Date().toISOString();
}

function emitSSA(type, data = {}) {
  const evt = { type, ts: nowIso(), source: SOURCE, data };
  try {
    eventBus.emit(type, evt);
  } catch (_e) {}
  if (isBrowser) {
    try {
      window.dispatchEvent(new CustomEvent(type, { detail: evt }));
    } catch (_e) {}
    try {
      const bus = window.__suka?.eventBus;
      if (bus?.emit) bus.emit(type, evt);
    } catch (_e) {}
  }
  return evt;
}

function safeId(prefix = "insight") {
  return `${prefix}-${Math.random()
    .toString(36)
    .slice(2)}-${Date.now().toString(36)}`;
}

function shallowClone(o) {
  return o ? JSON.parse(JSON.stringify(o)) : o;
}

// fallback localStorage load/save
function loadLocalInsights() {
  if (!isBrowser) return { byId: {}, order: [] };
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (!raw) return { byId: {}, order: [] };
    return JSON.parse(raw);
  } catch (_e) {
    return { byId: {}, order: [] };
  }
}

function saveLocalInsights(data) {
  if (!isBrowser) return;
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(data));
  } catch (_e) {}
}

async function loadInsightsFromStorage() {
  // prefer Dexie/localforage-based storageService
  if (storageService && typeof storageService.get === "function") {
    const data = await storageService.get("insights");
    return data || { byId: {}, order: [] };
  }
  return loadLocalInsights();
}

async function saveInsightsToStorage(data) {
  if (storageService && typeof storageService.set === "function") {
    try {
      await storageService.set("insights", data);
      return;
    } catch (_e) {}
  }
  saveLocalInsights(data);
}

// optional Hub export
async function exportToHubIfEnabled(payload) {
  if (!featureFlags.familyFundMode) return;
  // dataGateway may already sign + enqueue
  if (dataGateway && typeof dataGateway.exportBatch === "function") {
    try {
      await dataGateway.exportBatch({
        scope: "insights",
        items: Array.isArray(payload) ? payload : [payload],
      });
      return;
    } catch (err) {
      console.warn(
        "[insightService] export via dataGateway failed, trying securityService",
        err
      );
    }
  }

  // very small fallback: build a secure packet and send if possible
  if (securityService && typeof securityService.sendToHub === "function") {
    try {
      await securityService.sendToHub({
        channel: "insights",
        payload,
      });
    } catch (_e) {
      // fail silent
    }
  }
}

// ------------------------------ Insight Extractors ---------------------------
// These are “best effort” extractors per domain. Each returns either
// - null/undefined → no insight
// - single insight object
// - array of insight objects
//
// They all receive a shared “ctx” with the source event + normalized payload.
const extractors = {
  recipe(ctx) {
    const { payload } = ctx;
    if (!payload) return null;
    const ingredients = payload.ingredients || payload.items || [];
    const equipment =
      payload.equipment || payload.tools || inferEquipmentFromRecipe(payload);
    const cuisine = payload.cuisine || guessCuisineFromTitle(payload.title);
    return {
      id: safeId("rxp"),
      domain: "cooking",
      kind: "recipeIntelligence",
      title: payload.title || "Recipe insight",
      createdAt: nowIso(),
      sourceUrl: payload.url || payload.source?.url || null,
      data: {
        ingredients,
        equipment,
        cuisine,
        hasLambOrGoat: ingredients.some(
          (i) => typeof i === "string" && /lamb|goat|mutton/i.test(i)
        ),
        tags: payload.tags || [],
      },
    };
  },

  mealPlan(ctx) {
    const { payload } = ctx;
    const days = Array.isArray(payload.days) ? payload.days.length : null;
    return {
      id: safeId("mealplan"),
      domain: "cooking",
      kind: "mealPlanCoverage",
      title: payload.title || "Meal plan imported",
      createdAt: nowIso(),
      data: {
        days,
        meals: payload.meals || [],
        gapDetected: !days || days < 7,
      },
    };
  },

  cleaningPlan(ctx) {
    const { payload } = ctx;
    const tasks = payload.tasks || payload.steps || [];
    return {
      id: safeId("clean"),
      domain: "cleaning",
      kind: "roomCoverage",
      title: payload.title || "Cleaning plan imported",
      createdAt: nowIso(),
      data: {
        totalTasks: tasks.length,
        hasKitchen: tasks.some((t) =>
          containsAny(t.title || t, ["kitchen", "fridge", "stove"])
        ),
        hasBathroom: tasks.some((t) =>
          containsAny(t.title || t, ["bath", "toilet", "shower"])
        ),
        hasLaundry: tasks.some((t) =>
          containsAny(t.title || t, ["laundry", "washer", "dryer"])
        ),
        scheduleHint: payload.schedule || null,
      },
    };
  },

  gardenPlan(ctx) {
    const { payload } = ctx;
    const seeds = payload.seeds || payload.items || [];
    return {
      id: safeId("garden"),
      domain: "garden",
      kind: "gardenCoverage",
      title: payload.title || "Garden plan imported",
      createdAt: nowIso(),
      data: {
        seedCount: seeds.length,
        coop: !!payload.coop,
        varieties: seeds
          .map((s) => (typeof s === "string" ? s : s.name))
          .filter(Boolean),
        hasStorehouseGoal: !!payload.storehouseGoal,
      },
    };
  },

  gardenCare(ctx) {
    return {
      id: safeId("gardencare"),
      domain: "garden",
      kind: "careSchedule",
      title: ctx.payload?.title || "Garden care imported",
      createdAt: nowIso(),
      data: {
        careTasks: ctx.payload?.careTasks || [],
        weatherAware: true,
      },
    };
  },

  harvestPlan(ctx) {
    return {
      id: safeId("harvest"),
      domain: "garden",
      kind: "harvestWindow",
      title: ctx.payload?.title || "Harvest plan imported",
      createdAt: nowIso(),
      data: {
        harvestTasks: ctx.payload?.harvestTasks || [],
        mayFeedStorehouse: true,
      },
    };
  },

  storehouseGoal(ctx) {
    const sections = ctx.payload?.sections || ctx.payload?.items || [];
    return {
      id: safeId("storehouse"),
      domain: "storehouse",
      kind: "stockGoal",
      title: ctx.payload?.title || "Storehouse goal imported",
      createdAt: nowIso(),
      data: {
        sections,
        grocerySections: sections.length > 0,
        recommended: ["syncToInventory", "emitToMealPlanner"],
      },
    };
  },

  storehouseStock(ctx) {
    return {
      id: safeId("storestock"),
      domain: "storehouse",
      kind: "stockUpdateSignal",
      title: ctx.payload?.title || "Storehouse stock imported",
      createdAt: nowIso(),
      data: {
        stockItems: ctx.payload?.stock || ctx.payload?.items || [],
        mayTriggerInventoryUpdate: true,
      },
    };
  },

  animalPlan(ctx) {
    const { payload } = ctx;
    return {
      id: safeId("animal"),
      domain: "animal",
      kind: "animalCarePlan",
      title: payload?.title || "Animal plan imported",
      createdAt: nowIso(),
      data: {
        animals: payload?.animals || [],
        breeds:
          payload?.animals?.map((a) => a.breed || a.name).filter(Boolean) || [],
        mayTriggerButchery:
          payload?.purpose === "meat" || payload?.butchery === true,
      },
    };
  },

  animalAcquisition(ctx) {
    return {
      id: safeId("animacq"),
      domain: "animal",
      kind: "acquisitionNeed",
      title: ctx.payload?.title || "Animal acquisition plan imported",
      createdAt: nowIso(),
      data: {
        animals: ctx.payload?.animals || [],
        budget: ctx.payload?.budget || null,
      },
    };
  },

  butcherySession(ctx) {
    return {
      id: safeId("butcher"),
      domain: "animal",
      kind: "butcherySteps",
      title: ctx.payload?.title || "Butchery plan imported",
      createdAt: nowIso(),
      data: {
        steps: ctx.payload?.steps || [],
        yieldCurves: ctx.payload?.yieldCurves || null,
        mayTriggerStorehouse: true,
      },
    };
  },

  inventoryUpdate(ctx) {
    return {
      id: safeId("inv"),
      domain: "inventory",
      kind: "inventoryChange",
      title: ctx.payload?.title || "Inventory updated",
      createdAt: nowIso(),
      data: {
        items: ctx.payload?.items || ctx.payload?.stock || [],
        source: ctx.payload?.source || null,
      },
    };
  },

  generic(ctx) {
    return {
      id: safeId("gen"),
      domain: "general",
      kind: "importedContent",
      title: ctx.payload?.title || "Imported content",
      createdAt: nowIso(),
      data: {
        url: ctx.payload?.url || ctx.payload?.source?.url || null,
      },
    };
  },
};

// ------------------------------ Insight Service ------------------------------
export const insightService = {
  /**
   * Initialize event listeners
   * Should be called once at app start.
   */
  async init() {
    // load existing insights (if any)
    const existing = await loadInsightsFromStorage();
    INSIGHT_CACHE.byId = existing.byId || {};
    INSIGHT_CACHE.order = existing.order || [];

    // listen to high-value events
    eventBus.on("import.parsed", (evt = {}) => {
      this.fromImport(evt.data?.import || evt.data || evt);
    });
    eventBus.on("inventory.updated", (evt = {}) => {
      this.fromEvent("inventoryUpdate", evt.data || evt);
    });
    eventBus.on("inventory.shortage.detected", (evt = {}) => {
      this.fromEvent("inventoryShortage", evt.data || evt);
    });
    eventBus.on("meal.executed", (evt = {}) => {
      this.fromEvent("mealExecuted", evt.data || evt);
    });
    eventBus.on("garden.harvest.logged", (evt = {}) => {
      this.fromEvent("harvestLogged", evt.data || evt);
    });
    eventBus.on("persistence.flush.requested", () => {
      // when other parts of SSA trigger a flush, we also persist insights
      this.flush();
    });

    emitSSA("insight.init", {
      insightCount: INSIGHT_CACHE.order.length,
    });
  },

  /**
   * Handle a single import payload → try to extract 1..N insights
   */
  async fromImport(payload = {}) {
    const importType =
      payload.__importType ||
      payload.importType ||
      guessImportTypeFromPayload(payload) ||
      "generic";

    const extractor =
      extractors[importType] ||
      extractors[payload.domain] ||
      extractors.generic;

    const ctx = { payload, importType };
    let insights = extractor(ctx);
    if (!insights) return;
    if (!Array.isArray(insights)) insights = [insights];

    for (const ins of insights) {
      await this.saveInsight(ins, { emit: true, maybeExport: true });
    }
  },

  /**
   * Handle non-import events, e.g. inventory.shortage.detected
   */
  async fromEvent(eventKind, data = {}) {
    const ins = buildInsightFromEvent(eventKind, data);
    if (!ins) return;
    await this.saveInsight(ins, { emit: true, maybeExport: true });
  },

  /**
   * Save insight to storage / cache
   */
  async saveInsight(insight, { emit = false, maybeExport = false } = {}) {
    if (!insight || typeof insight !== "object") return;

    // normalize
    if (!insight.id) insight.id = safeId("ins");
    if (!insight.createdAt) insight.createdAt = nowIso();

    INSIGHT_CACHE.byId[insight.id] = insight;
    if (!INSIGHT_CACHE.order.includes(insight.id)) {
      INSIGHT_CACHE.order.unshift(insight.id);
      // keep it reasonably small
      if (INSIGHT_CACHE.order.length > 500) {
        const removed = INSIGHT_CACHE.order.splice(500);
        removed.forEach((id) => delete INSIGHT_CACHE.byId[id]);
      }
    }

    await saveInsightsToStorage(INSIGHT_CACHE);

    if (emit) {
      emitSSA("insight.created", { insight });
    }

    // export to hub if feature enabled
    if (maybeExport) {
      await exportToHubIfEnabled(insight);
    }
  },

  /**
   * Get latest N insights
   */
  getRecent(limit = 50) {
    return INSIGHT_CACHE.order
      .slice(0, limit)
      .map((id) => INSIGHT_CACHE.byId[id])
      .filter(Boolean);
  },

  /**
   * Flush to storage (manual)
   */
  async flush() {
    await saveInsightsToStorage(INSIGHT_CACHE);
    emitSSA("insight.flushed", { count: INSIGHT_CACHE.order.length });
  },

  /**
   * Allow other modules to register their own extractors
   */
  registerExtractor(importType, fn) {
    if (!importType || typeof fn !== "function") return;
    extractors[importType] = fn;
    emitSSA("insight.extractor.registered", { importType });
  },
};

// ------------------------------ Helper Builders ------------------------------
function guessImportTypeFromPayload(p) {
  const text = (p.title || p.text || p.url || "").toLowerCase();
  if (text.includes("storehouse")) return "storehouseGoal";
  if (text.includes("pantry")) return "storehouseStock";
  if (text.includes("garden") || text.includes("seed")) return "gardenPlan";
  if (text.includes("harvest")) return "harvestPlan";
  if (text.includes("cleaning") || text.includes("declutter"))
    return "cleaningPlan";
  if (text.includes("animal")) return "animalPlan";
  if (text.includes("butcher") || text.includes("slaughter"))
    return "butcherySession";
  if (text.includes("meal plan") || text.includes("weekly menu"))
    return "mealPlan";
  if (text.includes("recipe")) return "recipe";
  return "generic";
}

function containsAny(text, arr) {
  const lower = String(text).toLowerCase();
  return arr.some((w) => lower.includes(w));
}

function guessCuisineFromTitle(title = "") {
  const t = title.toLowerCase();
  if (t.includes("jerk") || t.includes("island")) return "caribbean";
  if (t.includes("jollof") || t.includes("west african")) return "west-african";
  if (t.includes("taco") || t.includes("enchilada")) return "mexican";
  if (t.includes("curry")) return "indian";
  return "general";
}

function inferEquipmentFromRecipe(payload) {
  const text = JSON.stringify(payload).toLowerCase();
  const eq = [];
  if (text.includes("oven")) eq.push("oven");
  if (text.includes("skillet") || text.includes("cast iron"))
    eq.push("skillet");
  if (text.includes("pressure cooker") || text.includes("instant pot"))
    eq.push("pressure-cooker");
  if (text.includes("grill")) eq.push("grill");
  return eq;
}

function buildInsightFromEvent(eventKind, data) {
  switch (eventKind) {
    case "inventoryUpdate":
      return {
        id: safeId("inv"),
        domain: "inventory",
        kind: "inventoryUpdate",
        title: "Inventory updated",
        createdAt: nowIso(),
        data,
      };
    case "inventoryShortage":
      return {
        id: safeId("inv-short"),
        domain: "inventory",
        kind: "shortageDetected",
        title: "Inventory shortage detected",
        createdAt: nowIso(),
        data: {
          ...data,
          recommendedActions: [
            "routeToGardenPlanner",
            "routeToAnimalAcquisition",
            "addToGroceryList",
          ],
        },
      };
    case "mealExecuted":
      return {
        id: safeId("mealx"),
        domain: "cooking",
        kind: "mealExecuted",
        title: "Meal executed",
        createdAt: nowIso(),
        data: {
          ...data,
          mayTriggerInventoryDeduct: true,
        },
      };
    case "harvestLogged":
      return {
        id: safeId("harv"),
        domain: "garden",
        kind: "harvestLogged",
        title: "Garden harvest logged",
        createdAt: nowIso(),
        data: {
          ...data,
          mayTriggerStorehouse: true,
        },
      };
    default:
      return null;
  }
}

// ------------------------------ Auto-init ------------------------------------
if (isBrowser) {
  // fire & forget – app can call again if needed
  insightService.init().catch((err) => {
    console.warn("[insightService] init failed:", err);
  });
}
