// C:\Users\larho\suka-smart-assistant\src\features\calculators\gardenAnimal\AnimalFeedCalculator\AnimalFeedCalculator.shim.js

/**
 * AnimalFeedCalculator.shim.js
 * ---------------------------------------------------------------------------
 * How this fits:
 * - This is a CALCULATOR SHIM for the Planning Graph node `animals.feedCalculator`.
 * - It accepts lightweight input (animals, feedInventory, planning horizon, pricebook),
 *   computes daily rations and feed requirements over time, and emits:
 *     • animals.feed.plan.calculated
 *     • inventory.shortage.detected (per feed item if needed)
 *     • planningGraph.node.updated
 * - It does NOT open the SessionRunner itself. Instead:
 *     • UI hooks (e.g. useAnimalFeedSessionLaunchers) read the result and build
 *       Session objects for “Feed Session Now” that the SessionRunner will run.
 * - If familyFundMode === true, it can optionally export a summary packet to
 *   the Family Fund Hub via HubPacketFormatter + FamilyFundConnector.
 *
 * This file is intentionally dependency-light and defensive:
 * - Soft-imports eventBus, featureFlags, and Hub helpers.
 * - Tolerates partial/missing data and returns warnings instead of throwing.
 */

/* -------------------------------------------------------------------------- */
/* Soft imports: eventBus, featureFlags, Hub helpers                          */
/* -------------------------------------------------------------------------- */

let emit = () => {};
let familyFundMode = false;
let HubPacketFormatter = null;
let FamilyFundConnector = null;

try {
  // eslint-disable-next-line import/no-unresolved
  const eventBus = require("@/services/eventBus");
  if (eventBus && typeof eventBus.emit === "function") {
    emit = eventBus.emit;
  }
} catch {
  // no-op fallback; keep shim usable in isolation / tests
}

try {
  // eslint-disable-next-line import/no-unresolved
  const flags = require("@/services/featureFlags");
  if (flags) {
    // project-specific: familyFundMode may be a boolean export or a getter
    familyFundMode = !!(flags.familyFundMode || flags.getFamilyFundMode?.());
  }
} catch {
  // ignore, default false
}

try {
  // eslint-disable-next-line import/no-unresolved
  HubPacketFormatter = require("@/services/HubPacketFormatter");
} catch {
  // optional
}

try {
  // eslint-disable-next-line import/no-unresolved
  FamilyFundConnector = require("@/services/FamilyFundConnector");
} catch {
  // optional
}

/* -------------------------------------------------------------------------- */
/* JSDoc typedefs (aligned with AnimalFeedCalculator.schema.json)             */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} AnimalSubject
 * @property {string} id
 * @property {string} displayName
 * @property {string} species
 * @property {string} [breed]
 * @property {string} class           - e.g. "growing", "lactating", "dry", "breeding"
 * @property {string} [role]          - e.g. "meat", "milk", "egg"
 * @property {number} count
 * @property {number} weightKg
 * @property {number} [targetWeightKg]
 * @property {number} [averageDailyGainKg]
 * @property {string} [location]
 * @property {string} [notes]
 */

/**
 * @typedef {Object} FeedInventoryItem
 * @property {string} id
 * @property {string} name
 * @property {string} [category]         - "forage" | "grain" | "byproduct" | "mineral" | "pasture"
 * @property {number} [dryMatterPercent] - 0–100
 * @property {number} [crudeProteinPercentOfDM]
 * @property {number} [energyMjPerKgDM]
 * @property {number} [quantityKg]       - available as-fed kg
 * @property {number} [unitCostPerKg]    - currency per as-fed kg
 */

/**
 * @typedef {Object} AnimalFeedCalculatorContext
 * @property {number} [planningHorizonDays]
 * @property {string} [unitSystem]        - "metric" | "imperial"
 * @property {string} [farmLocation]
 */

/**
 * @typedef {Object} AnimalFeedCalculatorResult
 * @property {Object} context
 * @property {AnimalSubject[]} animals
 * @property {Array<Object>} dailyFeedPlan
 * @property {Array<Object>} [feedBatchPlan]
 * @property {Array<Object>} [feedDemandProjection]
 * @property {Array<Object>} [nutritionGaps]
 * @property {Object} [analytics]
 * @property {Array<string>} [warnings]
 */

/**
 * @typedef {Object} AnimalFeedShimRequest
 * @property {string} [id]                  - Optional request id (for Reasoner logs)
 * @property {string} [nodeKey]             - Default: "animals.feedCalculator"
 * @property {AnimalSubject[]} animals
 * @property {FeedInventoryItem[]} [feedInventory]
 * @property {AnimalFeedCalculatorContext} [context]
 * @property {boolean} [exportToHub]        - If true and familyFundMode, send to Hub
 */

/**
 * @typedef {Object} AnimalFeedShimResponse
 * @property {boolean} ok
 * @property {string} nodeKey
 * @property {AnimalFeedCalculatorResult|null} result
 * @property {string[]} warnings
 * @property {string|null} error
 */

/* -------------------------------------------------------------------------- */
/* Constants & Utility helpers                                                */
/* -------------------------------------------------------------------------- */

const MODULE_SOURCE = "features/calculators/AnimalFeedCalculator.shim";
const NODE_KEY = "animals.feedCalculator";

/**
 * @returns {string}
 */
function nowIso() {
  return new Date().toISOString();
}

/**
 * Safe emit to eventBus.
 * @param {string} type
 * @param {any} data
 */
function safeEmit(type, data) {
  try {
    emit?.({
      type,
      ts: nowIso(),
      source: MODULE_SOURCE,
      data
    });
  } catch {
    // swallow; calculator should not crash app
  }
}

/**
 * Normalize planning horizon; default 7 days.
 * @param {AnimalFeedCalculatorContext|undefined} context
 * @returns {number}
 */
function getPlanningHorizonDays(context) {
  const days = context?.planningHorizonDays;
  if (!Number.isFinite(days) || days <= 0) return 7;
  return Math.max(1, Math.round(days));
}

/**
 * Very lightweight species/class → DM% of BW heuristic.
 * You can refine this later per species/production class.
 *
 * @param {AnimalSubject} subject
 * @returns {number} dry matter intake as % of BW
 */
function getDmIntakePercent(subject) {
  const species = subject.species?.toLowerCase?.() || "";
  const cls = subject.class?.toLowerCase?.() || "";

  if (species === "goat" || species === "sheep") {
    if (cls.includes("lact")) return 4; // 4% BW DM for lactating small ruminants
    return 3; // 3% BW DM default
  }

  if (species === "cattle" || species === "cow" || species === "steer") {
    if (cls.includes("lact")) return 3.5;
    return 2.5;
  }

  if (species === "chicken" || species === "poultry") {
    return 5; // expressed as bodyweight-equivalent; simple heuristic
  }

  // Generic fallback
  return 3;
}

/**
 * Choose a simple feed mix (forage + concentrate) from inventory.
 * This is intentionally naive; you can later plug in proper ration balancing.
 *
 * @param {FeedInventoryItem[]} feedInventory
 * @param {number} dmKgPerHeadPerDay
 * @returns {{ items: any[], totals: { asFedKgPerHeadPerDay:number, dryMatterKgPerHeadPerDay:number, estimatedCostPerHeadPerDay:number } }}
 */
function buildSimpleRation(feedInventory, dmKgPerHeadPerDay) {
  const forage = feedInventory?.find((f) => (f.category || "").toLowerCase() === "forage");
  const grain = feedInventory?.find((f) => (f.category || "").toLowerCase() === "grain");

  const rationItems = [];
  let totalAsFed = 0;
  let totalCost = 0;

  // 70% forage DM, 30% grain DM (if available)
  const forageDm = dmKgPerHeadPerDay * 0.7;
  const grainDm = dmKgPerHeadPerDay * 0.3;

  if (forage) {
    const dmPct = forage.dryMatterPercent || 90;
    const asFed = forageDm / (dmPct / 100);
    totalAsFed += asFed;
    totalCost += (forage.unitCostPerKg || 0) * asFed;

    rationItems.push({
      feedItemId: forage.id,
      name: forage.name,
      category: forage.category || "forage",
      asFedKgPerHeadPerDay: asFed,
      dryMatterPercent: dmPct,
      dryMatterKgPerHeadPerDay: forageDm,
      crudeProteinPercentOfDM: forage.crudeProteinPercentOfDM || 0,
      energyMjPerKgDM: forage.energyMjPerKgDM || 0,
      estimatedCostPerKgAsFed: forage.unitCostPerKg || 0,
      feedingTimeHints: ["morning", "evening"],
      notes: ""
    });
  }

  if (grain) {
    const dmPct = grain.dryMatterPercent || 90;
    const asFed = grainDm / (dmPct / 100);
    totalAsFed += asFed;
    totalCost += (grain.unitCostPerKg || 0) * asFed;

    rationItems.push({
      feedItemId: grain.id,
      name: grain.name,
      category: grain.category || "grain",
      asFedKgPerHeadPerDay: asFed,
      dryMatterPercent: dmPct,
      dryMatterKgPerHeadPerDay: grainDm,
      crudeProteinPercentOfDM: grain.crudeProteinPercentOfDM || 0,
      energyMjPerKgDM: grain.energyMjPerKgDM || 0,
      estimatedCostPerKgAsFed: grain.unitCostPerKg || 0,
      feedingTimeHints: ["evening"],
      notes: ""
    });
  }

  // If no inventory, just return generic item so UI has something
  if (!rationItems.length) {
    rationItems.push({
      feedItemId: "unknown",
      name: "Generic feed",
      category: "mixed",
      asFedKgPerHeadPerDay: dmKgPerHeadPerDay,
      dryMatterPercent: 90,
      dryMatterKgPerHeadPerDay: dmKgPerHeadPerDay * 0.9,
      crudeProteinPercentOfDM: 0,
      energyMjPerKgDM: 0,
      estimatedCostPerKgAsFed: 0,
      feedingTimeHints: ["morning", "evening"],
      notes: "No feed inventory linked; generic placeholder."
    });
    totalAsFed = dmKgPerHeadPerDay;
  }

  return {
    items: rationItems,
    totals: {
      asFedKgPerHeadPerDay: totalAsFed,
      dryMatterKgPerHeadPerDay: dmKgPerHeadPerDay,
      proteinPctOfDM: 0, // can be filled by weighted avg later
      energyMjPerHeadPerDay: 0,
      estimatedCostPerHeadPerDay: totalCost
    }
  };
}

/**
 * Aggregate per-item batch requirements and demand projection.
 *
 * @param {AnimalFeedCalculatorResult} result
 * @param {FeedInventoryItem[]} feedInventory
 * @param {number} horizonDays
 */
function buildBatchAndDemand(result, feedInventory, horizonDays) {
  const batchMap = new Map();
  const demandMap = new Map();

  for (const plan of result.dailyFeedPlan) {
    const subject = result.animals.find((a) => a.id === plan.subjectId);
    const count = subject?.count || 1;

    for (const item of plan.feedItems || []) {
      const key = item.feedItemId;
      const perDayAsFedAllHeads = (item.asFedKgPerHeadPerDay || 0) * count;
      const horizonAsFed = perDayAsFedAllHeads * horizonDays;
      const horizonDm = (item.dryMatterKgPerHeadPerDay || 0) * count * horizonDays;

      // Batch requirements
      const batch = batchMap.get(key) || {
        feedItemId: key,
        name: item.name,
        totalAsFedKg: 0,
        totalDryMatterKg: 0,
        estimatedCostTotal: 0
      };
      batch.totalAsFedKg += horizonAsFed;
      batch.totalDryMatterKg += horizonDm;

      const inv = feedInventory?.find((f) => f.id === key);
      const unitCost = inv?.unitCostPerKg || item.estimatedCostPerKgAsFed || 0;
      batch.estimatedCostTotal += unitCost * horizonAsFed;

      batchMap.set(key, batch);

      // Demand projection
      const invKg = inv?.quantityKg ?? 0;
      const demand = demandMap.get(key) || {
        feedItemId: key,
        name: item.name,
        currentInventoryKg: invKg,
        projectedUsageKg: 0,
        projectedShortageKg: 0,
        estimatedRunoutDate: null
      };
      demand.projectedUsageKg += horizonAsFed;
      demandMap.set(key, demand);
    }
  }

  const today = new Date();
  const batchPlan = Array.from(batchMap.values());
  const demandProjection = Array.from(demandMap.values()).map((d) => {
    const projectedShortageKg = Math.max(0, d.projectedUsageKg - d.currentInventoryKg);
    let estimatedRunoutDate = null;
    if (d.currentInventoryKg > 0 && d.projectedUsageKg > 0) {
      // naive: assume linear usage over horizon
      const dailyUse = d.projectedUsageKg / horizonDays;
      const daysUntilRunout = dailyUse > 0 ? d.currentInventoryKg / dailyUse : Infinity;
      if (Number.isFinite(daysUntilRunout)) {
        const runout = new Date(today.getTime() + daysUntilRunout * 24 * 60 * 60 * 1000);
        estimatedRunoutDate = runout.toISOString().slice(0, 10);
      }
    }
    return {
      ...d,
      projectedShortageKg,
      estimatedRunoutDate
    };
  });

  result.feedBatchPlan = batchPlan;
  result.feedDemandProjection = demandProjection;
}

/**
 * Emit inventory.shortage.detected events for items with projected shortages.
 *
 * @param {AnimalFeedCalculatorResult} result
 */
function emitShortageEvents(result) {
  if (!Array.isArray(result.feedDemandProjection)) return;

  for (const entry of result.feedDemandProjection) {
    if ((entry.projectedShortageKg || 0) <= 0) continue;

    safeEmit("inventory.shortage.detected", {
      domain: "animals",
      itemType: "feed",
      itemId: entry.feedItemId,
      name: entry.name,
      projectedShortageKg: entry.projectedShortageKg,
      currentInventoryKg: entry.currentInventoryKg,
      projectedUsageKg: entry.projectedUsageKg,
      estimatedRunoutDate: entry.estimatedRunoutDate
    });
  }
}

/**
 * Optionally export a compact summary to the Family Fund Hub.
 *
 * @param {AnimalFeedCalculatorResult} result
 */
async function exportToHubIfEnabled(result) {
  if (!familyFundMode || !HubPacketFormatter || !FamilyFundConnector) return;

  try {
    const summaryPayload = {
      nodeKey: NODE_KEY,
      calculatedAt: result.context?.calculatedAt,
      farmLocation: result.context?.farmLocation || null,
      analytics: result.analytics || null
    };

    const packet =
      typeof HubPacketFormatter.format === "function"
        ? HubPacketFormatter.format("animals.feed.plan", summaryPayload)
        : summaryPayload;

    if (typeof FamilyFundConnector.send === "function") {
      await FamilyFundConnector.send(packet);
    }

    safeEmit("session.exported", {
      nodeKey: NODE_KEY,
      ts: nowIso(),
      payloadKind: "animals.feed.plan",
      status: "success"
    });
  } catch {
    // fail silently per spec
  }
}

/* -------------------------------------------------------------------------- */
/* Core calculator                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Core logic: compute feed requirements over time.
 *
 * @param {AnimalFeedShimRequest} req
 * @returns {AnimalFeedShimResponse}
 */
function computeAnimalFeedPlan(req) {
  const warnings = [];
  const nodeKey = req.nodeKey || NODE_KEY;

  if (!Array.isArray(req.animals) || req.animals.length === 0) {
    return {
      ok: false,
      nodeKey,
      result: null,
      warnings: ["No animals provided to AnimalFeedCalculator."],
      error: "NO_ANIMALS"
    };
  }

  /** @type {FeedInventoryItem[]} */
  const feedInventory = Array.isArray(req.feedInventory) ? req.feedInventory : [];

  const horizonDays = getPlanningHorizonDays(req.context);
  const unitSystem = req.context?.unitSystem === "imperial" ? "imperial" : "metric";

  /** @type {AnimalFeedCalculatorResult} */
  const result = {
    context: {
      domain: "animals",
      calculatedAt: nowIso(),
      planningHorizonDays: horizonDays,
      unitSystem,
      farmLocation: req.context?.farmLocation || null,
      notes: req.context?.notes || ""
    },
    animals: req.animals,
    dailyFeedPlan: [],
    feedBatchPlan: [],
    feedDemandProjection: [],
    nutritionGaps: [],
    analytics: {},
    warnings
  };

  let totalAsFedKgPerDay = 0;
  let totalDmKgPerDay = 0;
  let totalCostPerDay = 0;

  // Build daily feed plans for each animal subject
  for (const subject of req.animals) {
    if (!subject || !Number.isFinite(subject.weightKg) || subject.weightKg <= 0) {
      warnings.push(`Animal ${subject?.displayName || subject?.id || "unknown"} is missing a valid weightKg.`);
      continue;
    }

    const dmPctBw = getDmIntakePercent(subject);
    const dmKgPerHeadPerDay = (subject.weightKg * dmPctBw) / 100;

    const { items, totals } = buildSimpleRation(feedInventory, dmKgPerHeadPerDay);

    const count = subject.count || 1;
    totalAsFedKgPerDay += totals.asFedKgPerHeadPerDay * count;
    totalDmKgPerDay += totals.dryMatterKgPerHeadPerDay * count;
    totalCostPerDay += totals.estimatedCostPerHeadPerDay * count;

    const rationId = `ration-${subject.id}`;

    result.dailyFeedPlan.push({
      subjectId: subject.id,
      rationId,
      timesPerDay: 2,
      feedItems: items,
      totals,
      instructions: `Feed approximately ${totals.asFedKgPerHeadPerDay.toFixed(
        2
      )} kg per head per day (split into 2 feedings).`
    });
  }

  // Build batch and demand projections
  buildBatchAndDemand(result, feedInventory, horizonDays);

  result.analytics = {
    totalAsFedKgPerDay,
    totalDryMatterKgPerDay: totalDmKgPerDay,
    estimatedFeedCostPerDay: totalCostPerDay,
    projectedShortageDays: result.feedDemandProjection?.reduce((min, d) => {
      if (!d.estimatedRunoutDate) return min;
      const runout = new Date(d.estimatedRunoutDate);
      const today = new Date(result.context.calculatedAt);
      const diffDays = Math.round((runout.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
      if (!Number.isFinite(diffDays) || diffDays < 0) return min;
      if (min == null) return diffDays;
      return Math.min(min, diffDays);
    }, null) ?? null
  };

  // Emit core events
  safeEmit("animals.feed.plan.calculated", {
    nodeKey,
    result
  });

  safeEmit("planningGraph.node.updated", {
    nodeKey,
    timestamp: result.context.calculatedAt,
    analytics: result.analytics
  });

  emitShortageEvents(result);

  return {
    ok: true,
    nodeKey,
    result,
    warnings,
    error: null
  };
}

/* -------------------------------------------------------------------------- */
/* Public Shim API                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Main entry point used by the Reasoner / Planning Graph.
 * This is intentionally synchronous wrt computation; Hub export is async.
 *
 * @param {AnimalFeedShimRequest} req
 * @returns {Promise<AnimalFeedShimResponse>}
 */
async function runAnimalFeedCalculatorShim(req) {
  const safeReq = req || /** @type {AnimalFeedShimRequest} */ ({});
  const response = computeAnimalFeedPlan(safeReq);

  if (response.ok && safeReq.exportToHub) {
    // best-effort Hub export, fire-and-forget
    exportToHubIfEnabled(response.result).catch(() => {});
  }

  return response;
}

module.exports = {
  runAnimalFeedCalculatorShim,
  computeAnimalFeedPlan
};
