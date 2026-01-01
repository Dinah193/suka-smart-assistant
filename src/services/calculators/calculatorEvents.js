// C:\Users\larho\suka-smart-assistant\src\services\calculators\calculatorEvents.js

/**
 * Calculator Events Helper
 *
 * How this fits:
 * - Centralized helpers for emitting calculator-related events onto SSA's
 *   global `eventBus` so analytics, Planning Graph, automation, and
 *   Stability tools can all observe calculator behavior consistently.
 *
 * Event envelope (required by SSA):
 *   {
 *     type: string,                     // e.g. "calculator.opened"
 *     ts: string,                       // ISO 8601 timestamp
 *     source: string,                   // e.g. "calculator.ui" or "calculator.runner"
 *     data?: Record<string, any>,       // payload (must be JSON-serializable)
 *   }
 *
 * Typical flow:
 *   - UI: user navigates to a calculator → emitCalculatorOpened(...)
 *   - UI: user edits inputs → emitCalculatorInputChanged(...)
 *   - UI: user clicks "Run" → emitCalculatorRunRequested(...)
 *   - Runner: calculation starts → emitCalculatorRunStarted(...)
 *   - Runner: calculation completes → emitCalculatorRunCompleted(...)
 *   - Runner: calculation fails → emitCalculatorRunFailed(...)
 *   - Runner: session created from result → emitCalculatorSessionCreated(...)
 *   - Store: result persisted → emitCalculatorResultSaved(...)
 *
 * NOTE:
 * - `calculatorRunner.js` and `calculatorResultStore.js` already emit some
 *   events internally. Over time, those modules can be refactored to call
 *   these helpers for a fully unified event vocabulary.
 */

import eventBus from "@/services/eventBus";

/**
 * @typedef {import("./calculatorRunner").CalculatorRunContext} CalculatorRunContext
 */

/**
 * @typedef {Object} CalculatorEventBase
 * @property {string} calculatorId
 * @property {CalculatorRunContext} [context]
 * @property {string} [source]               - e.g. "calculator.ui" | "calculator.runner" | "calculator.resultStore"
 */

/**
 * Event type constants for reuse across SSA.
 */
export const CALCULATOR_EVENT_TYPES = {
  OPENED: "calculator.opened",
  CLOSED: "calculator.closed",
  INPUT_CHANGED: "calculator.input.changed",
  RUN_REQUESTED: "calculator.run.requested",
  RUN_STARTED: "calculator.started",
  RUN_COMPLETED: "calculator.completed",
  RUN_FAILED: "calculator.failed",
  SESSION_CREATED: "calculator.session.created",
  RESULT_SAVED: "calculator.result.saved",
  RESULT_LOADED: "calculator.result.loaded",
  RESULT_DELETED: "calculator.result.deleted",
};

/** ------------------------------------------------------------------------
 *  UI-initiated events
 * --------------------------------------------------------------------- */

/**
 * Emit that a calculator UI was opened (navigated to / displayed).
 *
 * @param {CalculatorEventBase & { inputDefaults?: any }} params
 */
export function emitCalculatorOpened(params) {
  const { calculatorId, context, source, inputDefaults } = params || {};
  if (!calculatorId) return;

  safeEmit({
    type: CALCULATOR_EVENT_TYPES.OPENED,
    source: source || "calculator.ui",
    data: {
      calculatorId,
      context: sanitizeContext(context),
      inputDefaults: safeClone(inputDefaults),
    },
  });
}

/**
 * Emit that a calculator UI was closed (navigated away / dismissed).
 *
 * @param {CalculatorEventBase & { reason?: "navigate"|"dismiss"|"submit"|"unknown" }} params
 */
export function emitCalculatorClosed(params) {
  const { calculatorId, context, source, reason } = params || {};
  if (!calculatorId) return;

  safeEmit({
    type: CALCULATOR_EVENT_TYPES.CLOSED,
    source: source || "calculator.ui",
    data: {
      calculatorId,
      context: sanitizeContext(context),
      reason: reason || "unknown",
    },
  });
}

/**
 * Emit that calculator input has changed (debounced from UI).
 *
 * @param {CalculatorEventBase & { input: any }} params
 */
export function emitCalculatorInputChanged(params) {
  const { calculatorId, context, source, input } = params || {};
  if (!calculatorId) return;

  safeEmit({
    type: CALCULATOR_EVENT_TYPES.INPUT_CHANGED,
    source: source || "calculator.ui",
    data: {
      calculatorId,
      context: sanitizeContext(context),
      input: safeClone(input),
    },
  });
}

/**
 * Emit that the user explicitly requested a run (clicked "Calculate",
 * pressed Enter, etc.). The actual run will be captured by RUN_STARTED.
 *
 * @param {CalculatorEventBase & { input: any }} params
 */
export function emitCalculatorRunRequested(params) {
  const { calculatorId, context, source, input } = params || {};
  if (!calculatorId) return;

  safeEmit({
    type: CALCULATOR_EVENT_TYPES.RUN_REQUESTED,
    source: source || "calculator.ui",
    data: {
      calculatorId,
      context: sanitizeContext(context),
      input: safeClone(input),
    },
  });
}

/** ------------------------------------------------------------------------
 *  Runner-initiated events
 *  (calculatorRunner.js is the typical caller)
 * --------------------------------------------------------------------- */

/**
 * Emit that a calculator run has started (before any result is available).
 *
 * @param {CalculatorEventBase & { input: any }} params
 */
export function emitCalculatorRunStarted(params) {
  const { calculatorId, context, source, input } = params || {};
  if (!calculatorId) return;

  safeEmit({
    type: CALCULATOR_EVENT_TYPES.RUN_STARTED,
    source: source || "calculator.runner",
    data: {
      calculatorId,
      context: sanitizeContext(context),
      input: safeClone(input),
    },
  });
}

/**
 * Emit that a calculator run has completed successfully.
 *
 * @param {CalculatorEventBase & {
 *   input: any,
 *   result: any,
 *   durationMs?: number,
 *   sessionSupported?: boolean,
 *   sessionGenerated?: boolean,
 * }} params
 */
export function emitCalculatorRunCompleted(params) {
  const {
    calculatorId,
    context,
    source,
    input,
    result,
    durationMs,
    sessionSupported,
    sessionGenerated,
  } = params || {};
  if (!calculatorId) return;

  safeEmit({
    type: CALCULATOR_EVENT_TYPES.RUN_COMPLETED,
    source: source || "calculator.runner",
    data: {
      calculatorId,
      context: sanitizeContext(context),
      input: safeClone(input),
      result: safeClone(result),
      durationMs: typeof durationMs === "number" ? durationMs : undefined,
      sessionSupported: !!sessionSupported,
      sessionGenerated: !!sessionGenerated,
    },
  });
}

/**
 * Emit that a calculator run has failed.
 *
 * @param {CalculatorEventBase & {
 *   input: any,
 *   error: any,
 *   durationMs?: number,
 * }} params
 */
export function emitCalculatorRunFailed(params) {
  const { calculatorId, context, source, input, error, durationMs } =
    params || {};
  if (!calculatorId) return;

  safeEmit({
    type: CALCULATOR_EVENT_TYPES.RUN_FAILED,
    source: source || "calculator.runner",
    data: {
      calculatorId,
      context: sanitizeContext(context),
      input: safeClone(input),
      error: serializeError(error),
      durationMs: typeof durationMs === "number" ? durationMs : undefined,
    },
  });
}

/**
 * Emit that a SessionRunner-ready session was built from calculator results.
 *
 * @param {CalculatorEventBase & {
 *   session: any,
 * }} params
 */
export function emitCalculatorSessionCreated(params) {
  const { calculatorId, context, source, session } = params || {};
  if (!calculatorId || !session) return;

  safeEmit({
    type: CALCULATOR_EVENT_TYPES.SESSION_CREATED,
    source: source || "calculator.runner",
    data: {
      calculatorId,
      context: sanitizeContext(context),
      session: safeClone(session),
    },
  });

  // Helper: also emit the core `session.created.fromCalculator` event
  // so the automation runtime can listen for a single, domain-agnostic hook.
  safeEmit({
    type: "session.created.fromCalculator",
    source: source || "calculator.runner",
    data: {
      calculatorId,
      context: sanitizeContext(context),
      session: safeClone(session),
    },
  });
}

/** ------------------------------------------------------------------------
 *  Result store events
 *  (calculatorResultStore.js is the typical caller)
 * --------------------------------------------------------------------- */

/**
 * Emit that a calculator result has been persisted.
 *
 * @param {{ record: import("./calculatorResultStore").StoredCalculatorResult, source?: string }} params
 */
export function emitCalculatorResultSaved(params) {
  const { record, source } = params || {};
  if (!record || !record.id || !record.calculatorId) return;

  safeEmit({
    type: CALCULATOR_EVENT_TYPES.RESULT_SAVED,
    source: source || "calculator.resultStore",
    data: {
      id: record.id,
      calculatorId: record.calculatorId,
      label: record.label,
      tags: record.tags,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    },
  });
}

/**
 * Emit that a calculator result has been loaded/read.
 *
 * @param {{ record: import("./calculatorResultStore").StoredCalculatorResult, source?: string }} params
 */
export function emitCalculatorResultLoaded(params) {
  const { record, source } = params || {};
  if (!record || !record.id || !record.calculatorId) return;

  safeEmit({
    type: CALCULATOR_EVENT_TYPES.RESULT_LOADED,
    source: source || "calculator.resultStore",
    data: {
      id: record.id,
      calculatorId: record.calculatorId,
      label: record.label,
      tags: record.tags,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    },
  });
}

/**
 * Emit that a calculator result has been deleted.
 *
 * @param {{ record: import("./calculatorResultStore").StoredCalculatorResult, source?: string }} params
 */
export function emitCalculatorResultDeleted(params) {
  const { record, source } = params || {};
  if (!record || !record.id || !record.calculatorId) return;

  safeEmit({
    type: CALCULATOR_EVENT_TYPES.RESULT_DELETED,
    source: source || "calculator.resultStore",
    data: {
      id: record.id,
      calculatorId: record.calculatorId,
    },
  });
}

/** ------------------------------------------------------------------------
 *  Core emission helper
 * --------------------------------------------------------------------- */

/**
 * Core safe emitter that enforces SSA's envelope:
 *   { type, ts, source, data }
 *
 * @param {{ type: string, source: string, data?: any }} payload
 */
function safeEmit(payload) {
  if (!payload || !payload.type) return;

  const envelope = {
    type: payload.type,
    ts: new Date().toISOString(),
    source: payload.source || "calculator.unknown",
    data: payload.data,
  };

  try {
    if (eventBus && typeof eventBus.emit === "function") {
      eventBus.emit(envelope);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[calculatorEvents] safeEmit failed", envelope, err);
  }
}

/** ------------------------------------------------------------------------
 *  Utility helpers
 * --------------------------------------------------------------------- */

/**
 * Shallow-safe cloning for event data to avoid accidental mutation after
 * the event leaves the module. It also avoids throwing on non-serializable
 * values by falling back to the original value on error.
 *
 * @param {any} value
 * @returns {any}
 */
function safeClone(value) {
  if (value == null) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return value;

  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return value;
  }
}

/**
 * Lightweight error serializer for inclusion in event payloads.
 *
 * @param {any} err
 * @returns {{ name?: string, message?: string, stack?: string } | { message: string } | null}
 */
function serializeError(err) {
  if (!err) return null;
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
    };
  }
  if (typeof err === "string") {
    return { message: err };
  }
  if (typeof err === "object") {
    try {
      return JSON.parse(JSON.stringify(err));
    } catch (_) {
      return { message: String(err) };
    }
  }
  return { message: String(err) };
}

/**
 * Normalizes CalculatorRunContext-ish input to make sure we never leak
 * unexpected shapes into event payloads.
 *
 * @param {CalculatorRunContext} [ctx]
 * @returns {CalculatorRunContext}
 */
function sanitizeContext(ctx = /** @type {CalculatorRunContext} */ ({})) {
  const context = ctx || {};

  return {
    userId:
      typeof context.userId === "string" && context.userId.trim()
        ? context.userId.trim()
        : undefined,
    householdId:
      typeof context.householdId === "string" && context.householdId.trim()
        ? context.householdId.trim()
        : undefined,
    sessionDomain:
      typeof context.sessionDomain === "string" && context.sessionDomain.trim()
        ? context.sessionDomain.trim()
        : undefined,
    env:
      context.env && typeof context.env === "object"
        ? context.env
        : undefined,
  };
}

export default {
  CALCULATOR_EVENT_TYPES,
  emitCalculatorOpened,
  emitCalculatorClosed,
  emitCalculatorInputChanged,
  emitCalculatorRunRequested,
  emitCalculatorRunStarted,
  emitCalculatorRunCompleted,
  emitCalculatorRunFailed,
  emitCalculatorSessionCreated,
  emitCalculatorResultSaved,
  emitCalculatorResultLoaded,
  emitCalculatorResultDeleted,
};
