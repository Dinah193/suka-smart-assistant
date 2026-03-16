/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\services\db.js
//
// Core Dexie database wiring for Suka Smart Assistant (SSA).
// ---------------------------------------------------------
// This file is the **persistence spine** for SSA.
//
// Pipeline role:
// imports → intelligence → automation → (optional) Hub export
//
// - All normalized data (imports, inventory, sessions, logs, etc.) land here.
// - Domain engines (meals, cleaning, garden, animals, preservation, storehouse)
//   work *against* this db instance.
// - Dexie hooks emit SSA events (via eventBus) whenever key household tables
//   change, so the automation runtime and dashboards can react.
// - For household-critical tables (inventory, storehouse, sessions), hooks also
//   optionally export payloads to the Family Fund Hub when familyFundMode is on.
//
// Forward-thinking design:
// - Table names and indexes are generic and version-able.
// - Hook configuration is table-driven so new domains can be added by editing
//   HOOK_CONFIG and the schema, without touching the rest of the code.

import Dexie from "dexie";

// NOTE: In your project this lives at src/services/events/eventBus.js
// and should provide an .emit(payload) API.
import eventBus from "./events/eventBus";

// Hub helpers live under src/services/hub/
import HubPacketFormatter from "./hub/HubPacketFormatter";
import FamilyFundConnector from "./hub/FamilyFundConnector";

// Feature flags JSON (assumed at src/config/featureFlags.json)
import featureFlags from "@/config/featureFlags.json";

/* -------------------------------------------------------------------------- */
/* Utility helpers */
/* -------------------------------------------------------------------------- */

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix = "sess") {
  // stable enough for local-first ids; no dependency on crypto
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Emit a strongly-shaped SSA event.
 *
 * @param {string} type Semantic event type (e.g. "inventory.updated").
 * @param {string} source Short identifier of the emitter (e.g. "db.hook").
 * @param {object} data Arbitrary structured payload.
 */
function emitEvent(type, source, data) {
  if (!eventBus || typeof eventBus.emit !== "function") {
    // Fail silently but log once in dev if needed.
    if (import.meta?.env?.DEV) {
      console.warn("[db] eventBus.emit is not available");
    }
    return;
  }

  try {
    eventBus.emit({
      type,
      ts: nowIso(),
      source,
      data,
    });
  } catch (err) {
    if (import.meta?.env?.DEV) {
      console.error("[db] Failed to emit event", type, err);
    }
  }
}

/**
 * Optional Hub export helper.
 *
 * Any time household data changes (inventory, storehouse, sessions), we can
 * send a packet to the Family Fund Hub *if* familyFundMode is enabled.
 *
 * This **must not** throw; Hub connectivity is best-effort only.
 *
 * @param {string} domain Logical domain ("inventory" | "storehouse" | "sessions" | etc.)
 * @param {object} payload Structured data describing the change.
 */
async function exportToHubIfEnabled(domain, payload) {
  try {
    const enabled = Boolean(featureFlags?.familyFundMode === true);
    if (!enabled) return;

    if (
      !HubPacketFormatter ||
      typeof HubPacketFormatter.format !== "function" ||
      !FamilyFundConnector ||
      typeof FamilyFundConnector.send !== "function"
    ) {
      if (import.meta?.env?.DEV) {
        console.warn(
          "[db] Hub helpers not available; skipping Hub export for domain:",
          domain,
        );
      }
      return;
    }

    const packet = HubPacketFormatter.format({
      domain,
      ts: nowIso(),
      payload,
    });

    // Fire and forget; this must not block Dexie operations.
    await FamilyFundConnector.send(packet);
  } catch (err) {
    // Fail silently in production; log in dev.
    if (import.meta?.env?.DEV) {
      console.warn("[db] Hub export failed:", err);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Dexie database definition */
/* -------------------------------------------------------------------------- */

/**
 * Single, shared Dexie instance for the entire SSA runtime.
 *
 * Version 1 schema:
 * - imports: normalized imported artifacts, regardless of domain.
 * - sessions: runnable sessions (cooking, cleaning, garden, animal, preservation).
 * - inventory: line items in the household inventory.
 * - storehouse: higher-level “storehouse” view (by category/season/cycle).
 * - logs: generic diagnostic / analytics events.
 *
 * Sessions table is domain-agnostic:
 * - domain = "cooking" | "cleaning" | "garden" | "animals" | "preservation" | ...
 * - status = "draft" | "scheduled" | "running" | "completed" | "aborted"
 */
export const db = new Dexie("sukaSmartAssistant");

// ✅ Back-compat named export for code that imports { ssaDB } from "@/services/db"
export const ssaDB = db;

/**
 * v1 (legacy) used auto-increment numeric ids for sessions.
 * That breaks /:domain/play/:id when the app generates string ids like "draft_...".
 */
db.version(1).stores({
  imports:
    "++id, type, subType, source, sourceUrl, importedAt, domain, fingerprint",
  // LEGACY: numeric autoincrement id
  sessions:
    "++id, domain, status, startedAt, updatedAt, plannedFor, originImportId",
  inventory:
    "++id, sku, name, location, category, quantity, unit, updatedAt, lowStockFlag",
  storehouse:
    "++id, bucket, season, cycle, itemKey, plannedQuantity, actualQuantity, updatedAt",
  logs: "++id, domain, level, ts, tag",
});

/**
 * ✅ Option A (safe): Keep numeric primary key (so we DO NOT change primary key),
 * but introduce a canonical, stable string identifier: sessionId.
 *
 * This avoids Dexie "changing primary key" UpgradeError, while still allowing
 * routes to use the stable string id.
 *
 * Important:
 * - Primary key remains ++id (unchanged).
 * - We add sessionId as an indexed field for fast lookup.
 * - All code should treat sessionId as the canonical identifier for play/resume.
 */
db.version(2)
  .stores({
    imports:
      "++id, type, subType, source, sourceUrl, importedAt, domain, fingerprint",
    // ✅ SAME PRIMARY KEY as v1 (++) — only adds indexes.
    sessions:
      "++id, sessionId, domain, status, startedAt, updatedAt, plannedFor, originImportId, legacyId",
    inventory:
      "++id, sku, name, location, category, quantity, unit, updatedAt, lowStockFlag",
    storehouse:
      "++id, bucket, season, cycle, itemKey, plannedQuantity, actualQuantity, updatedAt",
    logs: "++id, domain, level, ts, tag",
  })
  .upgrade(async (tx) => {
    // Best-effort migration: populate sessionId for existing rows.
    try {
      const table = tx.table("sessions");
      const all = await table.toArray();
      const now = nowIso();

      for (const s of all) {
        // If already has a sessionId, leave it.
        if (typeof s?.sessionId === "string" && s.sessionId.length) continue;

        const legacyId = s?.legacyId ?? s?.id; // v1 numeric PK lives in id
        const sessionId = makeId(String(s?.domain || "sess"));

        // Use table.update(key, mods) so we don't rewrite PK.
        // NOTE: In Dexie upgrade tx, records from toArray() include the numeric PK at id.
        // eslint-disable-next-line no-await-in-loop
        await table.update(s.id, {
          sessionId,
          legacyId: legacyId ?? s.id,
          updatedAt: s?.updatedAt || now,
          createdAt: s?.createdAt || s?.updatedAt || now,
          status: s?.status || "draft",
          steps: Array.isArray(s?.steps) ? s.steps : [],
        });
      }
    } catch (err) {
      // Never block app boot due to migration issues.
      if (import.meta?.env?.DEV) {
        console.warn(
          "[db] sessions migration v1->v2 encountered an issue:",
          err,
        );
      }
    }
  });

/**
 * ✅ v3: Add cleaningPlans (NEW TABLE) without changing existing PKs.
 */
db.version(3).stores({
  imports:
    "++id, type, subType, source, sourceUrl, importedAt, domain, fingerprint",
  sessions:
    "++id, sessionId, domain, status, startedAt, updatedAt, plannedFor, originImportId, legacyId",
  inventory:
    "++id, sku, name, location, category, quantity, unit, updatedAt, lowStockFlag",
  storehouse:
    "++id, bucket, season, cycle, itemKey, plannedQuantity, actualQuantity, updatedAt",
  logs: "++id, domain, level, ts, tag",
  // NEW: reusable cleaning plans library (brand-new table; safe to introduce)
  cleaningPlans:
    "id, householdId, status, intensity, *zones, createdAt, updatedAt, lastCompletedAt",
});

/**
 * ✅ v4: Add planningDrafts (NEW TABLE) for cross-domain planner artifacts.
 */
db.version(4).stores({
  imports:
    "++id, type, subType, source, sourceUrl, importedAt, domain, fingerprint",
  sessions:
    "++id, sessionId, domain, status, startedAt, updatedAt, plannedFor, originImportId, legacyId",
  inventory:
    "++id, sku, name, location, category, quantity, unit, updatedAt, lowStockFlag",
  storehouse:
    "++id, bucket, season, cycle, itemKey, plannedQuantity, actualQuantity, updatedAt",
  logs: "++id, domain, level, ts, tag",
  cleaningPlans:
    "id, householdId, status, intensity, *zones, createdAt, updatedAt, lastCompletedAt",
  // NEW: planning drafts (cross-domain artifacts)
  planningDrafts:
    "id, kind, domain, status, createdAt, updatedAt, homesteadPlanId, title",
});

/**
 * ✅ v5: Add Import Pipeline tables (NEW TABLES)
 */
db.version(5).stores({
  imports:
    "++id, type, subType, source, sourceUrl, importedAt, domain, fingerprint",
  sessions:
    "++id, sessionId, domain, status, startedAt, updatedAt, plannedFor, originImportId, legacyId",
  inventory:
    "++id, sku, name, location, category, quantity, unit, updatedAt, lowStockFlag",
  storehouse:
    "++id, bucket, season, cycle, itemKey, plannedQuantity, actualQuantity, updatedAt",
  logs: "++id, domain, level, ts, tag",
  cleaningPlans:
    "id, householdId, status, intensity, *zones, createdAt, updatedAt, lastCompletedAt",
  planningDrafts:
    "id, kind, domain, status, createdAt, updatedAt, homesteadPlanId, title",
  // --- Import pipeline tables (raw + normalized + link maps + logs) ---
  importRaw: "id, domain, createdAtISO, updatedAtISO, source.kind, source.url",
  importNormalized:
    "id, rawId, domain, createdAtISO, updatedAtISO, confidence.overall",
  importLinkMaps: "id, rawId, normId, domain, createdAtISO, updatedAtISO",
  importLogs: "id, domain, rawId, normId, linkMapId, ts, level",
});

/**
 * ✅ v6: Add helpful compound indexes for per-domain import browsing
 */
db.version(6).stores({
  imports:
    "++id, type, subType, source, sourceUrl, importedAt, domain, fingerprint",
  sessions:
    "++id, sessionId, domain, status, startedAt, updatedAt, plannedFor, originImportId, legacyId",
  inventory:
    "++id, sku, name, location, category, quantity, unit, updatedAt, lowStockFlag",
  storehouse:
    "++id, bucket, season, cycle, itemKey, plannedQuantity, actualQuantity, updatedAt",
  logs: "++id, domain, level, ts, tag",
  cleaningPlans:
    "id, householdId, status, intensity, *zones, createdAt, updatedAt, lastCompletedAt",
  planningDrafts:
    "id, kind, domain, status, createdAt, updatedAt, homesteadPlanId, title",
  // Added compound indexes: [domain+createdAtISO] and [domain+ts]
  importRaw:
    "id, domain, createdAtISO, updatedAtISO, [domain+createdAtISO], source.kind, source.url",
  importNormalized:
    "id, rawId, domain, createdAtISO, updatedAtISO, [domain+createdAtISO], confidence.overall",
  importLinkMaps:
    "id, rawId, normId, domain, createdAtISO, updatedAtISO, [domain+createdAtISO]",
  importLogs: "id, domain, rawId, normId, linkMapId, ts, [domain+ts], level",
});

/**
 * ✅ v7: Import Pipeline conveniences (extra secondary indexes)
 */
db.version(7).stores({
  imports:
    "++id, type, subType, source, sourceUrl, importedAt, domain, fingerprint",
  sessions:
    "++id, sessionId, domain, status, startedAt, updatedAt, plannedFor, originImportId, legacyId",
  inventory:
    "++id, sku, name, location, category, quantity, unit, updatedAt, lowStockFlag",
  storehouse:
    "++id, bucket, season, cycle, itemKey, plannedQuantity, actualQuantity, updatedAt",
  logs: "++id, domain, level, ts, tag",
  cleaningPlans:
    "id, householdId, status, intensity, *zones, createdAt, updatedAt, lastCompletedAt",
  planningDrafts:
    "id, kind, domain, status, createdAt, updatedAt, homesteadPlanId, title",
  importRaw:
    "id, domain, createdAtISO, updatedAtISO, [domain+createdAtISO], [domain+fingerprint], fingerprint, source.kind, source.url",
  importNormalized:
    "id, rawId, domain, createdAtISO, updatedAtISO, [domain+createdAtISO], [domain+rawId], confidence.overall",
  importLinkMaps:
    "id, rawId, normId, domain, createdAtISO, updatedAtISO, [domain+createdAtISO], [domain+rawId], [domain+normId]",
  importLogs: "id, domain, rawId, normId, linkMapId, ts, [domain+ts], level",
});

/**
 * ✅ v8: Cooking Import Library tables
 */
db.version(8).stores({
  imports:
    "++id, type, subType, source, sourceUrl, importedAt, domain, fingerprint",
  sessions:
    "++id, sessionId, domain, status, startedAt, updatedAt, plannedFor, originImportId, legacyId",
  inventory:
    "++id, sku, name, location, category, quantity, unit, updatedAt, lowStockFlag",
  storehouse:
    "++id, bucket, season, cycle, itemKey, plannedQuantity, actualQuantity, updatedAt",
  logs: "++id, domain, level, ts, tag",
  cleaningPlans:
    "id, householdId, status, intensity, *zones, createdAt, updatedAt, lastCompletedAt",
  planningDrafts:
    "id, kind, domain, status, createdAt, updatedAt, homesteadPlanId, title",
  importRaw:
    "id, domain, createdAtISO, updatedAtISO, [domain+createdAtISO], [domain+fingerprint], fingerprint, source.kind, source.url",
  importNormalized:
    "id, rawId, domain, createdAtISO, updatedAtISO, [domain+createdAtISO], [domain+rawId], confidence.overall",
  importLinkMaps:
    "id, rawId, normId, domain, createdAtISO, updatedAtISO, [domain+createdAtISO], [domain+rawId], [domain+normId]",
  importLogs: "id, domain, rawId, normId, linkMapId, ts, [domain+ts], level",
  // --- Cooking libraries (NEW in v8) ---
  recipeLibrary:
    "id, sourceImportId, domain, createdAt, updatedAt, title, [domain+updatedAt]",
  kitchenTools:
    "id, name, category, createdAt, updatedAt, sourceImportId, [category+name]",
  kitchenUtensils:
    "id, name, category, createdAt, updatedAt, sourceImportId, [category+name]",
  kitchenEquipment:
    "id, name, category, createdAt, updatedAt, sourceImportId, [category+name]",
});

/**
 * ✅ v9: Session persistence support (checkpoints + kv)
 */
db.version(9).stores({
  imports:
    "++id, type, subType, source, sourceUrl, importedAt, domain, fingerprint",
  sessions:
    "++id, sessionId, domain, status, startedAt, updatedAt, plannedFor, originImportId, legacyId",
  inventory:
    "++id, sku, name, location, category, quantity, unit, updatedAt, lowStockFlag",
  storehouse:
    "++id, bucket, season, cycle, itemKey, plannedQuantity, actualQuantity, updatedAt",
  logs: "++id, domain, level, ts, tag",
  cleaningPlans:
    "id, householdId, status, intensity, *zones, createdAt, updatedAt, lastCompletedAt",
  planningDrafts:
    "id, kind, domain, status, createdAt, updatedAt, homesteadPlanId, title",
  importRaw:
    "id, domain, createdAtISO, updatedAtISO, [domain+createdAtISO], [domain+fingerprint], fingerprint, source.kind, source.url",
  importNormalized:
    "id, rawId, domain, createdAtISO, updatedAtISO, [domain+createdAtISO], [domain+rawId], confidence.overall",
  importLinkMaps:
    "id, rawId, normId, domain, createdAtISO, updatedAtISO, [domain+createdAtISO], [domain+rawId], [domain+normId]",
  importLogs: "id, domain, rawId, normId, linkMapId, ts, [domain+ts], level",
  recipeLibrary:
    "id, sourceImportId, domain, createdAt, updatedAt, title, [domain+updatedAt]",
  kitchenTools:
    "id, name, category, createdAt, updatedAt, sourceImportId, [category+name]",
  kitchenUtensils:
    "id, name, category, createdAt, updatedAt, sourceImportId, [category+name]",
  kitchenEquipment:
    "id, name, category, createdAt, updatedAt, sourceImportId, [category+name]",
  // ✅ NEW: Session checkpoints + key-value store
  sessionCheckpoints: "id, sessionId, domain, updatedAt, createdAt",
  kv: "key",
});

/**
 * ✅ v10: Nutrition tools support (ToolsHub.jsx)
 */
db.version(10).stores({
  imports:
    "++id, type, subType, source, sourceUrl, importedAt, domain, fingerprint",
  sessions:
    "++id, sessionId, domain, status, startedAt, updatedAt, plannedFor, originImportId, legacyId",
  inventory:
    "++id, sku, name, location, category, quantity, unit, updatedAt, lowStockFlag",
  storehouse:
    "++id, bucket, season, cycle, itemKey, plannedQuantity, actualQuantity, updatedAt",
  logs: "++id, domain, level, ts, tag",
  cleaningPlans:
    "id, householdId, status, intensity, *zones, createdAt, updatedAt, lastCompletedAt",
  planningDrafts:
    "id, kind, domain, status, createdAt, updatedAt, homesteadPlanId, title",
  importRaw:
    "id, domain, createdAtISO, updatedAtISO, [domain+createdAtISO], [domain+fingerprint], fingerprint, source.kind, source.url",
  importNormalized:
    "id, rawId, domain, createdAtISO, updatedAtISO, [domain+createdAtISO], [domain+rawId], confidence.overall",
  importLinkMaps:
    "id, rawId, normId, domain, createdAtISO, updatedAtISO, [domain+createdAtISO], [domain+rawId], [domain+normId]",
  importLogs: "id, domain, rawId, normId, linkMapId, ts, [domain+ts], level",
  recipeLibrary:
    "id, sourceImportId, domain, createdAt, updatedAt, title, [domain+updatedAt]",
  kitchenTools:
    "id, name, category, createdAt, updatedAt, sourceImportId, [category+name]",
  kitchenUtensils:
    "id, name, category, createdAt, updatedAt, sourceImportId, [category+name]",
  kitchenEquipment:
    "id, name, category, createdAt, updatedAt, sourceImportId, [category+name]",
  sessionCheckpoints: "id, sessionId, domain, updatedAt, createdAt",
  kv: "key",
  // ✅ NEW: Nutrition tools tables
  personProfiles:
    "id, householdId, name, sex, age, heightCm, weightKg, activityLevel, updatedAt",
  nutritionPreferences: "id, personId, goal, createdAt, updatedAt",
  toolRunLogs: "id, personId, tool, createdAt",
});

/**
 * ✅ v11: Nutrition → MealPlan → Grocery → Session Drafts
 */
db.version(11).stores({
  imports:
    "++id, type, subType, source, sourceUrl, importedAt, domain, fingerprint",
  sessions:
    "++id, sessionId, domain, status, startedAt, updatedAt, plannedFor, originImportId, legacyId",
  inventory:
    "++id, sku, name, location, category, quantity, unit, updatedAt, lowStockFlag",
  storehouse:
    "++id, bucket, season, cycle, itemKey, plannedQuantity, actualQuantity, updatedAt",
  logs: "++id, domain, level, ts, tag",
  cleaningPlans:
    "id, householdId, status, intensity, *zones, createdAt, updatedAt, lastCompletedAt",
  planningDrafts:
    "id, kind, domain, status, createdAt, updatedAt, homesteadPlanId, title",
  importRaw:
    "id, domain, createdAtISO, updatedAtISO, [domain+createdAtISO], [domain+fingerprint], fingerprint, source.kind, source.url",
  importNormalized:
    "id, rawId, domain, createdAtISO, updatedAtISO, [domain+createdAtISO], [domain+rawId], confidence.overall",
  importLinkMaps:
    "id, rawId, normId, domain, createdAtISO, updatedAtISO, [domain+createdAtISO], [domain+rawId], [domain+normId]",
  importLogs: "id, domain, rawId, normId, linkMapId, ts, [domain+ts], level",
  recipeLibrary:
    "id, sourceImportId, domain, createdAt, updatedAt, title, [domain+updatedAt]",
  kitchenTools:
    "id, name, category, createdAt, updatedAt, sourceImportId, [category+name]",
  kitchenUtensils:
    "id, name, category, createdAt, updatedAt, sourceImportId, [category+name]",
  kitchenEquipment:
    "id, name, category, createdAt, updatedAt, sourceImportId, [category+name]",
  sessionCheckpoints: "id, sessionId, domain, updatedAt, createdAt",
  kv: "key",
  personProfiles:
    "id, householdId, name, sex, age, heightCm, weightKg, activityLevel, updatedAt",
  nutritionPreferences: "id, personId, goal, createdAt, updatedAt",
  toolRunLogs: "id, personId, tool, createdAt",
  // ✅ NEW: Nutrition→MealPlan→Grocery→Session draft chain tables
  nutritionTargetsHistory: "id, householdId, personId, appliedAt, createdAt",
  mealPlanDrafts: "id, householdId, personId, targetsId, updatedAt, createdAt",
  groceryDrafts:
    "id, householdId, personId, targetsId, mealPlanId, updatedAt, createdAt",
  sessionDrafts:
    "id, householdId, personId, targetsId, mealPlanId, groceryId, updatedAt, createdAt",
  // ✅ NEW (patch): quick add drafts + audit trail (offline-first)
  quickAddDrafts:
    "id, createdAt, updatedAt, householdId, personId, detectedDomain, status",
  quickAddHistory:
    "id, createdAt, updatedAt, householdId, personId, domain, source",
});

/**
 * ✅ v12: Layer Spine tables (artifacts → parsed → method map → blueprint → overrides)
 */
db.version(12)
  .stores({
    imports:
      "++id, type, subType, source, sourceUrl, importedAt, domain, fingerprint",
    sessions:
      "++id, sessionId, domain, status, startedAt, updatedAt, plannedFor, originImportId, legacyId",
    inventory:
      "++id, sku, name, location, category, quantity, unit, updatedAt, lowStockFlag",
    storehouse:
      "++id, bucket, season, cycle, itemKey, plannedQuantity, actualQuantity, updatedAt",
    logs: "++id, domain, level, ts, tag",
    cleaningPlans:
      "id, householdId, status, intensity, *zones, createdAt, updatedAt, lastCompletedAt",
    planningDrafts:
      "id, kind, domain, status, createdAt, updatedAt, homesteadPlanId, title",
    importRaw:
      "id, domain, createdAtISO, updatedAtISO, [domain+createdAtISO], [domain+fingerprint], fingerprint, source.kind, source.url",
    importNormalized:
      "id, rawId, domain, createdAtISO, updatedAtISO, [domain+createdAtISO], [domain+rawId], confidence.overall",
    importLinkMaps:
      "id, rawId, normId, domain, createdAtISO, updatedAtISO, [domain+createdAtISO], [domain+rawId], [domain+normId]",
    importLogs: "id, domain, rawId, normId, linkMapId, ts, [domain+ts], level",
    recipeLibrary:
      "id, sourceImportId, domain, createdAt, updatedAt, title, [domain+updatedAt]",
    kitchenTools:
      "id, name, category, createdAt, updatedAt, sourceImportId, [category+name]",
    kitchenUtensils:
      "id, name, category, createdAt, updatedAt, sourceImportId, [category+name]",
    kitchenEquipment:
      "id, name, category, createdAt, updatedAt, sourceImportId, [category+name]",
    sessionCheckpoints: "id, sessionId, domain, updatedAt, createdAt",
    kv: "key",
    personProfiles:
      "id, householdId, name, sex, age, heightCm, weightKg, activityLevel, updatedAt",
    nutritionPreferences: "id, personId, goal, createdAt, updatedAt",
    toolRunLogs: "id, personId, tool, createdAt",
    nutritionTargetsHistory: "id, householdId, personId, appliedAt, createdAt",
    mealPlanDrafts:
      "id, householdId, personId, targetsId, updatedAt, createdAt",
    groceryDrafts:
      "id, householdId, personId, targetsId, mealPlanId, updatedAt, createdAt",
    sessionDrafts:
      "id, householdId, personId, targetsId, mealPlanId, groceryId, updatedAt, createdAt",
    quickAddDrafts:
      "id, createdAt, updatedAt, householdId, personId, detectedDomain, status",
    quickAddHistory:
      "id, createdAt, updatedAt, householdId, personId, domain, source",
    // ============================================================
    // NEW: Layer Spine tables (L0 → L3 + overrides + cache)
    // ============================================================
    artifacts:
      "++id, kind, domain, source, fingerprint, createdAt, updatedAt, status, sessionId, [kind+fingerprint], [domain+createdAt], [domain+status]",
    parsed_candidates:
      "++id, artifactId, domain, parser, fingerprint, createdAt, updatedAt, status, [artifactId+parser], [domain+createdAt], [domain+status]",
    method_maps:
      "++id, artifactId, candidateId, domain, methodKey, confidence, createdAt, updatedAt, status, [domain+methodKey], [candidateId+methodKey], [domain+status]",
    blueprints:
      "++id, domain, blueprintKey, createdAt, updatedAt, artifactId, candidateId, methodMapId, sessionId, status, [domain+createdAt], [domain+status], [domain+blueprintKey]",
    layer_overrides:
      "++id, scope, scopeId, domain, methodKey, createdAt, updatedAt, isActive, [scope+scopeId], [domain+methodKey], [scope+scopeId+domain], [scope+scopeId+domain+methodKey]",
    parse_cache: "fingerprint, createdAt, updatedAt, domain",
  })
  .upgrade(async () => {
    // New tables only — no destructive migration required.
    // Keep this hook for future backfills.
  });

/**
 * ✅ v13: Shopping Mode (staging + price observations + ad impressions + receipts)
 */
db.version(13)
  .stores({
    // ---------- carry forward v12 schema (must include ALL tables) ----------
    imports:
      "++id, type, subType, source, sourceUrl, importedAt, domain, fingerprint",
    sessions:
      "++id, sessionId, domain, status, startedAt, updatedAt, plannedFor, originImportId, legacyId",
    inventory:
      "++id, sku, name, location, category, quantity, unit, updatedAt, lowStockFlag",
    storehouse:
      "++id, bucket, season, cycle, itemKey, plannedQuantity, actualQuantity, updatedAt",
    logs: "++id, domain, level, ts, tag",
    cleaningPlans:
      "id, householdId, status, intensity, *zones, createdAt, updatedAt, lastCompletedAt",
    planningDrafts:
      "id, kind, domain, status, createdAt, updatedAt, homesteadPlanId, title",
    importRaw:
      "id, domain, createdAtISO, updatedAtISO, [domain+createdAtISO], [domain+fingerprint], fingerprint, source.kind, source.url",
    importNormalized:
      "id, rawId, domain, createdAtISO, updatedAtISO, [domain+createdAtISO], [domain+rawId], confidence.overall",
    importLinkMaps:
      "id, rawId, normId, domain, createdAtISO, updatedAtISO, [domain+createdAtISO], [domain+rawId], [domain+normId]",
    importLogs: "id, domain, rawId, normId, linkMapId, ts, [domain+ts], level",
    recipeLibrary:
      "id, sourceImportId, domain, createdAt, updatedAt, title, [domain+updatedAt]",
    kitchenTools:
      "id, name, category, createdAt, updatedAt, sourceImportId, [category+name]",
    kitchenUtensils:
      "id, name, category, createdAt, updatedAt, sourceImportId, [category+name]",
    kitchenEquipment:
      "id, name, category, createdAt, updatedAt, sourceImportId, [category+name]",
    sessionCheckpoints: "id, sessionId, domain, updatedAt, createdAt",
    kv: "key",
    personProfiles:
      "id, householdId, name, sex, age, heightCm, weightKg, activityLevel, updatedAt",
    nutritionPreferences: "id, personId, goal, createdAt, updatedAt",
    toolRunLogs: "id, personId, tool, createdAt",
    nutritionTargetsHistory: "id, householdId, personId, appliedAt, createdAt",
    mealPlanDrafts:
      "id, householdId, personId, targetsId, updatedAt, createdAt",
    groceryDrafts:
      "id, householdId, personId, targetsId, mealPlanId, updatedAt, createdAt",
    sessionDrafts:
      "id, householdId, personId, targetsId, mealPlanId, groceryId, updatedAt, createdAt",
    quickAddDrafts:
      "id, createdAt, updatedAt, householdId, personId, detectedDomain, status",
    quickAddHistory:
      "id, createdAt, updatedAt, householdId, personId, domain, source",
    artifacts:
      "++id, kind, domain, source, fingerprint, createdAt, updatedAt, status, sessionId, [kind+fingerprint], [domain+createdAt], [domain+status]",
    parsed_candidates:
      "++id, artifactId, domain, parser, fingerprint, createdAt, updatedAt, status, [artifactId+parser], [domain+createdAt], [domain+status]",
    method_maps:
      "++id, artifactId, candidateId, domain, methodKey, confidence, createdAt, updatedAt, status, [domain+methodKey], [candidateId+methodKey], [domain+status]",
    blueprints:
      "++id, domain, blueprintKey, createdAt, updatedAt, artifactId, candidateId, methodMapId, sessionId, status, [domain+createdAt], [domain+status], [domain+blueprintKey]",
    layer_overrides:
      "++id, scope, scopeId, domain, methodKey, createdAt, updatedAt, isActive, [scope+scopeId], [domain+methodKey], [scope+scopeId+domain], [scope+scopeId+domain+methodKey]",
    parse_cache: "fingerprint, createdAt, updatedAt, domain",
    // -------------------- NEW: Shopping Mode tables --------------------
    shoppingSessions:
      "id, householdId, userId, status, startedAt, endedAt, updatedAt, createdAt, sessionId, *storeIds, primaryStoreId, [householdId+startedAt], [householdId+status], [userId+startedAt]",
    shoppingCandidates:
      "candidateId, shoppingSessionId, householdId, userId, upc, sku, createdAt, updatedAt, status, storeId, [shoppingSessionId+createdAt], [shoppingSessionId+status], [storeId+upc], [householdId+createdAt], [upc+createdAt], fingerprint",
    priceObservations:
      "observationId, upc, storeId, storeChainId, observedAt, createdAt, [storeId+upc], [storeId+observedAt], [upc+observedAt], [storeChainId+upc], source, currency",
    adImpressions:
      "impressionId, householdId, userId, shoppingSessionId, storeId, upc, placementId, shownAt, createdAt, [shoppingSessionId+shownAt], [storeId+shownAt], [userId+shownAt], [placementId+shownAt], [upc+shownAt]",
    couponMatches:
      "matchId, upc, storeId, storeChainId, eligibleAt, expiresAt, createdAt, [storeId+upc], [upc+expiresAt], [storeChainId+upc], source, status",
    recallAlerts:
      "alertId, upc, brand, issuedAt, updatedAt, createdAt, status, severity, [upc+issuedAt], [brand+issuedAt], source",
    sponsoredPlacements:
      "placementId, provider, campaignId, storeId, storeChainId, upc, createdAt, updatedAt, status, [storeId+upc], [campaignId+createdAt], [provider+campaignId], caps.daily, caps.weekly",
    receiptReconciliations:
      "reconId, householdId, userId, shoppingSessionId, storeId, receiptFingerprint, receivedAt, status, createdAt, updatedAt, [shoppingSessionId+receivedAt], [receiptFingerprint+receivedAt], [householdId+receivedAt]",
  })
  .upgrade(async (tx) => {
    // Non-destructive, best-effort backfill:
    // - No required backfill for new tables.
    // Keep hook for future schema hardening.
    try {
      void tx;
    } catch {
      // ignore
    }
  });

/* -------------------------------------------------------------------------- */
/* Cuisine Profiles (AAI Cuisine) tables — version 14 */
/* -------------------------------------------------------------------------- */

/**
 * ✅ v14: Cuisine Profiles tables
 */
db.version(14)
  .stores({
    // ---------- carry forward v13 schema ----------
    imports:
      "++id, type, subType, source, sourceUrl, importedAt, domain, fingerprint",
    sessions:
      "++id, sessionId, domain, status, startedAt, updatedAt, plannedFor, originImportId, legacyId",
    inventory:
      "++id, sku, name, location, category, quantity, unit, updatedAt, lowStockFlag",
    storehouse:
      "++id, bucket, season, cycle, itemKey, plannedQuantity, actualQuantity, updatedAt",
    logs: "++id, domain, level, ts, tag",
    cleaningPlans:
      "id, householdId, status, intensity, *zones, createdAt, updatedAt, lastCompletedAt",
    planningDrafts:
      "id, kind, domain, status, createdAt, updatedAt, homesteadPlanId, title",
    importRaw:
      "id, domain, createdAtISO, updatedAtISO, [domain+createdAtISO], [domain+fingerprint], fingerprint, source.kind, source.url",
    importNormalized:
      "id, rawId, domain, createdAtISO, updatedAtISO, [domain+createdAtISO], [domain+rawId], confidence.overall",
    importLinkMaps:
      "id, rawId, normId, domain, createdAtISO, updatedAtISO, [domain+createdAtISO], [domain+rawId], [domain+normId]",
    importLogs: "id, domain, rawId, normId, linkMapId, ts, [domain+ts], level",
    recipeLibrary:
      "id, sourceImportId, domain, createdAt, updatedAt, title, [domain+updatedAt]",
    kitchenTools:
      "id, name, category, createdAt, updatedAt, sourceImportId, [category+name]",
    kitchenUtensils:
      "id, name, category, createdAt, updatedAt, sourceImportId, [category+name]",
    kitchenEquipment:
      "id, name, category, createdAt, updatedAt, sourceImportId, [category+name]",
    sessionCheckpoints: "id, sessionId, domain, updatedAt, createdAt",
    kv: "key",
    personProfiles:
      "id, householdId, name, sex, age, heightCm, weightKg, activityLevel, updatedAt",
    nutritionPreferences: "id, personId, goal, createdAt, updatedAt",
    toolRunLogs: "id, personId, tool, createdAt",
    nutritionTargetsHistory: "id, householdId, personId, appliedAt, createdAt",
    mealPlanDrafts:
      "id, householdId, personId, targetsId, updatedAt, createdAt",
    groceryDrafts:
      "id, householdId, personId, targetsId, mealPlanId, updatedAt, createdAt",
    sessionDrafts:
      "id, householdId, personId, targetsId, mealPlanId, groceryId, updatedAt, createdAt",
    quickAddDrafts:
      "id, createdAt, updatedAt, householdId, personId, detectedDomain, status",
    quickAddHistory:
      "id, createdAt, updatedAt, householdId, personId, domain, source",
    artifacts:
      "++id, kind, domain, source, fingerprint, createdAt, updatedAt, status, sessionId, [kind+fingerprint], [domain+createdAt], [domain+status]",
    parsed_candidates:
      "++id, artifactId, domain, parser, fingerprint, createdAt, updatedAt, status, [artifactId+parser], [domain+createdAt], [domain+status]",
    method_maps:
      "++id, artifactId, candidateId, domain, methodKey, confidence, createdAt, updatedAt, status, [domain+methodKey], [candidateId+methodKey], [domain+status]",
    blueprints:
      "++id, domain, blueprintKey, createdAt, updatedAt, artifactId, candidateId, methodMapId, sessionId, status, [domain+createdAt], [domain+status], [domain+blueprintKey]",
    layer_overrides:
      "++id, scope, scopeId, domain, methodKey, createdAt, updatedAt, isActive, [scope+scopeId], [domain+methodKey], [scope+scopeId+domain], [scope+scopeId+domain+methodKey]",
    parse_cache: "fingerprint, createdAt, updatedAt, domain",
    shoppingSessions:
      "id, householdId, userId, status, startedAt, endedAt, updatedAt, createdAt, sessionId, *storeIds, primaryStoreId, [householdId+startedAt], [householdId+status], [userId+startedAt]",
    shoppingCandidates:
      "candidateId, shoppingSessionId, householdId, userId, upc, sku, createdAt, updatedAt, status, storeId, [shoppingSessionId+createdAt], [shoppingSessionId+status], [storeId+upc], [householdId+createdAt], [upc+createdAt], fingerprint",
    priceObservations:
      "observationId, upc, storeId, storeChainId, observedAt, createdAt, [storeId+upc], [storeId+observedAt], [upc+observedAt], [storeChainId+upc], source, currency",
    adImpressions:
      "impressionId, householdId, userId, shoppingSessionId, storeId, upc, placementId, shownAt, createdAt, [shoppingSessionId+shownAt], [storeId+shownAt], [userId+shownAt], [placementId+shownAt], [upc+shownAt]",
    couponMatches:
      "matchId, upc, storeId, storeChainId, eligibleAt, expiresAt, createdAt, [storeId+upc], [upc+expiresAt], [storeChainId+upc], source, status",
    recallAlerts:
      "alertId, upc, brand, issuedAt, updatedAt, createdAt, status, severity, [upc+issuedAt], [brand+issuedAt], source",
    sponsoredPlacements:
      "placementId, provider, campaignId, storeId, storeChainId, upc, createdAt, updatedAt, status, [storeId+upc], [campaignId+createdAt], [provider+campaignId], caps.daily, caps.weekly",
    receiptReconciliations:
      "reconId, householdId, userId, shoppingSessionId, storeId, receiptFingerprint, receivedAt, status, createdAt, updatedAt, [shoppingSessionId+receivedAt], [receiptFingerprint+receivedAt], [householdId+receivedAt]",
    // ---------- NEW cuisine tables ----------
    cuisine_profiles: "++id,&key,name,enabledByDefault,createdAt,updatedAt",
    cuisine_rulesets:
      "++id,cuisineKey,versionTag,updatedAt,[cuisineKey+versionTag]",
    cuisine_user_prefs: "++id,householdId,updatedAt",
    cuisine_rotation_state:
      "++id,householdId,cuisineKey,weekIndex,updatedAt,[householdId+cuisineKey],[householdId+updatedAt]",
    // Optional indexes (safe to add now; can be used later for recipe linking)
    cuisine_recipe_index:
      "++id,recipeId,cuisineKey,updatedAt,[recipeId+cuisineKey],[cuisineKey+updatedAt]",
    preservation_outputs_index:
      "++id,householdId,itemKey,updatedAt,[householdId+itemKey],[itemKey+updatedAt]",
  })
  .upgrade(async (tx) => {
    // Non-destructive, best-effort backfill: nothing required.
    try {
      void tx;
    } catch {
      /* ignore */
    }
  });

/* -------------------------------------------------------------------------- */
/* Homestead Planner (Farm-to-Table / FTT) tables — version 15 */
/* -------------------------------------------------------------------------- */

/**
 * ✅ v15: Add/confirm tables used by Homestead Planner (FTT)
 */
db.version(15)
  .stores({
    // ---------- carry forward v14 schema ----------
    imports:
      "++id, type, subType, source, sourceUrl, importedAt, domain, fingerprint",
    sessions:
      "++id, sessionId, domain, status, startedAt, updatedAt, plannedFor, originImportId, legacyId",
    inventory:
      "++id, sku, name, location, category, quantity, unit, updatedAt, lowStockFlag",
    storehouse:
      "++id, bucket, season, cycle, itemKey, plannedQuantity, actualQuantity, updatedAt",
    logs: "++id, domain, level, ts, tag",
    cleaningPlans:
      "id, householdId, status, intensity, *zones, createdAt, updatedAt, lastCompletedAt",
    planningDrafts:
      "id, kind, domain, status, createdAt, updatedAt, homesteadPlanId, title",
    importRaw:
      "id, domain, createdAtISO, updatedAtISO, [domain+createdAtISO], [domain+fingerprint], fingerprint, source.kind, source.url",
    importNormalized:
      "id, rawId, domain, createdAtISO, updatedAtISO, [domain+createdAtISO], [domain+rawId], confidence.overall",
    importLinkMaps:
      "id, rawId, normId, domain, createdAtISO, updatedAtISO, [domain+createdAtISO], [domain+rawId], [domain+normId]",
    importLogs: "id, domain, rawId, normId, linkMapId, ts, [domain+ts], level",
    recipeLibrary:
      "id, sourceImportId, domain, createdAt, updatedAt, title, [domain+updatedAt]",
    kitchenTools:
      "id, name, category, createdAt, updatedAt, sourceImportId, [category+name]",
    kitchenUtensils:
      "id, name, category, createdAt, updatedAt, sourceImportId, [category+name]",
    kitchenEquipment:
      "id, name, category, createdAt, updatedAt, sourceImportId, [category+name]",
    sessionCheckpoints: "id, sessionId, domain, updatedAt, createdAt",
    kv: "key",
    personProfiles:
      "id, householdId, name, sex, age, heightCm, weightKg, activityLevel, updatedAt",
    nutritionPreferences: "id, personId, goal, createdAt, updatedAt",
    toolRunLogs: "id, personId, tool, createdAt",
    nutritionTargetsHistory: "id, householdId, personId, appliedAt, createdAt",
    mealPlanDrafts:
      "id, householdId, personId, targetsId, updatedAt, createdAt",
    groceryDrafts:
      "id, householdId, personId, targetsId, mealPlanId, updatedAt, createdAt",
    sessionDrafts:
      "id, householdId, personId, targetsId, mealPlanId, groceryId, updatedAt, createdAt",
    quickAddDrafts:
      "id, createdAt, updatedAt, householdId, personId, detectedDomain, status",
    quickAddHistory:
      "id, createdAt, updatedAt, householdId, personId, domain, source",
    artifacts:
      "++id, kind, domain, source, fingerprint, createdAt, updatedAt, status, sessionId, [kind+fingerprint], [domain+createdAt], [domain+status]",
    parsed_candidates:
      "++id, artifactId, domain, parser, fingerprint, createdAt, updatedAt, status, [artifactId+parser], [domain+createdAt], [domain+status]",
    method_maps:
      "++id, artifactId, candidateId, domain, methodKey, confidence, createdAt, updatedAt, status, [domain+methodKey], [candidateId+methodKey], [domain+status]",
    blueprints:
      "++id, domain, blueprintKey, createdAt, updatedAt, artifactId, candidateId, methodMapId, sessionId, status, [domain+createdAt], [domain+status], [domain+blueprintKey]",
    layer_overrides:
      "++id, scope, scopeId, domain, methodKey, createdAt, updatedAt, isActive, [scope+scopeId], [domain+methodKey], [scope+scopeId+domain], [scope+scopeId+domain+methodKey]",
    parse_cache: "fingerprint, createdAt, updatedAt, domain",
    shoppingSessions:
      "id, householdId, userId, status, startedAt, endedAt, updatedAt, createdAt, sessionId, *storeIds, primaryStoreId, [householdId+startedAt], [householdId+status], [userId+startedAt]",
    shoppingCandidates:
      "candidateId, shoppingSessionId, householdId, userId, upc, sku, createdAt, updatedAt, status, storeId, [shoppingSessionId+createdAt], [shoppingSessionId+status], [storeId+upc], [householdId+createdAt], [upc+createdAt], fingerprint",
    priceObservations:
      "observationId, upc, storeId, storeChainId, observedAt, createdAt, [storeId+upc], [storeId+observedAt], [upc+observedAt], [storeChainId+upc], source, currency",
    adImpressions:
      "impressionId, householdId, userId, shoppingSessionId, storeId, upc, placementId, shownAt, createdAt, [shoppingSessionId+shownAt], [storeId+shownAt], [userId+shownAt], [placementId+shownAt], [upc+shownAt]",
    couponMatches:
      "matchId, upc, storeId, storeChainId, eligibleAt, expiresAt, createdAt, [storeId+upc], [upc+expiresAt], [storeChainId+upc], source, status",
    recallAlerts:
      "alertId, upc, brand, issuedAt, updatedAt, createdAt, status, severity, [upc+issuedAt], [brand+issuedAt], source",
    sponsoredPlacements:
      "placementId, provider, campaignId, storeId, storeChainId, upc, createdAt, updatedAt, status, [storeId+upc], [campaignId+createdAt], [provider+campaignId], caps.daily, caps.weekly",
    receiptReconciliations:
      "reconId, householdId, userId, shoppingSessionId, storeId, receiptFingerprint, receivedAt, status, createdAt, updatedAt, [shoppingSessionId+receivedAt], [receiptFingerprint+receivedAt], [householdId+receivedAt]",
    cuisine_profiles: "++id,&key,name,enabledByDefault,createdAt,updatedAt",
    cuisine_rulesets:
      "++id,cuisineKey,versionTag,updatedAt,[cuisineKey+versionTag]",
    cuisine_user_prefs: "++id,householdId,updatedAt",
    cuisine_rotation_state:
      "++id,householdId,cuisineKey,weekIndex,updatedAt,[householdId+cuisineKey],[householdId+updatedAt]",
    cuisine_recipe_index:
      "++id,recipeId,cuisineKey,updatedAt,[recipeId+cuisineKey],[cuisineKey+updatedAt]",
    preservation_outputs_index:
      "++id,householdId,itemKey,updatedAt,[householdId+itemKey],[itemKey+updatedAt]",

    // =========================
    // NEW: Homestead Planner FTT
    // =========================
    // Household-level preferences: pantry goals, scratch-cooking %, cadence, cuisine rotation, etc.
    ftt_preferences_household:
      "id, householdId, updatedAt, createdAt, status, [householdId+updatedAt], [householdId+status]",
    // Person-level preferences: allergens, macros targets, dislikes, activity, roles, etc.
    ftt_preferences_people:
      "id, householdId, personId, updatedAt, createdAt, status, [householdId+personId], [personId+updatedAt], [householdId+updatedAt], [householdId+status]",
    // Session overrides: temporary adjustments that affect provisioning + planning (feasts, travel, sick days)
    ftt_preferences_session_overrides:
      "id, householdId, appliesToISO, updatedAt, createdAt, status, [householdId+appliesToISO], [householdId+updatedAt], [householdId+status]",
    // Provisioning targets: computed outputs (what to stock / produce / purchase) for a horizon window
    ftt_provisioning_targets:
      "id, householdId, horizonStartISO, horizonDays, updatedAt, createdAt, status, [householdId+horizonStartISO], [householdId+updatedAt], [householdId+status]",
    // Component inventory: normalized components used by FTT planning (SSA-local view; can map to inventory/storehouse)
    ftt_component_inventory:
      "id, householdId, componentKey, itemKey, updatedAt, createdAt, [householdId+componentKey], [householdId+itemKey], [componentKey+updatedAt], [itemKey+updatedAt]",
    // Component batches: batch-prep outputs (cooked beans, broth, chopped veg) and preservation runs tied to components
    ftt_component_batches:
      "id, householdId, componentKey, batchDateISO, updatedAt, createdAt, status, [householdId+componentKey], [householdId+batchDateISO], [componentKey+batchDateISO], [status+batchDateISO]",
    // FTT Plans: a saved homestead plan run (inputs + outputs + reasoning summary + snapshots)
    ftt_plans:
      "id, householdId, startISO, horizonDays, updatedAt, createdAt, status, title, [householdId+updatedAt], [householdId+status], [householdId+startISO]",
    // Plan items: normalized line-items inside a plan (targets, gaps, actions, garden/animal suggestions, tasks)
    ftt_plan_items:
      "id, planId, householdId, kind, itemKey, componentKey, updatedAt, createdAt, status, [planId+kind], [planId+status], [householdId+updatedAt], [itemKey+updatedAt], [componentKey+updatedAt]",
  })
  .upgrade(async (tx) => {
    // New tables only — no backfill required.
    try {
      void tx;
    } catch {
      /* ignore */
    }
  });

/* -------------------------------------------------------------------------- */
/* Homestead Profile + Visibility + Estimators — version 16 */
/* -------------------------------------------------------------------------- */
/**
 * ✅ v16: Add/confirm tables:
 * - homestead_profile
 *   • selected level, enabled domains, goals
 * - homestead_visibility_state (optional)
 *   • dismissed helper panels, collapsed sections, “don’t show again”
 * - estimator_baselines
 *   • grocery spend, eating-out frequency, household size, meals/week
 * - estimator_snapshots
 *   • computed outputs (food security %, days covered, monthly savings) over time
 *
 * IMPORTANT:
 * - Carry forward ALL v15 tables unchanged.
 * - Add new tables only (safe additive change).
 */
db.version(16)
  .stores({
    // ---------- carry forward v15 schema ----------
    imports:
      "++id, type, subType, source, sourceUrl, importedAt, domain, fingerprint",
    sessions:
      "++id, sessionId, domain, status, startedAt, updatedAt, plannedFor, originImportId, legacyId",
    inventory:
      "++id, sku, name, location, category, quantity, unit, updatedAt, lowStockFlag",
    storehouse:
      "++id, bucket, season, cycle, itemKey, plannedQuantity, actualQuantity, updatedAt",
    logs: "++id, domain, level, ts, tag",
    cleaningPlans:
      "id, householdId, status, intensity, *zones, createdAt, updatedAt, lastCompletedAt",
    planningDrafts:
      "id, kind, domain, status, createdAt, updatedAt, homesteadPlanId, title",
    importRaw:
      "id, domain, createdAtISO, updatedAtISO, [domain+createdAtISO], [domain+fingerprint], fingerprint, source.kind, source.url",
    importNormalized:
      "id, rawId, domain, createdAtISO, updatedAtISO, [domain+createdAtISO], [domain+rawId], confidence.overall",
    importLinkMaps:
      "id, rawId, normId, domain, createdAtISO, updatedAtISO, [domain+createdAtISO], [domain+rawId], [domain+normId]",
    importLogs: "id, domain, rawId, normId, linkMapId, ts, [domain+ts], level",
    recipeLibrary:
      "id, sourceImportId, domain, createdAt, updatedAt, title, [domain+updatedAt]",
    kitchenTools:
      "id, name, category, createdAt, updatedAt, sourceImportId, [category+name]",
    kitchenUtensils:
      "id, name, category, createdAt, updatedAt, sourceImportId, [category+name]",
    kitchenEquipment:
      "id, name, category, createdAt, updatedAt, sourceImportId, [category+name]",
    sessionCheckpoints: "id, sessionId, domain, updatedAt, createdAt",
    kv: "key",
    personProfiles:
      "id, householdId, name, sex, age, heightCm, weightKg, activityLevel, updatedAt",
    nutritionPreferences: "id, personId, goal, createdAt, updatedAt",
    toolRunLogs: "id, personId, tool, createdAt",
    nutritionTargetsHistory: "id, householdId, personId, appliedAt, createdAt",
    mealPlanDrafts:
      "id, householdId, personId, targetsId, updatedAt, createdAt",
    groceryDrafts:
      "id, householdId, personId, targetsId, mealPlanId, updatedAt, createdAt",
    sessionDrafts:
      "id, householdId, personId, targetsId, mealPlanId, groceryId, updatedAt, createdAt",
    quickAddDrafts:
      "id, createdAt, updatedAt, householdId, personId, detectedDomain, status",
    quickAddHistory:
      "id, createdAt, updatedAt, householdId, personId, domain, source",
    artifacts:
      "++id, kind, domain, source, fingerprint, createdAt, updatedAt, status, sessionId, [kind+fingerprint], [domain+createdAt], [domain+status]",
    parsed_candidates:
      "++id, artifactId, domain, parser, fingerprint, createdAt, updatedAt, status, [artifactId+parser], [domain+createdAt], [domain+status]",
    method_maps:
      "++id, artifactId, candidateId, domain, methodKey, confidence, createdAt, updatedAt, status, [domain+methodKey], [candidateId+methodKey], [domain+status]",
    blueprints:
      "++id, domain, blueprintKey, createdAt, updatedAt, artifactId, candidateId, methodMapId, sessionId, status, [domain+createdAt], [domain+status], [domain+blueprintKey]",
    layer_overrides:
      "++id, scope, scopeId, domain, methodKey, createdAt, updatedAt, isActive, [scope+scopeId], [domain+methodKey], [scope+scopeId+domain], [scope+scopeId+domain+methodKey]",
    parse_cache: "fingerprint, createdAt, updatedAt, domain",
    shoppingSessions:
      "id, householdId, userId, status, startedAt, endedAt, updatedAt, createdAt, sessionId, *storeIds, primaryStoreId, [householdId+startedAt], [householdId+status], [userId+startedAt]",
    shoppingCandidates:
      "candidateId, shoppingSessionId, householdId, userId, upc, sku, createdAt, updatedAt, status, storeId, [shoppingSessionId+createdAt], [shoppingSessionId+status], [storeId+upc], [householdId+createdAt], [upc+createdAt], fingerprint",
    priceObservations:
      "observationId, upc, storeId, storeChainId, observedAt, createdAt, [storeId+upc], [storeId+observedAt], [upc+observedAt], [storeChainId+upc], source, currency",
    adImpressions:
      "impressionId, householdId, userId, shoppingSessionId, storeId, upc, placementId, shownAt, createdAt, [shoppingSessionId+shownAt], [storeId+shownAt], [userId+shownAt], [placementId+shownAt], [upc+shownAt]",
    couponMatches:
      "matchId, upc, storeId, storeChainId, eligibleAt, expiresAt, createdAt, [storeId+upc], [upc+expiresAt], [storeChainId+upc], source, status",
    recallAlerts:
      "alertId, upc, brand, issuedAt, updatedAt, createdAt, status, severity, [upc+issuedAt], [brand+issuedAt], source",
    sponsoredPlacements:
      "placementId, provider, campaignId, storeId, storeChainId, upc, createdAt, updatedAt, status, [storeId+upc], [campaignId+createdAt], [provider+campaignId], caps.daily, caps.weekly",
    receiptReconciliations:
      "reconId, householdId, userId, shoppingSessionId, storeId, receiptFingerprint, receivedAt, status, createdAt, updatedAt, [shoppingSessionId+receivedAt], [receiptFingerprint+receivedAt], [householdId+receivedAt]",
    cuisine_profiles: "++id,&key,name,enabledByDefault,createdAt,updatedAt",
    cuisine_rulesets:
      "++id,cuisineKey,versionTag,updatedAt,[cuisineKey+versionTag]",
    cuisine_user_prefs: "++id,householdId,updatedAt",
    cuisine_rotation_state:
      "++id,householdId,cuisineKey,weekIndex,updatedAt,[householdId+cuisineKey],[householdId+updatedAt]",
    cuisine_recipe_index:
      "++id,recipeId,cuisineKey,updatedAt,[recipeId+cuisineKey],[cuisineKey+updatedAt]",
    preservation_outputs_index:
      "++id,householdId,itemKey,updatedAt,[householdId+itemKey],[itemKey+updatedAt]",

    // ---------- FTT tables (confirmed) ----------
    ftt_preferences_household:
      "id, householdId, updatedAt, createdAt, status, [householdId+updatedAt], [householdId+status]",
    ftt_preferences_people:
      "id, householdId, personId, updatedAt, createdAt, status, [householdId+personId], [personId+updatedAt], [householdId+updatedAt], [householdId+status]",
    ftt_preferences_session_overrides:
      "id, householdId, appliesToISO, updatedAt, createdAt, status, [householdId+appliesToISO], [householdId+updatedAt], [householdId+status]",
    ftt_provisioning_targets:
      "id, householdId, horizonStartISO, horizonDays, updatedAt, createdAt, status, [householdId+horizonStartISO], [householdId+updatedAt], [householdId+status]",
    ftt_component_inventory:
      "id, householdId, componentKey, itemKey, updatedAt, createdAt, [householdId+componentKey], [householdId+itemKey], [componentKey+updatedAt], [itemKey+updatedAt]",
    ftt_component_batches:
      "id, householdId, componentKey, batchDateISO, updatedAt, createdAt, status, [householdId+componentKey], [householdId+batchDateISO], [componentKey+batchDateISO], [status+batchDateISO]",
    ftt_plans:
      "id, householdId, startISO, horizonDays, updatedAt, createdAt, status, title, [householdId+updatedAt], [householdId+status], [householdId+startISO]",
    ftt_plan_items:
      "id, planId, householdId, kind, itemKey, componentKey, updatedAt, createdAt, status, [planId+kind], [planId+status], [householdId+updatedAt], [itemKey+updatedAt], [componentKey+updatedAt]",

    // ================================
    // NEW: Homestead profile + visibility
    // ================================
    homestead_profile:
      "id, householdId, selectedLevel, status, updatedAt, createdAt, [householdId+updatedAt], [householdId+status], [householdId+selectedLevel]",
    homestead_visibility_state:
      "id, householdId, viewKey, updatedAt, createdAt, [householdId+viewKey], [householdId+updatedAt]",

    // ================================
    // NEW: Estimators (baselines + snapshots)
    // ================================
    estimator_baselines:
      "id, householdId, status, updatedAt, createdAt, [householdId+updatedAt], [householdId+status]",
    estimator_snapshots:
      "id, householdId, kind, computedAt, updatedAt, createdAt, [householdId+computedAt], [householdId+kind], [kind+computedAt]",
  })
  .upgrade(async (tx) => {
    // New tables only — no backfill required.
    try {
      void tx;
    } catch {
      /* ignore */
    }
  });

/* -------------------------------------------------------------------------- */
/* Dexie hooks → SSA events (+ optional Hub export) */
/* -------------------------------------------------------------------------- */

/**
 * Configure which tables should emit which events.
 *
 * - eventType: high-level event name used by automation / UI.
 * - hubDomain: which domain label to send to the Hub when exporting.
 * - exportToHub: whether this table change is considered “household data”
 *   and should be mirrored to the Hub when familyFundMode=true.
 */
const HOOK_CONFIG = {
  inventory: {
    eventType: "inventory.updated",
    hubDomain: "inventory",
    exportToHub: true,
  },
  storehouse: {
    eventType: "storehouse.updated",
    hubDomain: "storehouse",
    exportToHub: true,
  },
  sessions: {
    eventType: "session.changed",
    hubDomain: "sessions",
    exportToHub: true,
  },
  imports: {
    eventType: "import.parsed",
    hubDomain: "imports",
    exportToHub: false, // imports are metadata; not always needed by Hub
  },

  // NEW: planning drafts should emit events for UI refresh + planner surfacing,
  // but should NOT be auto-exported to Hub by default (keep SSA local-first).
  planningDrafts: {
    eventType: "planningDraft.changed",
    hubDomain: "planningDrafts",
    exportToHub: false,
  },

  // Import pipeline tables should emit events (local-first)
  importRaw: {
    eventType: "import.raw.changed",
    hubDomain: "importRaw",
    exportToHub: false,
  },
  importNormalized: {
    eventType: "import.normalized.changed",
    hubDomain: "importNormalized",
    exportToHub: false,
  },
  importLinkMaps: {
    eventType: "import.linkmap.changed",
    hubDomain: "importLinkMaps",
    exportToHub: false,
  },
  importLogs: {
    eventType: "import.logs.changed",
    hubDomain: "importLogs",
    exportToHub: false,
  },

  // Cooking libraries (local-first; do not auto-export)
  recipeLibrary: {
    eventType: "cooking.recipes.changed",
    hubDomain: "recipeLibrary",
    exportToHub: false,
  },
  kitchenTools: {
    eventType: "cooking.tools.changed",
    hubDomain: "kitchenTools",
    exportToHub: false,
  },
  kitchenUtensils: {
    eventType: "cooking.utensils.changed",
    hubDomain: "kitchenUtensils",
    exportToHub: false,
  },
  kitchenEquipment: {
    eventType: "cooking.equipment.changed",
    hubDomain: "kitchenEquipment",
    exportToHub: false,
  },

  // NEW: session checkpoints + kv should emit lightweight events (no Hub export)
  sessionCheckpoints: {
    eventType: "session.checkpoint.changed",
    hubDomain: "sessionCheckpoints",
    exportToHub: false,
  },
  kv: { eventType: "kv.changed", hubDomain: "kv", exportToHub: false },

  // ✅ NEW: Nutrition tools tables (ToolsHub.jsx)
  personProfiles: {
    eventType: "nutrition.profile.updated",
    hubDomain: "personProfiles",
    exportToHub: false,
  },
  nutritionPreferences: {
    eventType: "nutrition.preferences.updated",
    hubDomain: "nutritionPreferences",
    exportToHub: false,
  },
  toolRunLogs: {
    eventType: "nutrition.toolrun.logged",
    hubDomain: "toolRunLogs",
    exportToHub: false,
  },

  // ✅ NEW: Draft chain tables (Nutrition → MealPlan → Grocery → Session)
  nutritionTargetsHistory: {
    eventType: "nutrition.targets.history.changed",
    hubDomain: "nutritionTargetsHistory",
    exportToHub: false,
  },
  mealPlanDrafts: {
    eventType: "mealplan.draft.changed",
    hubDomain: "mealPlanDrafts",
    exportToHub: false,
  },
  groceryDrafts: {
    eventType: "grocery.draft.changed",
    hubDomain: "groceryDrafts",
    exportToHub: false,
  },
  sessionDrafts: {
    eventType: "session.draft.changed",
    hubDomain: "sessionDrafts",
    exportToHub: false,
  },

  // ✅ NEW (patch): Quick Add tables should emit UI refresh events (no Hub export)
  quickAddDrafts: {
    eventType: "quickadd.draft.changed",
    hubDomain: "quickAddDrafts",
    exportToHub: false,
  },
  quickAddHistory: {
    eventType: "quickadd.history.changed",
    hubDomain: "quickAddHistory",
    exportToHub: false,
  },

  // ✅ NEW: Layer Spine events (local-first)
  artifacts: {
    eventType: "layers.artifact.changed",
    hubDomain: "artifacts",
    exportToHub: false,
  },
  parsed_candidates: {
    eventType: "layers.parsed.changed",
    hubDomain: "parsed_candidates",
    exportToHub: false,
  },
  method_maps: {
    eventType: "layers.methodmap.changed",
    hubDomain: "method_maps",
    exportToHub: false,
  },
  blueprints: {
    eventType: "layers.blueprint.changed",
    hubDomain: "blueprints",
    exportToHub: false,
  },
  layer_overrides: {
    eventType: "layers.override.changed",
    hubDomain: "layer_overrides",
    exportToHub: false,
  },
  parse_cache: {
    eventType: "layers.parsecache.changed",
    hubDomain: "parse_cache",
    exportToHub: false,
  },

  // ✅ NEW: Shopping Mode events (scan → receipt → commit)
  shoppingSessions: {
    eventType: "shopping.session.changed",
    hubDomain: "shoppingSessions",
    exportToHub: false,
  },
  shoppingCandidates: {
    eventType: "shopping.candidate.changed",
    hubDomain: "shoppingCandidates",
    exportToHub: false,
  },
  priceObservations: {
    eventType: "shopping.price.observed",
    hubDomain: "priceObservations",
    exportToHub: false,
  },
  adImpressions: {
    eventType: "ads.impression.logged",
    hubDomain: "adImpressions",
    exportToHub: false,
  },
  couponMatches: {
    eventType: "shopping.coupon.match.changed",
    hubDomain: "couponMatches",
    exportToHub: false,
  },
  recallAlerts: {
    eventType: "shopping.recall.alert.changed",
    hubDomain: "recallAlerts",
    exportToHub: false,
  },
  sponsoredPlacements: {
    eventType: "ads.sponsored.placement.changed",
    hubDomain: "sponsoredPlacements",
    exportToHub: false,
  },
  receiptReconciliations: {
    eventType: "shopping.receipt.reconciled",
    hubDomain: "receiptReconciliations",
    exportToHub: false,
  },

  // ✅ NEW: Homestead Planner (FTT) events (local-first)
  ftt_preferences_household: {
    eventType: "ftt.preferences.household.changed",
    hubDomain: "ftt_preferences_household",
    exportToHub: false,
  },
  ftt_preferences_people: {
    eventType: "ftt.preferences.people.changed",
    hubDomain: "ftt_preferences_people",
    exportToHub: false,
  },
  ftt_preferences_session_overrides: {
    eventType: "ftt.preferences.sessionOverrides.changed",
    hubDomain: "ftt_preferences_session_overrides",
    exportToHub: false,
  },
  ftt_provisioning_targets: {
    eventType: "ftt.provisioning.targets.changed",
    hubDomain: "ftt_provisioning_targets",
    exportToHub: false,
  },
  ftt_component_inventory: {
    eventType: "ftt.component.inventory.changed",
    hubDomain: "ftt_component_inventory",
    exportToHub: false,
  },
  ftt_component_batches: {
    eventType: "ftt.component.batches.changed",
    hubDomain: "ftt_component_batches",
    exportToHub: false,
  },
  ftt_plans: {
    eventType: "ftt.plan.changed",
    hubDomain: "ftt_plans",
    exportToHub: false,
  },
  ftt_plan_items: {
    eventType: "ftt.plan.items.changed",
    hubDomain: "ftt_plan_items",
    exportToHub: false,
  },

  // logs table intentionally does not emit events to avoid infinite loops.
};

function attachTableHooks() {
  Object.entries(HOOK_CONFIG).forEach(([tableName, config]) => {
    let table = null;

    try {
      table = db.table(tableName);
    } catch {
      table = null;
    }

    if (!table) {
      if (import.meta?.env?.DEV) {
        console.warn(
          `[db] Table "${tableName}" not found when attaching hooks.`,
        );
      }
      return;
    }

    // CREATE
    table.hook("creating", function (primaryKey, obj) {
      const payload = {
        op: "create",
        table: tableName,
        key: primaryKey,
        value: obj,
      };

      emitEvent(config.eventType, "db.hook", payload);

      if (config.exportToHub) {
        // Fire-and-forget; ignore returned promise.
        void exportToHubIfEnabled(config.hubDomain, payload);
      }
    });

    // UPDATE
    table.hook("updating", function (mods, primaryKey, obj) {
      const payload = {
        op: "update",
        table: tableName,
        key: primaryKey,
        mods,
        previousValue: obj,
      };

      emitEvent(config.eventType, "db.hook", payload);

      if (config.exportToHub) {
        void exportToHubIfEnabled(config.hubDomain, payload);
      }

      // Return mods unchanged so Dexie applies them as normal.
      return mods;
    });

    // DELETE
    table.hook("deleting", function (primaryKey, obj) {
      const payload = {
        op: "delete",
        table: tableName,
        key: primaryKey,
        previousValue: obj,
      };

      emitEvent(config.eventType, "db.hook", payload);

      if (config.exportToHub) {
        void exportToHubIfEnabled(config.hubDomain, payload);
      }
    });
  });
}

// Attach hooks immediately at module load.
attachTableHooks();

/* -------------------------------------------------------------------------- */
/* Public API */
/* -------------------------------------------------------------------------- */

/**
 * Convenience helper for transactional work.
 *
 * Example usage in a repo:
 * import db, { runInTransaction } from "../services/db";
 *
 * await runInTransaction("rw", ["inventory", "storehouse"], async (txDb) => {
 *   await txDb.inventory.put({...});
 *   await txDb.storehouse.put({...});
 * });
 *
 * @param {"r"|"rw"} mode Transaction mode.
 * @param {string[]} tables Table names participating in the transaction.
 * @param {Function} worker Async function that receives a transactional db.
 */
export async function runInTransaction(mode, tables, worker) {
  if (!Array.isArray(tables) || tables.length === 0) {
    throw new Error("[db.runInTransaction] tables must be a non-empty array");
  }

  return db.transaction(mode, tables, async (txDb) => {
    return worker(txDb);
  });
}

/**
 * ✅ Canonical session persistence helper
 *
 * Option A: sessionId is the canonical stable identifier for routing/resume.
 * - Primary key remains numeric (id) to avoid Dexie PK change errors.
 * - We UPSERT by sessionId (find existing row → update by numeric id).
 * - We also mirror id (string) field for back-compat with callers that expect session.id
 *   to be routable.
 *
 * In this implementation:
 * - session.sessionId is canonical
 * - session.id (string alias) === session.sessionId
 * - session.dbId is the numeric primary key (if present)
 *
 * @param {object} session
 * @returns {Promise<object>} saved session (with sessionId + dbId + id alias)
 */
export async function saveSession(session) {
  if (!session || typeof session !== "object") {
    throw new Error("[db.saveSession] session must be an object");
  }

  const domain =
    String(session.domain || "")
      .toLowerCase()
      .trim() || "unknown";

  // Canonical stable id for play routes.
  const sessionIdRaw =
    session.sessionId || session.id || session._id || session.sid;
  const sessionId = sessionIdRaw ? String(sessionIdRaw) : makeId(domain);

  const now = nowIso();

  const normalized = {
    ...session,
    // Canonical
    sessionId,
    // Back-compat alias: many pages currently navigate using session.id
    // We want that to be the stable string id (NOT the numeric db PK).
    id: sessionId,
    domain,
    status: session.status || "draft",
    createdAt: session.createdAt || now,
    updatedAt: now,
    steps: Array.isArray(session.steps) ? session.steps : [],
  };

  if (!db.sessions) {
    throw new Error("[db.saveSession] db.sessions store missing");
  }

  // UPSERT by sessionId without changing the numeric PK.
  // If exists → update that row by numeric id.
  // Else → add a new row; Dexie assigns numeric id.
  let dbId = null;

  try {
    const existing = await db.sessions
      .where("sessionId")
      .equals(sessionId)
      .first();

    if (existing && typeof existing.id === "number") {
      dbId = existing.id;
      await db.sessions.update(dbId, normalized);
    } else {
      dbId = await db.sessions.add(normalized);
    }
  } catch (err) {
    if (import.meta?.env?.DEV) {
      console.warn(
        "[db.saveSession] upsert by sessionId failed; falling back to put:",
        err,
      );
    }
    // Fallback: put may insert/update depending on id numeric PK presence in object.
    // Ensure we never pass the string alias id as a numeric PK by deleting it temporarily.
    const { id: _stringId, ...withoutStringId } = normalized;
    dbId = await db.sessions.put(withoutStringId);
  }

  return {
    ...normalized,
    dbId, // numeric PK
  };
}

/**
 * ✅ Convenience loader used by Play routes
 * - First: treat id as sessionId (canonical)
 * - Fallback: if id looks numeric, try numeric PK lookup
 *
 * @param {string|number} id
 */
export async function getSessionById(id) {
  if (id == null || id === "") return null;
  if (!db.sessions) return null;

  const asString = String(id);

  try {
    // Canonical: look up by sessionId index
    const bySessionId = await db.sessions
      .where("sessionId")
      .equals(asString)
      .first();

    if (bySessionId) {
      return {
        ...bySessionId,
        // ensure alias consistency
        sessionId: bySessionId.sessionId || asString,
        id: bySessionId.sessionId || asString,
        dbId: typeof bySessionId.id === "number" ? bySessionId.id : null,
      };
    }

    // Fallback: numeric primary key
    const maybeNum = Number(asString);
    if (!Number.isNaN(maybeNum) && Number.isFinite(maybeNum)) {
      const byPk = await db.sessions.get(maybeNum);
      if (byPk) {
        return {
          ...byPk,
          sessionId: byPk.sessionId || String(byPk.id),
          id: byPk.sessionId || String(byPk.id),
          dbId: typeof byPk.id === "number" ? byPk.id : null,
        };
      }
    }

    return null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Planning Drafts helpers (optional convenience API) */
/* -------------------------------------------------------------------------- */

/**
 * Optional helpers to keep planning drafts consistent across pages.
 * These are NOT required if you use a dedicated repo file, but are convenient.
 */
export async function savePlanningDraft(draft) {
  if (!draft || typeof draft !== "object") {
    throw new Error("[db.savePlanningDraft] draft must be an object");
  }
  if (!db.planningDrafts) {
    throw new Error("[db.savePlanningDraft] db.planningDrafts store missing");
  }

  const now = nowIso();

  const normalized = {
    id: draft.id ? String(draft.id) : makeId("draft"),
    kind: String(draft.kind || "unknown.draft"),
    domain: String(draft.domain || "unknown"),
    title: String(draft.title || "Draft"),
    status: String(draft.status || "draft"),
    createdAt: draft.createdAt || now,
    updatedAt: now,
    homesteadPlanId:
      draft.homesteadPlanId == null ? null : String(draft.homesteadPlanId),
    inputs:
      draft.inputs && typeof draft.inputs === "object" ? draft.inputs : {},
    outputs:
      draft.outputs && typeof draft.outputs === "object" ? draft.outputs : {},
    links: draft.links && typeof draft.links === "object" ? draft.links : {},
    metadata:
      draft.metadata && typeof draft.metadata === "object"
        ? draft.metadata
        : { version: 1 },
  };

  await db.planningDrafts.put(normalized);

  // Emit a domain-level event consumers can listen to for UI refresh.
  emitEvent("planningDraft.saved", "db.api", {
    id: normalized.id,
    kind: normalized.kind,
    domain: normalized.domain,
    status: normalized.status,
    updatedAt: normalized.updatedAt,
  });

  return normalized;
}

export async function listPlanningDrafts({
  kind,
  domain,
  status,
  limit = 25,
} = {}) {
  if (!db.planningDrafts) return [];

  let rows = [];

  // Dexie doesn't support multi-where on separate indexes without compound indexes.
  // For local-first scale, we keep it simple: use indexed query when possible, then filter.
  if (kind) {
    rows = await db.planningDrafts.where("kind").equals(kind).toArray();
  } else if (domain) {
    rows = await db.planningDrafts.where("domain").equals(domain).toArray();
  } else if (status) {
    rows = await db.planningDrafts.where("status").equals(status).toArray();
  } else {
    rows = await db.planningDrafts.toCollection().toArray();
  }

  if (kind) rows = rows.filter((r) => r.kind === kind);
  if (domain) rows = rows.filter((r) => r.domain === domain);
  if (status) rows = rows.filter((r) => r.status === status);

  rows.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  return rows.slice(0, limit);
}

export async function getPlanningDraftById(id) {
  if (!id || !db.planningDrafts) return null;
  try {
    return await db.planningDrafts.get(String(id));
  } catch {
    return null;
  }
}

// Default export to keep imports ergonomic across SSA.
export default db;
