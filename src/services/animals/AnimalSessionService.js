// src/services/animals/AnimalSessionService.js
/* eslint-disable no-console */

/**
 * AnimalSessionService
 * -----------------------------------------------------------------------------
 * Animal / livestock equivalent of your Cleaning/Garden/Inventory services.
 *
 * Must handle:
 *  - daily/weekly animal care (feed, water, muck, health checks)
 *  - breeding plans (pairing, gestation watch, farrowing/kidding/lambing dates)
 *  - butchering / processing sessions (and tell Inventory/Garden to update)
 *  - milk/egg collection (and tell Inventory to receive)
 *  - reverse generation:
 *      meals/storehouse → "we need X lbs lamb/beef/goat" → schedule butchering
 *      garden → "plant forage/fodder" (we emit to garden as refresh; garden service can create reverse session)
 *  - user-owned favorite sessions + schedules
 */

import { SessionEngineCore } from "@/engines/shared/SessionEngineCore";
import { getSessionScheduler } from "@/services/scheduling/SessionScheduler";

// tiny utils
const genTaskId = () => `animal_task_${Math.random().toString(36).slice(2)}`;
const isBrowser = typeof window !== "undefined";

/* -------------------------------------------------------------------------- */
/* animal actions / categories                                                */
/* -------------------------------------------------------------------------- */
const ANIMAL_ACTIONS = {
  FEED: "feed",
  WATER: "water",
  CLEAN_STALL: "clean-stall",
  HEALTH_CHECK: "health-check",
  BREED: "breed",
  PREGNANCY_CHECK: "pregnancy-check",
  BIRTHING: "birthing",
  WEIGH: "weigh",
  RECORD: "record",
  BUTCHER: "butcher",
  PROCESS: "process",
  COLLECT_MILK: "collect-milk",
  COLLECT_EGGS: "collect-eggs",
  MOVE_TO_INVENTORY: "move-to-inventory",
  REQUEST_FODDER: "request-fodder",
  PLAN_WITH_OTHERS: "plan-with-others",
  COOP_ALLOCATE: "coop-allocate",
};

/**
 * Optional: simple geography-based animal suggestion.
 * In your earlier chats you said “add in meat animal estimates and breeds that will work
 * well for the geographical location.”
 *
 * We keep this super light here; you can expand in a separate data file.
 */
const suggestAnimalsForLocation = (location = "US-Southeast") => {
  const lower = (location || "").toLowerCase();
  if (lower.includes("alabama") || lower.includes("florida") || lower.includes("georgia")) {
    return [
      { species: "goat", breed: "Kiko", purpose: "meat" },
      { species: "sheep", breed: "Katahdin", purpose: "meat/hair" },
      { species: "chicken", breed: "Red Ranger", purpose: "meat" },
    ];
  }
  // fallback
  return [
    { species: "chicken", breed: "Dual Purpose", purpose: "eggs/meat" },
    { species: "goat", breed: "Mixed", purpose: "milk/meat" },
  ];
};

/* -------------------------------------------------------------------------- */
/* engine                                                                     */
/* -------------------------------------------------------------------------- */
class AnimalSessionEngine extends SessionEngineCore {
  constructor(opts = {}) {
    super({
      domainName: "animals",
      sessionTableName: "animalSessions",
      ...opts,
    });
  }

  /**
   * FORWARD GENERATION
   * ---------------------------------------------------------------------------
   * sourcePayload can look like:
   * {
   *   label?: "Daily Animal Care"
   *   location?: "Jackson County, FL"
   *   herds?: [
   *     { name: "Goats", actions: ["FEED","WATER","CLEAN_STALL"], count: 12 },
   *     { name: "Sheep", actions: ["FEED","WATER"], breed: "Katahdin" }
   *   ]
   *   breeding?: [
   *     { pair: ["Buck #1","Doe #3"], due?: "2025-01-15" }
   *   ]
   *   processing?: [
   *     { animal: "Ram #4", weightEst: 85, product: "lamb" }
   *   ]
   *   coop?: { households: [...], sharedGoal: { product: "lamb", qty: 8 } }
   * }
   */
  async buildTasksFromSource(sourcePayload = {}) {
    const tasks = [];

    // 1) care per herd
    const herds = Array.isArray(sourcePayload.herds) ? sourcePayload.herds : [];
    herds.forEach((herd) => {
      const herdActions = Array.isArray(herd.actions) ? herd.actions : ["FEED", "WATER"];
      herdActions.forEach((actionCode) => {
        tasks.push({
          id: genTaskId(),
          action: ANIMAL_ACTIONS[actionCode] || actionCode.toLowerCase(),
          herd: herd.name,
          count: herd.count ?? null,
          breed: herd.breed || null,
          source: "plan",
          notes: herd.notes || "",
        });
      });
    });

    // 2) breeding plans
    if (Array.isArray(sourcePayload.breeding)) {
      sourcePayload.breeding.forEach((bp) => {
        tasks.push({
          id: genTaskId(),
          action: ANIMAL_ACTIONS.BREED,
          herd: bp.herd || null,
          pair: bp.pair || null,
          due: bp.due || null,
          source: "plan:breeding",
          notes: "Pair for breeding; track gestation.",
        });
        if (bp.due) {
          tasks.push({
            id: genTaskId(),
            action: ANIMAL_ACTIONS.BIRTHING,
            herd: bp.herd || null,
            source: "plan:breeding",
            notes: `Prepare for birthing around ${bp.due}`,
          });
        }
      });
    }

    // 3) processing/butchering
    if (Array.isArray(sourcePayload.processing)) {
      sourcePayload.processing.forEach((proc) => {
        tasks.push({
          id: genTaskId(),
          action: ANIMAL_ACTIONS.BUTCHER,
          animal: proc.animal,
          weightEst: proc.weightEst || null,
          product: proc.product || null,
          source: "plan:processing",
          notes: "Schedule butchering / coordinate with meat facility.",
        });
        tasks.push({
          id: genTaskId(),
          action: ANIMAL_ACTIONS.PROCESS,
          animal: proc.animal,
          product: proc.product || null,
          source: "plan:processing",
          notes: "Breakdown, package, label.",
        });
        tasks.push({
          id: genTaskId(),
          action: ANIMAL_ACTIONS.MOVE_TO_INVENTORY,
          product: proc.product || "meat",
          source: "plan:processing",
          notes: "Send to inventory/storehouse (freezer, cold room).",
        });
      });
    }

    // 4) co-op / plan with other households
    if (sourcePayload.coop?.households?.length) {
      tasks.push({
        id: genTaskId(),
        action: ANIMAL_ACTIONS.PLAN_WITH_OTHERS,
        source: "plan:coop",
        notes: `Plan animal care with: ${sourcePayload.coop.households.join(", ")}`,
      });
      if (sourcePayload.coop.sharedGoal) {
        tasks.push({
          id: genTaskId(),
          action: ANIMAL_ACTIONS.COOP_ALLOCATE,
          source: "plan:coop",
          sharedGoal: sourcePayload.coop.sharedGoal,
          notes: `Co-op livestock goal: ${sourcePayload.coop.sharedGoal.product} → ${sourcePayload.coop.sharedGoal.qty}`,
        });
      }
    }

    // 5) location-based recommendations
    if (sourcePayload.location) {
      const suggested = suggestAnimalsForLocation(sourcePayload.location);
      suggested.forEach((entry) => {
        tasks.push({
          id: genTaskId(),
          action: ANIMAL_ACTIONS.RECORD,
          source: "plan:location",
          notes: `Suggested for ${sourcePayload.location}: ${entry.breed} ${entry.species} (${entry.purpose})`,
        });
      });
    }

    return tasks;
  }

  /**
   * REVERSE GENERATION
   * ---------------------------------------------------------------------------
   * Accepts demand from other domains and turns it into animal actions.
   *
   * reversePayload examples:
   * {
   *   fromMeals: [{ meat: "lamb", qty: 2, unit: "carcass" }],
   *   fromStorehouse: [{ product: "lamb", neededQty: 60, unit: "lb" }],
   *   fromGarden: [{ forage: "alfalfa", qty: 50 }],         // -> request-fodder
   *   coop: { households: [...], product: "goat", qty: 4 }  // -> coop allocate
   * }
   */
  async buildTasksFromReverse(reversePayload = {}) {
    const tasks = [];

    // 1) meals need meat → schedule butchering
    if (Array.isArray(reversePayload.fromMeals)) {
      reversePayload.fromMeals.forEach((meal) => {
        tasks.push({
          id: genTaskId(),
          action: ANIMAL_ACTIONS.BUTCHER,
          animal: meal.meat || "lamb",
          qty: meal.qty ?? 1,
          unit: meal.unit || "carcass",
          source: "reverse:meals",
          notes: "Meal plan requires meat → butcher.",
        });
        tasks.push({
          id: genTaskId(),
          action: ANIMAL_ACTIONS.MOVE_TO_INVENTORY,
          product: meal.meat || "lamb",
          source: "reverse:meals",
          notes: "Send cuts to inventory / freezer.",
        });
      });
    }

    // 2) storehouse says we are short on meat → plan processing/breeding
    if (Array.isArray(reversePayload.fromStorehouse)) {
      reversePayload.fromStorehouse.forEach((need) => {
        tasks.push({
          id: genTaskId(),
          action: ANIMAL_ACTIONS.BUTCHER,
          animal: need.product || "lamb",
          qty: need.neededQty ?? null,
          unit: need.unit || "lb",
          source: "reverse:storehouse",
          notes: "Storehouse short → process animals.",
        });
        // optional breeding to replenish herd after butchering
        tasks.push({
          id: genTaskId(),
          action: ANIMAL_ACTIONS.BREED,
          source: "reverse:storehouse",
          notes: "Rebreed to maintain herd after processing.",
        });
      });
    }

    // 3) garden can supply forage, but we need to request it
    if (Array.isArray(reversePayload.fromGarden)) {
      reversePayload.fromGarden.forEach((g) => {
        tasks.push({
          id: genTaskId(),
          action: ANIMAL_ACTIONS.REQUEST_FODDER,
          source: "reverse:garden",
          notes: `Request forage/fodder: ${g.forage || "forage-mix"} ${g.qty ? `(${g.qty})` : ""}`,
        });
      });
    }

    // 4) co-op livestock production
    if (reversePayload.coop?.households?.length && reversePayload.coop.product) {
      tasks.push({
        id: genTaskId(),
        action: ANIMAL_ACTIONS.COOP_ALLOCATE,
        source: "reverse:coop",
        sharedGoal: {
          product: reversePayload.coop.product,
          qty: reversePayload.coop.qty || 0,
          households: reversePayload.coop.households,
        },
        notes: "Co-op reverse livestock plan.",
      });
    }

    return tasks;
  }
}

/* -------------------------------------------------------------------------- */
/* service façade                                                             */
/* -------------------------------------------------------------------------- */
class AnimalSessionService {
  constructor() {
    this.engine = new AnimalSessionEngine();
    this.scheduler = getSessionScheduler();
  }

  /**
   * Create from a normal animal care / breeding / processing plan
   */
  async createSessionFromPlan(plan = {}) {
    const session = await this.engine.createFromSource(plan, {
      source: "plan",
      label: plan.label || "Animal Session",
      links: plan.links || {},
      ownedByUser: true,
      meta: {
        location: plan.location || null,
        coop: plan.coop || null,
      },
    });
    return session;
  }

  /**
   * Create from reverse (demand from meals/storehouse/garden/co-op)
   */
  async createSessionFromReverse(reversePayload = {}, meta = {}) {
    const session = await this.engine.createFromReverse(reversePayload, {
      label: meta.label || "Reverse-generated Animal Session",
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
   * Schedule it (user or system)
   * scheduleDef is the same JSON we used in SessionScheduler.js
   */
  async scheduleAnimalSession(sessionId, scheduleDef) {
    // engine will emit automation:schedule:register
    const updated = await this.engine.scheduleSession(sessionId, scheduleDef);
    // we can also directly register with the scheduler for good measure
    await this.scheduler.register({
      ...scheduleDef,
      domain: "animals",
      sessionId,
      userOwned: updated?.ownedByUser ?? true,
    });
    return updated;
  }

  /**
   * List sessions
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

  // Daily care template
  async createDailyCare(location = null) {
    const base = await this.createSessionFromPlan({
      label: "Daily Animal Care",
      location,
      herds: [
        { name: "Goats", actions: ["FEED", "WATER"] },
        { name: "Sheep", actions: ["FEED", "WATER"] },
        { name: "Chickens", actions: ["FEED", "WATER"] },
      ],
    });
    return base;
  }

  // Butchering / processing template
  async createProcessingSession(animals = []) {
    const base = await this.createSessionFromPlan({
      label: "Processing / Butchering",
      processing: animals.map((a) => ({
        animal: a.name || a,
        weightEst: a.weightEst || null,
        product: a.product || "meat",
      })),
    });
    return base;
  }

  // Reverse: meal plan says we need meat
  async createFromMealDemand(mealDemand = []) {
    return this.createSessionFromReverse({ fromMeals: mealDemand }, {
      label: "Animals for Meal Demand",
    });
  }
}

/* -------------------------------------------------------------------------- */
/* singleton                                                                  */
/* -------------------------------------------------------------------------- */
let __animalSessionService;
export const getAnimalSessionService = () => {
  if (!__animalSessionService) {
    __animalSessionService = new AnimalSessionService();
  }
  return __animalSessionService;
};
