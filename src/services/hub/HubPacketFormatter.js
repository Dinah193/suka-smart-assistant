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
//   import { familyFundMode } from "@/config/featureFlags";
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
// UPDATE NOTE (Build fix)
// -----------------------------------------------------------------------------
// Your HouseholdOrchestrator imports:
//   import { HubPacketFormatter } from "@/services/hub/HubPacketFormatter";
//
// This file previously did NOT export a named "HubPacketFormatter" symbol.
// To keep all existing call sites working, we now export BOTH:
//   - named: HubPacketFormatter (a small facade/class)
//   - named: formatSessionDelta, buildHubPacket (existing functions)
//   - named: formatForHub (compat helper used by calculator shims)
//   - default: an object facade (backward compatible)
//
// -----------------------------------------------------------------------------
// ✅ UPDATE NOTE (Domain build fixes)
// -----------------------------------------------------------------------------
// Some domain engines import these compat functions:
//   - formatAnimalSessionForHub
//   - formatCleaningSessionForHub
//   - formatGardenSessionForHub
//   - formatMealSessionForHub
//   - formatStorehouseSignalForHub
//   - formatInventoryRuleForHub
//   - formatInventoryUpdateForHub
//   - formatMealAnalyticsForHub
//
// We provide thin, deterministic wrappers.
// Sessions produce either:
//   - "session.delta" packet (preferred) when eventEnvelope + prev/curr provided
//   - "session.snapshot" packet when only a session object is provided
//
// Inventory rules produce either:
//   - "inventory.rule" packet (preferred) when eventEnvelope present
//   - "inventory.rule.snapshot" packet when only a rule object is provided
//
// Inventory updates produce either:
//   - "inventory.update" packet (preferred) when eventEnvelope present
//   - "inventory.update.snapshot" packet when only an update object is provided
//
// Meal analytics produce either:
//   - "meal.analytics" packet (preferred) when eventEnvelope present
//   - "meal.analytics.snapshot" packet when only an analytics object is provided
//
// Storehouse signals produce either:
//   - "storehouse.signal" packet (preferred) when eventEnvelope present
//   - "storehouse.signal.snapshot" packet when only a signal is provided
//
// Remains side-effect free and browser-safe.
// -----------------------------------------------------------------------------
//
// ✅ UPDATE NOTE (CleaningPlanner build fix)
// -----------------------------------------------------------------------------
// CleaningPlanner.jsx imports:
//   import { formatCleaningPlanForHub } from "@/services/hub/HubPacketFormatter";
//
// We add a plan-oriented formatter that emits:
//   - "cleaning.plan" when eventEnvelope present (preferred)
//   - "cleaning.plan.snapshot" when only a plan is provided
// -----------------------------------------------------------------------------
//
// ✅ UPDATE NOTE (GardenPlanner build fix)
// -----------------------------------------------------------------------------
// GardenPlanner.jsx imports:
//   import { formatGardenPlanForHub } from "@/services/hub/HubPacketFormatter";
//
// We add a plan-oriented formatter that emits:
//   - "garden.plan" when eventEnvelope present (preferred)
//   - "garden.plan.snapshot" when only a plan is provided
// -----------------------------------------------------------------------------
//
// ✅ UPDATE NOTE (Meals build fix)
// -----------------------------------------------------------------------------
// MealPlanner.jsx imports:
//   import { formatMealPlanForHub } from "@/services/hub/HubPacketFormatter";
//
// We add a plan-oriented formatter that emits:
//   - "meals.plan" when eventEnvelope present (preferred)
//   - "meals.plan.snapshot" when only a plan is provided
// -----------------------------------------------------------------------------
//
// ✅ UPDATE NOTE (StorehousePlanner build fix)
// -----------------------------------------------------------------------------
// StorehousePlanner.jsx imports:
//   import { formatStorehousePlanForHub } from "@/services/hub/HubPacketFormatter";
//
// We add a plan-oriented formatter that emits:
//   - "storehouse.plan" when eventEnvelope present (preferred)
//   - "storehouse.plan.snapshot" when only a plan is provided
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
  if (
    !session.progress ||
    typeof session.progress.currentStepIndex !== "number"
  ) {
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
    .replace(/\/{2,}/g, "/")
    .replace(/^\/|\/$/g, "");
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

/**
 * ---------------------------------------------------------------------------
 * COMPAT EXPORT: formatForHub
 * ---------------------------------------------------------------------------
 * Some calculator shims import:
 *   import { formatForHub } from "@/services/hub/HubPacketFormatter";
 *
 * This helper is intentionally flexible:
 *  1) formatForHub({ kind, nodeId, payload, context?, ts?, source? })
 *  2) formatForHub(kind, eventEnvelope, payload, context?)
 *
 * It returns a Hub packet using the same envelope shape as buildHubPacket().
 *
 * @param  {...any} args
 * @returns {Object|null}
 */
export function formatForHub(...args) {
  // Signature A: single object
  if (args.length === 1 && args[0] && typeof args[0] === "object") {
    const {
      kind,
      nodeId,
      payload,
      context,
      ts,
      source,
      eventType,
      eventEnvelope,
    } = args[0];

    const ev = eventEnvelope || {
      type: eventType || (kind ? `hub/${kind}` : "hub/packet"),
      ts: isIso(ts) ? ts : new Date().toISOString(),
      source: source || "ssa.calculator",
      data: { nodeId: nodeId || null },
    };

    const packetKind = kind || "hub.packet";
    const body = {
      nodeId: nodeId || null,
      ...(payload && typeof payload === "object" ? payload : { payload }),
    };

    return buildHubPacket(packetKind, ev, body, context);
  }

  // Signature B: (kind, eventEnvelope, payload, context)
  const kind = args[0];
  const eventEnvelope = args[1];
  const payload = args[2];
  const context = args[3];

  if (!kind || !eventEnvelope) return null;

  const ev = {
    type: eventEnvelope.type || `hub/${kind}`,
    ts: isIso(eventEnvelope.ts) ? eventEnvelope.ts : new Date().toISOString(),
    source: eventEnvelope.source || "ssa",
    data: eventEnvelope.data,
  };

  return buildHubPacket(kind, ev, payload, context);
}

// -----------------------------------------------------------------------------
// ✅ Domain compat exporters (Animals / Cleaning / Garden / Meals)
// -----------------------------------------------------------------------------

/**
 * Internal helper for domain session export compatibility.
 * @param {string} domain
 * @param {string} defaultSource
 * @param  {...any} args
 * @returns {Object|null}
 */
function formatDomainSessionCompat(domain, defaultSource, ...args) {
  // Style A: object arg
  if (args.length === 1 && args[0] && typeof args[0] === "object") {
    const { eventEnvelope, previousSession, currentSession, context } = args[0];

    if (eventEnvelope && currentSession) {
      // Ensure domain is set (but don't mutate caller objects)
      const curr =
        currentSession && typeof currentSession === "object"
          ? { ...currentSession, domain: currentSession.domain || domain }
          : currentSession;

      const prev =
        previousSession && typeof previousSession === "object"
          ? { ...previousSession, domain: previousSession.domain || domain }
          : previousSession;

      return formatSessionDelta({
        eventEnvelope,
        previousSession: prev || null,
        currentSession: curr,
        context,
      });
    }

    // If passed an object that looks like a session, treat as snapshot
    if (args[0].id && (args[0].domain || domain)) {
      return formatDomainSessionCompat(
        domain,
        defaultSource,
        args[0],
        undefined
      );
    }

    return null;
  }

  // Style B: (session, context?)
  const session = args[0];
  const context = args[1];

  const safe = sanitizeSession(
    session && typeof session === "object"
      ? { ...session, domain: session.domain || domain }
      : session
  );
  if (!safe) return null;

  const ts = new Date().toISOString();
  const summary = buildSessionSummary(safe);

  return {
    kind: "session.snapshot",
    version: HUB_SCHEMA_VERSION,
    ts,
    source: defaultSource || `${domain}.sessionEngine`,
    eventType: "session/snapshot",
    session: summary,
    data: {
      session: safe,
    },
    context: context ? { ...context } : undefined,
  };
}

/**
 * formatAnimalSessionForHub
 * Backward-compatible helper for AnimalSessionEngine.
 */
export function formatAnimalSessionForHub(...args) {
  return formatDomainSessionCompat("animals", "animals.sessionEngine", ...args);
}

/**
 * formatCleaningSessionForHub
 * Backward-compatible helper for CleaningSessionEngine.
 */
export function formatCleaningSessionForHub(...args) {
  return formatDomainSessionCompat(
    "cleaning",
    "cleaning.sessionEngine",
    ...args
  );
}

/**
 * formatGardenSessionForHub
 * Backward-compatible helper for GardenSessionEngine.
 */
export function formatGardenSessionForHub(...args) {
  return formatDomainSessionCompat("garden", "garden.sessionEngine", ...args);
}

/**
 * formatMealSessionForHub
 * Backward-compatible helper for MealSessionGenerator.
 *
 * Notes:
 * - Treats meal sessions like any other session object (delta preferred).
 * - Uses domain "meals" when missing (but does not mutate caller object).
 */
export function formatMealSessionForHub(...args) {
  return formatDomainSessionCompat("meals", "meals.sessionGenerator", ...args);
}

// -----------------------------------------------------------------------------
// ✅ Storehouse compat exporter (StorehouseSignals)
// -----------------------------------------------------------------------------

/**
 * formatStorehouseSignalForHub
 *
 * Backward-compatible helper for StorehouseSignals.
 *
 * Supports:
 *  A) formatStorehouseSignalForHub({ eventEnvelope, signal, payload, context })
 *     -> returns a "storehouse.signal" packet (preferred)
 *
 *  B) formatStorehouseSignalForHub(signal, context?)
 *     -> returns a "storehouse.signal.snapshot" packet
 *
 * Notes:
 * - We keep this intentionally loose and pass the signal through as data.signal.
 * - Event envelope is normalized with normalizeEventType() via buildHubPacket().
 *
 * @param  {...any} args
 * @returns {Object|null}
 */
export function formatStorehouseSignalForHub(...args) {
  // Style A: object arg
  if (args.length === 1 && args[0] && typeof args[0] === "object") {
    const obj = args[0];
    const eventEnvelope = obj.eventEnvelope || null;
    const signal = obj.signal ?? obj.data ?? obj.payload ?? null;

    const payload = obj.payload;
    const context = obj.context;
    const source = obj.source;
    const eventType = obj.eventType;
    const ts = obj.ts;

    if (eventEnvelope) {
      const body =
        payload && typeof payload === "object"
          ? { ...payload }
          : { signal: signal ?? payload ?? null };

      if (signal != null && !("signal" in body)) body.signal = signal;

      const ev = {
        type: eventEnvelope.type || eventType || "storehouse/signal",
        ts: isIso(eventEnvelope.ts)
          ? eventEnvelope.ts
          : isIso(ts)
          ? ts
          : new Date().toISOString(),
        source: eventEnvelope.source || source || "storehouse.signals",
        data: eventEnvelope.data,
      };

      return buildHubPacket("storehouse.signal", ev, body, context);
    }

    // Snapshot fallback if a signal object is present
    if (signal && typeof signal === "object") {
      return formatStorehouseSignalForHub(signal, context);
    }

    // last-ditch: maybe caller passed signal directly (no wrapper)
    if (!eventEnvelope && obj && typeof obj === "object") {
      if (obj.id || obj.signalType || obj.type || obj.key || obj.level) {
        return formatStorehouseSignalForHub(obj, context);
      }
    }

    return null;
  }

  // Style B: (signal, context?)
  const signal = args[0];
  const context = args[1];

  if (!signal || typeof signal !== "object") return null;

  const ev = {
    type: "storehouse/signal.snapshot",
    ts: new Date().toISOString(),
    source: "storehouse.signals",
    data: { signalId: signal.id ?? signal.signalId ?? null },
  };

  return buildHubPacket(
    "storehouse.signal.snapshot",
    ev,
    { signal },
    context ? { ...context } : undefined
  );
}

// -----------------------------------------------------------------------------
// ✅ Inventory compat exporter (InventoryRules)
// -----------------------------------------------------------------------------

/**
 * formatInventoryRuleForHub
 *
 * Backward-compatible helper for InventoryRules.
 *
 * Supports:
 *  A) formatInventoryRuleForHub({ eventEnvelope, rule, payload, context })
 *     -> returns an "inventory.rule" packet (preferred)
 *
 *  B) formatInventoryRuleForHub(rule, context?)
 *     -> returns an "inventory.rule.snapshot" packet
 *
 * Notes:
 * - We do NOT attempt to validate rule shape; we pass it through as data.rule.
 * - Event envelope is normalized with normalizeEventType() via buildHubPacket().
 *
 * @param  {...any} args
 * @returns {Object|null}
 */
export function formatInventoryRuleForHub(...args) {
  // Style A: object arg
  if (args.length === 1 && args[0] && typeof args[0] === "object") {
    const { eventEnvelope, rule, payload, context, source, eventType } =
      args[0];

    // Prefer eventEnvelope if present
    if (eventEnvelope) {
      const body =
        payload && typeof payload === "object"
          ? payload
          : { rule: rule ?? payload ?? null };

      // Ensure we always include rule if provided
      if (
        rule != null &&
        (!body || typeof body !== "object" || !("rule" in body))
      )
        body.rule = rule;

      const ev = {
        type: eventEnvelope.type || eventType || "inventory/rule",
        ts: isIso(eventEnvelope.ts)
          ? eventEnvelope.ts
          : new Date().toISOString(),
        source: eventEnvelope.source || source || "inventory.rules",
        data: eventEnvelope.data,
      };

      return buildHubPacket("inventory.rule", ev, body, context);
    }

    // If it looks like a rule object, treat as snapshot
    if (rule && typeof rule === "object") {
      return formatInventoryRuleForHub(rule, context);
    }
    if (args[0] && typeof args[0] === "object" && !eventEnvelope) {
      // last-ditch: maybe caller passed the rule directly
      if (args[0].id || args[0].name || args[0].type) {
        return formatInventoryRuleForHub(args[0], context);
      }
    }
    return null;
  }

  // Style B: (rule, context?)
  const rule = args[0];
  const context = args[1];

  if (!rule || typeof rule !== "object") return null;

  const ev = {
    type: "inventory/rule.snapshot",
    ts: new Date().toISOString(),
    source: "inventory.rules",
    data: { ruleId: rule.id ?? null },
  };

  return buildHubPacket(
    "inventory.rule.snapshot",
    ev,
    { rule },
    context ? { ...context } : undefined
  );
}

// -----------------------------------------------------------------------------
// ✅ Inventory compat exporter (InventorySessionEngine)
// -----------------------------------------------------------------------------

/**
 * formatInventoryUpdateForHub
 *
 * Backward-compatible helper for InventorySessionEngine.
 *
 * Supports:
 *  A) formatInventoryUpdateForHub({ eventEnvelope, previous, current, update, payload, context })
 *     -> returns an "inventory.update" packet (preferred)
 *
 *  B) formatInventoryUpdateForHub(update, context?)
 *     -> returns an "inventory.update.snapshot" packet
 *
 * Also tolerates a common alternate shape:
 *   formatInventoryUpdateForHub({ eventEnvelope, previousSession, currentSession, context })
 *   (it will map those into previous/current)
 *
 * @param  {...any} args
 * @returns {Object|null}
 */
export function formatInventoryUpdateForHub(...args) {
  // Style A: object arg
  if (args.length === 1 && args[0] && typeof args[0] === "object") {
    const obj = args[0];

    const eventEnvelope = obj.eventEnvelope || null;

    const previous =
      obj.previous ??
      obj.prev ??
      obj.previousSession ??
      obj.previousSnapshot ??
      null;

    const current =
      obj.current ??
      obj.curr ??
      obj.currentSession ??
      obj.currentSnapshot ??
      null;

    const update = obj.update ?? obj.delta ?? obj.patch ?? null;

    const payload = obj.payload;
    const context = obj.context;
    const source = obj.source;
    const eventType = obj.eventType;
    const ts = obj.ts;

    if (eventEnvelope) {
      // Prefer explicit payload, otherwise build a safe body from what we have.
      const body =
        payload && typeof payload === "object"
          ? { ...payload }
          : {
              previous: previous ?? null,
              current: current ?? null,
              update: update ?? payload ?? null,
            };

      // Ensure core fields are present if provided
      if (previous != null && !("previous" in body)) body.previous = previous;
      if (current != null && !("current" in body)) body.current = current;
      if (update != null && !("update" in body)) body.update = update;

      const ev = {
        type: eventEnvelope.type || eventType || "inventory/update",
        ts: isIso(eventEnvelope.ts)
          ? eventEnvelope.ts
          : isIso(ts)
          ? ts
          : new Date().toISOString(),
        source: eventEnvelope.source || source || "inventory.sessionEngine",
        data: eventEnvelope.data,
      };

      return buildHubPacket("inventory.update", ev, body, context);
    }

    // If it looks like an update object, treat as snapshot
    if (update && typeof update === "object") {
      return formatInventoryUpdateForHub(update, context);
    }

    // If payload itself looks like an update object and no eventEnvelope, snapshot it
    if (payload && typeof payload === "object") {
      return formatInventoryUpdateForHub(payload, context);
    }

    // last-ditch: snapshot current if present
    if (current && typeof current === "object") {
      return formatInventoryUpdateForHub({ current }, context);
    }

    return null;
  }

  // Style B: (update, context?)
  const update = args[0];
  const context = args[1];

  if (!update || typeof update !== "object") return null;

  const ev = {
    type: "inventory/update.snapshot",
    ts: new Date().toISOString(),
    source: "inventory.sessionEngine",
    data: { updateId: update.id ?? update.updateId ?? null },
  };

  return buildHubPacket(
    "inventory.update.snapshot",
    ev,
    { update },
    context ? { ...context } : undefined
  );
}

// -----------------------------------------------------------------------------
// ✅ Meal analytics compat exporter (MealAnalytics)
// -----------------------------------------------------------------------------

/**
 * formatMealAnalyticsForHub
 *
 * Backward-compatible helper for MealAnalytics.
 *
 * Supports:
 *  A) formatMealAnalyticsForHub({ eventEnvelope, analytics, payload, context })
 *     -> returns a "meal.analytics" packet (preferred)
 *
 *  B) formatMealAnalyticsForHub(analytics, context?)
 *     -> returns a "meal.analytics.snapshot" packet
 *
 * Notes:
 * - We keep this intentionally loose: we pass through whatever analytics object
 *   the domain provides (macros, meals cooked, adherence, etc.).
 *
 * @param  {...any} args
 * @returns {Object|null}
 */
export function formatMealAnalyticsForHub(...args) {
  // Style A: object arg
  if (args.length === 1 && args[0] && typeof args[0] === "object") {
    const obj = args[0];
    const eventEnvelope = obj.eventEnvelope || null;
    const analytics =
      obj.analytics ?? obj.data ?? obj.metrics ?? obj.summary ?? null;

    const payload = obj.payload;
    const context = obj.context;
    const source = obj.source;
    const eventType = obj.eventType;
    const ts = obj.ts;

    if (eventEnvelope) {
      const body =
        payload && typeof payload === "object"
          ? { ...payload }
          : { analytics: analytics ?? payload ?? null };

      if (analytics != null && !("analytics" in body))
        body.analytics = analytics;

      const ev = {
        type: eventEnvelope.type || eventType || "meals/analytics",
        ts: isIso(eventEnvelope.ts)
          ? eventEnvelope.ts
          : isIso(ts)
          ? ts
          : new Date().toISOString(),
        source: eventEnvelope.source || source || "meals.analytics",
        data: eventEnvelope.data,
      };

      return buildHubPacket("meal.analytics", ev, body, context);
    }

    // Snapshot fallback if an analytics object is present
    if (analytics && typeof analytics === "object") {
      return formatMealAnalyticsForHub(analytics, context);
    }

    // last-ditch: maybe caller passed analytics directly (no wrapper)
    if (!eventEnvelope && obj && typeof obj === "object") {
      if (obj.id || obj.day || obj.range || obj.macros || obj.meals) {
        return formatMealAnalyticsForHub(obj, context);
      }
    }

    return null;
  }

  // Style B: (analytics, context?)
  const analytics = args[0];
  const context = args[1];

  if (!analytics || typeof analytics !== "object") return null;

  const ev = {
    type: "meals/analytics.snapshot",
    ts: new Date().toISOString(),
    source: "meals.analytics",
    data: { analyticsId: analytics.id ?? analytics.analyticsId ?? null },
  };

  return buildHubPacket(
    "meal.analytics.snapshot",
    ev,
    { analytics },
    context ? { ...context } : undefined
  );
}

// -----------------------------------------------------------------------------
// ✅ NEW: Animal plan compat exporter (AnimalPlanner.jsx)
// -----------------------------------------------------------------------------

/**
 * formatAnimalPlanForHub
 *
 * Supports:
 *  A) formatAnimalPlanForHub({ eventEnvelope, plan, payload, context, source?, ts?, eventType? })
 *     -> returns "animals.plan" packet
 *
 *  B) formatAnimalPlanForHub(plan, context?)
 *     -> returns "animals.plan.snapshot" packet
 *
 * @param  {...any} args
 * @returns {Object|null}
 */
export function formatAnimalPlanForHub(...args) {
  // Style A: object arg
  if (args.length === 1 && args[0] && typeof args[0] === "object") {
    const obj = args[0];

    const eventEnvelope = obj.eventEnvelope || null;
    const plan = obj.plan ?? obj.animalPlan ?? obj.data ?? obj.payload ?? null;

    const payload = obj.payload;
    const context = obj.context;
    const source = obj.source;
    const eventType = obj.eventType;
    const ts = obj.ts;

    if (eventEnvelope) {
      const body =
        payload && typeof payload === "object"
          ? { ...payload }
          : { plan: plan ?? payload ?? null };

      if (plan != null && !("plan" in body)) body.plan = plan;

      const ev = {
        type: eventEnvelope.type || eventType || "animals/plan",
        ts: isIso(eventEnvelope.ts)
          ? eventEnvelope.ts
          : isIso(ts)
          ? ts
          : new Date().toISOString(),
        source: eventEnvelope.source || source || "animals.planner",
        data: eventEnvelope.data,
      };

      return buildHubPacket("animals.plan", ev, body, context);
    }

    // Snapshot fallback if a plan object is present
    if (plan && typeof plan === "object") {
      return formatAnimalPlanForHub(plan, context);
    }

    // last-ditch: maybe caller passed plan directly in object with no wrapper
    if (!eventEnvelope && obj && typeof obj === "object") {
      if (obj.id || obj.kind || obj.title || obj.status) {
        return formatAnimalPlanForHub(obj, context);
      }
    }

    return null;
  }

  // Style B: (plan, context?)
  const plan = args[0];
  const context = args[1];

  if (!plan || typeof plan !== "object") return null;

  const ev = {
    type: "animals/plan.snapshot",
    ts: new Date().toISOString(),
    source: "animals.planner",
    data: { planId: plan.id ?? plan.planId ?? null },
  };

  return buildHubPacket(
    "animals.plan.snapshot",
    ev,
    { plan },
    context ? { ...context } : undefined
  );
}

// -----------------------------------------------------------------------------
// ✅ NEW: Cleaning plan compat exporter (CleaningPlanner.jsx)
// -----------------------------------------------------------------------------

/**
 * formatCleaningPlanForHub
 *
 * Supports:
 *  A) formatCleaningPlanForHub({ eventEnvelope, plan, payload, context, source?, ts?, eventType? })
 *     -> returns "cleaning.plan" packet
 *
 *  B) formatCleaningPlanForHub(plan, context?)
 *     -> returns "cleaning.plan.snapshot" packet
 *
 * @param  {...any} args
 * @returns {Object|null}
 */
export function formatCleaningPlanForHub(...args) {
  // Style A: object arg
  if (args.length === 1 && args[0] && typeof args[0] === "object") {
    const obj = args[0];

    const eventEnvelope = obj.eventEnvelope || null;
    const plan =
      obj.plan ?? obj.cleaningPlan ?? obj.data ?? obj.payload ?? null;

    const payload = obj.payload;
    const context = obj.context;
    const source = obj.source;
    const eventType = obj.eventType;
    const ts = obj.ts;

    if (eventEnvelope) {
      const body =
        payload && typeof payload === "object"
          ? { ...payload }
          : { plan: plan ?? payload ?? null };

      if (plan != null && !("plan" in body)) body.plan = plan;

      const ev = {
        type: eventEnvelope.type || eventType || "cleaning/plan",
        ts: isIso(eventEnvelope.ts)
          ? eventEnvelope.ts
          : isIso(ts)
          ? ts
          : new Date().toISOString(),
        source: eventEnvelope.source || source || "cleaning.planner",
        data: eventEnvelope.data,
      };

      return buildHubPacket("cleaning.plan", ev, body, context);
    }

    // Snapshot fallback if a plan object is present
    if (plan && typeof plan === "object") {
      return formatCleaningPlanForHub(plan, context);
    }

    // last-ditch: maybe caller passed plan directly in object with no wrapper
    if (!eventEnvelope && obj && typeof obj === "object") {
      if (obj.id || obj.name || obj.rooms || obj.rhythms) {
        return formatCleaningPlanForHub(obj, context);
      }
    }

    return null;
  }

  // Style B: (plan, context?)
  const plan = args[0];
  const context = args[1];

  if (!plan || typeof plan !== "object") return null;

  const ev = {
    type: "cleaning/plan.snapshot",
    ts: new Date().toISOString(),
    source: "cleaning.planner",
    data: { planId: plan.id ?? plan.planId ?? null },
  };

  return buildHubPacket(
    "cleaning.plan.snapshot",
    ev,
    { plan },
    context ? { ...context } : undefined
  );
}

// -----------------------------------------------------------------------------
// ✅ NEW: Garden plan compat exporter (GardenPlanner.jsx)
// -----------------------------------------------------------------------------

/**
 * formatGardenPlanForHub
 *
 * Supports:
 *  A) formatGardenPlanForHub({ eventEnvelope, plan, payload, context, source?, ts?, eventType? })
 *     -> returns "garden.plan" packet
 *
 *  B) formatGardenPlanForHub(plan, context?)
 *     -> returns "garden.plan.snapshot" packet
 *
 * @param  {...any} args
 * @returns {Object|null}
 */
export function formatGardenPlanForHub(...args) {
  // Style A: object arg
  if (args.length === 1 && args[0] && typeof args[0] === "object") {
    const obj = args[0];

    const eventEnvelope = obj.eventEnvelope || null;
    const plan = obj.plan ?? obj.gardenPlan ?? obj.data ?? obj.payload ?? null;

    const payload = obj.payload;
    const context = obj.context;
    const source = obj.source;
    const eventType = obj.eventType;
    const ts = obj.ts;

    if (eventEnvelope) {
      const body =
        payload && typeof payload === "object"
          ? { ...payload }
          : { plan: plan ?? payload ?? null };

      if (plan != null && !("plan" in body)) body.plan = plan;

      const ev = {
        type: eventEnvelope.type || eventType || "garden/plan",
        ts: isIso(eventEnvelope.ts)
          ? eventEnvelope.ts
          : isIso(ts)
          ? ts
          : new Date().toISOString(),
        source: eventEnvelope.source || source || "garden.planner",
        data: eventEnvelope.data,
      };

      return buildHubPacket("garden.plan", ev, body, context);
    }

    // Snapshot fallback if a plan object is present
    if (plan && typeof plan === "object") {
      return formatGardenPlanForHub(plan, context);
    }

    // last-ditch: maybe caller passed plan directly in object with no wrapper
    if (!eventEnvelope && obj && typeof obj === "object") {
      if (obj.id || obj.name || obj.beds || obj.crops || obj.tasks) {
        return formatGardenPlanForHub(obj, context);
      }
    }

    return null;
  }

  // Style B: (plan, context?)
  const plan = args[0];
  const context = args[1];

  if (!plan || typeof plan !== "object") return null;

  const ev = {
    type: "garden/plan.snapshot",
    ts: new Date().toISOString(),
    source: "garden.planner",
    data: { planId: plan.id ?? plan.planId ?? null },
  };

  return buildHubPacket(
    "garden.plan.snapshot",
    ev,
    { plan },
    context ? { ...context } : undefined
  );
}

// -----------------------------------------------------------------------------
// ✅ NEW: Meal plan compat exporter (MealPlanner.jsx)
// -----------------------------------------------------------------------------

/**
 * formatMealPlanForHub
 *
 * Supports:
 *  A) formatMealPlanForHub({ eventEnvelope, plan, payload, context, source?, ts?, eventType? })
 *     -> returns "meals.plan" packet (preferred when eventEnvelope present)
 *
 *  B) formatMealPlanForHub(plan, context?)
 *     -> returns "meals.plan.snapshot" packet
 *
 * Notes:
 * - Intentionally loose: the MealPlanStore plan shape can evolve; we pass through.
 * - Deterministic and side-effect free; no mutations of caller objects.
 *
 * @param  {...any} args
 * @returns {Object|null}
 */
export function formatMealPlanForHub(...args) {
  // Style A: object arg
  if (args.length === 1 && args[0] && typeof args[0] === "object") {
    const obj = args[0];

    const eventEnvelope = obj.eventEnvelope || null;
    const plan = obj.plan ?? obj.mealPlan ?? obj.data ?? obj.payload ?? null;

    const payload = obj.payload;
    const context = obj.context;
    const source = obj.source;
    const eventType = obj.eventType;
    const ts = obj.ts;

    if (eventEnvelope) {
      const body =
        payload && typeof payload === "object"
          ? { ...payload }
          : { plan: plan ?? payload ?? null };

      if (plan != null && !("plan" in body)) body.plan = plan;

      const ev = {
        type: eventEnvelope.type || eventType || "meals/plan",
        ts: isIso(eventEnvelope.ts)
          ? eventEnvelope.ts
          : isIso(ts)
          ? ts
          : new Date().toISOString(),
        source: eventEnvelope.source || source || "meals.planner",
        data: eventEnvelope.data,
      };

      return buildHubPacket("meals.plan", ev, body, context);
    }

    // Snapshot fallback if a plan object is present
    if (plan && typeof plan === "object") {
      return formatMealPlanForHub(plan, context);
    }

    // last-ditch: maybe caller passed plan directly in object with no wrapper
    if (!eventEnvelope && obj && typeof obj === "object") {
      if (
        obj.id ||
        obj.weekStartISO ||
        obj.days ||
        obj.rhythm ||
        obj.constraints
      ) {
        return formatMealPlanForHub(obj, context);
      }
    }

    return null;
  }

  // Style B: (plan, context?)
  const plan = args[0];
  const context = args[1];

  if (!plan || typeof plan !== "object") return null;

  const ev = {
    type: "meals/plan.snapshot",
    ts: new Date().toISOString(),
    source: "meals.planner",
    data: { planId: plan.id ?? plan.planId ?? null },
  };

  return buildHubPacket(
    "meals.plan.snapshot",
    ev,
    { plan },
    context ? { ...context } : undefined
  );
}

// -----------------------------------------------------------------------------
// ✅ NEW: Storehouse plan compat exporter (StorehousePlanner.jsx)
// -----------------------------------------------------------------------------

/**
 * formatStorehousePlanForHub
 *
 * Supports:
 *  A) formatStorehousePlanForHub({ eventEnvelope, plan, payload, context, source?, ts?, eventType? })
 *     -> returns "storehouse.plan" packet (preferred when eventEnvelope present)
 *
 *  B) formatStorehousePlanForHub(plan, context?)
 *     -> returns "storehouse.plan.snapshot" packet
 *
 * Notes:
 * - Intentionally loose: storehouse plan shape can evolve; we pass through.
 * - Deterministic and side-effect free; no mutations of caller objects.
 *
 * @param  {...any} args
 * @returns {Object|null}
 */
export function formatStorehousePlanForHub(...args) {
  // Style A: object arg
  if (args.length === 1 && args[0] && typeof args[0] === "object") {
    const obj = args[0];

    const eventEnvelope = obj.eventEnvelope || null;
    const plan =
      obj.plan ?? obj.storehousePlan ?? obj.data ?? obj.payload ?? null;

    const payload = obj.payload;
    const context = obj.context;
    const source = obj.source;
    const eventType = obj.eventType;
    const ts = obj.ts;

    if (eventEnvelope) {
      const body =
        payload && typeof payload === "object"
          ? { ...payload }
          : { plan: plan ?? payload ?? null };

      if (plan != null && !("plan" in body)) body.plan = plan;

      const ev = {
        type: eventEnvelope.type || eventType || "storehouse/plan",
        ts: isIso(eventEnvelope.ts)
          ? eventEnvelope.ts
          : isIso(ts)
          ? ts
          : new Date().toISOString(),
        source: eventEnvelope.source || source || "storehouse.planner",
        data: eventEnvelope.data,
      };

      return buildHubPacket("storehouse.plan", ev, body, context);
    }

    // Snapshot fallback if a plan object is present
    if (plan && typeof plan === "object") {
      return formatStorehousePlanForHub(plan, context);
    }

    // last-ditch: maybe caller passed plan directly in object with no wrapper
    if (!eventEnvelope && obj && typeof obj === "object") {
      if (obj.id || obj.name || obj.categories || obj.items || obj.cycles) {
        return formatStorehousePlanForHub(obj, context);
      }
    }

    return null;
  }

  // Style B: (plan, context?)
  const plan = args[0];
  const context = args[1];

  if (!plan || typeof plan !== "object") return null;

  const ev = {
    type: "storehouse/plan.snapshot",
    ts: new Date().toISOString(),
    source: "storehouse.planner",
    data: { planId: plan.id ?? plan.planId ?? null },
  };

  return buildHubPacket(
    "storehouse.plan.snapshot",
    ev,
    { plan },
    context ? { ...context } : undefined
  );
}

// -----------------------------------------------------------------------------
// Named export expected by callers:
//   import { HubPacketFormatter } from "@/services/hub/HubPacketFormatter";
// -----------------------------------------------------------------------------
export class HubPacketFormatter {
  /**
   * Format a session delta packet (shim-friendly).
   * @param {Parameters<typeof formatSessionDelta>[0]} args
   */
  static formatSessionDelta(args) {
    return formatSessionDelta(args);
  }

  /**
   * Generic hub packet helper.
   * @param {string} kind
   * @param {EventEnvelope} event
   * @param {any} payload
   * @param {HubContext} [context]
   */
  static buildHubPacket(kind, event, payload, context) {
    return buildHubPacket(kind, event, payload, context);
  }

  /**
   * Compat helper used by calculator shims.
   * @param  {...any} args
   */
  static formatForHub(...args) {
    return formatForHub(...args);
  }

  /**
   * Animals compat wrapper.
   * @param  {...any} args
   */
  static formatAnimalSessionForHub(...args) {
    return formatAnimalSessionForHub(...args);
  }

  /**
   * Cleaning compat wrapper.
   * @param  {...any} args
   */
  static formatCleaningSessionForHub(...args) {
    return formatCleaningSessionForHub(...args);
  }

  /**
   * Garden compat wrapper.
   * @param  {...any} args
   */
  static formatGardenSessionForHub(...args) {
    return formatGardenSessionForHub(...args);
  }

  /**
   * Meals compat wrapper.
   * @param  {...any} args
   */
  static formatMealSessionForHub(...args) {
    return formatMealSessionForHub(...args);
  }

  /**
   * Storehouse signals compat wrapper.
   * @param  {...any} args
   */
  static formatStorehouseSignalForHub(...args) {
    return formatStorehouseSignalForHub(...args);
  }

  /**
   * Inventory rules compat wrapper.
   * @param  {...any} args
   */
  static formatInventoryRuleForHub(...args) {
    return formatInventoryRuleForHub(...args);
  }

  /**
   * Inventory updates compat wrapper.
   * @param  {...any} args
   */
  static formatInventoryUpdateForHub(...args) {
    return formatInventoryUpdateForHub(...args);
  }

  /**
   * Meal analytics compat wrapper.
   * @param  {...any} args
   */
  static formatMealAnalyticsForHub(...args) {
    return formatMealAnalyticsForHub(...args);
  }

  /**
   * Animal plan compat wrapper.
   * @param  {...any} args
   */
  static formatAnimalPlanForHub(...args) {
    return formatAnimalPlanForHub(...args);
  }

  /**
   * Cleaning plan compat wrapper.
   * @param  {...any} args
   */
  static formatCleaningPlanForHub(...args) {
    return formatCleaningPlanForHub(...args);
  }

  /**
   * Garden plan compat wrapper.
   * @param  {...any} args
   */
  static formatGardenPlanForHub(...args) {
    return formatGardenPlanForHub(...args);
  }

  /**
   * Meal plan compat wrapper.
   * @param  {...any} args
   */
  static formatMealPlanForHub(...args) {
    return formatMealPlanForHub(...args);
  }

  /**
   * Storehouse plan compat wrapper.
   * @param  {...any} args
   */
  static formatStorehousePlanForHub(...args) {
    return formatStorehousePlanForHub(...args);
  }
}

export default {
  HubPacketFormatter,
  formatSessionDelta,
  buildHubPacket,
  formatForHub,
  formatAnimalSessionForHub,
  formatCleaningSessionForHub,
  formatGardenSessionForHub,
  formatMealSessionForHub,
  formatStorehouseSignalForHub,
  formatInventoryRuleForHub,
  formatInventoryUpdateForHub,
  formatMealAnalyticsForHub,
  formatAnimalPlanForHub,
  formatCleaningPlanForHub,
  formatGardenPlanForHub,
  formatMealPlanForHub,
  formatStorehousePlanForHub,
};
