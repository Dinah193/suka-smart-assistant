// C:\Users\larho\suka-smart-assistant\src\domain\meals\MealSessionGenerator.js
// Builds cooking sessions from recipes or imports selected by user.
// -----------------------------------------------------------------------------
// HOW THIS FITS THE PIPELINE
// imports (recipe / cleaning / garden / animal / storehouse / video)
//   → ImportService → normalized payloads → stored in intelligence layer
//   → MealPlanner (user picks meals / days)
//   → MealSessionGenerator (THIS FILE) turns plan/intelligence into
//       actionable cooking sessions (batch, day-by-day, cuisine, preservation-attach)
//   → emits events to automation/runtime
//   → if familyFundMode=true, also exports to Hub
//
// GOALS
// - Forward-thinking: supports future domains (preservation, animal, storehouse).
// - Event-driven: emits { type, ts, source, data } with ISO timestamps
// - Defensive: validates inputs, returns early if bad
// - Automated: can be called by UI or by automation.runtime
// - Reverse generation: we ALSO allow generating from imported items directly,
//   not only from MealPlanner plans
//
// ASSUMPTIONS
// - eventBus exists at src/services/eventBus.js
// - featureFlags.json exists and includes "familyFundMode"
// - HubPacketFormatter + FamilyFundConnector exist and are importable
// - A SessionStore / dataGateway exists to persist session records
// - InventoryMapper exists to map ingredients → inventory/storehouse items
// - Yield curves & substitutions (torah, low_storehouse, etc.) are applied
//   downstream by InventoryMapper or in here via small helper
//
// API (public)
//   generateFromPlan(plan, options?)
//   generateFromImports(importsArray, options?)
//   generateSingleSession(mealsArray, options?)
//   onSessionExecuted(sessionId, actuals)
//     → used by runtime when a user marks a session "done"
//
// The generated "session" shape (baseline):
// {
//   id: "sess_xxx",
//   ts: "2025-11-02T02:00:00.000Z",
//   domain: "meals",
//   source: "domain.meals.MealSessionGenerator",
//   planId: "plan_...?",               // optional
//   title: "Saturday Batch Cook",
//   tasks: [ { step, recipeId, duration, ingredientsNeeded, equipment, ... } ],
//   ingredients: [ { name, qty, unit, inventoryLink?, substitution? } ],
//   schedule: { start, estimatedEnd, policy: "batch-by-day" },
//   meta: { cuisine, seasonality, fromGarden, fromAnimal, fromStorehouse },
//   status: "pending" | "in-progress" | "completed"
// }

import eventBus from "../../services/eventBus";
import featureFlags from "../../config/featureFlags.json";
import { formatMealSessionForHub } from "../../services/HubPacketFormatter";
import FamilyFundConnector from "../../services/FamilyFundConnector";

// Defensive soft imports – you already have engines/stores for meals
let SessionStore;
let InventoryMapper;
let PreservationLinker;
try {
  // Optional: SSA may or may not have these wired yet
  SessionStore = require("./MealSessionStore.js");
} catch (e) {
  SessionStore = null;
}
try {
  InventoryMapper = require("../../services/inventory/InventoryMapper.js");
} catch (e) {
  InventoryMapper = null;
}
try {
  PreservationLinker = require("../preservation/PreservationLinker.js");
} catch (e) {
  PreservationLinker = null;
}

const SOURCE_ID = "domain.meals.MealSessionGenerator";

const MealSessionGenerator = {
  /**
   * Generate cooking sessions from a saved meal plan.
   * @param {Object} plan - meal plan, shape: { id, items: [{title, ingredients, day, mealType, ...}] }
   * @param {Object} options - { policy: "batch-by-day"|"one-per-meal"|"cuisine", attachPreservation: true|false }
   * @returns {Promise<Array>} generated sessions
   */
  async generateFromPlan(plan, options = {}) {
    if (!plan || !Array.isArray(plan.items)) {
      console.warn("[MealSessionGenerator] generateFromPlan: invalid plan");
      return [];
    }

    const policy = options.policy || "batch-by-day";
    const attachPreservation = options.attachPreservation ?? true;

    // 1. Group meals according to policy
    const groupedMeals = groupMeals(plan.items, policy);

    // 2. For each group, create a session
    const sessions = [];
    for (const group of groupedMeals) {
      const session = await buildSessionFromMeals(group, {
        planId: plan.id,
        policy,
        attachPreservation,
      });
      sessions.push(session);
    }

    // 3. Persist + emit
    for (const s of sessions) {
      const persisted = await persistSession(s);
      const evt = emitEvent("meal.session.generated", { session: persisted });
      // optional hub
      await exportToHubIfEnabled(evt);
    }

    return sessions;
  },

  /**
   * Generate sessions directly from normalized imports
   * (reverse generation).
   * Example: user imported 3 recipes from Allrecipes + 1 from TikTok,
   * they select them and click "Generate session".
   * @param {Array} importsArray
   * @param {Object} options
   * @returns {Promise<Array>}
   */
  async generateFromImports(importsArray, options = {}) {
    if (!Array.isArray(importsArray) || !importsArray.length) {
      console.warn("[MealSessionGenerator] generateFromImports: empty imports");
      return [];
    }

    const meals = importsArray
      .map((imp) => normalizeImportToMeal(imp))
      .filter(Boolean);

    return this.generateSingleSession(meals, {
      ...options,
      source: "imports.direct",
    });
  },

  /**
   * Generate ONE session from an array of meal-like objects.
   * @param {Array} meals
   * @param {Object} options
   * @returns {Promise<Array>} array with single session
   */
  async generateSingleSession(meals, options = {}) {
    if (!Array.isArray(meals) || !meals.length) {
      console.warn("[MealSessionGenerator] generateSingleSession: no meals");
      return [];
    }

    const session = await buildSessionFromMeals(meals, {
      planId: options.planId || null,
      policy: options.policy || "single-batch",
      attachPreservation: options.attachPreservation ?? true,
      source: options.source || "ui.single-session",
    });

    const persisted = await persistSession(session);
    const evt = emitEvent("meal.session.generated", { session: persisted });
    await exportToHubIfEnabled(evt);

    return [persisted];
  },

  /**
   * Runtime calls this when a session is actually executed (fully or partially).
   * This is where we can also emit meal.executed and trigger inventory.updated,
   * preservation.completed, etc.
   * @param {string} sessionId
   * @param {Object} actuals - e.g. { completedTasks, usedIngredients, notes }
   */
  async onSessionExecuted(sessionId, actuals = {}) {
    // lightweight; assume SessionStore has markExecuted
    let session = null;
    if (SessionStore && typeof SessionStore.markExecuted === "function") {
      session = await SessionStore.markExecuted(sessionId, actuals);
    }

    // emit meal.executed
    const evt = emitEvent("meal.executed", {
      sessionId,
      actuals,
      session,
    });

    // inventory update event (if actuals contain usedIngredients)
    if (actuals && Array.isArray(actuals.usedIngredients) && actuals.usedIngredients.length) {
      const invEvt = emitEvent("inventory.updated", {
        sourceSessionId: sessionId,
        deltas: actuals.usedIngredients.map((ing) => ({
          item: ing.inventoryLink || ing.name,
          qty: ing.qty,
          unit: ing.unit,
          direction: "decrement",
        })),
      });
      await exportToHubIfEnabled(invEvt);
    }

    // optional: preservation completed
    if (actuals && Array.isArray(actuals.preservation) && actuals.preservation.length) {
      const presEvt = emitEvent("preservation.completed", {
        sessionId,
        items: actuals.preservation,
      });
      await exportToHubIfEnabled(presEvt);
    }

    // also export executed meal to Hub
    await exportToHubIfEnabled(evt);
  },
};

// -----------------------------------------------------------------------------
// INTERNAL HELPERS
// -----------------------------------------------------------------------------

/**
 * Group meals according to selected policy.
 * "batch-by-day": group by meal.day
 * "one-per-meal": each meal is its own session
 * "cuisine": group by cuisine tag, fallback to one batch
 */
function groupMeals(meals, policy) {
  if (!Array.isArray(meals) || !meals.length) return [];

  if (policy === "one-per-meal") {
    return meals.map((m) => [m]);
  }

  if (policy === "cuisine") {
    const map = {};
    meals.forEach((m) => {
      const key = (m.tags && m.tags.find((t) => t.startsWith("cuisine:"))) || "cuisine:default";
      if (!map[key]) map[key] = [];
      map[key].push(m);
    });
    return Object.values(map);
  }

  // default: batch-by-day
  const map = {};
  meals.forEach((m) => {
    const day = m.day || "Unassigned";
    if (!map[day]) map[day] = [];
    map[day].push(m);
  });
  return Object.values(map);
}

/**
 * Build a single session object from meal array.
 * @param {Array} meals
 * @param {Object} ctx
 * @returns {Promise<Object>}
 */
async function buildSessionFromMeals(meals, ctx = {}) {
  const id = makeId("sess");
  const nowIso = new Date().toISOString();
  const planId = ctx.planId || null;

  // 1. Consolidate ingredients
  const ingredients = consolidateIngredients(meals);

  // 2. Map to inventory/storehouse (if mapper available)
  let mappedIngredients = ingredients;
  if (InventoryMapper && typeof InventoryMapper.mapIngredients === "function") {
    try {
      mappedIngredients = await InventoryMapper.mapIngredients(ingredients, {
        allowSubstitutions: true,
        domains: ["storehouse", "inventory", "garden", "animal"],
      });
    } catch (e) {
      console.warn("[MealSessionGenerator] InventoryMapper failed, using raw ingredients", e);
    }
  }

  // 3. Build tasks
  const tasks = buildTasks(meals);

  // 4. Optionally attach preservation (e.g., auto-suggest "can broth", "dehydrate herbs")
  let preservation = [];
  if (ctx.attachPreservation && PreservationLinker && typeof PreservationLinker.link === "function") {
    try {
      preservation = await PreservationLinker.link(meals, mappedIngredients);
    } catch (e) {
      console.warn("[MealSessionGenerator] PreservationLinker failed", e);
    }
  }

  // 5. Build final session object
  const session = {
    id,
    ts: nowIso,
    domain: "meals",
    source: SOURCE_ID,
    planId,
    title: makeSessionTitle(meals, ctx.policy),
    tasks,
    ingredients: mappedIngredients,
    schedule: {
      start: nowIso,
      estimatedEnd: estimateEndTime(nowIso, tasks),
      policy: ctx.policy || "batch-by-day",
    },
    meta: buildMeta(meals, preservation, ctx),
    preservation,
    status: "pending",
  };

  return session;
}

/**
 * Consolidate ingredients from all meals into a single list.
 * Tries to merge same-name, same-unit ingredients.
 */
function consolidateIngredients(meals) {
  const map = {};
  meals.forEach((meal) => {
    const list = meal.ingredients || [];
    list.forEach((ing) => {
      const key = (ing.name || "").toLowerCase() + "|" + (ing.unit || "");
      if (!map[key]) {
        map[key] = {
          name: ing.name,
          qty: Number(ing.qty) || 0,
          unit: ing.unit || "",
          mealRefs: [meal.title],
        };
      } else {
        map[key].qty += Number(ing.qty) || 0;
        map[key].mealRefs.push(meal.title);
      }
    });
  });
  return Object.values(map);
}

/**
 * Build a step/task list from meals.
 * Very simple starter — can be expanded to real task-graph generation.
 */
function buildTasks(meals) {
  const tasks = [];
  meals.forEach((meal, idx) => {
    tasks.push({
      id: makeId("task"),
      order: idx + 1,
      label: `Cook: ${meal.title}`,
      recipeId: meal.sourceId || null,
      duration: meal.estimatedDuration || 30, // minutes
      ingredientsNeeded: meal.ingredients || [],
      equipment: meal.equipment || [],
      tags: meal.tags || [],
    });
  });
  return tasks;
}

/**
 * Estimate end time based on # of tasks and durations.
 */
function estimateEndTime(startIso, tasks) {
  const start = new Date(startIso).getTime();
  const totalMinutes =
    tasks.reduce((sum, t) => sum + (Number(t.duration) || 0), 0) || 30;
  const end = start + totalMinutes * 60 * 1000;
  return new Date(end).toISOString();
}

/**
 * Build session title based on policy/meals.
 */
function makeSessionTitle(meals, policy) {
  if (policy === "one-per-meal" && meals.length === 1) {
    return `Cook: ${meals[0].title}`;
  }
  if (policy === "cuisine") {
    const cuisineTag =
      meals.find((m) => m.tags && m.tags.find((t) => t.startsWith("cuisine:")))
        ?.tags?.find((t) => t.startsWith("cuisine:")) || "Mixed";
    return `Batch Cook — ${cuisineTag.replace("cuisine:", "")}`;
  }
  const day = meals[0]?.day || "Batch";
  return `Batch Cook — ${day}`;
}

/**
 * Build meta info: cuisines, domains, preservation links.
 */
function buildMeta(meals, preservation, ctx) {
  const cuisines = new Set();
  const days = new Set();
  const domains = new Set(["meals"]);
  meals.forEach((m) => {
    (m.tags || [])
      .filter((t) => t.startsWith("cuisine:"))
      .forEach((t) => cuisines.add(t.replace("cuisine:", "")));
    if (m.day) days.add(m.day);
    if (m.fromGarden) domains.add("garden");
    if (m.fromAnimal) domains.add("animal");
    if (m.fromStorehouse) domains.add("storehouse");
  });

  if (preservation && preservation.length) {
    domains.add("preservation");
  }

  return {
    cuisines: Array.from(cuisines),
    days: Array.from(days),
    domains: Array.from(domains),
    policy: ctx.policy || "batch-by-day",
  };
}

/**
 * Persist a session using SessionStore or fallback to memory.
 */
async function persistSession(session) {
  if (SessionStore && typeof SessionStore.save === "function") {
    try {
      await SessionStore.save(session);
      return session;
    } catch (e) {
      console.warn("[MealSessionGenerator] persistSession failed, returning session only", e);
      return session;
    }
  }
  // fallback
  return session;
}

/**
 * Emit an SSA event in consistent shape.
 */
function emitEvent(type, data) {
  const payload = {
    type,
    ts: new Date().toISOString(),
    source: SOURCE_ID,
    data,
  };
  if (eventBus && typeof eventBus.emit === "function") {
    eventBus.emit(type, payload);
  } else {
    console.warn("[MealSessionGenerator] eventBus not available for", type);
  }
  return payload;
}

/**
 * Optional Hub export.
 */
async function exportToHubIfEnabled(evtPayload) {
  try {
    if (!featureFlags?.familyFundMode) return;
    if (!evtPayload) return;
    const packet = formatMealSessionForHub(evtPayload);
    if (!packet) return;
    await FamilyFundConnector.send(packet);
  } catch (e) {
    // silent fail – Hub is optional
    console.warn("[MealSessionGenerator] Hub export failed (silent)", e);
  }
}

/**
 * Normalize a general import (recipe, video/how-to, garden w/ recipe, etc.)
 * into a "meal-like" object.
 */
function normalizeImportToMeal(imp) {
  if (!imp) return null;
  // If it’s already a meal-like shape
  if (imp.title && (imp.ingredients || imp.steps)) {
    return {
      id: imp.id || makeId("meal"),
      title: imp.title,
      ingredients: imp.ingredients || [],
      equipment: imp.equipment || [],
      tags: imp.tags || [],
      day: imp.day || "Unassigned",
      mealType: imp.mealType || "dinner",
      sourceId: imp.url || imp.sourceId || null,
      estimatedDuration: imp.estimatedDuration || 30,
      fromGarden: imp.fromGarden || false,
      fromAnimal: imp.fromAnimal || false,
      fromStorehouse: imp.fromStorehouse || false,
    };
  }

  // Fallback normalization
  return {
    id: makeId("meal"),
    title: imp.name || "Imported Meal",
    ingredients: [],
    equipment: [],
    tags: ["imported"],
    day: "Unassigned",
    mealType: "dinner",
    sourceId: imp.url || null,
  };
}

function makeId(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

export default MealSessionGenerator;
