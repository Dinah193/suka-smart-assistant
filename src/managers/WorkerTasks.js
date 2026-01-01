// src/managers/WorkerTasks.js

/**
 * WorkerTasks
 * -----------------------------------------------------------------------------
 * Unifies task generation across domains (animals, garden, inventory, reminders,
 * and future cleaning/batch-cooking agents), recommends roles, skills, and tools,
 * then persists lightweight “assignments” to the existing workerSessions store
 * for compatibility with WorkerSessionManager and any dashboards you already wired.
 *
 * Design goals (from Suka project chats):
 *  - Smart role & skill inference (butcher, milker, gardener, stock keeper, cleaner, cook, etc.)
 *  - Tool recommendations from your Tool Inventory (findBestMatchingTools)
 *  - Priority normalization + due-date hinting (same-day, next-day, soon)
 *  - Inventory-aware restock actions w/ optional substitutions
 *  - Human-friendly grouping for Kanban dashboards (by status/role/source)
 *  - Fitness & Defense tie-in: lightweight “effort” estimate + kcal estimate
 *  - Stable IDs & de-duplication of feed items from multiple agents
 */

import DexieDB from "../db";
import AnimalQueueManager from "./AnimalQueueManager";
import GardenQueueManager from "./GardenQueueManager";
import ReminderManager from "./ReminderManager";
import InventoryMonitor from "./InventoryMonitor";
import { findBestMatchingTools } from "../utils/toolUtils";

// Optional: If you later add these, they will auto-participate without code changes.
let CleaningQueueManager, BatchCookingManager;
try {
  // Lazy / optional imports so this file doesn’t crash if they aren’t present yet.
  CleaningQueueManager = require("./CleaningQueueManager").default;
} catch (_) {}
try {
  BatchCookingManager = require("../features/meals/services/BatchCookingManager").default;
} catch (_) {}

/** ---------- Helpers: scoring, dates, roles, ids ---------- */

const TODAY = () => new Date();

const addDays = (date, days) => {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
};

const stableId = (source, raw) => {
  // Build a stable-ish ID from source + name + optional date key
  const key = `${source}:${raw?.id ?? ""}:${raw?.name ?? raw?.label ?? ""}:${raw?.date ?? ""}`.toLowerCase();
  return `task-${hashCode(key)}`;
};

function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) - h + str.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(36);
}

/**
 * Role inference tuned to your domains.
 * Extendable: just add more regex/keywords.
 */
const inferRole = (t) => {
  const s = `${t.name} ${t.task}`.toLowerCase();

  if (/\bbutcher|slaughter|dispatch\b/.test(s)) return "butcher";
  if (/\bmilk|milking\b/.test(s)) return "milker";
  if (/\bfeed|watering|animal|goat|sheep|hen|rooster|brooder|calf|kid\b/.test(s)) return "farm hand";
  if (/\bplant|transplant|trellis|harvest|mulch|prune|bed|row|seed\b/.test(s)) return "gardener";
  if (/\brestock|inventory|stock\b/.test(s)) return "stock keeper";
  if (/\bclean|sanitize|deep clean|scrub|mop|laundry|declutter\b/.test(s)) return "cleaner";
  if (/\bcook|batch|prep|can|jar|dehydrate|smoke|cure|brew|ferment\b/.test(s)) return "cook";
  if (/\breminder|calendar|schedule\b/.test(s)) return "scheduler";
  if (/\bbuild|repair|maintenance|fix|install\b/.test(s)) return "handyperson";

  return "general";
};

/**
 * Lightweight effort & kcal estimates to feed Fitness & Defense dashboards.
 * (We’re not chasing precision here—just useful signals for planning.)
 */
const estimateEffort = (t) => {
  const s = `${t.name} ${t.task}`.toLowerCase();

  // Minutes
  let minutes = 20; // baseline quick task
  if (/\bdeep clean|harvest|butcher|slaughter|cure|brew|can|dehydrate|transplant|build|repair\b/.test(s)) minutes = 60;
  if (/\blarge harvest|full room clean|barn clean|batch cook|pressure canning|smoking\b/.test(s)) minutes = 120;

  // Kcal burned rough estimate (MET-ish ballpark)
  let kcal = Math.round(minutes * (/\bclean|garden|harvest|butcher|carry|lift|stock\b/.test(s) ? 6 : 3));

  return { minutes, kcal };
};

/**
 * Priority normalization: “high/medium/low” → numeric + due window suggestion.
 * Inventory restock & perishable/animal tasks skew higher by default.
 */
const derivePriority = (t, source) => {
  const declared = (t.priority || "").toLowerCase();

  // seed score
  let score =
    declared === "high" ? 90 :
    declared === "medium" ? 60 :
    declared === "low" ? 30 : 50;

  const text = `${t.name} ${t.task}`.toLowerCase();

  // Heuristics
  if (source === "inventory") score += 25; // restocks are important
  if (source === "animal" && /\bfeed|water|medicat|health|milking\b/.test(text)) score += 25;
  if (source === "garden" && /\btransplant|frost|heat|irrigat|harvest today\b/.test(text)) score += 20;
  if (/\burgent|today|asap|right now\b/.test(text)) score += 30;

  // clamp
  score = Math.max(10, Math.min(100, score));

  // Due window suggestion
  let due = null;
  if (score >= 85) due = addDays(TODAY(), 0);        // today
  else if (score >= 60) due = addDays(TODAY(), 1);   // tomorrow
  else due = addDays(TODAY(), 3);                    // this week

  return { priorityScore: score, dueHint: due };
};

/** Required skill seeds by role to fuel tool matching */
const roleSkills = {
  butcher: ["butchering", "knives", "sanitation", "cold-storage"],
  milker: ["milking", "animal-handling", "sanitation"],
  "farm hand": ["animal-handling", "feeding", "lifting"],
  gardener: ["pruning", "planting", "harvesting", "irrigation"],
  "stock keeper": ["inventory", "lifting", "organization"],
  cleaner: ["cleaning", "sanitation", "organization"],
  cook: ["cooking", "batching", "sanitation", "canning"],
  handyperson: ["tools", "repair", "measuring"],
  general: ["general-labor"]
};

const normalizeSkills = (task) => {
  const role = task.recommendedRole || inferRole(task);
  const base = roleSkills[role] || ["general-labor"];
  const extra = task.requiredSkills || [];
  // Unique
  return Array.from(new Set([...base, ...extra]));
};

/** ---------- Source adapters → unified format ---------- */

const adaptReminder = (r) => ({
  icon: "⏰",
  id: stableId("reminder", r),
  name: r.label || "Reminder",
  task: r.message || "",
  priority: "medium",
  source: "reminder",
  recommendedRole: "scheduler",
  requiredSkills: ["scheduling", "calendar"],
});

const adaptInventory = (inv) => ({
  icon: "📦",
  id: stableId("inventory", inv),
  name: inv.name,
  task: `Restock ${inv.name}${inv.minQty ? ` (min: ${inv.minQty})` : ""}`,
  priority: "high",
  source: "inventory",
  recommendedRole: "stock keeper",
  requiredSkills: ["inventory", "lifting", "organization"],
  metadata: {
    currentQty: inv.currentQty,
    minQty: inv.minQty,
    substitutes: inv.substitutes || [], // if InventoryMonitor exposes suggestions
    location: inv.location || null,
  },
});

const adaptGeneric = (task, source) => ({
  icon: task.icon || (source === "animal" ? "🐑" : source === "garden" ? "🌱" : "🧩"),
  id: stableId(source, task),
  name: task.name || task.label || "Task",
  task: task.task || task.description || "",
  priority: task.priority || "medium",
  source,
  recommendedRole: inferRole(task),
  requiredSkills: task.requiredSkills || [],
  metadata: task.metadata || {},
});

/** Deduplicate by (id) or (name+source) */
const dedupe = (arr) => {
  const seen = new Set();
  return arr.filter((t) => {
    const key = t.id || `${t.source}:${(t.name || "").toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** ---------- Main API ---------- */

const WorkerTasks = {
  /**
   * Gather all unassigned, actionable tasks from agents/managers,
   * normalize + enrich them for the UI.
   */
  async generateAllUnassignedTasks() {
    // Pull raw feeds (guard each call so one failure doesn’t break the list)
    const [
      animalTasksRaw,
      gardenTasksRaw,
      inventoryAlertsRaw,
      reminderTasksRaw,
      cleaningTasksRaw,
      batchCookRaw,
    ] = await Promise.all([
      safeCall(() => AnimalQueueManager.getQueueFormattedForUI()),
      safeCall(() => GardenQueueManager.getQueueFormattedForUI()),
      safeCall(() => InventoryMonitor.getLowInventoryAlerts()),
      safeCall(() => ReminderManager.getAllReminders()),
      safeCall(() => CleaningQueueManager?.getQueueFormattedForUI?.()),
      safeCall(() => BatchCookingManager?.getTaskQueueForUI?.()),
    ]);

    // Adapt
    const reminders = (reminderTasksRaw || []).map(adaptReminder);
    const inventory = (inventoryAlertsRaw || []).map(adaptInventory);
    const animals = (animalTasksRaw || []).map((t) => adaptGeneric(t, "animal"));
    const garden = (gardenTasksRaw || []).map((t) => adaptGeneric(t, "garden"));
    const cleaning = (cleaningTasksRaw || []).map((t) => adaptGeneric(t, "cleaning"));
    const cooking = (batchCookRaw || []).map((t) => adaptGeneric(t, "cooking"));

    // Combine & dedupe
    let tasks = dedupe([...animals, ...garden, ...inventory, ...reminders, ...cleaning, ...cooking]);

    // Enrich: role, skills, tool recs, effort, priority & due hint
    const toolInventory = await safeCall(() => DexieDB.tools?.toArray?.()) || [];
    tasks = tasks.map((t) => {
      const recommendedRole = t.recommendedRole || inferRole(t);
      const requiredSkills = normalizeSkills({ ...t, recommendedRole });
      const { minutes, kcal } = estimateEffort(t);
      const { priorityScore, dueHint } = derivePriority(t, t.source);

      const toolMatches = findBestMatchingTools(requiredSkills, toolInventory) || [];
      const recommendedTools = toolMatches.slice(0, 6).map((x) => x.name);

      return {
        ...t,
        recommendedRole,
        requiredSkills,
        effort: { minutes, kcal },
        priorityScore,
        dueHint,
        recommendedTools,
        // for UI filtering/grouping:
        zone: t.metadata?.zone || null, // garden/animal location (future map tie-in)
        location: t.metadata?.location || null,
      };
    });

    // Sort: priority first, then source bucket
    tasks.sort((a, b) => b.priorityScore - a.priorityScore || a.source.localeCompare(b.source));

    return tasks;
  },

  /**
   * Assign a task to a worker or role, with tool suggestions and due-date hinting.
   * Persists into workerSessions for compatibility (each assignment is a “session” row).
   */
  async assignTaskToWorker({ taskId, task, assignedTo = null, role = null, due = null }) {
    const toolInventory = await (DexieDB.tools?.toArray?.() ?? []);
    const recommendedTools = findBestMatchingTools(task.requiredSkills || [], toolInventory).map((t) => t.name);

    const id = taskId || task.id || stableId(task.source || "manual", task);

    const assignment = {
      id,                                 // keep stable if re-assigning/updating
      workerId: assignedTo || null,       // matches workerSessions schema
      role: role || task.recommendedRole || inferRole(task),
      date: new Date().toISOString(),     // matches workerSessions schema
      tasks: [
        {
          label: task.name,
          details: task.task,
          source: task.source || "manual",
          requiredSkills: task.requiredSkills || [],
          recommendedTools,
          effort: task.effort || estimateEffort(task),
          priorityScore: task.priorityScore || derivePriority(task, task.source).priorityScore,
        },
      ],
      status: "pending",
      // Extended fields your UI can read (safe to ignore elsewhere)
      meta: {
        due: (due || task.dueHint || null) ? new Date(due || task.dueHint).toISOString() : null,
        location: task.location || task.metadata?.location || null,
        zone: task.zone || task.metadata?.zone || null,
      },
    };

    await DexieDB.workerSessions.put(assignment);
    return assignment;
  },

  /**
   * Get all current assignments (sessions-as-assignments).
   */
  async getAssignedTasks() {
    const rows = await DexieDB.workerSessions.toArray();
    // Normalize to a flat “assignment” shape for UI components
    return rows.map((row) => ({
      id: row.id,
      assignedTo: row.workerId || null,
      role: row.role || "general",
      status: row.status || "pending",
      createdAt: row.date ? new Date(row.date) : null,
      due: row.meta?.due ? new Date(row.meta.due) : null,
      label: row.tasks?.[0]?.label || "Task",
      details: row.tasks?.[0]?.details || "",
      source: row.tasks?.[0]?.source || "manual",
      requiredSkills: row.tasks?.[0]?.requiredSkills || [],
      recommendedTools: row.tasks?.[0]?.recommendedTools || [],
      effort: row.tasks?.[0]?.effort || { minutes: 20, kcal: 60 },
      priorityScore: row.tasks?.[0]?.priorityScore ?? 50,
      location: row.meta?.location || null,
      zone: row.meta?.zone || null,
    }));
  },

  /**
   * Filter assigned tasks for a specific worker or role.
   */
  async getTasksFor({ workerId = null, role = null, status = null }) {
    let all = await this.getAssignedTasks();
    if (workerId) all = all.filter((t) => (t.assignedTo || null) === workerId);
    if (role) all = all.filter((t) => (t.role || "general") === role);
    if (status) all = all.filter((t) => (t.status || "pending") === status);
    return all;
  },

  /**
   * Update task status.
   */
  async updateTaskStatus(assignmentId, status) {
    const row = await DexieDB.workerSessions.get(assignmentId);
    if (!row) return null;
    row.status = status;
    row.updatedAt = new Date().toISOString();
    await DexieDB.workerSessions.put(row);
    return {
      id: row.id,
      status: row.status,
      updatedAt: row.updatedAt,
    };
  },

  /**
   * Kanban-friendly grouping for UI:
   *  - byStatus: { pending: [...], in_progress: [...], completed: [...] }
   *  - byRole:   { gardener: [...], butcher: [...], ... }
   *  - bySource: { animal: [...], garden: [...], ... }
   */
  async getKanbanData() {
    const assigned = await this.getAssignedTasks();

    const byStatus = groupBy(assigned, (t) => t.status || "pending");
    const byRole = groupBy(assigned, (t) => t.role || "general");
    const bySource = groupBy(assigned, (t) => t.source || "manual");

    // Columns sorted by priority inside
    Object.values(byStatus).forEach((col) => col.sort((a, b) => b.priorityScore - a.priorityScore));
    Object.values(byRole).forEach((col) => col.sort((a, b) => b.priorityScore - a.priorityScore));
    Object.values(bySource).forEach((col) => col.sort((a, b) => b.priorityScore - a.priorityScore));

    return { byStatus, byRole, bySource };
  },

  /**
   * Convenience: bulk-assign top N urgent tasks to a role or a worker.
   */
  async bulkAssignTop({ count = 5, role = null, workerId = null }) {
    const unassigned = await this.generateAllUnassignedTasks();
    const top = unassigned.slice(0, count);

    const results = [];
    for (const t of top) {
      const res = await this.assignTaskToWorker({
        taskId: t.id,
        task: t,
        assignedTo: workerId || null,
        role: role || t.recommendedRole,
        due: t.dueHint || null,
      });
      results.push(res);
    }
    return results;
  },
};

/** ---------- Small utilities ---------- */

function groupBy(arr, fn) {
  return arr.reduce((acc, item) => {
    const k = fn(item);
    (acc[k] ||= []).push(item);
    return acc;
  }, {});
}

async function safeCall(fn) {
  try {
    const res = await fn();
    return res || [];
  } catch (err) {
    console.warn("[WorkerTasks] source fetch failed:", err?.message || err);
    return [];
  }
}

export default WorkerTasks;
