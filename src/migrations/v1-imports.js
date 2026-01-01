// C:\Users\larho\suka-smart-assistant\src\migrations\v1-imports.js
//
// v1 – Core imports schema
// ------------------------
// Purpose:
//   Establish the *foundational* Dexie stores for the SSA import pipeline.
//   These stores capture raw imports (recipes, cleaning, garden, animals,
//   storehouse, video/how-to) and their early normalization stage, but DO NOT
//   yet mutate inventory/storehouse or create sessions.
//
//   This is the “imports” leg of the pipeline:
//
//     imports → intelligence → automation → (optional) Hub export
//
//   Later migrations will:
//     • Attach inventory entries to normalized imports.
//     • Create sessions from imports (via domain engines).
//     • Add Hub export mirrors when household data mutates.
//
// Stores created:
//   • imports
//     - One row per import (recipe URL, cleaning plan, seed catalog, etc.).
//   • importItems
//     - Normalized “row-level” items per import (ingredients, tasks, SKUs).
//   • importErrors
//     - Captures parsing/normalization failures for observability.
//   • importTags
//     - Lightweight tagging system for imports (e.g. “Passover”, “winter”, “prep-heavy”).
//
// How this fits into SSA
// ----------------------
// imports → intelligence → automation → (optional) hub export
//
// • imports (THIS migration):
//   - Gives ImportRouter + scrapers a safe place to persist raw + parsed data.
//   - Everything at this stage is “pre-inventory”: no stock is altered yet.
//
// • intelligence (later):
//   - Recipes, cleaning plans, garden rotations, animal routines, etc. are
//     derived from importItems and promoted into domain-specific stores.
//
// • automation (later):
//   - Session engines read those domain-specific records, then create sessions.
//
// • optional hub export (later):
//   - Once inventory/storehouse/session data mutates, other modules will
//     call exportToHubIfEnabled. This migration only sets up schema, so it
//     does NOT export anything to the Hub.

import eventBus from "../services/events/eventBus";

/**
 * Emit a structured migration event on the shared eventBus.
 *
 * NOTE: This is telemetry only. It does not change household data.
 *
 * @param {"db.migration.started"|"db.migration.completed"|"db.migration.error"} type
 * @param {any} data
 */
function emitMigrationEvent(type, data) {
  if (!eventBus || typeof eventBus.emit !== "function") return;

  eventBus.emit({
    type,
    ts: new Date().toISOString(),
    source: "migrations.v1-imports",
    data,
  });
}

/** @type {number} */
const VERSION = 1;

/**
 * Register v1 "imports" migration on a Dexie instance.
 *
 * This should be the FIRST version registration for SSA's Dexie DB.
 *
 * Example wiring:
 *
 *   import Dexie from "dexie";
 *   import { registerV1Imports } from "../migrations/v1-imports";
 *
 *   const db = new Dexie("SukaSmartAssistant");
 *   registerV1Imports(db);
 *   // then v2, v3, ...
 *
 * @param {import("dexie").Dexie} db
 */
export function registerV1Imports(db) {
  if (!db || typeof db.version !== "function") {
    throw new Error("[v1-imports] Dexie instance is required");
  }

  db.version(VERSION)
    .stores({
      // Core imports table
      //
      // One row per import (recipe URL, cleaning plan paste, seed catalog,
      // animal/butchery guide, storehouse scan, video/how-to link, etc.).
      //
      // Index rationale:
      //   • type:      "recipe" | "cleaning" | "garden" | "animals" | "storehouse" | "video" | "other"
      //   • domain:    "cooking" | "cleaning" | "garden" | "animals" | "preservation" | "storehouse"
      //   • sourceUrl: enable quick lookup / de-dup by URL
      //   • status:    track pipeline stage ("raw", "normalized", "linked", "error")
      //   • createdAt: chronological queries and cleanup jobs
      imports: "++id, type, domain, sourceUrl, status, createdAt, updatedAt",

      // Per-import items
      //
      // Row-level “pieces” extracted from imports — ingredients, tasks,
      // SKUs, sub-steps, etc. This is the bridge between imports and
      // domain engines (recipe normalizer, cleaning plan parser, etc.).
      //
      // Index rationale:
      //   • importId:   link back to parent import
      //   • domain:     allow domain engines to query only their slice
      //   • kind:       "ingredient" | "task" | "equipment" | "meta" | "sku"
      //   • refKey:     optional canonical key (e.g. normalized ingredient ID)
      importItems: "++id, importId, domain, kind, refKey, createdAt, updatedAt",

      // Import errors
      //
      // Captures issues encountered during scraping/normalization/validation,
      // so SSA can show helpful diagnostics in the UI and avoid silent failure.
      //
      // Index rationale:
      //   • importId:  group errors per import
      //   • code:      error code ("SCRAPE_FAILED", "PARSER_ERROR", "UNSUPPORTED_DOMAIN", ...)
      //   • createdAt: chronological debugging
      importErrors: "++id, importId, code, createdAt",

      // Import tags
      //
      // Lightweight tagging system so imports can be clustered by:
      //   - seasons ("spring", "winter")
      //   - feasts ("passover", "sukkot")
      //   - complexity ("weeknight", "long-cook", "batch")
      //
      // Index rationale:
      //   • importId: lookup tags by import
      //   • tag:      simple text search / filters
      importTags: "++id, importId, tag, createdAt",
    })
    .upgrade(async (tx) => {
      const startedAt = new Date().toISOString();
      emitMigrationEvent("db.migration.started", {
        version: VERSION,
        kind: "imports",
        startedAt,
      });

      // v1 is a pure schema migration:
      //   • no existing data to migrate
      //   • no inventory/storehouse/session changes
      //   • no Hub export
      //
      // Still, we keep this upgrade callback so we can extend it safely
      // in early development (e.g. seed initial tags/imports for demos).
      //
      // Example (commented out by default):
      // const importsTable = tx.table("imports");
      // await importsTable.add({
      //   type: "recipe",
      //   domain: "cooking",
      //   sourceUrl: null,
      //   status: "seed",
      //   title: "Example Seed Import",
      //   raw: null,
      //   createdAt: startedAt,
      //   updatedAt: startedAt,
      // });

      const completedAt = new Date().toISOString();
      emitMigrationEvent("db.migration.completed", {
        version: VERSION,
        kind: "imports",
        startedAt,
        completedAt,
        notes:
          "Initial imports schema created (imports, importItems, importErrors, importTags).",
      });
    });
}

export default registerV1Imports;
