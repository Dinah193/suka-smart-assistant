// File: src/services/cleaning/CleaningPlanStore.js
/**
 * CleaningPlanStore (SSA)
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Offline-first, browser-safe store for "cleaning plans" (fixed rhythms + user
 *    customization) that supports:
 *      • multiple plans per household
 *      • deterministic generation of upcoming tasks (non-AI)
 *      • plan templates (daily/weekly/monthly/deep clean / move-out)
 *      • room/zone-aware checklists
 *      • integration hooks for eventBus + automation runtime (optional)
 *      • Dexie persistence when available; safe in-memory fallback otherwise
 *
 * What is a "Cleaning Plan" in SSA terms?
 *  - A plan is a household rhythm blueprint that emits scheduled "actions":
 *      • chores (tasks)
 *      • sessions (batch cleaning sessions / sprints)
 *      • reminders (quiet hours/sabbath aware via your runtime)
 *
 * This store does NOT execute cleaning sessions; it provides data + scheduling.
 *
 * Public API
 *  - CleaningPlanStore.getState()
 *  - CleaningPlanStore.subscribe(fn)
 *  - CleaningPlanStore.createPlan(input)
 *  - CleaningPlanStore.updatePlan(planId, patch)
 *  - CleaningPlanStore.deletePlan(planId)
 *  - CleaningPlanStore.setActivePlan(planId)
 *  - CleaningPlanStore.listPlans({ householdId })
 *  - CleaningPlanStore.getPlan(planId)
 *  - CleaningPlanStore.duplicatePlan(planId, { name })
 *  - CleaningPlanStore.generateSchedule({ planId, startISO, days })
 *  - CleaningPlanStore.previewNext({ planId, count })
 *  - CleaningPlanStore.ensureHydrated()
 *  - CleaningPlanStore.persistNow()
 *
 * Compatibility exports (named funcs expected by some planners)
 *  - saveCleaningPlan(plan)            -> upserts via store (create/update)
 *  - loadLatestCleaningPlan(householdId?) -> returns active or most recently updated
 *
 * Data model (plan)
 *  - {
 *      id, householdId, name, status, isActive,
 *      createdAtISO, updatedAtISO,
 *      meta: { version, notes, tags[] },
 *      settings: {
 *        timezone, weekStartsOn(0..6), quietHours?, sabbathAware?
 *      },
 *      rooms: [{ id, name, tags[], size?, floorType?, ... }],
 *      rhythms: [{
 *        id, kind: "task" | "session" | "reminder",
 *        title, roomId?, tags[],
 *        schedule: { freq, interval, byWeekday?, byMonthday?, timeOfDay? },
 *        effort: { minutes, intensity? },
 *        steps: [{ id, text, estMinutes? }],
 *        constraints: { requiresSupplies?, avoidDays?, onlyDays?, minGapDays? }
 *      }]
 *    }
 *
 * Storage
 *  - Dexie table if present: db.cleaning_plans or db.plans (best effort)
 *  - localStorage fallback key: "ssa.cleaning.plans.v1"
 */

import eventBus from "@/services/events/eventBus";
import db from "@/services/db";

/* -------------------------------------------------------------------------- */
/* Utilities                                                                  */
/* -------------------------------------------------------------------------- */

const SOURCE = "cleaning.CleaningPlanStore";
const LS_KEY = "ssa.cleaning.plans.v1";
const LS_ACTIVE_KEY = "ssa.cleaning.activePlan.v1";
const STORE_VERSION = 1;

function nowISO() {
  return new Date().toISOString();
}

function safeId(prefix = "cp") {
  return `${prefix}_${Math.random()
    .toString(16)
    .slice(2)}_${Date.now().toString(16)}`;
}

function asArray(x) {
  return Array.isArray(x) ? x : [];
}

function isObj(x) {
  return x && typeof x === "object" && !Array.isArray(x);
}

function normalizeStr(s) {
  return String(s || "").trim();
}

function clamp(n, min, max) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : min;
}

function emit(topic, payload) {
  try {
    if (eventBus?.emit) eventBus.emit(topic, payload);
  } catch {
    // never crash store
  }
}

function shallowMerge(a, b) {
  return { ...(a || {}), ...(b || {}) };
}

/**
 * Deep merge for plain objects (no arrays merge).
 */
function deepMerge(base, patch) {
  if (!isObj(base)) return isObj(patch) ? { ...patch } : base;
  if (!isObj(patch)) return { ...base };
  const out = { ...base };
  for (const k of Object.keys(patch)) {
    const pv = patch[k];
    const bv = out[k];
    if (isObj(bv) && isObj(pv)) out[k] = deepMerge(bv, pv);
    else out[k] = pv;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Minimal schedule engine (deterministic)                                    */
/* -------------------------------------------------------------------------- */

/**
 * schedule object:
 *  - { freq: "DAILY"|"WEEKLY"|"MONTHLY", interval?: number,
 *      byWeekday?: [0..6], byMonthday?: [1..31],
 *      timeOfDay?: "HH:MM" }
 */

function parseTimeOfDay(str) {
  const s = String(str || "").trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const hh = clamp(parseInt(m[1], 10), 0, 23);
  const mm = clamp(parseInt(m[2], 10), 0, 59);
  return { hh, mm };
}

function atLocalTime(date, timeOfDay) {
  // Note: Without timezone libs, this uses runtime local TZ.
  const t = parseTimeOfDay(timeOfDay);
  const d = new Date(date.getTime());
  if (t) {
    d.setHours(t.hh, t.mm, 0, 0);
  } else {
    d.setHours(9, 0, 0, 0);
  }
  return d;
}

function startOfDay(date) {
  const d = new Date(date.getTime());
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

function addMonths(date, months) {
  const d = new Date(date.getTime());
  d.setMonth(d.getMonth() + months);
  return d;
}

function sameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function isWeekdayMatch(date, byWeekday) {
  if (!Array.isArray(byWeekday) || byWeekday.length === 0) return true;
  return byWeekday.includes(date.getDay());
}

function isMonthdayMatch(date, byMonthday) {
  if (!Array.isArray(byMonthday) || byMonthday.length === 0) return true;
  return byMonthday.includes(date.getDate());
}

function scheduleMatchesDate(date, schedule, anchorISO) {
  const freq = schedule?.freq || "WEEKLY";
  const interval = clamp(schedule?.interval ?? 1, 1, 365);

  const anchor = anchorISO ? new Date(anchorISO) : new Date(0);
  const d0 = startOfDay(anchor);
  const d1 = startOfDay(date);

  if (freq === "DAILY") {
    const diff = Math.floor((d1 - d0) / 86400000);
    return diff >= 0 && diff % interval === 0;
  }

  if (freq === "WEEKLY") {
    const diff = Math.floor((d1 - d0) / 86400000);
    if (diff < 0) return false;
    const weeks = Math.floor(diff / 7);
    if (weeks % interval !== 0) return false;
    return isWeekdayMatch(d1, schedule.byWeekday);
  }

  if (freq === "MONTHLY") {
    const months =
      (d1.getFullYear() - d0.getFullYear()) * 12 +
      (d1.getMonth() - d0.getMonth());
    if (months < 0) return false;
    if (months % interval !== 0) return false;
    return isMonthdayMatch(d1, schedule.byMonthday);
  }

  // Unknown => never
  return false;
}

/* -------------------------------------------------------------------------- */
/* Default templates                                                          */
/* -------------------------------------------------------------------------- */

function defaultRooms() {
  return [
    { id: "room.kitchen", name: "Kitchen", tags: ["food", "high-traffic"] },
    { id: "room.bathroom", name: "Bathroom", tags: ["sanitation"] },
    { id: "room.living", name: "Living Room", tags: ["high-traffic"] },
    { id: "room.bedroom", name: "Bedroom", tags: ["rest"] },
    { id: "room.laundry", name: "Laundry", tags: ["utility"] },
  ];
}

function baseRhythms() {
  return [
    {
      id: "rhythm.kitchen.daily",
      kind: "task",
      title: "Kitchen reset",
      roomId: "room.kitchen",
      tags: ["daily", "reset"],
      schedule: { freq: "DAILY", interval: 1, timeOfDay: "19:30" },
      effort: { minutes: 20, intensity: "medium" },
      steps: [
        { id: "s1", text: "Clear counters and put away items", estMinutes: 5 },
        {
          id: "s2",
          text: "Load/start dishwasher or wash dishes",
          estMinutes: 8,
        },
        { id: "s3", text: "Wipe counters/stove", estMinutes: 5 },
        { id: "s4", text: "Quick sweep high-traffic area", estMinutes: 2 },
      ],
      constraints: { minGapDays: 0 },
    },
    {
      id: "rhythm.bathroom.weekly",
      kind: "task",
      title: "Bathroom clean (weekly)",
      roomId: "room.bathroom",
      tags: ["weekly", "deep"],
      schedule: {
        freq: "WEEKLY",
        interval: 1,
        byWeekday: [6],
        timeOfDay: "10:00",
      }, // Saturday
      effort: { minutes: 35, intensity: "medium" },
      steps: [
        { id: "s1", text: "Toilet: bowl + exterior wipe", estMinutes: 10 },
        { id: "s2", text: "Sink + mirror", estMinutes: 8 },
        { id: "s3", text: "Tub/shower quick scrub", estMinutes: 12 },
        { id: "s4", text: "Floor: sweep + mop", estMinutes: 5 },
      ],
      constraints: { minGapDays: 5 },
    },
    {
      id: "rhythm.laundry.weekly",
      kind: "session",
      title: "Laundry session",
      roomId: "room.laundry",
      tags: ["weekly", "session"],
      schedule: {
        freq: "WEEKLY",
        interval: 1,
        byWeekday: [1, 4],
        timeOfDay: "09:00",
      }, // Mon/Thu
      effort: { minutes: 60, intensity: "low" },
      steps: [
        { id: "s1", text: "Sort loads and start first load", estMinutes: 10 },
        { id: "s2", text: "Fold/put away dry laundry", estMinutes: 25 },
        { id: "s3", text: "Start next load / swap", estMinutes: 10 },
        { id: "s4", text: "Wipe washer/dryer top + tidy area", estMinutes: 5 },
      ],
      constraints: { minGapDays: 1 },
    },
    {
      id: "rhythm.floors.weekly",
      kind: "task",
      title: "Floors: sweep/vacuum main areas",
      roomId: "room.living",
      tags: ["weekly"],
      schedule: {
        freq: "WEEKLY",
        interval: 1,
        byWeekday: [5],
        timeOfDay: "11:00",
      }, // Friday
      effort: { minutes: 30, intensity: "medium" },
      steps: [
        { id: "s1", text: "Pick up clutter", estMinutes: 10 },
        { id: "s2", text: "Vacuum/sweep living areas", estMinutes: 15 },
        { id: "s3", text: "Spot mop if needed", estMinutes: 5 },
      ],
      constraints: { minGapDays: 3 },
    },
    {
      id: "rhythm.deep.monthly",
      kind: "task",
      title: "Monthly deep clean: fridge & pantry quick audit",
      roomId: "room.kitchen",
      tags: ["monthly", "deep"],
      schedule: {
        freq: "MONTHLY",
        interval: 1,
        byMonthday: [1],
        timeOfDay: "13:00",
      },
      effort: { minutes: 45, intensity: "medium" },
      steps: [
        { id: "s1", text: "Toss expired items", estMinutes: 10 },
        { id: "s2", text: "Wipe fridge shelves", estMinutes: 15 },
        {
          id: "s3",
          text: "Pantry: group like-items + check low stock",
          estMinutes: 20,
        },
      ],
      constraints: { minGapDays: 20 },
    },
  ];
}

function defaultPlan({ householdId, name }) {
  const createdAtISO = nowISO();
  return {
    id: safeId("plan"),
    householdId: householdId || null,
    name: name || "Household Cleaning Rhythm",
    status: "active",
    isActive: true,
    createdAtISO,
    updatedAtISO: createdAtISO,
    meta: { version: STORE_VERSION, notes: "", tags: [] },
    settings: {
      timezone: null,
      weekStartsOn: 0,
      quietHours: null,
      sabbathAware: true,
    },
    rooms: defaultRooms(),
    rhythms: baseRhythms(),
  };
}

/* -------------------------------------------------------------------------- */
/* Persistence layer (Dexie + localStorage fallback)                          */
/* -------------------------------------------------------------------------- */

function pickPlansTable() {
  // Best effort; never throw.
  try {
    const has = (name) =>
      !!db?.[name] && typeof db[name].toArray === "function";
    if (has("cleaning_plans")) return "cleaning_plans";
    if (has("plans")) return "plans";
    if (has("cleaningPlans")) return "cleaningPlans";
    return null;
  } catch {
    return null;
  }
}

async function dexieLoadAll(tableName) {
  try {
    if (!tableName) return null;
    const rows = await db[tableName].toArray();
    return Array.isArray(rows) ? rows : [];
  } catch {
    return null;
  }
}

async function dexieUpsert(tableName, plan) {
  try {
    if (!tableName) return false;
    const id = plan?.id;
    if (!id) return false;
    if (typeof db[tableName].put === "function") {
      await db[tableName].put(plan);
      return true;
    }
    if (typeof db[tableName].add === "function") {
      // fallback
      await db[tableName].add(plan);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function dexieDelete(tableName, id) {
  try {
    if (!tableName) return false;
    if (typeof db[tableName].delete === "function") {
      await db[tableName].delete(id);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function lsRead() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { plans: [], activePlanId: null };
    const parsed = JSON.parse(raw);
    const plans = asArray(parsed?.plans);
    const activePlanId =
      parsed?.activePlanId || localStorage.getItem(LS_ACTIVE_KEY) || null;
    return { plans, activePlanId };
  } catch {
    return { plans: [], activePlanId: null };
  }
}

function lsWrite(plans, activePlanId) {
  try {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({ plans, activePlanId, v: STORE_VERSION })
    );
    if (activePlanId) localStorage.setItem(LS_ACTIVE_KEY, activePlanId);
  } catch {
    // ignore
  }
}

/* -------------------------------------------------------------------------- */
/* Store implementation                                                       */
/* -------------------------------------------------------------------------- */

class CleaningPlanStoreImpl {
  constructor() {
    this._state = {
      status: {
        hydrated: false,
        loading: false,
        error: null,
        dirty: false,
        persisted: false,
        source: "memory",
        lastUpdatedISO: nowISO(),
      },
      plansById: new Map(),
      activePlanId: null,
    };
    this._subs = new Set();
    this._plansTable = null;
  }

  /* --------------------------- basic store wiring -------------------------- */

  getState() {
    const s = this._state;
    return {
      status: { ...s.status },
      activePlanId: s.activePlanId,
      plans: Array.from(s.plansById.values()).map((p) => ({ ...p })),
    };
  }

  subscribe(fn) {
    if (typeof fn !== "function") return () => {};
    this._subs.add(fn);
    return () => this._subs.delete(fn);
  }

  _setState(patch, meta = {}) {
    const prev = this._state;
    const next = isObj(patch) ? deepMerge(prev, patch) : prev;

    next.status = {
      ...next.status,
      lastUpdatedISO: nowISO(),
      ...meta.status,
    };

    this._state = next;
    for (const fn of this._subs) {
      try {
        fn(this.getState());
      } catch {
        // ignore subscriber errors
      }
    }
  }

  _markDirty() {
    this._state.status.dirty = true;
    this._state.status.persisted = false;
    this._state.status.source = this._state.status.source || "memory";
  }

  /* ------------------------------- hydration ------------------------------ */

  async ensureHydrated() {
    if (this._state.status.hydrated || this._state.status.loading)
      return this.getState();

    this._setState(
      { status: { loading: true, error: null } },
      { status: { loading: true } }
    );

    this._plansTable = pickPlansTable();

    // 1) try Dexie
    const rows = await dexieLoadAll(this._plansTable);
    if (rows && rows.length) {
      const map = new Map();
      for (const r of rows) {
        const plan = this._normalizePlan(r);
        map.set(plan.id, plan);
      }
      const activePlanId = this._pickActive(map) || null;

      this._state.plansById = map;
      this._state.activePlanId = activePlanId;

      this._setState(
        {
          status: {
            hydrated: true,
            loading: false,
            source: "dexie",
            persisted: true,
          },
        },
        {
          status: {
            hydrated: true,
            loading: false,
            source: "dexie",
            persisted: true,
          },
        }
      );

      emit("cleaning.plans.hydrated", {
        source: SOURCE,
        from: "dexie",
        count: map.size,
        activePlanId,
      });

      return this.getState();
    }

    // 2) fallback localStorage
    const ls = lsRead();
    const map = new Map();
    for (const p of ls.plans || []) {
      const plan = this._normalizePlan(p);
      map.set(plan.id, plan);
    }
    const activePlanId = ls.activePlanId || this._pickActive(map) || null;

    // 3) if nothing, create default
    if (map.size === 0) {
      const plan = defaultPlan({
        householdId: null,
        name: "Household Cleaning Rhythm",
      });
      map.set(plan.id, plan);
      lsWrite([plan], plan.id);
    }

    this._state.plansById = map;
    this._state.activePlanId =
      activePlanId ||
      this._pickActive(map) ||
      Array.from(map.keys())[0] ||
      null;

    this._setState(
      {
        status: {
          hydrated: true,
          loading: false,
          source: "localStorage",
          persisted: true,
        },
      },
      {
        status: {
          hydrated: true,
          loading: false,
          source: "localStorage",
          persisted: true,
        },
      }
    );

    emit("cleaning.plans.hydrated", {
      source: SOURCE,
      from: "localStorage",
      count: map.size,
      activePlanId: this._state.activePlanId,
    });

    return this.getState();
  }

  _pickActive(map) {
    for (const p of map.values()) {
      if (p.isActive) return p.id;
    }
    return null;
  }

  _normalizePlan(raw) {
    const createdAtISO = raw?.createdAtISO || nowISO();
    const updatedAtISO = raw?.updatedAtISO || createdAtISO;
    const id = raw?.id || safeId("plan");

    const plan = {
      id,
      householdId: raw?.householdId ?? null,
      name: normalizeStr(raw?.name || "Cleaning Plan"),
      status: raw?.status || "active",
      isActive: !!raw?.isActive,
      createdAtISO,
      updatedAtISO,
      meta: deepMerge(
        { version: STORE_VERSION, notes: "", tags: [] },
        raw?.meta || {}
      ),
      settings: deepMerge(
        {
          timezone: null,
          weekStartsOn: 0,
          quietHours: null,
          sabbathAware: true,
        },
        raw?.settings || {}
      ),
      rooms: asArray(raw?.rooms).map((r) => ({
        id: r?.id || safeId("room"),
        name: normalizeStr(r?.name || "Room"),
        tags: asArray(r?.tags),
        size: r?.size ?? null,
        floorType: r?.floorType ?? null,
        meta: r?.meta || {},
      })),
      rhythms: asArray(raw?.rhythms).map((rh) => ({
        id: rh?.id || safeId("rhythm"),
        kind: rh?.kind || "task",
        title: normalizeStr(rh?.title || "Chore"),
        roomId: rh?.roomId ?? null,
        tags: asArray(rh?.tags),
        schedule: deepMerge(
          { freq: "WEEKLY", interval: 1 },
          rh?.schedule || {}
        ),
        effort: deepMerge({ minutes: 15, intensity: "low" }, rh?.effort || {}),
        steps: asArray(rh?.steps).map((s) => ({
          id: s?.id || safeId("step"),
          text: normalizeStr(s?.text || ""),
          estMinutes: s?.estMinutes ?? null,
        })),
        constraints: deepMerge(
          {
            requiresSupplies: false,
            avoidDays: [],
            onlyDays: [],
            minGapDays: 0,
          },
          rh?.constraints || {}
        ),
        meta: rh?.meta || {},
      })),
    };

    // Ensure at least one plan is active if none flagged
    return plan;
  }

  /* ------------------------------- CRUD ----------------------------------- */

  async createPlan(input = {}) {
    await this.ensureHydrated();

    const plan = this._normalizePlan(
      deepMerge(
        defaultPlan({
          householdId: input.householdId || null,
          name: input.name || "New Cleaning Plan",
        }),
        input
      )
    );
    plan.createdAtISO = nowISO();
    plan.updatedAtISO = plan.createdAtISO;

    // if no plans exist, make active
    if (this._state.plansById.size === 0) plan.isActive = true;

    this._state.plansById.set(plan.id, plan);
    if (plan.isActive) this._state.activePlanId = plan.id;

    this._markDirty();
    this._setState({}); // trigger

    emit("cleaning.plan.created", {
      source: SOURCE,
      planId: plan.id,
      householdId: plan.householdId,
    });

    await this.persistNow();
    return { ok: true, plan: { ...plan } };
  }

  async updatePlan(planId, patch = {}) {
    await this.ensureHydrated();
    const id = planId;
    const cur = this._state.plansById.get(id);
    if (!cur) return { ok: false, error: "Plan not found", planId: id };

    const next = this._normalizePlan(deepMerge(cur, patch));
    next.updatedAtISO = nowISO();
    next.id = cur.id;

    this._state.plansById.set(id, next);

    // If setting isActive, enforce single active plan.
    if (patch?.isActive === true) {
      for (const [pid, p] of this._state.plansById.entries()) {
        if (pid !== id && p.isActive) {
          this._state.plansById.set(pid, {
            ...p,
            isActive: false,
            updatedAtISO: nowISO(),
          });
        }
      }
      this._state.activePlanId = id;
    }

    this._markDirty();
    this._setState({});

    emit("cleaning.plan.updated", { source: SOURCE, planId: id });

    await this.persistNow();
    return { ok: true, plan: { ...next } };
  }

  async deletePlan(planId) {
    await this.ensureHydrated();
    const id = planId;
    const cur = this._state.plansById.get(id);
    if (!cur) return { ok: false, error: "Plan not found", planId: id };

    this._state.plansById.delete(id);

    // If deleted active plan, select another
    if (this._state.activePlanId === id) {
      const nextId = Array.from(this._state.plansById.keys())[0] || null;
      this._state.activePlanId = nextId;
      if (nextId) {
        const p = this._state.plansById.get(nextId);
        if (p)
          this._state.plansById.set(nextId, {
            ...p,
            isActive: true,
            updatedAtISO: nowISO(),
          });
      }
    }

    this._markDirty();
    this._setState({});

    emit("cleaning.plan.deleted", { source: SOURCE, planId: id });

    // Persist deletes
    const ok = await dexieDelete(this._plansTable, id);
    if (!ok) {
      // localStorage persist will handle removal
      await this.persistNow();
    } else {
      await this.persistNow();
    }

    // Ensure at least one plan exists
    if (this._state.plansById.size === 0) {
      await this.createPlan({ name: "Household Cleaning Rhythm" });
    }

    return { ok: true };
  }

  async setActivePlan(planId) {
    await this.ensureHydrated();
    const id = planId;
    const cur = this._state.plansById.get(id);
    if (!cur) return { ok: false, error: "Plan not found", planId: id };

    for (const [pid, p] of this._state.plansById.entries()) {
      const isActive = pid === id;
      if (p.isActive !== isActive) {
        this._state.plansById.set(pid, {
          ...p,
          isActive,
          updatedAtISO: nowISO(),
        });
      }
    }
    this._state.activePlanId = id;

    this._markDirty();
    this._setState({});

    emit("cleaning.plan.activated", { source: SOURCE, planId: id });

    await this.persistNow();
    return { ok: true, activePlanId: id };
  }

  listPlans({ householdId = null } = {}) {
    const plans = Array.from(this._state.plansById.values());
    const filtered = householdId
      ? plans.filter((p) => p.householdId === householdId)
      : plans;
    filtered.sort(
      (a, b) =>
        (b.isActive ? 1 : 0) - (a.isActive ? 1 : 0) ||
        a.name.localeCompare(b.name)
    );
    return filtered.map((p) => ({ ...p }));
  }

  getPlan(planId) {
    const p = this._state.plansById.get(planId);
    return p ? { ...p } : null;
  }

  async duplicatePlan(planId, { name } = {}) {
    await this.ensureHydrated();
    const cur = this._state.plansById.get(planId);
    if (!cur) return { ok: false, error: "Plan not found", planId };

    const copy = this._normalizePlan({
      ...cur,
      id: safeId("plan"),
      name: name || `${cur.name} (Copy)`,
      isActive: false,
      createdAtISO: nowISO(),
      updatedAtISO: nowISO(),
    });

    this._state.plansById.set(copy.id, copy);
    this._markDirty();
    this._setState({});

    emit("cleaning.plan.duplicated", {
      source: SOURCE,
      fromPlanId: planId,
      planId: copy.id,
    });

    await this.persistNow();
    return { ok: true, plan: { ...copy } };
  }

  /* ----------------------------- schedule generation ----------------------- */

  /**
   * Generate a list of scheduled "occurrences" for a plan in a date window.
   * Returns:
   *  - { ok, planId, startISO, days, occurrences[] }
   *
   * occurrence:
   *  - {
   *      id, planId, rhythmId, kind, title, roomId, atISO,
   *      effortMinutes, tags[], steps[], meta
   *    }
   */
  async generateSchedule({ planId, startISO, days = 14 } = {}) {
    await this.ensureHydrated();
    const plan = this._state.plansById.get(planId || this._state.activePlanId);
    if (!plan)
      return { ok: false, error: "Plan not found", planId: planId || null };

    const start = startISO ? new Date(startISO) : new Date();
    const startDay = startOfDay(start);
    const numDays = clamp(days, 1, 366);

    const anchorISO = plan.createdAtISO; // deterministic anchor; can be overridden later

    const occurrences = [];
    for (let i = 0; i < numDays; i++) {
      const day = addDays(startDay, i);

      for (const rh of plan.rhythms || []) {
        if (!rh?.schedule) continue;

        // "onlyDays"/"avoidDays" constraints (weekday filters)
        const wd = day.getDay();
        const avoid = asArray(rh.constraints?.avoidDays);
        const only = asArray(rh.constraints?.onlyDays);
        if (only.length && !only.includes(wd)) continue;
        if (avoid.length && avoid.includes(wd)) continue;

        const matches = scheduleMatchesDate(day, rh.schedule, anchorISO);
        if (!matches) continue;

        const at = atLocalTime(day, rh.schedule.timeOfDay);
        occurrences.push({
          id: safeId("occ"),
          planId: plan.id,
          rhythmId: rh.id,
          kind: rh.kind,
          title: rh.title,
          roomId: rh.roomId || null,
          atISO: at.toISOString(),
          effortMinutes: clamp(rh.effort?.minutes ?? 15, 1, 600),
          tags: asArray(rh.tags),
          steps: asArray(rh.steps),
          meta: {
            roomName: this._roomName(plan, rh.roomId),
            intensity: rh.effort?.intensity || "low",
          },
        });
      }
    }

    occurrences.sort((a, b) => Date.parse(a.atISO) - Date.parse(b.atISO));

    return {
      ok: true,
      planId: plan.id,
      startISO: startDay.toISOString(),
      days: numDays,
      occurrences,
    };
  }

  async previewNext({ planId, count = 10 } = {}) {
    const res = await this.generateSchedule({
      planId,
      startISO: new Date().toISOString(),
      days: 30,
    });
    if (!res.ok) return res;
    const n = clamp(count, 1, 100);
    return { ...res, occurrences: res.occurrences.slice(0, n) };
  }

  _roomName(plan, roomId) {
    if (!roomId) return null;
    const r = (plan.rooms || []).find((x) => x.id === roomId);
    return r ? r.name : null;
  }

  /* ------------------------------- persistence ----------------------------- */

  async persistNow() {
    await this.ensureHydrated();

    const plans = Array.from(this._state.plansById.values()).map((p) => ({
      ...p,
    }));
    const activePlanId = this._state.activePlanId || null;

    // 1) try Dexie upserts if table exists
    let dexieOk = false;
    if (this._plansTable) {
      let okCount = 0;
      for (const p of plans) {
        const ok = await dexieUpsert(this._plansTable, p);
        if (ok) okCount++;
      }
      dexieOk = okCount === plans.length;
    }

    // 2) always update localStorage as a fallback snapshot
    lsWrite(plans, activePlanId);

    this._state.status.dirty = false;
    this._state.status.persisted = true;
    this._state.status.source = dexieOk
      ? "dexie"
      : this._state.status.source || "localStorage";

    this._setState({ status: { persisted: true, dirty: false } });

    emit("cleaning.plans.persisted", {
      source: SOURCE,
      to: dexieOk ? "dexie+localStorage" : "localStorage",
      count: plans.length,
      activePlanId,
    });

    return {
      ok: true,
      persistedToDexie: dexieOk,
      count: plans.length,
      activePlanId,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Singleton export                                                           */
/* -------------------------------------------------------------------------- */

const CleaningPlanStore = new CleaningPlanStoreImpl();

/* -------------------------------------------------------------------------- */
/* Compatibility exports (fixes missing named exports in planners)            */
/* -------------------------------------------------------------------------- */

/**
 * saveCleaningPlan
 * - Upsert semantics:
 *    • if plan.id exists and is found => updatePlan(plan.id, plan)
 *    • else => createPlan(plan)
 */
async function saveCleaningPlan(plan = {}) {
  await CleaningPlanStore.ensureHydrated();

  const id = plan?.id || null;
  const hasExisting = id
    ? !!CleaningPlanStore._state?.plansById?.get?.(id)
    : false;

  if (id && hasExisting) return CleaningPlanStore.updatePlan(id, plan);
  return CleaningPlanStore.createPlan(plan);
}

/**
 * loadLatestCleaningPlan
 * - Prefer active plan (optionally for householdId), else most recently updated.
 */
async function loadLatestCleaningPlan(householdId = null) {
  await CleaningPlanStore.ensureHydrated();

  const plans = CleaningPlanStore.listPlans({ householdId });
  if (!plans.length) return null;

  const activeId = CleaningPlanStore.getState().activePlanId;
  const active = activeId ? plans.find((p) => p.id === activeId) : null;
  if (active) return { ...active };

  // Most recently updated
  const sorted = [...plans].sort(
    (a, b) =>
      Date.parse(b.updatedAtISO || b.createdAtISO || 0) -
      Date.parse(a.updatedAtISO || a.createdAtISO || 0)
  );
  return sorted[0] ? { ...sorted[0] } : null;
}

export default CleaningPlanStore;
export { CleaningPlanStore, saveCleaningPlan, loadLatestCleaningPlan };
