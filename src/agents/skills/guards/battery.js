/**
 * @file src/agents/skills/guards/battery.js
 *
 * Low-battery pause policy helper for Suka Smart Assistant (SSA).
 *
 * HOW THIS FITS:
 * - This module centralizes “what to do when the device battery is low.”
 * - It is consumed by:
 *   - `guardsEvaluate.js` via `env.batteryLevel` and `env.batterySaverEnabled`,
 *   - SessionRunner to decide when to gently pause a session or suggest
 *     switching to lower-intensity tasks,
 *   - any “Now” resolver that should avoid launching a long session when
 *     the device is about to die.
 *
 * BEHAVIOR:
 * - Reads battery info (when available) using the Battery Status API
 *   (`navigator.getBattery()`), with safe fallbacks when unavailable.
 * - Evaluates a low-battery policy:
 *   - < 5%: block / auto-pause recommended.
 *   - 5–15% or saver mode on: warn and suggest pausing or plugging in.
 *   - 15–100%: allowed.
 * - Emits telemetry events:
 *   - `battery.snapshot.read`
 *   - `battery.evaluated`
 *
 * NOTE:
 * - This file does not directly pause sessions; it returns decisions and
 *   suggestions. The SessionRunner + guards system chooses how to respond.
 */

import { emit } from '../../../services/eventBus';

/**
 * Normalized snapshot of battery state.
 *
 * @typedef {Object} BatterySnapshot
 * @property {number} level             Battery level in [0.0, 1.0]
 * @property {boolean} charging         Whether device is currently charging
 * @property {number|null} chargingTime Estimated seconds until fully charged, if known
 * @property {number|null} dischargingTime Estimated seconds until empty, if known
 * @property {boolean|null} saverMode   If low-power / battery saver is active (if detectable)
 * @property {string} lastUpdated       ISO timestamp for the snapshot
 */

/**
 * Options that influence evaluation behavior.
 *
 * @typedef {Object} BatteryPolicyOptions
 * @property {number} [criticalThreshold]  Level below which we block (0.0–1.0; default 0.05)
 * @property {number} [lowThreshold]       Level below which we warn (0.0–1.0; default 0.15)
 * @property {boolean} [treatSaverAsLow]   If true (default), saver mode triggers warn even if level is higher
 */

/**
 * High-level battery evaluation result.
 *
 * @typedef {Object} BatteryEvaluationResult
 * @property {boolean} isSafe                 True if “normal SSA session” is allowed
 * @property {'allow'|'warn'|'block'} decision
 * @property {'ok'|'low'|'critical'|'unknown'} reasonCode
 * @property {string[]} suggestions           Human-readable suggestions for SessionRunner UI
 * @property {string[]} warnings              Non-fatal API / environment issues
 * @property {BatterySnapshot|null} snapshot
 */

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Read a battery snapshot using the Battery Status API where available.
 *
 * If the environment does not expose `navigator.getBattery` (or the call
 * fails), this returns `null` and logs a warning in the evaluation result.
 *
 * Usage:
 * ```js
 * const snapshot = await readBatterySnapshot();
 * const evalResult = evaluateBatteryPolicy(snapshot);
 * const env = toGuardBatteryEnv(evalResult);
 * // pass env.batteryLevel and env.batterySaverEnabled into guardsEvaluate
 * ```
 *
 * @returns {Promise<BatterySnapshot|null>}
 */
export async function readBatterySnapshot() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    // Probably SSR / Node; no battery info.
    return null;
  }

  try {
    // Most modern browsers expose navigator.getBattery() → Promise<BatteryManager>
    if (typeof navigator.getBattery === 'function') {
      // @ts-ignore (BatteryManager is not in the default TS lib)
      const battery = await navigator.getBattery();

      const level = typeof battery.level === 'number' ? battery.level : 1;
      const charging = !!battery.charging;
      const chargingTime = Number.isFinite(battery.chargingTime)
        ? battery.chargingTime
        : null;
      const dischargingTime = Number.isFinite(battery.dischargingTime)
        ? battery.dischargingTime
        : null;

      /** @type {BatterySnapshot} */
      const snapshot = {
        level: clamp01(level),
        charging,
        chargingTime,
        dischargingTime,
        saverMode: detectBatterySaver(),
        lastUpdated: new Date().toISOString()
      };

      safeEmitBatterySnapshotRead(snapshot);
      return snapshot;
    }

    // Fallback: no getBattery support; we cannot read battery state.
    const snapshot = /** @type {BatterySnapshot} */ ({
      level: 1,
      charging: true,
      chargingTime: null,
      dischargingTime: null,
      saverMode: detectBatterySaver(),
      lastUpdated: new Date().toISOString()
    });

    safeEmitBatterySnapshotRead(snapshot, [
      'navigator.getBattery is not supported; assuming full battery.'
    ]);
    return snapshot;
  } catch (err) {
    // If the API throws, log and return null
    safeEmitBatterySnapshotRead(null, [
      `Battery API threw an error; battery unknown. (${String(err)})`
    ]);
    return null;
  }
}

/**
 * Evaluate the low-battery policy based on a snapshot and optional thresholds.
 *
 * Default policy:
 * - level < 5% (0.05) → `block` with `critical` reason:
 *   - strongly recommended to pause/abort sessions and plug in.
 * - 5% ≤ level < 15% → `warn` with `low` reason:
 *   - recommended to pause long sessions, especially if not charging.
 * - saverMode === true → at least `warn` even at higher levels.
 *
 * @param {BatterySnapshot|null} snapshot
 * @param {BatteryPolicyOptions} [options]
 * @returns {BatteryEvaluationResult}
 */
export function evaluateBatteryPolicy(snapshot, options = {}) {
  /** @type {BatteryEvaluationResult} */
  const base = {
    isSafe: true,
    decision: 'allow',
    reasonCode: 'ok',
    suggestions: [],
    warnings: [],
    snapshot: snapshot || null
  };

  const criticalThreshold =
    typeof options.criticalThreshold === 'number'
      ? clamp01(options.criticalThreshold)
      : 0.05;

  const lowThreshold =
    typeof options.lowThreshold === 'number'
      ? clamp01(options.lowThreshold)
      : 0.15;

  const treatSaverAsLow =
    typeof options.treatSaverAsLow === 'boolean'
      ? options.treatSaverAsLow
      : true;

  if (!snapshot) {
    const res = {
      ...base,
      isSafe: true,
      decision: 'warn',
      reasonCode: 'unknown',
      warnings: ['Battery state is unknown; proceeding but monitoring is recommended.'],
      snapshot: null
    };
    safeEmitBatteryEvaluated(res);
    return res;
  }

  const level = clamp01(snapshot.level);
  const saverMode = snapshot.saverMode;
  const charging = snapshot.charging;

  /** @type {'allow'|'warn'|'block'} */
  let decision = 'allow';
  /** @type {'ok'|'low'|'critical'|'unknown'} */
  let reasonCode = 'ok';
  /** @type {string[]} */
  const suggestions = [];
  /** @type {string[]} */
  const warnings = [];

  if (level <= criticalThreshold && !charging) {
    decision = 'block';
    reasonCode = 'critical';
    suggestions.push(
      'Battery is critically low; plug in your device before continuing.',
      'Consider pausing or aborting this session to avoid abrupt interruption.'
    );
  } else if (level <= lowThreshold && !charging) {
    decision = 'warn';
    reasonCode = 'low';
    suggestions.push(
      'Battery is low; consider plugging in or shortening this session.',
      'If this session contains long timers, you may want to pause until you can charge.'
    );
  }

  // If battery saver / low-power mode is active, at least warn.
  if (treatSaverAsLow && saverMode) {
    if (decision === 'allow') {
      decision = 'warn';
      reasonCode = 'low';
    }
    suggestions.push(
      'Battery saver mode is active; to prevent interruptions, consider plugging in before long sessions.'
    );
  }

  const isSafe = decision !== 'block';

  const result = {
    ...base,
    isSafe,
    decision,
    reasonCode,
    suggestions,
    warnings,
    snapshot
  };

  safeEmitBatteryEvaluated(result);
  return result;
}

/**
 * Convert a battery evaluation (or snapshot) into the environment fields
 * expected by `guardsEvaluate.js`:
 *
 * - `env.batteryLevel`
 * - `env.batterySaverEnabled`
 *
 * Usage:
 * ```js
 * const snapshot = await readBatterySnapshot();
 * const batteryEval = evaluateBatteryPolicy(snapshot);
 * const env = toGuardBatteryEnv(batteryEval);
 *
 * const guardResult = await evaluateGuardsForStep(session, {
 *   ...env,
 *   // other env flags: isSabbath, isQuietHours, inventorySnapshot, weatherSnapshot ...
 * });
 * ```
 *
 * @param {BatteryEvaluationResult|BatterySnapshot|null} input
 * @returns {{ batteryLevel: number|null, batterySaverEnabled: boolean }}
 */
export function toGuardBatteryEnv(input) {
  if (!input) {
    return {
      batteryLevel: null,
      batterySaverEnabled: false
    };
  }

  // Case 1: full evaluation
  // @ts-ignore
  if (input.reasonCode && input.snapshot !== undefined) {
    /** @type {BatteryEvaluationResult} */
    const evalResult = /** @type any */ (input);
    const snapshot = evalResult.snapshot;
    return {
      batteryLevel: snapshot ? clamp01(snapshot.level) : null,
      batterySaverEnabled: snapshot ? !!snapshot.saverMode : false
    };
  }

  // Case 2: raw snapshot
  /** @type {BatterySnapshot} */
  const snapshot = /** @type any */ (input);
  return {
    batteryLevel: clamp01(snapshot.level),
    batterySaverEnabled: !!snapshot.saverMode
  };
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Try to detect whether OS-level battery saver / low-power mode is active.
 *
 * NOTE:
 * - There is no standardized, cross-browser “battery saver” API.
 * - Here we hook into:
 *   - `navigator.connection.saveData` (Data Saver) as a weak hint.
 *   - You can extend this to use feature flags or user preferences later.
 *
 * @returns {boolean|null}  True/false if we can guess; null if unknown.
 */
function detectBatterySaver() {
  if (typeof navigator === 'undefined') return null;

  // Data Saver is not exactly battery saver, but it often correlates with
  // “trying to conserve resources,” which is good enough as a soft signal.
  // @ts-ignore
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (connection && typeof connection.saveData === 'boolean') {
    return connection.saveData;
  }

  return null;
}

/**
 * Clamp a number into [0, 1].
 *
 * @param {number} n
 * @returns {number}
 */
function clamp01(n) {
  if (!Number.isFinite(n)) return 1;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/* -------------------------------------------------------------------------- */
/*  Event emission                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Emit `battery.snapshot.read` for telemetry / debugging.
 *
 * Payload:
 * {
 *   type: 'battery.snapshot.read',
 *   ts: ISO8601,
 *   source: 'guards.battery',
 *   data: {
 *     snapshot: BatterySnapshot|null,
 *     warnings: string[]
 *   }
 * }
 *
 * @param {BatterySnapshot|null} snapshot
 * @param {string[]} [warnings]
 */
function safeEmitBatterySnapshotRead(snapshot, warnings = []) {
  try {
    if (typeof emit !== 'function') return;
    emit({
      type: 'battery.snapshot.read',
      ts: new Date().toISOString(),
      source: 'guards.battery',
      data: {
        snapshot,
        warnings
      }
    });
  } catch (_err) {
    // Never crash because of eventBus; swallow errors.
  }
}

/**
 * Emit `battery.evaluated` for analytics / automation.
 *
 * Payload:
 * {
 *   type: 'battery.evaluated',
 *   ts: ISO8601,
 *   source: 'guards.battery',
 *   data: BatteryEvaluationResult
 * }
 *
 * @param {BatteryEvaluationResult} result
 */
function safeEmitBatteryEvaluated(result) {
  try {
    if (typeof emit !== 'function') return;
    emit({
      type: 'battery.evaluated',
      ts: new Date().toISOString(),
      source: 'guards.battery',
      data: result
    });
  } catch (_err) {
    // Swallow errors; battery policy must never crash the app.
  }
}
