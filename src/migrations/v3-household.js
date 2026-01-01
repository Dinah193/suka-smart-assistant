// C:\Users\larho\suka-smart-assistant\src\migrations\v3-household.js
//
// v3 – Core Household & Storehouse Topology Schema
// ------------------------------------------------
// Purpose:
//   Establish the **household identity layer** and a basic **storehouse
//   topology** for SSA. This is the backbone that lets all domains
//   (cooking, cleaning, garden, animals, preservation, storehouse) answer:
//
//     • “Which household is this data for?”
//     • “Where does this live in the storehouse?”
//
//   This migration *creates structure and seeds defaults*; it does not yet
//   track inventory quantities (that should live in dedicated inventory
//   migrations).
//
//   Pipeline position:
//
//     imports → intelligence → automation → (household/storehouse) → (optional) Hub export
//
//   This file:
//     • Adds Dexie stores:
//         - households
//         - householdMembers
//         - householdRoles
//         - storehouseLocations
//     • Seeds one default household ("primary") and a few standard
//       storehouse locations (e.g., Pantry, Freezer, Fridge, Root Cellar).
//     • Emits migration events to the eventBus.
//     • Sends a small summary to the Hub (if familyFundMode is enabled),
//       because this *does* create real household data (identity + layout).
//
// IMPORTANT VERSION NOTE
// ----------------------
// This file assumes VERSION = 3 for demonstration. If you are also using
// another v3 migration (e.g. v3-household-analytics), then **only one** can
// actually be version 3 in Dexie. Bump one of them to 4+ so your version
// chain is strictly increasing:
//
//   db.version(1) ... v1-imports
//   db.version(2) ... v2-sessions
//   db.version(3) ... v3-household   <-- OR analytics
//   db.version(4) ... v4-household-analytics (for example)
//
// Adjust VERSION below and the filename to keep things consistent.

import eventBus from "../services/events/eventBus";
import featureFlags from "../config/featureFlags";
import HubPacketFormatter from "../services/hub/HubPacketFormatter";
import FamilyFundConnector from "../services/hub/FamilyFundConnector";

/** @type {number} */
const VERSION = 3; // <-- Bump if needed to avoid conflict with other v3 migrations.

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
    source: "migrations.v3-household",
    data,
  });
}

/**
 * Export a small, high-level summary of household layout creation to the Hub
 * if familyFundMode is enabled. This is not a full sync, just a snapshot
 * useful for the Family Fund’s awareness of household topology.
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
      ? formatter("migration.household", payload)
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
      kind: "household",
      ok: true,
    });
  } catch (err) {
    // Best-effort only; never block migration on Hub issues.
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.warn("[v3-household] Hub export failed:", err);
    }
  }
}

/**
 * @typedef {"singleFamily"|"multiFamily"|"community"} HouseholdMode
 */

/**
 * @typedef {"pantry"|"fridge"|"freezer"|"rootCellar"|"barn"|"shed"|"other"} StorehouseLocationType
 */

/**
 * Register v3 "household identity & storehouse topology" migration on Dexie.
 *
 * How this fits into the pipeline:
 * --------------------------------
 * imports → intelligence → automation → household/storehouse → (optional) hub export
 *
 * • imports/intelligence:
 *   - Recipes, cleaning plans, garden layouts, etc. will eventually attach
 *     to a householdId and optionally storehouseLocationId.
 *
 * • automation:
 *   - Session engines (cooking, cleaning, garden, animals, preservation) will
 *     schedule sessions for a particular household and may target specific
 *     locations (e.g., “Pantry → Freezer rotation”, “Barn → Root Cellar”).
 *
 * • household/storehouse (THIS migration):
 *   - Provides the stable IDs and classification for households and their
 *     storehouse locations.
 *
 * • optional Hub export:
 *   - We send a tiny summary indicating how many households/locations were
 *     created, so the Family Fund Hub can understand the household’s basic
 *     layout when mirroring data.
 *
 * @param {import("dexie").Dexie} db
 */
export function registerV3Household(db) {
  if (!db || typeof db.version !== "function") {
    throw new Error("[v3-household] Dexie instance is required");
  }

  db.version(VERSION)
    .stores({
      // Households
      //
      // One row per *logical* household in SSA. Most users will have only one,
      // but multi-family / community setups can have multiple.
      //
      // Schema:
      //   id:        string PK ("primary", UUID, etc.)
      //   name:      human-readable household name
      //   slug:      URL-safe slug (not required)
      //   mode:      "singleFamily" | "multiFamily" | "community"
      //   timezone:  IANA tz string, e.g. "America/Chicago"
      //   locale:    e.g. "en-US"
      //   isPrimary: boolean flag to mark the main household
      //   createdAt, updatedAt: ISO timestamps
      households:
        "id, isPrimary, name, slug, mode, timezone, createdAt, updatedAt",

      // Household members
      //
      // Basic identity layer for people associated with a household
      // (adults, children, guests). This is *not* an auth system, just
      // a domain model for SSA's planning.
      //
      // Schema:
      //   ++id:            auto-increment
      //   householdId:     FK to households.id
      //   displayName:     e.g. "Rhonda", "Uncle James"
      //   roleKey:         e.g. "householder", "helper", "guest"
      //   status:          "active" | "inactive"
      //   isHouseholder:   boolean, helpful for UI filters
      //   createdAt, updatedAt
      householdMembers:
        "++id, householdId, displayName, roleKey, status, isHouseholder, createdAt, updatedAt",

      // Household roles
      //
      // Reusable role definitions that can be linked to members and used
      // by automation (e.g. assign tasks to "Barn Steward", "Kitchen Lead").
      //
      // Schema:
      //   ++id
      //   householdId
      //   key:         internal key ("householder", "kitchenLead", "barnSteward")
      //   label:       display label
      //   scope:       "adult" | "child" | "guest" | "system"
      //   permissions: optional serialized JSON of capabilities
      //   createdAt, updatedAt
      householdRoles: "++id, householdId, key, scope, createdAt, updatedAt",

      // Storehouse locations
      //
      // Physical or logical locations for food / supplies:
      //   Pantry, Fridge, Freezer, Root Cellar, Barn, Shed, etc.
      //
      // Schema:
      //   ++id
      //   householdId
      //   type:       "pantry" | "fridge" | "freezer" | "rootCellar" | "barn" | "shed" | "other"
      //   label:      human label ("Kitchen Pantry", "Garage Freezer A")
      //   slug:       optional slug key
      //   parentId:   for nested layouts (e.g., "Barn" → "Barn Freezer")
      //   isDefault:  marks core locations SSA can assume exist
      //   createdAt, updatedAt
      storehouseLocations:
        "++id, householdId, type, isDefault, label, slug, parentId, createdAt, updatedAt",
    })
    .upgrade(async (tx) => {
      const startedAt = new Date().toISOString();
      emitMigrationEvent("db.migration.started", {
        version: VERSION,
        kind: "household",
        startedAt,
      });

      const householdsTable = tx.table("households");
      const membersTable = tx.table("householdMembers");
      const rolesTable = tx.table("householdRoles");
      const locationsTable = tx.table("storehouseLocations");

      // Check if we already have at least one household; if so, we
      // assume this is a re-run or a branch merge, and we avoid
      // creating duplicates.
      let existingHouseholdsCount = 0;
      try {
        existingHouseholdsCount = await householdsTable.count();
      } catch (err) {
        emitMigrationEvent("db.migration.error", {
          version: VERSION,
          kind: "household",
          error: "Failed to count existing households",
        });
      }

      let createdHouseholds = 0;
      let createdRoles = 0;
      let createdLocations = 0;

      let primaryHouseholdId = "primary";

      if (existingHouseholdsCount === 0) {
        // Seed a default household row.
        const defaultHousehold = {
          id: primaryHouseholdId,
          name: "Primary Household",
          slug: "primary",
          mode: /** @type {HouseholdMode} */ ("singleFamily"),
          timezone:
            typeof Intl !== "undefined" &&
            Intl.DateTimeFormat &&
            Intl.DateTimeFormat().resolvedOptions
              ? Intl.DateTimeFormat().resolvedOptions().timeZone ||
                "America/Chicago"
              : "America/Chicago",
          locale:
            typeof navigator !== "undefined" && navigator.language
              ? navigator.language
              : "en-US",
          isPrimary: true,
          createdAt: startedAt,
          updatedAt: startedAt,
        };

        try {
          await householdsTable.put(defaultHousehold);
          createdHouseholds += 1;
        } catch (err) {
          emitMigrationEvent("db.migration.error", {
            version: VERSION,
            kind: "household",
            error: "Failed to seed primary household",
          });
        }

        // Seed a couple of core roles useful across SSA.
        /** @type {Array<import("dexie").Table<any>>} */
        const roleSeed = [
          {
            householdId: primaryHouseholdId,
            key: "householder",
            label: "Householder",
            scope: "adult",
            permissions: {
              canConfigureHousehold: true,
              canManageStorehouse: true,
              canManageSessions: true,
            },
            createdAt: startedAt,
            updatedAt: startedAt,
          },
          {
            householdId: primaryHouseholdId,
            key: "helper",
            label: "Helper",
            scope: "adult",
            permissions: {
              canExecuteSessions: true,
            },
            createdAt: startedAt,
            updatedAt: startedAt,
          },
          {
            householdId: primaryHouseholdId,
            key: "youthHelper",
            label: "Youth Helper",
            scope: "child",
            permissions: {
              canViewTasks: true,
              canMarkTasksDone: true,
            },
            createdAt: startedAt,
            updatedAt: startedAt,
          },
        ];

        try {
          await rolesTable.bulkAdd(roleSeed);
          createdRoles += roleSeed.length;
        } catch (err) {
          emitMigrationEvent("db.migration.error", {
            version: VERSION,
            kind: "household",
            error: "Failed to seed default household roles",
          });
        }

        // Seed default storehouse locations that SSA can rely on existing.
        const locationSeed = [
          {
            householdId: primaryHouseholdId,
            type: /** @type {StorehouseLocationType} */ ("pantry"),
            label: "Kitchen Pantry",
            slug: "kitchen-pantry",
            parentId: null,
            isDefault: true,
            createdAt: startedAt,
            updatedAt: startedAt,
          },
          {
            householdId: primaryHouseholdId,
            type: /** @type {StorehouseLocationType} */ ("fridge"),
            label: "Main Fridge",
            slug: "main-fridge",
            parentId: null,
            isDefault: true,
            createdAt: startedAt,
            updatedAt: startedAt,
          },
          {
            householdId: primaryHouseholdId,
            type: /** @type {StorehouseLocationType} */ ("freezer"),
            label: "Deep Freezer",
            slug: "deep-freezer",
            parentId: null,
            isDefault: true,
            createdAt: startedAt,
            updatedAt: startedAt,
          },
          {
            householdId: primaryHouseholdId,
            type: /** @type {StorehouseLocationType} */ ("rootCellar"),
            label: "Root Cellar",
            slug: "root-cellar",
            parentId: null,
            isDefault: true,
            createdAt: startedAt,
            updatedAt: startedAt,
          },
        ];

        try {
          await locationsTable.bulkAdd(locationSeed);
          createdLocations += locationSeed.length;
        } catch (err) {
          emitMigrationEvent("db.migration.error", {
            version: VERSION,
            kind: "household",
            error: "Failed to seed default storehouse locations",
          });
        }

        // Optional: seed a placeholder primary householder member record.
        try {
          await membersTable.add({
            householdId: primaryHouseholdId,
            displayName: "Householder",
            roleKey: "householder",
            status: "active",
            isHouseholder: true,
            createdAt: startedAt,
            updatedAt: startedAt,
          });
        } catch {
          // Non-fatal; UI can prompt user to fill this in later.
        }
      } else {
        // Households already exist; we do *not* attempt to seed defaults to
        // avoid duplication. We just ensure schema is created.
        primaryHouseholdId = null;
      }

      const completedAt = new Date().toISOString();
      const summary = {
        version: VERSION,
        kind: "household",
        startedAt,
        completedAt,
        existingHouseholdsBefore: existingHouseholdsCount,
        createdHouseholds,
        createdRoles,
        createdLocations,
        primaryHouseholdId,
      };

      emitMigrationEvent("db.migration.completed", summary);

      // Because this migration DOES create real household/storehouse data,
      // we send a tiny summary to the Hub (if enabled).
      void exportToHubIfEnabled(summary);
    });
}

export default registerV3Household;
