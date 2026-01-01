// src/managers/UserRoutineManager.js

import Dexie from "dexie";
import UserRoutine from "../models/UserRoutine";

/* -----------------------------------------------------------------------------
 * Dexie DB (v1 -> v2)
 * -------------------------------------------------------------------------- */
const db = new Dexie("SukaSmartAssistantDB");

// v1 (original)
db.version(1).stores({
  userRoutines: "id, name, frequency, days, timeOfDay, isActive, linkedPlanId",
});

// v2: richer fields + audit
db.version(2)
  .stores({
    userRoutines:
      "id, name, frequency, days, timeOfDay, isActive, linkedPlanId, lastRunISO, nextRunISO, timezone, priority, tags, createdAt, updatedAt",
    routineEvents: "++id, routineId, atISO, action",
  })
  .upgrade(async (tx) => {
    const tbl = tx.table("userRoutines");
    const rows = await tbl.toArray();
    await Promise.all(
      rows.map((r) =>
        tbl.put({
          ...r,
          createdAt: r.createdAt || new Date(),
          updatedAt: r.updatedAt || new Date(),
          priority: r.priority ?? "medium", // low|medium|high|urgent
          tags: Array.isArray(r.tags) ? r.tags : (r.tags ? [r.tags] : []),
          timezone: r.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
          lastRunISO: r.lastRunISO || null,
          nextRunISO: r.nextRunISO || null, // will be recomputed on read/update
        })
      )
    );
  });

/* -----------------------------------------------------------------------------
 * Utilities
 * -------------------------------------------------------------------------- */
const hasWindow = () => typeof window !== "undefined";
const iso = (d) => (d instanceof Date ? d.toISOString() : new Date(d ?? Date.now()).toISOString());
const toNum = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const safeArr = (v) => (Array.isArray(v) ? v : v ? [v] : []);
const DAY_MS = 86400000;

function emitUpdated(topic = "ROUTINES:UPDATED", payload = {}) {
  try {
    const s = hasWindow() ? window.__SUKA_SOCKET__ : null;
    if (s?.connected) s.emit(topic, { at: iso(), ...payload });
  } catch { /* noop */ }
}

function parseTimeHHMM(timeOfDay = "09:00") {
  const m = String(timeOfDay).match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return { h: 9, min: 0 };
  const h = Math.max(0, Math.min(23, Number(m[1])));
  const min = Math.max(0, Math.min(59, Number(m[2])));
  return { h, min };
}

function weekdayIndex(name) {
  const map = {
    sun: 0, sunday: 0,
    mon: 1, monday: 1,
    tue: 2, tuesday: 2,
    wed: 3, wednesday: 3,
    thu: 4, thursday: 4,
    fri: 5, friday: 5,
    sat: 6, saturday: 6,
  };
  return map[String(name || "").toLowerCase()];
}

function normalizeDays(days) {
  const arr = safeArr(days).map(weekdayIndex).filter((n) => Number.isInteger(n));
  // unique & sorted
  return Array.from(new Set(arr)).sort((a, b) => a - b);
}

function nextFromDaily(timeOfDay, from = Date.now()) {
  const { h, min } = parseTimeHHMM(timeOfDay);
  const d = new Date(from);
  d.setSeconds(0, 0);

  const candidate = new Date(d);
  candidate.setHours(h, min, 0, 0);
  if (candidate.getTime() <= from) candidate.setDate(candidate.getDate() + 1);
  return candidate;
}

function nextFromWeekly(days, timeOfDay, from = Date.now()) {
  const want = normalizeDays(days);
  if (!want.length) return nextFromDaily(timeOfDay, from);

  const { h, min } = parseTimeHHMM(timeOfDay);
  const d = new Date(from);
  d.setSeconds(0, 0);

  for (let i = 0; i < 8; i++) {
    const candidate = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, h, min, 0, 0);
    if (want.includes(candidate.getDay()) && candidate.getTime() > from) {
      return candidate;
    }
  }
  // fallback one week later on first desired day
  const first = want[0];
  const delta = (first - new Date(from).getDay() + 7) % 7 || 7;
  const candidate = new Date(from + delta * DAY_MS);
  candidate.setHours(h, min, 0, 0);
  return candidate;
}

function nextFromMonthly(timeOfDay, dayOfMonth = 1, from = Date.now()) {
  const { h, min } = parseTimeHHMM(timeOfDay);
  const cur = new Date(from);
  const cand = new Date(cur.getFullYear(), cur.getMonth(), Math.max(1, Math.min(28, Number(dayOfMonth) || 1)), h, min, 0, 0);
  if (cand.getTime() <= from) cand.setMonth(cand.getMonth() + 1);
  return cand;
}

function computeNextRun(r, from = Date.now()) {
  if (r.isActive === false) return null;
  const freq = String(r.frequency || "daily").toLowerCase();

  if (freq === "daily") return nextFromDaily(r.timeOfDay, from);
  if (freq === "weekly") return nextFromWeekly(r.days, r.timeOfDay, from);
  if (freq === "monthly") return nextFromMonthly(r.timeOfDay, r.dayOfMonth || 1, from);
  if (freq === "custom" && typeof r.computeNextRun === "function") {
    try {
      const t = r.computeNextRun(from);
      return t instanceof Date ? t : (t ? new Date(t) : null);
    } catch { return null; }
  }
  // default daily
  return nextFromDaily(r.timeOfDay, from);
}

function priorityScore(p = "medium") {
  switch (p) {
    case "urgent": return 95;
    case "high": return 70;
    case "medium": return 40;
    case "low": return 15;
    default: return 20;
  }
}

/* -----------------------------------------------------------------------------
 * Audit helper
 * -------------------------------------------------------------------------- */
async function audit(routineId, action, payload = {}) {
  if (!db.routineEvents) return;
  try {
    await db.routineEvents.add({ routineId, action, payload, atISO: iso() });
  } catch {}
}

/* -----------------------------------------------------------------------------
 * Manager (compat + upgrades)
 * -------------------------------------------------------------------------- */
const UserRoutineManager = {
  /* ------------------------------ Core (compat) --------------------------- */

  async addRoutine(routineData) {
    const r = routineData instanceof UserRoutine ? routineData : new UserRoutine(routineData);
    const json = r.toJSON();

    // Normalize + compute next
    json.tags = safeArr(json.tags);
    json.createdAt = json.createdAt || new Date();
    json.updatedAt = new Date();
    json.isActive = json.isActive !== false;
    const next = computeNextRun(json);
    json.nextRunISO = next ? iso(next) : null;

    await db.userRoutines.put(json);
    emitUpdated();
    await audit(json.id, "create", { routine: json });
    return UserRoutine.fromJSON(json);
  },

  async getAllRoutines() {
    const results = await db.userRoutines.toArray();
    return results.map((row) => {
      // refresh nextRun on read if missing/stale
      if (!row.nextRunISO && row.isActive !== false) {
        const next = computeNextRun(row);
        if (next) row.nextRunISO = iso(next);
      }
      return UserRoutine.fromJSON(row);
    });
  },

  async getRoutineById(id) {
    const result = await db.userRoutines.get(id);
    if (!result) return null;
    if (!result.nextRunISO && result.isActive !== false) {
      const next = computeNextRun(result);
      if (next) {
        result.nextRunISO = iso(next);
        await db.userRoutines.put(result);
      }
    }
    return UserRoutine.fromJSON(result);
  },

  async updateRoutine(id, updates) {
    const existing = await db.userRoutines.get(id);
    if (!existing) throw new Error("Routine not found");

    const nextJson = UserRoutine.fromJSON({ ...existing, ...updates, updatedAt: Date.now() }).toJSON();

    // recompute next run if scheduling fields changed or de/activated
    const scheduleChanged = ["frequency", "days", "timeOfDay", "dayOfMonth", "isActive"].some((k) =>
      Object.prototype.hasOwnProperty.call(updates, k)
    );
    if (scheduleChanged) {
      nextJson.nextRunISO = updates.isActive === false ? null : (computeNextRun(nextJson) ? iso(computeNextRun(nextJson)) : null);
    }

    await db.userRoutines.put(nextJson);
    emitUpdated();
    await audit(id, "update", { updates });
    return UserRoutine.fromJSON(nextJson);
  },

  async deleteRoutine(id) {
    await db.userRoutines.delete(id);
    emitUpdated();
    await audit(id, "delete");
  },

  async clearAllRoutines() {
    await db.userRoutines.clear();
    if (db.routineEvents) await db.routineEvents.clear();
    emitUpdated();
    await audit("*", "clearAll");
  },

  /* ------------------------------ New helpers ----------------------------- */

  async setActive(id, flag = true) {
    const r = await db.userRoutines.get(id);
    if (!r) return 0;
    r.isActive = !!flag;
    r.updatedAt = new Date();
    r.nextRunISO = r.isActive ? iso(computeNextRun(r)) : null;
    await db.userRoutines.put(r);
    emitUpdated();
    await audit(id, "setActive", { isActive: r.isActive });
    return 1;
  },

  async skipNext(id) {
    const r = await db.userRoutines.get(id);
    if (!r || !r.isActive) return 0;
    const from = new Date(r.nextRunISO || Date.now()).getTime() + 1;
    r.nextRunISO = iso(computeNextRun(r, from));
    r.updatedAt = new Date();
    await db.userRoutines.put(r);
    emitUpdated();
    await audit(id, "skipNext");
    return 1;
  },

  async runNow(id) {
    const r = await db.userRoutines.get(id);
    if (!r) return 0;
    r.lastRunISO = iso();
    r.nextRunISO = r.isActive ? iso(computeNextRun(r, Date.now() + 1)) : null;
    r.updatedAt = new Date();
    await db.userRoutines.put(r);
    emitUpdated();
    await audit(id, "runNow");
    return 1;
  },

  async linkToPlan(id, planId) {
    const r = await db.userRoutines.get(id);
    if (!r) return 0;
    r.linkedPlanId = planId || null;
    r.updatedAt = new Date();
    await db.userRoutines.put(r);
    emitUpdated();
    await audit(id, "linkToPlan", { planId });
    return 1;
  },

  async getActive() {
    const rows = await db.userRoutines.where("isActive").equals(1).toArray().catch(async () => {
      // Dexie treats booleans as numbers; fallback to manual
      const all = await db.userRoutines.toArray();
      return all.filter((x) => x.isActive !== false);
    });
    return rows.map(UserRoutine.fromJSON);
  },

  async getDueSoon(windowMinutes = 60) {
    const now = Date.now();
    const win = windowMinutes * 60000;
    const all = await db.userRoutines.toArray();
    return all
      .filter((r) => r.isActive !== false && r.nextRunISO)
      .filter((r) => {
        const t = new Date(r.nextRunISO).getTime();
        return t >= now && t - now <= win;
      })
      .sort((a, b) => new Date(a.nextRunISO) - new Date(b.nextRunISO))
      .map(UserRoutine.fromJSON);
  },

  async getOverdue() {
    const now = Date.now();
    const all = await db.userRoutines.toArray();
    return all
      .filter((r) => r.isActive !== false && r.nextRunISO && new Date(r.nextRunISO).getTime() < now)
      .sort((a, b) => new Date(a.nextRunISO) - new Date(b.nextRunISO))
      .map(UserRoutine.fromJSON);
  },

  async listUpcoming({ withinDays = 7, limit = 100 } = {}) {
    const now = Date.now();
    const until = now + withinDays * DAY_MS;
    const all = await db.userRoutines.toArray();
    const rows = all
      .filter((r) => r.isActive !== false)
      .map((r) => {
        const t = r.nextRunISO ? new Date(r.nextRunISO).getTime() : computeNextRun(r)?.getTime();
        return t ? { ...r, nextTs: t } : null;
      })
      .filter(Boolean)
      .filter((r) => r.nextTs <= until)
      .sort((a, b) => a.nextTs - b.nextTs)
      .slice(0, limit)
      .map(UserRoutine.fromJSON);
    return rows;
  },

  /* ------------------------------ Portability ----------------------------- */

  async exportAll() {
    const routines = await db.userRoutines.toArray();
    const events = db.routineEvents ? await db.routineEvents.toArray() : [];
    return { exportedAt: iso(), routines, events };
  },

  async importMany(payload, { merge = true } = {}) {
    if (!payload || typeof payload !== "object") return 0;
    const list = Array.isArray(payload.routines) ? payload.routines : [];

    if (!merge) {
      await db.userRoutines.clear();
      if (db.routineEvents) await db.routineEvents.clear();
    }
    if (list.length) {
      await db.userRoutines.bulkPut(
        list.map((r) => ({
          ...r,
          tags: safeArr(r.tags),
          createdAt: r.createdAt || new Date(),
          updatedAt: r.updatedAt || new Date(),
          nextRunISO: r.isActive === false ? null : (r.nextRunISO || iso(computeNextRun(r) || Date.now())),
        }))
      );
    }
    if (Array.isArray(payload.events) && db.routineEvents) {
      await db.routineEvents.bulkPut(payload.events);
    }

    emitUpdated();
    await audit("*", "import", { count: list.length });
    return list.length;
  },

  async backupToLocal() {
    const routines = await db.userRoutines.toArray();
    const events = (await db.routineEvents?.toArray?.()) || [];
    localStorage.setItem("suka_user_routines_backup", JSON.stringify({ routines, events, at: iso() }));
    return true;
  },

  async restoreFromLocal() {
    const raw = localStorage.getItem("suka_user_routines_backup");
    if (!raw) return 0;
    const parsed = JSON.parse(raw);
    const routines = parsed?.routines || [];
    const events = parsed?.events || [];
    await db.transaction("rw", db.userRoutines, db.routineEvents, async () => {
      await db.userRoutines.clear();
      if (db.routineEvents) await db.routineEvents.clear();
      if (routines.length) await db.userRoutines.bulkPut(routines);
      if (events.length && db.routineEvents) await db.routineEvents.bulkPut(events);
    });
    emitUpdated();
    await audit("*", "restoreLocal", { count: routines.length });
    return routines.length;
  },

  /* ------------------------------ QoL / Search ----------------------------- */

  async findByNameLoose(name) {
    if (!name) return null;
    const needle = String(name).trim().toLowerCase().replace(/\s+/g, " ");
    const all = await db.userRoutines.toArray();
    return (
      all.find((r) => (r.name || "").toLowerCase().replace(/\s+/g, " ") === needle) ||
      all.find((r) => (r.name || "").toLowerCase().includes(needle)) ||
      null
    );
  },

  async upsertRoutine(routine) {
    const existing = routine.id ? await db.userRoutines.get(routine.id) : null;
    if (existing) return this.updateRoutine(existing.id, routine);
    return this.addRoutine(routine);
  },

  async getStats() {
    const all = await db.userRoutines.toArray();
    const active = all.filter((r) => r.isActive !== false).length;
    const weekly = all.filter((r) => String(r.frequency).toLowerCase() === "weekly").length;
    const daily = all.filter((r) => String(r.frequency).toLowerCase() === "daily").length;
    const overdue = (await this.getOverdue()).length;
    return { total: all.length, active, daily, weekly, overdue };
  },
};

export default UserRoutineManager;
