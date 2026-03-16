// C:\Users\larho\suka-smart-assistant\src\services\calendar\deviceCalendar.js
// Device Calendar Manager (all domains)
// -----------------------------------------------------------------------------
// ROLE IN PIPELINE
// imports → intelligence → automation → (optional) hub export
//            │             │            └─ engines ask for device availability & book here
//            └─ imports may imply equipment needs (e.g., “preheat oven”, “use tiller”)
//
// This module tracks BOOKINGS for household devices/equipment across ALL domains
// (e.g., oven, stove burners, dishwasher, dehydrator, pressure canner, smoker,
// tiller, spade, hoe, incubator, shears, stunner, vacuum sealer, etc.).
//
// Features:
//  • Device registry (add/update/remove, quantities/capacity, default cooldown)
//  • Booking CRUD with cooldown buffers and maintenance windows
//  • Capacity-aware conflict detection (quantity > 1 allows parallel bookings)
//  • Slot suggestions (respecting cooldowns/maintenance/capacity)
//  • Optional quietHours/sabbathGuard enforcement for “noisy” device kinds
//  • Event wiring via eventBus (emits {type, ts, source, data}, canonicalized upstream)
//  • Optional Hub export on data-changing operations (familyFundMode)
//
// Storage: Dexie if available (db.deviceRegistry, db.deviceBookings, db.deviceMaintenance)
//          else localStorage fallbacks.
//
// All time parameters are ISO strings externally; internally compared as epoch ms.
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
 * @typedef {"appliance"|"tool"|"utensil"|"vehicle"|"other"} DeviceKind
 *
 * @typedef {Object} Device
 * @property {string} id
 * @property {string} name           // e.g., "Oven A", "Tiller", "Pressure Canner #1"
 * @property {DeviceKind} kind
 * @property {string} [domain]       // cooking | cleaning | garden | animals | preservation | storehouse
 * @property {number} [quantity]     // concurrent capacity, default 1
 * @property {number} [cooldownMs]   // default cooldown after each booking
 * @property {boolean} [active]      // default true
 * @property {string[]} [tags]
 * @property {Object} [meta]         // arbitrary (location, wattage, noisy?:true, etc.)
 * @property {string} createdAt
 * @property {string} updatedAt
 *
 * @typedef {Object} Maintenance
 * @property {string} id
 * @property {string} deviceId
 * @property {string} start          // ISO
 * @property {string} end            // ISO
 * @property {string} [reason]
 *
 * @typedef {Object} Booking
 * @property {string} id
 * @property {string} deviceId
 * @property {string} title
 * @property {string} start          // ISO
 * @property {string} end            // ISO
 * @property {string} [domain]
 * @property {Object} [meta]         // sessionId, draftId, ovenTemp, etc.
 * @property {string} source
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/* ------------------------------- In-Memory Cache --------------------------- */
const _devices = new Map(); // id -> Device
const _bookings = new Map(); // id -> Booking
const _maintenance = new Map(); // id -> Maintenance
let _initialized = false;

/* ------------------------------- Constants --------------------------------- */
const LSK = {
  devices: "ssa.device.registry.v1",
  bookings: "ssa.device.bookings.v1",
  maint: "ssa.device.maintenance.v1",
};

/* ---------------------------------- API ------------------------------------ */
export async function init() {
  if (_initialized) return;
  await hydrateAll();
  _initialized = true;

  // RPC endpoints for engines
  if (eventBus?.respond) {
    // Query availability for one or more devices
    eventBus.respond("device/availability", async (q) => {
      // q: { deviceIds?:string[], kinds?:string[], startISO, endISO, durationMin, granularityMin, applyQuiet?:boolean }
      try {
        const res = await suggestDeviceSlots(q || {});
        return { ok: true, ...res };
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
    });

    // Request a booking (single device)
    eventBus.respond("device/booking.request", async (req) => {
      // req: { deviceId, title, start, end, domain, meta }
      try {
        const item = await upsertBooking(req || {});
        return { ok: true, item };
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
    });
  }

  // Glue: when a session is approved and declares equipment, attempt auto-book
  eventBus.on(
    Events?.SESSION_APPROVED || "session/approved",
    async ({ data }) => {
      try {
        const eq = readEquipmentList(data);
        if (!eq.length) return;
        for (const need of eq) {
          const { deviceId, kind, title, start, end, domain, meta } = need;
          // If exact device known, try to book it; else find any device by kind
          if (deviceId && _devices.has(deviceId)) {
            await safeTry(() =>
              upsertBooking({
                deviceId,
                title: title || autoTitle(kind),
                start,
                end,
                domain,
                meta: { ...meta, sessionAuto: true },
              })
            );
          } else if (kind) {
            const best = findFirstActiveDeviceByKind(kind);
            if (best) {
              await safeTry(() =>
                upsertBooking({
                  deviceId: best.id,
                  title: title || autoTitle(kind),
                  start,
                  end,
                  domain,
                  meta: { ...meta, sessionAuto: true },
                })
              );
            }
          }
        }
      } catch {}
    }
  );
}

/** Registry ----------------------------------------------------------------- */
export async function registerDevice(input) {
  guardInit();
  const now = isoNow();
  const d = normalizeDevice(input, now);
  if (!d.name) throw new Error("device: name required");
  _devices.set(d.id, d);
  await persistDevice(d);

  emit("device/registered", { device: d });
  await exportToHubIfEnabled({
    type: "device/registered",
    ts: now,
    source: "deviceCalendar",
    data: { device: d },
  });
  return d;
}

export async function updateDevice(input) {
  guardInit();
  if (!input?.id) throw new Error("device: id required");
  const prev = _devices.get(String(input.id));
  if (!prev) throw new Error("device: not found");

  const now = isoNow();
  const merged = { ...prev, ...input, updatedAt: now };
  if (typeof merged.quantity !== "number" || merged.quantity < 1)
    merged.quantity = 1;
  if (typeof merged.cooldownMs !== "number" || merged.cooldownMs < 0)
    merged.cooldownMs = prev.cooldownMs || 0;

  _devices.set(merged.id, merged);
  await persistDevice(merged);

  emit("device/updated", { device: merged, prev });
  await exportToHubIfEnabled({
    type: "device/updated",
    ts: now,
    source: "deviceCalendar",
    data: { device: merged },
  });
  return merged;
}

export async function removeDevice(id) {
  guardInit();
  const dev = _devices.get(String(id));
  if (!dev) return false;

  // If there are future bookings, reject removal
  const now = Date.now();
  const hasFuture = Array.from(_bookings.values()).some(
    (b) => b.deviceId === dev.id && toMs(b.end) >= now
  );
  if (hasFuture) throw new Error("device: cannot remove with future bookings");

  _devices.delete(dev.id);
  await deleteDeviceFromStorage(dev.id);
  emit("device/removed", { id: dev.id, device: dev });
  await exportToHubIfEnabled({
    type: "device/removed",
    ts: isoNow(),
    source: "deviceCalendar",
    data: { id: dev.id },
  });
  return true;
}

export function listDevices({ activeOnly = true, kind, domain } = {}) {
  const arr = Array.from(_devices.values());
  return arr
    .filter((d) => {
      if (activeOnly && d.active === false) return false;
      if (kind && d.kind !== kind) return false;
      if (domain && d.domain !== domain) return false;
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Maintenance --------------------------------------------------------------- */
export async function addMaintenance({ deviceId, start, end, reason }) {
  guardInit();
  if (!deviceId || !_devices.has(String(deviceId)))
    throw new Error("maintenance: deviceId invalid");
  if (!isISO(start) || !isISO(end))
    throw new Error("maintenance: invalid start/end");
  if (toMs(end) <= toMs(start))
    throw new Error("maintenance: end must be after start");

  const m = {
    id: genId(),
    deviceId: String(deviceId),
    start: toISO(start),
    end: toISO(end),
    reason: String(reason || ""),
  };
  _maintenance.set(m.id, m);
  await persistMaintenance(m);

  emit("device/maintenance.added", { maintenance: m });
  await exportToHubIfEnabled({
    type: "device/maintenance.added",
    ts: isoNow(),
    source: "deviceCalendar",
    data: { maintenance: m },
  });
  return m;
}

export async function removeMaintenance(id) {
  guardInit();
  const m = _maintenance.get(String(id));
  if (!m) return false;
  _maintenance.delete(m.id);
  await deleteMaintenanceFromStorage(m.id);

  emit("device/maintenance.removed", { id: m.id, maintenance: m });
  await exportToHubIfEnabled({
    type: "device/maintenance.removed",
    ts: isoNow(),
    source: "deviceCalendar",
    data: { id: m.id },
  });
  return true;
}

/** Bookings ------------------------------------------------------------------ */
export async function upsertBooking(input) {
  guardInit();
  const now = isoNow();

  // Normalize & validate
  const b = normalizeBooking(input, now);
  const dev = _devices.get(b.deviceId);
  if (!dev || dev.active === false)
    throw new Error("booking: device not active/exists");
  if (!isISO(b.start) || !isISO(b.end))
    throw new Error("booking: invalid start/end");
  if (toMs(b.end) <= toMs(b.start))
    throw new Error("booking: end must be after start");

  // Guardrails for “noisy” devices if configured
  if (appliesQuietSabbath(dev)) {
    enforceQuietHours(b);
    enforceSabbathGuard(b);
  }

  // Conflict / capacity check (with cooldowns)
  const conflict = hasCapacityConflict(
    dev.id,
    b,
    dev.quantity || 1,
    dev.cooldownMs || 0
  );
  if (conflict) {
    emit("device/booking.conflict", {
      device: dev,
      booking: b,
      details: conflict,
    });
    throw new Error("booking: capacity/cooldown conflict");
  }

  _bookings.set(b.id, b);
  await persistBooking(b);

  emit("device/booking.saved", {
    booking: b,
    device: dev,
    reason: input?.id ? "updated" : "created",
  });
  await exportToHubIfEnabled({
    type: "device/booking.saved",
    ts: now,
    source: "deviceCalendar",
    data: { booking: b },
  });
  return b;
}

export async function releaseBooking(id) {
  guardInit();
  const b = _bookings.get(String(id));
  if (!b) return false;
  _bookings.delete(b.id);
  await deleteBookingFromStorage(b.id);

  emit("device/booking.removed", { id: b.id, booking: b });
  await exportToHubIfEnabled({
    type: "device/booking.removed",
    ts: isoNow(),
    source: "deviceCalendar",
    data: { id: b.id, booking: b },
  });
  return true;
}

export function getBookingsForDevice(deviceId, { fromISO, toISO } = {}) {
  const s = fromISO ? toMs(fromISO) : -Infinity;
  const e = toISO ? toMs(toISO) : Infinity;
  return Array.from(_bookings.values())
    .filter(
      (b) =>
        b.deviceId === String(deviceId) &&
        rangesOverlap(s, e, toMs(b.start), toMs(b.end))
    )
    .sort((a, b) => toMs(a.start) - toMs(b.start));
}

/**
 * Suggest slots for one or more devices
 * @param {Object} params
 * @param {string[]} [params.deviceIds]  // narrow search to specific devices
 * @param {string[]} [params.kinds]      // or search by kinds
 * @param {string} params.startISO
 * @param {string} params.endISO
 * @param {number} params.durationMin
 * @param {number} [params.granularityMin=15]
 * @param {boolean} [params.applyQuiet=true] // enforce quiet/sabbath for noisy devices
 * @returns {{window:{startISO,endISO}, durationMin:number, slots:Array<{deviceId,start,end}>}}
 */
export async function suggestDeviceSlots(params) {
  guardInit();
  const {
    deviceIds,
    kinds,
    startISO,
    endISO,
    durationMin,
    granularityMin = 15,
    applyQuiet = true,
  } = params;

  if (!isISO(startISO) || !isISO(endISO))
    throw new Error("availability: invalid window");
  if (!Number.isFinite(durationMin) || durationMin <= 0)
    throw new Error("availability: durationMin required");

  const s = toMs(startISO);
  const e = toMs(endISO);
  const durMs = Math.round(durationMin * 60_000);

  // Build candidate device list
  let candidates = [];
  if (Array.isArray(deviceIds) && deviceIds.length) {
    candidates = deviceIds
      .map((id) => _devices.get(String(id)))
      .filter(Boolean);
  } else if (Array.isArray(kinds) && kinds.length) {
    candidates = listDevices({ activeOnly: true }).filter((d) =>
      kinds.includes(d.kind)
    );
  } else {
    candidates = listDevices({ activeOnly: true });
  }

  // For each device, compute free windows honoring capacity/cooldown/maintenance
  const slots = [];
  for (const dev of candidates) {
    const deviceSlots = computeDeviceSlots(
      dev,
      s,
      e,
      durMs,
      granularityMin,
      applyQuiet
    );
    for (const win of deviceSlots) {
      slots.push({
        deviceId: dev.id,
        start: new Date(win[0]).toISOString(),
        end: new Date(win[1]).toISOString(),
      });
    }
  }

  // Sort by start time, earlier first
  slots.sort((a, b) => toMs(a.start) - toMs(b.start));

  emit("device/slotsSuggested", {
    window: { startISO, endISO },
    durationMin,
    granularityMin,
    deviceCount: candidates.length,
    count: slots.length,
  });

  return { window: { startISO, endISO }, durationMin, slots };
}

/* ---------------------------- Internal Helpers ----------------------------- */
function emit(type, data, opts = {}) {
  if (!eventBus?.emit) return;
  eventBus.emit(type, data, {
    source: opts.source || "deviceCalendar",
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

function normalizeDevice(input, nowIso) {
  const id = String(input?.id || genId());
  /** @type {Device} */
  const d = {
    id,
    name: String(input?.name || "Device"),
    kind: normKind(input?.kind),
    domain: input?.domain || undefined,
    quantity:
      Number.isFinite(input?.quantity) && input.quantity > 0
        ? Math.floor(input.quantity)
        : 1,
    cooldownMs:
      Number.isFinite(input?.cooldownMs) && input.cooldownMs >= 0
        ? Math.floor(input.cooldownMs)
        : 0,
    active: input?.active !== false,
    tags: Array.isArray(input?.tags) ? dedupStrings(input.tags) : undefined,
    meta: isPojo(input?.meta) ? { ...input.meta } : undefined,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  return d;
}

function normalizeBooking(input, nowIso) {
  const id = String(input?.id || genId());
  /** @type {Booking} */
  const b = {
    id,
    deviceId: String(input?.deviceId || ""),
    title: String(input?.title || "Device Booking"),
    start: toISO(input?.start),
    end: toISO(input?.end),
    domain: input?.domain || undefined,
    meta: isPojo(input?.meta) ? { ...input.meta } : undefined,
    source: input?.source || "deviceCalendar",
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  const prev = _bookings.get(id);
  if (prev) b.createdAt = prev.createdAt || nowIso;
  return b;
}

function appliesQuietSabbath(dev) {
  // Consider “noisy” kinds or flagged meta.noisy === true
  const noisyKinds = new Set(["tool", "vehicle"]);
  return noisyKinds.has(dev.kind) || dev?.meta?.noisy === true;
}

function enforceQuietHours(booking) {
  const q = featureFlags?.quietHours;
  if (!q || q.enabled === false) return;
  const startMs = toMs(booking.start);
  const endMs = toMs(booking.end);
  if (!violatesWindow(startMs, endMs, q)) return;
  throw new Error("booking violates quiet hours");
}

function enforceSabbathGuard(booking) {
  if (!featureFlags?.sabbathGuard) return;
  const [sabStart, sabEnd] = approximateSabbathWindow(toMs(booking.start));
  if (rangesOverlap(toMs(booking.start), toMs(booking.end), sabStart, sabEnd)) {
    const allowed = featureFlags?.sabbathGuard?.allowedDomains || [];
    if (!allowed.includes(booking.domain)) {
      throw new Error("booking violates sabbath guard");
    }
  }
}

function hasCapacityConflict(deviceId, newBooking, quantity, cooldownMs) {
  // Build timeline of intervals with cooldown applied AFTER each booking
  // We consider capacity as “can host up to N parallel active+cooldown intervals”
  const s = toMs(newBooking.start);
  const e = toMs(newBooking.end);
  const intervals = [];

  for (const b of _bookings.values()) {
    if (b.deviceId !== deviceId) continue;
    const bs = toMs(b.start);
    const be = toMs(b.end) + Math.max(0, cooldownMs);
    intervals.push([bs, be]);
  }
  // include maintenance windows as fully occupying capacity
  for (const m of _maintenance.values()) {
    if (m.deviceId !== deviceId) continue;
    intervals.push([toMs(m.start), toMs(m.end)]);
  }

  // Add the candidate with its cooldown
  const cand = [s, e + Math.max(0, cooldownMs)];
  intervals.push(cand);

  // Sweep line to ensure that overlap count never exceeds quantity
  const events = [];
  for (const [a, b] of intervals) {
    events.push([a, +1], [b, -1]);
  }
  events.sort((A, B) => A[0] - B[0] || A[1] - B[1]); // end before start at same ms

  let active = 0;
  for (const [t, delta] of events) {
    active += delta;
    if (active > quantity) {
      // Identify if candidate is causing overflow near t within its span
      if (t >= cand[0] && t <= cand[1]) {
        return { at: new Date(t).toISOString(), quantity, cooldownMs };
      }
    }
  }
  return null;
}

function computeDeviceSlots(dev, s, e, durMs, granMin, applyQuiet) {
  const step = (granMin || 15) * 60_000;
  const cooldown = Math.max(0, dev.cooldownMs || 0);
  const quantity = Math.max(1, dev.quantity || 1);

  // Build “busy” intervals (bookings + maintenance), each extended by cooldown
  const busy = [];
  for (const b of _bookings.values()) {
    if (b.deviceId !== dev.id) continue;
    busy.push([toMs(b.start), toMs(b.end) + cooldown]);
  }
  for (const m of _maintenance.values()) {
    if (m.deviceId !== dev.id) continue;
    busy.push([toMs(m.start), toMs(m.end)]);
  }
  busy.sort((a, b) => a[0] - b[0]);

  // Turn into a multiset of starts/ends to test capacity at candidate times
  const events = [];
  for (const [a, b] of busy) events.push([a, +1], [b, -1]);
  events.sort((A, B) => A[0] - B[0] || A[1] - B[1]);

  // Helper to test if [x, x+dur] fits within capacity at all instants
  const fits = (x) => {
    const y = x + durMs;
    // Quick reject against maintenance or capacity using local sweep
    let active = 0;
    let i = 0;
    while (i < events.length && events[i][0] <= x) {
      active += events[i][1];
      i++;
    }
    // Walk through changes within [x, y+cooldown] (include cooldown capacity)
    const endCheck = y + dev.cooldownMs;
    let t = x;
    let j = i;
    // If applying quiet/sabbath, filter here
    if (applyQuiet && appliesQuietSabbath(dev)) {
      const tempBooking = {
        start: new Date(x).toISOString(),
        end: new Date(y).toISOString(),
        domain: dev.domain,
      };
      try {
        enforceQuietHours(tempBooking);
      } catch {
        return false;
      }
      try {
        enforceSabbathGuard(tempBooking);
      } catch {
        return false;
      }
    }
    while (j < events.length && events[j][0] <= endCheck) {
      // segment [t, events[j][0]) must respect capacity
      if (active >= quantity) return false;
      active += events[j][1];
      t = events[j][0];
      j++;
    }
    // last segment [t, endCheck)
    return active < quantity;
  };

  const slots = [];
  // iterate over candidate starts on grid
  for (let x = ceilTo(s, granMin); x + durMs <= e; x += step) {
    if (fits(x)) slots.push([x, x + durMs]);
  }
  return slots;
}

function readEquipmentList(data) {
  // Accept a few shapes: data.session?.equipment[], data.draft?.equipment[], data?.equipment[]
  const eq =
    data?.session?.equipment ||
    data?.draft?.equipment ||
    data?.equipment ||
    data?.draft?.meta?.equipment ||
    [];
  if (!Array.isArray(eq)) return [];
  // Normalize: { deviceId?, kind?, title?, start?, end?, domain?, meta? }
  return eq
    .map((x) => ({
      deviceId: x?.deviceId ? String(x.deviceId) : undefined,
      kind: x?.kind ? String(x.kind) : undefined,
      title: x?.title,
      start: isISO(x?.start) ? x.start : undefined,
      end: isISO(x?.end) ? x.end : undefined,
      domain: x?.domain,
      meta: isPojo(x?.meta) ? x.meta : undefined,
    }))
    .filter((u) => (u.deviceId || u.kind) && u.start && u.end);
}

function findFirstActiveDeviceByKind(kind) {
  const list = listDevices({ activeOnly: true });
  return list.find((d) => d.kind === normKind(kind));
}

function autoTitle(kind) {
  const k = String(kind || "device");
  return `Auto-booked ${k}`;
}

/* ----------------------------- Storage Layer ------------------------------- */
async function hydrateAll() {
  const [devs, books, maint] = await Promise.all([
    storageLoadArray(LSK.devices, db?.deviceRegistry),
    storageLoadArray(LSK.bookings, db?.deviceBookings),
    storageLoadArray(LSK.maint, db?.deviceMaintenance),
  ]);
  for (const d of devs) _devices.set(d.id, coerceDevice(d));
  for (const b of books) _bookings.set(b.id, coerceBooking(b));
  for (const m of maint) _maintenance.set(m.id, coerceMaintenance(m));
}

async function persistDevice(d) {
  if (db?.deviceRegistry?.put) return db.deviceRegistry.put(d);
  return saveAllLocal(LSK.devices, Array.from(_devices.values()));
}
async function deleteDeviceFromStorage(id) {
  if (db?.deviceRegistry?.delete) return db.deviceRegistry.delete(id);
  return saveAllLocal(LSK.devices, Array.from(_devices.values()));
}

async function persistBooking(b) {
  if (db?.deviceBookings?.put) return db.deviceBookings.put(b);
  return saveAllLocal(LSK.bookings, Array.from(_bookings.values()));
}
async function deleteBookingFromStorage(id) {
  if (db?.deviceBookings?.delete) return db.deviceBookings.delete(id);
  return saveAllLocal(LSK.bookings, Array.from(_bookings.values()));
}

async function persistMaintenance(m) {
  if (db?.deviceMaintenance?.put) return db.deviceMaintenance.put(m);
  return saveAllLocal(LSK.maint, Array.from(_maintenance.values()));
}
async function deleteMaintenanceFromStorage(id) {
  if (db?.deviceMaintenance?.delete) return db.deviceMaintenance.delete(id);
  return saveAllLocal(LSK.maint, Array.from(_maintenance.values()));
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
function rangesOverlap(a1, a2, b1, b2) {
  return a1 < b2 && b1 < a2;
}
function ceilTo(ms, granMin) {
  const step = (granMin || 15) * 60_000;
  return Math.ceil(ms / step) * step;
}
function normKind(k) {
  const x = String(k || "other").toLowerCase();
  if (["appliance", "tool", "utensil", "vehicle"].includes(x)) return x;
  return "other";
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
    if (qe <= qs) qe += 24 * 60 * 60 * 1000;
    if (rangesOverlap(startMs, endMs, qs, qe)) return true;
  }
  return false;
}
function dayStart(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
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
function coerceDevice(x) {
  const now = isoNow();
  const d = normalizeDevice(x, now);
  d.createdAt = toISO(x?.createdAt || now);
  d.updatedAt = toISO(x?.updatedAt || now);
  return d;
}
function coerceBooking(x) {
  const now = isoNow();
  const b = normalizeBooking(x, now);
  b.createdAt = toISO(x?.createdAt || now);
  b.updatedAt = toISO(x?.updatedAt || now);
  return b;
}
function coerceMaintenance(x) {
  return {
    id: String(x?.id || genId()),
    deviceId: String(x?.deviceId || ""),
    start: toISO(x?.start),
    end: toISO(x?.end),
    reason: String(x?.reason || ""),
  };
}
async function safeTry(fn) {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/* --------------------------------- Exports --------------------------------- */
export default {
  init,
  // registry
  registerDevice,
  updateDevice,
  removeDevice,
  listDevices,
  // maintenance
  addMaintenance,
  removeMaintenance,
  // bookings
  upsertBooking,
  releaseBooking,
  getBookingsForDevice,
  suggestDeviceSlots,
};
