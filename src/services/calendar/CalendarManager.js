// File: C:\Users\larho\suka-smart-assistant\src\services\calendar\CalendarManager.js
/**
 * CalendarManager (browser-safe)
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Central place to record "calendar events" that SSA schedules internally.
 *  - DOES NOT integrate with Google/Apple calendars (by default).
 *  - Keeps behavior deterministic and app-local (Dexie if available, else memory).
 *
 * Why this file exists
 *  - scheduleSessionAlerts.js imports "../calendar/CalendarManager"
 *    => resolves to src/services/calendar/CalendarManager.js
 *
 * Storage
 *  - If Dexie db.calendarEvents exists, we persist there.
 *  - Otherwise we keep an in-memory store (still works, but non-persistent).
 *
 * Events (optional)
 *  - Emits lightweight events on eventBus if present:
 *      calendar.event.upserted
 *      calendar.event.removed
 */

import eventBus from "@/services/events/eventBus";
import db from "@/services/db"; // If you don't have this path, keep it; we guard usage.

const SOURCE = "CalendarManager";

function nowISO() {
  return new Date().toISOString();
}

function safeEmit(type, data) {
  try {
    if (eventBus && typeof eventBus.emit === "function") {
      eventBus.emit({
        type,
        ts: nowISO(),
        source: SOURCE,
        data,
      });
    } else if (eventBus && typeof eventBus.emit === "function") {
      // Some projects use eventBus.emit(type, payload)
      eventBus.emit(type, { type, ts: nowISO(), source: SOURCE, data });
    }
  } catch {
    // never crash callers
  }
}

function asArray(x) {
  return Array.isArray(x) ? x : [];
}

function toISO(d) {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString();
  if (typeof d === "string") {
    const t = d.trim();
    if (!t) return null;
    // accept ISO-ish strings directly
    if (t.includes("T")) return t;
    const parsed = new Date(t);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

function createId(prefix = "cal") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

/**
 * Canonical internal CalendarEvent shape (loose)
 * @typedef {Object} CalendarEvent
 * @property {string} id
 * @property {string} title
 * @property {string|null} startISO
 * @property {string|null} endISO
 * @property {string} [domain]
 * @property {string} [sessionId]
 * @property {string} [householdId]
 * @property {string} [status]         // "scheduled" | "completed" | "canceled" | ...
 * @property {Object} [meta]
 * @property {string} createdAt
 * @property {string} updatedAt
 */

const mem = new Map(); // id -> event

function hasDexieTable() {
  try {
    return !!(
      db &&
      db.calendarEvents &&
      typeof db.calendarEvents.put === "function"
    );
  } catch {
    return false;
  }
}

async function dexiePut(evt) {
  await db.calendarEvents.put(evt);
  return evt;
}

async function dexieGet(id) {
  return db.calendarEvents.get(id);
}

async function dexieDelete(id) {
  return db.calendarEvents.delete(id);
}

async function dexieQueryUpcoming({ startISO, endISO, limit = 200 } = {}) {
  // If you don't have indexes, Dexie will still scan; acceptable for modest volumes.
  const s = toISO(startISO);
  const e = toISO(endISO);

  const all = await db.calendarEvents.toArray();
  const filtered = all.filter((x) => {
    const xs = x?.startISO ? new Date(x.startISO).getTime() : 0;
    const sMs = s ? new Date(s).getTime() : -Infinity;
    const eMs = e ? new Date(e).getTime() : Infinity;
    return xs >= sMs && xs <= eMs;
  });

  filtered.sort((a, b) => {
    const ta = a?.startISO ? new Date(a.startISO).getTime() : 0;
    const tb = b?.startISO ? new Date(b.startISO).getTime() : 0;
    return ta - tb;
  });

  return filtered.slice(0, limit);
}

function memUpsert(evt) {
  mem.set(evt.id, evt);
  return evt;
}

function memRemove(id) {
  mem.delete(id);
}

function memGet(id) {
  return mem.get(id) || null;
}

function memUpcoming({ startISO, endISO, limit = 200 } = {}) {
  const s = toISO(startISO);
  const e = toISO(endISO);

  const sMs = s ? new Date(s).getTime() : -Infinity;
  const eMs = e ? new Date(e).getTime() : Infinity;

  const arr = Array.from(mem.values()).filter((x) => {
    const xs = x?.startISO ? new Date(x.startISO).getTime() : 0;
    return xs >= sMs && xs <= eMs;
  });

  arr.sort((a, b) => {
    const ta = a?.startISO ? new Date(a.startISO).getTime() : 0;
    const tb = b?.startISO ? new Date(b.startISO).getTime() : 0;
    return ta - tb;
  });

  return arr.slice(0, limit);
}

function normalizeEvent(partial) {
  const createdAt = partial?.createdAt || nowISO();
  const updatedAt = nowISO();

  /** @type {CalendarEvent} */
  const evt = {
    id: partial?.id || createId("cal"),
    title: String(partial?.title || "Untitled"),
    startISO: toISO(partial?.startISO || partial?.start || partial?.startAt),
    endISO: toISO(partial?.endISO || partial?.end || partial?.endAt),
    domain: partial?.domain || partial?.meta?.domain || "general",
    sessionId: partial?.sessionId || partial?.meta?.sessionId || null,
    householdId:
      partial?.householdId || partial?.meta?.householdId || "primary",
    status: partial?.status || "scheduled",
    meta: partial?.meta && typeof partial.meta === "object" ? partial.meta : {},
    createdAt,
    updatedAt,
  };

  return evt;
}

/**
 * Upsert (create/update) a calendar event.
 * @param {Partial<CalendarEvent>} partial
 * @returns {Promise<CalendarEvent>}
 */
async function upsertEvent(partial) {
  const evt = normalizeEvent(partial);

  if (hasDexieTable()) {
    await dexiePut(evt);
  } else {
    memUpsert(evt);
  }

  safeEmit("calendar.event.upserted", { id: evt.id, event: evt });
  return evt;
}

/**
 * Get event by id.
 * @param {string} id
 * @returns {Promise<CalendarEvent|null>}
 */
async function getEvent(id) {
  if (!id) return null;
  if (hasDexieTable()) {
    const found = await dexieGet(id);
    return found || null;
  }
  return memGet(id);
}

/**
 * Remove event by id.
 * @param {string} id
 * @returns {Promise<boolean>}
 */
async function removeEvent(id) {
  if (!id) return false;

  if (hasDexieTable()) {
    await dexieDelete(id);
  } else {
    memRemove(id);
  }

  safeEmit("calendar.event.removed", { id });
  return true;
}

/**
 * List upcoming events within a window.
 * @param {Object} opts
 * @param {string|Date} [opts.startISO]
 * @param {string|Date} [opts.endISO]
 * @param {number} [opts.limit]
 * @returns {Promise<CalendarEvent[]>}
 */
async function listUpcoming(opts = {}) {
  const startISO = toISO(opts.startISO) || nowISO();
  const endISO = toISO(opts.endISO) || null;
  const limit = Number.isFinite(Number(opts.limit)) ? Number(opts.limit) : 200;

  if (hasDexieTable()) {
    return dexieQueryUpcoming({ startISO, endISO, limit });
  }
  return memUpcoming({ startISO, endISO, limit });
}

/**
 * Convenience: create a calendar event from a Session object.
 * (Keeps scheduleSessionAlerts.js simple.)
 *
 * @param {Object} session
 * @param {Object} [options]
 * @returns {Promise<CalendarEvent>}
 */
async function upsertFromSession(session, options = {}) {
  const s = session && typeof session === "object" ? session : {};
  const title =
    options.title || s.title || (s.domain ? `${s.domain} session` : "Session");
  const startISO =
    s.startISO || s.windowStart || s.scheduledStart || options.startISO;
  const endISO = s.endISO || s.windowEnd || s.scheduledEnd || options.endISO;

  return upsertEvent({
    id: options.id || (s.id ? `cal_sess_${s.id}` : undefined),
    title,
    startISO,
    endISO,
    domain: s.domain || options.domain || "general",
    sessionId: s.id || null,
    householdId: s.householdId || options.householdId || "primary",
    status: options.status || "scheduled",
    meta: {
      ...(s.meta || {}),
      ...(options.meta || {}),
      source: "session",
    },
  });
}

const CalendarManager = {
  upsertEvent,
  getEvent,
  removeEvent,
  listUpcoming,
  upsertFromSession,
};

export default CalendarManager;
export { CalendarManager };
