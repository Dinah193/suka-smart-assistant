// src/store/sessions/SessionAnalytics.js
/* eslint-disable no-console */

/**
 * SessionAnalytics — resilient analytics recorder for SessionRunner
 * ----------------------------------------------------------------------------
 * How this fits:
 * - Listens to SessionRunner lifecycle events via src/services/eventBus.js.
 * - Persists light analytics alongside sessions using Dexie if available
 *   (table: 'session_analytics'); falls back to localStorage if Dexie/db missing.
 * - On session completed|aborted: writes a final analytics record, emits an
 *   event, and (optionally) exports to Hub when familyFundMode is enabled.
 * - Designed to survive reloads: updates are idempotent by session.id.
 *
 * Events observed:
 *   session.started
 *   session.step.changed
 *   session.paused
 *   session.resumed
 *   session.completed
 *   session.aborted
 *   session.exported (we record exportedAt)
 *
 * Events emitted (mirrored or for debugging observability):
 *   analytics.written         { id, domain, status }
 *   analytics.export.request  { id }
 *   analytics.export.success  { id }
 *   analytics.export.failed   { id, error }
 *
 * Contract references:
 *   Session object (minimum viable) provided in the Master Codegen Prompt.
 *
 * Extension points:
 * - Add new derived stats inside _deriveFinalStats().
 * - Add more guard-related counters in _noteGuardBlock().
 * - Expand Hub envelope fields in _exportToHubIfEnabled().
 */

// ----------------------------- dynamic soft imports -----------------------------
async function _tryImport(paths = []) {
  for (const p of paths) {
    try {
      const mod = await import(/* @vite-ignore */ p);
      if (mod) return mod;
    } catch (_) { /* keep trying */ }
  }
  return null;
}

const _loadEventBus = async () => {
  const mod = await _tryImport([
    "@/services/eventBus.js",
    "../../services/eventBus.js",
    "../../../services/eventBus.js",
  ]);
  return (mod && mod.eventBus) || _createLocalBus();
};

const _loadFeatureFlags = async () => {
  const mod = await _tryImport([
    "@/services/featureFlags.js",
    "../../services/featureFlags.js",
    "../../../services/featureFlags.js",
  ]);
  return (mod && mod.featureFlags) || { familyFundMode: false };
};

const _loadHubFormatter = async () => {
  const mod = await _tryImport([
    "@/services/hub/HubPacketFormatter.js",
    "../../services/hub/HubPacketFormatter.js",
    "../../../services/hub/HubPacketFormatter.js",
    "@/services/HubPacketFormatter.js",
    "../../services/HubPacketFormatter.js",
  ]);
  return mod || {};
};

const _loadHubConnector = async () => {
  const mod = await _tryImport([
    "@/services/hub/FamilyFundConnector.js",
    "../../services/hub/FamilyFundConnector.js",
    "../../../services/hub/FamilyFundConnector.js",
    "@/services/FamilyFundConnector.js",
    "../../services/FamilyFundConnector.js",
  ]);
  return mod || {};
};

const _loadDb = async () => {
  // Expecting a Dexie instance export like: export const db = new Dexie(...);
  const mod = await _tryImport([
    "@/data/db.js",
    "../../data/db.js",
    "../../../data/db.js",
    "@/services/db.js",
    "../../services/db.js",
  ]);
  return (mod && (mod.db || mod.default)) || null;
};

// ----------------------------- local shims / utils -----------------------------
const _noop = () => {};
const _iso = () => new Date().toISOString();
function _createLocalBus() {
  const listeners = {};
  return {
    on(evt, cb) {
      listeners[evt] = listeners[evt] || [];
      listeners[evt].push(cb);
      return () => (listeners[evt] = (listeners[evt] || []).filter((f) => f !== cb));
    },
    emit(evt, payload) {
      (listeners[evt] || []).forEach((cb) => {
        try { cb(payload); } catch (e) { console.warn("eventBus listener error:", e); }
      });
    },
  };
}
function _safeId(x) { return String(x || ""); }
function _safeArr(a) { return Array.isArray(a) ? a : []; }
function _num(n, d = 0) { const v = Number(n); return Number.isFinite(v) ? v : d; }

// ----------------------------- localStorage fallback ---------------------------
const LS_KEY = "ssa.session.analytics.v1";
function _lsReadAll() {
  try { const raw = localStorage.getItem(LS_KEY); return raw ? JSON.parse(raw) : {}; }
  catch { return {}; }
}
function _lsWriteAll(map) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(map)); } catch {}
}
function _lsUpsert(id, obj) {
  const map = _lsReadAll();
  map[id] = { ...(map[id] || {}), ...obj, updatedAt: _iso() };
  _lsWriteAll(map);
}
function _lsRead(id) {
  const map = _lsReadAll();
  return map[id] || null;
}
function _lsList(limit = 50, domain) {
  const map = _lsReadAll();
  let rows = Object.values(map);
  if (domain) rows = rows.filter(r => r.domain === domain);
  rows.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  return rows.slice(0, limit);
}
function _lsPrune(days = 90) {
  const map = _lsReadAll();
  const cutoff = Date.now() - days * 86400000;
  const out = {};
  Object.keys(map).forEach((k) => {
    const t = Date.parse(map[k].updatedAt || map[k].createdAt || 0);
    if (Number.isFinite(t) && t >= cutoff) out[k] = map[k];
  });
  _lsWriteAll(out);
}

// ----------------------------- Dexie integration -------------------------------
async function _ensureDexieTable(db) {
  if (!db || !db.version) return false;
  // Try to create table if missing at runtime (best-effort; Dexie needs version bump).
  // We try known paths; if not possible, we’ll fall back to localStorage.
  try {
    if (!db.session_analytics && db.table) {
      // Some apps register tables lazily; attempt probing
      try { db.session_analytics = db.table("session_analytics"); } catch {}
    }
    if (db.session_analytics) return true;
  } catch {}
  return false;
}

async function _dexieUpsert(db, id, obj) {
  try {
    const has = await _ensureDexieTable(db);
    if (!has) return false;
    const key = _safeId(id);
    const prev = await db.session_analytics.get(key);
    const next = { ...(prev || {}), ...obj, id: key, updatedAt: _iso(), createdAt: prev?.createdAt || _iso() };
    await db.session_analytics.put(next);
    return true;
  } catch (e) {
    console.warn("SessionAnalytics Dexie upsert failed:", e);
    return false;
  }
}
async function _dexieRead(db, id) {
  try { const has = await _ensureDexieTable(db); if (!has) return null; return await db.session_analytics.get(_safeId(id)); }
  catch { return null; }
}
async function _dexieList(db, limit = 50, domain) {
  try {
    const has = await _ensureDexieTable(db);
    if (!has) return [];
    let coll = db.session_analytics.orderBy("updatedAt").reverse();
    if (domain && db.session_analytics.where) {
      coll = db.session_analytics.where("domain").equals(domain).reverse();
    }
    const rows = await coll.toArray();
    return (rows || []).slice(0, limit);
  } catch { return []; }
}
async function _dexiePrune(db, days = 90) {
  try {
    const has = await _ensureDexieTable(db);
    if (!has) return false;
    const cutoff = Date.now() - days * 86400000;
    const all = await db.session_analytics.toArray();
    const old = all.filter(r => Date.parse(r.updatedAt || r.createdAt || 0) < cutoff);
    await Promise.all(old.map(r => db.session_analytics.delete(r.id)));
    return true;
  } catch { return false; }
}

// ----------------------------- Hub export helper ------------------------------
async function _exportToHubIfEnabled(ctx, finalRecord) {
  try {
    const { featureFlags, HubPacketFormatter, FamilyFundConnector, eventBus } = ctx;
    const on = !!(featureFlags && featureFlags.familyFundMode);
    if (!on) return;

    const fmt = HubPacketFormatter && (HubPacketFormatter.default || HubPacketFormatter);
    const conn = FamilyFundConnector && (FamilyFundConnector.default || FamilyFundConnector);
    if (!fmt || !conn || !conn.send) return;

    eventBus.emit("analytics.export.request", { type: "analytics.export.request", ts: _iso(), source: "SessionAnalytics", data: { id: finalRecord.id } });

    const envelope =
      (fmt.format && fmt.format("session.analytics", finalRecord)) ||
      { kind: "session.analytics", at: _iso(), payload: finalRecord };

    const ok = await conn.send(envelope).catch((e) => { throw e; });
    if (ok !== false) {
      eventBus.emit("session.exported", { type: "session.exported", ts: _iso(), source: "SessionAnalytics", data: { id: finalRecord.id } });
      eventBus.emit("analytics.export.success", { type: "analytics.export.success", ts: _iso(), source: "SessionAnalytics", data: { id: finalRecord.id } });
    } else {
      throw new Error("FamilyFundConnector.send returned false");
    }
  } catch (error) {
    try {
      ctx.eventBus.emit("analytics.export.failed", { type: "analytics.export.failed", ts: _iso(), source: "SessionAnalytics", data: { error: String(error && error.message || error) } });
    } catch {}
  }
}

// ----------------------------- derivations & reducers -------------------------
function _deriveFinalStats(state = {}) {
  const stepsCompleted = _num(state.stepsCompleted, 0);
  const stepsTotal     = _num(state.stepsTotal, 0);
  const elapsedSec     = _num(state.elapsedSec, 0);
  const pauses         = _num(state.pauseCount, 0);
  const guards         = state.guards || {}; // { inventoryBlocks, weatherBlocks, quietBlocks, sabbathBlocks, equipmentBlocks }

  return {
    stepsCompleted,
    stepsTotal,
    stepCompletionRate: stepsTotal ? (stepsCompleted / stepsTotal) : 0,
    elapsedSec,
    pauseCount: pauses,
    guardBlocks: {
      inventory: _num(guards.inventory, 0),
      weather: _num(guards.weather, 0),
      quietHours: _num(guards.quietHours, 0),
      sabbath: _num(guards.sabbath, 0),
      equipment: _num(guards.equipment, 0),
    },
  };
}

function _noteGuardBlock(st, kind) {
  if (!st.guards) st.guards = {};
  st.guards[kind] = _num(st.guards[kind], 0) + 1;
}

// ----------------------------- main singleton ---------------------------------
const SessionAnalytics = (() => {
  // Runtime context (filled in init)
  const ctx = {
    db: null,
    eventBus: _createLocalBus(),
    featureFlags: { familyFundMode: false },
    HubPacketFormatter: null,
    FamilyFundConnector: null,
    attached: false,
  };

  // in-memory working set before writes (by session.id)
  const mem = new Map();

  async function init() {
    // Load deps
    try { ctx.eventBus = await _loadEventBus(); } catch { ctx.eventBus = _createLocalBus(); }
    try { ctx.featureFlags = await _loadFeatureFlags(); } catch { ctx.featureFlags = { familyFundMode: false }; }
    try { ctx.HubPacketFormatter = await _loadHubFormatter(); } catch {}
    try { ctx.FamilyFundConnector = await _loadHubConnector(); } catch {}
    try { ctx.db = await _loadDb(); } catch { ctx.db = null; }

    // Attach listeners once
    if (!ctx.attached) {
      _attachListeners();
      ctx.attached = true;
    }

    return SessionAnalytics;
  }

  function _attachListeners() {
    // STARTED
    ctx.eventBus.on("session.started", (evt) => {
      const s = evt && (evt.data || evt.payload || evt.session);
      if (!s || !s.id) return;
      if (!mem.has(s.id)) {
        mem.set(s.id, {
          id: _safeId(s.id),
          domain: s.domain || "unknown",
          title: s.title || "",
          startedAt: s.progress?.startedAt || _iso(),
          lastTickAt: _iso(),
          status: "running",
          stepsTotal: _safeArr(s.steps).length,
          stepsCompleted: 0,
          pauseCount: 0,
          elapsedSec: _num(s.progress?.elapsedSec, 0),
          skippedSteps: _safeArr(s.analytics?.skippedSteps),
          adjustments: _safeArr(s.analytics?.adjustments),
          guards: {},
          exportedAt: null,
          createdAt: _iso(),
          updatedAt: _iso(),
        });
      } else {
        const st = mem.get(s.id);
        st.status = "running";
        st.lastTickAt = _iso();
        st.updatedAt = _iso();
      }
      _persistWorkingSet(s.id);
    });

    // STEP CHANGED
    ctx.eventBus.on("session.step.changed", (evt) => {
      const s = evt && (evt.data || evt.payload || evt.session);
      if (!s || !s.id) return;
      const st = mem.get(s.id) || {
        id: _safeId(s.id),
        domain: s.domain || "unknown",
        title: s.title || "",
        startedAt: s.progress?.startedAt || _iso(),
        status: s.status || "running",
        stepsTotal: _safeArr(s.steps).length,
        stepsCompleted: 0,
        pauseCount: 0,
        elapsedSec: _num(s.progress?.elapsedSec, 0),
        skippedSteps: _safeArr(s.analytics?.skippedSteps),
        adjustments: _safeArr(s.analytics?.adjustments),
        guards: {},
        createdAt: _iso(),
        updatedAt: _iso(),
      };

      const idx = _num(s.progress?.currentStepIndex, 0);
      // Consider a step "completed" when we move forward (best-effort heuristic)
      if (_num(idx, 0) > st.stepsCompleted) st.stepsCompleted = idx;
      st.elapsedSec = _num(s.progress?.elapsedSec, st.elapsedSec);
      st.lastTickAt = _iso();
      st.updatedAt = _iso();
      mem.set(s.id, st);
      _persistWorkingSet(s.id);
    });

    // PAUSED / RESUMED
    ctx.eventBus.on("session.paused", (evt) => {
      const s = evt && (evt.data || evt.payload || evt.session);
      if (!s || !s.id) return;
      const st = mem.get(s.id);
      if (st) {
        st.status = "paused";
        st.pauseCount = _num(st.pauseCount, 0) + 1;
        st.elapsedSec = _num(s.progress?.elapsedSec, st.elapsedSec);
        st.updatedAt = _iso();
        _persistWorkingSet(s.id);
      }
    });
    ctx.eventBus.on("session.resumed", (evt) => {
      const s = evt && (evt.data || evt.payload || evt.session);
      if (!s || !s.id) return;
      const st = mem.get(s.id);
      if (st) {
        st.status = "running";
        st.updatedAt = _iso();
        _persistWorkingSet(s.id);
      }
    });

    // COMPLETED
    ctx.eventBus.on("session.completed", async (evt) => {
      const s = evt && (evt.data || evt.payload || evt.session);
      if (!s || !s.id) return;
      const st = mem.get(s.id) || {};
      st.status = "completed";
      st.elapsedSec = _num(s.progress?.elapsedSec, st.elapsedSec);
      st.stepsTotal = _safeArr(s.steps).length;
      st.stepsCompleted = Math.max(_num(st.stepsCompleted, 0), st.stepsTotal);
      st.finishedAt = _iso();
      st.updatedAt = _iso();

      const record = await _finalizeAndStore(s.id, s.domain, st);
      ctx.eventBus.emit("analytics.written", { type: "analytics.written", ts: _iso(), source: "SessionAnalytics", data: { id: record.id, domain: record.domain, status: record.status } });
      await _exportToHubIfEnabled(ctx, record);
    });

    // ABORTED
    ctx.eventBus.on("session.aborted", async (evt) => {
      const s = evt && (evt.data || evt.payload || evt.session);
      if (!s || !s.id) return;
      const st = mem.get(s.id) || {};
      st.status = "aborted";
      st.elapsedSec = _num(s.progress?.elapsedSec, st.elapsedSec);
      st.stepsTotal = _safeArr(s.steps).length;
      st.finishedAt = _iso();
      st.updatedAt = _iso();

      const record = await _finalizeAndStore(s.id, s.domain, st);
      ctx.eventBus.emit("analytics.written", { type: "analytics.written", ts: _iso(), source: "SessionAnalytics", data: { id: record.id, domain: record.domain, status: record.status } });
      await _exportToHubIfEnabled(ctx, record); // still export aborted runs for post-mortem
    });

    // EXPORTED (runner indicates Hub send success)
    ctx.eventBus.on("session.exported", (evt) => {
      const s = evt && (evt.data || evt.payload || evt.session);
      const id = s?.id || s;
      if (!id) return;
      const st = mem.get(id);
      if (st) {
        st.exportedAt = _iso();
        st.updatedAt = _iso();
        _persistWorkingSet(id);
      } else {
        // Update persisted record too
        _upsertPersisted(id, { exportedAt: _iso() });
      }
    });

    // Optional: record guards (if your guards emit these)
    ctx.eventBus.on("guard.blocked", (evt) => {
      const data = evt && (evt.data || evt.payload);
      const { sessionId, kind } = (data || {});
      if (!sessionId || !kind) return;
      const st = mem.get(sessionId);
      if (st) {
        _noteGuardBlock(st, String(kind));
        st.updatedAt = _iso();
        _persistWorkingSet(sessionId);
      }
    });
  }

  async function _persistWorkingSet(id) {
    const st = mem.get(id);
    if (!st || !id) return;
    // Try Dexie first
    if (ctx.db && await _dexieUpsert(ctx.db, id, st)) return;
    // Fallback to localStorage
    _lsUpsert(id, st);
  }

  async function _upsertPersisted(id, patch) {
    if (!id) return;
    // Dexie path
    if (ctx.db) {
      const prev = await _dexieRead(ctx.db, id);
      if (prev) {
        await _dexieUpsert(ctx.db, id, { ...prev, ...patch });
        return;
      }
    }
    // LS
    const prevLS = _lsRead(id) || {};
    _lsUpsert(id, { ...prevLS, ...patch });
  }

  async function _finalizeAndStore(id, domain, st) {
    const derived = _deriveFinalStats(st);
    const finalRecord = {
      id: _safeId(id),
      domain: domain || "unknown",
      title: st.title || "",
      status: st.status || "completed",
      startedAt: st.startedAt || null,
      finishedAt: st.finishedAt || _iso(),
      exportedAt: st.exportedAt || null,
      stepsTotal: derived.stepsTotal,
      stepsCompleted: derived.stepsCompleted,
      stepCompletionRate: derived.stepCompletionRate,
      elapsedSec: derived.elapsedSec,
      pauseCount: derived.pauseCount,
      guardBlocks: derived.guardBlocks,
      skippedSteps: _safeArr(st.skippedSteps),
      adjustments: _safeArr(st.adjustments),
      createdAt: st.createdAt || _iso(),
      updatedAt: _iso(),
    };

    // Persist
    if (ctx.db && await _dexieUpsert(ctx.db, id, finalRecord)) {
      mem.set(id, finalRecord);
      return finalRecord;
    }
    _lsUpsert(id, finalRecord);
    mem.set(id, finalRecord);
    return finalRecord;
  }

  // ----------------------------- public API ---------------------------------
  return {
    /** Initialize and attach listeners (idempotent). */
    init,

    /** Manually record a step skip or adjustment (UI helpers can call these). */
    async noteSkippedStep(sessionId, stepId) {
      if (!sessionId) return;
      const st = mem.get(sessionId) || { id: sessionId, skippedSteps: [], adjustments: [] };
      const set = new Set(_safeArr(st.skippedSteps));
      if (stepId) set.add(String(stepId));
      st.skippedSteps = Array.from(set);
      st.updatedAt = _iso();
      mem.set(sessionId, st);
      await _persistWorkingSet(sessionId);
    },

    async noteAdjustment(sessionId, msg, meta) {
      if (!sessionId) return;
      const st = mem.get(sessionId) || { id: sessionId, skippedSteps: [], adjustments: [] };
      st.adjustments = _safeArr(st.adjustments).concat([{ at: _iso(), msg: String(msg || ""), meta: meta || {} }]);
      st.updatedAt = _iso();
      mem.set(sessionId, st);
      await _persistWorkingSet(sessionId);
    },

    /** Read analytics for a specific session id. */
    async read(sessionId) {
      if (!sessionId) return null;
      if (mem.has(sessionId)) return mem.get(sessionId);
      if (ctx.db) {
        const row = await _dexieRead(ctx.db, sessionId);
        if (row) return row;
      }
      return _lsRead(sessionId);
    },

    /** List recent analytics rows (optionally by domain). */
    async list({ limit = 50, domain } = {}) {
      if (ctx.db) {
        const rows = await _dexieList(ctx.db, limit, domain);
        if (rows?.length) return rows;
      }
      return _lsList(limit, domain);
    },

    /** Prune old analytics rows. Default 90 days. */
    async prune(days = 90) {
      let ok = false;
      if (ctx.db) ok = await _dexiePrune(ctx.db, days);
      _lsPrune(days);
      return ok;
    },

    /** Force export of a particular session analytics record (if enabled). */
    async exportNow(sessionId) {
      const rec = await this.read(sessionId);
      if (!rec) return false;
      await _exportToHubIfEnabled(ctx, rec);
      return true;
    },

    /** For tests/dev: inject a fake eventBus or db. */
    __inject({ eventBus, db, featureFlags, HubPacketFormatter, FamilyFundConnector } = {}) {
      if (eventBus) ctx.eventBus = eventBus;
      if (db) ctx.db = db;
      if (featureFlags) ctx.featureFlags = featureFlags;
      if (HubPacketFormatter) ctx.HubPacketFormatter = HubPacketFormatter;
      if (FamilyFundConnector) ctx.FamilyFundConnector = FamilyFundConnector;
      if (!ctx.attached) { _attachListeners(); ctx.attached = true; }
      return this;
    },
  };
})();

// Initialize eagerly (safe to call; no-ops if deps missing).
// You can also import and call SessionAnalytics.init() in your app bootstrap.
SessionAnalytics.init().catch(_noop);

export default SessionAnalytics;
