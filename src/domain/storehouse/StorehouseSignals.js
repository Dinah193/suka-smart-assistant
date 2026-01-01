// C:\Users\larho\suka-smart-assistant\src\domain\storehouse\StorehouseSignals.js
// Emits storehouse.low events to trigger resupply/production
// AND storehouse.surplus events to trigger trade/barter/gift/sell
// -----------------------------------------------------------------------------
// HOW THIS FITS THE SSA PIPELINE
// imports → ImportService → normalized storehouse / garden / animal / preservation payloads
//   → StorehousePlanner builds long-term targets
//   → InventorySessionEngine adjusts current inventory
//   → StorehouseSignals (THIS FILE) watches the flows and **decides when to talk**
//       - if current < min   → emit storehouse.low
//       - if current > max   → emit storehouse.surplus
//   → automation runtime can:
//       - create restock session (buy/make/preserve)
//       - or create outbound session (trade/barter/gift/sell)
//   → if featureFlags.familyFundMode=true
//       → also export signals to Hub (so the Hub marketplace / co-op can react)
//
// WHY A SEPARATE FILE?
// - keeps “signal logic” out of UI components
// - lets you run it headless (SSA can run by itself)
// - makes it easy to extend to new domains (preservation, animal, storehouse)
// - matches your event-driven pattern { type, ts, source, data }
//
// EVENT SHAPE (outbound):
//   {
//     type: "storehouse.low" | "storehouse.surplus",
//     ts: "2025-11-02T12:00:00.000Z",
//     source: "domain.storehouse.StorehouseSignals",
//     data: {
//       items: [
//         {
//           name, zone, current, min, max?, target?, unit, category, reason
//         }
//       ],
//       from: "inventory.updated" | "storehouse.goal.updated" | "preservation.completed" | ...
//     }
//   }
//
// EXTENSION POINTS
// - registerSourceMapper(domain, fn) to normalize custom domain payloads
// - overrideThresholds(fn) to calculate min/max per item
// -----------------------------------------------------------------------------

import eventBus from "../../services/eventBus";
import featureFlags from "../../config/featureFlags.json";
import { formatStorehouseSignalForHub } from "../../services/HubPacketFormatter";
import FamilyFundConnector from "../../services/FamilyFundConnector";

let StorehousePlanStore = null;

try {
  // eslint-disable-next-line global-require
  StorehousePlanStore = require("../../services/storehouse/StorehousePlanStore.js");
} catch (e) {
  StorehousePlanStore = null;
}

const SOURCE_ID = "domain.storehouse.StorehouseSignals";

// in-memory plan cache so we can compare
let _plan = null;
// extra mappers
const _sourceMappers = new Map();
// optional threshold override
let _thresholdOverride = null;

/**
 * Initialize storehouse signals — call once from your app bootstrap.
 * This will:
 *  - load latest plan (if available)
 *  - attach listeners to key events
 */
async function initStorehouseSignals() {
  _plan = await loadLatestPlan();

  // inventory shifts affect storehouse balances
  eventBus?.on?.("inventory.updated", handleInventoryUpdated);
  // storehouse plan updates affect our thresholds
  eventBus?.on?.("storehouse.goal.updated", handleStorehouseGoalUpdated);
  // preservation adds to storehouse
  eventBus?.on?.("preservation.completed", handlePreservationCompleted);
  // garden harvest might go straight to storehouse
  eventBus?.on?.("garden.harvest.logged", handleGardenHarvestLogged);
  // animal processing can add fats, broths, hides
  eventBus?.on?.("animal.executed", handleAnimalExecuted);
}

/**
 * Register a mapper for a custom source/domain
 * @param {String} domain
 * @param {Function} fn   fn(payload) → [{name, current, unit, category, zone}]
 */
function registerSourceMapper(domain, fn) {
  if (!domain || typeof fn !== "function") return;
  _sourceMappers.set(domain, fn);
}

/**
 * Allow consumer to set threshold override logic
 * @param {Function} fn fn(item, planItem?) → {min, max}
 */
function overrideThresholds(fn) {
  if (typeof fn === "function") {
    _thresholdOverride = fn;
  }
}

// -----------------------------------------------------------------------------
// EVENT HANDLERS
// -----------------------------------------------------------------------------

async function handleInventoryUpdated(payload) {
  const deltas = payload?.data?.deltas;
  if (!Array.isArray(deltas) || !deltas.length) return;

  // Ensure we have plan
  if (!_plan) {
    _plan = await loadLatestPlan();
  }

  const changedItems = deltas.map((d) => ({
    name: d.item,
    qtyChange: d.direction === "decrement" ? -1 * (Number(d.qty) || 0) : Number(d.qty) || 0,
    unit: d.unit || "ea",
    location: d.location || "Pantry",
  }));

  await evaluateAgainstPlan(changedItems, "inventory.updated");
}

async function handleStorehouseGoalUpdated(payload) {
  const items = payload?.data?.items;
  if (Array.isArray(items)) {
    _plan = { items }; // discard old, keep current
  } else {
    // if items missing, reload from store
    _plan = await loadLatestPlan();
  }
  // not emitting here — signals will emit on actual stock changes
}

async function handlePreservationCompleted(payload) {
  const items = payload?.data?.items;
  if (!Array.isArray(items) || !items.length) return;

  // map to storehouse format
  const mapped = items.map((it) => ({
    name: it.name,
    current: Number(it.qty) || 0,
    unit: it.unit || "jar",
    category: "preserved",
    zone: "Preserved Goods",
  }));

  await evaluateRaw(mapped, "preservation.completed");
}

async function handleGardenHarvestLogged(payload) {
  const items = payload?.data?.items;
  if (!Array.isArray(items) || !items.length) return;

  const mapped = items.map((it) => ({
    name: it.crop,
    current: Number(it.qty) || 0,
    unit: it.unit || "ea",
    category: "produce",
    zone: "Root Cellar",
  }));

  await evaluateRaw(mapped, "garden.harvest.logged");
}

async function handleAnimalExecuted(payload) {
  const actuals = payload?.data?.actuals;
  if (!actuals) return;

  const stockChanges = [];

  // byproducts
  if (Array.isArray(actuals.byproducts)) {
    actuals.byproducts.forEach((bp) => {
      stockChanges.push({
        name: bp.name,
        current: Number(bp.qty) || 0,
        unit: bp.unit || "ea",
        category: "animal",
        zone: "Freezer Overflow",
      });
    });
  }

  // fats / broths / heads etc. (future extension)
  if (Array.isArray(actuals.preserved)) {
    actuals.preserved.forEach((pr) => {
      stockChanges.push({
        name: pr.name,
        current: Number(pr.qty) || 0,
        unit: pr.unit || "jar",
        category: "preserved",
        zone: "Preserved Goods",
      });
    });
  }

  if (!stockChanges.length) return;
  await evaluateRaw(stockChanges, "animal.executed");
}

// -----------------------------------------------------------------------------
// CORE EVALUATION
// -----------------------------------------------------------------------------

/**
 * Evaluate changed items (with +- deltas) against the current storehouse plan.
 * @param {Array} changedItems [{name, qtyChange, unit, location}]
 * @param {String} from
 */
async function evaluateAgainstPlan(changedItems, from) {
  if (!Array.isArray(changedItems) || !changedItems.length) return;
  if (!_plan || !Array.isArray(_plan.items)) {
    // no plan, but we can still detect surplus on obvious overflows
    return;
  }

  const lows = [];
  const surpluses = [];

  for (const ch of changedItems) {
    const planItem = findPlanItem(ch.name, ch.location);
    if (!planItem) continue;

    // current qty is planItem.currentQty + delta
    const current = clampToZero((Number(planItem.currentQty) || 0) + (Number(ch.qtyChange) || 0));
    const target = Number(planItem.targetQty) || 0;
    const unit = ch.unit || planItem.unit || "ea";

    // thresholds
    const { min, max } = calculateThresholds(planItem);

    if (current < min) {
      lows.push({
        name: planItem.name,
        zone: planItem.zone,
        current,
        min,
        target,
        unit,
        category: planItem.category,
        reason: from,
      });
    } else if (max && current > max) {
      surpluses.push({
        name: planItem.name,
        zone: planItem.zone,
        current,
        max,
        target,
        unit,
        category: planItem.category,
        reason: from,
      });
    }

    // update plan cache with new current
    planItem.currentQty = current;
  }

  if (lows.length) {
    const evt = emitEvent("storehouse.low", {
      items: lows,
      from,
    });
    await exportToHubIfEnabled(evt);
  }

  if (surpluses.length) {
    const evt = emitEvent("storehouse.surplus", {
      items: surpluses,
      from,
    });
    await exportToHubIfEnabled(evt);
  }
}

/**
 * Evaluate "raw" inputs that already contain current qty (e.g. preservation, garden harvest)
 * @param {Array} rawItems
 * @param {String} from
 */
async function evaluateRaw(rawItems, from) {
  if (!Array.isArray(rawItems) || !rawItems.length) return;
  if (!_plan || !Array.isArray(_plan.items)) return;

  const lows = [];
  const surpluses = [];

  for (const it of rawItems) {
    const planItem = findPlanItem(it.name, it.zone);
    if (!planItem) continue;

    const current = clampToZero((Number(planItem.currentQty) || 0) + (Number(it.current) || 0));
    const target = Number(planItem.targetQty) || 0;
    const unit = it.unit || planItem.unit || "ea";

    const { min, max } = calculateThresholds(planItem);

    if (current < min) {
      lows.push({
        name: planItem.name,
        zone: planItem.zone,
        current,
        min,
        target,
        unit,
        category: planItem.category,
        reason: from,
      });
    } else if (max && current > max) {
      surpluses.push({
        name: planItem.name,
        zone: planItem.zone,
        current,
        max,
        target,
        unit,
        category: planItem.category,
        reason: from,
      });
    }

    // update plan cache
    planItem.currentQty = current;
  }

  if (lows.length) {
    const evt = emitEvent("storehouse.low", {
      items: lows,
      from,
    });
    await exportToHubIfEnabled(evt);
  }

  if (surpluses.length) {
    const evt = emitEvent("storehouse.surplus", {
      items: surpluses,
      from,
    });
    await exportToHubIfEnabled(evt);
  }
}

// -----------------------------------------------------------------------------
// PLAN + THRESHOLDS
// -----------------------------------------------------------------------------

async function loadLatestPlan() {
  if (StorehousePlanStore && typeof StorehousePlanStore.loadLatest === "function") {
    try {
      const plan = await StorehousePlanStore.loadLatest();
      return plan || { items: [] };
    } catch (e) {
      console.warn("[StorehouseSignals] loadLatestPlan failed", e);
      return { items: [] };
    }
  }
  return { items: [] };
}

function findPlanItem(name, zone) {
  if (!_plan || !Array.isArray(_plan.items)) return null;
  const n = normalizeName(name);
  const z = zone ? zone.toLowerCase() : null;

  // 1. by name + zone
  let item =
    _plan.items.find(
      (it) => normalizeName(it.name) === n && (!z || (it.zone || "").toLowerCase() === z)
    ) || null;

  // 2. by name only
  if (!item) {
    item = _plan.items.find((it) => normalizeName(it.name) === n) || null;
  }

  return item;
}

function calculateThresholds(planItem) {
  if (_thresholdOverride) {
    const custom = _thresholdOverride(planItem);
    if (custom && (typeof custom.min === "number" || typeof custom.max === "number")) {
      return {
        min: typeof custom.min === "number" ? custom.min : defaultMin(planItem),
        max: typeof custom.max === "number" ? custom.max : defaultMax(planItem),
      };
    }
  }
  return {
    min: defaultMin(planItem),
    max: defaultMax(planItem),
  };
}

function defaultMin(planItem) {
  const target = Number(planItem.targetQty) || 0;
  if (!target) return Number(planItem.minQty) || 0;
  // default: 25% of target, at least 1
  return Math.max(Math.ceil(target * 0.25), Number(planItem.minQty) || 1);
}

function defaultMax(planItem) {
  const target = Number(planItem.targetQty) || 0;
  if (!target) return Number(planItem.maxQty) || 0;
  // default: 150% of target
  return Math.max(Math.ceil(target * 1.5), Number(planItem.maxQty) || 0);
}

// -----------------------------------------------------------------------------
// EVENT / HUB
// -----------------------------------------------------------------------------

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
    console.warn("[StorehouseSignals] eventBus not available for", type);
  }
  return payload;
}

async function exportToHubIfEnabled(evtPayload) {
  try {
    if (!featureFlags?.familyFundMode) return;
    if (!evtPayload) return;
    const packet = formatStorehouseSignalForHub(evtPayload);
    if (!packet) return;
    await FamilyFundConnector.send(packet);
  } catch (e) {
    // hub is optional
    console.warn("[StorehouseSignals] Hub export failed (silent)", e);
  }
}

// -----------------------------------------------------------------------------
// UTILS
// -----------------------------------------------------------------------------

function normalizeName(str) {
  return (str || "").toLowerCase().trim();
}

function clampToZero(num) {
  return num < 0 ? 0 : num;
}

function makeId(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

// -----------------------------------------------------------------------------
// EXPORT API
// -----------------------------------------------------------------------------

const StorehouseSignals = {
  init: initStorehouseSignals,
  registerSourceMapper,
  overrideThresholds,
};

export default StorehouseSignals;
