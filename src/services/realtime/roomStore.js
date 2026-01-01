// src/services/realtime/roomStore.js
// Tiny in-memory room + session state for SSA clients (browser/app).
//
// How this fits the SSA pipeline
// • imports → intelligence → automation → (optional) hub export
// • This module is the "client-side brain" that tracks cross-device rooms (RTC/WS),
//   participants, transport health, and the live Session state (step, status, ETA).
// • It emits SSA-standard events over eventBus: { type, ts, source, data }.
// • When Session state changes represent a household mutation (e.g., session.started,
//   meal.executed, preservation.completed), it can optionally export to the Hub.
//
// Design goals
// • Zero external deps; works offline (optional localStorage persistence).
// • Defensive: input validation, bounded memory, TTL-based purging.
// • Forward-thinking: supports multiple domains (cooking/cleaning/garden/animal/preservation),
//   multiple transports (rtc|ws), per-room observers, and future metadata.
//
// Typical usage
//   roomStore.configure({ persist: true, ttlMs: 12*60*60*1000 });
//   const { roomId } = roomStore.createRoom("ABC123", { session: { type: "cooking" } });
//   roomStore.joinRoom("ABC123", { id: "phone-1", role: "controller" });
//   roomStore.setSessionState("ABC123", { status: "started", stepId: "prep-1" });
//   roomStore.appendMessage("ABC123", { type: "session.control.next", data: {...} });
//   roomStore.closeRoom("ABC123", "done");
//
// Notes
// • This is a client-side store. Server-side authority (signaling / hub) remains external.
// • For RTC/WS wiring, consume events from rtcClient/wsFallback and update roomStore accordingly.

let eventBus = {
  emit: (...a) => console.debug("[roomStore:eventBus.emit]", ...a),
  on: () => () => {},
};
try {
  const eb = require("@/services/eventBus");
  eventBus = eb?.default || eb?.eventBus || eventBus;
} catch { /* optional */ }

// Feature flags
let featureFlags = { familyFundMode: false };
try {
  featureFlags = require("@/config/featureFlags.json");
} catch { /* optional */ }

// Optional Hub export
let HubPacketFormatter = null;
let FamilyFundConnector = null;
try {
  HubPacketFormatter = require("@/integrations/HubPacketFormatter");
  FamilyFundConnector = require("@/integrations/FamilyFundConnector");
} catch { /* optional */ }

const SRC = "services.realtime.roomStore";

/* -------------------------------- Helpers -------------------------------- */
function nowIso() { return new Date().toISOString(); }
function emit(type, data = {}) {
  try { eventBus.emit({ type, ts: nowIso(), source: SRC, data }); }
  catch (err) { console.warn("[roomStore] eventBus.emit failed", err); }
}
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function deepClone(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }
function isMutatingType(t = "") {
  return /^session\.|^inventory\.|^garden\.|^preservation\./.test(t || "");
}
async function exportToHubIfEnabled(payload) {
  if (!featureFlags?.familyFundMode) return;
  if (!HubPacketFormatter || !FamilyFundConnector) return;
  try {
    const packet = HubPacketFormatter.format(payload);
    await FamilyFundConnector.send(packet);
  } catch (err) {
    // Silent by design; Hub is auxiliary.
    console.warn("[roomStore] Hub export failed silently:", err?.message || err);
  }
}

// Bounded message buffer
function appendBounded(arr, item, max) {
  if (!Array.isArray(arr)) return [item];
  if (arr.length >= max) arr.shift();
  arr.push(item);
  return arr;
}

// Local storage helpers (best-effort)
const LS_KEY = "ssa.roomStore.v1";
function lsGet() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || "null"); } catch { return null; }
}
function lsSet(obj) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(obj)); } catch { /* ignore quota */ }
}

/* --------------------------------- Store --------------------------------- */
class RoomStore {
  constructor() {
    this._rooms = new Map(); // roomId -> room
    this._roomObservers = new Map(); // roomId -> Set(fn)
    this._wildcards = new Set(); // all-room observers
    this._opts = {
      maxMessagesPerRoom: 200,
      ttlMs: 6 * 60 * 60 * 1000, // 6h
      persist: false,
      persistFields: ["id", "createdAt", "updatedAt", "metadata", "session", "transport", "participants"],
      debug: false,
    };

    // Periodic GC for TTL/persistence freshness
    this._gcTimer = setInterval(() => this.purgeExpired(), 10 * 60 * 1000);
    // Lazy load persisted snapshot
    this._hydrateFromStorage();
  }

  /* ------------------------------- Configure ------------------------------ */
  configure(opts = {}) {
    if (typeof opts.maxMessagesPerRoom === "number") {
      this._opts.maxMessagesPerRoom = clamp(opts.maxMessagesPerRoom, 20, 5000);
    }
    if (typeof opts.ttlMs === "number") {
      this._opts.ttlMs = clamp(opts.ttlMs, 5 * 60 * 1000, 7 * 24 * 60 * 60 * 1000); // 5m..7d
    }
    if (typeof opts.persist === "boolean") this._opts.persist = opts.persist;
    if (Array.isArray(opts.persistFields)) this._opts.persistFields = opts.persistFields.slice(0);
    if (typeof opts.debug === "boolean") this._opts.debug = opts.debug;
  }

  /* -------------------------------- Observe ------------------------------- */
  onRoom(roomId, fn) {
    if (!roomId || typeof fn !== "function") return () => {};
    if (!this._roomObservers.has(roomId)) this._roomObservers.set(roomId, new Set());
    const set = this._roomObservers.get(roomId);
    set.add(fn);
    return () => set.delete(fn);
  }
  onAny(fn) {
    if (typeof fn !== "function") return () => {};
    this._wildcards.add(fn);
    return () => this._wildcards.delete(fn);
  }
  _notify(roomId, event, roomSnapshot) {
    const snap = deepClone(roomSnapshot);
    const set = this._roomObservers.get(roomId);
    set && set.forEach(fn => { try { fn(event, snap); } catch {} });
    this._wildcards.forEach(fn => { try { fn(roomId, event, snap); } catch {} });
  }

  /* --------------------------------- CRUD -------------------------------- */
  createRoom(roomId, initial = {}) {
    if (!roomId || typeof roomId !== "string") throw new Error("createRoom requires roomId:string");
    if (this._rooms.has(roomId)) {
      // Update metadata if provided
      const r = this._rooms.get(roomId);
      if (initial?.metadata) {
        r.metadata = { ...(r.metadata || {}), ...(initial.metadata || {}) };
        r.updatedAt = nowIso();
        this._persist();
        this._notify(roomId, "metadata.updated", r);
        emit("room.metadata.updated", { roomId, metadata: deepClone(r.metadata) });
      }
      return { roomId, existed: true };
    }

    const room = {
      id: roomId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      lastActiveAt: nowIso(),

      // lightweight state
      transport: { kind: null, connected: false }, // {kind: "rtc"|"ws"|null, connected: bool}
      participants: [], // [{id, role, device, name}]
      metadata: deepClone(initial?.metadata) || {},

      // session: domain-neutral but ready for SSA
      session: sanitizeSession(initial?.session),

      // bounded message log (UI tooling / debug)
      messages: [],
      _ttl: this._opts.ttlMs,
    };

    this._rooms.set(roomId, room);
    this._persist();
    this._notify(roomId, "room.created", room);
    emit("room.created", { roomId });
    return { roomId };
  }

  closeRoom(roomId, reason = "closed") {
    const r = this._rooms.get(roomId);
    if (!r) return false;
    this._rooms.delete(roomId);
    this._persist();
    emit("room.closed", { roomId, reason });
    this._notify(roomId, "room.closed", { id: roomId, reason });
    return true;
  }

  getRoom(roomId) {
    const r = this._rooms.get(roomId);
    return r ? deepClone(r) : null;
  }

  listRooms() {
    return Array.from(this._rooms.values()).map(deepClone);
  }

  /* ------------------------------ Participants ---------------------------- */
  joinRoom(roomId, participant) {
    const r = this._rooms.get(roomId);
    if (!r) throw new Error("joinRoom: unknown roomId");
    const p = sanitizeParticipant(participant);
    if (!p) return false;

    const idx = r.participants.findIndex(x => x.id === p.id);
    if (idx >= 0) {
      r.participants[idx] = { ...r.participants[idx], ...p };
    } else {
      r.participants.push(p);
    }
    r.updatedAt = nowIso();
    r.lastActiveAt = r.updatedAt;
    this._persist();

    this._notify(roomId, "participant.joined", r);
    emit("room.participant.joined", { roomId, participant: deepClone(p) });
    return true;
  }

  leaveRoom(roomId, participantId) {
    const r = this._rooms.get(roomId);
    if (!r) return false;
    const sizeBefore = r.participants.length;
    r.participants = r.participants.filter(x => x.id !== participantId);
    if (r.participants.length !== sizeBefore) {
      r.updatedAt = nowIso();
      r.lastActiveAt = r.updatedAt;
      this._persist();
      this._notify(roomId, "participant.left", r);
      emit("room.participant.left", { roomId, participantId });
      return true;
    }
    return false;
  }

  /* -------------------------------- Session ------------------------------- */
  setSessionState(roomId, partial = {}) {
    const r = this._rooms.get(roomId);
    if (!r) throw new Error("setSessionState: unknown roomId");
    const before = JSON.stringify(r.session || {});
    const merged = mergeSession(r.session || {}, partial);
    r.session = merged;
    r.updatedAt = nowIso();
    r.lastActiveAt = r.updatedAt;

    this._persist();
    this._notify(roomId, "session.updated", r);

    emit("session.state.updated", { roomId, session: deepClone(merged) });

    // Optional Hub export for mutations of household significance
    // Choose key transitions/status messages to export.
    if (shouldExportSessionMutation(before, merged)) {
      exportToHubIfEnabled({
        via: "roomStore",
        roomId,
        message: { type: "session.state.updated", ts: nowIso(), source: SRC, data: deepClone(merged) },
      });
    }
    return deepClone(merged);
  }

  /* -------------------------------- Messages ------------------------------ */
  appendMessage(roomId, envelope) {
    const r = this._rooms.get(roomId);
    if (!r) throw new Error("appendMessage: unknown roomId");

    const msg = normalizeEnvelope(envelope);
    r.messages = appendBounded(r.messages, msg, this._opts.maxMessagesPerRoom);
    r.updatedAt = nowIso();
    r.lastActiveAt = r.updatedAt;

    this._persist();
    this._notify(roomId, "message.appended", r);

    emit("room.message", { roomId, type: msg.type });

    // Hub export only for mutating domain messages
    if (isMutatingType(msg.type)) {
      exportToHubIfEnabled({ via: "roomStore", roomId, message: msg, inbound: true });
    }
    return msg;
  }

  /* ------------------------------- Transport ------------------------------ */
  updateTransport(roomId, kind, connected) {
    const r = this._rooms.get(roomId);
    if (!r) throw new Error("updateTransport: unknown roomId");

    const k = kind === "rtc" || kind === "ws" ? kind : null;
    const c = !!connected;
    const changed = r.transport.kind !== k || r.transport.connected !== c;

    r.transport = { kind: k, connected: c };
    r.updatedAt = nowIso();
    if (changed) {
      this._persist();
      this._notify(roomId, "transport.updated", r);
      emit("room.transport.updated", { roomId, kind: k, connected: c });
    }
    return deepClone(r.transport);
  }

  /* --------------------------------- Admin -------------------------------- */
  purgeExpired() {
    const now = Date.now();
    const ttl = this._opts.ttlMs;
    const removed = [];
    this._rooms.forEach((room, id) => {
      const age = now - new Date(room.lastActiveAt || room.updatedAt || room.createdAt).getTime();
      if (age > ttl) {
        this._rooms.delete(id);
        removed.push(id);
        emit("room.ttl.purged", { roomId: id, ageMs: age });
      }
    });
    if (removed.length) this._persist();
    return removed;
  }

  clearAll(reason = "manual-clear") {
    const ids = Array.from(this._rooms.keys());
    this._rooms.clear();
    this._persist();
    ids.forEach(id => this._notify(id, "room.cleared", { id, reason }));
    emit("room.cleared.all", { count: ids.length, reason });
    return ids.length;
  }

  /* ------------------------------ Persistence ----------------------------- */
  _hydrateFromStorage() {
    const snap = lsGet();
    if (!snap || !Array.isArray(snap.rooms)) return;
    snap.rooms.forEach(s => {
      // messages are not persisted to keep storage light
      const room = {
        ...s,
        messages: [],
        _ttl: this._opts.ttlMs,
      };
      this._rooms.set(s.id, room);
    });
  }

  _persist() {
    if (!this._opts.persist) return;
    const rooms = Array.from(this._rooms.values()).map(r => {
      const slim = {};
      this._opts.persistFields.forEach(f => { if (f in r) slim[f] = r[f]; });
      return slim;
    });
    lsSet({ savedAt: nowIso(), rooms });
  }
}

/* ------------------------------ Sanitizers ------------------------------- */
function sanitizeParticipant(p) {
  if (!p || typeof p !== "object") return null;
  const id = String(p.id || "").trim();
  if (!id) return null;
  const role = p.role ? String(p.role) : "unknown"; // controller | overlay | viewer | unknown
  const name = p.name ? String(p.name) : undefined;
  const device = p.device ? String(p.device) : undefined;
  return { id, role, name, device };
}

function sanitizeSession(s) {
  if (!s || typeof s !== "object") {
    return {
      type: null,          // cooking|cleaning|garden|animal|preservation
      status: "idle",      // idle|planned|started|paused|completed|canceled|failed
      stepId: null,
      deadlineTs: null,    // absolute
      plan: null,          // optional plan snapshot { plannedStartTs, p50, p80, p95, ... }
      notes: null,
    };
  }
  const safe = {
    type: s.type || null,
    status: s.status || "idle",
    stepId: s.stepId || null,
    deadlineTs: s.deadlineTs || null,
    plan: s.plan || null,
    notes: s.notes || null,
  };
  return safe;
}

function mergeSession(prev, partial) {
  const base = sanitizeSession(prev);
  const inc = partial && typeof partial === "object" ? partial : {};
  const next = {
    ...base,
    ...(inc.type !== undefined ? { type: inc.type } : {}),
    ...(inc.status !== undefined ? { status: inc.status } : {}),
    ...(inc.stepId !== undefined ? { stepId: inc.stepId } : {}),
    ...(inc.deadlineTs !== undefined ? { deadlineTs: inc.deadlineTs } : {}),
    ...(inc.plan !== undefined ? { plan: inc.plan } : {}),
    ...(inc.notes !== undefined ? { notes: inc.notes } : {}),
  };
  return next;
}

function normalizeEnvelope(obj) {
  if (obj && typeof obj === "object" && obj.type && obj.ts) {
    // Ensure minimal fields present
    return {
      type: obj.type,
      ts: obj.ts || nowIso(),
      source: obj.source || SRC,
      data: ("data" in obj) ? obj.data : null,
    };
  }
  // Wrap raw payload
  const type = obj && obj.type ? String(obj.type) : "room.payload";
  const data = obj && obj.data !== undefined ? obj.data : obj;
  return { type, ts: nowIso(), source: SRC, data };
}

function shouldExportSessionMutation(beforeJson, afterObj) {
  // Export on meaningful transitions that impact household state.
  // Examples: session.started → meal prep begins; session.completed → meal.executed.
  try {
    const before = JSON.parse(beforeJson || "{}");
    const after = afterObj || {};
    if (before.status !== after.status) {
      const t = (after.type || "").toLowerCase();
      const s = (after.status || "").toLowerCase();
      // Only export for domain sessions, not idle/no-type
      if (["cooking", "cleaning", "garden", "animal", "preservation"].includes(t)) {
        if (["started", "completed", "canceled", "failed"].includes(s)) return true;
      }
    }
  } catch { /* ignore */ }
  return false;
}

/* -------------------------------- Exports -------------------------------- */
const roomStore = new RoomStore();

module.exports = {
  RoomStore,
  roomStore,
  __internals: {
    nowIso,
    isMutatingType,
    sanitizeParticipant,
    sanitizeSession,
    mergeSession,
    normalizeEnvelope,
    shouldExportSessionMutation,
  },
};
