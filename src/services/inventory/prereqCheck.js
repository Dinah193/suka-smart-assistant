// C:\Users\larho\suka-smart-assistant\src\services\inventory\prereqCheck.js
// Session Prerequisite Checker
// -----------------------------------------------------------------------------
// ROLE IN PIPELINE
// imports → intelligence → automation → (optional) hub export
//                           └─ when sessions are scheduled, this module verifies
//                              required inventory + tools (and people, optionally)
//                              both immediately and again 6h before start.
// It emits canonical events through eventBus (which wraps payloads to
// { type, ts, source, data }):
//   • inventory/shortageDetected
//   • ui/toast
//   • ui/nbaSuggested
//   • session/error  (if fatal issues are detected)
//
// Extension points:
//   - New domains (preservation, animals, storehouse) simply provide equipment
//     and ingredient requirements in session.meta and this checker will query
//     the appropriate responders via eventBus.ask(...).
//
// Assumptions / contracts (soft):
//   - deviceCalendar.respond("device/availability", ...) is available (see deviceCalendar.js).
//   - personCalendar.respond("person/roleAvailability", ...) is available (optional).
//   - Inventory layer responds to "inventory/check" with:
//       { ok: true, items: [{ id|sku|name, need: number, have: number }] }
//     (We defensively handle missing responders.)
//
// Persistence:
//   - Pending preflight checks are persisted in localStorage to survive reloads.
// -----------------------------------------------------------------------------

/* --------------------------------- Imports --------------------------------- */
let eventBus, Events;
try {
  const eb = require("@/services/events/eventBus.js");
  eventBus = eb.default || eb.eventBus || eb;
  Events = eb.Events || {};
} catch {
  try {
    const eb = require("@/services/eventBus.js");
    eventBus = eb.default || eb.eventBus || eb;
    Events = eb.Events || {};
  } catch {
    eventBus = {
      emit: () => {},
      on: () => () => {},
      once: () => () => {},
      ask: async () => ({}),
      respond: () => () => {},
    };
    Events = {};
  }
}

let featureFlags = {};
try {
  featureFlags = require("@/config/featureFlags").default || require("@/config/featureFlags");
} catch {}

let HubPacketFormatter, FamilyFundConnector;
try {
  HubPacketFormatter = require("@/services/hub/HubPacketFormatter");
  FamilyFundConnector = require("@/services/hub/FamilyFundConnector");
} catch {}

/* --------------------------------- State ----------------------------------- */
const _timers = new Map(); // sessionId -> timeoutId
const LS_KEY = "ssa.prereq.pending.v1";
let _initialized = false;

/* ---------------------------------- API ------------------------------------ */
export async function initPrereqCheck() {
  if (_initialized) return;
  _initialized = true;

  // Rehydrate any pending preflight schedules
  try {
    const pending = JSON.parse(localStorage.getItem(LS_KEY) || "[]");
    if (Array.isArray(pending)) {
      const now = Date.now();
      for (const it of pending) {
        if (!it?.sessionId || !isISO(it?.start)) continue;
        const startMs = toMs(it.start);
        const target = Math.max(now, startMs - HOURS(6));
        schedulePreflight(it.sessionId, it, target);
      }
    }
  } catch {}

  // 1) When a domain draft becomes a shared session draft ready (glue handles),
  // 2) and especially when a session is APPROVED / SCHEDULE_SAVED, run prereq.
  eventBus.on(Events?.SESSION_DRAFT_READY || "session/draftReady", ({ data }) => {
    // Soft check on drafts if time window present
    const s = readSessionData(data);
    if (s.sessionId && s.start && s.end) runCheckAndMaybeSchedule(s, { soft: true });
  });

  // Main trigger: APPROVED session (user confirmed)
  eventBus.on(Events?.SESSION_APPROVED || "session/approved", ({ data }) => {
    const s = readSessionData(data);
    if (s.sessionId && s.start && s.end) runCheckAndMaybeSchedule(s, { soft: false });
  });

  // Also listen to calendar save if sessions are persisted there
  eventBus.on(Events?.SCHEDULE_SAVED || "schedule/saved", ({ data }) => {
    const item = data?.item || {};
    if ((item.kind === "session" || /session/i.test(item?.title || "")) && item?.start && item?.end) {
      const s = {
        sessionId: item?.meta?.sessionId || item.id,
        domain: item?.domain || item?.meta?.domain,
        start: item.start,
        end: item.end,
        title: item.title,
        ingredients: extractIngredients(item?.meta),
        equipment: extractEquipment(item?.meta),
        roles: extractRoles(item?.meta),
      };
      runCheckAndMaybeSchedule(s, { soft: false });
    }
  });
}

/* --------------------------- Core functionality ---------------------------- */
/**
 * Performs immediate prerequisite check, emits events with findings,
 * then schedules a re-check 6 hours before the session start.
 */
async function runCheckAndMaybeSchedule(session, { soft = false } = {}) {
  // 1) Immediate check
  const results = await performPrereqCheck(session);

  // 2) Emit UX and shortage signals
  announceResults(session, results, { soft });

  // 3) Schedule 6h-before re-check
  const startMs = toMs(session.start);
  const target = Math.max(Date.now(), startMs - HOURS(6));
  schedulePreflight(session.sessionId, session, target);
}

/** Schedules the 6-hours-before check; persists to LS for resilience. */
function schedulePreflight(sessionId, session, targetMs) {
  clearPreflight(sessionId); // ensure only one timer

  const wait = Math.max(0, targetMs - Date.now());
  const t = setTimeout(async () => {
    try {
      const res = await performPrereqCheck(session);
      announceResults(session, res, { soft: false, window: "6h-before" });
    } finally {
      clearPreflight(sessionId);
    }
  }, wait);

  _timers.set(sessionId, t);
  persistPendingSchedules();
}

/** Cancels a pending preflight, if any. */
function clearPreflight(sessionId) {
  const t = _timers.get(sessionId);
  if (t) clearTimeout(t);
  _timers.delete(sessionId);
  persistPendingSchedules();
}

/** Persist all current timers (sessions) to localStorage */
function persistPendingSchedules() {
  try {
    const arr = Array.from(_timers.keys()).map((k) => _pendingIndex.get(k)).filter(Boolean);
    localStorage.setItem(LS_KEY, JSON.stringify(arr));
  } catch {}
}

/* We keep an index of the last scheduled session metadata to persist */
const _pendingIndex = new Map(); // sessionId -> {sessionId, start, end, title, domain}
function rememberPending(session) {
  _pendingIndex.set(session.sessionId, {
    sessionId: session.sessionId,
    start: session.start,
    end: session.end,
    title: session.title,
    domain: session.domain,
  });
}
function forgetPending(sessionId) {
  _pendingIndex.delete(sessionId);
}

/* ---------------------------- The actual checks ---------------------------- */
/**
 * Perform prerequisite checks:
 *  - Inventory needed ingredients/consumables
 *  - Equipment/device slot availability for the scheduled window
 *  - Optional role/person availability
 *
 * Returns a compact report for UX + automation.
 */
async function performPrereqCheck(session) {
  const { sessionId, domain, start, end, ingredients, equipment, roles } = session;
  if (!sessionId || !isISO(start) || !isISO(end)) {
    return { ok: false, reason: "missing-session-times", shortages: [], toolsConflicts: [], rolesConflicts: [] };
  }

  const durationMin = Math.max(1, Math.round((toMs(end) - toMs(start)) / 60000));
  const window = { startISO: start, endISO: end };

  // Inventory check (best-effort)
  const inv = await safeAsk("inventory/check", { items: ingredients });
  const shortages = normalizeShortages(inv, ingredients);

  // Device availability check (best-effort)
  let toolsConflicts = [];
  if (equipment.length) {
    const kinds = distinct(equipment.map(e => e.kind).filter(Boolean));
    const deviceIds = distinct(equipment.map(e => e.deviceId).filter(Boolean));
    const devRes = await safeAsk("device/availability", {
      deviceIds: deviceIds.length ? deviceIds : undefined,
      kinds: deviceIds.length ? undefined : kinds,
      startISO: start,
      endISO: end,
      durationMin,
      granularityMin: 5,
      applyQuiet: true,
    });
    toolsConflicts = findToolConflicts(equipment, devRes?.slots || [], start, end);
  }

  // Role availability (optional)
  let rolesConflicts = [];
  if (roles.length) {
    for (const need of roles) {
      const rr = await safeAsk("person/roleAvailability", {
        role: need.role,
        startISO: start,
        endISO: end,
        durationMin,
        granularityMin: 15,
        domain,
      });
      const ok = (rr?.slots || []).some(s => within(s.start, s.end, start, end));
      if (!ok) rolesConflicts.push({ role: need.role });
    }
  }

  const ok = shortages.length === 0 && toolsConflicts.length === 0 && rolesConflicts.length === 0;
  return { ok, shortages, toolsConflicts, rolesConflicts, window, durationMin };
}

/* ----------------------------- Announcements ------------------------------- */
function announceResults(session, results, { soft = false, window = "immediate" } = {}) {
  const { sessionId, title, domain } = session;
  rememberPending(session); // store minimal info for persistence
  persistPendingSchedules();

  // 1) Inventory shortages → emit SSA-level event
  if (Array.isArray(results.shortages) && results.shortages.length) {
    const data = {
      sessionId,
      domain,
      title,
      window,
      items: results.shortages,
    };
    emit(Events?.INVENTORY_SHORTAGE_DETECTED || "inventory/shortageDetected", data);
    // UX hints
    emit(Events?.UI_NBA_SUGGESTED || "ui/nbaSuggested", {
      label: "Open Grocery List",
      route: "/tier2/household/meals#grocery",
      hint: "Add missing items before session",
    });
    emit(Events?.UI_TOAST || "ui/toast", {
      variant: "warning",
      title: "Some items are missing",
      message: `${results.shortages.length} item(s) short for "${title || "session"}".`,
    });
    // Optional hub mirror (not required because it's not mutating, but useful)
    exportToHubIfEnabled({
      type: "inventory/shortageDetected",
      ts: new Date().toISOString(),
      source: "prereqCheck",
      data,
    });
  }

  // 2) Tool/device conflicts → UX event
  if (Array.isArray(results.toolsConflicts) && results.toolsConflicts.length) {
    emit(Events?.UI_TOAST || "ui/toast", {
      variant: "warning",
      title: "Equipment conflict",
      message: `Some equipment isn’t available for "${title || "session"}".`,
    });
    emit("device/conflictDetected", {
      sessionId,
      conflicts: results.toolsConflicts,
      window,
      domain,
    });
    emit(Events?.UI_NBA_SUGGESTED || "ui/nbaSuggested", {
      label: "Suggest another time",
      hint: "Find a free slot",
      route: "/tier2/household/schedule#assist",
    });
  }

  // 3) Role conflicts → UX event
  if (Array.isArray(results.rolesConflicts) && results.rolesConflicts.length) {
    emit(Events?.UI_TOAST || "ui/toast", {
      variant: "info",
      title: "Helpers not available",
      message: `No matching role available for "${title || "session"}" at this time.`,
    });
    emit("people/conflictDetected", {
      sessionId,
      conflicts: results.rolesConflicts,
      window,
      domain,
    });
  }

  // 4) All good → gentle toast on final window (not on soft checks)
  if (results.ok && !soft) {
    emit(Events?.UI_TOAST || "ui/toast", {
      variant: "success",
      title: "You’re all set",
      message: `"${title || "Session"}" has what it needs.`,
    });
  }

  // If everything is fine, we can clear pending schedule once at start time,
  // but we keep the 6h-before timer until it fires (already handled).
}

/* -------------------------------- Helpers ---------------------------------- */
function readSessionData(data) {
  // Accept several shapes:
  // data.session with meta, or data.draft, or direct fields on data
  const src = data?.session || data?.draft || data || {};
  const meta = src?.meta || data?.meta || {};
  const time = src?.time || {};
  return {
    sessionId: String(src?.id || meta?.sessionId || meta?.id || ""),
    domain: src?.domain || meta?.domain,
    title: src?.title || meta?.title,
    start: firstISO(src?.start, time?.start, meta?.start),
    end: firstISO(src?.end, time?.end, meta?.end),
    ingredients: extractIngredients(meta),
    equipment: extractEquipment(meta),
    roles: extractRoles(meta),
  };
}

function extractIngredients(meta) {
  // Expect meta.ingredients: [{ id|sku|name, qty, unit }]
  const arr = Array.isArray(meta?.ingredients) ? meta.ingredients : [];
  return arr
    .map((x) => ({
      id: String(x?.id || x?.sku || x?.name || ""),
      qty: Number(x?.qty || x?.quantity || 0),
      unit: x?.unit || "",
    }))
    .filter((x) => x.id && x.qty > 0);
}

function extractEquipment(meta) {
  // Expect meta.equipment: [{ deviceId?, kind?, title? }]
  const arr = Array.isArray(meta?.equipment) ? meta.equipment : [];
  return arr
    .map((x) => ({
      deviceId: x?.deviceId ? String(x.deviceId) : undefined,
      kind: x?.kind ? String(x.kind) : undefined,
      title: x?.title,
    }))
    .filter((x) => x.deviceId || x.kind);
}

function extractRoles(meta) {
  // Expect meta.rolesNeeded: [{ role }]
  const arr = Array.isArray(meta?.rolesNeeded) ? meta.rolesNeeded : [];
  return arr.map((x) => ({ role: String(x?.role || "") })).filter((x) => x.role);
}

function normalizeShortages(invRes, requested) {
  const reqIndex = new Map(requested.map((r) => [r.id, r]));
  const out = [];
  if (invRes && Array.isArray(invRes.items)) {
    for (const it of invRes.items) {
      const key = String(it?.id || it?.sku || it?.name || "");
      const need = Number(it?.need ?? reqIndex.get(key)?.qty ?? 0);
      const have = Number(it?.have ?? 0);
      if (need > have) {
        out.push({ id: key, need, have, delta: need - have });
      }
    }
  } else {
    // If no responder, we conservatively return empty (no shortages known)
  }
  return out;
}

function findToolConflicts(equipment, slots, start, end) {
  // We flag conflict if none of the slots cover the entire window for a given requested device/kind
  const res = [];
  for (const eq of equipment) {
    const ok = (slots || []).some((s) => {
      const match =
        (eq.deviceId && s.deviceId === eq.deviceId) ||
        (!eq.deviceId && eq.kind && !!s.deviceId); // when kind-only, any available device works
      return match && within(s.start, s.end, start, end);
    });
    if (!ok) res.push({ deviceId: eq.deviceId, kind: eq.kind, title: eq.title });
  }
  return res;
}

/* --------------------------------- eventBus -------------------------------- */
function emit(type, data) {
  if (!eventBus?.emit) return;
  eventBus.emit(type, data, { source: "prereqCheck" });
}

async function safeAsk(base, payload) {
  try {
    if (!eventBus?.ask) return null;
    const ans = await eventBus.ask(base, payload, 12_000);
    return ans;
  } catch {
    return null;
  }
}

/* ------------------------------ Hub mirroring ------------------------------ */
async function exportToHubIfEnabled(payload) {
  try {
    if (!featureFlags || !featureFlags.familyFundMode) return;
    if (!HubPacketFormatter || !FamilyFundConnector) return;
    const pkt = HubPacketFormatter.format(payload);
    await FamilyFundConnector.send(pkt);
  } catch {
    // fail silently by design
  }
}

/* -------------------------------- Utilities -------------------------------- */
function toMs(v) {
  if (typeof v === "number") return v;
  if (v instanceof Date) return v.getTime();
  return Date.parse(v);
}
function isISO(s) { return typeof s === "string" && !Number.isNaN(Date.parse(s)); }
function firstISO(...vals) { return vals.find(isISO) || null; }
function HOURS(n) { return n * 60 * 60 * 1000; }
function within(aStart, aEnd, bStart, bEnd) {
  const as = toMs(aStart), ae = toMs(aEnd);
  const bs = toMs(bStart), be = toMs(bEnd);
  return as <= bs && be <= ae;
}
function distinct(arr) {
  const out = []; const seen = new Set();
  for (const x of arr) { const k = String(x); if (!seen.has(k)) { seen.add(k); out.push(k); } }
  return out;
}

/* --------------------------------- Exports --------------------------------- */
export default {
  initPrereqCheck,
  // For tests/manual calls:
  _performPrereqCheck: performPrereqCheck,
  _readSessionData: readSessionData,
  _clearPreflight: clearPreflight,
};
