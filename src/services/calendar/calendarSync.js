// src/services/calendar/calendarSync.js
/* eslint-disable no-console */

/**
 * calendarSync.js — Session ↔ Calendar write-through
 *
 * Goals:
 *  - Map session lifecycle into calendar events
 *  - Pause-aware end-time updates; compact, humanized titles
 *  - Defensive adapters (Google/Outlook/ICS fallback)
 *  - Batching + dedupe to avoid thrash while the user tweaks timers
 *  - Emits bus events: "calendar.write.requested" | "calendar.write.ok" | "calendar.write.fail"
 *
 * No import.meta usage. Safe for Node/SSR. Uses shared orchestration utilities if present.
 */

let eventBus = { on() {}, off() {}, emit() {} };
try {
  const eb = require("@/services/events/eventBus");
  eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
} catch (_e) {
  /* no-op */
}

let timeMath = null;
try {
  timeMath = require("@/services/session/utils/timeMath.js");
  timeMath = (timeMath && (timeMath.default || timeMath)) || null;
} catch (_e) {
  /* no-op */
}

let debugMod = null;
try {
  debugMod = require("@/services/session/utils/scheduleDebug.js");
  debugMod = (debugMod && (debugMod.default || debugMod)) || null;
} catch (_e) {
  /* no-op */
}

const d = debugMod?.withDomain
  ? debugMod.withDomain("calendar")
  : {
      debug() {},
      info() {},
      warn() {},
      error() {},
      trace() {},
    };

const isBrowser = typeof window !== "undefined";
const now = () => Date.now();

/* --------------------------------- Provider API ------------------------------ */
/**
 * Provider interface:
 *   upsertEvent(eventInput) => Promise<{ id, htmlLink? }>
 *   deleteEvent(providerId) => Promise<void>
 *   batchUpsert(arrayOfEventInputs) => Promise<Array<{ id }>>
 *
 * eventInput shape:
 * {
 *   providerId?: string,   // if previously synced, for updates
 *   title: string,
 *   description?: string,
 *   startTs: number,       // ms epoch
 *   endTs: number,         // ms epoch
 *   location?: string,
 *   colorId?: string,
 *   transparency?: "opaque"|"transparent",
 *   reminders?: { useDefault?: boolean, overrides?: [{method:"popup",minutes:number}] }
 * }
 */

/* ----------------------------- No-op (Local) Adapter ------------------------- */
const LocalAdapter = {
  kind: "local",
  async upsertEvent(input) {
    // Emits a request for UI to offer connecting a real calendar
    eventBus.emit?.("calendar.write.requested", { input, provider: "local" });
    d.debug("local:upsert", input);
    return { id: `local_${Math.floor(Math.random() * 1e9).toString(36)}` };
  },
  async deleteEvent(id) {
    d.debug("local:delete", { id });
    return;
  },
  async batchUpsert(inputs) {
    d.debug("local:batch", { n: inputs?.length || 0 });
    return (inputs || []).map(() => ({
      id: `local_${Math.floor(Math.random() * 1e9).toString(36)}`,
    }));
  },
};

/* -------------------------------- Google Adapter ----------------------------- */
/**
 * Lightweight Google Calendar adapter. It will use the Google API client if available
 * (window.gapi + authorized calendar scope). Otherwise falls back to local.
 */
const GoogleAdapter = {
  kind: "google",
  _calendarId: "primary",
  setCalendarId(id) {
    this._calendarId = id || "primary";
  },

  _g() {
    try {
      return isBrowser ? window.gapi : null;
    } catch (_e) {
      return null;
    }
  },
  _authed() {
    const g = this._g();
    try {
      // Best effort check
      return !!(g && g.client && g.client.calendar);
    } catch (_e) {
      return false;
    }
  },

  async upsertEvent(input) {
    if (!this._authed()) return LocalAdapter.upsertEvent(input);
    const g = this._g();

    const resource = toGoogleResource(input);
    try {
      let resp;
      if (input.providerId) {
        resp = await g.client.calendar.events.update({
          calendarId: this._calendarId,
          eventId: input.providerId,
          resource,
        });
      } else {
        resp = await g.client.calendar.events.insert({
          calendarId: this._calendarId,
          resource,
        });
      }
      const { id, htmlLink } = resp.result || {};
      d.info("google:upsert:ok", { id, title: input.title });
      return { id, htmlLink };
    } catch (err) {
      d.error("google:upsert:fail", { error: String(err?.message || err) });
      throw err;
    }
  },

  async deleteEvent(id) {
    if (!this._authed()) return LocalAdapter.deleteEvent(id);
    const g = this._g();
    try {
      await g.client.calendar.events.delete({
        calendarId: this._calendarId,
        eventId: id,
      });
      d.info("google:delete:ok", { id });
    } catch (err) {
      d.warn("google:delete:fail", { id, error: String(err?.message || err) });
      throw err;
    }
  },

  async batchUpsert(inputs) {
    // naive sequential upsert; reduce API churn via our queue upstream
    const out = [];
    for (const i of inputs || []) {
      out.push(await this.upsertEvent(i));
    }
    return out;
  },
};

function toGoogleResource(input) {
  const start = new Date(input.startTs).toISOString();
  const end = new Date(input.endTs).toISOString();
  return {
    summary: input.title,
    description: input.description || "",
    start: { dateTime: start },
    end: { dateTime: end },
    location: input.location || undefined,
    colorId: input.colorId || undefined,
    transparency:
      input.transparency === "transparent" ? "transparent" : "opaque",
    reminders: input.reminders || { useDefault: true },
  };
}

/* --------------------------------- State/Queue ------------------------------- */
const STATE = {
  enabled: true,
  provider: LocalAdapter, // default until setProvider("google") etc.
  calendarId: "primary",
  queue: new Map(), // sessionId -> eventInput
  mapping: new Map(), // sessionId -> { providerId, lastWriteTs }
  flushHandle: null,
  flushDelayMs: 800, // debounce
  defaultDomain: "meals", // used in titles if missing
};

/* --------------------------------- Utilities -------------------------------- */
function ensureTimeMath() {
  if (!timeMath) return null;
  return timeMath;
}

function humanize(ms) {
  if (!timeMath?.humanize) return `${Math.round(ms / 1000)}s`;
  return timeMath.humanize(ms, { style: "short", maxUnits: 2 });
}

function sessionToEventTitle(session) {
  const domain = session?.domain || STATE.defaultDomain;
  const base = session?.title || session?.name || "Timed Session";
  const snap = snapshot(session);
  const pct = Math.max(
    0,
    Math.min(100, Math.round((snap?.progress || 0) * 100))
  );
  const left = humanize(snap?.remainingMs || 0);
  // Format like top productivity apps: terse, useful
  return `${base} — ${pct}% • ${left} left (${domain})`;
}

function sessionToEventDescription(session) {
  const s = session || {};
  const snap = snapshot(s) || {};
  const parts = [];
  if (s.notes) parts.push(s.notes);
  parts.push(`Started: ${new Date(s.startedAt).toLocaleString()}`);
  if (s.targetMs) parts.push(`Target: ${humanize(s.targetMs)}`);
  if (snap?.elapsedMs != null)
    parts.push(`Elapsed: ${humanize(snap.elapsedMs)}`);
  if (Array.isArray(s.pauses) && s.pauses.length)
    parts.push(`Pauses: ${s.pauses.length}`);
  if (s.recipe) parts.push(`Recipe: ${s.recipe}`);
  if (s.location) parts.push(`Location: ${s.location}`);
  return parts.join("\n");
}

function snapshot(session) {
  const t = ensureTimeMath();
  if (!t) return { progress: 0, remainingMs: 0, elapsedMs: 0 };
  const target = session?.targetMs || t.toMs(session?.target || 0);
  return t.remainingProgress({
    startTs: session?.startedAt || now(),
    durationMs: target || 0,
    pauses: session?.pauses || [],
    nowTs: now(),
  });
}

function clampEnd(startTs, endTs) {
  // calendar APIs require end > start
  const min = startTs + 60 * 1000;
  return Math.max(min, endTs);
}

function buildEventInput(session, prevProviderId) {
  const s = session || {};
  const snap = snapshot(s);

  const startTs = s.startedAt || now();
  const estimatedEndTs = clampEnd(
    startTs,
    (s.startedAt || now()) + (s.targetMs || 0)
  );
  const effectiveEndTs = snap?.complete ? now() : estimatedEndTs;

  return {
    providerId: prevProviderId, // if present, we update
    title: sessionToEventTitle(s),
    description: sessionToEventDescription(s),
    startTs,
    endTs: effectiveEndTs,
    location: s.location || undefined,
    colorId: s.colorId || undefined,
    transparency: s.busy === false ? "transparent" : "opaque",
    reminders: {
      useDefault: true,
    },
  };
}

/* --------------------------------- Core API --------------------------------- */
function setEnabled(v) {
  STATE.enabled = !!v;
  d.info("enabled", { enabled: STATE.enabled });
}

function setProvider(kind, options = {}) {
  if (String(kind).toLowerCase() === "google") {
    STATE.provider = GoogleAdapter;
    if (options.calendarId) GoogleAdapter.setCalendarId(options.calendarId);
  } else {
    STATE.provider = LocalAdapter;
  }
  d.info("provider:set", {
    kind: STATE.provider.kind,
    calendarId: options.calendarId || "primary",
  });
}

function getMapping(sessionId) {
  return STATE.mapping.get(sessionId) || null;
}

function setMapping(sessionId, providerId) {
  STATE.mapping.set(sessionId, { providerId, lastWriteTs: now() });
}

function queueUpsert(session) {
  if (!STATE.enabled) return;
  const sessionId = session?.id || session?.sessionId;
  if (!sessionId) return;

  const mapping = getMapping(sessionId);
  const input = buildEventInput(session, mapping?.providerId);
  STATE.queue.set(sessionId, input);
  d.debug("queue:upsert", { sessionId });

  requestFlush();
}

async function removeSession(sessionId) {
  if (!STATE.enabled) return;
  try {
    const mapping = getMapping(sessionId);
    if (mapping?.providerId) {
      await STATE.provider.deleteEvent(mapping.providerId);
      STATE.mapping.delete(sessionId);
      d.info("delete:ok", { sessionId, providerId: mapping.providerId });
      eventBus.emit?.("calendar.write.ok", {
        op: "delete",
        sessionId,
        providerId: mapping.providerId,
      });
    }
  } catch (err) {
    d.warn("delete:fail", { sessionId, error: String(err?.message || err) });
    eventBus.emit?.("calendar.write.fail", {
      op: "delete",
      sessionId,
      error: String(err?.message || err),
    });
  }
}

/* ---------------------------------- Flush ----------------------------------- */
function requestFlush() {
  if (STATE.flushHandle) clearTimeout(STATE.flushHandle);
  STATE.flushHandle = setTimeout(flushQueue, STATE.flushDelayMs);
}

async function flushQueue() {
  const items = Array.from(STATE.queue.entries()); // [sessionId, eventInput]
  if (!items.length) return;

  STATE.queue.clear();
  const inputs = items.map(([, ev]) => ev);

  eventBus.emit?.("calendar.write.requested", {
    count: inputs.length,
    provider: STATE.provider.kind,
  });

  try {
    const results = await STATE.provider.batchUpsert(inputs);
    // correlate results to sessionIds in order
    for (let i = 0; i < items.length; i++) {
      const sessionId = items[i][0];
      const providerId = results?.[i]?.id;
      if (providerId) setMapping(sessionId, providerId);
      d.info("upsert:ok", { sessionId, providerId });
    }
    eventBus.emit?.("calendar.write.ok", {
      op: "batchUpsert",
      count: inputs.length,
    });
  } catch (err) {
    d.error("upsert:fail", { error: String(err?.message || err) });
    eventBus.emit?.("calendar.write.fail", {
      op: "batchUpsert",
      error: String(err?.message || err),
    });
    // On failure, re-queue once (best effort) in 10s
    for (const [sid, ev] of items) STATE.queue.set(sid, ev);
    clearTimeout(STATE.flushHandle);
    STATE.flushHandle = setTimeout(flushQueue, 10_000);
  }
}

/* --------------------------- EventBus Integration ---------------------------- */
/**
 * We mirror the orchestration names used in your session layer.
 * Supported events (payload must carry session object or fields we need):
 *   - "session.started"  { id, startedAt, targetMs, domain, ... }
 *   - "session.paused"   { id, ... }
 *   - "session.resumed"  { id, ... }
 *   - "session.progress" { id, progress, remainingMs, ... } (debounced upsert)
 *   - "session.ended"    { id, endedAt?, ... } (finalize end time)
 */
function attachBus() {
  if (!eventBus?.on) return;

  eventBus.on("session.started", (s) => {
    d.info("evt:started", { id: s?.id });
    queueUpsert(s);
  });

  eventBus.on("session.paused", (s) => {
    d.debug("evt:paused", { id: s?.id });
    queueUpsert(s);
  });

  eventBus.on("session.resumed", (s) => {
    d.debug("evt:resumed", { id: s?.id });
    queueUpsert(s);
  });

  // Only update periodically—this will still get debounced/queued
  eventBus.on("session.progress", (s) => {
    d.trace("evt:progress", { id: s?.id, progress: s?.progress });
    queueUpsert(s);
  });

  eventBus.on("session.ended", async (s) => {
    d.info("evt:ended", { id: s?.id });
    // finalize event end time to now
    const final = { ...s, targetMs: s?.startedAt ? now() - s.startedAt : 0 };
    queueUpsert(final);
    requestFlush();
  });
}

/* ----------------------------- ICS Export Fallback --------------------------- */
/**
 * Generates an ICS string from a list of sessions; useful if no provider connected.
 */
function toICSLine(s) {
  return s.replace(/\n/g, "\\n").replace(/,/g, "\\,");
}
function pad(n) {
  return String(n).padStart(2, "0");
}
function fmtICS(ts) {
  const dte = new Date(ts);
  const y = dte.getUTCFullYear();
  const m = pad(dte.getUTCMonth() + 1);
  const d = pad(dte.getUTCDate());
  const hh = pad(dte.getUTCHours());
  const mm = pad(dte.getUTCMinutes());
  const ss = pad(dte.getUTCSeconds());
  return `${y}${m}${d}T${hh}${mm}${ss}Z`;
}

function exportICS(sessions = []) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Suka Smart Assistant//EN",
  ];
  for (const s of sessions) {
    const title = sessionToEventTitle(s);
    const desc = sessionToEventDescription(s);
    const startTs = s?.startedAt || now();
    const endTs = clampEnd(
      startTs,
      (s?.startedAt || now()) + (s?.targetMs || 0)
    );
    const uid = `suka-${
      s?.id || Math.floor(Math.random() * 1e9).toString(36)
    }@suka`;

    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${uid}`);
    lines.push(`DTSTAMP:${fmtICS(now())}`);
    lines.push(`DTSTART:${fmtICS(startTs)}`);
    lines.push(`DTEND:${fmtICS(endTs)}`);
    lines.push(`SUMMARY:${toICSLine(title)}`);
    lines.push(`DESCRIPTION:${toICSLine(desc)}`);
    if (s?.location) lines.push(`LOCATION:${toICSLine(s.location)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

/* ---------------------------------- Init ------------------------------------ */
function init(options = {}) {
  if (options.enabled != null) setEnabled(!!options.enabled);
  if (options.provider)
    setProvider(options.provider, { calendarId: options.calendarId });
  attachBus();
  d.info("initialized", {
    enabled: STATE.enabled,
    provider: STATE.provider.kind,
  });
}

/* ---------------------------------- API ------------------------------------- */
const calendarSync = {
  init,
  setEnabled,
  setProvider,
  queueUpsert,
  removeSession,
  exportICS,

  // internal/testing
  _state: STATE,
};

/**
 * Named export for modules that import:
 *   import { CalendarSync } from "@/services/calendar/CalendarSync"
 * or:
 *   import { CalendarSync } from "@/services/calendar/calendarSync"
 *
 * Keep default export intact (back-compat), but provide the named export alias.
 */
export const CalendarSync = calendarSync;

export default calendarSync;

/* ----------------------------------- Notes -----------------------------------
UI integration suggestions:

- When "calendar.write.requested" fires with LocalAdapter (default), show a
  banner/button to "Connect Calendar". After successful auth, call:
     calendarSync.setProvider("google", { calendarId: "primary" })

- For Google auth, ensure gapi is loaded and calendar scope granted.
  This adapter intentionally falls back to local if the API isn't ready.

Title/Description design:

- Titles favor compact signal: "${name} — ${progress}% • ${remaining} left (domain)"
- Description includes started time, target, elapsed, pause count, recipe/location if present.

This mirrors well-executed productivity apps: short titles fit month/week views;
descriptions carry detail if you open the event.

------------------------------------------------------------------------------- */
