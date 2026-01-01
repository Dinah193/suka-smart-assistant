// src/features/import/ImportRouter.js
/* eslint-disable no-console */
/**
 * ImportRouter
 * -----------------------------------------------------------------------------
 * One place to send *any* import-like payload and have it:
 *  - normalized
 *  - routed to the right domain (meals, inventory, garden, animals, cooking, cleaning,
 *    storehouse stock planning, garden care, garden harvest)
 *  - optionally run in REVERSE
 *  - optionally saved as a USER FAVORITE import pattern
 *  - optionally scheduled (via automation.schedule.request)
 *  - optionally ANALYZED (importAnalyticsService) so dashboards can show “what’s flowing in?”
 *
 * Now wired to:
 *  - src/services/importAnalyticsService.js
 *  - users can save their own favorite sessions and schedules (not just system)
 *  - reverse generation from the router, not just from the service
 */

const isBrowser = typeof window !== "undefined";

let cookingServicePromise = null;
let inventoryServicePromise = null;
let gardenServicePromise = null;
let gardenCareServicePromise = null;
let gardenHarvestServicePromise = null;
let animalServicePromise = null;
let cleaningServicePromise = null;
let storehouseServicePromise = null;
let mealPlanServicePromise = null;
let automationPromise = null;
let importAnalyticsPromise = null;

/* -------------------------------------------------------------------------- */
/* tiny safe import helper                                                    */
/* -------------------------------------------------------------------------- */
async function safeImport(promiseFactory, fallback = null) {
  try {
    return await promiseFactory();
  } catch (err) {
    console.warn("[ImportRouter] optional import failed:", err?.message || err);
    return fallback;
  }
}

/* -------------------------------------------------------------------------- */
/* lazy imports to avoid circular deps                                        */
/* -------------------------------------------------------------------------- */
async function getCooking() {
  if (!cookingServicePromise) {
    cookingServicePromise = import("@/services/cooking/CookingSessionService").then((m) =>
      m.getCookingSessionService()
    );
  }
  return cookingServicePromise;
}
async function getInventory() {
  if (!inventoryServicePromise) {
    inventoryServicePromise = import("@/services/inventory/InventorySessionService").then((m) =>
      m.getInventorySessionService()
    );
  }
  return inventoryServicePromise;
}
async function getGarden() {
  if (!gardenServicePromise) {
    gardenServicePromise = import("@/services/gardening/GardenSessionService").then((m) =>
      m.getGardenSessionService()
    );
  }
  return gardenServicePromise;
}
async function getGardenCare() {
  if (!gardenCareServicePromise) {
    gardenCareServicePromise = safeImport(
      () => import("@/services/gardening/GardenCareService").then((m) => m.getGardenCareService()),
      null
    );
  }
  return gardenCareServicePromise;
}
async function getGardenHarvest() {
  if (!gardenHarvestServicePromise) {
    gardenHarvestServicePromise = safeImport(
      () => import("@/services/gardening/HarvestSessionService").then((m) => m.getHarvestSessionService()),
      null
    );
  }
  return gardenHarvestServicePromise;
}
async function getAnimals() {
  if (!animalServicePromise) {
    animalServicePromise = import("@/services/animals/AnimalSessionService").then((m) =>
      m.getAnimalSessionService()
    );
  }
  return animalServicePromise;
}
async function getCleaning() {
  if (!cleaningServicePromise) {
    cleaningServicePromise = import("@/services/cleaning/CleaningSessionService").then((m) =>
      m.getCleaningSessionService()
    );
  }
  return cleaningServicePromise;
}
async function getStorehouse() {
  if (!storehouseServicePromise) {
    // optional: a service that handles storehouse goals/stock
    storehouseServicePromise = safeImport(
      () => import("@/services/storehouse/StorehouseService").then((m) => m.getStorehouseService()),
      null
    );
  }
  return storehouseServicePromise;
}
async function getMealPlanner() {
  if (!mealPlanServicePromise) {
    // optional: a service that handles meal plans directly
    mealPlanServicePromise = safeImport(
      () => import("@/services/meals/MealPlanService").then((m) => m.getMealPlanService()),
      null
    );
  }
  return mealPlanServicePromise;
}
async function getAutomation() {
  if (!automationPromise) {
    automationPromise = import("@/services/automation/runtime").then((m) => m.automation);
  }
  return automationPromise;
}
async function getImportAnalytics() {
  if (!importAnalyticsPromise) {
    importAnalyticsPromise = safeImport(() => import("@/services/importAnalyticsService").then((m) => m.default), null);
  }
  return importAnalyticsPromise;
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */
const genId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
const toArray = (v) => (Array.isArray(v) ? v : v ? [v] : []);
const safe = (v, d = {}) => (v && typeof v === "object" ? v : d);

function emitBus(eventName, detail = {}) {
  if (!isBrowser) return;
  try {
    window.dispatchEvent(new CustomEvent(eventName, { detail }));
  } catch {
    /* noop */
  }
  try {
    const bus = window.__suka?.eventBus;
    if (bus?.emit) bus.emit(eventName, detail);
  } catch {
    /* noop */
  }
}

/**
 * Normalize raw import payloads from multiple domains.
 */
function normalizeImport(raw = {}) {
  // already normalized
  if (raw.kind) return raw;

  // pinterest board
  if (raw.type === "pinterest.board") {
    const pins = toArray(raw.items);

    const recipes = pins
      .filter((p) => p?.contentType === "recipe" || /recipe|meal|dinner|lunch|breakfast/i.test(p?.title || ""))
      .map((p) => ({
        id: p.id || genId(),
        title: p.title || "Imported Pinterest Recipe",
        ingredients: p.ingredients || [],
        steps: p.steps || [],
        sourceUrl: p.url || raw.sourceUrl || null,
      }));

    const gardenSeeds = pins
      .filter((p) => /seed|garden|plant/i.test(p?.title || ""))
      .map((p) => ({
        id: p.id || genId(),
        name: p.title || "Imported Seed",
        notes: p.description || "",
        sourceUrl: p.url || raw.sourceUrl || null,
      }));

    const gardenCare = pins
      .filter((p) => /water|weed|fertiliz|pest|prune|mulch|trellis/i.test(p?.title || ""))
      .map((p) => ({
        id: p.id || genId(),
        task: p.title || "Garden Care Task",
        notes: p.description || "",
        sourceUrl: p.url || raw.sourceUrl || null,
      }));

    const gardenHarvest = pins
      .filter((p) => /harvest|pick|preserv|canning|freez|dehydrat/i.test(p?.title || ""))
      .map((p) => ({
        id: p.id || genId(),
        crop: p.title || "Imported Harvest Item",
        qty: p.qty ?? 1,
        unit: p.unit || "ea",
        notes: p.description || "",
      }));

    const hasRecipes = recipes.length > 0;
    const hasSeeds = gardenSeeds.length > 0;
    const hasCare = gardenCare.length > 0;
    const hasHarvest = gardenHarvest.length > 0;

    return {
      kind: hasRecipes && (hasSeeds || hasCare || hasHarvest) ? "mixed" : hasRecipes ? "recipes" : "garden",
      recipes,
      gardenSeeds,
      gardenCare,
      gardenHarvest,
      source: { type: "pinterest.board", url: raw.sourceUrl || null, meta: raw.meta || {} },
    };
  }

  // recipe site
  if (
    raw.type === "recipe" ||
    raw.type === "recipes" ||
    raw.site === "allrecipes" ||
    raw.site === "loveandlemons" ||
    raw.sourceType === "recipe.site"
  ) {
    const recipes = toArray(raw.recipes || raw.items || raw.recipe).map((r) => ({
      id: r.id || genId(),
      title: r.title || r.name || "Imported Recipe",
      ingredients: r.ingredients || [],
      steps: r.steps || r.directions || [],
      sourceUrl: r.url || raw.sourceUrl || null,
    }));
    return {
      kind: "recipes",
      recipes,
      source: { type: "recipe.site", url: raw.sourceUrl || null, meta: raw.meta || {} },
    };
  }

  // meal plan import (explicit)
  if (raw.type === "meal-plan" || raw.kind === "mealPlan" || Array.isArray(raw.days)) {
    return {
      kind: "meal-plan",
      mealPlan: {
        id: raw.id || genId(),
        title: raw.title || "Imported Meal Plan",
        days: toArray(raw.days),
      },
      source: { type: raw.type || "meal-plan", url: raw.sourceUrl || null, meta: raw.meta || {} },
    };
  }

  // scan-compare-trust → inventory
  if (raw.type === "scan" || raw.type === "scan-cart" || raw.type === "scan-circular") {
    const items = toArray(raw.items || raw.products || raw.lines);
    return {
      kind: "inventory",
      inventoryItems: items.map((it) => ({
        id: it.id || it.upc || genId(),
        upc: it.upc || null,
        name: it.name || "Scanned Item",
        qty: it.qty ?? it.quantity ?? 1,
        unit: it.unit || "ea",
        location: it.location || "pantry",
        price: it.price || null,
        tags: it.tags || [],
      })),
      source: { type: raw.type, url: raw.sourceUrl || null, meta: raw.meta || {} },
    };
  }

  // seed pack / garden plan
  if (raw.type === "seed-pack" || raw.type === "garden-plan" || raw.type === "garden-seeds") {
    const seeds = toArray(raw.items || raw.seeds).map((s) => ({
      id: s.id || genId(),
      name: s.name || s.title || "Imported Seed",
      qty: s.qty ?? s.quantity ?? 1,
      unit: s.unit || "pkg",
      notes: s.notes || s.description || "",
    }));
    return {
      kind: "garden",
      gardenSeeds: seeds,
      source: { type: raw.type, url: raw.sourceUrl || null, meta: raw.meta || {} },
    };
  }

  // garden care
  if (
    raw.type === "garden-care" ||
    raw.type === "garden-maintenance" ||
    raw.type === "garden-tasks" ||
    raw.type === "garden-calendar"
  ) {
    const care = toArray(raw.tasks || raw.items).map((t) => ({
      id: t.id || genId(),
      task: t.task || t.title || t.name || "Garden Care Task",
      notes: t.notes || t.description || "",
      when: t.when || t.date || null,
      zone: t.zone || t.bed || null,
    }));
    return {
      kind: "garden-care",
      gardenCare: care,
      source: { type: raw.type, url: raw.sourceUrl || null, meta: raw.meta || {} },
    };
  }

  // garden harvest
  if (raw.type === "garden-harvest" || raw.type === "harvest-log" || raw.type === "garden-yield") {
    const harvest = toArray(raw.items || raw.harvest).map((h) => ({
      id: h.id || genId(),
      crop: h.crop || h.name || h.title || "Harvest Item",
      qty: h.qty ?? h.quantity ?? 1,
      unit: h.unit || "ea",
      notes: h.notes || h.description || "",
      harvestedAt: h.harvestedAt || h.date || null,
    }));
    return {
      kind: "garden-harvest",
      gardenHarvest: harvest,
      source: { type: raw.type, url: raw.sourceUrl || null, meta: raw.meta || {} },
    };
  }

  // storehouse stock planning (grocery sections)
  if (
    raw.type === "storehouse-stock-plan" ||
    raw.type === "stock-plan" ||
    raw.kind === "storehouseStockPlan" ||
    raw.grocerySections
  ) {
    const sections = toArray(raw.grocerySections || raw.sections || raw.items).map((sec) => ({
      id: sec.id || genId(),
      name: sec.name || sec.section || "Section",
      items: toArray(sec.items).map((it) => ({
        id: it.id || genId(),
        name: it.name || it.title || "Item",
        qty: it.qty ?? it.quantity ?? 1,
        unit: it.unit || "ea",
      })),
    }));
    return {
      kind: "storehouse-stock-plan",
      stockPlan: {
        id: raw.id || genId(),
        title: raw.title || "Imported Storehouse Stock Plan",
        sections,
      },
      source: { type: raw.type || "storehouse-stock-plan", url: raw.sourceUrl || null, meta: raw.meta || {} },
    };
  }

  // animal / livestock import (acquisition / care / butchery)
  if (
    raw.type === "animal-products" ||
    raw.type === "livestock-processing" ||
    raw.type === "animal-acquisition" ||
    raw.type === "animal-care-plan" ||
    raw.type === "animal-butchery"
  ) {
    return {
      kind: "animals",
      animalEntries: toArray(raw.items).map((p) => ({
        id: p.id || genId(),
        name: p.name || p.product || p.title || "Animal Item",
        qty: p.qty ?? 1,
        unit: p.unit || "ea",
        location: p.location || "freezer",
        role: p.role || raw.type,
      })),
      source: { type: raw.type, url: raw.sourceUrl || null, meta: raw.meta || {} },
    };
  }

  // cleaning
  if (
    raw.type === "cleaning-plan" ||
    raw.type === "declutter-plan" ||
    raw.type === "room-routine" ||
    raw.type === "zone-cleaning"
  ) {
    const sets = toArray(raw.tasks || raw.zones || raw.items).map((t) => ({
      id: t.id || genId(),
      task: t.task || t.title || t.name || "Cleaning Task",
      room: t.room || t.zone || null,
      freq: t.freq || t.frequency || null,
      notes: t.notes || t.description || "",
    }));
    return {
      kind: "cleaning",
      cleaningSets: sets,
      source: { type: raw.type, url: raw.sourceUrl || null, meta: raw.meta || {} },
    };
  }

  // fallback
  return {
    kind: "unknown",
    source: { type: raw.type || "unknown", url: raw.sourceUrl || null, meta: raw.meta || {} },
    raw,
  };
}

/* -------------------------------------------------------------------------- */
/* ImportRouter class                                                         */
/* -------------------------------------------------------------------------- */
class ImportRouter {
  constructor() {
    this._last = null;
  }

  getLast() {
    return this._last;
  }

  /**
   * MAIN ROUTE
   */
  async route(raw = {}, opts = {}) {
    // 1) normalize
    const normalized = normalizeImport(raw);
    this._last = { at: Date.now(), normalized, opts };

    // 2) ANALYTICS: record the normalized import right away
    //    so even if the routing fails, we still know what came in.
    const analytics = await getImportAnalytics();
    let analyticsRecord = null;
    if (analytics?.recordImport) {
      analyticsRecord = await analytics.recordImport({
        ...normalized,
        // preserve user intent
        userOwned: !!opts.asFavorite,
        planId: opts.planId || null,
        scheduleId: opts.schedule ? `sch_${genId()}` : null,
        source: normalized.source?.url || normalized.source?.type || raw.sourceUrl || raw.type || "unknown",
      });
    }

    const wantsReverse = opts.reverse === true;
    const label = opts.label || this._titleFrom(normalized, raw);

    // 3) SWITCH by kind (your existing logic, but we’ll tap analytics for reverse/favorites)
    let result;
    switch (normalized.kind) {
      case "meal-plan":
        result = wantsReverse
          ? await this._routeMealPlanReverse(normalized, { label, ...opts })
          : await this._routeMealPlan(normalized, { label, ...opts });
        break;

      case "recipes":
        result = wantsReverse
          ? await this._routeRecipesReverse(normalized, { label, ...opts })
          : await this._routeRecipes(normalized, { label, ...opts });
        break;

      case "inventory":
        result = wantsReverse
          ? await this._routeInventoryReverse(normalized, { label, ...opts })
          : await this._routeInventory(normalized, { label, ...opts });
        break;

      case "garden":
        result = wantsReverse
          ? await this._routeGardenReverse(normalized, { label, ...opts })
          : await this._routeGarden(normalized, { label, ...opts });
        break;

      case "garden-care":
        result = wantsReverse
          ? await this._routeGardenCareReverse(normalized, { label, ...opts })
          : await this._routeGardenCare(normalized, { label, ...opts });
        break;

      case "garden-harvest":
        result = wantsReverse
          ? await this._routeGardenHarvestReverse(normalized, { label, ...opts })
          : await this._routeGardenHarvest(normalized, { label, ...opts });
        break;

      case "storehouse-stock-plan":
        result = wantsReverse
          ? await this._routeStorehouseStockReverse(normalized, { label, ...opts })
          : await this._routeStorehouseStock(normalized, { label, ...opts });
        break;

      case "animals":
        result = wantsReverse
          ? await this._routeAnimalsReverse(normalized, { label, ...opts })
          : await this._routeAnimals(normalized, { label, ...opts });
        break;

      case "cleaning":
        result = await this._routeCleaning(normalized, { label, ...opts });
        break;

      case "mixed":
        result = await this._routeMixed(normalized, { label, ...opts });
        break;

      default:
        console.warn("[ImportRouter] Unknown import kind:", normalized);
        result = { ok: false, reason: "unknown-kind", normalized };
    }

    // 4) ANALYTICS: if user wanted it as favorite, mirror to analytics
    if (opts.asFavorite && analyticsRecord && analytics?.favoriteFromImport) {
      await analytics.favoriteFromImport(analyticsRecord.id, {
        label,
        userScheduleId: result?.session?.id ? null : null, // hook: you can pass real schedule id if you create it
        sharedWith: toArray(opts.sharedWith),
        sellable: !!opts.sellable,
      });
    }

    // 5) ANALYTICS: if this was a reverse request, tell analytics to drive the UI
    if (wantsReverse && analytics?.reverseGenerate) {
      // find domain from normalized.kind
      const domainMap = {
        "meal-plan": analytics.DOMAIN.MEALS,
        recipes: analytics.DOMAIN.MEALS,
        inventory: analytics.DOMAIN.STOREHOUSE,
        garden: analytics.DOMAIN.GARDEN,
        "garden-care": analytics.DOMAIN.GARDEN,
        "garden-harvest": analytics.DOMAIN.GARDEN,
        "storehouse-stock-plan": analytics.DOMAIN.STOREHOUSE,
        animals: analytics.DOMAIN.ANIMALS,
        cleaning: analytics.DOMAIN.CLEANING,
      };
      const domain = domainMap[normalized.kind] || analytics.DOMAIN.UNKNOWN;
      analytics.reverseGenerate({
        domain,
        plan: result?.session || result?.sessions || normalized,
      });
    }

    return result;
  }

  _titleFrom(normalized, raw) {
    if (raw?.title) return raw.title;
    if (normalized?.source?.type === "pinterest.board") return "Imported Pinterest Board";
    if (normalized?.source?.type === "recipe.site") return "Imported Recipes";
    if (normalized?.kind === "inventory") return "Scanned Items → Inventory";
    if (normalized?.kind === "garden-care") return "Imported Garden Care Tasks";
    if (normalized?.kind === "garden-harvest") return "Imported Garden Harvest";
    if (normalized?.kind === "storehouse-stock-plan") return "Imported Storehouse Stock Plan";
    if (normalized?.kind === "meal-plan") return "Imported Meal Plan";
    return "Imported Content";
  }

  /* ------------------------------------------------------------------------ */
  /* Meal Plan → Meal Planner (forward)                                       */
  /* ------------------------------------------------------------------------ */
  async _routeMealPlan(normalized, opts) {
    const mealPlanner = await getMealPlanner();
    const auto = await getAutomation();
    const mealPlan = normalized.mealPlan;

    let session;
    if (mealPlanner?.createSessionFromMealPlan) {
      session = await mealPlanner.createSessionFromMealPlan(mealPlan, {
        label: opts.label || "Imported Meal Plan",
        meta: { imported: true, source: normalized.source },
      });
    } else {
      session = { id: mealPlan.id, label: mealPlan.title, days: mealPlan.days };
    }

    if (opts.asFavorite && mealPlanner?.saveSessionAsFavorite) {
      await mealPlanner.saveSessionAsFavorite(session);
      auto.saveFavoriteSession({ id: session.id, label: session.label || session.id, domain: "meal-planner" });
    }

    if (opts.schedule) {
      auto.emitEvent("automation.schedule.request", {
        title: opts.scheduleTitle || session.label || "Meal Plan",
        templateId: "meal.plan.generate",
        rule: opts.schedule,
        ctx: { mealPlanId: session.id },
        meta: { domain: "meal-planner", mealPlanId: session.id },
      });
    }

    emitBus("import.meal-plan.created", { session, source: normalized.source });
    return { ok: true, domain: "meal-planner", session, normalized };
  }

  /* ------------------------------------------------------------------------ */
  /* Meal Plan (reverse) – meal plan → generate shopping/storehouse           */
  /* ------------------------------------------------------------------------ */
  async _routeMealPlanReverse(normalized, opts) {
    const inventory = await getInventory();
    const auto = await getAutomation();
    const mealPlan = normalized.mealPlan;

    const invSession = await inventory.createSessionFromReverse(
      { mealPlan },
      { label: opts.label || "Meal Plan → Inventory / Shopping" }
    );

    if (opts.asFavorite) {
      await inventory.saveSessionAsFavorite(invSession);
      auto.saveFavoriteSession({ id: invSession.id, label: invSession.label, domain: "inventory" });
    }

    emitBus("import.inventory.created", { session: invSession, source: normalized.source });
    return { ok: true, domain: "inventory", session: invSession, normalized };
  }

  /* ------------------------------------------------------------------------ */
  /* Recipes → Cooking (forward)                                              */
  /* ------------------------------------------------------------------------ */
  async _routeRecipes(normalized, opts) {
    const cooking = await getCooking();
    const auto = await getAutomation();
    const recipes = toArray(normalized.recipes);

    const session = await cooking.createSessionFromRecipes(recipes, {
      label: opts.label || "Imported Recipes → Cooking",
      links: { sourceUrl: normalized.source?.url || null },
      meta: { imported: true, source: normalized.source },
    });

    if (opts.asFavorite) {
      await cooking.saveSessionAsFavorite(session);
      auto.saveFavoriteSession({ id: session.id, label: session.label || session.id, domain: "cooking" });
    }

    if (opts.schedule) {
      auto.emitEvent("automation.schedule.request", {
        title: opts.scheduleTitle || session.label || "Cooking Session",
        templateId: "cooking.session.generate",
        rule: opts.schedule,
        ctx: { sessionId: session.id },
        meta: { domain: "cooking", sessionId: session.id },
      });
    }

    emitBus("import.cooking.created", { session, source: normalized.source });
    return { ok: true, domain: "cooking", session, normalized };
  }

  /* ------------------------------------------------------------------------ */
  /* Recipes → Cooking (reverse)                                              */
  /* ------------------------------------------------------------------------ */
  async _routeRecipesReverse(normalized, opts) {
    const cooking = await getCooking();
    const inventory = await getInventory();
    const auto = await getAutomation();
    const recipes = toArray(normalized.recipes);

    const cookSession = await cooking.createSessionFromReverse(
      { fromMeals: recipes },
      { label: opts.label || "Imported Recipes → Reverse Cooking" }
    );

    const invSession = await inventory.createSessionFromReverse(
      { mealRecipes: recipes },
      { label: "Imported Recipes → Inventory Check" }
    );

    if (opts.asFavorite) {
      await cooking.saveSessionAsFavorite(cookSession);
      await inventory.saveSessionAsFavorite(invSession);
      auto.saveFavoriteSession({ id: cookSession.id, label: cookSession.label, domain: "cooking" });
      auto.saveFavoriteSession({ id: invSession.id, label: invSession.label, domain: "inventory" });
    }

    emitBus("import.cooking.created", { session: cookSession, source: normalized.source });
    emitBus("import.inventory.created", { session: invSession, source: normalized.source });

    return {
      ok: true,
      domain: ["cooking", "inventory"],
      sessions: { cooking: cookSession, inventory: invSession },
      normalized,
    };
  }

  /* ------------------------------------------------------------------------ */
  /* Inventory (forward)                                                       */
  /* ------------------------------------------------------------------------ */
  async _routeInventory(normalized, opts) {
    const inventory = await getInventory();
    const auto = await getAutomation();

    const session = await inventory.createSessionFromScans(toArray(normalized.inventoryItems), {
      label: opts.label || "Scanned Items → Inventory",
      meta: { imported: true, source: normalized.source },
    });

    if (opts.asFavorite) {
      await inventory.saveSessionAsFavorite(session);
      auto.saveFavoriteSession({ id: session.id, label: session.label || session.id, domain: "inventory" });
    }

    if (opts.schedule) {
      auto.emitEvent("automation.schedule.request", {
        title: opts.scheduleTitle || session.label || "Inventory Session",
        templateId: "inventory.session.generate",
        rule: opts.schedule,
        ctx: { sessionId: session.id },
        meta: { domain: "inventory", sessionId: session.id },
      });
    }

    emitBus("import.inventory.created", { session, source: normalized.source });
    return { ok: true, domain: "inventory", session, normalized };
  }

  /* ------------------------------------------------------------------------ */
  /* Inventory (reverse)                                                       */
  /* ------------------------------------------------------------------------ */
  async _routeInventoryReverse(normalized, opts) {
    const cooking = await getCooking();
    const auto = await getAutomation();
    const items = toArray(normalized.inventoryItems);

    const cookSession = await cooking.createSessionFromReverse(
      { fromInventory: items.map((it) => ({ ...it, reason: "imported/on-hand" })) },
      { label: opts.label || "On-hand Items → Cook / Preserve" }
    );

    if (opts.asFavorite) {
      await cooking.saveSessionAsFavorite(cookSession);
      auto.saveFavoriteSession({ id: cookSession.id, label: cookSession.label, domain: "cooking" });
    }

    emitBus("import.cooking.created", { session: cookSession, source: normalized.source });
    return { ok: true, domain: "cooking", session: cookSession, normalized };
  }

  /* ------------------------------------------------------------------------ */
  /* Garden (forward)                                                          */
  /* ------------------------------------------------------------------------ */
  async _routeGarden(normalized, opts) {
    const garden = await getGarden();
    const auto = await getAutomation();

    const session = await garden.createSessionFromPlan(
      { seeds: toArray(normalized.gardenSeeds) },
      {
        label: opts.label || "Imported Seeds → Garden Plan",
        meta: { imported: true, source: normalized.source },
      }
    );

    if (opts.asFavorite) {
      await garden.saveSessionAsFavorite(session);
      auto.saveFavoriteSession({ id: session.id, label: session.label || session.id, domain: "garden" });
    }

    if (opts.schedule) {
      auto.emitEvent("automation.schedule.request", {
        title: opts.scheduleTitle || session.label || "Garden Session",
        templateId: "garden.session.generate",
        rule: opts.schedule,
        ctx: { sessionId: session.id },
        meta: { domain: "garden", sessionId: session.id },
      });
    }

    emitBus("import.garden.created", { session, source: normalized.source });
    return { ok: true, domain: "garden", session, normalized };
  }

  /* ------------------------------------------------------------------------ */
  /* Garden (reverse)                                                          */
  /* ------------------------------------------------------------------------ */
  async _routeGardenReverse(normalized, opts) {
    const inventory = await getInventory();
    const cooking = await getCooking();
    const auto = await getAutomation();

    const harvests = toArray(normalized.gardenSeeds).map((s) => ({
      crop: s.name,
      qty: s.qty ?? 1,
      unit: s.unit || "ea",
      notes: s.notes || "",
    }));

    const invSession = await inventory.createSessionFromReverse(
      { gardenHarvests: harvests },
      { label: opts.label || "Garden Harvest → Inventory" }
    );
    const cookSession = await cooking.createSessionFromReverse(
      { fromGarden: harvests },
      { label: "Garden Harvest → Cook / Preserve" }
    );

    if (opts.asFavorite) {
      await inventory.saveSessionAsFavorite(invSession);
      await cooking.saveSessionAsFavorite(cookSession);
      auto.saveFavoriteSession({ id: invSession.id, label: invSession.label, domain: "inventory" });
      auto.saveFavoriteSession({ id: cookSession.id, label: cookSession.label, domain: "cooking" });
    }

    emitBus("import.inventory.created", { session: invSession, source: normalized.source });
    emitBus("import.cooking.created", { session: cookSession, source: normalized.source });

    return {
      ok: true,
      domain: ["inventory", "cooking"],
      sessions: { inventory: invSession, cooking: cookSession },
      normalized,
    };
  }

  /* ------------------------------------------------------------------------ */
  /* Garden CARE (forward)                                                     */
  /* ------------------------------------------------------------------------ */
  async _routeGardenCare(normalized, opts) {
    const gardenCare = await getGardenCare();
    const garden = await getGarden();
    const auto = await getAutomation();
    const tasks = toArray(normalized.gardenCare);

    let session;
    if (gardenCare?.createSessionFromCareTasks) {
      session = await gardenCare.createSessionFromCareTasks(
        { tasks },
        {
          label: opts.label || "Imported Garden Care Tasks",
          meta: { imported: true, source: normalized.source },
        }
      );
    } else {
      session = await garden.createSessionFromPlan(
        { care: tasks },
        {
          label: opts.label || "Imported Garden Care Tasks",
          meta: { imported: true, source: normalized.source, asCare: true },
        }
      );
    }

    if (opts.asFavorite) {
      if (gardenCare?.saveSessionAsFavorite) {
        await gardenCare.saveSessionAsFavorite(session);
      } else if (garden?.saveSessionAsFavorite) {
        await garden.saveSessionAsFavorite(session);
      }
      auto.saveFavoriteSession({ id: session.id, label: session.label || session.id, domain: "garden-care" });
    }

    if (opts.schedule) {
      auto.emitEvent("automation.schedule.request", {
        title: opts.scheduleTitle || session.label || "Garden Care Session",
        templateId: "garden.care.session.generate",
        rule: opts.schedule,
        ctx: { sessionId: session.id },
        meta: { domain: "garden-care", sessionId: session.id },
      });
    }

    emitBus("import.gardenCare.created", { session, source: normalized.source });
    return { ok: true, domain: "garden-care", session, normalized };
  }

  /* ------------------------------------------------------------------------ */
  /* Garden CARE (reverse)                                                     */
  /* ------------------------------------------------------------------------ */
  async _routeGardenCareReverse(normalized, opts) {
    const auto = await getAutomation();
    const careTasks = toArray(normalized.gardenCare);

    if (careTasks.length) {
      auto.emitEvent("automation.schedule.request", {
        title: opts.scheduleTitle || opts.label || "Garden Care Tasks",
        templateId: "garden.care.session.generate",
        rule: opts.schedule || "RRULE:FREQ=DAILY",
        ctx: { tasks: careTasks },
        meta: { domain: "garden-care" },
      });
    }

    emitBus("import.gardenCare.reverse", { tasks: careTasks, source: normalized.source });
    return { ok: true, domain: "garden-care", tasks: careTasks, normalized };
  }

  /* ------------------------------------------------------------------------ */
  /* Garden HARVEST (forward)                                                  */
  /* ------------------------------------------------------------------------ */
  async _routeGardenHarvest(normalized, opts) {
    const inventory = await getInventory();
    const cooking = await getCooking();
    const harvestService = await getGardenHarvest();
    const auto = await getAutomation();

    const harvests = toArray(normalized.gardenHarvest);

    let harvestSession = null;
    if (harvestService?.createSessionFromHarvest) {
      harvestSession = await harvestService.createSessionFromHarvest(
        { harvests },
        {
          label: opts.label || "Imported Garden Harvest",
          meta: { imported: true, source: normalized.source },
        }
      );
    }

    const invSession = await inventory.createSessionFromReverse(
      { gardenHarvests: harvests },
      { label: `${opts.label || "Imported Garden Harvest"} → Inventory` }
    );

    const cookSession = await cooking.createSessionFromReverse(
      { fromGarden: harvests },
      { label: `${opts.label || "Imported Garden Harvest"} → Cook / Preserve` }
    );

    if (opts.asFavorite) {
      if (harvestSession && harvestService?.saveSessionAsFavorite) {
        await harvestService.saveSessionAsFavorite(harvestSession);
        auto.saveFavoriteSession({ id: harvestSession.id, label: harvestSession.label, domain: "garden-harvest" });
      }
      await inventory.saveSessionAsFavorite(invSession);
      await cooking.saveSessionAsFavorite(cookSession);
      auto.saveFavoriteSession({ id: invSession.id, label: invSession.label, domain: "inventory" });
      auto.saveFavoriteSession({ id: cookSession.id, label: cookSession.label, domain: "cooking" });
    }

    if (opts.schedule) {
      auto.emitEvent("automation.schedule.request", {
        title: opts.scheduleTitle || "Garden Harvest → Follow-up",
        templateId: "garden.harvest.session.generate",
        rule: opts.schedule,
        ctx: { harvests },
        meta: { domain: "garden-harvest" },
      });
    }

    emitBus("import.gardenHarvest.created", {
      harvestSession,
      inventorySession: invSession,
      cookingSession: cookSession,
      source: normalized.source,
    });

    return {
      ok: true,
      domain: ["garden-harvest", "inventory", "cooking"],
      sessions: { harvest: harvestSession, inventory: invSession, cooking: cookSession },
      normalized,
    };
  }

  /* ------------------------------------------------------------------------ */
  /* Garden HARVEST (reverse)                                                  */
  /* ------------------------------------------------------------------------ */
  async _routeGardenHarvestReverse(normalized, opts) {
    return this._routeGardenHarvest(normalized, opts);
  }

  /* ------------------------------------------------------------------------ */
  /* Storehouse Stock Plan (forward)                                           */
  /* ------------------------------------------------------------------------ */
  async _routeStorehouseStock(normalized, opts) {
    const storehouse = await getStorehouse();
    const auto = await getAutomation();
    const stockPlan = normalized.stockPlan;

    let session;
    if (storehouse?.createSessionFromStockPlan) {
      session = await storehouse.createSessionFromStockPlan(stockPlan, {
        label: opts.label || "Imported Storehouse Stock Plan",
        meta: { imported: true, source: normalized.source },
      });
    } else {
      session = { id: stockPlan.id, label: stockPlan.title, sections: stockPlan.sections };
    }

    if (opts.asFavorite && storehouse?.saveSessionAsFavorite) {
      await storehouse.saveSessionAsFavorite(session);
      auto.saveFavoriteSession({ id: session.id, label: session.label || session.id, domain: "storehouse" });
    }

    if (opts.schedule) {
      auto.emitEvent("automation.schedule.request", {
        title: opts.scheduleTitle || session.label || "Storehouse Stock Plan",
        templateId: "storehouse.stock.plan.generate",
        rule: opts.schedule,
        ctx: { stockPlanId: session.id },
        meta: { domain: "storehouse", stockPlanId: session.id },
      });
    }

    emitBus("import.storehouse-stock.created", { session, source: normalized.source });
    return { ok: true, domain: "storehouse", session, normalized };
  }

  /* ------------------------------------------------------------------------ */
  /* Storehouse Stock Plan (reverse)                                           */
  /* ------------------------------------------------------------------------ */
  async _routeStorehouseStockReverse(normalized, opts) {
    const auto = await getAutomation();
    const stockPlan = normalized.stockPlan;

    if (opts.schedule) {
      auto.emitEvent("automation.schedule.request", {
        title: opts.scheduleTitle || "Storehouse Stock Plan",
        templateId: "storehouse.stock.plan.generate",
        rule: opts.schedule,
        ctx: { stockPlan },
        meta: { domain: "storehouse" },
      });
    }

    emitBus("import.storehouse-stock.reverse", { stockPlan, source: normalized.source });
    return { ok: true, domain: "storehouse", stockPlan, normalized };
  }

  /* ------------------------------------------------------------------------ */
  /* Animals (forward)                                                         */
  /* ------------------------------------------------------------------------ */
  async _routeAnimals(normalized, opts) {
    const animals = await getAnimals();
    const inventory = await getInventory();
    const auto = await getAutomation();

    const animalSession = await animals.createSessionFromProducts(toArray(normalized.animalEntries), {
      label: opts.label || "Imported Animal Entries",
      meta: { imported: true, source: normalized.source },
    });

    const invSession = await inventory.createSessionFromReverse(
      { animalProducts: toArray(normalized.animalEntries) },
      { label: "Imported Animal Entries → Inventory" }
    );

    if (opts.asFavorite) {
      await animals.saveSessionAsFavorite(animalSession);
      await inventory.saveSessionAsFavorite(invSession);
      auto.saveFavoriteSession({ id: animalSession.id, label: animalSession.label, domain: "animals" });
      auto.saveFavoriteSession({ id: invSession.id, label: invSession.label, domain: "inventory" });
    }

    emitBus("import.animals.created", {
      animalSession,
      inventorySession: invSession,
      source: normalized.source,
    });

    return {
      ok: true,
      domain: ["animals", "inventory"],
      sessions: { animals: animalSession, inventory: invSession },
      normalized,
    };
  }

  /* ------------------------------------------------------------------------ */
  /* Animals (reverse)                                                         */
  /* ------------------------------------------------------------------------ */
  async _routeAnimalsReverse(normalized, opts) {
    const cooking = await getCooking();
    const auto = await getAutomation();

    const cookSession = await cooking.createSessionFromReverse(
      { fromAnimals: toArray(normalized.animalEntries) },
      { label: opts.label || "Imported Animal Entries → Cook" }
    );

    if (opts.asFavorite) {
      await cooking.saveSessionAsFavorite(cookSession);
      auto.saveFavoriteSession({ id: cookSession.id, label: cookSession.label, domain: "cooking" });
    }

    emitBus("import.cooking.created", { session: cookSession, source: normalized.source });
    return { ok: true, domain: "cooking", session: cookSession, normalized };
  }

  /* ------------------------------------------------------------------------ */
  /* Cleaning (forward)                                                        */
  /* ------------------------------------------------------------------------ */
  async _routeCleaning(normalized, opts) {
    const cleaning = await getCleaning();
    const auto = await getAutomation();

    const session = await cleaning.createSessionFromPlan(
      { tasks: toArray(normalized.cleaningSets) },
      {
        label: opts.label || "Imported Cleaning Plan",
        meta: { imported: true, source: normalized.source },
      }
    );

    if (opts.asFavorite) {
      await cleaning.saveSessionAsFavorite(session);
      auto.saveFavoriteSession({ id: session.id, label: session.label || session.id, domain: "cleaning" });
    }

    if (opts.schedule) {
      auto.emitEvent("automation.schedule.request", {
        title: opts.scheduleTitle || session.label || "Cleaning Session",
        templateId: "cleaning.session.generate",
        rule: opts.schedule,
        ctx: { sessionId: session.id },
        meta: { domain: "cleaning", sessionId: session.id },
      });
    }

    emitBus("import.cleaning.created", { session, source: normalized.source });
    return { ok: true, domain: "cleaning", session, normalized };
  }

  /* ------------------------------------------------------------------------ */
  /* Mixed imports                                                             */
  /* ------------------------------------------------------------------------ */
  async _routeMixed(normalized, opts) {
    const results = {};
    // recipes
    if (toArray(normalized.recipes).length) {
      results.recipes = await this._routeRecipes({ ...normalized, kind: "recipes" }, { ...opts });
    }
    // seeds/plan
    if (toArray(normalized.gardenSeeds).length) {
      results.garden = await this._routeGarden({ ...normalized, kind: "garden" }, { ...opts });
    }
    // care
    if (toArray(normalized.gardenCare).length) {
      results.gardenCare = await this._routeGardenCare({ ...normalized, kind: "garden-care" }, { ...opts });
    }
    // harvest
    if (toArray(normalized.gardenHarvest).length) {
      results.gardenHarvest = await this._routeGardenHarvest({ ...normalized, kind: "garden-harvest" }, { ...opts });
    }

    return {
      ok: true,
      domain: ["cooking", "garden", "garden-care", "garden-harvest"].filter(Boolean),
      sessions: {
        cooking: results.recipes?.session,
        garden: results.garden?.session,
        gardenCare: results.gardenCare?.session,
        gardenHarvest: results.gardenHarvest?.sessions,
      },
      normalized,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* singleton                                                                  */
/* -------------------------------------------------------------------------- */
let __importRouter;
export const getImportRouter = () => {
  if (!__importRouter) {
    __importRouter = new ImportRouter();
  }
  return __importRouter;
};

export default ImportRouter;
