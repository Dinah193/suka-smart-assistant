// C:\Users\larho\suka-smart-assistant\src\services\session\telemetry.js
// Session Telemetry — collection, aggregation, and analytics events
// -----------------------------------------------------------------------------
// ROLE IN PIPELINE
// imports → intelligence → automation → (optional) hub export
//                               └─ this module observes session lifecycle
//                                  (draft → approved → scheduled → executed → done)
//                                  and emits/records telemetry for analytics.
//
// What this module does
// ---------------------
// • Listens on eventBus for session & domain signals (cooking/cleaning/garden/…)
// • Records lightweight, structured metrics in-memory (and optional persistence)
// • Emits analytics events with canonical payloads { type, ts, source, data }
// • Exposes query helpers (getTimeline, getSummary, getSessionMetrics)
// • Periodically flushes snapshots to storage and (optionally) to the Hub when
//   familyFundMode=true (fail-silent).
//
// Design notes
// ------------
// • Zero required external deps; gracefully degrades if dataGateway/hub are absent.
// • Minimal overhead: constant-time updates, bounded ring buffers, debounced flush.
// • Forward-looking: domain-agnostic tags & fields; custom metrics hook.
// -----------------------------------------------------------------------------

/* --------------------------------- Imports --------------------------------- */
let eventBus, Events;
try {
  const eb = require("@/services/events/eventBus.js");
  eventBus = eb; // exports named functions; we call eb.emit/on/emitDebounced
  Events = eb.Events || {};
} catch {
  try {
    const eb = require("@/services/events/eventBus.js");
    eventBus = eb;
    Events = eb.Events || {};
  } catch {
    eventBus = { emit: () => {}, on: () => () => {}, emitDebounced: () => {} };
    Events = {};
  }
}

let dataGateway = null;
try {
  dataGateway = require("@/services/dataGateway.js");
} catch {
  // optional persistence
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
} catch {
  /* optional */
}

/* --------------------------------- State ----------------------------------- */
const SOURCE = "telemetry.session";

const RING_MAX = 400; // recent events for timeline
const _timeline = []; // [{t, type, sessionId, domain, ...}]
const _bySession = new Map(); // sessionId -> SessionMetric (see typedef)
const _counters = {
  drafts: 0,
  approvals: 0,
  scheduled: 0,
  executed: 0,
  completed: 0,
  discarded: 0,
  errors: 0,
};

let _initialized = false;
let _flushTimer = null;
const FLUSH_DEBOUNCE_MS = 1500;
const SNAPSHOT_KEY = "analytics/sessionTelemetry"; // suggested key for storage

/* ------------------------------ Public API --------------------------------- */
/**
 * Initialize telemetry listeners and periodic flushing.
 * Safe to call multiple times; only the first call wires listeners.
 */
export function initSessionTelemetry() {
  if (_initialized) return noopUnsub;
  _initialized = true;

  const unsubs = [];

  // Core session pipeline events (from eventBus.Events registry)
  unsubs.push(
    eventBus.on(Events.SESSION_DRAFT_READY || "session/draftReady", onDraft, {
      priority: -1,
    })
  );
  unsubs.push(
    eventBus.on(Events.SESSION_APPROVED || "session/approved", onApproved, {
      priority: -1,
    })
  );
  unsubs.push(
    eventBus.on(Events.SESSION_DISCARDED || "session/discarded", onDiscarded, {
      priority: -1,
    })
  );
  unsubs.push(
    eventBus.on(Events.SESSION_ERROR || "session/error", onError, {
      priority: -1,
    })
  );

  // Household-calendar glue (writer emits schedule/saved & schedule/deleted)
  unsubs.push(
    eventBus.on(Events.SCHEDULE_SAVED || "schedule/saved", onScheduled, {
      priority: -1,
    })
  );
  unsubs.push(
    eventBus.on(Events.SCHEDULE_DELETED || "schedule/deleted", onUnschedule, {
      priority: -1,
    })
  );

  // Domain completions (used to mark "executed/completed")
  unsubs.push(
    eventBus.on(
      Events.PRESERVATION_COMPLETED || "preservation/completed",
      onDomainCompleted,
      { priority: -1 }
    )
  );
  unsubs.push(
    eventBus.on(
      Events.GARDEN_HARVEST_LOGGED || "garden/harvestLogged",
      onGardenLogged,
      { priority: -1 }
    )
  );
  // Cooking "executed" signal is not standardized; accept meal.executed (from prompt)
  unsubs.push(eventBus.on("meal/executed", onMealExecuted, { priority: -1 }));

  // Emit a sticky snapshot for analytics panels to quickly render
  emitAnalyticsSnapshot("init");

  // Return unsubscribe for tests/env reset
  return () =>
    unsubs.forEach((u) => {
      try {
        u();
      } catch {}
    });
}

/**
 * Custom metric hook (for engines or UI).
 * @param {string} sessionId
 * @param {string} key
 * @param {number} delta
 */
export function recordCustom(sessionId, key, delta = 1) {
  if (!sessionId || !key) return;
  const sm = ensureSessionMetric(sessionId);
  sm.custom[key] = (sm.custom[key] || 0) + (Number.isFinite(delta) ? delta : 0);
  addTimeline("custom", { sessionId, key, delta });
  scheduleFlush();
}

/**
 * Query recent timeline (most recent first).
 * @param {number} limit
 */
export function getTimeline(limit = 100) {
  return _timeline.slice(-limit).reverse();
}

/**
 * Query a summary snapshot (counters + session aggregates).
 */
export function getSummary() {
  const byDomain = {};
  for (const sm of _bySession.values()) {
    const d = sm.domain || "general";
    byDomain[d] = byDomain[d] || {
      drafts: 0,
      approvals: 0,
      scheduled: 0,
      executed: 0,
      completed: 0,
      errors: 0,
    };
    for (const k of Object.keys(byDomain[d])) byDomain[d][k] += sm[k] ? 1 : 0;
  }
  return {
    ts: new Date().toISOString(),
    totals: { ..._counters },
    activeSessions: _bySession.size,
    byDomain,
  };
}

/**
 * Get detailed metrics for a single session.
 */
export function getSessionMetrics(sessionId) {
  return clone(ensureSessionMetric(sessionId));
}

/* ----------------------------- Event Handlers ------------------------------ */
function onDraft({ data }) {
  const s = pickSession(data?.draft || data?.session || data);
  if (!s.id) return;
  const sm = ensureSessionMetric(s.id, s.domain);
  sm.draftsAt = now();
  sm.domain = s.domain || sm.domain;
  sm.title = s.title || sm.title;
  inc("drafts");
  sm.drafts = true;
  addTimeline("draft", { sessionId: s.id, domain: sm.domain, title: sm.title });
  emitAnalyticsPulse("draft", s.id, sm.domain);
  scheduleFlush();
}

function onApproved({ data }) {
  const s = pickSession(data?.session || data);
  if (!s.id) return;
  const sm = ensureSessionMetric(s.id, s.domain);
  sm.approvalsAt = now();
  sm.domain = s.domain || sm.domain;
  sm.title = s.title || sm.title;
  inc("approvals");
  sm.approvals = true;
  addTimeline("approved", { sessionId: s.id, domain: sm.domain });
  emitAnalyticsPulse("approved", s.id, sm.domain);
  scheduleFlush();
}

function onScheduled({ data }) {
  const sessionId = data?.sessionId || data?.session?.id;
  if (!sessionId) return;
  const sm = ensureSessionMetric(sessionId);
  sm.scheduledAt = now();
  sm.scheduled = true;
  sm.holdsCount = Array.isArray(data?.holds)
    ? data.holds.length
    : sm.holdsCount || 0;
  addTimeline("scheduled", { sessionId, holds: sm.holdsCount });
  emitAnalyticsPulse("scheduled", sessionId, sm.domain);
  scheduleFlush();
}

function onUnschedule({ data }) {
  const sessionId = data?.sessionId;
  if (!sessionId) return;
  const sm = ensureSessionMetric(sessionId);
  sm.scheduled = false;
  addTimeline("unscheduled", { sessionId });
  scheduleFlush();
}

function onDiscarded({ data }) {
  const sessionId = data?.sessionId || data?.id || data?.session?.id;
  if (!sessionId) return;
  const sm = ensureSessionMetric(sessionId);
  sm.discardedAt = now();
  sm.discarded = true;
  inc("discarded");
  addTimeline("discarded", { sessionId });
  emitAnalyticsPulse("discarded", sessionId, sm.domain);
  scheduleFlush();
}

function onError({ data }) {
  const sessionId = data?.sessionId || data?.input?.id;
  const domain = data?.domain;
  if (!sessionId && !domain) return;
  const sm = ensureSessionMetric(sessionId || genId(), domain);
  sm.errors = (sm.errors || 0) + 1;
  inc("errors");
  sm.lastErrorAt = now();
  addTimeline("error", {
    sessionId: sm.id,
    domain: sm.domain,
    error: String(data?.error || "unknown"),
  });
  emitAnalyticsPulse("error", sm.id, sm.domain);
  scheduleFlush();
}

function onMealExecuted({ data }) {
  // mark execution for cooking sessions if we can match sessionId
  const sessionId = data?.sessionId || data?.meta?.sessionId;
  const sm = ensureSessionMetric(sessionId || genId(), "cooking");
  sm.executedAt = now();
  sm.executed = true;
  inc("executed");
  addTimeline("executed", { sessionId: sm.id, domain: "cooking" });
  emitAnalyticsPulse("executed", sm.id, sm.domain);
  scheduleFlush();
}

function onGardenLogged({ data }) {
  const sessionId = data?.sessionId || data?.meta?.sessionId;
  const sm = ensureSessionMetric(sessionId || genId(), "garden");
  sm.completedAt = now();
  sm.completed = true;
  inc("completed");
  addTimeline("completed", { sessionId: sm.id, domain: "garden" });
  emitAnalyticsPulse("completed", sm.id, sm.domain);
  scheduleFlush();
}

function onDomainCompleted({ data }) {
  const sessionId = data?.sessionId || data?.meta?.sessionId;
  const sm = ensureSessionMetric(sessionId || genId(), "preservation");
  sm.completedAt = now();
  sm.completed = true;
  inc("completed");
  addTimeline("completed", { sessionId: sm.id, domain: "preservation" });
  emitAnalyticsPulse("completed", sm.id, sm.domain);
  scheduleFlush();
}

/* ------------------------------- Persistence ------------------------------- */
function scheduleFlush() {
  if (_flushTimer) clearTimeout(_flushTimer);
  _flushTimer = setTimeout(flushSnapshot, FLUSH_DEBOUNCE_MS);
}

async function flushSnapshot() {
  _flushTimer = null;
  const snapshot = {
    ts: new Date().toISOString(),
    counters: { ..._counters },
    sessions: Array.from(_bySession.values()).map(shallowCloneForPersist),
    timeline: _timeline.slice(-100), // cap to keep payloads small
  };
  // Persist to local data store if present
  try {
    if (dataGateway?.save) {
      await dataGateway.save(SNAPSHOT_KEY, snapshot);
    } else if (dataGateway?.put) {
      await dataGateway.put(SNAPSHOT_KEY, snapshot);
    }
  } catch {
    /* storage is optional */
  }

  // Emit an analytics snapshot event for UI subscribers
  emitAnalyticsSnapshot("flush", snapshot);

  // Optional Hub mirror (NOT household data, but allowed in familyFundMode)
  try {
    if (
      featureFlags?.familyFundMode &&
      HubPacketFormatter &&
      FamilyFundConnector
    ) {
      const payload = {
        type: "analytics/sessionSnapshot",
        ts: snapshot.ts,
        source: SOURCE,
        data: snapshot,
      };
      const pkt = HubPacketFormatter.format(payload);
      await FamilyFundConnector.send(pkt);
    }
  } catch {
    /* fail-silent */
  }
}

/* ------------------------------ Emit helpers ------------------------------- */
function emitAnalyticsPulse(kind, sessionId, domain) {
  eventBus.emit(
    "analytics/sessionTelemetry.pulse",
    {
      kind,
      sessionId,
      domain,
    },
    { source: SOURCE }
  );
}

function emitAnalyticsSnapshot(reason, provided) {
  const snap = provided || getSummary();
  eventBus.emit(
    "analytics/sessionTelemetry.snapshot",
    {
      reason,
      summary: snap,
    },
    { source: SOURCE, sticky: true }
  );
}

/* -------------------------------- Utilities -------------------------------- */
/**
 * @typedef {Object} SessionMetric
 * @property {string} id
 * @property {string} [domain]
 * @property {string} [title]
 * @property {boolean} [drafts]
 * @property {boolean} [approvals]
 * @property {boolean} [scheduled]
 * @property {boolean} [executed]
 * @property {boolean} [completed]
 * @property {boolean} [discarded]
 * @property {number} [errors]
 * @property {string} [draftsAt]
 * @property {string} [approvalsAt]
 * @property {string} [scheduledAt]
 * @property {string} [executedAt]
 * @property {string} [completedAt]
 * @property {string} [lastErrorAt]
 * @property {number} [holdsCount]
 * @property {Record<string,number>} custom
 */

function ensureSessionMetric(id, domain) {
  const key = String(id || genId());
  let sm = _bySession.get(key);
  if (!sm) {
    sm = { id: key, domain, custom: {} };
    _bySession.set(key, sm);
  } else if (domain && !sm.domain) {
    sm.domain = domain;
  }
  return sm;
}

function pickSession(x = {}) {
  // Adapters use unified draft shape { id, domain, title, window, durationMin, ... }
  // Accept looser shapes too.
  return {
    id: String(x?.id || ""),
    domain: String(x?.domain || x?.meta?.domain || ""),
    title: String(x?.title || x?.meta?.title || ""),
  };
}

function addTimeline(type, extra = {}) {
  _timeline.push({
    t: Date.now(),
    ts: new Date().toISOString(),
    type,
    ...extra,
  });
  if (_timeline.length > RING_MAX)
    _timeline.splice(0, _timeline.length - RING_MAX);
}

function inc(name) {
  _counters[name] = (_counters[name] || 0) + 1;
}

function shallowCloneForPersist(sm) {
  // Trim volatile fields and large maps
  const { custom, ...rest } = sm;
  // Keep custom metrics but prune massive keys if any
  const smallCustom = {};
  for (const [k, v] of Object.entries(custom || {})) {
    if (k.length <= 80) smallCustom[k] = v;
  }
  return { ...rest, custom: smallCustom };
}

/* ----------------------------- Hub export hook ----------------------------- */
// NOTE: Not used here for household data changes (inventory/storehouse/sessions),
// but snapshots may be mirrored if familyFundMode=true via flushSnapshot().

/* --------------------------------- Small utils ----------------------------- */
function now() {
  return new Date().toISOString();
}
function clone(v) {
  return JSON.parse(JSON.stringify(v));
}
function genId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
function noopUnsub() {}

/* --------------------------------- Exports --------------------------------- */
export default {
  initSessionTelemetry,
  getTimeline,
  getSummary,
  getSessionMetrics,
  recordCustom,
};
