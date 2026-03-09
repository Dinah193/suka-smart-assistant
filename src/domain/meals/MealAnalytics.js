// C:\Users\larho\suka-smart-assistant\src\domain\meals\MealAnalytics.js
// Tracks meals cooked from imports vs local recipes, ingredients, cuisine type, equipment, utensils, etc.
// -----------------------------------------------------------------------------
// ROLE IN SSA PIPELINE
// imports (recipe / cleaning / garden / animal / storehouse / video)
//   → ImportService → normalized records
//   → MealPlanner / MealSessionGenerator builds actionable meal sessions
//   → user / automation executes session → meal.executed
//   → MealAnalytics (THIS FILE) listens to events and aggregates intelligence:
//       - how many meals came from IMPORTS vs LOCAL recipes
//       - which cuisines are cooked most often
//       - which ingredients are most used (for inventory + storehouse signals)
//       - which equipment/utensils are used (for maintenance/planning)
//   → emits "analytics.meals.updated" so dashboards (HouseholdAnalytics.jsx) can refresh
//   → IF familyFundMode=true, we also export aggregated household meal intel to Hub
//
// IMPORTANT
// - SSA and SVFFH are separate. This file runs fine even without Hub.
// - Event-driven: subscribes to eventBus in init()
// - Defensive: all inputs are validated, fallbacks exist
// - Forward-thinking: supports future domains (preservation, animal, storehouse)
// - Every emitted payload has shape: { type, ts, source, data } with ISO timestamps
//
// ASSUMPTIONS
// - src/services/events/eventBus.js exists
// - src/config/featureFlags.json exists
// - src/services/hub/HubPacketFormatter.js exports formatMealAnalyticsForHub
// - src/services/hub/FamilyFundConnector.js exists
// - src/services/dataGateway.js or local Dexie store can be used (we soft-import)

import eventBus from "../../services/events/eventBus";
import featureFlags from "@/config/featureFlags.json";
import { formatMealAnalyticsForHub } from "@/services/hub/HubPacketFormatter";
import FamilyFundConnector from "@/services/hub/FamilyFundConnector";

let dataGateway = null;
try {
  // try to soft-load your data gateway
  // should have methods like save(domain, key, payload) and load(domain, key)
  // or be Dexie-backed
  // eslint-disable-next-line global-require
  dataGateway = require("../../services/dataGateway.js").default;
} catch (e) {
  // optional
}

const SOURCE_ID = "domain.meals.MealAnalytics";

// in-memory baseline so SSA can run fully offline
const DEFAULT_STATE = {
  // counts
  totalMealsExecuted: 0,
  fromImports: 0,
  fromLocal: 0,
  fromGarden: 0,
  fromAnimal: 0,
  fromStorehouse: 0,
  fromPreservation: 0,

  // maps
  cuisineCounts: {}, // { "Mediterranean": 5, "Soul": 10 }
  ingredientCounts: {}, // { "onion|cup": 12, "lamb|lb": 3 }
  equipmentCounts: {}, // { "dutch-oven": 4, "airfryer": 2 }
  utensilCounts: {}, // { "ladle": 7 }

  // last updated ISO
  lastUpdated: null,
};

// a single in-memory instance
let _state = { ...DEFAULT_STATE };

const MealAnalytics = {
  /**
   * Initialize listeners. Call once from app startup.
   * Subscribes to:
   *  - meal.executed → core signal for analytics
   *  - import.parsed → so we can attribute future meals to import sources
   *  - meal.session.generated → so we know "planned" meals vs "executed"
   */
  async init() {
    // load persisted state if available
    const loaded = await safeLoadState();
    if (loaded) {
      _state = {
        ...DEFAULT_STATE,
        ...loaded,
      };
    }

    eventBus?.on?.("meal.executed", handleMealExecuted);
    eventBus?.on?.("import.parsed", handleImportParsed);
    eventBus?.on?.("meal.session.generated", handleSessionGenerated);

    // emit initial state so analytics dashboards can show something
    emitEvent("analytics.meals.updated", { snapshot: getSnapshot() });
  },

  /**
   * Return the current analytics snapshot (no mutation).
   */
  getSnapshot() {
    return getSnapshot();
  },

  /**
   * Reset analytics (useful for tests or user request).
   */
  async reset() {
    _state = { ...DEFAULT_STATE, lastUpdated: new Date().toISOString() };
    await safePersistState(_state);
    const evt = emitEvent("analytics.meals.updated", {
      snapshot: getSnapshot(),
    });
    await exportToHubIfEnabled(evt);
  },
};

// -----------------------------------------------------------------------------
// EVENT HANDLERS
// -----------------------------------------------------------------------------

/**
 * meal.executed handler
 * payload shape from MealSessionGenerator.onSessionExecuted:
 * {
 *   type: "meal.executed",
 *   ts: "...",
 *   source: "...",
 *   data: {
 *     sessionId,
 *     actuals: {
 *       completedTasks,
 *       usedIngredients: [{ name, qty, unit, inventoryLink, fromImport, fromGarden, fromAnimal, fromStorehouse }],
 *       notes,
 *     },
 *     session, // optional full session
 *   }
 * }
 */
async function handleMealExecuted(evt) {
  const data = evt?.data;
  if (!data) return;

  const actuals = data.actuals || {};
  const session = data.session || {};

  // 1. bump total meals
  _state.totalMealsExecuted += 1;

  // 2. detect if meal came from import or local
  const isFromImport = detectImportedMeal(session, actuals);
  if (isFromImport) _state.fromImports += 1;
  else _state.fromLocal += 1;

  // 3. ingredient analytics
  if (Array.isArray(actuals.usedIngredients)) {
    actuals.usedIngredients.forEach((ing) => {
      bumpIngredient(ing);

      // cross-domain flags
      if (ing.fromGarden) _state.fromGarden += 1;
      if (ing.fromAnimal) _state.fromAnimal += 1;
      if (ing.fromStorehouse) _state.fromStorehouse += 1;
      if (ing.fromPreservation) _state.fromPreservation += 1;
    });
  } else {
    // if no actuals, we can fallback to session ingredients
    if (Array.isArray(session.ingredients)) {
      session.ingredients.forEach((ing) => bumpIngredient(ing));
    }
  }

  // 4. cuisine analytics
  bumpCuisinesFromSession(session);

  // 5. equipment/utensils analytics
  bumpEquipFromSession(session);

  // 6. persist + emit
  _state.lastUpdated = new Date().toISOString();
  await safePersistState(_state);

  const evtOut = emitEvent("analytics.meals.updated", {
    snapshot: getSnapshot(),
    reason: "meal.executed",
    sessionId: data.sessionId,
  });

  // 7. optional Hub export
  await exportToHubIfEnabled(evtOut);
}

/**
 * import.parsed handler
 * Even though analytics is meal-focused, we want to keep a hint of
 * what import sources we have so we can better attribute executed meals later.
 *
 * evt.data: { domain, normalized, sourceUrl?, sourceSite?, intelligence? }
 */
async function handleImportParsed(evt) {
  const d = evt?.data;
  if (!d) return;

  // We won't store full imports here — that belongs to intelligence layer.
  // But we can prime cuisine / equipment frequencies if they’re obvious.
  if (d.normalized) {
    const guessCuisines =
      d.normalized.tags?.filter((t) => t.startsWith("cuisine:")) || [];
    guessCuisines.forEach((tag) => {
      const c = tag.replace("cuisine:", "");
      bumpCuisine(c);
    });

    // prime equipment
    (d.normalized.equipment || []).forEach((eq) => bumpEquipment(eq));

    _state.lastUpdated = new Date().toISOString();
    await safePersistState(_state);
    emitEvent("analytics.meals.updated", {
      snapshot: getSnapshot(),
      reason: "import.parsed",
    });
  }
}

/**
 * meal.session.generated handler
 * We don't increase executed counts here, but we COULD track planned vs executed.
 * That helps you later: "we planned 20 meals, executed 14"
 */
async function handleSessionGenerated(evt) {
  const sess = evt?.data?.session;
  if (!sess) return;

  // we can pre-bump cuisine/equipment to get a better "planned" view
  bumpCuisinesFromSession(sess);
  bumpEquipFromSession(sess);

  _state.lastUpdated = new Date().toISOString();
  await safePersistState(_state);

  emitEvent("analytics.meals.updated", {
    snapshot: getSnapshot(),
    reason: "meal.session.generated",
  });
}

// -----------------------------------------------------------------------------
// CORE MUTATION HELPERS
// -----------------------------------------------------------------------------

function detectImportedMeal(session, actuals) {
  // Several ways to tell an imported meal:
  // 1. session.meta.domains includes "imports" or "video"
  // 2. actuals.usedIngredients contain { fromImport: true }
  // 3. session.tasks contain recipeId that looks like a URL
  if (session?.meta?.domains?.includes?.("imports")) return true;
  if (Array.isArray(actuals?.usedIngredients)) {
    if (actuals.usedIngredients.some((ing) => ing.fromImport)) {
      return true;
    }
  }
  if (Array.isArray(session?.tasks)) {
    if (session.tasks.some((t) => isProbablyImportId(t.recipeId))) {
      return true;
    }
  }
  return false;
}

function isProbablyImportId(recipeId) {
  if (!recipeId) return false;
  // naive detection: URL-ish → from import
  return recipeId.startsWith("http://") || recipeId.startsWith("https://");
}

function bumpIngredient(ing = {}) {
  const name = (ing.name || "").trim().toLowerCase();
  if (!name) return;
  const unit = (ing.unit || "").trim().toLowerCase();
  const key = name + "|" + unit;
  if (!_state.ingredientCounts[key]) _state.ingredientCounts[key] = 0;
  _state.ingredientCounts[key] += Number(ing.qty) || 1;
}

function bumpCuisinesFromSession(session = {}) {
  const metaCuisines = session.meta?.cuisines;
  if (Array.isArray(metaCuisines) && metaCuisines.length) {
    metaCuisines.forEach((c) => bumpCuisine(c));
  } else {
    // fallback: look at tasks tags
    if (Array.isArray(session.tasks)) {
      session.tasks.forEach((t) => {
        (t.tags || [])
          .filter((tag) => tag.startsWith("cuisine:"))
          .forEach((tag) => bumpCuisine(tag.replace("cuisine:", "")));
      });
    }
  }
}

function bumpCuisine(cuisine) {
  if (!cuisine) return;
  const key = cuisine.trim();
  if (!_state.cuisineCounts[key]) _state.cuisineCounts[key] = 0;
  _state.cuisineCounts[key] += 1;
}

function bumpEquipFromSession(session = {}) {
  // tasks-equipment
  if (Array.isArray(session.tasks)) {
    session.tasks.forEach((t) => {
      (t.equipment || []).forEach((eq) => bumpEquipment(eq));
      (t.utensils || []).forEach((ut) => bumpUtensil(ut));
    });
  }
  // session-level equipment
  (session.equipment || []).forEach((eq) => bumpEquipment(eq));
  (session.utensils || []).forEach((ut) => bumpUtensil(ut));
}

function bumpEquipment(eq) {
  if (!eq) return;
  const key = eq.trim().toLowerCase();
  if (!_state.equipmentCounts[key]) _state.equipmentCounts[key] = 0;
  _state.equipmentCounts[key] += 1;
}

function bumpUtensil(ut) {
  if (!ut) return;
  const key = ut.trim().toLowerCase();
  if (!_state.utensilCounts[key]) _state.utensilCounts[key] = 0;
  _state.utensilCounts[key] += 1;
}

// -----------------------------------------------------------------------------
// PERSISTENCE + EXPORT
// -----------------------------------------------------------------------------

function getSnapshot() {
  return {
    ..._state,
    // extra analytics:
    ratios: {
      importVsLocal: calcRatio(_state.fromImports, _state.fromLocal),
      gardenHitRate: calcRatio(_state.fromGarden, _state.totalMealsExecuted),
      animalHitRate: calcRatio(_state.fromAnimal, _state.totalMealsExecuted),
      storehouseHitRate: calcRatio(
        _state.fromStorehouse,
        _state.totalMealsExecuted
      ),
    },
  };
}

function calcRatio(part, total) {
  if (!total) return 0;
  return Number((part / total).toFixed(3));
}

async function safePersistState(state) {
  if (!dataGateway) return;
  try {
    await dataGateway.save("analytics", "meals", state);
  } catch (e) {
    console.warn("[MealAnalytics] safePersistState failed", e);
  }
}

async function safeLoadState() {
  if (!dataGateway) return null;
  try {
    const s = await dataGateway.load("analytics", "meals");
    return s || null;
  } catch (e) {
    console.warn("[MealAnalytics] safeLoadState failed", e);
    return null;
  }
}

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
    console.warn("[MealAnalytics] eventBus not available for", type);
  }
  return payload;
}

async function exportToHubIfEnabled(evtPayload) {
  try {
    if (!featureFlags?.familyFundMode) return;
    if (!evtPayload) return;
    const packet = formatMealAnalyticsForHub(evtPayload);
    if (!packet) return;
    await FamilyFundConnector.send(packet);
  } catch (e) {
    // Hub is optional – fail silently
    console.warn("[MealAnalytics] Hub export failed (silent)", e);
  }
}

export default MealAnalytics;
