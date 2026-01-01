// src/types/events.d.ts
// Central Event Map + typed EventBus for Suka Smart Assistant.
// Works with JS runtime (EventEmitter3) while giving TS/JS IntelliSense via // @ts-check.
//
// Design:
// - One canonical EventMap keyed by "domain:topic[:verb]" strings
// - Re-usable shared shapes for ids, timeline, NBA, safety, etc.
// - Lightweight EventBus interface: on/off/once/emit with strong typing
// - Module augmentation for "@/services/automation/runtime" so `automation.eventBus` is typed

import type {
  TimelineItem,
  SafetyEvaluation,
  TimeCountdownTick,
  TimeCountdownDone,
  SessionSafetyAutoPause,
  NextBestAction,
  SchedulerPrefs,
} from "./scheduler";

/* -------------------------------------------------------------------------- */
/* Shared primitives                                                          */
/* -------------------------------------------------------------------------- */

export type ID = string;
export type ISODate = string;     // e.g., "2025-10-27T16:23:11.000Z"
export type MsEpoch = number;     // Date.now()
export type DomainType =
  | "cooking"
  | "cleaning"
  | "garden"
  | "animals"
  | "inventory"
  | "tasks"
  | "susu"
  | "other";

export interface ErrorPayload {
  message: string;
  code?: string;
  stack?: string;
  cause?: unknown;
  meta?: Record<string, any>;
}

/* -------------------------------------------------------------------------- */
/* Favorites & Templates                                                      */
/* -------------------------------------------------------------------------- */

export interface FavoriteSaved {
  id: ID;                           // favorite id (or template id if same)
  ownerId?: ID;                     // user/household
  kind: "session" | "schedule" | "template";
  name?: string;
  sourceRef?: string;               // planRef/templateId
  createdAt: MsEpoch;
  meta?: Record<string, any>;       // overrides, notes, tags
}

export interface FavoriteRemoved {
  id: ID;
  kind: "session" | "schedule" | "template";
  removedAt: MsEpoch;
}

export interface TemplateChosen {
  id: ID;                           // template id
  domain: DomainType;
  name?: string;
  context?: Record<string, any>;    // where it was picked (page, filter)
}

/* -------------------------------------------------------------------------- */
/* Scheduler & Sessions                                                       */
/* -------------------------------------------------------------------------- */

export interface SessionCreated {
  id: ID;                           // session id
  domain: DomainType;
  title: string;
  items: TimelineItem[];
  createdAt: MsEpoch;
  source?: { templateId?: ID; favoriteId?: ID; planRef?: string };
}

export interface SessionStarted {
  id: ID;
  startedAt: MsEpoch;
}

export interface SessionResumed {
  id: ID;
  resumedAt: MsEpoch;
}

export interface SessionPaused {
  id: ID;
  reason:
    | "user"
    | "safety"
    | "inventory"
    | "quietHours"
    | "sabbath"
    | "dependency"
    | "system";
  message?: string;
  pausedAt: MsEpoch;
}

export interface SessionCompleted {
  id: ID;
  completedAt: MsEpoch;
}

export interface SessionCanceled {
  id: ID;
  canceledAt: MsEpoch;
  reason?: string;
}

export interface StepStarted {
  id: ID;                           // item id (session:xyz#step:n)
  sessionId: ID;
  startedAt: MsEpoch;
  index?: number;
  item?: TimelineItem;
}

export interface StepProgress {
  id: ID;
  sessionId: ID;
  progress: number;                 // 0..1
  updatedAt: MsEpoch;
}

export interface StepCompleted {
  id: ID;
  sessionId: ID;
  completedAt: MsEpoch;
  result?: Record<string, any>;
}

export interface StepErrored {
  id: ID;
  sessionId: ID;
  error: ErrorPayload;
  at: MsEpoch;
}

/* -------------------------------------------------------------------------- */
/* Safety & Time                                                              */
/* -------------------------------------------------------------------------- */

export type SafetyEscalationEvent = SafetyEvaluation;

export type CountdownTickEvent = TimeCountdownTick;
export type CountdownDoneEvent = TimeCountdownDone;

export interface GuardWindowEvent {
  guard: "quietHours" | "sabbath";
  inside: boolean;                  // true if just entered the window
  changedAt: MsEpoch;
  window?: { startTs?: MsEpoch; endTs?: MsEpoch };
}

export type SessionAutoPauseEvent = SessionSafetyAutoPause;

/* -------------------------------------------------------------------------- */
/* NBA (Next Best Action)                                                     */
/* -------------------------------------------------------------------------- */

export interface NbaSuggested {
  id: ID;                           // target (item/session)
  domain: DomainType | "task";
  suggestions: NextBestAction[];
  at: MsEpoch;
  source?: "safety" | "inventory" | "planner" | "user" | "system";
}

export interface NbaActed {
  id: ID;                           // target (item/session)
  action: NextBestAction["code"];
  label?: string;
  at: MsEpoch;
  meta?: Record<string, any>;
}

/* -------------------------------------------------------------------------- */
/* Calendar Sync                                                              */
/* -------------------------------------------------------------------------- */

export interface CalendarWriteSuccess {
  id: ID;                           // event id on calendar
  sessionId?: ID;
  provider: "google" | "ics" | "local";
  start: MsEpoch;
  end: MsEpoch;
  displayUrl?: string;
}

export interface CalendarWriteFailure {
  sessionId?: ID;
  provider: "google" | "ics" | "local";
  error: ErrorPayload;
}

/* -------------------------------------------------------------------------- */
/* Inventory / Garden / Animals                                               */
/* -------------------------------------------------------------------------- */

export interface InventorySignal {
  itemId: ID;
  name: string;
  status: "have" | "low" | "short" | "surplus";
  rationale?: string;
  nba?: NextBestAction[];
  at: MsEpoch;
}

export interface GardenStepEvent {
  id: ID;                           // step id
  planRef?: string;
  type: "start" | "complete";
  at: MsEpoch;
  meta?: Record<string, any>;
}

export interface AnimalStepEvent {
  id: ID;
  phase: "care" | "breeding" | "butchery" | "processing";
  type: "start" | "complete";
  at: MsEpoch;
  meta?: Record<string, any>;
}

/* -------------------------------------------------------------------------- */
/* Scan • Compare • Trust                                                     */
/* -------------------------------------------------------------------------- */

export interface ScanItemEvent {
  id: ID;                           // scan id
  kind: "barcode" | "image" | "text";
  content: string;                  // e.g., UPC, image ref, raw text
  at: MsEpoch;
  source?: "mobile" | "desktop" | "camera-roll" | "upload";
}

export interface CompareResultsEvent {
  id: ID;                           // scan id
  itemName?: string;
  comparisons: Array<{
    store: string;
    price?: number;
    unit?: string;
    lastSeen?: ISODate;
    coupon?: { label: string; value: string; expires?: ISODate } | null;
  }>;
  at: MsEpoch;
}

export interface TrustAlertsEvent {
  id: ID;                           // scan id
  alerts: Array<{
    type: "recall" | "ingredient" | "allergen" | "warning" | "nutrition";
    title: string;
    detail?: string;
    source?: string;                // e.g., FDA/USDA URL domain
  }>;
  at: MsEpoch;
}

/* -------------------------------------------------------------------------- */
/* Settings / Prefs                                                           */
/* -------------------------------------------------------------------------- */

export interface SchedulerPrefsChanged {
  prefs: SchedulerPrefs;
  changedAt: MsEpoch;
}

/* -------------------------------------------------------------------------- */
/* Analytics                                                                  */
/* -------------------------------------------------------------------------- */

export interface AnalyticsTrack {
  event: string;                    // human/GA-like label
  props?: Record<string, any>;
  at: MsEpoch;
}

/* -------------------------------------------------------------------------- */
/* Event Map                                                                  */
/* -------------------------------------------------------------------------- */

export interface SukaEventMap {
  /* Time */
  "time:countdown:tick": CountdownTickEvent;
  "time:countdown:done": CountdownDoneEvent;

  /* Safety */
  "safety:escalation": SafetyEscalationEvent;
  "session:safety:autopause": SessionAutoPauseEvent;

  /* Guards */
  "guard:quiet:changed": GuardWindowEvent;
  "guard:sabbath:changed": GuardWindowEvent;

  /* Sessions */
  "session:created": SessionCreated;
  "session:started": SessionStarted;
  "session:resumed": SessionResumed;
  "session:paused": SessionPaused;
  "session:completed": SessionCompleted;
  "session:canceled": SessionCanceled;

  /* Steps (generic + domain executors) */
  "step:started": StepStarted;
  "step:progress": StepProgress;
  "step:completed": StepCompleted;
  "step:error": StepErrored;

  "garden:step:start": GardenStepEvent;     // GardenExecutor hook
  "garden:step:complete": GardenStepEvent;

  "animals:step:start": AnimalStepEvent;    // AnimalQueueManager hooks
  "animals:step:complete": AnimalStepEvent;

  /* NBA */
  "nba:suggested": NbaSuggested;
  "nba:acted": NbaActed;

  /* Calendar */
  "calendar:write:success": CalendarWriteSuccess;
  "calendar:write:failure": CalendarWriteFailure;

  /* Inventory */
  "inventory:signal": InventorySignal;

  /* Favorites & Templates */
  "favorites:saved": FavoriteSaved;
  "favorites:removed": FavoriteRemoved;
  "template:chosen": TemplateChosen;

  /* Scan • Compare • Trust */
  "scan:item": ScanItemEvent;
  "compare:results": CompareResultsEvent;
  "trust:alerts": TrustAlertsEvent;

  /* Settings */
  "scheduler:prefs:changed": SchedulerPrefsChanged;

  /* Analytics / Diagnostics */
  "analytics:track": AnalyticsTrack;
  "error": ErrorPayload;
}

/* -------------------------------------------------------------------------- */
/* Typed EventBus                                                             */
/* -------------------------------------------------------------------------- */

export type Listener<P> = (payload: P) => void;

export interface SukaEventBus<M extends Record<string, any> = SukaEventMap> {
  on<K extends keyof M>(event: K, listener: Listener<M[K]>): this;
  once<K extends keyof M>(event: K, listener: Listener<M[K]>): this;
  off<K extends keyof M>(event: K, listener: Listener<M[K]>): this;
  emit<K extends keyof M>(event: K, payload: M[K]): boolean;
}

/* Helper to extract payload type by key */
export type EventOf<K extends keyof SukaEventMap> = SukaEventMap[K];

/* -------------------------------------------------------------------------- */
/* Module augmentation: type the automation runtime's eventBus                */
/* -------------------------------------------------------------------------- */

declare module "@/services/automation/runtime" {
  export const automation: {
    eventBus?: SukaEventBus;
    // ...other runtime fields you already export
    [k: string]: any;
  };
}

/* -------------------------------------------------------------------------- */
/* Convenience overloads for untyped emitters (optional)                      */
/* -------------------------------------------------------------------------- */

/**
 * Attach strong typing to an untyped EventEmitter instance at the call site:
 *
 *   import { asSukaEventBus } from "@/types/events";
 *   const bus = asSukaEventBus(automation.eventBus);
 *   bus.on("safety:escalation", (p) => { ... });
 */
export function asSukaEventBus<T extends { on: any; once: any; off: any; emit: any }>(
  anyBus: T
): SukaEventBus;

/* -------------------------------------------------------------------------- */
/* Discriminated BaseEvent (optional)                                         */
/* -------------------------------------------------------------------------- */

export interface BaseEvent<K extends keyof SukaEventMap = keyof SukaEventMap> {
  type: K;
  payload: SukaEventMap[K];
  at?: MsEpoch;
}
