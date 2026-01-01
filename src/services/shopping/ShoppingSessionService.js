// src/services/shopping/ShoppingSessionService.js
// -----------------------------------------------------------------------------
// ShoppingSessionService
// -----------------------------------------------------------------------------
// Responsibilities:
// - Start/stop an active shopping session
// - Attach store context (selected stores / current store)
// - Add candidates created from scans (provisional, not committed to household)
// - Persist sessions + candidates (Dexie if available; local fallback otherwise)
// - Emit events so UI can react instantly
//
// Emits:
// - "shopping:session.started" { session }
// - "shopping:session.updated" { sessionId, patch, session }
// - "shopping:session.stopped" { sessionId, endedAt, session }
// - "shopping:candidate.added" { sessionId, candidate }
// - "shopping:candidate.updated" { candidateId, patch, candidate }
// - "shopping:candidate.removed" { candidateId }
// -----------------------------------------------------------------------------
//
// Candidate shape (minimal; pipeline will enrich):
// {
//   id, sessionId, status: "staged"|"enriching"|"enriched"|"failed"|"dismissed"|"in_cart"|"returned",
//   createdAt, updatedAt,
//   storeSetKey, stores: [...], currentStore,
//   scan: { id, kind, content, at, meta, intent, mode },
//   resolved: { item, observations, coupons, recalls, ingredientsCheck } // streaming patches
// }
//
// NOTE: This service does NOT enrich candidates; it stages & persists.
// The ShoppingCandidatePipeline should subscribe to candidate additions or be invoked by UI.
// -----------------------------------------------------------------------------

/* eslint-disable no-console */

const DEFAULTS = {
  dbImportPath: "@/services/db",
  sessionTable: "shopping_sessions",
  candidateTable: "shopping_candidates",
  storageKey: "suka:shopping:sessions:v1",
  activeKey: "suka:shopping:activeSessionId:v1",
};

function now() {
  return Date.now();
}
function uid(prefix = "id") {
  return `${prefix}:${Math.random()
    .toString(36)
    .slice(2)}:${Date.now().toString(36)}`;
}
function safeJsonParse(raw, fallback) {
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function deepMerge(base, patch) {
  if (!patch || typeof patch !== "object") return base;
  const out = Array.isArray(base) ? [...base] : { ...(base || {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function getEventBusFromGlobals() {
  if (typeof window === "undefined") return null;
  return window.__SUKA_EVENT_BUS__ || null;
}

/**
 * Dexie adapter:
 * - Uses db.table(name) when available
 * - Or db[name] when your db exports tables as properties
 * - Otherwise returns null so we fallback to local storage
 */
function getDexieTable(db, name) {
  if (!db) return null;
  try {
    if (typeof db.table === "function") {
      const t = db.table(name);
      if (t) return t;
    }
  } catch {}
  try {
    if (db[name]) return db[name];
  } catch {}
  try {
    const tables = Array.isArray(db.tables) ? db.tables : [];
    const found = tables.find((t) => t?.name === name);
    if (found && typeof db.table === "function") return db.table(name);
  } catch {}
  return null;
}

async function lazyImportDb(dbImportPath) {
  try {
    const mod = await import(/* @vite-ignore */ dbImportPath);
    return mod?.db || mod?.default || mod || null;
  } catch (e) {
    return null;
  }
}

/**
 * Local fallback store (single JSON blob) for sessions and candidates.
 * Keeps app functioning even before Dexie schema lands.
 */
class LocalStore {
  constructor(storageKey) {
    this.storageKey = storageKey;
  }

  _read() {
    if (typeof localStorage === "undefined")
      return { sessions: {}, candidates: {} };
    const raw = localStorage.getItem(this.storageKey);
    return safeJsonParse(raw, { sessions: {}, candidates: {} });
  }
  _write(data) {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(this.storageKey, JSON.stringify(data));
  }

  getActiveSessionId(activeKey) {
    try {
      return localStorage.getItem(activeKey) || null;
    } catch {
      return null;
    }
  }
  setActiveSessionId(activeKey, id) {
    try {
      if (!id) localStorage.removeItem(activeKey);
      else localStorage.setItem(activeKey, String(id));
    } catch {}
  }

  async putSession(session) {
    const db = this._read();
    db.sessions[String(session.id)] = session;
    this._write(db);
    return session;
  }
  async getSession(id) {
    const db = this._read();
    return db.sessions[String(id)] || null;
  }
  async listSessions() {
    const db = this._read();
    return Object.values(db.sessions || {}).sort(
      (a, b) => Number(b?.startedAt || 0) - Number(a?.startedAt || 0)
    );
  }

  async putCandidate(candidate) {
    const db = this._read();
    db.candidates[String(candidate.id)] = candidate;
    this._write(db);
    return candidate;
  }
  async getCandidate(id) {
    const db = this._read();
    return db.candidates[String(id)] || null;
  }
  async listCandidatesBySession(sessionId) {
    const db = this._read();
    return Object.values(db.candidates || {})
      .filter((c) => String(c.sessionId) === String(sessionId))
      .sort((a, b) => Number(b?.createdAt || 0) - Number(a?.createdAt || 0));
  }
  async deleteCandidate(id) {
    const db = this._read();
    delete db.candidates[String(id)];
    this._write(db);
  }
}

export default class ShoppingSessionService {
  constructor(opts = {}) {
    const gBus = getEventBusFromGlobals();
    this.eventBus = opts.eventBus ||
      gBus || { emit: () => {}, on: () => {}, off: () => {} };

    this.db = opts.db || null;
    this.dbImportPath = opts.dbImportPath || DEFAULTS.dbImportPath;

    this.sessionTableName = opts.sessionTable || DEFAULTS.sessionTable;
    this.candidateTableName = opts.candidateTable || DEFAULTS.candidateTable;

    this.local = new LocalStore(opts.storageKey || DEFAULTS.storageKey);
    this.activeKey = opts.activeKey || DEFAULTS.activeKey;

    this._ready = false;
    this._tables = { sessions: null, candidates: null };
  }

  async init({ force = false } = {}) {
    if (this._ready && !force) return true;

    if (!this.db) {
      this.db = await lazyImportDb(this.dbImportPath);
    }
    const sessions = getDexieTable(this.db, this.sessionTableName);
    const candidates = getDexieTable(this.db, this.candidateTableName);
    this._tables.sessions = sessions;
    this._tables.candidates = candidates;

    this._ready = true;
    return true;
  }

  getActiveSessionId() {
    return this.local.getActiveSessionId(this.activeKey);
  }

  async getActiveSession() {
    await this.init();
    const id = this.getActiveSessionId();
    if (!id) return null;
    return this.getSession(id);
  }

  async setActiveSessionId(sessionId) {
    this.local.setActiveSessionId(
      this.activeKey,
      sessionId ? String(sessionId) : ""
    );
  }

  async startSession({
    stores = [],
    currentStore = null,
    storeSetKey = null,
    meta = {},
  } = {}) {
    await this.init();

    const session = {
      id: uid("shopSess"),
      status: "active",
      startedAt: now(),
      endedAt: null,
      stores: Array.isArray(stores) ? stores : [],
      currentStore: currentStore || (Array.isArray(stores) ? stores[0] : null),
      storeSetKey: storeSetKey || null,
      meta: meta && typeof meta === "object" ? meta : {},
      stats: { candidateCount: 0, enrichedCount: 0, failedCount: 0 },
      updatedAt: now(),
    };

    await this._putSession(session);
    await this.setActiveSessionId(session.id);

    this.eventBus.emit?.("shopping:session.started", { session });
    return session;
  }

  async stopSession(sessionId, { reason = "user", metaPatch = {} } = {}) {
    await this.init();
    const id = sessionId || this.getActiveSessionId();
    if (!id) return null;

    const existing = await this.getSession(id);
    if (!existing) {
      await this.setActiveSessionId(null);
      return null;
    }

    const endedAt = now();
    const patch = {
      status: "stopped",
      endedAt,
      updatedAt: endedAt,
      meta: deepMerge(existing.meta || {}, {
        stopReason: reason,
        ...(metaPatch || {}),
      }),
    };

    const next = deepMerge(existing, patch);
    await this._putSession(next);

    const active = this.getActiveSessionId();
    if (String(active) === String(id)) await this.setActiveSessionId(null);

    this.eventBus.emit?.("shopping:session.stopped", {
      sessionId: id,
      endedAt,
      session: next,
    });
    return next;
  }

  async attachStoreContext(
    sessionId,
    { stores, currentStore, storeSetKey, metaPatch = {} } = {}
  ) {
    await this.init();
    const id = sessionId || this.getActiveSessionId();
    if (!id)
      throw new Error("No active shopping session to attach store context to.");

    const existing = await this.getSession(id);
    if (!existing) throw new Error("Shopping session not found.");

    const patch = {
      stores: Array.isArray(stores) ? stores : existing.stores || [],
      currentStore: currentStore || existing.currentStore || null,
      storeSetKey: storeSetKey || existing.storeSetKey || null,
      updatedAt: now(),
      meta: deepMerge(existing.meta || {}, metaPatch || {}),
    };

    const next = deepMerge(existing, patch);
    await this._putSession(next);

    this.eventBus.emit?.("shopping:session.updated", {
      sessionId: id,
      patch,
      session: next,
    });
    return next;
  }

  /**
   * Stage a candidate from a scan (barcode/text/image).
   * This does NOT commit to household inventory — that happens after receipt reconciliation.
   */
  async addCandidateFromScan(
    scan,
    { sessionId, stores, currentStore, storeSetKey, mode = "shopping" } = {}
  ) {
    await this.init();
    const sid = sessionId || this.getActiveSessionId();
    if (!sid)
      throw new Error("No active shopping session. Start a session first.");

    const session = await this.getSession(sid);
    const finalStores = Array.isArray(stores) ? stores : session?.stores || [];
    const finalCurrentStore =
      currentStore || session?.currentStore || finalStores[0] || null;
    const finalStoreSetKey = storeSetKey || session?.storeSetKey || null;

    const candidate = {
      id: uid("cand"),
      sessionId: sid,
      status: "staged",
      createdAt: now(),
      updatedAt: now(),
      stores: finalStores,
      currentStore: finalCurrentStore,
      storeSetKey: finalStoreSetKey,
      scan: {
        id: scan?.id || uid("scan"),
        kind: scan?.kind || "barcode",
        content: scan?.content || "",
        at: scan?.at || now(),
        meta: scan?.meta || {},
        intent: scan?.intent || "shopping:candidate",
        mode: scan?.mode || mode,
      },
      resolved:
        scan?.resolved && typeof scan.resolved === "object"
          ? scan.resolved
          : {},
    };

    await this._putCandidate(candidate);

    // Update session stats
    if (session) {
      const stats = { ...(session.stats || {}) };
      stats.candidateCount = Number(stats.candidateCount || 0) + 1;
      const nextSession = deepMerge(session, { stats, updatedAt: now() });
      await this._putSession(nextSession);
      this.eventBus.emit?.("shopping:session.updated", {
        sessionId: sid,
        patch: { stats },
        session: nextSession,
      });
    }

    this.eventBus.emit?.("shopping:candidate.added", {
      sessionId: sid,
      candidate,
    });
    return candidate;
  }

  async updateCandidate(candidateId, patch = {}) {
    await this.init();
    const existing = await this.getCandidate(candidateId);
    if (!existing) return null;
    const next = deepMerge(existing, { ...(patch || {}), updatedAt: now() });
    await this._putCandidate(next);
    this.eventBus.emit?.("shopping:candidate.updated", {
      candidateId: next.id,
      patch,
      candidate: next,
    });
    return next;
  }

  async removeCandidate(candidateId) {
    await this.init();
    await this._deleteCandidate(candidateId);
    this.eventBus.emit?.("shopping:candidate.removed", { candidateId });
  }

  async getSession(id) {
    await this.init();
    const t = this._tables.sessions;
    if (t?.get) {
      try {
        return await t.get(String(id));
      } catch {}
    }
    return this.local.getSession(id);
  }

  async listSessions() {
    await this.init();
    const t = this._tables.sessions;
    if (t?.toArray) {
      try {
        const xs = await t.toArray();
        return (xs || []).sort(
          (a, b) => Number(b?.startedAt || 0) - Number(a?.startedAt || 0)
        );
      } catch {}
    }
    return this.local.listSessions();
  }

  async getCandidate(id) {
    await this.init();
    const t = this._tables.candidates;
    if (t?.get) {
      try {
        return await t.get(String(id));
      } catch {}
    }
    return this.local.getCandidate(id);
  }

  async listCandidatesBySession(sessionId) {
    await this.init();
    const t = this._tables.candidates;

    // Dexie query if index exists
    if (t?.where) {
      try {
        // Common: where("sessionId").equals(...)
        const xs = await t
          .where("sessionId")
          .equals(String(sessionId))
          .toArray();
        return (xs || []).sort(
          (a, b) => Number(b?.createdAt || 0) - Number(a?.createdAt || 0)
        );
      } catch {}
    }

    // fallback: full scan
    if (t?.toArray) {
      try {
        const xs = await t.toArray();
        return (xs || [])
          .filter((c) => String(c?.sessionId) === String(sessionId))
          .sort(
            (a, b) => Number(b?.createdAt || 0) - Number(a?.createdAt || 0)
          );
      } catch {}
    }

    return this.local.listCandidatesBySession(sessionId);
  }

  /* ------------------------------ Internal persistence ------------------------------ */

  async _putSession(session) {
    const t = this._tables.sessions;
    if (t?.put) {
      try {
        await t.put(session);
        return session;
      } catch (e) {
        // fallthrough to local
      }
    }
    return this.local.putSession(session);
  }

  async _putCandidate(candidate) {
    const t = this._tables.candidates;
    if (t?.put) {
      try {
        await t.put(candidate);
        return candidate;
      } catch (e) {
        // fallthrough to local
      }
    }
    return this.local.putCandidate(candidate);
  }

  async _deleteCandidate(candidateId) {
    const t = this._tables.candidates;
    if (t?.delete) {
      try {
        await t.delete(String(candidateId));
        return;
      } catch {}
    }
    return this.local.deleteCandidate(candidateId);
  }
}
