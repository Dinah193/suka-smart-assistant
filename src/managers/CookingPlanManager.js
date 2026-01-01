// src/managers/CookingPlanManager.js

import { v4 as uuidv4 } from "uuid";

/**
 * LocalStorage keys & schema versioning
 */
const STORAGE_KEY = "suka_cooking_plans";
const STORAGE_VER_KEY = "suka_cooking_plans_version";
const SCHEMA_VERSION = 2;

/* -----------------------------------------------------------------------------
 * Utilities
 * -------------------------------------------------------------------------- */
const iso = (d) => (d instanceof Date ? d.toISOString() : new Date(d || Date.now()).toISOString());
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const toInt = (v, def = 0) => (Number.isFinite(+v) ? +v : def);

function safeParse(json, fallback) {
  try {
    return json ? JSON.parse(json) : fallback;
  } catch {
    return fallback;
  }
}

function emitPlansUpdated() {
  try {
    const s = typeof window !== "undefined" ? window.__SUKA_SOCKET__ : null;
    if (s?.connected) s.emit("COOKING:PLANS_UPDATED", { at: iso() });
  } catch {
    /* noop */
  }
}

/* -----------------------------------------------------------------------------
 * Migrations (v1 -> v2)
 * -------------------------------------------------------------------------- */
function normalizePlanV2(p) {
  const now = iso();
  const plan = {
    id: p.id || uuidv4(),
    title: p.title || "Untitled Plan",
    createdAt: p.createdAt || now,
    // Keep originals
    recipes: Array.isArray(p.recipes) ? p.recipes : [],
    tasks: Array.isArray(p.tasks)
      ? p.tasks.map((t) => ({
          id: t.id || uuidv4(),
          name: t.name || "Task",
          recipeId: t.recipeId || null,
          estMinutes: clamp(toInt(t.estMinutes ?? t.estimate ?? 10, 10), 1, 24 * 60),
          dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn : [], // taskId[]
          notes: t.notes || "",
          label: t.label || null, // printable label text (if any)
          kind: t.kind || "prep", // "prep"|"cook"|"cool"|"pack"|"clean"
        }))
      : [],
    // New fields (non-breaking defaults)
    status: p.status || "draft", // "draft"|"scheduled"|"active"|"done"|"archived"
    progressPct: clamp(toInt(p.progressPct ?? 0), 0, 100),
    session: {
      startISO: p.session?.startISO || null,
      endISO: p.session?.endISO || null,
      // optional schedule string "RRULE:FREQ=WEEKLY;BYDAY=SU;BYHOUR=13;BYMINUTE=0"
      schedule: p.session?.schedule || p.schedule || null,
    },
    labels: {
      // printable labels bundle url or blob ref (filled by generator elsewhere)
      pdfUrl: p.labels?.pdfUrl || null,
      count: toInt(p.labels?.count || 0),
    },
    meta: {
      source: (p.meta && p.meta.source) || "local",
      updatedAt: now,
      notes: (p.meta && p.meta.notes) || "",
    },
  };
  return plan;
}

function migrateToV2(plans) {
  return (plans || []).map(normalizePlanV2);
}

/* -----------------------------------------------------------------------------
 * Storage
 * -------------------------------------------------------------------------- */
function loadCookingPlansRaw() {
  const raw = localStorage.getItem(STORAGE_KEY);
  const verRaw = localStorage.getItem(STORAGE_VER_KEY);
  const ver = parseInt(verRaw || "1", 10) || 1;

  let plans = safeParse(raw, []);

  if (ver < 2) {
    plans = migrateToV2(plans);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(plans));
    localStorage.setItem(STORAGE_VER_KEY, String(SCHEMA_VERSION));
  } else {
    // Ensure any stray records are normalized
    plans = plans.map(normalizePlanV2);
  }

  return plans;
}

function saveCookingPlansRaw(plans) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(plans));
  localStorage.setItem(STORAGE_VER_KEY, String(SCHEMA_VERSION));
  emitPlansUpdated();
}

/* -----------------------------------------------------------------------------
 * Public (backward-compatible) base API
 * -------------------------------------------------------------------------- */

/**
 * Load all cooking plans from localStorage
 * @returns {Array} Array of cooking plans (v2 normalized)
 */
function loadCookingPlans() {
  return loadCookingPlansRaw();
}

/**
 * Save all cooking plans to localStorage
 * @param {Array} plans - Array of cooking plans to save
 */
function saveCookingPlans(plans) {
  const normalized = (plans || []).map(normalizePlanV2);
  saveCookingPlansRaw(normalized);
}

/**
 * Create a new empty cooking plan
 * @param {String} title - Name of the batch session
 * @returns {Object} New cooking plan (v2 shape)
 */
function createCookingPlan(title = "Untitled Plan") {
  return normalizePlanV2({
    id: uuidv4(),
    title,
    createdAt: iso(),
    recipes: [],
    tasks: [],
    status: "draft",
    progressPct: 0,
    session: { startISO: null, endISO: null, schedule: null },
    labels: { pdfUrl: null, count: 0 },
    meta: { source: "local", notes: "", updatedAt: iso() },
  });
}

/**
 * Add a recipe to an existing plan
 * @param {Object} plan
 * @param {Object} recipe
 */
function addRecipeToPlan(plan, recipe) {
  if (!plan.recipes.some((r) => r.id === recipe.id)) {
    plan.recipes.push(recipe);
    plan.meta.updatedAt = iso();
  }
}

/**
 * Remove a recipe from a plan
 * @param {Object} plan
 * @param {String} recipeId
 */
function removeRecipeFromPlan(plan, recipeId) {
  plan.recipes = plan.recipes.filter((r) => r.id !== recipeId);
  plan.meta.updatedAt = iso();
}

/**
 * Add a task to a plan
 * @param {Object} plan
 * @param {Object} task
 */
function addTaskToPlan(plan, task) {
  plan.tasks.push({
    ...task,
    id: uuidv4(),
    estMinutes: clamp(toInt(task?.estMinutes ?? 10, 10), 1, 24 * 60),
    dependsOn: Array.isArray(task?.dependsOn) ? task.dependsOn : [],
    kind: task?.kind || "prep",
  });
  plan.meta.updatedAt = iso();
}

/**
 * Delete a cooking plan by ID
 * @param {String} planId
 */
function deleteCookingPlan(planId) {
  const allPlans = loadCookingPlansRaw();
  const filtered = allPlans.filter((p) => p.id !== planId);
  saveCookingPlansRaw(filtered);
}

/**
 * Update or insert a cooking plan (upsert)
 * @param {Object} updatedPlan
 */
function upsertCookingPlan(updatedPlan) {
  const plans = loadCookingPlansRaw();
  const normalized = normalizePlanV2(updatedPlan);
  const index = plans.findIndex((p) => p.id === normalized.id);
  if (index >= 0) {
    plans[index] = { ...plans[index], ...normalized, meta: { ...plans[index].meta, ...normalized.meta, updatedAt: iso() } };
  } else {
    plans.push(normalized);
  }
  saveCookingPlansRaw(plans);
}

/**
 * Get a single cooking plan by ID
 * @param {String} planId
 * @returns {Object|null}
 */
function getCookingPlanById(planId) {
  const plans = loadCookingPlansRaw();
  return plans.find((p) => p.id === planId) || null;
}

/* -----------------------------------------------------------------------------
 * New: Planner helpers, runtime, schedule, stats
 * -------------------------------------------------------------------------- */

/** Reorder tasks by an array of taskIds */
function reorderTasks(plan, newOrderIds = []) {
  const idToTask = new Map(plan.tasks.map((t) => [t.id, t]));
  const reordered = newOrderIds.map((id) => idToTask.get(id)).filter(Boolean);
  const leftovers = plan.tasks.filter((t) => !newOrderIds.includes(t.id));
  plan.tasks = [...reordered, ...leftovers];
  plan.meta.updatedAt = iso();
}

/** Mark task complete; returns new progressPct */
function completeTask(plan, taskId, { durationMin = null } = {}) {
  const t = plan.tasks.find((x) => x.id === taskId);
  if (!t) return plan.progressPct;
  if (!t.done) {
    t.done = true;
    t.doneISO = iso();
    if (durationMin != null) t.actualMinutes = toInt(durationMin, t.estMinutes || 10);
    plan.meta.updatedAt = iso();
  }
  plan.progressPct = computeProgress(plan);
  if (plan.progressPct === 100) {
    plan.status = "done";
    plan.session.endISO = plan.session.endISO || iso();
  }
  return plan.progressPct;
}

/** Undo complete */
function undoTask(plan, taskId) {
  const t = plan.tasks.find((x) => x.id === taskId);
  if (!t) return plan.progressPct;
  if (t.done) {
    delete t.done;
    delete t.doneISO;
    delete t.actualMinutes;
    plan.meta.updatedAt = iso();
  }
  plan.progressPct = computeProgress(plan);
  if (plan.status === "done") plan.status = "active";
  return plan.progressPct;
}

/** Compute % complete by minutes (weighted) */
function computeProgress(plan) {
  const tasks = plan.tasks || [];
  const total = tasks.reduce((s, t) => s + (t.estMinutes || 0), 0);
  if (total <= 0) return tasks.length ? Math.round((tasks.filter((t) => t.done).length / tasks.length) * 100) : 0;
  const done = tasks.reduce((s, t) => s + (t.done ? (t.actualMinutes || t.estMinutes || 0) : 0), 0);
  return clamp(Math.round((done / total) * 100), 0, 100);
}

/**
 * Naive dependency-aware scheduler:
 * - Topologically orders tasks using dependsOn[]
 * - Assigns start/end offsets in minutes (single worker stream)
 * Returns array with {id, name, startISO, endISO}
 */
function computeSchedule(plan, { startISO = null } = {}) {
  const start = new Date(startISO || plan.session.startISO || iso());
  const tasks = (plan.tasks || []).map((t) => ({ ...t }));

  // Kahn’s algorithm (simple)
  const inDeg = new Map(tasks.map((t) => [t.id, 0]));
  const graph = new Map(tasks.map((t) => [t.id, []]));
  for (const t of tasks) {
    for (const dep of t.dependsOn || []) {
      inDeg.set(t.id, (inDeg.get(t.id) || 0) + 1);
      if (!graph.has(dep)) graph.set(dep, []);
      graph.get(dep).push(t.id);
    }
  }
  const q = [];
  for (const [id, d] of inDeg.entries()) if (d === 0) q.push(id);
  const ordered = [];
  while (q.length) {
    const id = q.shift();
    ordered.push(id);
    for (const nxt of graph.get(id) || []) {
      inDeg.set(nxt, (inDeg.get(nxt) || 0) - 1);
      if (inDeg.get(nxt) === 0) q.push(nxt);
    }
  }
  // Fallback if cycles: keep original order
  const order = ordered.length === tasks.length ? ordered : tasks.map((t) => t.id);

  const lookup = new Map(tasks.map((t) => [t.id, t]));
  const sched = [];
  let cursor = new Date(start);
  for (const id of order) {
    const t = lookup.get(id);
    // Ensure all deps finished: push cursor if needed
    let depFinish = new Date(start);
    for (const dep of t.dependsOn || []) {
      const depEv = sched.find((e) => e.id === dep);
      if (depEv) depFinish = new Date(Math.max(depFinish.getTime(), new Date(depEv.endISO).getTime()));
    }
    const begin = new Date(Math.max(cursor.getTime(), depFinish.getTime()));
    const end = new Date(begin.getTime() + (t.estMinutes || 10) * 60000);
    sched.push({ id, name: t.name, startISO: begin.toISOString(), endISO: end.toISOString(), kind: t.kind });
    cursor = new Date(end);
  }
  return sched;
}

/** Convert a plan or schedule to calendar events */
function toCalendarEvents(plan, { startISO = null } = {}) {
  const schedule = computeSchedule(plan, { startISO });
  return schedule.map((e) => ({
    id: `${plan.id}:${e.id}:${e.startISO}`,
    title: `🍳 ${plan.title} — ${e.name}`,
    start: e.startISO,
    end: e.endISO,
    metadata: { planId: plan.id, taskId: e.id, kind: e.kind || "prep" },
  }));
}

/** Start & stop sessions */
function startSession(plan, { atISO = iso() } = {}) {
  plan.session.startISO = atISO;
  plan.status = "active";
  plan.meta.updatedAt = iso();
}

function stopSession(plan, { atISO = iso() } = {}) {
  plan.session.endISO = atISO;
  plan.status = plan.progressPct === 100 ? "done" : "scheduled";
  plan.meta.updatedAt = iso();
}

/** Stats & summaries */
function planStats(plan) {
  const t = plan.tasks || [];
  const totalMin = t.reduce((s, x) => s + (x.estMinutes || 0), 0);
  const doneMin = t.reduce((s, x) => s + (x.done ? (x.actualMinutes || x.estMinutes || 0) : 0), 0);
  const done = t.filter((x) => x.done).length;
  const remaining = t.length - done;
  return {
    totalTasks: t.length,
    completedTasks: done,
    remainingTasks: remaining,
    totalMinutes: totalMin,
    completedMinutes: doneMin,
    progressPct: computeProgress(plan),
    started: !!plan.session.startISO,
    finished: plan.status === "done",
    startISO: plan.session.startISO,
    endISO: plan.session.endISO,
  };
}

/** Narration & toast strings */
function narrationFor(plan, taskId) {
  const t = (plan.tasks || []).find((x) => x.id === taskId);
  if (!t) return `Cooking plan "${plan.title}" updated.`;
  return `Cooking: ${t.name} for plan "${plan.title}".`;
}

function toastFor(plan, taskId) {
  const t = (plan.tasks || []).find((x) => x.id === taskId);
  if (!t) return `🍳 ${plan.title} updated`;
  return `🍳 ${t.name} — ${plan.title}`;
}

/* -----------------------------------------------------------------------------
 * Import / Export
 * -------------------------------------------------------------------------- */
function exportPlans() {
  const plans = loadCookingPlansRaw();
  return {
    version: SCHEMA_VERSION,
    exportedAt: iso(),
    count: plans.length,
    plans,
  };
}

function importPlans(payload, { merge = true } = {}) {
  const incoming = Array.isArray(payload?.plans) ? payload.plans : [];
  const normalized = incoming.map(normalizePlanV2);

  let base = merge ? loadCookingPlansRaw() : [];

  // Replace if same id, insert otherwise
  const map = new Map(base.map((p) => [p.id, p]));
  for (const p of normalized) map.set(p.id, p);

  const merged = Array.from(map.values());
  saveCookingPlansRaw(merged);
  return merged.length;
}

/* -----------------------------------------------------------------------------
 * Named exports (backward compatible + new helpers)
 * -------------------------------------------------------------------------- */
export {
  // original
  loadCookingPlans,
  saveCookingPlans,
  createCookingPlan,
  addRecipeToPlan,
  removeRecipeFromPlan,
  addTaskToPlan,
  deleteCookingPlan,
  upsertCookingPlan,
  getCookingPlanById,

  // new (optional) helpers
  reorderTasks,
  completeTask,
  undoTask,
  computeSchedule,
  toCalendarEvents,
  startSession,
  stopSession,
  planStats,
  exportPlans,
  importPlans,
  narrationFor,
  toastFor,
};

/* -----------------------------------------------------------------------------
 * Default export (compat)
 * -------------------------------------------------------------------------- */
export default {
  // original
  loadCookingPlans,
  saveCookingPlans,
  createCookingPlan,
  addRecipeToPlan,
  removeRecipeFromPlan,
  addTaskToPlan,
  deleteCookingPlan,
  upsertCookingPlan,
  getCookingPlanById,

  // new helpers
  reorderTasks,
  completeTask,
  undoTask,
  computeSchedule,
  toCalendarEvents,
  startSession,
  stopSession,
  planStats,
  exportPlans,
  importPlans,
  narrationFor,
  toastFor,
};
