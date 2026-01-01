// C:\Users\larho\suka-smart-assistant\src\db\migrations\v1-imports.js
// -----------------------------------------------------------------------------
// v1-imports — INITIAL IMPORT STACK MIGRATION
// -----------------------------------------------------------------------------
// WHAT THIS MIGRATION DOES
// - Seeds the *data layer* for your multi-domain import system.
// - Adds baseline rows so the UI (ImportLanding, ImportSettings, ImportQueueManager)
//   can render immediately, even on a fresh install.
// - Wires to the shared eventBus and emits a standard envelope
//   { type, ts, source, data } so your automation runtime knows a migration ran.
// - Leaves extension points for new import domains (preservation, animal, storehouse).
//
// HOW THIS FITS IN THE PIPELINE
// imports (raw) → **this migration ensures tables & defaults exist** →
// normalizes → context intelligence → automation → (optional) hub export.
//
// ASSUMPTIONS
// - You are using Dexie and you already declared the stores in src/db/index.js
//   for: imports, import_intel, import_queue, import_sources, system_meta
//   This migration ONLY seeds/repairs data; it does NOT define the Dexie schema version.
// - eventBus exists at src/services/events/eventBus.js
// - env.js provides getConfig() with featureFlags.familyFundMode
// - HubPacketFormatter and FamilyFundConnector may or may not exist — we soft-import.
// -----------------------------------------------------------------------------

// ✅ Correct event bus location (your project uses services/events/)
import busMod from "../../services/events/eventBus.js";

// ✅ Use env.js (no JSON assert; plays nice with Vite/TS)
import getConfigDefault, { getConfig as getConfigNamed } from "../../config/env.js";
const getConfig = getConfigNamed || getConfigDefault || (() => ({}));

// Normalize default/named export for bus
const eventBus = (busMod && (busMod.default || busMod)) || { emit: () => {} };

// soft/optional hub deps (under /connectors, not /services/hub)
let HubPacketFormatter = null;
let FamilyFundConnector = null;

(async function softImportHubDeps() {
  try {
    const fmt = await import("../../connectors/HubPacketFormatter.js");
    const conn = await import("../../connectors/FamilyFundConnector.js");
    HubPacketFormatter = fmt?.default || fmt;
    FamilyFundConnector = conn?.default || conn;
  } catch (_err) {
    // silent by design – SSA must run without the Hub present
  }
})();

export const MIGRATION_ID = "v1-imports";
const SOURCE = "db/migrations/v1-imports.js";

// -----------------------------------------------------------------------------
// PUBLIC API (called from your db/index.js or migrations runner)
// -----------------------------------------------------------------------------
//
// Example from db/index.js:
//
//   import { applyMigration as v1Imports } from "./migrations/v1-imports.js";
//   await v1Imports(db);
//
// -----------------------------------------------------------------------------
export async function applyMigration(db) {
  if (!db) return;

  const already = await isMigrationApplied(db, MIGRATION_ID);
  if (already) {
    emitMigrationEvent("system.migration.skipped", {
      migrationId: MIGRATION_ID,
      reason: "already-applied"
    });
    return;
  }

  // 1) seed import sources (where data can come from)
  await seedImportSources(db);

  // 2) seed import settings (user/system prefs)
  await seedImportSettings(db);

  // 3) seed import queue with a tiny example (helps UI show 'recent')
  await seedImportQueue(db);

  // 4) mark migration as applied
  await markMigrationApplied(db, MIGRATION_ID);

  // 5) emit SSA event for automation + analytics
  emitMigrationEvent("system.migration.applied", {
    migrationId: MIGRATION_ID,
    affects: [
      "imports",
      "import_intel",
      "import_queue",
      "import_sources"
    ],
    tsApplied: new Date().toISOString()
  });

  // 6) optionally export to Hub IF this is a Hub-aware household
  await exportToHubIfEnabled({
    type: "system.migration.applied",
    ts: new Date().toISOString(),
    source: SOURCE,
    data: {
      migrationId: MIGRATION_ID,
      modules: ["imports"]
    }
  });
}

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

/**
 * Check if this migration has been applied by looking in system_meta.
 * We use a very simple pattern so you can copy/paste for v2, v3...
 */
async function isMigrationApplied(db, migrationId) {
  try {
    const row = await db.table("system_meta").get({ key: `migration:${migrationId}` });
    return !!row;
  } catch (_err) {
    // if system_meta doesn't exist yet, treat as not applied
    return false;
  }
}

/**
 * Insert a marker into system_meta so we don't re-run.
 */
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
    // non-fatal – migration is still considered applied from our POV
  }
}

/**
 * Seed import sources – this tells the ImportService where payloads may arrive from.
 * You can extend this array to add: "youtube", "rumble", "pinterest", "garden.blog", etc.
 */
async function seedImportSources(db) {
  const table = db.table("import_sources");

  const baseline = [
    {
      id: "web.share",
      label: "Web Share / Desktop",
      enabled: true,
      domains: ["*"],
      createdAt: new Date().toISOString()
    },
    {
      id: "ios.shortcut",
      label: "iOS Shortcut",
      enabled: true,
      domains: ["*"],
      createdAt: new Date().toISOString()
    },
    {
      id: "bookmarklet",
      label: "Browser Bookmarklet",
      enabled: true,
      domains: ["*"],
      createdAt: new Date().toISOString()
    },
    {
      id: "scan-compare-trust",
      label: "Scan • Compare • Trust (CSV/PDF)",
      enabled: true,
      domains: [
        "storehouse",
        "inventory",
        "meals",
        "cleaning",
        "garden",
        "animal",
        "preservation"
      ],
      createdAt: new Date().toISOString()
    }
  ];

  for (const src of baseline) {
    try {
      const existing = await table.get(src.id);
      if (!existing) {
        await table.put(src);
      }
    } catch (_err) {
      // best-effort – do not fail the whole migration
    }
  }
}

/**
 * Seed import settings – user/system preferences.
 * We add support for ALL your domains right away so the UI can toggle them.
 */
async function seedImportSettings(db) {
  const table = db.table("imports");

  const DEFAULT_SETTINGS_ID = "settings:default";
  const existing = await table.get(DEFAULT_SETTINGS_ID);
  if (existing) return;

  const ts = new Date().toISOString();

  const settings = {
    id: DEFAULT_SETTINGS_ID,
    kind: "settings",
    createdAt: ts,
    updatedAt: ts,
    data: {
      // domains user can enable/disable
      domains: {
        recipe: true,
        cleaning: true,
        "garden/seed": true,
        "animal/butchery": true,
        storehouse: true,
        "video/howto": true,
        preservation: true
      },
      // if true: auto-run engines after import.parsed
      autoRunEngines: {
        meals: true,
        cleaning: true,
        garden: true,
        animals: true,
        storehouse: true,
        preservation: true
      },
      // if true: auto-create favorites/schedules from imports
      autoCreateUserAssets: {
        favorites: true,
        schedules: true
      },
      // import source priorities
      sources: ["ios.shortcut", "web.share", "bookmarklet", "scan-compare-trust"]
    }
  };

  try {
    await table.put(settings);
  } catch (_err) {
    // non-fatal
  }
}

/**
 * Seed import queue with a tiny sample so UI components
 * like ImportQueueManager have at least one row to show.
 */
async function seedImportQueue(db) {
  const table = db.table("import_queue");
  const sampleId = "imp_sample_v1";

  const already = await table.get(sampleId);
  if (already) return;

  const ts = new Date().toISOString();

  const sample = {
    id: sampleId,
    sourceKind: "web.share",
    status: "parsed", // could also be "pending", "failed", "dispatched"
    parsedType: "recipe",
    payloadSummary: {
      title: "Sample Imported Recipe",
      domainGuess: "recipe"
    },
    createdAt: ts,
    updatedAt: ts
  };

  try {
    await table.put(sample);
  } catch (_err) {
    // non-fatal
  }

  // let the rest of the app know we seeded one
  emitMigrationEvent("import.parsed", {
    importId: sampleId,
    parsedType: "recipe",
    contextIntelId: null,
    linkHints: {
      inventory: [],
      storehouse: [],
      garden: []
    }
  });
}

/**
 * Emit an SSA event using the shared eventBus with correct envelope.
 */
function emitMigrationEvent(type, data) {
  const envelope = {
    type,
    ts: new Date().toISOString(),
    source: SOURCE,
    data
  };

  try {
    // also emit a DOM CustomEvent for any vanilla listeners
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(type, { detail: envelope }));
    }
  } catch {}
  try {
    eventBus.emit(envelope);
  } catch (_err) {
    // if eventBus isn't ready, ignore
  }
}

/**
 * If household runs in familyFundMode, export this migration info to the Hub.
 * This is mostly telemetry / visibility so Hub admins know a node was initialized.
 */
async function exportToHubIfEnabled(ssaEventEnvelope) {
  try {
    const cfg = getConfig() || {};
    const familyFundMode =
      !!(cfg.featureFlags && (cfg.featureFlags.familyFundMode === true));

    if (!familyFundMode) return;

    // try mapping via HubPacketFormatter, else send raw
    const packet =
      HubPacketFormatter?.formatForHub?.(ssaEventEnvelope) ||
      HubPacketFormatter?.wrap?.("migration", ssaEventEnvelope) ||
      ssaEventEnvelope;

    if (FamilyFundConnector?.sendToHub) {
      await FamilyFundConnector.sendToHub(packet);

      // also emit local "hub.export.succeeded"
      emitMigrationEvent("hub.export.succeeded", {
        exportId: packet?.data?.migrationId || randomId(),
        responseMeta: { mode: "migration-init" }
      });
    }
  } catch (_err) {
    emitMigrationEvent("hub.export.failed", {
      exportId: ssaEventEnvelope?.data?.migrationId || randomId(),
      reason: "hub-unavailable",
      attempts: 1
    });
  }
}

/**
 * Tiny ID helper – no dependency on uuid.
 */
function randomId() {
  return "migr_" + Math.random().toString(36).slice(2, 10);
}
