// C:\Users\larho\suka-smart-assistant\src\db\dexie.js
/* eslint-disable no-console */

/**
 * Core Dexie database setup for Suka Smart Assistant (SSA)
 * -----------------------------------------------------------------------------
 * Role in pipeline:
 * - Imports → Intelligence → Automation → (optional) Hub export
 * - This module initializes the browser-local (or Node IndexedDB polyfill)
 *   database used by SSA. It defines normalized stores for:
 *     • sessions / steps               → actionable plans
 *     • resources                      → people/devices/rooms graph
 *     • calendars & calendarEvents     → scheduling layer (new)
 *     • telemetry & metrics            → runtime exhaust
 *     • calibrationFactors/History     → learning loop corrections
 * - On first run it seeds a default "Household Calendar" so engines can place
 *   events without asking for a calendar first.
 *
 * Events:
 * - Emits { type, ts, source, data } via shared eventBus on open/seed/migrate.
 * - Payloads are informational; no Hub export here (no household data changes).
 */

import Dexie from "dexie";

let eventBus = { emit: () => {}, on: () => () => {} };
try {
  const eb = require("@/services/events/eventBus");
  eventBus = eb?.default || eb?.eventBus || eventBus;
} catch {
  /* non-fatal for early bootstrap */
}

const SOURCE = "db/dexie";
const isoNow = () => new Date().toISOString();
const emit = (type, data) => {
  try {
    eventBus.emit({ type, ts: isoNow(), source: SOURCE, data });
  } catch (err) {
    console.warn("[dexie] event emit failed:", err?.message || err);
  }
};

/**
 * Database instance
 * The name is versioned logically; Dexie handles schema versions below.
 */
export const db = new Dexie("suka_smart_assistant");

/**
 * Schema versions
 * - v1: Core entities (sessions, steps, resources)
 * - v2: Scheduling stores (calendars, calendarEvents)
 * - v3: Telemetry & metrics
 * - v4: Calibration factors & history
 * - v5: Minor index tune-ups + multi-field dotted indexes for queries
 *
 * NOTE on indexes:
 * Dexie supports dotted indexes on simple properties (e.g., "schedule.scheduledFor").
 * Use them sparingly; prefer top-level duplication for hot query keys if needed.
 */

// v1 — core planning entities
db.version(1).stores({
  sessions:
    // primary key & secondary indexes
    //   id, domain, status, createdAt, updatedAt, householdId, schedule.scheduledFor
    "id, domain, status, createdAt, updatedAt, householdId, schedule.scheduledFor",
  steps:
    //   sessionId + position for ordering, status and times for filtering
    "id, sessionId, domain, status, position, createdAt, updatedAt",
  resources:
    //   name is not indexed (text search is client-side); index by type/status/placement
    "id, type, status, updatedAt, location.roomId, assignedTo.personId",
});

// v2 — scheduling (new stores)
db.version(2).stores({
  calendars:
    // calendars can belong to a household and/or a resource (person/device/room)
    "id, status, updatedAt, householdId, resourceId, name",
  calendarEvents:
    // event windowing by start/end; links to SSA entities and calendars
    "id, calendarId, start, end, status, sessionId, stepId, domain",
});

// v3 — runtime exhaust
db.version(3).stores({
  telemetry:
    // actuals timeline; ts is hot; link to step/session/resource/device
    "id, ts, kind, stepId, sessionId, domain, resourceId, deviceId",
  metrics:
    // timeseries; key+ts scanning; linkages
    "id, ts, key, stepId, sessionId, domain, resourceId, deviceId",
});

// v4 — learning loop
db.version(4).stores({
  calibrationFactors:
    // dotted scope fields allow targeted lookups; updatedAt for recency
    "id, key, updatedAt, scope.deviceId, scope.resourceId, scope.roomId, scope.recipeId, scope.ingredient, scope.method, scope.domain, scope.model, scope.householdId",
  calibrationHistory:
    // optional audit trail
    "id, factorId, key, ts",
});

// v5 — index refinements (safe to re-declare full store lists)
// (Dexie allows upgrading indexes via new version + stores() definition.)
// Add compound index for events by calendarId+start and sessions by status+createdAt.
db.version(5).stores({
  sessions:
    "id, [status+createdAt], domain, status, createdAt, updatedAt, householdId, schedule.scheduledFor",
  steps:
    "id, [sessionId+position], sessionId, domain, status, position, createdAt, updatedAt",
  resources:
    "id, type, status, updatedAt, location.roomId, assignedTo.personId",
  calendars: "id, status, updatedAt, householdId, resourceId, name",
  calendarEvents:
    "id, [calendarId+start], calendarId, start, end, status, sessionId, stepId, domain",
  telemetry: "id, ts, kind, stepId, sessionId, domain, resourceId, deviceId",
  metrics: "id, ts, key, stepId, sessionId, domain, resourceId, deviceId",
  calibrationFactors:
    "id, key, updatedAt, scope.deviceId, scope.resourceId, scope.roomId, scope.recipeId, scope.ingredient, scope.method, scope.domain, scope.model, scope.householdId",
  calibrationHistory: "id, factorId, key, ts",
});

/**
 * Global middleware / hooks
 * Keep it minimal — heavy logic stays in repositories.
 */
db.on("populate", async () => {
  // First-time database creation → seed default "Household Calendar"
  try {
    const defaultCalendar = {
      id: cryptoRandomId("cal"),
      name: "Household Calendar",
      color: "#4b5563",
      status: "active",
      householdId: null,
      resourceId: null,
      timezone: null,
      metadata: { seeded: true },
      createdAt: isoNow(),
      updatedAt: isoNow(),
      archivedAt: null,
    };
    await db.calendars.add(defaultCalendar);
    emit("db.seeded", { calendars: 1 });
  } catch (err) {
    console.warn("[dexie] populate seed failed:", err?.message || err);
  }
});

db.on("blocked", () => {
  console.warn(
    "[dexie] schema upgrade blocked — close other tabs to continue."
  );
  emit("db.blocked", {});
});

db.on("versionchange", () => {
  // In a multi-tab scenario, Dexie suggests closing/reloading
  console.warn("[dexie] version change detected.");
  emit("db.version_change", {});
});

db.open()
  .then(() => emit("db.ready", { name: db.name, ver: db.verno }))
  .catch((err) => {
    console.error("[dexie] open failed:", err?.message || err);
    emit("db.open_failed", { error: String(err?.message || err) });
  });

/* ----------------------------------------------------------------------------
 * Helpers
 * -------------------------------------------------------------------------- */

function cryptoRandomId(prefix) {
  try {
    return (
      globalThis?.crypto?.randomUUID?.() ||
      `${prefix}_${Date.now().toString(36)}_${Math.random()
        .toString(36)
        .slice(2, 8)}`
    );
  } catch {
    return `${prefix}_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;
  }
}

/**
 * Optional: lightweight integrity check that repositories can call at startup.
 * This does NOT migrate — it just sanity-checks presence of expected tables.
 */
export async function sanityCheck() {
  const expected = [
    "sessions",
    "steps",
    "resources",
    "calendars",
    "calendarEvents",
    "telemetry",
    "metrics",
    "calibrationFactors",
  ];
  const missing = expected.filter(
    (t) => !(t in db.tables.reduce((m, tbl) => ((m[tbl.name] = true), m), {}))
  );
  const ok = missing.length === 0;
  if (!ok) console.warn("[dexie] missing tables:", missing);
  return { ok, missing };
}

/**
 * Convenience: get a default active calendar (used by CalendarsRepo fallback)
 */
export async function getDefaultCalendar() {
  const first = await db.calendars.where("status").equals("active").first();
  return first || (await db.calendars.toCollection().first());
}

/**
 * Export default (compat with CommonJS import patterns used elsewhere)
 */
const exported = db;
export default exported;
// For CJS interop if needed:
// module.exports = exported;
