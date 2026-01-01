// src/managers/TimerManager.js

import Dexie from "dexie";
import Timer from "../models/Timer";

/**
 * TimerManager
 * -----------------------------------------------------------------------------
 * Backward compatible methods:
 *  - createTimer(timerData)
 *  - getTimer(id)
 *  - getAllTimers({ category?, status? })
 *  - updateTimer(timer)
 *  - deleteTimer(id)
 *  - clearAll()
 *  - resumeRunningTimers()
 *
 * Additions (optional to use):
 *  - start(id)
 *  - pause(id)
 *  - resume(id)
 *  - complete(id, { reason? })
 *  - cancel(id, { reason? })
 *  - snooze(id, ms = 5*60*1000)
 *  - extend(id, ms)
 *  - restart(id)
 *  - getActive()
 *  - getDueSoon(ms = 5*60*1000)
 *  - getOverdue()
 *  - timersByDue({ limit? })
 *  - exportAll()
 *  - importMany(payload, { merge = true } = {})
 */

const NOW = () => Date.now();
const iso = (t) => new Date(t ?? Date.now()).toISOString();
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const hasWindow = () => typeof window !== "undefined";

function emitUpdated(topic = "TIMERS:UPDATED", payload = {}) {
  try {
    const s = hasWindow() ? window.__SUKA_SOCKET__ : null;
    if (s?.connected) s.emit(topic, { at: iso(), ...payload });
  } catch {
    /* noop */
  }
}

function toScore(status, msRemaining) {
  // higher score = more urgent
  if (status === "running") {
    if (msRemaining <= 0) return 95;           // overdue
    if (msRemaining <= 60_000) return 80;      // <= 1 min
    if (msRemaining <= 5 * 60_000) return 60;  // <= 5 min
    return 35;
  }
  if (status === "paused") return 20;
  if (status === "scheduled") return 25;
  return 10; // completed/cancelled
}

/* -----------------------------------------------------------------------------
 * Dexie DB (v1 -> v2)
 * -------------------------------------------------------------------------- */

class TimerDB extends Dexie {
  constructor() {
    super("SukaSmartAssistantDB");
    // v1 (original)
    this.version(1).stores({
      timers: "id, label, status, category, createdAt",
    });

    // v2 (richer fields + optional audit)
    this.version(2)
      .stores({
        timers:
          "id, label, status, category, createdAt, startTime, endTime, durationMs, pausedAt, lastUpdatedAt, tags",
        timerEvents: "++id, timerId, atISO, action",
      })
      .upgrade(async (tx) => {
        const tbl = tx.table("timers");
        const list = await tbl.toArray();
        await Promise.all(
          list.map((t) =>
            tbl.put({
              ...t,
              lastUpdatedAt: t.lastUpdatedAt || new Date(),
              durationMs:
                typeof t.durationMs === "number"
                  ? t.durationMs
                  : (t.endTime && t.startTime ? Math.max(0, t.endTime - t.startTime) : t.durationMs || 0),
              tags: Array.isArray(t.tags) ? t.tags : [],
            })
          )
        );
      });
  }
}

class TimerManager {
  constructor() {
    this.db = new TimerDB();
  }

  // --------------------------- helpers -----------------------------

  /** Compute remaining ms from persisted fields (tick-less). */
  static computeRemaining(json, now = NOW()) {
    const { status, startTime, endTime, pausedAt, durationMs } = json || {};
    if (status === "completed" || status === "cancelled") return 0;

    // If paused, freeze remaining at pause time
    if (status === "paused" && typeof pausedAt === "number") {
      const started = typeof startTime === "number";
      const dur = typeof durationMs === "number" ? durationMs : Math.max(0, (endTime || 0) - (startTime || now));
      const elapsed = started ? Math.max(0, pausedAt - startTime) : 0;
      return clamp(dur - elapsed, 0, dur);
    }

    // Running or scheduled → derive from endTime
    if (typeof endTime === "number") {
      return Math.max(0, endTime - now);
    }

    // If only duration exists, assume not started
    if (typeof durationMs === "number") return durationMs;
    return 0;
  }

  static enrichForUX(json) {
    const now = NOW();
    const remaining = TimerManager.computeRemaining(json, now);
    const dueISO = json.endTime ? iso(json.endTime) : null;
    const priorityScore = toScore(json.status, remaining);
    const icon =
      json.icon ||
      (json.category === "cooking"
        ? "🍳"
        : json.category === "cleaning"
        ? "🧼"
        : json.category === "garden"
        ? "🌿"
        : json.category === "animal"
        ? "🐄"
        : "⏱️");

    const speak =
      json.speak ||
      (json.status === "running"
        ? `${json.label || "Timer"} ends in ${Math.ceil(remaining / 60000)} minutes.`
        : `${json.label || "Timer"} is ${json.status}.`);

    const deepLink =
      json.deepLink ||
      { panel: "Timers", tab: "All", id: json.id };

    return {
      ...json,
      remainingMs: remaining,
      dueISO,
      priorityScore,
      icon,
      speak,
      deepLink,
    };
  }

  async audit(timerId, action, payload = {}) {
    try {
      if (this.db.timerEvents) {
        await this.db.timerEvents.add({ timerId, atISO: iso(), action, payload });
      }
    } catch {
      /* noop */
    }
  }

  // ------------------------ core (compat) --------------------------

  /** Create and save a new timer */
  async createTimer(timerData) {
    const timer = timerData instanceof Timer ? timerData : new Timer(timerData);

    // Normalize: if duration provided without start, treat as scheduled until started
    if (timer.durationMs && !timer.startTime && !timer.endTime) {
      timer.status = timer.status || "scheduled";
    }
    await this.db.timers.add(timer.toJSON());
    await this.audit(timer.id, "create", { timer: timer.toJSON() });
    emitUpdated();
    return timer;
  }

  /** Get a timer by ID */
  async getTimer(id) {
    const json = await this.db.timers.get(id);
    return json ? Timer.fromJSON(TimerManager.enrichForUX(json)) : null;
  }

  /** Get all timers (optionally filter by category or status) */
  async getAllTimers({ category = null, status = null } = {}) {
    let collection = this.db.timers.toCollection();
    if (category) collection = this.db.timers.where("category").equals(category);

    let timers = await collection.toArray();
    if (status) timers = timers.filter((t) => t.status === status);

    return timers.map((j) => Timer.fromJSON(TimerManager.enrichForUX(j)));
  }

  /** Update timer (expects Timer instance) */
  async updateTimer(timer) {
    if (!(timer instanceof Timer)) throw new Error("Must be instance of Timer");
    const json = timer.toJSON();
    json.lastUpdatedAt = new Date();
    await this.db.timers.put(json);
    await this.audit(timer.id, "update", { timer: json });
    emitUpdated();
  }

  /** Delete timer by ID */
  async deleteTimer(id) {
    await this.db.timers.delete(id);
    await this.audit(id, "delete");
    emitUpdated();
  }

  /** Clear all timers (dangerous) */
  async clearAll() {
    await this.db.timers.clear();
    if (this.db.timerEvents) await this.db.timerEvents.clear();
    await this.audit("*", "clearAll");
    emitUpdated();
  }

  /** Resume any running timers (adjust/complete based on current time) */
  async resumeRunningTimers() {
    const now = NOW();
    const all = await this.getAllTimers({ status: "running" });
    for (const timer of all) {
      if (typeof timer.endTime === "number" && now >= timer.endTime) {
        timer.complete();
        await this.updateTimer(timer);
      }
    }
    return all;
  }

  // ------------------------- new lifecycle -------------------------

  async start(id) {
    const json = await this.db.timers.get(id);
    if (!json) return null;

    const t = Timer.fromJSON(json);
    if (!t.startTime) t.startTime = NOW();
    if (t.durationMs && !t.endTime) t.endTime = t.startTime + t.durationMs;
    t.status = "running";

    await this.updateTimer(t);
    await this.audit(id, "start");
    return t;
  }

  async pause(id) {
    const json = await this.db.timers.get(id);
    if (!json) return null;

    const now = NOW();
    const t = Timer.fromJSON(json);

    if (t.status !== "running") return t;

    // Freeze remaining by shifting duration to elapsed
    const remaining = TimerManager.computeRemaining(json, now);
    const elapsed = Math.max(0, (t.durationMs || Math.max(0, (t.endTime || 0) - (t.startTime || now))) - remaining);

    t.pausedAt = now;
    t.status = "paused";
    // Rewrite model to “scheduled-equivalent”: duration = remaining, kill endTime
    t.durationMs = remaining;
    t.startTime = now; // anchor for later resume
    t.endTime = null;

    await this.updateTimer(t);
    await this.audit(id, "pause", { elapsed });
    return t;
  }

  async resume(id) {
    const json = await this.db.timers.get(id);
    if (!json) return null;

    const now = NOW();
    const t = Timer.fromJSON(json);

    if (t.status !== "paused") return t;

    const remaining = t.durationMs || TimerManager.computeRemaining(json, now);
    t.startTime = now;
    t.endTime = now + remaining;
    t.pausedAt = null;
    t.status = "running";

    await this.updateTimer(t);
    await this.audit(id, "resume");
    return t;
  }

  async complete(id, { reason = "done" } = {}) {
    const json = await this.db.timers.get(id);
    if (!json) return null;
    const t = Timer.fromJSON(json);
    t.complete?.(); // Model’s helper if available
    t.status = "completed";
    t.endTime = t.endTime || NOW();
    await this.updateTimer(t);
    await this.audit(id, "complete", { reason });
    return t;
  }

  async cancel(id, { reason = "cancelled" } = {}) {
    const json = await this.db.timers.get(id);
    if (!json) return null;
    const t = Timer.fromJSON(json);
    t.status = "cancelled";
    await this.updateTimer(t);
    await this.audit(id, "cancel", { reason });
    return t;
  }

  async snooze(id, ms = 5 * 60 * 1000) {
    const json = await this.db.timers.get(id);
    if (!json) return null;
    const now = NOW();
    const t = Timer.fromJSON(json);

    const remaining = TimerManager.computeRemaining(json, now);
    t.startTime = now;
    t.endTime = now + remaining + ms;
    t.durationMs = (t.durationMs || remaining) + ms;
    t.status = "running";

    await this.updateTimer(t);
    await this.audit(id, "snooze", { ms });
    return t;
  }

  async extend(id, ms) {
    const json = await this.db.timers.get(id);
    if (!json) return null;
    const t = Timer.fromJSON(json);

    if (typeof ms !== "number" || !Number.isFinite(ms)) return t;

    if (t.status === "running" && typeof t.endTime === "number") {
      t.endTime += ms;
      t.durationMs = (t.durationMs || 0) + ms;
    } else if (t.status === "paused" || t.status === "scheduled") {
      t.durationMs = (t.durationMs || 0) + ms;
    }

    await this.updateTimer(t);
    await this.audit(id, "extend", { ms });
    return t;
  }

  async restart(id) {
    const json = await this.db.timers.get(id);
    if (!json) return null;

    const now = NOW();
    const t = Timer.fromJSON(json);
    const dur = t.durationMs || Math.max(0, (t.endTime || now) - (t.startTime || now)) || 0;

    t.startTime = now;
    t.endTime = now + dur;
    t.status = "running";
    t.pausedAt = null;

    await this.updateTimer(t);
    await this.audit(id, "restart");
    return t;
  }

  // -------------------------- convenience views ---------------------

  async getActive() {
    const rows = await this.db.timers.toArray();
    const active = rows.filter((t) => ["running", "paused", "scheduled"].includes(t.status));
    return active.map((j) => Timer.fromJSON(TimerManager.enrichForUX(j)));
  }

  async getDueSoon(windowMs = 5 * 60 * 1000) {
    const now = NOW();
    const rows = await this.db.timers.toArray();
    const soon = rows.filter(
      (t) =>
        t.status === "running" &&
        typeof t.endTime === "number" &&
        t.endTime > now &&
        t.endTime - now <= windowMs
    );
    return soon
      .map((j) => Timer.fromJSON(TimerManager.enrichForUX(j)))
      .sort((a, b) => (a.endTime || 0) - (b.endTime || 0));
  }

  async getOverdue() {
    const now = NOW();
    const rows = await this.db.timers.toArray();
    const overdue = rows.filter((t) => t.status === "running" && typeof t.endTime === "number" && t.endTime <= now);
    return overdue
      .map((j) => Timer.fromJSON(TimerManager.enrichForUX(j)))
      .sort((a, b) => (a.endTime || 0) - (b.endTime || 0));
  }

  async timersByDue({ limit = 50 } = {}) {
    const rows = await this.db.timers.toArray();
    const enriched = rows.map(TimerManager.enrichForUX);
    enriched.sort((a, b) => {
      // urgency first, then earliest due
      if ((b.priorityScore || 0) !== (a.priorityScore || 0))
        return (b.priorityScore || 0) - (a.priorityScore || 0);
      return (a.endTime || Infinity) - (b.endTime || Infinity);
    });
    return enriched.slice(0, limit).map((j) => Timer.fromJSON(j));
  }

  // ------------------------------ import/export ----------------------

  async exportAll() {
    const timers = await this.db.timers.toArray();
    const events = this.db.timerEvents ? await this.db.timerEvents.toArray() : [];
    return { exportedAt: iso(), timers, events };
  }

  async importMany(payload, { merge = true } = {}) {
    if (!payload || typeof payload !== "object") return 0;
    const list = Array.isArray(payload.timers) ? payload.timers : [];

    if (!merge) {
      await this.db.timers.clear();
      if (this.db.timerEvents) await this.db.timerEvents.clear();
    }

    if (list.length) {
      await this.db.timers.bulkPut(
        list.map((t) => ({
          ...t,
          lastUpdatedAt: t.lastUpdatedAt || new Date(),
          tags: Array.isArray(t.tags) ? t.tags : [],
        }))
      );
    }

    if (Array.isArray(payload.events) && this.db.timerEvents) {
      await this.db.timerEvents.bulkPut(payload.events);
    }

    emitUpdated();
    return list.length;
  }
}

const timerManager = new TimerManager();
export default timerManager;
