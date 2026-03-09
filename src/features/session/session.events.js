/**
 * src/features/session/session.events.js
 * -----------------------------------------------------------------------------
 * SessionEvents shim — canonical event catalog & helpers for SSA sessions.
 *
 * Pure shim (no React, no DOM, no timers). Safe to import from anywhere:
 * - SessionRunner (modal / background logic)
 * - SessionBanner / domain pages
 * - Background workers / analytics / Hub exporters
 *
 * Event envelope: { type, ts, source, data }   // ts is ISO 8601
 * -----------------------------------------------------------------------------
 */

import eventBus from "@/services/events/eventBus";

// Canonical event names used around SSA for session lifecycle & infra.
export const SESSION_EVENTS = Object.freeze({
  // UX → Runner
  OPEN_REQUEST: "session.open.request",

  // Runner lifecycle
  STARTED: "session.started",
  STEP_CHANGED: "session.step.changed",
  PAUSED: "session.paused",
  RESUMED: "session.resumed",
  COMPLETED: "session.completed",
  ABORTED: "session.aborted",

  // Side-effect / integrations
  EXPORTED: "session.exported",

  // Optional diagnostic / infra events
  CHECKPOINT_WRITTEN: "session.checkpoint.written",
  WARNING: "session.warning",
  ERROR: "session.error",
});

// Simple ISO timestamp helper.
function isoNow() {
  return new Date().toISOString();
}

// Basic validators to keep accidental emissions sane.
function isString(v) {
  return typeof v === "string" && v.length > 0;
}
function isObject(v) {
  return v !== null && typeof v === "object";
}

function looksLikeProgress(p) {
  return (
    isObject(p) &&
    typeof p.currentStepIndex === "number" &&
    typeof p.elapsedSec === "number"
  );
}

// Envelope helper: { type, ts, source, data }
export function envelope(type, source, data) {
  return { type, ts: isoNow(), source, data };
}

// Internal safe emit wrapper.
function emit(type, source, data) {
  if (!type || !source) return;
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit(envelope(type, source, data));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[session.events] emit failed", type, err);
  }
}

// -----------------------------------------------------------------------------
// Public emitters (Runner / UI / background code)
// -----------------------------------------------------------------------------

// UI (or background automation) requests the SessionRunner to open a session.
export function emitOpenRequest(sessionId, source = "UI") {
  if (!isString(sessionId)) return;
  emit(SESSION_EVENTS.OPEN_REQUEST, source, { id: sessionId });
}

// Runner signals the session has started.
export function emitSessionStarted(
  sessionId,
  domain,
  source = "SessionRunner"
) {
  if (!isString(sessionId) || !isString(domain)) return;
  emit(SESSION_EVENTS.STARTED, source, { sessionId, domain });
}

// Runner signals a step change.
export function emitStepChanged(
  sessionId,
  domain,
  nextStepIndex,
  step,
  source = "SessionRunner"
) {
  if (!isString(sessionId) || !isString(domain)) return;
  if (typeof nextStepIndex !== "number") return;

  const stepPayload = step
    ? {
        id: step.id,
        title: step.title,
        durationSec: step.durationSec,
        blockers: Array.isArray(step.blockers) ? step.blockers : [],
        metadata: isObject(step.metadata) ? step.metadata : {},
      }
    : null;

  emit(SESSION_EVENTS.STEP_CHANGED, source, {
    sessionId,
    domain,
    nextStepIndex,
    step: stepPayload,
  });
}

// Runner signals it has paused.
export function emitSessionPaused(
  sessionId,
  domain,
  reason,
  source = "SessionRunner"
) {
  if (!isString(sessionId) || !isString(domain)) return;
  emit(SESSION_EVENTS.PAUSED, source, {
    sessionId,
    domain,
    reason: reason || "unknown",
  });
}

// Runner signals it has resumed.
export function emitSessionResumed(
  sessionId,
  domain,
  source = "SessionRunner"
) {
  if (!isString(sessionId) || !isString(domain)) return;
  emit(SESSION_EVENTS.RESUMED, source, { sessionId, domain });
}

// Runner signals it has completed.
export function emitSessionCompleted(
  sessionId,
  domain,
  analytics,
  source = "SessionRunner"
) {
  if (!isString(sessionId) || !isString(domain)) return;
  const payload = isObject(analytics) ? analytics : {};
  emit(SESSION_EVENTS.COMPLETED, source, {
    sessionId,
    domain,
    analytics: payload,
  });
}

// Runner signals it has aborted.
export function emitSessionAborted(
  sessionId,
  domain,
  meta,
  source = "SessionRunner"
) {
  if (!isString(sessionId) || !isString(domain)) return;
  const extra = isObject(meta) ? meta : {};
  emit(SESSION_EVENTS.ABORTED, source, { sessionId, domain, ...extra });
}

// Runner signals Hub export succeeded.
export function emitSessionExported(sessionId, info, source = "SessionRunner") {
  if (!isString(sessionId)) return;
  const extra = isObject(info) ? info : {};
  emit(SESSION_EVENTS.EXPORTED, source, { sessionId, ...extra });
}

// Runner/Repo signals a checkpoint write (every step transition & ~10s tick).
export function emitCheckpointWritten(
  sessionId,
  progress,
  source = "SessionRunner"
) {
  if (!isString(sessionId) || !looksLikeProgress(progress)) return;
  emit(SESSION_EVENTS.CHECKPOINT_WRITTEN, source, { sessionId, progress });
}

// Non-fatal warning event for UI surfacing / logs.
export function emitWarning(sessionId, warn, source = "SessionRunner") {
  if (!isString(sessionId) || !isObject(warn) || !isString(warn.code)) return;
  emit(SESSION_EVENTS.WARNING, source, { sessionId, ...warn });
}

// Error event for telemetry/diagnostics.
export function emitError(sessionId, err, source = "SessionRunner") {
  if (!isString(sessionId) || !isObject(err) || !isString(err.code)) return;
  emit(SESSION_EVENTS.ERROR, source, { sessionId, ...err });
}

// -----------------------------------------------------------------------------
// Public subscription helpers
// -----------------------------------------------------------------------------

// Subscribe to a specific event type.
export function on(type, handler) {
  if (!type || typeof handler !== "function") return;
  if (!eventBus || typeof eventBus.on !== "function") return;
  eventBus.on(type, handler);
}

// Unsubscribe from a specific event type.
export function off(type, handler) {
  if (!type || typeof handler !== "function") return;
  if (!eventBus || typeof eventBus.off !== "function") return;
  eventBus.off(type, handler);
}

// Subscribe to many event types with a single handler.
export function onMany(types, handler) {
  if (!Array.isArray(types) || typeof handler !== "function") {
    return () => {};
  }
  if (
    !eventBus ||
    typeof eventBus.on !== "function" ||
    typeof eventBus.off !== "function"
  ) {
    return () => {};
  }
  types.forEach((t) => eventBus.on(t, handler));
  return () => types.forEach((t) => eventBus.off(t, handler));
}

// Subscribe once to an event type then auto-unsubscribe.
export function once(type, handler) {
  if (!type || typeof handler !== "function") return;
  if (
    !eventBus ||
    typeof eventBus.on !== "function" ||
    typeof eventBus.off !== "function"
  ) {
    return;
  }
  const wrapper = (evt) => {
    try {
      handler(evt);
    } finally {
      eventBus.off(type, wrapper);
    }
  };
  eventBus.on(type, wrapper);
}

// -----------------------------------------------------------------------------
// Convenience: namespaced re-export for consumers that prefer a single import
// -----------------------------------------------------------------------------
const SessionEvents = {
  SESSION_EVENTS,
  envelope,
  emitOpenRequest,
  emitSessionStarted,
  emitStepChanged,
  emitSessionPaused,
  emitSessionResumed,
  emitSessionCompleted,
  emitSessionAborted,
  emitSessionExported,
  emitCheckpointWritten,
  emitWarning,
  emitError,
  on,
  off,
  onMany,
  once,
};

export default SessionEvents;
