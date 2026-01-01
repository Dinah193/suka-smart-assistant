// C:\Users\larho\suka-smart-assistant\src\migrations\v3-household-analytics.js
//
// v3 – Household Analytics Schema & Baseline
// ------------------------------------------
// Purpose:
//   Establish the *analytics* layer of SSA’s data model. This sits on top of
//   imports + sessions + inventory and provides a structured place to record:
//
//     • fine-grained analytics events (what happened, when, and in which domain)
//     • daily rollups per domain (how many meals, cleanings, harvest logs, etc.)
//     • a single "household health" snapshot (aggregate indicators)
//
//   This is **read-mostly, derived data** – it does not own inventory or
//   sessions; it summarizes them.
//
//   Pipeline position:
//
//     imports → intelligence → automation → analytics → (optional) hub export
//
//   This migration:
//     • Adds three stores:
//         - analyticsEvents
//         - analyticsDaily
//         - analyticsHousehold
//     • Optionally scans existing sessions to seed a baseline household
//       analytics snapshot (best-effort).
//
//   It does *not* modify inventory quantities or session content, only
//   derives analytics records. Therefore, it does NOT call exportToHubIfEnabled
//   with full household data, only with a small migration summary.
//
//   NOTE: In your runtime code (not in this migration), when you emit domain
//   events like `meal.executed`, `garden.harvest.logged`, etc., you’ll also
//   write analyticsEvents rows and periodically roll up into analyticsDaily.
//
// -----------------------------------------------------------------------------
//
// Usage in Dexie setup:
//
//   import Dexie from "dexie";
//   import { registerV3HouseholdAnalytics } from "../migrations/v3-household-analytics";
//
//   const db = new Dexie("SukaSmartAssistant");
//   // v1-imports, v2-sessions, etc.
//   registerV3HouseholdAnalytics(db);
//
// -----------------------------------------------------------------------------

import eventBus from "../services/events/eventBus";
import featureFlags from "../config/featureFlags";
import HubPacketFormatter from "../services/hub/HubPacketFormatter";
import FamilyFundConnector from "../services/hub/FamilyFundConnector";

/** @type {number} */
const VERSION = 3;

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
    source: "migrations.v3-household-analytics",
    data,
  });
}

/**
 * Export a high-level summary of the migration to the Hub if familyFundMode
 * is enabled. This is *meta* info (counts, dates), NOT a full analytics dump.
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
      ? formatter("migration.householdAnalytics", payload)
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
      kind: "householdAnalytics",
      ok: true,
    });
  } catch (err) {
    // Best-effort only, never break migration for Hub issues.
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.warn("[v3-household-analytics] Hub export failed:", err);
    }
  }
}

/**
 * Normalizes a domain string or returns "unknown".
 *
 * @param {string|undefined|null} raw
 * @returns {"cooking"|"cleaning"|"garden"|"animals"|"preservation"|"storehouse"|"unknown"}
 */
function normalizeDomain(raw) {
  if (!raw || typeof raw !== "string") return "unknown";
  const v = raw.trim().toLowerCase();
  switch (v) {
    case "cooking":
    case "cleaning":
    case "garden":
    case "animals":
    case "preservation":
    case "storehouse":
      return v;
    default:
      return "unknown";
  }
}

/**
 * Register v3 "household analytics" migration on a Dexie instance.
 *
 * @param {import("dexie").Dexie} db
 */
export function registerV3HouseholdAnalytics(db) {
  if (!db || typeof db.version !== "function") {
    throw new Error("[v3-household-analytics] Dexie instance is required");
  }

  db.version(VERSION)
    .stores({
      // Fine-grained analytics events
      //
      // These rows track **what happened** in the household engine:
      //
      //   - type:   event type, e.g. "meal.executed", "garden.harvest.logged",
      //             "preservation.completed", "inventory.shortage.detected".
      //   - domain: main domain touched by the event (cooking, cleaning, etc.).
      //   - ts:     primary time index for analytics.
      //   - sessionId/importId: soft links back to source records (stringified).
      //
      // Index rationale:
      //   • type + domain: filter by event kind per domain.
      //   • ts:            chronological queries and time range analytics.
      //   • sessionId:     session-based drill-down.
      //   • importId:      import-based drill-down.
      analyticsEvents: "++id, type, domain, ts, sessionId, importId, source",
      // ts will be stored as ISO string and used with Dexie range queries.

      // Daily rollups
      //
      // Summaries of events per day and domain, e.g.:
      //   "2025-01-01 / cooking / mealsExecuted = 3"
      //
      // Index rationale:
      //   • date + domain + kind: uniqueness + fast lookup
      //   • date:                 chronological dashboards
      //   • domain:               domain dashboards
      analyticsDaily: "++id, date, domain, kind, [date+domain+kind]",

      // Household-level analytics snapshot
      //
      // This can be a single-row "dashboard" record that aggregates high-level
      // counts or metrics (number of sessions executed, meals cooked this week,
      // average batch size, etc.).
      //
      // We use a simple string key (e.g. id="household") so you can easily
      // add more snapshots later ("animals", "garden", etc.) if needed.
      //
      // Index rationale:
      //   • id:        primary key (string)
      //   • updatedAt: quickly see freshness and query by recency if needed
      analyticsHousehold: "id, updatedAt",
    })
    .upgrade(async (tx) => {
      const startedAt = new Date().toISOString();
      emitMigrationEvent("db.migration.started", {
        version: VERSION,
        kind: "householdAnalytics",
        startedAt,
      });

      let sessionsTable = null;
      let analyticsHousehold;
      let analyticsDaily;

      try {
        analyticsHousehold = tx.table("analyticsHousehold");
        analyticsDaily = tx.table("analyticsDaily");
      } catch (err) {
        emitMigrationEvent("db.migration.error", {
          version: VERSION,
          kind: "householdAnalytics",
          error:
            "analyticsHousehold and/or analyticsDaily tables not accessible",
        });
        throw err;
      }

      try {
        sessionsTable = tx.table("sessions");
      } catch {
        // If there's no sessions table yet (very early deployments), we just
        // create the analytics schema and skip baseline seeding. That's fine.
        sessionsTable = null;
      }

      let sessionCount = 0;
      let sessionsByDomain = {};
      let completedSessions = 0;
      let abortedSessions = 0;

      if (sessionsTable) {
        try {
          const sessions = await sessionsTable.toArray();
          sessionCount = sessions.length;

          const domainCounts = {};
          for (const s of sessions) {
            const domain = normalizeDomain(s.domain);
            domainCounts[domain] = (domainCounts[domain] || 0) + 1;

            if (s && typeof s.status === "string") {
              const st = s.status;
              if (st === "completed") completedSessions += 1;
              else if (st === "aborted") abortedSessions += 1;
            }
          }

          sessionsByDomain = domainCounts;

          // Optional: seed an initial daily rollup row summarizing
          // "sessionsExistingAtMigration" for each domain.
          const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

          const dailyRows = Object.entries(domainCounts).map(
            ([domain, count]) => ({
              date: today,
              domain,
              kind: "sessionsExistingAtMigration",
              value: count,
              createdAt: startedAt,
              updatedAt: startedAt,
            })
          );

          if (dailyRows.length > 0) {
            await analyticsDaily.bulkAdd(dailyRows);
          }
        } catch (err) {
          emitMigrationEvent("db.migration.error", {
            version: VERSION,
            kind: "householdAnalytics",
            error: "Failed to seed baseline from sessions table",
          });
          // Non-fatal; we still want schema to exist even if baseline fails.
        }
      }

      // Seed / update household snapshot
      try {
        const baseSnapshot = {
          id: "household",
          sessionsTotal: sessionCount,
          sessionsByDomain,
          sessionsCompleted: completedSessions,
          sessionsAborted: abortedSessions,
          // Placeholders for future analytics (can be overwritten later)
          mealsExecutedTotal: 0,
          gardenHarvestLoggedTotal: 0,
          preservationCompletedTotal: 0,
          inventoryShortageDetectedTotal: 0,
          createdAt: startedAt,
          updatedAt: startedAt,
        };

        // Upsert pattern for Dexie inside an upgrade transaction:
        //  - try get existing, then put/merge accordingly.
        let existing;
        try {
          existing = await analyticsHousehold.get("household");
        } catch {
          existing = null;
        }

        if (!existing) {
          await analyticsHousehold.put(baseSnapshot);
        } else {
          await analyticsHousehold.put({
            ...existing,
            ...baseSnapshot,
            createdAt: existing.createdAt || startedAt,
            updatedAt: startedAt,
          });
        }
      } catch (err) {
        emitMigrationEvent("db.migration.error", {
          version: VERSION,
          kind: "householdAnalytics",
          error: "Failed to seed analyticsHousehold snapshot",
        });
        // Still non-fatal for schema.
      }

      const completedAt = new Date().toISOString();
      const summary = {
        version: VERSION,
        kind: "householdAnalytics",
        startedAt,
        completedAt,
        sessionCount,
        sessionsByDomain,
        sessionsCompleted: completedSessions,
        sessionsAborted: abortedSessions,
      };

      emitMigrationEvent("db.migration.completed", summary);

      // Optional tiny Hub summary (meta only).
      void exportToHubIfEnabled(summary);
    });
}

export default registerV3HouseholdAnalytics;
