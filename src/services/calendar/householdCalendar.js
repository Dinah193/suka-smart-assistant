// C:\Users\larho\suka-smart-assistant\src\services\calendar\householdCalendar.js
// Household Calendar Manager
// -----------------------------------------------------------------------------
// ROLE IN PIPELINE
// imports → intelligence → automation → (optional) hub export
//            │             │            └─ schedules/blocks emitted here
//            │             └─ engines ask for availability/suggested slots
//            └─ imports may propose target dates (e.g., recipe says “marinate overnight”)
//
// This module manages time blocks, holds, and scheduled sessions for the household.
// It provides:
//   • Upsert/remove/list calendar blocks and holds
//   • Conflict detection and slot suggestion
//   • Guardrails for quiet hours and sabbath windows (feature-flagged)
//   • Event wiring (emits {type, ts, source, data} via eventBus)
//   • Optional export to Hub when household data changes
//
// Storage: tries Dexie (db.calendarBlocks) if available; falls back to localStorage.
// Time: all APIs accept/return ISO strings; internal comparisons use epoch ms.
// -----------------------------------------------------------------------------

/* --------------------------------- Imports --------------------------------- */
let eventBus, Events;
try {
  // Prefer your consolidated bus with Events registry if present
  const eb = require("@/services/events/eventBus.js");
  eventBus = eb.default || eb.eventBus || eb;
  Events = eb.Events || {};
} catch {
  try {
    const eb = require("@/services/events/eventBus.js");
    eventBus = eb.default || eb.eventBus || eb;
    Events = eb.Events || {};
  } catch {
    eventBus = {
      emit: () => {},
      on: () => () => {},
      once: () => () => {},
    };
    Events = {};
  }
}

let featureFlags = {};
try {
  featureFlags =
    require("@/config/featureFlags").default ||
    require("@/config/featureFlags");
} catch {}

/** Hub export helpers (optional, fail-silent) */
let HubPacketFormatter, FamilyFundConnector;
try {
  HubPacketFormatter = require("@/services/hub/HubPacketFormatter");
  FamilyFundConnector = require("@/services/hub/FamilyFundConnector");
} catch {}

/** Optional Dexie DB */
let db = null;
try {
  db = require("@/services/db").default || require("@/services/db");
} catch {}

/* --------------------------------- Types ----------------------------------- */
/**
 * @typedef {"block"|"hold"|"session"} CalendarKind
 *
 * @typedef {Object} CalendarItem
 * @property {string} id            // stable id
 * @property {CalendarKind} kind    // "block" | "hold" | "session"
 * @property {string} title
 * @property {string} start         // ISO
 * @property {string} end           // ISO
 * @property {string} [domain]      // cooking | cleaning | garden | animals | preservation
 * @property {string[]} [tags]
 * @property {Object} [meta]        // free-form (room, timers, sessionId, recipeIds, etc.)
 * @property {string} source        // emitter module/domain
 * @property {string} createdAt     // ISO
 * @property {string} updatedAt     // ISO
 */

/* ------------------------------- In-Memory Cache --------------------------- */
const _cache = new Map(); // id -> CalendarItem
let _initialized = false;

/* --------------------------------- API ------------------------------------- */
export async function init() {
  if (_initialized) return;
  await hydrateFromStorage();
  _initialized = true;

  // Answer availability RPCs from engines
  if (eventBus?.respond) {
    eventBus.respond("calendar/availability", async (query) => {
      const {
        startISO,
        endISO,
        granularityMin = 30,
        minDurationMin = 30,
        domain,
      } = query || {};
      const slots = await suggestSlots({
        startISO,
        endISO,
        granularityMin,
        minDurationMin,
        domain,
      });
      return { ok: true, slots };
    });

    eventBus.respond("calendar/schedule.request", async (req) => {
      // req: { title, start, end, domain, meta }
      try {
        const item = await upsertBlock({
          kind: "session",
          title: req?.title || "Session",
          start: req?.start,
          end: req?.end,
          domain: req?.domain,
          meta: req?.meta,
          source: "calendar.rpc",
        });
        return { ok: true, item };
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
    });
  }
}

/** Create or update a calendar entry (block, hold, or session). */
export async function upsertBlock(input) {
  guardInit();
  const nowIso = isoNow();
  const item = normalizeItem(input, nowIso);

  if (!item.title) throw new Error("calendar: title is required");
  if (!isISO(item.start) || !isISO(item.end))
    throw new Error("calendar: invalid start/end");
  if (toMs(item.end) <= toMs(item.start))
    throw new Error("calendar: end must be after start");

  // Guardrails
  enforceQuietHours(item);
  enforceSabbathGuard(item);

  // Conflicts (informational; session may still proceed if allowed)
  const conflicts = findConflicts(item);
  const hasHardConflict = conflicts.some((c) =>
    isHardConflict(c.kind, item.kind)
  );

  if (hasHardConflict) {
    // Emit a soft error and throw
    emit("calendar/conflict", { item, conflicts, severity: "hard" });
    throw new Error("calendar: hard conflict with existing blocks/holds");
  }

  _cache.set(item.id, item);
  await persistToStorage(item);

  const payload = {
    item,
    conflicts,
    reason: input?.id ? "updated" : "created",
  };
  emit(Events?.SCHEDULE_SAVED || "schedule/saved", payload, {
    sticky: false,
    source: "calendar",
  });
  emit("calendar/blockSaved", payload);

  await exportToHubIfEnabled({
    type: "calendar/blockSaved",
    ts: nowIso,
    source: "calendar",
    data: payload,
  });

  return item;
}

/** Remove a calendar entry by id. */
export async function removeBlock(id) {
  guardInit();
  const item = _cache.get(String(id));
  if (!item) return false;

  _cache.delete(String(id));
  await deleteFromStorage(String(id));

  emit(
    Events?.SCHEDULE_DELETED || "schedule/deleted",
    { id, item },
    { source: "calendar" }
  );
  emit("calendar/blockRemoved", { id, item });

  await exportToHubIfEnabled({
    type: "calendar/blockRemoved",
    ts: isoNow(),
    source: "calendar",
    data: { id, item },
  });

  return true;
}

/** Create a temporary hold (e.g., user is planning; prevents auto-scheduling). */
export async function createHold({
  title = "Hold",
  start,
  end,
  domain,
  meta,
  source = "calendar",
}) {
  return upsertBlock({
    kind: "hold",
    title,
    start,
    end,
    domain,
    meta,
    source,
  });
}

/** Release an existing hold by id. */
export async function releaseHold(id) {
  return removeBlock(id);
}

/** List items in a time range (inclusive). */
export async function getBlocksInRange({ startISO, endISO, kinds }) {
  guardInit();
  const s = toMs(startISO);
  const e = toMs(endISO);
  const arr = Array.from(_cache.values()).filter((it) => {
    if (Array.isArray(kinds) && kinds.length && !kinds.includes(it.kind))
      return false;
    return rangesOverlap(s, e, toMs(it.start), toMs(it.end));
  });
  return arr.sort((a, b) => toMs(a.start) - toMs(b.start));
}

/** Return the next N upcoming items from now (default 20). */
export async function listUpcoming(limit = 20) {
  guardInit();
  const now = Date.now();
  return Array.from(_cache.values())
    .filter((it) => toMs(it.end) >= now)
    .sort((a, b) => toMs(a.start) - toMs(b.start))
    .slice(0, limit);
}

/**
 * Suggest available slots in [startISO, endISO]
 * granularityMin: slot grid size
 * minDurationMin: minimal required duration
 */
export async function suggestSlots({
  startISO,
  endISO,
  granularityMin = 30,
  minDurationMin = 30,
  domain,
}) {
  guardInit();
  if (!isISO(startISO) || !isISO(endISO))
    throw new Error("calendar: invalid range");
  const s = floorTo(toMs(startISO), granularityMin);
  const e = toMs(endISO);
  const need = minDurationMin * 60_000;

  // Collect busy intervals (blocks + holds + sessions)
  const busy = Array.from(_cache.values())
    .map((it) => [toMs(it.start), toMs(it.end)])
    .filter(([a, b]) => rangesOverlap(s, e, a, b))
    .sort((a, b) => a[0] - b[0]);

  // Merge busy
  const merged = [];
  for (const [a, b] of busy) {
    if (!merged.length || a > merged[merged.length - 1][1]) merged.push([a, b]);
    else
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], b);
  }

  // Free windows
  const free = [];
  let cursor = s;
  for (const [a, b] of merged) {
    if (cursor < a && a - cursor >= need) free.push([cursor, a]);
    cursor = Math.max(cursor, b);
  }
  if (cursor < e && e - cursor >= need) free.push([cursor, e]);

  // Snap to granularity and filter guardrails
  const slots = [];
  for (const [a, b] of free) {
    let t = ceilTo(a, granularityMin);
    while (t + need <= b) {
      const candidate = {
        start: new Date(t).toISOString(),
        end: new Date(t + need).toISOString(),
        domain,
      };
      try {
        enforceQuietHours(candidate, { throwOnViolation: false });
        enforceSabbathGuard(candidate, { throwOnViolation: false });
        slots.push(candidate);
      } catch {
        // filtered out
      }
      t += granularityMin * 60_000;
    }
  }

  // Emit suggestion event (non-sticky)
  emit("calendar/slotsSuggested", {
    range: { startISO, endISO },
    granularityMin,
    minDurationMin,
    domain,
    count: slots.length,
  });

  return slots;
}

/** Convenience: schedule a session if a slot is free (conflict-aware). */
export async function scheduleSession({
  title,
  domain,
  start,
  end,
  meta,
  source = "calendar",
}) {
  return upsertBlock({
    kind: "session",
    title: title || defaultTitleFor(domain),
    domain,
    start,
    end,
    meta,
    source,
  });
}

/** Cancel a scheduled session by id. */
export async function cancelSession(id) {
  return removeBlock(id);
}

/* ---------------------------- Internal Helpers ----------------------------- */
function emit(type, data, opts = {}) {
  if (!eventBus?.emit) return;
  eventBus.emit(type, data, {
    source: opts.source || "calendar",
    sticky: !!opts.sticky,
  });
}

async function exportToHubIfEnabled(payload) {
  try {
    if (!featureFlags || !featureFlags.familyFundMode) return;
    if (!HubPacketFormatter || !FamilyFundConnector) return;
    const pkt = HubPacketFormatter.format(payload);
    await FamilyFundConnector.send(pkt);
  } catch {
    // fail silent by design
  }
}

function normalizeItem(input, nowIso) {
  const id = String(input?.id || genId());
  const kind = asKind(input?.kind);
  const title = String(input?.title || (kind === "hold" ? "Hold" : "Block"));
  const start = toISO(input?.start);
  const end = toISO(input?.end);
  const domain = input?.domain || input?.meta?.domain || undefined;
  const tags = Array.isArray(input?.tags)
    ? dedupStrings(input.tags)
    : undefined;
  const meta = isPojo(input?.meta) ? { ...input.meta } : undefined;
  const source = input?.source || "calendar";

  /** @type {CalendarItem} */
  const base = {
    id,
    kind,
    title,
    start,
    end,
    domain,
    tags,
    meta,
    source,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  // Preserve createdAt if updating
  const prev = _cache.get(id);
  if (prev) {
    base.createdAt = prev.createdAt || nowIso;
  }
  return base;
}

function asKind(v) {
  const k = String(v || "block").toLowerCase();
  return k === "session" || k === "hold" ? k : "block";
}

function guardInit() {
  if (!_initialized)
    throw new Error("householdCalendar: call init() before use");
}

function findConflicts(item) {
  const a = toMs(item.start);
  const b = toMs(item.end);
  const out = [];
  for (const it of _cache.values()) {
    if (it.id === item.id) continue;
    if (rangesOverlap(a, b, toMs(it.start), toMs(it.end))) out.push(it);
  }
  return out;
}

function isHardConflict(existingKind, newKind) {
  // holds and sessions block each other; blocks vs sessions also conflict
  if (existingKind === "hold" || newKind === "hold") return true;
  if (existingKind === "session" || newKind === "session") return true;
  // block vs block considered soft (can be merged/overridden by caller policy)
  return false;
}

function enforceQuietHours(item, { throwOnViolation = true } = {}) {
  const q = featureFlags?.quietHours;
  if (!q || q.enabled === false) return;

  // q: { enabled:true, start:"21:00", end:"07:00", days:[0..6] }
  const startMs = toMs(item.start);
  const endMs = toMs(item.end);

  if (!violatesWindow(startMs, endMs, q)) return;

  const err = new Error("calendar: violates quiet hours");
  if (throwOnViolation) throw err;
  // else silently filter candidate (used by suggestSlots)
  throw err; // keep behavior strict by default
}

function enforceSabbathGuard(item, { throwOnViolation = true } = {}) {
  if (!featureFlags?.sabbathGuard) return;
  const startMs = toMs(item.start);
  const endMs = toMs(item.end);

  const [sabStart, sabEnd] = approximateSabbathWindow(startMs);
  const overlaps = rangesOverlap(startMs, endMs, sabStart, sabEnd);
  if (!overlaps) return;

  // Allow only “low-impact” domains if configured
  const allowed = featureFlags?.sabbathGuard?.allowedDomains || [];
  if (allowed.includes(item.domain)) return;

  const err = new Error("calendar: violates sabbath guard window");
  if (throwOnViolation) throw err;
  throw err; // strict by default (same reasoning as quiet hours)
}

function approximateSabbathWindow(ts) {
  // Approximation: Fri 18:00 → Sat 20:00 local
  const d = new Date(ts);
  const day = d.getDay(); // 0 Sun ... 5 Fri ... 6 Sat
  const base = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

  // Find the most recent Friday 18:00
  const diffToFri = (5 - day + 7) % 7;
  const friBase = base + diffToFri * 24 * 60 * 60 * 1000;
  const sabStart = new Date(friBase + 18 * 60 * 60 * 1000).getTime();

  // Ends Saturday 20:00
  const sabEnd = sabStart + 26 * 60 * 60 * 1000; // +26h → Sat 20:00
  return [sabStart, sabEnd];
}

/* ----------------------------- Storage Layer ------------------------------- */
const LSK = "ssa.calendar.blocks.v1";

async function hydrateFromStorage() {
  const items = await storageLoadAll();
  for (const it of items) _cache.set(it.id, it);
}

async function persistToStorage(item) {
  if (db?.calendarBlocks?.put) {
    await db.calendarBlocks.put(item);
    return;
  }
  // fallback: localStorage (whole set write)
  const all = Array.from(_cache.values());
  localStorage.setItem(LSK, JSON.stringify(all));
}

async function deleteFromStorage(id) {
  if (db?.calendarBlocks?.delete) {
    await db.calendarBlocks.delete(id);
    return;
  }
  const all = Array.from(_cache.values());
  localStorage.setItem(LSK, JSON.stringify(all));
}

async function storageLoadAll() {
  try {
    if (db?.calendarBlocks?.toArray) {
      const arr = await db.calendarBlocks.toArray();
      return (arr || []).map(coerceItem);
    }
  } catch {}
  try {
    const raw = localStorage.getItem(LSK);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(coerceItem) : [];
  } catch {
    return [];
  }
}

/* ------------------------------ Utilities ---------------------------------- */
function genId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
function isoNow() {
  return new Date().toISOString();
}
function toISO(v) {
  if (typeof v === "string" && isISO(v)) return v;
  if (typeof v === "number") return new Date(v).toISOString();
  if (v instanceof Date) return v.toISOString();
  return new Date(String(v || Date.now())).toISOString();
}
function toMs(v) {
  if (typeof v === "number") return v;
  if (v instanceof Date) return v.getTime();
  return Date.parse(v);
}
function isISO(s) {
  return typeof s === "string" && !Number.isNaN(Date.parse(s));
}
function isPojo(v) {
  return v && typeof v === "object" && v.constructor === Object;
}
function dedupStrings(arr) {
  const out = [];
  const seen = new Set();
  for (const s of arr) {
    const k = String(s).trim();
    if (!k) continue;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}
function rangesOverlap(a1, a2, b1, b2) {
  return a1 < b2 && b1 < a2;
}
function floorTo(ms, granMin) {
  const step = granMin * 60_000;
  return Math.floor(ms / step) * step;
}
function ceilTo(ms, granMin) {
  const step = granMin * 60_000;
  return Math.ceil(ms / step) * step;
}
function violatesWindow(startMs, endMs, q) {
  // q.start "HH:MM", q.end "HH:MM"; if start < end → nightly window
  // If end < start (e.g., 22:00..06:00), handle wrap.
  const days =
    Array.isArray(q.days) && q.days.length ? q.days : [0, 1, 2, 3, 4, 5, 6];
  // Iterate each day the range touches (max few days per call)
  for (
    let d = dayStart(startMs);
    d <= dayStart(endMs);
    d += 24 * 60 * 60 * 1000
  ) {
    const dayIdx = new Date(d).getDay();
    if (!days.includes(dayIdx)) continue;
    const [sH, sM] = (q.start || "21:00").split(":").map(Number);
    const [eH, eM] = (q.end || "07:00").split(":").map(Number);
    const qs = d + (sH * 60 + sM) * 60_000;
    let qe = d + (eH * 60 + eM) * 60_000;
    if (qe <= qs) qe += 24 * 60 * 60 * 1000; // wrap past midnight
    if (rangesOverlap(startMs, endMs, qs, qe)) return true;
  }
  return false;
}
function dayStart(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
function coerceItem(it) {
  // Ensure required fields exist and are strings
  if (!it?.id) it.id = genId();
  it.kind = asKind(it.kind);
  it.title = String(it.title || "Block");
  it.start = toISO(it.start);
  it.end = toISO(it.end);
  it.source = String(it.source || "calendar");
  it.createdAt = toISO(it.createdAt || Date.now());
  it.updatedAt = toISO(it.updatedAt || Date.now());
  if (Array.isArray(it.tags)) it.tags = dedupStrings(it.tags);
  if (!isPojo(it.meta)) it.meta = undefined;
  return it;
}
function defaultTitleFor(domain) {
  if (!domain) return "Household Session";
  const m = {
    cooking: "Cooking Session",
    cleaning: "Cleaning Session",
    garden: "Garden Session",
    animals: "Animal Care Session",
    preservation: "Preservation Session",
    storehouse: "Storehouse Session",
  };
  return m[domain] || "Household Session";
}

/* ------------------------------ Exports ------------------------------------ */
export default {
  init,
  upsertBlock,
  removeBlock,
  createHold,
  releaseHold,
  getBlocksInRange,
  suggestSlots,
  scheduleSession,
  cancelSession,
  listUpcoming,
};
