/**
 * compostPlan.js
 * --------------
 * How this fits:
 * - Lives under: src/agents/skills/garden/compostPlan.js
 * - Used by: Garden Dashboard, Kitchen Cleanup, Animal Care pages, and
 *   SessionRunner when building “Now” composting sessions for waste streams.
 *
 * Responsibilities:
 * - Given a set of waste materials (kitchen scraps, garden waste, bedding, paper, etc.)
 *   decide where each should go:
 *   • hot compost bins
 *   • worm bins
 *   • leaf-mold / brown stockpile
 *   • mulch-in-place / sheet compost
 *   • trash / burn / “do not compost” fallback
 * - Provide “swap options” for each material so a Compost Routing Swap Modal
 *   can let the user choose alternate routes while:
 *   • remaining mounted at app root (portal),
 *   • persisting choices in Dexie,
 *   • resuming even if the user navigates away.
 * - Emit SSA events and optionally export analytics to the Hub.
 */

import { db } from "../../../services/db";
import { emitEvent } from "../../../services/eventBus";
import { familyFundMode } from "../../../services/featureFlags";
import { HubPacketFormatter } from "../../../services/hub/HubPacketFormatter";
import { FamilyFundConnector } from "../../../services/hub/FamilyFundConnector";

/* -------------------------------------------------------------------------- */
/* Typedefs                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {"kitchen"|"garden"|"animal"|"paper"|"wood"|"other"} WasteCategory
 */

/**
 * Waste material to route into a compost / waste stream.
 *
 * @typedef {Object} WasteMaterial
 * @property {string} id
 * @property {string} name                 - e.g. "Onion skins", "Straw bedding".
 * @property {WasteCategory} category
 * @property {string[]} [tags]             - e.g. ["green","high-n","oily","meat","dairy","manure","bedding","weedy","seed-heads"].
 * @property {number} [carbonNitrogenRatio] - Optional C:N estimate.
 * @property {"wet"|"dry"|"balanced"} [moisture]
 * @property {number} [quantity]          - Quantity in local units (e.g. buckets).
 * @property {string} [unit]              - e.g. "bucket","kg","lb".
 * @property {"cooking"|"garden"|"animals"|"preservation"|"storehouse"} [sourceDomain]
 * @property {string} [createdAt]         - ISO timestamp when waste was logged.
 */

/**
 * Compost bin / pile description (Dexie record).
 *
 * @typedef {Object} CompostBin
 * @property {string} id
 * @property {string} name
 * @property {"hot"|"cold"|"worm"|"leafMold"|"sheet"} type
 * @property {string[]} [allowedCategories] - WasteCategory[] that can go here; empty/undefined = all.
 * @property {string[]} [allowedTags]       - tags which are particularly suited.
 * @property {number} [capacityUnits]       - Max units (e.g. buckets).
 * @property {number} [currentLoadUnits]    - Current fill.
 * @property {string} [locationId]
 * @property {string} [locationName]
 * @property {string} [notes]
 */

/**
 * Routing destination for a material (used for swap options).
 *
 * @typedef {Object} CompostRoutingDestination
 * @property {string} id
 * @property {"compostBin"|"wormBin"|"leafPile"|"mulchInPlace"|"trash"|"other"} kind
 * @property {string} label
 * @property {string|null} binId            - For compostBin/wormBin etc.
 * @property {string|null} locationName
 * @property {number|null} estimatedReadyDays
 * @property {string|null} notes
 */

/**
 * Swap option for the Compost Routing Swap Modal.
 *
 * @typedef {Object} CompostSwapOption
 * @property {string} id
 * @property {string} label                - e.g. "Hot compost bin", "Worm bin"
 * @property {string} summary              - UX text for the modal.
 * @property {CompostRoutingDestination} destination
 * @property {boolean} autoSelected
 * @property {boolean} [isNeutral]
 * @property {string[]} badges             - e.g. ["DEFAULT","FAST","SAFE","NO-COMPOST"]
 */

/**
 * Result per waste material.
 *
 * @typedef {Object} CompostPlanResultItem
 * @property {WasteMaterial} material
 * @property {string} routeId              - Stable id (e.g. "cm_<materialId>").
 * @property {CompostSwapOption[]} swapOptions
 * @property {string|null} chosenSwapId
 * @property {CompostRoutingDestination|null} primaryDestination
 * @property {string|null} error
 */

/**
 * Options for compost planning.
 *
 * @typedef {Object} CompostPlanOptions
 * @property {string} [eventSource="garden"]
 * @property {number} [nowTs]              - Timestamp; defaults to Date.now().
 * @property {Record<string,string>} [chosenSwapByRouteId] - Resume map: routeId → swapId.
 */

/* -------------------------------------------------------------------------- */
/* Utilities                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * SSA event wrapper.
 * @param {string} type
 * @param {string} source
 * @param {any} data
 */
function emit(type, source, data) {
  try {
    emitEvent({
      type,
      ts: new Date().toISOString(),
      source,
      data,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[garden/compostPlan] Failed to emit event:", type, err);
  }
}

/* -------------------------------------------------------------------------- */
/* Dexie helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Fetch compost bins from Dexie (if table exists).
 * @returns {Promise<CompostBin[]>}
 */
async function fetchCompostBins() {
  if (!db || !db.compostBins) return [];
  try {
    if (db.compostBins.toArray) {
      const bins = await db.compostBins.toArray();
      return Array.isArray(bins) ? bins : [];
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[garden/compostPlan] Failed to read compostBins:", err);
  }
  return [];
}

/* -------------------------------------------------------------------------- */
/* Routing heuristics                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Quick categorization helpers.
 */
function isGreen(material) {
  if (!material) return false;
  if (material.tags?.includes("green")) return true;
  if (material.moisture === "wet") return true;
  if (material.category === "kitchen") return true;
  if (material.category === "animal" && material.tags?.includes("manure")) return true;
  return false;
}

function isBrown(material) {
  if (!material) return false;
  if (material.tags?.includes("brown")) return true;
  if (material.moisture === "dry") return true;
  if (material.category === "paper" || material.category === "wood") return true;
  if (material.tags?.includes("bedding")) return true;
  return false;
}

function isRisky(material) {
  if (!material) return false;
  return Boolean(
    material.tags?.includes("meat") ||
      material.tags?.includes("dairy") ||
      material.tags?.includes("oily") ||
      material.tags?.includes("diseased") ||
      material.tags?.includes("seed-heads")
  );
}

function isWormFriendly(material) {
  if (!material) return false;
  if (material.tags?.includes("citrus")) return false;
  if (material.tags?.includes("spicy")) return false;
  if (material.tags?.includes("onion")) return false;
  if (material.tags?.includes("garlic")) return false;
  if (material.tags?.includes("meat") || material.tags?.includes("dairy")) return false;
  if (material.category === "paper" && material.tags?.includes("shiny")) return false;
  return material.category === "kitchen" || material.tags?.includes("soft");
}

/**
 * Score how well a material fits a given bin.
 * Higher score = better match.
 *
 * @param {WasteMaterial} material
 * @param {CompostBin} bin
 * @returns {number}
 */
function scoreMaterialForBin(material, bin) {
  let score = 0;

  // Category fit
  if (!bin.allowedCategories || bin.allowedCategories.length === 0) {
    score += 5;
  } else if (bin.allowedCategories.includes(material.category)) {
    score += 8;
  }

  // Tag fit
  if (Array.isArray(bin.allowedTags) && Array.isArray(material.tags)) {
    const overlap = material.tags.filter((t) => bin.allowedTags.includes(t));
    score += overlap.length * 3;
  }

  const green = isGreen(material);
  const brown = isBrown(material);
  const risky = isRisky(material);

  if (bin.type === "worm") {
    if (isWormFriendly(material)) score += 10;
    if (risky) score -= 10;
  } else if (bin.type === "hot") {
    if (green) score += 6;
    if (brown) score += 4;
    if (risky) score -= 4;
  } else if (bin.type === "leafMold") {
    if (brown) score += 8;
    if (green) score -= 4;
  } else if (bin.type === "sheet") {
    if (brown || material.category === "garden") score += 6;
  } else if (bin.type === "cold") {
    if (brown || !risky) score += 4;
  }

  // Capacity hint (avoid overfilling)
  const capacity = bin.capacityUnits || 0;
  const load = bin.currentLoadUnits || 0;
  if (capacity > 0) {
    const remaining = capacity - load;
    if (remaining <= 0) {
      score -= 8; // overloaded
    } else if (remaining < capacity * 0.25) {
      score -= 2;
    } else {
      score += 2;
    }
  }

  return score;
}

/**
 * Construct a routing destination object for a bin.
 *
 * @param {CompostBin} bin
 * @returns {CompostRoutingDestination}
 */
function destFromBin(bin) {
  let kind = "compostBin";
  if (bin.type === "worm") kind = "wormBin";
  else if (bin.type === "leafMold") kind = "leafPile";
  else if (bin.type === "sheet") kind = "mulchInPlace";

  let estimatedReadyDays = null;
  if (bin.type === "hot") estimatedReadyDays = 30;
  else if (bin.type === "worm") estimatedReadyDays = 60;
  else if (bin.type === "cold") estimatedReadyDays = 180;
  else if (bin.type === "leafMold") estimatedReadyDays = 365;
  else if (bin.type === "sheet") estimatedReadyDays = 120;

  return {
    id: `dest:bin:${bin.id}`,
    kind,
    label: bin.name,
    binId: bin.id,
    locationName: bin.locationName || null,
    estimatedReadyDays,
    notes: bin.notes || null,
  };
}

/**
 * Fallback destinations when no compost bins exist.
 *
 * @returns {CompostRoutingDestination[]}
 */
function defaultDestinations() {
  return [
    {
      id: "dest:virtual:hot",
      kind: "compostBin",
      label: "Backyard hot compost pile",
      binId: null,
      locationName: "Garden corner",
      estimatedReadyDays: 45,
      notes: "Generic hot pile; you can create a real bin profile later.",
    },
    {
      id: "dest:virtual:leaf",
      kind: "leafPile",
      label: "Leaf / brown stockpile",
      binId: null,
      locationName: "Fence line",
      estimatedReadyDays: 365,
      notes: "For leaves, straw, paper, and other carbon-heavy materials.",
    },
    {
      id: "dest:virtual:trash",
      kind: "trash",
      label: "Trash / do not compost",
      binId: null,
      locationName: "Household trash",
      estimatedReadyDays: null,
      notes: "For diseased plants, persistent weeds, or unsafe materials.",
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* Swap options building                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Build swap options for a material given candidate destinations.
 *
 * @param {WasteMaterial} material
 * @param {CompostRoutingDestination[]} destinations
 * @returns {CompostSwapOption[]}
 */
function buildSwapOptionsForMaterial(material, destinations) {
  const green = isGreen(material);
  const brown = isBrown(material);
  const risky = isRisky(material);
  const wormFriendly = isWormFriendly(material);

  /** @type {CompostSwapOption[]} */
  const options = [];

  for (const dest of destinations) {
    /** @type {string[]} */
    const badges = [];

    if (dest.kind === "wormBin") {
      badges.push("NUTRIENT-RICH", "SLOW");
      if (!wormFriendly) {
        badges.push("LIMITED");
      }
    } else if (dest.kind === "compostBin") {
      badges.push("FAST");
      if (green && brown) badges.push("BALANCED");
      if (green && !brown) badges.push("GREEN-HEAVY");
      if (brown && !green) badges.push("BROWN-HEAVY");
    } else if (dest.kind === "leafPile") {
      badges.push("BROWN-STORAGE", "SLOW");
    } else if (dest.kind === "mulchInPlace") {
      badges.push("IN-PLACE", "LOW-EFFORT");
    } else if (dest.kind === "trash") {
      badges.push("NO-COMPOST", "SAFE");
    }

    const quantityText =
      material.quantity && material.unit
        ? `${material.quantity} ${material.unit}`
        : "this material";

    let label = dest.label;
    let summary;

    if (dest.kind === "trash") {
      summary = `Send ${quantityText} of ${material.name} to trash / non-compost stream (safest option).`;
    } else if (dest.kind === "wormBin") {
      summary = `Feed ${quantityText} of ${material.name} to worm bin for castings.`;
    } else if (dest.kind === "mulchInPlace") {
      summary = `Use ${quantityText} of ${material.name} as mulch directly in beds / paths.`;
    } else if (dest.kind === "leafPile") {
      summary = `Add ${quantityText} of ${material.name} to brown stockpile / leaf pile.`;
    } else {
      summary = `Add ${quantityText} of ${material.name} to compost bin: ${dest.label}.`;
    }

    options.push({
      id: `${material.id}:${dest.id}`,
      label,
      summary,
      destination: dest,
      autoSelected: false,
      isNeutral: false,
      badges,
    });
  }

  // Neutral “decide later” option
  options.unshift({
    id: `${material.id}:neutral`,
    label: "Decide later / informational only",
    summary:
      "Log this material and see routing suggestions, but do not commit to any bin yet.",
    destination: {
      id: "dest:none",
      kind: "other",
      label: "Unassigned",
      binId: null,
      locationName: null,
      estimatedReadyDays: null,
      notes: "Use this if you want to review compost plan before committing.",
    },
    autoSelected: true,
    isNeutral: true,
    badges: ["DEFAULT", "VIEW-ONLY"],
  });

  // If material is clearly unsafe, mark trash as autoSelected instead.
  if (risky) {
    for (const opt of options) opt.autoSelected = false;
    const trash = options.find((o) => o.destination.kind === "trash");
    if (trash) trash.autoSelected = true;
  }

  return options;
}

/* -------------------------------------------------------------------------- */
/* Hub export                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Export compost plan to Hub (if enabled).
 *
 * @param {CompostPlanResultItem[]} results
 * @param {string} eventSource
 */
async function exportCompostPlanToHub(results, eventSource) {
  if (!familyFundMode || !results || !results.length) return;
  try {
    const payload = HubPacketFormatter.formatCompostPlan(results, {
      source: eventSource,
      exportedAt: new Date().toISOString(),
    });
    await FamilyFundConnector.send(payload);
    emit("garden.compost.plan.exported", eventSource, {
      materials: results.length,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[garden/compostPlan] Hub export failed (soft):", err);
  }
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Plan composting routes for a list of waste materials.
 *
 * Emits:
 * - garden.compost.plan.requested
 * - garden.compost.swapOptions.built (per material)
 * - garden.compost.plan.completed
 * - garden.compost.plan.exported (on Hub export success)
 *
 * Swap Modal:
 * - The returned `results` items contain:
 *   • routeId (stable key for this material’s routing)
 *   • swapOptions[] (CompostSwapOption)
 *   • chosenSwapId (respecting options.chosenSwapByRouteId for resume)
 *   • primaryDestination (CompostRoutingDestination) for the current plan
 *
 * @param {WasteMaterial[]} materials
 * @param {CompostPlanOptions} [options]
 * @returns {Promise<{ results: CompostPlanResultItem[], meta: { materials: number, errors: number } }>}
 */
export async function planCompostForMaterials(materials, options = {}) {
  const {
    eventSource = "garden",
    nowTs = Date.now(), // reserved for future seasonal logic
    chosenSwapByRouteId = {},
  } = options;

  const safeMaterials = Array.isArray(materials) ? materials : [];

  emit("garden.compost.plan.requested", eventSource, {
    materials: safeMaterials.length,
  });

  const bins = await fetchCompostBins();
  const baseDestinations = bins.length
    ? bins.map(destFromBin)
    : defaultDestinations();

  /** @type {CompostPlanResultItem[]} */
  const results = [];
  let errorCount = 0;

  for (const material of safeMaterials) {
    const routeId = `cm_${material.id}`;

    /** @type {CompostPlanResultItem} */
    const result = {
      material,
      routeId,
      swapOptions: [],
      chosenSwapId: null,
      primaryDestination: null,
      error: null,
    };

    try {
      // Score bins specifically for this material, then sort.
      const scored = baseDestinations.map((dest) => {
        if (dest.kind === "compostBin" || dest.kind === "wormBin" || dest.kind === "leafPile" || dest.kind === "mulchInPlace") {
          // If dest was built from a real bin, we can re-score from bin record.
          if (dest.binId && bins.length) {
            const bin = bins.find((b) => b.id === dest.binId);
            if (bin) {
              return { dest, score: scoreMaterialForBin(material, bin) };
            }
          }
        }
        // Generic fallback score.
        let score = 0;
        if (dest.kind === "trash" && isRisky(material)) score += 10;
        if (dest.kind === "compostBin" && (isGreen(material) || isBrown(material))) score += 5;
        if (dest.kind === "leafPile" && isBrown(material)) score += 6;
        if (dest.kind === "wormBin" && isWormFriendly(material)) score += 7;
        return { dest, score };
      });

      scored.sort((a, b) => b.score - a.score);

      const sortedDestinations = scored.map((s) => s.dest);
      const swapOptions = buildSwapOptionsForMaterial(material, sortedDestinations);
      result.swapOptions = swapOptions;

      // Resume-friendly chosen option
      const resumeId = chosenSwapByRouteId[routeId];
      const chosen =
        (resumeId && swapOptions.find((opt) => opt.id === resumeId)) ||
        swapOptions.find((opt) => opt.autoSelected) ||
        swapOptions[0] ||
        null;

      result.chosenSwapId = chosen ? chosen.id : null;
      result.primaryDestination = chosen ? chosen.destination : null;

      emit("garden.compost.swapOptions.built", eventSource, {
        materialId: material.id,
        routeId,
        optionsCount: swapOptions.length,
        autoSelectedId:
          swapOptions.find((opt) => opt.autoSelected)?.id || null,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        "[garden/compostPlan] Failed to plan compost route for material:",
        material,
        err
      );
      result.error = err?.message || String(err);
      errorCount += 1;
    }

    results.push(result);
  }

  emit("garden.compost.plan.completed", eventSource, {
    materials: results.length,
    errors: errorCount,
    ts: new Date(nowTs).toISOString(),
  });

  // Fire-and-forget Hub export
  exportCompostPlanToHub(results, eventSource).catch(() => {});

  return {
    results,
    meta: {
      materials: results.length,
      errors: errorCount,
    },
  };
}

/**
 * Convenience helper:
 * Plan compost routing for a single waste material.
 *
 * @param {WasteMaterial} material
 * @param {CompostPlanOptions} [options]
 * @returns {Promise<CompostPlanResultItem|null>}
 */
export async function planSingleCompost(material, options = {}) {
  const { results } = await planCompostForMaterials([material], options);
  return results[0] || null;
}
