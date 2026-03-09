/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\services\knowledgeHelper\SkillProgressTracker.js
/**
 * SSA • Knowledge Helper • SkillProgressTracker
 * -----------------------------------------------------------------------------
 * Production-ready skill progress tracking with Dexie persistence (when available),
 * and a safe in-memory fallback (when Dexie tables aren't present yet).
 *
 * What this does:
 *  - Records practice events ("attempts") against a skill (or any learnable item)
 *  - Computes streaks, time-spent, mastery score (0..1), confidence, and history
 *  - Supports session ingestion (e.g., SessionRunner sessions) to auto-log practice
 *  - Provides UI-friendly summaries, dashboards, and “next step” suggestions
 *
 * Browser-safe:
 *  - No Node imports.
 *  - Dexie is accessed via your local db.js (dynamic import or injection).
 *
 * Integration pattern:
 *  - Prefer dependency injection:
 *      const tracker = new SkillProgressTracker({ db, eventBus });
 *  - Or use the factory which attempts to load db automatically:
 *      const tracker = await createSkillProgressTracker();
 *
 * Tables (recommended):
 *  - skillProfiles (optional): id, title, domain, tags, difficulty, prereqIds...
 *  - skillAttempts (required for persistence): id, skillId, startedAt, endedAt,
 *        durationMs, status, quality, notes, context, source, createdAt, updatedAt
 *  - skillStats (optional cache): skillId, mastery, streak, lastPracticedAt,
 *        minutesTotal, attemptsTotal, successRate, confidence, updatedAt
 *
 * If tables do not exist, the tracker will still work in-memory and return
 * deterministic results for the current session.
 */

/* -----------------------------------------------------------------------------
 * Defaults
 * -------------------------------------------------------------------------- */

const DEFAULTS = Object.freeze({
  // Persistence + events
  emitEvents: true,
  eventNamespace: "knowledge.skills",
  // If you don’t have eventBus, tracker still works.
  // event types (if emitEvents enabled):
  //  - knowledge.skills.attempt.started
  //  - knowledge.skills.attempt.completed
  //  - knowledge.skills.practice.logged
  //  - knowledge.skills.stats.updated

  // Scoring model
  // Mastery is computed from successes, quality, time spent, and recency decay.
  mastery: {
    // base weights
    successWeight: 0.55,
    qualityWeight: 0.25,
    durationWeight: 0.2,
    // decay: mastery contribution halves every `halfLifeDays` without practice
    halfLifeDays: 21,
    // clamp durations so a single marathon doesn’t dominate
    durationCapMinutes: 90,
    // minimal minutes that count as meaningful
    minMeaningfulMinutes: 4,
    // minimum attempts before confidence can rise
    confidenceWarmupAttempts: 3,
  },

  // Streak rules
  streak: {
    // practice counted as “day practiced” if >= minMeaningfulMinutes
    minMeaningfulMinutes: 4,
    // streak breaks if gap > breakAfterDays
    breakAfterDays: 2,
  },

  // Query / dashboard
  historyLimit: 50,
  topSkillsLimit: 30,

  // Safety/perf
  maxNotesChars: 2000,
  maxContextChars: 5000,

  // Fallback memory store max (in-memory)
  memoryMaxAttempts: 2000,
});

/* -----------------------------------------------------------------------------
 * Small utilities
 * -------------------------------------------------------------------------- */

function nowMs() {
  return Date.now();
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function safeNum(v, d = 0) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : d;
}

function toStr(v) {
  return v == null ? "" : String(v);
}

function clampString(s, maxChars) {
  const str = toStr(s);
  if (!maxChars || maxChars <= 0) return str;
  return str.length <= maxChars ? str : str.slice(0, maxChars);
}

function dayKeyFromMs(ms) {
  const d = new Date(ms);
  // UTC day key (stable across TZ changes)
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${da}`;
}

function daysBetweenUTC(aMs, bMs) {
  const a = new Date(aMs);
  const b = new Date(bMs);
  const aUTC = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const bUTC = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  return Math.round((bUTC - aUTC) / (24 * 60 * 60 * 1000));
}

function stableId(prefix = "id") {
  // good enough for client-side ids; caller can replace with crypto if desired
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function toMinutes(ms) {
  return ms / (60 * 1000);
}

function expDecay(ageDays, halfLifeDays) {
  // contribution multiplier ∈ (0,1]
  // halfLifeDays => multiplier halves
  const hl = Math.max(1, halfLifeDays);
  return Math.pow(0.5, ageDays / hl);
}

function mean(arr) {
  if (!arr || !arr.length) return 0;
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s / arr.length;
}

function uniq(arr) {
  const set = new Set();
  const out = [];
  for (let i = 0; i < (arr || []).length; i++) {
    const v = arr[i];
    if (!set.has(v)) {
      set.add(v);
      out.push(v);
    }
  }
  return out;
}

/* -----------------------------------------------------------------------------
 * Safe event emitter wrapper
 * -------------------------------------------------------------------------- */

function makeEmitter(eventBus, cfg) {
  const canEmit =
    !!eventBus &&
    (typeof eventBus.emit === "function" ||
      typeof eventBus.publish === "function" ||
      typeof eventBus.dispatch === "function");

  const emitFn =
    (eventBus && eventBus.emit) ||
    (eventBus && eventBus.publish) ||
    (eventBus && eventBus.dispatch) ||
    null;

  return {
    emit(type, payload) {
      if (!cfg.emitEvents) return;
      if (!canEmit || !emitFn) return;
      try {
        emitFn.call(eventBus, type, payload);
      } catch (e) {
        // never crash the app
        console.warn("[SkillProgressTracker] event emit failed:", e);
      }
    },
  };
}

/* -----------------------------------------------------------------------------
 * Memory fallback store
 * -------------------------------------------------------------------------- */

class MemoryStore {
  constructor(cfg) {
    this.cfg = cfg;
    this.attempts = []; // array of attempt records
    this.bySkill = new Map(); // skillId -> array indices
    this.stats = new Map(); // skillId -> cached stats
    this.skillProfiles = new Map(); // skillId -> profile
  }

  upsertProfile(profile) {
    if (!profile || !profile.id) return;
    this.skillProfiles.set(String(profile.id), { ...profile });
  }

  async putAttempt(rec) {
    const skillId = String(rec.skillId);
    const id = String(rec.id);
    // update if exists
    for (let i = 0; i < this.attempts.length; i++) {
      if (this.attempts[i].id === id) {
        this.attempts[i] = { ...this.attempts[i], ...rec };
        return id;
      }
    }
    // insert new
    const idx = this.attempts.length;
    this.attempts.push({ ...rec });
    if (!this.bySkill.has(skillId)) this.bySkill.set(skillId, []);
    this.bySkill.get(skillId).push(idx);

    // cap memory
    const cap = this.cfg.memoryMaxAttempts || DEFAULTS.memoryMaxAttempts;
    if (this.attempts.length > cap) {
      // drop oldest 5%
      const drop = Math.max(1, Math.floor(cap * 0.05));
      const removed = this.attempts.splice(0, drop);
      // rebuild indices (cheap for cap sizes)
      this.bySkill.clear();
      for (let i = 0; i < this.attempts.length; i++) {
        const sId = String(this.attempts[i].skillId);
        if (!this.bySkill.has(sId)) this.bySkill.set(sId, []);
        this.bySkill.get(sId).push(i);
      }
      // also clear stats cache (safe)
      for (let i = 0; i < removed.length; i++)
        this.stats.delete(String(removed[i].skillId));
    }

    return id;
  }

  async getAttempt(id) {
    const sid = String(id);
    for (let i = 0; i < this.attempts.length; i++) {
      if (this.attempts[i].id === sid) return { ...this.attempts[i] };
    }
    return null;
  }

  async listAttemptsBySkill(skillId, limit = 100) {
    const sid = String(skillId);
    const idxs = this.bySkill.get(sid) || [];
    const out = [];
    for (let k = idxs.length - 1; k >= 0 && out.length < limit; k--) {
      out.push({ ...this.attempts[idxs[k]] });
    }
    // newest-first
    out.sort(
      (a, b) =>
        safeNum(b.startedAt || b.createdAt) -
        safeNum(a.startedAt || a.createdAt)
    );
    return out;
  }

  async setStats(skillId, stats) {
    this.stats.set(String(skillId), { ...stats });
  }

  async getStats(skillId) {
    return this.stats.get(String(skillId))
      ? { ...this.stats.get(String(skillId)) }
      : null;
  }

  async listAllStats() {
    const out = [];
    this.stats.forEach((v) => out.push({ ...v }));
    return out;
  }

  async listProfiles() {
    const out = [];
    this.skillProfiles.forEach((v) => out.push({ ...v }));
    return out;
  }
}

/* -----------------------------------------------------------------------------
 * Dexie adapter (optional)
 * -------------------------------------------------------------------------- */

function safeDexieTable(db, tableName) {
  try {
    if (!db) return null;
    if (typeof db.table !== "function") return null;
    const t = db.table(tableName);
    // Dexie table has toCollection, where, put, get, etc.
    if (!t || typeof t.put !== "function") return null;
    return t;
  } catch {
    return null;
  }
}

/**
 * Minimal Dexie interface used:
 *  - attemptsTable.put(record)
 *  - attemptsTable.get(id)
 *  - attemptsTable.where("skillId").equals(skillId).reverse().sortBy("startedAt") ...
 * Dexie query chains vary; we use safe fallbacks.
 */
class DexieStore {
  constructor(db, cfg) {
    this.db = db;
    this.cfg = cfg;
    this.attemptsTable = safeDexieTable(db, "skillAttempts");
    this.statsTable = safeDexieTable(db, "skillStats");
    this.profilesTable = safeDexieTable(db, "skillProfiles");
  }

  get ok() {
    return !!this.attemptsTable;
  }

  async upsertProfile(profile) {
    if (!this.profilesTable || !profile || !profile.id) return;
    const rec = {
      ...profile,
      id: String(profile.id),
      updatedAt: profile.updatedAt || nowMs(),
      createdAt: profile.createdAt || profile.updatedAt || nowMs(),
    };
    try {
      await this.profilesTable.put(rec);
    } catch (e) {
      console.warn("[SkillProgressTracker] profilesTable.put failed:", e);
    }
  }

  async putAttempt(rec) {
    if (!this.attemptsTable) return null;
    try {
      await this.attemptsTable.put(rec);
      return rec.id;
    } catch (e) {
      console.warn("[SkillProgressTracker] attemptsTable.put failed:", e);
      return null;
    }
  }

  async getAttempt(id) {
    if (!this.attemptsTable) return null;
    try {
      const r = await this.attemptsTable.get(String(id));
      return r ? { ...r } : null;
    } catch (e) {
      console.warn("[SkillProgressTracker] attemptsTable.get failed:", e);
      return null;
    }
  }

  async listAttemptsBySkill(skillId, limit = 100) {
    if (!this.attemptsTable) return [];
    const sid = String(skillId);
    try {
      // Prefer indexed query if available
      if (typeof this.attemptsTable.where === "function") {
        const coll = this.attemptsTable.where("skillId").equals(sid);
        // Try reverse+sortBy; fallback to toArray then sort
        if (coll && typeof coll.toArray === "function") {
          const arr = await coll.toArray();
          arr.sort(
            (a, b) =>
              safeNum(b.startedAt || b.createdAt) -
              safeNum(a.startedAt || a.createdAt)
          );
          return arr.slice(0, limit).map((x) => ({ ...x }));
        }
      }
    } catch (e) {
      console.warn(
        "[SkillProgressTracker] listAttemptsBySkill(where) failed:",
        e
      );
    }
    try {
      // Last-resort: full scan (not ideal, but safe)
      const arr = await this.attemptsTable.toArray();
      const filtered = arr
        .filter((x) => String(x.skillId) === sid)
        .sort(
          (a, b) =>
            safeNum(b.startedAt || b.createdAt) -
            safeNum(a.startedAt || a.createdAt)
        )
        .slice(0, limit);
      return filtered.map((x) => ({ ...x }));
    } catch (e) {
      console.warn(
        "[SkillProgressTracker] listAttemptsBySkill(scan) failed:",
        e
      );
      return [];
    }
  }

  async setStats(skillId, stats) {
    if (!this.statsTable) return;
    try {
      await this.statsTable.put({ ...stats, skillId: String(skillId) });
    } catch (e) {
      console.warn("[SkillProgressTracker] statsTable.put failed:", e);
    }
  }

  async getStats(skillId) {
    if (!this.statsTable) return null;
    try {
      const r = await this.statsTable.get(String(skillId));
      return r ? { ...r } : null;
    } catch (e) {
      console.warn("[SkillProgressTracker] statsTable.get failed:", e);
      return null;
    }
  }

  async listAllStats() {
    if (!this.statsTable) return [];
    try {
      const arr = await this.statsTable.toArray();
      return arr.map((x) => ({ ...x }));
    } catch (e) {
      console.warn("[SkillProgressTracker] statsTable.toArray failed:", e);
      return [];
    }
  }

  async listProfiles() {
    if (!this.profilesTable) return [];
    try {
      const arr = await this.profilesTable.toArray();
      return arr.map((x) => ({ ...x }));
    } catch (e) {
      console.warn("[SkillProgressTracker] profilesTable.toArray failed:", e);
      return [];
    }
  }
}

/* -----------------------------------------------------------------------------
 * Scoring + aggregation
 * -------------------------------------------------------------------------- */

function computeAttemptFeatures(attempt, cfg) {
  const startedAt = safeNum(attempt.startedAt || attempt.createdAt || nowMs());
  const endedAt = safeNum(attempt.endedAt || attempt.updatedAt || startedAt);
  const durationMs = safeNum(
    attempt.durationMs,
    Math.max(0, endedAt - startedAt)
  );

  const status = attempt.status || "unknown"; // success|fail|partial|unknown
  const isSuccess = status === "success";
  const isFail = status === "fail";
  const isPartial = status === "partial";

  // quality 0..1
  const quality = clamp(
    safeNum(
      attempt.quality,
      isSuccess ? 0.75 : isPartial ? 0.45 : isFail ? 0.2 : 0.35
    ),
    0,
    1
  );

  // duration factor 0..1 based on meaningful minutes and cap
  const minutes = clamp(
    toMinutes(durationMs),
    0,
    cfg.mastery.durationCapMinutes
  );
  const durFactor =
    minutes <= 0 ? 0 : clamp(minutes / cfg.mastery.durationCapMinutes, 0, 1);

  // success factor 0..1
  const successFactor = isSuccess ? 1 : isPartial ? 0.6 : isFail ? 0 : 0.35;

  return {
    startedAt,
    endedAt,
    durationMs,
    minutes,
    dayKey: dayKeyFromMs(startedAt),
    status,
    successFactor,
    quality,
    durFactor,
  };
}

function computeStatsFromAttempts(skillId, attempts, cfg) {
  const sid = String(skillId);
  const list = (attempts || [])
    .slice()
    .sort(
      (a, b) =>
        safeNum(a.startedAt || a.createdAt) -
        safeNum(b.startedAt || b.createdAt)
    );
  const n = list.length;

  if (!n) {
    return {
      skillId: sid,
      mastery: 0,
      confidence: 0,
      streakDays: 0,
      lastPracticedAt: null,
      minutesTotal: 0,
      attemptsTotal: 0,
      successRate: 0,
      qualityAvg: 0,
      updatedAt: nowMs(),
    };
  }

  const feats = list.map((a) => computeAttemptFeatures(a, cfg));

  const last = feats[feats.length - 1];
  const lastPracticedAt = last.startedAt;

  // totals
  const minutesTotal = feats.reduce((acc, f) => acc + f.minutes, 0);
  const successes = feats.filter((f) => f.status === "success").length;
  const successRate = n ? successes / n : 0;
  const qualityAvg = mean(feats.map((f) => f.quality));

  // streak: count consecutive practiced days where each day has >= minMeaningfulMinutes total
  const byDay = new Map(); // dayKey -> minutes
  for (let i = 0; i < feats.length; i++) {
    const f = feats[i];
    byDay.set(f.dayKey, (byDay.get(f.dayKey) || 0) + f.minutes);
  }
  const practicedDays = Array.from(byDay.entries())
    .filter(([, mins]) => mins >= cfg.streak.minMeaningfulMinutes)
    .map(([k]) => k)
    .sort();

  let streakDays = 0;
  if (practicedDays.length) {
    // walk backwards from most recent day
    const lastDay = practicedDays[practicedDays.length - 1];
    let cur = new Date(`${lastDay}T00:00:00.000Z`).getTime();
    streakDays = 1;

    for (let i = practicedDays.length - 2; i >= 0; i--) {
      const day = practicedDays[i];
      const t = new Date(`${day}T00:00:00.000Z`).getTime();
      const gap = daysBetweenUTC(t, cur);
      // gap is positive if t < cur (older)
      if (gap <= cfg.streak.breakAfterDays && gap >= 1) {
        streakDays += 1;
        cur = t;
      } else if (gap === 0) {
        // same day duplicate
        cur = t;
      } else {
        break;
      }
    }
  }

  // Mastery: sum of decayed contributions (bounded 0..1 with logistic-ish curve)
  const now = nowMs();
  const contributions = [];
  for (let i = 0; i < feats.length; i++) {
    const f = feats[i];
    const ageDays = Math.max(0, (now - f.startedAt) / (24 * 60 * 60 * 1000));
    const decay = expDecay(ageDays, cfg.mastery.halfLifeDays);

    // combine factors
    const contrib =
      decay *
      (cfg.mastery.successWeight * f.successFactor +
        cfg.mastery.qualityWeight * f.quality +
        cfg.mastery.durationWeight * f.durFactor);

    contributions.push(contrib);
  }

  // map contributions to mastery 0..1 with diminishing returns
  // masteryRaw grows with totalContribution; squash with 1 - exp(-k*x)
  const totalContribution = contributions.reduce((a, b) => a + b, 0);
  const mastery = clamp(1 - Math.exp(-1.15 * totalContribution), 0, 1);

  // Confidence: based on attempts count + success rate, with warmup
  const warm = cfg.mastery.confidenceWarmupAttempts;
  const attemptFactor = clamp(n / Math.max(1, warm), 0, 1);
  const confidence = clamp(
    0.15 + 0.85 * attemptFactor * (0.35 + 0.65 * successRate),
    0,
    1
  );

  return {
    skillId: sid,
    mastery: Number(mastery.toFixed(4)),
    confidence: Number(confidence.toFixed(4)),
    streakDays,
    lastPracticedAt,
    minutesTotal: Number(minutesTotal.toFixed(2)),
    attemptsTotal: n,
    successRate: Number(successRate.toFixed(4)),
    qualityAvg: Number(qualityAvg.toFixed(4)),
    updatedAt: nowMs(),
  };
}

/* -----------------------------------------------------------------------------
 * SkillProgressTracker
 * -------------------------------------------------------------------------- */

export class SkillProgressTracker {
  /**
   * @param {object} deps
   * @param {object=} deps.db - Dexie instance (SSA db)
   * @param {object=} deps.eventBus - optional event bus
   * @param {object=} deps.options - config overrides
   */
  constructor({ db = null, eventBus = null, options = {} } = {}) {
    this.cfg = {
      ...DEFAULTS,
      ...options,
      mastery: { ...DEFAULTS.mastery, ...(options.mastery || {}) },
      streak: { ...DEFAULTS.streak, ...(options.streak || {}) },
    };

    this._emitter = makeEmitter(eventBus, this.cfg);

    this._db = db || null;
    this._dexieStore = db ? new DexieStore(db, this.cfg) : null;
    this._memStore = new MemoryStore(this.cfg);

    // Prefer Dexie if tables exist; else fallback memory
    this._store =
      this._dexieStore && this._dexieStore.ok
        ? this._dexieStore
        : this._memStore;

    // attempt session map: attemptId -> record (for quick completion updates)
    this._activeAttempts = new Map();
  }

  /**
   * If you construct without db, call init() to attempt dynamic import of db.
   */
  async init() {
    if (this._db) return this;

    // Try dynamic import of SSA db.js (relative path from this file)
    try {
      const mod = await import("../db.js");
      const db = mod?.db || mod?.default || mod;
      if (db) {
        this._db = db;
        this._dexieStore = new DexieStore(db, this.cfg);
        this._store = this._dexieStore.ok ? this._dexieStore : this._memStore;
      }
    } catch (e) {
      // keep memory mode
      console.warn(
        "[SkillProgressTracker] init() could not load db.js; using memory store.",
        e
      );
    }

    return this;
  }

  get mode() {
    return this._store instanceof DexieStore ? "dexie" : "memory";
  }

  /**
   * Upsert an optional skill profile (for better dashboards).
   */
  async upsertSkillProfile(profile) {
    if (!profile || !profile.id) return null;
    const rec = {
      ...profile,
      id: String(profile.id),
      title: profile.title || profile.name || profile.label || null,
      domain: profile.domain || null,
      tags: Array.isArray(profile.tags)
        ? profile.tags
        : profile.tags
        ? [String(profile.tags)]
        : [],
      difficulty: profile.difficulty ?? null,
      prereqIds: Array.isArray(profile.prereqIds)
        ? profile.prereqIds.map(String)
        : [],
      updatedAt: profile.updatedAt || nowMs(),
      createdAt: profile.createdAt || nowMs(),
    };

    if (this._store.upsertProfile) await this._store.upsertProfile(rec);
    else this._memStore.upsertProfile(rec);

    return rec.id;
  }

  /**
   * Start a practice attempt (returns attemptId).
   */
  async startAttempt({
    skillId,
    status = "in_progress",
    quality = null,
    notes = "",
    context = null,
    source = "SkillProgressTracker.startAttempt",
    startedAt = nowMs(),
  } = {}) {
    if (!skillId) throw new Error("startAttempt requires skillId");

    const id = stableId("attempt");
    const rec = {
      id,
      skillId: String(skillId),
      startedAt: safeNum(startedAt, nowMs()),
      endedAt: null,
      durationMs: 0,
      status,
      quality: quality == null ? null : clamp(safeNum(quality, 0), 0, 1),
      notes: clampString(notes, this.cfg.maxNotesChars),
      context: context
        ? clampString(JSON.stringify(context), this.cfg.maxContextChars)
        : null,
      source: String(source || ""),
      createdAt: nowMs(),
      updatedAt: nowMs(),
    };

    const savedId = await this._store.putAttempt(rec);
    const finalId = savedId || id;

    this._activeAttempts.set(finalId, rec);

    this._emitter.emit(`${this.cfg.eventNamespace}.attempt.started`, {
      attemptId: finalId,
      skillId: rec.skillId,
      startedAt: rec.startedAt,
      source: rec.source,
    });

    return finalId;
  }

  /**
   * Complete an attempt by attemptId.
   */
  async completeAttempt(
    attemptId,
    { status = "success", quality = null, notes = null, endedAt = nowMs() } = {}
  ) {
    const id = String(attemptId || "");
    if (!id) throw new Error("completeAttempt requires attemptId");

    let rec = this._activeAttempts.get(id);
    if (!rec) rec = await this._store.getAttempt(id);
    if (!rec) throw new Error(`Attempt not found: ${id}`);

    const end = safeNum(endedAt, nowMs());
    const start = safeNum(rec.startedAt, end);
    const durationMs = Math.max(0, end - start);

    const updated = {
      ...rec,
      endedAt: end,
      durationMs,
      status: String(status || rec.status || "success"),
      quality:
        quality == null
          ? rec.quality == null
            ? null
            : rec.quality
          : clamp(safeNum(quality, 0), 0, 1),
      notes:
        notes == null ? rec.notes : clampString(notes, this.cfg.maxNotesChars),
      updatedAt: nowMs(),
    };

    await this._store.putAttempt(updated);
    this._activeAttempts.delete(id);

    // Update stats cache (Dexie if present) and emit event
    const stats = await this.recomputeSkillStats(updated.skillId);

    this._emitter.emit(`${this.cfg.eventNamespace}.attempt.completed`, {
      attemptId: id,
      skillId: updated.skillId,
      status: updated.status,
      durationMs: updated.durationMs,
      endedAt: updated.endedAt,
      stats,
    });

    return { attemptId: id, record: updated, stats };
  }

  /**
   * Log a practice event without explicit start/complete (one-shot).
   */
  async logPractice({
    skillId,
    status = "success",
    quality = null,
    durationMs = 10 * 60 * 1000,
    notes = "",
    context = null,
    source = "SkillProgressTracker.logPractice",
    startedAt = nowMs(),
  } = {}) {
    if (!skillId) throw new Error("logPractice requires skillId");
    const id = stableId("attempt");
    const start = safeNum(startedAt, nowMs());
    const dur = Math.max(0, safeNum(durationMs, 0));
    const end = start + dur;

    const rec = {
      id,
      skillId: String(skillId),
      startedAt: start,
      endedAt: end,
      durationMs: dur,
      status: String(status || "success"),
      quality: quality == null ? null : clamp(safeNum(quality, 0), 0, 1),
      notes: clampString(notes, this.cfg.maxNotesChars),
      context: context
        ? clampString(JSON.stringify(context), this.cfg.maxContextChars)
        : null,
      source: String(source || ""),
      createdAt: nowMs(),
      updatedAt: nowMs(),
    };

    await this._store.putAttempt(rec);
    const stats = await this.recomputeSkillStats(rec.skillId);

    this._emitter.emit(`${this.cfg.eventNamespace}.practice.logged`, {
      attemptId: id,
      skillId: rec.skillId,
      status: rec.status,
      durationMs: rec.durationMs,
      startedAt: rec.startedAt,
      stats,
    });

    return { attemptId: id, record: rec, stats };
  }

  /**
   * Ingest an SSA SessionRunner-like session record to auto-log practice.
   * This is intentionally permissive; it tries to extract duration + outcome.
   *
   * Supported session-ish shapes (examples):
   *  - { id, domain, startedAt, endedAt, durationMs, status, title, tags, steps, notes }
   *  - { sessionId, startedISO, endedISO, events:[...] }
   *
   * @returns {object} { logged: number, attempts: Array<{skillId, attemptId}> }
   */
  async ingestSession(
    session,
    { mapToSkillId = null, source = "SkillProgressTracker.ingestSession" } = {}
  ) {
    if (!session) return { logged: 0, attempts: [] };

    const startedAt =
      safeNum(session.startedAt) ||
      (session.startedISO ? Date.parse(session.startedISO) : 0) ||
      nowMs();

    const endedAt =
      safeNum(session.endedAt) ||
      (session.endedISO ? Date.parse(session.endedISO) : 0) ||
      (session.durationMs ? startedAt + safeNum(session.durationMs) : 0) ||
      nowMs();

    const durationMs = Math.max(
      0,
      safeNum(session.durationMs, endedAt - startedAt)
    );

    const statusRaw = toStr(
      session.status || session.outcome || session.result || ""
    );
    const status = statusRaw ? statusRaw : "success";

    // Determine skillId(s)
    const skillIds = [];
    if (typeof mapToSkillId === "function") {
      const mapped = mapToSkillId(session);
      asArray(mapped).forEach((x) => x && skillIds.push(String(x)));
    } else if (session.skillId) {
      skillIds.push(String(session.skillId));
    } else if (session.skillIds) {
      asArray(session.skillIds).forEach((x) => x && skillIds.push(String(x)));
    } else if (session.title) {
      // fallback: use a stable “skill” id based on title + domain
      const base = `${toStr(session.domain || "")}:${toStr(
        session.title
      )}`.trim();
      skillIds.push(`auto_${stableHash32(base)}`);
    } else if (session.domain) {
      skillIds.push(`domain_${String(session.domain)}`);
    }

    const attempts = [];
    for (let i = 0; i < skillIds.length; i++) {
      const skillId = skillIds[i];
      const notes = session.notes || session.summary || "";
      const context = {
        sessionId: session.id || session.sessionId || null,
        domain: session.domain || null,
        title: session.title || null,
        tags: session.tags || null,
        route: session.route || null,
      };
      const res = await this.logPractice({
        skillId,
        status,
        quality: session.quality ?? null,
        durationMs,
        notes,
        context,
        source,
        startedAt,
      });
      attempts.push({ skillId, attemptId: res.attemptId });
    }

    return { logged: attempts.length, attempts };
  }

  /**
   * Get attempts for a skill (newest-first).
   */
  async getAttemptHistory(skillId, { limit = DEFAULTS.historyLimit } = {}) {
    if (!skillId) return [];
    const arr = await this._store.listAttemptsBySkill(
      String(skillId),
      Math.max(1, limit | 0)
    );
    return arr.map((a) => ({
      ...a,
      // ensure consistent numeric values for UI
      startedAt: safeNum(a.startedAt || a.createdAt || 0),
      endedAt: a.endedAt == null ? null : safeNum(a.endedAt),
      durationMs: safeNum(a.durationMs, 0),
      quality: a.quality == null ? null : clamp(safeNum(a.quality, 0), 0, 1),
    }));
  }

  /**
   * Recompute and persist stats for a skillId.
   */
  async recomputeSkillStats(skillId) {
    const sid = String(skillId);
    const attempts = await this._store.listAttemptsBySkill(sid, 500); // safe cap
    const stats = computeStatsFromAttempts(sid, attempts, this.cfg);

    // Persist cached stats if table exists
    if (this._store.setStats) await this._store.setStats(sid, stats);
    else await this._memStore.setStats(sid, stats);

    this._emitter.emit(`${this.cfg.eventNamespace}.stats.updated`, {
      skillId: sid,
      stats,
    });
    return stats;
  }

  /**
   * Get cached stats for a skillId; if missing, compute.
   */
  async getSkillStats(skillId) {
    const sid = String(skillId);
    const cached = await this._store.getStats(sid);
    if (cached) return cached;
    return this.recomputeSkillStats(sid);
  }

  /**
   * UI-friendly summary: profile + stats + recent attempts.
   */
  async getSkillSummary(
    skillId,
    { includeHistory = true, historyLimit = 10 } = {}
  ) {
    const sid = String(skillId);
    const stats = await this.getSkillStats(sid);

    let profile = null;
    try {
      // profiles may not exist; handle gracefully
      const profiles = await this._store.listProfiles?.();
      if (profiles && profiles.length) {
        profile = profiles.find((p) => String(p.id) === sid) || null;
      }
    } catch {
      profile = null;
    }

    const history = includeHistory
      ? await this.getAttemptHistory(sid, { limit: historyLimit })
      : [];

    return {
      skillId: sid,
      profile,
      stats,
      history,
      // simple “next practice” hint
      suggestedNext: this._suggestNextFromStats(stats, profile),
    };
  }

  /**
   * Dashboard: list all known skills (from stats cache; optionally include profiles).
   */
  async getDashboard({
    limit = DEFAULTS.topSkillsLimit,
    sortBy = "lastPracticedAt",
  } = {}) {
    const statsArr = await this._store.listAllStats();
    const profilesArr = (await this._store.listProfiles?.()) || [];

    const profileById = new Map();
    for (let i = 0; i < profilesArr.length; i++)
      profileById.set(String(profilesArr[i].id), profilesArr[i]);

    const rows = statsArr.map((s) => {
      const profile = profileById.get(String(s.skillId)) || null;
      return {
        skillId: String(s.skillId),
        title: profile?.title || null,
        domain: profile?.domain || null,
        tags: Array.isArray(profile?.tags) ? profile.tags : [],
        mastery: safeNum(s.mastery, 0),
        confidence: safeNum(s.confidence, 0),
        streakDays: safeNum(s.streakDays, 0),
        lastPracticedAt: s.lastPracticedAt || null,
        minutesTotal: safeNum(s.minutesTotal, 0),
        attemptsTotal: safeNum(s.attemptsTotal, 0),
        successRate: safeNum(s.successRate, 0),
        qualityAvg: safeNum(s.qualityAvg, 0),
        updatedAt: s.updatedAt || null,
      };
    });

    const sorter = (a, b) => {
      if (sortBy === "mastery") return b.mastery - a.mastery;
      if (sortBy === "confidence") return b.confidence - a.confidence;
      if (sortBy === "streakDays") return b.streakDays - a.streakDays;
      if (sortBy === "minutesTotal") return b.minutesTotal - a.minutesTotal;
      if (sortBy === "attemptsTotal") return b.attemptsTotal - a.attemptsTotal;
      // default: lastPracticedAt desc
      return safeNum(b.lastPracticedAt, 0) - safeNum(a.lastPracticedAt, 0);
    };

    rows.sort(sorter);
    return rows.slice(0, Math.max(1, limit | 0));
  }

  /**
   * Recommendations: which skills to practice next.
   * Strategy:
   *  - prioritize low mastery but non-zero confidence (you’ve started it)
   *  - also include “stale” skills (haven’t practiced recently)
   */
  async recommendNextSkills({ limit = 8, domain = null, tag = null } = {}) {
    const rows = await this.getDashboard({
      limit: 500,
      sortBy: "lastPracticedAt",
    });

    const filtered = rows.filter((r) => {
      if (domain && r.domain && String(r.domain) !== String(domain))
        return false;
      if (
        tag &&
        Array.isArray(r.tags) &&
        r.tags.length &&
        !r.tags.includes(String(tag))
      )
        return false;
      return true;
    });

    // score each candidate
    const now = nowMs();
    const scored = filtered.map((r) => {
      const ageDays = r.lastPracticedAt
        ? Math.max(
            0,
            (now - safeNum(r.lastPracticedAt, now)) / (24 * 60 * 60 * 1000)
          )
        : 999;
      const staleFactor = clamp(ageDays / 30, 0, 1); // 0..1 over 30 days
      const lowMastery = 1 - clamp(r.mastery, 0, 1);
      const startedFactor = clamp(r.confidence, 0, 1);

      // prefer skills you’ve begun (confidence) but haven’t mastered (low mastery),
      // plus a boost if stale
      const score =
        0.55 * lowMastery * (0.35 + 0.65 * startedFactor) +
        0.3 * staleFactor +
        0.15 * (1 - clamp(r.successRate, 0, 1));

      return {
        ...r,
        recommendScore: Number(score.toFixed(4)),
        ageDays: Number(ageDays.toFixed(1)),
      };
    });

    scored.sort((a, b) => b.recommendScore - a.recommendScore);
    return scored.slice(0, Math.max(1, limit | 0)).map((r) => ({
      skillId: r.skillId,
      title: r.title,
      domain: r.domain,
      tags: r.tags,
      recommendScore: r.recommendScore,
      mastery: r.mastery,
      confidence: r.confidence,
      streakDays: r.streakDays,
      lastPracticedAt: r.lastPracticedAt,
      ageDays: r.ageDays,
      suggestedNext: this._suggestNextFromStats(r, { title: r.title }),
    }));
  }

  _suggestNextFromStats(stats, profile) {
    const mastery = safeNum(stats.mastery, 0);
    const streak = safeNum(stats.streakDays, 0);
    const attempts = safeNum(stats.attemptsTotal, 0);

    const title = profile?.title || "this skill";

    if (attempts === 0) {
      return {
        label: `Start a short 10–15 minute practice session for ${title}.`,
        kind: "start",
      };
    }
    if (mastery < 0.35) {
      return {
        label: `Repeat a focused drill (10–20 min) and aim for one clean success.`,
        kind: "practice",
      };
    }
    if (mastery < 0.7) {
      return {
        label: `Increase difficulty slightly and practice 20–30 minutes.`,
        kind: "progress",
      };
    }
    if (streak < 3) {
      return {
        label: `Build consistency: practice 3 days in a row (even 5–10 min).`,
        kind: "streak",
      };
    }
    return {
      label: `Maintain: quick refresher once a week to prevent decay.`,
      kind: "maintain",
    };
  }
}

/* -----------------------------------------------------------------------------
 * Factory helpers
 * -------------------------------------------------------------------------- */

/**
 * Create tracker, attempting to auto-load db.js if not provided.
 */
export async function createSkillProgressTracker({
  db = null,
  eventBus = null,
  options = {},
} = {}) {
  const t = new SkillProgressTracker({ db, eventBus, options });
  await t.init();
  return t;
}

export default SkillProgressTracker;
