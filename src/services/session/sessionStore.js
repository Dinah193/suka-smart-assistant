// File: src/services/session/sessionStore.js
/**
 * sessionStore
 * -----------------------------------------------------------------------------
 * SSA Session Store (browser-safe, Dexie-backed)
 *
 * Purpose
 *  - Single source of truth for SSA "sessions" used by SessionRunner and engines:
 *      • cooking sessions, cleaning sessions, garden sessions, shopping sessions, etc.
 *  - Provides:
 *      • CRUD (create/read/update/close/cancel)
 *      • step tracking + checkpoints
 *      • lightweight querying (by domain/status/date)
 *      • optimistic updates with versioning
 *      • eventBus integration (if available)
 *      • liveQuery helpers for reactive UI
 *      • graceful fallback to in-memory store if Dexie table is missing
 *
 * Key Contracts (best-effort; schema tolerant)
 *  - Session:
 *      id, domain, title, status, steps[], activeStepIndex, startedAt, endedAt,
 *      createdAt, updatedAt, meta{}, blockers[], checkpoints[]
 *
 * Status conventions (not enforced, but standardized):
 *  - planned | active | paused | completed | canceled | failed
 *
 * Notes
 *  - NO Node imports; safe for Vite builds.
 *  - If your Dexie schema differs, this store attempts to resolve a sessions table.
 *  - Writes go to Dexie when possible; fallback to memory when not.
 */

import db from "@/services/db";
import { liveQuery } from "dexie";

/* -----------------------------------------------------------------------------
 * Optional eventBus
 * -------------------------------------------------------------------------- */

let eventBus = null;
try {
  // eslint-disable-next-line import/no-unresolved
  eventBus = (await import("@/services/events/eventBus")).default ?? null;
} catch {
  eventBus = null;
}

const SOURCE = "session.sessionStore";

/* -----------------------------------------------------------------------------
 * Table resolution
 * -------------------------------------------------------------------------- */

const SESSION_TABLE_CANDIDATES = [
  "sessions",
  "session",
  "sessionRuns",
  "session_runs",
  "cookingSessions",
  "cooking_sessions",
  "shoppingSessions",
  "shopping_sessions",
];

function resolveSessionsTable() {
  // direct candidates
  for (const k of SESSION_TABLE_CANDIDATES) {
    const t = db?.[k];
    if (t && typeof t.toCollection === "function") return t;
  }

  // scan tables
  try {
    const tables = db?.tables || [];
    const exact = tables.find((t) =>
      SESSION_TABLE_CANDIDATES.some((c) => String(t?.name) === c)
    );
    if (exact) return exact;

    const fuzzy = tables.find((t) => /session/i.test(String(t?.name || "")));
    return fuzzy || null;
  } catch {
    return null;
  }
}

function sessionsTableOrNull() {
  return resolveSessionsTable();
}

/* -----------------------------------------------------------------------------
 * In-memory fallback (only used if Dexie sessions table is missing)
 * -------------------------------------------------------------------------- */

const mem = {
  enabled: false,
  map: new Map(), // id -> session
};

function enableMemoryFallback() {
  if (!mem.enabled) mem.enabled = true;
}

function memPut(session) {
  mem.map.set(session.id, session);
  return session;
}

function memGet(id) {
  return mem.map.get(id) || null;
}

function memDel(id) {
  return mem.map.delete(id);
}

function memAll() {
  return Array.from(mem.map.values());
}

/* -----------------------------------------------------------------------------
 * Utilities
 * -------------------------------------------------------------------------- */

function nowMs() {
  return Date.now();
}

function genId(prefix = "sess") {
  const rnd = Math.random().toString(16).slice(2);
  return `${prefix}_${nowMs().toString(16)}_${rnd}`;
}

function normalizeText(s) {
  return String(s || "")
    .toLowerCase()
    .trim();
}

function normalizeDateValue(v) {
  if (!v) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const ms = Date.parse(String(v));
  return Number.isFinite(ms) ? ms : null;
}

function safeArray(x) {
  return Array.isArray(x) ? x : [];
}

function safeObject(x) {
  return x && typeof x === "object" && !Array.isArray(x) ? x : {};
}

function deepMerge(base, patch) {
  const a = safeObject(base);
  const b = safeObject(patch);
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      typeof out[k] === "object" &&
      !Array.isArray(out[k])
    ) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function emit(name, payload) {
  try {
    eventBus?.emit?.(name, payload);
  } catch {
    // never crash
  }
}

function stableStatus(s) {
  const t = normalizeText(s);
  if (!t) return "planned";
  // normalize common variants
  if (["running", "started", "inprogress", "in_progress", "active"].includes(t))
    return "active";
  if (["done", "complete", "completed"].includes(t)) return "completed";
  if (["cancel", "canceled", "cancelled"].includes(t)) return "canceled";
  if (["pause", "paused", "hold"].includes(t)) return "paused";
  if (["fail", "failed", "error"].includes(t)) return "failed";
  return t;
}

function normalizeSession(input = {}) {
  const id = input.id ?? input._id ?? input.uuid ?? input.key ?? genId();
  const createdAt =
    normalizeDateValue(input.createdAt ?? input.created_at) ?? nowMs();
  const updatedAt =
    normalizeDateValue(input.updatedAt ?? input.updated_at) ?? createdAt;

  return {
    id,
    domain: input.domain ?? input.type ?? "general",
    title: input.title ?? input.name ?? `${input.domain || "Session"}`,
    status: stableStatus(input.status ?? input.state),
    steps: safeArray(input.steps),
    activeStepIndex: Number.isFinite(input.activeStepIndex)
      ? input.activeStepIndex
      : Number(input.activeStepIndex ?? 0) || 0,
    startedAt: normalizeDateValue(input.startedAt ?? input.started_at) ?? null,
    endedAt: normalizeDateValue(input.endedAt ?? input.ended_at) ?? null,
    createdAt,
    updatedAt,
    version: Number.isFinite(input.version)
      ? input.version
      : Number(input.version ?? 1) || 1,
    meta: deepMerge({}, input.meta),
    blockers: safeArray(input.blockers),
    checkpoints: safeArray(input.checkpoints),
    // extra fields pass-through
    ...safeObject(input.extra),
  };
}

function isDexieReady() {
  const t = sessionsTableOrNull();
  return !!t && typeof t.toCollection === "function";
}

/* -----------------------------------------------------------------------------
 * Core CRUD
 * -------------------------------------------------------------------------- */

/**
 * Create a new session.
 * @param {object} session
 * @param {object} [opts]
 * @param {boolean} [opts.startNow] - sets startedAt + status active
 */
export async function createSession(session, opts = {}) {
  const t = sessionsTableOrNull();
  const startNow = !!opts.startNow;

  const base = normalizeSession(session);
  const next = {
    ...base,
    status: startNow ? "active" : base.status,
    startedAt: startNow ? base.startedAt ?? nowMs() : base.startedAt,
    updatedAt: nowMs(),
    version: (base.version || 1) + 0,
  };

  emit("session.created", {
    id: next.id,
    domain: next.domain,
    status: next.status,
  });

  if (t) {
    await t.put(next);
    return next;
  }

  enableMemoryFallback();
  memPut(next);
  return next;
}

/**
 * Read a session by ID.
 */
export async function getSession(id) {
  if (id == null) return null;
  const t = sessionsTableOrNull();
  if (t) return await t.get(id);
  if (mem.enabled) return memGet(id);
  return null;
}

/**
 * Update a session (partial merge). Increments version.
 * @param {string|number} id
 * @param {object|function(any):object} patchOrUpdater
 */
export async function updateSession(id, patchOrUpdater) {
  if (id == null) return null;

  const t = sessionsTableOrNull();
  const current = await getSession(id);
  if (!current) return null;

  const patch =
    typeof patchOrUpdater === "function"
      ? safeObject(patchOrUpdater(current))
      : safeObject(patchOrUpdater);

  const merged = {
    ...current,
    ...patch,
    meta: patch.meta ? deepMerge(current.meta, patch.meta) : current.meta,
    updatedAt: nowMs(),
    version: (Number(current.version) || 1) + 1,
  };

  merged.status = stableStatus(merged.status);

  emit("session.updated", {
    id,
    domain: merged.domain,
    status: merged.status,
    version: merged.version,
  });

  if (t) {
    await t.put(merged);
    return merged;
  }

  enableMemoryFallback();
  memPut(merged);
  return merged;
}

/**
 * Delete a session permanently (use carefully).
 */
export async function deleteSession(id) {
  if (id == null) return false;
  const t = sessionsTableOrNull();

  emit("session.deleted", { id });

  if (t) {
    await t.delete(id);
    return true;
  }

  if (mem.enabled) return memDel(id);
  return false;
}

/* -----------------------------------------------------------------------------
 * State transitions
 * -------------------------------------------------------------------------- */

export async function startSession(id, opts = {}) {
  const now = opts.nowMs ?? nowMs();
  return await updateSession(id, (s) => ({
    status: "active",
    startedAt: s.startedAt ?? now,
  }));
}

export async function pauseSession(id) {
  return await updateSession(id, { status: "paused" });
}

export async function resumeSession(id) {
  return await updateSession(id, { status: "active" });
}

export async function completeSession(id, opts = {}) {
  const now = opts.nowMs ?? nowMs();
  return await updateSession(id, { status: "completed", endedAt: now });
}

export async function cancelSession(id, opts = {}) {
  const now = opts.nowMs ?? nowMs();
  return await updateSession(id, {
    status: "canceled",
    endedAt: now,
    meta: { cancelReason: opts.reason ?? null },
  });
}

export async function failSession(id, opts = {}) {
  const now = opts.nowMs ?? nowMs();
  return await updateSession(id, {
    status: "failed",
    endedAt: now,
    meta: {
      error: opts.error ? String(opts.error?.message || opts.error) : null,
    },
  });
}

/* -----------------------------------------------------------------------------
 * Step helpers
 * -------------------------------------------------------------------------- */

/**
 * Set active step index (clamped).
 */
export async function setActiveStepIndex(id, index) {
  const session = await getSession(id);
  if (!session) return null;

  const steps = safeArray(session.steps);
  const nextIdx = Math.max(
    0,
    Math.min(Number(index) || 0, Math.max(0, steps.length - 1))
  );

  const updated = await updateSession(id, { activeStepIndex: nextIdx });

  emit("session.step.changed", {
    id,
    domain: updated?.domain,
    activeStepIndex: nextIdx,
    step: steps[nextIdx] ?? null,
  });

  return updated;
}

/**
 * Advance to next step (no-op if already last).
 */
export async function nextStep(id) {
  const session = await getSession(id);
  if (!session) return null;
  const steps = safeArray(session.steps);
  const i = Number(session.activeStepIndex) || 0;
  const nextIdx = Math.min(i + 1, Math.max(0, steps.length - 1));
  return await setActiveStepIndex(id, nextIdx);
}

/**
 * Go back to previous step (no-op if already first).
 */
export async function prevStep(id) {
  const session = await getSession(id);
  if (!session) return null;
  const i = Number(session.activeStepIndex) || 0;
  const nextIdx = Math.max(0, i - 1);
  return await setActiveStepIndex(id, nextIdx);
}

/**
 * Replace steps array (keeps activeStepIndex in bounds).
 */
export async function setSteps(id, steps) {
  const arr = safeArray(steps);
  const session = await getSession(id);
  if (!session) return null;

  const idx = Math.max(
    0,
    Math.min(Number(session.activeStepIndex) || 0, Math.max(0, arr.length - 1))
  );
  const updated = await updateSession(id, { steps: arr, activeStepIndex: idx });

  emit("session.steps.updated", {
    id,
    domain: updated?.domain,
    stepsCount: arr.length,
  });
  return updated;
}

/* -----------------------------------------------------------------------------
 * Checkpoints
 * -------------------------------------------------------------------------- */

/**
 * Append a checkpoint snapshot.
 * @param {string|number} id
 * @param {object} checkpoint - { at, label, data, stepIndex }
 */
export async function addCheckpoint(id, checkpoint = {}) {
  const session = await getSession(id);
  if (!session) return null;

  const cp = {
    at: normalizeDateValue(checkpoint.at) ?? nowMs(),
    label: checkpoint.label ?? "checkpoint",
    stepIndex: Number.isFinite(checkpoint.stepIndex)
      ? checkpoint.stepIndex
      : Number(session.activeStepIndex) || 0,
    data: safeObject(checkpoint.data),
  };

  const updated = await updateSession(id, (s) => ({
    checkpoints: [...safeArray(s.checkpoints), cp],
  }));

  emit("session.checkpoint.added", {
    id,
    domain: updated?.domain,
    checkpoint: cp,
  });
  return updated;
}

/**
 * List checkpoints.
 */
export async function listCheckpoints(id) {
  const session = await getSession(id);
  return safeArray(session?.checkpoints);
}

/* -----------------------------------------------------------------------------
 * Query helpers
 * -------------------------------------------------------------------------- */

function sortSessions(items, sortBy = "updatedAt", sortDir = "desc") {
  const dir = normalizeText(sortDir) === "asc" ? 1 : -1;

  const getter = (() => {
    switch (sortBy) {
      case "createdAt":
        return (s) => normalizeDateValue(s?.createdAt ?? s?.created_at) ?? 0;
      case "startedAt":
        return (s) => normalizeDateValue(s?.startedAt ?? s?.started_at) ?? 0;
      case "endedAt":
        return (s) => normalizeDateValue(s?.endedAt ?? s?.ended_at) ?? 0;
      case "status":
        return (s) => normalizeText(s?.status);
      case "domain":
        return (s) => normalizeText(s?.domain);
      case "title":
        return (s) => normalizeText(s?.title);
      case "updatedAt":
      default:
        return (s) => normalizeDateValue(s?.updatedAt ?? s?.updated_at) ?? 0;
    }
  })();

  return [...items].sort((a, b) => {
    const av = getter(a);
    const bv = getter(b);
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;

    // tie-breaker: updatedAt desc
    const au = normalizeDateValue(a?.updatedAt) ?? 0;
    const bu = normalizeDateValue(b?.updatedAt) ?? 0;
    if (au < bu) return -1 * dir;
    if (au > bu) return 1 * dir;
    return 0;
  });
}

function matchesQuery(session, q) {
  const qq = normalizeText(q);
  if (!qq) return true;
  const blob = normalizeText(
    [
      session?.title,
      session?.domain,
      session?.status,
      session?.meta?.intent,
      session?.meta?.notes,
      session?.meta?.label,
      ...(Array.isArray(session?.tags) ? session.tags : []),
    ]
      .filter(Boolean)
      .join(" ")
  );
  return blob.includes(qq);
}

function dayStartMs(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function dayEndMs(now) {
  const d = new Date(now);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

/**
 * List sessions with filters.
 * @param {object} opts
 * @param {string} [opts.domain]
 * @param {string} [opts.status]
 * @param {string} [opts.query]
 * @param {number} [opts.fromMs]
 * @param {number} [opts.toMs]
 * @param {boolean} [opts.includeArchived]
 * @param {number} [opts.limit]
 * @param {number} [opts.offset]
 * @param {string} [opts.sortBy]
 * @param {string} [opts.sortDir]
 * @returns {Promise<{items:any[], total:number}>}
 */
export async function listSessions(opts = {}) {
  const {
    domain,
    status,
    query,
    fromMs,
    toMs,
    includeArchived = false,
    limit = DEFAULTS.limit,
    offset = DEFAULTS.offset,
    sortBy = "updatedAt",
    sortDir = "desc",
  } = opts;

  const all = await (async () => {
    const t = sessionsTableOrNull();
    if (t) return await t.toArray();
    if (mem.enabled) return memAll();
    return [];
  })();

  const filtered = all
    .filter((s) =>
      includeArchived
        ? true
        : !(s?.archived ?? s?.isArchived ?? s?.deleted ?? s?.isDeleted)
    )
    .filter((s) =>
      domain ? normalizeText(s?.domain) === normalizeText(domain) : true
    )
    .filter((s) =>
      status
        ? normalizeText(stableStatus(s?.status)) === normalizeText(status)
        : true
    )
    .filter((s) => matchesQuery(s, query))
    .filter((s) => {
      if (fromMs == null && toMs == null) return true;
      const t =
        normalizeDateValue(
          s?.startedAt ?? s?.plannedFor ?? s?.date ?? s?.createdAt
        ) ?? 0;
      if (fromMs != null && t < fromMs) return false;
      if (toMs != null && t > toMs) return false;
      return true;
    });

  const sorted = sortSessions(filtered, sortBy, sortDir);

  const total = sorted.length;
  const o = Math.max(0, Number(offset) || 0);
  const l = Math.max(0, Number(limit) || 0);
  const items = l ? sorted.slice(o, o + l) : sorted.slice(o);

  return { items, total };
}

/**
 * List active sessions (status = active).
 */
export async function listActiveSessions(opts = {}) {
  return (
    await listSessions({
      ...opts,
      status: "active",
      limit: opts.limit ?? 200,
      offset: 0,
    })
  ).items;
}

/**
 * List today's sessions (by plannedFor/startedAt).
 */
export async function listTodaysSessions(opts = {}) {
  const now = opts.nowMs ?? nowMs();
  const start = dayStartMs(now);
  const end = dayEndMs(now);

  const { items } = await listSessions({
    ...opts,
    fromMs: start,
    toMs: end,
    limit: opts.limit ?? 500,
    offset: 0,
    sortBy: "startedAt",
    sortDir: "asc",
  });

  return items;
}

/* -----------------------------------------------------------------------------
 * KPIs
 * -------------------------------------------------------------------------- */

/**
 * Compute session KPIs for dashboard cards.
 * @param {object} opts
 * @param {number} [opts.nowMs]
 * @param {string[]} [opts.domains] - optional filter
 */
export async function getSessionKPIs(opts = {}) {
  const now = opts.nowMs ?? nowMs();
  const domains = Array.isArray(opts.domains)
    ? opts.domains.map(normalizeText).filter(Boolean)
    : null;

  const all = (
    await listSessions({ includeArchived: false, limit: 0, offset: 0 })
  ).items;
  const filtered = domains?.length
    ? all.filter((s) => domains.includes(normalizeText(s?.domain)))
    : all;

  const byStatus = filtered.reduce((acc, s) => {
    const st = stableStatus(s?.status);
    acc[st] = (acc[st] || 0) + 1;
    return acc;
  }, {});

  const today = await listTodaysSessions({ nowMs: now });
  const active = filtered.filter((s) => stableStatus(s?.status) === "active");

  const latestUpdatedAt =
    filtered.reduce(
      (m, s) => Math.max(m, normalizeDateValue(s?.updatedAt) ?? 0),
      0
    ) || null;

  return {
    generatedAt: now,
    total: filtered.length,
    activeCount: active.length,
    todayCount: today.length,
    byStatus,
    latestUpdatedAt,
  };
}

/* -----------------------------------------------------------------------------
 * Live query helpers (Dexie)
 * -------------------------------------------------------------------------- */

/**
 * liveQuery wrapper for listSessions().
 * Returns a function suitable for dexie-react-hooks useLiveQuery.
 */
export function makeLiveSessions(opts = {}) {
  return () => liveQuery(() => listSessions(opts));
}

export function makeLiveSession(id) {
  return () => liveQuery(() => getSession(id));
}

export function makeLiveSessionKPIs(opts = {}) {
  return () => liveQuery(() => getSessionKPIs(opts));
}

/* -----------------------------------------------------------------------------
 * Diagnostics / self-check
 * -------------------------------------------------------------------------- */

export function isReady() {
  return isDexieReady() || mem.enabled;
}

/**
 * Returns resolved table name or "(memory)".
 */
export function resolvedBackend() {
  const t = sessionsTableOrNull();
  if (t) return t.name || "sessions";
  return mem.enabled ? "(memory)" : "(none)";
}

/**
 * Force enabling memory fallback (useful for tests/dev).
 */
export function enableFallbackMemoryStore() {
  enableMemoryFallback();
  emit("session.backend.changed", { backend: "(memory)" });
}

/* -----------------------------------------------------------------------------
 * Optional: bootstrap a default store if Dexie is missing
 * -------------------------------------------------------------------------- */

(function bootstrap() {
  if (!sessionsTableOrNull()) {
    // Only enable fallback if caller later writes/reads;
    // we keep it off by default to surface schema issues early.
    // If you'd rather never crash, flip this to enableMemoryFallback().
  }
})();
