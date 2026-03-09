/**
 * C:\Users\larho\suka-smart-assistant\src\store\sessions\SessionStore.js
 *
 * SessionStore — persistence & query utilities for SSA sessions.
 *
 * How this fits:
 * - A thin repository over Dexie (db.sessions) with safe fallbacks.
 * - Used by domain pages to find the “next runnable session” for their “Now” CTA.
 * - Used by SessionRunner to checkpoint, mutate status, and record analytics.
 * - Emits telemetry via eventBus for store-level mutations (not the same as runner events).
 *
 * Contracts honored:
 * - Session object shape (see Master Codegen Prompt).
 * - Event payload shape: { type, ts, source, data } (ts is ISO 8601).
 *
 * Key capabilities:
 * - ensureSchema(): upgrades/creates the 'sessions' table if needed.
 * - upsert(session), get(id), remove(id)
 * - markStatus(id, status, patch?) -> writes status + touched timestamps
 * - checkpoint(session) -> idempotent put with updatedAt touch
 * - listByDomain(domain), listRunnableByDomain(domain)
 * - selectNextRunnable(domain) -> heuristic for “Now” button
 * - findRunningById(id) + resume semantics
 * - recordAnalytics(id, patch) -> merges analytics arrays safely
 * - clearCompletedOlderThan(days)
 *
 * Defensive behavior:
 * - If Dexie is missing/unavailable, falls back to an in-memory Map so UI can still
 *   function during development; logs a warning.
 *
 * © Suka Smart Assistant
 */

/** @typedef {"pending"|"running"|"paused"|"completed"|"aborted"} SessionStatus */

const ISO = () => new Date().toISOString();

// -------------------- Defensive imports -------------------------------------
let eventBus;
try {
  // expected default export: { emit({type, ts, source, data}) }
  eventBus = require("../../services/events/eventBus.js").default;
} catch {
  eventBus = { emit: () => {} };
}

let db;
try {
  // expected: export const db = new Dexie(...); with db.sessions table
  db = require("../../services/db.js").db;
} catch {
  db = null;
}

let featureFlags = { familyFundMode: false };
try {
  featureFlags = require("@/config/featureFlags.json");
} catch {
  /* noop */
}

// -------------------- Utilities ---------------------------------------------
function emitStore(type, data) {
  try {
    eventBus.emit({ type, ts: ISO(), source: "SessionStore", data });
  } catch {
    /* noop */
  }
}

function normalizeSession(s = {}) {
  const base = {
    id: "",
    domain: "cooking",
    title: "Untitled Session",
    source: { type: "manual", refId: null },
    steps: [],
    prefs: { voiceGuidance: true, haptic: true, autoAdvance: false },
    status: "pending",
    progress: {
      currentStepIndex: 0,
      elapsedSec: 0,
      startedAt: null,
      pausedAt: null,
    },
    analytics: { skippedSteps: [], adjustments: [] },
    createdAt: ISO(),
    updatedAt: ISO(),
  };
  const out = { ...base, ...s };
  out.prefs = { ...base.prefs, ...(s.prefs || {}) };
  out.progress = { ...base.progress, ...(s.progress || {}) };
  out.analytics = {
    skippedSteps: Array.isArray(s?.analytics?.skippedSteps)
      ? s.analytics.skippedSteps
      : [],
    adjustments: Array.isArray(s?.analytics?.adjustments)
      ? s.analytics.adjustments
      : [],
  };
  out.steps = Array.isArray(s.steps) ? s.steps : [];
  if (!out.id || typeof out.id !== "string")
    throw new Error("Session must have a string id");
  return out;
}

function sortByUpdatedDesc(a, b) {
  return (b.updatedAt || "").localeCompare(a.updatedAt || "");
}

// -------------------- In-memory fallback ------------------------------------
const memory = new Map(); // id -> session
const memApi = {
  async put(s) {
    memory.set(s.id, s);
    return s.id;
  },
  async get(id) {
    return memory.get(id) || null;
  },
  async delete(id) {
    memory.delete(id);
  },
  async whereDomain(domain) {
    return Array.from(memory.values()).filter((x) => x.domain === domain);
  },
  async all() {
    return Array.from(memory.values());
  },
};

// -------------------- Dexie helpers -----------------------------------------
/**
 * Ensure the 'sessions' table exists with useful indexes.
 * Safe to call multiple times; on failure, silently continues.
 *
 * Schema: id (primary), domain, status, updatedAt, createdAt
 */
async function ensureSchema() {
  if (!db) return false;
  try {
    // Dexie allows versioned upgrades; bumping dynamically is supported.
    // We only add the store if it doesn't exist.
    const tables = Object.keys(
      db?.tables?.reduce?.((acc, t) => ((acc[t.name] = 1), acc), {}) || {}
    );
    const hasSessions = tables.includes("sessions") || !!db.sessions;

    if (!hasSessions) {
      const next = (db.verno || 1) + 0.001; // minimal bump to avoid collision
      db.version(next).stores({
        sessions: "id, domain, status, updatedAt, createdAt",
      });
      await db.open(); // apply version
    }
    return true;
  } catch {
    return false;
  }
}

async function table() {
  // Attempt Dexie path
  if (db?.sessions) return db.sessions;
  // Try to add schema then re-check
  const ok = await ensureSchema();
  if (ok && db?.sessions) return db.sessions;
  // Fallback to memory
  if (!SessionStore._warnedFallback) {
    console.warn(
      "[SessionStore] Dexie unavailable — using in-memory fallback (non-persistent)."
    );
    SessionStore._warnedFallback = true;
  }
  return null;
}

// -------------------- Store implementation ----------------------------------
class SessionStore {
  /** internal flag for console.warn throttling */
  static _warnedFallback = false;

  /**
   * Upsert a session (normalize + touch updatedAt); creates if not exists.
   * @param {any} raw
   * @returns {Promise<any>} normalized session saved
   */
  async upsert(raw) {
    if (!raw) throw new Error("upsert() requires a session object");
    const s = normalizeSession({
      ...raw,
      updatedAt: ISO(),
      createdAt: raw?.createdAt || ISO(),
    });

    const t = await table();
    if (t) {
      await t.put(s);
    } else {
      await memApi.put(s);
    }
    emitStore("session.store.updated", { id: s.id, op: "upsert" });
    return s;
  }

  /**
   * Write a lightweight checkpoint (idempotent). Will touch updatedAt.
   * @param {any} raw
   */
  async checkpoint(raw) {
    if (!raw?.id) return;
    const s = normalizeSession({ ...raw, updatedAt: ISO() });

    const t = await table();
    if (t) {
      await t.put(s);
    } else {
      await memApi.put(s);
    }
    emitStore("session.store.updated", { id: s.id, op: "checkpoint" });
  }

  /**
   * Get a session by id.
   * @param {string} id
   * @returns {Promise<any|null>}
   */
  async get(id) {
    if (!id) return null;
    const t = await table();
    if (t) return (await t.get(id)) || null;
    return await memApi.get(id);
  }

  /**
   * Remove a session by id.
   * @param {string} id
   */
  async remove(id) {
    if (!id) return;
    const t = await table();
    if (t) await t.delete(id);
    else await memApi.delete(id);
    emitStore("session.store.updated", { id, op: "remove" });
  }

  /**
   * List sessions for a domain (most recent first).
   * @param {"cooking"|"cleaning"|"garden"|"animals"|"preservation"|"storehouse"} domain
   */
  async listByDomain(domain) {
    const t = await table();
    let rows = [];
    if (t) {
      // Prefer using index if present
      try {
        rows = await t.where("domain").equals(domain).toArray();
      } catch {
        rows = await t.toArray();
        rows = rows.filter((r) => r.domain === domain);
      }
    } else {
      rows = await memApi.whereDomain(domain);
    }
    return rows.sort(sortByUpdatedDesc);
  }

  /**
   * List sessions that are “runnable” for a domain.
   * Heuristics:
   * - Include 'running' (to resume), 'paused', and 'pending'
   * - Exclude 'completed' and 'aborted'
   * Sorted priority: running (newest) → paused (newest) → pending (oldest createdAt first)
   * @param {string} domain
   */
  async listRunnableByDomain(domain) {
    const list = await this.listByDomain(domain);
    const running = list
      .filter((s) => s.status === "running")
      .sort(sortByUpdatedDesc);
    const paused = list
      .filter((s) => s.status === "paused")
      .sort(sortByUpdatedDesc);
    const pending = list
      .filter((s) => s.status === "pending")
      .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || "")); // oldest first

    return [...running, ...paused, ...pending];
  }

  /**
   * Select a single “next runnable” session for a domain (for the “Now” CTA).
   * Priority: running → paused → oldest pending.
   * Returns null if none.
   * @param {string} domain
   * @returns {Promise<any|null>}
   */
  async selectNextRunnable(domain) {
    const list = await this.listRunnableByDomain(domain);
    return list[0] || null;
  }

  /**
   * If the same id exists with status 'running', return it — used for idempotent resume.
   * @param {string} id
   * @returns {Promise<any|null>}
   */
  async findRunningById(id) {
    const s = await this.get(id);
    if (s && s.status === "running") return s;
    return null;
  }

  /**
   * Mark status and touch timestamps safely. Optionally patch fields.
   * Emits store telemetry; runner should emit its own domain events separately.
   * @param {string} id
   * @param {SessionStatus} status
   * @param {Partial<any>} [patch]
   * @returns {Promise<any|null>}
   */
  async markStatus(id, status, patch = {}) {
    const current = await this.get(id);
    if (!current) return null;

    const now = ISO();
    const next = {
      ...current,
      ...patch,
      status,
      updatedAt: now,
      progress: {
        ...current.progress,
        pausedAt:
          status === "paused"
            ? now
            : status === "running"
            ? null
            : current.progress?.pausedAt || null,
        startedAt:
          current.progress?.startedAt || (status === "running" ? now : null),
      },
    };

    const t = await table();
    if (t) await t.put(next);
    else await memApi.put(next);

    emitStore("session.store.updated", { id, op: "markStatus", status });
    return next;
  }

  /**
   * Append analytics in a safe, idempotent-ish way (no duplicates by stringified key).
   * @param {string} id
   * @param {{skippedSteps?: number[], adjustments?: any[]}} patch
   * @returns {Promise<any|null>}
   */
  async recordAnalytics(id, patch = {}) {
    const current = await this.get(id);
    if (!current) return null;

    const skippedSteps = Array.isArray(patch.skippedSteps)
      ? patch.skippedSteps
      : [];
    const adjustments = Array.isArray(patch.adjustments)
      ? patch.adjustments
      : [];

    const mergeUnique = (arr, add, keyFn = (x) => JSON.stringify(x)) => {
      const seen = new Set(arr.map(keyFn));
      const out = arr.slice();
      for (const item of add) {
        const k = keyFn(item);
        if (!seen.has(k)) {
          seen.add(k);
          out.push(item);
        }
      }
      return out;
    };

    const next = {
      ...current,
      analytics: {
        skippedSteps: mergeUnique(
          current.analytics?.skippedSteps || [],
          skippedSteps,
          (x) => String(x)
        ),
        adjustments: mergeUnique(
          current.analytics?.adjustments || [],
          adjustments
        ),
      },
      updatedAt: ISO(),
    };

    const t = await table();
    if (t) await t.put(next);
    else await memApi.put(next);

    emitStore("session.store.updated", { id, op: "recordAnalytics" });
    return next;
  }

  /**
   * Quickly append a skipped step index to analytics.skippedSteps.
   * @param {string} id
   * @param {number} stepIndex
   */
  async markStepSkipped(id, stepIndex) {
    return this.recordAnalytics(id, { skippedSteps: [stepIndex] });
  }

  /**
   * Cleanup helper to remove completed/aborted sessions older than N days.
   * Returns number of removed items when possible.
   * @param {number} days
   */
  async clearCompletedOlderThan(days = 7) {
    const cutoff = Date.now() - Math.max(1, days) * 24 * 3600 * 1000;
    const cutoffISO = new Date(cutoff).toISOString();

    const t = await table();
    let removed = 0;

    if (t) {
      try {
        // If index not available, do manual scan
        const all = await t.toArray();
        const doomed = all.filter(
          (s) =>
            (s.status === "completed" || s.status === "aborted") &&
            (s.updatedAt || s.createdAt || "1970-01-01") < cutoffISO
        );
        await Promise.all(doomed.map((s) => t.delete(s.id)));
        removed = doomed.length;
      } catch {
        // ignore
      }
    } else {
      // memory cleanup
      for (const s of await memApi.all()) {
        if (
          (s.status === "completed" || s.status === "aborted") &&
          (s.updatedAt || s.createdAt || "1970-01-01") < cutoffISO
        ) {
          await memApi.delete(s.id);
          removed++;
        }
      }
    }

    if (removed) emitStore("session.store.updated", { op: "gc", removed });
    return removed;
  }

  /**
   * Convenience to bump elapsed time (used by worker-driven ticks if store-level persistence is wanted).
   * Prefer calling from SessionRunner.checkpoint(); this remains optional.
   * @param {string} id
   * @param {number} deltaSec
   */
  async bumpElapsed(id, deltaSec = 1) {
    const s = await this.get(id);
    if (!s) return null;
    const next = {
      ...s,
      progress: {
        ...s.progress,
        elapsedSec: (s.progress?.elapsedSec || 0) + (deltaSec | 0),
      },
      updatedAt: ISO(),
    };
    const t = await table();
    if (t) await t.put(next);
    else await memApi.put(next);
    emitStore("session.store.updated", { id, op: "bumpElapsed", deltaSec });
    return next;
  }

  /**
   * Jump to a specific step index safely and persist.
   * @param {string} id
   * @param {number} idx
   */
  async setCurrentStep(id, idx) {
    const s = await this.get(id);
    if (!s) return null;
    const max = Math.max(0, (s.steps?.length || 1) - 1);
    const nextIdx = Math.min(Math.max(0, idx | 0), max);
    const next = {
      ...s,
      progress: { ...s.progress, currentStepIndex: nextIdx },
      updatedAt: ISO(),
    };
    const t = await table();
    if (t) await t.put(next);
    else await memApi.put(next);
    emitStore("session.store.updated", {
      id,
      op: "setCurrentStep",
      stepIndex: nextIdx,
    });
    return next;
  }

  /**
   * Advance to next step; if already at last step, no-op (caller decides completion).
   * @param {string} id
   */
  async nextStep(id) {
    const s = await this.get(id);
    if (!s) return null;
    const idx = s.progress?.currentStepIndex || 0;
    const total = s.steps?.length || 0;
    if (idx >= total - 1) return s;
    return this.setCurrentStep(id, idx + 1);
  }

  /**
   * Previous step (floor at zero).
   * @param {string} id
   */
  async prevStep(id) {
    const s = await this.get(id);
    if (!s) return null;
    const idx = s.progress?.currentStepIndex || 0;
    if (idx <= 0) return s;
    return this.setCurrentStep(id, idx - 1);
  }
}

// Singleton export (typical usage)
const sessionStore = new SessionStore();
module.exports = {
  SessionStore,
  sessionStore,
  // Named helpers (optional re-exports for convenience)
  ensureSchema,
};
