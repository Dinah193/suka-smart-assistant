/**
 * src/features/session/session.guards/battery.js
 * -----------------------------------------------------------------------------
 * Device Battery Guard (optional)
 *
 * Purpose:
 * - Prevents starting or advancing a session step if the device battery is too
 *   low or if the step is considered "long-running" and the device is not
 *   plugged in. This helps avoid losing progress/timers/voice when the device
 *   dies mid-session.
 *
 * How it fits:
 * - The SessionRunner should invoke this guard when:
 *   1) starting a session, or
 *   2) transitioning to a step that may be power-sensitive.
 * - The runner decides *when* to call based on its own policy; this guard
 *   provides a consistent allow/deny result and a retryAt hint.
 *
 * Triggering:
 * - This guard is "optional": there is no explicit "battery" blocker in the
 *   base contract. We recommend calling it when either:
 *     • the step lists "equipment" in blockers (e.g., requires screen-on/voice),
 *     • the step has metadata like { requiresBatteryPower: true } or
 *       { minBatteryPct: 0..100 }, or
 *     • the app enables a global policy (featureFlags.batteryGuard).
 *
 * Contracts:
 * - Event bus is available; guard emits only debug diagnostics (runner emits the
 *   user-facing session.* events).
 * - Returns a GuardResult with { allowed, guard: "battery", reason?, message?, retryAt? }.
 *
 * API/Resilience:
 * - Uses the Battery Status API when available (navigator.getBattery()).
 * - If unsupported or any error occurs, it *allows* progression (fail-open),
 *   but you can flip that via settings.failClosed=true (rarely recommended).
 *
 * Extension points:
 * - Household/runner can pass GuardContext.settings to tune thresholds.
 * - Future: Detect OS battery saver modes and apply stricter policy.
 *
 * Typed JSDoc below documents inputs and outputs.
 * -----------------------------------------------------------------------------
 */

import eventBus from "../../../services/events/eventBus";
import { featureFlags } from "../../../config/featureFlags";

/**
 * @typedef {Object} SessionStep
 * @property {string} id
 * @property {string} title
 * @property {string} desc
 * @property {number} durationSec
 * @property {Array<"inventory"|"weather"|"quietHours"|"sabbath"|"equipment">} blockers
 * @property {{
 *   tempTargetF?: number,
 *   donenessCue?: "color"|"texture"|"probeTemp"|"timer"|"smell",
 *   cueNotes?: string,
 *   requiresBatteryPower?: boolean,
 *   minBatteryPct?: number
 * }} [metadata]
 */

/**
 * @typedef {Object} Session
 * @property {string} id
 * @property {"cooking"|"cleaning"|"garden"|"animals"|"preservation"|"storehouse"} domain
 * @property {string} title
 * @property {{ type: "recipe"|"cleaningPlan"|"gardenPlan"|"animalTask"|"import"|"manual", refId: string|null }} source
 * @property {SessionStep[]} steps
 * @property {{ voiceGuidance?: boolean, haptic?: boolean, autoAdvance?: boolean }} prefs
 * @property {"pending"|"running"|"paused"|"completed"|"aborted"} status
 * @property {{ currentStepIndex: number, elapsedSec: number, startedAt: string|null, pausedAt: string|null }} progress
 * @property {{ skippedSteps: string[], adjustments: Array<any> }} analytics
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} GuardContext
 * @property {{
 *   enabled?: boolean,               // default true (or from feature flag)
 *   failClosed?: boolean,            // default false: if battery API fails, allow
 *   minBatteryPctDefault?: number,   // default 15
 *   longStepThresholdSec?: number,   // default 900 (15 min)
 *   requireChargingForLongSteps?: boolean, // default true
 *   disallowBelowMinWhenNotCharging?: boolean, // default true
 * }} [settings]
 * @property {(msg: string, data?: any) => void} [logger]
 */

/**
 * @typedef {Object} GuardResult
 * @property {boolean} allowed
 * @property {"battery"} guard
 * @property {string} [reason]
 * @property {string} [message]
 * @property {string} [retryAt] // ISO
 */

/**
 * Evaluate battery guard for a given step index.
 * @param {Session} session
 * @param {number} stepIndex - Index of the step under consideration (-1 means "session start").
 * @param {GuardContext} [ctx]
 * @returns {Promise<GuardResult>}
 */
export async function evaluateBatteryGuard(session, stepIndex, ctx = {}) {
  const log = ctx.logger || (() => {});
  const now = new Date();

  // Global/feature flag enablement.
  const enabled = isGuardEnabled(ctx?.settings);
  if (!enabled) return { allowed: true, guard: "battery" };

  // Determine if we *should* apply for this step.
  const step = stepIndex >= 0 ? session?.steps?.[stepIndex] : null;
  if (!shouldApplyForStep(step)) {
    return { allowed: true, guard: "battery" };
  }

  const settings = withDefaults(ctx?.settings);

  /** @type {BatterySnapshot|null} */
  let snapshot = null;
  try {
    snapshot = await readBatterySnapshot();
  } catch (err) {
    log("[batteryGuard] navigator.getBattery() threw", err);
    safeEmitDebug("guard.battery.error", { error: String(err) });
    // Fail-open unless configured otherwise.
    if (!settings.failClosed) return { allowed: true, guard: "battery" };
    return {
      allowed: false,
      guard: "battery",
      reason: "battery_api_unavailable",
      message:
        "Battery status unavailable. To avoid risk of losing progress, session is blocked by policy.",
      retryAt: undefined,
    };
  }

  if (!snapshot) {
    if (!settings.failClosed) return { allowed: true, guard: "battery" };
    return {
      allowed: false,
      guard: "battery",
      reason: "battery_snapshot_null",
      message:
        "Battery status could not be read. To avoid risk of losing progress, session is blocked by policy.",
    };
  }

  const minPct = chooseMinPct(step, settings);
  const longStep = isLongStep(step, settings);

  // If charging, we generally allow unless level is *extremely* low and step is long.
  if (snapshot.charging) {
    if (snapshot.levelPct >= Math.max(1, Math.min(minPct, 5))) {
      return { allowed: true, guard: "battery" };
    }
    // Very low and long-running: suggest waiting a bit.
    if (longStep && settings.requireChargingForLongSteps) {
      const retryAt = estimateReachPct(snapshot, Math.max(minPct, 5));
      return {
        allowed: false,
        guard: "battery",
        reason: "battery_too_low_even_while_charging",
        message: `Battery at ${snapshot.levelPct}%. Please charge for a few minutes before starting this long step.`,
        retryAt,
      };
    }
    return { allowed: true, guard: "battery" };
  }

  // Not charging:
  if (settings.disallowBelowMinWhenNotCharging && snapshot.levelPct < minPct) {
    return {
      allowed: false,
      guard: "battery",
      reason: "battery_below_min",
      message: `Battery at ${snapshot.levelPct}%. Minimum required is ${minPct}% for this step.`,
      retryAt: undefined, // unknown until user plugs in
    };
  }

  if (longStep && settings.requireChargingForLongSteps) {
    return {
      allowed: false,
      guard: "battery",
      reason: "not_charging_for_long_step",
      message:
        "This step is long-running. Please plug in your device (charging recommended) before continuing.",
      retryAt: undefined,
    };
  }

  return { allowed: true, guard: "battery" };
}

/* --------------------------------- Helpers -------------------------------- */

/**
 * Decide if this guard is enabled via settings or feature flag.
 */
function isGuardEnabled(settings) {
  const fromSettings =
    typeof settings?.enabled === "boolean" ? settings.enabled : undefined;
  if (typeof fromSettings === "boolean") return fromSettings;

  try {
    if (
      featureFlags &&
      Object.prototype.hasOwnProperty.call(featureFlags, "batteryGuard")
    ) {
      return !!featureFlags.batteryGuard;
    }
  } catch {
    // ignore
  }
  return true; // default on
}

/**
 * @param {GuardContext["settings"]} s
 */
function withDefaults(s) {
  const d = {
    enabled: true,
    failClosed: false,
    minBatteryPctDefault: 15,
    longStepThresholdSec: 900, // 15 minutes
    requireChargingForLongSteps: true,
    disallowBelowMinWhenNotCharging: true,
  };
  return Object.assign({}, d, s || {});
}

/**
 * Apply policy to decide if battery guard should run for a given step.
 * We consider it if:
 *  - step has 'equipment' blocker (likely needs screen/voice),
 *  - step.metadata.requiresBatteryPower === true,
 *  - step.metadata.minBatteryPct is set (explicit policy),
 *  - OR there's no step (session start) → apply conservatively.
 * @param {SessionStep|null} step
 */
function shouldApplyForStep(step) {
  if (!step) return true;
  if (Array.isArray(step.blockers) && step.blockers.includes("equipment"))
    return true;
  if (
    step.metadata &&
    (step.metadata.requiresBatteryPower ||
      isFinitePct(step.metadata.minBatteryPct))
  ) {
    return true;
  }
  return false;
}

/**
 * @param {SessionStep|null} step
 * @param {ReturnType<typeof withDefaults>} settings
 */
function chooseMinPct(step, settings) {
  const explicit = step?.metadata?.minBatteryPct;
  if (isFinitePct(explicit)) return clampPct(explicit);
  // Heuristic: longer steps deserve a bit more buffer.
  if (isLongStep(step, settings))
    return Math.max(settings.minBatteryPctDefault, 20);
  return settings.minBatteryPctDefault;
}

/**
 * @param {SessionStep|null} step
 * @param {ReturnType<typeof withDefaults>} settings
 */
function isLongStep(step, settings) {
  const dur = Number(step?.durationSec);
  return Number.isFinite(dur) && dur >= settings.longStepThresholdSec;
}

function isFinitePct(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 100;
}

function clampPct(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

function safeEmitDebug(type, data) {
  try {
    if (eventBus && typeof eventBus.emit === "function") {
      eventBus.emit({
        type,
        ts: new Date().toISOString(),
        source: "batteryGuard",
        data,
      });
    }
  } catch {
    // no-op
  }
}

/* ------------------------------ Battery Reader ---------------------------- */

/**
 * @typedef {Object} BatterySnapshot
 * @property {boolean} charging
 * @property {number} levelPct  // 0..100 integer
 * @property {number} level     // 0..1 float
 * @property {number|null} chargingTimeSec // seconds until full, or null/Infinity
 * @property {number|null} dischargingTimeSec // seconds until empty, or null/Infinity
 */

/**
 * Try to read the Battery Status API (where supported).
 * @returns {Promise<BatterySnapshot|null>}
 */
async function readBatterySnapshot() {
  // @ts-ignore
  if (typeof navigator === "undefined") return null;
  // Some browsers gate getBattery behind insecure context; handle carefully.
  // @ts-ignore
  const getBattery = navigator?.getBattery;
  if (typeof getBattery !== "function") return null;

  // @ts-ignore
  const mgr = await navigator.getBattery();
  if (!mgr) return null;

  const level = Number(mgr.level);
  const chargingTime = Number(mgr.chargingTime);
  const dischargingTime = Number(mgr.dischargingTime);

  return {
    charging: !!mgr.charging,
    levelPct: Math.round((Number.isFinite(level) ? level : 0) * 100),
    level: Number.isFinite(level) ? level : 0,
    chargingTimeSec: Number.isFinite(chargingTime) ? chargingTime : null,
    dischargingTimeSec: Number.isFinite(dischargingTime)
      ? dischargingTime
      : null,
  };
}

/**
 * Rough estimate of when a given target percentage might be reached.
 * Works only when currently charging and chargingTimeSec is provided by UA.
 * @param {BatterySnapshot} snap
 * @param {number} targetPct
 * @returns {string|undefined} ISO timestamp
 */
function estimateReachPct(snap, targetPct) {
  if (!snap.charging) return undefined;
  if (!Number.isFinite(snap.chargingTimeSec) || snap.chargingTimeSec == null)
    return undefined;

  const remainingPct = Math.max(0, targetPct - snap.levelPct);
  if (remainingPct <= 0) return new Date().toISOString();

  // If UA exposes total time to 100%, scale proportionally.
  const pctToFull = Math.max(1, 100 - snap.levelPct);
  const secs = (snap.chargingTimeSec * remainingPct) / pctToFull;
  const eta = new Date(Date.now() + Math.round(secs * 1000));
  return eta.toISOString();
}

/* ----------------------------- Public API Shape --------------------------- */

/**
 * Evaluate for current step (session.progress.currentStepIndex).
 * @param {Session} session
 * @param {GuardContext} [ctx]
 * @returns {Promise<GuardResult>}
 */
export async function evaluateForCurrentStep(session, ctx) {
  const idx = safeStepIndex(session);
  return evaluateBatteryGuard(session, idx, ctx);
}

/**
 * Return a best-effort next lift time (when we expect battery policy to allow),
 * or null if unknown. If charging and we can estimate time to min default (15%),
 * returns an ISO ETA. Otherwise null.
 * @param {GuardContext} [ctx]
 * @returns {Promise<string|null>}
 */
export async function nextBatteryLiftTime(ctx = {}) {
  const snap = await readBatterySnapshot().catch(() => null);
  if (!snap) return null;
  if (!snap.charging) return null;
  const iso = estimateReachPct(
    snap,
    withDefaults(ctx.settings).minBatteryPctDefault
  );
  return iso || null;
}

function safeStepIndex(session) {
  if (!session || !session.progress) return -1;
  const i = Number(session.progress.currentStepIndex);
  return Number.isFinite(i) && i >= 0 ? i : -1;
}

/* ------------------------------- Default Export --------------------------- */

const batteryGuard = {
  id: "battery",
  evaluate: evaluateBatteryGuard,
  evaluateForCurrentStep,
  nextLift: nextBatteryLiftTime,
};

export default batteryGuard;

/* --------------------------------- Usage -----------------------------------
 * // In SessionRunner (pseudo):
 * import batteryGuard from "@/features/session/session.guards/battery";
 *
 * async function guardCheck(session, stepIndex) {
 *   const res = await batteryGuard.evaluate(session, stepIndex, {
 *     settings: {
 *       // enabled: true,
 *       // minBatteryPctDefault: 20,
 *       // longStepThresholdSec: 1200,
 *       // requireChargingForLongSteps: true,
 *       // disallowBelowMinWhenNotCharging: true,
 *       // failClosed: false,
 *     },
 *   });
 *   if (!res.allowed) {
 *     // Runner pauses & surfaces res.message and a "Plug in" nudge.
 *     // Optionally schedule a retry at res.retryAt (if provided).
 *   }
 * }
 * -------------------------------------------------------------------------- */
