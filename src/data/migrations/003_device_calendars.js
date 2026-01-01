// C:\Users\larho\suka-smart-assistant\src\data\migrations\003_device_calendars.js
// -----------------------------------------------------------------------------
/**
 * SSA IndexedDB (Dexie) migration — Device Calendars
 *
 * This migration introduces storage for device usage/hold calendars used by the
 * planner during the imports → intelligence → automation loop. The calendar
 * mirrors the structure found in resource.device.schema.json (usageCalendar)
 * and quiet-hours defaults, enabling the scheduler to place sessions
 * respecting busy windows, quiet hours, maintenance, and external holds.
 *
 * Tables:
 *  - deviceCalendars : holds/busy intervals per device (append/update)
 *
 * Event Emission:
 *  - Emits SSA-shaped envelopes on create/update/delete:
 *      { type, ts, source, data }
 *    where type is: db.deviceCalendars.created/updated/deleted
 *  - Emits a single "db.migration.completed" when applied or verified.
 *
 * Idempotency:
 *  - If the table already exists, the migration installs hooks and exits
 *    without bumping Dexie version again.
 */
/* eslint-disable no-console */

// Optional soft import of the shared event bus
let eventBus = null;
try {
  eventBus = require("@/services/eventBus")?.default;
} catch {}

/** Emit SSA-shaped envelopes safely (never crash) */
function safeEmit(type, data) {
  const envelope = {
    type,
    ts: new Date().toISOString(),
    source: "data.migrations/003_device_calendars",
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
    /* no-op */
  }
}

/** Dexie stores version as a float; use the next whole integer */
function nextSchemaVersion(db) {
  const current = Number(db?.verno || 0);
  return Math.max(1, Math.floor(current) + 1);
}

/**
 * Store definitions for this migration.
 *
 * deviceCalendars:
 *  - id         : auto-increment primary key
 *  - uid        : stable ULID/UUID for the interval (optional convenience)
 *  - deviceId   : device the interval belongs to (required)
 *  - title      : short label
 *  - start/end  : ISO timestamps
 *  - source     : session | manual | import | maintenance | external
 *  - sessionId  : optional linkage for session-sourced holds
 *  - rrule      : RRULE string for recurrences (optional)
 *  - hard       : boolean, hard block vs soft preference
 *  - tags       : string[] (multiEntry)
 *  - createdAt/updatedAt : timestamps maintained by hooks
 *
 * Indexes chosen for common planner queries:
 *  - by deviceId
 *  - by deviceId + start (range scans for time slicing)
 *  - by source
 *  - by sessionId (fast release when session completes)
 *  - multiEntry tags
 */
function getStoreDefinitions() {
  return {
    deviceCalendars:
      "++id, uid, deviceId, start, end, source, sessionId, [deviceId+start], [deviceId+end], [source], [sessionId], *tags",
  };
}

/** Idempotent table verification */
async function verifyTables(db) {
  const wanted = Object.keys(getStoreDefinitions());
  const existing = db.tables.map((t) => t.name);
  const missing = wanted.filter((t) => !existing.includes(t));
  return { missing, ok: missing.length === 0 };
}

/**
 * Install per-table hooks to keep timestamps and emit envelopes
 * on create/update/delete. Idempotent by table flag.
 */
function installTableHooks(db) {
  const table = db.table("deviceCalendars");
  if (!table || table.__ssaHooksInstalled) return;

  try {
    table.hook("creating", function (_pk, obj) {
      const now = new Date().toISOString();
      if (!obj.createdAt) obj.createdAt = now;
      if (!obj.updatedAt) obj.updatedAt = now;

      // minimal normalization/defense
      if (!obj.deviceId || typeof obj.deviceId !== "string") {
        throw new Error("deviceCalendars.creating: deviceId is required");
      }
      if (!obj.start || !obj.end) {
        throw new Error("deviceCalendars.creating: start and end are required");
      }
      // Coerce tags to array-of-strings if provided in other forms
      if (obj.tags && !Array.isArray(obj.tags)) {
        obj.tags = [String(obj.tags)];
      }
    });

    table.hook("updating", function (mods /*, pk, obj, tx */) {
      mods.updatedAt = new Date().toISOString();
      // defensive: keep tags as array-of-strings
      if (mods.tags && !Array.isArray(mods.tags)) {
        mods.tags = [String(mods.tags)];
      }
      return mods;
    });

    table.hook("created", function (_pk, obj) {
      safeEmit("db.deviceCalendars.created", { record: obj });
    });
    table.hook("updated", function (_mods, _pk, obj) {
      safeEmit("db.deviceCalendars.updated", { record: obj });
    });
    table.hook("deleting", function (_pk, obj) {
      // emit prior state for observers/analytics
      safeEmit("db.deviceCalendars.deleted", { record: obj });
    });

    table.__ssaHooksInstalled = true;
  } catch {
    /* never block app */
  }
}

/**
 * Optional seed: create a lightweight example hold so dev builds
 * can visualize calendar usage immediately. Safe in PROD (tagged 'seed').
 */
async function seedExample(db) {
  try {
    if (!import.meta?.env?.DEV) return;
  } catch {
    // If not in a module context (CJS), ignore and allow seed once.
  }

  const t = db.table("deviceCalendars");
  if (!t) return;

  const sample = await t.where("[deviceId+start]").between(
    ["kitchen-display", "2025-11-08T00:00:00.000Z"],
    ["kitchen-display", "2025-11-09T23:59:59.999Z"]
  ).first();

  if (!sample) {
    try {
      await t.add({
        uid: "dev-seed-kitchen-display-block",
        deviceId: "kitchen-display",
        title: "Family Movie",
        start: "2025-11-09T01:00:00.000Z",
        end: "2025-11-09T03:00:00.000Z",
        source: "manual",
        hard: false,
        tags: ["quiet", "media", "seed"],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    } catch {
      /* ignore seed failure */
    }
  }
}

/**
 * Primary exported migration application.
 * @param {Dexie} db - live Dexie instance
 * @returns {Promise<{applied:boolean, version:number}>}
 */
async function applyMigration(db) {
  if (!db || typeof db.version !== "function") {
    throw new Error("Dexie instance required to run migration 003.");
  }

  // If already present, just verify+hooks+emit and exit.
  const pre = await verifyTables(db);
  if (pre.ok) {
    installTableHooks(db);
    safeEmit("db.migration.completed", {
      id: "003_device_calendars",
      status: "verified",
      version: Math.floor(db.verno || 0),
    });
    return { applied: false, version: Math.floor(db.verno || 0) };
  }

  const version = nextSchemaVersion(db);
  const stores = getStoreDefinitions();

  db.version(version).stores(stores).upgrade(async (tx) => {
    // Record migration metadata if a meta table exists
    try {
      const meta = tx.table("meta");
      if (meta) {
        await meta.put({
          key: "migration.003",
          value: {
            appliedAt: new Date().toISOString(),
            stores,
          },
        });
      }
    } catch {
      /* meta not guaranteed */
    }
  });

  await db.open().catch((err) => {
    console.error("[SSA] Migration 003 open failed:", err);
    throw err;
  });

  installTableHooks(db);
  await seedExample(db).catch(() => {});

  safeEmit("db.migration.completed", {
    id: "003_device_calendars",
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
