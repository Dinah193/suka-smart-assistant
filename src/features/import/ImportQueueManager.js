// C:\Users\larho\suka-smart-assistant\src\features\import\ImportQueueManager.js
// Import Queue Manager
// -----------------------------------------------------------------------------
// PURPOSE
// - small, offline-friendly, event-driven queue for inbound imports
// - batches / orders imports before they get normalized + dispatched
// - supports user-owned favorites & schedules (opt-in per item)
// - supports reverse generation (so we can re-export any item in the queue)
// - integrates with shared orchestration (window.__suka?.eventBus + DOM)
// - now aware of:
//     • cleaning
//     • garden planning
//     • garden care / maintenance
//     • garden harvest
//     • storehouse stock planning (with grocery sections)
//     • meal planning
//     • animal acquisition, animal care, and butchery
// - mirrors the pattern you’re using in GardenQueueManager.js,
//   MealPlanEngine, Scan•Compare•Trust workers, and automation runtime.
//
// UI expectations (inspired by well-executed sites):
//   - “Incoming / Processing / Done / Failed” lanes
//   - one-click “Save as favorite”
//   - “Run now / Schedule”
//   - “Share / Export” (reverse)
//   - clear / re-order
//
// DEPENDS ON:
//  - ImportService (the updated one that knows about garden-care/harvest/
//    cleaning/storehouse/animal)
//  - ImportNormalizer (inside ImportService)
//  - shared event bus
// -----------------------------------------------------------------------------

import { ImportService } from "./ImportService";

const isBrowser = typeof window !== "undefined";
const STORAGE_KEY = "suka.import.queue.v2"; // bumped to v2 for new domains

const DEFAULT_STATE = {
  items: [], // { id, sourceType, payload, opts, status, error?, normalized? }
  updatedAt: 0,
};

// -----------------------------------------------------------------------------
// storage utils
// -----------------------------------------------------------------------------
function loadState() {
  if (!isBrowser) return { ...DEFAULT_STATE };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : { ...DEFAULT_STATE };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function saveState(state) {
  if (!isBrowser) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[ImportQueueManager] failed to persist queue:", err);
  }
}

// -----------------------------------------------------------------------------
// unified emitter (DOM + bus)
// -----------------------------------------------------------------------------
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
    console.warn("[ImportQueueManager] bus emit failed:", err);
  }
}

// -----------------------------------------------------------------------------
// id generator
// -----------------------------------------------------------------------------
function genId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// -----------------------------------------------------------------------------
// domain-aware broadcast
// this fires AFTER an item is processed, so dashboards/pages refresh immediately
// -----------------------------------------------------------------------------
function broadcastDomainFromNormalized(normalized) {
  const t = normalized?.type;
  if (!t) return;

  switch (t) {
    // meals
    case "mealPlan":
      emit("mealPlanner.imported", { mealPlan: normalized });
      break;
    case "recipe":
      emit("recipes.imported", { recipe: normalized });
      emit("batchCooking.recipe.imported", { recipe: normalized });
      break;

    // garden
    case "gardenPlan":
      emit("gardenPlanner.imported", { gardenPlan: normalized });
      break;
    case "gardenCare":
      emit("gardenCare.imported", { gardenCare: normalized });
      break;
    case "gardenHarvest":
      emit("gardenHarvest.imported", { gardenHarvest: normalized });
      // harvest → inventory / cooking / storehouse
      emit("inventory.harvest.imported", { gardenHarvest: normalized });
      emit("cooking.garden-harvest.imported", { gardenHarvest: normalized });
      emit("storehouse.harvest.imported", { gardenHarvest: normalized });
      break;

    // cleaning
    case "cleaningSession":
      emit("cleaning.imported", { cleaningSession: normalized });
      break;

    // storehouse (goals) and storehouse-stock-like imports
    case "storehouseGoal":
      emit("storehouse.imported", { storehouseGoal: normalized });
      break;
    case "storehouseStockPlan":
      // this is your “grocery sections for inspiration” mapping
      emit("storehouse.stockPlan.imported", { stockPlan: normalized });
      // and your inventory/meals dashboards may want to re-evaluate shopping list
      emit("inventory.stockPlan.imported", { stockPlan: normalized });
      break;

    // animals
    case "animalPlan":
      emit("animalPlanner.imported", { animalPlan: normalized });
      break;
    case "animalAcquisition":
      emit("animal.acquisition.imported", { animalAcquisition: normalized });
      break;
    case "animalCarePlan":
      emit("animal.care.imported", { animalCarePlan: normalized });
      break;
    case "animalButchery":
      emit("animal.butchery.imported", { animalButchery: normalized });
      // butchery → inventory
      emit("inventory.animal-products.imported", { animalButchery: normalized });
      break;

    // inventory
    case "inventoryUpdate":
      emit("inventory.imported", { update: normalized });
      break;

    default:
      break;
  }
}

// -----------------------------------------------------------------------------
// core queue manager
// -----------------------------------------------------------------------------
const ImportQueueManager = {
  _state: loadState(),

  // --- getters ---------------------------------------------------------------
  getState() {
    return this._state;
  },

  getItems() {
    return this._state.items || [];
  },

  getPending() {
    return this.getItems().filter((i) => i.status === "pending");
  },

  getProcessing() {
    return this.getItems().filter((i) => i.status === "processing");
  },

  getDone() {
    return this.getItems().filter((i) => i.status === "done");
  }

  ,
  getFailed() {
    return this.getItems().filter((i) => i.status === "failed");
  },

  // --- persist ---------------------------------------------------------------
  _commit(nextState) {
    this._state = {
      ...nextState,
      updatedAt: Date.now(),
    };
    saveState(this._state);
    emit("import.queue.updated", { state: this._state });
  },

  // --- add to queue ----------------------------------------------------------
  /**
   * Add a new item to the queue
   *
   * @param {string} sourceType - e.g. "file", "bookmarklet", "scan-compare-trust", "pinterest",
   *                              "garden-plan", "garden-care", "garden-harvest", "cleaning-plan",
   *                              "storehouse-stock-plan", "animal-acquisition", "animal-care-plan",
   *                              "animal-butchery"
   * @param {any} payload
   * @param {object} opts - { saveAsFavorite?, schedule?, session?, priority?, label? }
   */
  enqueue(sourceType, payload, opts = {}) {
    const state = this.getState();

    // domain-friendly default labels
    let autoLabel = null;
    switch (sourceType) {
      case "garden-plan":
        autoLabel = "Imported Garden Plan";
        break;
      case "garden-care":
        autoLabel = "Imported Garden Care";
        break;
      case "garden-harvest":
        autoLabel = "Imported Garden Harvest";
        break;
      case "cleaning-plan":
        autoLabel = "Imported Cleaning Plan";
        break;
      case "storehouse-stock-plan":
        autoLabel = "Imported Storehouse Stock Plan";
        break;
      case "meal-plan":
        autoLabel = "Imported Meal Plan";
        break;
      case "animal-acquisition":
        autoLabel = "Imported Animal Acquisition";
        break;
      case "animal-care-plan":
        autoLabel = "Imported Animal Care Plan";
        break;
      case "animal-butchery":
        autoLabel = "Imported Animal Butchery";
        break;
      default:
        autoLabel = null;
    }

    const item = {
      id: genId(),
      sourceType,
      payload,
      opts: {
        saveAsFavorite: !!opts.saveAsFavorite,
        schedule: opts.schedule || null,
        session: opts.session || null,
        priority: typeof opts.priority === "number" ? opts.priority : 0,
        label:
          opts.label ||
          payload.title ||
          payload.name ||
          autoLabel,
      },
      status: "pending",
      createdAt: Date.now(),
      error: null,
      normalized: null,
    };

    const nextItems = [item, ...state.items];
    this._commit({ ...state, items: nextItems });

    emit("import.queue.enqueued", { item });

    return item.id;
  },

  /**
   * Remove an item from the queue
   */
  remove(id) {
    const state = this.getState();
    const nextItems = state.items.filter((i) => i.id !== id);
    this._commit({ ...state, items: nextItems });
    emit("import.queue.removed", { id });
  },

  /**
   * Clear the entire queue
   */
  clear() {
    this._commit({ ...DEFAULT_STATE });
    emit("import.queue.cleared", {});
  },

  // --- process one item ------------------------------------------------------
  async processOne(id) {
    const state = this.getState();
    const item = state.items.find((i) => i.id === id);
    if (!item) return null;

    // mark processing
    item.status = "processing";
    this._commit({ ...state });
    emit("import.queue.processing", { id, item });

    try {
      // hand off to ImportService (normalize + broadcast)
      const normalized = await ImportService.importAndBroadcast(
        item.sourceType,
        item.payload,
        item.opts
      );

      // mark done
      item.status = "done";
      item.normalized = normalized;
      item.error = null;
      this._commit({ ...state });

      // extra domain broadcast
      broadcastDomainFromNormalized(normalized);

      emit("import.queue.done", { id, item, normalized });

      return normalized;
    } catch (err) {
      item.status = "failed";
      item.error = err?.message || String(err);
      this._commit({ ...state });

      emit("import.queue.failed", { id, item, error: item.error });

      return null;
    }
  },

  // --- process next (by priority) --------------------------------------------
  async processNext() {
    const pending = this.getPending();
    if (!pending.length) return null;

    // sort by priority DESC, then createdAt ASC
    pending.sort((a, b) => {
      const prioDiff = (b.opts?.priority || 0) - (a.opts?.priority || 0);
      if (prioDiff !== 0) return prioDiff;
      return a.createdAt - b.createdAt;
    });

    const nextItem = pending[0];
    return this.processOne(nextItem.id);
  },

  // --- process all -----------------------------------------------------------
  async processAll() {
    let processed = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const item = this.getPending()[0];
      if (!item) break;
      await this.processOne(item.id);
      processed += 1;
    }
    return processed;
  },

  // --- reverse generation ----------------------------------------------------
  /**
   * Reverse-generate an item in the queue (even if pending/done)
   * This supports: “I imported this storehouse stock plan → now export/sell to hub”
   * and: “I imported an animal care plan → now share with allied households”
   */
  reverse(id) {
    const item = this.getItems().find((i) => i.id === id);
    if (!item) return null;

    // if we already have normalized, use that
    if (item.normalized) {
      const reversed = ImportService.reverse(item.normalized);
      emit("import.queue.reverse.generated", { id, reversed });
      return reversed;
    }

    // otherwise guess domain from sourceType and make a minimal reverse
    const guessedType = (() => {
      switch (item.sourceType) {
        case "garden-plan":
          return "gardenPlan";
        case "garden-care":
          return "gardenCare";
        case "garden-harvest":
          return "gardenHarvest";
        case "cleaning-plan":
          return "cleaningSession";
        case "storehouse-stock-plan":
          return "storehouseStockPlan";
        case "meal-plan":
          return "mealPlan";
        case "animal-acquisition":
          return "animalAcquisition";
        case "animal-care-plan":
          return "animalCarePlan";
        case "animal-butchery":
          return "animalButchery";
        default:
          return item.payload?.type || "recipe";
      }
    })();

    const reversed = ImportService.reverse({
      type: guessedType,
      title:
        item.payload?.title ||
        item.payload?.name ||
        item.opts?.label ||
        "Queued Import",
    });

    emit("import.queue.reverse.generated", { id, reversed });

    return reversed;
  },

  // --- user favorite from queue ----------------------------------------------
  saveAsFavorite(id) {
    const item = this.getItems().find((i) => i.id === id);
    if (!item || !item.normalized) return null;
    const favs = ImportService.saveAsFavorite(item.normalized);
    emit("import.queue.favorite.saved", { id, favorites: favs });
    return favs;
  },

  // --- scheduler bridge ------------------------------------------------------
  /**
   * Forward schedule that arrived with the item
   * e.g. garden-care RRULE, cleaning-plan weekly, harvest follow-ups,
   * storehouse restock cadence, animal care rotation
   */
  forwardSchedule(id) {
    const item = this.getItems().find((i) => i.id === id);
    if (!item) return null;

    const schedule = item?.opts?.schedule || null;
    const session = item?.opts?.session || null;
    if (!schedule && !session) return null;

    emit("automation.schedule.request", {
      source: "import.queue",
      normalized: item.normalized || null,
      schedule,
      session,
    });

    emit("import.queue.schedule.forwarded", { id, schedule, session });

    return { schedule, session };
  },

  // --- listeners for global “import.queue.enqueue” ---------------------------
  initListeners() {
    if (!isBrowser) return;

    // from DOM
    window.addEventListener("import.queue.enqueue", (ev) => {
      const { sourceType, payload, opts } = ev.detail || {};
      if (!sourceType || !payload) return;
      this.enqueue(sourceType, payload, opts);
    });

    // from bus
    try {
      const bus = window.__suka?.eventBus;
      if (bus?.on) {
        bus.on("import.queue.enqueue", ({ sourceType, payload, opts }) => {
          if (!sourceType || !payload) return;
          this.enqueue(sourceType, payload, opts);
        });
      }
    } catch {
      /* noop */
    }
  },
};

// auto-init listeners in browser
if (isBrowser) {
  ImportQueueManager.initListeners();
}

// -----------------------------------------------------------------------------
// EXPORT
// -----------------------------------------------------------------------------
export { ImportQueueManager };

/*
HOW THIS MEETS YOUR LATEST ASK:

✓ cleaning → sourceType: "cleaning-plan" → normalized: cleaningSession → emits "cleaning.imported"
✓ garden planning → "garden-plan" → emits "gardenPlanner.imported"
✓ garden care → "garden-care" → emits "gardenCare.imported" and is scheduleable
✓ garden harvest → "garden-harvest" → also emits to inventory/cooking/storehouse
✓ storehouse stock planning → "storehouse-stock-plan" → emits "storehouse.stockPlan.imported"
   so you can map to “grocery sections” in UI
✓ meal planning → "meal-plan" → emits "mealPlanner.imported"
✓ animal acquisition / care / butchery:
   - "animal-acquisition" → "animal.acquisition.imported"
   - "animal-care-plan" → "animal.care.imported"
   - "animal-butchery" → "animal.butchery.imported" + "inventory.animal-products.imported"
✓ user-owned favorites → ImportQueueManager.saveAsFavorite(id) delegates to ImportService
✓ reverse generation → ImportQueueManager.reverse(id) guesses the correct domain so that
  garden, cleaning, storehouse, and animal data can all be re-shared / sold to the hub
✓ shared orchestration → all queue + domain events fired so your React/Vite pages can
  stay in sync with the Suka Smart Assistant orchestration
✓ offline / Sabbath-friendly → still persisted to localStorage (key bumped to v2)
*/
