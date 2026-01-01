// C:\Users\larho\suka-smart-assistant\src\db\migrations\v7-normalized-store.js
// Dexie migration for normalized plans/tasks/blocks
// -----------------------------------------------------------------------------
// GOAL for v7
// - bring the *new* domains into the same normalized shape so the UI and the
//   automation/runtime can treat them similarly
// - domains to normalize:
//     • cleaning
//     • garden (plan + care + harvest)
//     • storehouse stock planning (with grocery-section inspiration)
//     • meals (plans, cooking sessions)
//     • animals (acquisition, care, butchery) + reverse-from-recipes
//     • import sessions (because you want to save user-created favorites/schedules)
// - support user-owned favorites & schedules at the row level
// - support reverse generation (meals → animals, meals → storehouse)
// - preserve older data (v5/v6) and *lift* it into the new shape
//
// This file assumes you already have a Dexie instance set up somewhere else and
// that your db file imports each migration in order.
//
// If your actual store names differ, adjust at the bottom in `migrateV7(db)`
// where we check for `db.cleaningSessions`, `db.gardenPlans`, etc.

import { getConfig } from "@/config";

const V7_VERSION = 7;

/**
 * normalizeBase
 * Ensures every domain row can be:
 * - owned by a user / household
 * - favorited
 * - scheduled
 * - orchestrated
 */
function normalizeBase(row, cfg, domain) {
  if (!row) row = {};

  // owner-ish
  if (!row.userId) row.userId = "__system__";
  if (!row.householdId) row.householdId = "__default_household__";

  // favorites/schedules (per-domain overrides)
  const domCfg = cfg.domains?.[domain];
  const canFav =
    cfg.allowUserFavorites && domCfg && domCfg.allowUserFavorites !== false;
  const canSched =
    cfg.allowUserSchedules && domCfg && domCfg.allowUserSchedules !== false;

  if (typeof row.favorite === "undefined") {
    row.favorite = canFav ? false : false; // default false, but allowed
  }
  if (typeof row.schedule === "undefined") {
    row.schedule = canSched
      ? {
          enabled: false,
        }
      : null;
  }

  // orchestration
  if (!row.orchestration) {
    row.orchestration = {
      source: "migration:v7",
      bus: cfg.runtimeHints?.domChannel || "window.__suka?.eventBus",
      shared: cfg.runtimeHints?.sharedBus ?? true,
    };
  }

  // timestamps
  const now = new Date().toISOString();
  if (!row.createdAt) row.createdAt = now;
  row.updatedAt = now;

  return row;
}

/**
 * normalizeCleaning
 * v5/v6 cleaning might have only { id, name, zone, steps[] }
 * we turn it into: { id, name, zone, steps[], routineType, meta }
 */
function normalizeCleaning(row, cfg) {
  row = normalizeBase(row, cfg, "cleaning");
  if (!row.routineType) {
    // infer from zone/steps
    if (row.zone && row.zone.toLowerCase().includes("bath")) {
      row.routineType = "bathroom";
    } else if (row.zone && row.zone.toLowerCase().includes("kitchen")) {
      row.routineType = "kitchen";
    } else {
      row.routineType = "general";
    }
  }
  if (!row.meta) row.meta = {};
  // support declutter / zone / deep-clean
  if (!row.meta.modes) {
    row.meta.modes = ["routine"];
    if (Array.isArray(row.steps) && row.steps.length > 6) {
      row.meta.modes.push("deep-clean");
    }
    if (row.name?.toLowerCase().includes("declutter")) {
      row.meta.modes.push("declutter");
    }
  }
  return row;
}

/**
 * normalizeGardenPlan
 * older data: { id, name, beds: [...] }
 * new data: { id, name, season, beds, careProfile, harvestProfile, collab }
 */
function normalizeGardenPlan(row, cfg) {
  row = normalizeBase(row, cfg, "garden");
  if (!row.season) {
    // guess season by date
    const m = new Date().getMonth() + 1;
    if ([3, 4, 5].includes(m)) row.season = "spring";
    else if ([6, 7, 8].includes(m)) row.season = "summer";
    else if ([9, 10, 11].includes(m)) row.season = "fall";
    else row.season = "winter";
  }
  if (!row.careProfile) {
    row.careProfile = {
      defaultWatering: "every-2d",
      defaultFeeding: "weekly",
    };
  }
  if (!row.harvestProfile) {
    row.harvestProfile = {
      autoGenerateTasks: true,
      outputTo: "storehouse", // where harvest goes
    };
  }
  if (!row.collab) {
    row.collab = {
      enabled: cfg.domains?.garden?.collab?.enabled ?? false,
      coOpPlanning: cfg.domains?.garden?.collab?.coOpPlanning ?? false,
      shareablePlans: cfg.domains?.garden?.collab?.shareablePlans ?? false,
    };
  }
  return row;
}

/**
 * normalizeGardenTask
 * care & harvest tasks get normalized to a single shape
 */
function normalizeGardenTask(row, cfg) {
  row = normalizeBase(row, cfg, "garden");
  if (!row.type) row.type = "care";
  if (!row.status) row.status = "pending";
  return row;
}

/**
 * normalizeStorehouseGoal
 * older data might just have {id, name, items:[]}
 * we add grocery-section inspiration, reverseFromMeals, and co-op flags
 */
function normalizeStorehouseGoal(row, cfg) {
  row = normalizeBase(row, cfg, "storehouse");
  if (!row.grocerySections) {
    // try to lift from 'items'
    if (Array.isArray(row.items) && row.items.length) {
      row.grocerySections = row.items.map((it) => ({
        section: it.section || "Pantry",
        targetQty: it.targetQty || it.qty || 0,
        unit: it.unit || "each",
        fromMeals: !!it.fromMeals,
      }));
    } else {
      row.grocerySections = [
        { section: "Pantry", targetQty: 0, unit: "each", fromMeals: false },
      ];
    }
  }
  if (typeof row.reverseFromMeals === "undefined") {
    row.reverseFromMeals = true; // because we often import from meal plans
  }
  if (!row.coOp) {
    row.coOp = {
      enabled: cfg.domains?.storehouse?.coOp?.enabled ?? false,
      linkedHouseholds: cfg.domains?.storehouse?.coOp?.linkedHouseholds ?? false,
      bulkBuyEvents: cfg.domains?.storehouse?.coOp?.bulkBuyEvents ?? false,
    };
  }
  return row;
}

/**
 * normalizeMealPlan
 * we add reverseGeneration, and be sure steps/recipes are in a known shape
 */
function normalizeMealPlan(row, cfg) {
  row = normalizeBase(row, cfg, "meals");
  if (!row.reverseGeneration) {
    row.reverseGeneration = {
      toAnimalPlanner: true,
      toStorehouse: true,
      toShoppingList: true,
    };
  }
  if (!Array.isArray(row.days)) {
    row.days = [];
  }
  return row;
}

/**
 * normalizeAnimalPlan
 * add acquisition, care, butchery, reverse-from-recipes
 */
function normalizeAnimalPlan(row, cfg) {
  row = normalizeBase(row, cfg, "animals");
  if (!row.acquisition) {
    row.acquisition = [];
  }
  if (!row.careProfile) {
    row.careProfile = {
      feed: "2x/day",
      water: "2x/day",
    };
  }
  if (!row.butcheryProfile) {
    row.butcheryProfile = {
      enabled: true,
      routeOutputs: ["storehouse", "meals", "byproducts"],
    };
  }
  if (!row.reverseDirection) {
    row.reverseDirection = {
      generateAnimalPlanFromRecipes:
        cfg.domains?.animals?.reverseDirection?.generateAnimalPlanFromRecipes ??
        true,
    };
  }
  return row;
}

/**
 * normalizeImportSession
 * so user can favorite/schedule import pipelines (your requirement)
 */
function normalizeImportSession(row, cfg) {
  row = normalizeBase(row, cfg, "import");
  if (!row.payload) row.payload = {};
  return row;
}

// -----------------------------------------------------------------------------
// MIGRATION ENTRY
// -----------------------------------------------------------------------------
export async function migrateV7(db) {
  const cfg = getConfig({ tier: "ssa", role: "admin" });

  // CLEANING
  if (db.cleaningSessions) {
    const all = await db.cleaningSessions.toArray();
    const normalized = all.map((row) => normalizeCleaning(row, cfg));
    await bulkSafePut(db.cleaningSessions, normalized);
  }

  // GARDEN
  if (db.gardenPlans) {
    const all = await db.gardenPlans.toArray();
    const normalized = all.map((row) => normalizeGardenPlan(row, cfg));
    await bulkSafePut(db.gardenPlans, normalized);
  }
  if (db.gardenQueue) {
    const all = await db.gardenQueue.toArray();
    const normalized = all.map((row) => normalizeGardenTask(row, cfg));
    await bulkSafePut(db.gardenQueue, normalized);
  }

  // STOREHOUSE
  if (db.storehouseGoals) {
    const all = await db.storehouseGoals.toArray();
    const normalized = all.map((row) => normalizeStorehouseGoal(row, cfg));
    await bulkSafePut(db.storehouseGoals, normalized);
  }

  // MEALS
  if (db.mealPlans) {
    const all = await db.mealPlans.toArray();
    const normalized = all.map((row) => normalizeMealPlan(row, cfg));
    await bulkSafePut(db.mealPlans, normalized);
  }

  // ANIMALS
  if (db.animalPlans) {
    const all = await db.animalPlans.toArray();
    const normalized = all.map((row) => normalizeAnimalPlan(row, cfg));
    await bulkSafePut(db.animalPlans, normalized);
  }

  // IMPORT
  if (db.importSessions) {
    const all = await db.importSessions.toArray();
    const normalized = all.map((row) => normalizeImportSession(row, cfg));
    await bulkSafePut(db.importSessions, normalized);
  }

  // META
  if (db.meta) {
    await db.meta.put({
      id: "migration-v7",
      at: new Date().toISOString(),
      version: V7_VERSION,
      notes: "Normalized cleaning, garden, storehouse, meals, animals, import for favorites/schedules/reverse-gen.",
    });
  }
}

// bulkSafePut ---------------------------------------------------------
async function bulkSafePut(table, rows) {
  if (!table || !rows || !rows.length) return;
  try {
    await table.bulkPut(rows);
  } catch (err) {
    // fallback one-by-one
    // eslint-disable-next-line no-console
    console.warn("[v7-normalized-store] bulkPut failed, trying 1x", err?.message || err);
    for (const row of rows) {
      try {
        await table.put(row);
      } catch (err2) {
        // eslint-disable-next-line no-console
        console.warn("[v7-normalized-store] put failed for id", row?.id, err2?.message || err2);
      }
    }
  }
}

export default {
  version: V7_VERSION,
  migrate: migrateV7,
};
