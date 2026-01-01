// src/types/cooking.d.ts

/* -------------------------------------------------------------------------- */
/* Basic scalars & utility types                                              */
/* -------------------------------------------------------------------------- */

export type ISODateString = string; // ISO 8601 string "YYYY-MM-DDTHH:mm:ss.sssZ" or "YYYY-MM-DD"
export type UUID = string;

export type Unit =
  | 'g' | 'kg' | 'oz' | 'lb'
  | 'ml' | 'l'
  | 'tsp' | 'tbsp' | 'cup'
  | 'unit'
  | (string & {}); // allow custom units

export type NullableDate = ISODateString | Date | null | undefined;

export interface Quantity {
  qty: number;
  unit?: Unit;
}

/* -------------------------------------------------------------------------- */
/* Status enums                                                               */
/* -------------------------------------------------------------------------- */

export type StepStatus = 'pending' | 'in_progress' | 'done' | 'skipped';

export type TimerStatus =
  | 'running'
  | 'paused'
  | 'done'        // kept for BC with older code
  | 'complete'    // matches MultiTimerManager
  | 'canceled';

export type SessionStatus = 'active' | 'done' | 'canceled';

/* -------------------------------------------------------------------------- */
/* Core cooking entities                                                      */
/* -------------------------------------------------------------------------- */

export interface CookingStep {
  stepId: string;
  idx: number;
  text: string;

  status?: StepStatus;
  startedAt?: NullableDate;
  finishedAt?: NullableDate;
  /** Intended/observed duration for the step (ms). */
  durationMs?: number;

  /** Optional timer linkage for agents/UX to attach countdowns. */
  timerId?: string | null;
  timerMinHint?: number | null;

  notes?: Array<{ at: NullableDate; text: string }>;
  meta?: Record<string, any>;
}

export interface RecipeRef {
  recipeId: string;
  title?: string;
  portions?: number;
  tags?: string[];
  steps?: CookingStep[];

  /** Optional nutrition or source hints (agent-friendly). */
  sourceUrl?: string;
  imageUrl?: string;
  meta?: Record<string, any>;
}

export interface CookingEvent<T = any> {
  ts: NullableDate;
  type: string; // e.g., "step:started", "timer:finished"
  payload?: T;
}

export interface CookingTimer {
  id?: string;
  label?: string;

  /** Countdown baseline in minutes (BC). Prefer seconds or dueAt below for precision. */
  minutes?: number;

  /** New precise fields (optional, do not break BC). */
  seconds?: number;        // duration in seconds
  dueAt?: ISODateString;   // if set, remaining = max(0, dueAt - now)

  startedAt?: NullableDate;
  finishedAt?: NullableDate;
  status?: TimerStatus;

  /** Links back to recipe/step/slot for UX composition. */
  recipeId?: string;
  stepId?: string;
  slotId?: string;

  meta?: Record<string, any>;
}

export interface Note {
  at?: NullableDate;
  text: string;
  meta?: any;
}

export interface LabelRecord {
  at?: NullableDate;
  filePath?: string | null;
  count?: number;
  templateId?: string | null;

  /** Extra structured label data (product, batch, etc.). */
  data?: {
    productName?: string;
    batchCode?: string | null;
    packedOn?: string; // YYYY-MM-DD
    bestBy?: string;   // YYYY-MM-DD
    variety?: string;
    netWeight?: number;
    unit?: string;
    jarSize?: string;
    method?: string;
    ingredients?: string[];
  };
}

export interface InventoryDelta {
  at?: NullableDate;
  name: string;
  qty: number;
  unit?: Unit;
  reason?: 'use' | 'add' | 'waste' | (string & {});
  meta?: Record<string, any>;
}

/** Full session / history document shape */
export interface CookingSession {
  userId: string;
  sessionId: string;

  title?: string;
  batch?: boolean;
  status: SessionStatus;

  startedAt: ISODateString | Date;
  finishedAt?: NullableDate;
  /** Total minutes (rounded) for quick summaries. */
  durationMin?: number;

  /** Optional timezone for more accurate summaries. */
  timezone?: string;

  /** Observance flags for UX/planning. */
  observance?: {
    sabbathAware?: boolean;
    sabbathWindow?: { start?: ISODateString; end?: ISODateString } | null;
  };

  recipes?: RecipeRef[];
  events?: CookingEvent[];
  timers?: CookingTimer[];
  notes?: Note[];
  labels?: LabelRecord[];
  inventoryDeltas?: InventoryDelta[];

  meta?: Record<string, any>;
  createdAt?: NullableDate;
  updatedAt?: NullableDate;
}

/* -------------------------------------------------------------------------- */
/* Inputs / outputs for model operations & APIs                               */
/* -------------------------------------------------------------------------- */

export interface StartSessionInput {
  userId: string;
  sessionId: string;
  title?: string;
  batch?: boolean;
  startedAt?: NullableDate;
  timezone?: string;
  observance?: CookingSession['observance'];
  recipes?: RecipeRef[];
  meta?: Record<string, any>;
}

export interface FinishSessionPatch {
  status?: SessionStatus;
  finishedAt?: NullableDate;
  timers?: CookingTimer[];
  events?: CookingEvent[];
  labels?: LabelRecord[];
  inventoryDeltas?: InventoryDelta[];
  meta?: Record<string, any>;
}

export interface ListByUserOpts {
  limit?: number;
  since?: NullableDate | null;
  to?: NullableDate | null;
  status?: SessionStatus | null;
}

export interface UserSummary {
  userId: string;
  sessions: number;
  totalMinutes: number;
  totalRecipes: number;
  since: ISODateString | null;
  to: ISODateString | null;
}

/* Standard HTTP payloads used by services/workflows */

export interface CreateTimerPayload {
  userId?: string | null;
  recipeId?: string;
  stepId?: string;
  slotId?: string;
  label?: string;

  /** Either minutes (BC), or seconds/dueAt for precision. */
  minutes?: number;
  seconds?: number;
  dueAt?: ISODateString;

  meta?: Record<string, any>;
}

export interface InventoryDeltaPayload {
  userId?: string | null;
  lines: InventoryDelta[];
}

export interface PrintLabelsPayload {
  userId?: string | null;
  items: Array<{
    productName: string;
    batchCode?: string | null;
    count?: number;
    packedOn?: string; // YYYY-MM-DD
    bestBy?: string;   // YYYY-MM-DD
    variety?: string;
    netWeight?: number;
    unit?: string;
    jarSize?: string;
    method?: string;
    ingredients?: string[];
  }>;
  templateId?: string | null;
}

export interface CreateSessionPayload {
  userId: string;
  title?: string;
  batch?: boolean;
  startedAt?: ISODateString;
  timezone?: string;
  recipes?: RecipeRef[];
  observance?: CookingSession['observance'];
}

export interface CreateSessionResponse {
  sessionId: string;
  [k: string]: any;
}

/* -------------------------------------------------------------------------- */
/* CookingHistory model contract (Mongoose or file DAO)                       */
/* -------------------------------------------------------------------------- */

export interface CookingHistoryModel {
  startSession(data: StartSessionInput): Promise<CookingSession>;
  finishSession(sessionId: string, patch?: FinishSessionPatch): Promise<CookingSession | null>;

  recordEvent<T = any>(sessionId: string, type: string, payload?: T): Promise<CookingSession | null>;
  addNote(sessionId: string, text: string, meta?: any): Promise<CookingSession | null>;

  addInventoryDelta(sessionId: string, line: InventoryDelta): Promise<CookingSession | null>;
  addLabelRecord(sessionId: string, rec: LabelRecord): Promise<CookingSession | null>;
  appendSteps(sessionId: string, recipeId: string, steps: CookingStep[]): Promise<CookingSession | null>;

  getBySession(sessionId: string): Promise<CookingSession | null>;
  listByUser(userId: string, opts?: ListByUserOpts): Promise<CookingSession[]>;
  getUserSummary(
    userId: string,
    opts?: { since?: NullableDate | null; to?: NullableDate | null }
  ): Promise<UserSummary>;

  /** Exposes which backend is active (non-standard helper). */
  __driver?: 'mongoose' | 'file';
}

/* -------------------------------------------------------------------------- */
/* Event bus (cookingBus) event union                                         */
/* -------------------------------------------------------------------------- */

export type CookingBusEvent =
  | { type: 'session:started'; session: CookingSession }
  | { type: 'session:finished'; session: CookingSession }
  | { type: 'step:started'; sessionId: string; recipeId: string; stepId: string }
  | { type: 'step:finished'; sessionId: string; recipeId: string; stepId: string; durationMs?: number }
  | { type: 'timer:started'; sessionId: string; label?: string; minutes?: number; seconds?: number; dueAt?: ISODateString }
  | { type: 'timer:finished'; sessionId: string; label?: string }
  | { type: 'inventory:delta'; sessionId: string; line: InventoryDelta }
  | { type: 'labels:printed'; sessionId: string; labels: LabelRecord[] }
  | { type: 'observance:window'; sessionId?: string; start?: ISODateString; end?: ISODateString }
  | { type: 'storehouse:preserve:planned'; sessionId?: string; tasks: Array<Record<string, any>> }
  | { type: string; [k: string]: any };

/* -------------------------------------------------------------------------- */
/* n8n webhook bodies used across workflows                                   */
/* -------------------------------------------------------------------------- */

export interface CookingSessionWebhookBody {
  userId?: string;
  title?: string;
  batch?: boolean;
  startAt?: ISODateString;
  timezone?: string;
  recipes?: Array<{
    id?: string;
    title?: string;
    portions?: number;
    tags?: string[];
    ingredients?: Array<{ name: string; qty: number; unit?: Unit }>;
    steps?: Array<{ id?: string; text: string; timerMin?: number }>;
  }>;
  timers?: Array<{ recipeId?: string; stepId?: string; label?: string; minutes?: number; seconds?: number; dueAt?: string }>;
  labels?: Array<{ productName: string; batchCode?: string; packedOn?: string; count?: number }>;
  inventory?: InventoryDelta[];
  observance?: CookingSession['observance'];
}

export interface PreservationLabelWebhookBody {
  userId?: string;
  method: 'can' | 'pickle' | 'freeze' | 'dehydrate' | 'ferment' | (string & {});
  productName?: string;
  items: Array<{
    variety?: string;
    netWeight?: number;
    unit?: string;
    jarSize?: string;
    count?: number;
    ingredients?: string[];
  }>;
  shelfLifeDays?: number;
  templateId?: string | null;
  makeTicket?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Type guards (declaration only – implemented elsewhere if desired)          */
/* -------------------------------------------------------------------------- */

export function isCookingSession(x: any): x is CookingSession;
export function isInventoryDelta(x: any): x is InventoryDelta;
export function isLabelRecord(x: any): x is LabelRecord;

/* -------------------------------------------------------------------------- */
/* Ambient module declarations (so require() picks up the model types)        */
/* -------------------------------------------------------------------------- */

/**
 * Adjust these module specifiers if your import paths differ.
 * They’re declared as CommonJS exports to match `module.exports = CookingHistory`.
 */
declare module '../db/models/CookingHistory' {
  const CookingHistory: import('../types/cooking').CookingHistoryModel;
  export = CookingHistory;
}
declare module './db/models/CookingHistory' {
  const CookingHistory: import('../types/cooking').CookingHistoryModel;
  export = CookingHistory;
}
declare module '../../server/db/models/CookingHistory' {
  const CookingHistory: import('../types/cooking').CookingHistoryModel;
  export = CookingHistory;
}
