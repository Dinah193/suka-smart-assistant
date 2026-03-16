// src/automation/emitters.js
import { N8N_PATHS, CookingEvents } from "./events";
import { sendToN8n } from "./n8nBridge";
import { validate } from "./validate";
import cookingSchema from "./payloadSchemas/cooking.json" assert { type: "json" };
import mealRefreshSchema from "./payloadSchemas/mealplan.refresh.json" assert { type: "json" };
import harvestSchema from "./payloadSchemas/harvest-window.json" assert { type: "json" };
import soilWaterSchema from "./payloadSchemas/soil-water.json" assert { type: "json" };
import animalPlanSchema from "./payloadSchemas/animal-plan.json" assert { type: "json" };

/** Meal planner: ask n8n to generate/refill */
export async function emitMealRefresh({ userId, reason = "recipes-updated" }) {
  const payload = { userId, reason };
  validate(mealRefreshSchema, payload);
  return sendToN8n(N8N_PATHS.MEAL_REFRESH, payload, {
    userId,
    source: "app.mealplanner",
  });
}

/** Cooking sessions: lifecycle + steps */
export async function emitCookingEvent(eventType, payload) {
  if (!Object.values(CookingEvents).includes(eventType)) {
    throw new Error(`Unknown cooking eventType: ${eventType}`);
  }
  const full = { eventType, ...payload };
  validate(cookingSchema, full);
  return sendToN8n(N8N_PATHS.COOKING_DISPATCH, full, {
    userId: payload.userId,
    source: "app.cooking",
  });
}

/** Garden harvest window / preservation sync */
export async function emitHarvestWindow(payload) {
  validate(harvestSchema, payload);
  return sendToN8n(N8N_PATHS.GARDEN_HARVEST, payload, {
    userId: payload.userId,
    source: "app.garden",
  });
}

/** Soil & water keeper (irrigation + amendments) */
export async function emitSoilWater(payload) {
  validate(soilWaterSchema, payload);
  return sendToN8n(N8N_PATHS.SOIL_WATER, payload, {
    userId: payload.userId,
    source: "app.garden",
  });
}

/** Animal care planner */
export async function emitAnimalPlan(payload) {
  validate(animalPlanSchema, payload);
  return sendToN8n(N8N_PATHS.ANIMAL_PLAN, payload, {
    userId: payload.userId,
    source: "app.animals",
  });
}
