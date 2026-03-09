// src/services/session/SessionRunner.js
// -----------------------------------------------------------------------------
// SessionRunner
// -----------------------------------------------------------------------------
// How this fits in the SSA pipeline:
//
//   imports → intelligence → automation → (optional) Hub export
//
// - "Intelligence" (domain engines like CookingSessionEngine, CleaningSessionEngine,
//   CleaningSessionEngine, GardenSessionEngine, AnimalSessionEngine, etc.) create
//   **sessions** with steps, timing, and metadata.
// - This SessionRunner is the **automation runtime** for those sessions. It:
//     • tracks the active session
//     • manages timers, step advancement, and completion/abort
//     • persists runtime state to Dexie for resilience / auto-resume
//     • emits rich events on the shared eventBus
//     • (optionally) mirrors analytics to the Family Fund Hub when
//       featureFlags.familyFundMode === true
//
// UI responsibilities:
// - This file is intentionally UI-light. It does **not** render React directly.
// - Instead, it ensures a root "host" container exists in the DOM and emits
//   "session.ui.*" events on the eventBus so a React/DOM layer can listen and
//   render a full-screen modal + mini HUD.
// - Keeping the runtime and UI decoupled lets us use the same SessionRunner for
//   cooking, cleaning, garden, animal, preservation, and future domains.
// -----------------------------------------------------------------------------

/* eslint-disable no-console */

import {
  emit as busEmit,
  on as busOn,
  off as busOff,
} from "../events/eventBus.js";
import { db } from "@/db";

import HubPacketFormatter from "@services/hub/HubPacketFormatter.js";
import FamilyFundConnector from "../hub/FamilyFundConnector.js";
import featureFlags from "@/config/featureFlags.json";

/* -------------------------------------------------------------------------- */
/* Constants & module-scoped state                                            */
/* -------------------------------------------------------------------------- */

const RUNNER_SOURCE = "SessionRunner";
const HOST_ID = "ssa-session-runner-root";

const isBrowser = typeof window !== "undefined";

let activeSession = null; // in-memory snapshot
let activeTimerId = null;
let wakeLockSentinel = null;

/* -------------------------------------------------------------------------- */
/* Utility helpers                                                            */
/* -------------------------------------------------------------------------- */

function nowIso() {
  return new Date().toISOString();
}

/**
 * Normalize a session object so SessionRunner can work with it safely.
 * This is defensive: if steps or metadata are missing, we still run.
 */
function normalizeSession(session) {
  if (!session || typeof session !== "object") return null;

  const normalized = {
    id: session.id,
    domain: session.domain || "generic",
    title: session.title || "Session",
    status: session.status || "draft",
    startedAt: session.startedAt || null,
    completedAt: session.completedAt || null,
    currentStepIndex:
      typeof session.currentStepIndex === "number"
        ? session.currentStepIndex
        : 0,
    steps: Array.isArray(session.steps) ? session.steps : [],
    meta: session.meta || {},
    // Keep any additional fields
    ...session,
  };

  return normalized;
}

/**
 * Emit a strongly-shaped SSA event.
 * Payload shape: { type, ts, source, data }
 */
function emitEvent(type, data) {
  if (!eventBus || typeof busEmit !== "function") {
    if (import.meta?.env?.DEV) {
      console.warn(`[${RUNNER_SOURCE}] busEmit not available`, {
        type,
        data,
      });
    }
    return;
  }

  try {
    busEmit({
      type,
      ts: nowIso(),
      source: RUNNER_SOURCE,
      data,
    });
  } catch (err) {
    if (import.meta?.env?.DEV) {
      console.error(`[${RUNNER_SOURCE}] Failed to emit event`, type, err);
    }
  }
}

/**
 * Optional Hub export helper.
 * Mirrors analytics to SVFFH when familyFundMode is enabled.
 *
 * This must never throw.
 */
async function exportToHubIfEnabled(payload) {
  try {
    const enabled = Boolean(
      featureFlags &&
        (featureFlags.familyFundMode ?? featureFlags.familyFundMode === true)
    );
    if (!enabled) return;

    if (
      !HubPacketFormatter ||
      typeof HubPacketFormatter.format !== "function" ||
      !FamilyFundConnector ||
      typeof FamilyFundConnector.send !== "function"
    ) {
      if (import.meta?.env?.DEV) {
        console.warn(
          `[${RUNNER_SOURCE}] Hub helpers unavailable; skipping Hub export`
        );
      }
      return;
    }

    const packet = HubPacketFormatter.format({
      domain: payload.domain || payload.session?.domain || "sessions",
      ts: nowIso(),
      payload,
    });

    await FamilyFundConnector.send(packet);
  } catch (err) {
    if (import.meta?.env?.DEV) {
      console.warn(`[${RUNNER_SOURCE}] Hub export failed:`, err);
    }
  }
}

/**
 * Acquire a screen wake lock if supported.
 */
async function acquireWakeLock() {
  if (!isBrowser || !("wakeLock" in navigator)) return;

  try {
    wakeLockSentinel = await navigator.wakeLock.request("screen");
    wakeLockSentinel.addEventListener("release", () => {
      if (import.meta?.env?.DEV) {
        console.info(`[${RUNNER_SOURCE}] Wake lock released`);
      }
      wakeLockSentinel = null;
    });
    if (import.meta?.env?.DEV) {
      console.info(`[${RUNNER_SOURCE}] Wake lock acquired`);
    }
  } catch (err) {
    if (import.meta?.env?.DEV) {
      console.warn(`[${RUNNER_SOURCE}] Failed to acquire wake lock`, err);
    }
  }
}

/**
 * Release the wake lock if we hold one.
 */
async function releaseWakeLock() {
  if (!wakeLockSentinel) return;
  try {
    await wakeLockSentinel.release();
  } catch (err) {
    // Ignore; sentinel will clean itself up
  } finally {
    wakeLockSentinel = null;
  }
}

/**
 * Schedule a simple per-step timer based on the current step's duration.
 * The UI can implement more sophisticated timers if needed.
 */
function scheduleStepTimer() {
  clearStepTimer();

  if (!activeSession) return;
  const step = activeSession.steps?.[activeSession.currentStepIndex];
  if (!step || !step.durationSec) return;

  const ms = step.durationSec * 1000;

  activeTimerId = setTimeout(() => {
    emitEvent("session.step.timerElapsed", {
      sessionId: activeSession.id,
      domain: activeSession.domain,
      stepIndex: activeSession.currentStepIndex,
    });
  }, ms);
}

function clearStepTimer() {
  if (activeTimerId) {
    clearTimeout(activeTimerId);
    activeTimerId = null;
  }
}

/**
 * Persist the current activeSession runtime state to Dexie for resilience.
 */
async function persistRuntimeState() {
  if (!activeSession || !db || !db.sessions) return;
  try {
    await db.sessions.put({
      ...activeSession,
      updatedAt: nowIso(),
    });
  } catch (err) {
    if (import.meta?.env?.DEV) {
      console.warn(`[${RUNNER_SOURCE}] Failed to persist runtime state`, err);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Host management (UI mounting surface)                                      */
/* -------------------------------------------------------------------------- */

/**
 * Ensure that a root container exists in the DOM for the UI layer
 * to attach a full-screen modal and/or mini HUD.
 *
 * This function is idempotent.
 */
export async function ensureHost() {
  if (!isBrowser) return;

  let host = document.getElementById(HOST_ID);
  if (host) return;

  host = document.createElement("div");
  host.id = HOST_ID;
  host.dataset.ssaHost = "session-runner-root";
  host.style.position = "fixed";
  host.style.inset = "0";
  host.style.pointerEvents = "none"; // UI layer can override
  host.style.zIndex = "9999";

  document.body.appendChild(host);

  emitEvent("session.ui.host.ready", {
    hostId: HOST_ID,
  });
}

/* -------------------------------------------------------------------------- */
/* Core SessionRunner operations                                              */
/* -------------------------------------------------------------------------- */

/**
 * Load a session from Dexie by id.
 */
async function loadSessionById(sessionId) {
  if (!db || !db.sessions || !sessionId) return null;
  try {
    const session = await db.sessions.get(sessionId);
    return normalizeSession(session);
  } catch (err) {
    if (import.meta?.env?.DEV) {
      console.warn(
        `[${RUNNER_SOURCE}] Failed to load session ${sessionId}`,
        err
      );
    }
    return null;
  }
}

/**
 * Start or resume a session.
 *
 * options:
 *   - domain:   string, used for logging/analytics (required)
 *   - sessionId: id in Dexie.sessions (required)
 *   - resume:   boolean, if true keeps startedAt and status when possible
 *   - source:   who requested the run (shim, page, etc.)
 */
export async function run(options) {
  const {
    domain,
    sessionId,
    resume = false,
    source = "unknown",
  } = options || {};

  if (!sessionId) {
    if (import.meta?.env?.DEV) {
      console.warn(
        `[${RUNNER_SOURCE}] run() called without sessionId`,
        options
      );
    }
    return;
  }

  // 1) Ensure host is present
  await ensureHost();

  // 2) Load session
  let session = await loadSessionById(sessionId);
  if (!session) {
    if (import.meta?.env?.DEV) {
      console.warn(
        `[${RUNNER_SOURCE}] No session found for id ${sessionId}; aborting run`
      );
    }
    return;
  }

  // 3) Normalize and set runtime metadata
  const now = nowIso();

  if (!resume || !session.startedAt) {
    session.startedAt = now;
    session.status = "running";
    session.currentStepIndex =
      typeof session.currentStepIndex === "number"
        ? session.currentStepIndex
        : 0;
  } else {
    // resume path: keep startedAt/status but ensure status is running
    session.status = session.status === "running" ? "running" : "running";
  }

  activeSession = session;

  // 4) Persist updated status
  await persistRuntimeState();

  // 5) Fire events + analytics
  emitEvent("session.started", {
    sessionId: session.id,
    domain: session.domain || domain || "generic",
    resume,
    requestedBy: source,
  });

  exportToHubIfEnabled({
    kind: "session.started",
    session,
    resume,
  });

  // 6) Notify UI layer
  emitEvent("session.ui.opened", {
    session,
    hostId: HOST_ID,
  });

  // 7) Runtime helpers: wake lock + timers
  await acquireWakeLock();
  scheduleStepTimer();
}

/**
 * Advance to the next step in the active session.
 * If at the end, marks the session as completed.
 */
export async function nextStep() {
  if (!activeSession) return;

  const totalSteps = Array.isArray(activeSession.steps)
    ? activeSession.steps.length
    : 0;

  if (totalSteps === 0) {
    // No steps defined; treat as completed
    return completeSession();
  }

  if (activeSession.currentStepIndex < totalSteps - 1) {
    activeSession.currentStepIndex += 1;
    await persistRuntimeState();
    clearStepTimer();
    scheduleStepTimer();

    emitEvent("session.step.changed", {
      sessionId: activeSession.id,
      domain: activeSession.domain,
      stepIndex: activeSession.currentStepIndex,
    });

    exportToHubIfEnabled({
      kind: "session.step.changed",
      sessionId: activeSession.id,
      domain: activeSession.domain,
      stepIndex: activeSession.currentStepIndex,
    });

    emitEvent("session.ui.updated", {
      session: activeSession,
      hostId: HOST_ID,
    });
  } else {
    await completeSession();
  }
}

/**
 * Mark the active session as completed.
 */
export async function completeSession() {
  if (!activeSession) return;

  activeSession.status = "completed";
  activeSession.completedAt = nowIso();

  await persistRuntimeState();
  clearStepTimer();
  await releaseWakeLock();

  emitEvent("session.completed", {
    session: activeSession,
  });

  exportToHubIfEnabled({
    kind: "session.completed",
    session: activeSession,
  });

  emitEvent("session.ui.closed", {
    sessionId: activeSession.id,
    hostId: HOST_ID,
  });

  activeSession = null;
}

/**
 * Abort the active session (user cancels).
 */
export async function abortSession(reason = "user_aborted") {
  if (!activeSession) return;

  activeSession.status = "aborted";
  activeSession.abortedAt = nowIso();
  activeSession.abortReason = reason;

  await persistRuntimeState();
  clearStepTimer();
  await releaseWakeLock();

  emitEvent("session.aborted", {
    session: activeSession,
    reason,
  });

  exportToHubIfEnabled({
    kind: "session.aborted",
    session: activeSession,
    reason,
  });

  emitEvent("session.ui.closed", {
    sessionId: activeSession.id,
    hostId: HOST_ID,
  });

  activeSession = null;
}

/**
 * Get the current active session snapshot (read-only).
 */
export function getActiveSession() {
  return activeSession ? { ...activeSession } : null;
}

/* -------------------------------------------------------------------------- */
/* Default export                                                             */
/* -------------------------------------------------------------------------- */

const SessionRunner = {
  ensureHost,
  run,
  nextStep,
  completeSession,
  abortSession,
  getActiveSession,
};

export default SessionRunner;
