// src/engines/inventory/InventorySessionEngine.js
/* eslint-disable no-console */

/**
 * InventorySessionEngine
 * -----------------------------------------------------------------------------
 * Canonical place to:
 *  - build inventory sessions from scans, plans, or external engines
 *  - reverse-generate inventory actions from downstream domains
 *    (meals → needed items, garden harvests → put into storehouse, animals → butchering log → inventory)
 *  - persist user-owned favorite sessions/schedules
 *  - emit orchestration events so other pages (meals, cleaning, garden, animals)
 *    can refresh their views when an inventory session is created or updated
 *
 * This is intentionally parallel to your:
 *  - MealPlanEngine
 *  - GardenQueueManager
 *  - AnimalQueueManager
 *  - CleaningPlanManager
 *
 * It should “feel” the same to the rest of the app.
 */

import DexieDB from "@/db"; // <- you already used this path in other managers
// if the alias is different, keep the same pattern you used in GardenQueueManager.js

// tiny utils
const isBrowser = typeof window !== "undefined";
const genId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
const nowISO = () => new Date().toISOString();

// soft Sabbath / quiet-hours guard (non-blocking)
const respectQuietHours = async (ctx = {}) => {
  try {
    // you have Sabbath guards elsewhere – we just mirror the pattern
    const globalConfig = isBrowser ? window.__suka?.config ?? {} : {};
    const quiet = globalConfig.quietHours || {};
    if (!quiet.enabled) return true;

    const hour = new Date().getHours();
    const start = quiet.start ?? 21; // 9pm
    const end = quiet.end ?? 7; // 7am
    const within =
      start < end ? hour >= start && hour < end : hour >= start || hour < end;

    if (within) {
      // emit a hint instead of hard blocking
      emitGlobal("suka:quiet-hours:blocked", {
        reason: "Inventory session creation during quiet hours",
        ctx,
      });
    }
    return !within;
  } catch (err) {
    console.warn("[InventorySessionEngine] quiet-hours check failed", err);
    return true;
  }
};

// global emitter bridge
const emitGlobal = (type, detail = {}) => {
  if (isBrowser) {
    window.dispatchEvent(new CustomEvent(type, { detail }));
    try {
      const bus = window.__suka?.eventBus;
      if (bus?.emit) bus.emit(type, detail);
    } catch {
      /* noop */
    }
  }
};

// defensive Dexie table getters
const getTable = (name) => {
  try {
    return DexieDB?.[name];
  } catch (err) {
    console.warn("[InventorySessionEngine] Dexie table not available:", name, err);
    return null;
  }
};

/**
 * Hydrates a session object into a normalized shape we use across the app.
 */
const normalizeSession = (partial = {}) => {
  const id = partial.id || `inv_sess_${genId()}`;
  return {
    id,
    type: partial.type || "inventory",
    label: partial.label || "Inventory Session",
    createdAt: partial.createdAt || nowISO(),
    updatedAt: nowISO(),
    source: partial.source || "manual", // scan|plan|reverse|import|sync
    // the actual work to do
    tasks: Array.isArray(partial.tasks) ? partial.tasks : [],
    // optional cross-domain refs
    links: {
      mealSessionId: partial.links?.mealSessionId || null,
      gardenPlanId: partial.links?.gardenPlanId || null,
      animalPlanId: partial.links?.animalPlanId || null,
      cleaningPlanId: partial.links?.cleaningPlanId || null,
      storehouseGoalId: partial.links?.storehouseGoalId || null,
      ...partial.links,
    },
    // scheduling metadata
    schedule: partial.schedule || null,
    // user vs system
    ownedByUser: partial.ownedByUser ?? true,
    // flags
    status: partial.status || "draft", // draft|active|done|archived
    meta: {
      ...partial.meta,
    },
  };
};

/**
 * Builds tasks from scanned items (Scan • Compare • Trust → Inventory)
 * Input shape mirrors your scan result: { upc, name, qty, unit, location, tags, price }
 */
const tasksFromScans = (scannedItems = []) => {
  return scannedItems.map((item) => {
    const id = `inv_task_${genId()}`;
    return {
      id,
      action: "reconcile", // reconcile|add|adjust|move|inspect
      itemId: item.upc || null,
      name: item.name || "Scanned item",
      qty: item.qty ?? 1,
      unit: item.unit || "ea",
      location: item.location || "pantry",
      tags: item.tags || [],
      source: "scan",
      price: item.price || null,
      notes: item.notes || "",
    };
  });
};

/**
 * Builds tasks from a "plan" (e.g. Storehouse Goals → Inventory Execution)
 * You said: Storehouse (Goals Planner) vs Inventory (Execution)
 * This turns goals into execution tasks.
 */
const tasksFromStorehousePlan = (plan = {}) => {
  const items = Array.isArray(plan.items) ? plan.items : [];
  return items.map((goal) => ({
    id: `inv_task_${genId()}`,
    action: "add", // goal → we need to add to inventory
    itemId: goal.id || null,
    name: goal.name || "Planned item",
    qty: goal.targetQty ?? goal.qty ?? 1,
    unit: goal.unit || "ea",
    location: goal.preferredLocation || "storehouse",
    tags: ["from-storehouse-goal"],
    source: "storehouse",
    notes: goal.notes || "",
  }));
};

/**
 * REVERSE GENERATION
 * -----------------------------------------------------------------------------
 * You wanted: “Option to ‘Generate Animal Plan from Recipes’ (reverse direction)”,
 * and “the things that are generated on the home page need to update the appropriate
 * other pages, like meal planning, animal care, cleaning, and cooking.”
 *
 * Here, reverse generation = “I already know what I’m going to COOK / FEED / HARVEST,
 * so tell me what to do in INVENTORY to support that.”
 */
const tasksFromReverseDomain = (reversePayload = {}) => {
  const tasks = [];

  // 1) meals → inventory
  if (Array.isArray(reversePayload.mealRecipes)) {
    reversePayload.mealRecipes.forEach((recipe) => {
      const ing = Array.isArray(recipe.ingredients) ? recipe.ingredients : [];
      ing.forEach((ingredient) => {
        tasks.push({
          id: `inv_task_${genId()}`,
          action: "check-or-pull", // check inventory and pull to prep
          name: ingredient.name || "Meal ingredient",
          itemId: ingredient.inventoryId || null,
          qty: ingredient.qty ?? 1,
          unit: ingredient.unit || "ea",
          location: ingredient.preferredLocation || "pantry",
          tags: ["from-meal"],
          source: "reverse:meal",
          notes: `For meal: ${recipe.title || recipe.name || "untitled meal"}`,
        });
      });
    });
  }

  // 2) garden → inventory
  if (Array.isArray(reversePayload.gardenHarvests)) {
    reversePayload.gardenHarvests.forEach((harvest) => {
      tasks.push({
        id: `inv_task_${genId()}`,
        action: "receive-harvest",
        name: harvest.crop || "Garden harvest",
        qty: harvest.qty ?? 1,
        unit: harvest.unit || "ea",
        location: harvest.storageLocation || "root-cellar",
        tags: ["from-garden"],
        source: "reverse:garden",
        notes: harvest.notes || "",
      });
    });
  }

  // 3) animals → inventory (butchering log → inventory items)
  if (Array.isArray(reversePayload.animalProducts)) {
    reversePayload.animalProducts.forEach((prod) => {
      tasks.push({
        id: `inv_task_${genId()}`,
        action: "receive-livestock-product",
        name: prod.name || "Animal product",
        qty: prod.qty ?? 1,
        unit: prod.unit || "ea",
        location: prod.location || "freezer",
        tags: ["from-animals"],
        source: "reverse:animals",
        notes: prod.notes || "",
      });
    });
  }

  // 4) cleaning / household supply usage → inventory
  if (Array.isArray(reversePayload.cleaningSupplies)) {
    reversePayload.cleaningSupplies.forEach((supply) => {
      tasks.push({
        id: `inv_task_${genId()}`,
        action: "reconcile",
        name: supply.name || "Cleaning supply",
        qty: supply.qtyUsed ? -Math.abs(supply.qtyUsed) : -1,
        unit: supply.unit || "ea",
        location: supply.location || "laundry",
        tags: ["from-cleaning"],
        source: "reverse:cleaning",
        notes: supply.notes || "",
      });
    });
  }

  return tasks;
};

/**
 * The main engine
 */
export class InventorySessionEngine {
  constructor(opts = {}) {
    this.opts = opts;
    this.table = getTable("inventorySessions"); // create this Dexie table if not present
    this.favoritesTable = getTable("favorites"); // generic favorites table
  }

  /**
   * Create from scanned items
   */
  async createFromScans(scannedItems = [], meta = {}) {
    const ok = await respectQuietHours({ kind: "inventory:scan" });
    const tasks = tasksFromScans(scannedItems);
    const session = normalizeSession({
      source: "scan",
      label: meta.label || "Scanned Inventory Session",
      tasks,
      meta,
      ownedByUser: true,
    });

    await this._persist(session);
    emitGlobal("inventory:session:created", { session });
    if (!ok) {
      emitGlobal("inventory:session:created:queued", { session });
    }
    return session;
  }

  /**
   * Create from a storehouse / goals plan
   */
  async createFromStorehousePlan(plan = {}) {
    const tasks = tasksFromStorehousePlan(plan);
    const session = normalizeSession({
      source: "plan",
      label: plan.label || "Storehouse → Inventory",
      tasks,
      links: { storehouseGoalId: plan.id || null },
      ownedByUser: true,
    });
    await this._persist(session);
    emitGlobal("inventory:session:created", { session });
    return session;
  }

  /**
   * REVERSE: create from downstream domain needs
   * reversePayload can contain:
   *  - mealRecipes: []
   *  - gardenHarvests: []
   *  - animalProducts: []
   *  - cleaningSupplies: []
   */
  async createFromReverse(reversePayload = {}, meta = {}) {
    const tasks = tasksFromReverseDomain(reversePayload);
    const session = normalizeSession({
      source: "reverse",
      label: meta.label || "Reverse-generated Inventory Session",
      tasks,
      links: {
        mealSessionId: meta.mealSessionId || null,
        gardenPlanId: meta.gardenPlanId || null,
        animalPlanId: meta.animalPlanId || null,
        cleaningPlanId: meta.cleaningPlanId || null,
      },
      ownedByUser: true,
      meta,
    });
    await this._persist(session);
    emitGlobal("inventory:session:created", { session, reverse: true });

    // let other domain pages update themselves
    emitGlobal("meals:needs-refresh", { reason: "inventory-reverse-session" });
    emitGlobal("garden:needs-refresh", { reason: "inventory-reverse-session" });
    emitGlobal("animals:needs-refresh", { reason: "inventory-reverse-session" });
    emitGlobal("cleaning:needs-refresh", { reason: "inventory-reverse-session" });

    return session;
  }

  /**
   * Save as user favorite (NOT just system sessions)
   */
  async saveAsFavorite(session) {
    try {
      const fav = {
        id: `fav_${session.id}`,
        type: "inventory-session",
        label: session.label,
        payload: session,
        createdAt: nowISO(),
        updatedAt: nowISO(),
        ownedByUser: true,
      };
      if (this.favoritesTable) {
        await this.favoritesTable.put(fav);
      } else {
        // fallback: stash in localStorage
        const lsKey = "suka:favorites:inventory-sessions";
        const prev = JSON.parse(localStorage.getItem(lsKey) || "[]");
        prev.push(fav);
        localStorage.setItem(lsKey, JSON.stringify(prev));
      }
      emitGlobal("inventory:favorite:created", { favorite: fav });
      return fav;
    } catch (err) {
      console.error("[InventorySessionEngine] failed to save favorite", err);
      return null;
    }
  }

  /**
   * Attach a schedule to a session and forward to the automation runtime
   * You have an in-app automation runtime at:
   *   src/services/automation/runtime.js
   * that listens for schedule/register events – we mirror that here.
   */
  async scheduleSession(sessionId, scheduleDef) {
    if (!sessionId || !scheduleDef) return;
    const session = await this._get(sessionId);
    if (!session) return;

    session.schedule = scheduleDef;
    session.updatedAt = nowISO();
    await this._persist(session);

    // hand off to automation runtime
    emitGlobal("automation:schedule:register", {
      id: sessionId,
      kind: "inventory-session",
      schedule: scheduleDef,
      payload: session,
    });

    emitGlobal("inventory:session:scheduled", { session });
    return session;
  }

  /**
   * List (optionally filtered)
   */
  async list(opts = {}) {
    const table = this.table;
    if (!table) return [];
    const all = await table.toArray();
    if (!opts.filter) return all;
    return all.filter((s) => {
      if (opts.filter.source && s.source !== opts.filter.source) return false;
      if (opts.filter.status && s.status !== opts.filter.status) return false;
      return true;
    });
  }

  /**
   * Update status (e.g. mark done)
   */
  async updateStatus(sessionId, status = "done") {
    const session = await this._get(sessionId);
    if (!session) return null;
    session.status = status;
    session.updatedAt = nowISO();
    await this._persist(session);
    emitGlobal("inventory:session:updated", { session });
    return session;
  }

  /**
   * INTERNAL: persist to Dexie or localStorage as fallback
   */
  async _persist(session) {
    const table = this.table;
    if (table) {
      await table.put(session);
    } else if (isBrowser) {
      const key = "suka:inventory-sessions";
      const prev = JSON.parse(localStorage.getItem(key) || "[]");
      const existingIdx = prev.findIndex((s) => s.id === session.id);
      if (existingIdx > -1) prev[existingIdx] = session;
      else prev.push(session);
      localStorage.setItem(key, JSON.stringify(prev));
    }
  }

  async _get(id) {
    const table = this.table;
    if (table) return table.get(id);
    if (isBrowser) {
      const key = "suka:inventory-sessions";
      const prev = JSON.parse(localStorage.getItem(key) || "[]");
      return prev.find((s) => s.id === id) || null;
    }
    return null;
  }
}

/* -----------------------------------------------------------------------------
   singleton export (like your other managers/engines)
----------------------------------------------------------------------------- */
let __inventorySessionEngine;
export const getInventorySessionEngine = (opts = {}) => {
  if (!__inventorySessionEngine) {
    __inventorySessionEngine = new InventorySessionEngine(opts);
  }
  return __inventorySessionEngine;
};
