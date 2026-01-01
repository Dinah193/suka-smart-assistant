/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\services\nutrition\nutritionEvents.js
//
// Nutrition Events: constants + payload contracts + safe emit/subscribe helpers
// -----------------------------------------------------------------------------
// Purpose:
// - Centralize event names so all tools publish/subscribe consistently
// - Provide canonical payload "contracts" (JS doc typedefs) used across SSA
// - Offer defensive emit/on helpers with soft-import eventBus paths
//
// SSA rules:
// - No TypeScript
// - Defensive imports
// - Standalone safe (no hard dependency on Hub)
// -----------------------------------------------------------------------------

/* -------------------------------------------------------------------------- */
/* Event name constants                                                       */
/* -------------------------------------------------------------------------- */

export const NUTRITION_EVENTS = Object.freeze({
  // selection
  ACTIVE_PERSON_CHANGED: "nutrition.activePerson.changed",

  // canonical preference / targets updates
  TARGETS_UPDATED: "nutrition.targets.updated",
  CONSTRAINTS_UPDATED: "nutrition.constraints.updated",

  // tool computations
  BMI_COMPUTED: "nutrition.bmi.computed",
  MACROS_COMPUTED: "nutrition.macros.computed",
  MICROS_COMPUTED: "nutrition.micros.computed",

  // audit/logging
  TOOLRUN_LOGGED: "nutrition.toolrun.logged",

  // optional common profile update event (often used by tools)
  PROFILE_UPDATED: "nutrition.profile.updated",

  // bridge to meal planner (your store emits this when targets/constraints change)
  MEALPLAN_PREFERENCES_APPLIED: "mealplan.preferences.applied",
});

/* -------------------------------------------------------------------------- */
/* Canonical Data Contracts (JSDoc typedefs)                                   */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} PersonProfile
 * @property {string} id
 * @property {string|null} householdId
 * @property {string} name
 * @property {"female"|"male"|"other"|"unknown"|string} sex
 * @property {number|null} age
 * @property {number|null} heightCm
 * @property {number|null} weightKg
 * @property {"sedentary"|"light"|"moderate"|"active"|"very_active"|string} activityLevel
 * @property {string} updatedAt   ISO timestamp
 */

/**
 * @typedef {Object} DietConstraints
 * @property {boolean} porkFree
 * @property {boolean} glutenFree
 * @property {boolean} dairyFree
 * @property {boolean} lowCarb
 * @property {boolean} vegetarian
 * @property {boolean} vegan
 * @property {Object.<string, boolean>} custom
 */

/**
 * @typedef {Object} Allergens
 * @property {boolean} peanuts
 * @property {boolean} treeNuts
 * @property {boolean} shellfish
 * @property {boolean} fish
 * @property {boolean} eggs
 * @property {boolean} soy
 * @property {boolean} wheat
 * @property {boolean} milk
 * @property {Object.<string, boolean>} custom
 */

/**
 * NutritionTargets (canonical)
 * - caloriesKcal: number|null
 * - macros: grams per day
 * - micros: keyed nutrient targets (units embedded in keys)
 *
 * @typedef {Object} NutritionTargets
 * @property {number|null} caloriesKcal
 * @property {{proteinG:number|null, carbsG:number|null, fatG:number|null, fiberG:number|null}} macros
 * @property {Object.<string, number|null>} micros
 */

/**
 * ToolDerivations (canonical)
 * - tool-specific computed "explanations" / intermediate results
 *
 * @typedef {Object} ToolDerivations
 * @property {Object|null} bmi
 * @property {Object|null} macros
 * @property {Object|null} micros
 * @property {Object.<string, any>} meta
 */

/**
 * Common envelope used by SSA eventBus (matches patterns used in your db.js)
 *
 * @typedef {Object} SsaEventEnvelope
 * @property {string} type
 * @property {string} ts
 * @property {string} source
 * @property {Object} data
 */

/* -------------------------------------------------------------------------- */
/* Event Payload Contracts                                                     */
/* -------------------------------------------------------------------------- */

/**
 * nutrition.activePerson.changed
 * @typedef {Object} ActivePersonChangedPayload
 * @property {string|null} personId
 * @property {string} reason
 */

/**
 * nutrition.targets.updated
 * @typedef {Object} TargetsUpdatedPayload
 * @property {string} personId
 * @property {NutritionTargets} targets
 * @property {"bmi"|"macros"|"micros"|"reset"|"manual"|"unknown"|string} reason
 */

/**
 * nutrition.constraints.updated
 * @typedef {Object} ConstraintsUpdatedPayload
 * @property {string} personId
 * @property {DietConstraints} constraints
 * @property {Allergens} allergens
 */

/**
 * nutrition.toolrun.logged
 * @typedef {Object} ToolrunLoggedPayload
 * @property {string} personId
 * @property {"BMI"|"MACROS"|"MICROS"|"RESET_DEFAULTS"|string} tool
 * @property {string} logId
 * @property {number} [version]
 */

/**
 * mealplan.preferences.applied (bridge event)
 * @typedef {Object} MealplanPreferencesAppliedPayload
 * @property {string} personId
 * @property {string} from
 * @property {NutritionTargets} [targets]
 * @property {DietConstraints} [constraints]
 * @property {Allergens} [allergens]
 * @property {string} ts
 */

/* -------------------------------------------------------------------------- */
/* Defensive soft-import eventBus + helpers                                     */
/* -------------------------------------------------------------------------- */

function nowIso() {
  return new Date().toISOString();
}

let _eventBus = { emit: () => {}, on: () => () => {} };
let _loaded = false;

/**
 * Soft-import eventBus with multiple paths.
 * - @/services/events/eventBus.js
 * - ../../services/events/eventBus
 */
export async function getEventBus() {
  if (_loaded) return _eventBus;
  _loaded = true;

  try {
    // eslint-disable-next-line import/no-unresolved
    const mod = await import("@/services/events/eventBus.js");
    _eventBus = mod?.default || mod?.eventBus || mod || _eventBus;
    return _eventBus;
  } catch {}

  try {
    const mod2 = await import("../../services/events/eventBus");
    _eventBus = mod2?.default || mod2?.eventBus || mod2 || _eventBus;
    return _eventBus;
  } catch {}

  return _eventBus;
}

/**
 * Emit a nutrition-related event using the SSA envelope shape.
 * Never throws.
 *
 * @param {string} type One of NUTRITION_EVENTS.*
 * @param {string} source e.g. "nutritionStore" | "bmi.page" | "macros.page"
 * @param {Object} data payload contract depends on event type
 */
export async function emitNutritionEvent(type, source, data) {
  const eb = await getEventBus();
  if (!eb || typeof eb.emit !== "function") return;

  try {
    eb.emit({
      type,
      ts: nowIso(),
      source: source || "nutrition",
      data: data && typeof data === "object" ? data : {},
    });
  } catch (err) {
    if (import.meta?.env?.DEV) {
      console.warn("[nutritionEvents] emit failed", type, err);
    }
  }
}

/**
 * Subscribe helper (returns unsubscribe).
 * Never throws; returns noop unsubscribe if bus missing.
 *
 * @param {string} type event type string
 * @param {(evt:SsaEventEnvelope)=>void} handler
 * @returns {Promise<() => void>}
 */
export async function onNutritionEvent(type, handler) {
  const eb = await getEventBus();
  if (!eb || typeof eb.on !== "function") return () => {};

  try {
    return eb.on(type, handler);
  } catch {
    return () => {};
  }
}
