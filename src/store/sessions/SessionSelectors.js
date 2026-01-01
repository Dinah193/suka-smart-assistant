/**
 * C:\Users\larho\suka-smart-assistant\src\store\sessions\SessionSelectors.js
 *
 * SessionSelectors — read-only “query helpers” for SSA sessions.
 *
 * How this fits:
 * - Domain pages call these selectors to power their prominent “Now” CTA and lists.
 * - SessionRunner can use these to restore/reroute when a session is already running.
 * - All writes go through SessionStore; selectors are *purely* derived reads.
 *
 * Contracts honored:
 * - Session object per Master Codegen Prompt (id, domain, status, progress, etc.).
 * - Uses SessionStore repository for persistence access (Dexie or in-memory fallback).
 *
 * Design:
 * - Async selectors that fetch from the store and compute a result.
 * - Conservative, defensive guards — never throw on bad data.
 * - Heuristics for “next runnable”: running → paused → oldest pending.
 * - Helpers to compute progress stats, ETA strings, and CTA button state.
 *
 * Extension points:
 * - Add domain-specific ranking in `rankPending` if your app needs priorities.
 * - Plug “guard-aware” filtering in `filterRunnableByGuards()` once guards are global.
 *
 * © Suka Smart Assistant
 */

const { sessionStore } = require("./SessionStore");

// ---------------------------------------------------------------------------
// Small utilities
const ISO = () => new Date().toISOString();
const safe = (v, d) => (v == null ? d : v);
const byUpdatedDesc = (a, b) => String(b?.updatedAt || "").localeCompare(String(a?.updatedAt || ""));
const byCreatedAsc = (a, b) => String(a?.createdAt || "").localeCompare(String(b?.createdAt || ""));

function mmss(sec = 0) {
  const s = Math.max(0, sec | 0);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r < 10 ? "0" : ""}${r}`;
}

function etaFromNowPlus(seconds = 0) {
  const now = new Date();
  const then = new Date(now.getTime() + Math.max(0, seconds | 0) * 1000);
  const pad = (n) => (n < 10 ? `0${n}` : `${n}`);
  return `${pad(then.getHours())}:${pad(then.getMinutes())}`;
}

function progressPct(session) {
  const total = Array.isArray(session?.steps) ? session.steps.length : 0;
  const idx = safe(session?.progress?.currentStepIndex, 0);
  if (!total) return 0;
  return Math.max(0, Math.min(100, (idx / total) * 100));
}

function remainingSeconds(session) {
  // Sum durations from *next* step onward (rough ETA), ignoring current elapsed detail.
  const steps = Array.isArray(session?.steps) ? session.steps : [];
  const idx = safe(session?.progress?.currentStepIndex, 0);
  const tail = steps.slice(idx + 1);
  return tail.reduce((sum, s) => sum + (Number.isFinite(s?.durationSec) ? s.durationSec : 0), 0);
}

function summarize(session) {
  if (!session) return null;
  const pct = progressPct(session);
  const rem = remainingSeconds(session);
  const eta = rem ? etaFromNowPlus(rem) : "—";
  const idx = safe(session?.progress?.currentStepIndex, 0);
  const total = Array.isArray(session?.steps) ? session.steps.length : 0;
  const currentTitle = session?.steps?.[idx]?.title || null;
  return {
    id: session.id,
    title: session.title || "Session",
    domain: session.domain || "cooking",
    status: session.status || "pending",
    step: { index: idx, of: total, title: currentTitle },
    progressPct: pct,
    remainingSec: rem,
    remainingMMSS: mmss(rem),
    eta,
    source: { type: session?.source?.type || "manual", refId: session?.source?.refId || null },
    updatedAt: session?.updatedAt || ISO(),
  };
}

/**
 * Optional placeholder for guard-aware filtering.
 * Plug global guards here to preempt sessions that cannot run right now.
 * Currently returns the same list.
 */
async function filterRunnableByGuards(list /* : any[] */) {
  // TODO: integrate real guards (quietHours/sabbath/weather/inventory) if desired.
  return list;
}

/** Optional ranker for pending sessions (domain-specific prioritization). */
function rankPending(list /* : any[] */) {
  // Oldest first is often best for “pending”; customize here for your domain.
  return list.slice().sort(byCreatedAsc);
}

// ---------------------------------------------------------------------------
// Public Selectors

/**
 * Get all sessions for a domain, grouped by status buckets commonly used in UI.
 * @param {"cooking"|"cleaning"|"garden"|"animals"|"preservation"|"storehouse"} domain
 * @returns {Promise<{running:any[], paused:any[], pending:any[], completed:any[], aborted:any[]}>}
 */
async function selectDomainGroups(domain) {
  const all = await sessionStore.listByDomain(domain);
  const running = [];
  const paused = [];
  const pending = [];
  const completed = [];
  const aborted = [];
  for (const s of all) {
    switch (s?.status) {
      case "running": running.push(s); break;
      case "paused": paused.push(s); break;
      case "pending": pending.push(s); break;
      case "completed": completed.push(s); break;
      case "aborted": aborted.push(s); break;
      default: pending.push(s); break;
    }
  }
  running.sort(byUpdatedDesc);
  paused.sort(byUpdatedDesc);
  rankPending(pending); // in-place sorted copy not needed for direct push consumers
  completed.sort(byUpdatedDesc);
  aborted.sort(byUpdatedDesc);
  return { running, paused, pending, completed, aborted };
}

/**
 * List sessions that are eligible to run “now” for a given domain, ordered by priority.
 * Priority: running (newest) → paused (newest) → pending (oldest).
 * Guard-aware filtering stub is applied.
 * @param {string} domain
 * @returns {Promise<any[]>}
 */
async function selectRunnableList(domain) {
  const raw = await sessionStore.listRunnableByDomain(domain);
  return filterRunnableByGuards(raw);
}

/**
 * Select a single “next runnable” session for a domain for the “Now” CTA.
 * Returns null if none.
 * @param {string} domain
 * @returns {Promise<any|null>}
 */
async function selectNextRunnable(domain) {
  const list = await selectRunnableList(domain);
  return list[0] || null;
}

/**
 * If a session with the given id exists and is running, return it — used for idempotent resume.
 * @param {string} id
 * @returns {Promise<any|null>}
 */
async function selectResumeCandidateById(id) {
  return sessionStore.findRunningById(id);
}

/**
 * Return an “active or latest” session for a domain — convenient for deep-links or auto-open logic.
 * Heuristic:
 *   1) running (newest) if any,
 *   2) else paused (newest),
 *   3) else most recently updated session of any status (to show history).
 * @param {string} domain
 */
async function selectActiveOrLatest(domain) {
  const all = await sessionStore.listByDomain(domain);
  if (!all.length) return null;
  const running = all.filter((s) => s.status === "running").sort(byUpdatedDesc);
  if (running.length) return running[0];
  const paused = all.filter((s) => s.status === "paused").sort(byUpdatedDesc);
  if (paused.length) return paused[0];
  return all.sort(byUpdatedDesc)[0];
}

/**
 * Compute a compact summary DTO for UI badges/rows (safe to show in lists).
 * @param {any} session
 * @returns {{
 *  id:string,title:string,domain:string,status:string,
 *  step:{index:number,of:number,title:string|null},
 *  progressPct:number, remainingSec:number, remainingMMSS:string, eta:string,
 *  source:{type:string,refId:string|null}, updatedAt:string
 * } | null}
 */
function buildSessionSummary(session) {
  try {
    return summarize(session);
  } catch {
    return null;
  }
}

/**
 * Compute the CTA state for a domain page's “Now” button.
 * - label: UX text
 * - hint: sublabel
 * - session: the chosen session (or null)
 * - disabled: whether the CTA should be disabled
 * @param {string} domain
 * @returns {Promise<{label:string, hint:string, session:any|null, disabled:boolean}>}
 */
async function computeDomainCTAState(domain) {
  const next = await selectNextRunnable(domain);
  if (!next) {
    return { label: "Start a session", hint: "No runnable sessions found", session: null, disabled: true };
  }
  if (next.status === "running") {
    return { label: "Resume now", hint: "A session is already in progress", session: next, disabled: false };
  }
  if (next.status === "paused") {
    return { label: "Resume now", hint: "Pick up where you left off", session: next, disabled: false };
  }
  return { label: "Start now", hint: "Oldest pending session", session: next, disabled: false };
}

/**
 * Produce notification-friendly fields for an ongoing session (title + current step line).
 * @param {any} session
 * @returns {{title:string, body:string, tag:string}}
 */
function selectOngoingNotificationData(session) {
  const s = session || {};
  const idx = safe(s?.progress?.currentStepIndex, 0);
  const step = s?.steps?.[idx];
  const title = s?.title || "Session";
  const body = step ? `Step ${idx + 1}: ${step.title}` : "Session in progress";
  return { title, body, tag: `ssa-session-${s?.id || "unknown"}` };
}

/**
 * Compute a bucket of progress/ETA stats for dashboard cards.
 * @param {any} session
 * @returns {{pct:number, remainingSec:number, remainingMMSS:string, eta:string}}
 */
function computeProgressStats(session) {
  const pct = progressPct(session);
  const rem = remainingSeconds(session);
  return {
    pct,
    remainingSec: rem,
    remainingMMSS: mmss(rem),
    eta: rem ? etaFromNowPlus(rem) : "—",
  };
}

// ---------------------------------------------------------------------------
// Convenience higher-level selectors (optional but handy)

/**
 * For a domain, return:
 * - chosen: the single session that should open when user taps “Now”
 * - options: if multiple runnable exist *beyond* chosen, return the rest (for selector modal)
 * - summaries: summarized rows for display
 * @param {string} domain
 * @returns {Promise<{chosen:any|null, options:any[], summaries:any[]}>}
 */
async function selectNowBundle(domain) {
  const list = await selectRunnableList(domain);
  const chosen = list[0] || null;
  const options = list.slice(1);
  const summaries = list.map(buildSessionSummary).filter(Boolean);
  return { chosen, options, summaries };
}

/**
 * Given a session id, fetch, normalize minimal fields, and return a resilient object for UI.
 * Intended for route guards that need a quick check.
 * @param {string} id
 */
async function selectSessionHeader(id) {
  const s = await sessionStore.get(id);
  if (!s) return null;
  return {
    id: s.id,
    title: s.title || "Session",
    domain: s.domain || "cooking",
    status: s.status || "pending",
    stepIndex: safe(s?.progress?.currentStepIndex, 0),
    stepCount: Array.isArray(s?.steps) ? s.steps.length : 0,
    updatedAt: s.updatedAt || ISO(),
  };
}

// ---------------------------------------------------------------------------
// Exports
module.exports = {
  // lists & grouping
  selectDomainGroups,
  selectRunnableList,
  selectNextRunnable,
  selectActiveOrLatest,
  selectResumeCandidateById,

  // UI helpers
  buildSessionSummary,
  computeDomainCTAState,
  selectOngoingNotificationData,
  computeProgressStats,

  // bundles / convenience
  selectNowBundle,
  selectSessionHeader,
};
