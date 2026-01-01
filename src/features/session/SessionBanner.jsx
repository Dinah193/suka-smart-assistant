/**
 * src/features/session/SessionBanner.jsx
 * -----------------------------------------------------------------------------
 * SessionBannerShim — background controller for "Now" / session candidates.
 *
 * Purpose
 * - Centralize the logic for:
 *   - Finding the current running session (if any).
 *   - Listing pending sessions and evaluating high-level guards.
 *   - Selecting a primary "Now" candidate.
 *   - Emitting a "session.open.request" event to trigger the SessionRunner.
 * - Runs as a UI-agnostic shim so the logic can stay alive even if:
 *   - The user navigates away from pages that render a banner, OR
 *   - Different UIs (header banner, domain "Now" buttons) need the same data.
 *
 * How this fits
 * - This module DOES NOT render React UI.
 *   It exposes a small API:
 *     - SessionBannerShim.onChange(listener)
 *     - SessionBannerShim.getState()
 *     - SessionBannerShim.refreshNow()
 *     - SessionBannerShim.openRunnerFor(id)
 *     - SessionBannerShim.requestNow()  (uses current primary)
 * - One or more React components can subscribe to onChange() and render:
 *   - A sticky "Now" banner.
 *   - Domain-level "Play Now" buttons.
 *   - A swap/selector modal (separate UI file) using the candidates list.
 *
 * Contracts
 * - Event bus at src/services/eventBus.js exposing:
 *     eventBus.on(type, fn)
 *     eventBus.off(type, fn)
 *     eventBus.emit({ type, ts, source, data })
 * - SessionsRepo abstraction:
 *     SessionsRepo.listByStatus(statusArray) -> Promise<Session[]>
 *     SessionsRepo.getRunning() -> Promise<Session|null>
 * - Guard services (optional; fail-open if missing):
 *     guards/sabbathGuard.js   -> { isBlocked(session): Promise<boolean> }
 *     guards/quietHoursGuard.js-> { isBlocked(session): Promise<boolean> }
 *     guards/weatherGuard.js   -> { isBlocked(session): Promise<boolean> }
 *     guards/inventoryGuard.js -> { isBlocked(session): Promise<boolean> }
 *     guards/batteryGuard.js   -> { isBlocked(session): Promise<boolean> } (optional)
 *
 * Eventing
 * - To open the SessionRunner, this shim emits:
 *     {
 *       type: "session.open.request",
 *       ts: ISO_8601,
 *       source: "SessionBannerShim",
 *       data: { id: "<sessionId>" }
 *     }
 * - SessionRunnerShim (or your root runner component) listens for this event,
 *   loads the session by id, and begins execution.
 *
 * State shape (getState / onChange):
 *   {
 *     loading: boolean,
 *     running: Session|null,
 *     pendingEvaluated: Array<{ session: Session, blocked: boolean, blockedReasons: string[] }>,
 *     primary: Session|null,   // chosen by choosePrimary()
 *     candidates: Array<{ session: Session, blocked: boolean, blockedReasons: string[] }>,
 *     hasMultipleViable: boolean,
 *     lastUpdated: string|null // ISO time of last refresh
 *   }
 *
 * NOTE: This file is intentionally a pure JS shim (no React). You can create
 * a presentational React component (e.g., SessionBannerUI.jsx) that imports
 * SessionBannerShim, subscribes via onChange(), and renders your sticky banner
 * + optional swap modal.
 * -----------------------------------------------------------------------------
 */

import eventBus from "@/services/eventBus";
// featureFlags is available if you want to specialize behavior later.
import featureFlags from "@/services/featureFlags";
import * as SessionsRepo from "@/data/SessionsRepo";

// Optional guards; each import is wrapped so missing files won't break runtime.
let sabbathGuard, quietHoursGuard, weatherGuard, inventoryGuard, batteryGuard;
try { sabbathGuard = require("@/guards/sabbathGuard"); } catch {}
try { quietHoursGuard = require("@/guards/quietHoursGuard"); } catch {}
try { weatherGuard = require("@/guards/weatherGuard"); } catch {}
try { inventoryGuard = require("@/guards/inventoryGuard"); } catch {}
try { batteryGuard = require("@/guards/batteryGuard"); } catch {}

/** @typedef {import("@/types").Session} Session */

/** Poll interval for refreshing candidate sessions (ms) */
const REFRESH_MS = 15_000;

/**
 * Small domain metadata map for UI friendliness; UIs can use this to
 * show labels / colors / emojis without re-defining in each component.
 */
const DOMAIN_META =
  /** @type {Record<string, {label:string, hue:string, emoji:string}>} */ ({
    cooking: { label: "Cooking", hue: "hsl(16, 88%, 45%)", emoji: "🍳" },
    cleaning: { label: "Cleaning", hue: "hsl(200, 75%, 40%)", emoji: "🧽" },
    garden: { label: "Garden", hue: "hsl(120, 55%, 35%)", emoji: "🪴" },
    animals: { label: "Animals", hue: "hsl(35, 90%, 40%)", emoji: "🐑" },
    preservation: { label: "Preserve", hue: "hsl(300, 55%, 45%)", emoji: "🫙" },
    storehouse: { label: "Storehouse", hue: "hsl(260, 55%, 45%)", emoji: "🏚️" },
  });

/**
 * Convert guard reason codes to human-friendly labels. UIs can use this if desired.
 * @param {string[]} reasons
 */
function formatReasons(reasons) {
  const map = {
    sabbath: "Sabbath",
    quietHours: "Quiet Hours",
    weather: "Weather",
    inventory: "Inventory",
    battery: "Low Battery",
  };
  return reasons.map((r) => map[r] || r);
}

/**
 * Gracefully evaluate all relevant guard checks for a session.
 * Missing guards resolve to "not blocked".
 * @param {Session} session
 * @returns {Promise<{blocked: boolean, reasons: string[]}>}
 */
async function evaluateGuards(session) {
  /** @type {string[]} */
  const reasons = [];

  const safeBlocked = async (guard, label) => {
    if (!guard || typeof guard.isBlocked !== "function") return false;
    try {
      const res = await guard.isBlocked(session);
      if (res) reasons.push(label);
      return !!res;
    } catch {
      // If guard errors, fail open (not blocked) but note reason for visibility.
      // eslint-disable-next-line no-console
      console.warn(`[SessionBannerShim] Guard "${label}" threw; allowing run.`);
      return false;
    }
  };

  // Banner-level "pre-run" guards; SessionRunner still does per-step blockers.
  const results = await Promise.all([
    safeBlocked(sabbathGuard, "sabbath"),
    safeBlocked(quietHoursGuard, "quietHours"),
    safeBlocked(weatherGuard, "weather"),
    safeBlocked(inventoryGuard, "inventory"),
    safeBlocked(batteryGuard, "battery"),
  ]);

  const blocked = results.some(Boolean);
  return { blocked, reasons };
}

/**
 * Pick the "best" primary session:
 *  1) If a running session exists, prefer it.
 *  2) Else pick first non-blocked pending session by most-recent updatedAt.
 * @param {Session|null} running
 * @param {Array<{session: Session, blocked: boolean}>} pendingEvaluated
 * @returns {Session|null}
 */
function choosePrimary(running, pendingEvaluated) {
  if (running) return running;
  const viable = pendingEvaluated
    .filter((x) => !x.blocked)
    .map((x) => x.session)
    .sort(
      (a, b) =>
        new Date(b.updatedAt || b.createdAt).getTime() -
        new Date(a.updatedAt || a.createdAt).getTime()
    );
  return viable[0] || null;
}

// ---------------------------------------------------------------------------
// Safe data access helpers (SessionsRepo)
// ---------------------------------------------------------------------------

async function safeGetRunning() {
  try {
    if (typeof SessionsRepo.getRunning === "function") {
      const s = await SessionsRepo.getRunning();
      return sanitizeSession(s);
    }
    if (typeof SessionsRepo.listByStatus === "function") {
      const list = await SessionsRepo.listByStatus(["running"]);
      return sanitizeSession(list?.[0] || null);
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[SessionBannerShim] getRunning failed", e);
  }
  return null;
}

async function safeListPending() {
  try {
    if (typeof SessionsRepo.listByStatus === "function") {
      const list = await SessionsRepo.listByStatus(["pending", "paused"]);
      return (list || []).map(sanitizeSession).filter(Boolean);
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[SessionBannerShim] listByStatus failed", e);
  }
  return [];
}

/**
 * Defensively coerce a plain Session shape.
 * @param {any} s
 * @returns {Session|null}
 */
function sanitizeSession(s) {
  if (!s || typeof s !== "object") return null;
  if (!s.id || !s.domain) return null;
  const nowISO = new Date().toISOString();
  return /** @type {Session} */ ({
    id: String(s.id),
    domain: String(s.domain),
    title: s.title ? String(s.title) : "",
    source: s.source || { type: "manual", refId: null },
    steps: Array.isArray(s.steps) ? s.steps : [],
    prefs:
      s.prefs || {
        voiceGuidance: false,
        haptic: true,
        autoAdvance: false,
      },
    status: s.status || "pending",
    progress:
      s.progress || {
        currentStepIndex: 0,
        elapsedSec: 0,
        startedAt: null,
        pausedAt: null,
      },
    analytics:
      s.analytics || {
        skippedSteps: [],
        adjustments: [],
      },
    createdAt: s.createdAt || nowISO,
    updatedAt: s.updatedAt || s.createdAt || nowISO,
  });
}

// ---------------------------------------------------------------------------
// Shim state & subscription model
// ---------------------------------------------------------------------------

/** @type {boolean} */
let loading = true;

/** @type {Session|null} */
let running = null;

/** @type {Array<{session: Session, blocked: boolean, blockedReasons: string[]}>} */
let pendingEvaluated = [];

/** @type {string|null} */
let lastUpdated = null;

/** @type {Set<(state: ReturnType<typeof getState>) => void>} */
const listeners = new Set();

/** @type {number|null} */
let pollTimerId = null;

/** Ensure polling is active once we have at least one subscriber. */
function ensurePolling() {
  if (pollTimerId != null) return;
  pollTimerId = setInterval(refreshNow, REFRESH_MS);
}

/** Stop polling (optional; currently unused, but available). */
function stopPolling() {
  if (pollTimerId == null) return;
  clearInterval(pollTimerId);
  pollTimerId = null;
}

/**
 * Compute the primary candidate, candidate list, and viability flag
 * based on current state.
 */
function computeDerived() {
  const simplePending = pendingEvaluated.map((x) => ({
    session: x.session,
    blocked: x.blocked,
  }));
  const primary = choosePrimary(running, simplePending);

  // Build ordered candidate list:
  //  - running at top (if any),
  //  - then pending sessions sorted by recency.
  const list = [];
  if (running) {
    list.push({
      session: running,
      blocked: false,
      blockedReasons: [],
    });
  }
  const sortedPendings = pendingEvaluated.slice().sort((a, b) => {
    const tA = new Date(a.session.updatedAt || a.session.createdAt).getTime();
    const tB = new Date(b.session.updatedAt || b.session.createdAt).getTime();
    return tB - tA;
  });
  list.push(...sortedPendings);

  const viableCount =
    Number(!!running) +
    pendingEvaluated.filter((x) => !x.blocked).length;

  return {
    primary,
    candidates: list,
    hasMultipleViable: viableCount > 1,
  };
}

/**
 * Snapshot of current shim state for consumers.
 */
function getState() {
  const { primary, candidates, hasMultipleViable } = computeDerived();
  return {
    loading,
    running,
    pendingEvaluated,
    primary,
    candidates,
    hasMultipleViable,
    lastUpdated,
    domainMeta: DOMAIN_META,
    formatGuardReasons: formatReasons,
    featureFlags, // surfaced for convenience (read-only usage preferred)
  };
}

/**
 * Notify all subscribed listeners of the latest state.
 */
function notifyListeners() {
  const snapshot = getState();
  listeners.forEach((fn) => {
    try {
      fn(snapshot);
    } catch {
      // eslint-disable-next-line no-console
      console.warn("[SessionBannerShim] listener threw");
    }
  });
}

/**
 * Public: subscribe to state changes.
 * @param {(state: ReturnType<typeof getState>) => void} listener
 * @returns {() => void} unsubscribe
 */
function onChange(listener) {
  if (typeof listener !== "function") return () => {};
  listeners.add(listener);
  ensurePolling();
  // emit immediately with current snapshot
  try {
    listener(getState());
  } catch {
    /* noop */
  }
  return () => {
    listeners.delete(listener);
    // You *could* stop polling when listeners.size === 0. For now we keep it
    // running to support hot-mounting banners on different routes.
  };
}

/**
 * Internal: refresh from SessionsRepo & guards, then notify listeners.
 */
async function refreshNow() {
  try {
    loading = true;
    notifyListeners();

    const [runningNow, pendings] = await Promise.all([
      safeGetRunning(),
      safeListPending(),
    ]);

    const evaluated = await Promise.all(
      pendings.map(async (session) => {
        const { blocked, reasons } = await evaluateGuards(session);
        return {
          session,
          blocked,
          blockedReasons: reasons,
        };
      })
    );

    running = runningNow;
    pendingEvaluated = evaluated;
    loading = false;
    lastUpdated = new Date().toISOString();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[SessionBannerShim] refresh failed", err);
    loading = false;
  } finally {
    notifyListeners();
  }
}

/**
 * Emit an open request for the SessionRunner to handle.
 * @param {string} sessionId
 */
function openRunnerFor(sessionId) {
  if (!sessionId) return;
  try {
    eventBus.emit({
      type: "session.open.request",
      ts: new Date().toISOString(),
      source: "SessionBannerShim",
      data: { id: sessionId },
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[SessionBannerShim] failed to emit session.open.request", e);
  }
}

/**
 * Public convenience: request "Now" based on current primary candidate.
 * - If no primary is available, does nothing.
 * - If hasMultipleViable is true, callers can inspect getState().candidates
 *   and choose to open a swap/selector UI before calling openRunnerFor().
 */
function requestNow() {
  const { primary } = computeDerived();
  if (!primary) return;
  openRunnerFor(primary.id);
}

/**
 * Optional: clean up polling and event listeners (e.g., on app teardown).
 */
function teardown() {
  stopPolling();
  listeners.clear();
  // Remove eventBus listeners registered below.
  removeEventBusListeners();
}

// ---------------------------------------------------------------------------
// Listen to SessionRunner events so the banner reacts in near-real-time.
// ---------------------------------------------------------------------------

let eventBusBound = false;
let offFns = [];

/** Attach eventBus listeners once. */
function ensureEventBusListeners() {
  if (eventBusBound || !eventBus || typeof eventBus.on !== "function") return;
  const rerun = () => {
    // Debounce using microtask to avoid duplicate refresh storms
    Promise.resolve().then(() => refreshNow());
  };
  const types = [
    "session.started",
    "session.completed",
    "session.aborted",
    "session.paused",
    "session.resumed",
  ];
  offFns = types.map((t) => {
    eventBus.on(t, rerun);
    return () => eventBus.off(t, rerun);
  });
  eventBusBound = true;
}

/** Remove eventBus listeners (for teardown). */
function removeEventBusListeners() {
  offFns.forEach((off) => {
    try {
      off();
    } catch {
      /* noop */
    }
  });
  offFns = [];
  eventBusBound = false;
}

// Attach listeners immediately so even early runner events update state.
ensureEventBusListeners();

// Kick off first refresh so state is populated when first UI subscribes.
refreshNow();

// ---------------------------------------------------------------------------
// Exported shim object
// ---------------------------------------------------------------------------

const SessionBannerShim = {
  // state & subscription
  getState,
  onChange,

  // control
  refreshNow,
  openRunnerFor,
  requestNow,
  teardown,

  // helpers for UIs
  DOMAIN_META,
  formatGuardReasons,
};

export default SessionBannerShim;
