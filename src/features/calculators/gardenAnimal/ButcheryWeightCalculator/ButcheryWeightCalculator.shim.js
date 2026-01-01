// C:\Users\larho\suka-smart-assistant\src\features\calculators\gardenAnimal\ButcheryWeightCalculator\ButcheryWeightCalculator.shim.js

/**
 * ButcheryWeightCalculator.shim.js
 *
 * “Shim” module for the Butchery Weight Calculator node.
 *
 * Role in SSA:
 * - Takes animal live weights + optional yield curves + optional storehouse inventory.
 * - Computes carcass weights, retail cut weights, and by-product estimates.
 * - Produces a stable result object that the view + Planning Graph can consume.
 * - Optionally exports analytics to the Family Fund Hub when familyFundMode is enabled.
 *
 * This shim does NOT manage UI or SessionRunner directly. It is a pure calculator:
 *   request (animals, yieldCurves, storehouseInventory, context) → result (carcassBreakdown, retailCutPlan, byproducts, analytics).
 *
 * Expected request shape (aligned with ButcheryWeightCalculator.schema.json, simplified):
 *
 * {
 *   context?: {
 *     plannedAt?: string,           // ISO datetime
 *     processingDate?: string,      // date string
 *     unitSystem?: "metric"|"imperial",
 *     location?: string,
 *     notes?: string,
 *     exportToHub?: boolean
 *   },
 *   animals: [
 *     {
 *       id: string,
 *       species: string,
 *       class?: string,
 *       displayName?: string,
 *       liveWeightKg: number,
 *       liveWeightLb?: number,
 *       count?: number,
 *       ...
 *     }
 *   ],
 *   yieldCurves?: [
 *     {
 *       id: string,
 *       species: string,
 *       class?: string,
 *       dressingPercent: number,        // 0–100
 *       retailYieldPercent: number,     // 0–100
 *       cutDistributions?: [
 *         { cutKey: string, cutName: string, percentOfRetail: number }
 *       ]
 *     }
 *   ],
 *   storehouseInventory?: [ ... ]
 * }
 *
 * Returns:
 * {
 *   context: { ... },
 *   animals: [ ...normalized... ],
 *   result: {
 *     carcassBreakdown: [ ... ],
 *     retailCutPlan: [ ... ],
 *     offalAndByproducts: [ ... ],
 *     analytics: { ... }
 *   }
 * }
 */

import { emit } from "@/services/eventBus";
import * as featureFlags from "@/services/featureFlags";

// Soft-ish imports; if paths differ, you can adjust them here.
let HubPacketFormatter = null;
let FamilyFundConnector = null;
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  HubPacketFormatter = require("@/services/hub/HubPacketFormatter");
  // eslint-disable-next-line global-require, import/no-unresolved
  FamilyFundConnector = require("@/services/hub/FamilyFundConnector");
} catch (err) {
  // Optional Hub integration; failing to import is non-fatal.
}

/**
 * @typedef {import('./ButcheryWeightCalculator.schema.json')} ButcheryWeightSchema
 */

/**
 * Main entry point for the butchery weight calculator shim.
 *
 * @param {Object} request - Calculation request payload.
 * @returns {Object} - Response with `context`, `animals`, and `result`.
 */
export async function runButcheryWeightCalculator(request) {
  const ts = new Date().toISOString();

  if (!request || typeof request !== "object") {
    throw new Error("ButcheryWeightCalculator: request must be a non-null object.");
  }

  const { animals, yieldCurves = [], storehouseInventory = [], context = {} } = request;

  if (!Array.isArray(animals) || animals.length === 0) {
    throw new Error("ButcheryWeightCalculator: 'animals' array is required and must be non-empty.");
  }

  const normalizedContext = {
    unitSystem: context.unitSystem === "imperial" ? "imperial" : "metric",
    plannedAt: context.plannedAt || ts,
    processingDate: context.processingDate || null,
    location: context.location || null,
    notes: context.notes || "",
    exportToHub: Boolean(context.exportToHub)
  };

  const normalizedAnimals = animals.map(normalizeAnimal);

  /** @type {Array<import('./ButcheryWeightCalculator.schema.json').$defs.carcassBreakdownEntry>} */
  const carcassBreakdown = [];
  /** @type {Array<import('./ButcheryWeightCalculator.schema.json').$defs.retailCutPlanEntry>} */
  const retailCutPlan = [];
  /** @type {Array<import('./ButcheryWeightCalculator.schema.json').$defs.byproductEntry>} */
  const offalAndByproducts = [];

  const yieldLookup = buildYieldCurveLookup(yieldCurves);
  const batchAnalytics = {
    totalLiveWeightKg: 0,
    totalCarcassWeightKg: 0,
    totalRetailWeightKg: 0,
    totalByproductWeightKg: 0,
    averageDressingPercent: 0,
    averageRetailYieldPercent: 0,
    headCount: 0
  };

  normalizedAnimals.forEach((animal) => {
    const curve = selectYieldCurveForAnimal(yieldLookup, animal);
    const {
      dressingPercent,
      retailYieldPercent,
      shrinkPercent,
      cutDistributions
    } = curve;

    const {
      carcassEntry,
      retailEntries,
      byproductEntries
    } = computeYieldsForAnimal(animal, {
      dressingPercent,
      retailYieldPercent,
      shrinkPercent,
      cutDistributions
    });

    carcassBreakdown.push(carcassEntry);
    retailCutPlan.push(...retailEntries);
    offalAndByproducts.push(...byproductEntries);

    batchAnalytics.totalLiveWeightKg += carcassEntry.liveWeightKg;
    batchAnalytics.totalCarcassWeightKg += carcassEntry.carcassChilledKg;
    batchAnalytics.totalRetailWeightKg += sumRetailCutWeight(retailEntries);
    batchAnalytics.totalByproductWeightKg += sumByproductWeight(byproductEntries);
    batchAnalytics.headCount += animal.count;
  });

  if (normalizedAnimals.length > 0) {
    const avgDressing =
      carcassBreakdown.reduce((sum, c) => sum + (c.dressingPercent || 0), 0) /
      carcassBreakdown.length;
    const avgRetail =
      carcassBreakdown.reduce((sum, c) => sum + (c._retailYieldPercent || 0), 0) /
      carcassBreakdown.length;

    batchAnalytics.averageDressingPercent = roundTo(avgDressing, 2);
    batchAnalytics.averageRetailYieldPercent = roundTo(avgRetail, 2);
  }

  const response = {
    context: normalizedContext,
    animals: normalizedAnimals,
    result: {
      carcassBreakdown,
      retailCutPlan,
      offalAndByproducts,
      analytics: batchAnalytics
    },
    storehouseInventory // echoed for convenience if the caller wants to compare.
  };

  // Emit a calculator-level event for observability.
  safeEmit("calculator.butcheryWeight.completed", {
    ts,
    requestSummary: {
      animalCount: normalizedAnimals.length,
      headCount: batchAnalytics.headCount,
      totalLiveWeightKg: batchAnalytics.totalLiveWeightKg
    },
    analytics: batchAnalytics
  });

  // Optional Hub export when enabled.
  await exportToHubIfEnabled(normalizedContext, normalizedAnimals, response);

  return response;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Normalize a single animal entry: unit conversions, defaults, and guard rails.
 *
 * @param {Object} animal
 * @returns {Object}
 */
function normalizeAnimal(animal) {
  if (!animal || typeof animal !== "object") {
    throw new Error("ButcheryWeightCalculator: each animal must be an object.");
  }

  const id = String(animal.id || "");
  if (!id) {
    throw new Error("ButcheryWeightCalculator: each animal must have an 'id'.");
  }

  const liveWeightKg = toKg(animal.liveWeightKg, animal.liveWeightLb);
  if (!isFinite(liveWeightKg) || liveWeightKg <= 0) {
    throw new Error(
      `ButcheryWeightCalculator: animal '${id}' must have a positive live weight (kg or lb).`
    );
  }

  const species = (animal.species || "").trim().toLowerCase();
  if (!species) {
    throw new Error(`ButcheryWeightCalculator: animal '${id}' must have a 'species'.`);
  }

  const count = Number.isInteger(animal.count) && animal.count > 0 ? animal.count : 1;

  return {
    id,
    lotId: animal.lotId || null,
    species,
    class: (animal.class || "").trim().toLowerCase() || null,
    displayName: animal.displayName || id,
    liveWeightKg,
    count,
    sex: animal.sex || null,
    ageMonths: typeof animal.ageMonths === "number" ? animal.ageMonths : null,
    role: animal.role || "meat",
    location: animal.location || null,
    scheduledProcessingDate: animal.scheduledProcessingDate || null,
    notes: animal.notes || ""
  };
}

/**
 * Build a lookup structure for yield curves keyed by species and species-class.
 *
 * @param {Array<Object>} yieldCurves
 * @returns {{ bySpeciesClass: Map<string,Object>, bySpecies: Map<string,Object> }}
 */
function buildYieldCurveLookup(yieldCurves) {
  const bySpeciesClass = new Map();
  const bySpecies = new Map();

  if (!Array.isArray(yieldCurves)) {
    return { bySpeciesClass, bySpecies };
  }

  yieldCurves.forEach((curve) => {
    if (!curve || typeof curve !== "object") return;
    const species = (curve.species || "").trim().toLowerCase();
    if (!species) return;

    const cls = (curve.class || "").trim().toLowerCase() || "";
    const key = `${species}:${cls}`;

    const safeCurve = {
      id: String(curve.id || key),
      species,
      class: cls || null,
      dressingPercent: clampNumber(curve.dressingPercent, 0, 100, 60),
      retailYieldPercent: clampNumber(curve.retailYieldPercent, 0, 100, 65),
      cutDistributions: Array.isArray(curve.cutDistributions)
        ? curve.cutDistributions.filter(isValidCutDistribution)
        : []
    };

    bySpeciesClass.set(key, safeCurve);
    if (!bySpecies.has(species)) {
      bySpecies.set(species, safeCurve);
    }
  });

  return { bySpeciesClass, bySpecies };
}

/**
 * Select the most appropriate yield curve for a given animal, or fall back to defaults.
 *
 * @param {{ bySpeciesClass: Map<string,Object>, bySpecies: Map<string,Object> }} lookup
 * @param {Object} animal
 * @returns {{ dressingPercent:number, retailYieldPercent:number, shrinkPercent:number, cutDistributions:Array }}
 */
function selectYieldCurveForAnimal(lookup, animal) {
  const { bySpeciesClass, bySpecies } = lookup || {};
  const species = animal.species;
  const cls = animal.class || "";

  let curve = null;

  const key = `${species}:${cls}`;
  if (bySpeciesClass && bySpeciesClass.has(key)) {
    curve = bySpeciesClass.get(key);
  } else if (bySpecies && bySpecies.has(species)) {
    curve = bySpecies.get(species);
  }

  if (!curve) {
    // Very conservative defaults per species (can be refined later).
    const speciesDefaults = getSpeciesDefaultYields(species);
    return {
      dressingPercent: speciesDefaults.dressingPercent,
      retailYieldPercent: speciesDefaults.retailYieldPercent,
      shrinkPercent: speciesDefaults.shrinkPercent,
      cutDistributions: []
    };
  }

  return {
    dressingPercent: curve.dressingPercent,
    retailYieldPercent: curve.retailYieldPercent,
    shrinkPercent: 2, // Default 2% shrink unless specified in the future.
    cutDistributions: curve.cutDistributions || []
  };
}

/**
 * Compute carcass, retail, and by-product yields for a single animal entry.
 *
 * @param {Object} animal - Normalized animal.
 * @param {Object} yieldParams - dressingPercent, retailYieldPercent, shrinkPercent, cutDistributions.
 * @returns {{ carcassEntry: Object, retailEntries: Array, byproductEntries: Array }}
 */
function computeYieldsForAnimal(animal, yieldParams) {
  const {
    dressingPercent,
    retailYieldPercent,
    shrinkPercent = 2,
    cutDistributions = []
  } = yieldParams;

  const totalLiveWeightKg = animal.liveWeightKg * animal.count;
  const carcassHotKg = (totalLiveWeightKg * dressingPercent) / 100;
  const carcassChilledKg = carcassHotKg * (1 - shrinkPercent / 100);

  const retailTotalKg = (carcassChilledKg * retailYieldPercent) / 100;
  const byproductTotalKg = Math.max(totalLiveWeightKg - carcassChilledKg - retailTotalKg, 0);

  const carcassEntry = {
    animalId: animal.id,
    lotId: animal.lotId,
    species: animal.species,
    class: animal.class,
    count: animal.count,
    liveWeightKg: roundTo(totalLiveWeightKg, 2),
    dressingPercent: roundTo(dressingPercent, 2),
    carcassHotKg: roundTo(carcassHotKg, 2),
    carcassChilledKg: roundTo(carcassChilledKg, 2),
    shrinkPercent: roundTo(shrinkPercent, 2),
    primals: [],
    // internal, not in schema, but useful for analytics; will be ignored by consumers if not used
    _retailYieldPercent: roundTo(retailYieldPercent, 2)
  };

  const retailEntries = buildRetailCutEntries(
    animal,
    retailTotalKg,
    cutDistributions
  );

  const byproductEntries = buildByproductEntries(
    animal,
    byproductTotalKg
  );

  return { carcassEntry, retailEntries, byproductEntries };
}

/**
 * Build retail cut entries for a single animal.
 *
 * @param {Object} animal
 * @param {number} retailTotalKg
 * @param {Array<Object>} cutDistributions
 * @returns {Array<Object>}
 */
function buildRetailCutEntries(animal, retailTotalKg, cutDistributions) {
  const entries = [];

  if (!Array.isArray(cutDistributions) || cutDistributions.length === 0) {
    // Single generic "mixed retail" entry if we don't have detailed distributions.
    if (retailTotalKg > 0) {
      entries.push({
        animalId: animal.id,
        lotId: animal.lotId,
        cutKey: "mixedRetail",
        cutName: "Mixed Retail Cuts",
        weightKg: roundTo(retailTotalKg, 2),
        units: null,
        unitSizeKg: null,
        packageLabel: `${animal.displayName || animal.id} – Mixed Retail`,
        notes: ""
      });
    }
    return entries;
  }

  // Ensure percentages roughly sum to 100; we'll normalize if needed.
  const totalPercent = cutDistributions.reduce(
    (sum, c) => sum + (typeof c.percentOfRetail === "number" ? c.percentOfRetail : 0),
    0
  );
  const normalizationFactor = totalPercent > 0 ? 100 / totalPercent : 1;

  cutDistributions.forEach((c) => {
    const percent = (c.percentOfRetail || 0) * normalizationFactor;
    const cutWeightKg = (retailTotalKg * percent) / 100;
    if (cutWeightKg <= 0) return;

    entries.push({
      animalId: animal.id,
      lotId: animal.lotId,
      cutKey: String(c.cutKey),
      cutName: String(c.cutName),
      weightKg: roundTo(cutWeightKg, 2),
      units: null,
      unitSizeKg: null,
      packageLabel: `${animal.displayName || animal.id} – ${c.cutName}`,
      notes: ""
    });
  });

  return entries;
}

/**
 * Build a simple by-product distribution per animal.
 * This is intentionally coarse and can be refined later or replaced by a more detailed curve.
 *
 * @param {Object} animal
 * @param {number} byproductTotalKg
 * @returns {Array<Object>}
 */
function buildByproductEntries(animal, byproductTotalKg) {
  if (!byproductTotalKg || byproductTotalKg <= 0) {
    return [];
  }

  // Simple rule-of-thumb breakdown (can be made species-specific later):
  // 40% bones, 40% fat trim, 20% organs/other.
  const bonesKg = roundTo(byproductTotalKg * 0.4, 2);
  const fatKg = roundTo(byproductTotalKg * 0.4, 2);
  const organsKg = roundTo(byproductTotalKg * 0.2, 2);

  const entries = [];

  if (bonesKg > 0) {
    entries.push({
      animalId: animal.id,
      lotId: animal.lotId,
      category: "bones",
      name: "Soup Bones",
      weightKg: bonesKg,
      intendedUse: "stock",
      notes: ""
    });
  }

  if (fatKg > 0) {
    entries.push({
      animalId: animal.id,
      lotId: animal.lotId,
      category: "fat",
      name: "Trim Fat",
      weightKg: fatKg,
      intendedUse: "render",
      notes: ""
    });
  }

  if (organsKg > 0) {
    entries.push({
      animalId: animal.id,
      lotId: animal.lotId,
      category: "organs",
      name: "Mixed Organs",
      weightKg: organsKg,
      intendedUse: "edible",
      notes: ""
    });
  }

  return entries;
}

/**
 * Export result to Hub when familyFundMode + exportToHub are enabled.
 *
 * @param {Object} context
 * @param {Array<Object>} animals
 * @param {Object} response
 */
async function exportToHubIfEnabled(context, animals, response) {
  const familyFundEnabled = Boolean(featureFlags && featureFlags.familyFundMode);
  if (!familyFundEnabled) return;
  if (!context || !context.exportToHub) return;
  if (!HubPacketFormatter || !FamilyFundConnector) return;

  try {
    const payload = {
      type: "butcheryWeights",
      ts: new Date().toISOString(),
      context,
      animals,
      analytics: response?.result?.analytics || {},
      carcassBreakdown: response?.result?.carcassBreakdown || [],
      retailCutPlan: response?.result?.retailCutPlan || [],
      offalAndByproducts: response?.result?.offalAndByproducts || []
    };

    const envelope = HubPacketFormatter.format(payload);
    await FamilyFundConnector.send(envelope);

    safeEmit("calculator.butcheryWeight.exported", {
      ts: new Date().toISOString(),
      analytics: response?.result?.analytics || {}
    });
  } catch (err) {
    // Fail silently per spec, but log to console for dev environments.
    // eslint-disable-next-line no-console
    console.warn("ButcheryWeightCalculator: Hub export failed", err);
  }
}

/**
 * Emit via SSA event bus with basic safety.
 *
 * @param {string} type
 * @param {Object} data
 */
function safeEmit(type, data) {
  try {
    emit({
      type,
      ts: new Date().toISOString(),
      source: "features/calculators/ButcheryWeightCalculator.shim",
      data
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`ButcheryWeightCalculator: failed to emit event '${type}'`, err);
  }
}

/**
 * Convert from kg/lb pair to canonical kg.
 *
 * @param {number|undefined} kg
 * @param {number|undefined} lb
 * @returns {number}
 */
function toKg(kg, lb) {
  if (typeof kg === "number" && isFinite(kg) && kg > 0) {
    return kg;
  }
  if (typeof lb === "number" && isFinite(lb) && lb > 0) {
    return lb * 0.45359237;
  }
  return 0;
}

/**
 * Clamp number into [min, max], or use default if invalid.
 *
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function clampNumber(value, min, max, fallback) {
  const n = typeof value === "number" && isFinite(value) ? value : fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/**
 * Round number to specified decimals.
 *
 * @param {number} value
 * @param {number} decimals
 * @returns {number}
 */
function roundTo(value, decimals) {
  const factor = Math.pow(10, decimals || 0);
  return Math.round(value * factor) / factor;
}

/**
 * Check if a cut distribution entry is structurally valid.
 *
 * @param {Object} c
 * @returns {boolean}
 */
function isValidCutDistribution(c) {
  if (!c || typeof c !== "object") return false;
  if (!c.cutKey || !c.cutName) return false;
  if (typeof c.percentOfRetail !== "number" || !isFinite(c.percentOfRetail)) return false;
  return true;
}

/**
 * Get conservative per-species default yield assumptions.
 *
 * @param {string} species
 * @returns {{ dressingPercent: number, retailYieldPercent: number, shrinkPercent: number }}
 */
function getSpeciesDefaultYields(species) {
  switch (species) {
    case "cattle":
    case "cow":
    case "steer":
      return { dressingPercent: 60, retailYieldPercent: 65, shrinkPercent: 2 };
    case "sheep":
    case "lamb":
      return { dressingPercent: 52, retailYieldPercent: 68, shrinkPercent: 2 };
    case "goat":
    case "kid":
      return { dressingPercent: 50, retailYieldPercent: 65, shrinkPercent: 2 };
    case "pig":
    case "hog":
      return { dressingPercent: 72, retailYieldPercent: 70, shrinkPercent: 2 };
    case "poultry":
    case "chicken":
    case "turkey":
      return { dressingPercent: 72, retailYieldPercent: 72, shrinkPercent: 1 };
    default:
      return { dressingPercent: 60, retailYieldPercent: 65, shrinkPercent: 2 };
  }
}

/**
 * Sum up total retail cut weight for a list of entries.
 *
 * @param {Array<Object>} retailEntries
 * @returns {number}
 */
function sumRetailCutWeight(retailEntries) {
  if (!Array.isArray(retailEntries)) return 0;
  return retailEntries.reduce(
    (sum, e) => sum + (typeof e.weightKg === "number" ? e.weightKg : 0),
    0
  );
}

/**
 * Sum up total by-product weight for a list of entries.
 *
 * @param {Array<Object>} byproductEntries
 * @returns {number}
 */
function sumByproductWeight(byproductEntries) {
  if (!Array.isArray(byproductEntries)) return 0;
  return byproductEntries.reduce(
    (sum, e) => sum + (typeof e.weightKg === "number" ? e.weightKg : 0),
    0
  );
}

// Default export for convenience when imported as a generic shim.
export default {
  run: runButcheryWeightCalculator
};
