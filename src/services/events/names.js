// C:\Users\larho\suka-smart-assistant\src\services\events\names.js
// -----------------------------------------------------------------------------
/**
 * Central registry of SSA event names.
 * This file defines the canonical string constants used across:
 *   imports → intelligence → automation/scheduler → (optional) hub export
 *
 * Why this exists:
 * - Prevents typos and drift across services/workers/UI.
 * - Enables defensive validation of event names at emit/subscribe.
 * - Provides clear grouping for scheduler-related events (primary purpose here).
 *
 * Payload shape (standard across SSA):
 *   {
 *     type: string,               // one of the constants below
 *     ts: string,                 // ISO timestamp
 *     source: string,             // emitter id/module path
 *     data: Record<string, any>   // event-specific payload
 *   }
 *
 * NOTE: Only event-name strings live here. Emission happens via eventBus.
 */
// -----------------------------------------------------------------------------

"use strict";

/** Core domain events (stable, widely used) */
export const CORE_EVENTS = Object.freeze({
  IMPORT_PARSED:               "import.parsed",
  INVENTORY_UPDATED:           "inventory.updated",
  INVENTORY_SHORTAGE_DETECTED: "inventory.shortage.detected",
  MEAL_EXECUTED:               "meal.executed",
  GARDEN_HARVEST_LOGGED:       "garden.harvest.logged",
  PRESERVATION_COMPLETED:      "preservation.completed",
});

/** Content/knowledge events (web-of-meaning, articles, entities) */
export const CONTENT_EVENTS = Object.freeze({
  ARTICLE_PUBLISHED:           "article.published",
  ARTICLE_LINKED:              "article.linked",
  ARTICLE_REFRESH_REQUESTED:   "article.refresh.requested",
});

/** Session lifecycle (generic across cooking/cleaning/garden/animal) */
export const SESSION_EVENTS = Object.freeze({
  SESSION_DRAFT_CREATED:       "session.draft.created",
  SESSION_DRAFT_APPROVED:      "session.draft.approved",
  SESSION_STARTED:             "session.started",
  SESSION_STEP_PROGRESS:       "session.step.progress",
  SESSION_COMPLETED:           "session.completed",
  SESSION_CANCELLED:           "session.cancelled",
});

/**
 * Scheduler / Automation runtime events
 * These are the canonical names the SSA scheduler uses. If you’re wiring a
 * cron/timer/queue or registering automation rules, use ONLY these strings.
 */
export const SCHEDULER_EVENTS = Object.freeze({
  // Schedules (definitions/records)
  SCHEDULE_CREATED:            "schedule.created",
  SCHEDULE_UPDATED:            "schedule.updated",
  SCHEDULE_DELETED:            "schedule.deleted",
  SCHEDULE_ENABLED:            "schedule.enabled",
  SCHEDULE_DISABLED:           "schedule.disabled",
  SCHEDULE_NEXT_COMPUTED:      "schedule.next.computed",
  SCHEDULE_CONFLICT_DETECTED:  "schedule.conflict.detected",
  SCHEDULE_DRIFT_DETECTED:     "schedule.drift.detected",

  // Clock/tick lifecycle
  SCHEDULE_TICK:               "schedule.tick",            // periodic heartbeat
  SCHEDULE_DUE:                "schedule.due",             // item is due now (pre-run)

  // Runs (individual executions)
  SCHEDULE_RUN_REQUESTED:      "schedule.run.requested",   // request to run (API/trigger)
  SCHEDULE_RUN_ENQUEUED:       "schedule.run.enqueued",    // placed on worker/queue
  SCHEDULE_RUN_STARTED:        "schedule.run.started",
  SCHEDULE_RUN_PROGRESS:       "schedule.run.progress",
  SCHEDULE_RUN_SKIPPED:        "schedule.run.skipped",     // condition not met/quiet hours
  SCHEDULE_RUN_COMPLETED:      "schedule.run.completed",
  SCHEDULE_RUN_FAILED:         "schedule.run.failed",
  SCHEDULE_RETRY_SCHEDULED:    "schedule.retry.scheduled",
  SCHEDULE_BACKOFF_APPLIED:    "schedule.backoff.applied",

  // Rules (declarative automations)
  AUTOMATION_RULE_REGISTERED:  "automation.rule.registered",
  AUTOMATION_RULE_FIRED:       "automation.rule.fired",
  AUTOMATION_RULE_FAILED:      "automation.rule.failed",

  // Suggestions (NBAs, soft actions)
  SUGGESTION_CREATED:          "automation.suggestion.created",
  SUGGESTION_ACCEPTED:         "automation.suggestion.accepted",
  SUGGESTION_REJECTED:         "automation.suggestion.rejected",
});

/** Hub/export signals (emitted by writers after local commit succeeds) */
export const HUB_EVENTS = Object.freeze({
  HUB_EXPORT_ATTEMPTED:        "hub.export.attempted",
  HUB_EXPORT_SUCCEEDED:        "hub.export.succeeded",
  HUB_EXPORT_FAILED:           "hub.export.failed",
});

/**
 * Flattened map of ALL known events keyed by a readable constant name.
 * Useful for IDE autocomplete and for building allowlists.
 */
export const EVENTS = Object.freeze({
  ...CORE_EVENTS,
  ...CONTENT_EVENTS,
  ...SESSION_EVENTS,
  ...SCHEDULER_EVENTS,
  ...HUB_EVENTS,
});

/** Ordered arrays for grouping/filtering UIs (e.g., analytics, devtools) */
export const EVENT_GROUPS = Object.freeze({
  core:       Object.values(CORE_EVENTS),
  content:    Object.values(CONTENT_EVENTS),
  session:    Object.values(SESSION_EVENTS),
  scheduler:  Object.values(SCHEDULER_EVENTS),
  hub:        Object.values(HUB_EVENTS),
});

/** Fast Sets for validation / membership checks */
const ALL_EVENT_SET        = new Set(Object.values(EVENTS));
const SCHEDULER_EVENT_SET  = new Set(EVENT_GROUPS.scheduler);

/**
 * Runtime guard: is the name a known event?
 * @param {string} name
 * @returns {boolean}
 */
export function isKnownEventName(name) {
  return ALL_EVENT_SET.has(name);
}

/**
 * Runtime guard: is the name a scheduler/automation event?
 * @param {string} name
 * @returns {boolean}
 */
export function isSchedulerEvent(name) {
  return SCHEDULER_EVENT_SET.has(name);
}

/**
 * Suggest close matches when validation fails (tiny helper; no external deps).
 * @param {string} name
 * @param {number} max
 * @returns {string[]} sorted suggestions by naive similarity
 */
export function suggestEventNames(name, max = 5) {
  const score = (a, b) => {
    // simple case-insensitive overlap metric
    const A = a.toLowerCase(), B = b.toLowerCase();
    let hit = 0;
    for (let i = 0; i < Math.min(A.length, B.length); i++) {
      if (A[i] === B[i]) hit++;
    }
    return hit / Math.max(A.length, B.length);
  };
  return Array.from(ALL_EVENT_SET)
    .map(ev => [ev, score(ev, name)])
    .sort((x, y) => y[1] - x[1])
    .slice(0, max)
    .map(([ev]) => ev);
}

/**
 * Extension point:
 * If you add a brand-new domain (e.g., preservation sessions, animal tasks),
 * prefer adding its event names here in a new group object (ANIMAL_EVENTS, etc.)
 * then spread into EVENTS and EVENT_GROUPS to keep validation consistent.
 */
// -----------------------------------------------------------------------------
