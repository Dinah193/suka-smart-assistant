/**
 * harvestWindow.js
 * ----------------
 * How this fits:
 * - Lives under: src/agents/skills/garden/harvestWindow.js
 * - Used by: Garden Dashboard, Homestead Planner, and SessionRunner when building
 *   “Now” harvest sessions from active plantings.
 *
 * Responsibilities:
 * - Given plantings (crop + actual sow/plant dates), predict harvest windows.
 * - Provide Early / Standard / Late harvest variants per planting.
 * - Attach a "storage link" so SSA can:
 *    • suggest storehouse locations,
 *    • propose preservation sessions (canning, freezing, drying, etc.),
 *    • generate follow-up sessions for the SessionRunner.
 * - Emit SSA events and optionally export analytics to the Hub.
 *
 * Swap Modal Integration:
 * - This file is pure logic; it does NOT render React.
 * - It returns `swapOptions` for each planting, shaped for a root-mounted
 *   HarvestSwapModal that:
 *    • shows Early / Standard / Late harvest options,
 *    • shows storage recommendations for each option,
 *    • persists chosen options in Dexie,
 *    • remains mounted at app root so it can continue running while the user
 *      navigates away from the garden page.
 */

import { db } from "../../../services/db";
import { emitEvent } from "../../../services/events/eventBus";
import { familyFundMode } from "../../../config/featureFlags";
import { HubPacketFormatter } from "@/services/hub/HubPacketFormatter";
import { FamilyFundConnector } from "@/services/hub/FamilyFundConnector";

/* -------------------------------------------------------------------------- */
/* Typedefs                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A planting instance (one block of a crop in bed/zone).
 *
 * @typedef {Object} GardenPlanting
 * @property {string} id
 * @property {string} cropId
 * @property {string} cropName
 * @property {string} [cropSlug]
 * @property {string} [bedId]
 * @property {string[]} [tags]                 - e.g. ["leafy","root","storage-root"].
 * @property {"direct"|"indoor"|"transplant"} [sowType]
 * @property {number} [daysToMaturity]        - Days from sow/plant to first harvest.
 * @property {number} [harvestToleranceDays]  - +/- days around maturity date (default: 7).
 * @property {number} [successionIndex]       - 0-based; helps group successions.
 * @property {string} plantingDate            - ISO string (YYYY-MM-DD or full ISO).
 * @property {number} [expectedYield]         - Approximate total yield (kg, lb, bunches, etc.).
 * @property {string} [storageProfileId]      - Optional link to a storage profile.
 */

/**
 * Frost dates (optional; used to clamp late harvest windows).
 *
 * @typedef {Object} FrostDates
 * @property {string|null} lastSpringFrost  - ISO date string (YYYY-MM-DD or full ISO).
 * @property {string|null} firstFallFrost   - ISO date string (YYYY-MM-DD or full ISO).
 */

/**
 * Storage link metadata, used to connect harvest → storehouse / preservation.
 *
 * @typedef {Object} StorageLink
 * @property {string} storageMethod          - "fresh"|"cool-storage"|"frozen"|"canned"|"dehydrated"|"fermented"
 * @property {string|null} locationId        - Storehouse location id (root cellar, fridge, freezer, pantry).
 * @property {string|null} locationName
 * @property {number|null} expectedShelfLifeDays
 * @property {string|null} preservationPlanId
 * @property {string|null} inventoryCategoryId
 * @property {string|null} notes
 */

/**
 * A harvest window for a planting.
 *
 * @typedef {Object} HarvestWindow
 * @property {string} id
 * @property {string} plantingId
 * @property {number} index
 * @property {"early"|"standard"|"late"} variant
 * @property {string} windowStart             - ISO date (YYYY-MM-DD)
 * @property {string} windowEnd               - ISO date (YYYY-MM-DD)
 * @property {string} targetDate              - ISO date (YYYY-MM-DD)
 * @property {string[]} blockers              - ["weather","sabbath","equipment","inventory"]
 * @property {string|null} notes
 */

/**
 * Swap option for the HarvestSwapModal.
 *
 * @typedef {Object} HarvestSwapOption
 * @property {string} id
 * @property {string} label                   - e.g. "Early harvest", "Standard harvest"
 * @property {string} summary                 - UX text for the modal.
 * @property {"early"|"standard"|"late"} variant
 * @property {string} windowStart
 * @property {string} windowEnd
 * @property {string} targetDate
 * @property {boolean} autoSelected
 * @property {boolean} [isNeutral]
 * @property {string[]} badges                - e.g. ["MAX-FLAVOR","MAX-YIELD","STORAGE-OPTIMAL"]
 * @property {StorageLink[]} storageLinks
 */

/**
 * Result per planting.
 *
 * @typedef {Object} GardenHarvestResultItem
 * @property {GardenPlanting} planting
 * @property {string} harvestId               - Stable id for this planting's harvest planning.
 * @property {string} baseHarvestDate         - ISO date (YYYY-MM-DD) for nominal maturity.
 * @property {HarvestSwapOption[]} swapOptions
 * @property {string|null} chosenSwapId
 * @property {StorageLink|null} primaryStorage
 * @property {string|null} error
 */

/**
 * Options for prediction.
 *
 * @typedef {Object} GardenHarvestOptions
 * @property {string} [eventSource="garden"]
 * @property {number} [nowTs]                 - Timestamp; defaults to Date.now().
 * @property {FrostDates} [frostDates]        - Optional frost dates.
 * @property {string} [zoneId]                - Garden zone / location id for frost lookup.
 * @property {Record<string,string>} [chosenSwapByHarvestId] - Resume choices (harvestId → swapId).
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
    console.error("[garden/harvestWindow] Failed to emit event:", type, err);
  }
}

/**
 * Convert an ISO-like string to a Date (noon local to avoid TZ flakiness).
 * @param {string|null|undefined} iso
 * @returns {Date|null}
 */
function isoToDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(12, 0, 0, 0);
  return d;
}

/**
 * Convert Date to YYYY-MM-DD string.
 * @param {Date} d
 * @returns {string}
 */
function dateToYMD(d) {
  const year = d.getFullYear();
  const month = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Add days to a Date, returning a new Date.
 * @param {Date} d
 * @param {number} days
 * @returns {Date}
 */
function addDays(d, days) {
  const out = new Date(d.getTime());
  out.setDate(out.getDate() + days);
  return out;
}

/**
 * Clamp a date to be <= max.
 * @param {Date} d
 * @param {Date} max
 * @returns {Date}
 */
function clampToBefore(d, max) {
  return d.getTime() > max.getTime() ? new Date(max.getTime()) : d;
}

/**
 * Normalize crop to a lookup key.
 * @param {GardenPlanting} planting
 * @returns {string}
 */
function normalizeCropKey(planting) {
  const base =
    planting.cropSlug ||
    planting.cropName ||
    planting.cropId ||
    planting.id ||
    "unknown";

  return String(base)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/* -------------------------------------------------------------------------- */
/* Frost date helpers (optional, reused from garden/schedule style)          */
/* -------------------------------------------------------------------------- */

/**
 * Attempt to read frost dates from Dexie using garden zones / meta.
 * Same pattern as schedule.js for consistency.
 *
 * @param {GardenHarvestOptions} options
 * @returns {Promise<FrostDates>}
 */
async function resolveFrostDatesFromDb(options) {
  const fallback = { lastSpringFrost: null, firstFallFrost: null };
  if (!db) return fallback;

  try {
    if (options.zoneId && db.gardenZones && db.gardenZones.get) {
      const zone = await db.gardenZones.get(options.zoneId);
      if (zone && (zone.lastSpringFrost || zone.firstFallFrost)) {
        return {
          lastSpringFrost: zone.lastSpringFrost || null,
          firstFallFrost: zone.firstFallFrost || null,
        };
      }
    }

    if (db.gardenMeta && db.gardenMeta.toCollection) {
      const metas = await db.gardenMeta.toCollection().limit(1).toArray();
      const meta = metas[0];
      if (meta && (meta.lastSpringFrost || meta.firstFallFrost)) {
        return {
          lastSpringFrost: meta.lastSpringFrost || null,
          firstFallFrost: meta.firstFallFrost || null,
        };
      }
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[garden/harvestWindow] Failed to read frost dates:", err);
  }

  return fallback;
}

/**
 * Resolve frost dates (options override DB).
 * @param {GardenHarvestOptions} options
 * @returns {Promise<FrostDates>}
 */
async function resolveFrostDates(options) {
  const override = options.frostDates || {};
  const base = await resolveFrostDatesFromDb(options);
  return {
    lastSpringFrost: override.lastSpringFrost || base.lastSpringFrost,
    firstFallFrost: override.firstFallFrost || base.firstFallFrost,
  };
}

/* -------------------------------------------------------------------------- */
/* Storage rules                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Tiny built-in mapping from crop key or tag to storage preferences.
 * This is an extension point: you can move this to JSON or Dexie later.
 */
const STORAGE_RULES = {
  tomato: {
    storageMethod: "canned",
    fallbackLocationName: "Pantry (canned goods)",
    expectedShelfLifeDays: 365,
    notes: "Best preserved as sauce, salsa, or diced tomatoes.",
  },
  basil: {
    storageMethod: "dehydrated",
    fallbackLocationName: "Pantry (dry herbs)",
    expectedShelfLifeDays: 180,
    notes: "Dry or freeze in oil cubes for best flavor.",
  },
  carrot: {
    storageMethod: "cool-storage",
    fallbackLocationName: "Root cellar / crisper drawer",
    expectedShelfLifeDays: 90,
    notes: "Store in damp sand or bag in fridge.",
  },
  lettuce: {
    storageMethod: "fresh",
    fallbackLocationName: "Refrigerator crisper drawer",
    expectedShelfLifeDays: 7,
    notes: "Harvest closer to serving date; short shelf life.",
  },
  potato: {
    storageMethod: "cool-storage",
    fallbackLocationName: "Cool dark pantry / cellar",
    expectedShelfLifeDays: 120,
    notes: "Keep away from onions; avoid light to reduce greening.",
  },
};

/**
 * Heuristic mapping from generic tags to storage method.
 */
const TAG_STORAGE_MAP = {
  leafy: {
    storageMethod: "fresh",
    fallbackLocationName: "Refrigerator",
    expectedShelfLifeDays: 7,
  },
  root: {
    storageMethod: "cool-storage",
    fallbackLocationName: "Root cellar / cool pantry",
    expectedShelfLifeDays: 90,
  },
  fruiting: {
    storageMethod: "fresh",
    fallbackLocationName: "Refrigerator or counter",
    expectedShelfLifeDays: 5,
  },
  herb: {
    storageMethod: "dehydrated",
    fallbackLocationName: "Pantry (dry herbs)",
    expectedShelfLifeDays: 180,
  },
};

/**
 * Attempt to resolve a StorageLink for a planting:
 * 1) Use db.gardenStorageProfiles or db.storehouseLocations if available.
 * 2) Fall back to STORAGE_RULES and TAG_STORAGE_MAP.
 *
 * @param {GardenPlanting} planting
 * @returns {Promise<StorageLink|null>}
 */
async function resolveStorageLink(planting) {
  const cropKey = normalizeCropKey(planting);
  let profile = null;
  let location = null;

  // 1) Try Dexie storage profile.
  try {
    if (
      planting.storageProfileId &&
      db &&
      db.gardenStorageProfiles &&
      db.gardenStorageProfiles.get
    ) {
      profile = await db.gardenStorageProfiles.get(planting.storageProfileId);
    } else if (
      db &&
      db.gardenStorageProfiles &&
      db.gardenStorageProfiles.where
    ) {
      const byCrop = await db.gardenStorageProfiles
        .where("cropKey")
        .equals(cropKey)
        .first();
      profile = byCrop || null;
    }

    if (
      profile &&
      profile.locationId &&
      db &&
      db.storehouseLocations &&
      db.storehouseLocations.get
    ) {
      location = await db.storehouseLocations.get(profile.locationId);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      "[garden/harvestWindow] Failed to resolve storage profile:",
      err
    );
  }

  if (profile) {
    return {
      storageMethod: profile.storageMethod || "fresh",
      locationId: profile.locationId || null,
      locationName: (location && location.name) || profile.locationName || null,
      expectedShelfLifeDays: profile.expectedShelfLifeDays || null,
      preservationPlanId: profile.preservationPlanId || null,
      inventoryCategoryId: profile.inventoryCategoryId || null,
      notes: profile.notes || null,
    };
  }

  // 2) Built-in rules by crop key.
  const byCrop = STORAGE_RULES[cropKey];
  if (byCrop) {
    return {
      storageMethod: byCrop.storageMethod,
      locationId: null,
      locationName: byCrop.fallbackLocationName || null,
      expectedShelfLifeDays: byCrop.expectedShelfLifeDays || null,
      preservationPlanId: null,
      inventoryCategoryId: null,
      notes: byCrop.notes || null,
    };
  }

  // 3) Tag-based heuristic.
  if (Array.isArray(planting.tags)) {
    for (const tag of planting.tags) {
      const t = TAG_STORAGE_MAP[tag];
      if (t) {
        return {
          storageMethod: t.storageMethod,
          locationId: null,
          locationName: t.fallbackLocationName || null,
          expectedShelfLifeDays: t.expectedShelfLifeDays || null,
          preservationPlanId: null,
          inventoryCategoryId: null,
          notes: null,
        };
      }
    }
  }

  // 4) Fallback: assume fresh, short-lived.
  return {
    storageMethod: "fresh",
    locationId: null,
    locationName: "Refrigerator",
    expectedShelfLifeDays: 5,
    preservationPlanId: null,
    inventoryCategoryId: null,
    notes: "Generic fresh storage; refine this profile later.",
  };
}

/* -------------------------------------------------------------------------- */
/* Harvest window + swap options                                              */
/* -------------------------------------------------------------------------- */

/**
 * Compute the nominal harvest date & early/late windows for a planting.
 *
 * @param {GardenPlanting} planting
 * @param {FrostDates} frost
 * @returns {{ baseHarvestDate: string, windows: HarvestWindow[] } | null}
 */
function computeHarvestWindowsForPlanting(planting, frost) {
  const plantingDate = isoToDate(planting.plantingDate);
  if (!plantingDate) return null;

  const daysToMaturity = Number.isFinite(planting.daysToMaturity)
    ? planting.daysToMaturity
    : 70;

  const tolerance =
    Number.isFinite(planting.harvestToleranceDays) &&
    planting.harvestToleranceDays > 0
      ? planting.harvestToleranceDays
      : 7;

  const baseDate = addDays(plantingDate, daysToMaturity);
  const baseYmd = dateToYMD(baseDate);

  // Early window: a bit before nominal maturity.
  let earlyStart = addDays(baseDate, -(tolerance + 3));
  let earlyEnd = addDays(baseDate, -1);

  // Standard window: centered on nominal date.
  const standardStart = addDays(baseDate, -Math.round(tolerance / 2));
  const standardEnd = addDays(baseDate, Math.round(tolerance / 2));

  // Late window: after nominal maturity.
  let lateStart = addDays(baseDate, tolerance);
  let lateEnd = addDays(baseDate, tolerance * 2);

  const firstFrost = isoToDate(frost.firstFallFrost);
  if (firstFrost) {
    const lastSafeHarvest = addDays(firstFrost, -1);
    lateStart = clampToBefore(lateStart, lastSafeHarvest);
    lateEnd = clampToBefore(lateEnd, lastSafeHarvest);
  }

  const harvestId = `h_${planting.id}`;

  /** @type {HarvestWindow[]} */
  const windows = [
    {
      id: `${harvestId}:early`,
      plantingId: planting.id,
      index: 0,
      variant: "early",
      windowStart: dateToYMD(earlyStart),
      windowEnd: dateToYMD(earlyEnd),
      targetDate: dateToYMD(
        addDays(
          earlyStart,
          Math.round((earlyEnd - earlyStart) / (2 * 24 * 60 * 60 * 1000))
        )
      ),
      blockers: ["weather"],
      notes:
        "Early harvest tends to favor tenderness and flavor over maximum yield.",
    },
    {
      id: `${harvestId}:standard`,
      plantingId: planting.id,
      index: 1,
      variant: "standard",
      windowStart: dateToYMD(standardStart),
      windowEnd: dateToYMD(standardEnd),
      targetDate: baseYmd,
      blockers: ["weather"],
      notes: "Standard harvest balances flavor, size, and storage readiness.",
    },
    {
      id: `${harvestId}:late`,
      plantingId: planting.id,
      index: 2,
      variant: "late",
      windowStart: dateToYMD(lateStart),
      windowEnd: dateToYMD(lateEnd),
      targetDate: dateToYMD(
        addDays(
          lateStart,
          Math.round((lateEnd - lateStart) / (2 * 24 * 60 * 60 * 1000))
        )
      ),
      blockers: ["weather"],
      notes:
        "Late harvest maximizes size and yield but can risk overripeness or weather damage.",
    },
  ];

  return { baseHarvestDate: baseYmd, windows };
}

/**
 * Build HarvestSwapOption[] for a planting + its storage link.
 * This powers the Harvest Swap Modal’s UI.
 *
 * @param {string} harvestId
 * @param {GardenPlanting} planting
 * @param {{ baseHarvestDate: string, windows: HarvestWindow[] }} data
 * @param {StorageLink|null} storageLink
 * @returns {HarvestSwapOption[]}
 */
function buildSwapOptionsForPlanting(harvestId, planting, data, storageLink) {
  const storageLinks = storageLink ? [storageLink] : [];

  return data.windows.map((w) => {
    /** @type {string[]} */
    const badges = [];

    if (w.variant === "early") {
      badges.push("MAX-FLAVOR", "TENDER");
    } else if (w.variant === "standard") {
      badges.push("BALANCED", "DEFAULT");
    } else if (w.variant === "late") {
      badges.push("MAX-YIELD");
    }

    if (storageLink && storageLink.storageMethod !== "fresh") {
      badges.push("STORAGE-OPTIMAL");
    }

    let label;
    let summary;
    if (w.variant === "early") {
      label = "Early harvest";
      summary = `Harvest ${planting.cropName} a bit before full maturity for peak tenderness.`;
    } else if (w.variant === "late") {
      label = "Late harvest";
      summary = `Let ${planting.cropName} size up for maximum yield (watch for weather and quality).`;
    } else {
      label = "Standard harvest";
      summary = `Balanced harvest timing for ${planting.cropName}, ideal for both fresh eating and storage.`;
    }

    return {
      id: `${harvestId}:${w.variant}`,
      label,
      summary,
      variant: w.variant,
      windowStart: w.windowStart,
      windowEnd: w.windowEnd,
      targetDate: w.targetDate,
      autoSelected: w.variant === "standard",
      isNeutral: false,
      badges,
      storageLinks,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Hub export                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Export harvest predictions to the Hub, if familyFundMode is enabled.
 *
 * @param {GardenHarvestResultItem[]} results
 * @param {string} eventSource
 */
async function exportHarvestToHub(results, eventSource) {
  if (!familyFundMode || !results || !results.length) return;

  try {
    const payload = HubPacketFormatter.formatGardenHarvest(results, {
      source: eventSource,
      exportedAt: new Date().toISOString(),
    });
    await FamilyFundConnector.send(payload);
    emit("garden.harvestWindow.exported", eventSource, {
      plantings: results.length,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[garden/harvestWindow] Hub export failed (soft):", err);
  }
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Predict harvest dates and storage link for a list of plantings.
 *
 * Emits:
 * - garden.harvestWindow.requested
 * - garden.harvestWindow.swapOptions.built (per planting)
 * - garden.harvestWindow.completed
 * - garden.harvestWindow.exported (on Hub export success)
 *
 * Harvest Swap Modal:
 * - The returned `results` items contain:
 *   • harvestId (stable key for this planting’s harvest planning)
 *   • swapOptions[] (HarvestSwapOption) per planting
 *   • chosenSwapId (resume from Dexie via options.chosenSwapByHarvestId)
 *   • primaryStorage (StorageLink) for storehouse / preservation pipelines
 *
 * @param {GardenPlanting[]} plantings
 * @param {GardenHarvestOptions} [options]
 * @returns {Promise<{ results: GardenHarvestResultItem[], meta: { plantings: number, errors: number } }>}
 */
export async function predictHarvestWindows(plantings, options = {}) {
  const {
    eventSource = "garden",
    nowTs = Date.now(), // reserved for future seasonal tweaks
    chosenSwapByHarvestId = {},
  } = options;

  const safePlantings = Array.isArray(plantings) ? plantings : [];

  emit("garden.harvestWindow.requested", eventSource, {
    plantings: safePlantings.length,
  });

  const frost = await resolveFrostDates(options);

  /** @type {GardenHarvestResultItem[]} */
  const results = [];
  let errorCount = 0;

  for (const planting of safePlantings) {
    const harvestId = `h_${planting.id}`;

    /** @type {GardenHarvestResultItem} */
    const result = {
      planting,
      harvestId,
      baseHarvestDate: null,
      swapOptions: [],
      chosenSwapId: null,
      primaryStorage: null,
      error: null,
    };

    try {
      const data = computeHarvestWindowsForPlanting(planting, frost);
      if (!data) {
        result.error =
          "Unable to compute harvest windows (missing or invalid plantingDate).";
        errorCount += 1;
        results.push(result);
        continue;
      }

      result.baseHarvestDate = data.baseHarvestDate;
      const storageLink = await resolveStorageLink(planting);
      result.primaryStorage = storageLink;

      const swapOptions = buildSwapOptionsForPlanting(
        harvestId,
        planting,
        data,
        storageLink
      );
      result.swapOptions = swapOptions;

      const resumeId = chosenSwapByHarvestId[harvestId];
      const chosen =
        (resumeId && swapOptions.find((opt) => opt.id === resumeId)) ||
        swapOptions.find((opt) => opt.autoSelected) ||
        swapOptions[0] ||
        null;

      result.chosenSwapId = chosen ? chosen.id : null;

      emit("garden.harvestWindow.swapOptions.built", eventSource, {
        plantingId: planting.id,
        harvestId,
        optionsCount: swapOptions.length,
        autoSelectedId: swapOptions.find((opt) => opt.autoSelected)?.id || null,
        baseHarvestDate: result.baseHarvestDate,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        "[garden/harvestWindow] Failed to compute harvest windows for planting:",
        planting,
        err
      );
      result.error = err?.message || String(err);
      errorCount += 1;
    }

    results.push(result);
  }

  emit("garden.harvestWindow.completed", eventSource, {
    plantings: results.length,
    errors: errorCount,
    ts: new Date(nowTs).toISOString(),
  });

  // Fire-and-forget Hub export
  exportHarvestToHub(results, eventSource).catch(() => {});

  return {
    results,
    meta: {
      plantings: results.length,
      errors: errorCount,
    },
  };
}

/**
 * Convenience helper:
 * Predict harvest windows + storage link for a single planting.
 *
 * @param {GardenPlanting} planting
 * @param {GardenHarvestOptions} [options]
 * @returns {Promise<GardenHarvestResultItem|null>}
 */
export async function predictSingleHarvestWindow(planting, options = {}) {
  const { results } = await predictHarvestWindows([planting], options);
  return results[0] || null;
}
