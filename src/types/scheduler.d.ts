// src/types/scheduler.d.ts
// Typed contracts for Timeline items, Pause Policies, Safety Escalation,
// and related event payloads used across Sessions/Garden/Animals/Cleaning.
//
// These definitions are JS-runtime friendly (no emitted JS), and improve
// IntelliSense when using // @ts-check in JS files.

/* -----------------------------------------------------------------------------
   CORE DOMAIN TYPES
----------------------------------------------------------------------------- */

export type DomainType =
  | "cooking"
  | "cleaning"
  | "garden"
  | "animals"
  | "inventory"
  | "tasks"
  | "susu"
  | "other";

export type Priority = "low" | "normal" | "high" | "critical";

export type TimelineStatus =
  | "planned"     // created, not yet scheduled
  | "queued"      // scheduled, waiting to start
  | "active"      // in progress
  | "paused"      // paused by user/policy
  | "completed"   // finished normally
  | "canceled"    // intentionally stopped
  | "skipped"     // auto-skipped by policy
  | "failed";     // errored or exceeded safety

export interface RiskFlags {
  heat?: boolean;
  perishables?: boolean;
  contamination?: boolean;
  sharpTools?: boolean;
  heavyLifting?: boolean;
  chemicals?: boolean;
  animals?: boolean;
  dehydration?: boolean;
  [k: string]: boolean | undefined;
}

/* -----------------------------------------------------------------------------
   NEXT BEST ACTIONS (NBA)
----------------------------------------------------------------------------- */

export interface NextBestAction {
  /** Action code consumed by orchestrators (stable identifier). */
  code:
    | "PREHEAT_OR_PREP"
    | "SET_TIMER"
    | "CHECK_SUBS"
    | "STAGE_TOOLS"
    | "STAGE_FEED_SHELTER"
    | "REVIEW_STEP"
    | "AUTO_PAUSE"
    | "AUTO_STOP"
    | "SAFE_REMOVE_HEAT"
    | "COOL_DOWN"
    | "ESCALATE_ANIMAL_WELFARE"
    | "WATER_OR_SHADE"
    | string;
  /** Human-readable label for UI buttons, chips, etc. */
  label: string;
  /** Why this is suggested (UI tooltip/help). */
  rationale?: string;
  /** Arbitrary data for handlers. */
  data?: Record<string, any>;
}

/* -----------------------------------------------------------------------------
   FAVORITES / USER-SAVED SESSION METADATA
----------------------------------------------------------------------------- */

export interface FavoriteMeta {
  /** If this item/template is user-saved (as opposed to system-provided). */
  isFavorite?: boolean;
  /** Owner/user id, or household id for shared favorites. */
  ownerId?: string;
  /** Id of the saved template or plan this came from. */
  templateId?: string;
  /** Optional user notes / nickname. */
  nickname?: string;
  /** Optional safety overrides stored with favorite. */
  overrides?: Partial<DeadlineConfig & GuardAwareConfig>;
}

/* -----------------------------------------------------------------------------
   DEADLINES & GUARDS
----------------------------------------------------------------------------- */

export interface DeadlineConfig {
  /** Soft threshold before due (ms). If absent, system softLeadMs is used. */
  softAt?: number | string | Date;
  /** Hard due timestamp (ms). */
  dueAt: number | string | Date;
  /** Extra grace after dueAt before "hard" escalation (ms). */
  maxOverrunMs?: number;
}

export interface GuardWindow {
  enabled: boolean;
  /** "HH:mm" local time (Quiet Hours) or friendly text for Sabbath (ignored here). */
  start?: string;
  end?: string;
}

export interface GuardAwareConfig {
  quietHours?: GuardWindow;
  sabbathGuard?: GuardWindow & {
    /** Optional resolved window for current week, if your store computes it. */
    resolved?: { startTs?: number; endTs?: number };
  };
}

export interface ScheduleWindow {
  /** Start timestamp (ms). For steps that start immediately, equals Date.now() at activation. */
  startAt?: number | string | Date;
  /** Calculated soft/hard timestamps after normalization. */
  softAt?: number;
  dueAt?: number;
  hardAt?: number;
}

/* -----------------------------------------------------------------------------
   TIMELINE ITEM (SESSION / STEP)
----------------------------------------------------------------------------- */

export interface TimelineItem {
  /** Stable id (session:xyz#step:1). */
  id: string;
  /** Domain this item belongs to. */
  domain: DomainType;
  /** Human title shown in banners, cards, and timeline rows. */
  title: string;
  /** Optional longer description. */
  description?: string;

  /** Priority used for ordering and safety scoring. */
  priority?: Priority;
  /** Risk flags influence safety escalation. */
  risk?: RiskFlags;

  /** Labels for search/filter. */
  tags?: string[];

  /** Planned/actual schedule info. */
  schedule?: ScheduleWindow & DeadlineConfig;

  /** Current runtime status. */
  status: TimelineStatus;

  /** Progress from 0..1 for UI bars. */
  progress?: number;

  /** Arbitrary meta: plan reference, indices, context, etc. */
  meta?: {
    sessionId?: string;
    stepIndex?: number;
    planRef?: string;
    householdId?: string;
    /** Arbitrary structured metadata. */
    [k: string]: any;
  };

  /** Guard configuration applied at evaluation time. */
  guards?: GuardAwareConfig;

  /** Per-item favorites metadata for user-saved sessions/schedules. */
  favorite?: FavoriteMeta;

  /** Last computed safety evaluation (cached by orchestrator). */
  lastSafety?: SafetyEvaluation;
}

/* -----------------------------------------------------------------------------
   SAFETY ESCALATION RESULTS (from utils/safetyEscalation.js)
----------------------------------------------------------------------------- */

export type SafetyLevel = "none" | "soft" | "hard";

export interface SafetyScheduleSnapshot {
  softAt: number;
  dueAt: number;
  hardAt: number;
  now: number;
  toSoft: number;
  toDue: number;
  toHard: number;
}

export interface SafetyEvaluation {
  id: string;
  domain: DomainType | "task";
  level: SafetyLevel;
  /** Machine-readable code e.g. "APPROACHING_DEADLINE", "DEADLINE_PASSED", "GUARD_DOWNGRADE_QUIET". */
  code: string;
  /** Humanized reason for UI. */
  reason: string;
  /** 0..10 from heuristic (heat/perishables/priority/animals…). */
  risk: number;
  /** Snapshot used by UI/agents. */
  schedule: SafetyScheduleSnapshot;
  /** NBA suggestions for banners/toasts/agent actions. */
  nextBestActions: NextBestAction[];
  /** Title + meta echo to avoid external lookups in handlers. */
  context: {
    title?: string;
    meta?: TimelineItem["meta"];
  };
  /** Whether guards suppressed hard actions. */
  guards: { quietHours: boolean; sabbath: boolean };
  /** Suggested next re-evaluation tick in ms. */
  nextCheckMs: number;
}

/* -----------------------------------------------------------------------------
   PAUSE POLICIES
----------------------------------------------------------------------------- */

export type PauseReason =
  | "user"
  | "safety"
  | "inventory"
  | "quietHours"
  | "sabbath"
  | "dependency"
  | "system";

export interface PauseDirective {
  /** Whether to pause the whole session or only this item. */
  scope: "item" | "session";
  /** Optional countdown to auto-resume (ms). */
  resumeInMs?: number;
  /** Free-form message for banners/modals. */
  message?: string;
}

export interface PauseDecision {
  /** True if policy decides to pause given context. */
  shouldPause: boolean;
  /** Why policy paused or refused. */
  reason?: PauseReason;
  /** Directive used by orchestrator to apply pause. */
  directive?: PauseDirective;
}

export interface PausePolicyContext {
  item: TimelineItem;
  /** Latest safety evaluation (if any). */
  safety?: SafetyEvaluation;
  /** Aggregate session info (lightweight). */
  session?: {
    id: string;
    status: TimelineStatus;
    domain: DomainType;
    items?: TimelineItem[];
  };
  /** Current guards from store. */
  guards?: GuardAwareConfig;
}

export interface PausePolicy {
  /** Human name for debugging and settings. */
  name: string;

  /** Decide if a pause should be applied (pure/side-effect free). */
  shouldPause(ctx: PausePolicyContext): PauseDecision;

  /** Optional hook to compute resume timing or to transform directive. */
  onBeforePause?(ctx: PausePolicyContext, decision: PauseDecision): PauseDecision;

  /** Programmatic auto-pause used by safetyEscalation when a "hard" occurs. */
  autoPauseForSafety?(evaluation: SafetyEvaluation): void;

  /** Optional method to resolve guard-based requests (quiet/sabbath). */
  shouldAutoPauseForGuard?(ctx: PausePolicyContext): PauseDecision;
}

/* -----------------------------------------------------------------------------
   EVENT BUS PAYLOADS (used by runtime + UI)
----------------------------------------------------------------------------- */

/** Ticker events from dateFormat.makeCountdownTicker(...) */
export interface TimeCountdownTick {
  id: string;                 // e.g., "session:123", "session:123#step:2"
  remainingMs: number;
  label: string;              // already formatted ("04:17 remaining")
  done: boolean;
}
export interface TimeCountdownDone {
  id: string;
}

/** Emitted by safetyEscalation.evaluate(...) */
export type SafetyEscalationEvent = SafetyEvaluation;

/** Emitted when orchestrator applies a safety auto-pause. */
export interface SessionSafetyAutoPause {
  id: string;                 // item/session id
  reason: string;             // code from SafetyEvaluation
}

/* -----------------------------------------------------------------------------
   SCHEDULER PREFS (for Settings pages / DI into evaluators)
----------------------------------------------------------------------------- */

export interface SafetyPrefs {
  /** If no softAt on item, warn this many ms before dueAt. */
  softLeadMs: number;
  /** Default hard grace after dueAt. */
  hardGraceMs: number;
  /** Re-emit min interval for escalation events. */
  cooldownMs: number;
  /** Min tick when in soft window. */
  minTickMs: number;
}

export interface SchedulerPrefs {
  quietHours: GuardWindow;
  sabbathGuard: GuardWindow;
  safety: SafetyPrefs;
  user?: { locale?: string; timeZone?: string; use24h?: boolean | null };
}

/* -----------------------------------------------------------------------------
   HELPER GUARDS (used by calendarSync, SessionRunner, etc.)
----------------------------------------------------------------------------- */

export interface WindowCheckResult {
  /** True if now is inside the guard window. */
  inside: boolean;
  /** Milliseconds until the window ends (if inside) or until it starts (if outside). */
  untilBoundaryMs: number | null;
}

/* -----------------------------------------------------------------------------
   MODULE AUGMENTATION (OPTIONAL) — type the eventBus if you have one
----------------------------------------------------------------------------- */

// Example event map shape; update if you have a typed bus.
export interface SukaEventMap {
  "time:countdown:tick": TimeCountdownTick;
  "time:countdown:done": TimeCountdownDone;
  "safety:escalation": SafetyEscalationEvent;
  "session:safety:autopause": SessionSafetyAutoPause;
}

/* -----------------------------------------------------------------------------
   UTILITY UNIONS FOR UI
----------------------------------------------------------------------------- */

export type TimelineChipKind =
  | "time"
  | "risk"
  | "guard"
  | "priority"
  | "favorite"
  | "status";

export interface TimelineChip {
  kind: TimelineChipKind;
  label: string;
  value?: string | number | boolean;
  tone?: "neutral" | "info" | "warning" | "danger" | "success";
}

/* -----------------------------------------------------------------------------
   FACTORY SIGNATURES (OPTIONAL)
----------------------------------------------------------------------------- */

export interface TimelineFactory {
  fromPlanStep(input: any, context?: Partial<TimelineItem>): TimelineItem;
  normalize(item: TimelineItem): TimelineItem;
}
