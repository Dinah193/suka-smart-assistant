// C:\Users\larho\suka-smart-assistant\src\db\migrations\vXX-favorites-schedules.js
/**
 * db/migrations/vXX-favorites-schedules.js
 * — Ensure domain-scoped stores for favorites.*Drafts and scheduleTemplates.*
 *
 * Where this fits (imports → intelligence → automation → (optional) hub export):
 * - The automation layer benefits from fast per-domain lookups for "starred drafts"
 *   and "recurring schedule templates". This migration introduces domain-scoped
 *   object stores to avoid scanning cross-domain tables on every suggestion run.
 *
 * What this adds (new object stores):
 *   favorites.cookingDrafts
 *   favorites.cleaningDrafts
 *   favorites.gardenDrafts
 *   favorites.animalsDrafts
 *   scheduleTemplates.cooking
 *   scheduleTemplates.cleaning
 *   scheduleTemplates.garden
 *   scheduleTemplates.animals
 *
 * Notes:
 * - Dexie/IndexedDB allow dots in objectStore names; we keep the names exactly as requested.
 * - Basic indexes are provided for common query patterns.
 * - A best-effort seeding step copies matching records from the generic
 *   favorites / scheduleTemplates tables if they already exist.
 * - Emits eventBus telemetry with standardized envelopes { type, ts, source, data }.
 * - Sends a tiny summary to the Hub when familyFundMode=true (fails silently).
 *
 * Usage:
 *   import registerFavoritesSchedulesMigration from "@/db/migrations/vXX-favorites-schedules";
 *   const nextVersion = registerFavoritesSchedulesMigration(db);
 */

let eventBus = {
  emit: (...a) => console.debug("[db:migration:fav-sched:eventBus.emit]", ...a),
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
const SOURCE = "db.migrations.vXX-favorites-schedules";

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

const FAV_STORES = [
  "favorites.cookingDrafts",
  "favorites.cleaningDrafts",
  "favorites.gardenDrafts",
  "favorites.animalsDrafts",
];

const SCHED_STORES = [
  "scheduleTemplates.cooking",
  "scheduleTemplates.cleaning",
  "scheduleTemplates.garden",
  "scheduleTemplates.animals",
];

/**
 * Build the Dexie .stores() definition string for all new stores.
 * We create simple, pragmatic indexes for common queries:
 *  - favorites.*Drafts: id (pk), targetId, title, createdAt
 *  - scheduleTemplates.*: id (pk), enabled, nextRunAt, title
 */
function buildStoresDefinition() {
  const defs = {};
  for (const name of FAV_STORES) {
    // Primary key 'id'; indexes for targetId (exact), title (basic), createdAt (range)
    defs[name] = "id, targetId, title, createdAt";
  }
  for (const name of SCHED_STORES) {
    // Primary key 'id'; indexes for enabled, nextRunAt (range), title
    defs[name] = "id, enabled, nextRunAt, title";
  }
  return defs;
}

/**
 * Safely probe for an existing table inside an upgrade transaction.
 */
async function safeProbe(tx, name) {
  try {
    const t = tx.table(name);
    await t.limit(1).toArray();
    return t;
  } catch {
    return null;
  }
}

/**
 * Best-effort seeding from generic tables if present.
 * - favorites → favorites.*Drafts when record.kind ends with 'draft' and domain matches
 * - scheduleTemplates → scheduleTemplates.{domain}
 */
async function seedFromGeneric(tx) {
  const startedAt = nowISO();
  const summary = {
    seededFavorites: 0,
    seededSchedules: 0,
    startedAt,
    finishedAt: null,
  };

  // Seed favorites
  const fav = await safeProbe(tx, "favorites");
  if (fav) {
    const all = await fav.toArray().catch(() => []);
    for (const r of all) {
      const domain = String(r.domain || "").toLowerCase();
      const isDraft = String(r.kind || "")
        .toLowerCase()
        .includes("draft");
      if (!isDraft) continue;
      const storeName =
        domain === "cooking"
          ? "favorites.cookingDrafts"
          : domain === "cleaning"
          ? "favorites.cleaningDrafts"
          : domain === "garden"
          ? "favorites.gardenDrafts"
          : domain === "animals"
          ? "favorites.animalsDrafts"
          : null;
      if (!storeName) continue;
      try {
        await tx.table(storeName).put({
          id:
            r.id ||
            `fav_${Date.now().toString(36)}_${Math.random()
              .toString(36)
              .slice(2)}`,
          targetId: String(r.targetId || ""),
          title: r.title || undefined,
          tags: r.tags || undefined,
          createdAt: r.createdAt || nowISO(),
          // keep a tiny backlink for future migrations
          _source: "favorites",
        });
        summary.seededFavorites++;
      } catch {
        // keep going
      }
    }
  }

  // Seed schedule templates
  const sched = await safeProbe(tx, "scheduleTemplates");
  if (sched) {
    const all = await sched.toArray().catch(() => []);
    for (const r of all) {
      const domain = String(r.domain || "").toLowerCase();
      const storeName =
        domain === "cooking"
          ? "scheduleTemplates.cooking"
          : domain === "cleaning"
          ? "scheduleTemplates.cleaning"
          : domain === "garden"
          ? "scheduleTemplates.garden"
          : domain === "animals"
          ? "scheduleTemplates.animals"
          : null;
      if (!storeName) continue;
      try {
        await tx.table(storeName).put({
          id:
            r.id ||
            `tpl_${Date.now().toString(36)}_${Math.random()
              .toString(36)
              .slice(2)}`,
          title: r.title || "",
          rrule: r.rrule || "",
          tzid: r.tzid || undefined,
          startTime: r.startTime || undefined,
          durationMs: r.durationMs || undefined,
          alarmMinutesBefore: r.alarmMinutesBefore || undefined,
          enabled: r.enabled !== false,
          nextRunAt: r.nextRunAt || undefined,
          lastRunAt: r.lastRunAt || undefined,
          meta: r.meta || {},
          createdAt: r.createdAt || nowISO(),
          updatedAt: r.updatedAt || nowISO(),
          _source: "scheduleTemplates",
        });
        summary.seededSchedules++;
      } catch {
        // keep going
      }
    }
  }

  summary.finishedAt = nowISO();
  return summary;
}

/**
 * Register the migration onto the provided Dexie instance and return the new version.
 *
 * @param {import('dexie').Dexie} db
 * @returns {number} nextVersion
 */
function registerFavoritesSchedulesMigration(db) {
  if (!db || typeof db.version !== "function") {
    throw new Error(
      "registerFavoritesSchedulesMigration: expected a Dexie instance."
    );
  }

  // Dexie verno may be float; bump to the next integer for safety.
  const current = Math.floor(Number(db.verno || 0));
  const nextVersion = current + 1;

  const stores = buildStoresDefinition();

  db.version(nextVersion)
    .stores(stores)
    .upgrade(async (tx) => {
      const startedAt = nowISO();

      // Ensure all new stores exist and are accessible
      const created = [];
      for (const name of [...FAV_STORES, ...SCHED_STORES]) {
        try {
          // Touch the table to ensure creation; a list operation will throw if absent
          await tx.table(name).limit(0).toArray();
          created.push(name);
        } catch (err) {
          emit("db.migration.table.error", {
            name,
            message: err?.message || String(err),
          });
        }
      }

      // Seed from generic tables if present
      const seeding = await seedFromGeneric(tx).catch((err) => {
        emit("db.migration.seed.error", {
          message: err?.message || String(err),
        });
        return {
          seededFavorites: 0,
          seededSchedules: 0,
          startedAt: nowISO(),
          finishedAt: nowISO(),
        };
      });

      const finishedAt = nowISO();
      const summary = {
        version: nextVersion,
        startedAt,
        finishedAt,
        createdCount: created.length,
        created,
        seededFavorites: seeding.seededFavorites,
        seededSchedules: seeding.seededSchedules,
      };

      emit("db.migration.applied", summary);
      exportToHubIfEnabled({ name: "favorites-schedules", ...summary });
    });

  emit("db.migration.registered", {
    toVersion: nextVersion,
    stores: [...FAV_STORES, ...SCHED_STORES],
  });

  return nextVersion;
}

module.exports = registerFavoritesSchedulesMigration;
