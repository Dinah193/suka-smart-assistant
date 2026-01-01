// C:\Users\larho\suka-smart-assistant\src\db\migrations\v3-household-analytics.js
// -----------------------------------------------------------------------------
// v3-household-analytics — ANALYTICS PRIMING FOR SSA
// -----------------------------------------------------------------------------
// PURPOSE
// -----------------------------------------------------------------------------
// Your SSA is now emitting structured events (see eventCatalog.json) like:
//   - import.parsed
//   - inventory.updated
//   - inventory.shortage.detected
//   - meal.executed
//   - garden.harvest.logged
//   - preservation.completed
//   - animal.butchery.logged
//
// This migration PREPARES the local DB so that analytics dashboards
// (src/analytics/HouseholdAnalytics.jsx, domain-level KPI cards, “what did we
// cook this week?”, “what did we harvest?”, “what got preserved?”) have baseline
// buckets to write to.
//
// It does NOT do any heavy analytics calculation here — that is runtime work.
// It just:
//  1. Ensures analytics_* tables have baseline rows
//  2. Seeds KPI descriptors so UI can render cards immediately
//  3. Emits an SSA event so automation / UI can refresh
//  4. Optionally exports to the Hub if familyFundMode=true
//
// PIPELINE POSITION
// imports → intelligence (v2-knowledge-graph) → **analytics primed (this file)** →
// automation (schedule/suggest) → (optional) hub export.
// -----------------------------------------------------------------------------

// NOTE: event bus actually lives under services/events
import busMod from "../../services/events/eventBus.js";

// Use env config instead of a JSON assert so builds don’t break
import getConfigDefault, { getConfig as getConfigNamed } from "../../config/env.js";
const getConfig = getConfigNamed || getConfigDefault || (() => ({}));

// Normalize default/named export for bus
const eventBus = (busMod && (busMod.default || busMod)) || { emit: () => {} };

let HubPacketFormatter = null;
let FamilyFundConnector = null;

// Soft-import hub deps — SSA must not break if Hub isn’t shipped
(async function softImportHubDeps() {
  try {
    // Your connectors live under /src/connectors
    const fmt = await import("../../connectors/HubPacketFormatter.js");
    const conn = await import("../../connectors/FamilyFundConnector.js");
    HubPacketFormatter = fmt?.default || fmt;
    FamilyFundConnector = conn?.default || conn;
  } catch (_err) {
    // silent
  }
})();

export const MIGRATION_ID = "v3-household-analytics";
const SOURCE = "db/migrations/v3-household-analytics.js";

// -----------------------------------------------------------------------------
// PUBLIC ENTRY
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

  // 1. Seed analytics descriptors (what we want to track)
  await seedAnalyticsDescriptors(db);

  // 2. Seed time buckets (today, thisWeek, thisMonth, thisSeason)
  await seedAnalyticsTimeBuckets(db);

  // 3. Seed domain rollups (meals, cleaning, garden, preservation, inventory, animals)
  await seedDomainRollups(db);

  // 4. Mark migration applied
  await markMigrationApplied(db, MIGRATION_ID);

  // 5. Emit SSA event so anything listening (like HouseholdAnalytics.jsx) can refresh
  emitEvent("system.migration.applied", {
    migrationId: MIGRATION_ID,
    affects: ["analytics_descriptors", "analytics_rollups", "analytics_timebuckets"],
    tsApplied: new Date().toISOString()
  });

  // 6. Optionally export to Hub
  await exportToHubIfEnabled({
    type: "system.migration.applied",
    ts: new Date().toISOString(),
    source: SOURCE,
    data: {
      migrationId: MIGRATION_ID,
      modules: ["household-analytics"],
      note: "SSA analytics layer primed"
    }
  });
}

// -----------------------------------------------------------------------------
// HELPERS
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
  const envelope = {
    type,
    ts: new Date().toISOString(),
    source: SOURCE,
    data
  };
  try {
    // DOM event for vanilla listeners
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(type, { detail: envelope }));
    }
  } catch {}
  try {
    eventBus.emit(envelope);
  } catch (_err) {
    // swallow
  }
}

// -----------------------------------------------------------------------------
// SEEDERS
// -----------------------------------------------------------------------------
//
// Assumed tables (define them in src/db/index.js Dexie version):
//  - analytics_descriptors   # { id, domain, label, description, eventType, measure, createdAt, updatedAt }
//  - analytics_timebuckets   # { id, range, startISO, endISO, label, createdAt }
//  - analytics_rollups       # { id, domain, bucketId, counts, lastEventAt, createdAt, updatedAt }
//
// If some tables don’t exist yet, these calls will just no-op.
// -----------------------------------------------------------------------------

async function seedAnalyticsDescriptors(db) {
  const table = db.table("analytics_descriptors");
  const now = new Date().toISOString();

  const rows = [
    // MEALS -------------------------------------------------------------------
    {
      id: "kpi:meals:executed.count",
      domain: "meals",
      label: "Meals Cooked",
      description: "Count meal.executed events.",
      eventType: "meal.executed",
      measure: "count",
      createdAt: now,
      updatedAt: now
    },
    {
      id: "kpi:meals:inventory.used",
      domain: "meals",
      label: "Inventory Used for Meals",
      description: "Sum of inventory deltas from meal.executed.",
      eventType: "meal.executed",
      measure: "sum:inventoryDeltas",
      createdAt: now,
      updatedAt: now
    },

    // CLEANING ---------------------------------------------------------------
    {
      id: "kpi:cleaning:executed.count",
      domain: "cleaning",
      label: "Cleaning Sessions",
      description: "Count cleaning.executed events.",
      eventType: "cleaning.executed",
      measure: "count",
      createdAt: now,
      updatedAt: now
    },

    // GARDEN -----------------------------------------------------------------
    {
      id: "kpi:garden:harvest.count",
      domain: "garden",
      label: "Harvests Logged",
      description: "Count garden.harvest.logged events.",
      eventType: "garden.harvest.logged",
      measure: "count",
      createdAt: now,
      updatedAt: now
    },
    {
      id: "kpi:garden:harvest.weight",
      domain: "garden",
      label: "Harvest Weight / Qty",
      description: "Sum of quantity from garden.harvest.logged.",
      eventType: "garden.harvest.logged",
      measure: "sum:data.quantity",
      createdAt: now,
      updatedAt: now
    },

    // INVENTORY --------------------------------------------------------------
    {
      id: "kpi:inventory:updates.count",
      domain: "inventory",
      label: "Inventory Updates",
      description: "Count inventory.updated events.",
      eventType: "inventory.updated",
      measure: "count",
      createdAt: now,
      updatedAt: now
    },
    {
      id: "kpi:inventory:shortages.count",
      domain: "inventory",
      label: "Shortages Detected",
      description: "Count inventory.shortage.detected events.",
      eventType: "inventory.shortage.detected",
      measure: "count",
      createdAt: now,
      updatedAt: now
    },

    // PRESERVATION -----------------------------------------------------------
    {
      id: "kpi:preservation:completed.count",
      domain: "preservation",
      label: "Preservation Sessions",
      description: "Count preservation.completed events.",
      eventType: "preservation.completed",
      measure: "count",
      createdAt: now,
      updatedAt: now
    },

    // ANIMALS ----------------------------------------------------------------
    {
      id: "kpi:animals:butchery.count",
      domain: "animals",
      label: "Butchery Sessions",
      description: "Count animal.butchery.logged events.",
      eventType: "animal.butchery.logged",
      measure: "count",
      createdAt: now,
      updatedAt: now
    },
    {
      id: "kpi:animals:acquired.count",
      domain: "animals",
      label: "Animals Acquired",
      description: "Count animal.acquisition events.",
      eventType: "animal.acquisition",
      measure: "count",
      createdAt: now,
      updatedAt: now
    }
  ];

  for (const row of rows) {
    try {
      const exists = await table.get(row.id);
      if (!exists) {
        await table.put(row);
      }
    } catch (_err) {
      // non-fatal
    }
  }
}

async function seedAnalyticsTimeBuckets(db) {
  const table = db.table("analytics_timebuckets");
  const now = new Date();

  // Helper to get ISO
  const iso = (d) => d.toISOString();

  // Basic ranges — the runtime can recalc/extend daily
  const todayId = "bucket:today";
  const thisWeekId = "bucket:thisWeek";
  const thisMonthId = "bucket:thisMonth";
  const thisSeasonId = "bucket:thisSeason";

  // TODAY
  {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);

    await upsertBucket(table, {
      id: todayId,
      range: "today",
      startISO: iso(start),
      endISO: iso(end),
      label: "Today",
      createdAt: iso(now)
    });
  }

  // THIS WEEK (assuming Sunday start — adjust to your locale if needed)
  {
    const start = new Date(now);
    const day = start.getDay(); // 0=Sun
    start.setDate(start.getDate() - day);
    start.setHours(0, 0, 0, 0);

    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    end.setHours(23, 59, 59, 999);

    await upsertBucket(table, {
      id: thisWeekId,
      range: "thisWeek",
      startISO: iso(start),
      endISO: iso(end),
      label: "This Week",
      createdAt: iso(now)
    });
  }

  // THIS MONTH
  {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0); // last day
    end.setHours(23, 59, 59, 999);

    await upsertBucket(table, {
      id: thisMonthId,
      range: "thisMonth",
      startISO: iso(start),
      endISO: iso(end),
      label: "This Month",
      createdAt: iso(now)
    });
  }

  // THIS SEASON (very rough — SSA has your more exact Hebrew calendar logic elsewhere)
  {
    const seasonLabel = guessSeasonFromMonth(now.getMonth() + 1); // month is 0-based
    await upsertBucket(table, {
      id: thisSeasonId,
      range: "thisSeason",
      startISO: iso(now), // runtime can refine
      endISO: iso(now),
      label: seasonLabel,
      createdAt: iso(now)
    });
  }
}

async function upsertBucket(table, bucket) {
  try {
    const exists = await table.get(bucket.id);
    if (!exists) {
      await table.put(bucket);
    } else {
      // keep the old date ranges, but update label if needed
      await table.put({
        ...exists,
        label: bucket.label
      });
    }
  } catch (_err) {
    // non-fatal
  }
}

function guessSeasonFromMonth(m) {
  // Simple N. Hemisphere logic; your actual app can replace
  if (m === 12 || m <= 2) return "Winter";
  if (m >= 3 && m <= 5) return "Spring";
  if (m >= 6 && m <= 8) return "Summer";
  return "Fall";
}

async function seedDomainRollups(db) {
  const table = db.table("analytics_rollups");
  const now = new Date().toISOString();

  // For each domain, create a rollup per bucket
  const domains = ["meals", "cleaning", "garden", "inventory", "preservation", "animals"];
  const buckets = ["bucket:today", "bucket:thisWeek", "bucket:thisMonth", "bucket:thisSeason"];

  for (const domain of domains) {
    for (const bucketId of buckets) {
      const id = `rollup:${domain}:${bucketId}`;
      try {
        const exists = await table.get(id);
        if (!exists) {
          await table.put({
            id,
            domain,
            bucketId,
            counts: {
              total: 0
            },
            lastEventAt: null,
            createdAt: now,
            updatedAt: now
          });
        }
      } catch (_err) {
        // non-fatal
      }
    }
  }

  // Emit an intelligence-like event so analytics UI can refresh
  emitEvent("context.intelligence.created", {
    intelId: "analytics.seed." + MIGRATION_ID,
    sourceImportId: null,
    intelType: "analytics-baseline",
    intel: {
      domains: domains.length,
      bucketsPerDomain: buckets.length
    }
  });
}

// -----------------------------------------------------------------------------
// HUB EXPORT
// -----------------------------------------------------------------------------

async function exportToHubIfEnabled(ssaEventEnvelope) {
  try {
    const cfg = getConfig() || {};
    const familyFundMode =
      !!(cfg.featureFlags && (cfg.featureFlags.familyFundMode === true));

    if (!familyFundMode) return;

    const packet =
      HubPacketFormatter?.formatForHub?.(ssaEventEnvelope) ||
      HubPacketFormatter?.wrap?.("analytics", ssaEventEnvelope) ||
      ssaEventEnvelope;

    if (FamilyFundConnector?.sendToHub) {
      await FamilyFundConnector.sendToHub(packet);

      emitEvent("hub.export.succeeded", {
        exportId: packet?.data?.migrationId || randomId(),
        responseMeta: { mode: "household-analytics" }
      });
    }
  } catch (_err) {
    emitEvent("hub.export.failed", {
      exportId: ssaEventEnvelope?.data?.migrationId || randomId(),
      reason: "hub-unavailable",
      attempts: 1
    });
  }
}

// -----------------------------------------------------------------------------
// UTIL
// -----------------------------------------------------------------------------

function randomId() {
  return "ha_" + Math.random().toString(36).slice(2, 10);
}
