// C:\Users\larho\suka-smart-assistant\src\migrations\vXX-add-plays.js
//
// vXX – Add "plays" store and link sessions to reusable plays
// -----------------------------------------------------------
// Purpose:
//   Introduce a dedicated "plays" store that represents reusable,
//   user-facing “Play from this plan/import” records, distinct from
//   individual runtime sessions.
//
//   • A *play* is a reusable template/entry point (e.g. “Daily Barn Walk”,
//     “Sunday Deep-Clean”, “Batch Cook: Chili & Cornbread”).
//   • A *session* is a concrete run-through with timers, analytics, etc.
//   • This migration:
//       - Creates the Dexie "plays" store.
//       - Scans existing sessions and attempts to backfill plays where
//         possible, based on `session.domain`, `session.title`, and
//         `session.source`.
//       - Adds a `playId` property to sessions (no index; Dexie will store
//         extra fields without schema changes).
//
// How this fits into the SSA pipeline
// -----------------------------------
// imports → intelligence → automation → (optional) hub export
//
// • imports:
//   ImportRouter & domain importers will later create/update "plays" when
//   the user chooses to “save this as a favorite Play” from a recipe,
//   cleaning plan, garden plan, etc.
//
// • intelligence:
//   The intelligence layer can now reason about:
//     - Which Plays get used most often.
//     - Which Plays should be surfaced as "Next best actions" per domain.
//
// • automation:
//   Automation runtime can:
//
//     - Propose sessions from plays (e.g., “Run ‘Evening Barn Walk’ now?”).
//     - Tie analytics to the play instead of the ephemeral session ID.
//
// • optional hub export:
//   Because this migration *relabels / groups existing sessions* and creates
//   meta-level "plays" (not new inventory/storehouse records), the impact on
//   household *stock* is minimal. Still, for transparency, we emit a small
//   Hub-friendly summary at the end via `exportToHubIfEnabled`.
//
// Usage
// -----
// In your central Dexie setup (e.g. src/db/index.js or src/db/migrations.js):
//
//   import { registerVXXAddPlays } from "../migrations/vXX-add-plays";
//
//   const db = new Dexie("SukaSmartAssistant");
//   // ... earlier versions ...
//   registerVXXAddPlays(db);
//
// Important: Replace VERSION below with the next numeric version in your
// Dexie chain (e.g. 7, 8, etc.) and keep this file name in sync.

import eventBus from "../services/events/eventBus";
import featureFlags from "../config/featureFlags";
import HubPacketFormatter from "../services/hub/HubPacketFormatter";
import FamilyFundConnector from "../services/hub/FamilyFundConnector";

/** @type {number} */
const VERSION = 99; // <-- Replace with your next Dexie version.

/**
 * Emit a structured migration event on the shared eventBus.
 *
 * @param {string} type - e.g. "db.migration.started" | "db.migration.completed" | "db.migration.error"
 * @param {any} data
 */
function emitMigrationEvent(type, data) {
  if (!eventBus || typeof eventBus.emit !== "function") return;

  eventBus.emit({
    type,
    ts: new Date().toISOString(),
    source: "migrations.vXX-add-plays",
    data,
  });
}

/**
 * Export a high-level summary to the Hub if familyFundMode is enabled.
 * This is *meta* data about the migration, not full household state.
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
      ? formatter("migration.addPlays", payload)
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
      kind: "addPlays",
      ok: true,
    });
  } catch (err) {
    // Hub export is best-effort only; never break the migration for this.
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.warn("[vXX-add-plays] Hub export failed:", err);
    }
  }
}

/**
 * Attempt to derive a stable key for a Play from an existing session.
 *
 * We prefer:
 *   (domain, source.type, source.refId, title)
 *   then fall back to:
 *   (domain, "-", "-", title)
 *
 * @param {any} session
 * @returns {string|null}
 */
function derivePlayKeyFromSession(session) {
  if (!session || typeof session !== "object") return null;
  const domain = session.domain || "unknown";
  const title = session.title || "Untitled";

  const sourceType =
    session.source && typeof session.source.type === "string"
      ? session.source.type
      : "-";

  const sourceRefId =
    session.source && typeof session.source.refId === "string"
      ? session.source.refId
      : "-";

  return [domain, sourceType, sourceRefId, title].join("::");
}

/**
 * Minimal play record structure for the "plays" store.
 *
 * @typedef {Object} PlayRecord
 * @property {number} [id]          - Auto-incremented by Dexie.
 * @property {string} domain        - "cooking" | "cleaning" | "garden" | "animals" | "preservation" | "storehouse" | "unknown"
 * @property {string} title
 * @property {string} sourceType    - "recipe" | "cleaningPlan" | "gardenPlan" | "animalTask" | "import" | "manual" | "-"
 * @property {string|null} sourceRefId
 * @property {string|null} createdFromSessionId
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * Register vXX "add plays" migration on a Dexie instance.
 *
 * @param {import("dexie").Dexie} db
 */
export function registerVXXAddPlays(db) {
  if (!db || typeof db.version !== "function") {
    throw new Error("[vXX-add-plays] Dexie instance is required");
  }

  db.version(VERSION)
    .stores({
      // New "plays" store.
      //
      // Index rationale:
      //   • domain: quickly list plays per domain (cooking, cleaning, etc.)
      //   • title: for simple alphabetical listings/search
      //   • sourceType + sourceRefId: allow lookups like "plays derived from this recipe/import"
      plays:
        "++id, domain, title, sourceType, sourceRefId, createdAt, updatedAt",
    })
    .upgrade(async (tx) => {
      const startedAt = new Date().toISOString();
      emitMigrationEvent("db.migration.started", {
        version: VERSION,
        kind: "addPlays",
        startedAt,
      });

      let sessionsTable;
      let playsTable;

      try {
        sessionsTable = tx.table("sessions");
      } catch (err) {
        // If there's no "sessions" table yet, this is a no-op migration (only adds schema).
        emitMigrationEvent("db.migration.completed", {
          version: VERSION,
          kind: "addPlays",
          startedAt,
          completedAt: new Date().toISOString(),
          detail: "No sessions table found; created plays store only.",
        });
        return;
      }

      try {
        playsTable = tx.table("plays");
      } catch (err) {
        emitMigrationEvent("db.migration.error", {
          version: VERSION,
          kind: "addPlays",
          error: "plays table not accessible in upgrade transaction",
        });
        throw err;
      }

      /** @type {PlayRecord[]} */
      const newPlays = [];
      /** @type {Map<string, number>} */
      const playKeyToId = new Map();

      let sessions;
      try {
        sessions = await sessionsTable.toArray();
      } catch (err) {
        emitMigrationEvent("db.migration.error", {
          version: VERSION,
          kind: "addPlays",
          error: "Failed to load sessions from Dexie",
        });
        throw err;
      }

      const sessionCount = sessions.length;
      let linkedSessionsCount = 0;

      // First pass: derive unique plays and insert them.
      for (const session of sessions) {
        const key = derivePlayKeyFromSession(session);
        if (!key) continue;

        if (playKeyToId.has(key)) {
          continue; // Already created for this key.
        }

        const [domainRaw, sourceTypeRaw, sourceRefIdRaw, title] =
          key.split("::");

        /** @type {PlayRecord} */
        const play = {
          domain: domainRaw || "unknown",
          title: title || "Untitled",
          sourceType:
            sourceTypeRaw && sourceTypeRaw !== "-" ? sourceTypeRaw : "-",
          sourceRefId:
            sourceRefIdRaw && sourceRefIdRaw !== "-" ? sourceRefIdRaw : null,
          createdFromSessionId:
            typeof session.id === "string" || typeof session.id === "number"
              ? String(session.id)
              : null,
          createdAt: startedAt,
          updatedAt: startedAt,
        };

        newPlays.push(play);
      }

      // Put plays into Dexie and capture assigned IDs.
      let createdPlaysCount = 0;
      if (newPlays.length > 0) {
        /** @type {number[]} */
        const ids = await playsTable.bulkAdd(newPlays, { allKeys: true });

        for (let i = 0; i < newPlays.length; i++) {
          const play = newPlays[i];
          const id = ids[i];
          if (id == null) continue;

          const key = [
            play.domain,
            play.sourceType || "-",
            play.sourceRefId || "-",
            play.title,
          ].join("::");
          playKeyToId.set(key, id);
          createdPlaysCount++;
        }
      }

      // Second pass: write playId to sessions (no index required; Dexie
      // accepts extra properties that are not indexed).
      for (const session of sessions) {
        const key = derivePlayKeyFromSession(session);
        if (!key) continue;
        const playId = playKeyToId.get(key);
        if (!playId) continue;

        try {
          await sessionsTable.update(session.id, {
            playId,
            // optional: keep an updatedAt if your sessions use it
            updatedAt: new Date().toISOString(),
          });
          linkedSessionsCount++;
        } catch {
          // Best-effort only for existing sessions; if update fails, we skip.
          // No need to emit noisy errors here.
        }
      }

      const completedAt = new Date().toISOString();
      const summary = {
        version: VERSION,
        kind: "addPlays",
        startedAt,
        completedAt,
        sessionCount,
        createdPlaysCount,
        linkedSessionsCount,
      };

      emitMigrationEvent("db.migration.completed", summary);

      // Optional & best-effort Hub export
      void exportToHubIfEnabled(summary);
    });
}

export default registerVXXAddPlays;
