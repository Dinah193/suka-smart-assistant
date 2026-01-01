// src/managers/WorkerSessionManager.js

import Dexie from "dexie";

/* -----------------------------------------------------------------------------
 * DB (v1 -> v2)
 * -------------------------------------------------------------------------- */
const db = new Dexie("SukaInventoryDB");

// v1 (original)
db.version(1).stores({
  workerSessions: "id, workerId, role, date, tasks, status",
});

// v2: schedule-aware + audit
db.version(2)
  .stores({
    workerSessions:
      "id, workerId, role, date, status, plannedStartISO, plannedEndISO, startedAtISO, endedAtISO, priority, notes, lastUpdated",
    workerSessionEvents: "++id, sessionId, atISO, action",
  })
  .upgrade(async (tx) => {
    const tbl = tx.table("workerSessions");
    const rows = await tbl.toArray();
    await Promise.all(
      rows.map((r) =>
        tbl.put({
          ...r,
          priority: r.priority || "medium",
          notes: r.notes || "",
          lastUpdated: r.lastUpdated || new Date(),
          plannedStartISO: r.plannedStartISO || null,
          plannedEndISO: r.plannedEndISO || null,
          startedAtISO: r.startedAtISO || null,
          endedAtISO: r.endedAtISO || null,
          tasks: Array.isArray(r.tasks) ? r.tasks : [],
          breaks: Array.isArray(r.breaks) ? r.breaks : [],
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
const genId = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

function emitUpdated(topic = "WORKER_SESSIONS:UPDATED", payload = {}) {
  try {
    const s = hasWindow() ? window.__SUKA_SOCKET__ : null;
    if (s?.connected) s.emit(topic, { at: iso(), ...payload });
  } catch { /* noop */ }
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

function computeProgress(sess) {
  const now = Date.now();
  const start = sess.startedAtISO ? new Date(sess.startedAtISO).getTime() : null;
  const end = sess.endedAtISO ? new Date(sess.endedAtISO).getTime() : null;
  const plannedStart = sess.plannedStartISO ? new Date(sess.plannedStartISO).getTime() : null;
  const plannedEnd = sess.plannedEndISO ? new Date(sess.plannedEndISO).getTime() : null;

  // task completion
  const tasks = safeArr(sess.tasks);
  const doneCount = tasks.filter((t) => t?.status === "done").length;
  const taskPct = tasks.length ? (doneCount / tasks.length) : null;

  // time progress (planned)
  let timePct = null;
  if (plannedStart && plannedEnd && plannedEnd > plannedStart) {
    const span = plannedEnd - plannedStart;
    const pos = Math.max(0, Math.min(span, now - plannedStart));
    timePct = pos / span;
  }

  // status
  const status = sess.status || (start ? (end ? "completed" : "in_progress") : "scheduled");

  // due
  const dueISO = plannedEnd || end ? iso(plannedEnd || end) : null;

  // speak
  const speak =
    status === "in_progress"
      ? `${sess.role || "Worker"} session is in progress${taskPct != null ? `, ${Math.round(taskPct * 100)}% tasks complete.` : "."}`
      : status === "scheduled"
      ? `${sess.role || "Worker"} session scheduled${dueISO ? ` to end at ${new Date(dueISO).toLocaleTimeString()}` : ""}.`
      : `${sess.role || "Worker"} session ${status}.`;

  // deep link
  const deepLink = { panel: "Sessions", id: sess.id, workerId: sess.workerId, role: sess.role };

  return {
    ...sess,
    taskProgress: taskPct,          // 0..1 | null
    timeProgress: timePct,          // 0..1 | null
    dueISO,
    priorityScore: priorityScore(sess.priority),
    speak,
    deepLink,
  };
}

/* -----------------------------------------------------------------------------
 * Audit helper
 * -------------------------------------------------------------------------- */
async function audit(sessionId, action, payload = {}) {
  if (!db.workerSessionEvents) return;
  try {
    await db.workerSessionEvents.add({ sessionId, action, payload, atISO: iso() });
  } catch { /* noop */ }
}

/* -----------------------------------------------------------------------------
 * Manager (compat + upgrades)
 * -------------------------------------------------------------------------- */
const WorkerSessionManager = {
  /* ------------------------------ Core (compat) --------------------------- */

  async add(session) {
    const row = {
      id: session.id || genId(),
      workerId: session.workerId || null,
      role: session.role || "worker",
      date: session.date || iso().slice(0, 10), // YYYY-MM-DD
      status: session.status || "scheduled",     // scheduled|in_progress|paused|completed|cancelled
      tasks: safeArr(session.tasks),
      breaks: safeArr(session.breaks),
      plannedStartISO: session.plannedStartISO || null,
      plannedEndISO: session.plannedEndISO || null,
      startedAtISO: session.startedAtISO || null,
      endedAtISO: session.endedAtISO || null,
      priority: session.priority || "medium",
      notes: session.notes || "",
      lastUpdated: new Date(),
    };
    await db.workerSessions.put(row);
    emitUpdated();
    await audit(row.id, "create", { session: row });
    return computeProgress(row);
  },

  async getAll() {
    const rows = await db.workerSessions.toArray();
    return rows.map(computeProgress);
  },

  async update(id, updates) {
    const prev = await db.workerSessions.get(id);
    if (!prev) return 0;
    const next = {
      ...prev,
      ...updates,
      tasks: updates.tasks ? safeArr(updates.tasks) : prev.tasks,
      breaks: updates.breaks ? safeArr(updates.breaks) : prev.breaks,
      lastUpdated: new Date(),
    };
    await db.workerSessions.put(next);
    emitUpdated();
    await audit(id, "update", { updates });
    return 1;
  },

  async remove(id) {
    await db.workerSessions.delete(id);
    emitUpdated();
    await audit(id, "delete");
    return 1;
  },

  async clear() {
    await db.workerSessions.clear();
    if (db.workerSessionEvents) await db.workerSessionEvents.clear();
    emitUpdated();
    await audit("*", "clearAll");
    return 1;
  },

  /* ------------------------------ Lifecycle ------------------------------- */

  async startSession(id, { at = Date.now() } = {}) {
    const row = await db.workerSessions.get(id);
    if (!row) return null;
    row.startedAtISO = iso(at);
    if (!row.plannedStartISO) row.plannedStartISO = row.startedAtISO;
    if (!row.plannedEndISO && row.startedAtISO && row.plannedStartISO === row.startedAtISO) {
      // simple default 2h session if none planned
      row.plannedEndISO = iso(new Date(new Date(row.startedAtISO).getTime() + 2 * 3600000));
    }
    row.status = "in_progress";
    row.lastUpdated = new Date();
    await db.workerSessions.put(row);
    emitUpdated();
    await audit(id, "start");
    return computeProgress(row);
  },

  async endSession(id, { at = Date.now(), reason = "done" } = {}) {
    const row = await db.workerSessions.get(id);
    if (!row) return null;
    row.endedAtISO = iso(at);
    row.status = "completed";
    row.lastUpdated = new Date();
    await db.workerSessions.put(row);
    emitUpdated();
    await audit(id, "end", { reason });
    return computeProgress(row);
  },

  async setStatus(id, status) {
    const row = await db.workerSessions.get(id);
    if (!row) return null;
    row.status = status;
    row.lastUpdated = new Date();
    await db.workerSessions.put(row);
    emitUpdated();
    await audit(id, "status", { status });
    return computeProgress(row);
  },

  async punchIn(id, { at = Date.now() } = {}) {
    const row = await db.workerSessions.get(id);
    if (!row) return null;
    const b = row.breaks || [];
    // close any open break first
    const openIdx = b.findIndex((x) => x && !x.endISO);
    if (openIdx >= 0) b[openIdx].endISO = iso(at);
    row.breaks = b;
    row.status = "in_progress";
    row.lastUpdated = new Date();
    await db.workerSessions.put(row);
    emitUpdated();
    await audit(id, "punchIn");
    return computeProgress(row);
  },

  async punchOut(id, { at = Date.now(), reason = "break" } = {}) {
    const row = await db.workerSessions.get(id);
    if (!row) return null;
    const b = row.breaks || [];
    const openIdx = b.findIndex((x) => x && !x.endISO);
    if (openIdx === -1) b.push({ startISO: iso(at), endISO: null, reason });
    row.breaks = b;
    row.status = "paused";
    row.lastUpdated = new Date();
    await db.workerSessions.put(row);
    emitUpdated();
    await audit(id, "punchOut", { reason });
    return computeProgress(row);
  },

  async addTask(id, task) {
    const row = await db.workerSessions.get(id);
    if (!row) return null;
    const t = {
      id: task?.id || `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      title: task?.title || "Task",
      status: task?.status || "todo", // todo|doing|done
      notes: task?.notes || "",
      priority: task?.priority || "medium",
      estimateMin: toNum(task?.estimateMin, 0),
    };
    row.tasks = [...(row.tasks || []), t];
    row.lastUpdated = new Date();
    await db.workerSessions.put(row);
    emitUpdated();
    await audit(id, "task:add", { task: t });
    return computeProgress(row);
  },

  async completeTask(id, taskId) {
    const row = await db.workerSessions.get(id);
    if (!row) return null;
    row.tasks = (row.tasks || []).map((t) => (t.id === taskId ? { ...t, status: "done" } : t));
    row.lastUpdated = new Date();
    await db.workerSessions.put(row);
    emitUpdated();
    await audit(id, "task:complete", { taskId });
    return computeProgress(row);
  },

  async assignWorker(id, { workerId, role }) {
    const row = await db.workerSessions.get(id);
    if (!row) return null;
    if (workerId != null) row.workerId = workerId;
    if (role) row.role = role;
    row.lastUpdated = new Date();
    await db.workerSessions.put(row);
    emitUpdated();
    await audit(id, "assign", { workerId, role });
    return computeProgress(row);
  },

  /* --------------------------------- Views -------------------------------- */

  async getActive() {
    const rows = await db.workerSessions.toArray();
    return rows
      .filter((r) => ["scheduled", "in_progress", "paused"].includes(r.status))
      .map(computeProgress);
  },

  async getByWorker(workerId, { onlyOpen = false } = {}) {
    const rows = await db.workerSessions.where("workerId").equals(workerId).toArray().catch(async () => {
      // fallback if no index match
      const all = await db.workerSessions.toArray();
      return all.filter((r) => r.workerId === workerId);
    });
    const mapped = rows.map(computeProgress);
    return onlyOpen ? mapped.filter((r) => r.status !== "completed" && r.status !== "cancelled") : mapped;
  },

  async sessionsByDate(dateISO) {
    const day = (dateISO || iso().slice(0, 10));
    const all = await db.workerSessions.toArray();
    return all.filter((r) => (r.date || "").slice(0, 10) === day).map(computeProgress);
  },

  async overdueSessions() {
    const now = Date.now();
    const rows = await db.workerSessions.toArray();
    return rows
      .filter((r) => {
        const plannedEnd = r.plannedEndISO ? new Date(r.plannedEndISO).getTime() : null;
        return r.status !== "completed" && plannedEnd != null && plannedEnd < now;
      })
      .map(computeProgress);
  },

  async dueSoon(windowMinutes = 60) {
    const now = Date.now();
    const limit = windowMinutes * 60000;
    const rows = await db.workerSessions.toArray();
    return rows
      .filter((r) => r.status === "scheduled" && r.plannedStartISO)
      .filter((r) => {
        const t = new Date(r.plannedStartISO).getTime();
        return t > now && t - now <= limit;
      })
      .map(computeProgress)
      .sort((a, b) => new Date(a.plannedStartISO) - new Date(b.plannedStartISO));
  },

  async search(q, { role, status, workerId } = {}) {
    const needle = String(q || "").toLowerCase().trim();
    const rows = await db.workerSessions.toArray();
    return rows
      .filter((r) => (!role || r.role === role) && (!status || r.status === status) && (!workerId || r.workerId === workerId))
      .filter((r) => {
        if (!needle) return true;
        const hay = [
          r.role, r.status, r.workerId,
          ...(safeArr(r.tasks).map((t) => t.title)),
          r.notes,
        ].join(" ").toLowerCase();
        return hay.includes(needle);
      })
      .map(computeProgress);
  },

  async getStats() {
    const all = await db.workerSessions.toArray();
    const total = all.length;
    const byStatus = all.reduce((acc, r) => {
      acc[r.status] = (acc[r.status] || 0) + 1;
      return acc;
    }, {});
    const active = (byStatus.scheduled || 0) + (byStatus.in_progress || 0) + (byStatus.paused || 0);
    const overdue = (await this.overdueSessions()).length;
    return {
      total,
      active,
      completed: byStatus.completed || 0,
      scheduled: byStatus.scheduled || 0,
      inProgress: byStatus.in_progress || 0,
      paused: byStatus.paused || 0,
      cancelled: byStatus.cancelled || 0,
      overdue,
    };
  },

  /* --------------------------- Portability/Backup -------------------------- */

  async exportAll() {
    const sessions = await db.workerSessions.toArray();
    const events = db.workerSessionEvents ? await db.workerSessionEvents.toArray() : [];
    return { exportedAt: iso(), sessions, events };
  },

  async importMany(payload, { merge = true } = {}) {
    if (!payload || typeof payload !== "object") return 0;
    const list = Array.isArray(payload.sessions) ? payload.sessions : [];

    if (!merge) {
      await db.workerSessions.clear();
      if (db.workerSessionEvents) await db.workerSessionEvents.clear();
    }

    if (list.length) {
      await db.workerSessions.bulkPut(
        list.map((s) => ({
          ...s,
          tasks: safeArr(s.tasks),
          breaks: safeArr(s.breaks),
          lastUpdated: s.lastUpdated || new Date(),
        }))
      );
    }

    if (Array.isArray(payload.events) && db.workerSessionEvents) {
      await db.workerSessionEvents.bulkPut(payload.events);
    }

    emitUpdated();
    await audit("*", "import", { count: list.length });
    return list.length;
  },

  async backupToLocal() {
    const sessions = await db.workerSessions.toArray();
    const events = (await db.workerSessionEvents?.toArray?.()) || [];
    localStorage.setItem("suka_worker_sessions_backup", JSON.stringify({ sessions, events, at: iso() }));
    return true;
  },

  async restoreFromLocal() {
    const raw = localStorage.getItem("suka_worker_sessions_backup");
    if (!raw) return 0;
    const parsed = JSON.parse(raw);
    const sessions = parsed?.sessions || [];
    const events = parsed?.events || [];
    await db.transaction("rw", db.workerSessions, db.workerSessionEvents, async () => {
      await db.workerSessions.clear();
      if (db.workerSessionEvents) await db.workerSessionEvents.clear();
      if (sessions.length) await db.workerSessions.bulkPut(sessions);
      if (events.length && db.workerSessionEvents) await db.workerSessionEvents.bulkPut(events);
    });
    emitUpdated();
    await audit("*", "restoreLocal", { count: sessions.length });
    return sessions.length;
  },
};

export default WorkerSessionManager;
