// src/services/cleaning/CleaningSessionService.js
/* eslint-disable no-console */

/**
 * CleaningSessionService
 * -----------------------------------------------------------------------------
 * Service wrapper around the shared SessionEngineCore specialized for CLEANING.
 * This is the cleaning equivalent of your inventory session engine.
 *
 * Goals from project chats:
 *  - Cleaning must be schedulable (one-time or recurring)
 *  - Cleaning sessions must update other pages when generated (meals, inventory,
 *    gardening, animal care) because cleaning often consumes supplies or frees
 *    up rooms/equipment for those domains
 *  - Users must be able to SAVE *their* favorite sessions/schedules
 *    (not just system templates)
 *  - Must support REVERSE generation:
 *      e.g. batch cooking / animal processing / gardening → auto make
 *      a “clean this, sanitize that, take out compost, restock supplies”
 *      cleaning session
 *  - Must stay event-driven with the same event names you’ve been using
 */

import { SessionEngineCore } from "@/engines/shared/SessionEngineCore";
import { getSessionScheduler } from "@/services/scheduling/SessionScheduler";

// tiny utils
const isBrowser = typeof window !== "undefined";
const genTaskId = () => `clean_task_${Math.random().toString(36).slice(2)}`;

/**
 * Map from your common cleaning verbs to normalized actions
 * so UI can show nice icons/badges like well-executed dashboards do.
 */
const CLEANING_ACTIONS = {
  SWEEP: "sweep",
  MOP: "mop",
  WIPE: "wipe-down",
  SANITIZE: "sanitize",
  DECLUTTER: "declutter",
  LAUNDRY: "laundry",
  BATHROOM: "clean-bathroom",
  KITCHEN: "clean-kitchen",
  DUST: "dust",
  TRASH: "take-out-trash",
  INVENTORY: "reconcile-cleaning-supplies",
};

const ROOM_DEFAULTS = ["Kitchen", "Bathroom", "Living Room", "Entryway", "Laundry", "Pantry"];

/**
 * Actual cleaning engine – extends the shared core
 */
class CleaningSessionEngine extends SessionEngineCore {
  constructor(opts = {}) {
    super({
      domainName: "cleaning",
      sessionTableName: "cleaningSessions",
      ...opts,
    });
  }

  /**
   * FORWARD GENERATION
   * ---------------------------------------------------------------------------
   * Build cleaning tasks from a “cleaning plan” style payload. This is for
   * your standard flows:
   *  - user picked zones/rooms
   *  - user picked frequency
   *  - system suggested tasks (daily reset, weekly deep clean, Sabbath prep)
   *
   * sourcePayload shape we support here:
   * {
   *   label?: string
   *   rooms?: [{ name: "Kitchen", tasks: ["SWEEP","MOP","SANITIZE"], notes? }]
   *   frequency?: "daily"|"weekly"|"monthly"
   *   supplies?: [{ name, qty, unit, location }]
   * }
   */
  async buildTasksFromSource(sourcePayload = {}) {
    const tasks = [];
    const rooms = Array.isArray(sourcePayload.rooms) && sourcePayload.rooms.length
      ? sourcePayload.rooms
      : ROOM_DEFAULTS.map((name) => ({ name, tasks: [] }));

    rooms.forEach((room) => {
      const roomTasks = Array.isArray(room.tasks) ? room.tasks : [];
      if (roomTasks.length === 0) {
        // default “reset” task
        tasks.push({
          id: genTaskId(),
          action: CLEANING_ACTIONS.DECLUTTER,
          room: room.name,
          notes: room.notes || "",
          source: "plan",
        });
      } else {
        roomTasks.forEach((actionCode) => {
          tasks.push({
            id: genTaskId(),
            action: CLEANING_ACTIONS[actionCode] || actionCode.toLowerCase(),
            room: room.name,
            notes: room.notes || "",
            source: "plan",
          });
        });
      }
    });

    // if the plan identified supplies to check (e.g. homemade cleaner, soap, vinegar)
    if (Array.isArray(sourcePayload.supplies)) {
      sourcePayload.supplies.forEach((supply) => {
        tasks.push({
          id: genTaskId(),
          action: CLEANING_ACTIONS.INVENTORY,
          item: supply.name,
          qty: supply.qty ?? 1,
          unit: supply.unit || "ea",
          location: supply.location || "laundry",
          source: "plan",
          notes: "Check / mix / refill this supply.",
        });
      });
    }

    return tasks;
  }

  /**
   * REVERSE GENERATION
   * ---------------------------------------------------------------------------
   * You said:
   *  - “This is also needed for Cleaning, Gardening, Animal Care and Inventory.”
   *  - “The things that are generated on the home page need to update the appropriate
   *     other pages, like meal planning, animal care, cleaning, and cooking”
   *
   * So here we take NON-cleaning domain events and turn them into cleaning tasks.
   *
   * reversePayload can look like:
   * {
   *   fromMeals: [{ title, kitchenImpact?: true, dishes?: true }]
   *   fromBatchCooking: [{ station: "kitchen"|"outdoor"|"butchering", heavy?: true }]
   *   fromAnimals: [{ area: "butchering-room"|"barn"|"pens", sanitize?: true }]
   *   fromGarden: [{ area: "mudroom"|"wash-station" }]
   *   fromInventory: [{ area: "pantry", spilled?: true }]
   * }
   */
  async buildTasksFromReverse(reversePayload = {}) {
    const tasks = [];

    // 1) Meals / Batch Cooking → clean kitchen, sanitize, dishes
    if (Array.isArray(reversePayload.fromMeals)) {
      reversePayload.fromMeals.forEach((meal) => {
        tasks.push({
          id: genTaskId(),
          action: CLEANING_ACTIONS.KITCHEN,
          room: "Kitchen",
          source: "reverse:meal",
          notes: meal.title ? `After meal: ${meal.title}` : "Post-meal cleanup",
        });
        if (meal.dishes) {
          tasks.push({
            id: genTaskId(),
            action: "dishes",
            room: "Kitchen",
            source: "reverse:meal",
            notes: "Wash / load / put away dishes",
          });
        }
      });
    }

    if (Array.isArray(reversePayload.fromBatchCooking)) {
      reversePayload.fromBatchCooking.forEach((session) => {
        tasks.push({
          id: genTaskId(),
          action: CLEANING_ACTIONS.SANITIZE,
          room: session.station === "butchering" ? "Butchering Room" : "Kitchen",
          source: "reverse:batch-cooking",
          notes: session.heavy
            ? "Heavy session → sanitize counters, floors, and tools."
            : "Sanitize cooking surfaces.",
        });
        tasks.push({
          id: genTaskId(),
          action: CLEANING_ACTIONS.TRASH,
          room: "Kitchen",
          source: "reverse:batch-cooking",
          notes: "Take out trash / compost from cooking session.",
        });
      });
    }

    // 2) Animals → sanitize butchering / barn area
    if (Array.isArray(reversePayload.fromAnimals)) {
      reversePayload.fromAnimals.forEach((animalEvt) => {
        tasks.push({
          id: genTaskId(),
          action: animalEvt.sanitize
            ? CLEANING_ACTIONS.SANITIZE
            : CLEANING_ACTIONS.DECLUTTER,
          room: animalEvt.area || "Butchering Room",
          source: "reverse:animals",
          notes: "Post-animal-processing cleanup.",
        });
      });
    }

    // 3) Garden → mudroom / wash station cleanup
    if (Array.isArray(reversePayload.fromGarden)) {
      reversePayload.fromGarden.forEach((gEvt) => {
        tasks.push({
          id: genTaskId(),
          action: CLEANING_ACTIONS.MOP,
          room: gEvt.area || "Mudroom",
          source: "reverse:garden",
          notes: "Clean up after bringing in harvest / soil.",
        });
      });
    }

    // 4) Inventory / pantry spill → spot clean
    if (Array.isArray(reversePayload.fromInventory)) {
      reversePayload.fromInventory.forEach((invEvt) => {
        if (invEvt.spilled) {
          tasks.push({
            id: genTaskId(),
            action: CLEANING_ACTIONS.WIPE,
            room: invEvt.area || "Pantry",
            source: "reverse:inventory",
            notes: "Clean spilled item in pantry/inventory area.",
          });
        }
      });
    }

    return tasks;
  }
}

/**
 * Service façade – this is what your pages/components will import.
 * Keeps the API nice and small and consistent with other services.
 */
class CleaningSessionService {
  constructor() {
    this.engine = new CleaningSessionEngine();
    this.scheduler = getSessionScheduler();
  }

  /**
   * Create from a normal cleaning plan (forward)
   */
  async createSessionFromPlan(plan = {}) {
    const session = await this.engine.createFromSource(plan, {
      source: "plan",
      label: plan.label || "Cleaning Session",
      links: plan.links || {},
      ownedByUser: true,
    });
    return session;
  }

  /**
   * Create from reverse (after cooking/garden/animals/inventory)
   */
  async createSessionFromReverse(reversePayload = {}, meta = {}) {
    const session = await this.engine.createFromReverse(reversePayload, {
      label: meta.label || "Post-Activity Cleaning",
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
   * Schedule a cleaning session (user or system)
   * scheduleDef is the same shape we used in SessionScheduler.js
   */
  async scheduleCleaningSession(sessionId, scheduleDef) {
    // let the engine tag the session & emit automation:schedule:register
    const updated = await this.engine.scheduleSession(sessionId, scheduleDef);
    // scheduler will pick up the emitted event, but we can also register directly:
    await this.scheduler.register({
      ...scheduleDef,
      domain: "cleaning",
      sessionId,
      userOwned: updated?.ownedByUser ?? true,
    });
    return updated;
  }

  /**
   * List existing cleaning sessions
   */
  async listSessions(filter = {}) {
    return this.engine.list({ filter });
  }

  /**
   * Mark session done
   */
  async completeSession(sessionId) {
    return this.engine.updateStatus(sessionId, "done");
  }

  /**
   * SHORTCUTS for UI
   * ---------------------------------------------------------------------------
   * Common patterns to make your screens more like well executed websites:
   *  - “Daily Reset”
   *  - “Sabbath / Feast Prep”
   *  - “After Batch Cooking”
   *  - “After Guests”
   * These are just quick creators that UI can show as chips/cards.
   */
  async createDailyReset() {
    return this.createSessionFromPlan({
      label: "Daily Reset",
      frequency: "daily",
      rooms: [
        { name: "Kitchen", tasks: ["WIPE", "TRASH"] },
        { name: "Living Room", tasks: ["DECLUTTER", "DUST"] },
        { name: "Entryway", tasks: ["SWEEP"] },
      ],
    });
  }

  async createSabbathPrep() {
    return this.createSessionFromPlan({
      label: "Sabbath / Feast Prep",
      frequency: "weekly",
      rooms: [
        { name: "Kitchen", tasks: ["WIPE", "SANITIZE", "TRASH"] },
        { name: "Bathroom", tasks: ["BATHROOM"] },
        { name: "Living Room", tasks: ["DECLUTTER", "DUST"] },
      ],
      supplies: [
        { name: "All-purpose cleaner", qty: 1, unit: "bottle" },
        { name: "Paper towels", qty: 1, unit: "roll" },
      ],
    });
  }
}

/* -------------------------------------------------------------------------- */
/* singleton                                                                  */
/* -------------------------------------------------------------------------- */
let __cleaningSessionService;
export const getCleaningSessionService = () => {
  if (!__cleaningSessionService) {
    __cleaningSessionService = new CleaningSessionService();
  }
  return __cleaningSessionService;
};
