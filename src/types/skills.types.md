# Suka Smart Assistant (SSA) – Skill Types & I/O Contracts

**File:** `src/types/skills.types.md`  
**Purpose:** Canonical reference for **skill function I/O shapes** used by:

- SessionRunner (cooking, cleaning, garden, animals, preservation, storehouse)
- Orchestrator / Reasoner shims
- Domain pages (“Now” CTAs + swap modal)
- Automation runtime & Hub export logic

This document is **design + types** only. Runtime implementation lives in `src/skills/*.js` (or similar).  
TypeScript snippets below are **expected shapes**, not enforced here — mirror them in your `.d.ts` files.

---

## 0. Imports & Shared Types

Skills must reuse the shared contracts declared in:

- `src/types/agent.contracts.d.ts` (module: `"@/types/agent.contracts"`)

Key types:

```ts
import type {
  AgentDomain,
  AgentSubdomain,
  AgentSession,
  AgentSchedule,
  SessionObject,
  SessionSwapOption,
  SessionSwapModalState,
  SessionSwapStrategy,
  OrchestratorGuardContext,
  ReasonerRequest,
  ReasonerResponse,
  ReasonerError,
  HubExportEnvelope,
} from "@/types/agent.contracts";
1. Conventions
All skills share these conventions:

Function signature (conceptual):

ts
Copy code
type Skill<Input, Output> = (input: Input) => Promise<Output>;
Required fields on inputs:

userId: string

domain: AgentDomain (when domain-scoped)

No direct DOM / React access: skills are pure logic & data.

Event bus use happens in caller; skills may emit events indirectly via helpers, but I/O here is data only.

2. Session Discovery & “Now” Routing Skills
These skills power the “Now” buttons on domain pages and the swap modal that lets the user choose which session to run.

2.1 findNextRunnableSessions
Find and score candidate sessions for a domain (cooking, cleaning, garden, animals, preservation, storehouse).

ts
Copy code
export interface FindNextRunnableSessionsInput {
  userId: string;
  domain: AgentDomain;
  /** Optional narrower hint (e.g. "batchCooking", "gardenCare"). */
  subdomain?: AgentSubdomain;
  /** Strategy used to rank sessions in the swap modal. */
  strategy?: SessionSwapStrategy;
  /** Current time; used for guard evaluation & ranking. */
  nowTs?: string; // ISO
  /** Guard context (Sabbath, quiet hours, weather, inventory, battery). */
  guards?: OrchestratorGuardContext;
  /**
   * Optional: restrict to favorites or templates only.
   */
  filters?: {
    favoritesOnly?: boolean;
    templatesOnly?: boolean;
  };
}

export interface FindNextRunnableSessionsOutput {
  /** All viable candidates with scores & guard status. */
  options: SessionSwapOption[];
  /** ID of the recommended default session (may be null if none). */
  recommendedSessionId: string | null;
  /** State object that can be handed directly to SessionSwapModal. */
  modalState: SessionSwapModalState;
}

export type FindNextRunnableSessionsSkill =
  Skill<FindNextRunnableSessionsInput, FindNextRunnableSessionsOutput>;
Domain flavor:

For storehouse, bias sessions that cover needed grocery sections (produce, meat+freezer, etc.).

For garden, prefer sessions aligned with current season & harvest windows.

For animals, include animalAcquisition, animalRoutineCare, animalButchery sessions.

2.2 loadSessionById
Load a session with all steps and context for use by SessionRunner.

ts
Copy code
export interface LoadSessionByIdInput {
  userId: string;
  sessionId: string;
}

export interface LoadSessionByIdOutput {
  session: SessionObject | null;
  /** If null, an error message explaining why. */
  error?: string;
}

export type LoadSessionByIdSkill = Skill<
  LoadSessionByIdInput,
  LoadSessionByIdOutput
>;
3. Planning Skills (Forward & Reverse)
Planning skills sit on top of Reasoner / agent shims and return AgentSessions and AgentSchedules.

3.1 planSessionsForward
High-level planning entrypoint for cooking, cleaning, garden, animals, preservation, storehouse.

ts
Copy code
export interface PlanSessionsForwardInput {
  userId: string;
  request: ReasonerRequest; // includes domain, subdomain, constraints, links, etc.
}

export interface PlanSessionsForwardOutput {
  response: ReasonerResponse | null;
  error?: ReasonerError;
}

export type PlanSessionsForwardSkill = Skill<
  PlanSessionsForwardInput,
  PlanSessionsForwardOutput
>;
Examples:

Cooking: “Batch-cook dinners for 3 days using garden greens + freezer meats.”

Cleaning: “Daily evening kitchen reset + weekly bathroom deep clean.”

Garden: “Plan fall bed prep & harvest for current week.”

Animals: “Weekly goat care + scheduled butchery day.”

Storehouse: “Monthly stock-up by grocery section.”

3.2 planSessionsReverseFromHistory
Reverse generation skill: derive templates & schedules from real usage.

ts
Copy code
export interface PlanSessionsReverseFromHistoryInput {
  userId: string;
  request: ReasonerRequest; // mode: "reverse", with reverseGenerationSources filled
}

export interface PlanSessionsReverseFromHistoryOutput {
  response: ReasonerResponse | null;
  error?: ReasonerError;
}

export type PlanSessionsReverseFromHistorySkill = Skill<
  PlanSessionsReverseFromHistoryInput,
  PlanSessionsReverseFromHistoryOutput
>;
Use cases:

Detect repeated “Homestead Saturday” (garden + animals + meals) and create a reusable schedule.

Detect repeated weekly goat care and produce a named template.

Detect repeated storehouse stock rotation patterns.

4. Favorites & Template Skills
These skills support user-saved favorites for sessions and schedules (system + user + reverse).

4.1 toggleSessionFavorite
ts
Copy code
export interface ToggleSessionFavoriteInput {
  userId: string;
  sessionId: string;
  /** Desired favorite state; if omitted, toggles. */
  isFavorite?: boolean;
}

export interface ToggleSessionFavoriteOutput {
  session: AgentSession | null;
  /** Updated favorite state, or null if not found. */
  isFavorite: boolean | null;
  error?: string;
}

export type ToggleSessionFavoriteSkill = Skill<
  ToggleSessionFavoriteInput,
  ToggleSessionFavoriteOutput
>;
4.2 toggleScheduleFavorite
ts
Copy code
export interface ToggleScheduleFavoriteInput {
  userId: string;
  scheduleId: string;
  isFavorite?: boolean;
}

export interface ToggleScheduleFavoriteOutput {
  schedule: AgentSchedule | null;
  isFavorite: boolean | null;
  error?: string;
}

export type ToggleScheduleFavoriteSkill = Skill<
  ToggleScheduleFavoriteInput,
  ToggleScheduleFavoriteOutput
>;
4.3 listFavorites
Return favorite sessions & schedules, optionally filtered by domain.

ts
Copy code
export interface ListFavoritesInput {
  userId: string;
  domain?: AgentDomain;
}

export interface ListFavoritesOutput {
  sessions: AgentSession[];
  schedules: AgentSchedule[];
}

export type ListFavoritesSkill = Skill<
  ListFavoritesInput,
  ListFavoritesOutput
>;
5. Guard Evaluation Skills
Guards keep sessions from running in bad conditions (Sabbath, quiet hours, weather, inventory, battery).

5.1 evaluateGuardsForSession
ts
Copy code
export type GuardId =
  | "sabbath"
  | "quietHours"
  | "weather"
  | "inventory"
  | "equipment"
  | "deviceBattery";

export interface GuardResult {
  guardId: GuardId;
  /** true = this guard passes; false = blocked. */
  pass: boolean;
  /** Short message suitable for UI. */
  message?: string;
}

export interface EvaluateGuardsForSessionInput {
  userId: string;
  session: SessionObject;
  /** Context controlling which guards are active. */
  context: OrchestratorGuardContext;
}

export interface EvaluateGuardsForSessionOutput {
  results: GuardResult[];
  /** All guards pass when this is true. */
  allPass: boolean;
}

export type EvaluateGuardsForSessionSkill = Skill<
  EvaluateGuardsForSessionInput,
  EvaluateGuardsForSessionOutput
>;
Domain examples:

Garden session blocked by weather (storm, extreme heat).

Animal butchery session restricted by quietHours or local rules.

Storehouse stock-up blocked by inventory guard (missing funds / items?).

6. Session Lifecycle & Analytics Skills
Skills that help SessionRunner persist checkpoints, update status, and write analytics.

6.1 saveSessionCheckpoint
ts
Copy code
export interface SaveSessionCheckpointInput {
  userId: string;
  session: SessionObject;
}

export interface SaveSessionCheckpointOutput {
  /** The stored session object after persistence. */
  session: SessionObject;
}

export type SaveSessionCheckpointSkill = Skill<
  SaveSessionCheckpointInput,
  SaveSessionCheckpointOutput
>;
Called:

after every step transition

every 10s while running

on pause / resume / status change

6.2 updateSessionStatus
ts
Copy code
export interface UpdateSessionStatusInput {
  userId: string;
  sessionId: string;
  status: "pending" | "running" | "paused" | "completed" | "aborted";
  /** Optional analytics update alongside status change. */
  analyticsPatch?: Partial<SessionObject["analytics"]>;
}

export interface UpdateSessionStatusOutput {
  session: SessionObject | null;
  error?: string;
}

export type UpdateSessionStatusSkill = Skill<
  UpdateSessionStatusInput,
  UpdateSessionStatusOutput
>;
6.3 recordSessionAnalytics
Called once at the end of a run (completed/aborted) to write durable analytics.

ts
Copy code
export interface RecordSessionAnalyticsInput {
  userId: string;
  session: SessionObject;
}

export interface RecordSessionAnalyticsOutput {
  success: boolean;
  error?: string;
}

export type RecordSessionAnalyticsSkill = Skill<
  RecordSessionAnalyticsInput,
  RecordSessionAnalyticsOutput
>;
7. Hub Export Skills
Export completed / aborted sessions and/or usage stats to the Hub when familyFundMode === true.

7.1 exportSessionToHubIfEnabled
ts
Copy code
export interface ExportSessionToHubIfEnabledInput {
  userId: string;
  householdId: string;
  session: SessionObject;
  /** Optional extra analytics / context to include. */
  analytics?: Record<string, unknown>;
}

export interface ExportSessionToHubIfEnabledOutput {
  /** true if an export was attempted AND succeeded; false otherwise. */
  exported: boolean;
  /** Hub packet ID if successful. */
  hubPacketId?: string;
  /** If export was attempted but failed, a reason (not surfaced to user). */
  error?: string;
  /** Full envelope that was sent (or would have been sent). */
  envelope: HubExportEnvelope;
}

export type ExportSessionToHubIfEnabledSkill = Skill<
  ExportSessionToHubIfEnabledInput,
  ExportSessionToHubIfEnabledOutput
>;
When export succeeds, SessionRunner will emit session.exported with { sessionId, hubPacketId }.

8. Engagement Skills (Wake Lock, Notifications, TTS, Media Session, PiP)
These skills encapsulate browser/OS-specific engagement features so SessionRunner’s core logic stays clean and testable.

Note: Implementations will mostly live in browser-only modules; I/O is still defined here.

8.1 ensureWakeLock
ts
Copy code
export interface EnsureWakeLockInput {
  sessionId: string;
}

export interface EnsureWakeLockOutput {
  supported: boolean;
  acquired: boolean;
  /** Call this when session fully ends. */
  releaseHandle?: () => Promise<void> | void;
}

export type EnsureWakeLockSkill = Skill<
  EnsureWakeLockInput,
  EnsureWakeLockOutput
>;
8.2 configureOngoingNotification
ts
Copy code
export interface ConfigureOngoingNotificationInput {
  sessionId: string;
  stepTitle: string;
  /** e.g. "Step 2 of 7 – Simmer soup (20 min left)". */
  subtitle: string;
  /**
   * Can be used by Service Worker notification actions ("pause", "next").
   */
  actions?: Array<{
    action: "pause" | "next";
    title: string;
  }>;
}

export interface ConfigureOngoingNotificationOutput {
  supported: boolean;
  shown: boolean;
  error?: string;
}

export type ConfigureOngoingNotificationSkill = Skill<
  ConfigureOngoingNotificationInput,
  ConfigureOngoingNotificationOutput
>;
8.3 speakStepWithTTS
ts
Copy code
export interface SpeakStepWithTTSInput {
  sessionId: string;
  step: SessionStep;
  /** Optional override text; falls back to step.title + step.desc. */
  textOverride?: string;
  /** If true, cancel any in-progress speech before speaking. */
  interrupt?: boolean;
}

export interface SpeakStepWithTTSOutput {
  supported: boolean;
  spoken: boolean;
  error?: string;
}

export type SpeakStepWithTTSSkill = Skill<
  SpeakStepWithTTSInput,
  SpeakStepWithTTSOutput
>;
8.4 configureMediaSessionControls
ts
Copy code
export interface ConfigureMediaSessionControlsInput {
  sessionId: string;
  /** Displayed as media title (e.g., "Batch Soup Session"). */
  title: string;
  /** Optional step name as “artist” field like label. */
  stepTitle?: string;
}

export interface ConfigureMediaSessionControlsOutput {
  supported: boolean;
}

export type ConfigureMediaSessionControlsSkill = Skill<
  ConfigureMediaSessionControlsInput,
  ConfigureMediaSessionControlsOutput
>;
8.5 openSessionPictureInPicture
For Document Picture-in-Picture mini-HUD (Chromium desktop).

ts
Copy code
export interface OpenSessionPictureInPictureInput {
  sessionId: string;
  /** Optional initial text to display in PiP header/body. */
  title: string;
  subtitle?: string;
}

export interface OpenSessionPictureInPictureOutput {
  supported: boolean;
  opened: boolean;
  /** Optional function to close PiP programmatically. */
  closeHandle?: () => Promise<void> | void;
  error?: string;
}

export type OpenSessionPictureInPictureSkill = Skill<
  OpenSessionPictureInPictureInput,
  OpenSessionPictureInPictureOutput
>;
9. Swap Modal Helper Skills
These skills act as helpers for the swap modal that appears when multiple sessions are runnable for a given domain.

9.1 buildSwapModalState
ts
Copy code
export interface BuildSwapModalStateInput {
  domain: AgentDomain;
  options: SessionSwapOption[];
  /**
   * Optional strategy for which session is highlighted by default.
   * - "favoriteFirst": prefer favorites
   * - "highestScore": prefer highest runnable score
   * - "recentlyUsed": prefer last-run choice
   */
  strategy?: SessionSwapStrategy;
  /** Optional last chosen sessionId for "userLastChoice" strategy. */
  lastChosenSessionId?: string | null;
}

export interface BuildSwapModalStateOutput {
  state: SessionSwapModalState;
}

export type BuildSwapModalStateSkill = Skill<
  BuildSwapModalStateInput,
  BuildSwapModalStateOutput
>;
9.2 applySwapSelection
When user picks a session from the swap modal, this skill returns the chosen session and any analytics tags.

ts
Copy code
export interface ApplySwapSelectionInput {
  userId: string;
  state: SessionSwapModalState;
  chosenSessionId: string;
}

export interface ApplySwapSelectionOutput {
  /** The chosen session ready to be passed to SessionRunner. */
  session: AgentSession | null;
  error?: string;
  /**
   * Tags for analytics / reverse generation.
   * Example:
   *   { reason: "favoriteFirst", domain: "meals", source: "swapModal" }
   */
  analyticsTags?: Record<string, unknown>;
}

export type ApplySwapSelectionSkill = Skill<
  ApplySwapSelectionInput,
  ApplySwapSelectionOutput
>;
10. Domain-Specific Planning Inputs (Optional Extensions)
You can define domain-specific skill input aliases for richer hints.

10.1 Meal Planning
ts
Copy code
export interface MealPlanningHints {
  /** Meals per day; e.g., 2 = lunch & dinner only. */
  mealsPerDay?: number;
  /** Use garden harvest if available. */
  useGardenHarvest?: boolean;
  /** Favor storehouse sections to deplete first. */
  prioritizeSections?: StorehouseGrocerySection[];
  /** Blacklist ingredients or allergens. */
  avoidIngredients?: string[];
}
10.2 Garden Planning & Harvest
ts
Copy code
export interface GardenPlanningHints {
  season?: "spring" | "summer" | "fall" | "winter";
  /** Specific beds to prioritize. */
  bedIds?: string[];
  /** Crops to focus on (by name or id). */
  crops?: string[];
}
10.3 Animals (Acquisition, Care, Butchery)
ts
Copy code
export interface AnimalPlanningHints {
  /** "goats", "sheep", "chickens", etc. */
  species?: string[];
  /** true = include butchery sessions; false = care only. */
  includeButchery?: boolean;
  /** true = include acquisition tasks (buy/adopt). */
  includeAcquisition?: boolean;
}
These hint objects can be embedded inside ReasonerRequest.constraints or passed to domain-specific skills.

11. Summary
Skills are pure, async functions with well-defined input/output shapes.

SessionRunner, agents, and orchestrator all speak the same language using:

AgentDomain, SessionObject, AgentSession, AgentSchedule

SessionSwapOption & SessionSwapModalState

ReasonerRequest & ReasonerResponse

Domain behavior (cleaning, garden, storehouse, meals, animals, preservation) is expressed through:

domain, subdomain, context hints, and tags.

Favorites & reverse generation are first-class citizens via dedicated skills.

When adding a new skill:

Add its Input/Output interfaces and a Skill<Input, Output> alias here.

Implement it in src/skills/*.js.

Wire it into orchestrator / SessionRunner in a way that keeps UI simple: every domain page gets a clear “Now” button backed by these skills.

ts
Copy code
// Generic helper, conceptually used across this document:
export type Skill<Input, Output> = (input: Input) => Promise<Output>;
