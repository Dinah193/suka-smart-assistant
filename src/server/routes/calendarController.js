// C:\Users\larho\suka-smart-assistant\src\server\routes\calendarController.js
//
// Suka Smart Assistant — Calendar Controller
// Purpose:
//   - Provider-agnostic HTTP API for creating/updating/deleting calendar events
//   - Designed for calls from n8n workflows and internal agents
//   - Delegates to src/server/services/calendarService.js when available
//
// Endpoints:
//   GET    /api/calendar/health
//   GET    /api/calendar/providers
//   POST   /api/calendar/events                 -> create 1..N events (upsert optional)
//   DELETE /api/calendar/events/:eventId        -> delete a single event
//   POST   /api/calendar/batch/delete           -> delete multiple events
//   POST   /api/calendar/rrule/expand           -> expand RRULE into ISO datetimes
//   POST   /api/calendar/schedule/suggest       -> suggest next allowed slots (Sabbath/quiet-hour aware)
//   POST   /api/calendar/worker/assignments/create -> create events from WorkerTasks-like payloads
//
// Notes:
//   - Uses Ajv for strict payload validation
//   - If calendarService is missing, responds ok:false with instructions (graceful)
//   - Timestamps: accept ISO strings; default tz via GENERIC_TIMEZONE (falls back to America/Chicago)
//   - Sabbath/quiet-hours nudging is available per-request (opt-in)
//   - Metadata passthrough for tracing (source, tags, linkBack)
//
// Optional security:
//   Mount with verifyN8nSignature on routes that n8n calls:
//     import { verifyN8nSignature } from "../middleware/verifyN8nSignature.js";
//     app.use("/api/calendar", rawJson, verifyN8nSignature, calendarController);
//
// Install (if needed): npm i ajv ajv-formats
//

import express from "express";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const router = express.Router();

const ajv = new Ajv({ allErrors: true, removeAdditional: "failing", strict: false });
addFormats(ajv);

/* -----------------------------------------------------------------------------
   Utilities & dynamic service import
----------------------------------------------------------------------------- */

function badRequest(res, message, details) {
  return res.status(400).json({ ok: false, error: message, details });
}

function notImplemented(res, hint) {
  return res.status(501).json({
    ok: false,
    error: "calendarService not available",
    hint:
      hint ||
      "Create src/server/services/calendarService.js exporting createEvent/createEventsBatch/deleteEvent/listProviders",
  });
}

async function loadCalendarService() {
  try {
    const mod = await import("../services/calendarService.js");
    return mod?.default || mod;
  } catch {
    return null;
  }
}

const DEFAULT_TZ = process.env.GENERIC_TIMEZONE || "America/Chicago";

const DAY = 86400000;
const toISO = (d) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());
const isISODateOnly = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function parseBool(v, d = false) {
  if (typeof v === "boolean") return v;
  if (v == null) return d;
  const s = String(v).toLowerCase();
  return ["1","true","yes","y"].includes(s) ? true : ["0","false","no","n"].includes(s) ? false : d;
}

function inQuietHours(date, { start = 21, end = 7 } = {}) {
  const h = date.getHours();
  return start < end ? (h >= start && h < end) : (h >= start || h < end);
}
function isSabbath(date, { avoidSabbath = false, saturdayAsSabbath = false } = {}) {
  if (!avoidSabbath) return false;
  // Approximate: treat Saturday as day to avoid; upstream Hebrew calendar can refine.
  return saturdayAsSabbath ? date.getDay() === 6 : date.getDay() === 6;
}
function nudgeToAllowed(date, { avoidSabbath = false, saturdayAsSabbath = false, quietHours = { start: 21, end: 7 }, defaultHour = 9 } = {}) {
  let d = new Date(date);
  let guard = 0;
  while ((isSabbath(d, { avoidSabbath, saturdayAsSabbath }) || inQuietHours(d, quietHours)) && guard < 14) {
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, defaultHour, 0, 0, 0);
    guard++;
  }
  return d;
}

/** Normalize event object minimally */
function normalizeEvent(e) {
  const out = { ...e };
  if (!out.timezone) out.timezone = DEFAULT_TZ;

  // allDay convenience: accept date-only strings and infer [start 00:00, end 23:59:59.999]
  if (isISODateOnly(out.start) && isISODateOnly(out.end)) {
    out.allDay = true;
  }

  if (typeof out.start !== "string") out.start = String(out.start);
  if (typeof out.end !== "string") out.end = String(out.end);

  if (!Array.isArray(out.reminders)) out.reminders = [];
  // default 10-min popup if nothing specified and not all-day
  if (!out.allDay && out.reminders.length === 0) {
    out.reminders = [{ minutes: 10, method: "popup" }];
  }
  return out;
}

/* -----------------------------------------------------------------------------
   Validation Schemas
----------------------------------------------------------------------------- */

const attendeeSchema = {
  type: "object",
  required: ["email"],
  properties: {
    email: { type: "string" },
    name: { type: "string" },
    optional: { type: "boolean" },
  },
  additionalProperties: false,
};

const reminderSchema = {
  type: "object",
  required: ["minutes"],
  properties: {
    minutes: { type: "integer", minimum: 0 },
    method: { type: "string", enum: ["popup", "email", "sms"], default: "popup" },
  },
  additionalProperties: false,
};

const eventSchema = {
  type: "object",
  required: ["title", "start", "end"],
  properties: {
    title: { type: "string", minLength: 1 },
    description: { type: "string" },
    start: { type: "string", minLength: 3 }, // ISO datetime or YYYY-MM-DD
    end: { type: "string", minLength: 3 },   // ISO datetime or YYYY-MM-DD
    timezone: { type: "string", minLength: 3, default: DEFAULT_TZ },
    allDay: { type: "boolean", default: false },
    location: { type: "string" },
    attendees: { type: "array", items: attendeeSchema },
    reminders: { type: "array", items: reminderSchema },
    transparency: { type: "string", enum: ["opaque", "transparent"], default: "opaque" },
    visibility: { type: "string", enum: ["default", "public", "private"], default: "default" },
    metadata: {
      type: "object",
      properties: {
        source: { type: "string" },  // e.g., "n8n.sabbath-prep"
        tags: { type: "array", items: { type: "string" } },
        linkBack: { type: "string" }, // URL
      },
      additionalProperties: true,
    },
    externalId: { type: "string" }, // for idempotent upsert
  },
  additionalProperties: false,
};

const createPayloadSchema = {
  type: "object",
  required: ["provider", "calendarId", "events"],
  properties: {
    provider: { type: "string", enum: ["google", "outlook", "local"] },
    calendarId: { type: "string", minLength: 1 },
    upsert: { type: "boolean", default: true },
    sabbathAware: { type: "boolean", default: false },
    saturdayAsSabbath: { type: "boolean", default: false },
    quietHours: {
      type: "object",
      properties: { start: { type: "integer", minimum: 0, maximum: 23 }, end: { type: "integer", minimum: 0, maximum: 23 } },
      additionalProperties: false
    },
    defaultHour: { type: "integer", minimum: 0, maximum: 23, default: 9 },
    events: {
      anyOf: [
        eventSchema,
        { type: "array", items: eventSchema, minItems: 1 },
      ],
    },
  },
  additionalProperties: false,
};

const deleteBatchSchema = {
  type: "object",
  required: ["provider", "calendarId", "eventIds"],
  properties: {
    provider: { type: "string", enum: ["google", "outlook", "local"] },
    calendarId: { type: "string", minLength: 1 },
    eventIds: { type: "array", minItems: 1, items: { type: "string" } },
  },
  additionalProperties: false,
};

const rruleExpandSchema = {
  type: "object",
  required: ["start", "rrule"],
  properties: {
    start: { type: "string", minLength: 3 }, // ISO start (anchor)
    rrule: { type: "string", minLength: 5 }, // e.g., "FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=1"
    durationMinutes: { type: "integer", minimum: 0, default: 60 },
    count: { type: "integer", minimum: 1, maximum: 200 },
    until: { type: "string" }, // ISO
    sabbathAware: { type: "boolean", default: false },
    saturdayAsSabbath: { type: "boolean", default: false },
    quietHours: {
      type: "object",
      properties: { start: { type: "integer", minimum: 0, maximum: 23 }, end: { type: "integer", minimum: 0, maximum: 23 } },
      additionalProperties: false
    },
    defaultHour: { type: "integer", minimum: 0, maximum: 23, default: 9 },
  },
  additionalProperties: false,
};

const suggestSchema = {
  type: "object",
  properties: {
    after: { type: "string" }, // ISO start scan time
    windowDays: { type: "integer", minimum: 1, maximum: 60, default: 14 },
    slots: { type: "integer", minimum: 1, maximum: 20, default: 3 },
    sabbathAware: { type: "boolean", default: true },
    saturdayAsSabbath: { type: "boolean", default: false },
    quietHours: {
      type: "object",
      properties: { start: { type: "integer", minimum: 0, maximum: 23 }, end: { type: "integer", minimum: 0, maximum: 23 } },
      additionalProperties: false
    },
    durationMinutes: { type: "integer", minimum: 5, maximum: 24*60, default: 60 },
    defaultHour: { type: "integer", minimum: 0, maximum: 23, default: 9 },
  },
  additionalProperties: false,
};

const workerCreateSchema = {
  type: "object",
  required: ["provider", "calendarId", "assignments"],
  properties: {
    provider: { type: "string", enum: ["google", "outlook", "local"] },
    calendarId: { type: "string" },
    upsert: { type: "boolean", default: true },
    assignments: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["taskId", "task"],
        properties: {
          taskId: { type: "string" },
          task: {
            type: "object",
            required: ["name", "task"],
            properties: {
              name: { type: "string" },
              task: { type: "string" },
              dueHint: { type: "string" }, // ISO
              priorityScore: { type: "integer" },
              metadata: { type: "object", additionalProperties: true }
            },
            additionalProperties: true
          },
          role: { type: "string" }
        },
        additionalProperties: true
      }
    },
    sabbathAware: { type: "boolean", default: false },
    saturdayAsSabbath: { type: "boolean", default: false },
    quietHours: {
      type: "object",
      properties: { start: { type: "integer", minimum: 0, maximum: 23 }, end: { type: "integer", minimum: 0, maximum: 23 } },
      additionalProperties: false
    },
    defaultHour: { type: "integer", minimum: 0, maximum: 23, default: 9 },
  },
  additionalProperties: false
};

const validateCreate = ajv.compile(createPayloadSchema);
const validateDeleteBatch = ajv.compile(deleteBatchSchema);
const validateExpand = ajv.compile(rruleExpandSchema);
const validateSuggest = ajv.compile(suggestSchema);
const validateWorkerCreate = ajv.compile(workerCreateSchema);

/* -----------------------------------------------------------------------------
   Routes
----------------------------------------------------------------------------- */

/** Health check */
router.get("/health", (_req, res) => {
  res.json({ ok: true, tz: DEFAULT_TZ });
});

/** List providers/calendars (best-effort) */
router.get("/providers", async (_req, res) => {
  const svc = await loadCalendarService();
  if (!svc?.listProviders) return notImplemented(res, "calendarService.listProviders() missing");
  try {
    const data = await svc.listProviders();
    return res.json({ ok: true, data });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * Create 1..N events (idempotent upsert supported via externalId)
 * Body:
 *  {
 *    provider: "google"|"outlook"|"local",
 *    calendarId: "primary" | "...",
 *    upsert?: true,
 *    sabbathAware?: false,
 *    saturdayAsSabbath?: false,
 *    quietHours?: { start, end },
 *    defaultHour?: 9,
 *    events: Event or Event[]
 *  }
 */
router.post("/events", express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    if (!validateCreate(body)) {
      const msg = validateCreate.errors?.map(e => `${e.instancePath || "/"} ${e.message}`).join("; ");
      return badRequest(res, msg || "Invalid payload", validateCreate.errors);
    }

    const svc = await loadCalendarService();
    if (!svc) return notImplemented(res);
    if (!svc.createEvent && !svc.createEventsBatch) {
      return notImplemented(res, "calendarService.createEvent/createEventsBatch missing");
    }

    const { provider, calendarId, upsert = true, sabbathAware = false, saturdayAsSabbath = false, quietHours, defaultHour = 9 } = body;

    // Normalize events array
    const eventsArray = Array.isArray(body.events) ? body.events : [body.events];
    const normalized = eventsArray.map(normalizeEvent).map((ev) => {
      // If sabbathAware, nudge start/end to allowed time (for non-all-day)
      if (sabbathAware && !ev.allDay) {
        const startNudged = nudgeToAllowed(new Date(ev.start), { avoidSabbath: true, saturdayAsSabbath, quietHours, defaultHour });
        const durationMs = new Date(ev.end).getTime() - new Date(ev.start).getTime();
        const endNudged = new Date(startNudged.getTime() + Math.max(5 * 60_000, durationMs));
        return { ...ev, start: toISO(startNudged), end: toISO(endNudged) };
      }
      // all-day date-only convenience
      if (ev.allDay && isISODateOnly(ev.start) && isISODateOnly(ev.end)) {
        const start = new Date(`${ev.start}T00:00:00.000`);
        const end = new Date(`${ev.end}T23:59:59.999`);
        return { ...ev, start: toISO(start), end: toISO(end) };
      }
      return ev;
    });

    let result;
    if (svc.createEventsBatch) {
      result = await svc.createEventsBatch({ provider, calendarId, events: normalized, upsert });
    } else {
      const outputs = [];
      for (const ev of normalized) {
        const out = await svc.createEvent({ provider, calendarId, data: ev, upsert });
        outputs.push(out);
      }
      result = outputs;
    }

    return res.json({ ok: true, result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/** Delete a single event (requires provider & calendarId query) */
router.delete("/events/:eventId", async (req, res) => {
  const { eventId } = req.params || {};
  const { provider, calendarId } = req.query || {};
  if (!eventId || !provider || !calendarId) {
    return badRequest(res, "Missing eventId, provider, or calendarId");
  }

  const svc = await loadCalendarService();
  if (!svc?.deleteEvent) return notImplemented(res, "calendarService.deleteEvent missing");

  try {
    const result = await svc.deleteEvent({ provider: String(provider), calendarId: String(calendarId), eventId: String(eventId) });
    return res.json({ ok: true, result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/** Delete multiple events */
router.post("/batch/delete", express.json(), async (req, res) => {
  const body = req.body || {};
  if (!validateDeleteBatch(body)) {
    const msg = validateDeleteBatch.errors?.map(e => `${e.instancePath || "/"} ${e.message}`).join("; ");
    return badRequest(res, msg || "Invalid payload", validateDeleteBatch.errors);
  }

  const svc = await loadCalendarService();
  if (!svc?.deleteEvent) return notImplemented(res, "calendarService.deleteEvent missing");

  const { provider, calendarId, eventIds } = body;
  try {
    const results = [];
    for (const id of eventIds) {
      const r = await svc.deleteEvent({ provider, calendarId, eventId: id });
      results.push({ eventId: id, ...r });
    }
    return res.json({ ok: true, results });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/* -----------------------------------------------------------------------------
   RRULE expansion (lightweight, weekly/daily/monthly basics)
----------------------------------------------------------------------------- */

function parseRRule(rr) {
  const map = {};
  rr.split(";").forEach(kv => {
    const [k, v] = kv.split("=");
    map[k?.toUpperCase()] = v;
  });
  return map;
}
const BYDAY_ORDER = ["SU","MO","TU","WE","TH","FR","SA"];

function* expandRRule({ start, rrule, count, until, sabbathAware, saturdayAsSabbath, quietHours, defaultHour }) {
  const anchor = new Date(start);
  const rule = parseRRule(rrule);
  const freq = (rule.FREQ || "WEEKLY").toUpperCase();
  const interval = Math.max(1, parseInt(rule.INTERVAL || "1", 10));
  const byDay = (rule.BYDAY || "").split(",").filter(Boolean);

  let cursor = new Date(anchor);
  let produced = 0;
  const untilDate = until ? new Date(until) : null;

  const step = () => {
    if (freq === "DAILY") cursor = new Date(cursor.getTime() + interval * DAY);
    else if (freq === "WEEKLY") cursor = new Date(cursor.getTime() + 7 * interval * DAY);
    else if (freq === "MONTHLY") {
      const c = new Date(cursor);
      c.setMonth(c.getMonth() + interval);
      cursor = c;
    } else {
      // default weekly
      cursor = new Date(cursor.getTime() + 7 * interval * DAY);
    }
  };

  const emitIfAllowed = (d) => {
    const base = new Date(d);
    const nudged = sabbathAware
      ? nudgeToAllowed(base, { avoidSabbath: true, saturdayAsSabbath, quietHours, defaultHour })
      : base;
    if (!untilDate || nudged <= untilDate) {
      produced++;
      return nudged;
    }
    return null;
  };

  while ((count ? produced < count : true)) {
    if (untilDate && cursor > untilDate) break;

    if (freq === "WEEKLY" && byDay.length) {
      // Walk the 7-day window from cursor's week
      const weekStart = new Date(cursor);
      for (let i = 0; i < 7; i++) {
        const d = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + i, anchor.getHours(), anchor.getMinutes(), 0, 0);
        const code = BYDAY_ORDER[d.getDay()];
        if (byDay.includes(code)) {
          const out = emitIfAllowed(d);
          if (out) yield out;
          if (count && produced >= count) return;
        }
      }
      step();
      continue;
    }

    const out = emitIfAllowed(cursor);
    if (out) yield out;
    step();
  }
}

/** Expand RRULE into occurrence start times */
router.post("/rrule/expand", express.json(), async (req, res) => {
  const body = req.body || {};
  if (!validateExpand(body)) {
    const msg = validateExpand.errors?.map(e => `${e.instancePath || "/"} ${e.message}`).join("; ");
    return badRequest(res, msg || "Invalid payload", validateExpand.errors);
  }
  const { start, rrule, durationMinutes = 60, count, until, sabbathAware = false, saturdayAsSabbath = false, quietHours, defaultHour = 9 } = body;
  const out = [];
  for (const occ of expandRRule({ start, rrule, count, until, sabbathAware, saturdayAsSabbath, quietHours, defaultHour })) {
    const s = occ;
    const e = new Date(s.getTime() + clamp(durationMinutes, 5, 24 * 60) * 60_000);
    out.push({ start: toISO(s), end: toISO(e) });
    if (out.length >= (count || 200)) break;
  }
  return res.json({ ok: true, occurrences: out });
});

/* -----------------------------------------------------------------------------
   Suggestions (find next allowed slots)
----------------------------------------------------------------------------- */
router.post("/schedule/suggest", express.json(), async (req, res) => {
  const body = req.body || {};
  if (!validateSuggest(body)) {
    const msg = validateSuggest.errors?.map(e => `${e.instancePath || "/"} ${e.message}`).join("; ");
    return badRequest(res, msg || "Invalid payload", validateSuggest.errors);
  }
  const {
    after = new Date().toISOString(),
    windowDays = 14,
    slots = 3,
    sabbathAware = true,
    saturdayAsSabbath = false,
    quietHours,
    durationMinutes = 60,
    defaultHour = 9
  } = body;

  const results = [];
  let cursor = new Date(after);
  const end = new Date(new Date(after).getTime() + windowDays * DAY);

  while (cursor <= end && results.length < slots) {
    const candidate = new Date(cursor);
    candidate.setHours(defaultHour, 0, 0, 0);
    const nudged = sabbathAware ? nudgeToAllowed(candidate, { avoidSabbath: true, saturdayAsSabbath, quietHours, defaultHour }) : candidate;
    if (nudged >= new Date(after)) {
      const e = new Date(nudged.getTime() + durationMinutes * 60_000);
      results.push({ start: toISO(nudged), end: toISO(e) });
    }
    cursor = new Date(cursor.getTime() + DAY);
  }

  return res.json({ ok: true, suggestions: results });
});

/* -----------------------------------------------------------------------------
   WorkerTasks bridge: create calendar events from WorkerTasks assignments
----------------------------------------------------------------------------- */
/**
 * Body:
 * {
 *   provider, calendarId, upsert?,
 *   assignments: [{
 *     taskId, role?,
 *     task: { name, task, dueHint?, priorityScore?, metadata? }
 *   }],
 *   sabbathAware?, saturdayAsSabbath?, quietHours?, defaultHour?
 * }
 */
router.post("/worker/assignments/create", express.json(), async (req, res) => {
  const body = req.body || {};
  if (!validateWorkerCreate(body)) {
    const msg = validateWorkerCreate.errors?.map(e => `${e.instancePath || "/"} ${e.message}`).join("; ");
    return badRequest(res, msg || "Invalid payload", validateWorkerCreate.errors);
  }

  const svc = await loadCalendarService();
  if (!svc) return notImplemented(res);
  if (!svc.createEventsBatch && !svc.createEvent) return notImplemented(res, "calendarService.createEvent/createEventsBatch missing");

  const {
    provider, calendarId, upsert = true,
    assignments,
    sabbathAware = false,
    saturdayAsSabbath = false,
    quietHours,
    defaultHour = 9
  } = body;

  // Map assignments → events
  const events = (assignments || []).map((a) => {
    const title = a.task?.name || "Task";
    const desc = a.task?.task || "";
    const startBase = a.task?.dueHint ? new Date(a.task.dueHint) : nudgeToAllowed(new Date(), { avoidSabbath: sabbathAware, saturdayAsSabbath, quietHours, defaultHour });
    const durationMin = a.task?.effort?.minutes ? clamp(Number(a.task.effort.minutes), 5, 240) : 60;
    const start = sabbathAware
      ? nudgeToAllowed(startBase, { avoidSabbath: true, saturdayAsSabbath, quietHours, defaultHour })
      : startBase;
    const end = new Date(start.getTime() + durationMin * 60_000);

    const metadata = {
      source: "WorkerTasks",
      tags: [a.role || "general", ...(a.task?.requiredSkills || [])],
      linkBack: a.task?.metadata?.link || "",
      ...(a.task?.metadata || {})
    };

    return normalizeEvent({
      title,
      description: desc,
      start: toISO(start),
      end: toISO(end),
      timezone: DEFAULT_TZ,
      location: a.task?.metadata?.zone || "",
      reminders: [{ minutes: 10, method: "popup" }],
      metadata,
      externalId: `task-${a.taskId}` // idempotent
    });
  });

  let result;
  if (svc.createEventsBatch) {
    result = await svc.createEventsBatch({ provider, calendarId, events, upsert });
  } else {
    const outputs = [];
    for (const ev of events) outputs.push(await svc.createEvent({ provider, calendarId, data: ev, upsert }));
    result = outputs;
  }

  return res.json({ ok: true, result, created: events.length });
});

export default router;

/* -----------------------------------------------------------------------------
  Example calendarService.js contract (to place at src/server/services/calendarService.js):

  // export async function listProviders() {
  //   return [
  //     { provider: "google", calendars: [{ id: "primary", name: "Primary" }] },
  //     { provider: "local", calendars: [{ id: "household", name: "Household" }] },
  //   ];
  // }

  // export async function createEventsBatch({ provider, calendarId, events, upsert = true }) {
  //   // Switch by provider and call respective API. Return array of { id, htmlLink, start, end, summary }.
  //   return events.map((e, i) => ({ id: e.externalId || `mock-${i}`, htmlLink: "", start: e.start, end: e.end, summary: e.title }));
  // }

  // export async function createEvent({ provider, calendarId, data, upsert = true }) {
  //   return { id: data.externalId || "mock-1", start: data.start, end: data.end, summary: data.title };
  // }

  // export async function deleteEvent({ provider, calendarId, eventId }) {
  //   return { deleted: true, eventId };
  // }
----------------------------------------------------------------------------- */
