// C:\Users\larho\suka-smart-assistant\src\data\migrations\002_calibration_factors.js
// -----------------------------------------------------------------------------
/**
 * SSA IndexedDB (Dexie) migration — Learning Loop Calibration Data
 *
 * This migration introduces lightweight stores that power the automation
 * learning loop (imports → intelligence → automation → telemetry → learn).
 *
 *  - calibrations          : current, consolidated calibration factors
 *  - calibrationTelemetry  : event-style observations that inform updates
 *
 * These tables let the scheduler/runtime adjust buffer and duration models
 * based on observed deltas (p50/p80 drift, device/person/room effects),
 * network/RTC characteristics, quiet-hours friction, etc.
 *
 * Emission: after schema application/verification, we emit a single
 * { type: "db.migration.completed", ts, source, data } envelope.
 *
 * Idempotent: if the schema exists, we verify+install hooks and do not bump
 * Dexie version again.
 */
/* eslint-disable no-console */

// Optional soft import of the shared event bus
let eventBus = null;
try {
  eventBus = require("@/services/events/eventBus")?.default;
} catch {}

/** Emit SSA-shaped envelopes safely (never crash the app) */
function safeEmit(type, data) {
  const envelope = {
    type,
    ts: new Date().toISOString(),
    source: "data.migrations/002_calibration_factors",
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

/** Dexie keeps verno as a float; we bump to the next whole integer */
function nextSchemaVersion(db) {
  const current = Number(db?.verno || 0);
  return Math.max(1, Math.floor(current) + 1);
}

/**
 * Store definitions for this migration.
 *
 * Schema notes:
 * - calibrations:
 *     key: ULID/UUID (uid) for record; also logically addressable via a composite
 *          scope key (scopeType+scopeId+domain+feature) to allow quick lookups.
 *     indexes: by scope, domain, feature, updatedAt.
 *
 * - calibrationTelemetry:
 *     append-only observations (per session/step/device/person/room).
 *     indexes target the common slicing patterns used by the learner.
 */
function getStoreDefinitions() {
  return {
    calibrations:
      "++id, uid, scopeType, scopeId, domain, feature, updatedAt, [scopeType+scopeId], [domain+feature], [scopeType+scopeId+domain+feature]",

    calibrationTelemetry:
      "++id, uid, ts, sessionId, stepId, domain, deviceId, personId, roomId, feature, tag, [domain+feature], [deviceId+feature], [personId+feature], [roomId+feature], [sessionId+stepId]",
  };
}

/**
 * Install per-table hooks to keep timestamps healthy and emit envelopes on
 * create/update/delete. Hooks are idempotent.
 */
function installTableHooks(db) {
  const install = (table, typePrefix) => {
    if (!table || table.__ssaHooksInstalled) return;
    try {
      table.hook("creating", function (_pk, obj) {
        const now = new Date().toISOString();
        if (!obj.createdAt) obj.createdAt = now;
        if (!obj.updatedAt) obj.updatedAt = now;
      });
      table.hook("updating", function (mods /*, pk, obj, tx */) {
        mods.updatedAt = new Date().toISOString();
        return mods;
      });
      table.hook("created", function (_pk, obj) {
        safeEmit(`${typePrefix}.created`, { record: obj });
      });
      table.hook("updated", function (_mods, _pk, obj) {
        safeEmit(`${typePrefix}.updated`, { record: obj });
      });
      table.hook("deleting", function (_pk, obj) {
        safeEmit(`${typePrefix}.deleted`, { record: obj });
      });
      table.__ssaHooksInstalled = true;
    } catch {
      /* no-op */
    }
  };

  install(db.table("calibrations"), "db.calibrations");
  install(db.table("calibrationTelemetry"), "db.calibrationTelemetry");
}

/** Light existence check for idempotency */
async function verifyTables(db) {
  const wanted = Object.keys(getStoreDefinitions());
  const existing = db.tables.map((t) => t.name);
  const missing = wanted.filter((t) => !existing.includes(t));
  return { missing, ok: missing.length === 0 };
}

/**
 * Seed a few baseline calibration records so the learner has anchors.
 * Safe to run even if duplicates exist (we guard by composite scope).
 */
async function seedBaselines(db) {
  const table = db.table("calibrations");
  if (!table) return;

  const baseline = [
    // Household/global baseline for duration multiplier
    {
      uid: "calib_global_duration",
      scopeType: "household",
      scopeId: "global",
      domain: "any",
      feature: "duration.multiplier",
      value: 1.0,
      confidence: 0.6,
      notes: "Baseline multiplier before domain/device corrections.",
    },
    // RTC/network baseline
    {
      uid: "calib_rtc_penalty",
      scopeType: "network",
      scopeId: "default",
      domain: "any",
      feature: "rtc.penalty",
      value: 0.0,
      confidence: 0.5,
      notes: "Penalty (ms per minute) added when RTC is degraded.",
    },
    // Quiet-hours friction (soft cost)
    {
      uid: "calib_quiet_hours_friction",
      scopeType: "policy",
      scopeId: "quiet-hours",
      domain: "any",
      feature: "quiet.friction",
      value: 0.05,
      confidence: 0.5,
      notes:
        "Adds 5% duration in quiet hours by default (UI is dim, haptics off).",
    },
  ];

  for (const rec of baseline) {
    // Upsert by composite scope
    const existing = await table
      .where("[scopeType+scopeId+domain+feature]")
      .equals([rec.scopeType, rec.scopeId, rec.domain, rec.feature])
      .first();
    if (!existing) {
      try {
        await table.add({
          ...rec,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tags: ["seed"],
        });
      } catch {
        /* ignore seed write failure */
      }
    }
  }
}

/**
 * Primary exported migration function.
 * @param {Dexie} db - live Dexie instance
 * @returns {Promise<{applied:boolean, version:number}>}
 */
async function applyMigration(db) {
  if (!db || typeof db.version !== "function") {
    throw new Error("Dexie instance required to run migration 002.");
  }

  // If already present, just verify+hooks+emit and exit.
  const pre = await verifyTables(db);
  if (pre.ok) {
    installTableHooks(db);
    safeEmit("db.migration.completed", {
      id: "002_calibration_factors",
      status: "verified",
      version: Math.floor(db.verno || 0),
    });
    return { applied: false, version: Math.floor(db.verno || 0) };
  }

  const version = nextSchemaVersion(db);
  const stores = getStoreDefinitions();

  db.version(version)
    .stores(stores)
    .upgrade(async (tx) => {
      // Record migration metadata if a meta table exists
      try {
        const meta = tx.table("meta");
        if (meta) {
          await meta.put({
            key: "migration.002",
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
    console.error("[SSA] Migration 002 open failed:", err);
    throw err;
  });

  installTableHooks(db);
  await seedBaselines(db).catch(() => {});

  safeEmit("db.migration.completed", {
    id: "002_calibration_factors",
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
