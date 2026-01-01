// src/automation/dispatch.js
import {
  emitMealRefresh,
  emitCookingEvent,
  emitHarvestWindow,
  emitSoilWater,
  emitAnimalPlan,
} from "./emitters.js";
import { CookingEvents } from "./events.js";

/**
 * High-level dispatcher so features can fire automations without knowing details.
 * @param {string} kind
 * @param {object} payload
 */
export async function dispatchAutomation(kind, payload) {
  switch (kind) {
    case "meal.refresh":
      return emitMealRefresh(payload);

    case "cooking.session.start":
    case "cooking.session.pause":
    case "cooking.step.start":
    case "cooking.step.done":
    case "cooking.session.done":
      return emitCookingEvent(kind, payload);

    case "garden.harvest-window":
      return emitHarvestWindow(payload);

    case "garden.soil-water":
      return emitSoilWater(payload);

    case "animals.plan":
      return emitAnimalPlan(payload);

    default:
      throw new Error(`Unknown automation kind: ${kind}`);
  }
}

// Convenience exports for cooking events
export const Cooking = {
  start: (p) => emitCookingEvent(CookingEvents.SESSION_START, p),
  pause: (p) => emitCookingEvent(CookingEvents.SESSION_PAUSE, p),
  stepStart: (p) => emitCookingEvent(CookingEvents.STEP_START, p),
  stepDone: (p) => emitCookingEvent(CookingEvents.STEP_DONE, p),
  done: (p) => emitCookingEvent(CookingEvents.SESSION_DONE, p),
};
