/**
 * Suka Smart Assistant (SSA)
 * Agent / Orchestrator / Reasoner Contracts
 * ---------------------------------------------------------------
 * File: src/types/agent.contracts.d.ts
 *
 * Purpose:
 *  - Provide shared type definitions for:
 *      • Agent domains & sessions
 *      • Orchestrator ↔ Reasoner contracts
 *      • SessionRunner integration (session object contract)
 *      • Reverse generation & favorites
 *      • Telemetry envelopes & Hub export
 *      • Swap-modal flows (when users pick which session to run "Now")
 *
 *  - These types are used by:
 *      • agents/*Shim.js (planning / reverse generation)
 *      • orchestrator code (deciding which agent to call)
 *      • reasoner shims (LLM or rules engines)
 *      • UI components that call into agents / orchestrator
 *
 * Notes:
 *  - This is a declaration file only (no runtime code).
 *  - All string unions are intentionally explicit to keep SSA coherent.
 */

declare module "@/types/agent.contracts" {
  /* ------------------------------------------------------------------ */
  /* 1. Core domain enums                                               */
  /* ------------------------------------------------------------------ */

  /** Primary domains covered by SSA agents. */
  export type AgentDomain =
    | "cooking"
    | "cleaning"
    | "garden"
    | "animals"
    | "preservation"
    | "storehouse";

  /** Narrower domain tags if you need more granularity later. */
  export type AgentSubdomain =
    | "batchCooking"
    | "dailyReset"
    | "deepClean"
    | "gardenPlanning"
    | "gardenCare"
    | "harvest"
    | "animalAcquisition"
    | "animalRoutineCare"
    | "animalButchery"
    | "storehouseStockUp"
    | "storehouseRotation"
    | "none";

  /** Where a session originally came from. */
  export type SessionSourceType =
    | "recipe"
    | "cleaningPlan"
    | "gardenPlan"
    | "animalTask"
    | "import"
    | "manual";

  /** Who originated this plan at the agent level. */
  export type OriginKind = "system" | "user" | "reverse";

  /** Domain-specific grocery sections for storehouse plans. */
  export type StorehouseGrocerySection =
    | "produce"
    | "meat+freezer"
    | "dairy"
    | "pantry+baking"
    | "frozen"
    | "household+cleaning"
    | "personalCare"
    | "other";

  /** Session blockers used for guards (Sabbath, Weather, etc.). */
  export type SessionBlocker =
    | "inventory"
    | "weather"
    | "quietHours"
    | "sabbath"
    | "equipment"
    | "deviceBattery"
    | "other";

  /** How doneness / completion is detected for a step. */
  export type DonenessCue =
    | "color"
    | "texture"
    | "probeTemp"
    | "timer"
    | "smell"
    | "visual"
    | "sound"
    | "none";

  /* ------------------------------------------------------------------ */
  /* 2. Session object contract (SessionRunner)                         */
  /* ------------------------------------------------------------------ */

  export interface SessionSourceRef {
    type: SessionSourceType;
    /**
     * Domain-specific identifier, e.g. recipeId, cleaningPlanId,
     * gardenPlanId, butcheryPlanId, external import ID, etc.
     */
    refId: string | null;
  }

  export interface SessionStepMetadata {
    tempTargetF?: number | null;
    donenessCue?: DonenessCue;
    cueNotes?: string | null;

    /** Optional: storehouse + grocery section context, if relevant. */
    storehouseSection?: StorehouseGrocerySection;

    /** Optional: linked inventory IDs that should be present. */
    inventoryItemIds?: string[];

    /** Optional: any domain-specific metadata (garden beds, animals, etc.). */
    [key: string]: unknown;
  }

  export interface SessionStep {
    id: string;
    title: string;
    desc: string;
    durationSec: number;
    blockers: SessionBlocker[];
    metadata: SessionStepMetadata;
  }

  export interface SessionPrefs {
    voiceGuidance: boolean;
    haptic: boolean;
    autoAdvance: boolean;
  }

  export type SessionStatus =
    | "pending"
    | "running"
    | "paused"
    | "completed"
    | "aborted";

  export interface SessionProgress {
    currentStepIndex: number;
    elapsedSec: number;
    startedAt: string | null; // ISO 8601
    pausedAt: string | null;  // ISO 8601
  }

  export interface SessionAnalyticsAdjustment {
    stepId: string;
    kind: "durationChange" | "skip" | "extraStep" | "reorder" | "note";
    from?: unknown;
    to?: unknown;
    note?: string;
  }

  export interface SessionAnalytics {
    /** step IDs that were skipped entirely */
    skippedSteps: string[];
    adjustments: SessionAnalyticsAdjustment[];

    /** optional rating from the user */
    rating?: number | null;
    /** free text notes from the user for reverse generation */
    userNotes?: string | null;
  }

  /**
   * Minimum viable Session contract used by SessionRunner, agents, and orchestrator.
   */
  export interface SessionObject {
    id: string;
    domain: AgentDomain;
    title: string;
    source: SessionSourceRef;
    steps: SessionStep[];
    prefs: SessionPrefs;
    status: SessionStatus;
    progress: SessionProgress;
    analytics: SessionAnalytics;
    createdAt: string; // ISO
    updatedAt: string; // ISO

    /**
     * Optional: tags used by agents & UI filters.
     * Examples: ["batch", "soup", "winter", "kitchenReset"]
     */
    tags?: string[];

    /**
     * Origin & favorite state to line up with agent telemetry.
     */
    origin?: OriginKind;
    isTemplate?: boolean;
    isFavorite?: boolean;
    favoriteOwnerId?: string | null;

    /**
     * Optional additional context for domain-specific flows (garden, animals, storehouse, etc.).
     */
    context?: Record<string, unknown>;
  }

  /* ------------------------------------------------------------------ */
  /* 3. Agent-level Sessions & Schedules (planning artifacts)           */
  /* ------------------------------------------------------------------ */

  export interface AgentSession extends SessionObject {
    /**
     * When an agent is the primary author of the session, agent metadata can live here.
     */
    agentMeta?: {
      agentId?: string;
      /**
       * Heuristic score or confidence of the plan (0–1).
       */
      confidence?: number;
      /**
       * Why the agent proposed this plan.
       * Example: "use up overripe bananas + Sunday afternoon batch window"
       */
      rationale?: string;
    };
  }

  export type ScheduleBlockFirmness = "soft" | "hard";

  export interface AgentScheduleBlock {
    id: string;
    sessionId: string;
    fromTs: string; // ISO
    toTs: string;   // ISO
    firmness: ScheduleBlockFirmness;
  }

  export interface AgentSchedule {
    id: string;
    title: string;
    domains: AgentDomain[];
    origin: OriginKind;
    isFavorite: boolean;
    favoriteOwnerId: string | null;
    blocks: AgentScheduleBlock[];
    meta: {
      /**
       * Sabbath / rest guard applied.
       */
      sabbathGuardApplied?: boolean;
      /**
       * High-level theme for UX:
       * e.g. "homestead-day", "kitchen-reset", "storehouse-stock-up"
       */
      theme?: string;
      /**
       * Storehouse grocery sections touched by this schedule.
       */
      grocerySections?: StorehouseGrocerySection[];
      /**
       * Additional arbitrary metadata.
       */
      [key: string]: unknown;
    };
  }

  /* ------------------------------------------------------------------ */
  /* 4. Reasoner & Orchestrator Contracts                               */
  /* ------------------------------------------------------------------ */

  /** How the orchestrator is invoking the reasoner. */
  export type ReasonerInvocationMode = "forward" | "reverse" | "repair";

  /** Why the orchestrator is invoking the reasoner. */
  export type OrchestratorReason =
    | "user.request"
    | "automation.trigger"
    | "session.resume"
    | "reverse.template.fromHistory"
    | "repair.invalidSession"
    | "other";

  /**
   * Guards the orchestrator can consider when deciding if a session is runnable.
   */
  export interface OrchestratorGuardContext {
    sabbathGuardEnabled: boolean;
    quietHoursGuardEnabled: boolean;
    weatherGuardEnabled: boolean;
    inventoryGuardEnabled: boolean;
    batteryGuardEnabled?: boolean;

    /**
     * If available, domain-specific guard hints.
     */
    hints?: Record<string, unknown>;
  }

  /**
   * High-level planning request that the orchestrator sends to a Reasoner shim.
   */
  export interface ReasonerRequest {
    id: string;
    mode: ReasonerInvocationMode;
    domain: AgentDomain;
    subdomain?: AgentSubdomain;
    reason: OrchestratorReason;

    /**
     * User context for personalization.
     */
    user: {
      id: string;
      householdId?: string;
      timezone?: string;
      locale?: string;
    };

    /**
     * Time window or anchor for planning.
     */
    timeWindow?: {
      fromTs?: string;
      toTs?: string;
      anchorTs?: string;
    };

    /**
     * Constraints to respect (time budget, sabbath, quiet hours, etc.).
     */
    constraints?: {
      timeBudgetMinutes?: number;
      maxSimultaneousTimers?: number;
      sabbathSafe?: boolean;
      quietHoursSafe?: boolean;
      /**
       * If meal-related, desired meals per day etc.
       */
      mealsPerDay?: number;
      /**
       * Other domain-specific constraints.
       */
      [key: string]: unknown;
    };

    /**
     * Links to external systems & snapshots for context.
     */
    links?: {
      inventorySnapshotId?: string;
      calendarWindowId?: string;
      recipeVaultId?: string;
      batchQueueId?: string;
      gardenContextId?: string;
      animalsContextId?: string;
      storehouseContextId?: string;
      /**
       * Any other domain-specific references.
       */
      [key: string]: unknown;
    };

    /**
     * Optional: for reverse generation, specify which history sources to use.
     */
    reverseGenerationSources?: ReverseGenerationSource[];

    /**
     * Raw input or prompt from UI (e.g. user typed goals).
     */
    goals?: string[];
    freeText?: string | null;
  }

  export interface ReverseGenerationSource {
    kind: "session.history" | "calendar.history" | "import.patterns";
    ids: string[];
  }

  export interface ReasonerPlanMeta {
    /**
     * Confidently applied sabbath guard?
     */
    sabbathGuardApplied?: boolean;
    /**
     * Did we consider inventory shortage signals?
     */
    usedInventoryShortages?: boolean;
    /**
     * Any domains beyond the primary that we consulted.
     */
    crossDomainConsulted?: AgentDomain[];
    /**
     * Arbitrary metadata for debugging / analytics.
     */
    [key: string]: unknown;
  }

  export interface ReasonerResponse {
    id: string;
    requestId: string;
    domain: AgentDomain;
    mode: ReasonerInvocationMode;
    sessions: AgentSession[];
    schedules: AgentSchedule[];
    inferredPreferences?: Record<string, unknown>;
    meta?: ReasonerPlanMeta;
    /**
     * Optional: textual explanation for UI (e.g. “why this plan?”).
     */
    rationale?: string;
  }

  /**
   * Error scenario from the Reasoner.
   */
  export interface ReasonerError {
    id: string;
    requestId: string;
    domain: AgentDomain;
    mode: ReasonerInvocationMode;
    errorCode: string;
    message: string;
    /**
     * Additional debugging data (never shown directly to end user).
     */
    debug?: Record<string, unknown>;
  }

  /* ------------------------------------------------------------------ */
  /* 5. Swap Modal & Selection Contracts                                */
  /* ------------------------------------------------------------------ */

  /**
   * How the orchestrator ranks sessions when deciding “Next runnable session”.
   */
  export interface RunnableSessionScore {
    sessionId: string;
    domain: AgentDomain;
    score: number;
    /**
     * Short reasons for UI (“uses up wilting greens”, “fits 20-minute window”).
     */
    reasons?: string[];
  }

  /**
   * Option displayed in the “Swap / Choose Session” modal when the user hits “Now”.
   * This is purely data; UI uses it to render a friendly chooser that
   * can still run in the background after navigation.
   */
  export interface SessionSwapOption {
    session: AgentSession;
    runnableScore: RunnableSessionScore;
    /**
     * Whether all known guards pass (Sabbath, quiet hours, etc.).
     */
    guardsPass: boolean;
    /**
     * If false, this reason can be surfaced to help user understand why.
     */
    guardsFailureReason?: string | null;
  }

  /**
   * State object powering the swap modal / selector.
   */
  export interface SessionSwapModalState {
    isOpen: boolean;
    /**
     * Domain for which the user hit “Now”.
     */
    domain: AgentDomain;
    /**
     * Candidate sessions (possibly mixed origin: system/user/reverse).
     */
    options: SessionSwapOption[];
    /**
     * The ID of the currently highlighted or default option.
     */
    highlightedSessionId: string | null;
  }

  /**
   * High-level strategies the orchestrator can apply when auto-selecting.
   */
  export type SessionSwapStrategy =
    | "highestScore"
    | "recentlyUsed"
    | "favoriteFirst"
    | "userLastChoice";

  /* ------------------------------------------------------------------ */
  /* 6. Telemetry Event Envelopes (Orchestrator / Reasoner perspective) */
  /* ------------------------------------------------------------------ */

  /** Base shape for all telemetry events. */
  export interface SSAEventBase<Data = unknown> {
    type: string;
    ts: string;      // ISO 8601
    source: string;  // e.g. "agents/meals/mealShim", "ui/sessionRunner"
    data: Data;
  }

  /* Agent events (see events.md) */

  export interface AgentInvokedEventData {
    domain: AgentDomain;
    agentId: string;
    mode: ReasonerInvocationMode;
    reason: OrchestratorReason;
    input: ReasonerRequest;
  }

  export type AgentInvokedEvent = SSAEventBase<AgentInvokedEventData> & {
    type: "agent.invoked";
  };

  export interface AgentPlanGeneratedEventData {
    domain: AgentDomain;
    agentId: string;
    mode: ReasonerInvocationMode;
    sessions: AgentSession[];
    schedules: AgentSchedule[];
    meta?: ReasonerPlanMeta;
  }

  export type AgentPlanGeneratedEvent = SSAEventBase<AgentPlanGeneratedEventData> & {
    type: "agent.plan.generated";
  };

  export interface AgentPlanFailedEventData {
    domain: AgentDomain;
    agentId: string;
    mode: ReasonerInvocationMode;
    errorCode: string;
    message: string;
    debug?: Record<string, unknown>;
  }

  export type AgentPlanFailedEvent = SSAEventBase<AgentPlanFailedEventData> & {
    type: "agent.plan.failed";
  };

  export interface AgentSessionGeneratedEventData {
    domain: AgentDomain;
    session: AgentSession;
  }

  export type AgentSessionGeneratedEvent = SSAEventBase<AgentSessionGeneratedEventData> & {
    type: "agent.session.generated";
  };

  export interface AgentSessionUserCreatedEventData {
    domain: AgentDomain;
    userId: string;
    session: AgentSession;
  }

  export type AgentSessionUserCreatedEvent =
    SSAEventBase<AgentSessionUserCreatedEventData> & {
      type: "agent.session.userCreated";
    };

  export interface AgentScheduleGeneratedEventData {
    domain: AgentDomain;
    schedule: AgentSchedule;
  }

  export type AgentScheduleGeneratedEvent =
    SSAEventBase<AgentScheduleGeneratedEventData> & {
      type: "agent.schedule.generated";
    };

  export interface AgentScheduleUserCreatedEventData {
    userId: string;
    schedule: AgentSchedule;
  }

  export type AgentScheduleUserCreatedEvent =
    SSAEventBase<AgentScheduleUserCreatedEventData> & {
      type: "agent.schedule.userCreated";
    };

  export interface AgentSessionFavoriteEventData {
    domain: AgentDomain;
    userId: string;
    sessionId: string;
    previousFavoriteState: boolean;
    newFavoriteState: boolean;
    origin: OriginKind;
  }

  export type AgentSessionFavoriteSavedEvent =
    SSAEventBase<AgentSessionFavoriteEventData> & {
      type: "agent.session.favorite.saved";
    };

  export type AgentSessionFavoriteRemovedEvent =
    SSAEventBase<AgentSessionFavoriteEventData> & {
      type: "agent.session.favorite.removed";
    };

  export interface AgentScheduleFavoriteEventData {
    userId: string;
    scheduleId: string;
    previousFavoriteState: boolean;
    newFavoriteState: boolean;
  }

  export type AgentScheduleFavoriteSavedEvent =
    SSAEventBase<AgentScheduleFavoriteEventData> & {
      type: "agent.schedule.favorite.saved";
    };

  export type AgentScheduleFavoriteRemovedEvent =
    SSAEventBase<AgentScheduleFavoriteEventData> & {
      type: "agent.schedule.favorite.removed";
    };

  export interface AgentReverseGenerationRequestedEventData {
    domain: AgentDomain;
    agentId: string;
    userId: string;
    sourceWindow: {
      fromTs: string;
      toTs: string;
    };
    sources: ReverseGenerationSource[];
    goal: string;
  }

  export type AgentReverseGenerationRequestedEvent =
    SSAEventBase<AgentReverseGenerationRequestedEventData> & {
      type: "agent.reverseGeneration.requested";
    };

  export interface AgentReverseGenerationCompletedEventData {
    domain: AgentDomain;
    agentId: string;
    userId: string;
    createdSessions: AgentSession[];
    createdSchedules: AgentSchedule[];
    inferredPreferences?: Record<string, unknown>;
  }

  export type AgentReverseGenerationCompletedEvent =
    SSAEventBase<AgentReverseGenerationCompletedEventData> & {
      type: "agent.reverseGeneration.completed";
    };

  export interface AgentReverseGenerationFailedEventData {
    domain: AgentDomain;
    agentId: string;
    userId: string;
    errorCode: string;
    message: string;
    sources: ReverseGenerationSource[];
  }

  export type AgentReverseGenerationFailedEvent =
    SSAEventBase<AgentReverseGenerationFailedEventData> & {
      type: "agent.reverseGeneration.failed";
    };

  /* SessionRunner events */

  export interface SessionStartedEventData {
    session: SessionObject;
  }

  export type SessionStartedEvent = SSAEventBase<SessionStartedEventData> & {
    type: "session.started" | "session.runner.started";
  };

  export interface SessionStepChangedEventData {
    sessionId: string;
    previousStepId: string | null;
    currentStepId: string;
    currentStepIndex: number;
  }

  export type SessionStepChangedEvent =
    SSAEventBase<SessionStepChangedEventData> & {
      type: "session.step.changed";
    };

  export interface SessionPausedEventData {
    sessionId: string;
    atStepId: string;
  }

  export type SessionPausedEvent = SSAEventBase<SessionPausedEventData> & {
    type: "session.paused";
  };

  export interface SessionResumedEventData {
    sessionId: string;
    atStepId: string;
  }

  export type SessionResumedEvent = SSAEventBase<SessionResumedEventData> & {
    type: "session.resumed";
  };

  export interface SessionCompletedEventData {
    session: SessionObject;
  }

  export type SessionCompletedEvent = SSAEventBase<SessionCompletedEventData> & {
    type: "session.completed" | "session.runner.completed";
  };

  export interface SessionAbortedEventData {
    session: SessionObject;
    reason: string;
  }

  export type SessionAbortedEvent = SSAEventBase<SessionAbortedEventData> & {
    type: "session.aborted" | "session.runner.aborted";
  };

  export interface SessionExportedEventData {
    sessionId: string;
    hubPacketId: string;
  }

  export type SessionExportedEvent = SSAEventBase<SessionExportedEventData> & {
    type: "session.exported";
  };

  /** Discriminated union for agent-related events the orchestrator cares about. */
  export type AgentEvent =
    | AgentInvokedEvent
    | AgentPlanGeneratedEvent
    | AgentPlanFailedEvent
    | AgentSessionGeneratedEvent
    | AgentSessionUserCreatedEvent
    | AgentScheduleGeneratedEvent
    | AgentScheduleUserCreatedEvent
    | AgentSessionFavoriteSavedEvent
    | AgentSessionFavoriteRemovedEvent
    | AgentScheduleFavoriteSavedEvent
    | AgentScheduleFavoriteRemovedEvent
    | AgentReverseGenerationRequestedEvent
    | AgentReverseGenerationCompletedEvent
    | AgentReverseGenerationFailedEvent;

  /** Discriminated union for session runner events. */
  export type SessionRunnerEvent =
    | SessionStartedEvent
    | SessionStepChangedEvent
    | SessionPausedEvent
    | SessionResumedEvent
    | SessionCompletedEvent
    | SessionAbortedEvent
    | SessionExportedEvent;

  /* ------------------------------------------------------------------ */
  /* 7. Hub Export Envelope                                             */
  /* ------------------------------------------------------------------ */

  export interface HubExportEnvelope<TPayload = unknown> {
    /**
     * High-level export type, e.g. "session.analytics", "usage.counters",
     * "agent.plan", etc.
     */
    kind: string;
    /**
     * Household ID or Hub membership key.
     */
    householdId: string;
    /**
     * ISO timestamp of export.
     */
    exportedAt: string;
    /**
     * Payload being exported.
     */
    payload: TPayload;
    /**
     * Optional metadata for routing on the Hub side.
     */
    meta?: Record<string, unknown>;
  }
}
