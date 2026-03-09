// C:\Users\larho\suka-smart-assistant\src\features\calculators\storehouseMeals\MeatBreakdownCalculator\MeatBreakdownCalculator.hooks.js

/**
 * MeatBreakdownCalculator.hooks.js
 *
 * HOW THIS FITS:
 * - React hooks that connect MeatBreakdownCalculator results to:
 *    1) Storehouse / freezer layout (where do the packages go?).
 *    2) Batch cooking / SessionRunner planning (what should we cook now?).
 *
 * - These hooks DO NOT render UI. They:
 *    • Derive freezer/bin suggestions based on packages and cut categories.
 *    • Build proposed batch cooking sessions (ground, stew, roasts, organs).
 *    • Optionally persist inventory rows via Dexie (ssaDB.inventory).
 *    • Emit events on the global eventBus for automation & analytics.
 *
 * - They are designed to be used in:
 *    • MeatBreakdownCalculator.view.jsx
 *    • Storehouse / Freezer pages
 *    • Batch Cooking / Meal Planning pages
 *
 * SSA CONTRACT NOTES:
 * - Events emitted here use:
 *   emit({ type, ts, source, data })
 * - Session objects produced follow the SessionRunner contract:
 *   {
 *     id, domain, title, source, steps, prefs, status,
 *     progress, analytics, createdAt, updatedAt
 *   }
 *
 * EXTENSION POINTS:
 * - You can:
 *    • Change freezerZone heuristics in `deriveFreezerZonesFromCuts`.
 *    • Adjust which cuts map into which batch sessions in `buildBatchCookingSessions`.
 *    • Wire the `startBatchSession` helper into the global SessionRunner controller.
 */

import { useMemo, useState, useCallback } from "react";
import { emit } from "@/services/events/eventBus";
// NOTE: If your Dexie instance is exported from a different path/name,
// update this import accordingly.
import { ssaDB } from "@/services/db";

/**
 * @typedef {object} MeatBreakdownPayload
 * @property {{ animal?: object, carcass?: object, processingPreferences?: object, batchContext?: object }} [inputs]
 * @property {{ summary?: object, cuts?: Array<object>, byproducts?: Array<object> }} [outputs]
 * @property {string} [version]
 * @property {string} [calculator]
 * @property {object} [metadata]
 */

/* -------------------------------------------------------------------------- */
/* Hook: Sync to Storehouse Inventory & Freezer Layout                        */
/* -------------------------------------------------------------------------- */

/**
 * useMeatBreakdownInventorySync
 *
 * - Prepares a "preview" of inventory items & freezer locations derived from
 *   the MeatBreakdown payload.
 * - Offers a `syncToInventory()` action that will:
 *    • Create/merge inventory rows in Dexie (ssaDB.inventory).
 *    • Emit events so Storehouse dashboards can refresh.
 *
 * @param {MeatBreakdownPayload|null} breakdown
 * @param {object} [options]
 * @param {string|null} [options.householdId] - Optional household id for inventory scoping.
 * @param {boolean} [options.createMissingItems] - If true, create inventory items even if no mapping exists.
 * @returns {{
 *   inventoryPreview: Array<object>,
 *   freezerZones: Array<{
 *     zone: string,
 *     label: string,
 *     packages: number,
 *     totalWeight: number,
 *     unit: string,
 *     cuts: Array<object>
 *   }>,
 *   totalPackages: number,
 *   totalWeight: number,
 *   weightUnit: string,
 *   syncStatus: 'idle'|'saving'|'success'|'error',
 *   syncError: string|null,
 *   syncToInventory: () => Promise<void>
 * }}
 */
export function useMeatBreakdownInventorySync(
  breakdown,
  { householdId = null, createMissingItems = true } = {}
) {
  const [syncStatus, setSyncStatus] = useState("idle");
  const [syncError, setSyncError] = useState(null);

  const summary = breakdown?.outputs?.summary || null;
  const cuts = Array.isArray(breakdown?.outputs?.cuts)
    ? breakdown.outputs.cuts
    : [];
  const byproducts = Array.isArray(breakdown?.outputs?.byproducts)
    ? breakdown.outputs.byproducts
    : [];
  const weightUnit = summary?.weightUnit || "lb";

  // Derived freezer layout and inventory rows.
  const { freezerZones, inventoryPreview, totalPackages, totalWeight } =
    useMemo(() => {
      if (!summary) {
        return {
          freezerZones: [],
          inventoryPreview: [],
          totalPackages: 0,
          totalWeight: 0,
        };
      }

      const zones = deriveFreezerZonesFromCuts(cuts, byproducts, weightUnit);
      const preview = buildInventoryPreviewFromCuts(
        cuts,
        byproducts,
        householdId
      );

      const totalPkgs = preview.reduce(
        (acc, row) => acc + (row.packages || 0),
        0
      );
      const totalWt = preview.reduce(
        (acc, row) => acc + (row.totalWeight || 0),
        0
      );

      return {
        freezerZones: zones,
        inventoryPreview: preview,
        totalPackages: totalPkgs,
        totalWeight: totalWt,
      };
    }, [summary, cuts, byproducts, householdId, weightUnit]);

  /**
   * Sync the preview into Dexie inventory.
   * This is defensive: if ssaDB or ssaDB.inventory doesn't exist, it will
   * simply emit an event and return.
   */
  const syncToInventory = useCallback(async () => {
    if (!breakdown || !summary) return;

    const ts = new Date().toISOString();
    const source =
      "features/calculators/storehouseMeals/MeatBreakdownCalculator.hooks";

    setSyncStatus("saving");
    setSyncError(null);

    emit({
      type: "storehouse.inventory.meatBreakdown.sync.requested",
      ts,
      source,
      data: {
        householdId,
        itemsCount: inventoryPreview.length,
      },
    });

    try {
      const hasInventoryTable =
        ssaDB && typeof ssaDB.inventory?.bulkPut === "function";

      if (!hasInventoryTable) {
        console.warn(
          "[useMeatBreakdownInventorySync] ssaDB.inventory missing; skipping DB write."
        );
        emit({
          type: "storehouse.inventory.meatBreakdown.sync.skipped",
          ts,
          source,
          data: {
            reason: "missing_inventory_table",
            householdId,
            itemsCount: inventoryPreview.length,
          },
        });
        setSyncStatus("success");
        return;
      }

      const rows = inventoryPreview
        .filter((row) => row.totalWeight > 0 && row.packages > 0)
        .map((row) =>
          inventoryRowFromPreview(row, breakdown, {
            householdId,
            createMissingItems,
          })
        );

      if (rows.length) {
        await ssaDB.inventory.bulkPut(rows);
      }

      emit({
        type: "storehouse.inventory.meatBreakdown.synced",
        ts,
        source,
        data: {
          householdId,
          rowsCount: rows.length,
          basisWeight: summary.basisWeight,
          basisType: summary.basisType,
        },
      });

      setSyncStatus("success");
    } catch (err) {
      console.error(
        "[useMeatBreakdownInventorySync] Failed to sync inventory:",
        err
      );
      setSyncStatus("error");
      setSyncError(err?.message || "Unknown error");

      emit({
        type: "storehouse.inventory.meatBreakdown.sync.failed",
        ts,
        source,
        data: {
          householdId,
          error: err?.message || "Unknown error",
        },
      });
    }
  }, [breakdown, summary, inventoryPreview, householdId, createMissingItems]);

  return {
    inventoryPreview,
    freezerZones,
    totalPackages,
    totalWeight,
    weightUnit,
    syncStatus,
    syncError,
    syncToInventory,
  };
}

/* -------------------------------------------------------------------------- */
/* Hook: Build Batch Cooking Sessions from Breakdown                          */
/* -------------------------------------------------------------------------- */

/**
 * useMeatBreakdownBatchPlanning
 *
 * - Builds proposed batch cooking sessions from the meat breakdown.
 * - Sessions generally include:
 *    • Ground meat processing (seasoning, forming patties, cooking/packing).
 *    • Stew/curry prep.
 *    • Roast prep sessions.
 *    • Organ/offal prep (e.g., broth, paté).
 *
 * - Provides helpers:
 *    • `proposedSessions` – a list of session objects matching the SessionRunner contract.
 *    • `startBatchSession(session)` – emit event to request SessionRunner to start.
 *
 * @param {MeatBreakdownPayload|null} breakdown
 * @param {object} [options]
 * @param {string} [options.domain] - Session domain ("cooking" by default).
 * @param {string} [options.defaultSourceType] - Source type for sessions ("manual" default).
 * @returns {{
 *   proposedSessions: Array<object>,
 *   startBatchSession: (session: object) => void
 * }}
 */
export function useMeatBreakdownBatchPlanning(
  breakdown,
  { domain = "cooking", defaultSourceType = "manual" } = {}
) {
  const summary = breakdown?.outputs?.summary || null;
  const cuts = Array.isArray(breakdown?.outputs?.cuts)
    ? breakdown.outputs.cuts
    : [];
  const byproducts = Array.isArray(breakdown?.outputs?.byproducts)
    ? breakdown.outputs.byproducts
    : [];
  const weightUnit = summary?.weightUnit || "lb";

  const proposedSessions = useMemo(() => {
    if (!breakdown || !summary) return [];

    return buildBatchCookingSessions(breakdown, cuts, byproducts, weightUnit, {
      domain,
      defaultSourceType,
    });
  }, [
    breakdown,
    summary,
    cuts,
    byproducts,
    weightUnit,
    domain,
    defaultSourceType,
  ]);

  /**
   * Emit a request for SessionRunner to start the given session.
   * The actual SessionRunner orchestrator will listen for this and
   * mount the SessionRunner modal.
   *
   * @param {object} session
   */
  const startBatchSession = useCallback(
    (session) => {
      if (!session || typeof session !== "object") return;
      const ts = new Date().toISOString();

      emit({
        type: "session.request.fromMeatBreakdown.batch",
        ts,
        source:
          "features/calculators/storehouseMeals/MeatBreakdownCalculator.hooks",
        data: {
          session,
          breakdownId: breakdown?.metadata?.id || null,
          species: breakdown?.inputs?.animal?.species || "unknown",
        },
      });
    },
    [breakdown]
  );

  return {
    proposedSessions,
    startBatchSession,
  };
}

/* -------------------------------------------------------------------------- */
/* Freezer Zone Derivation                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Group cuts & byproducts into freezer zones (high-level heuristics).
 *
 * You can adapt this to match your actual freezer/zone taxonomy.
 *
 * Example zones:
 *   - "steaks_roasts"
 *   - "ground_sausage"
 *   - "bones_stock"
 *   - "organs_offal"
 *
 * @param {Array<object>} cuts
 * @param {Array<object>} byproducts
 * @param {'lb'|'kg'} weightUnit
 * @returns {Array<{
 *   zone: string,
 *   label: string,
 *   packages: number,
 *   totalWeight: number,
 *   unit: string,
 *   cuts: Array<object>
 * }>}
 */
function deriveFreezerZonesFromCuts(cuts, byproducts, weightUnit) {
  const zones = {
    steaks_roasts: {
      zone: "steaks_roasts",
      label: "Steaks & Roasts",
      packages: 0,
      totalWeight: 0,
      unit: weightUnit,
      cuts: [],
    },
    ground_sausage: {
      zone: "ground_sausage",
      label: "Ground & Sausage",
      packages: 0,
      totalWeight: 0,
      unit: weightUnit,
      cuts: [],
    },
    bones_stock: {
      zone: "bones_stock",
      label: "Bones & Stock",
      packages: 0,
      totalWeight: 0,
      unit: weightUnit,
      cuts: [],
    },
    organs_offal: {
      zone: "organs_offal",
      label: "Organs & Offal",
      packages: 0,
      totalWeight: 0,
      unit: weightUnit,
      cuts: [],
    },
  };

  const pushCut = (zoneKey, cut) => {
    const z = zones[zoneKey];
    if (!z) return;
    const pkgCount = cut.packagePlan?.packages || 0;
    const weight = cut.weight || 0;
    z.packages += pkgCount;
    z.totalWeight += weight;
    z.cuts.push(cut);
  };

  cuts.forEach((cut) => {
    const category = String(cut.category || "").toLowerCase();

    if (["steak", "roast", "chop", "rib"].includes(category)) {
      pushCut("steaks_roasts", cut);
    } else if (["ground", "sausage", "stew"].includes(category)) {
      pushCut("ground_sausage", cut);
    } else if (category === "organ") {
      pushCut("organs_offal", cut);
    } else {
      // Default: put misc cuts with ground/sausage
      pushCut("ground_sausage", cut);
    }
  });

  byproducts.forEach((bp) => {
    const type = String(bp.type || "").toLowerCase();
    const pseudoCut = {
      id: `bp_${type}`,
      name: bp.label || type,
      category: type === "organ" ? "organ" : "bone",
      weight: bp.weight || 0,
      packagePlan: {
        packages: 0,
      },
    };

    if (type === "organ") {
      pushCut("organs_offal", pseudoCut);
    } else if (type === "bone" || type === "stock_bag") {
      pushCut("bones_stock", pseudoCut);
    } else if (type === "fat") {
      // Render fat near bones/stock by default.
      pushCut("bones_stock", pseudoCut);
    }
  });

  return Object.values(zones).filter(
    (z) => z.cuts.length > 0 || z.totalWeight > 0
  );
}

/* -------------------------------------------------------------------------- */
/* Inventory Preview Construction                                             */
/* -------------------------------------------------------------------------- */

/**
 * Build inventory preview rows from cuts & byproducts.
 *
 * Each row is an "inventory item + quantity + packages" snapshot that can be
 * shown to the user before syncing into Dexie.
 *
 * @param {Array<object>} cuts
 * @param {Array<object>} byproducts
 * @param {string|null} householdId
 * @returns {Array<object>}
 */
function buildInventoryPreviewFromCuts(cuts, byproducts, householdId) {
  const rows = [];

  const pushRow = (item) => {
    rows.push(item);
  };

  cuts.forEach((cut) => {
    const totalWeight = cut.weight || 0;
    const packages = cut.packagePlan?.packages || 0;
    const weightPerPackage = cut.packagePlan?.weightPerPackage || 0;

    if (totalWeight <= 0 || packages <= 0) return;

    pushRow({
      kind: "cut",
      name: cut.name || "Cut",
      category: cut.category || "meat",
      primal: cut.primal || "",
      subPrimal: cut.subPrimal || "",
      boneIn: !!cut.boneIn,
      householdId: householdId || null,
      packages,
      totalWeight,
      weightPerPackage,
      unit: cut.weightUnit || "lb",
      intendedUse: cut.intendedUse || "family_meals",
      storehouseLink: cut.storehouseLink || {},
    });
  });

  byproducts.forEach((bp) => {
    const totalWeight = bp.weight || 0;
    if (totalWeight <= 0) return;

    pushRow({
      kind: "byproduct",
      name: bp.label || typeToInventoryName(bp.type),
      category: bp.type || "byproduct",
      householdId: householdId || null,
      packages: 0,
      totalWeight,
      weightPerPackage: 0,
      unit: bp.weightUnit || "lb",
      intendedUse: bp.intendedUse || "stock",
      storehouseLink: bp.storehouseLink || {},
    });
  });

  return rows;
}

/**
 * Convert a preview row into an inventory row for Dexie.
 *
 * NOTE: This assumes the inventory schema looks something like:
 *  {
 *    id?: string,
 *    householdId?: string|null,
 *    name: string,
 *    category: string,
 *    location: string,
 *    quantity: number,
 *    unit: string,
 *    packages: number,
 *    meta: object,
 *    createdAt: string,
 *    updatedAt: string
 *  }
 *
 * Adjust fields to match your real schema.
 *
 * @param {object} preview
 * @param {MeatBreakdownPayload} breakdown
 * @param {{ householdId: string|null, createMissingItems: boolean }} options
 * @returns {object}
 */
function inventoryRowFromPreview(preview, breakdown, options) {
  const ts = new Date().toISOString();
  const { householdId, createMissingItems } = options || {};
  const meta = breakdown?.metadata || {};

  return {
    // id can be auto-generated by Dexie; omit here unless you need a custom one.
    householdId: householdId || preview.householdId || null,
    name: preview.name,
    category: preview.category,
    location: inferDefaultLocation(preview),
    quantity: preview.totalWeight,
    unit: preview.unit || "lb",
    packages: preview.packages,
    meta: {
      fromCalculator: "MeatBreakdownCalculator",
      kind: preview.kind,
      primal: preview.primal || "",
      subPrimal: preview.subPrimal || "",
      boneIn: !!preview.boneIn,
      intendedUse: preview.intendedUse || "family_meals",
      breakdownId: meta.id || null,
      createMissingItems: !!createMissingItems,
      storehouseLink: preview.storehouseLink || {},
    },
    createdAt: ts,
    updatedAt: ts,
  };
}

function typeToInventoryName(type) {
  switch (type) {
    case "bone":
      return "Soup / Stock Bones";
    case "fat":
      return "Trim Fat for Rendering";
    case "organ":
      return "Organs / Offal";
    case "stock_bag":
      return "Stock Bags";
    case "hide":
      return "Hide";
    case "pet_food":
      return "Pet Food";
    default:
      return "Byproduct";
  }
}

function inferDefaultLocation(preview) {
  if (preview.kind === "byproduct") {
    if (preview.category === "bone" || preview.category === "stock_bag") {
      return "Freezer: Stock/Bones";
    }
    if (preview.category === "fat") {
      return "Freezer: Fat/Rendering";
    }
    if (preview.category === "organ") {
      return "Freezer: Organs";
    }
  }

  const cat = String(preview.category || "").toLowerCase();
  if (["steak", "roast", "chop", "rib"].includes(cat)) {
    return "Freezer: Steaks/Roasts";
  }
  if (["ground", "sausage", "stew"].includes(cat)) {
    return "Freezer: Ground/Sausage";
  }

  return "Freezer: Misc";
}

/* -------------------------------------------------------------------------- */
/* Batch Cooking Session Construction                                         */
/* -------------------------------------------------------------------------- */

/**
 * Build Batch Cooking sessions from cuts and byproducts.
 *
 * Each session object matches the SessionRunner minimum contract.
 *
 * @param {MeatBreakdownPayload} breakdown
 * @param {Array<object>} cuts
 * @param {Array<object>} byproducts
 * @param {'lb'|'kg'} weightUnit
 * @param {{ domain: string, defaultSourceType: string }} opts
 * @returns {Array<object>}
 */
function buildBatchCookingSessions(
  breakdown,
  cuts,
  byproducts,
  weightUnit,
  opts
) {
  const { domain, defaultSourceType } = opts || {};
  const ts = new Date().toISOString();

  const groundCuts = cuts.filter(
    (c) =>
      String(c.category || "").toLowerCase() === "ground" ||
      String(c.category || "").toLowerCase() === "sausage"
  );
  const stewCuts = cuts.filter(
    (c) => String(c.category || "").toLowerCase() === "stew"
  );
  const roastCuts = cuts.filter((c) =>
    ["roast", "steak", "chop", "rib"].includes(
      String(c.category || "").toLowerCase()
    )
  );
  const organByproducts = byproducts.filter(
    (bp) => String(bp.type || "").toLowerCase() === "organ"
  );
  const boneByproducts = byproducts.filter(
    (bp) =>
      String(bp.type || "").toLowerCase() === "bone" ||
      String(bp.type || "").toLowerCase() === "stock_bag"
  );

  /** @type {Array<object>} */
  const sessions = [];

  if (groundCuts.length) {
    sessions.push(
      buildGroundSession(
        breakdown,
        groundCuts,
        weightUnit,
        domain,
        defaultSourceType,
        ts
      )
    );
  }

  if (stewCuts.length) {
    sessions.push(
      buildStewSession(
        breakdown,
        stewCuts,
        weightUnit,
        domain,
        defaultSourceType,
        ts
      )
    );
  }

  if (roastCuts.length) {
    sessions.push(
      buildRoastSession(
        breakdown,
        roastCuts,
        weightUnit,
        domain,
        defaultSourceType,
        ts
      )
    );
  }

  if (organByproducts.length || boneByproducts.length) {
    sessions.push(
      buildStockAndOffalSession(
        breakdown,
        organByproducts,
        boneByproducts,
        weightUnit,
        domain,
        defaultSourceType,
        ts
      )
    );
  }

  return sessions;
}

function buildGroundSession(
  breakdown,
  cuts,
  weightUnit,
  domain,
  defaultSourceType,
  ts
) {
  const totalWeight = cuts.reduce((acc, c) => acc + (c.weight || 0), 0);
  const title = "Batch: Ground & Sausage Prep";

  return {
    id: `meatbatch_ground_${ts}`,
    domain,
    title,
    source: {
      type: defaultSourceType || "manual",
      refId: breakdown?.metadata?.id || null,
    },
    steps: [
      {
        id: "gather_ground_cuts",
        title: "Gather all ground & sausage meat",
        desc: `Pull all labeled ground/sausage cuts from the freezer or fresh prep table. Total ~${totalWeight.toFixed(
          1
        )} ${weightUnit}.`,
        durationSec: 10 * 60,
        blockers: ["inventory", "equipment"],
        metadata: {
          tempTargetF: 34,
          donenessCue: "texture",
          cueNotes:
            "Meat should be cold, slightly firm to the touch for safe grinding.",
        },
      },
      {
        id: "season_and_mix",
        title: "Season and mix",
        desc: "Season meat according to your recipe (plain, breakfast sausage, Italian, etc.) and mix thoroughly.",
        durationSec: 20 * 60,
        blockers: ["equipment"],
        metadata: {
          tempTargetF: 40,
          donenessCue: "texture",
          cueNotes:
            "Well-mixed, uniform texture. Avoid smearing the fat; keep it cold.",
        },
      },
      {
        id: "form_packages",
        title: "Portion and package ground meat",
        desc: "Weigh, portion, and package ground meat (e.g., 1–2 lb packs). Label with date, seasoning type, and fat % if known.",
        durationSec: 30 * 60,
        blockers: ["equipment"],
        metadata: {
          tempTargetF: 40,
          donenessCue: "timer",
          cueNotes:
            "Work quickly to keep meat cold; move finished packs to freezer.",
        },
      },
    ],
    prefs: { voiceGuidance: true, haptic: true, autoAdvance: false },
    status: "pending",
    progress: {
      currentStepIndex: 0,
      elapsedSec: 0,
      startedAt: null,
      pausedAt: null,
    },
    analytics: { skippedSteps: [], adjustments: [] },
    createdAt: ts,
    updatedAt: ts,
  };
}

function buildStewSession(
  breakdown,
  cuts,
  weightUnit,
  domain,
  defaultSourceType,
  ts
) {
  const totalWeight = cuts.reduce((acc, c) => acc + (c.weight || 0), 0);
  const title = "Batch: Stew / Curry Prep";

  return {
    id: `meatbatch_stew_${ts}`,
    domain,
    title,
    source: {
      type: defaultSourceType || "manual",
      refId: breakdown?.metadata?.id || null,
    },
    steps: [
      {
        id: "gather_stew_cuts",
        title: "Gather stew/curry cuts",
        desc: `Gather all cuts marked for stew or curry (~${totalWeight.toFixed(
          1
        )} ${weightUnit}).`,
        durationSec: 10 * 60,
        blockers: ["inventory"],
        metadata: {
          tempTargetF: 40,
          donenessCue: "timer",
          cueNotes: "Keep meat cold while you work.",
        },
      },
      {
        id: "cube_and_trim",
        title: "Cube and trim",
        desc: "Trim excess surface fat (if desired) and cut stew meat into even cubes for even cooking.",
        durationSec: 25 * 60,
        blockers: ["equipment"],
        metadata: {
          tempTargetF: 40,
          donenessCue: "texture",
          cueNotes:
            "Pieces should be uniform in size and free of large connective tissue lumps.",
        },
      },
      {
        id: "marinate_or_bag",
        title: "Marinate or bag into meal kits",
        desc: "Either marinate for immediate cooking or package into frozen stew/curry kits with seasonings and labels.",
        durationSec: 20 * 60,
        blockers: ["equipment"],
        metadata: {
          tempTargetF: 40,
          donenessCue: "timer",
          cueNotes:
            "Note which kits are ready-to-cook vs. require additional ingredients.",
        },
      },
    ],
    prefs: { voiceGuidance: true, haptic: true, autoAdvance: false },
    status: "pending",
    progress: {
      currentStepIndex: 0,
      elapsedSec: 0,
      startedAt: null,
      pausedAt: null,
    },
    analytics: { skippedSteps: [], adjustments: [] },
    createdAt: ts,
    updatedAt: ts,
  };
}

function buildRoastSession(
  breakdown,
  cuts,
  weightUnit,
  domain,
  defaultSourceType,
  ts
) {
  const totalWeight = cuts.reduce((acc, c) => acc + (c.weight || 0), 0);
  const title = "Batch: Roasts & Special Cuts Labeling";

  return {
    id: `meatbatch_roasts_${ts}`,
    domain,
    title,
    source: {
      type: defaultSourceType || "manual",
      refId: breakdown?.metadata?.id || null,
    },
    steps: [
      {
        id: "inventory_roasts",
        title: "Inventory roasts and special cuts",
        desc: `Lay out all roasts, steaks, chops, and ribs. Confirm counts and weights (~${totalWeight.toFixed(
          1
        )} ${weightUnit}).`,
        durationSec: 15 * 60,
        blockers: ["inventory"],
        metadata: {
          tempTargetF: 40,
          donenessCue: "timer",
          cueNotes: "Update your storehouse log as you verify each package.",
        },
      },
      {
        id: "label_occasion",
        title: "Label by occasion",
        desc: "Mark packages for weeknight, Sabbath/feast, or special gatherings. Add serving counts on each label.",
        durationSec: 20 * 60,
        blockers: ["inventory"],
        metadata: {
          tempTargetF: 40,
          donenessCue: "timer",
          cueNotes:
            "This step helps you quickly select appropriate cuts for each occasion later.",
        },
      },
    ],
    prefs: { voiceGuidance: true, haptic: true, autoAdvance: false },
    status: "pending",
    progress: {
      currentStepIndex: 0,
      elapsedSec: 0,
      startedAt: null,
      pausedAt: null,
    },
    analytics: { skippedSteps: [], adjustments: [] },
    createdAt: ts,
    updatedAt: ts,
  };
}

function buildStockAndOffalSession(
  breakdown,
  organs,
  bones,
  weightUnit,
  domain,
  defaultSourceType,
  ts
) {
  const organWeight = organs.reduce((acc, bp) => acc + (bp.weight || 0), 0);
  const boneWeight = bones.reduce((acc, bp) => acc + (bp.weight || 0), 0);
  const title = "Batch: Broth & Offal Prep";

  return {
    id: `meatbatch_broth_offal_${ts}`,
    domain,
    title,
    source: {
      type: defaultSourceType || "manual",
      refId: breakdown?.metadata?.id || null,
    },
    steps: [
      {
        id: "sort_bones",
        title: "Sort and bag bones",
        desc: `Sort bones for stock/roasting (~${boneWeight.toFixed(
          1
        )} ${weightUnit}). Bag them into stock-ready portions.`,
        durationSec: 20 * 60,
        blockers: ["inventory", "equipment"],
        metadata: {
          tempTargetF: 32,
          donenessCue: "timer",
          cueNotes:
            "Freeze some bags raw; consider roasting others for deeper flavor.",
        },
      },
      {
        id: "organ_triage",
        title: "Organ prep triage",
        desc: `Review organs (~${organWeight.toFixed(
          1
        )} ${weightUnit}), decide which to cook fresh vs. freeze, and package accordingly.`,
        durationSec: 25 * 60,
        blockers: ["equipment"],
        metadata: {
          tempTargetF: 40,
          donenessCue: "smell",
          cueNotes:
            "Rinse, trim, and package to reduce strong odors; label clearly.",
        },
      },
      {
        id: "start_broth_batch",
        title: "Start a broth batch (optional)",
        desc: "If time allows, start a large batch of broth with bones, aromatics, and vegetables.",
        durationSec: 15 * 60,
        blockers: ["equipment"],
        metadata: {
          tempTargetF: 212,
          donenessCue: "smell",
          cueNotes:
            "Bring to a simmer and hold low and slow; you can convert this into a dedicated cooking session later.",
        },
      },
    ],
    prefs: { voiceGuidance: true, haptic: true, autoAdvance: false },
    status: "pending",
    progress: {
      currentStepIndex: 0,
      elapsedSec: 0,
      startedAt: null,
      pausedAt: null,
    },
    analytics: { skippedSteps: [], adjustments: [] },
    createdAt: ts,
    updatedAt: ts,
  };
}

export default {
  useMeatBreakdownInventorySync,
  useMeatBreakdownBatchPlanning,
};
