// C:\Users\larho\suka-smart-assistant\src\features\calculators\storehouseMeals\MeatBreakdownCalculator\MeatBreakdownCalculator.shim.js

/**
 * MeatBreakdownCalculator Shim
 *
 * HOW THIS FITS:
 * - Called by SSA calculator/Reasoner layer when a user records or edits a carcass.
 * - Consumes a payload that aligns with MeatBreakdownCalculator.schema.json `inputs` + optional `metadata`.
 * - Produces a full calculator payload with `version`, `calculator`, `inputs`, and `outputs`.
 * - Emits calculator events on the global event bus so downstream planners (Storehouse Stock Planner,
 *   Meal Yield Planner, Animal Planner, etc.) can react.
 * - Optionally exports an analytics snapshot to the Family Fund Hub when familyFundMode is enabled.
 *
 * This shim is pure-logic for:
 * - choosing a basis weight (live / hot carcass / chilled),
 * - applying species yield profiles,
 * - tuning yields based on trim & grind preferences,
 * - generating per-cut yields and byproduct records,
 * - computing serving estimates for storehouse & meal planning.
 */

import { emit } from "@/services/events/eventBus";
import { familyFundMode } from "@/config/featureFlags";
import { HubPacketFormatter, FamilyFundConnector } from "@/services/hub";

/** @typedef {import("./MeatBreakdownCalculator.config").MeatBreakdownCalculatorInput} MeatBreakdownCalculatorInput */
/** @typedef {import("./MeatBreakdownCalculator.schema.json")} MeatBreakdownCalculatorSchema */

/**
 * Shim metadata for registration in the calculators / Reasoner registry.
 */
export const MeatBreakdownCalculatorShim = {
  id: "MeatBreakdownCalculator",
  domain: "storehouse",
  version: "v1.0.0",
  /**
   * Main entry point.
   * @param {MeatBreakdownCalculatorInput} payload
   * @returns {Promise<MeatBreakdownCalculatorSchema>}
   */
  run: runMeatBreakdownCalculator,
};

/**
 * Entry function used by the SSA calculators layer.
 *
 * @param {object} payload - Object expected to contain `inputs` and optional `metadata`.
 * @returns {Promise<object>} - MeatBreakdownCalculator schema-compliant payload.
 */
export async function runMeatBreakdownCalculator(payload) {
  const ts = new Date().toISOString();
  const source = "features/calculators/storehouseMeals/MeatBreakdownCalculator";

  try {
    if (!payload || typeof payload !== "object") {
      throw new Error(
        "MeatBreakdownCalculator: payload is required and must be an object."
      );
    }

    const { inputs, metadata = {} } = payload;

    if (!inputs || typeof inputs !== "object") {
      throw new Error("MeatBreakdownCalculator: `inputs` is required.");
    }

    const {
      animal,
      carcass,
      processingPreferences = {},
      batchContext = {},
    } = inputs;

    if (!animal || typeof animal !== "object") {
      throw new Error("MeatBreakdownCalculator: `inputs.animal` is required.");
    }
    if (!carcass || typeof carcass !== "object") {
      throw new Error("MeatBreakdownCalculator: `inputs.carcass` is required.");
    }

    const { species = "other" } = animal;
    const { basisType, basisWeight, weightUnit } = deriveBasisFromCarcass(
      carcass,
      batchContext
    );

    if (!basisWeight || basisWeight <= 0) {
      throw new Error(
        "MeatBreakdownCalculator: could not determine a valid basis weight."
      );
    }

    const speciesProfile = getSpeciesProfile(species);
    const tunedProfile = tuneProfileForPreferences(
      speciesProfile,
      processingPreferences
    );

    const summary = buildSummaryFromProfile(
      tunedProfile,
      basisType,
      basisWeight,
      weightUnit
    );

    const cuts = buildCutsFromProfile(tunedProfile, summary, weightUnit);

    const byproducts = buildByproductsFromProfile(
      tunedProfile,
      summary,
      weightUnit
    );

    const calculatorPayload = {
      version: "v1.0.0",
      calculator: "MeatBreakdownCalculator",
      metadata: {
        ...metadata,
        updatedAt: ts,
        createdAt: metadata.createdAt || ts,
      },
      inputs: {
        animal,
        carcass,
        processingPreferences,
        batchContext,
      },
      outputs: {
        summary,
        cuts,
        byproducts,
      },
    };

    emit({
      type: "calculator.meatBreakdown.completed",
      ts,
      source,
      data: {
        calculatorId: "MeatBreakdownCalculator",
        species,
        basisType,
        basisWeight,
        weightUnit,
        summary,
      },
    });

    await exportToHubIfEnabled(calculatorPayload);

    return calculatorPayload;
  } catch (error) {
    console.error("[MeatBreakdownCalculator] Error:", error);

    emit({
      type: "calculator.meatBreakdown.error",
      ts,
      source,
      data: {
        message: error.message,
        stack: error.stack || null,
      },
    });

    // Re-throw so the calling layer can handle UI-level error states if needed.
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* Helper: Basis weight selection                                             */
/* -------------------------------------------------------------------------- */

/**
 * Derive basisType, basisWeight, and weightUnit from carcass and batch context.
 *
 * Priority:
 *  1. chilledCarcassWeight
 *  2. hotCarcassWeight
 *  3. liveWeight
 *
 * Batch shareFactor (0–1) is applied to the chosen basisWeight when present.
 *
 * @param {object} carcass
 * @param {object} batchContext
 * @returns {{ basisType: 'hot_carcass'|'chilled_carcass'|'live', basisWeight: number, weightUnit: 'lb'|'kg' }}
 */
function deriveBasisFromCarcass(carcass, batchContext) {
  const weightUnit = carcass.weightUnit === "kg" ? "kg" : "lb";
  let basisType = "chilled_carcass";
  let basisWeight = Number(carcass.chilledCarcassWeight || 0);

  if (!basisWeight && carcass.hotCarcassWeight) {
    basisType = "hot_carcass";
    basisWeight = Number(carcass.hotCarcassWeight || 0);
  }

  if (!basisWeight && carcass.liveWeight) {
    basisType = "live";
    basisWeight = Number(carcass.liveWeight || 0);
  }

  if (batchContext && typeof batchContext.shareFactor === "number") {
    const share = Math.max(0, Math.min(1, batchContext.shareFactor || 0));
    if (share > 0) {
      basisWeight = basisWeight * share;
    }
  }

  return { basisType, basisWeight, weightUnit };
}

/* -------------------------------------------------------------------------- */
/* Species Profiles & Tuning                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Base yield profiles per species. These are approximate but consistent, designed
 * for planning rather than lab-accurate butchery math.
 *
 * Percentages are expressed as percentages of the basisWeight.
 *
 * - `meatPct` is edible meat as a percentage of basisWeight.
 * - `bonePct`, `fatPct`, `offalPct`, and `shrinkPct` are also % of basisWeight.
 * - `cuts[i].pctOfMeat` is each cut's share of the total edible meat.
 */
const BASE_SPECIES_PROFILES = {
  beef: {
    id: "beef",
    label: "Beef",
    meatPct: 67,
    bonePct: 15,
    fatPct: 8,
    offalPct: 5,
    shrinkPct: 5,
    cuts: [
      {
        key: "steaks",
        name: "Mixed Steaks",
        category: "steak",
        primal: "Loin/Rib",
        pctOfMeat: 35,
      },
      {
        key: "roasts",
        name: "Roasts & Pot Roasts",
        category: "roast",
        primal: "Chuck/Round",
        pctOfMeat: 25,
      },
      {
        key: "ground",
        name: "Ground Beef",
        category: "ground",
        primal: "Various",
        pctOfMeat: 30,
      },
      {
        key: "stew",
        name: "Stew Meat",
        category: "stew",
        primal: "Various",
        pctOfMeat: 10,
      },
    ],
  },
  lamb: {
    id: "lamb",
    label: "Lamb",
    meatPct: 68,
    bonePct: 17,
    fatPct: 6,
    offalPct: 4,
    shrinkPct: 5,
    cuts: [
      {
        key: "chops",
        name: "Loin & Rib Chops",
        category: "chop",
        primal: "Loin/Rib",
        pctOfMeat: 30,
      },
      {
        key: "leg",
        name: "Leg Roasts/Chops",
        category: "roast",
        primal: "Leg",
        pctOfMeat: 30,
      },
      {
        key: "shoulder",
        name: "Shoulder Roasts/Chops",
        category: "roast",
        primal: "Shoulder",
        pctOfMeat: 20,
      },
      {
        key: "ground",
        name: "Ground Lamb",
        category: "ground",
        primal: "Various",
        pctOfMeat: 20,
      },
    ],
  },
  goat: {
    id: "goat",
    label: "Goat",
    meatPct: 65,
    bonePct: 18,
    fatPct: 5,
    offalPct: 4,
    shrinkPct: 8,
    cuts: [
      {
        key: "chops",
        name: "Chops & Small Steaks",
        category: "chop",
        primal: "Loin/Rib",
        pctOfMeat: 25,
      },
      {
        key: "curry",
        name: "Curry/Stew Pieces",
        category: "stew",
        primal: "Various",
        pctOfMeat: 35,
      },
      {
        key: "roasts",
        name: "Roasts",
        category: "roast",
        primal: "Leg/Shoulder",
        pctOfMeat: 25,
      },
      {
        key: "ground",
        name: "Ground Goat",
        category: "ground",
        primal: "Various",
        pctOfMeat: 15,
      },
    ],
  },
  pork: {
    id: "pork",
    label: "Pork",
    meatPct: 70,
    bonePct: 12,
    fatPct: 8,
    offalPct: 3,
    shrinkPct: 7,
    cuts: [
      {
        key: "chops",
        name: "Loin Chops & Steaks",
        category: "chop",
        primal: "Loin",
        pctOfMeat: 30,
      },
      {
        key: "roasts",
        name: "Roasts & Shoulders",
        category: "roast",
        primal: "Shoulder/Leg",
        pctOfMeat: 30,
      },
      {
        key: "ground",
        name: "Ground Pork",
        category: "ground",
        primal: "Various",
        pctOfMeat: 25,
      },
      {
        key: "ribs",
        name: "Ribs",
        category: "rib",
        primal: "Rib",
        pctOfMeat: 15,
      },
    ],
  },
  poultry: {
    id: "poultry",
    label: "Poultry",
    meatPct: 55,
    bonePct: 25,
    fatPct: 5,
    offalPct: 5,
    shrinkPct: 10,
    cuts: [
      {
        key: "breast",
        name: "Breast Portions",
        category: "steak",
        primal: "Breast",
        pctOfMeat: 45,
      },
      {
        key: "thigh_leg",
        name: "Legs & Thighs",
        category: "roast",
        primal: "Leg/Thigh",
        pctOfMeat: 35,
      },
      {
        key: "wings",
        name: "Wings",
        category: "other",
        primal: "Wing",
        pctOfMeat: 10,
      },
      {
        key: "ground",
        name: "Ground Poultry",
        category: "ground",
        primal: "Various",
        pctOfMeat: 10,
      },
    ],
  },
  other: {
    id: "other",
    label: "Other",
    meatPct: 65,
    bonePct: 15,
    fatPct: 7,
    offalPct: 5,
    shrinkPct: 8,
    cuts: [
      {
        key: "primary",
        name: "Primary Cuts",
        category: "roast",
        primal: "Various",
        pctOfMeat: 60,
      },
      {
        key: "ground",
        name: "Ground/Minced",
        category: "ground",
        primal: "Various",
        pctOfMeat: 40,
      },
    ],
  },
};

/**
 * Get a cloned species profile.
 * @param {string} species
 * @returns {object}
 */
function getSpeciesProfile(species) {
  const key = String(species || "other").toLowerCase();
  const base = BASE_SPECIES_PROFILES[key] || BASE_SPECIES_PROFILES.other;
  // Deep-ish clone to avoid mutating the base profile.
  return {
    id: base.id,
    label: base.label,
    meatPct: base.meatPct,
    bonePct: base.bonePct,
    fatPct: base.fatPct,
    offalPct: base.offalPct,
    shrinkPct: base.shrinkPct,
    cuts: base.cuts.map((c) => ({ ...c })),
  };
}

/**
 * Adjust profile based on trim level and grind preference.
 *
 * - trimLevel:
 *   - heavy_trim: more trim fat, slightly less meat.
 *   - leave_fat_cap: more meat (fat left attached), slightly less trim fat.
 *
 * - grindPreference:
 *   - minimal_grind: move some pct from `ground` into non-ground cuts.
 *   - max_grind: move some pct from non-ground cuts into `ground`.
 *
 * @param {object} profile
 * @param {object} processingPreferences
 * @returns {object}
 */
function tuneProfileForPreferences(profile, processingPreferences) {
  const tuned = { ...profile, cuts: profile.cuts.map((c) => ({ ...c })) };
  const { trimLevel = "standard_trim", grindPreference = "balanced_grind" } =
    processingPreferences || {};

  // --- Trim tuning ---
  if (trimLevel === "heavy_trim") {
    // +3% trim, -3% meat if possible.
    const delta = 3;
    if (tuned.meatPct - delta >= 40) {
      tuned.meatPct -= delta;
      tuned.fatPct += delta;
    }
  } else if (trimLevel === "leave_fat_cap") {
    // +3% meat, -3% trim if possible.
    const delta = 3;
    if (tuned.fatPct - delta >= 0) {
      tuned.meatPct += delta;
      tuned.fatPct -= delta;
    }
  }

  // --- Grind tuning ---
  const groundIndex = tuned.cuts.findIndex((c) => c.key === "ground");
  if (groundIndex !== -1) {
    const ground = tuned.cuts[groundIndex];

    if (grindPreference === "minimal_grind") {
      // Move 10 points out of ground into non-ground cuts if possible.
      const transfer = 10;
      if (ground.pctOfMeat > transfer) {
        ground.pctOfMeat -= transfer;
        distributePctToOthers(tuned.cuts, groundIndex, transfer);
      }
    } else if (grindPreference === "max_grind") {
      // Move 10 points into ground from other cuts.
      const transfer = 10;
      const taken = takePctFromOthers(tuned.cuts, groundIndex, transfer);
      ground.pctOfMeat += taken;
    }
  }

  // Normalize cut percentages to sum to 100 (defensive).
  normalizeCutPercentages(tuned.cuts);

  return tuned;
}

/**
 * Distribute percentage points across all cuts except the excluded index.
 * @param {Array} cuts
 * @param {number} excludedIndex
 * @param {number} pct
 */
function distributePctToOthers(cuts, excludedIndex, pct) {
  const recipients = cuts.filter((_, idx) => idx !== excludedIndex);
  if (!recipients.length || pct <= 0) return;
  const per = pct / recipients.length;
  recipients.forEach((c) => {
    c.pctOfMeat = (c.pctOfMeat || 0) + per;
  });
}

/**
 * Take up to `pct` points from other cuts and return how much was actually taken.
 * @param {Array} cuts
 * @param {number} excludedIndex
 * @param {number} pct
 * @returns {number}
 */
function takePctFromOthers(cuts, excludedIndex, pct) {
  let remaining = pct;
  cuts.forEach((c, idx) => {
    if (idx === excludedIndex || remaining <= 0) return;
    const available = Math.max(0, (c.pctOfMeat || 0) - 5); // keep minimum 5%
    const take = Math.min(available, remaining);
    if (take > 0) {
      c.pctOfMeat -= take;
      remaining -= take;
    }
  });
  return pct - remaining;
}

/**
 * Normalize cut pctOfMeat so they sum to ~100.
 * @param {Array} cuts
 */
function normalizeCutPercentages(cuts) {
  const sum = cuts.reduce((acc, c) => acc + (c.pctOfMeat || 0), 0);
  if (!sum || sum <= 0) return;
  cuts.forEach((c) => {
    c.pctOfMeat = (c.pctOfMeat || 0) * (100 / sum);
  });
}

/* -------------------------------------------------------------------------- */
/* Summary Builder                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Build summary object according to schema from tuned profile and basis info.
 *
 * @param {object} profile
 * @param {'hot_carcass'|'chilled_carcass'|'live'} basisType
 * @param {number} basisWeight
 * @param {'lb'|'kg'} weightUnit
 * @returns {object}
 */
function buildSummaryFromProfile(profile, basisType, basisWeight, weightUnit) {
  const clampPct = (n) => Math.max(0, Math.min(100, n));

  const meatPct = clampPct(profile.meatPct);
  const bonePct = clampPct(profile.bonePct);
  const fatPct = clampPct(profile.fatPct);
  const offalPct = clampPct(profile.offalPct);
  const shrinkPct = clampPct(profile.shrinkPct);

  const basis = basisWeight;

  const totalUsableMeatWeight = (basis * meatPct) / 100;
  const totalBoneWeight = (basis * bonePct) / 100;
  const totalTrimFatWeight = (basis * fatPct) / 100;
  const totalOffalWeight = (basis * offalPct) / 100;

  // Simple servings assumption: 0.5 lb (or 0.23kg) per serving.
  const servingSize =
    weightUnit === "kg"
      ? 0.23 // ~230g
      : 0.5; // 8oz/0.5lb

  const estimatedTotalServings =
    servingSize > 0 ? totalUsableMeatWeight / servingSize : 0;

  return {
    basisType,
    basisWeight,
    weightUnit,
    totalUsableMeatWeight,
    totalBoneWeight,
    totalTrimFatWeight,
    totalOffalWeight,
    yieldPercentages: {
      meatPct,
      bonePct,
      trimFatPct: fatPct,
      offalPct,
      shrinkLossPct: shrinkPct,
    },
    estimatedTotalServings,
  };
}

/* -------------------------------------------------------------------------- */
/* Cuts & Byproducts Builders                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Build per-cut records from the tuned profile and summary.
 *
 * @param {object} profile
 * @param {object} summary
 * @param {'lb'|'kg'} weightUnit
 * @returns {Array<object>}
 */
function buildCutsFromProfile(profile, summary, weightUnit) {
  const cuts = [];
  const totalMeat = summary.totalUsableMeatWeight || 0;
  const basis = summary.basisWeight || 0;
  const basisSafe = basis > 0 ? basis : 1;

  const servingSize =
    weightUnit === "kg"
      ? 0.23 // ~230g
      : 0.5; // ~0.5lb / 8oz

  profile.cuts.forEach((c, index) => {
    const pctOfMeat = typeof c.pctOfMeat === "number" ? c.pctOfMeat : 0;
    const weight = (totalMeat * pctOfMeat) / 100;
    const yieldPctOfBasis = (weight / basisSafe) * 100;

    const estimatedServings = servingSize > 0 ? weight / servingSize : 0;

    // Packaging defaults: aim for ~1.5lb/0.7kg packages.
    const targetPerPackage = weightUnit === "kg" ? 0.7 : 1.5;
    const packages =
      weight > 0 ? Math.max(1, Math.round(weight / targetPerPackage)) : 0;
    const weightPerPackage = packages > 0 ? weight / packages : 0;
    const servingsPerPackage = packages > 0 ? estimatedServings / packages : 0;

    cuts.push({
      id: `cut_${c.key || index}`,
      name: c.name || "Cut",
      category: c.category || "roast",
      primal: c.primal || "Various",
      subPrimal: c.subPrimal || "",
      boneIn: c.category === "chop" || c.category === "rib",
      weight,
      weightUnit,
      yieldPctOfBasis,
      yieldPctOfMeat: pctOfMeat,
      estimatedServings,
      servingSizeUnit: weightUnit === "kg" ? "kg" : "lb",
      packagePlan: {
        packages,
        weightPerPackage,
        servingsPerPackage,
      },
      intendedUse: "family_meals",
      storehouseLink: {
        inventoryItemId: "",
        preferredRecipeIds: [],
      },
      notes: "",
    });
  });

  return cuts;
}

/**
 * Build byproduct records (bones, fat, offal) from summary & profile.
 *
 * @param {object} profile
 * @param {object} summary
 * @param {'lb'|'kg'} weightUnit
 * @returns {Array<object>}
 */
function buildByproductsFromProfile(profile, summary, weightUnit) {
  const byproducts = [];
  const basis = summary.basisWeight || 0;
  const basisSafe = basis > 0 ? basis : 1;

  const addByproduct = (type, label, weight, pctOfBasis, intendedUse) => {
    if (!weight || weight <= 0) return;
    byproducts.push({
      type,
      label,
      weight,
      weightUnit,
      yieldPctOfBasis: pctOfBasis,
      intendedUse,
      storehouseLink: {
        inventoryItemId: "",
      },
      notes: "",
    });
  };

  const boneWeight = summary.totalBoneWeight || 0;
  const bonePct = (boneWeight / basisSafe) * 100;
  addByproduct("bone", "Soup/Stock Bones", boneWeight, bonePct, "stock");

  const fatWeight = summary.totalTrimFatWeight || 0;
  const fatPct = (fatWeight / basisSafe) * 100;
  addByproduct(
    "fat",
    "Trim Fat (Tallow/Lard)",
    fatWeight,
    fatPct,
    profile.id === "pork" ? "render_lard" : "render_tallow"
  );

  const offalWeight = summary.totalOffalWeight || 0;
  const offalPct = (offalWeight / basisSafe) * 100;
  addByproduct("organ", "Organs & Offal", offalWeight, offalPct, "stock");

  return byproducts;
}

/* -------------------------------------------------------------------------- */
/* Hub Export                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Export calculator payload to the Hub when familyFundMode is enabled.
 *
 * Safe-guards:
 * - Feature-flag gated.
 * - Only calls helpers if they expose expected functions.
 * - Logs but does not throw on failure.
 *
 * @param {object} calculatorPayload
 * @returns {Promise<void>}
 */
async function exportToHubIfEnabled(calculatorPayload) {
  if (!familyFundMode) return;

  try {
    const hasFormatter =
      HubPacketFormatter &&
      typeof HubPacketFormatter.buildPacket === "function";
    const hasConnector =
      FamilyFundConnector && typeof FamilyFundConnector.send === "function";

    if (!hasFormatter || !hasConnector) {
      console.warn(
        "[MeatBreakdownCalculator] Hub export helpers missing or incomplete; skipping export."
      );
      return;
    }

    const packet = HubPacketFormatter.buildPacket({
      kind: "calculator",
      calculatorId: "MeatBreakdownCalculator",
      payload: calculatorPayload,
    });

    await FamilyFundConnector.send(packet);

    emit({
      type: "calculator.meatBreakdown.exported",
      ts: new Date().toISOString(),
      source: "features/calculators/storehouseMeals/MeatBreakdownCalculator",
      data: {
        calculatorId: "MeatBreakdownCalculator",
        hubPacketId: packet.id || null,
      },
    });
  } catch (err) {
    console.error("[MeatBreakdownCalculator] Failed to export to Hub:", err);
    // Fail silently from the perspective of the caller.
  }
}

export default MeatBreakdownCalculatorShim;
