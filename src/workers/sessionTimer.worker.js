/**
 * C:\Users\larho\suka-smart-assistant\src\workers\sessionTimer.worker.js
 *
 * SessionTimer Web Worker — resilient, drift-aware ticking for SSA sessions.
 *
 * How this fits:
 * - Owned by SessionRunner (main thread). Keeps time even if tab is backgrounded.
 * - Emits TICK every second (elapsed & per-step remaining) and CHECKPOINT every N seconds.
 * - Not authoritative for state; Runner remains source of truth. This worker only tracks time.
 * - Idempotent resume: you can call START/RESUME multiple times; it will reconcile safely.
 * - Multi-session capable (tracks by session id), though SSA typically runs one active session.
 *
 * Message protocol (main thread → worker):
 *   { type: "START", id, stepIndex, stepDurationSec, startedAtISO?, elapsedSec?, checkpointEverySec? }
 *   { type: "PAUSE", id }
 *   { type: "RESUME", id }
 *   { type: "STOP", id }                               // stops ticking but keeps last known state
 *   { type: "SET_STEP", id, stepIndex, stepDurationSec } // resets per-step clock
 *   { type: "ADJUST_DURATION", id, deltaSec }          // +/- seconds to current step duration
 *   { type: "NUDGE_ELAPSED", id, deltaSec }            // +/- seconds to total elapsed
 *   { type: "SYNC", id, status, progress?, stepDurationSec? } // reconcile with runner state
 *   { type: "GET_STATE", id }                          // request snapshot
 *   { type: "PING" }                                   // health check → PONG
 *
 * Worker → main thread posts:
 *   { type: "TICK", id, elapsedSec, stepElapsedSec, stepRemainingSec, stepIndex, ts }
 *   { type: "CHECKPOINT", id, elapsedSec, stepIndex, ts }
 *   { type: "STEP_EXPIRED", id, stepIndex, ts }        // fire once per step when remaining hits 0
 *   { type: "STATE", id, state }                       // snapshot reply to GET_STATE
 *   { type: "PONG", ts }
 *   { type: "LOG", level, message, data? }             // non-fatal diagnostics
 *
 * Drift handling:
 * - Uses performance.now() for monotonic timing; emits only when a full second boundary is crossed.
 * - Internal tick loop runs at 250ms, coalescing to 1s granularity for events.
 *
 * Safety:
 * - Defensive guards around bad input; logs via LOG posts instead of throwing.
 * - Timer loops are per-session; starting twice is idempotent (existing loop reused).
 *
 * © Suka Smart Assistant
 */

/**
 * @typedef {Object} TimerState
 * @property {string} id
 * @property {"idle"|"running"|"paused"|"stopped"} status
 * @property {number} elapsedSec               // total session elapsed (whole seconds)
 * @property {number} stepIndex
 * @property {number} stepDurationSec          // 0 means open-ended
 * @property {number} stepElapsedSec           // whole seconds in current step
 * @property {number} checkpointEverySec
 * @property {number} _lastHr                  // performance.now() at last tick sample
 * @property {number} _accumMs                 // ms carried between ticks to coalesce
 * @property {number} _checkpointMs            // ms accumulator to determine CHECKPOINT cadence
 * @property {boolean} _expiredFired           // guard to emit STEP_EXPIRED only once per step
 * @property {number|null} _loopHandle         // setInterval handle
 * @property {string|null} startedAtISO
 * @property {string|null} pausedAtISO
 */

/** @type {Map<string, TimerState>} */
const sessions = new Map();

const ISO = () => new Date().toISOString();
const clampInt = (n, min, max) => Math.max(min, Math.min(max, n | 0));

function log(level, message, data) {
  try { postMessage({ type: "LOG", level, message, data }); } catch { /* noop */ }
}

function ensureState(id) {
  if (!id || typeof id !== "string") return null;
  if (!sessions.has(id)) {
    sessions.set(id, {
      id,
      status: "idle",
      elapsedSec: 0,
      stepIndex: 0,
      stepDurationSec: 0,
      stepElapsedSec: 0,
      checkpointEverySec: 10,
      _lastHr: performance.now(),
      _accumMs: 0,
      _checkpointMs: 0,
      _expiredFired: false,
      _loopHandle: null,
      startedAtISO: null,
      pausedAtISO: null,
    });
  }
  return sessions.get(id);
}

function clearLoop(state) {
  if (state?._loopHandle != null) {
    clearInterval(state._loopHandle);
    state._loopHandle = null;
  }
}

function startLoop(state) {
  if (!state) return;
  if (state._loopHandle != null) return; // idempotent
  state._lastHr = performance.now();
  state._accumMs = 0;
  state._checkpointMs = 0;

  state._loopHandle = setInterval(() => {
    if (state.status !== "running") return;

    const nowHr = performance.now();
    const deltaMs = nowHr - state._lastHr;
    state._lastHr = nowHr;

    // coalesce to 1s ticks
    state._accumMs += deltaMs;
    state._checkpointMs += deltaMs;

    let advanced = false;
    while (state._accumMs >= 1000) {
      state._accumMs -= 1000;
      state.elapsedSec = clampInt(state.elapsedSec + 1, 0, Number.MAX_SAFE_INTEGER);
      if (state.stepDurationSec > 0) {
        state.stepElapsedSec = clampInt(state.stepElapsedSec + 1, 0, Number.MAX_SAFE_INTEGER);
      }
      advanced = true;
    }

    if (advanced) {
      const remaining = Math.max(0, (state.stepDurationSec | 0) - (state.stepElapsedSec | 0));
      postMessage({
        type: "TICK",
        id: state.id,
        elapsedSec: state.elapsedSec,
        stepElapsedSec: state.stepElapsedSec,
        stepRemainingSec: state.stepDurationSec ? remaining : null,
        stepIndex: state.stepIndex,
        ts: ISO(),
      });

      // emit STEP_EXPIRED exactly once per step when remaining hits 0
      if (state.stepDurationSec > 0 && remaining === 0 && !state._expiredFired) {
        state._expiredFired = true;
        postMessage({ type: "STEP_EXPIRED", id: state.id, stepIndex: state.stepIndex, ts: ISO() });
      }
    }

    // checkpoint cadence
    if (state._checkpointMs >= (state.checkpointEverySec * 1000)) {
      state._checkpointMs = 0;
      postMessage({
        type: "CHECKPOINT",
        id: state.id,
        elapsedSec: state.elapsedSec,
        stepIndex: state.stepIndex,
        ts: ISO(),
      });
    }
  }, 250);
}

function applyStart(msg) {
  const id = msg?.id;
  const stepIndex = clampInt(msg?.stepIndex ?? 0, 0, Number.MAX_SAFE_INTEGER);
  const stepDurationSec = clampInt(msg?.stepDurationSec ?? 0, 0, Number.MAX_SAFE_INTEGER);
  const checkpointEverySec = clampInt(msg?.checkpointEverySec ?? 10, 5, 120);
  const elapsedSec = clampInt(msg?.elapsedSec ?? 0, 0, Number.MAX_SAFE_INTEGER);
  const startedAtISO = typeof msg?.startedAtISO === "string" ? msg.startedAtISO : ISO();

  const s = ensureState(id);
  if (!s) return log("warn", "START ignored: invalid id", { id });

  s.status = "running";
  s.stepIndex = stepIndex;
  s.stepDurationSec = stepDurationSec;
  s.stepElapsedSec = 0;
  s._expiredFired = stepDurationSec === 0; // if open-ended, never fire expired
  s.checkpointEverySec = checkpointEverySec;
  s.elapsedSec = elapsedSec;
  s.startedAtISO = s.startedAtISO || startedAtISO;
  s.pausedAtISO = null;

  startLoop(s);
  // emit immediate tick for responsive UI
  postMessage({
    type: "TICK",
    id: s.id,
    elapsedSec: s.elapsedSec,
    stepElapsedSec: s.stepElapsedSec,
    stepRemainingSec: s.stepDurationSec ? Math.max(0, s.stepDurationSec - s.stepElapsedSec) : null,
    stepIndex: s.stepIndex,
    ts: ISO(),
  });
}

function applyPause(msg) {
  const s = ensureState(msg?.id);
  if (!s) return;
  s.status = "paused";
  s.pausedAtISO = ISO();
  // keep loop alive but it won't advance while paused (guarded in loop)
}

function applyResume(msg) {
  const s = ensureState(msg?.id);
  if (!s) return;
  s.status = "running";
  s.pausedAtISO = null;
  // reset drift anchors so resume is smooth
  s._lastHr = performance.now();
  startLoop(s);
  postMessage({
    type: "TICK",
    id: s.id,
    elapsedSec: s.elapsedSec,
    stepElapsedSec: s.stepElapsedSec,
    stepRemainingSec: s.stepDurationSec ? Math.max(0, s.stepDurationSec - s.stepElapsedSec) : null,
    stepIndex: s.stepIndex,
    ts: ISO(),
  });
}

function applyStop(msg) {
  const s = ensureState(msg?.id);
  if (!s) return;
  s.status = "stopped";
  clearLoop(s);
}

function applySetStep(msg) {
  const s = ensureState(msg?.id);
  if (!s) return;
  const idx = clampInt(msg?.stepIndex ?? s.stepIndex, 0, Number.MAX_SAFE_INTEGER);
  const dur = clampInt(msg?.stepDurationSec ?? s.stepDurationSec, 0, Number.MAX_SAFE_INTEGER);

  s.stepIndex = idx;
  s.stepDurationSec = dur;
  s.stepElapsedSec = 0;
  s._expiredFired = dur === 0; // reset "expired once" guard

  // snap a tick
  postMessage({
    type: "TICK",
    id: s.id,
    elapsedSec: s.elapsedSec,
    stepElapsedSec: s.stepElapsedSec,
    stepRemainingSec: s.stepDurationSec ? Math.max(0, s.stepDurationSec - s.stepElapsedSec) : null,
    stepIndex: s.stepIndex,
    ts: ISO(),
  });
}

function applyAdjustDuration(msg) {
  const s = ensureState(msg?.id);
  if (!s) return;
  const delta = msg?.deltaSec | 0;
  const next = clampInt((s.stepDurationSec | 0) + delta, 0, Number.MAX_SAFE_INTEGER);
  s.stepDurationSec = next;

  if (next === 0) s._expiredFired = true; // open-ended now; never expire
  else if (s.stepElapsedSec < next) s._expiredFired = false; // allow expire later

  // snap a tick to reflect new remaining
  postMessage({
    type: "TICK",
    id: s.id,
    elapsedSec: s.elapsedSec,
    stepElapsedSec: s.stepElapsedSec,
    stepRemainingSec: next ? Math.max(0, next - s.stepElapsedSec) : null,
    stepIndex: s.stepIndex,
    ts: ISO(),
  });
}

function applyNudgeElapsed(msg) {
  const s = ensureState(msg?.id);
  if (!s) return;
  const delta = msg?.deltaSec | 0;
  s.elapsedSec = clampInt(s.elapsedSec + delta, 0, Number.MAX_SAFE_INTEGER);
  // no change to stepElapsed; that is independent unless caller also adjusts it
}

function applySync(msg) {
  const s = ensureState(msg?.id);
  if (!s) return;
  const status = msg?.status;
  if (status === "running" || status === "paused" || status === "stopped" || status === "idle") {
    s.status = status;
  }
  if (msg?.progress) {
    const p = msg.progress;
    if (Number.isFinite(p.currentStepIndex)) s.stepIndex = clampInt(p.currentStepIndex, 0, Number.MAX_SAFE_INTEGER);
    if (Number.isFinite(p.elapsedSec)) s.elapsedSec = clampInt(p.elapsedSec, 0, Number.MAX_SAFE_INTEGER);
    // If main thread tracks per-step elapsed in future, you can wire it here. For now we keep local stepElapsedSec.
  }
  if (Number.isFinite(msg?.stepDurationSec)) {
    s.stepDurationSec = clampInt(msg.stepDurationSec, 0, Number.MAX_SAFE_INTEGER);
  }
  // Reset drift anchors to avoid jump
  s._lastHr = performance.now();
  // Snap a tick to reflect sync
  postMessage({
    type: "TICK",
    id: s.id,
    elapsedSec: s.elapsedSec,
    stepElapsedSec: s.stepElapsedSec,
    stepRemainingSec: s.stepDurationSec ? Math.max(0, s.stepDurationSec - s.stepElapsedSec) : null,
    stepIndex: s.stepIndex,
    ts: ISO(),
  });
}

function applyGetState(msg) {
  const s = ensureState(msg?.id);
  if (!s) return;
  postMessage({
    type: "STATE",
    id: s.id,
    state: {
      id: s.id,
      status: s.status,
      elapsedSec: s.elapsedSec,
      stepIndex: s.stepIndex,
      stepDurationSec: s.stepDurationSec,
      stepElapsedSec: s.stepElapsedSec,
      checkpointEverySec: s.checkpointEverySec,
      startedAtISO: s.startedAtISO,
      pausedAtISO: s.pausedAtISO,
    },
  });
}

// Message router
onmessage = (ev) => {
  const msg = ev?.data || {};
  const type = msg?.type;

  try {
    switch (type) {
      case "START": return applyStart(msg);
      case "PAUSE": return applyPause(msg);
      case "RESUME": return applyResume(msg);
      case "STOP": return applyStop(msg);
      case "SET_STEP": return applySetStep(msg);
      case "ADJUST_DURATION": return applyAdjustDuration(msg);
      case "NUDGE_ELAPSED": return applyNudgeElapsed(msg);
      case "SYNC": return applySync(msg);
      case "GET_STATE": return applyGetState(msg);
      case "PING": return postMessage({ type: "PONG", ts: ISO() });
      default:
        return log("warn", "Unknown message type", { type });
    }
  } catch (err) {
    log("error", "Worker message handling failed", { type, error: String(err && err.message || err) });
  }
};

// Graceful teardown when worker is terminated by browser (no API needed here).
// Consumers should recreate the worker on demand and call SYNC/START idempotently.
