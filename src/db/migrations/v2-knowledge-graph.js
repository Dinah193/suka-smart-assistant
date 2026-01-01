// C:\Users\larho\suka-smart-assistant\src\db\migrations\v2-knowledge-graph.js
// -----------------------------------------------------------------------------
// v2-knowledge-graph — CONTEXT INTELLIGENCE / KNOWLEDGE GRAPH SEED
// -----------------------------------------------------------------------------
// PURPOSE
// -----------------------------------------------------------------------------
// Your SSA takes imports from multiple domains (recipe, cleaning, garden/seed,
// animal/butchery, storehouse, video/how-to) and you said:
//   “Every import must become context intelligence: ingredient patterns,
//    methods, equipment, seasonality.”
//
// This migration seeds the *knowledge layer* that those imports should write to.
//
// After v1-imports gave you import sources + settings, this v2 migration
// installs the default knowledge graph scaffolding that:
//
// 1. Gives you base node types: ingredient, method, equipment, season, domain
// 2. Links them with common relations: uses, requires, yields, similar-to
// 3. Lets ImportNormalizer and ImportService immediately “file” new intel
// 4. Emits SSA events so the automation runtime / analytics can react
// 5. Optionally exports to the Hub if familyFundMode=true
//
// HOW IT FITS
// imports → normalized → **knowledge/graph seeded here** → automation suggestions
// → (optional) hub export.
// -----------------------------------------------------------------------------

import eventBus from "../../services/eventBus.js";
import featureFlags from "../../config/featureFlags.json" assert { type: "json" };

let HubPacketFormatter = null;
let FamilyFundConnector = null;

// Soft import Hub deps – do NOT break SSA if Hub is not installed.
(async function softImportHubDeps() {
  try {
    const fmt = await import("../../services/hub/HubPacketFormatter.js");
    const conn = await import("../../services/hub/FamilyFundConnector.js");
    HubPacketFormatter = fmt?.default || fmt;
    FamilyFundConnector = conn?.default || conn;
  } catch (_err) {
    // Silent on purpose.
  }
})();

export const MIGRATION_ID = "v2-knowledge-graph";
const SOURCE = "db/migrations/v2-knowledge-graph.js";

// -----------------------------------------------------------------------------
// PUBLIC API
// -----------------------------------------------------------------------------
//
// In your db/index.js migrations runner, call:
//
//   import { applyMigration as v2Knowledge } from "./migrations/v2-knowledge-graph.js";
//   await v2Knowledge(db);
//
// -----------------------------------------------------------------------------
export async function applyMigration(db) {
  if (!db) return;

  const already = await isMigrationApplied(db, MIGRATION_ID);
  if (already) {
    emitEvent("system.migration.skipped", {
      migrationId: MIGRATION_ID,
      reason: "already-applied"
    });
    return;
  }

  // 1. seed core node types
  await seedCoreNodeTypes(db);

  // 2. seed starter nodes for meals, cleaning, garden, animal, storehouse, preservation
  await seedStarterNodes(db);

  // 3. seed relations between those nodes so engines can query “what should I do?”
  await seedStarterRelations(db);

  // 4. mark as applied
  await markMigrationApplied(db, MIGRATION_ID);

  // 5. tell SSA
  emitEvent("system.migration.applied", {
    migrationId: MIGRATION_ID,
    affects: ["kg_nodes", "kg_relations", "kg_meta"],
    tsApplied: new Date().toISOString()
  });

  // 6. optionally export to Hub
  await exportToHubIfEnabled({
    type: "system.migration.applied",
    ts: new Date().toISOString(),
    source: SOURCE,
    data: {
      migrationId: MIGRATION_ID,
      modules: ["knowledge-graph", "context-intelligence"]
    }
  });
}

// -----------------------------------------------------------------------------
// INTERNAL HELPERS
// -----------------------------------------------------------------------------

async function isMigrationApplied(db, migrationId) {
  try {
    const row = await db.table("system_meta").get({ key: `migration:${migrationId}` });
    return !!row;
  } catch (_err) {
    return false;
  }
}

async function markMigrationApplied(db, migrationId) {
  const ts = new Date().toISOString();
  try {
    await db.table("system_meta").put({
      key: `migration:${migrationId}`,
      value: {
        id: migrationId,
        appliedAt: ts
      }
    });
  } catch (_err) {
    // non-fatal
  }
}

function emitEvent(type, data) {
  const env = {
    type,
    ts: new Date().toISOString(),
    source: SOURCE,
    data
  };
  try {
    eventBus.emit(env);
  } catch (_err) {
    // swallow – migration should never crash app
  }
}

// -----------------------------------------------------------------------------
// SEEDERS
// -----------------------------------------------------------------------------
//
// We assume these Dexie tables already exist in src/db/index.js:
//
//   kg_nodes      # { id, type, label, domain, props, createdAt, updatedAt }
//   kg_relations  # { id, from, to, relType, weight, props, createdAt }
//   kg_meta       # { key, value }
//
// If not, create them in your db version bump, then run this migration.
// -----------------------------------------------------------------------------

async function seedCoreNodeTypes(db) {
  const table = db.table("kg_nodes");
  const now = new Date().toISOString();

  const core = [
    {
      id: "type:ingredient",
      type: "kg-type",
      label: "Ingredient",
      domain: "global",
      props: {
        description: "Base node for edible/consumable items (meals, preservation)."
      },
      createdAt: now,
      updatedAt: now
    },
    {
      id: "type:method",
      type: "kg-type",
      label: "Method",
      domain: "global",
      props: {
        description: "Base node for how-tos: cook, clean, preserve, harvest, butcher."
      },
      createdAt: now,
      updatedAt: now
    },
    {
      id: "type:equipment",
      type: "kg-type",
      label: "Equipment",
      domain: "global",
      props: {
        description: "Things needed to do methods: pressure canner, dehydrator, mop, vacuum."
      },
      createdAt: now,
      updatedAt: now
    },
    {
      id: "type:season",
      type: "kg-type",
      label: "Season",
      domain: "global",
      props: {
        description: "Seasonality for garden and preservation."
      },
      createdAt: now,
      updatedAt: now
    },
    {
      id: "type:domain",
      type: "kg-type",
      label: "Domain",
      domain: "global",
      props: {
        description: "SSA domains: meals, cleaning, garden, animals, storehouse, preservation."
      },
      createdAt: now,
      updatedAt: now
    }
  ];

  for (const node of core) {
    try {
      const exists = await table.get(node.id);
      if (!exists) {
        await table.put(node);
      }
    } catch (_err) {
      // continue
    }
  }
}

async function seedStarterNodes(db) {
  const table = db.table("kg_nodes");
  const now = new Date().toISOString();

  // We pre-seed a few things that reflect your real setup: lamb, goat, rosemary,
  // tomato (for canning), cleaning basics, garden seeds, animal butchery.
  const nodes = [
    // DOMAIN NODES ------------------------------------------------------------
    {
      id: "domain:meals",
      type: "domain",
      label: "Meals / Cooking",
      domain: "global",
      props: { engines: ["MealSessionEngine"] },
      createdAt: now,
      updatedAt: now
    },
    {
      id: "domain:cleaning",
      type: "domain",
      label: "Cleaning / Declutter",
      domain: "global",
      props: { engines: ["CleaningSessionEngine"] },
      createdAt: now,
      updatedAt: now
    },
    {
      id: "domain:garden",
      type: "domain",
      label: "Garden / Seed / Harvest",
      domain: "global",
      props: { engines: ["GardenSessionEngine"] },
      createdAt: now,
      updatedAt: now
    },
    {
      id: "domain:animals",
      type: "domain",
      label: "Animals / Butchery",
      domain: "global",
      props: { engines: ["AnimalSessionEngine"] },
      createdAt: now,
      updatedAt: now
    },
    {
      id: "domain:storehouse",
      type: "domain",
      label: "Storehouse / Long-term",
      domain: "global",
      props: { engines: ["StorehousePlanner"] },
      createdAt: now,
      updatedAt: now
    },
    {
      id: "domain:preservation",
      type: "domain",
      label: "Preservation",
      domain: "global",
      props: { engines: ["PreservationSessionEngine"] },
      createdAt: now,
      updatedAt: now
    },

    // INGREDIENT / RESOURCE NODES --------------------------------------------
    {
      id: "ing:meat:lamb",
      type: "ingredient",
      label: "Lamb",
      domain: "meals",
      props: {
        clean: true,
        yieldRefs: ["yieldCurves/meat/sheep_katahdin.json"],
        storehouseAlt: "frozen_lamb"
      },
      createdAt: now,
      updatedAt: now
    },
    {
      id: "ing:meat:goat",
      type: "ingredient",
      label: "Goat",
      domain: "meals",
      props: {
        clean: true,
        yieldRefs: ["yieldCurves/meat/goat_kiko.json"],
        storehouseAlt: "frozen_goat"
      },
      createdAt: now,
      updatedAt: now
    },
    {
      id: "ing:herb:rosemary",
      type: "ingredient",
      label: "Rosemary",
      domain: "meals",
      props: {
        gardenAlt: "Rosemary (perennial)",
        preservation: ["dehydrate", "infuse_oil"]
      },
      createdAt: now,
      updatedAt: now
    },
    {
      id: "ing:veg:tomato_roma",
      type: "ingredient",
      label: "Tomato, Roma",
      domain: "meals",
      props: {
        gardenAlt: "Tomato, Roma",
        preservation: ["can_hot_water", "freeze"],
        triggers: ["garden.harvest.logged"]
      },
      createdAt: now,
      updatedAt: now
    },
    // CLEANING ----------------------------------------------------------------
    {
      id: "clean:all_purpose",
      type: "ingredient",
      label: "All-Purpose Cleaner",
      domain: "cleaning",
      props: {
        storehouseAlt: "vinegar",
        methods: ["wipe", "sanitize"]
      },
      createdAt: now,
      updatedAt: now
    },
    {
      id: "clean:baking_soda",
      type: "ingredient",
      label: "Baking Soda",
      domain: "cleaning",
      props: { methods: ["scrub", "deodorize"] },
      createdAt: now,
      updatedAt: now
    },
    // GARDEN SEASONALITY ------------------------------------------------------
    {
      id: "season:cool",
      type: "season",
      label: "Cool Season",
      domain: "garden",
      props: { months: ["Feb", "Mar", "Oct", "Nov"], tasks: ["sow", "transplant"] },
      createdAt: now,
      updatedAt: now
    },
    {
      id: "season:warm",
      type: "season",
      label: "Warm Season",
      domain: "garden",
      props: { months: ["Apr", "May", "Jun", "Jul", "Aug"], tasks: ["sow", "transplant"] },
      createdAt: now,
      updatedAt: now
    }
  ];

  for (const node of nodes) {
    try {
      const exists = await table.get(node.id);
      if (!exists) {
        await table.put(node);
      }
    } catch (_err) {
      // non-fatal
    }
  }
}

async function seedStarterRelations(db) {
  const table = db.table("kg_relations");
  const now = new Date().toISOString();

  // build relations between domains and ingredients/methods
  const rels = [
    // meals → ingredients
    {
      id: "rel:meals-uses-lamb",
      from: "domain:meals",
      to: "ing:meat:lamb",
      relType: "uses",
      weight: 0.9,
      props: { note: "meals frequently use lamb (Torah-clean replacement for pork)" },
      createdAt: now
    },
    {
      id: "rel:meals-uses-goat",
      from: "domain:meals",
      to: "ing:meat:goat",
      relType: "uses",
      weight: 0.85,
      props: { note: "meals use goat for sausage, breakfast meats, curries" },
      createdAt: now
    },
    {
      id: "rel:meals-uses-rosemary",
      from: "domain:meals",
      to: "ing:herb:rosemary",
      relType: "uses",
      weight: 0.7,
      props: { note: "SSA can suggest planting rosemary if inventory is low" },
      createdAt: now
    },

    // garden → seasons
    {
      id: "rel:garden-in-season-cool",
      from: "domain:garden",
      to: "season:cool",
      relType: "in-season",
      weight: 1.0,
      props: { note: "cool-season crops go here" },
      createdAt: now
    },
    {
      id: "rel:garden-in-season-warm",
      from: "domain:garden",
      to: "season:warm",
      relType: "in-season",
      weight: 1.0,
      props: { note: "warm-season crops go here" },
      createdAt: now
    },

    // preservation ↔ tomato
    {
      id: "rel:preserve-can-tomato",
      from: "domain:preservation",
      to: "ing:veg:tomato_roma",
      relType: "preserve",
      weight: 0.95,
      props: {
        method: "can_hot_water",
        triggerFromEvent: "garden.harvest.logged"
      },
      createdAt: now
    },

    // cleaning ↔ ingredients
    {
      id: "rel:cleaning-uses-apc",
      from: "domain:cleaning",
      to: "clean:all_purpose",
      relType: "uses",
      weight: 1.0,
      props: { note: "if inventory low → suggest storehouse vinegar or DIY cleaner" },
      createdAt: now
    },
    {
      id: "rel:cleaning-alt-baking-soda",
      from: "clean:baking_soda",
      to: "clean:all_purpose",
      relType: "alternative-to",
      weight: 0.6,
      props: { note: "can replace all-purpose for scrub jobs" },
      createdAt: now
    },

    // animals ↔ meals/storehouse (future butchery)
    {
      id: "rel:animals-yield-lamb",
      from: "domain:animals",
      to: "ing:meat:lamb",
      relType: "yields",
      weight: 1.0,
      props: {
        yieldCurves: ["yieldCurves/meat/sheep_katahdin.json"],
        triggers: ["animal.butchery.logged"]
      },
      createdAt: now
    },
    {
      id: "rel:animals-yield-goat",
      from: "domain:animals",
      to: "ing:meat:goat",
      relType: "yields",
      weight: 1.0,
      props: {
        yieldCurves: ["yieldCurves/meat/goat_kiko.json"],
        triggers: ["animal.butchery.logged"]
      },
      createdAt: now
    }
  ];

  for (const rel of rels) {
    try {
      const exists = await table.get(rel.id);
      if (!exists) {
        await table.put(rel);
      }
    } catch (_err) {
      // non-fatal
    }
  }

  // emit an intelligence-created event so your analytics / UI can show progress
  emitEvent("context.intelligence.created", {
    intelId: "kg.seed." + MIGRATION_ID,
    sourceImportId: null,
    intelType: "kg-seed",
    intel: {
      nodes: rels.length,
      note: "seeded default KG domains/ingredients/relations for SSA"
    }
  });
}

// -----------------------------------------------------------------------------
// HUB EXPORT
// -----------------------------------------------------------------------------

async function exportToHubIfEnabled(ssaEventEnvelope) {
  const familyFundMode = !!featureFlags?.familyFundMode;
  if (!familyFundMode) return;

  const packet =
    HubPacketFormatter?.formatForHub?.(ssaEventEnvelope) || ssaEventEnvelope;

  try {
    if (FamilyFundConnector?.sendToHub) {
      await FamilyFundConnector.sendToHub(packet);

      emitEvent("hub.export.succeeded", {
        exportId: packet?.data?.migrationId || randomId(),
        responseMeta: { mode: "knowledge-graph" }
      });
    }
  } catch (_err) {
    emitEvent("hub.export.failed", {
      exportId: packet?.data?.migrationId || randomId(),
      reason: "hub-unavailable",
      attempts: 1
    });
  }
}

// -----------------------------------------------------------------------------
// UTIL
// -----------------------------------------------------------------------------

function randomId() {
  return "kg_" + Math.random().toString(36).slice(2, 10);
}
