/**
 * @file src/agents/skills/sessions/guardsEvaluate.js
 *
 * Wrapper for guard evaluations (Sabbath, Quiet Hours, Weather, Inventory, Battery)
 * used by the SessionRunner and “Now” flows.
 *
 * HOW THIS FITS:
 * - SessionRunner calls `evaluateGuardsForStep(session, options)` before starting
 *   or advancing a step. The wrapper:
 *     - Looks at the step’s `blockers` array.
 *     - Runs only the relevant guard functions.
 *     - Aggregates results into a single `{ ok, blockedBy, results }` object.
 *     - Emits a `session.guards.evaluated` event for automation/analytics.
 * - UI can use the `blockedBy` list to:
 *     - Show warnings.
 *     - Trigger a “swap step/session” modal (e.g., suggest alternate tasks
 *       that *are* runnable given current inventory/weather/quiet hours).
 * - Guards are intentionally designed to be “data-in”:
 *     - This wrapper does NOT fetch weather, inventory, or calendar data itself.
 *     - Callers supply snapshots (weather, inventory, Sabbath/quiet flags, etc.)
 *       via `EvaluateGuardOptions`, so tests & other runtimes can plug in their own.
 *
 * EXTENSION POINTS:
 * - Add new guards by registering them in `GUARD_REGISTRY`.
 * - Use `registerGuard(id, fn)` to register at runtime if you want pluggable guards.
 */

import { emit } from "../../../services/events/eventBus"; // { type, ts, source, data }

/**
 * @typedef {'cooking'|'cleaning'|'garden'|'animals'|'preservation'|'storehouse'} SessionDomain
 */

/**
 * @typedef {'recipe'|'cleaningPlan'|'gardenPlan'|'animalTask'|'import'|'manual'} SessionSourceType
 */

/**
 * @typedef {'pending'|'running'|'paused'|'completed'|'aborted'} SessionStatus
 */

/**
 * @typedef {'inventory'|'weather'|'quietHours'|'sabbath'|'equipment'} SessionBlocker
 */

/**
 * @typedef {'color'|'texture'|'probeTemp'|'timer'|'smell'} DonenessCue
 */

/**
 * @typedef {Object} SessionSource
 * @property {SessionSourceType} type
 * @property {string|null} refId
 */

/**
 * @typedef {Object} SessionStepMetadata
 * @property {number} [tempTargetF]
 * @property {DonenessCue} [donenessCue]
 * @property {string} [cueNotes]
 */

/**
 * @typedef {Object} SessionStep
 * @property {string} id
 * @property {string} title
 * @property {string} desc
 * @property {number} durationSec
 * @property {SessionBlocker[]} blockers
 * @property {SessionStepMetadata} metadata
 */

/**
 * @typedef {Object} SessionPrefs
 * @property {boolean} voiceGuidance
 * @property {boolean} haptic
 * @property {boolean} autoAdvance
 */

/**
 * @typedef {Object} SessionProgress
 * @property {number} currentStepIndex
 * @property {number} elapsedSec
 * @property {string|null} startedAt
 * @property {string|null} pausedAt
 */

/**
 * @typedef {Object} SessionAnalytics
 * @property {string[]} skippedSteps
 * @property {Array<Object>} adjustments
 */

/**
 * @typedef {Object} Session
 * @property {string} id
 * @property {SessionDomain} domain
 * @property {string} title
 * @property {SessionSource} source
 * @property {SessionStep[]} steps
 * @property {SessionPrefs} prefs
 * @property {SessionStatus} status
 * @property {SessionProgress} progress
 * @property {SessionAnalytics} analytics
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * Input/environment context for guard evaluation.
 *
 * NOTE: This is intentionally generic. The wrapper does not know how you shape
 * inventory or weather data; guards simply receive what you pass through.
 *
 * @typedef {Object} EvaluateGuardOptions
 * @property {number} [stepIndex] Override which step to evaluate (defaults to session.progress.currentStepIndex)
 * @property {Date} [now] Current time; defaults to `new Date()`
 * @property {boolean} [isSabbath] Whether it is currently Sabbath
 * @property {boolean} [isQuietHours] Whether it is currently quiet hours
 * @property {number} [batteryLevel] Battery level from 0.0–1.0 (optional)
 * @property {boolean} [batterySaverEnabled] If battery saver / low power mode is on
 * @property {Object} [inventorySnapshot] Arbitrary structure; guards decide how to interpret
 * @property {Object} [weatherSnapshot] Arbitrary structure; guards decide how to interpret
 * @property {Object} [equipmentSnapshot] Arbitrary structure; guards decide how to interpret
 */

/**
 * Result from a single guard.
 *
 * @typedef {Object} GuardResult
 * @property {string} guard        Id of the guard (e.g., 'sabbath', 'inventory')
 * @property {boolean} ok          True if guard allows proceeding
 * @property {'allow'|'block'|'warn'} decision  High-level decision
 * @property {string} [reason]     Human-readable, localized-ready reason
 * @property {Object} [details]    Arbitrary extra details for UI / analytics
 */

/**
 * Aggregated result for a single step.
 *
 * @typedef {Object} AggregateGuardResult
 * @property {boolean} ok
 * @property {number} stepIndex
 * @property {string|null} stepId
 * @property {GuardResult[]} results
 * @property {GuardResult[]} blockedBy
 */

/**
 * Context passed into each guard function.
 *
 * @typedef {Object} GuardContext
 * @property {Session} session
 * @property {SessionStep} step
 * @property {number} stepIndex
 * @property {Date} now
 * @property {EvaluateGuardOptions} env
 */

/**
 * Guard function signature.
 * Must be synchronous or return a Promise.
 *
 * @callback GuardFn
 * @param {GuardContext} ctx
 * @returns {GuardResult|Promise<GuardResult>}
 */

/**
 * Registry of guard functions keyed by guard id.
 *
 * @type {Record<string, GuardFn>}
 */
const GUARD_REGISTRY = {
  sabbath: sabbathGuard,
  quietHours: quietHoursGuard,
  weather: weatherGuard,
  inventory: inventoryGuard,
  battery: batteryGuard,
};

/**
 * Register or override a guard at runtime.
 *
 * @param {string} id
 * @param {GuardFn} fn
 */
export function registerGuard(id, fn) {
  if (!id || typeof id !== "string" || typeof fn !== "function") return;
  GUARD_REGISTRY[id] = fn;
}

/**
 * Evaluate all guards needed for a single step, based on its `blockers` array.
 *
 * This is the primary entry point for the SessionRunner.
 *
 * Example usage in SessionRunner:
 * ```js
 * const guardResult = await evaluateGuardsForStep(session, {
 *   inventorySnapshot,
 *   weatherSnapshot,
 *   isSabbath,
 *   isQuietHours,
 *   batteryLevel,
 *   batterySaverEnabled
 * });
 *
 * if (!guardResult.ok) {
 *   // Show swap modal or warnings based on `guardResult.blockedBy`
 * }
 * ```
 *
 * @param {Session} session
 * @param {EvaluateGuardOptions} [options]
 * @returns {Promise<AggregateGuardResult>}
 */
export async function evaluateGuardsForStep(session, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();

  if (!session || typeof session !== "object") {
    return {
      ok: false,
      stepIndex: 0,
      stepId: null,
      results: [],
      blockedBy: [
        {
          guard: "system",
          ok: false,
          decision: "block",
          reason: "Invalid session object passed to guardsEvaluate.",
          details: {},
        },
      ],
    };
  }

  const steps = Array.isArray(session.steps) ? session.steps : [];
  const fallbackIndex =
    session.progress && Number.isInteger(session.progress.currentStepIndex)
      ? session.progress.currentStepIndex
      : 0;

  const stepIndex = clampIndex(
    typeof options.stepIndex === "number" ? options.stepIndex : fallbackIndex,
    steps.length
  );

  const step = steps[stepIndex];
  if (!step) {
    const result = {
      ok: true, // No step == nothing to block; SessionRunner will show a warning anyway.
      stepIndex,
      stepId: null,
      results: [],
      blockedBy: [],
    };
    safeEmitGuardsEvaluated(session, result);
    return result;
  }

  const blockers = Array.isArray(step.blockers) ? step.blockers : [];
  const requiredGuardIds = blockersToGuardIds(blockers);

  if (!requiredGuardIds.length) {
    const result = {
      ok: true,
      stepIndex,
      stepId: step.id || null,
      results: [],
      blockedBy: [],
    };
    safeEmitGuardsEvaluated(session, result);
    return result;
  }

  /** @type {GuardResult[]} */
  const guardResults = [];

  for (const guardId of requiredGuardIds) {
    const fn = GUARD_REGISTRY[guardId];
    if (typeof fn !== "function") {
      guardResults.push({
        guard: guardId,
        ok: true,
        decision: "warn",
        reason: `Guard "${guardId}" not implemented; allowing step but logging warning.`,
        details: {},
      });
      continue;
    }

    /** @type {GuardContext} */
    const ctx = {
      session,
      step,
      stepIndex,
      now,
      env: options,
    };

    try {
      const res = await Promise.resolve(fn(ctx));
      guardResults.push(normalizeGuardResult(guardId, res));
    } catch (err) {
      guardResults.push({
        guard: guardId,
        ok: true,
        decision: "warn",
        reason: `Guard "${guardId}" threw an error; allowing step but logging warning.`,
        details: { error: String(err) },
      });
    }
  }

  const blockedBy = guardResults.filter((r) => !r.ok || r.decision === "block");
  const aggregate = {
    ok: blockedBy.length === 0,
    stepIndex,
    stepId: step.id || null,
    results: guardResults,
    blockedBy,
  };

  safeEmitGuardsEvaluated(session, aggregate);
  return aggregate;
}

/**
 * Back-compat alias:
 * HouseholdOrchestrator imports `evaluateGuards` from this module.
 * Keep evaluateGuardsForStep as the canonical implementation.
 *
 * @param {Session} session
 * @param {EvaluateGuardOptions} [options]
 * @returns {Promise<AggregateGuardResult>}
 */
export const evaluateGuards = evaluateGuardsForStep;

/**
 * Optional: Evaluate guards across all steps to pre-compute which steps
 * are runnable under current conditions. This can be used by:
 * - “Now” resolver to pick the next runnable session/step.
 * - Swap modal to suggest alternative steps when the current one is blocked.
 *
 * NOTE: This runs guards for *each* step sequentially by default. If you expect
 * many steps and expensive guards, you can change to parallel, but then make
 * sure guards can handle it.
 *
 * @param {Session} session
 * @param {EvaluateGuardOptions} [options]
 * @returns {Promise<AggregateGuardResult[]>}
 */
export async function evaluateGuardsForSession(session, options = {}) {
  if (
    !session ||
    typeof session !== "object" ||
    !Array.isArray(session.steps)
  ) {
    return [];
  }

  /** @type {AggregateGuardResult[]} */
  const results = [];
  for (let i = 0; i < session.steps.length; i += 1) {
    // Reuse the same options with stepIndex override
    // eslint-disable-next-line no-await-in-loop
    const res = await evaluateGuardsForStep(session, {
      ...options,
      stepIndex: i,
    });
    results.push(res);
  }
  return results;
}

/**
 * Map `SessionBlocker` values to guard ids.
 *
 * @param {SessionBlocker[]} blockers
 * @returns {string[]}
 */
function blockersToGuardIds(blockers) {
  /** @type {Set<string>} */
  const ids = new Set();

  for (const b of blockers) {
    if (b === "sabbath") ids.add("sabbath");
    if (b === "quietHours") ids.add("quietHours");
    if (b === "weather") ids.add("weather");
    if (b === "inventory") ids.add("inventory");
    if (b === "equipment") {
      // Equipment can be evaluated as part of inventory or a separate guard;
      // we’ll treat it as inventory for now, but this is a natural extension point.
      ids.add("inventory");
    }
  }

  return Array.from(ids);
}

/**
 * Make sure guard result always has required properties.
 *
 * @param {string} guardId
 * @param {GuardResult} res
 * @returns {GuardResult}
 */
function normalizeGuardResult(guardId, res) {
  const ok = typeof res.ok === "boolean" ? res.ok : true;
  const decision = res.decision || (ok ? "allow" : "block");
  return {
    guard: guardId,
    ok,
    decision,
    reason: typeof res.reason === "string" ? res.reason : undefined,
    details: res.details || {},
  };
}

/**
 * Clamp step index to valid range.
 *
 * @param {number} index
 * @param {number} len
 * @returns {number}
 */
function clampIndex(index, len) {
  if (!Number.isFinite(index)) return 0;
  if (len <= 0) return 0;
  if (index < 0) return 0;
  if (index >= len) return len - 1;
  return index;
}

/**
 * Emit `session.guards.evaluated` for automation & analytics.
 *
 * Payload:
 * {
 *   type: 'session.guards.evaluated',
 *   ts: ISO8601,
 *   source: 'sessions.guards',
 *   data: {
 *     sessionId,
 *     domain,
 *     stepIndex,
 *     stepId,
 *     ok,
 *     blockedBy,
 *     results
 *   }
 * }
 *
 * @param {Session} session
 * @param {AggregateGuardResult} result
 */
function safeEmitGuardsEvaluated(session, result) {
  try {
    if (typeof emit !== "function") return;
    emit({
      type: "session.guards.evaluated",
      ts: new Date().toISOString(),
      source: "sessions.guards",
      data: {
        sessionId: session.id,
        domain: session.domain,
        stepIndex: result.stepIndex,
        stepId: result.stepId,
        ok: result.ok,
        blockedBy: result.blockedBy,
        results: result.results,
      },
    });
  } catch (err) {
    // Swallow errors; guards should never crash the app because of eventBus issues.
    // console.warn('[sessions.guards] Failed to emit session.guards.evaluated', err);
  }
}

/* -------------------------------------------------------------------------- */
/*  Default Guard Implementations (Stubs with sensible behavior)              */
/* -------------------------------------------------------------------------- */

/**
 * Sabbath guard
 * Blocks if:
 * - step has 'sabbath' blocker AND env.isSabbath === true
 *
 * @type {GuardFn}
 */
async function sabbathGuard(ctx) {
  const { env } = ctx;
  const isSabbath = !!env.isSabbath;

  if (!isSabbath) {
    return {
      guard: "sabbath",
      ok: true,
      decision: "allow",
      reason: "Not Sabbath – step allowed.",
      details: {},
    };
  }

  return {
    guard: "sabbath",
    ok: false,
    decision: "block",
    reason: "This step is blocked during Sabbath.",
    details: {
      isSabbath: true,
    },
  };
}

/**
 * Quiet Hours guard
 * Blocks if:
 * - step has 'quietHours' blocker AND env.isQuietHours === true
 *
 * @type {GuardFn}
 */
async function quietHoursGuard(ctx) {
  const { env } = ctx;
  const isQuiet = !!env.isQuietHours;

  if (!isQuiet) {
    return {
      guard: "quietHours",
      ok: true,
      decision: "allow",
      reason: "Not quiet hours – step allowed.",
      details: {},
    };
  }

  return {
    guard: "quietHours",
    ok: false,
    decision: "block",
    reason: "This step is blocked during quiet hours.",
    details: {
      isQuietHours: true,
    },
  };
}

/**
 * Weather guard
 * Example behavior:
 * - If env.weatherSnapshot indicates “severe” or “unsafe” and this step has
 *   a weather blocker, block or warn accordingly.
 *
 * NOTE: We don’t know your weather schema; this is a stub that expects
 *   something like `{ severity: 'ok'|'rain'|'storm'|'heat' }`.
 *
 * @type {GuardFn}
 */
async function weatherGuard(ctx) {
  const { env } = ctx;
  const weather = env.weatherSnapshot || {};
  const severity =
    typeof weather.severity === "string" ? weather.severity : "ok";

  if (severity === "storm" || severity === "danger") {
    return {
      guard: "weather",
      ok: false,
      decision: "block",
      reason: "Current weather conditions make this step unsafe.",
      details: { severity },
    };
  }

  if (severity === "rain" || severity === "heat") {
    return {
      guard: "weather",
      ok: true,
      decision: "warn",
      reason: "Weather is not ideal; proceed with caution.",
      details: { severity },
    };
  }

  return {
    guard: "weather",
    ok: true,
    decision: "allow",
    reason: "Weather is acceptable for this step.",
    details: { severity },
  };
}

/**
 * Inventory guard
 * Example behavior:
 * - If env.inventorySnapshot indicates missing critical items for this step,
 *   block or warn.
 *
 * NOTE: We don’t know your schema; we assume:
 *   env.inventorySnapshot.missingCritical is an array of strings.
 *
 * @type {GuardFn}
 */
async function inventoryGuard(ctx) {
  const { env, step } = ctx;
  const inv = env.inventorySnapshot || {};
  const missingCritical = Array.isArray(inv.missingCritical)
    ? inv.missingCritical
    : [];

  if (!missingCritical.length) {
    return {
      guard: "inventory",
      ok: true,
      decision: "allow",
      reason: "No critical inventory issues reported.",
      details: {},
    };
  }

  return {
    guard: "inventory",
    ok: false,
    decision: "block",
    reason: "Required items are missing for this step.",
    details: {
      stepId: step.id,
      missingCritical,
    },
  };
}

/**
 * Battery guard (optional)
 * Example behavior:
 * - If batteryLevel is < 0.15 and this step is expected to be long,
 *   we can warn or block based on your preference.
 *
 * This stub chooses:
 * - < 5%: block
 * - 5–15% (or batterySaverEnabled): warn
 *
 * @type {GuardFn}
 */
async function batteryGuard(ctx) {
  const { env, step } = ctx;
  const level = typeof env.batteryLevel === "number" ? env.batteryLevel : 1;
  const saver = !!env.batterySaverEnabled;

  if (level < 0.05) {
    return {
      guard: "battery",
      ok: false,
      decision: "block",
      reason: "Battery too low to safely run this session step.",
      details: {
        batteryLevel: level,
        batterySaverEnabled: saver,
        stepId: step.id,
      },
    };
  }

  if (level < 0.15 || saver) {
    return {
      guard: "battery",
      ok: true,
      decision: "warn",
      reason: "Battery is low; consider plugging in before continuing.",
      details: {
        batteryLevel: level,
        batterySaverEnabled: saver,
        stepId: step.id,
      },
    };
  }

  return {
    guard: "battery",
    ok: true,
    decision: "allow",
    reason: "Battery level is sufficient.",
    details: {
      batteryLevel: level,
      batterySaverEnabled: saver,
      stepId: step.id,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* NOTE ON SWAP MODAL INTEGRATION                                             */
/* -------------------------------------------------------------------------- */
/**
 * The actual “swap session/step” modal lives in your UI layer (e.g., a global
 * SessionRunnerSwapModal component). It should subscribe to:
 *   - `session.guards.evaluated` events (via eventBus), and
 *   - user actions from SessionRunner (e.g., “Show alternatives” button).
 *
 * Typical flow:
 * 1. SessionRunner calls `evaluateGuardsForStep(...)`.
 * 2. If `ok === false`, it shows a compact guard summary.
 * 3. User taps “See alternatives” → UI opens the swap modal.
 * 4. Swap modal uses `evaluateGuardsForSession(...)` and/or other SSA engines
 *    (like SessionComposer) to propose:
 *      - other steps in current session that are runnable now,
 *      - or other sessions in the domain that are runnable.
 * 5. Once user selects a replacement, SessionRunner resumes with the new step.
 *
 * Because this file is non-UI, we only provide the guard results and events
 * for that modal to hook into.
 */
