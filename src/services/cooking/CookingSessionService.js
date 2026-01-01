// src/services/cooking/CookingSessionService.js
/* eslint-disable no-console */

/**
 * CookingSessionService
 * -----------------------------------------------------------------------------
 * Orchestrates cooking/batch-cooking sessions so they:
 *  - look/behave like the rest of your session engines (inventory, cleaning, garden, animals)
 *  - can be user-owned (favorites, user schedules)
 *  - can be REVERSE-generated (meals picked → build cooking session, or
 *    inventory surplus → build cooking/preservation session)
 *  - emit the shared orchestration events so meals, inventory, garden, animals,
 *    and cleaning all stay in sync
 *  - integrate with your multi-timer / batch parser / prep checklist ideas
 *
 * This service sits on top of:
 *  - src/engines/shared/SessionEngineCore.js
 *  - src/services/scheduling/SessionScheduler.js
 *
 * and is meant to be called from:
 *  - your Meals dashboard (when user drags recipes into BatchSessionPlanner)
 *  - your “Recipe Vault” toggle
 *  - your Scan • Compare • Trust flow (when you detect ingredients on hand → suggest batch cook)
 *  - your Home page auto-generator (the one you wanted to also show Garden, Animals, Pinterest → Planner)
 */

import { SessionEngineCore } from "@/engines/shared/SessionEngineCore";
import { getSessionScheduler } from "@/services/scheduling/SessionScheduler";

const isBrowser = typeof window !== "undefined";
const genTaskId = () => `cook_task_${Math.random().toString(36).slice(2)}`;

/* -------------------------------------------------------------------------- */
/* cooking actions                                                            */
/* -------------------------------------------------------------------------- */
const COOK_ACTIONS = {
  PREP: "prep",
  COOK: "cook",
  MARINATE: "marinate",
  DEFROST: "defrost",
  BATCH: "batch",
  PLATE: "plate",
  CLEAN: "clean-after-cook",
  LABEL: "label",
  STORE: "store",
  SYNC_TO_INVENTORY: "sync-to-inventory",
  SYNC_TO_MEALS: "sync-to-meals",
  SYNC_TO_CLEANING: "sync-to-cleaning",
  SYNC_TO_GARDEN: "sync-to-garden",
};

/**
 * Build cooking tasks from standard meal/recipe payload
 * (this is your forward direction: user picked recipes → build session)
 *
 * recipes: [
 *  {
 *    id,
 *    title,
 *    steps: [ "Chop onions", "Boil water", ... ],
 *    ingredients: [{ name, qty, unit, inventoryId?, needsDefrost?, needsMarinade? }]
 *  }
 * ]
 */
const tasksFromRecipes = (recipes = []) => {
  const tasks = [];

  recipes.forEach((recipe, recipeIdx) => {
    const baseLabel = recipe.title || `Recipe #${recipeIdx + 1}`;

    // 1) check defrost/marinade requirements FIRST
    const ings = Array.isArray(recipe.ingredients) ? recipe.ingredients : [];
    ings.forEach((ing) => {
      if (ing.needsDefrost) {
        tasks.push({
          id: genTaskId(),
          action: COOK_ACTIONS.DEFROST,
          recipeId: recipe.id || null,
          name: ing.name || "Ingredient",
          qty: ing.qty ?? 1,
          unit: ing.unit || "ea",
          source: "plan",
          notes: `Defrost for ${baseLabel}`,
        });
      }
      if (ing.needsMarinade) {
        tasks.push({
          id: genTaskId(),
          action: COOK_ACTIONS.MARINATE,
          recipeId: recipe.id || null,
          name: ing.name || "Ingredient",
          source: "plan",
          notes: `Marinate for ${baseLabel}`,
        });
      }
    });

    // 2) prep task
    tasks.push({
      id: genTaskId(),
      action: COOK_ACTIONS.PREP,
      recipeId: recipe.id || null,
      name: baseLabel,
      source: "plan",
      notes: "Prep all ingredients.",
      // this is where your Integrated Task Parser can hook in
      parserHint: {
        recipeTitle: baseLabel,
        recipeId: recipe.id || null,
      },
    });

    // 3) cook task (can be consolidated by the batch orchestrator)
    tasks.push({
      id: genTaskId(),
      action: COOK_ACTIONS.COOK,
      recipeId: recipe.id || null,
      name: baseLabel,
      source: "plan",
      notes: "Main cooking step.",
      multiTimer: true, // your MultiTimerPanel can read this
    });

    // 4) label + store (optional)
    tasks.push({
      id: genTaskId(),
      action: COOK_ACTIONS.LABEL,
      recipeId: recipe.id || null,
      name: baseLabel,
      source: "plan",
      notes: "Label container + date.",
    });
    tasks.push({
      id: genTaskId(),
      action: COOK_ACTIONS.STORE,
      recipeId: recipe.id || null,
      name: baseLabel,
      source: "plan",
      notes: "Store in fridge/freezer; update inventory.",
    });

    // 5) cleaning handoff
    tasks.push({
      id: genTaskId(),
      action: COOK_ACTIONS.SYNC_TO_CLEANING,
      recipeId: recipe.id || null,
      name: baseLabel,
      source: "plan",
      notes: "Trigger cleaning session (kitchen, dishes, trash).",
    });
  });

  return tasks;
};

/**
 * Build cooking tasks from REVERSE direction.
 *
 * reversePayload can look like:
 * {
 *   fromInventory: [{ name, qty, unit, reason?: "expiring-soon" }]
 *   fromGarden: [{ crop, qty, unit }]
 *   fromAnimals: [{ product: "lamb", cut: "shank" }]
 *   fromMeals: [{ title, ingredients: [...] }]   // re-batch for this week
 * }
 *
 * Idea: “I have things on hand → suggest a batch cook for them”
 */
const tasksFromReverse = (reversePayload = {}) => {
  const tasks = [];

  // 1) inventory surplus / expiring
  if (Array.isArray(reversePayload.fromInventory)) {
    reversePayload.fromInventory.forEach((item) => {
      tasks.push({
        id: genTaskId(),
        action: COOK_ACTIONS.BATCH,
        name: item.name || "On-hand item",
        qty: item.qty ?? 1,
        unit: item.unit || "ea",
        source: "reverse:inventory",
        notes: item.reason
          ? `Use in batch cook – ${item.reason}`
          : "Use in batch cook – on hand.",
      });
      tasks.push({
        id: genTaskId(),
        action: COOK_ACTIONS.LABEL,
        name: item.name || "On-hand item",
        source: "reverse:inventory",
        notes: "Label prepared batch.",
      });
      tasks.push({
        id: genTaskId(),
        action: COOK_ACTIONS.STORE,
        name: item.name || "On-hand item",
        source: "reverse:inventory",
        notes: "Store prepared batch; update inventory.",
      });
    });
  }

  // 2) garden harvest → cook/preserve
  if (Array.isArray(reversePayload.fromGarden)) {
    reversePayload.fromGarden.forEach((harvest) => {
      tasks.push({
        id: genTaskId(),
        action: COOK_ACTIONS.PREP,
        name: harvest.crop || "Harvest",
        source: "reverse:garden",
        notes: "Wash / chop / prep harvest.",
      });
      tasks.push({
        id: genTaskId(),
        action: COOK_ACTIONS.BATCH,
        name: harvest.crop || "Harvest",
        source: "reverse:garden",
        notes: "Cook / can / dehydrate harvest.",
      });
      tasks.push({
        id: genTaskId(),
        action: COOK_ACTIONS.SYNC_TO_INVENTORY,
        name: harvest.crop || "Harvest",
        source: "reverse:garden",
        notes: "Add cooked/preserved item to inventory/storehouse.",
      });
    });
  }

  // 3) animals → cook now (fresh processing)
  if (Array.isArray(reversePayload.fromAnimals)) {
    reversePayload.fromAnimals.forEach((prod) => {
      tasks.push({
        id: genTaskId(),
        action: COOK_ACTIONS.DEFROST,
        name: prod.product || prod.name || "Animal product",
        source: "reverse:animals",
        notes: "Defrost / bring to temp.",
      });
      tasks.push({
        id: genTaskId(),
        action: COOK_ACTIONS.COOK,
        name: prod.product || prod.name || "Animal product",
        source: "reverse:animals",
        notes: "Cook fresh animal product.",
      });
      tasks.push({
        id: genTaskId(),
        action: COOK_ACTIONS.SYNC_TO_INVENTORY,
        name: prod.product || prod.name || "Animal product",
        source: "reverse:animals",
        notes: "If cooked/prepped, add to inventory.",
      });
    });
  }

  // 4) meals → re-batch / pre-cook this week’s meals
  if (Array.isArray(reversePayload.fromMeals)) {
    const mealTasks = tasksFromRecipes(
      reversePayload.fromMeals.map((m) => ({
        id: m.id,
        title: m.title,
        ingredients: m.ingredients || [],
        steps: m.steps || [],
      }))
    );
    tasks.push(...mealTasks);
  }

  return tasks;
};

/* -------------------------------------------------------------------------- */
/* engine                                                                     */
/* -------------------------------------------------------------------------- */
class CookingSessionEngine extends SessionEngineCore {
  constructor(opts = {}) {
    super({
      domainName: "cooking",
      sessionTableName: "cookingSessions",
      ...opts,
    });
  }

  // FORWARD: user selected recipes / batch session
  async buildTasksFromSource(sourcePayload = {}) {
    // support both { recipes: [...] } and an array directly
    if (Array.isArray(sourcePayload.recipes)) {
      return tasksFromRecipes(sourcePayload.recipes);
    }
    if (Array.isArray(sourcePayload)) {
      return tasksFromRecipes(sourcePayload);
    }
    // support “from inventory surplus” as forward (rare but possible)
    if (Array.isArray(sourcePayload.fromInventory)) {
      return tasksFromReverse({ fromInventory: sourcePayload.fromInventory });
    }
    return [];
  }

  // REVERSE: inventory/garden/animals/meals → cooking
  async buildTasksFromReverse(reversePayload = {}) {
    return tasksFromReverse(reversePayload);
  }
}

/* -------------------------------------------------------------------------- */
/* service façade                                                             */
/* -------------------------------------------------------------------------- */
class CookingSessionService {
  constructor() {
    this.engine = new CookingSessionEngine();
    this.scheduler = getSessionScheduler();
  }

  /**
   * Forward: create a cooking session from selected recipes
   * (what your BatchSessionPlanner is doing)
   */
  async createSessionFromRecipes(recipes = [], meta = {}) {
    const session = await this.engine.createFromSource(
      { recipes },
      {
        source: "plan",
        label: meta.label || "Cooking / Batch Session",
        links: meta.links || {},
        ownedByUser: true,
        meta: {
          // this is where we can tell the UI to auto-open multi-timer, etc.
          openMultiTimer: true,
          openPrepChecklist: true,
          ...meta.meta,
        },
      }
    );
    return session;
  }

  /**
   * Reverse: create cooking session from “stuff we have / stuff we just did”
   */
  async createSessionFromReverse(reversePayload = {}, meta = {}) {
    const session = await this.engine.createFromReverse(reversePayload, {
      label: meta.label || "Reverse-generated Cooking Session",
      links: meta.links || {},
      ownedByUser: true,
      ...meta,
    });

    // we want cleaning + inventory to refresh right away
    if (isBrowser) {
      window.dispatchEvent(
        new CustomEvent("cooking:reverse:created", { detail: { session } })
      );
    }

    return session;
  }

  /**
   * Save as user favorite
   */
  async saveSessionAsFavorite(session) {
    return this.engine.saveAsFavorite(session);
  }

  /**
   * Schedule a cooking/batch session
   */
  async scheduleCookingSession(sessionId, scheduleDef) {
    // let the engine tag it & emit automation:schedule:register
    const updated = await this.engine.scheduleSession(sessionId, scheduleDef);

    // also register directly with the shared scheduler
    await this.scheduler.register({
      ...scheduleDef,
      domain: "cooking",
      sessionId,
      userOwned: updated?.ownedByUser ?? true,
    });

    return updated;
  }

  /**
   * List cooking sessions
   */
  async listSessions(filter = {}) {
    return this.engine.list({ filter });
  }

  /**
   * Mark done
   */
  async completeSession(sessionId) {
    return this.engine.updateStatus(sessionId, "done");
  }

  /* ------------------------------------------------------------------------ */
  /* UI-friendly shortcuts                                                     */
  /* ------------------------------------------------------------------------ */

  /**
   * Quick: “Cook from what’s expiring”
   */
  async createFromExpiringInventory(items = []) {
    return this.createSessionFromReverse(
      {
        fromInventory: items.map((it) => ({
          ...it,
          reason: it.reason || "expiring-soon",
        })),
      },
      {
        label: "Expiring items → Cook now",
      }
    );
  }

  /**
   * Quick: “Cook today’s meals”
   * pass in the meals the user picked on the Meals page
   */
  async createFromTodayMeals(meals = []) {
    return this.createSessionFromReverse(
      {
        fromMeals: meals,
      },
      {
        label: "Today’s Meals → Cooking Session",
      }
    );
  }

  /**
   * Quick: “Garden harvest day” → cook/preserve
   */
  async createFromGardenDay(harvests = []) {
    return this.createSessionFromReverse(
      {
        fromGarden: harvests,
      },
      {
        label: "Garden Harvest → Cook / Preserve",
      }
    );
  }

  /**
   * Quick: “Animal processing day” → cook some now
   */
  async createFromAnimalProcessing(products = []) {
    return this.createSessionFromReverse(
      {
        fromAnimals: products,
      },
      {
        label: "Fresh Animal Products → Cook",
      }
    );
  }
}

/* -------------------------------------------------------------------------- */
/* singleton                                                                  */
/* -------------------------------------------------------------------------- */
let __cookingSessionService;
export const getCookingSessionService = () => {
  if (!__cookingSessionService) {
    __cookingSessionService = new CookingSessionService();
  }
  return __cookingSessionService;
};
