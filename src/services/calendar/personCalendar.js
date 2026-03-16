// C:\Users\larho\suka-smart-assistant\src\services\calendar\personCalendar.js
// Person/Role Calendar Manager (availability, holds, and bookings)
// -----------------------------------------------------------------------------
// ROLE IN PIPELINE
// imports → intelligence → automation → (optional) hub export
//            │             │            └─ engines ask for people/roles availability & book here
//            └─ imports/engines may imply human roles (e.g., "butchery helper", "dishwasher unload")
//
// This module tracks household PEOPLE and ROLE availability across ALL domains.
// It supports:
//   • People registry with roles, skills, preferences, and capacity (max concurrent sessions)
//   • Weekly availability rules + one-off exceptions (busy/available)
//   • Bookings/holds for people with conflict detection
//   • Role-based slot suggestions (find a person for a role in a window)
//   • Quiet hours & sabbath guard (optional; enforced for “noisy/strenuous” role tags)
//   • Event wiring via eventBus (emits {type, ts, source, data}, canonicalized upstream)
//   • Optional Hub export on data-changing operations (familyFundMode)
//
// Storage: Dexie if available (db.people, db.peopleWeekly, db.peopleExceptions, db.peopleBookings)
//          else localStorage fallbacks.
//
// All public times are ISO strings; internally compared as epoch ms.
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
    eventBus = {
      emit: () => {},
      on: () => () => {},
      once: () => () => {},
      respond: () => () => {},
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

let HubPacketFormatter, FamilyFundConnector;
try {
  HubPacketFormatter = require("@/services/hub/HubPacketFormatter");
  FamilyFundConnector = require("@/services/hub/FamilyFundConnector");
} catch {}

let db = null;
try {
  db = require("@/services/db").default || require("@/services/db");
} catch {}

/* --------------------------------- Types ----------------------------------- */
/**
 * @typedef {Object} Person
 * @property {string} id
 * @property {string} name
 * @property {string[]} roles        // e.g., ["cook","butcher","gardener","sanitation"]
 * @property {string[]} [skills]     // free-form skills
 * @property {string[]} [tags]       // e.g., ["noisyOk","heavyLiftingOk","prefersMorning"]
 * @property {number} [capacity]     // concurrent sessions allowed (default 1)
 * @property {Object} [preferences]  // { quietOnly?: boolean, domains?: string[] }
 * @property {boolean} [active]      // default true
 * @property {string} createdAt
 * @property {string} updatedAt
 *
 * @typedef {"busy"|"available"} ExceptionType
 * @typedef {Object} AvailabilityRule
 * @property {string} id
 * @property {string} personId
 * @property {number} day           // 0-6 (Sun..Sat)
 * @property {string} startHM       // "HH:MM"
 * @property {string} endHM         // "HH:MM" (may wrap past midnight if end <= start → next day)
 *
 * @typedef {Object} AvailabilityException
 * @property {string} id
 * @property {string} personId
 * @property {ExceptionType} type   // "busy" | "available"
 * @property {string} start         // ISO
 * @property {string} end           // ISO
 * @property {string} [reason]
 *
 * @typedef {Object} PersonBooking
 * @property {string} id
 * @property {string} personId
 * @property {string} title
 * @property {string} start         // ISO
 * @property {string} end           // ISO
 * @property {string} [role]
 * @property {string} [domain]      // cooking | cleaning | garden | animals | preservation | storehouse
 * @property {Object} [meta]        // sessionId, draftId, etc.
 * @property {string} source
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/* ------------------------------- In-Memory --------------------------------- */
const _people = new Map(); // id -> Person
const _weekly = new Map(); // id -> AvailabilityRule
const _exceptions = new Map(); // id -> AvailabilityException
const _bookings = new Map(); // id -> PersonBooking
let _initialized = false;

/* -------------------------------- Constants -------------------------------- */
const LSK = {
  people: "ssa.people.registry.v1",
  weekly: "ssa.people.weekly.v1",
  exceptions: "ssa.people.exceptions.v1",
  bookings: "ssa.people.bookings.v1",
};

/* ----------------------------------- API ----------------------------------- */
export async function init() {
  if (_initialized) return;
  await hydrateAll();
  _initialized = true;

  // RPC endpoints for engines/UX
  if (eventBus?.respond) {
    // Query role availability → return slots and candidate people
    eventBus.respond("person/roleAvailability", async (q) => {
      // q: { role, startISO, endISO, durationMin, granularityMin, domain, tagsInclude?:[], tagsExclude?:[] }
      try {
        const res = await suggestRoleSlots(q || {});
        return { ok: true, ...res };
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
    });

    // Request a booking for a person
    eventBus.respond("person/booking.request", async (req) => {
      // req: { personId, title, start, end, role, domain, meta }
      try {
        const b = await upsertBooking(req || {});
        return { ok: true, booking: b };
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
    });
  }

  // Glue: when a SESSION is APPROVED and declares human roles, try to auto-book
  eventBus.on(
    Events?.SESSION_APPROVED || "session/approved",
    async ({ data }) => {
      const humanNeeds = readHumanNeeds(data);
      for (const need of humanNeeds) {
        const { role, start, end, domain, meta } = need;
        const { slots } = (await safeTry(() =>
          suggestRoleSlots({
            role,
            startISO: start,
            endISO: end,
            durationMin: Math.max(
              1,
              Math.round((toMs(end) - toMs(start)) / 60000)
            ),
            domain,
          })
        )) || { slots: [] };
        const pick = slots?.[0];
        if (pick) {
          await safeTry(() =>
            upsertBooking({
              personId: pick.personId,
              title: meta?.title || `Role: ${role}`,
              role,
              domain,
              start: pick.start,
              end: pick.end,
              meta: { ...meta, sessionAuto: true },
              source: "personCalendar.auto",
            })
          );
        }
      }
    }
  );
}

/** --------------------------- People Registry ------------------------------ */
export async function registerPerson(input) {
  guardInit();
  const now = isoNow();
  const p = normalizePerson(input, now);
  if (!p.name) throw new Error("person: name required");

  _people.set(p.id, p);
  await persistPeople();

  emit("person/registered", { person: p });
  await exportToHubIfEnabled({
    type: "person/registered",
    ts: now,
    source: "personCalendar",
    data: { person: p },
  });
  return p;
}

export async function updatePerson(input) {
  guardInit();
  if (!input?.id) throw new Error("person: id required");
  const prev = _people.get(String(input.id));
  if (!prev) throw new Error("person: not found");

  const now = isoNow();
  const merged = coercePerson({ ...prev, ...input, updatedAt: now });
  _people.set(merged.id, merged);
  await persistPeople();

  emit("person/updated", { person: merged, prev });
  await exportToHubIfEnabled({
    type: "person/updated",
    ts: now,
    source: "personCalendar",
    data: { person: merged },
  });
  return merged;
}

export async function removePerson(id) {
  guardInit();
  const p = _people.get(String(id));
  if (!p) return false;

  // Prevent removal if future bookings exist
  const now = Date.now();
  const hasFuture = Array.from(_bookings.values()).some(
    (b) => b.personId === p.id && toMs(b.end) >= now
  );
  if (hasFuture) throw new Error("person: cannot remove with future bookings");

  _people.delete(p.id);
  await persistPeople();

  emit("person/removed", { id: p.id, person: p });
  await exportToHubIfEnabled({
    type: "person/removed",
    ts: isoNow(),
    source: "personCalendar",
    data: { id: p.id },
  });
  return true;
}

export function listPeople({
  activeOnly = true,
  role,
  tagsInclude = [],
  tagsExclude = [],
} = {}) {
  let arr = Array.from(_people.values());
  if (activeOnly) arr = arr.filter((p) => p.active !== false);
  if (role) arr = arr.filter((p) => (p.roles || []).includes(String(role)));
  if (tagsInclude?.length)
    arr = arr.filter((p) => hasAllTags(p.tags, tagsInclude));
  if (tagsExclude?.length)
    arr = arr.filter((p) => !hasAnyTag(p.tags, tagsExclude));
  return arr.sort((a, b) => a.name.localeCompare(b.name));
}

/** --------------------------- Weekly Availability -------------------------- */
export async function setWeeklyAvailability(
  personId,
  rules /* Array<{day,startHM,endHM}> */
) {
  guardInit();
  if (!_people.has(String(personId)))
    throw new Error("weekly: person not found");

  // Remove existing
  for (const r of Array.from(_weekly.values())) {
    if (r.personId === String(personId)) _weekly.delete(r.id);
  }

  // Add new
  for (const r of rules || []) {
    const rule = sanitizeRule({
      id: genId(),
      personId: String(personId),
      day: Number(r.day),
      startHM: String(r.startHM),
      endHM: String(r.endHM),
    });
    _weekly.set(rule.id, rule);
  }
  await persistWeekly();

  emit("person/weekly.set", {
    personId: String(personId),
    count: (rules || []).length,
  });
  await exportToHubIfEnabled({
    type: "person/weekly.set",
    ts: isoNow(),
    source: "personCalendar",
    data: { personId: String(personId) },
  });
  return true;
}

export function getWeeklyAvailability(personId) {
  return Array.from(_weekly.values())
    .filter((r) => r.personId === String(personId))
    .sort((a, b) => a.day - b.day);
}

/** --------------------------- Exceptions (busy/available) ------------------ */
export async function addException({
  personId,
  type = "busy",
  start,
  end,
  reason,
}) {
  guardInit();
  if (!_people.has(String(personId)))
    throw new Error("exception: person not found");
  if (!isISO(start) || !isISO(end))
    throw new Error("exception: invalid start/end");
  if (toMs(end) <= toMs(start))
    throw new Error("exception: end must be after start");

  const ex = /** @type {AvailabilityException} */ ({
    id: genId(),
    personId: String(personId),
    type: type === "available" ? "available" : "busy",
    start: toISO(start),
    end: toISO(end),
    reason: String(reason || ""),
  });
  _exceptions.set(ex.id, ex);
  await persistExceptions();

  emit("person/exception.added", { exception: ex });
  await exportToHubIfEnabled({
    type: "person/exception.added",
    ts: isoNow(),
    source: "personCalendar",
    data: { exception: ex },
  });
  return ex;
}

export async function removeException(id) {
  guardInit();
  const ex = _exceptions.get(String(id));
  if (!ex) return false;
  _exceptions.delete(ex.id);
  await persistExceptions();

  emit("person/exception.removed", { id: ex.id, exception: ex });
  await exportToHubIfEnabled({
    type: "person/exception.removed",
    ts: isoNow(),
    source: "personCalendar",
    data: { id: ex.id },
  });
  return true;
}

/** --------------------------- Bookings (holds/work) ------------------------ */
export async function upsertBooking(input) {
  guardInit();
  const now = isoNow();
  const b = normalizeBooking(input, now);

  const person = _people.get(b.personId);
  if (!person || person.active === false)
    throw new Error("booking: person not active/exists");
  if (!isISO(b.start) || !isISO(b.end))
    throw new Error("booking: invalid start/end");
  if (toMs(b.end) <= toMs(b.start))
    throw new Error("booking: end must be after start");

  // Guardrails (quiet hours/sabbath) if role tagged “noisy/strenuous” or person prefers quiet
  if (appliesQuietSabbath(person, b.role)) {
    enforceQuietHours(b);
    enforceSabbathGuard(b);
  }

  // Capacity/conflict check
  const conflict = hasPersonConflict(person, b);
  if (conflict) {
    emit("person/booking.conflict", { person, booking: b, details: conflict });
    throw new Error("booking: capacity/conflict");
  }

  _bookings.set(b.id, b);
  await persistBookings();

  emit("person/booking.saved", {
    booking: b,
    person,
    reason: input?.id ? "updated" : "created",
  });
  await exportToHubIfEnabled({
    type: "person/booking.saved",
    ts: now,
    source: "personCalendar",
    data: { booking: b },
  });
  return b;
}

export async function releaseBooking(id) {
  guardInit();
  const b = _bookings.get(String(id));
  if (!b) return false;
  _bookings.delete(b.id);
  await persistBookings();

  emit("person/booking.removed", { id: b.id, booking: b });
  await exportToHubIfEnabled({
    type: "person/booking.removed",
    ts: isoNow(),
    source: "personCalendar",
    data: { id: b.id, booking: b },
  });
  return true;
}

export function getBookingsForPerson(personId, { fromISO, toISO } = {}) {
  const s = fromISO ? toMs(fromISO) : -Infinity;
  const e = toISO ? toMs(toISO) : Infinity;
  return Array.from(_bookings.values())
    .filter(
      (b) =>
        b.personId === String(personId) &&
        rangesOverlap(s, e, toMs(b.start), toMs(b.end))
    )
    .sort((a, b) => toMs(a.start) - toMs(b.start));
}

/** --------------------------- Suggestions (role) --------------------------- */
/**
 * Suggest slots for a ROLE within a time window.
 * @param {Object} params
 * @param {string} params.role
 * @param {string} params.startISO
 * @param {string} params.endISO
 * @param {number} params.durationMin
 * @param {number} [params.granularityMin=15]
 * @param {string} [params.domain]
 * @param {string[]} [params.tagsInclude]
 * @param {string[]} [params.tagsExclude]
 * @returns {{window:{startISO,endISO}, durationMin:number, slots:Array<{personId,start,end,role}>, candidates:string[]}}
 */
export async function suggestRoleSlots(params) {
  guardInit();
  const {
    role,
    startISO,
    endISO,
    durationMin,
    granularityMin = 15,
    domain,
    tagsInclude = [],
    tagsExclude = [],
  } = params || {};

  if (!role) throw new Error("availability: role required");
  if (!isISO(startISO) || !isISO(endISO))
    throw new Error("availability: invalid window");
  if (!Number.isFinite(durationMin) || durationMin <= 0)
    throw new Error("availability: durationMin required");

  const candidates = listPeople({
    activeOnly: true,
    role,
    tagsInclude,
    tagsExclude,
  }).map((p) => p.id);
  const s = toMs(startISO);
  const e = toMs(endISO);
  const durMs = Math.round(durationMin * 60_000);
  const step = (granularityMin || 15) * 60_000;

  const slots = [];
  for (const pid of candidates) {
    const windows = computePersonFreeWindows(pid, s, e, domain);
    for (const [a, b] of windows) {
      // Snap a..b to grid and yield possible starts
      let x = ceilTo(a, granularityMin);
      while (x + durMs <= b) {
        const proposed = {
          personId: pid,
          start: new Date(x).toISOString(),
          end: new Date(x + durMs).toISOString(),
          role,
        };
        // Re-check guardrails if necessary
        const person = _people.get(pid);
        if (appliesQuietSabbath(person, role)) {
          try {
            enforceQuietHours(proposed);
          } catch {
            x += step;
            continue;
          }
          try {
            enforceSabbathGuard(proposed);
          } catch {
            x += step;
            continue;
          }
        }
        // Re-check capacity
        if (!hasPersonConflict(person, { ...proposed, id: "probe" })) {
          slots.push(proposed);
        }
        x += step;
      }
    }
  }

  // Sort by start
  slots.sort((A, B) => toMs(A.start) - toMs(B.start));

  emit("person/slotsSuggested", {
    window: { startISO, endISO },
    role,
    durationMin,
    granularityMin,
    count: slots.length,
  });

  return { window: { startISO, endISO }, durationMin, slots, candidates };
}

/* ---------------------------- Internal Helpers ----------------------------- */
function emit(type, data, opts = {}) {
  if (!eventBus?.emit) return;
  eventBus.emit(type, data, {
    source: opts.source || "personCalendar",
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
    // fail-silent
  }
}

function normalizePerson(input, nowIso) {
  const id = String(input?.id || genId());
  /** @type {Person} */
  const p = {
    id,
    name: String(input?.name || "Person"),
    roles: Array.isArray(input?.roles) ? dedupStrings(input.roles) : [],
    skills: Array.isArray(input?.skills)
      ? dedupStrings(input.skills)
      : undefined,
    tags: Array.isArray(input?.tags) ? dedupStrings(input.tags) : undefined,
    capacity:
      Number.isFinite(input?.capacity) && input.capacity > 0
        ? Math.floor(input.capacity)
        : 1,
    preferences: isPojo(input?.preferences)
      ? { ...input.preferences }
      : undefined,
    active: input?.active !== false,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  return p;
}

function coercePerson(x) {
  const now = isoNow();
  const p = normalizePerson(x, now);
  p.createdAt = toISO(x?.createdAt || now);
  p.updatedAt = toISO(x?.updatedAt || now);
  return p;
}

function normalizeBooking(input, nowIso) {
  const id = String(input?.id || genId());
  /** @type {PersonBooking} */
  const b = {
    id,
    personId: String(input?.personId || ""),
    title: String(input?.title || "Work Block"),
    start: toISO(input?.start),
    end: toISO(input?.end),
    role: input?.role ? String(input.role) : undefined,
    domain: input?.domain || undefined,
    meta: isPojo(input?.meta) ? { ...input.meta } : undefined,
    source: input?.source || "personCalendar",
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  const prev = _bookings.get(id);
  if (prev) b.createdAt = prev.createdAt || nowIso;
  return b;
}

function sanitizeRule(r) {
  const day = clampInt(r.day, 0, 6);
  const startHM = hmOrDefault(r.startHM, "08:00");
  const endHM = hmOrDefault(r.endHM, "17:00");
  return {
    id: String(r.id || genId()),
    personId: String(r.personId),
    day,
    startHM,
    endHM,
  };
}

function readHumanNeeds(data) {
  // Accept data.session?.rolesNeeded[], data?.rolesNeeded[], draft.meta.rolesNeeded[]
  const arr =
    data?.session?.rolesNeeded ||
    data?.rolesNeeded ||
    data?.draft?.meta?.rolesNeeded ||
    [];
  if (!Array.isArray(arr)) return [];
  return arr
    .map((x) => ({
      role: x?.role ? String(x.role) : undefined,
      start: isISO(x?.start) ? x.start : undefined,
      end: isISO(x?.end) ? x.end : undefined,
      domain: x?.domain,
      meta: isPojo(x?.meta) ? x.meta : undefined,
    }))
    .filter((x) => x.role && x.start && x.end);
}

function appliesQuietSabbath(person, role) {
  // If person prefers quietOnly OR role tagged “noisy”(by naming/tag) OR featureFlags mandates humans respect quiet
  const tags = new Set(person?.tags || []);
  const roleStr = String(role || "").toLowerCase();
  const roleNoisy =
    /butcher|tiller|mower|grinder|chainsaw|hammer|smoker|vacuum|compressor/.test(
      roleStr
    );
  const quietOnly = person?.preferences?.quietOnly === true;
  const global = !!featureFlags?.quietHours?.humansEnforced;
  return roleNoisy || quietOnly || global || !!featureFlags?.sabbathGuard;
}

function enforceQuietHours(block) {
  const q = featureFlags?.quietHours;
  if (!q || q.enabled === false) return;
  const startMs = toMs(block.start);
  const endMs = toMs(block.end);
  if (!violatesWindow(startMs, endMs, q)) return;
  throw new Error("booking violates quiet hours");
}

function enforceSabbathGuard(block) {
  if (!featureFlags?.sabbathGuard) return;
  const [sabStart, sabEnd] = approximateSabbathWindow(toMs(block.start));
  if (rangesOverlap(toMs(block.start), toMs(block.end), sabStart, sabEnd)) {
    const allowed = featureFlags?.sabbathGuard?.allowedDomains || [];
    if (!allowed.includes(block.domain))
      throw new Error("booking violates sabbath guard");
  }
}

function hasPersonConflict(person, newBlock) {
  const s = toMs(newBlock.start);
  const e = toMs(newBlock.end);

  // Gather person's busy intervals: bookings (same person) + busy exceptions
  const intervals = [];
  for (const b of _bookings.values()) {
    if (b.personId !== person.id) continue;
    intervals.push([toMs(b.start), toMs(b.end)]);
  }
  for (const ex of _exceptions.values()) {
    if (ex.personId !== person.id || ex.type !== "busy") continue;
    intervals.push([toMs(ex.start), toMs(ex.end)]);
  }

  // Capacity check using sweep-line
  const events = [];
  for (const [a, b] of intervals) events.push([a, +1], [b, -1]);
  // include candidate
  events.push([s, +1], [e, -1]);
  events.sort((A, B) => A[0] - B[0] || A[1] - B[1]);

  const cap = Math.max(1, person.capacity || 1);
  let active = 0;
  for (const [t, d] of events) {
    active += d;
    if (active > cap) {
      if (t >= s && t <= e)
        return { at: new Date(t).toISOString(), capacity: cap };
    }
  }

  // Also ensure candidate falls within “available” windows if weekly rules present
  const weeklyRules = getWeeklyAvailability(person.id);
  if (weeklyRules.length > 0) {
    if (!rangeCoveredByWeeklyAndExceptions(person.id, s, e)) {
      return { reason: "outside weekly availability" };
    }
  }

  return null;
}

function computePersonFreeWindows(personId, s, e, domain) {
  const person = _people.get(personId);
  const cap = Math.max(1, person?.capacity || 1);

  // Build busy from bookings + busy exceptions
  const busy = [];
  for (const b of _bookings.values()) {
    if (b.personId !== personId) continue;
    busy.push([toMs(b.start), toMs(b.end)]);
  }
  for (const ex of _exceptions.values()) {
    if (ex.personId !== personId && ex.type === "busy") continue;
    if (ex.personId === personId && ex.type === "busy")
      busy.push([toMs(ex.start), toMs(ex.end)]);
  }
  busy.sort((a, b) => a[0] - b[0]);

  // If capacity > 1, busy might still leave capacity; build capacity timeline
  // We'll derive "not-full" windows within [s,e] where active < cap.
  const events = [];
  for (const [a, b] of busy) events.push([a, +1], [b, -1]);
  events.push([s, 0], [e, 0]);
  events.sort((A, B) => A[0] - B[0] || A[1] - B[1]);
  const capacityFree = [];
  let active = 0,
    lastT = s;
  for (const [t, d] of events) {
    if (t > lastT) {
      if (active < cap) capacityFree.push([Math.max(lastT, s), Math.min(t, e)]);
    }
    active += d;
    lastT = t;
  }

  // Intersect with weekly “available” windows if defined; also apply “available” exceptions
  const avail = weeklyRulesToIntervals(personId, s, e);
  const extraAvail = Array.from(_exceptions.values())
    .filter(
      (ex) =>
        ex.personId === personId &&
        ex.type === "available" &&
        rangesOverlap(s, e, toMs(ex.start), toMs(ex.end))
    )
    .map((ex) => [Math.max(s, toMs(ex.start)), Math.min(e, toMs(ex.end))]);

  const allowed = normalizeIntervals([...avail, ...extraAvail]);
  const final = intersectIntervalSets(capacityFree, allowed);
  // Optional: filter by quiet/sabbath if person needs it & domain is noisy
  if (appliesQuietSabbath(person, /*role*/ null)) {
    return final.filter(([a, b]) => {
      const tmp = {
        start: new Date(a).toISOString(),
        end: new Date(b).toISOString(),
        domain,
      };
      try {
        enforceQuietHours(tmp);
      } catch {
        return false;
      }
      try {
        enforceSabbathGuard(tmp);
      } catch {
        return false;
      }
      return true;
    });
  }
  return final;
}

function weeklyRulesToIntervals(personId, s, e) {
  const rules = getWeeklyAvailability(personId);
  if (!rules.length) return [[s, e]]; // if no weekly rules, assume always allowed
  const out = [];
  // Build each touched day as [dayStart, dayEnd] and map rules on it
  for (
    let dayMs = dayStart(s);
    dayMs <= dayStart(e);
    dayMs += 24 * 60 * 60 * 1000
  ) {
    const dayIdx = new Date(dayMs).getDay();
    const dayRules = rules.filter((r) => r.day === dayIdx);
    for (const r of dayRules) {
      const [sh, sm] = r.startHM.split(":").map(Number);
      const [eh, em] = r.endHM.split(":").map(Number);
      const start = dayMs + (sh * 60 + sm) * 60 * 1000;
      let end = dayMs + (eh * 60 + em) * 60 * 1000;
      if (end <= start) end += 24 * 60 * 60 * 1000; // wrap next day
      const seg = [Math.max(s, start), Math.min(e, end)];
      if (seg[0] < seg[1]) out.push(seg);
    }
  }
  return normalizeIntervals(out);
}

function rangeCoveredByWeeklyAndExceptions(personId, s, e) {
  const allowed = [
    ...weeklyRulesToIntervals(personId, s, e),
    ...Array.from(_exceptions.values())
      .filter(
        (ex) =>
          ex.personId === personId &&
          ex.type === "available" &&
          rangesOverlap(s, e, toMs(ex.start), toMs(ex.end))
      )
      .map((ex) => [Math.max(s, toMs(ex.start)), Math.min(e, toMs(ex.end))]),
  ];
  const merged = normalizeIntervals(allowed);
  // if [s,e] fully covered by merged intervals
  let cursor = s;
  for (const [a, b] of merged.sort((x, y) => x[0] - y[0])) {
    if (a > cursor) break;
    cursor = Math.max(cursor, b);
    if (cursor >= e) return true;
  }
  return false;
}

/* ----------------------------- Storage Layer ------------------------------- */
async function hydrateAll() {
  const [people, weekly, exceptions, bookings] = await Promise.all([
    storageLoadArray(LSK.people, db?.people),
    storageLoadArray(LSK.weekly, db?.peopleWeekly),
    storageLoadArray(LSK.exceptions, db?.peopleExceptions),
    storageLoadArray(LSK.bookings, db?.peopleBookings),
  ]);
  for (const p of people) _people.set(p.id, coercePerson(p));
  for (const r of weekly) _weekly.set(r.id, sanitizeRule(r));
  for (const ex of exceptions)
    _exceptions.set(ex.id, {
      id: String(ex?.id || genId()),
      personId: String(ex?.personId || ""),
      type: ex?.type === "available" ? "available" : "busy",
      start: toISO(ex?.start),
      end: toISO(ex?.end),
      reason: String(ex?.reason || ""),
    });
  for (const b of bookings) _bookings.set(b.id, normalizeBooking(b, isoNow()));
}

async function persistPeople() {
  if (db?.people?.bulkPut)
    return db.people.bulkPut(Array.from(_people.values()));
  return saveAllLocal(LSK.people, Array.from(_people.values()));
}
async function persistWeekly() {
  if (db?.peopleWeekly?.bulkPut)
    return db.peopleWeekly.bulkPut(Array.from(_weekly.values()));
  return saveAllLocal(LSK.weekly, Array.from(_weekly.values()));
}
async function persistExceptions() {
  if (db?.peopleExceptions?.bulkPut)
    return db.peopleExceptions.bulkPut(Array.from(_exceptions.values()));
  return saveAllLocal(LSK.exceptions, Array.from(_exceptions.values()));
}
async function persistBookings() {
  if (db?.peopleBookings?.bulkPut)
    return db.peopleBookings.bulkPut(Array.from(_bookings.values()));
  return saveAllLocal(LSK.bookings, Array.from(_bookings.values()));
}

async function storageLoadArray(lsKey, table) {
  try {
    if (table?.toArray) {
      const arr = await table.toArray();
      return Array.isArray(arr) ? arr : [];
    }
  } catch {}
  try {
    const raw = localStorage.getItem(lsKey);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
function saveAllLocal(lsKey, arr) {
  try {
    localStorage.setItem(lsKey, JSON.stringify(arr));
  } catch {}
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
  const seen = new Set();
  const out = [];
  for (const s of arr) {
    const k = String(s).trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}
function hasAllTags(tags = [], req = []) {
  const set = new Set((tags || []).map(String));
  return req.every((t) => set.has(String(t)));
}
function hasAnyTag(tags = [], list = []) {
  const set = new Set((tags || []).map(String));
  return list.some((t) => set.has(String(t)));
}
function rangesOverlap(a1, a2, b1, b2) {
  return a1 < b2 && b1 < a2;
}
function ceilTo(ms, granMin) {
  const step = (granMin || 15) * 60_000;
  return Math.ceil(ms / step) * step;
}
function dayStart(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
function hmOrDefault(s, def) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(s || ""));
  return m ? `${m[1]}:${m[2]}` : def;
}
function clampInt(n, lo, hi) {
  const x = Math.max(lo, Math.min(hi, Number.isFinite(n) ? Math.floor(n) : lo));
  return x;
}
function approximateSabbathWindow(ts) {
  // Fri 18:00 → Sat 20:00 (approx)
  const d = new Date(ts);
  const day = d.getDay();
  const base = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffToFri = (5 - day + 7) % 7;
  const friBase = base + diffToFri * 24 * 60 * 60 * 1000;
  const sabStart = new Date(friBase + 18 * 60 * 60 * 1000).getTime();
  const sabEnd = sabStart + 26 * 60 * 60 * 1000;
  return [sabStart, sabEnd];
}
function violatesWindow(startMs, endMs, q) {
  const days =
    Array.isArray(q.days) && q.days.length ? q.days : [0, 1, 2, 3, 4, 5, 6];
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
    if (qe <= qs) qe += 24 * 60 * 60 * 1000; // wrap
    if (rangesOverlap(startMs, endMs, qs, qe)) return true;
  }
  return false;
}
function normalizeIntervals(list) {
  if (!list.length) return [];
  const arr = list.slice().sort((a, b) => a[0] - b[0]);
  const out = [arr[0].slice()];
  for (let i = 1; i < arr.length; i++) {
    const [a, b] = arr[i];
    const last = out[out.length - 1];
    if (a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}
function intersectIntervalSets(A, B) {
  const out = [];
  let i = 0,
    j = 0;
  while (i < A.length && j < B.length) {
    const a = A[i],
      b = B[j];
    const start = Math.max(a[0], b[0]);
    const end = Math.min(a[1], b[1]);
    if (start < end) out.push([start, end]);
    if (a[1] < b[1]) i++;
    else j++;
  }
  return out;
}

/* --------------------------------- Exports --------------------------------- */
export default {
  init,
  // people
  registerPerson,
  updatePerson,
  removePerson,
  listPeople,
  // weekly availability
  setWeeklyAvailability,
  getWeeklyAvailability,
  // exceptions
  addException,
  removeException,
  // bookings
  upsertBooking,
  releaseBooking,
  getBookingsForPerson,
  // suggestions
  suggestRoleSlots,
};
