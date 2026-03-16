// C:\Users\larho\suka-smart-assistant\src\features\calculators\gardenAnimal\ButcheryWeightCalculator\ButcheryWeightCalculator.hooks.js

/**
 * ButcheryWeightCalculator.hooks.js
 *
 * Hooks connecting ButcheryWeightCalculator outputs to:
 *  - Freezer / storehouse inventory planning
 *  - Batch cooking & preservation session planning
 *
 * How this fits SSA:
 *  - Consumes the normalized result from ButcheryWeightCalculator.shim.
 *  - Creates freezer-friendly item records for cuts & by-products.
 *  - Suggests batch cooking / preservation session drafts using the SSA Session contract.
 *  - Emits events so other modules (storehouse, meal planner, preservation) can react.
 *  - Optionally exports planning envelopes to the Hub when familyFundMode is true.
 *
 * This file does NOT directly write to Dexie; it:
 *  - Returns derived data for the UI or higher-level services.
 *  - Emits events on user actions via the shared eventBus.
 */

import { useCallback, useMemo } from "react";
import { emit } from "@/services/events/eventBus";
import { familyFundMode } from "@/config/featureFlags";

/**
 * Optional Hub export hook.
 * Replace the window shim with a real import when your Hub helpers are ready:
 *
 *   import { exportToHubIfEnabled } from "@/services/hub/exportToHubIfEnabled";
 */
const exportToHubIfEnabled =
  typeof window !== "undefined" && window.__SSA_EXPORT_TO_HUB__
    ? window.__SSA_EXPORT_TO_HUB__
    : async () => false;

/**
 * @typedef {Object} ButcheryResult
 * @property {{ analytics?: any, carcassBreakdown?: any[], retailCutPlan?: any[], offalAndByproducts?: any[] }} result
 *   Shape from ButcheryWeightCalculator.shim
 */

/**
 * @typedef {Object} FreezerMappingOptions
 * @property {string} [defaultLocation]   - e.g. "Main Chest Freezer"
 * @property {string} [batchLabel]        - e.g. "Spring Beef 2026"
 * @property {string} [householdId]       - For Hub export envelopes
 */

/**
 * Maps butchery retail cuts & by-products into freezer/storehouse item plans.
 *
 * @param {ButcheryResult|null|undefined} butcheryResult
 * @param {FreezerMappingOptions} [options]
 * @returns {{
 *   freezerItems: Array<any>,
 *   totalFreezerWeightKg: number,
 *   createFreezerPlanEnvelope: () => any,
 *   emitFreezerPlanCreated: () => Promise<void>
 * }}
 */
export function useButcheryFreezerMappings(butcheryResult, options = {}) {
  const {
    defaultLocation = "Freezer",
    batchLabel = "",
    householdId = null,
  } = options;

  const { freezerItems, totalFreezerWeightKg } = useMemo(() => {
    if (!butcheryResult || !butcheryResult.result) {
      return { freezerItems: [], totalFreezerWeightKg: 0 };
    }

    const retailCuts = Array.isArray(butcheryResult.result.retailCutPlan)
      ? butcheryResult.result.retailCutPlan
      : [];
    const byproducts = Array.isArray(butcheryResult.result.offalAndByproducts)
      ? butcheryResult.result.offalAndByproducts
      : [];

    /** @type {Array<any>} */
    const items = [];

    const ts = new Date().toISOString();
    const batchId = `butchery-${ts}`;

    // Retail cuts → packaged freezer items
    for (const cut of retailCuts) {
      const weightKg = Number(cut.weightKg) || 0;
      if (!weightKg) continue;

      const units = Number(cut.units) || 0;
      const unitSizeKg = cut.unitSizeKg
        ? Number(cut.unitSizeKg) || 0
        : units
        ? weightKg / units
        : weightKg;

      items.push({
        id: `${batchId}-${cut.animalId || "animal"}-${
          cut.cutKey || "cut"
        }-${Math.random().toString(36).slice(2)}`,
        sku: `BUTCHERY-${(cut.cutKey || cut.cutName || "cut").toUpperCase()}`,
        label: cut.cutName || "Mixed Cut",
        category: "meat",
        subcategory: "retail-cut",
        animalId: cut.animalId || null,
        batchId,
        batchLabel: batchLabel || inferBatchLabelFromCut(cut),
        location: defaultLocation,
        storageType: "frozen",
        unitSystem: "metric",
        totalWeightKg: weightKg,
        units,
        unitSizeKg,
        createdAt: ts,
        source: {
          type: "butchery",
          refId: batchId,
        },
        metadata: {
          cutKey: cut.cutKey || null,
          species: cut.species || null,
          class: cut.class || null,
          notes: cut.notes || null,
        },
      });
    }

    // By-products → freezer items (organs, bones, fat)
    for (const bp of byproducts) {
      const weightKg = Number(bp.weightKg) || 0;
      if (!weightKg) continue;

      items.push({
        id: `${batchId}-${bp.animalId || "animal"}-${slugify(
          bp.name || "byproduct"
        )}-${Math.random().toString(36).slice(2)}`,
        sku: `BUTCHERY-BY-${slugify(bp.name || "byproduct").toUpperCase()}`,
        label: bp.name || "By-product",
        category: "meat",
        subcategory: bp.category || "offal",
        animalId: bp.animalId || null,
        batchId,
        batchLabel: batchLabel || inferBatchLabelFromByproduct(bp),
        location: defaultLocation,
        storageType: bp.storageType || "frozen",
        unitSystem: "metric",
        totalWeightKg: weightKg,
        units: 1,
        unitSizeKg: weightKg,
        createdAt: ts,
        source: {
          type: "butchery",
          refId: batchId,
        },
        metadata: {
          notes: bp.notes || null,
        },
      });
    }

    const total = items.reduce(
      (sum, item) => sum + (Number(item.totalWeightKg) || 0),
      0
    );

    return { freezerItems: items, totalFreezerWeightKg: total };
  }, [butcheryResult, defaultLocation, batchLabel]);

  const createFreezerPlanEnvelope = useCallback(() => {
    const ts = new Date().toISOString();
    return {
      id: `butchery-freezer-plan-${ts}`,
      kind: "freezer-plan",
      householdId: householdId || null,
      createdAt: ts,
      payload: {
        items: freezerItems,
        totals: {
          weightKg: totalFreezerWeightKg,
        },
      },
    };
  }, [freezerItems, totalFreezerWeightKg, householdId]);

  const emitFreezerPlanCreated = useCallback(async () => {
    if (!freezerItems.length) return;

    const envelope = createFreezerPlanEnvelope();
    const ts = new Date().toISOString();

    emit({
      type: "storehouse.freezer.plan.created",
      ts,
      source: "calculators/gardenAnimal/ButcheryWeightCalculator.hooks",
      data: envelope,
    });

    if (familyFundMode && typeof exportToHubIfEnabled === "function") {
      try {
        await exportToHubIfEnabled({
          kind: "freezer-plan",
          createdAt: ts,
          payload: envelope,
        });
        emit({
          type: "session.exported",
          ts,
          source: "calculators/gardenAnimal/ButcheryWeightCalculator.hooks",
          data: { kind: "freezer-plan", id: envelope.id },
        });
      } catch (err) {
        // fail silently per contract; console is okay for debugging
        // eslint-disable-next-line no-console
        console.warn("Butchery freezer plan Hub export failed", err);
      }
    }
  }, [createFreezerPlanEnvelope, freezerItems.length]);

  return {
    freezerItems,
    totalFreezerWeightKg,
    createFreezerPlanEnvelope,
    emitFreezerPlanCreated,
  };
}

/**
 * @typedef {Object} BatchPlanningOptions
 * @property {string} [householdId]
 * @property {number} [defaultSessionDurationMin] - default per-session duration if not otherwise inferred
 */

/**
 * Builds batch cooking / preservation session drafts from butchery yields.
 *
 * These drafts use the SSA Session contract with domain "cooking" or "preservation"
 * and are intended to be fed into the global SessionRunner via a higher-level page.
 *
 * @param {ButcheryResult|null|undefined} butcheryResult
 * @param {BatchPlanningOptions} [options]
 * @returns {{
 *   batchSessions: Array<any>,
 *   createBatchPlanningEnvelope: () => any,
 *   emitBatchPlanningSuggested: () => Promise<void>
 * }}
 */
export function useButcheryBatchPlanning(butcheryResult, options = {}) {
  const { householdId = null, defaultSessionDurationMin = 90 } = options;

  const batchSessions = useMemo(() => {
    if (!butcheryResult || !butcheryResult.result) return [];

    const retailCuts = Array.isArray(butcheryResult.result.retailCutPlan)
      ? butcheryResult.result.retailCutPlan
      : [];
    const byproducts = Array.isArray(butcheryResult.result.offalAndByproducts)
      ? butcheryResult.result.offalAndByproducts
      : [];
    const analytics = butcheryResult.result.analytics || {};

    const ts = new Date().toISOString();
    const batchId = `butchery-${ts}`;

    // Group cuts by high-level use case
    const { stewCuts, roastCuts, steakCuts, grindCuts } =
      groupCutsByUse(retailCuts);
    const bonesAndOrgans = byproducts.filter(
      (bp) =>
        (bp.category || "").toLowerCase().includes("bone") ||
        (bp.category || "").toLowerCase().includes("organ")
    );

    /** @type {Array<any>} */
    const sessions = [];

    if (grindCuts.length) {
      sessions.push(
        buildGrindSessionDraft({
          batchId,
          cuts: grindCuts,
          analytics,
          defaultSessionDurationMin,
        })
      );
    }

    if (stewCuts.length || roastCuts.length) {
      sessions.push(
        buildBatchCookingSessionDraft({
          batchId,
          stewCuts,
          roastCuts,
          analytics,
          defaultSessionDurationMin,
        })
      );
    }

    if (bonesAndOrgans.length) {
      sessions.push(
        buildStockAndOffalSessionDraft({
          batchId,
          byproducts: bonesAndOrgans,
          analytics,
          defaultSessionDurationMin,
        })
      );
    }

    return sessions;
  }, [butcheryResult, defaultSessionDurationMin]);

  const createBatchPlanningEnvelope = useCallback(() => {
    const ts = new Date().toISOString();
    return {
      id: `butchery-batch-planning-${ts}`,
      kind: "butchery-batch-planning",
      householdId: householdId || null,
      createdAt: ts,
      payload: {
        sessions: batchSessions,
      },
    };
  }, [batchSessions, householdId]);

  const emitBatchPlanningSuggested = useCallback(async () => {
    if (!batchSessions.length) return;

    const envelope = createBatchPlanningEnvelope();
    const ts = new Date().toISOString();

    emit({
      type: "planning.batchCooking.suggested",
      ts,
      source: "calculators/gardenAnimal/ButcheryWeightCalculator.hooks",
      data: envelope,
    });

    if (familyFundMode && typeof exportToHubIfEnabled === "function") {
      try {
        await exportToHubIfEnabled({
          kind: "butchery-batch-planning",
          createdAt: ts,
          payload: envelope,
        });
        emit({
          type: "session.exported",
          ts,
          source: "calculators/gardenAnimal/ButcheryWeightCalculator.hooks",
          data: { kind: "butchery-batch-planning", id: envelope.id },
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("Butchery batch planning Hub export failed", err);
      }
    }
  }, [createBatchPlanningEnvelope, batchSessions.length]);

  return {
    batchSessions,
    createBatchPlanningEnvelope,
    emitBatchPlanningSuggested,
  };
}

/**
 * Combined hook: pulls together freezer mappings and batch session suggestions.
 *
 * @param {ButcheryResult|null|undefined} butcheryResult
 * @param {{ freezer?: FreezerMappingOptions, batch?: BatchPlanningOptions }} [options]
 */
export function useButcheryPlanning(butcheryResult, options = {}) {
  const freezer = useButcheryFreezerMappings(butcheryResult, options.freezer);
  const batch = useButcheryBatchPlanning(butcheryResult, options.batch);

  return { freezer, batch };
}

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                            */
/* -------------------------------------------------------------------------- */

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function inferBatchLabelFromCut(cut) {
  const species = (cut.species || "").toString().trim();
  const className = (cut.class || "").toString().trim();
  const date = new Date().toLocaleDateString();
  if (species && className)
    return `${capitalize(species)} ${capitalize(className)} – ${date}`;
  if (species) return `${capitalize(species)} – ${date}`;
  return `Butchery Batch – ${date}`;
}

function inferBatchLabelFromByproduct(bp) {
  const name = (bp.name || "").toString().trim();
  const date = new Date().toLocaleDateString();
  if (name) return `${capitalize(name)} – ${date}`;
  return `By-products – ${date}`;
}

function capitalize(str) {
  if (!str) return "";
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function roundTo(value, decimals) {
  const factor = Math.pow(10, decimals || 0);
  return Math.round((Number(value) || 0) * factor) / factor;
}

/**
 * Groups retail cuts into high-level usage for batch planning.
 *
 * @param {Array<any>} cuts
 * @returns {{ stewCuts: any[], roastCuts: any[], steakCuts: any[], grindCuts: any[] }}
 */
function groupCutsByUse(cuts) {
  /** @type {any[]} */
  const stewCuts = [];
  /** @type {any[]} */
  const roastCuts = [];
  /** @type {any[]} */
  const steakCuts = [];
  /** @type {any[]} */
  const grindCuts = [];

  for (const cut of cuts || []) {
    const key = (cut.cutKey || cut.cutName || "").toLowerCase();

    if (!key) continue;

    if (
      key.includes("stew") ||
      key.includes("shank") ||
      key.includes("chuck")
    ) {
      stewCuts.push(cut);
    } else if (
      key.includes("roast") ||
      key.includes("round") ||
      key.includes("shoulder")
    ) {
      roastCuts.push(cut);
    } else if (
      key.includes("steak") ||
      key.includes("loin") ||
      key.includes("ribeye") ||
      key.includes("t-bone")
    ) {
      steakCuts.push(cut);
    } else if (
      key.includes("trim") ||
      key.includes("grind") ||
      key.includes("ground") ||
      key.includes("burger")
    ) {
      grindCuts.push(cut);
    } else {
      // heuristic fallback: heavier cuts → roast/stew
      const weight = Number(cut.weightKg) || 0;
      if (weight > 5) roastCuts.push(cut);
      else if (weight > 1.5) stewCuts.push(cut);
      else grindCuts.push(cut);
    }
  }

  return { stewCuts, roastCuts, steakCuts, grindCuts };
}

/**
 * Build a "Grind & Packaging" session draft from trimmings / grind cuts.
 *
 * @param {Object} params
 * @param {string} params.batchId
 * @param {Array<any>} params.cuts
 * @param {any} params.analytics
 * @param {number} params.defaultSessionDurationMin
 */
function buildGrindSessionDraft({
  batchId,
  cuts,
  analytics,
  defaultSessionDurationMin,
}) {
  const ts = new Date().toISOString();
  const totalKg = cuts.reduce((sum, c) => sum + (Number(c.weightKg) || 0), 0);
  const title = `Grind & Package (${roundTo(totalKg, 1)} kg)`;

  const steps = [
    {
      id: `${batchId}-grind-setup`,
      title: "Set Up Grinder & Work Area",
      desc: "Assemble grinder, sanitize work surfaces, set up trays or tubs for ground meat, and prepare labels/bags.",
      durationSec: 20 * 60,
      blockers: ["equipment", "inventory"],
      metadata: {
        tempTargetF: 32,
        donenessCue: "probeTemp",
        cueNotes:
          "Keep meat close to freezing to improve grind quality and food safety.",
      },
    },
    {
      id: `${batchId}-grind-process`,
      title: "Grind Meat Batch",
      desc: `Grind approximately ${roundTo(
        totalKg,
        1
      )} kg of trim into your target grind size. Mix batches as needed for fat content.`,
      durationSec: defaultSessionDurationMin * 60,
      blockers: ["equipment"],
      metadata: {
        tempTargetF: 40,
        donenessCue: "timer",
        cueNotes:
          "Check temperature regularly; if the batch warms too much, pause and chill before continuing the grind.",
      },
    },
    {
      id: `${batchId}-grind-package`,
      title: "Package & Label Ground Meat",
      desc: "Weigh portions into target pack sizes, vacuum seal or wrap, and label with species, grind %, and date.",
      durationSec: 30 * 60,
      blockers: ["inventory"],
      metadata: {
        tempTargetF: 0,
        donenessCue: "timer",
        cueNotes:
          "Send final pack weights to the Storehouse freezer inventory tools.",
      },
    },
  ];

  return {
    id: `session-grind-${ts}`,
    domain: "cooking",
    title,
    source: {
      type: "animalTask",
      refId: batchId,
    },
    steps,
    prefs: {
      voiceGuidance: true,
      haptic: true,
      autoAdvance: false,
    },
    status: "pending",
    progress: {
      currentStepIndex: 0,
      elapsedSec: 0,
      startedAt: null,
      pausedAt: null,
    },
    analytics: {
      sourceAnalytics: analytics || {},
      skippedSteps: [],
      adjustments: [],
    },
    createdAt: ts,
    updatedAt: ts,
  };
}

/**
 * Batch cooking session draft for stews/roasts.
 */
function buildBatchCookingSessionDraft({
  batchId,
  stewCuts,
  roastCuts,
  analytics,
  defaultSessionDurationMin,
}) {
  const ts = new Date().toISOString();
  const stewKg = stewCuts.reduce(
    (sum, c) => sum + (Number(c.weightKg) || 0),
    0
  );
  const roastKg = roastCuts.reduce(
    (sum, c) => sum + (Number(c.weightKg) || 0),
    0
  );
  const totalKg = stewKg + roastKg;

  const title = `Batch Cooking – Stews & Roasts (${roundTo(totalKg, 1)} kg)`;

  const steps = [
    {
      id: `${batchId}-batch-thaw`,
      title: "Thaw or Temper Cuts",
      desc: "Move selected stew and roast cuts from deep freeze to refrigerator or controlled thaw area. Confirm enough capacity for planned recipes.",
      durationSec: 12 * 60 * 60, // long passive step
      blockers: ["inventory"],
      metadata: {
        tempTargetF: 40,
        donenessCue: "probeTemp",
        cueNotes:
          "Use SSA's thaw planning tools to ensure safe time/temperature; actual timings will vary by cut size.",
      },
    },
    {
      id: `${batchId}-batch-prep`,
      title: "Prep Cuts & Aromatics",
      desc: "Cube stew meat, trim roasts if needed, and prepare vegetables, aromatics, and herbs for batch recipes.",
      durationSec: 45 * 60,
      blockers: ["inventory"],
      metadata: {
        tempTargetF: 0,
        donenessCue: "timer",
        cueNotes:
          "As you prep, tag cuts to specific recipes inside SSA so leftovers roll into the Meal Planner.",
      },
    },
    {
      id: `${batchId}-batch-cook`,
      title: "Cook Stews & Roasts",
      desc: "Brown, braise, or slow-cook roasts and stews according to your chosen recipes. Stagger start times so everything finishes within a safe window.",
      durationSec: defaultSessionDurationMin * 60,
      blockers: ["equipment", "inventory"],
      metadata: {
        tempTargetF: 195,
        donenessCue: "probeTemp",
        cueNotes:
          "Use internal temp and tenderness as primary doneness cues. SSA timers & probes can help track multiple pots.",
      },
    },
    {
      id: `${batchId}-batch-package`,
      title: "Portion & Store Cooked Meals",
      desc: "Cool, portion into containers, label with recipe name and date, and store in fridge or freezer. Log final portions into SSA Meal & Storehouse tools.",
      durationSec: 40 * 60,
      blockers: ["inventory"],
      metadata: {
        tempTargetF: 40,
        donenessCue: "timer",
        cueNotes:
          "Cool quickly to food-safe temperatures before freezing. Consider single-serve and family-size portions.",
      },
    },
  ];

  return {
    id: `session-batch-cook-${ts}`,
    domain: "cooking",
    title,
    source: {
      type: "animalTask",
      refId: batchId,
    },
    steps,
    prefs: {
      voiceGuidance: true,
      haptic: true,
      autoAdvance: false,
    },
    status: "pending",
    progress: {
      currentStepIndex: 0,
      elapsedSec: 0,
      startedAt: null,
      pausedAt: null,
    },
    analytics: {
      sourceAnalytics: analytics || {},
      skippedSteps: [],
      adjustments: [],
    },
    createdAt: ts,
    updatedAt: ts,
  };
}

/**
 * Stock & offal preservation session draft.
 */
function buildStockAndOffalSessionDraft({
  batchId,
  byproducts,
  analytics,
  defaultSessionDurationMin,
}) {
  const ts = new Date().toISOString();
  const totalKg = byproducts.reduce(
    (sum, b) => sum + (Number(b.weightKg) || 0),
    0
  );
  const title = `Stock, Broth & Offal Prep (${roundTo(totalKg, 1)} kg)`;

  const steps = [
    {
      id: `${batchId}-stock-roast`,
      title: "Roast Bones (Optional)",
      desc: "Spread bones and connective tissue on pans and roast until well browned if you want a richer stock flavor.",
      durationSec: 60 * 60,
      blockers: ["equipment"],
      metadata: {
        tempTargetF: 400,
        donenessCue: "smell",
        cueNotes: "Roast until deeply browned and fragrant but not burnt.",
      },
    },
    {
      id: `${batchId}-stock-simmer`,
      title: "Simmer Stock / Broth",
      desc: "Combine bones and aromatics with water. Simmer gently for several hours, skimming as needed for a clear broth.",
      durationSec: defaultSessionDurationMin * 60 * 2,
      blockers: ["equipment", "inventory"],
      metadata: {
        tempTargetF: 212,
        donenessCue: "smell",
        cueNotes:
          "Low simmer is key. SSA timers can remind you to skim and top up water periodically.",
      },
    },
    {
      id: `${batchId}-offal-prep`,
      title: "Prepare Organs & Special By-products",
      desc: "Trim and portion organs (liver, heart, tongue, etc.) for immediate cooking, freezing, or other preservation methods.",
      durationSec: 45 * 60,
      blockers: ["inventory"],
      metadata: {
        tempTargetF: 40,
        donenessCue: "timer",
        cueNotes:
          "Keep offal cold and clearly labeled; many organ cuts thaw faster and have shorter storage windows.",
      },
    },
    {
      id: `${batchId}-stock-package`,
      title: "Cool, Package & Label",
      desc: "Cool stock and organ dishes rapidly, portion into containers, label, and move to fridge or freezer. Update the Storehouse so stock shows as available.",
      durationSec: 40 * 60,
      blockers: ["inventory"],
      metadata: {
        tempTargetF: 40,
        donenessCue: "timer",
        cueNotes: "Use shallow containers and ice baths to cool stock quickly.",
      },
    },
  ];

  return {
    id: `session-stock-offal-${ts}`,
    domain: "preservation",
    title,
    source: {
      type: "animalTask",
      refId: batchId,
    },
    steps,
    prefs: {
      voiceGuidance: true,
      haptic: true,
      autoAdvance: false,
    },
    status: "pending",
    progress: {
      currentStepIndex: 0,
      elapsedSec: 0,
      startedAt: null,
      pausedAt: null,
    },
    analytics: {
      sourceAnalytics: analytics || {},
      skippedSteps: [],
      adjustments: [],
    },
    createdAt: ts,
    updatedAt: ts,
  };
}
