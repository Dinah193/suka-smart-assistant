/**
 * src/features/session/session.guards/sabbath.js
 * -----------------------------------------------------------------------------
 * Sabbath Guard
 *
 * Purpose:
 * - Prevents starting or advancing a session step when the weekly Sabbath is in
 *   effect (from local Friday sunset to Saturday sunset).
 *
 * How it fits:
 * - This guard is invoked by the SessionRunner before:
 *   1) starting a session that declares "sabbath" in any step.blockers, or
 *   2) advancing to a step that declares "sabbath" in its blockers.
 * - It returns a structured result indicating whether to allow progress, and if
 *   blocked, when the guard expects the restriction to lift (retryAt).
 *
 * Contracts:
 * - EventBus exists, but guards do NOT emit events; the runner emits higher-level
 *   events (e.g., session.paused) based on aggregated guard outcomes.
 * - Feature flags are available; if you later add a toggle to disable sabbath
 *   checks globally, wire it into `isGuardGloballyEnabled()`.
 *
 * Resilience:
 * - If a precise sun-times provider is not available, we fall back to a
 *   conservative fixed window: Friday 17:00 (5pm) → Saturday 21:00 (9pm) *local time*.
 * - All logic is defensive with sane defaults, visible reason codes, and retryAt.
 *
 * Extension points:
 * - Plug in a real sun-times provider (e.g., one that wraps SunCalc) via `ctx.sunTimesProvider`.
 * - Respect household overrides (e.g., alternate observance rules) via `ctx.settings.sabbath`.
 *
 * Typed JSDoc below documents the shape used by callers and return values.
 * -----------------------------------------------------------------------------
 */

import eventBus from "../../../services/events/eventBus"; // Optional: used for debug emits; safe if unused
import { featureFlags } from "../../../config/featureFlags";

/**
 * @typedef {Object} SessionStep
 * @property {string} id
 * @property {string} title
 * @property {string} desc
 * @property {number} durationSec
 * @property {Array<"inventory"|"weather"|"quietHours"|"sabbath"|"equipment">} blockers
 * @property {{ tempTargetF?: number, donenessCue?: "color"|"texture"|"probeTemp"|"timer"|"smell", cueNotes?: string }} [metadata]
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
 * @property {{ enabled?: boolean, startRule?: "sunset"|"fixed", fixedStartHourLocal?: number, fixedEndHourLocal?: number }} [settings] - Optional sabbath settings (household overrides).
 * @property {{ lat?: number, lon?: number }} [coords] - Optional coordinates for sunset calc.
 * @property {(isoDate: string, lat: number, lon: number) => { sunset: string, nextSunset: string }} [sunTimesProvider]
 *   A function that returns local sunset ISO timestamps for the given date and the next day.
 *   Minimal contract: Given a local-calendar date (YYYY-MM-DD in the ISO string is sufficient),
 *   return { sunset, nextSunset } as ISO strings in the *local timezone*. If you provide UTC,
 *   include the offset (e.g., 2025-11-12T23:05:00-06:00).
 * @property {(msg: string, data?: any) => void} [logger] - Optional logger for diagnostics.
 */

/**
 * @typedef {Object} GuardResult
 * @property {boolean} allowed - Whether progression is allowed.
 * @property {"sabbath"} guard - Guard identifier.
 * @property {string} [reason] - Short machine-friendly reason code when blocked.
 * @property {string} [message] - Human-friendly explanation when blocked.
 * @property {string} [retryAt] - ISO timestamp when the guard expects to lift.
 */

/**
 * Evaluate sabbath guard for a given session + step.
 *
 * @param {Session} session
 * @param {number} stepIndex - Index of the step being considered (can be -1 for "session start").
 * @param {GuardContext} [ctx]
 * @returns {Promise<GuardResult>}
 */
export async function evaluateSabbathGuard(session, stepIndex, ctx = {}) {
  const log = ctx.logger || (() => {});
  const now = new Date();

  // 1) Quick global disable hook (future-proof).
  if (!isGuardGloballyEnabled()) {
    return { allowed: true, guard: "sabbath" };
  }

  // 2) If the relevant step (or any step for session start) doesn't declare sabbath, allow.
  const shouldApply =
    stepIndex >= 0
      ? hasBlocker(session?.steps?.[stepIndex], "sabbath")
      : session?.steps?.some((s) => hasBlocker(s, "sabbath"));

  if (!shouldApply) {
    return { allowed: true, guard: "sabbath" };
  }

  // 3) Determine whether Sabbath is currently active.
  try {
    const activeInfo = await isSabbathActive(now, ctx);
    if (!activeInfo.active) {
      return { allowed: true, guard: "sabbath" };
    }

    const message = "Sabbath observed: session is paused until Sabbath ends.";
    const reason = "sabbath_active";
    const retryAtIso = activeInfo.endsAt?.toISOString();

    // Optional debug emit for operator inspection (not user-facing event).
    safeEmitDebug("guard.sabbath.blocked", {
      ts: new Date().toISOString(),
      source: "sabbathGuard",
      data: {
        sessionId: session?.id || null,
        stepIndex,
        reason,
        retryAt: retryAtIso,
      },
    });

    return {
      allowed: false,
      guard: "sabbath",
      reason,
      message,
      retryAt: retryAtIso,
    };
  } catch (err) {
    log("[sabbathGuard] error while checking:", err);
    // Fail-safe: if we cannot determine accurately, allow progression but log.
    safeEmitDebug("guard.sabbath.error", {
      ts: new Date().toISOString(),
      source: "sabbathGuard",
      data: { error: String(err) },
    });
    return { allowed: true, guard: "sabbath" };
  }
}

/**
 * Determine if the Sabbath is active at a given moment.
 * If a sunTimesProvider is supplied, we compute Friday→Saturday sunset window precisely.
 * Otherwise we use a conservative fixed window: Fri 17:00 → Sat 21:00 local.
 *
 * @param {Date} at
 * @param {GuardContext} ctx
 * @returns {Promise<{ active: boolean, startsAt?: Date, endsAt?: Date }>}
 */
export async function isSabbathActive(at, ctx = {}) {
  const settings = normalizeSettings(ctx.settings);

  if (settings.enabled === false) {
    return { active: false };
  }

  // Try precise sunset rule when requested and provider available.
  if (
    settings.startRule === "sunset" &&
    typeof ctx.sunTimesProvider === "function"
  ) {
    const { startsAt, endsAt } = computeSabbathWindowBySunset(at, ctx);
    const active = at >= startsAt && at < endsAt;
    return { active, startsAt, endsAt };
  }

  // Fixed-window fallback (no external deps).
  const { startsAt, endsAt } = computeSabbathWindowFixed(at, settings);
  const active = at >= startsAt && at < endsAt;
  return { active, startsAt, endsAt };
}

/* --------------------------------- Helpers -------------------------------- */

function isGuardGloballyEnabled() {
  // Hook for a future feature flag (e.g., featureFlags.sabbathGuard)
  // Default: enabled.
  try {
    if (
      featureFlags &&
      Object.prototype.hasOwnProperty.call(featureFlags, "sabbathGuard")
    ) {
      return !!featureFlags.sabbathGuard;
    }
  } catch {
    // ignore
  }
  return true;
}

/**
 * @param {SessionStep|undefined|null} step
 * @param {string} blocker
 */
function hasBlocker(step, blocker) {
  if (!step || !Array.isArray(step.blockers)) return false;
  return step.blockers.includes(blocker);
}

/**
 * Normalizes settings with defaults.
 * @param {GuardContext["settings"]} raw
 */
function normalizeSettings(raw) {
  const defaults = {
    enabled: true,
    startRule: "sunset", // prefer sunset when possible
    fixedStartHourLocal: 17, // 5pm Friday
    fixedEndHourLocal: 21, // 9pm Saturday
  };
  return Object.assign({}, defaults, raw || {});
}

/**
 * Compute Sabbath window using a sunset provider.
 * Friday sunset → Saturday sunset relative to the week containing `at`.
 * @param {Date} at
 * @param {GuardContext} ctx
 * @returns {{ startsAt: Date, endsAt: Date }}
 */
function computeSabbathWindowBySunset(at, ctx) {
  // Determine the "Friday" and "Saturday" for the week of `at` in local time.
  const local = toLocalYmd(at);
  const dow = at.getDay(); // 0=Sun, 5=Fri, 6=Sat

  // Build dates for Friday and Saturday of the current "Sabbath week"
  const friday = shiftLocalDate(local, 5 - dow);
  const saturday = shiftLocalDate(local, 6 - dow);

  const fridayIso = `${friday}T00:00:00`; // local-calendar date; provider should interpret locally
  const saturdayIso = `${saturday}T00:00:00`; // same

  const lat = toNumberOrNull(ctx.coords?.lat);
  const lon = toNumberOrNull(ctx.coords?.lon);

  let fridaySunsetISO, saturdaySunsetISO;

  try {
    const fri = ctx.sunTimesProvider(fridayIso, lat ?? 0, lon ?? 0);
    const sat = ctx.sunTimesProvider(saturdayIso, lat ?? 0, lon ?? 0);
    fridaySunsetISO = validIso(fri?.sunset) ? fri.sunset : null;
    saturdaySunsetISO = validIso(sat?.sunset) ? sat.sunset : null;
  } catch (e) {
    // If provider fails, fall back to fixed for this evaluation.
    return computeSabbathWindowFixed(at, normalizeSettings());
  }

  if (!fridaySunsetISO || !saturdaySunsetISO) {
    return computeSabbathWindowFixed(at, normalizeSettings());
  }

  const startsAt = new Date(fridaySunsetISO);
  const endsAt = new Date(saturdaySunsetISO);

  // Safety: Ensure endsAt is after startsAt. If not, push by 24h.
  if (!(endsAt > startsAt)) {
    endsAt.setDate(endsAt.getDate() + 1);
  }

  return { startsAt, endsAt };
}

/**
 * Fixed window: Friday HH:00 → Saturday HH:00 local time.
 * @param {Date} at
 * @param {{ fixedStartHourLocal: number, fixedEndHourLocal: number }} settings
 */
function computeSabbathWindowFixed(at, settings) {
  const local = toLocalYmd(at);
  const dow = at.getDay(); // 0=Sun ... 6=Sat
  const fridayYmd = shiftLocalDate(local, 5 - dow);
  const saturdayYmd = shiftLocalDate(local, 6 - dow);

  const startsAt = localDateTime(fridayYmd, settings.fixedStartHourLocal);
  const endsAt = localDateTime(saturdayYmd, settings.fixedEndHourLocal);

  // Safety: ensure ordering.
  if (!(endsAt > startsAt)) {
    endsAt.setDate(endsAt.getDate() + 1);
  }

  return { startsAt, endsAt };
}

/**
 * Convert Date -> YYYY-MM-DD in local timezone.
 * @param {Date} d
 */
function toLocalYmd(d) {
  const y = d.getFullYear();
  const m = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  return `${y}-${m}-${day}`;
}

function pad2(n) {
  return n < 10 ? `0${n}` : `${n}`;
}

/**
 * Shift a YYYY-MM-DD by some number of days (can be negative).
 * @param {string} ymd
 * @param {number} deltaDays
 */
function shiftLocalDate(ymd, deltaDays) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + deltaDays);
  return toLocalYmd(dt);
}

/**
 * Build a local Date at YYYY-MM-DD + hour (HH:00:00).
 * @param {string} ymd
 * @param {number} hourLocal
 */
function localDateTime(ymd, hourLocal) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d, clampHour(hourLocal), 0, 0, 0);
}

function clampHour(h) {
  if (Number.isFinite(h)) {
    if (h < 0) return 0;
    if (h > 23) return 23;
    return Math.floor(h);
  }
  return 17; // default to 17:00 if invalid
}

function toNumberOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function validIso(s) {
  return typeof s === "string" && !Number.isNaN(Date.parse(s));
}

function safeEmitDebug(type, data) {
  try {
    if (eventBus && typeof eventBus.emit === "function") {
      eventBus.emit({
        type,
        ts: new Date().toISOString(),
        source: "sabbathGuard",
        data,
      });
    }
  } catch {
    // no-op
  }
}

/* ----------------------------- Public API Shape ---------------------------- */

/**
 * Convenience: evaluate for the current step in `session.progress.currentStepIndex`.
 * @param {Session} session
 * @param {GuardContext} [ctx]
 * @returns {Promise<GuardResult>}
 */
export async function evaluateForCurrentStep(session, ctx) {
  const idx = safeStepIndex(session);
  return evaluateSabbathGuard(session, idx, ctx);
}

/**
 * Utility: returns the next moment when Sabbath ends, or null if not active.
 * @param {GuardContext} [ctx]
 * @returns {Promise<string|null>} ISO string or null
 */
export async function nextSabbathLiftTime(ctx = {}) {
  const now = new Date();
  const { active, endsAt } = await isSabbathActive(now, ctx);
  return active && endsAt ? endsAt.toISOString() : null;
}

function safeStepIndex(session) {
  if (!session || !session.progress) return -1;
  const i = Number(session.progress.currentStepIndex);
  return Number.isFinite(i) && i >= 0 ? i : -1;
}

/* ------------------------------- Default Export ---------------------------- */

const sabbathGuard = {
  id: "sabbath",
  evaluate: evaluateSabbathGuard,
  evaluateForCurrentStep,
  isActive: isSabbathActive,
  nextLift: nextSabbathLiftTime,
};

export default sabbathGuard;

/* --------------------------------- Usage -----------------------------------
 * // In SessionRunner (pseudo):
 * import sabbathGuard from "@/features/session/session.guards/sabbath";
 *
 * async function guardCheck(session, stepIndex, ctx) {
 *   const result = await sabbathGuard.evaluate(session, stepIndex, {
 *     ...ctx,
 *     // Optional precise calculations:
 *     // sunTimesProvider: (isoYmd, lat, lon) => mySunCalcWrapper(isoYmd, lat, lon),
 *     // coords: { lat, lon },
 *     // settings: { startRule: "sunset" } // or "fixed" with custom hours
 *   });
 *   if (!result.allowed) {
 *     // Runner will pause & schedule retry using result.retryAt if provided.
 *   }
 * }
 * -------------------------------------------------------------------------- */
