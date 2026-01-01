// C:\Users\larho\suka-smart-assistant\src\migrations\vXX-favorites-schedules.js
//
// vXX – Add "favorites" and "schedules" stores
// --------------------------------------------
// Purpose:
//   Introduce dedicated Dexie stores for:
//     • favorites  – reusable, user-facing "starred" items
//     • schedules  – reusable schedule definitions for automation
//
//   This creates a clean separation between:
//     - raw imports
//     - intelligence (plays/templates, favorites)
//     - automation (sessions + schedules)
//
//   It also optionally backfills favorites/schedules from existing sessions
//   when possible (best-effort, safe to skip if shapes don't match).
//
// How this fits into the SSA pipeline
// -----------------------------------
// imports → intelligence → automation → (optional) hub export
//
// • imports:
//   Other files (ImportRouter, scan/compare/trust, scrapers) create imported
//   items. The user can later mark those as "favorite" via UI, which will
//   write to the new favorites store (not handled here).
//
// • intelligence:
//   Favorites are a *semantic* layer: “This plan, session template, import,
//   or query is important to the household.” They feed dashboards and
//   "Next best action" suggestions.
//   Schedules represent recurring patterns (RRULE, “every Friday before
//   sundown”, etc.) that automation can use to instantiate sessions.
//
// • automation:
//   The automation runtime can:
//     - Read schedules and generate upcoming sessions.
//     - Use favorites as weights when ranking suggestions.
//   This migration optionally links older sessions to favorites/schedules
//   by creating meta-records and attaching favoriteId / scheduleId fields.
//
// • optional hub export:
//   Because this migration touches **generated sessions metadata** (favorites,
//   schedules) but not core stock quantities, we still emit a high-level
//   summary to the Hub via exportToHubIfEnabled so the Family Fund can reason
//   about “what the household tends to favorite/schedule” over time.
//
// Usage
// -----
// In your central Dexie setup (e.g. src/db/index.js or src/db/migrations.js):
//
//   import { registerVXXFavoritesSchedules } from "../migrations/vXX-favorites-schedules";
//
//   const db = new Dexie("SukaSmartAssistant");
//   // ... previous version registrations ...
//   registerVXXFavoritesSchedules(db);
//
// IMPORTANT: Replace VERSION below with the next numeric version in your Dexie
// version chain (e.g. 100). Keep this file name aligned with that version.

import eventBus from "../services/events/eventBus";
import featureFlags from "../config/featureFlags";
import HubPacketFormatter from "../services/hub/HubPacketFormatter";
import FamilyFundConnector from "../services/hub/FamilyFundConnector";

/** @type {number} */
const VERSION = 100; // <-- Replace with your next Dexie version number.

/**
 * Emit a structured migration event on the shared eventBus.
 *
 * @param {"db.migration.started"|"db.migration.completed"|"db.migration.error"|"db.migration.exported"} type
 * @param {any} data
 */
function emitMigrationEvent(type, data) {
  if (!eventBus || typeof eventBus.emit !== "function") return;

  eventBus.emit({
    type,
    ts: new Date().toISOString(),
    source: "migrations.vXX-favorites-schedules",
    data,
  });
}

/**
 * Export a high-level summary to the Hub if familyFundMode is enabled.
 * This is *meta* information about the migration, not full household state.
 *
 * @param {any} payload
 */
async function exportToHubIfEnabled(payload) {
  try {
    if (!featureFlags || !featureFlags.familyFundMode) return;
    if (!HubPacketFormatter || !FamilyFundConnector) return;

    const formatter =
      typeof HubPacketFormatter.formatMigrationSummary === "function"
        ? HubPacketFormatter.formatMigrationSummary
        : HubPacketFormatter.format;

    const packet = formatter
      ? formatter("migration.favoritesSchedules", payload)
      : payload;

    const sender =
      typeof FamilyFundConnector.send === "function"
        ? FamilyFundConnector.send
        : typeof FamilyFundConnector.dispatch === "function"
        ? FamilyFundConnector.dispatch
        : null;

    if (!sender) return;

    await sender(packet);

    emitMigrationEvent("db.migration.exported", {
      version: VERSION,
      kind: "favoritesSchedules",
      ok: true,
    });
  } catch (err) {
    // Hub export is best-effort only; never break the migration for this.
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.warn("[vXX-favorites-schedules] Hub export failed:", err);
    }
  }
}

/**
 * Attempt to detect whether a session was previously “favorited” with some
 * ad-hoc property shape.
 *
 * We look for:
 *   - session.favorite === true
 *   - session.isFavorite === true
 *   - session.flags includes "favorite"
 *   - session.tags includes "favorite"
 *
 * @param {any} session
 * @returns {boolean}
 */
function sessionLooksFavorited(session) {
  if (!session || typeof session !== "object") return false;
  if (session.favorite === true || session.isFavorite === true) return true;

  const flags = session.flags;
  if (Array.isArray(flags) && flags.includes("favorite")) return true;

  const tags = session.tags;
  if (Array.isArray(tags) && tags.includes("favorite")) return true;

  return false;
}

/**
 * Attempt to extract a schedule-like definition from a session, if any.
 *
 * We look for:
 *   - session.schedule.rrule
 *   - session.schedule.cron
 *   - session.schedule.pattern
 *
 * @param {any} session
 * @returns {{ rrule: string|null; cron: string|null; pattern: any|null }|null}
 */
function extractScheduleFromSession(session) {
  if (!session || typeof session !== "object") return null;
  const raw = session.schedule;
  if (!raw || typeof raw !== "object") return null;

  const rrule =
    typeof raw.rrule === "string" && raw.rrule.trim().length > 0
      ? raw.rrule.trim()
      : null;
  const cron =
    typeof raw.cron === "string" && raw.cron.trim().length > 0
      ? raw.cron.trim()
      : null;
  const pattern =
    raw.pattern && typeof raw.pattern === "object" ? raw.pattern : null;

  if (!rrule && !cron && !pattern) return null;
  return { rrule, cron, pattern };
}

/**
 * Derive a short, user-facing label for a favorite based on a session.
 *
 * @param {any} session
 * @returns {string}
 */
function favoriteTitleFromSession(session) {
  if (!session || typeof session !== "object") return "Favorite";
  if (typeof session.title === "string" && session.title.trim()) {
    return session.title.trim();
  }
  if (typeof session.domain === "string") {
    return `Favorite ${session.domain} session`;
  }
  return "Favorite session";
}

/**
 * Derive a short, user-facing label for a schedule based on a session.
 *
 * @param {any} session
 * @returns {string}
 */
function scheduleTitleFromSession(session) {
  if (!session || typeof session !== "object") return "Schedule";
  if (typeof session.title === "string" && session.title.trim()) {
    return `Schedule: ${session.title.trim()}`;
  }
  if (typeof session.domain === "string") {
    return `Schedule (${session.domain})`;
  }
  return "Schedule";
}

/**
 * @typedef {"sessionTemplate"|"import"|"play"|"plan"|"other"} FavoriteKind
 */

/**
 * @typedef {"cooking"|"cleaning"|"garden"|"animals"|"preservation"|"storehouse"|"unknown"} DomainValue
 */

/**
 * Minimal record structure for the "favorites" store.
 *
 * @typedef {Object} FavoriteRecord
 * @property {number} [id]              - Auto-incremented by Dexie.
 * @property {DomainValue} domain       - Domain for routing/filters.
 * @property {FavoriteKind} kind        - What type of thing is this favorite?
 * @property {string} title             - Human label.
 * @property {string} sourceType        - e.g. "session", "import", "recipe", "plan", "play"
 * @property {string|null} sourceId     - ID of the source record (stringified).
 * @property {string|null} sourceRef    - Optional extra ID, e.g. recipeId/importId.
 * @property {string[]} [tags]          - Optional tags/labels.
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * Minimal record structure for the "schedules" store.
 *
 * @typedef {Object} ScheduleRecord
 * @property {number} [id]              - Auto-incremented by Dexie.
 * @property {DomainValue} domain       - Domain this schedule primarily targets.
 * @property {string} title             - Human label.
 * @property {boolean} enabled
 * @property {string|null} rrule        - iCal RRULE (preferred).
 * @property {string|null} cron         - Optional cron representation.
 * @property {any|null} pattern         - JSON pattern for relative scheduling.
 * @property {string|null} timezone     - IANA TZ string (e.g. "America/Chicago").
 * @property {string|null} sourceType   - "session" | "plan" | "manual" | etc.
 * @property {string|null} sourceId     - Stringified ID of source record.
 * @property {string|null} lastRunAt
 * @property {string|null} nextRunAt
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * Register vXX "favorites & schedules" migration on a Dexie instance.
 *
 * @param {import("dexie").Dexie} db
 */
export function registerVXXFavoritesSchedules(db) {
  if (!db || typeof db.version !== "function") {
    throw new Error("[vXX-favorites-schedules] Dexie instance is required");
  }

  db.version(VERSION)
    .stores({
      // New "favorites" store.
      //
      // Index rationale:
      //   • domain: quick filters per domain dashboard.
      //   • kind:   filter favorites by type (sessionTemplate, import, play).
      //   • title:  basic alphabetical listing and search.
      //   • sourceType + sourceId: look up favorites for a specific session/import/plan.
      favorites:
        "++id, domain, kind, title, sourceType, sourceId, createdAt, updatedAt",

      // New "schedules" store.
      //
      // Index rationale:
      //   • domain: filter upcoming schedules per domain.
      //   • enabled: support simple queries for active schedules.
      //   • nextRunAt: let automation runtime efficiently pull "what's next".
      //   • sourceType + sourceId: tie schedules back to plans/sessions/imports.
      schedules:
        "++id, domain, enabled, nextRunAt, title, sourceType, sourceId, createdAt, updatedAt",
    })
    .upgrade(async (tx) => {
      const startedAt = new Date().toISOString();
      emitMigrationEvent("db.migration.started", {
        version: VERSION,
        kind: "favoritesSchedules",
        startedAt,
      });

      let sessionsTable;
      let favoritesTable;
      let schedulesTable;

      try {
        sessionsTable = tx.table("sessions");
      } catch (err) {
        // If there's no "sessions" table yet, we still create favorites/schedules schema
        // but skip backfill. This is acceptable in early deployments.
        sessionsTable = null;
      }

      try {
        favoritesTable = tx.table("favorites");
        schedulesTable = tx.table("schedules");
      } catch (err) {
        emitMigrationEvent("db.migration.error", {
          version: VERSION,
          kind: "favoritesSchedules",
          error:
            "favorites and/or schedules tables not accessible in upgrade transaction",
        });
        throw err;
      }

      let sessionCount = 0;
      let favoriteCreatedFromSessions = 0;
      let scheduleCreatedFromSessions = 0;
      let sessionsUpdatedWithFavoriteId = 0;
      let sessionsUpdatedWithScheduleId = 0;

      /** @type {FavoriteRecord[]} */
      const favoritesToInsert = [];
      /** @type {ScheduleRecord[]} */
      const schedulesToInsert = [];
      /** @type {Map<string, number>} */
      const sessionIdToFavoriteId = new Map();
      /** @type {Map<string, number>} */
      const sessionIdToScheduleId = new Map();

      if (sessionsTable) {
        let sessions = [];
        try {
          sessions = await sessionsTable.toArray();
          sessionCount = sessions.length;
        } catch (err) {
          emitMigrationEvent("db.migration.error", {
            version: VERSION,
            kind: "favoritesSchedules",
            error: "Failed to load sessions from Dexie",
          });
          // We still proceed with schema creation; just skip backfill.
          sessions = [];
        }

        // Phase 1: scan sessions for "favorited" & schedule-bearing ones
        for (const session of sessions) {
          const sessionId =
            typeof session.id === "string" || typeof session.id === "number"
              ? String(session.id)
              : null;

          const domain =
            typeof session.domain === "string" && session.domain.trim()
              ? /** @type {DomainValue} */ (session.domain.trim())
              : /** @type {DomainValue} */ ("unknown");

          // Backfill favorites from sessions
          if (sessionLooksFavorited(session) && sessionId) {
            /** @type {FavoriteRecord} */
            const fav = {
              domain,
              kind: /** @type {FavoriteKind} */ ("sessionTemplate"),
              title: favoriteTitleFromSession(session),
              sourceType: "session",
              sourceId: sessionId,
              sourceRef:
                session.source && session.source.refId
                  ? String(session.source.refId)
                  : null,
              tags: Array.isArray(session.tags)
                ? session.tags.slice(0, 10)
                : [],
              createdAt: startedAt,
              updatedAt: startedAt,
            };
            favoritesToInsert.push(fav);
            favoriteCreatedFromSessions++;
          }

          // Backfill schedules from sessions (if any schedule-ish shape exists)
          const scheduleInfo = extractScheduleFromSession(session);
          if (scheduleInfo && sessionId) {
            /** @type {ScheduleRecord} */
            const sched = {
              domain,
              title: scheduleTitleFromSession(session),
              enabled:
                typeof session.enabled === "boolean" ? session.enabled : true,
              rrule: scheduleInfo.rrule,
              cron: scheduleInfo.cron,
              pattern: scheduleInfo.pattern,
              timezone:
                typeof session.timezone === "string" ? session.timezone : null,
              sourceType: "session",
              sourceId: sessionId,
              lastRunAt:
                typeof session.lastRunAt === "string"
                  ? session.lastRunAt
                  : null,
              nextRunAt:
                typeof session.nextRunAt === "string"
                  ? session.nextRunAt
                  : null,
              createdAt: startedAt,
              updatedAt: startedAt,
            };
            schedulesToInsert.push(sched);
            scheduleCreatedFromSessions++;
          }
        }
      }

      // Phase 2: insert favorites & schedules, capturing IDs to link back
      if (favoritesToInsert.length > 0) {
        /** @type {number[]} */
        const favIds = await favoritesTable.bulkAdd(favoritesToInsert, {
          allKeys: true,
        });

        // Map sessionId -> favoriteId for later linking
        for (let i = 0; i < favoritesToInsert.length; i++) {
          const fav = favoritesToInsert[i];
          const favId = favIds[i];
          if (!fav || fav.sourceType !== "session" || !fav.sourceId) continue;
          if (favId == null) continue;
          sessionIdToFavoriteId.set(fav.sourceId, favId);
        }
      }

      if (schedulesToInsert.length > 0) {
        /** @type {number[]} */
        const schedIds = await schedulesTable.bulkAdd(schedulesToInsert, {
          allKeys: true,
        });

        // Map sessionId -> scheduleId for later linking
        for (let i = 0; i < schedulesToInsert.length; i++) {
          const sched = schedulesToInsert[i];
          const schedId = schedIds[i];
          if (!sched || sched.sourceType !== "session" || !sched.sourceId)
            continue;
          if (schedId == null) continue;
          sessionIdToScheduleId.set(sched.sourceId, schedId);
        }
      }

      // Phase 3: link sessions back to favoriteId / scheduleId (if table exists)
      if (
        sessionsTable &&
        (sessionIdToFavoriteId.size > 0 || sessionIdToScheduleId.size > 0)
      ) {
        const allSessionIds = Array.from(
          new Set([
            ...sessionIdToFavoriteId.keys(),
            ...sessionIdToScheduleId.keys(),
          ])
        );

        for (const sessionId of allSessionIds) {
          const favoriteId = sessionIdToFavoriteId.get(sessionId);
          const scheduleId = sessionIdToScheduleId.get(sessionId);

          const patch = {};
          if (typeof favoriteId === "number") {
            patch.favoriteId = favoriteId;
            sessionsUpdatedWithFavoriteId++;
          }
          if (typeof scheduleId === "number") {
            patch.scheduleId = scheduleId;
            sessionsUpdatedWithScheduleId++;
          }
          if (Object.keys(patch).length === 0) continue;

          patch.updatedAt = new Date().toISOString();

          try {
            // Dexie allows string IDs and numeric IDs; we pass as-is and let
            // Dexie map to primaryKey type.
            await sessionsTable.update(
              // eslint-disable-next-line eqeqeq
              /** @type {any} */ (sessionId),
              patch
            );
          } catch {
            // Non-fatal; linking is best-effort metadata.
          }
        }
      }

      const completedAt = new Date().toISOString();
      const summary = {
        version: VERSION,
        kind: "favoritesSchedules",
        startedAt,
        completedAt,
        sessionCount,
        favoriteCreatedFromSessions,
        scheduleCreatedFromSessions,
        sessionsUpdatedWithFavoriteId,
        sessionsUpdatedWithScheduleId,
      };

      emitMigrationEvent("db.migration.completed", summary);

      // Optional & best-effort Hub export of summary.
      void exportToHubIfEnabled(summary);
    });
}

export default registerVXXFavoritesSchedules;
