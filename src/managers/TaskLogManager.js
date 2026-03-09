// src/managers/TaskLogManager.js
// ------------------------------------------------------------------
// Household task aggregator + lightweight logger.
// Sources: ReminderManager (inventory, cooking, cleaning, garden, animal)
// Persist: localStorage (primary), optional Dexie audit if db.available
// ------------------------------------------------------------------

const STORAGE_KEY = "sv_task_log_v1";
const ROLES_KEY = "sv_roles_v1";

const STABLE_EMPTY = [];
const ICONS = {
  inventory: "📦",
  cooking: "🍳",
  cleaning: "🧼",
  garden: "🌿",
  animal: "🐄",
  system: "🧠",
};

const iso = (d) =>
  d instanceof Date ? d.toISOString() : new Date(d || Date.now()).toISOString();

async function tryImport(path) {
  try {
    // Vite can't statically analyze variable dynamic imports.
    // This suppresses the warning while keeping your soft-import behavior.
    return await import(/* @vite-ignore */ path);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Local persistence (primary)                                        */
/* ------------------------------------------------------------------ */
function loadLog() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : { entries: [], events: [] };
    if (!Array.isArray(parsed.entries)) parsed.entries = [];
    if (!Array.isArray(parsed.events)) parsed.events = [];
    return parsed;
  } catch {
    return { entries: [], events: [] };
  }
}

function saveLog(data) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {}
}

/* ------------------------------------------------------------------ */
/* Optional Dexie audit (safe if db not present)                      */
/* ------------------------------------------------------------------ */
async function auditEventDexie(evt) {
  const dbMod = await tryImport("../db");
  const DexieDB = dbMod?.default;
  if (!DexieDB || !DexieDB.taskEvents) return false;
  try {
    await DexieDB.taskEvents.add({ ...evt, atISO: iso() });
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Normalization & scoring                                            */
/* ------------------------------------------------------------------ */
function toScore(priority = "low", explicitScore) {
  if (Number.isFinite(explicitScore)) return explicitScore;
  switch (priority) {
    case "urgent":
      return 95;
    case "high":
      return 70;
    case "medium":
      return 40;
    case "low":
      return 15;
    default:
      return 10;
  }
}

/** Normalize a reminder-like object to a task. */
function reminderToTask(r) {
  // Prefer stable IDs coming from the reminder; otherwise derive one deterministically if possible
  const baseId = (r.id || `${r.type || "task"}-${r.message || r.title || ""}`)
    .toLowerCase()
    .replace(/\s+/g, "-")
    .slice(0, 80);
  const id = baseId || `${r.type || "task"}-${Date.now()}`;

  return {
    id,
    type: r.type ?? "system",
    title: r.message ?? r.title ?? "Household task",
    icon: r.icon ?? (ICONS[r.type] || ICONS.system),
    priority: r.priority ?? "low",
    priorityScore: toScore(r.priority, r.priorityScore),
    // Map due fields from new ReminderManager if present
    dueAt: r.dueISO || r.dueAt || null,
    assignedTo: r.assignedTo ?? null,
    status: "pending",
    source: r.meta?.kind ?? "reminder",
    deepLink: r.deepLink || r.meta?.deepLink || null,
    speak: r.speak || null,
    meta: r.meta ?? {},
  };
}

function sortTasks(list) {
  return [...list].sort((a, b) => {
    if ((b.priorityScore || 0) !== (a.priorityScore || 0))
      return (b.priorityScore || 0) - (a.priorityScore || 0);
    if (a.dueAt || b.dueAt)
      return (
        new Date(a.dueAt || 8640000000000000) -
        new Date(b.dueAt || 8640000000000000)
      );
    return String(a.title).localeCompare(String(b.title));
  });
}

function dedupeById(list) {
  const seen = new Set();
  const out = [];
  for (const t of list) {
    if (!t || seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Aggregate from ReminderManager                                     */
/* ------------------------------------------------------------------ */
/**
 * Get tasks aggregated from available sources.
 * filters.types: array like ["animal", "cleaning", "cooking", "garden", "inventory"]
 */
export async function getHouseholdTasks(filters = {}) {
  const { types = null } = filters;

  // Pull from ReminderManager (defensive import)
  const remMod = await tryImport("@/managers/ReminderManager");
  let reminders = STABLE_EMPTY;

  try {
    const mgr = remMod?.default ?? remMod;
    if (mgr?.getFormattedForUI) {
      // formatted has: icon, message, priority, type, id, dueISO?, deepLink?
      const formatted = await mgr.getFormattedForUI();
      // We need priorityScore/speak if available → fall back safely
      const raw = mgr.getActiveReminders ? await mgr.getActiveReminders() : [];
      const byId = new Map((raw || []).map((r) => [r.id, r]));
      reminders = (formatted || []).map((f) => {
        const enrich = byId.get?.(f.id) || {};
        return {
          id: f.id,
          type: f.type,
          icon: f.icon,
          message: f.message,
          priority: f.priority,
          priorityScore: enrich.priorityScore ?? toScore(f.priority),
          dueISO: f.dueISO || enrich.dueISO || null,
          deepLink: f.deepLink || enrich.deepLink || null,
          speak: enrich.speak || null,
          meta: enrich.meta || {},
        };
      });
    } else if (mgr?.getActiveReminders) {
      reminders = await mgr.getActiveReminders();
    }
  } catch {
    reminders = STABLE_EMPTY;
  }

  // Normalize to task shape
  const tasks = (reminders || []).map(reminderToTask);

  // Filter by type if requested
  const filtered =
    Array.isArray(types) && types.length
      ? tasks.filter((t) => types.includes(t.type))
      : tasks;

  // Merge with existing local assignments/status
  const log = loadLog();
  const merged = filtered.map((t) => {
    const entry = log.entries.find((e) => e.id === t.id);
    return entry ? { ...t, ...entry } : t;
  });

  // Dedupe & sort (priority → due → title)
  return sortTasks(dedupeById(merged));
}

/* ------------------------------------------------------------------ */
/* Mutations + audit                                                  */
/* ------------------------------------------------------------------ */
async function logTaskEvent({ id, action, payload = {} }) {
  const event = { id, action, payload, atISO: iso() };
  // Persist in localStorage
  const log = loadLog();
  log.events.push(event);
  saveLog(log);
  // Optional Dexie audit
  await auditEventDexie({ id, action, payload });
  return event;
}

/** Assign a task to a role/person. */
export async function assignTask(taskId, assignee) {
  const log = loadLog();
  const idx = log.entries.findIndex((e) => e.id === taskId);
  if (idx >= 0) {
    log.entries[idx].assignedTo = assignee;
  } else {
    log.entries.push({ id: taskId, assignedTo: assignee, status: "pending" });
  }
  saveLog(log);
  await logTaskEvent({ id: taskId, action: "assign", payload: { assignee } });
  return { ok: true, id: taskId, assignedTo: assignee };
}

/** Mark task complete/pending. */
export async function setTaskStatus(taskId, status = "completed") {
  const log = loadLog();
  const idx = log.entries.findIndex((e) => e.id === taskId);
  if (idx >= 0) {
    log.entries[idx].status = status;
    if (status === "completed") {
      log.entries[idx].completedAt = iso();
    } else {
      delete log.entries[idx].completedAt;
    }
  } else {
    log.entries.push({
      id: taskId,
      status,
      completedAt: status === "completed" ? iso() : null,
    });
  }
  saveLog(log);
  await logTaskEvent({ id: taskId, action: "status", payload: { status } });
  return { ok: true, id: taskId, status };
}

/** Remove a task entry from the local log (does not delete source reminder). */
export async function removeTask(taskId) {
  const log = loadLog();
  const before = log.entries.length;
  log.entries = log.entries.filter((e) => e.id !== taskId);
  saveLog(log);
  await logTaskEvent({ id: taskId, action: "remove" });
  return { ok: true, removed: before - log.entries.length };
}

/** Clear all completed tasks from local log. */
export async function clearCompleted() {
  const log = loadLog();
  const before = log.entries.length;
  log.entries = log.entries.filter((e) => e.status !== "completed");
  saveLog(log);
  await logTaskEvent({ id: "*", action: "clearCompleted" });
  return { ok: true, removed: before - log.entries.length };
}

/* ------------------------------------------------------------------ */
/* Roles                                                              */
/* ------------------------------------------------------------------ */
export function getRoles() {
  try {
    const raw = localStorage.getItem(ROLES_KEY);
    const roles = raw
      ? JSON.parse(raw)
      : ["Householder", "Cook", "Cleaner", "Gardener", "Animal Keeper"];
    return Array.isArray(roles)
      ? roles
      : ["Householder", "Cook", "Cleaner", "Gardener", "Animal Keeper"];
  } catch {
    return ["Householder", "Cook", "Cleaner", "Gardener", "Animal Keeper"];
  }
}

export function addRole(name) {
  const roles = getRoles();
  if (name && !roles.includes(name)) {
    roles.push(name);
    localStorage.setItem(ROLES_KEY, JSON.stringify(roles));
  }
  return roles;
}

/* ------------------------------------------------------------------ */
/* Optional helpers (non-breaking additions)                          */
/* ------------------------------------------------------------------ */

/** Quick stats for a dashboard badge. */
export async function getStats() {
  const tasks = await getHouseholdTasks();
  const total = tasks.length;
  const byStatus = tasks.reduce((acc, t) => {
    acc[t.status] = (acc[t.status] || 0) + 1;
    return acc;
  }, {});
  const urgent = tasks.filter((t) => t.priority === "urgent").length;
  const high = tasks.filter((t) => t.priority === "high").length;
  return {
    total,
    completed: byStatus.completed || 0,
    pending: byStatus.pending || 0,
    urgent,
    high,
  };
}

/** Calendar events view for planner board. */
export async function getCalendarEvents() {
  const tasks = await getHouseholdTasks();
  return tasks
    .filter((t) => t.dueAt)
    .map((t) => ({
      id: `${t.id}:${t.dueAt}`,
      title: `${t.icon || ICONS[t.type] || ICONS.system} ${t.title}`,
      start: t.dueAt,
      end: iso(new Date(new Date(t.dueAt).getTime() + 15 * 60000)),
      metadata: {
        type: t.type,
        priority: t.priority,
        deepLink: t.deepLink || null,
      },
    }));
}

/** Export/import the task log (entries + events). */
export async function exportLog() {
  const data = loadLog();
  return { exportedAt: iso(), ...data };
}

export async function importLog(payload) {
  if (!payload || typeof payload !== "object") return 0;
  const current = loadLog();
  // Merge by id for entries; append events
  const byId = new Map(current.entries.map((e) => [e.id, e]));
  (payload.entries || []).forEach((e) =>
    byId.set(e.id, { ...byId.get(e.id), ...e })
  );
  const mergedEntries = Array.from(byId.values());
  const mergedEvents = [...current.events, ...(payload.events || [])];
  saveLog({ entries: mergedEntries, events: mergedEvents });
  await logTaskEvent({ id: "*", action: "import" });
  return mergedEntries.length;
}

/* ------------------------------------------------------------------ */
/* Default export                                                     */
/* ------------------------------------------------------------------ */
const TaskLogManager = {
  // Aggregation
  getHouseholdTasks,
  // Mutations
  assignTask,
  setTaskStatus,
  removeTask,
  clearCompleted,
  // Roles
  getRoles,
  addRole,
  // Extras
  getStats,
  getCalendarEvents,
  exportLog,
  importLog,
};

export default TaskLogManager;
