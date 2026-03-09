// C:\Users\larho\suka-smart-assistant\src\db\migrations\vXX-add-plays.js
/**
 * db/migrations/vXX-add-plays.js — Add {plays, playHistory} tables; bump version safely
 *
 * Where this fits in SSA (imports → intelligence → automation → (optional) hub export):
 * - This migration prepares IndexedDB (via Dexie) for the automation/execution layer by
 *   adding:
 *     • plays         → live or recent sessions (cursor, timers, status)
 *     • playHistory   → immutable execution logs (for analytics & suggestions)
 * - It emits dev telemetry on the shared eventBus using the canonical payload shape
 *   { type, ts, source, data } to make DB lifecycle observable.
 * - It does not mutate inventory/storehouse directly. However, since it introduces new
 *   household-owned data stores, we optionally export a tiny “db.migration” summary to
 *   the Hub when familyFundMode is enabled (fails silently).
 *
 * Usage:
 *   import registerAddPlaysMigration from "@/db/migrations/vXX-add-plays";
 *   const db = new Dexie("SukaSmartAssistantDB");
 *   // ...existing db.version(x).stores({...});
 *   const nextVersion = registerAddPlaysMigration(db); // bumps from current verno to verno+1
 *   await db.open();
 *
 * Notes:
 * - Dexie requires explicit numeric versions at registration time. We derive the next
 *   integer from `db.verno` to “bump safely”, so you can compose this with other
 *   migration modules without manual renumbering.
 * - Includes a best-effort legacy migration from a hypothetical old 'runs' table, if present.
 */

let eventBus = {
  emit: (...a) => console.debug("[db:migration:add-plays:eventBus.emit]", ...a),
  on: () => () => {},
};
try {
  const eb = require("@/services/events/eventBus");
  eventBus = eb?.default || eb?.eventBus || eventBus;
} catch {}

let featureFlags = { familyFundMode: false };
try {
  featureFlags = require("@/config/featureFlags");
} catch {}

let HubPacketFormatter = null;
let FamilyFundConnector = null;
try {
  HubPacketFormatter = require("@/services/hub/HubPacketFormatter");
  FamilyFundConnector = require("@/services/hub/FamilyFundConnector");
} catch {}

const nowISO = () => new Date().toISOString();
const SOURCE = "db.migrations.vXX-add-plays";

function emit(type, data) {
  try {
    eventBus.emit({ type, ts: nowISO(), source: SOURCE, data });
  } catch {}
}

async function exportToHubIfEnabled(summary) {
  try {
    if (!featureFlags?.familyFundMode) return;
    if (!HubPacketFormatter || !FamilyFundConnector) return;
    const packet =
      (HubPacketFormatter.formatDbMigration &&
        HubPacketFormatter.formatDbMigration(summary)) ||
      (HubPacketFormatter.format &&
        HubPacketFormatter.format({ kind: "db.migration", ...summary })) ||
      null;
    if (!packet) return;
    await (FamilyFundConnector.send?.(packet) ||
      FamilyFundConnector.post?.(packet));
  } catch {
    // fail silently by design
  }
}

/**
 * Register the migration onto the provided Dexie instance.
 * Returns the new version number (integer).
 *
 * @param {import('dexie').Dexie} db
 * @param {{ legacyRunsTableName?: string }} [opts]
 * @returns {number} nextVersion
 */
function registerAddPlaysMigration(db, opts = {}) {
  if (!db || typeof db.version !== "function") {
    throw new Error("registerAddPlaysMigration: expected a Dexie instance.");
  }

  // Dexie verno can be a float (e.g., 1). Convert to next integer safely.
  const current = Math.floor(Number(db.verno || 0));
  const nextVersion = current + 1;

  const legacyRunsTableName = String(opts.legacyRunsTableName || "runs");

  db.version(nextVersion)
    .stores({
      // New tables:
      plays: "id, sessionId, domain, status, updatedAt", // status: active|paused|stopped|completed
      playHistory: "id, sessionId, domain, startedAt, endedAt, outcome", // outcome: completed|canceled|error
      // Note: do not touch existing stores here; only additive schema for safety.
    })
    .upgrade(async (tx) => {
      const startedAt = nowISO();
      let migratedCount = 0;
      let legacyCount = 0;

      // Best-effort legacy migration: copy from old 'runs' table if it exists.
      // Not all Dexie versions expose tx.tables; access may throw if table doesn't exist.
      let legacyTable = null;
      try {
        legacyTable = tx.table(legacyRunsTableName);
        // A probe read will throw if the table is undefined or not in this DB version.
        await legacyTable.limit(1).toArray();
      } catch {
        legacyTable = null;
      }

      if (legacyTable) {
        try {
          const all = await legacyTable.toArray();
          legacyCount = all.length;
          const playHistory = tx.table("playHistory");

          for (const r of all) {
            // Map legacy fields conservatively; unknowns are left undefined.
            const rec = {
              id:
                r.id ||
                `hist_${Date.now().toString(36)}_${Math.random()
                  .toString(36)
                  .slice(2)}`,
              sessionId: String(r.sessionId || r.runId || r.sid || "unknown"),
              domain: String(r.domain || "cooking").toLowerCase(),
              startedAt: r.startedAt || r.startAt || r.createdAt || startedAt,
              endedAt: r.endedAt || r.endAt || r.updatedAt || startedAt,
              durationMs: Number.isFinite(r.durationMs)
                ? Math.max(0, r.durationMs)
                : Math.max(
                    0,
                    new Date(r.endedAt || startedAt) -
                      new Date(r.startedAt || startedAt)
                  ),
              outcome: String(
                r.outcome || r.status || "completed"
              ).toLowerCase(),
              stepsCompleted: Number.isInteger(r.stepsCompleted)
                ? r.stepsCompleted
                : undefined,
              notes: r.notes || undefined,
              meta: r.meta || {},
              createdAt: nowISO(),
            };
            await playHistory.add(rec);
            migratedCount++;
          }
        } catch (err) {
          emit("db.migration.legacy.copy.error", {
            message: err?.message || String(err),
          });
        }
      }

      const finishedAt = nowISO();
      const summary = {
        version: nextVersion,
        startedAt,
        finishedAt,
        legacyTable: legacyTable ? legacyRunsTableName : null,
        legacyCount,
        migratedCount,
        tablesCreated: ["plays", "playHistory"],
      };

      emit("db.migration.applied", summary);
      exportToHubIfEnabled({ name: "add-plays", ...summary });
    });

  emit("db.migration.registered", {
    fromVersion: Math.floor(Number(db.verno || 0)),
    toVersion: nextVersion,
    tables: ["plays", "playHistory"],
  });

  return nextVersion;
}

module.exports = registerAddPlaysMigration;
