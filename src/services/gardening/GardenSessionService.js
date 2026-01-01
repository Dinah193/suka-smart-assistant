// src/services/gardening/GardenSessionService.js
/* eslint-disable no-console */

/**
 * GardenSessionService
 * -----------------------------------------------------------------------------
 * Garden equivalent of CleaningSessionService / InventorySessionEngine, but:
 *  - understands seed → plan → plant → harvest chains
 *  - understands co-op / multi-household goals (your “many hands make light work”)
 *  - can reverse-generate FROM meals, storehouse goals, or even animal feed needs
 *  - can be scheduled and saved as user-owned favorites
 *
 * Built on top of:
 *  - src/engines/shared/SessionEngineCore.js
 *  - src/services/scheduling/SessionScheduler.js
 */

import { SessionEngineCore } from "@/engines/shared/SessionEngineCore";
import { getSessionScheduler } from "@/services/scheduling/SessionScheduler";

const isBrowser = typeof window !== "undefined";
const genTaskId = () => `garden_task_${Math.random().toString(36).slice(2)}`;

// common gardening actions we can show as chips/badges in UI
const GARDEN_ACTIONS = {
  START_SEEDS: "start-seeds",
  TRANSPLANT: "transplant",
  DIRECT_SOW: "direct-sow",
  WATER: "water",
  FERTILIZE: "fertilize",
  WEED: "weed",
  PRUNE: "prune",
  HARVEST: "harvest",
  PRESERVE: "preserve",
  MOVE_TO_STOREHOUSE: "move-to-storehouse",
  SYNC_TO_INVENTORY: "sync-to-inventory",
  CLEAN_TOOLS: "clean-tools",
  PLAN_WITH_OTHERS: "plan-with-others",
  COOP_ALLOCATE: "coop-allocate",
};

// fallback zones
const DEFAULT_BEDS = ["Bed A", "Bed B", "Greenhouse", "Orchard"];

/**
 * Garden engine based on SessionEngineCore
 */
class GardenSessionEngine extends SessionEngineCore {
  constructor(opts = {}) {
    super({
      domainName: "garden",
      sessionTableName: "gardenSessions",
      ...opts,
    });
  }

  /**
   * FORWARD GENERATION
   * ---------------------------------------------------------------------------
   * Build tasks from a garden plan or seed import.
   *
   * sourcePayload can look like:
   * {
   *   label?: "Spring Planting"
   *   season?: "spring" | "summer" | "fall" | "winter"
   *   zone?: "8a"
   *   beds?: [{ name: "Bed A", crops: [{ name, method: "transplant"|"direct-sow", qty, spacing }] }]
   *   seeds?: [{ sku, name, method, qty, targetBed }]
   *   coop?: {
   *     households: ["houseA","houseB"],
   *     sharedGoal: { crop: "Tomato", totalQty: 60, perHousehold?: 15 }
   *   }
   * }
   */
  async buildTasksFromSource(sourcePayload = {}) {
    const tasks = [];

    const beds = Array.isArray(sourcePayload.beds) && sourcePayload.beds.length
      ? sourcePayload.beds
      : DEFAULT_BEDS.map((name) => ({ name, crops: [] }));

    // 1) beds/crops → plant/transplant/sow tasks
    beds.forEach((bed) => {
      const crops = Array.isArray(bed.crops) ? bed.crops : [];
      if (crops.length === 0) {
        // allow a generic “prepare bed” task so UI has something to show
        tasks.push({
          id: genTaskId(),
          action: GARDEN_ACTIONS.WEED,
          bed: bed.name,
          source: "plan",
          notes: "Prepare bed for upcoming planting.",
        });
      } else {
        crops.forEach((crop) => {
          const method = crop.method || "transplant";
          const action =
            method === "direct-sow"
              ? GARDEN_ACTIONS.DIRECT_SOW
              : method === "start-seeds"
                ? GARDEN_ACTIONS.START_SEEDS
                : GARDEN_ACTIONS.TRANSPLANT;
          tasks.push({
            id: genTaskId(),
            action,
            bed: bed.name,
            crop: crop.name,
            qty: crop.qty ?? 1,
            spacing: crop.spacing || null,
            source: "plan",
            notes: crop.notes || "",
          });
        });
      }
    });

    // 2) seeds array (from bookmarklet / seed-pack scan) → start-seeds/direct-sow
    if (Array.isArray(sourcePayload.seeds)) {
      sourcePayload.seeds.forEach((seed) => {
        tasks.push({
          id: genTaskId(),
          action:
            seed.method === "direct-sow"
              ? GARDEN_ACTIONS.DIRECT_SOW
              : GARDEN_ACTIONS.START_SEEDS,
          bed: seed.targetBed || "Seedling Station",
          crop: seed.name || seed.sku || "Unknown seed",
          qty: seed.qty ?? 1,
          source: "plan:seeds",
          notes: "Imported from seed packet / bookmarklet.",
        });
      });
    }

    // 3) co-op / plan with others
    if (sourcePayload.coop?.households?.length) {
      tasks.push({
        id: genTaskId(),
        action: GARDEN_ACTIONS.PLAN_WITH_OTHERS,
        source: "plan:coop",
        notes: `Plan with: ${sourcePayload.coop.households.join(", ")}`,
      });

      if (sourcePayload.coop.sharedGoal) {
        tasks.push({
          id: genTaskId(),
          action: GARDEN_ACTIONS.COOP_ALLOCATE,
          source: "plan:coop",
          sharedGoal: sourcePayload.coop.sharedGoal,
          notes: `Co-op goal: ${sourcePayload.coop.sharedGoal.crop} → ${sourcePayload.coop.sharedGoal.totalQty}`,
        });
      }
    }

    // 4) general maintenance per season
    if (sourcePayload.season) {
      tasks.push({
        id: genTaskId(),
        action: GARDEN_ACTIONS.WATER,
        source: "plan:season",
        notes: `Watering schedule for ${sourcePayload.season} in zone ${sourcePayload.zone || "?"}`,
      });
      tasks.push({
        id: genTaskId(),
        action: GARDEN_ACTIONS.FERTILIZE,
        source: "plan:season",
        notes: `Fertilize per ${sourcePayload.season} plan.`,
      });
    }

    return tasks;
  }

  /**
   * REVERSE GENERATION
   * ---------------------------------------------------------------------------
   * Garden is a bridge for you:
   *  - From meals: “we use tomatoes, onions, herbs → grow more”
   *  - From storehouse: “we want 200 jars of tomato sauce → plant enough tomatoes”
   *  - From animals: “we need fodder / forage → plant X beds”
   *  - From community co-op: “I’ll grow tomatoes for everybody → create session”
   *
   * reversePayload shape:
   * {
   *   fromMeals: [{ ingredients: [{ name, qty, unit }], cuisine? }]
   *   fromStorehouse: [{ item: "Tomato", neededQty: 100, unit: "lb" }]
   *   fromAnimals: [{ forage: "alfalfa", qty: 50, unit: "lb" }]
   *   coop: { households: [...], crop: "Tomato", totalQty: 80 }
   * }
   */
  async buildTasksFromReverse(reversePayload = {}) {
    const tasks = [];

    // 1) meals → grow frequently used crops/herbs
    if (Array.isArray(reversePayload.fromMeals)) {
      reversePayload.fromMeals.forEach((meal) => {
        const ings = Array.isArray(meal.ingredients)
          ? meal.ingredients
          : [];
        ings.forEach((ing) => {
          tasks.push({
            id: genTaskId(),
            action: GARDEN_ACTIONS.DIRECT_SOW, // default to direct-sow for herbs/greens
            bed: "Kitchen / Herb Bed",
            crop: ing.name,
            qty: ings.length > 3 ? 2 : 1, // simple heuristic
            source: "reverse:meals",
            notes: `Meal uses this often → plant more. Meal: ${meal.title || "untitled"}`,
          });
        });
      });
    }

    // 2) storehouse → plant enough to hit storage goals
    if (Array.isArray(reversePayload.fromStorehouse)) {
      reversePayload.fromStorehouse.forEach((goal) => {
        tasks.push({
          id: genTaskId(),
          action: GARDEN_ACTIONS.DIRECT_SOW,
          bed: "Field / High Yield",
          crop: goal.item,
          qty: goal.neededQty ? Math.ceil(goal.neededQty / 5) : 5, // heuristic
          source: "reverse:storehouse",
          notes: "Plant to fulfill storehouse preservation goal.",
        });
        tasks.push({
          id: genTaskId(),
          action: GARDEN_ACTIONS.HARVEST,
          crop: goal.item,
          source: "reverse:storehouse",
          notes: "Schedule harvest for preservation.",
        });
        tasks.push({
          id: genTaskId(),
          action: GARDEN_ACTIONS.PRESERVE,
          crop: goal.item,
          source: "reverse:storehouse",
          notes: "Send to canning/dehydrating/freezing workflow.",
        });
        tasks.push({
          id: genTaskId(),
          action: GARDEN_ACTIONS.SYNC_TO_INVENTORY,
          crop: goal.item,
          source: "reverse:storehouse",
          notes: "Add preserved item to inventory/storehouse.",
        });
      });
    }

    // 3) animals → forage/fodder beds
    if (Array.isArray(reversePayload.fromAnimals)) {
      reversePayload.fromAnimals.forEach((feed) => {
        tasks.push({
          id: genTaskId(),
          action: GARDEN_ACTIONS.DIRECT_SOW,
          bed: "Fodder Bed",
          crop: feed.forage || "forage-mix",
          qty: feed.qty ?? 1,
          source: "reverse:animals",
          notes: "Plant feed/fodder to reduce purchase costs.",
        });
      });
    }

    // 4) co-op
    if (reversePayload.coop?.households?.length && reversePayload.coop.crop) {
      tasks.push({
        id: genTaskId(),
        action: GARDEN_ACTIONS.COOP_ALLOCATE,
        source: "reverse:coop",
        sharedGoal: {
          crop: reversePayload.coop.crop,
          totalQty: reversePayload.coop.totalQty || 0,
          households: reversePayload.coop.households,
        },
        notes: "Co-op reverse plan: distribute crop responsibilities.",
      });
    }

    return tasks;
  }
}

/**
 * Service façade – what your components/pages should import.
 */
class GardenSessionService {
  constructor() {
    this.engine = new GardenSessionEngine();
    this.scheduler = getSessionScheduler();
  }

  /**
   * Create from a normal garden plan (forward)
   */
  async createSessionFromPlan(plan = {}) {
    const session = await this.engine.createFromSource(plan, {
      source: "plan",
      label: plan.label || "Garden Session",
      links: plan.links || {},
      ownedByUser: true,
      meta: {
        season: plan.season,
        zone: plan.zone,
        coop: plan.coop || null,
      },
    });
    return session;
  }

  /**
   * Create from reverse (meals → grow, storehouse → plant, animals → fodder)
   */
  async createSessionFromReverse(reversePayload = {}, meta = {}) {
    const session = await this.engine.createFromReverse(reversePayload, {
      label: meta.label || "Reverse-generated Garden Session",
      links: meta.links || {},
      ownedByUser: true,
      ...meta,
    });
    return session;
  }

  /**
   * Save as user's favorite
   */
  async saveSessionAsFavorite(session) {
    return this.engine.saveAsFavorite(session);
  }

  /**
   * Schedule a garden session (user/system)
   * scheduleDef uses the shared scheduler shape
   */
  async scheduleGardenSession(sessionId, scheduleDef) {
    const updated = await this.engine.scheduleSession(sessionId, scheduleDef);
    // register directly with the shared scheduler as well
    await this.scheduler.register({
      ...scheduleDef,
      domain: "garden",
      sessionId,
      userOwned: updated?.ownedByUser ?? true,
    });
    return updated;
  }

  /**
   * List existing garden sessions
   */
  async listSessions(filter = {}) {
    return this.engine.list({ filter });
  }

  /**
   * Mark garden session completed
   */
  async completeSession(sessionId) {
    return this.engine.updateStatus(sessionId, "done");
  }

  /* ------------------------------------------------------------------------ */
  /* UI-friendly shortcuts                                                     */
  /* ------------------------------------------------------------------------ */

  /**
   * Quick “Spring Planting” template
   */
  async createSpringPlanting(zone = "8a") {
    return this.createSessionFromPlan({
      label: "Spring Planting",
      season: "spring",
      zone,
      beds: [
        {
          name: "Bed A",
          crops: [
            { name: "Tomato", method: "transplant", qty: 6 },
            { name: "Basil", method: "direct-sow", qty: 12 },
          ],
        },
        {
          name: "Bed B",
          crops: [
            { name: "Squash", method: "transplant", qty: 4 },
            { name: "Cucumber", method: "direct-sow", qty: 6 },
          ],
        },
      ],
    });
  }

  /**
   * Quick “Harvest & Preserve” template – because you said garden tools
   * should sync harvest data to inventory & schedule.
   */
  async createHarvestAndPreserve(crop = "Tomato") {
    return this.createSessionFromPlan({
      label: `Harvest & Preserve – ${crop}`,
      season: null,
      beds: [],
      // directly create the post-harvest chain
      seeds: [],
      // we can simulate as if this came from reverse storehouse
      links: { storehouseGoalId: null },
      // engine will add WATER/FERTILIZE defaults if needed
    }).then(async (session) => {
      // add extra tasks to the session (harvest → preserve → inventory)
      const enriched = {
        ...session,
        tasks: [
          ...(session.tasks || []),
          {
            id: genTaskId(),
            action: GARDEN_ACTIONS.HARVEST,
            crop,
            source: "template",
            notes: "Harvest ripe produce.",
          },
          {
            id: genTaskId(),
            action: GARDEN_ACTIONS.PRESERVE,
            crop,
            source: "template",
            notes: "Can / dehydrate / freeze.",
          },
          {
            id: genTaskId(),
            action: GARDEN_ACTIONS.SYNC_TO_INVENTORY,
            crop,
            source: "template",
            notes: "Sync to inventory & storehouse.",
          },
        ],
      };
      // persist enriched session
      await this.engine["_persist"](enriched); // safe enough in your codebase pattern
      return enriched;
    });
  }
}

/* -------------------------------------------------------------------------- */
/* singleton                                                                  */
/* -------------------------------------------------------------------------- */
let __gardenSessionService;
export const getGardenSessionService = () => {
  if (!__gardenSessionService) {
    __gardenSessionService = new GardenSessionService();
  }
  return __gardenSessionService;
};
