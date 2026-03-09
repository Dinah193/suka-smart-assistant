// C:\Users\larho\suka-smart-assistant\src\db\tables.js
/**
 * db/tables.js — Dexie table definitions + small, evented CRUD helpers
 *
 * How this fits the SSA pipeline (imports → intelligence → automation → (optional) hub export):
 * - These tables persist household execution state and preferences used by the automation layer:
 *   • plays:            live or recent sessions (cursor, timers, status)
 *   • playHistory:      immutable execution logs (for analytics & suggestions)
 *   • favorites:        cross-domain starred items (recipes, cleaning routines, etc.)
 *   • scheduleTemplates:recurring suggestions (RRULE-like templates for session scheduling)
 *
 * - Any mutation emits standardized envelopes on the shared eventBus:
 *   { type, ts, source, data } with ISO timestamps.
 * - Because these change household-owned data, we also attempt an optional export to the Hub
 *   via exportToHubIfEnabled(payload) (featureFlags.familyFundMode gate, fails silently).
 *
 * Forward-thinking:
 * - Domains include cooking, cleaning, garden, animals, preservation, storehouse.
 * - Schema is versioned; future versions can add tables/indexes with Dexie migrations.
 * - CRUD helpers are deliberately small; higher-level engines can build on them.
 */

let Dexie;
try {
  Dexie = require("dexie").Dexie || require("dexie");
} catch {
  // Soft fallback for SSR/non-browser contexts; methods will throw on use
  Dexie = class MockDexie {
    constructor() {}
    version() {
      return { stores() {} };
    }
    table() {
      throw new Error("Dexie is unavailable outside the browser environment.");
    }
    open() {
      return Promise.resolve(this);
    }
  };
}

let eventBus = {
  emit: (...a) => console.debug("[db:tables:eventBus.emit]", ...a),
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
const SOURCE = "db.tables";

/* ------------------------------ Hub export -------------------------------- */
async function exportToHubIfEnabled(payload) {
  try {
    if (!featureFlags?.familyFundMode) return;
    if (!HubPacketFormatter || !FamilyFundConnector) return;
    // Prefer a generic formatter; fall back to pass-through if unavailable.
    const packet =
      (HubPacketFormatter.formatDbEvent &&
        HubPacketFormatter.formatDbEvent(payload)) ||
      (HubPacketFormatter.format && HubPacketFormatter.format(payload)) ||
      null;
    if (!packet) return;
    await (FamilyFundConnector.send?.(packet) ||
      FamilyFundConnector.post?.(packet));
  } catch {
    // fail silent by design
  }
}

/* --------------------------------- Utils ---------------------------------- */
function createId(prefix = "id") {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID)
      return `${prefix}_${crypto.randomUUID()}`;
  } catch {}
  // Fallback
  const rnd = Math.random().toString(36).slice(2);
  return `${prefix}_${Date.now().toString(36)}_${rnd}`;
}

function assertNonEmptyString(name, v) {
  if (typeof v !== "string" || v.trim() === "")
    throw new Error(`${name} must be a non-empty string`);
}

function emit(type, data) {
  eventBus.emit({ type, ts: nowISO(), source: SOURCE, data });
}

/* --------------------------------- DB Init -------------------------------- */
let dbSingleton = null;

/**
 * Returns the opened Dexie instance (singleton).
 * Tables & indexes:
 *   plays:             id (pk), sessionId, domain, status, updatedAt
 *   playHistory:       id (pk), sessionId, domain, startedAt, endedAt, outcome
 *   favorites:         id (pk), domain, kind, targetId, createdAt
 *   scheduleTemplates: id (pk), domain, enabled, nextRunAt
 */
function getDB() {
  if (dbSingleton) return dbSingleton;

  const db = new Dexie("SukaSmartAssistantDB");

  // Version 1 — initial schema
  db.version(1).stores({
    plays: "id, sessionId, domain, status, updatedAt", // status: active|paused|stopped|completed
    playHistory: "id, sessionId, domain, startedAt, endedAt, outcome", // outcome: completed|canceled|error
    favorites: "id, domain, kind, targetId, createdAt",
    scheduleTemplates: "id, domain, enabled, nextRunAt",
  });

  // Future migrations:
  // db.version(2).stores({...}).upgrade(tx => { /* data migration */ });

  dbSingleton = db;
  return dbSingleton;
}

/* --------------------------------- Tables --------------------------------- */
function plays() {
  return getDB().table("plays");
}
function playHistory() {
  return getDB().table("playHistory");
}
function favorites() {
  return getDB().table("favorites");
}
function scheduleTemplates() {
  return getDB().table("scheduleTemplates");
}

/* --------------------------------- Plays ---------------------------------- */
/**
 * Upsert a play record (live session state).
 * @param {object} play - { id?, sessionId, domain, status, stepIndex?, timers?, meta? }
 */
async function upsertPlay(play = {}) {
  assertNonEmptyString("sessionId", play.sessionId || "");
  assertNonEmptyString("domain", play.domain || "");
  const id = play.id || createId("play");
  const record = {
    id,
    sessionId: String(play.sessionId),
    domain: String(play.domain).toLowerCase(),
    status: (play.status || "active").toLowerCase(),
    stepIndex: Number.isInteger(play.stepIndex) ? play.stepIndex : 0,
    timers: Array.isArray(play.timers) ? play.timers : [],
    meta: play.meta || {},
    createdAt: play.createdAt || nowISO(),
    updatedAt: nowISO(),
  };

  await plays().put(record);
  const payload = { table: "plays", op: "upsert", record };
  emit("db.play.upserted", payload);
  exportToHubIfEnabled(payload);
  return record;
}

/**
 * Mark a play as completed/paused/stopped and persist cursor/timers snapshot.
 */
async function updatePlayStatus(id, status, patch = {}) {
  assertNonEmptyString("id", id);
  assertNonEmptyString("status", status || "");
  const existing = await plays().get(id);
  if (!existing) throw new Error(`play ${id} not found`);
  const record = {
    ...existing,
    status: status.toLowerCase(),
    stepIndex: Number.isInteger(patch.stepIndex)
      ? patch.stepIndex
      : existing.stepIndex,
    timers: Array.isArray(patch.timers) ? patch.timers : existing.timers,
    updatedAt: nowISO(),
  };
  await plays().put(record);
  const payload = { table: "plays", op: "status", record };
  emit("db.play.updated", payload);
  exportToHubIfEnabled(payload);
  return record;
}

/**
 * Remove a play record.
 */
async function removePlay(id) {
  assertNonEmptyString("id", id);
  await plays().delete(id);
  const payload = { table: "plays", op: "delete", id };
  emit("db.play.deleted", payload);
  exportToHubIfEnabled(payload);
  return true;
}

/* ------------------------------ Play History ------------------------------ */
/**
 * Log a completed/canceled/error session run.
 * @param {object} entry - { id?, sessionId, domain, startedAt, endedAt, outcome, stepsCompleted?, notes?, meta? }
 */
async function logPlayHistory(entry = {}) {
  assertNonEmptyString("sessionId", entry.sessionId || "");
  assertNonEmptyString("domain", entry.domain || "");
  const id = entry.id || createId("hist");
  const startedAt = entry.startedAt || nowISO();
  const endedAt = entry.endedAt || nowISO();
  const durationMs = Math.max(
    0,
    new Date(endedAt).getTime() - new Date(startedAt).getTime()
  );

  const record = {
    id,
    sessionId: String(entry.sessionId),
    domain: String(entry.domain).toLowerCase(),
    startedAt,
    endedAt,
    durationMs,
    outcome: (entry.outcome || "completed").toLowerCase(),
    stepsCompleted: Number.isInteger(entry.stepsCompleted)
      ? entry.stepsCompleted
      : undefined,
    notes: entry.notes || undefined,
    meta: entry.meta || {},
    createdAt: nowISO(),
  };

  await playHistory().add(record);
  const payload = { table: "playHistory", op: "insert", record };
  emit("db.playHistory.logged", payload);
  exportToHubIfEnabled(payload);
  return record;
}

/* -------------------------------- Favorites ------------------------------- */
/**
 * Toggle a favorite entry, returns { favorite, removed }
 * @param {object} fav - { id?, domain, kind, targetId, title?, tags?[] }
 */
async function toggleFavorite(fav = {}) {
  assertNonEmptyString("domain", fav.domain || "");
  assertNonEmptyString("kind", fav.kind || "");
  assertNonEmptyString("targetId", fav.targetId || "");

  // Natural key: domain+kind+targetId
  const existing = await favorites()
    .where("[domain+kind+targetId]")
    .equals([
      String(fav.domain).toLowerCase(),
      String(fav.kind).toLowerCase(),
      String(fav.targetId),
    ])
    .first()
    .catch(() => null);

  if (existing) {
    await favorites().delete(existing.id);
    const payload = {
      table: "favorites",
      op: "delete",
      id: existing.id,
      domain: existing.domain,
      kind: existing.kind,
      targetId: existing.targetId,
    };
    emit("db.favorite.removed", payload);
    exportToHubIfEnabled(payload);
    return { favorite: null, removed: true };
  }

  // Ensure compound index exists by storing the fields explicitly on record
  const record = {
    id: fav.id || createId("fav"),
    domain: String(fav.domain).toLowerCase(),
    kind: String(fav.kind).toLowerCase(),
    targetId: String(fav.targetId),
    title: fav.title || undefined,
    tags: Array.isArray(fav.tags) ? fav.tags.slice(0, 24) : undefined,
    createdAt: nowISO(),
  };
  await favorites().add(record);
  const payload = { table: "favorites", op: "insert", record };
  emit("db.favorite.added", payload);
  exportToHubIfEnabled(payload);
  return { favorite: record, removed: false };
}

/* --------------------------- Schedule Templates --------------------------- */
/**
 * Upsert a schedule template.
 * @param {object} tpl - { id?, domain, title, rrule, tzid?, startTime?, durationMs?, alarmMinutesBefore?, enabled?, nextRunAt?, meta? }
 */
async function upsertScheduleTemplate(tpl = {}) {
  assertNonEmptyString("domain", tpl.domain || "");
  assertNonEmptyString("title", tpl.title || "");
  assertNonEmptyString("rrule", tpl.rrule || "");

  const record = {
    id: tpl.id || createId("tpl"),
    domain: String(tpl.domain).toLowerCase(),
    title: tpl.title,
    rrule: tpl.rrule, // e.g., "FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=18;BYMINUTE=0;COUNT=12"
    tzid: tpl.tzid || undefined,
    startTime: tpl.startTime || undefined, // ISO date-time of first occurrence or preferred local time
    durationMs: Number.isFinite(tpl.durationMs)
      ? Math.max(0, tpl.durationMs)
      : undefined,
    alarmMinutesBefore: Number.isFinite(tpl.alarmMinutesBefore)
      ? Math.max(0, tpl.alarmMinutesBefore)
      : undefined,
    enabled: tpl.enabled !== false,
    lastRunAt: tpl.lastRunAt || undefined,
    nextRunAt: tpl.nextRunAt || undefined,
    meta: tpl.meta || {},
    updatedAt: nowISO(),
    createdAt: tpl.createdAt || nowISO(),
  };

  await scheduleTemplates().put(record);
  const payload = { table: "scheduleTemplates", op: "upsert", record };
  emit("db.scheduleTemplate.upserted", payload);
  exportToHubIfEnabled(payload);
  return record;
}

async function deleteScheduleTemplate(id) {
  assertNonEmptyString("id", id);
  await scheduleTemplates().delete(id);
  const payload = { table: "scheduleTemplates", op: "delete", id };
  emit("db.scheduleTemplate.deleted", payload);
  exportToHubIfEnabled(payload);
  return true;
}

/* --------------------------------- Exports -------------------------------- */
module.exports = {
  getDB,

  // raw tables (use with care)
  plays,
  playHistory,
  favorites,
  scheduleTemplates,

  // helpers
  upsertPlay,
  updatePlayStatus,
  removePlay,
  logPlayHistory,
  toggleFavorite,
  upsertScheduleTemplate,
  deleteScheduleTemplate,
};
