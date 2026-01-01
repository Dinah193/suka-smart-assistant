// C:\Users\larho\suka-smart-assistant\src\db\repositories\CalendarsRepo.js
/* eslint-disable no-console */

/**
 * CalendarsRepo
 * -----------------------------------------------------------------------------
 * Role in pipeline:
 * - Imports → Intelligence → Automation → (optional) Hub export
 * - Centralized read/write layer for household and resource calendars.
 *   Engines (cooking/cleaning/garden/animal/preservation) schedule Sessions
 *   and Steps. This repo persists those schedules as calendar events so the
 *   automation runtime can propose, remind, and execute work.
 * - Any mutation emits an event { type, ts, source, data } to the shared
 *   eventBus. If featureFlags.familyFundMode is enabled, mutations are also
 *   formatted and forwarded to the Hub (best-effort, silent on failure).
 *
 * Tables expected in Dexie:
 *  - db.calendars          (by household/resource or general)
 *  - db.calendarEvents     (event items, optionally linked to sessions/steps)
 *
 * Forward-thinking:
 *  - Supports multiple owners (householdId, resourceId).
 *  - Supports simple RRULE-style recurrences (DAILY/WEEKLY/MONTHLY) for local expansion.
 *  - Supports free/busy queries and conflict detection.
 *  - Leaves extension points for ICS import/export and additional domains.
 */

let db = null;
try {
  const mod = require("@/db");
  db = mod?.default || mod?.db || mod;
} catch {}

let eventBus = { emit: () => {}, on: () => () => {} };
try {
  const eb = require("@/services/eventBus");
  eventBus = eb?.default || eb?.eventBus || eventBus;
} catch {}

let featureFlags = { familyFundMode: false };
try {
  featureFlags = require("@/config/featureFlags.json");
} catch {}

let HubPacketFormatter = null;
try {
  const mod = require("@/services/hub/HubPacketFormatter");
  HubPacketFormatter = mod?.default || mod;
} catch {}

let FamilyFundConnector = null;
try {
  const mod = require("@/services/hub/FamilyFundConnector");
  FamilyFundConnector = mod?.default || mod;
} catch {}

const SOURCE = "db/CalendarsRepo";

/* ----------------------------------------------------------------------------
 * Utilities
 * -------------------------------------------------------------------------- */

function isoNow() {
  return new Date().toISOString();
}

function uuid(prefix = "cal") {
  try {
    return globalThis?.crypto?.randomUUID?.() || `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  } catch {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
}

function emit(type, data) {
  try {
    eventBus.emit({ type, ts: isoNow(), source: SOURCE, data });
  } catch (err) {
    console.warn("[CalendarsRepo] event emit failed:", err);
  }
}

async function exportToHubIfEnabled(payload) {
  if (!featureFlags?.familyFundMode || !HubPacketFormatter || !FamilyFundConnector) return;
  try {
    const packet = HubPacketFormatter.formatCalendarChange?.(payload) || payload;
    await FamilyFundConnector.send?.(packet);
  } catch (err) {
    console.warn("[CalendarsRepo] Hub export failed (silent):", err?.message || err);
  }
}

function ensureDB() {
  const ok =
    db &&
    typeof db === "object" &&
    db.calendars &&
    db.calendarEvents &&
    typeof db.calendars === "object" &&
    typeof db.calendarEvents === "object";

  if (!ok) {
    throw new Error(
      "Dexie tables 'calendars' and 'calendarEvents' are required. Ensure '@/db' exports a Dexie with these tables."
    );
  }
}

/* ----------------------------------------------------------------------------
 * Normalizers
 * -------------------------------------------------------------------------- */

/**
 * Calendar shape:
 *  - id, name, color, householdId?, resourceId?, timezone?, metadata
 *  - status: active|archived
 */
function normalizeCalendar(input = {}) {
  if (!input || typeof input !== "object") return { ok: false, error: "Invalid calendar payload." };

  const now = isoNow();
  const record = {
    id: input.id || uuid("cal"),
    name: String(input.name || "").trim() || "Household Calendar",
    color: String(input.color || "").trim() || "#4b5563", // neutral
    status: ["active", "archived"].includes(input.status) ? input.status : "active",

    householdId: input.householdId || null,
    resourceId: input.resourceId || null, // device/person/room calendar

    timezone: input.timezone || null,

    metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {},

    createdAt: input.createdAt || now,
    updatedAt: now,
    archivedAt: input.archivedAt || null,
  };

  return { ok: true, record };
}

/**
 * Event shape:
 *  - id, calendarId, title, start, end, allDay?, recurrence?, links?, metadata
 *  - optional links to domain entities: sessionId, stepId
 *  - recurrence: { freq: "DAILY"|"WEEKLY"|"MONTHLY", interval?: number, byweekday?: [0..6], count?: number, until?: ISO }
 *  - status: tentative|confirmed|canceled|completed
 */
function normalizeEvent(input = {}) {
  if (!input || typeof input !== "object") return { ok: false, error: "Invalid event payload." };

  const now = isoNow();
  const start = toISO(input.start);
  const end = toISO(input.end);

  if (!start || !end) return { ok: false, error: "Event start/end required (ISO)." };
  if (new Date(end).getTime() < new Date(start).getTime()) {
    return { ok: false, error: "Event end must be after start." };
  }

  const record = {
    id: input.id || uuid("evt"),
    calendarId: input.calendarId || null,
    title: String(input.title || "").trim() || "Scheduled Task",
    description: String(input.description || "").trim() || "",

    start,
    end,
    allDay: !!input.allDay,

    // Linkage to SSA entities
    sessionId: input.sessionId || null,
    stepId: input.stepId || null,
    domain: String(input.domain || "").trim() || null, // cooking/cleaning/garden/animal/preservation/storehouse

    // Recurrence (simple RRULE)
    recurrence: normRecurrence(input.recurrence),

    // Participation & location
    attendees: Array.isArray(input.attendees) ? input.attendees : [], // [{resourceId|personId, role?, rsvp?}]
    location: input.location || null, // { roomId?, coords?, text? }

    // Status & alerts
    status: ["tentative", "confirmed", "canceled", "completed"].includes(input.status)
      ? input.status
      : "confirmed",
    reminders: Array.isArray(input.reminders) ? input.reminders : [], // [{ minutesBefore: 10, method: "push"|"sms"|"email" }]

    // Misc
    timezone: input.timezone || null,
    metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {},

    createdAt: input.createdAt || now,
    updatedAt: now,
    canceledAt: input.canceledAt || null,
    completedAt: input.completedAt || null,
  };

  return { ok: true, record };
}

function toISO(v) {
  if (!v) return null;
  try {
    const d = new Date(v);
    const t = d.getTime();
    if (!Number.isFinite(t)) return null;
    return d.toISOString();
  } catch {
    return null;
  }
}

function normRecurrence(r) {
  if (!r || typeof r !== "object") return null;
  const freq = String(r.freq || "").toUpperCase();
  if (!["DAILY", "WEEKLY", "MONTHLY"].includes(freq)) return null;
  const out = {
    freq,
    interval: Math.max(1, Number(r.interval || 1)),
  };
  if (Array.isArray(r.byweekday)) {
    out.byweekday = r.byweekday
      .map((n) => Number(n))
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
    if (!out.byweekday.length) delete out.byweekday;
  }
  if (r.until) out.until = toISO(r.until);
  if (r.count && Number(r.count) > 0) out.count = Number(r.count);
  return out;
}

/* ----------------------------------------------------------------------------
 * Repository
 * -------------------------------------------------------------------------- */

const CalendarsRepo = {
  /* --------------------------------- CALENDARS -------------------------------- */

  async createCalendar(cal) {
    ensureDB();
    const res = normalizeCalendar(cal);
    if (!res.ok) return { ok: false, error: res.error };

    const record = res.record;
    try {
      await db.calendars.put(record);
      const payload = { action: "calendar.create", calendar: record };
      emit("calendar.created", payload);
      await exportToHubIfEnabled(payload);
      return { ok: true, data: record };
    } catch (err) {
      console.error("[CalendarsRepo.createCalendar] failed:", err);
      return { ok: false, error: err?.message || String(err) };
    }
  },

  async upsertCalendar(cal = {}) {
    ensureDB();
    const id = cal?.id;
    if (!id) return this.createCalendar(cal);
    const existing = await db.calendars.get(id);
    return existing ? this.patchCalendar(id, cal) : this.createCalendar(cal);
  },

  async getCalendarById(id) {
    ensureDB();
    if (!id) return { ok: false, error: "Missing id." };
    try {
      const row = await db.calendars.get(id);
      return row ? { ok: true, data: row } : { ok: false, error: "Not found." };
    } catch (err) {
      console.error("[CalendarsRepo.getCalendarById] failed:", err);
      return { ok: false, error: err?.message || String(err) };
    }
  },

  async listCalendars(opts = {}) {
    ensureDB();
    const {
      householdId = null,
      resourceId = null,
      status = null, // "active"|"archived"
      text = null,
      limit = 200,
      offset = 0,
      sortBy = "updatedAt",
      sortDir = "desc",
    } = opts;

    try {
      let coll = db.calendars.toCollection();

      if (householdId) coll = coll.and((c) => c.householdId === householdId);
      if (resourceId) coll = coll.and((c) => c.resourceId === resourceId);
      if (status) {
        const set = new Set(Array.isArray(status) ? status : [status]);
        coll = coll.and((c) => set.has(c.status));
      }
      if (text) {
        const q = String(text).toLowerCase();
        coll = coll.and((c) => String(c.name || "").toLowerCase().includes(q));
      }

      const dir = sortDir === "asc" ? 1 : -1;
      const arr = await coll.sortBy(sortBy).then((a) => (dir === 1 ? a : a.reverse()));
      const slice = arr.slice(offset, offset + limit);

      return { ok: true, data: { total: arr.length, items: slice, offset, limit } };
    } catch (err) {
      console.error("[CalendarsRepo.listCalendars] failed:", err);
      return { ok: false, error: err?.message || String(err) };
    }
  },

  async patchCalendar(id, partial = {}) {
    ensureDB();
    if (!id || typeof partial !== "object") return { ok: false, error: "Invalid patch payload." };
    try {
      const curr = await db.calendars.get(id);
      if (!curr) return { ok: false, error: "Not found." };
      const next = { ...curr, ...partial, id, updatedAt: isoNow() };
      await db.calendars.put(next);
      const payload = { action: "calendar.patch", calendar: next, fields: Object.keys(partial) };
      emit("calendar.patched", payload);
      await exportToHubIfEnabled(payload);
      return { ok: true, data: next };
    } catch (err) {
      console.error("[CalendarsRepo.patchCalendar] failed:", err);
      return { ok: false, error: err?.message || String(err) };
    }
  },

  async archiveCalendar(id) {
    const res = await this.patchCalendar(id, { status: "archived", archivedAt: isoNow() });
    if (res.ok) {
      const payload = { action: "calendar.archive", id };
      emit("calendar.archived", payload);
      exportToHubIfEnabled(payload);
    }
    return res;
  },

  async removeCalendar(id) {
    ensureDB();
    if (!id) return { ok: false, error: "Missing id." };
    try {
      const curr = await db.calendars.get(id);
      if (!curr) return { ok: false, error: "Not found." };

      // Optional: cascade delete events for this calendar
      await db.transaction("rw", db.calendars, db.calendarEvents, async () => {
        await db.calendarEvents.where("calendarId").equals(id).delete();
        await db.calendars.delete(id);
      });

      const payload = { action: "calendar.delete", id, calendar: curr };
      emit("calendar.deleted", payload);
      await exportToHubIfEnabled(payload);
      return { ok: true, data: { id } };
    } catch (err) {
      console.error("[CalendarsRepo.removeCalendar] failed:", err);
      return { ok: false, error: err?.message || String(err) };
    }
  },

  /* ----------------------------------- EVENTS ---------------------------------- */

  async createEvent(evt) {
    ensureDB();
    const res = normalizeEvent(evt);
    if (!res.ok) return { ok: false, error: res.error };

    const record = res.record;
    try {
      if (!record.calendarId) {
        // default to a household or general calendar if none provided
        const fallback = await pickDefaultCalendar();
        record.calendarId = fallback?.id || null;
      }
      await db.calendarEvents.put(record);
      const payload = { action: "event.create", event: record };
      emit("calendar.event_created", payload);
      await exportToHubIfEnabled(payload);
      return { ok: true, data: record };
    } catch (err) {
      console.error("[CalendarsRepo.createEvent] failed:", err);
      return { ok: false, error: err?.message || String(err) };
    }
  },

  async bulkCreateEvents(list = []) {
    ensureDB();
    if (!Array.isArray(list) || !list.length) return { ok: false, error: "Nothing to create." };

    const ready = [];
    for (const e of list) {
      const res = normalizeEvent(e);
      if (res.ok) ready.push(res.record);
    }
    if (!ready.length) return { ok: false, error: "No valid events." };

    try {
      // Fill missing calendarId with default
      const fallback = await pickDefaultCalendar();
      const fallbackId = fallback?.id || null;
      for (const r of ready) if (!r.calendarId) r.calendarId = fallbackId;

      const ids = await db.calendarEvents.bulkPut(ready);
      const payload = { action: "event.bulkCreate", count: ready.length, events: ready.map((e) => e.id) };
      emit("calendar.events_bulk_created", payload);
      await exportToHubIfEnabled(payload);
      return { ok: true, data: Array.isArray(ids) ? ids : ready.map((e) => e.id) };
    } catch (err) {
      console.error("[CalendarsRepo.bulkCreateEvents] failed:", err);
      return { ok: false, error: err?.message || String(err) };
    }
  },

  async getEventById(id) {
    ensureDB();
    if (!id) return { ok: false, error: "Missing id." };
    try {
      const row = await db.calendarEvents.get(id);
      return row ? { ok: true, data: row } : { ok: false, error: "Not found." };
    } catch (err) {
      console.error("[CalendarsRepo.getEventById] failed:", err);
      return { ok: false, error: err?.message || String(err) };
    }
  },

  async listEvents(opts = {}) {
    ensureDB();
    const {
      calendarId = null,
      householdId = null, // via calendar->householdId
      resourceId = null,  // via calendar->resourceId
      from = null,        // ISO
      to = null,          // ISO
      status = null,      // string or array
      domain = null,
      limit = 500,
      offset = 0,
      expandRecurrence = true, // expand into occurrences if true
    } = opts;

    try {
      // First collect candidate events
      let events = await db.calendarEvents.toArray();

      if (calendarId) {
        const set = new Set(Array.isArray(calendarId) ? calendarId : [calendarId]);
        events = events.filter((e) => set.has(e.calendarId));
      }

      if (householdId || resourceId) {
        // join on calendars (cheap in-memory filter)
        const calendars = await db.calendars.toArray();
        const calById = new Map(calendars.map((c) => [c.id, c]));
        events = events.filter((e) => {
          const cal = calById.get(e.calendarId);
          if (!cal) return false;
          if (householdId && cal.householdId !== householdId) return false;
          if (resourceId && cal.resourceId !== resourceId) return false;
          return true;
        });
      }

      if (status) {
        const set = new Set(Array.isArray(status) ? status : [status]);
        events = events.filter((e) => set.has(e.status));
      }

      if (domain) {
        const set = new Set(Array.isArray(domain) ? domain : [domain]);
        events = events.filter((e) => e.domain && set.has(e.domain));
      }

      // Time window filtering
      if (from || to) {
        const fromT = from ? new Date(from).getTime() : null;
        const toT = to ? new Date(to).getTime() : null;
        events = events.filter((e) => {
          const s = new Date(e.start).getTime();
          const en = new Date(e.end).getTime();
          if (fromT && en < fromT) return false; // event ends before window starts
          if (toT && s >= toT) return false;     // event starts at/after window end
          return true;
        });
      }

      // Expand recurrences into occurrences when requested
      let items = expandRecurrence ? expandEvents(events, { from, to }) : events;

      // Sort by start time
      items.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

      // Paginate
      const slice = items.slice(offset, offset + limit);

      return { ok: true, data: { total: items.length, items: slice, offset, limit } };
    } catch (err) {
      console.error("[CalendarsRepo.listEvents] failed:", err);
      return { ok: false, error: err?.message || String(err) };
    }
  },

  async updateEvent(id, next) {
    ensureDB();
    if (!id || !next || typeof next !== "object") return { ok: false, error: "Invalid update payload." };
    const curr = await db.calendarEvents.get(id);
    if (!curr) return { ok: false, error: "Not found." };

    const res = normalizeEvent({ ...next, id, createdAt: curr.createdAt });
    if (!res.ok) return { ok: false, error: res.error };

    try {
      await db.calendarEvents.put(res.record);
      const payload = { action: "event.update", event: res.record };
      emit("calendar.event_updated", payload);
      await exportToHubIfEnabled(payload);
      return { ok: true, data: res.record };
    } catch (err) {
      console.error("[CalendarsRepo.updateEvent] failed:", err);
      return { ok: false, error: err?.message || String(err) };
    }
  },

  async patchEvent(id, partial = {}) {
    ensureDB();
    if (!id || typeof partial !== "object") return { ok: false, error: "Invalid patch payload." };
    try {
      const curr = await db.calendarEvents.get(id);
      if (!curr) return { ok: false, error: "Not found." };

      // Maintain valid start/end if provided
      const next = { ...curr, ...partial, id, updatedAt: isoNow() };
      if (partial.start || partial.end) {
        const check = normalizeEvent(next);
        if (!check.ok) return { ok: false, error: check.error };
      }
      await db.calendarEvents.put(next);

      const payload = { action: "event.patch", event: next, fields: Object.keys(partial) };
      emit("calendar.event_patched", payload);
      await exportToHubIfEnabled(payload);
      return { ok: true, data: next };
    } catch (err) {
      console.error("[CalendarsRepo.patchEvent] failed:", err);
      return { ok: false, error: err?.message || String(err) };
    }
  },

  async removeEvent(id) {
    ensureDB();
    if (!id) return { ok: false, error: "Missing id." };
    try {
      const curr = await db.calendarEvents.get(id);
      if (!curr) return { ok: false, error: "Not found." };

      await db.calendarEvents.delete(id);
      const payload = { action: "event.delete", id, event: curr };
      emit("calendar.event_deleted", payload);
      await exportToHubIfEnabled(payload);
      return { ok: true, data: { id } };
    } catch (err) {
      console.error("[CalendarsRepo.removeEvent] failed:", err);
      return { ok: false, error: err?.message || String(err) };
    }
  },

  async cancelEvent(id, reason = null) {
    const res = await this.patchEvent(id, { status: "canceled", canceledAt: isoNow(), metadata: { ...(await this._getEventMeta(id)), cancelReason: reason } });
    if (res.ok) {
      const payload = { action: "event.cancel", id, reason };
      emit("calendar.event_canceled", payload);
      exportToHubIfEnabled(payload);
    }
    return res;
  },

  async completeEvent(id) {
    const res = await this.patchEvent(id, { status: "completed", completedAt: isoNow() });
    if (res.ok) {
      const payload = { action: "event.complete", id };
      emit("calendar.event_completed", payload);
      exportToHubIfEnabled(payload);
    }
    return res;
  },

  /* ------------------------------ Scheduling Aids ----------------------------- */

  /**
   * freeBusy({ calendars?, from, to })
   * Returns { busy: [{start,end,calendarId,eventId}], free: [{start,end}] } for the union window.
   */
  async freeBusy({ calendars = null, from, to } = {}) {
    ensureDB();
    if (!from || !to) return { ok: false, error: "from/to are required (ISO)." };

    const calIds = calendars
      ? Array.isArray(calendars)
        ? calendars
        : [calendars]
      : (await db.calendars.toArray()).map((c) => c.id);

    const eventsRes = await this.listEvents({ calendarId: calIds, from, to, expandRecurrence: true, limit: 10000 });
    if (!eventsRes.ok) return eventsRes;

    const busy = eventsRes.data.items.map((e) => ({
      start: e.start,
      end: e.end,
      calendarId: e.calendarId,
      eventId: e.id,
    }));

    const free = invertBusyIntervals([{ start: from, end: to }], busy);

    return { ok: true, data: { busy, free } };
  },

  /**
   * conflicts({ calendars?, from, to })
   * Returns events that overlap with each other within the window.
   */
  async conflicts({ calendars = null, from, to } = {}) {
    const res = await this.listEvents({ calendarId: calendars || null, from, to, expandRecurrence: true, limit: 10000 });
    if (!res.ok) return res;

    const items = res.data.items;
    const conflicts = [];
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        if (overlaps(items[i].start, items[i].end, items[j].start, items[j].end)) {
          conflicts.push([items[i], items[j]]);
        }
      }
    }
    return { ok: true, data: conflicts };
  },

  /**
   * quickAddSessionBlock({ calendarId?, sessionId, title, start, end, domain })
   * Convenience: schedule a session block on a calendar.
   */
  async quickAddSessionBlock({ calendarId = null, sessionId, title, start, end, domain = null } = {}) {
    if (!sessionId || !start || !end) return { ok: false, error: "sessionId, start, end required." };
    return this.createEvent({
      calendarId,
      sessionId,
      title: title || "Planned Session",
      start,
      end,
      domain,
      status: "confirmed",
    });
  },

  /**
   * attachCalendarToResource(calendarId, resourceId)
   */
  async attachCalendarToResource(calendarId, resourceId) {
    const res = await this.patchCalendar(calendarId, { resourceId });
    if (res.ok) {
      const payload = { action: "calendar.attach_resource", calendarId, resourceId };
      emit("calendar.attached_resource", payload);
      exportToHubIfEnabled(payload);
    }
    return res;
  },

  /**
   * attachCalendarToHousehold(calendarId, householdId)
   */
  async attachCalendarToHousehold(calendarId, householdId) {
    const res = await this.patchCalendar(calendarId, { householdId });
    if (res.ok) {
      const payload = { action: "calendar.attach_household", calendarId, householdId };
      emit("calendar.attached_household", payload);
      exportToHubIfEnabled(payload);
    }
    return res;
  },

  /* ----------------------------- Future Extensions ---------------------------- */

  /**
   * importICS(icsText, { calendarId? })
   * Placeholder for ICS import. Currently validates args and returns a stub.
   */
  async importICS(icsText, { calendarId = null } = {}) {
    if (typeof icsText !== "string" || !icsText.trim()) {
      return { ok: false, error: "icsText must be a non-empty string." };
    }
    // Implement parser in a worker/file later; keep API stable now.
    return { ok: true, data: { imported: 0, calendarId } };
  },

  /**
   * exportICS({ calendarId, from?, to? })
   * Placeholder for ICS export. Returns a minimal VCALENDAR string stub.
   */
  async exportICS({ calendarId, from = null, to = null } = {}) {
    const eventsRes = await this.listEvents({ calendarId, from, to, expandRecurrence: false, limit: 10000 });
    if (!eventsRes.ok) return eventsRes;
    const events = eventsRes.data.items;

    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Suka Smart Assistant//Calendar//EN",
    ];
    for (const e of events) {
      lines.push("BEGIN:VEVENT");
      lines.push(`UID:${e.id}`);
      lines.push(`DTSTAMP:${toICSDate(isoNow())}`);
      lines.push(`DTSTART:${toICSDate(e.start)}`);
      lines.push(`DTEND:${toICSDate(e.end)}`);
      lines.push(`SUMMARY:${escapeICS(e.title || "")}`);
      if (e.description) lines.push(`DESCRIPTION:${escapeICS(e.description)}`);
      lines.push("END:VEVENT");
    }
    lines.push("END:VCALENDAR");

    return { ok: true, data: lines.join("\r\n") };
  },

  /* ------------------------------- Private helpers ---------------------------- */

  async _getEventMeta(id) {
    try {
      const row = await db.calendarEvents.get(id);
      return row?.metadata || {};
    } catch {
      return {};
    }
  },
};

/* ----------------------------------------------------------------------------
 * Recurrence & free/busy helpers (simple, local)
 * -------------------------------------------------------------------------- */

function expandEvents(events, { from = null, to = null } = {}) {
  const out = [];
  for (const e of events) {
    if (!e.recurrence) {
      out.push(e);
      continue;
    }
    const occ = expandRecurrenceOccurrences(e, { from, to });
    out.push(...occ);
  }
  return out;
}

function expandRecurrenceOccurrences(event, { from = null, to = null } = {}) {
  // Supports FREQ=DAILY|WEEKLY|MONTHLY, INTERVAL, BYWEEKDAY (0..6), COUNT, UNTIL
  const rec = event.recurrence;
  if (!rec) return [event];

  const startT = new Date(event.start).getTime();
  const endT = new Date(event.end).getTime();
  const dur = endT - startT;

  const windowStart = from ? new Date(from).getTime() : null;
  const windowEnd = to ? new Date(to).getTime() : null;

  const until = rec.until ? new Date(rec.until).getTime() : null;
  const maxCount = rec.count || 500; // safety

  const results = [];
  let count = 0;

  if (rec.freq === "DAILY") {
    const step = (rec.interval || 1) * 24 * 3600 * 1000;
    for (let t = startT; shouldContinue(t, until, maxCount, count); t += step) {
      const s = t, e = t + dur;
      if (withinWindow(s, e, windowStart, windowEnd)) results.push(cloneEventAt(event, s, e));
      count++;
    }
  } else if (rec.freq === "WEEKLY") {
    // Start from week of start; emit on matching weekdays.
    const intervalWeeks = rec.interval || 1;
    const weekdays = rec.byweekday && rec.byweekday.length ? rec.byweekday : [new Date(startT).getDay()];
    const weekStart = startOfWeek(startT);
    for (let w = 0; shouldContinue(weekStart + w * 7 * 24 * 3600 * 1000, until, maxCount, count); w += intervalWeeks) {
      const base = weekStart + w * 7 * 24 * 3600 * 1000;
      for (const d of weekdays) {
        const s = alignDayTime(base, d, startT);
        if (s < startT) continue; // do not emit before first event start
        const e = s + dur;
        if (withinWindow(s, e, windowStart, windowEnd)) results.push(cloneEventAt(event, s, e));
        count++;
        if (!shouldContinue(s, until, maxCount, count)) break;
      }
    }
  } else if (rec.freq === "MONTHLY") {
    const intervalMonths = rec.interval || 1;
    // Use the calendar day of start
    const startDate = new Date(startT);
    const day = startDate.getUTCDate();
    for (let i = 0; shouldContinue(startDate.getTime(), until, maxCount, count); i += intervalMonths) {
      const sDate = addMonthsUTC(startDate, i);
      if (sDate.getUTCDate() !== day) {
        // If month rollover (e.g., 31st), clamp to last day of month
        const last = lastDayOfMonthUTC(sDate.getUTCFullYear(), sDate.getUTCMonth());
        sDate.setUTCDate(last);
      }
      const s = Date.UTC(
        sDate.getUTCFullYear(),
        sDate.getUTCMonth(),
        sDate.getUTCDate(),
        new Date(startT).getUTCHours(),
        new Date(startT).getUTCMinutes(),
        new Date(startT).getUTCSeconds(),
        new Date(startT).getUTCMilliseconds()
      );
      if (s < startT) continue;
      const e = s + dur;
      if (withinWindow(s, e, windowStart, windowEnd)) results.push(cloneEventAt(event, s, e));
      count++;
    }
  } else {
    // Unknown freq; return base event
    return [event];
  }

  return results;
}

function shouldContinue(t, until, maxCount, count) {
  if (count >= maxCount) return false;
  if (until && t > until) return false;
  return true;
}

function withinWindow(s, e, wStart, wEnd) {
  if (wStart && e < wStart) return false;
  if (wEnd && s >= wEnd) return false;
  return true;
}

function cloneEventAt(event, startMs, endMs) {
  return {
    ...event,
    // Keep id to represent the "series item" id or generate a synthetic one for UI
    id: `${event.id}@${startMs}`,
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    // mark derived occurrence
    metadata: { ...(event.metadata || {}), occurrenceOf: event.id },
  };
}

function startOfWeek(t) {
  const d = new Date(t);
  const day = d.getUTCDay();
  const diff = -day; // week starts Sunday (0)
  d.setUTCDate(d.getUTCDate() + diff);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

function alignDayTime(weekStartMs, weekday, templateMs) {
  const d = new Date(weekStartMs);
  d.setUTCDate(d.getUTCDate() + weekday);
  const template = new Date(templateMs);
  d.setUTCHours(template.getUTCHours(), template.getUTCMinutes(), template.getUTCSeconds(), template.getUTCMilliseconds());
  return d.getTime();
}

function addMonthsUTC(date, months) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()));
  return d;
}

function lastDayOfMonthUTC(year, month /* 0-based */) {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  const as = new Date(aStart).getTime();
  const ae = new Date(aEnd).getTime();
  const bs = new Date(bStart).getTime();
  const be = new Date(bEnd).getTime();
  return as < be && bs < ae;
}

function invertBusyIntervals(windowIntervals, busy) {
  // windowIntervals: [{start,end}]
  // busy: [{start,end}]
  const free = [];
  for (const win of windowIntervals) {
    const ws = new Date(win.start).getTime();
    const we = new Date(win.end).getTime();
    if (!(Number.isFinite(ws) && Number.isFinite(we) && we > ws)) continue;

    // collect busy segments within this window
    const segments = busy
      .map((b) => ({
        s: new Date(b.start).getTime(),
        e: new Date(b.end).getTime(),
      }))
      .filter((b) => overlaps(win.start, win.end, new Date(b.s).toISOString(), new Date(b.e).toISOString()))
      .sort((a, b) => a.s - b.s);

    let cursor = ws;
    for (const seg of segments) {
      if (seg.s > cursor) {
        free.push({ start: new Date(cursor).toISOString(), end: new Date(Math.min(seg.s, we)).toISOString() });
      }
      cursor = Math.max(cursor, seg.e);
      if (cursor >= we) break;
    }
    if (cursor < we) {
      free.push({ start: new Date(cursor).toISOString(), end: new Date(we).toISOString() });
    }
  }
  return free;
}

function toICSDate(iso) {
  const d = new Date(iso);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(
    d.getUTCMinutes()
  )}${pad(d.getUTCSeconds())}Z`;
}

function escapeICS(text) {
  return String(text).replace(/([,;])/g, "\\$1").replace(/\n/g, "\\n");
}

/* ----------------------------------------------------------------------------
 * Default calendar selection
 * -------------------------------------------------------------------------- */

async function pickDefaultCalendar() {
  try {
    const list = await db.calendars.toArray();
    if (list.length) return list.find((c) => c.status === "active") || list[0];
  } catch {}
  // Create an ephemeral default calendar in-memory? No—callers should handle null.
  return null;
}

export default CalendarsRepo;
