// src/automation/events.js

// Webhook paths in n8n (append to N8N_WEBHOOK_BASE)
export const N8N_PATHS = {
  MEAL_REFRESH: "meal/refresh",
  COOKING_DISPATCH: "cooking/dispatch",
  GARDEN_HARVEST: "garden/harvest-window",
  SOIL_WATER: "garden/soil-water",
  ANIMAL_PLAN: "animals/plan",
};

// App-side event types
export const CookingEvents = {
  SESSION_START: "cooking.session.start",
  SESSION_PAUSE: "cooking.session.pause",
  STEP_START: "cooking.step.start",
  STEP_DONE: "cooking.step.done",
  SESSION_DONE: "cooking.session.done",
};
