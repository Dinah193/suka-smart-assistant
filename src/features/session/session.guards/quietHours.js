/**
 * src/features/session/session.guards/quietHours.js
 * -----------------------------------------------------------------------------
 * Quiet Hours Guard
 *
 * Purpose:
 * - Prevents starting/advancing a step when the household is within configured
 *   "quiet hours" (e.g., 10:00 PM–7:00 AM). This is typically used to suppress
 *   noisy activities (blenders, vacuums) or voice announcements while family
 *   members are sleeping or resting.
 *
 * How it fits:
 * - The SessionRunner invokes this guard:
 *   • when starting a session or transitioning to a step that declares
 *     "quietHours" in its blockers.
 * - The guard determines whether the *current time* falls within a configured
 *   quiet-hours window and whether the step is considered “noisy”.
 * - If blocked, it returns a retryAt ISO timestamp for when quiet hours end.
 *
 * Contracts & Signals:
 * - EventBus exists; this guard only emits debug signals (runner emits
 *   session.* events).
 * - Feature flag: featureFlags.quietHoursGuard (default ON if missing).
 *
 * Resilience:
 * - If schedule is missing or invalid, we fail-open (allow) unless
 *   settings.failClosed = true.
 * - Supports windows that cross midnight (e.g., 22:00–07:00).
 *
 * Heuristics to determine “noisy” step (customizable via settings):
 * - Explicit step.metadata.noisy === true → noisy.
 * - session.prefs.voiceGuidance === true → counts as noisy unless
 *   settings.allowVoiceDuringQuiet === true.
 * - step.metadata.donenessCue === "timer" → may beep; considered noisy unless
 *   settings.allowTimersDuringQuiet === true.
 *
 * Extension points:
 * - Add per-domain noise policies or equipment-driven noise checks.
 * - Respect per-day overrides, special dates (holidays) via settings.overrides.
 *
 * Typed JSDoc documents inputs/outputs.
 * -----------------------------------------------------------------------------
 */

import eventBus from "../../../services/eventBus";
import { featureFlags } from "../../../services/featureFlags";

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
 *   noisy?: boolean
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
 * Quiet hours schedule model:
 * - windows: Record<0..6, Array<[startHHmm,endHHmm]>>
 *   where 0 = Sunday per JS Date.getDay()
 * - timezone (IANA) is optional and informational; we evaluate in local time.
 *   If you need cross-timezone consistency, run the guard in a time service.
 *
 * Example:
 *   {
 *     timezone: "America/Chicago",
 *     windows: {
 *       0: [["22:00","07:00"]],
 *       1: [["22:00","06:30"]],
 *       2: [["22:00","06:30"]],
 *       3: [["22:00","06:30"]],
 *       4: [["22:30","06:30"]],
 *       5: [["23:00","07:30"]],
 *       6: [["23:00","07:30"]]
 *     }
 *   }
 */

/**
 * @typedef {Object} QuietSchedule
 * @property {string} [timezone]
 * @property {Record<string, Array<[string,string]>>} [windows]
 */

/**
 * @typedef {Object} GuardContext
 * @property {{
 *   enabled?: boolean,                 // default true or feature flag
 *   failClosed?: boolean,              // default false
 *   schedule?: QuietSchedule,          // quiet windows (HH:mm pairs)
 *   allowVoiceDuringQuiet?: boolean,   // default false
 *   allowTimersDuringQuiet?: boolean,  // default false
 *   treatUnknownAsNoisy?: boolean,     // default false
 * }} [settings]
 * @property {(msg: string, data?: any) => void} [logger]
 */

/**
 * @typedef {Object} GuardResult
 * @property {boolean} allowed
 * @property {"quietHours"} guard
 * @property {string} [reason]
 * @property {string} [message]
 * @property {string} [retryAt] // ISO when quiet hours end
 */

/**
 * Evaluate quiet hours guard for a given step.
 * @param {Session} session
 * @param {number} stepIndex - Index of the step under consideration (-1 = "session start")
 * @param {GuardContext} [ctx]
 * @returns {Promise<GuardResult>}
 */
export async function evaluateQuietHoursGuard(session, stepIndex, ctx = {}) {
  const log = ctx.logger || (() => {});

  if (!isGuardEnabled(ctx?.settings)) {
    return { allowed: true, guard: "quietHours" };
  }

  const step = resolveStep(session, stepIndex);
  if (!hasBlocker(step, "quietHours")) {
    return { allowed: true, guard: "quietHours" };
  }

  const settings = withDefaults(ctx.settings);
  const schedule = normalizeSchedule(settings.schedule);

  if (!schedule) {
    // Missing schedule: allow unless failClosed.
    if (!settings.failClosed) return { allowed: true, guard: "quietHours" };
    return {
      allowed: false,
      guard: "quietHours",
      reason: "schedule_missing",
      message: "Quiet hours schedule is not configured.",
    };
  }

  // Determine if this step is “noisy”.
  const noisy = isStepNoisy(step, session, settings);
  if (!noisy) {
    // Non-noisy steps can proceed during quiet hours.
    return { allowed: true, guard: "quietHours" };
  }

  // Evaluate current time against today's windows (with cross-midnight support).
  const now = new Date();
  const state = evaluateWindows(now, schedule.windows);

  if (!state.active) {
    return { allowed: true, guard: "quietHours" };
  }

  const msg = `Quiet hours are active until ${humanTime(state.endsAt)}. This step appears noisy.`;
  const retryAtIso = state.endsAt ? state.endsAt.toISOString() : undefined;

  safeEmitDebug("guard.quietHours.blocked", {
    sessionId: safeId(session),
    stepId: step?.id || null,
    endsAt: retryAtIso,
  });

  return {
    allowed: false,
    guard: "quietHours",
    reason: "quiet_hours_active",
    message: msg,
    retryAt: retryAtIso,
  };
}

/* --------------------------------- Helpers -------------------------------- */

function isGuardEnabled(settings) {
  const fromSettings =
    typeof settings?.enabled === "boolean" ? settings.enabled : undefined;
  if (typeof fromSettings === "boolean") return fromSettings;

  try {
    if (featureFlags && Object.prototype.hasOwnProperty.call(featureFlags, "quietHoursGuard")) {
      return !!featureFlags.quietHoursGuard;
    }
  } catch {
    // ignore
  }
  return true; // default ON
}

/**
 * @param {GuardContext["settings"]} s
 */
function withDefaults(s) {
  const d = {
    enabled: true,
    failClosed: false,
    schedule: null,
    allowVoiceDuringQuiet: false,
    allowTimersDuringQuiet: false,
    treatUnknownAsNoisy: false,
  };
  return Object.assign({}, d, s || {});
}

/**
 * Decide if a step is noisy.
 * @param {SessionStep|null} step
 * @param {Session} session
 * @param {ReturnType<typeof withDefaults>} settings
 */
function isStepNoisy(step, session, settings) {
  if (!step) return !!settings.treatUnknownAsNoisy;

  // Explicit flag wins.
  if (step?.metadata?.noisy === true) return true;

  // Voice guidance counts as noise unless explicitly allowed.
  if (session?.prefs?.voiceGuidance && !settings.allowVoiceDuringQuiet) return true;

  // Timer beeps/buzzers
  if (step?.metadata?.donenessCue === "timer" && !settings.allowTimersDuringQuiet) return true;

  return false;
}

/**
 * Normalize schedule; returns null if invalid.
 * @param {QuietSchedule|null} raw
 * @returns {{ windows: Record<number, Array<[string,string]>>, timezone?: string }|null}
 */
function normalizeSchedule(raw) {
  if (!raw || typeof raw !== "object") return null;
  const out = { windows: {}, timezone: raw.timezone };
  const src = raw.windows || {};
  let any = false;

  for (const k of Object.keys(src)) {
    const dow = Number(k);
    if (!Number.isFinite(dow) || dow < 0 || dow > 6) continue;
    const arr = Array.isArray(src[k]) ? src[k] : [];
    const normPairs = [];
    for (const pair of arr) {
      if (!Array.isArray(pair) || pair.length !== 2) continue;
      const a = toHHmm(pair[0]);
      const b = toHHmm(pair[1]);
      if (!a || !b) continue;
      normPairs.push([a, b]);
      any = true;
    }
    if (normPairs.length) out.windows[dow] = normPairs;
  }
  return any ? out : null;
}

/**
 * Evaluate "now" against today's windows; supports cross-midnight pairs.
 * If within any active window → active = true and endsAt is computed.
 * @param {Date} now
 * @param {Record<number, Array<[string,string]>>} windows
 * @returns {{ active: boolean, endsAt?: Date }}
 */
function evaluateWindows(now, windows) {
  const dow = now.getDay(); // 0..6
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();

  // Gather candidate windows from today and yesterday (for cross-midnight).
  const today = windows[dow] || [];
  const yesterdayDow = (dow + 6) % 7;
  const yesterday = windows[yesterdayDow] || [];

  // Build concrete intervals.
  /** @type {Array<{start: Date, end: Date}>} */
  const intervals = [];

  // Today's windows (may cross midnight into tomorrow).
  for (const [startHHmm, endHHmm] of today) {
    const start = localDateTime(y, m, d, startHHmm);
    let end = localDateTime(y, m, d, endHHmm);
    if (end <= start) {
      // crosses midnight → end tomorrow
      end = addDays(end, 1);
    }
    intervals.push({ start, end });
  }

  // Yesterday's cross-midnight windows that might still be active.
  const yesterDate = new Date(y, m, d - 1);
  const yy = yesterDate.getFullYear();
  const ym = yesterDate.getMonth();
  const yd = yesterDate.getDate();

  for (const [startHHmm, endHHmm] of yesterday) {
    const start = localDateTime(yy, ym, yd, startHHmm);
    let end = localDateTime(yy, ym, yd, endHHmm);
    if (end <= start) {
      // crossed midnight → end today
      end = addDays(end, 1);
    }
    // Only keep if it touches today.
    if (end.getFullYear() === y && end.getMonth() === m && end.getDate() === d) {
      intervals.push({ start, end });
    }
  }

  // Resolve active interval (if any).
  for (const it of intervals) {
    if (now >= it.start && now < it.end) {
      return { active: true, endsAt: it.end };
    }
  }

  return { active: false };
}

/* -------------------------- Time/Parsing Utilities ------------------------- */

/**
 * @param {string} s
 * @returns {string|null} "HH:mm" or null
 */
function toHHmm(s) {
  if (typeof s !== "string") return null;
  const m = s.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  let hh = Number(m[1]);
  let mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return `${pad2(hh)}:${pad2(mm)}`;
}

function pad2(n) {
  return n < 10 ? `0${n}` : `${n}`;
}

function localDateTime(y, m, d, hhmm) {
  const [hh, mm] = hhmm.split(":").map(Number);
  return new Date(y, m, d, hh, mm, 0, 0);
}

function addDays(dt, days) {
  const x = new Date(dt.getTime());
  x.setDate(x.getDate() + days);
  return x;
}

function humanTime(dt) {
  try {
    // Best-effort locale-friendly time only.
    return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(dt);
  } catch {
    return dt.toLocaleTimeString();
  }
}

/* ------------------------------- Step Utils -------------------------------- */

function resolveStep(session, stepIndex) {
  if (!session || !Array.isArray(session.steps) || session.steps.length === 0) return null;
  if (typeof stepIndex === "number" && stepIndex >= 0 && stepIndex < session.steps.length) {
    return session.steps[stepIndex];
  }
  const idx =
    Number.isFinite(session?.progress?.currentStepIndex) && session.progress.currentStepIndex >= 0
      ? session.progress.currentStepIndex
      : 0;
  return session.steps[idx] || null;
}

function hasBlocker(step, blocker) {
  if (!step || !Array.isArray(step.blockers)) return false;
  return step.blockers.includes(blocker);
}

function safeId(session) {
  return (session && typeof session.id === "string" && session.id) || null;
}

function safeEmitDebug(type, data) {
  try {
    if (eventBus && typeof eventBus.emit === "function") {
      eventBus.emit({ type, ts: new Date().toISOString(), source: "quietHoursGuard", data });
    }
  } catch {
    // no-op
  }
}

/* ----------------------------- Public API Shape ---------------------------- */

/**
 * Evaluate current step (session.progress.currentStepIndex).
 * @param {Session} session
 * @param {GuardContext} [ctx]
 * @returns {Promise<GuardResult>}
 */
export async function evaluateForCurrentStep(session, ctx) {
  const idx = safeStepIndex(session);
  return evaluateQuietHoursGuard(session, idx, ctx);
}

function safeStepIndex(session) {
  if (!session || !session.progress) return -1;
  const i = Number(session.progress.currentStepIndex);
  return Number.isFinite(i) && i >= 0 ? i : -1;
}

/**
 * Utility: returns the next moment when quiet hours end, or null if not active.
 * @param {GuardContext} [ctx]
 * @returns {Promise<string|null>} ISO string or null
 */
export async function nextQuietLiftTime(ctx = {}) {
  const settings = withDefaults(ctx.settings);
  const schedule = normalizeSchedule(settings.schedule);
  if (!schedule) return null;
  const now = new Date();
  const state = evaluateWindows(now, schedule.windows);
  return state.active && state.endsAt ? state.endsAt.toISOString() : null;
}

/* --------------------------------- Default -------------------------------- */

const quietHoursGuard = {
  id: "quietHours",
  evaluate: evaluateQuietHoursGuard,
  evaluateForCurrentStep,
  nextLift: nextQuietLiftTime,
};

export default quietHoursGuard;

/* --------------------------------- Usage -----------------------------------
 * // In SessionRunner (pseudo):
 * import quietHoursGuard from "@/features/session/session.guards/quietHours";
 *
 * async function guardCheck(session, stepIndex) {
 *   const res = await quietHoursGuard.evaluate(session, stepIndex, {
 *     settings: {
 *       schedule: {
 *         timezone: "America/Chicago",
 *         windows: {
 *           0: [["22:00","07:00"]],
 *           1: [["22:00","06:30"]],
 *           2: [["22:00","06:30"]],
 *           3: [["22:00","06:30"]],
 *           4: [["22:30","06:30"]],
 *           5: [["23:00","07:30"]],
 *           6: [["23:00","07:30"]],
 *         },
 *       },
 *       allowVoiceDuringQuiet: false,
 *       allowTimersDuringQuiet: false,
 *       // failClosed: false,
 *     },
 *   });
 *   if (!res.allowed) {
 *     // Runner pauses & schedules retry at res.retryAt.
 *     // UI: show "Quiet hours active until HH:MM" + options:
 *     //   - "Switch to silent mode" (disable voice, haptics only)
 *     //   - "Queue for later" (schedule after quiet hours)
 *     //   - "Override once" (if household policy permits; your app policy)
 *   }
 * }
 * -------------------------------------------------------------------------- */
