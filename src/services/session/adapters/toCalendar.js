// C:\Users\larho\suka-smart-assistant\src\services\session\adapters\toCalendar.js
// Session → Calendar Writer
// -----------------------------------------------------------------------------
// ROLE IN PIPELINE
// imports → intelligence → automation → (optional) hub export
//                                    └─ this adapter turns an APPROVED session
//                                       into concrete calendar holds, from
//                                       plannedStart → deadline (or computed
//                                       from duration/window), and mirrors to
//                                       device/person calendars when possible.
//
// What this module does
// ---------------------
// • Exposes `writeHoldsForSession(session, opts)` that:
//    - validates / normalizes time window
//    - writes a primary hold to the household calendar
//    - (best-effort) reserves devices & people based on session.equipment/roles
//    - emits SCHEDULE_SAVED (canonical payload) on success
// • Wires event handlers:
//    - respond("adapter/calendar/write") → { ok, hold(s) }
//    - on("session/approved") → writes holds
//    - on("session/discarded") → attempts to delete corresponding holds
// • Uses the shared eventBus; payload shape normalized upstream to:
//      { type, ts, source, data }
//
// Safety & Notes
// --------------
// • Defensive against missing start/deadline. If neither provided, it won’t write.
// • Idempotent by sessionId: uses upsert when the calendar service supports it.
// • If a change affects household planning data, exportToHubIfEnabled() is called,
//   but this file itself never talks to the Hub directly.
//
// Extension hooks
// ---------------
// • New domains (preservation/animals/storehouse) ride on the same mapping.
// • Device/Person reservation is optional: if those services are absent, we skip gracefully.
// -----------------------------------------------------------------------------

/* --------------------------------- Imports --------------------------------- */
let eventBus, Events;
try {
  const eb = require("@/services/events/eventBus.js");
  eventBus = eb.default || eb.eventBus || eb;
  Events = eb.Events || {};
} catch {
  try {
    const eb = require("@/services/events/eventBus.js");
    eventBus = eb.default || eb.eventBus || eb;
    Events = eb.Events || {};
  } catch {
    eventBus = { emit: () => {}, on: () => () => {}, respond: () => () => {} };
    Events = {};
  }
}

let householdCalendar = null;
let deviceCalendar = null;
let personCalendar = null;
try {
  householdCalendar =
    require("@/services/calendar/householdCalendar").default ||
    require("@/services/calendar/householdCalendar");
} catch {}
try {
  deviceCalendar =
    require("@/services/calendar/deviceCalendar").default ||
    require("@/services/calendar/deviceCalendar");
} catch {}
try {
  personCalendar =
    require("@/services/calendar/personCalendar").default ||
    require("@/services/calendar/personCalendar");
} catch {}

let featureFlags = {};
try {
  featureFlags =
    require("@/config/featureFlags").default ||
    require("@/config/featureFlags");
} catch {}

let HubPacketFormatter, FamilyFundConnector;
try {
  HubPacketFormatter = require("@/services/hub/HubPacketFormatter");
  FamilyFundConnector = require("@/services/hub/FamilyFundConnector");
} catch {
  /* optional */
}

/* ---------------------------------- API ------------------------------------ */
/** Initialize event glue for writing calendar holds */
export function initCalendarWriter() {
  // RPC: write holds on demand
  if (eventBus?.respond) {
    eventBus.respond("adapter/calendar/write", async (payload) => {
      try {
        const { session, opts } = payload?.session
          ? payload
          : { session: payload, opts: {} };
        const res = await writeHoldsForSession(session, opts);
        return { ok: true, ...res };
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
    });
  }

  // When a session is approved, write its holds
  eventBus.on(
    Events?.SESSION_APPROVED || "session/approved",
    async ({ data }) => {
      const session = data?.session || data;
      try {
        const res = await writeHoldsForSession(session, { emitToast: true });
        emit(Events?.SCHEDULE_SAVED || "schedule/saved", {
          kind: "session",
          sessionId: session?.id,
          holds: res?.holds || [],
        });
        exportToHubIfEnabled({
          type: "schedule/saved",
          ts: new Date().toISOString(),
          source: "adapter.calendar",
          data: { sessionId: session?.id, holds: res?.holds || [] },
        });
      } catch (e) {
        emit(Events?.SESSION_ERROR || "session/error", {
          domain: session?.domain || "general",
          error: String(e?.message || e),
          input: safeSmall(session),
        });
      }
    },
    { priority: 1 }
  );

  // When a session is discarded, try to remove its holds
  eventBus.on(
    Events?.SESSION_DISCARDED || "session/discarded",
    async ({ data }) => {
      const sessionId = data?.sessionId || data?.id || data?.session?.id;
      if (!sessionId) return;
      try {
        const removed = await deleteHoldsForSession(sessionId);
        if (removed?.count > 0) {
          emit(Events?.SCHEDULE_DELETED || "schedule/deleted", {
            sessionId,
            ...removed,
          });
          exportToHubIfEnabled({
            type: "schedule/deleted",
            ts: new Date().toISOString(),
            source: "adapter.calendar",
            data: { sessionId, ...removed },
          });
        }
      } catch {
        /* silent */
      }
    },
    { priority: 1 }
  );
}

/**
 * Write (or upsert) calendar holds for a single approved session.
 * @param {object} session
 * @param {{emitToast?:boolean}} opts
 * @returns {{holds:Array<any>, window:{startISO:string,endISO:string}}}
 */
export async function writeHoldsForSession(session = {}, opts = {}) {
  const s = normalizeSession(session);
  const wnd = resolveWindow(s);
  if (!wnd)
    throw new Error(
      "calendar/write: session needs a start or a window with duration"
    );

  // Primary household hold
  const hold = buildHouseholdHold(s, wnd);
  const saved = await upsertHouseholdHold(hold);

  // Best-effort device reservations
  const deviceResults = await reserveDevicesIfPossible(s, wnd, saved?.id);

  // Best-effort person/role reservations
  const peopleResults = await reservePeopleIfPossible(s, wnd, saved?.id);

  const holds = [saved, ...deviceResults, ...peopleResults].filter(Boolean);

  if (opts.emitToast) {
    emit(Events?.UI_TOAST || "ui/toast", {
      variant: "success",
      title: "Scheduled",
      message: s.title ? `${s.title} placed on calendar` : "Session scheduled",
    });
  }

  return { holds, window: wnd };
}

/**
 * Attempt to delete holds connected to a sessionId across calendars (best-effort).
 */
export async function deleteHoldsForSession(sessionId) {
  let removed = 0;
  try {
    removed += (await tryDelete(householdCalendar, sessionId)) || 0;
  } catch {}
  try {
    removed += (await tryDelete(deviceCalendar, sessionId)) || 0;
  } catch {}
  try {
    removed += (await tryDelete(personCalendar, sessionId)) || 0;
  } catch {}
  return { count: removed };
}

/* ------------------------------ Core helpers ------------------------------- */
function normalizeSession(x = {}) {
  // Expect fields based on adapters (fromCooking/fromCleaning/fromGarden/...):
  // { id, domain, title, location, durationMin, window?, meta?, equipment?, rolesNeeded? }
  const title = String(x.title || "Household Session");
  const domain = String(x.domain || "general");
  const durationMin = clamp(
    num(x.durationMin) || num(x.meta?.durationMin),
    5,
    12 * 60
  );
  const window = isWindow(x.window)
    ? x.window
    : {
        startISO: firstISO(
          x.plannedStart,
          x.startISO,
          x.time?.start,
          x.meta?.plannedStart
        ),
        endISO: firstISO(x.deadline, x.endISO, x.time?.end, x.meta?.deadline),
      };
  const equipment = Array.isArray(x.equipment) ? x.equipment : [];
  const roles = Array.isArray(x.rolesNeeded) ? x.rolesNeeded : [];
  return {
    id: String(x.id || ""),
    title,
    domain,
    durationMin,
    window,
    noisy: !!x.noisy,
    outdoor: !!x.outdoor,
    location: x.location || undefined,
    tags: x.meta?.tags || [],
    priority: x.meta?.priority || "normal",
    equipment,
    roles,
  };
}

function resolveWindow(s) {
  // Determine final {startISO, endISO}:
  // - If start and end given: honor them (validate order)
  // - If start only: end = start + duration
  // - If end only: start = end - duration
  const start = firstISO(s.window?.startISO);
  const end = firstISO(s.window?.endISO);
  const durMs = (s.durationMin || 0) * 60000;

  if (start && end) {
    const a = Date.parse(start),
      b = Date.parse(end);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null;
    return {
      startISO: new Date(a).toISOString(),
      endISO: new Date(b).toISOString(),
    };
  }
  if (start && durMs > 0) {
    const e = new Date(Date.parse(start) + durMs).toISOString();
    return { startISO: new Date(start).toISOString(), endISO: e };
  }
  if (end && durMs > 0) {
    const st = new Date(Date.parse(end) - durMs).toISOString();
    return { startISO: st, endISO: new Date(end).toISOString() };
  }
  return null;
}

function buildHouseholdHold(s, wnd) {
  return {
    id: makeHoldId("household", s.id),
    sessionId: s.id || undefined,
    title: s.title,
    domain: s.domain,
    location: s.location,
    startISO: wnd.startISO,
    endISO: wnd.endISO,
    flags: {
      noisy: s.noisy,
      outdoor: s.outdoor,
      priority: s.priority,
    },
    tags: Array.isArray(s.tags) ? s.tags : [],
    metadata: {
      type: "session",
      source: "adapter.calendar",
      createdBy: "SSA",
    },
  };
}

async function upsertHouseholdHold(hold) {
  // Try a few method names to be compatible with our calendar service
  if (!householdCalendar)
    throw new Error("household calendar service unavailable");
  if (typeof householdCalendar.upsertHold === "function") {
    return await householdCalendar.upsertHold(hold);
  }
  if (typeof householdCalendar.createHold === "function") {
    // createHold should be idempotent per hold.id; if it throws "exists", try update
    try {
      return await householdCalendar.createHold(hold);
    } catch {
      if (typeof householdCalendar.updateHold === "function") {
        return await householdCalendar.updateHold(hold.id, hold);
      }
      throw new Error("calendar: cannot upsert hold");
    }
  }
  if (typeof householdCalendar.saveBlock === "function") {
    return await householdCalendar.saveBlock(hold);
  }
  throw new Error("household calendar has no compatible writer");
}

async function reserveDevicesIfPossible(s, wnd, parentHoldId) {
  if (!deviceCalendar) return [];
  const eq = (s.equipment || []).filter((e) => e?.kind || e?.deviceId);
  if (!eq.length) return [];
  const results = [];
  for (const e of eq) {
    const hold = {
      id: makeHoldId("device", s.id, e.deviceId || e.kind),
      sessionId: s.id || undefined,
      parentId: parentHoldId,
      deviceId: e.deviceId,
      deviceKind: e.kind,
      title: `${s.title} • ${e.title || e.kind || "device"}`,
      startISO: wnd.startISO,
      endISO: wnd.endISO,
      domain: s.domain,
      metadata: { type: "device-hold", source: "adapter.calendar" },
    };
    try {
      if (typeof deviceCalendar.reserve === "function") {
        results.push(await deviceCalendar.reserve(hold));
      } else if (typeof deviceCalendar.upsertHold === "function") {
        results.push(await deviceCalendar.upsertHold(hold));
      } else if (typeof deviceCalendar.createHold === "function") {
        results.push(await deviceCalendar.createHold(hold));
      }
    } catch {
      /* skip one device and continue */
    }
  }
  return results;
}

async function reservePeopleIfPossible(s, wnd, parentHoldId) {
  if (!personCalendar) return [];
  const roles = (s.roles || s.rolesNeeded || []).filter((r) => r?.role);
  if (!roles.length) return [];
  const results = [];
  for (const r of roles) {
    const hold = {
      id: makeHoldId("person", s.id, r.role),
      sessionId: s.id || undefined,
      parentId: parentHoldId,
      role: r.role,
      requiredCount: num(r.count) || 1,
      title: `${s.title} • ${toTitle(r.role)}`,
      startISO: wnd.startISO,
      endISO: wnd.endISO,
      domain: s.domain,
      metadata: { type: "person-hold", source: "adapter.calendar" },
    };
    try {
      if (typeof personCalendar.reserve === "function") {
        results.push(await personCalendar.reserve(hold));
      } else if (typeof personCalendar.upsertHold === "function") {
        results.push(await personCalendar.upsertHold(hold));
      } else if (typeof personCalendar.createHold === "function") {
        results.push(await personCalendar.createHold(hold));
      }
    } catch {
      /* skip one role and continue */
    }
  }
  return results;
}

async function tryDelete(cal, sessionId) {
  if (!cal) return 0;
  // Prefer "removeBySession", otherwise list+delete
  if (typeof cal.removeBySession === "function") {
    const out = await cal.removeBySession(sessionId);
    return out?.count || 0;
  }
  if (
    typeof cal.findBySession === "function" &&
    typeof cal.deleteHold === "function"
  ) {
    const arr = await cal.findBySession(sessionId);
    let n = 0;
    for (const h of arr || []) {
      try {
        await cal.deleteHold(h.id);
        n++;
      } catch {}
    }
    return n;
  }
  return 0;
}

/* --------------------------- Middleware + events --------------------------- */
function emit(type, data) {
  if (!eventBus?.emit) return;
  eventBus.emit(type, data, { source: "adapter.calendar" });
}

/* ------------------------------ Hub mirroring ------------------------------ */
async function exportToHubIfEnabled(payload) {
  try {
    if (!featureFlags || !featureFlags.familyFundMode) return;
    if (!HubPacketFormatter || !FamilyFundConnector) return;
    const pkt = HubPacketFormatter.format(payload);
    await FamilyFundConnector.send(pkt);
  } catch {
    /* fail-silent */
  }
}

/* --------------------------------- Utils ----------------------------------- */
function makeHoldId(scope, sessionId, suffix) {
  const base = sessionId ? String(sessionId) : genId();
  return suffix ? `${scope}:${base}:${String(suffix)}` : `${scope}:${base}`;
}

function isWindow(w) {
  return !!(w && (isISO(w.startISO) || isISO(w.endISO)));
}

function firstISO(...vals) {
  return vals.find(isISO) || undefined;
}
function isISO(s) {
  return typeof s === "string" && !Number.isNaN(Date.parse(s));
}

function num(n) {
  return Number.isFinite(n) ? n : Number.isFinite(+n) ? +n : undefined;
}
function clamp(n, lo, hi) {
  const x = Number.isFinite(n) ? n : lo;
  return Math.max(lo, Math.min(hi, x));
}
function toTitle(s) {
  return String(s || "").replace(/\b\w/g, (c) => c.toUpperCase());
}
function genId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
function safeSmall(obj) {
  try {
    const s = JSON.stringify(obj);
    return s && s.length > 2000 ? s.slice(0, 2000) + "…" : s;
  } catch {
    return "[unserializable]";
  }
}

/* --------------------------------- Exports --------------------------------- */
export default {
  initCalendarWriter,
  writeHoldsForSession,
  deleteHoldsForSession,
};
