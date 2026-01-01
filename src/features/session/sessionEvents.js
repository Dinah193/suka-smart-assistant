// C:\Users\larho\suka-smart-assistant\src\features\session\sessionEvents.js

import { emit } from "../../services/eventBus";

/**
 * Default source label for session-related events.
 * Individual callers can override this if needed.
 */
export const DEFAULT_SESSION_EVENT_SOURCE = "features/session";

/**
 * Utility: ISO timestamp now
 */
function nowIso() {
  return new Date().toISOString();
}

/**
 * Canonical session event type strings.
 *
 * Keeping this centralized helps:
 *  - orchestrator / shims subscribe reliably
 *  - avoid typos
 *  - evolve the event model over time
 */
export const SessionEventTypes = {
  SESSION_STARTED: "session.started",
  SESSION_START_FAILED: "session.start.failed",
  SESSION_RESTORED: "session.restored",
  SESSION_RESUMED: "session.resumed",
  SESSION_RESUME_FAILED: "session.resume.failed",
  SESSION_PAUSED: "session.paused",
  SESSION_CANCELLED: "session.cancelled",
  SESSION_COMPLETED: "session.completed",

  SESSION_STEP_STARTED: "session.step.started",
  SESSION_STEP_COMPLETED: "session.step.completed",

  SESSION_REVERSE_GENERATED: "session.reverse.generated",

  SESSION_PLAN_ENRICHED: "session.plan.enriched",
  SESSION_PLAN_ENRICHMENT_FAILED: "session.plan.enrichment.failed",

  HUB_EXPORT_QUEUED: "hub.export.queued",
  HUB_EXPORT_FAILED: "hub.export.failed",

  SESSION_FAVORITED: "session.favorited",
  SESSION_FAVORITE_REMOVED: "session.favorite.removed",

  SESSION_SCHEDULE_SAVED: "session.schedule.saved",

  SHIM_ON_SESSION_STARTED_FAILED: "session.shim.onSessionStarted.failed",
  SHIM_ON_SESSION_COMPLETED_FAILED: "session.shim.onSessionCompleted.failed",
};

/**
 * Domain hints (for analytics / orchestration):
 * This mirrors your multi-domain SSA context and can be used in payloads.
 */
export const SessionDomains = {
  COOKING: "cooking",
  CLEANING: "cleaning",
  GARDEN_PLANNING: "garden_planning",
  GARDEN_CARE: "garden_care",
  GARDEN_HARVEST: "garden_harvest",
  STOREHOUSE: "storehouse",
  ANIMALS_ACQUISITION: "animals_acquisition",
  ANIMALS_CARE: "animals_care",
  ANIMALS_BUTCHERY: "animals_butchery",
  PRESERVATION: "preservation",
  GENERIC: "generic",
};

/**
 * Base helper to keep the event payloads consistent.
 */
function emitSessionEvent(type, { source, data }) {
  emit({
    type,
    ts: nowIso(),
    source: source || DEFAULT_SESSION_EVENT_SOURCE,
    data,
  });
}

/**
 * SESSION LIFECYCLE EVENTS
 * ------------------------------------------------------------
 */

export function emitSessionStarted(session, opts = {}) {
  emitSessionEvent(SessionEventTypes.SESSION_STARTED, {
    source: opts.source,
    data: {
      session,
      sessionId: session.id,
      domain: session.domain || SessionDomains.GENERIC,
      mode: session.schedule?.mode || "now",
    },
  });
}

export function emitSessionStartFailed(error, opts = {}) {
  emitSessionEvent(SessionEventTypes.SESSION_START_FAILED, {
    source: opts.source,
    data: {
      error: String(error),
      errorMeta: opts.errorMeta || null,
    },
  });
}

export function emitSessionRestored(session, opts = {}) {
  emitSessionEvent(SessionEventTypes.SESSION_RESTORED, {
    source: opts.source,
    data: {
      sessionId: session.id,
      domain: session.domain || SessionDomains.GENERIC,
      status: session.status,
    },
  });
}

export function emitSessionResumed(session, opts = {}) {
  emitSessionEvent(SessionEventTypes.SESSION_RESUMED, {
    source: opts.source,
    data: {
      sessionId: session.id,
      domain: session.domain || SessionDomains.GENERIC,
    },
  });
}

export function emitSessionResumeFailed(sessionId, error, opts = {}) {
  emitSessionEvent(SessionEventTypes.SESSION_RESUME_FAILED, {
    source: opts.source,
    data: {
      sessionId,
      error: String(error),
    },
  });
}

export function emitSessionPaused(session, opts = {}) {
  emitSessionEvent(SessionEventTypes.SESSION_PAUSED, {
    source: opts.source,
    data: {
      sessionId: session.id,
      domain: session.domain || SessionDomains.GENERIC,
    },
  });
}

export function emitSessionCancelled(session, reason, opts = {}) {
  emitSessionEvent(SessionEventTypes.SESSION_CANCELLED, {
    source: opts.source,
    data: {
      sessionId: session.id,
      domain: session.domain || SessionDomains.GENERIC,
      reason: reason || "user_cancelled",
    },
  });
}

export function emitSessionCompleted(session, opts = {}) {
  emitSessionEvent(SessionEventTypes.SESSION_COMPLETED, {
    source: opts.source,
    data: {
      sessionId: session.id,
      domain: session.domain || SessionDomains.GENERIC,
      completedAt: session.completedAt || nowIso(),
    },
  });
}

/**
 * STEP-LEVEL EVENTS
 * ------------------------------------------------------------
 */

export function emitSessionStepStarted(session, step, index, opts = {}) {
  emitSessionEvent(SessionEventTypes.SESSION_STEP_STARTED, {
    source: opts.source,
    data: {
      sessionId: session.id,
      domain: session.domain || SessionDomains.GENERIC,
      stepId: step.id,
      index,
    },
  });
}

export function emitSessionStepCompleted(session, step, index, opts = {}) {
  emitSessionEvent(SessionEventTypes.SESSION_STEP_COMPLETED, {
    source: opts.source,
    data: {
      sessionId: session.id,
      domain: session.domain || SessionDomains.GENERIC,
      stepId: step.id,
      index,
    },
  });
}

/**
 * REVERSE GENERATION & PLAN ENRICHMENT
 * ------------------------------------------------------------
 * These are key for your reverse-planned sessions and shims/orchestrator flows.
 */

export function emitSessionReverseGenerated(session, targetCompletion, opts = {}) {
  emitSessionEvent(SessionEventTypes.SESSION_REVERSE_GENERATED, {
    source: opts.source,
    data: {
      sessionId: session.id,
      domain: session.domain || SessionDomains.GENERIC,
      targetCompletion,
      mode: session.schedule?.mode || "reverse",
    },
  });
}

export function emitSessionPlanEnriched(session, opts = {}) {
  emitSessionEvent(SessionEventTypes.SESSION_PLAN_ENRICHED, {
    source: opts.source,
    data: {
      sessionId: session.id,
      domain: session.domain || SessionDomains.GENERIC,
    },
  });
}

export function emitSessionPlanEnrichmentFailed(sessionId, error, opts = {}) {
  emitSessionEvent(SessionEventTypes.SESSION_PLAN_ENRICHMENT_FAILED, {
    source: opts.source,
    data: {
      sessionId,
      error: String(error),
    },
  });
}

/**
 * HUB EXPORT EVENTS
 * ------------------------------------------------------------
 * When familyFundMode is enabled, your SessionRunner already attempts export.
 * These helpers just standardize the events.
 */

export function emitHubExportQueued(session, opts = {}) {
  emitSessionEvent(SessionEventTypes.HUB_EXPORT_QUEUED, {
    source: opts.source,
    data: {
      sessionId: session.id,
      domain: session.domain || SessionDomains.GENERIC,
    },
  });
}

export function emitHubExportFailed(session, error, opts = {}) {
  emitSessionEvent(SessionEventTypes.HUB_EXPORT_FAILED, {
    source: opts.source,
    data: {
      sessionId: session.id,
      domain: session.domain || SessionDomains.GENERIC,
      error: String(error),
    },
  });
}

/**
 * FAVORITES & SCHEDULES
 * ------------------------------------------------------------
 * Explicitly supports *user-owned* favorites and schedules,
 * not just system templates.
 */

export function emitSessionFavorited(session, favoriteRecord, opts = {}) {
  emitSessionEvent(SessionEventTypes.SESSION_FAVORITED, {
    source: opts.source,
    data: {
      sessionId: session.id,
      domain: session.domain || SessionDomains.GENERIC,
      favoriteId: favoriteRecord?.id,
      userOwned: true, // important: user-created favorite
    },
  });
}

export function emitSessionFavoriteRemoved(sessionId, opts = {}) {
  emitSessionEvent(SessionEventTypes.SESSION_FAVORITE_REMOVED, {
    source: opts.source,
    data: {
      sessionId,
      userOwned: true,
    },
  });
}

export function emitSessionScheduleSaved(scheduleRecord, opts = {}) {
  emitSessionEvent(SessionEventTypes.SESSION_SCHEDULE_SAVED, {
    source: opts.source,
    data: {
      scheduleId: scheduleRecord.id,
      domain: scheduleRecord.domain || SessionDomains.GENERIC,
      sessionTemplateId: scheduleRecord.sessionTemplateId || null,
      userOwned: true, // explicit signal for user-created schedule
    },
  });
}

/**
 * SHIM + HOUSEHOLD ORCHESTRATOR FAILURE EVENTS
 * ------------------------------------------------------------
 * These give your diagnostics / observability a clean place to listen
 * when shims or orchestrator hooks fail.
 */

export function emitShimOnSessionStartedFailed(sessionId, error, opts = {}) {
  emitSessionEvent(SessionEventTypes.SHIM_ON_SESSION_STARTED_FAILED, {
    source: opts.source,
    data: {
      sessionId,
      error: String(error),
    },
  });
}

export function emitShimOnSessionCompletedFailed(sessionId, error, opts = {}) {
  emitSessionEvent(SessionEventTypes.SHIM_ON_SESSION_COMPLETED_FAILED, {
    source: opts.source,
    data: {
      sessionId,
      error: String(error),
    },
  });
}

/**
 * OPTIONAL: domain-aware convenience emitters
 * ------------------------------------------------------------
 * These are sugar helpers you can use in UI or orchestrator code
 * when creating domain-specific sessions. They don't create sessions;
 * they only emit metadata-rich events for analytics or orchestration.
 */

export function emitDomainSessionRequested(domainKey, context = {}, opts = {}) {
  // Example: UI button "Quick Garden Care Session"
  emitSessionEvent("session.domain.requested", {
    source: opts.source,
    data: {
      domain: domainKey || SessionDomains.GENERIC,
      context,
    },
  });
}

export function emitReversePlanRequested(domainKey, targetCompletion, context = {}, opts = {}) {
  // Example: "Finish butchery by 5pm" → orchestrator listens for this
  emitSessionEvent("session.reverse.requested", {
    source: opts.source,
    data: {
      domain: domainKey || SessionDomains.GENERIC,
      targetCompletion,
      context,
    },
  });
}
