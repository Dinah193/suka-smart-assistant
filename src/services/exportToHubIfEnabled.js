// src/services/exportToHubIfEnabled.js
/* eslint-disable no-console */

/**
 * exportToHubIfEnabled — unified Hub export helper (resilient + silent on fail)
 * ----------------------------------------------------------------------------
 * How this fits:
 * - Used by SessionRunner, SessionAnalytics, and any feature wishing to export
 *   a record to the Family Fund Hub when featureFlags.familyFundMode === true.
 * - Soft-imports all dependencies; if anything is missing or offline, it
 *   quietly queues the payload for a later retry and returns { sent:false }.
 * - Emits consistent app events via eventBus:
 *     hub.export.requested   { id, kind }
 *     hub.export.queued      { id, kind, reason }
 *     hub.export.success     { id, kind }
 *     hub.export.failed      { id, kind, error }
 *   Additionally, if options.successEvent is provided (e.g., "session.exported"),
 *   that event is emitted on success to align with the Master Codegen Prompt.
 *
 * Envelope:
 * - If HubPacketFormatter is available, uses formatter.format(kind, payload).
 * - Otherwise falls back to { kind, at: ISO, payload }.
 *
 * Offline / Retry:
 * - LocalStorage-backed queue (‘ssa.hub.queue.v1’) with best-effort flush on:
 *     • module load
 *     • window 'online' event
 *     • each successful send (drain rest)
 *
 * API:
 *   exportToHubIfEnabled(payload, options?)
 *
 *   @param {object} payload - Data to export (must include a stable `id` if you want dedupe).
 *   @param {object} [options]
 *   @param {string} [options.kind="generic"] - Logical record kind (e.g., "session.analytics").
 *   @param {string} [options.source="exportToHubIfEnabled"] - Event 'source' field.
 *   @param {string} [options.successEvent] - Extra event to emit on success (e.g., "session.exported").
 *   @param {boolean} [options.queueIfUnavailable=true] - Queue when disabled/offline/missing deps.
 *   @returns {Promise<{sent:boolean, queued?:boolean, reason?:string}>}
 */

// ----------------------------- dynamic soft imports -----------------------------
async function _tryImport(paths = []) {
  for (const p of paths) {
    try {
      const mod = await import(/* @vite-ignore */ p);
      if (mod) return mod;
    } catch (_) { /* keep trying */ }
  }
  return null;
}

async function _loadEventBus() {
  const mod = await _tryImport([
    "@/services/eventBus.js",
    "../services/eventBus.js",
    "../../services/eventBus.js",
  ]);
  return (mod && mod.eventBus) || _createLocalBus();
}

async function _loadFeatureFlags() {
  const mod = await _tryImport([
    "@/services/featureFlags.js",
    "../services/featureFlags.js",
    "../../services/featureFlags.js",
  ]);
  return (mod && mod.featureFlags) || { familyFundMode: false };
}

async function _loadHubFormatter() {
  const mod = await _tryImport([
    "@/services/hub/HubPacketFormatter.js",
    "../services/hub/HubPacketFormatter.js",
    "../../services/hub/HubPacketFormatter.js",
    "@/services/HubPacketFormatter.js",
    "../services/HubPacketFormatter.js",
  ]);
  return mod || {};
}

async function _loadHubConnector() {
  const mod = await _tryImport([
    "@/services/hub/FamilyFundConnector.js",
    "../services/hub/FamilyFundConnector.js",
    "../../services/hub/FamilyFundConnector.js",
    "@/services/FamilyFundConnector.js",
    "../services/FamilyFundConnector.js",
  ]);
  return mod || {};
}

// ----------------------------- shims / utils -----------------------------------
const _iso = () => new Date().toISOString();
const _id = (x) => (x != null ? String(x) : "");
const _noop = () => {};

function _createLocalBus() {
  const listeners = {};
  return {
    on(evt, cb) {
      listeners[evt] = listeners[evt] || [];
      listeners[evt].push(cb);
      return () => (listeners[evt] = (listeners[evt] || []).filter((f) => f !== cb));
    },
    emit(evt, payload) {
      (listeners[evt] || []).forEach((cb) => {
        try { cb(payload); } catch (e) { console.warn("eventBus listener error:", e); }
      });
    },
  };
}

// ----------------------------- queue (localStorage) ----------------------------
const QUEUE_KEY = "ssa.hub.queue.v1";

function _qRead() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]"); } catch { return []; }
}
function _qWrite(items) {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(items || [])); } catch {}
}
function _qPush(item) {
  const items = _qRead();
  // de-duplicate by (kind,id) if both exist
  const key = `${item.kind}::${_id(item.payload && item.payload.id)}`;
  const idx = items.findIndex((r) => r.__key === key);
  const record = { ...item, __key: key, queuedAt: _iso() };
  if (idx >= 0) items[idx] = record; else items.push(record);
  _qWrite(items);
}
function _qShift() {
  const items = _qRead();
  const next = items.shift();
  _qWrite(items);
  return next || null;
}
function _qLen() {
  return _qRead().length;
}

// ----------------------------- runtime context ---------------------------------
const ctx = {
  ready: false,
  eventBus: _createLocalBus(),
  featureFlags: { familyFundMode: false },
  HubPacketFormatter: null,
  FamilyFundConnector: null,
  flushing: false,
};

async function _ensureCtx() {
  if (ctx.ready) return ctx;
  try { ctx.eventBus = await _loadEventBus(); } catch { ctx.eventBus = _createLocalBus(); }
  try { ctx.featureFlags = await _loadFeatureFlags(); } catch { ctx.featureFlags = { familyFundMode: false }; }
  try { ctx.HubPacketFormatter = await _loadHubFormatter(); } catch {}
  try { ctx.FamilyFundConnector = await _loadHubConnector(); } catch {}
  ctx.ready = true;
  return ctx;
}

// ----------------------------- envelope builder --------------------------------
function _buildEnvelope(kind, payload) {
  const fmt = ctx.HubPacketFormatter && (ctx.HubPacketFormatter.default || ctx.HubPacketFormatter);
  if (fmt && typeof fmt.format === "function") {
    try { return fmt.format(kind, payload); } catch {}
  }
  return { kind, at: _iso(), payload };
}

// ----------------------------- flushing logic ----------------------------------
async function _flushQueue() {
  if (ctx.flushing) return;
  ctx.flushing = true;
  try {
    // If disabled or connector missing, bail fast.
    if (!ctx.featureFlags?.familyFundMode) return;
    const conn = ctx.FamilyFundConnector && (ctx.FamilyFundConnector.default || ctx.FamilyFundConnector);
    if (!conn || typeof conn.send !== "function") return;
    if (typeof navigator !== "undefined" && "onLine" in navigator && !navigator.onLine) return;

    let safety = 50; // don’t loop forever
    while (_qLen() > 0 && safety-- > 0) {
      const item = _qShift();
      if (!item) break;
      try {
        const ok = await conn.send(_buildEnvelope(item.kind, item.payload));
        if (ok === false) throw new Error("FamilyFundConnector.send returned false");
        ctx.eventBus.emit("hub.export.success", { type: "hub.export.success", ts: _iso(), source: item.source || "exportToHubIfEnabled", data: { id: _id(item.payload?.id), kind: item.kind } });
        // Also emit custom success event if saved in queued item
        if (item.successEvent) {
          ctx.eventBus.emit(item.successEvent, { type: item.successEvent, ts: _iso(), source: item.source || "exportToHubIfEnabled", data: { id: _id(item.payload?.id), session: item.payload } });
        }
      } catch (err) {
        // Put it back at the front and stop—avoid hot loop on repeat failure
        _qWrite([item, ..._qRead()]);
        ctx.eventBus.emit("hub.export.failed", { type: "hub.export.failed", ts: _iso(), source: item.source || "exportToHubIfEnabled", data: { id: _id(item.payload?.id), kind: item.kind, error: String(err && err.message || err) } });
        break;
      }
    }
  } finally {
    ctx.flushing = false;
  }
}

// Best-effort online flush
if (typeof window !== "undefined") {
  window.addEventListener("online", () => { _ensureCtx().then(_flushQueue).catch(_noop); });
  // Also try once after a tick on module load
  setTimeout(() => { _ensureCtx().then(_flushQueue).catch(_noop); }, 50);
}

// ----------------------------- main function -----------------------------------
/**
 * @param {object} payload
 * @param {object} [options]
 * @param {string} [options.kind="generic"]
 * @param {string} [options.source="exportToHubIfEnabled"]
 * @param {string} [options.successEvent] e.g., "session.exported"
 * @param {boolean} [options.queueIfUnavailable=true]
 * @returns {Promise<{sent:boolean, queued?:boolean, reason?:string}>}
 */
export default async function exportToHubIfEnabled(payload, {
  kind = "generic",
  source = "exportToHubIfEnabled",
  successEvent,
  queueIfUnavailable = true,
} = {}) {
  await _ensureCtx();

  const id = _id(payload && payload.id);
  ctx.eventBus.emit("hub.export.requested", { type: "hub.export.requested", ts: _iso(), source, data: { id, kind } });

  // Feature flag off? Quietly queue or skip.
  if (!ctx.featureFlags?.familyFundMode) {
    if (queueIfUnavailable) {
      _qPush({ kind, payload, source, successEvent });
      ctx.eventBus.emit("hub.export.queued", { type: "hub.export.queued", ts: _iso(), source, data: { id, kind, reason: "disabled" } });
      return { sent: false, queued: true, reason: "disabled" };
    }
    return { sent: false, reason: "disabled" };
  }

  const conn = ctx.FamilyFundConnector && (ctx.FamilyFundConnector.default || ctx.FamilyFundConnector);
  if (!conn || typeof conn.send !== "function") {
    if (queueIfUnavailable) {
      _qPush({ kind, payload, source, successEvent });
      ctx.eventBus.emit("hub.export.queued", { type: "hub.export.queued", ts: _iso(), source, data: { id, kind, reason: "connector-missing" } });
      return { sent: false, queued: true, reason: "connector-missing" };
    }
    return { sent: false, reason: "connector-missing" };
  }

  if (typeof navigator !== "undefined" && "onLine" in navigator && !navigator.onLine) {
    if (queueIfUnavailable) {
      _qPush({ kind, payload, source, successEvent });
      ctx.eventBus.emit("hub.export.queued", { type: "hub.export.queued", ts: _iso(), source, data: { id, kind, reason: "offline" } });
      return { sent: false, queued: true, reason: "offline" };
    }
    return { sent: false, reason: "offline" };
  }

  // Try sending now
  try {
    const envelope = _buildEnvelope(kind, payload);
    const ok = await conn.send(envelope);
    if (ok === false) throw new Error("FamilyFundConnector.send returned false");

    // Success
    ctx.eventBus.emit("hub.export.success", { type: "hub.export.success", ts: _iso(), source, data: { id, kind } });

    // Optional extra event per Prompt (e.g., "session.exported")
    if (successEvent) {
      ctx.eventBus.emit(successEvent, { type: successEvent, ts: _iso(), source, data: { id, session: payload } });
    }

    // After a success, opportunistically drain queue
    _flushQueue().catch(_noop);

    return { sent: true };
  } catch (error) {
    // Queue on failure (silent preference)
    if (queueIfUnavailable) {
      _qPush({ kind, payload, source, successEvent });
      ctx.eventBus.emit("hub.export.queued", { type: "hub.export.queued", ts: _iso(), source, data: { id, kind, reason: String(error && error.message || error) } });
      return { sent: false, queued: true, reason: "send-failed" };
    }
    ctx.eventBus.emit("hub.export.failed", { type: "hub.export.failed", ts: _iso(), source, data: { id, kind, error: String(error && error.message || error) } });
    return { sent: false, reason: "send-failed" };
  }
}

// ----------------------------- test seam (optional) ----------------------------
/**
 * For unit tests or bootstrapping:
 * exportToHubIfEnabled.__inject({ eventBus, featureFlags, HubPacketFormatter, FamilyFundConnector })
 */
exportToHubIfEnabled.__inject = function inject({
  eventBus, featureFlags, HubPacketFormatter, FamilyFundConnector,
} = {}) {
  if (eventBus) ctx.eventBus = eventBus;
  if (featureFlags) ctx.featureFlags = featureFlags;
  if (HubPacketFormatter) ctx.HubPacketFormatter = HubPacketFormatter;
  if (FamilyFundConnector) ctx.FamilyFundConnector = FamilyFundConnector;
  ctx.ready = true;
};
