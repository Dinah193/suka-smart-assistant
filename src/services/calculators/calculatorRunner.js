// C:\Users\larho\suka-smart-assistant\src\services\calculators\calculatorRunner.js

/**
 * Calculator Runner
 *
 * How this fits:
 * - Provides a single, standard interface for executing ANY calculator
 *   registered in `calculatorRegistry.js`.
 * - Resolves the correct shim module, runs its core logic, and returns
 *   a normalized result object.
 * - Optionally asks the shim to convert a calculator result into a
 *   SessionRunner-ready session object (for calculators that support it).
 * - Emits calculator events on the global `eventBus` so the Planning Graph,
 *   analytics, and Stability tools can observe calculator usage.
 *
 * This module does NOT:
 * - Render React components.
 * - Mount SessionRunner directly.
 *
 * Convention for calculator shims:
 * - A shim may export any of the following (highest precedence first):
 *   • default function (input, options) => result
 *   • run(input, options) => result
 *   • calculate(input, options) => result
 *   • compute(input, options) => result
 *
 * - For calculators that can generate sessions, a shim MAY also export:
 *   • toSession(result, context) => Session | null
 *   • toSessionSteps(result, context) => Session | null
 *   • buildSession(result, context) => Session | null
 *
 * NOTE:
 * - All of the above are optional and detected at runtime.
 * - This runner is defensive and will gracefully handle missing exports.
 */

import eventBus from "@/services/eventBus";
import {
  getCalculator,
  getCalculatorShimLoader,
  calculatorSupportsSessions,
} from "./calculatorRegistry";

/**
 * @typedef {import("./types").CalculatorRegistryEntry} CalculatorRegistryEntry
 * If you haven't created ./types yet, you can treat this as JSDoc docs only.
 */

/**
 * @typedef {Object} CalculatorRunContext
 * @property {string} [userId]            - Optional user identifier
 * @property {string} [householdId]       - Optional household / SSA instance
 * @property {string} [sessionDomain]     - Optional SessionRunner domain hint
 * @property {Record<string, any>} [env]  - Optional environment metadata (device, locale, etc.)
 */

/**
 * @typedef {Object} CalculatorRunOptions
 * @property {boolean} [generateSession]  - Ask the shim to build a Session from the result (if supported)
 * @property {CalculatorRunContext} [context] - Execution context for analytics and Session generation
 * @property {number} [timeoutMs]         - Optional soft timeout (ms); non-fatal if exceeded
 */

/**
 * @typedef {Object} CalculatorRunResult
 * @property {string} calculatorId
 * @property {any} result                 - Raw calculator result from the shim
 * @property {any} [session]              - Optional SessionRunner-ready session object
 * @property {CalculatorRunContext} [context]
 * @property {number} durationMs
 * @property {boolean} sessionSupported
 * @property {boolean} sessionGenerated
 */

/** ------------------------------------------------------------------------
 *  Public API
 * --------------------------------------------------------------------- */

/**
 * Run a calculator by ID using the standard SSA interface.
 *
 * - Resolves the calculator shim (via registry).
 * - Invokes the shim's primary run function with the given input.
 * - Emits `calculator.started`, `calculator.completed`, and
 *   `calculator.failed` events to `eventBus`.
 * - Optionally attempts to build a Session object from the result.
 *
 * @param {string} calculatorId
 * @param {any} input
 * @param {CalculatorRunOptions} [options]
 * @returns {Promise<CalculatorRunResult>}
 */
export async function runCalculator(calculatorId, input, options = {}) {
  const startedAt = Date.now();
  const ctx = sanitizeContext(options.context);
  const generateSession = !!options.generateSession;

  if (!calculatorId || typeof calculatorId !== "string") {
    const err = new Error("[calculatorRunner] calculatorId is required");
    emitCalculatorFailed(calculatorId || "unknown", input, ctx, err);
    throw err;
  }

  const registryEntry = getCalculator(calculatorId);
  if (!registryEntry) {
    const err = new Error(
      `[calculatorRunner] Unknown calculatorId: ${calculatorId}`
    );
    emitCalculatorFailed(calculatorId, input, ctx, err);
    throw err;
  }

  emitCalculatorStarted(calculatorId, input, ctx);

  let shim;
  try {
    const loader = getCalculatorShimLoader(calculatorId);
    if (!loader) {
      throw new Error(
        `[calculatorRunner] No shim loader found for calculatorId: ${calculatorId}`
      );
    }
    shim = await loader();
  } catch (err) {
    emitCalculatorFailed(calculatorId, input, ctx, err);
    throw err;
  }

  const runnerFn = resolveShimRunner(shim);
  if (!runnerFn) {
    const err = new Error(
      `[calculatorRunner] Shim for ${calculatorId} does not expose a run/calculate/compute/default function`
    );
    emitCalculatorFailed(calculatorId, input, ctx, err);
    throw err;
  }

  let result;
  let errorObj = null;

  try {
    // Optional timeout guard (non-fatal; just records a red flag / console)
    const timeoutMs =
      typeof options.timeoutMs === "number" && options.timeoutMs > 0
        ? options.timeoutMs
        : null;

    if (timeoutMs) {
      result = await runWithSoftTimeout(runnerFn, input, { ctx, timeoutMs });
    } else {
      result = await Promise.resolve(runnerFn(input, { ctx }));
    }
  } catch (err) {
    errorObj = err;
  }

  const durationMs = Date.now() - startedAt;

  if (errorObj) {
    emitCalculatorFailed(calculatorId, input, ctx, errorObj, {
      durationMs,
    });
    throw errorObj;
  }

  const sessionSupported = calculatorSupportsSessions(calculatorId);
  let session = null;
  let sessionGenerated = false;

  if (generateSession && sessionSupported) {
    try {
      session = buildSessionFromResult(calculatorId, shim, result, {
        ...ctx,
        sessionDomain: ctx.sessionDomain || inferSessionDomain(registryEntry),
      });
      sessionGenerated = !!session;
    } catch (err) {
      // Session generation failure should not fail the calculator itself.
      // eslint-disable-next-line no-console
      console.warn(
        "[calculatorRunner] Failed to generate session from calculator result",
        calculatorId,
        err
      );
    }
  }

  /** @type {CalculatorRunResult} */
  const payload = {
    calculatorId,
    result,
    session,
    context: ctx,
    durationMs,
    sessionSupported,
    sessionGenerated,
  };

  emitCalculatorCompleted(calculatorId, payload);

  // If a session was generated, we emit a helper event that your automation
  // runtime can listen for and potentially auto-open / schedule it.
  if (sessionGenerated && session) {
    emitSessionCreatedFromCalculator(calculatorId, session, ctx);
  }

  return payload;
}

/**
 * Try to generate a session object from a calculator result
 * without re-running the calculator.
 *
 * This is useful when you've already computed a result (e.g. in a
 * React component) and now want to offer a "Create Session" button.
 *
 * @param {string} calculatorId
 * @param {any} result
 * @param {CalculatorRunContext} [context]
 * @returns {Promise<any|null>} Session object or null
 */
export async function createSessionFromCalculatorResult(
  calculatorId,
  result,
  context = {}
) {
  const ctx = sanitizeContext(context);

  const registryEntry = getCalculator(calculatorId);
  if (!registryEntry) {
    // eslint-disable-next-line no-console
    console.warn(
      "[calculatorRunner] createSessionFromCalculatorResult: unknown calculatorId",
      calculatorId
    );
    return null;
  }

  const loader = getCalculatorShimLoader(calculatorId);
  if (!loader) {
    // eslint-disable-next-line no-console
    console.warn(
      "[calculatorRunner] createSessionFromCalculatorResult: no shim loader",
      calculatorId
    );
    return null;
  }

  let shim;
  try {
    shim = await loader();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[calculatorRunner] createSessionFromCalculatorResult: shim load failed",
      calculatorId,
      err
    );
    return null;
  }

  const sessionDomain = ctx.sessionDomain || inferSessionDomain(registryEntry);

  try {
    const session = buildSessionFromResult(calculatorId, shim, result, {
      ...ctx,
      sessionDomain,
    });

    if (session) {
      emitSessionCreatedFromCalculator(calculatorId, session, ctx);
    }

    return session || null;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[calculatorRunner] createSessionFromCalculatorResult: buildSessionFromResult failed",
      calculatorId,
      err
    );
    return null;
  }
}

/** ------------------------------------------------------------------------
 *  Event helpers
 * --------------------------------------------------------------------- */

/**
 * @param {string} calculatorId
 * @param {any} input
 * @param {CalculatorRunContext} context
 */
function emitCalculatorStarted(calculatorId, input, context) {
  safeEmitEvent({
    type: "calculator.started",
    ts: new Date().toISOString(),
    source: "calculator.runner",
    data: {
      calculatorId,
      input,
      context,
    },
  });
}

/**
 * @param {string} calculatorId
 * @param {CalculatorRunResult} payload
 */
function emitCalculatorCompleted(calculatorId, payload) {
  safeEmitEvent({
    type: "calculator.completed",
    ts: new Date().toISOString(),
    source: "calculator.runner",
    data: {
      calculatorId,
      ...payload,
    },
  });
}

/**
 * @param {string} calculatorId
 * @param {any} input
 * @param {CalculatorRunContext} context
 * @param {any} error
 * @param {{ durationMs?: number }} [extra]
 */
function emitCalculatorFailed(calculatorId, input, context, error, extra = {}) {
  safeEmitEvent({
    type: "calculator.failed",
    ts: new Date().toISOString(),
    source: "calculator.runner",
    data: {
      calculatorId,
      input,
      context,
      error: serializeError(error),
      ...extra,
    },
  });
}

/**
 * Emit helper event when a calculator produces a session object.
 *
 * @param {string} calculatorId
 * @param {any} session
 * @param {CalculatorRunContext} context
 */
function emitSessionCreatedFromCalculator(calculatorId, session, context) {
  safeEmitEvent({
    type: "session.created.fromCalculator",
    ts: new Date().toISOString(),
    source: "calculator.runner",
    data: {
      calculatorId,
      session,
      context,
    },
  });
}

/**
 * Safe wrapper for eventBus.emit to avoid runtime errors if
 * eventBus is not available or not fully wired yet.
 *
 * @param {{ type: string, ts: string, source: string, data?: any }} payload
 */
function safeEmitEvent(payload) {
  try {
    if (!payload || !payload.type) return;
    if (eventBus && typeof eventBus.emit === "function") {
      eventBus.emit(payload);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[calculatorRunner] safeEmitEvent failed", payload, err);
  }
}

/** ------------------------------------------------------------------------
 *  Shim + Session helpers
 * --------------------------------------------------------------------- */

/**
 * Determine which function on the shim to call as the primary calculator runner.
 *
 * Priority:
 *   1) default export (if function)
 *   2) shim.run
 *   3) shim.calculate
 *   4) shim.compute
 *
 * @param {any} shim
 * @returns {((input: any, options?: any) => any) | null}
 */
function resolveShimRunner(shim) {
  if (!shim) return null;

  if (typeof shim === "function") {
    return shim;
  }

  if (shim && typeof shim.default === "function") {
    return shim.default;
  }

  if (shim && typeof shim.run === "function") {
    return shim.run;
  }

  if (shim && typeof shim.calculate === "function") {
    return shim.calculate;
  }

  if (shim && typeof shim.compute === "function") {
    return shim.compute;
  }

  return null;
}

/**
 * Attempt to call a "toSession-like" helper on the shim.
 *
 * Priority:
 *   1) shim.toSession(result, context)
 *   2) shim.toSessionSteps(result, context)
 *   3) shim.buildSession(result, context)
 *
 * The returned object is assumed to already conform to the Session contract
 * described in the Master Codegen Prompt.
 *
 * @param {string} calculatorId
 * @param {any} shim
 * @param {any} result
 * @param {CalculatorRunContext} context
 * @returns {any|null}
 */
function buildSessionFromResult(calculatorId, shim, result, context) {
  if (!shim || typeof shim !== "object") {
    return null;
  }

  let builder = null;

  if (typeof shim.toSession === "function") {
    builder = shim.toSession;
  } else if (typeof shim.toSessionSteps === "function") {
    builder = shim.toSessionSteps;
  } else if (typeof shim.buildSession === "function") {
    builder = shim.buildSession;
  }

  if (!builder) {
    // eslint-disable-next-line no-console
    console.warn(
      "[calculatorRunner] buildSessionFromResult: no toSession/toSessionSteps/buildSession export on shim for",
      calculatorId
    );
    return null;
  }

  const raw = builder(result, context);

  if (!raw || typeof raw !== "object") {
    return null;
  }

  // Soft validation & normalization: ensure mandatory keys exist.
  const nowIso = new Date().toISOString();

  const session = {
    id: raw.id || `calc-${calculatorId}-${nowIso}`,
    domain: raw.domain || context.sessionDomain || "storehouse",
    title: raw.title || fallbackSessionTitle(calculatorId),
    source: raw.source || {
      type: "import",
      refId: calculatorId,
    },
    steps: Array.isArray(raw.steps) ? raw.steps : [],
    prefs: {
      voiceGuidance:
        raw.prefs && typeof raw.prefs.voiceGuidance === "boolean"
          ? raw.prefs.voiceGuidance
          : true,
      haptic:
        raw.prefs && typeof raw.prefs.haptic === "boolean"
          ? raw.prefs.haptic
          : true,
      autoAdvance:
        raw.prefs && typeof raw.prefs.autoAdvance === "boolean"
          ? raw.prefs.autoAdvance
          : false,
    },
    status: raw.status || "pending",
    progress: {
      currentStepIndex:
        raw.progress && typeof raw.progress.currentStepIndex === "number"
          ? raw.progress.currentStepIndex
          : 0,
      elapsedSec:
        raw.progress && typeof raw.progress.elapsedSec === "number"
          ? raw.progress.elapsedSec
          : 0,
      startedAt: raw.progress?.startedAt || null,
      pausedAt: raw.progress?.pausedAt || null,
    },
    analytics: raw.analytics || { skippedSteps: [], adjustments: [] },
    createdAt: raw.createdAt || nowIso,
    updatedAt: raw.updatedAt || nowIso,
  };

  return session;
}

/**
 * Provide a simple human-readable session title fallback.
 *
 * @param {string} calculatorId
 * @returns {string}
 */
function fallbackSessionTitle(calculatorId) {
  const parts = calculatorId.split(".");
  const raw = parts[parts.length - 1] || calculatorId;
  const pretty = raw.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[\._-]/g, " ");
  return `Session from ${pretty}`;
}

/**
 * Infer a SessionRunner domain from the calculator's registry entry.
 *
 * This is a heuristic used only when the context doesn't specify
 * `sessionDomain`.
 *
 * @param {CalculatorRegistryEntry|null} entry
 * @returns {"cooking"|"cleaning"|"garden"|"animals"|"preservation"|"storehouse"}
 */
function inferSessionDomain(entry) {
  if (!entry) return "storehouse";

  const doms = entry.domains || [];

  if (doms.includes("meals") || doms.includes("health")) {
    return "cooking";
  }
  if (doms.includes("garden")) {
    return "garden";
  }
  if (doms.includes("animals")) {
    return "animals";
  }
  if (doms.includes("preservation")) {
    return "preservation";
  }
  if (doms.includes("cleaning")) {
    return "cleaning";
  }
  if (doms.includes("storehouse")) {
    return "storehouse";
  }

  return "storehouse";
}

/**
 * Normalize/defend against weird context values.
 *
 * @param {CalculatorRunContext} [context]
 * @returns {CalculatorRunContext}
 */
function sanitizeContext(context = {}) {
  const ctx = context || {};
  const safeEnv = ctx.env && typeof ctx.env === "object" ? ctx.env : undefined;

  return {
    userId:
      typeof ctx.userId === "string" && ctx.userId.trim() ? ctx.userId : undefined,
    householdId:
      typeof ctx.householdId === "string" && ctx.householdId.trim()
        ? ctx.householdId
        : undefined,
    sessionDomain:
      typeof ctx.sessionDomain === "string" && ctx.sessionDomain.trim()
        ? ctx.sessionDomain
        : undefined,
    env: safeEnv,
  };
}

/**
 * Run a function with an optional soft timeout.
 *
 * - If the function resolves before timeout, return its value.
 * - If it does not, log a warning and return whatever the function
 *   eventually resolves to (if it does).
 *
 * This is primarily used to flag unusually slow calculators in
 * Stability dashboards; it is NOT a hard kill.
 *
 * @param {(input: any, options?: any) => any} fn
 * @param {any} input
 * @param {{ ctx: CalculatorRunContext, timeoutMs: number }} cfg
 * @returns {Promise<any>}
 */
async function runWithSoftTimeout(fn, input, cfg) {
  const { timeoutMs } = cfg;
  let timeoutId;
  let didTimeout = false;

  const timeoutPromise = new Promise((resolve) => {
    timeoutId = setTimeout(() => {
      didTimeout = true;
      // eslint-disable-next-line no-console
      console.warn(
        "[calculatorRunner] Calculator exceeded soft timeout of",
        timeoutMs,
        "ms"
      );
      resolve(undefined);
    }, timeoutMs);
  });

  const fnPromise = Promise.resolve(fn(input, { ctx: cfg.ctx }));

  const winner = await Promise.race([fnPromise, timeoutPromise]);

  clearTimeout(timeoutId);

  if (didTimeout) {
    // The function may still resolve later; we don't care about that here.
    return winner;
  }

  return winner;
}

/**
 * Lightweight error serializer for event payloads.
 *
 * @param {any} err
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

export default {
  runCalculator,
  createSessionFromCalculatorResult,
};
