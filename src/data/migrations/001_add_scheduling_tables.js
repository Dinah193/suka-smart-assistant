// C:\Users\larho\suka-smart-assistant\src\data\migrations\001_add_scheduling_tables.js
// -----------------------------------------------------------------------------
/**
 * SSA IndexedDB (Dexie) migration — scheduling tables
 *
 * This migration introduces the core scheduling stores used by the
 * imports → intelligence → automation → (optional) hub export pipeline:
 *
 *  - sessions   : high-level jobs (cooking, cleaning, garden, animals, preservation)
 *  - steps      : executable atoms that belong to a session
 *  - resources  : devices/people/rooms used by the planner and runtime
 *
 * Shape aligns with the JSON Schemas in src/data/schemas:
 *   - session.schema.json
 *   - step.schema.json
 *   - resource.device/person/room.schema.json  (collapsed into a single table via resourceType)
 *
 * All writes emit SSA-shaped events on the shared event bus so analytics and
 * the automation runtime can react. The migration itself emits a single
 * `db.migration.completed` event when the schema is installed/verified.
 *
 * Notes:
 *  - Safe to import multiple times: it detects existing version and skips if
 *    the declared schema is already present (idempotent).
 *  - Designed for Dexie v3+. The caller should pass the live Dexie instance.
 */
/* eslint-disable no-console */

// Optional soft imports (kept safe if missing)
let eventBus = null;
try {
  // assumed path per SSA
  eventBus = require("@/services/eventBus").default;
} catch {}

function safeEmit(type, data) {
  const envelope = {
    type,
    ts: new Date().toISOString(),
    source: "data.migrations/001_add_scheduling_tables",
    data,
  };
  try {
    eventBus?.emit?.(type, envelope);
    if (typeof window !== "undefined") {
      window.dispatchEvent?.(new CustomEvent(type, { detail: envelope }));
      const bus = window.__suka?.eventBus;
      bus?.emit?.(type, envelope);
    }
  } catch {
    /* never crash migration */
  }
}

/**
 * Compute next integer Dexie version from current db.verno.
 * Dexie stores verno as a float; we bump to the next whole integer.
 */
function nextSchemaVersion(db) {
  const current = Number(db?.verno || 0);
  const next = Math.max(1, Math.floor(current) + 1);
  return next;
}

/**
 * Returns the string definitions used by Dexie.stores().
 * Keep this as a function so other migrations can re-use/compose.
 *
 * Indexing notes:
 *  - '++id' auto-increment numeric primary keys for internal speed.
 *    We also store 'uid' as a stable string id (ULID/UUID) to mirror JSON schema.
 *  - Compound and multiEntry indexes support common queries from the scheduler:
 *      sessions: by status, domain, plannedStartTs, deadlineTs, priority
 *      steps   : by sessionId, status; multiEntry on deps and tags
 *      resources: by resourceType and room, tags (multiEntry)
 */
function getStoreDefinitions() {
  return {
    // High-level jobs (session contract)
    // Indexes: status, domain, plannedStartTs, deadlineTs, priority (desc-ish via negative if stored), riskBadge
    sessions:
      "++id, uid, status, domain, plannedStartTs, plannedEndTs, deadlineTs, priority, riskBadge, [domain+status], [plannedStartTs+status]",

    // Execution atoms belonging to a session
    // Indexes: sessionId, status, canParallelize, parallelKey, multiEntry on deps and tags
    steps:
      "++id, uid, sessionId, status, canParallelize, parallelKey, [sessionId+status], *deps, *tags",

    // Collapsed resource table (devices, people, rooms)
    // Indexes: resourceType, room, name.display (if present), *roles, *tags
    resources:
      "++id, uid, resourceType, room, name, [resourceType+room], *roles, *tags",
  };
}

/**
 * Create stabilizer hooks so any runtime writes (outside migrations) will emit
 * SSA events. This ensures that after boot, the rest of the app benefits from
 * consistent envelope emissions without each caller remembering to do so.
 *
 * These hooks are installed only once.
 */
function installTableHooks(db) {
  const install = (table, typePrefix) => {
    if (!table || table.__ssaHooksInstalled) return;
    try {
      table.hook("creating", function (_primKey, obj) {
        // default timestamps if missing
        const now = new Date().toISOString();
        if (!obj.createdAt) obj.createdAt = now;
        if (!obj.updatedAt) obj.updatedAt = now;
      });
      table.hook("updating", function (mods /*, primKey, obj, tx */) {
        mods.updatedAt = new Date().toISOString();
        return mods;
      });
      table.hook("created", function (_primKey, obj) {
        safeEmit(`${typePrefix}.created`, { record: obj });
      });
      table.hook("updated", function (_mods, _primKey, obj) {
        safeEmit(`${typePrefix}.updated`, { record: obj });
      });
      table.hook("deleting", function (_primKey, obj) {
        // 'deleting' fires before delete; emit and include prior object.
        safeEmit(`${typePrefix}.deleted`, { record: obj });
      });
      table.__ssaHooksInstalled = true;
    } catch {
      /* ignore hook problems — never block app */
    }
  };

  install(db.table("sessions"), "db.sessions");
  install(db.table("steps"), "db.steps");
  install(db.table("resources"), "db.resources");
}

/**
 * Verifies tables exist with at least the declared indexes.
 * Dexie does not expose index comparison easily; this is a light check to keep idempotency.
 */
async function verifyTables(db) {
  const wanted = Object.keys(getStoreDefinitions());
  const existing = db.tables.map((t) => t.name);
  const missing = wanted.filter((t) => !existing.includes(t));
  return { missing, ok: missing.length === 0 };
}

/**
 * Primary exported migration function.
 * @param {Dexie} db - live Dexie instance (already constructed)
 * @returns {Promise<{applied:boolean, version:number}>}
 */
async function applyMigration(db) {
  if (!db || typeof db.version !== "function") {
    throw new Error("Dexie instance required to run migration 001.");
  }

  // If tables already exist, consider this migration verified.
  const pre = await verifyTables(db);
  if (pre.ok) {
    installTableHooks(db);
    safeEmit("db.migration.completed", {
      id: "001_add_scheduling_tables",
      status: "verified",
      version: Math.floor(db.verno || 0),
    });
    return { applied: false, version: Math.floor(db.verno || 0) };
  }

  const version = nextSchemaVersion(db);
  const stores = getStoreDefinitions();

  db.version(version).stores(stores).upgrade(async (tx) => {
    // Seed minimal metadata or migrate existing shapes if needed.
    // (No-op right now; reserved for future backfills.)
    try {
      const meta = tx.table("meta");
      if (meta) {
        await meta.put({
          key: "migration.001",
          value: {
            appliedAt: new Date().toISOString(),
            stores,
          },
        });
      }
    } catch {
      /* meta table may not exist — ignore */
    }
  });

  // Open / re-open to apply schema
  await db.open().catch((err) => {
    console.error("[SSA] Migration open failed:", err);
    throw err;
  });

  installTableHooks(db);

  // Emit a single envelope for analytics/telemetry
  safeEmit("db.migration.completed", {
    id: "001_add_scheduling_tables",
    status: "applied",
    version,
    stores,
  });

  return { applied: true, version };
}

module.exports = {
  applyMigration,
  getStoreDefinitions,
  installTableHooks,
};
