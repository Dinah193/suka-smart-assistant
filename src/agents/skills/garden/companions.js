/**
 * companions.js
 * --------------
 * How this fits:
 * - Lives under: src/agents/skills/garden/companions.js
 * - Used by: Garden Planner, Bed Layout pages, Homestead Planner, and SessionRunner
 *   when building “Now” garden sessions (e.g., sowing / transplanting runs).
 * - Responsibility: Given plants/crops, look up companion & antagonist relationships
 *   from Dexie (and a small built-in rule set) and return structured data PLUS
 *   “swap options” that a root-mounted Companion Swap Modal can render.
 *
 * Swap Modal Integration:
 * - This file is pure logic; it does NOT render React.
 * - It returns `swapOptions` for each plant, shaped for a modal that:
 *   • shows Neutral vs “Max companions” vs “Avoid antagonists” layouts,
 *   • can stay mounted at app root (portal in App.jsx),
 *   • can persist user choices in Dexie and resume if they navigate away.
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
 * @typedef {Object} GardenPlant
 * @property {string} id
 * @property {string} name                 - Common name (e.g., "Tomato").
 * @property {string} [latinName]
 * @property {string} [family]
 * @property {string[]} [tags]             - e.g. ["nightshade","heavy-feeder"].
 * @property {string} [bedId]              - Garden bed / zone id.
 */

/**
 * Relation between plants.
 *
 * @typedef {Object} CompanionRelation
 * @property {string} id
 * @property {string} plantKey             - Normalized key for the “subject” plant.
 * @property {string} otherKey             - Normalized key for the “partner” plant.
 * @property {"companion"|"antagonist"|"rotation"} relation
 * @property {"strong"|"moderate"|"weak"} [strength]
 * @property {string} [notes]
 * @property {string} [source]             - "extensionService","book","user","builtin", etc.
 * @property {number} [confidence]         - 0–1 heuristic confidence.
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * Swap option for the Companion Swap Modal.
 *
 * @typedef {Object} GardenCompanionSwapOption
 * @property {string} id
 * @property {string} label                - e.g., "Balanced layout", "Max companions".
 * @property {string} summary              - UX-friendly text for the modal.
 * @property {string[]} companions         - Plant keys recommended nearby.
 * @property {string[]} antagonists        - Plant keys to avoid nearby.
 * @property {string[]} rotations          - Crop-rotation follow-ups.
 * @property {boolean} autoSelected
 * @property {boolean} [isNeutral]
 * @property {string[]} badges             - e.g. ["DEFAULT","AGGRESSIVE","SAFE"].
 */

/**
 * Result per plant.
 *
 * @typedef {Object} GardenCompanionResultItem
 * @property {GardenPlant} plant
 * @property {string} key
 * @property {CompanionRelation[]} companions
 * @property {CompanionRelation[]} antagonists
 * @property {CompanionRelation[]} rotations
 * @property {GardenCompanionSwapOption[]} swapOptions
 * @property {string|null} chosenSwapId
 * @property {string|null} error
 */

/**
 * Options for lookup.
 *
 * @typedef {Object} GardenCompanionLookupOptions
 * @property {string} [eventSource="garden"]
 * @property {boolean} [includeRotations=true]
 * @property {Record<string,string>} [chosenSwapByPlantId] - For resume (plantId → swapId).
 */

/* -------------------------------------------------------------------------- */
/* Built-in fallback rule set                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A tiny, opinionated fallback rule set for common crops.
 * This is only used if Dexie has no companion data.
 * Keys must be normalized (see normalizePlantKey).
 *
 * NOTE: This is intentionally small and serves as an extension point;
 * you can grow this over time or import from JSON.
 */
const FALLBACK_RULES = {
  tomato: {
    companions: ["basil", "marigold", "onion", "garlic", "parsley"],
    antagonists: ["cabbage", "broccoli", "cauliflower", "fennel", "corn"],
    rotations: ["beans", "peas"],
    notes: "Classic companions: basil + marigold; avoid brassicas and fennel.",
  },
  basil: {
    companions: ["tomato", "pepper", "oregano"],
    antagonists: ["rue"],
    rotations: [],
    notes: "Often interplanted with tomatoes and peppers.",
  },
  carrot: {
    companions: ["onion", "leek", "rosemary", "sage"],
    antagonists: ["dill", "parsnip"],
    rotations: [],
    notes: "Onion family deters carrot fly; avoid dill nearby.",
  },
  cabbage: {
    companions: ["dill", "onion", "garlic", "celery"],
    antagonists: ["strawberry", "tomato"],
    rotations: ["beans"],
    notes: "Avoid planting near strawberries and tomatoes.",
  },
  lettuce: {
    companions: ["carrot", "radish", "strawberry"],
    antagonists: ["celery", "parsley"],
    rotations: [],
    notes: "Enjoys light shade from taller companions.",
  },
};

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
    console.error("[garden/companions] Failed to emit event:", type, err);
  }
}

/**
 * Normalize a plant to a lookup key (lowercase slug).
 * Prefers `slug` → `name` → `latinName`.
 *
 * @param {GardenPlant} plant
 * @returns {string}
 */
function normalizePlantKey(plant) {
  if (!plant || typeof plant !== "object") return "unknown";

  const base =
    plant.slug ||
    plant.name ||
    plant.latinName ||
    plant.id ||
    "unknown";

  return String(base)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Build a relation object from fallback rules.
 *
 * @param {string} plantKey
 * @param {string} otherKey
 * @param {"companion"|"antagonist"|"rotation"} relation
 * @param {string} [note]
 * @returns {CompanionRelation}
 */
function buildFallbackRelation(plantKey, otherKey, relation, note) {
  const now = new Date().toISOString();
  return {
    id: `builtin:${plantKey}:${relation}:${otherKey}`,
    plantKey,
    otherKey,
    relation,
    strength: "moderate",
    notes: note || null,
    source: "builtin",
    confidence: 0.7,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Merge Dexie relations with fallback rules for a given plant key.
 *
 * @param {string} plantKey
 * @param {CompanionRelation[]} allDbRelations
 * @returns {{ companions: CompanionRelation[], antagonists: CompanionRelation[], rotations: CompanionRelation[] }}
 */
function gatherRelationsForKey(plantKey, allDbRelations) {
  /** @type {CompanionRelation[]} */
  const companions = [];
  /** @type {CompanionRelation[]} */
  const antagonists = [];
  /** @type {CompanionRelation[]} */
  const rotations = [];

  // 1) DB relations – treat as primary.
  for (const rel of allDbRelations) {
    if (!rel || (!rel.plantKey && !rel.otherKey)) continue;

    // Make relation symmetric: if plantKey matches, otherKey is partner; if otherKey matches, plantKey is partner.
    // We build a normalized view where "plantKey" is always the LOOKUP key.
    let subjectKey = null;
    let partnerKey = null;

    if (rel.plantKey === plantKey) {
      subjectKey = rel.plantKey;
      partnerKey = rel.otherKey;
    } else if (rel.otherKey === plantKey) {
      subjectKey = rel.otherKey;
      partnerKey = rel.plantKey;
    }

    if (!subjectKey || !partnerKey) continue;

    const normalized = {
      ...rel,
      plantKey: subjectKey,
      otherKey: partnerKey,
    };

    if (rel.relation === "companion") companions.push(normalized);
    else if (rel.relation === "antagonist") antagonists.push(normalized);
    else if (rel.relation === "rotation") rotations.push(normalized);
  }

  // 2) Fallback rules (only if DB is empty for that type).
  const fallback = FALLBACK_RULES[plantKey];
  if (fallback) {
    const baseNote = fallback.notes || `Fallback companions for ${plantKey}.`;

    if (companions.length === 0 && Array.isArray(fallback.companions)) {
      for (const c of fallback.companions) {
        companions.push(
          buildFallbackRelation(plantKey, c, "companion", baseNote)
        );
      }
    }

    if (antagonists.length === 0 && Array.isArray(fallback.antagonists)) {
      for (const a of fallback.antagonists) {
        antagonists.push(
          buildFallbackRelation(plantKey, a, "antagonist", baseNote)
        );
      }
    }

    if (rotations.length === 0 && Array.isArray(fallback.rotations)) {
      for (const r of fallback.rotations) {
        rotations.push(
          buildFallbackRelation(plantKey, r, "rotation", baseNote)
        );
      }
    }
  }

  return { companions, antagonists, rotations };
}

/**
 * Build swap options for a plant given its relations.
 * The options power a root-mounted Companion Swap Modal:
 * - Neutral: no enforcement, informational only.
 * - Balanced / Max companions / Avoid antagonists:
 *   different “modes” for layout/suggestions.
 *
 * @param {GardenPlant} plant
 * @param {CompanionRelation[]} companions
 * @param {CompanionRelation[]} antagonists
 * @param {CompanionRelation[]} rotations
 * @returns {GardenCompanionSwapOption[]}
 */
function buildSwapOptionsForPlant(plant, companions, antagonists, rotations) {
  const key = normalizePlantKey(plant);

  const companionKeys = Array.from(
    new Set(companions.map((r) => r.otherKey).filter(Boolean))
  );
  const antagonistKeys = Array.from(
    new Set(antagonists.map((r) => r.otherKey).filter(Boolean))
  );
  const rotationKeys = Array.from(
    new Set(rotations.map((r) => r.otherKey).filter(Boolean))
  );

  // Neutral / Informational
  /** @type {GardenCompanionSwapOption[]} */
  const options = [
    {
      id: `${plant.id}:neutral`,
      label: "Neutral (informational only)",
      summary:
        "Show companion / antagonist info, but do not enforce layout rules.",
      companions: companionKeys,
      antagonists: antagonistKeys,
      rotations: rotationKeys,
      autoSelected: true,
      isNeutral: true,
      badges: ["DEFAULT", "VIEW-ONLY"],
    },
  ];

  if (companionKeys.length > 0) {
    options.push({
      id: `${plant.id}:max-companions`,
      label: "Max companions nearby",
      summary:
        "Prioritize grouping this plant with as many compatible companions as possible.",
      companions: companionKeys,
      antagonists: [],
      rotations: rotationKeys,
      autoSelected: false,
      isNeutral: false,
      badges: ["AGGRESSIVE", "COMPANION-HEAVY"],
    });
  }

  if (antagonistKeys.length > 0) {
    options.push({
      id: `${plant.id}:avoid-antagonists`,
      label: "Avoid antagonists",
      summary:
        "Enforce spacing so antagonistic plants are not placed in the same bed or row.",
      companions: [],
      antagonists: antagonistKeys,
      rotations: rotationKeys,
      autoSelected: false,
      isNeutral: false,
      badges: ["SAFE", "CONSERVATIVE"],
    });
  }

  if (companionKeys.length > 0 && antagonistKeys.length > 0) {
    options.push({
      id: `${plant.id}:balanced`,
      label: "Balanced companions & avoidances",
      summary:
        "Try to keep key companions nearby while avoiding the worst antagonists.",
      companions: companionKeys.slice(0, 5), // top subset
      antagonists: antagonistKeys.slice(0, 5),
      rotations: rotationKeys,
      autoSelected: false,
      isNeutral: false,
      badges: ["BALANCED"],
    });
  }

  // Ensure exactly one autoSelected if any more options exist.
  if (options.length > 1) {
    // Keep Neutral as default autoSelected.
  }

  return options;
}

/* -------------------------------------------------------------------------- */
/* Dexie helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Fetch all companion relations from Dexie (if table exists).
 * You can scope this to a zone or family in the future if needed.
 *
 * @returns {Promise<CompanionRelation[]>}
 */
async function fetchAllCompanionRelationsFromDb() {
  if (!db || !db.gardenCompanions) return [];
  try {
    if (db.gardenCompanions.toArray) {
      const arr = await db.gardenCompanions.toArray();
      return Array.isArray(arr) ? arr : [];
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[garden/companions] Failed to read gardenCompanions:", err);
  }
  return [];
}

/* -------------------------------------------------------------------------- */
/* Hub export                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Export companion lookup results to the Hub, if familyFundMode is enabled.
 *
 * @param {GardenCompanionResultItem[]} results
 * @param {string} eventSource
 */
async function exportCompanionsToHub(results, eventSource) {
  if (!familyFundMode || !results || !results.length) return;

  try {
    const payload = HubPacketFormatter.formatGardenCompanions(results, {
      source: eventSource,
      exportedAt: new Date().toISOString(),
    });
    await FamilyFundConnector.send(payload);
    emit("garden.companions.exported", eventSource, {
      plants: results.length,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[garden/companions] Hub export failed (soft):", err);
  }
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Look up companion / antagonist / rotation relationships for a list of plants.
 *
 * Emits:
 * - garden.companions.lookup.requested
 * - garden.companions.swapOptions.built (per plant)
 * - garden.companions.lookup.completed
 * - garden.companions.exported (on Hub export success)
 *
 * Swap Modal:
 * - The returned `results` items contain:
 *   • swapOptions[] (GardenCompanionSwapOption) per plant
 *   • chosenSwapId for resume (use options.chosenSwapByPlantId)
 *
 * @param {GardenPlant[]} plants
 * @param {GardenCompanionLookupOptions} [options]
 * @returns {Promise<{ results: GardenCompanionResultItem[], meta: { plants: number, errors: number } }>}
 */
export async function lookupPlantCompanions(plants, options = {}) {
  const {
    eventSource = "garden",
    includeRotations = true,
    chosenSwapByPlantId = {},
  } = options;

  const safePlants = Array.isArray(plants) ? plants : [];

  emit("garden.companions.lookup.requested", eventSource, {
    plants: safePlants.length,
  });

  const allRelations = await fetchAllCompanionRelationsFromDb();

  /** @type {GardenCompanionResultItem[]} */
  const results = [];
  let errorCount = 0;

  for (const plant of safePlants) {
    const key = normalizePlantKey(plant);

    /** @type {GardenCompanionResultItem} */
    const result = {
      plant,
      key,
      companions: [],
      antagonists: [],
      rotations: [],
      swapOptions: [],
      chosenSwapId: null,
      error: null,
    };

    try {
      const { companions, antagonists, rotations } = gatherRelationsForKey(
        key,
        allRelations
      );

      result.companions = companions;
      result.antagonists = antagonists;
      result.rotations = includeRotations ? rotations : [];

      const swapOptions = buildSwapOptionsForPlant(
        plant,
        companions,
        antagonists,
        includeRotations ? rotations : []
      );
      result.swapOptions = swapOptions;

      // Respect previously chosen swap for resume.
      const resumeId = chosenSwapByPlantId[plant.id];
      const chosen =
        (resumeId && swapOptions.find((opt) => opt.id === resumeId)) ||
        swapOptions.find((opt) => opt.autoSelected) ||
        swapOptions[0] ||
        null;

      result.chosenSwapId = chosen ? chosen.id : null;

      emit("garden.companions.swapOptions.built", eventSource, {
        plantId: plant.id,
        key,
        optionsCount: swapOptions.length,
        autoSelectedId:
          swapOptions.find((opt) => opt.autoSelected)?.id || null,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        "[garden/companions] Failed to compute companions for plant:",
        plant,
        err
      );
      result.error = err?.message || String(err);
      errorCount += 1;
    }

    results.push(result);
  }

  emit("garden.companions.lookup.completed", eventSource, {
    plants: results.length,
    errors: errorCount,
  });

  // Fire-and-forget Hub export.
  exportCompanionsToHub(results, eventSource).catch(() => {});

  return {
    results,
    meta: {
      plants: results.length,
      errors: errorCount,
    },
  };
}

/**
 * Convenience helper:
 * Get companions/antagonists for a single plant.
 *
 * @param {GardenPlant} plant
 * @param {GardenCompanionLookupOptions} [options]
 * @returns {Promise<GardenCompanionResultItem|null>}
 */
export async function lookupSinglePlantCompanions(plant, options = {}) {
  const { results } = await lookupPlantCompanions([plant], options);
  return results[0] || null;
}
