// File: src/services/gardening/GardenPlanStore.js
/**
 * GardenPlanStore (SSA)
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Browser-only store for garden plans (plantings + tasks + schedules + notes).
 *  - Provides a stable, export-friendly generateSchedule() that produces a
 *    "household steward" task packet (dates, durations, supplies, constraints).
 *  - Safe to import anywhere (no Node imports).
 *
 * Storage
 *  - localStorage (default) with versioned key.
 *  - Optional external persistence can be wired later (Dexie repo) without
 *    changing the store API.
 *
 * Eventing
 *  - Emits SSA events via eventBus:
 *      garden/plan.saved
 *      garden/plan.deleted
 *      garden/plan.activated
 *      garden/plan.task.updated
 *      garden/plan.schedule.generated
 *
 * Notes
 *  - This store is intentionally "fixed logic friendly": it can run with little
 *    to no AI. Any future suggestion service should write to this store.
 */

import { eventBus } from "@/services/events/eventBus";

const SOURCE = "gardening.GardenPlanStore";

/* -------------------------------------------------------------------------- */
/*                                   Config                                   */
/* -------------------------------------------------------------------------- */

const STORAGE_KEY = "ssa.gardenPlanStore.v1";
const MAX_PLANS = 50;

const DEFAULT_TIMEZONE =
  (typeof Intl !== "undefined" &&
    Intl.DateTimeFormat &&
    Intl.DateTimeFormat().resolvedOptions &&
    Intl.DateTimeFormat().resolvedOptions().timeZone) ||
  "UTC";

/* -------------------------------------------------------------------------- */
/*                                    Utils                                   */
/* -------------------------------------------------------------------------- */

function nowISO() {
  return new Date().toISOString();
}

function genId(prefix = "gp") {
  return `${prefix}_${Math.random()
    .toString(36)
    .slice(2)}_${Date.now().toString(36)}`;
}

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function safeString(v) {
  return String(v ?? "");
}

function asInt(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

function clamp(n, min, max) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : min;
}

function deepClone(obj) {
  try {
    return structuredClone(obj);
  } catch {
    return JSON.parse(JSON.stringify(obj || {}));
  }
}

function toDayKeyLocal(isoOrDate, tz = DEFAULT_TIMEZONE) {
  // We keep it simple: use local date components from Date.
  // If you later need strict TZ conversion, you can add a TZ utility.
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(dayKey, delta) {
  const d = new Date(`${dayKey}T12:00:00`);
  d.setDate(d.getDate() + delta);
  return toDayKeyLocal(d.toISOString());
}

function parseDayKey(dayKey) {
  // dayKey: YYYY-MM-DD
  if (!dayKey || !/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) return null;
  const d = new Date(`${dayKey}T12:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function stableSortBy(arr, keyFn) {
  return (arr || [])
    .map((v, i) => ({ v, i, k: keyFn(v) }))
    .sort((a, b) => {
      if (a.k < b.k) return -1;
      if (a.k > b.k) return 1;
      return a.i - b.i;
    })
    .map((x) => x.v);
}

function emit(type, data, opts = {}) {
  try {
    eventBus?.emit?.(type, data, { source: SOURCE, ...(opts || {}) });
  } catch {
    // noop
  }
}

/* -------------------------------------------------------------------------- */
/*                              Data Model (v1)                               */
/* -------------------------------------------------------------------------- */

/**
 * GardenPlan
 * -----------------------------------------------------------------------------
 * {
 *   id, name,
 *   createdAtISO, updatedAtISO,
 *   timezone,
 *   year, seasonLabel?,
 *
 *   householdId?, actorId?,
 *
 *   constraints: {
 *     doNot: string[],
 *     preferredSupplies: string[],        // user preferred brands/products
 *     notes: string
 *   },
 *
 *   beds: [{ id, name, size, units, locationNotes?, soilNotes? }],
 *
 *   crops: [{
 *     id,
 *     name, variety?,
 *     bedId?,
 *     startMethod: "seed"|"transplant"|"set"|"cutting"|"unknown",
 *     plantedOn?: "YYYY-MM-DD",
 *     expectedHarvestFrom?: "YYYY-MM-DD",
 *     expectedHarvestTo?: "YYYY-MM-DD",
 *     spacingNotes?,
 *     waterNeeds?: "low"|"medium"|"high"|"unknown",
 *     sunNeeds?: "full"|"part"|"shade"|"unknown",
 *     tags?: string[]
 *   }],
 *
 *   tasks: [{
 *     id,
 *     title,
 *     detailSteps: string[],              // checklists
 *     durationMin?: number,
 *     supplies: string[],
 *     doNot: string[],                    // task-level constraints
 *     cropId?, bedId?,
 *     // scheduling:
 *     schedule: {
 *       kind: "once"|"range"|"recurring",
 *       date?: "YYYY-MM-DD",
 *       start?: "YYYY-MM-DD",
 *       end?: "YYYY-MM-DD",
 *       recurrence?: {
 *         freq: "daily"|"weekly"|"biweekly"|"monthly",
 *         interval?: number,
 *         byWeekday?: number[],           // 0=Sun..6=Sat
 *       }
 *     },
 *     status: {
 *       doneDates: string[],              // list of dayKeys completed
 *       skippedDates: string[],
 *       notes?: string
 *     },
 *     priority?: "low"|"normal"|"high",
 *     tags?: string[]
 *   }],
 *
 *   scheduleOverrides?: {
 *     // optional future expansion: per-day overrides, blackout dates, etc.
 *     blackoutDates?: string[],
 *   }
 * }
 */

/* -------------------------------------------------------------------------- */
/*                               Default State                                */
/* -------------------------------------------------------------------------- */

const defaultState = () => ({
  version: 1,
  hydrated: false,
  dirty: false,
  lastError: null,
  lastSavedISO: null,

  activePlanId: null,
  plans: [],

  // UI helpers (non-persistent)
  ui: {
    lastGenerated: null, // { planId, range, generatedAtISO }
  },
});

/* -------------------------------------------------------------------------- */
/*                                  Store Core                                */
/* -------------------------------------------------------------------------- */

let _state = defaultState();
const _subs = new Set();

function getState() {
  return _state;
}

function setState(updater, meta = {}) {
  const prev = _state;
  const next =
    typeof updater === "function"
      ? updater(prev)
      : { ...prev, ...(updater || {}) };
  _state = next;

  // mark dirty unless explicitly disabled
  if (meta?.markDirty !== false) _state.dirty = true;

  // notify
  for (const fn of Array.from(_subs)) {
    try {
      fn(_state);
    } catch {
      // noop
    }
  }
}

function subscribe(fn) {
  _subs.add(fn);
  return () => _subs.delete(fn);
}

/* -------------------------------------------------------------------------- */
/*                                 Persistence                                */
/* -------------------------------------------------------------------------- */

function _loadFromStorage() {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function _saveToStorage(snapshot) {
  if (typeof localStorage === "undefined") return false;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    return true;
  } catch {
    return false;
  }
}

function _sanitizePlan(plan) {
  const p = isPlainObject(plan) ? deepClone(plan) : {};
  const iso = nowISO();

  p.id = safeString(p.id || genId("plan"));
  p.name = safeString(p.name || "Garden Plan");
  p.createdAtISO = safeString(p.createdAtISO || iso);
  p.updatedAtISO = safeString(p.updatedAtISO || iso);
  p.timezone = safeString(p.timezone || DEFAULT_TIMEZONE);
  p.year = asInt(p.year || new Date().getFullYear(), new Date().getFullYear());
  if (p.seasonLabel != null) p.seasonLabel = safeString(p.seasonLabel);

  p.constraints = isPlainObject(p.constraints) ? p.constraints : {};
  p.constraints.doNot = Array.isArray(p.constraints.doNot)
    ? p.constraints.doNot.map(safeString)
    : [];
  p.constraints.preferredSupplies = Array.isArray(
    p.constraints.preferredSupplies
  )
    ? p.constraints.preferredSupplies.map(safeString)
    : [];
  p.constraints.notes = safeString(p.constraints.notes || "");

  p.beds = Array.isArray(p.beds) ? p.beds : [];
  p.beds = p.beds.map((b) => ({
    id: safeString(b?.id || genId("bed")),
    name: safeString(b?.name || "Bed"),
    size: b?.size ?? "",
    units: safeString(b?.units || ""),
    locationNotes: safeString(b?.locationNotes || ""),
    soilNotes: safeString(b?.soilNotes || ""),
  }));

  p.crops = Array.isArray(p.crops) ? p.crops : [];
  p.crops = p.crops.map((c) => ({
    id: safeString(c?.id || genId("crop")),
    name: safeString(c?.name || "Crop"),
    variety: safeString(c?.variety || ""),
    bedId: c?.bedId ? safeString(c.bedId) : null,
    startMethod: safeString(c?.startMethod || "unknown"),
    plantedOn: c?.plantedOn ? safeString(c.plantedOn) : null,
    expectedHarvestFrom: c?.expectedHarvestFrom
      ? safeString(c.expectedHarvestFrom)
      : null,
    expectedHarvestTo: c?.expectedHarvestTo
      ? safeString(c.expectedHarvestTo)
      : null,
    spacingNotes: safeString(c?.spacingNotes || ""),
    waterNeeds: safeString(c?.waterNeeds || "unknown"),
    sunNeeds: safeString(c?.sunNeeds || "unknown"),
    tags: Array.isArray(c?.tags) ? c.tags.map(safeString) : [],
  }));

  p.tasks = Array.isArray(p.tasks) ? p.tasks : [];
  p.tasks = p.tasks.map((t) => _sanitizeTask(t));

  p.scheduleOverrides = isPlainObject(p.scheduleOverrides)
    ? p.scheduleOverrides
    : {};
  p.scheduleOverrides.blackoutDates = Array.isArray(
    p.scheduleOverrides.blackoutDates
  )
    ? p.scheduleOverrides.blackoutDates.map(safeString)
    : [];

  return p;
}

function _sanitizeTask(task) {
  const t = isPlainObject(task) ? deepClone(task) : {};
  t.id = safeString(t.id || genId("task"));
  t.title = safeString(t.title || "Task");
  t.detailSteps = Array.isArray(t.detailSteps)
    ? t.detailSteps.map(safeString).filter(Boolean)
    : [];
  t.durationMin = clamp(asInt(t.durationMin, 0), 0, 600);
  t.supplies = Array.isArray(t.supplies)
    ? t.supplies.map(safeString).filter(Boolean)
    : [];
  t.doNot = Array.isArray(t.doNot)
    ? t.doNot.map(safeString).filter(Boolean)
    : [];
  t.cropId = t.cropId ? safeString(t.cropId) : null;
  t.bedId = t.bedId ? safeString(t.bedId) : null;
  t.priority = safeString(t.priority || "normal");

  t.tags = Array.isArray(t.tags) ? t.tags.map(safeString).filter(Boolean) : [];

  t.schedule = isPlainObject(t.schedule) ? t.schedule : { kind: "once" };
  t.schedule.kind = safeString(t.schedule.kind || "once");

  if (t.schedule.kind === "once") {
    t.schedule.date = safeString(t.schedule.date || "");
  } else if (t.schedule.kind === "range") {
    t.schedule.start = safeString(t.schedule.start || "");
    t.schedule.end = safeString(t.schedule.end || "");
  } else if (t.schedule.kind === "recurring") {
    t.schedule.start = safeString(t.schedule.start || "");
    t.schedule.end = safeString(t.schedule.end || "");
    t.schedule.recurrence = isPlainObject(t.schedule.recurrence)
      ? t.schedule.recurrence
      : {};
    t.schedule.recurrence.freq = safeString(
      t.schedule.recurrence.freq || "weekly"
    );
    t.schedule.recurrence.interval = clamp(
      asInt(t.schedule.recurrence.interval, 1),
      1,
      365
    );
    t.schedule.recurrence.byWeekday = Array.isArray(
      t.schedule.recurrence.byWeekday
    )
      ? t.schedule.recurrence.byWeekday.map((n) => clamp(asInt(n, 0), 0, 6))
      : [];
  } else {
    // unknown kind -> normalize to once
    t.schedule = { kind: "once", date: "" };
  }

  t.status = isPlainObject(t.status) ? t.status : {};
  t.status.doneDates = Array.isArray(t.status.doneDates)
    ? t.status.doneDates.map(safeString)
    : [];
  t.status.skippedDates = Array.isArray(t.status.skippedDates)
    ? t.status.skippedDates.map(safeString)
    : [];
  t.status.notes = safeString(t.status.notes || "");

  return t;
}

export function hydrate() {
  const loaded = _loadFromStorage();
  if (loaded && isPlainObject(loaded)) {
    setState(
      (prev) => {
        const merged = { ...prev, ...loaded };
        merged.hydrated = true;
        merged.dirty = false;
        merged.lastError = null;

        // sanitize plans
        merged.plans = Array.isArray(merged.plans)
          ? merged.plans.slice(0, MAX_PLANS).map(_sanitizePlan)
          : [];

        // ensure active exists
        if (
          merged.activePlanId &&
          !merged.plans.some((p) => p.id === merged.activePlanId)
        ) {
          merged.activePlanId = merged.plans[0]?.id || null;
        }
        if (!merged.activePlanId && merged.plans[0]?.id)
          merged.activePlanId = merged.plans[0].id;

        return merged;
      },
      { markDirty: false }
    );
    return { ok: true, source: "localStorage" };
  }

  setState((prev) => ({ ...prev, hydrated: true }), { markDirty: false });
  return { ok: true, source: "empty" };
}

export function persistNow() {
  try {
    const snapshot = {
      version: _state.version,
      activePlanId: _state.activePlanId,
      plans: _state.plans,
      lastSavedISO: nowISO(),
    };

    const ok = _saveToStorage(snapshot);

    setState(
      (prev) => ({
        ...prev,
        dirty: ok ? false : prev.dirty,
        lastSavedISO: snapshot.lastSavedISO,
        lastError: ok ? null : "Failed to write localStorage",
      }),
      { markDirty: false }
    );

    return { ok };
  } catch (e) {
    setState((prev) => ({ ...prev, lastError: String(e?.message || e) }), {
      markDirty: false,
    });
    return { ok: false, error: String(e?.message || e) };
  }
}

export function resetStore({ keepPlans = false } = {}) {
  const next = defaultState();
  if (keepPlans) {
    next.plans = _state.plans;
    next.activePlanId = _state.activePlanId;
    next.hydrated = true;
    next.dirty = true;
  }
  _state = next;
  persistNow();
  for (const fn of Array.from(_subs)) {
    try {
      fn(_state);
    } catch {}
  }
}

/* -------------------------------------------------------------------------- */
/*                               Plan CRUD API                                */
/* -------------------------------------------------------------------------- */

export function listPlans() {
  return (_state.plans || []).map((p) => ({
    id: p.id,
    name: p.name,
    year: p.year,
    updatedAtISO: p.updatedAtISO,
  }));
}

export function getPlan(planId) {
  const id = safeString(planId || _state.activePlanId || "");
  return (_state.plans || []).find((p) => p.id === id) || null;
}

export function getActivePlan() {
  return getPlan(_state.activePlanId);
}

export function createPlan(partial = {}) {
  const plan = _sanitizePlan({
    ...partial,
    id: partial?.id || genId("plan"),
    createdAtISO: nowISO(),
    updatedAtISO: nowISO(),
  });

  setState((prev) => {
    const plans = [plan, ...(prev.plans || [])].slice(0, MAX_PLANS);
    return { ...prev, plans, activePlanId: plan.id };
  });

  persistNow();
  emit("garden/plan.saved", { planId: plan.id, plan });

  return plan;
}

export function updatePlan(planId, patchOrUpdater) {
  const id = safeString(planId);
  setState((prev) => {
    const plans = (prev.plans || []).map((p) => {
      if (p.id !== id) return p;
      const next =
        typeof patchOrUpdater === "function"
          ? patchOrUpdater(deepClone(p))
          : { ...p, ...(patchOrUpdater || {}) };
      next.updatedAtISO = nowISO();
      return _sanitizePlan(next);
    });
    return { ...prev, plans };
  });

  persistNow();
  emit("garden/plan.saved", { planId: id });

  return getPlan(id);
}

export function deletePlan(planId) {
  const id = safeString(planId);
  const before = getPlan(id);
  setState((prev) => {
    const plans = (prev.plans || []).filter((p) => p.id !== id);
    let activePlanId = prev.activePlanId;
    if (activePlanId === id) activePlanId = plans[0]?.id || null;
    return { ...prev, plans, activePlanId };
  });

  persistNow();
  emit("garden/plan.deleted", { planId: id, plan: before });

  return { ok: true };
}

export function setActivePlan(planId) {
  const id = safeString(planId);
  if (!id) return { ok: false, error: "Missing planId" };
  if (!(_state.plans || []).some((p) => p.id === id))
    return { ok: false, error: "Plan not found" };

  setState((prev) => ({ ...prev, activePlanId: id }));
  persistNow();
  emit("garden/plan.activated", { planId: id });

  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/*                               Beds / Crops API                             */
/* -------------------------------------------------------------------------- */

export function addBed(planId, bedPartial = {}) {
  return updatePlan(planId, (p) => {
    const bed = {
      id: genId("bed"),
      name: safeString(bedPartial.name || "Bed"),
      size: bedPartial.size ?? "",
      units: safeString(bedPartial.units || ""),
      locationNotes: safeString(bedPartial.locationNotes || ""),
      soilNotes: safeString(bedPartial.soilNotes || ""),
    };
    p.beds = Array.isArray(p.beds) ? p.beds : [];
    p.beds.unshift(bed);
    return p;
  });
}

export function updateBed(planId, bedId, patch = {}) {
  return updatePlan(planId, (p) => {
    p.beds = (p.beds || []).map((b) =>
      b.id === bedId ? { ...b, ...(patch || {}) } : b
    );
    return p;
  });
}

export function deleteBed(planId, bedId) {
  return updatePlan(planId, (p) => {
    p.beds = (p.beds || []).filter((b) => b.id !== bedId);
    // also detach crops/tasks
    p.crops = (p.crops || []).map((c) =>
      c.bedId === bedId ? { ...c, bedId: null } : c
    );
    p.tasks = (p.tasks || []).map((t) =>
      t.bedId === bedId ? { ...t, bedId: null } : t
    );
    return p;
  });
}

export function addCrop(planId, cropPartial = {}) {
  return updatePlan(planId, (p) => {
    const crop = {
      id: genId("crop"),
      name: safeString(cropPartial.name || "Crop"),
      variety: safeString(cropPartial.variety || ""),
      bedId: cropPartial.bedId ? safeString(cropPartial.bedId) : null,
      startMethod: safeString(cropPartial.startMethod || "unknown"),
      plantedOn: cropPartial.plantedOn
        ? safeString(cropPartial.plantedOn)
        : null,
      expectedHarvestFrom: cropPartial.expectedHarvestFrom
        ? safeString(cropPartial.expectedHarvestFrom)
        : null,
      expectedHarvestTo: cropPartial.expectedHarvestTo
        ? safeString(cropPartial.expectedHarvestTo)
        : null,
      spacingNotes: safeString(cropPartial.spacingNotes || ""),
      waterNeeds: safeString(cropPartial.waterNeeds || "unknown"),
      sunNeeds: safeString(cropPartial.sunNeeds || "unknown"),
      tags: Array.isArray(cropPartial.tags)
        ? cropPartial.tags.map(safeString)
        : [],
    };
    p.crops = Array.isArray(p.crops) ? p.crops : [];
    p.crops.unshift(crop);
    return p;
  });
}

export function updateCrop(planId, cropId, patch = {}) {
  return updatePlan(planId, (p) => {
    p.crops = (p.crops || []).map((c) =>
      c.id === cropId ? { ...c, ...(patch || {}) } : c
    );
    return p;
  });
}

export function deleteCrop(planId, cropId) {
  return updatePlan(planId, (p) => {
    p.crops = (p.crops || []).filter((c) => c.id !== cropId);
    // also detach tasks
    p.tasks = (p.tasks || []).map((t) =>
      t.cropId === cropId ? { ...t, cropId: null } : t
    );
    return p;
  });
}

/* -------------------------------------------------------------------------- */
/*                                 Tasks API                                  */
/* -------------------------------------------------------------------------- */

export function addTask(planId, taskPartial = {}) {
  return updatePlan(planId, (p) => {
    const t = _sanitizeTask({
      ...taskPartial,
      id: genId("task"),
      status: {
        doneDates: [],
        skippedDates: [],
        notes: safeString(taskPartial?.status?.notes || ""),
      },
    });
    p.tasks = Array.isArray(p.tasks) ? p.tasks : [];
    p.tasks.unshift(t);
    return p;
  });
}

export function updateTask(planId, taskId, patchOrUpdater) {
  const id = safeString(taskId);
  const plan = getPlan(planId);
  if (!plan) return null;

  const next = updatePlan(plan.id, (p) => {
    p.tasks = (p.tasks || []).map((t) => {
      if (t.id !== id) return t;
      const merged =
        typeof patchOrUpdater === "function"
          ? patchOrUpdater(deepClone(t))
          : { ...t, ...(patchOrUpdater || {}) };
      return _sanitizeTask(merged);
    });
    return p;
  });

  emit("garden/plan.task.updated", { planId: safeString(planId), taskId: id });
  return next;
}

export function deleteTask(planId, taskId) {
  return updatePlan(planId, (p) => {
    p.tasks = (p.tasks || []).filter((t) => t.id !== taskId);
    return p;
  });
}

export function markTaskDone(planId, taskId, dayKey = null) {
  const plan = getPlan(planId);
  if (!plan) return null;
  const dk = safeString(dayKey || toDayKeyLocal(nowISO(), plan.timezone));
  return updateTask(plan.id, taskId, (t) => {
    t.status = isPlainObject(t.status)
      ? t.status
      : { doneDates: [], skippedDates: [] };
    t.status.doneDates = Array.isArray(t.status.doneDates)
      ? t.status.doneDates
      : [];
    if (!t.status.doneDates.includes(dk)) t.status.doneDates.push(dk);
    // remove from skipped if present
    t.status.skippedDates = (t.status.skippedDates || []).filter(
      (x) => x !== dk
    );
    return t;
  });
}

export function markTaskSkipped(planId, taskId, dayKey = null) {
  const plan = getPlan(planId);
  if (!plan) return null;
  const dk = safeString(dayKey || toDayKeyLocal(nowISO(), plan.timezone));
  return updateTask(plan.id, taskId, (t) => {
    t.status = isPlainObject(t.status)
      ? t.status
      : { doneDates: [], skippedDates: [] };
    t.status.skippedDates = Array.isArray(t.status.skippedDates)
      ? t.status.skippedDates
      : [];
    if (!t.status.skippedDates.includes(dk)) t.status.skippedDates.push(dk);
    // remove from done if present
    t.status.doneDates = (t.status.doneDates || []).filter((x) => x !== dk);
    return t;
  });
}

/* -------------------------------------------------------------------------- */
/*                           Schedule Generation (Export)                      */
/* -------------------------------------------------------------------------- */

/**
 * Expand a task's schedule into date occurrences within [fromDayKey, toDayKey].
 * Returns array of { dayKey, taskId }.
 */
function expandTaskOccurrences(task, fromDayKey, toDayKey) {
  const out = [];
  const sched = task?.schedule || { kind: "once" };
  const kind = safeString(sched.kind || "once");

  const pushIfInRange = (dk) => {
    if (!dk) return;
    if (dk >= fromDayKey && dk <= toDayKey)
      out.push({ dayKey: dk, taskId: task.id });
  };

  if (kind === "once") {
    pushIfInRange(safeString(sched.date));
    return out;
  }

  if (kind === "range") {
    const start = safeString(sched.start);
    const end = safeString(sched.end);
    if (!start || !end) return out;

    let cur = start;
    const guardMax = 730; // 2 years safety
    for (let i = 0; i < guardMax && cur <= end; i++) {
      pushIfInRange(cur);
      cur = addDays(cur, 1);
    }
    return out;
  }

  if (kind === "recurring") {
    const start = safeString(sched.start);
    const end = safeString(sched.end || toDayKey);
    const rec = sched.recurrence || {};
    const freq = safeString(rec.freq || "weekly");
    const interval = clamp(asInt(rec.interval, 1), 1, 365);
    const byWeekday = Array.isArray(rec.byWeekday) ? rec.byWeekday : [];

    // Determine effective range intersection
    const effStart = start && start > fromDayKey ? start : fromDayKey;
    const effEnd = end && end < toDayKey ? end : toDayKey;

    if (!effStart || !effEnd || effStart > effEnd) return out;

    // Strategy:
    // - daily: every interval days
    // - weekly/biweekly: every interval weeks on specified weekdays (or start weekday)
    // - monthly: every interval months on same day-of-month as start
    if (freq === "daily") {
      let cur = effStart;
      const guardMax = 2000;
      // Align to start
      if (start && start < cur) {
        // advance by interval to >= cur
        let s = start;
        let steps = 0;
        while (s < cur && steps < guardMax) {
          s = addDays(s, interval);
          steps++;
        }
        cur = s;
      }
      for (let i = 0; i < guardMax && cur <= effEnd; i++) {
        pushIfInRange(cur);
        cur = addDays(cur, interval);
      }
      return out;
    }

    if (freq === "weekly" || freq === "biweekly") {
      const effIntervalWeeks =
        freq === "biweekly" ? Math.max(interval, 2) : interval;

      // weekdays default: start date weekday if none provided
      const startDate = parseDayKey(start || effStart) || parseDayKey(effStart);
      const defaultWday = startDate ? startDate.getDay() : 1;
      const wdays = byWeekday.length
        ? byWeekday.map((n) => clamp(asInt(n, defaultWday), 0, 6))
        : [defaultWday];

      // walk day-by-day, but only emit on matching weekdays and week stepping
      // We measure weeks since "start" anchor.
      const anchor = parseDayKey(start || effStart) || parseDayKey(effStart);
      if (!anchor) return out;

      const guardMax = 2000;
      let cur = effStart;
      for (let i = 0; i < guardMax && cur <= effEnd; i++) {
        const curDate = parseDayKey(cur);
        if (!curDate) break;
        const wday = curDate.getDay();

        // weeks since anchor (floor)
        const daysDiff = Math.floor(
          (curDate.getTime() - anchor.getTime()) / 86400000
        );
        const weeksSince = Math.floor(daysDiff / 7);

        if (
          weeksSince >= 0 &&
          weeksSince % effIntervalWeeks === 0 &&
          wdays.includes(wday)
        ) {
          pushIfInRange(cur);
        }

        cur = addDays(cur, 1);
      }
      return out;
    }

    if (freq === "monthly") {
      const anchor = parseDayKey(start || effStart) || parseDayKey(effStart);
      if (!anchor) return out;
      const anchorDay = anchor.getDate();

      let curDate = parseDayKey(effStart);
      if (!curDate) return out;

      // Align to the next month boundary if needed, but keep it simple:
      // step month by interval, emit on anchor day (or last day if shorter month)
      const guardMax = 240; // 20 years
      // find first candidate month/year >= effStart
      // candidate is (curYear, curMonth) from effStart
      let y = curDate.getFullYear();
      let m = curDate.getMonth(); // 0-11

      // baseline month index for anchor
      const anchorMonthIndex = anchor.getFullYear() * 12 + anchor.getMonth();
      let monthIndex = y * 12 + m;

      // advance monthIndex until it matches recurrence pattern
      while (monthIndex < anchorMonthIndex) monthIndex += interval;

      // If effStart is after the anchor month, align by interval steps
      if (monthIndex < y * 12 + m) {
        const diff = y * 12 + m - monthIndex;
        const bump = Math.ceil(diff / interval) * interval;
        monthIndex += bump;
      }

      for (let i = 0; i < guardMax; i++) {
        const cy = Math.floor(monthIndex / 12);
        const cm = monthIndex % 12;

        const candidate = new Date(cy, cm, 1, 12, 0, 0);
        // compute day: anchorDay or last day of month
        const lastDay = new Date(cy, cm + 1, 0, 12, 0, 0).getDate();
        const day = Math.min(anchorDay, lastDay);
        candidate.setDate(day);

        const dk = toDayKeyLocal(candidate.toISOString());
        if (dk >= effStart && dk <= effEnd) pushIfInRange(dk);
        if (dk > effEnd) break;

        monthIndex += interval;
      }
      return out;
    }

    // unknown freq: nothing
    return out;
  }

  return out;
}

/**
 * Generates a schedule packet for a plan, suitable for:
 *  - UI display
 *  - exporting (CSV/ICS/print)
 *
 * @param {string} planId
 * @param {{
 *   fromDayKey?: string,
 *   toDayKey?: string,
 *   includeCompleted?: boolean,
 *   includeSkipped?: boolean,
 *   collapseByDay?: boolean,      // group tasks per day
 *   collapseByTask?: boolean,     // aggregate occurrences per task
 * }} [opts]
 *
 * @returns {{
 *   ok: boolean,
 *   planId: string,
 *   planName: string,
 *   range: { fromDayKey: string, toDayKey: string },
 *   totals: { tasks: number, occurrences: number, estMinutes: number },
 *   constraints: { doNot: string[], preferredSupplies: string[], notes: string },
 *   suppliesNeeded: string[],
 *   items: Array<{
 *     dayKey: string,
 *     taskId: string,
 *     title: string,
 *     detailSteps: string[],
 *     durationMin: number,
 *     supplies: string[],
 *     doNot: string[],
 *     priority: string,
 *     crop?: { id, name, variety },
 *     bed?: { id, name },
 *     status?: { done: boolean, skipped: boolean }
 *   }>,
 *   byDay?: Record<string, Array<...same item shape...>>,
 * }} */
export function generateSchedule(planId, opts = {}) {
  const plan = getPlan(planId);
  if (!plan) return { ok: false, error: "Plan not found" };

  const today = toDayKeyLocal(nowISO(), plan.timezone);

  const fromDayKey = safeString(opts.fromDayKey || today);
  const toDayKey = safeString(opts.toDayKey || addDays(fromDayKey, 13)); // default 2 weeks

  const includeCompleted = !!opts.includeCompleted;
  const includeSkipped = !!opts.includeSkipped;

  const blackout = new Set(
    (plan.scheduleOverrides?.blackoutDates || [])
      .map(safeString)
      .filter(Boolean)
  );

  const cropById = new Map((plan.crops || []).map((c) => [c.id, c]));
  const bedById = new Map((plan.beds || []).map((b) => [b.id, b]));

  // occurrences
  const occ = [];
  for (const t of plan.tasks || []) {
    const task = _sanitizeTask(t);
    const expanded = expandTaskOccurrences(task, fromDayKey, toDayKey);
    for (const o of expanded) {
      if (blackout.has(o.dayKey)) continue;
      occ.push({ ...o, task });
    }
  }

  // normalize into items
  const items = [];
  for (const o of occ) {
    const t = o.task;
    const done = (t.status?.doneDates || []).includes(o.dayKey);
    const skipped = (t.status?.skippedDates || []).includes(o.dayKey);

    if (!includeCompleted && done) continue;
    if (!includeSkipped && skipped) continue;

    const crop = t.cropId ? cropById.get(t.cropId) : null;
    const bed = t.bedId
      ? bedById.get(t.bedId)
      : crop?.bedId
      ? bedById.get(crop.bedId)
      : null;

    items.push({
      dayKey: o.dayKey,
      taskId: t.id,
      title: t.title,
      detailSteps: t.detailSteps || [],
      durationMin: asInt(t.durationMin, 0),
      supplies: Array.isArray(t.supplies) ? t.supplies.slice() : [],
      doNot: Array.isArray(t.doNot) ? t.doNot.slice() : [],
      priority: safeString(t.priority || "normal"),
      crop: crop
        ? {
            id: crop.id,
            name: crop.name,
            variety: safeString(crop.variety || ""),
          }
        : null,
      bed: bed ? { id: bed.id, name: bed.name } : null,
      status: { done, skipped },
    });
  }

  // sort by day then priority then title
  const priorityRank = (p) => (p === "high" ? 0 : p === "low" ? 2 : 1);
  const sorted = stableSortBy(
    items,
    (it) =>
      `${it.dayKey}|${priorityRank(it.priority)}|${it.title.toLowerCase()}`
  );

  // supplies + constraints aggregation
  const suppliesSet = new Set();
  for (const it of sorted)
    for (const s of it.supplies || []) if (s) suppliesSet.add(safeString(s));

  // include preferred supplies in packet (so a housekeeper/garden helper knows exactly what to use)
  for (const s of plan.constraints?.preferredSupplies || [])
    if (s) suppliesSet.add(safeString(s));

  const suppliesNeeded = Array.from(suppliesSet).sort((a, b) =>
    a.localeCompare(b)
  );

  const estMinutes = sorted.reduce(
    (sum, it) => sum + asInt(it.durationMin, 0),
    0
  );

  const packet = {
    ok: true,
    planId: plan.id,
    planName: plan.name,
    range: { fromDayKey, toDayKey },
    totals: {
      tasks: (plan.tasks || []).length,
      occurrences: sorted.length,
      estMinutes,
    },
    constraints: {
      doNot: Array.isArray(plan.constraints?.doNot)
        ? plan.constraints.doNot.slice()
        : [],
      preferredSupplies: Array.isArray(plan.constraints?.preferredSupplies)
        ? plan.constraints.preferredSupplies.slice()
        : [],
      notes: safeString(plan.constraints?.notes || ""),
    },
    suppliesNeeded,
    items: sorted,
  };

  if (opts.collapseByDay) {
    const byDay = {};
    for (const it of sorted) {
      if (!byDay[it.dayKey]) byDay[it.dayKey] = [];
      byDay[it.dayKey].push(it);
    }
    packet.byDay = byDay;
  }

  setState((prev) => ({
    ...prev,
    ui: {
      ...prev.ui,
      lastGenerated: {
        planId: plan.id,
        range: { fromDayKey, toDayKey },
        generatedAtISO: nowISO(),
      },
    },
  }));

  emit("garden/plan.schedule.generated", {
    planId: plan.id,
    fromDayKey,
    toDayKey,
    count: sorted.length,
  });

  return packet;
}

/* -------------------------------------------------------------------------- */
/*                               Convenience API                               */
/* -------------------------------------------------------------------------- */

export function ensureDefaultPlan() {
  const existing = getActivePlan();
  if (existing) return existing;

  const created = createPlan({
    name: "My Garden Plan",
    year: new Date().getFullYear(),
    timezone: DEFAULT_TIMEZONE,
    constraints: {
      doNot: [],
      preferredSupplies: [],
      notes: "",
    },
    beds: [],
    crops: [],
    tasks: [],
  });

  return created;
}

export function importPlan(planObject) {
  const plan = _sanitizePlan(planObject || {});
  setState((prev) => {
    // replace if id already exists
    const exists = (prev.plans || []).some((p) => p.id === plan.id);
    const plans = exists
      ? (prev.plans || []).map((p) => (p.id === plan.id ? plan : p))
      : [plan, ...(prev.plans || [])].slice(0, MAX_PLANS);
    return { ...prev, plans, activePlanId: plan.id };
  });

  persistNow();
  emit("garden/plan.saved", { planId: plan.id, imported: true });

  return plan;
}

export function exportPlan(planId) {
  const plan = getPlan(planId);
  if (!plan) return null;
  return deepClone(plan);
}

/* -------------------------------------------------------------------------- */
/*                      Compatibility Exports (Planner API)                    */
/* -------------------------------------------------------------------------- */

/**
 * saveGardenPlan
 * -----------------------------------------------------------------------------
 * Compatibility wrapper for domain planners that expect a simple save() call.
 * Accepts a full plan object:
 *  - If plan.id exists and matches an existing plan -> replaces via importPlan()
 *  - If plan.id does not exist -> creates a new plan
 *
 * Returns the saved plan (sanitized).
 */
export function saveGardenPlan(planObject = {}) {
  const p = isPlainObject(planObject) ? planObject : {};
  const id = safeString(p.id || "");

  if (id && getPlan(id)) {
    // replace whole plan (safer than shallow update for nested arrays/objects)
    return importPlan({ ...p, id });
  }

  // create new plan (preserve provided id if present)
  return createPlan(p);
}

/**
 * loadLatestGardenPlan
 * -----------------------------------------------------------------------------
 * Returns the most relevant plan for "resume" behavior:
 *  - Active plan if set
 *  - Otherwise most recently updated plan
 *  - Otherwise a default plan (created)
 */
export function loadLatestGardenPlan() {
  const active = getActivePlan();
  if (active) return active;

  const plans = Array.isArray(_state.plans) ? _state.plans.slice() : [];
  if (!plans.length) return ensureDefaultPlan();

  plans.sort((a, b) =>
    safeString(b.updatedAtISO).localeCompare(safeString(a.updatedAtISO))
  );
  const latest = plans[0] || null;
  if (latest?.id) {
    // also set as active for consistent UX
    try {
      setActivePlan(latest.id);
    } catch {
      // noop
    }
  }
  return latest || ensureDefaultPlan();
}

/* -------------------------------------------------------------------------- */
/*                                   Facade                                   */
/* -------------------------------------------------------------------------- */

export const GardenPlanStore = {
  // core
  getState,
  setState,
  subscribe,

  // persistence
  hydrate,
  persistNow,
  resetStore,

  // plans
  listPlans,
  getPlan,
  getActivePlan,
  setActivePlan,
  createPlan,
  updatePlan,
  deletePlan,
  importPlan,
  exportPlan,
  ensureDefaultPlan,

  // compatibility (domain planners)
  saveGardenPlan,
  loadLatestGardenPlan,

  // beds/crops
  addBed,
  updateBed,
  deleteBed,
  addCrop,
  updateCrop,
  deleteCrop,

  // tasks
  addTask,
  updateTask,
  deleteTask,
  markTaskDone,
  markTaskSkipped,

  // schedule
  generateSchedule,
};

export default GardenPlanStore;

/* -------------------------------------------------------------------------- */
/*                              Auto-hydrate (safe)                            */
/* -------------------------------------------------------------------------- */

try {
  // Hydrate once on first import, but never throw.
  // If you prefer explicit hydration, remove this block.
  if (!_state.hydrated) hydrate();
} catch {
  // noop
}
