// File: src/services/animals/AnimalPlanStore.js
/**
 * AnimalPlanStore (SSA)
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Local-first (Dexie-backed) store/service for animal plans:
 *      • breeding plans (pairings, timing windows, expected births)
 *      • feeding plans (ration targets, seasonal adjustments)
 *      • health plans (vaccines, deworming schedules, checks)
 *      • task plans (rotations, barn chores, pasture moves)
 *      • butchery plans (target dates, weights, cut-sheet intents)
 *
 *  - Designed to integrate with:
 *      • src/store/AnimalStore (profiles & events)
 *      • src/store/TaskStore (task emission)
 *      • src/services/db.js (Dexie instance)
 *      • Layer Spine / Blueprint Builder (future)
 *
 * Build constraints
 *  - Browser-safe; no Node imports.
 *  - Works even if db tables aren’t present yet:
 *      • falls back to in-memory map
 *      • does not crash build
 *
 * Data model (table `animal_plans`)
 *  {
 *    id: string,
 *    kind: "breeding"|"feeding"|"health"|"tasks"|"butchery"|"custom",
 *    householdId?: string|null,
 *    animalIds?: string[],          // involved animals (optional)
 *    species?: string|null,         // "sheep","goat","cattle"...
 *    title: string,
 *    status: "draft"|"active"|"paused"|"completed"|"archived",
 *    startISO?: string|null,
 *    endISO?: string|null,
 *    cadence?: { rrule?: string, intervalDays?: number, byWeekday?: number[] },
 *    targets?: object,              // plan-specific targets
 *    notes?: string,
 *    tags?: string[],
 *    meta?: object,
 *    createdAtISO: string,
 *    updatedAtISO: string
 *  }
 *
 * Table `animal_plan_events` (optional but recommended)
 *  {
 *    id: string,
 *    planId: string,
 *    timeISO: string,
 *    type: string, // "task.emitted","status.changed","note","metric"
 *    payload?: object
 *  }
 */

import { isPlainObject, isArr, isStr, isNum, deepMerge } from "@/utils/obj";
import { nowISO, toISODate, parseISODate, addDays } from "@/utils/dates";

// Optional dependencies (safe import patterns)
let db = null;
try {
  // eslint-disable-next-line import/no-unresolved
  // NOTE: adjust if your db export path differs
  // Expected: export default db OR named export { db }
  // We handle both.
  // eslint-disable-next-line global-require
  // (Vite ESM) - use dynamic import below in init()
} catch {
  // ignore
}

const SOURCE = "animals.AnimalPlanStore";
const TABLE_PLANS = "animal_plans";
const TABLE_EVENTS = "animal_plan_events";

// Local fallback if Dexie tables not available
const mem = {
  plans: new Map(), // id -> plan
  events: new Map(), // planId -> [event]
};

// Subscriptions
const subs = new Set();

const DEFAULTS = Object.freeze({
  enabled: true,
  tablePlans: TABLE_PLANS,
  tableEvents: TABLE_EVENTS,
  // If you haven’t added tables yet, store still works in-memory.
  requireDexieTables: false,
  // guardrails
  maxTitleLen: 160,
  maxNotesLen: 4000,
  maxTags: 30,
  maxAnimalIds: 200,
});

const state = {
  config: { ...DEFAULTS },
  ready: false,
  lastError: null,
  // resolved db tables if available
  tPlans: null,
  tEvents: null,
};

/* ---------------------------------- API ---------------------------------- */

const AnimalPlanStore = {
  SOURCE,

  configure,
  init,
  isReady,
  getLastError,

  // CRUD
  createPlan,
  upsertPlan,
  updatePlan,
  deletePlan,

  // Read
  getPlan,
  listPlans,
  listPlansByKind,
  listPlansByAnimal,
  listPlansByHousehold,

  // Status & lifecycle
  setStatus,
  archivePlan,
  activatePlan,
  pausePlan,
  completePlan,

  // Events / audit trail
  addEvent,
  listEvents,

  // Utilities
  normalizePlan,
  validatePlan,
  computePlanWindow,
  emitPlannedTasks, // optional helper for TaskStore integration (safe no-op if missing)
  subscribe,

  // Debug
  __debugDump,
};

export default AnimalPlanStore;

/* -------------------------------- Config --------------------------------- */

function configure(partial = {}) {
  if (!isPlainObject(partial)) return { ...state.config };
  state.config = deepMerge({ ...state.config }, partial);
  return { ...state.config };
}

function getLastError() {
  return state.lastError;
}

function isReady() {
  return !!state.ready;
}

/* -------------------------------- Init ----------------------------------- */

/**
 * init()
 * - attempts to resolve Dexie db and tables.
 * - safe to call multiple times.
 */
async function init(opts = {}) {
  if (state.ready) return true;
  if (opts && isPlainObject(opts)) configure(opts);

  state.lastError = null;

  // Try to import db (dynamic import keeps builds safe if file path changes)
  // IMPORTANT: this must be a static string for Vite. Your project uses "@/services/db"
  // in many files; if your actual path is different, adjust here.
  try {
    const mod = await import(/* @vite-ignore */ "@/services/db");
    db = mod?.default || mod?.db || mod;
  } catch {
    db = null;
  }

  // Resolve tables if possible
  try {
    state.tPlans = resolveTable(db, state.config.tablePlans);
    state.tEvents = resolveTable(db, state.config.tableEvents);

    if (state.config.requireDexieTables) {
      if (!state.tPlans)
        throw new Error(`Missing Dexie table: ${state.config.tablePlans}`);
    }

    state.ready = true;
    notify();
    return true;
  } catch (e) {
    state.lastError = {
      code: "init_failed",
      message: e?.message || "init failed",
      stack: e?.stack,
    };
    // Still mark ready because we can fall back to memory store
    state.ready = true;
    notify();
    return false;
  }
}

function resolveTable(dbLike, name) {
  if (!dbLike || !name) return null;
  // Dexie tables are usually accessed as db.tableName or db[name]
  const t =
    dbLike[name] ||
    (typeof dbLike.table === "function" ? dbLike.table(name) : null);
  // crude check: Dexie table has put/get/toArray/where
  if (t && typeof t.put === "function" && typeof t.get === "function") return t;
  return null;
}

/* ------------------------------- Subscribe -------------------------------- */

function subscribe(fn) {
  if (typeof fn !== "function") return () => {};
  subs.add(fn);
  // push initial
  try {
    fn({ type: "ready", ready: state.ready, error: state.lastError });
  } catch {
    // ignore
  }
  return () => subs.delete(fn);
}

function notify(evt = { type: "changed" }) {
  for (const fn of subs) {
    try {
      fn(evt);
    } catch {
      // ignore
    }
  }
}

/* --------------------------------- CRUD ---------------------------------- */

async function createPlan(input) {
  await init();
  const plan = normalizePlan(input, { mode: "create" });
  const v = validatePlan(plan);
  if (!v.ok) throw makeErr("validation_failed", v.message, v.details);

  const saved = await savePlan(plan);
  notify({ type: "plan.created", id: saved.id, plan: saved });
  return saved;
}

async function upsertPlan(input) {
  await init();
  const plan = normalizePlan(input, { mode: "upsert" });
  const v = validatePlan(plan);
  if (!v.ok) throw makeErr("validation_failed", v.message, v.details);

  const saved = await savePlan(plan);
  notify({ type: "plan.upserted", id: saved.id, plan: saved });
  return saved;
}

async function updatePlan(id, patch) {
  await init();
  const pid = normId(id);
  if (!pid) throw makeErr("bad_id", "updatePlan requires id");

  const existing = await getPlan(pid);
  if (!existing) throw makeErr("not_found", "Plan not found", { id: pid });

  const merged = deepMerge({ ...existing }, isPlainObject(patch) ? patch : {});
  const plan = normalizePlan(merged, { mode: "update" });
  const v = validatePlan(plan);
  if (!v.ok) throw makeErr("validation_failed", v.message, v.details);

  const saved = await savePlan(plan);
  notify({ type: "plan.updated", id: saved.id, plan: saved });
  return saved;
}

async function deletePlan(id) {
  await init();
  const pid = normId(id);
  if (!pid) return false;

  // Dexie
  if (state.tPlans) {
    await state.tPlans.delete(pid);
    if (state.tEvents) {
      // best effort: delete events by planId if indexed; otherwise, ignore
      try {
        await state.tEvents.where("planId").equals(pid).delete();
      } catch {
        // ignore
      }
    }
  } else {
    mem.plans.delete(pid);
    mem.events.delete(pid);
  }

  notify({ type: "plan.deleted", id: pid });
  return true;
}

/* --------------------------------- Read ---------------------------------- */

async function getPlan(id) {
  await init();
  const pid = normId(id);
  if (!pid) return null;

  if (state.tPlans) {
    const p = await state.tPlans.get(pid);
    return p ? normalizePlan(p, { mode: "read" }) : null;
  }
  const p = mem.plans.get(pid);
  return p ? normalizePlan(p, { mode: "read" }) : null;
}

async function listPlans(filters = {}) {
  await init();

  const f = normalizeFilters(filters);

  let plans = [];
  if (state.tPlans) {
    plans = await fetchPlansDexie(f);
  } else {
    plans = Array.from(mem.plans.values());
  }

  plans = plans.map((p) => normalizePlan(p, { mode: "read" }));

  plans = applyFilters(plans, f);
  plans = sortPlans(plans, f.sort);

  return plans;
}

async function listPlansByKind(kind, filters = {}) {
  return listPlans({ ...(isPlainObject(filters) ? filters : {}), kind });
}

async function listPlansByAnimal(animalId, filters = {}) {
  const aid = normId(animalId);
  return listPlans({
    ...(isPlainObject(filters) ? filters : {}),
    animalId: aid,
  });
}

async function listPlansByHousehold(householdId, filters = {}) {
  const hid = normId(householdId);
  return listPlans({
    ...(isPlainObject(filters) ? filters : {}),
    householdId: hid,
  });
}

async function fetchPlansDexie(filters) {
  // Attempt indexed queries if possible; fallback to toArray
  const t = state.tPlans;
  if (!t) return [];

  const hasWhere = typeof t.where === "function";
  if (!hasWhere) return await t.toArray();

  try {
    // Prefer householdId index if exists
    if (filters.householdId) {
      try {
        return await t
          .where("householdId")
          .equals(filters.householdId)
          .toArray();
      } catch {
        // ignore
      }
    }
    // Prefer kind index if exists
    if (filters.kind) {
      try {
        return await t.where("kind").equals(filters.kind).toArray();
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }

  return await t.toArray();
}

/* -------------------------- Status & Lifecycle ----------------------------- */

async function setStatus(id, status, meta = {}) {
  const pid = normId(id);
  const s = normStatus(status);
  if (!pid) throw makeErr("bad_id", "setStatus requires id");
  if (!s) throw makeErr("bad_status", "Invalid status", { status });

  const existing = await getPlan(pid);
  if (!existing) throw makeErr("not_found", "Plan not found", { id: pid });

  const updated = await updatePlan(pid, {
    status: s,
    meta: deepMerge(existing.meta || {}, meta),
  });

  await addEvent(pid, "status.changed", {
    from: existing.status,
    to: s,
    ...meta,
  });

  return updated;
}

function archivePlan(id, meta) {
  return setStatus(id, "archived", meta);
}
function activatePlan(id, meta) {
  return setStatus(id, "active", meta);
}
function pausePlan(id, meta) {
  return setStatus(id, "paused", meta);
}
function completePlan(id, meta) {
  return setStatus(id, "completed", meta);
}

/* ------------------------------ Events ------------------------------------- */

async function addEvent(planId, type, payload = {}) {
  await init();
  const pid = normId(planId);
  if (!pid) throw makeErr("bad_id", "addEvent requires planId");
  const t = normKey(type) || "event";

  const ev = {
    id: `ap_evt_${pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    planId: pid,
    timeISO: nowISO ? nowISO() : new Date().toISOString(),
    type: t,
    payload: isPlainObject(payload) ? payload : { value: payload },
  };

  if (state.tEvents) {
    await state.tEvents.put(ev);
  } else {
    const list = mem.events.get(pid) || [];
    list.push(ev);
    mem.events.set(pid, list);
  }

  notify({ type: "plan.event", planId: pid, eventType: t, event: ev });
  return ev;
}

async function listEvents(planId, opts = {}) {
  await init();
  const pid = normId(planId);
  if (!pid) return [];

  let events = [];
  if (state.tEvents) {
    // If indexed by planId, use where
    try {
      events = await state.tEvents.where("planId").equals(pid).toArray();
    } catch {
      // fallback to full scan
      events = (await state.tEvents.toArray()).filter((e) => e.planId === pid);
    }
  } else {
    events = mem.events.get(pid) || [];
  }

  events.sort((a, b) => (a.timeISO > b.timeISO ? 1 : -1));

  const limit = Math.max(0, Math.floor(safeNum(opts.limit, 0)));
  if (limit) events = events.slice(-limit);

  return events;
}

/* ----------------------------- Planning Helpers ---------------------------- */

/**
 * Compute a plan window:
 * - uses plan start/end
 * - or derives end from cadence/targets if possible
 * This does NOT modify plan; it’s a read helper.
 */
export function computePlanWindow(plan, opts = {}) {
  const p = normalizePlan(plan, { mode: "read" });
  if (!p) return null;

  const startISO = toISODate(p.startISO || p.start || null);
  const endISO = toISODate(p.endISO || p.end || null);

  if (startISO && endISO) return { startISO, endISO, derived: false };

  // Derive end from cadence intervalDays + horizonDays
  const horizonDays = Math.max(1, Math.floor(safeNum(opts.horizonDays, 90)));
  if (startISO && !endISO) {
    return {
      startISO,
      endISO: toISODate(addDays(startISO, horizonDays)),
      derived: true,
    };
  }

  // Unknown start -> anchor to today
  const today = toISODate(new Date());
  return {
    startISO: startISO || today,
    endISO: endISO || toISODate(addDays(startISO || today, horizonDays)),
    derived: true,
  };
}

/**
 * emitPlannedTasks(planId, options)
 * - OPTIONAL helper that emits tasks into TaskStore if it exists.
 * - Safe no-op if TaskStore isn't present or doesn't expose expected API.
 *
 * This creates "planned tasks" for upcoming windows, e.g.:
 *  - breeding: pregnancy checks, expected due date prep
 *  - feeding: ration review every N days
 *  - health: vaccine boosters at known intervals
 *
 * You can extend the task templates per plan.kind via options.templates.
 */
async function emitPlannedTasks(planId, options = {}) {
  await init();
  const pid = normId(planId);
  if (!pid) throw makeErr("bad_id", "emitPlannedTasks requires planId");

  const plan = await getPlan(pid);
  if (!plan) throw makeErr("not_found", "Plan not found", { id: pid });

  const window = computePlanWindow(plan, {
    horizonDays: options.horizonDays ?? 60,
  });

  const templates = buildDefaultTaskTemplates(plan, options.templates);
  const tasks = expandTemplatesToTasks(plan, window, templates, options);

  // Try TaskStore
  let TaskStore = null;
  try {
    const mod = await import(/* @vite-ignore */ "@/store/TaskStore");
    TaskStore = mod?.default || mod?.TaskStore || mod;
  } catch {
    TaskStore = null;
  }

  if (!TaskStore || typeof TaskStore.upsert !== "function") {
    // best-effort: store as events so you can reconcile later
    await addEvent(pid, "task.emit.skipped", {
      reason: "TaskStore missing or no upsert()",
      count: tasks.length,
    });
    return { ok: false, emitted: 0, tasks, reason: "TaskStore unavailable" };
  }

  let emitted = 0;
  for (const t of tasks) {
    try {
      await TaskStore.upsert(t);
      emitted += 1;
    } catch {
      // ignore per-task
    }
  }

  await addEvent(pid, "task.emitted", { emitted, count: tasks.length, window });

  return { ok: true, emitted, count: tasks.length, window };
}

/* --------------------------- Task Template Logic --------------------------- */

function buildDefaultTaskTemplates(plan, userTemplates) {
  const base = defaultTemplatesForKind(plan.kind);
  if (!userTemplates) return base;

  // Merge: allow array override/add
  const ut = isArr(userTemplates)
    ? userTemplates
    : isPlainObject(userTemplates)
    ? [userTemplates]
    : [];
  return [...base, ...ut].filter(Boolean);
}

function defaultTemplatesForKind(kind) {
  const k = normKey(kind) || "custom";

  // Each template:
  // { type, title, dueOffsetDays, repeatEveryDays?, tags?, priority? }
  switch (k) {
    case "breeding":
      return [
        {
          type: "note",
          title: "Confirm pairing details",
          dueOffsetDays: 0,
          priority: 0.65,
        },
        {
          type: "health",
          title: "Pregnancy check / condition score",
          dueOffsetDays: 30,
          priority: 0.7,
        },
        {
          type: "prep",
          title: "Prepare birthing area / supplies",
          dueOffsetDays: 135,
          priority: 0.8,
        },
      ];
    case "feeding":
      return [
        {
          type: "feed",
          title: "Review ration + body condition",
          dueOffsetDays: 7,
          repeatEveryDays: 14,
          priority: 0.6,
        },
      ];
    case "health":
      return [
        {
          type: "health",
          title: "Routine health check",
          dueOffsetDays: 7,
          repeatEveryDays: 30,
          priority: 0.65,
        },
      ];
    case "tasks":
      return [
        {
          type: "cleanup",
          title: "Barn/pen deep clean",
          dueOffsetDays: 7,
          repeatEveryDays: 14,
          priority: 0.5,
        },
      ];
    case "butchery":
      return [
        {
          type: "prep",
          title: "Confirm target weight + schedule processing",
          dueOffsetDays: 7,
          priority: 0.75,
        },
        {
          type: "prep",
          title: "Prepare cut sheet + packaging supplies",
          dueOffsetDays: 21,
          priority: 0.7,
        },
      ];
    default:
      return [
        {
          type: "note",
          title: "Review animal plan",
          dueOffsetDays: 7,
          repeatEveryDays: 30,
          priority: 0.5,
        },
      ];
  }
}

function expandTemplatesToTasks(plan, window, templates, options) {
  const start = parseISODate(window.startISO) || new Date();
  const end = parseISODate(window.endISO) || addDays(window.startISO, 60);
  const horizonDays = Math.max(
    1,
    Math.floor(diffDays(toISODate(end), toISODate(start)))
  );

  const out = [];
  for (const tpl of templates) {
    const t = normalizeTemplate(tpl);
    if (!t) continue;

    const due0 = addDays(toISODate(start), t.dueOffsetDays || 0);
    if (!t.repeatEveryDays) {
      if (isWithin(due0, window))
        out.push(makeTaskFromTemplate(plan, due0, t, options));
      continue;
    }

    // repeat within window
    const every = Math.max(1, Math.floor(t.repeatEveryDays));
    for (let d = t.dueOffsetDays || 0; d <= horizonDays; d += every) {
      const due = addDays(toISODate(start), d);
      if (isWithin(due, window))
        out.push(makeTaskFromTemplate(plan, due, t, options));
    }
  }

  // Dedup by id
  const seen = new Set();
  return out.filter((t) => {
    if (!t?.id) return false;
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
}

function normalizeTemplate(tpl) {
  if (!isPlainObject(tpl)) return null;
  const type = normKey(tpl.type) || "note";
  const title = String(tpl.title || "").trim();
  if (!title) return null;

  const dueOffsetDays = Math.floor(safeNum(tpl.dueOffsetDays, 0));
  const repeatEveryDays =
    tpl.repeatEveryDays != null
      ? Math.floor(safeNum(tpl.repeatEveryDays, 0))
      : null;

  return {
    type,
    title,
    dueOffsetDays,
    repeatEveryDays:
      repeatEveryDays && repeatEveryDays > 0 ? repeatEveryDays : null,
    tags: normalizeTags(tpl.tags),
    priority: clamp01(safeNum(tpl.priority, 0.5)),
  };
}

function makeTaskFromTemplate(plan, dueISO, tpl, options) {
  const pid = plan.id;
  const due = toISODate(dueISO);
  const t = normKey(tpl.type);

  const animalIds = isArr(plan.animalIds)
    ? plan.animalIds.map(normId).filter(Boolean)
    : [];

  const id = `task_animalplan_${pid}_${t}_${due}`;
  const tags = uniq([
    "animals",
    "animalplan",
    t,
    normKey(plan.kind),
    ...normalizeTags(plan.tags),
    ...normalizeTags(tpl.tags),
  ]).filter(Boolean);

  return {
    id,
    domain: "animals",
    type: t,
    title: tpl.title,
    dueISO: due,
    status: "open",
    priority: tpl.priority,
    tags,
    meta: {
      planId: pid,
      planKind: plan.kind,
      species: plan.species || null,
      householdId: plan.householdId || null,
      animalIds,
      // allow caller to attach extra metadata
      ...(isPlainObject(options.meta) ? options.meta : {}),
    },
  };
}

function isWithin(dateISO, window) {
  const d = parseISODate(dateISO);
  const s = parseISODate(window.startISO);
  const e = parseISODate(window.endISO);
  if (!d || !s || !e) return true;
  return d >= s && d <= e;
}

/* ----------------------------- Normalization & Validation ------------------- */

function normalizePlan(input, { mode = "read" } = {}) {
  if (!input) return null;

  const cfg = state.config;

  let p = null;
  if (isStr(input)) {
    p = { id: normId(input), title: "Animal Plan", kind: "custom" };
  } else if (isPlainObject(input)) {
    p = { ...input };
  } else {
    return null;
  }

  const id = normId(p.id || p.key || p.planId || "");
  const titleRaw = String(p.title || p.name || "").trim();
  const title = titleRaw ? titleRaw.slice(0, cfg.maxTitleLen) : "Animal Plan";

  const kind = normKind(p.kind || p.type || "custom");
  const status = normStatus(
    p.status || (mode === "create" ? "draft" : "active")
  );

  const householdId = normId(p.householdId || p.houseId || null) || null;
  const species =
    normKey(p.species || p.animalType || p.speciesKey || "") || null;

  const animalIds = normalizeIds(p.animalIds || p.animals || []);
  const tags = normalizeTags(p.tags);

  const startISO = toISODate(p.startISO || p.start || null) || null;
  const endISO = toISODate(p.endISO || p.end || null) || null;

  const cadence = normalizeCadence(p.cadence);
  const targets = isPlainObject(p.targets) ? p.targets : {};
  const notes = String(p.notes || "").slice(0, cfg.maxNotesLen);

  const now = nowISO ? nowISO() : new Date().toISOString();
  const createdAtISO = toISODate(p.createdAtISO || p.createdAt || null) || now;
  const updatedAtISO = now;

  const meta = isPlainObject(p.meta) ? p.meta : {};

  return {
    ...p,
    id:
      id ||
      (mode === "create"
        ? `ap_${Date.now()}_${Math.random().toString(16).slice(2)}`
        : id),
    kind,
    title,
    status,
    householdId,
    species,
    animalIds,
    startISO,
    endISO,
    cadence,
    targets,
    notes,
    tags,
    meta,
    createdAtISO,
    updatedAtISO,
  };
}

function validatePlan(plan) {
  if (!plan || !isPlainObject(plan))
    return { ok: false, message: "Plan missing", details: {} };
  if (!normId(plan.id))
    return { ok: false, message: "Plan id required", details: { id: plan.id } };
  if (!plan.title || !String(plan.title).trim())
    return { ok: false, message: "Plan title required", details: {} };
  if (!normKind(plan.kind))
    return { ok: false, message: "Invalid kind", details: { kind: plan.kind } };
  if (!normStatus(plan.status))
    return {
      ok: false,
      message: "Invalid status",
      details: { status: plan.status },
    };

  if (plan.startISO && plan.endISO) {
    const s = parseISODate(plan.startISO);
    const e = parseISODate(plan.endISO);
    if (s && e && e < s)
      return { ok: false, message: "endISO must be >= startISO", details: {} };
  }

  if (plan.animalIds && plan.animalIds.length > state.config.maxAnimalIds) {
    return {
      ok: false,
      message: `Too many animalIds (max ${state.config.maxAnimalIds})`,
      details: { count: plan.animalIds.length },
    };
  }

  if (plan.tags && plan.tags.length > state.config.maxTags) {
    return {
      ok: false,
      message: `Too many tags (max ${state.config.maxTags})`,
      details: { count: plan.tags.length },
    };
  }

  return { ok: true };
}

function normalizeCadence(cadence) {
  if (!isPlainObject(cadence)) return null;
  const out = {};
  if (isStr(cadence.rrule)) out.rrule = String(cadence.rrule).trim();
  if (isNum(cadence.intervalDays))
    out.intervalDays = Math.max(1, Math.floor(Number(cadence.intervalDays)));
  if (isArr(cadence.byWeekday))
    out.byWeekday = cadence.byWeekday.map((n) =>
      Math.max(0, Math.min(6, Math.floor(n)))
    );
  return Object.keys(out).length ? out : null;
}

/* ------------------------------ Persistence -------------------------------- */

async function savePlan(plan) {
  const p = normalizePlan(plan, { mode: "upsert" });
  const v = validatePlan(p);
  if (!v.ok) throw makeErr("validation_failed", v.message, v.details);

  if (state.tPlans) {
    await state.tPlans.put(p);
    return p;
  }

  mem.plans.set(p.id, p);
  return p;
}

/* ------------------------------- Filters ----------------------------------- */

function normalizeFilters(filters) {
  const f = isPlainObject(filters) ? filters : {};
  const out = {
    householdId: normId(f.householdId || f.houseId || null) || null,
    kind: normKind(f.kind || f.type || null) || null,
    status: f.status ? normStatus(f.status) : null,
    animalId: normId(f.animalId || null) || null,
    species: f.species ? normKey(f.species) : null,
    search: isStr(f.search) ? f.search.trim().toLowerCase() : "",
    includeArchived: f.includeArchived === true,
    sort: f.sort || "updated_desc", // updated_desc | updated_asc | start_asc | start_desc | title_asc
    limit: f.limit != null ? Math.max(0, Math.floor(safeNum(f.limit, 0))) : 0,
  };
  return out;
}

function applyFilters(plans, f) {
  let out = plans.slice();

  if (f.householdId)
    out = out.filter((p) => (p.householdId || null) === f.householdId);
  if (f.kind) out = out.filter((p) => normKind(p.kind) === f.kind);
  if (f.status) out = out.filter((p) => normStatus(p.status) === f.status);
  if (f.species) out = out.filter((p) => normKey(p.species) === f.species);

  if (!f.includeArchived)
    out = out.filter((p) => normStatus(p.status) !== "archived");

  if (f.animalId) {
    out = out.filter((p) =>
      isArr(p.animalIds) ? p.animalIds.includes(f.animalId) : false
    );
  }

  if (f.search) {
    const q = f.search;
    out = out.filter((p) => {
      const blob = `${p.title || ""} ${p.notes || ""} ${(p.tags || []).join(
        " "
      )}`.toLowerCase();
      return blob.includes(q);
    });
  }

  if (f.limit) out = out.slice(0, f.limit);
  return out;
}

function sortPlans(plans, sortKey) {
  const key = normKey(sortKey || "updated_desc");
  const arr = plans.slice();

  const cmp = (a, b) => (a > b ? 1 : a < b ? -1 : 0);

  arr.sort((A, B) => {
    const a = A || {};
    const b = B || {};

    if (key === "updated_asc")
      return cmp(a.updatedAtISO || "", b.updatedAtISO || "");
    if (key === "updated_desc")
      return cmp(b.updatedAtISO || "", a.updatedAtISO || "");

    if (key === "start_asc") return cmp(a.startISO || "", b.startISO || "");
    if (key === "start_desc") return cmp(b.startISO || "", a.startISO || "");

    if (key === "title_asc")
      return cmp((a.title || "").toLowerCase(), (b.title || "").toLowerCase());

    return cmp(b.updatedAtISO || "", a.updatedAtISO || "");
  });

  return arr;
}

/* ------------------------------- Helpers ----------------------------------- */

function normId(x) {
  const s = String(x || "").trim();
  return s ? s : "";
}

function normKey(x) {
  return String(x || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normKind(kind) {
  const k = normKey(kind);
  if (!k) return "";
  const allowed = [
    "breeding",
    "feeding",
    "health",
    "tasks",
    "butchery",
    "custom",
  ];
  return allowed.includes(k) ? k : "custom";
}

function normStatus(status) {
  const s = normKey(status);
  const allowed = ["draft", "active", "paused", "completed", "archived"];
  return allowed.includes(s) ? s : "";
}

function normalizeIds(ids) {
  const arr = isArr(ids) ? ids : ids ? [ids] : [];
  return uniq(arr.map(normId).filter(Boolean));
}

function normalizeTags(tags) {
  const arr = isArr(tags) ? tags : isStr(tags) ? [tags] : [];
  return uniq(arr.map(normKey).filter(Boolean)).slice(0, state.config.maxTags);
}

function clamp01(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

function safeNum(n, fallback = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

function makeErr(code, message, details) {
  const e = new Error(message || code || "error");
  e.code = code || "error";
  if (details) e.details = details;
  return e;
}

function uniq(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr || []) {
    if (!x) continue;
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

function diffDays(aISO, bISO) {
  const a = parseISODate(aISO);
  const b = parseISODate(bISO);
  if (!a || !b) return 0;
  const ms = a.getTime() - b.getTime();
  return Math.round(ms / 86400000);
}

/* ---------------------- Compatibility Named Exports ------------------------ */
/**
 * AnimalPlanner.jsx imports named functions:
 *   import { saveAnimalPlan, loadLatestAnimalPlan } from "../../services/animals/AnimalPlanStore";
 *
 * This module primarily exports a default object store, so we provide
 * browser-safe named wrappers to satisfy those imports.
 */

export async function saveAnimalPlan(plan) {
  // If caller didn't provide an id, use createPlan (upsertPlan requires id)
  const hasId = !!(
    plan &&
    isPlainObject(plan) &&
    normId(plan.id || plan.planId)
  );
  if (hasId) return AnimalPlanStore.upsertPlan(plan);
  return AnimalPlanStore.createPlan(plan);
}

export async function loadLatestAnimalPlan(filters = {}) {
  const f = isPlainObject(filters) ? filters : {};
  const arr = await AnimalPlanStore.listPlans({
    ...f,
    sort: "updated_desc",
    limit: 1,
    includeArchived: f.includeArchived === true,
  });
  return arr && arr.length ? arr[0] : null;
}

/* ------------------------------- Debug ------------------------------------- */

function __debugDump() {
  return {
    source: SOURCE,
    ready: state.ready,
    lastError: state.lastError,
    config: { ...state.config },
    hasDexie: !!db,
    tables: {
      plans: !!state.tPlans,
      events: !!state.tEvents,
      names: {
        plans: state.config.tablePlans,
        events: state.config.tableEvents,
      },
    },
    mem: {
      plans: mem.plans.size,
      eventsPlans: mem.events.size,
    },
    routesHint:
      "Use emitPlannedTasks(planId) to create TaskStore items (requires TaskStore.upsert).",
  };
}
