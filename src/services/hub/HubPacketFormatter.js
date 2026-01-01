// C:\Users\larho\suka-smart-assistant\src\services\hub\HubPacketFormatter.js
// -----------------------------------------------------------------------------
// PURPOSE (Shim-friendly)
// -----------------------------------------------------------------------------
// This module formats SSA events + session objects into Hub-ready packets.
//
// ✅ Pure, side-effect free (safe to call from Web Workers, background tabs).
// ✅ Does NOT know about React, Dexie, DOM, or FamilyFundConnector.
// ✅ SessionRunner shims call this when familyFundMode === true, then pass the
//    result to FamilyFundConnector for actual send.
//
// Focus here is export of *session deltas* based on the standard Session
// contract used by SSA.
//
// Typical usage from a SessionRunner shim:
//
//   import { formatSessionDelta } from "@/services/hub/HubPacketFormatter";
//   import { FamilyFundConnector } from "@/services/hub/FamilyFundConnector";
//   import { familyFundMode } from "@/services/featureFlags";
//
//   if (familyFundMode) {
//     const packet = formatSessionDelta({
//       eventEnvelope,       // canonical { type, ts, source, data }
//       previousSession,     // snapshot BEFORE change (or null)
//       currentSession,      // snapshot AFTER change
//       context: {
//         householdId,
//         userId,
//         deviceId,
//         appVersion,
//       },
//     });
//     if (packet) {
//       FamilyFundConnector.queue(packet); // or .send(packet)
//     }
//   }
//
// The Hub receives a normalized payload:
//
//   {
//     kind: "session.delta",
//     version: "1.0.0",
//     ts: "<ISO>",
//     source: "sessionRunner" | "<event source>",
//     eventType: "session/step.changed",
//     session: { ...minimal session info... },
//     delta: { ...changes since previous snapshot... },
//     context: { householdId, userId, deviceId, appVersion, ... }
//   }
//
// -----------------------------------------------------------------------------

/**
 * @typedef {Object} SessionMetadata
 * @property {number} [tempTargetF]
 * @property {"color"|"texture"|"probeTemp"|"timer"|"smell"|string} [donenessCue]
 * @property {string} [cueNotes]
 */

/**
 * @typedef {Object} SessionStep
 * @property {string} id
 * @property {string} title
 * @property {string} [desc]
 * @property {number} [durationSec]
 * @property {string[]} [blockers]
 * @property {SessionMetadata} [metadata]
 */

/**
 * @typedef {Object} SessionProgress
 * @property {number} currentStepIndex
 * @property {number} elapsedSec
 * @property {string|null} [startedAt]
 * @property {string|null} [pausedAt]
 */

/**
 * @typedef {Object} SessionAnalytics
 * @property {string[]} [skippedSteps]
 * @property {Array<Object>} [adjustments]
 */

/**
 * @typedef {Object} SessionObject
 * @property {string} id
 * @property {"cooking"|"cleaning"|"garden"|"animals"|"preservation"|"storehouse"|string} domain
 * @property {string} title
 * @property {{ type:string, refId:(string|null) }} [source]
 * @property {SessionStep[]} [steps]
 * @property {Object} [prefs]
 * @property {"pending"|"running"|"paused"|"completed"|"aborted"|string} status
 * @property {SessionProgress} progress
 * @property {SessionAnalytics} [analytics]
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * Canonical SSA event envelope (from eventBus).
 * @typedef {Object} EventEnvelope
 * @property {string} type      // normalized "a/b"
 * @property {string} ts        // ISO-8601 timestamp
 * @property {string} source    // logical source ("sessionRunner", "cookingEngine", etc.)
 * @property {any}    data      // arbitrary payload
 */

/**
 * Context fields for Hub routing / analytics.
 * All optional, but highly recommended when available.
 * @typedef {Object} HubContext
 * @property {string} [householdId]
 * @property {string} [userId]
 * @property {string} [deviceId]
 * @property {string} [appVersion]
 * @property {string} [tier]          // "ssa-only" | "hub" | etc.
 * @property {string} [locale]
 */

/**
 * @typedef {Object} SessionDeltaPacket
 * @property {"session.delta"} kind
 * @property {string} version
 * @property {string} ts
 * @property {string} source
 * @property {string} eventType
 * @property {SessionObjectSummary} session
 * @property {SessionDeltaDetails} delta
 * @property {HubContext} [context]
 */

/**
 * @typedef {Object} SessionObjectSummary
 * @property {string} id
 * @property {string} domain
 * @property {string} title
 * @property {string} status
 * @property {SessionProgress} progress
 * @property {{ type:string, refId:(string|null) }|null} source
 * @property {{ id:string, title:string, index:number }|null} currentStep
 */

/**
 * @typedef {Object} SessionDeltaDetails
 * @property {string[]} changedFields
 * @property {{ from:string|null, to:string|null }} status
 * @property {{ from:number|null, to:number|null }} stepIndex
 * @property {number|null} elapsedDeltaSec
 * @property {string[]} [newlySkippedSteps]
 * @property {number} [adjustmentsAdded]
 * @property {Object<string, any>} [extra]
 */

const HUB_SCHEMA_VERSION = "1.0.0";

/**
 * Main entry: format a Hub-ready packet for a session delta.
 *
 * Returns `null` if there is not enough information to build a meaningful delta.
 *
 * @param {Object} params
 * @param {EventEnvelope} params.eventEnvelope   - Canonical SSA event (session.started / step.changed / etc.)
 * @param {SessionObject|null} params.previousSession - Snapshot BEFORE change (or null for first export)
 * @param {SessionObject} params.currentSession  - Snapshot AFTER change
 * @param {HubContext} [params.context]          - Optional Hub routing context
 * @returns {SessionDeltaPacket|null}
 */
export function formatSessionDelta({
  eventEnvelope,
  previousSession,
  currentSession,
  context,
}) {
  if (!eventEnvelope || !currentSession) return null;

  const safeCurr = sanitizeSession(currentSession);
  const safePrev = previousSession ? sanitizeSession(previousSession) : null;

  // If sanitize fails, bail out safely
  if (!safeCurr) return null;

  const ts = isIso(eventEnvelope.ts)
    ? eventEnvelope.ts
    : new Date().toISOString();

  const source = eventEnvelope.source || "sessionRunner.shim";
  const eventType = normalizeEventType(eventEnvelope.type);

  const summary = buildSessionSummary(safeCurr);
  const delta = computeSessionDelta(safePrev, safeCurr, eventType);

  // If no meaningful changes (and not a status or step event), you can choose
  // to return null to avoid noisy Hub traffic. Here we still export but the
  // caller can add an extra guard if desired.
  return {
    kind: "session.delta",
    version: HUB_SCHEMA_VERSION,
    ts,
    source,
    eventType,
    session: summary,
    delta,
    context: context ? { ...context } : undefined,
  };
}

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

/**
 * Minimal guard to ensure required session fields exist.
 * @param {any} session
 * @returns {SessionObject|null}
 */
function sanitizeSession(session) {
  if (!session || typeof session !== "object") return null;
  if (!session.id || !session.domain || !session.title) return null;
  if (!session.progress || typeof session.progress.currentStepIndex !== "number") {
    return null;
  }
  // Shallow clone to avoid accidental mutation by caller
  return {
    ...session,
    source: session.source || null,
    steps: Array.isArray(session.steps) ? session.steps.slice() : [],
    analytics: session.analytics || { skippedSteps: [], adjustments: [] },
    progress: {
      currentStepIndex: Number(session.progress.currentStepIndex || 0),
      elapsedSec: Number(session.progress.elapsedSec || 0),
      startedAt: session.progress.startedAt || null,
      pausedAt: session.progress.pausedAt || null,
    },
  };
}

/**
 * Normalize event type to a hub-friendly string.
 * @param {string} type
 * @returns {string}
 */
function normalizeEventType(type) {
  if (!type) return "session/unknown";
  return String(type)
    .replace(/\s+/g, "")
    .replace(/\.+/g, "/")
    .replace(/\/{2,}/g, "/");
}

/**
 * Build the summary block the Hub cares about for routing and dashboards.
 * @param {SessionObject} session
 * @returns {SessionObjectSummary}
 */
function buildSessionSummary(session) {
  const steps = Array.isArray(session.steps) ? session.steps : [];
  const idx = clampIndex(session.progress.currentStepIndex, steps.length);
  const step = idx != null ? steps[idx] : null;

  return {
    id: session.id,
    domain: String(session.domain || "unknown"),
    title: String(session.title || ""),
    status: String(session.status || "pending"),
    progress: {
      currentStepIndex: idx ?? 0,
      elapsedSec: Number(session.progress.elapsedSec || 0),
      startedAt: session.progress.startedAt || null,
      pausedAt: session.progress.pausedAt || null,
    },
    source: session.source
      ? {
          type: String(session.source.type || "manual"),
          refId:
            typeof session.source.refId === "string"
              ? session.source.refId
              : null,
        }
      : null,
    currentStep: step
      ? {
          id: String(step.id || `step-${idx}`),
          title: String(step.title || `Step ${idx + 1}`),
          index: idx,
        }
      : null,
  };
}

/**
 * Compute the delta between two session snapshots.
 * @param {SessionObject|null} prev
 * @param {SessionObject} curr
 * @param {string} eventType
 * @returns {SessionDeltaDetails}
 */
function computeSessionDelta(prev, curr, eventType) {
  /** @type {string[]} */
  const changedFields = [];

  const prevStatus = prev ? String(prev.status || "") : null;
  const currStatus = String(curr.status || "");

  if (!prev || prevStatus !== currStatus) {
    changedFields.push("status");
  }

  const prevStepIdx = prev ? safeIndex(prev.progress.currentStepIndex) : null;
  const currStepIdx = safeIndex(curr.progress.currentStepIndex);

  if (prevStepIdx !== currStepIdx) {
    changedFields.push("progress.currentStepIndex");
  }

  const prevElapsed = prev ? Number(prev.progress.elapsedSec || 0) : null;
  const currElapsed = Number(curr.progress.elapsedSec || 0);
  const elapsedDelta =
    prevElapsed == null ? null : clampNumber(currElapsed - prevElapsed);

  if (elapsedDelta !== null && elapsedDelta !== 0) {
    changedFields.push("progress.elapsedSec");
  }

  const prevSkipped =
    (prev && Array.isArray(prev.analytics?.skippedSteps)
      ? prev.analytics.skippedSteps
      : []) || [];
  const currSkipped =
    (Array.isArray(curr.analytics?.skippedSteps)
      ? curr.analytics.skippedSteps
      : []) || [];
  const newlySkipped = currSkipped.filter((id) => !prevSkipped.includes(id));
  if (newlySkipped.length) {
    changedFields.push("analytics.skippedSteps");
  }

  const prevAdjCount = prev
    ? Array.isArray(prev.analytics?.adjustments)
      ? prev.analytics.adjustments.length
      : 0
    : 0;
  const currAdjCount = Array.isArray(curr.analytics?.adjustments)
    ? curr.analytics.adjustments.length
    : 0;
  const addedAdjustments =
    currAdjCount > prevAdjCount ? currAdjCount - prevAdjCount : 0;
  if (addedAdjustments > 0) {
    changedFields.push("analytics.adjustments");
  }

  return {
    changedFields,
    status: {
      from: prevStatus,
      to: currStatus,
    },
    stepIndex: {
      from: prevStepIdx,
      to: currStepIdx,
    },
    elapsedDeltaSec: elapsedDelta,
    newlySkippedSteps: newlySkipped.length ? newlySkipped : undefined,
    adjustmentsAdded: addedAdjustments || undefined,
    extra: {
      // A bit of semantic sugar the Hub can use for dashboards:
      isTerminal: currStatus === "completed" || currStatus === "aborted",
      isStepChange: prevStepIdx !== currStepIdx,
      eventType,
    },
  };
}

// -----------------------------------------------------------------------------
// Tiny primitives
// -----------------------------------------------------------------------------

/**
 * @param {any} v
 * @returns {boolean}
 */
function isIso(v) {
  if (!v || typeof v !== "string") return false;
  return !Number.isNaN(Date.parse(v));
}

/**
 * Clamp index to [0, length-1] or return null when list is empty.
 * @param {number} idx
 * @param {number} length
 * @returns {number|null}
 */
function clampIndex(idx, length) {
  if (!Number.isFinite(idx) || length <= 0) return null;
  const n = Math.max(0, Math.min(length - 1, Math.floor(idx)));
  return Number.isFinite(n) ? n : null;
}

/**
 * Safe integer index, or null when invalid.
 * @param {any} v
 * @returns {number|null}
 */
function safeIndex(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

/**
 * Clamp numeric value into a sensible range (for deltas).
 * @param {any} v
 * @returns {number|null}
 */
function clampNumber(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n > 86400 * 7) return 86400 * 7; // 7-day cap for safety
  if (n < -86400 * 7) return -86400 * 7;
  return n;
}

// -----------------------------------------------------------------------------
// Optional generic helper for other Hub exports (not limited to sessions)
// -----------------------------------------------------------------------------

/**
 * Generic builder for arbitrary Hub packets.
 * This keeps envelope shape consistent if you want to export other domains.
 *
 * @param {string} kind            - e.g. "import.event", "inventory.delta"
 * @param {EventEnvelope} event    - Canonical SSA event
 * @param {any} payload            - Hub-specific payload body
 * @param {HubContext} [context]   - Optional context
 * @returns {Object}
 */
export function buildHubPacket(kind, event, payload, context) {
  const ts = isIso(event?.ts) ? event.ts : new Date().toISOString();
  return {
    kind,
    version: HUB_SCHEMA_VERSION,
    ts,
    source: event?.source || "ssa",
    eventType: normalizeEventType(event?.type || kind),
    data: payload || {},
    context: context ? { ...context } : undefined,
  };
}

export default {
  formatSessionDelta,
  buildHubPacket,
};
