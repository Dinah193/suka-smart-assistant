// src/managers/CleaningPlanManager.js
import Dexie from "dexie";
import { getRoutineTemplates } from "@/data/cleaningTemplates"; // behavior-first generator

/**
 * DB Setup
 * - v1: cleaningPlans
 * - v2: cleaningLogs (task completions), plus meta/active fields on plans
 * - v3: routineType/longCadence/deepFocus/routine createdAt/updatedAt; richer tasks
 */
const db = new Dexie("SukaInventoryDB");
db.version(1).stores({
  cleaningPlans: "id, title, zones, tasks, assignedTo, schedule",
});
db.version(2).stores({
  cleaningPlans: "id, title, zones, tasks, assignedTo, schedule, active, meta",
  cleaningLogs: "++id, planId, taskId, dateISO, zone, assignee, durationMin",
}).upgrade(async (tx) => {
  // Backfill missing fields on existing plans
  const plans = await tx.table("cleaningPlans").toArray();
  await Promise.all(
    plans.map((p) =>
      tx.table("cleaningPlans").put({
        ...p,
        active: p.active ?? true,
        meta: p.meta ?? { template: null, createdAt: new Date().toISOString() },
      })
    )
  );
});

db.version(3).stores({
  // Index by id (PK), title, routineType and active for quick filtering in UI
  cleaningPlans: "id, title, routineType, active, nextRunISO",
  cleaningLogs: "++id, planId, taskId, dateISO, zone, assignee, durationMin",
}).upgrade(async (tx) => {
  const plans = await tx.table("cleaningPlans").toArray();
  await Promise.all(
    plans.map((p) => {
      const nowISO = new Date().toISOString();
      return tx.table("cleaningPlans").put({
        ...p,
        routineType: p.routineType || "Standard",
        longCadence: p.longCadence ?? null,
        deepFocus: p.deepFocus ?? null,     // store as plain object (Dexie serializes)
        routine: p.routine ?? { All: [] },  // reserved for future day-mapped routines
        meta: {
          ...(p.meta || {}),
          createdAt: p.meta?.createdAt || nowISO,
          upgradedAt: nowISO,
        },
        createdAt: p.createdAt || nowISO,
        updatedAt: p.updatedAt || nowISO,
        nextRunISO: p.nextRunISO || null,
      });
    })
  );
});

/* -----------------------------------------------------------------------------
// Small utilities
----------------------------------------------------------------------------- */
const hasWindow = () => typeof window !== "undefined";
const iso = (d) => (d instanceof Date ? d.toISOString() : new Date(d || Date.now()).toISOString());
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const toInt = (v, def = 0) => (Number.isFinite(Number(v)) ? Number(v) : def);
const DAY_MAP = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/* -----------------------------------------------------------------------------
// RRULE / VEVENT helpers (simple subset)
----------------------------------------------------------------------------- */
function parseVeventOrRRule(input) {
  if (!input) return null;
  const txt = String(input).trim();
  const rruleLine = txt.includes("RRULE:") ? txt.split("\n").find((l) => l.startsWith("RRULE:")) : txt;
  const rule = rruleLine.replace(/^RRULE:/, "").trim();

  const parts = {};
  rule.split(";").forEach((kv) => {
    const [k, v] = kv.split("=");
    if (!k) return;
    parts[k.toUpperCase()] = v;
  });

  const FREQ = (parts.FREQ || "WEEKLY").toUpperCase();
  const INTERVAL = toInt(parts.INTERVAL || 1, 1);
  const BYDAY = (parts.BYDAY || "")
    .split(",")
    .map((d) => d.trim().toUpperCase())
    .filter(Boolean);
  const BYHOUR = toInt(parts.BYHOUR ?? 9, 9);
  const BYMINUTE = toInt(parts.BYMINUTE ?? 0, 0);
  const BYSECOND = toInt(parts.BYSECOND ?? 0, 0);

  return { FREQ, INTERVAL, BYDAY, BYHOUR, BYMINUTE, BYSECOND };
}

function nextOccurrences(rr, fromDate, toDate, tzOffsetMin = null) {
  if (!rr) return [];
  const out = [];
  const start = new Date(fromDate);
  const end = new Date(toDate);
  const clampToRange = (d) => d >= start && d <= end;

  const setTime = (d) => {
    const dt = new Date(d);
    dt.setHours(rr.BYHOUR, rr.BYMINUTE, rr.BYSECOND, 0);
    return dt;
  };

  if (rr.FREQ === "DAILY") {
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + rr.INTERVAL)) {
      const occ = setTime(d);
      if (clampToRange(occ)) out.push(new Date(occ));
    }
  } else if (rr.FREQ === "WEEKLY") {
    const anchor = new Date(start);
    anchor.setDate(anchor.getDate() - anchor.getDay()); // to Sunday
    for (let week = new Date(anchor); week <= end; week.setDate(week.getDate() + 7 * rr.INTERVAL)) {
      const days = rr.BYDAY.length ? rr.BYDAY : ["MO"]; // default Monday
      for (const dcode of days) {
        const idx = DAY_MAP[dcode] ?? 1;
        const day = new Date(week);
        day.setDate(week.getDate() + idx);
        const occ = setTime(day);
        if (clampToRange(occ)) out.push(new Date(occ));
      }
    }
  } else if (rr.FREQ === "MONTHLY") {
    const s = new Date(start);
    const dom = s.getDate();
    for (let m = new Date(s.getFullYear(), s.getMonth(), 1); m <= end; m.setMonth(m.getMonth() + rr.INTERVAL)) {
      const day = new Date(m.getFullYear(), m.getMonth(), dom);
      const occ = setTime(day);
      if (clampToRange(occ)) out.push(new Date(occ));
    }
  }
  if (tzOffsetMin != null && Number.isFinite(tzOffsetMin)) {
    return out.map((d) => new Date(d.getTime() - tzOffsetMin * 60000));
  }
  return out;
}

/* -----------------------------------------------------------------------------
// Estimation & mapping
----------------------------------------------------------------------------- */
function estimateMinutesFromTitle(title = "", deep = false) {
  const s = String(title).toLowerCase();
  let min = deep ? 45 : 20;
  if (/bath(room)?|toilet|shower|tub/.test(s)) min += deep ? 20 : 10;
  if (/kitchen|stove|oven|fridge/.test(s)) min += deep ? 25 : 15;
  if (/floor|mop|vacuum|sweep/.test(s)) min += 10;
  if (/windows?/.test(s)) min += 10;
  if (/baseboards?/.test(s)) min += deep ? 15 : 10;
  if (/declutter|closet|pantry|drawers?/.test(s)) min += deep ? 20 : 10;
  return clamp(min, 5, 240);
}

function mapGeneratorTask(t, i = 0) {
  const deep = !!t.deepClean || (Array.isArray(t.focus) && (t.focus.includes("detail") || t.focus.includes("declutter")));
  const estMinutes = clamp(toInt(t.estimatedMinutes ?? estimateMinutesFromTitle(t.title || t.name, deep), 20), 5, 240);
  return {
    id:
      t.id ||
      (hasWindow() && window.crypto?.randomUUID
        ? window.crypto.randomUUID()
        : `t-${i}-${Math.random().toString(36).slice(2)}`),
    name: t.title || t.name || "Task",
    zone: t.zone || t.roomType || "General",
    estMinutes,
    cadence: t.cadence || (deep ? "monthly" : "weekly"),
    focus: Array.isArray(t.focus) ? t.focus : [],
    tags: Array.isArray(t.tags) ? t.tags : [],
    requires: Array.isArray(t.requires) ? t.requires : [],
    supplies: Array.isArray(t.supplies) ? t.supplies : null,
    notes: t.notes || "",
    deepClean: deep,
  };
}

/* -----------------------------------------------------------------------------
// Defaults & schedules
----------------------------------------------------------------------------- */
function defaultScheduleFor({ routineType = "Standard", longCadence = null } = {}) {
  // Human-friendly defaults; you can reschedule in UI later.
  // Standard → 2x weekly (Mon/Thu) at 9:00.
  // Deep → cadence-driven monthly/quarterly/etc. at 10:00 on Wednesday (avoid weekends by default).
  const lc = String(longCadence || "").toLowerCase();
  if (routineType === "Deep") {
    if (lc === "monthly") return "RRULE:FREQ=MONTHLY;INTERVAL=1;BYDAY=WE;BYHOUR=10;BYMINUTE=0";
    if (lc === "quarterly") return "RRULE:FREQ=MONTHLY;INTERVAL=3;BYDAY=WE;BYHOUR=10;BYMINUTE=0";
    if (lc === "biannual" || lc === "seasonal") return "RRULE:FREQ=MONTHLY;INTERVAL=6;BYDAY=WE;BYHOUR=10;BYMINUTE=0";
    if (lc === "annual" || lc === "yearly") return "RRULE:FREQ=MONTHLY;INTERVAL=12;BYDAY=WE;BYHOUR=10;BYMINUTE=0";
    // fallback: monthly
    return "RRULE:FREQ=MONTHLY;INTERVAL=1;BYDAY=WE;BYHOUR=10;BYMINUTE=0";
  }
  return "RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TH;BYHOUR=9;BYMINUTE=0";
}

function nextRunFromSchedule(schedule) {
  try {
    const rr = parseVeventOrRRule(schedule);
    const list = nextOccurrences(rr, new Date(), new Date(Date.now() + 120 * 24 * 3600 * 1000));
    return list[0]?.toISOString() || null;
  } catch {
    return null;
  }
}

/* -----------------------------------------------------------------------------
// Optional socket bridge (if your useSocket infrastructure is wired)
----------------------------------------------------------------------------- */
function tryEmitPlansUpdated() {
  try {
    const s = hasWindow() ? window.__SUKA_SOCKET__ : null;
    if (s?.connected) s.emit("CLEANING:PLANS_UPDATED", { at: iso() });
  } catch {/* noop */}
}

/* -----------------------------------------------------------------------------
// Plan sanitization & defaults (back-compat)
----------------------------------------------------------------------------- */
function normalizePlan(input) {
  const id = input.id || (hasWindow() && window.crypto?.randomUUID ? window.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const title = (input.title || "Cleaning Plan").trim();
  const zones = Array.isArray(input.zones) ? input.zones : [];
  const tasks = Array.isArray(input.tasks) ? input.tasks : [];
  const assignedTo = input.assignedTo || null;
  const schedule = input.schedule || defaultScheduleFor({ routineType: input.routineType || "Standard", longCadence: input.longCadence || null });
  const active = input.active ?? true;
  const meta = input.meta ?? { template: null, createdAt: iso() };

  // NEW fields
  const routineType = input.routineType || "Standard";
  const longCadence = input.longCadence ?? null;
  const deepFocus = input.deepFocus ?? null;
  const routine = input.routine ?? { All: [] };

  // Ensure rich tasks
  const safeTasks = tasks.map((t, i) => ({
    ...t,
    id:
      t.id ||
      (hasWindow() && window.crypto?.randomUUID
        ? window.crypto.randomUUID()
        : `t-${i}-${Math.random().toString(36).slice(2)}`),
    estMinutes: clamp(toInt(t.estMinutes ?? estimateMinutesFromTitle(t.name, !!t.deepClean), 20), 5, 8 * 60),
    zone: t.zone || "General",
    cadence: t.cadence || (t.deepClean ? "monthly" : "weekly"),
    focus: Array.isArray(t.focus) ? t.focus : [],
    tags: Array.isArray(t.tags) ? t.tags : [],
    requires: Array.isArray(t.requires) ? t.requires : [],
  }));

  const createdAt = input.createdAt || iso();
  const updatedAt = iso();
  const nextRunISO = input.nextRunISO || nextRunFromSchedule(schedule);

  return {
    id, title, zones, tasks: safeTasks, assignedTo, schedule, active, meta,
    routineType, longCadence, deepFocus, routine, createdAt, updatedAt, nextRunISO
  };
}

/* -----------------------------------------------------------------------------
// Manager
----------------------------------------------------------------------------- */
const CleaningPlanManager = {
  /* --------------------------- CRUD (backward compatible) ------------------ */
  async add(plan) {
    const normalized = normalizePlan(plan || {});
    await db.cleaningPlans.add(normalized);
    tryEmitPlansUpdated();
    return normalized.id;
  },

  async getAll() {
    return db.cleaningPlans.toArray();
  },

  async getById(id) {
    return db.cleaningPlans.get(id);
  },

  async update(id, updates) {
    const current = await db.cleaningPlans.get(id);
    if (!current) return 0;
    const merged = normalizePlan({ ...current, ...updates, id: current.id });
    const res = await db.cleaningPlans.put(merged);
    tryEmitPlansUpdated();
    return res ? 1 : 0;
  },

  async upsert(plan) {
    const normalized = normalizePlan(plan || {});
    await db.cleaningPlans.put(normalized);
    tryEmitPlansUpdated();
    return normalized.id;
  },

  async remove(id) {
    await db.cleaningPlans.delete(id);
    tryEmitPlansUpdated();
  },

  async clear() {
    await db.cleaningPlans.clear();
    tryEmitPlansUpdated();
  },

  /* --------------------------- Filters & helpers --------------------------- */
  async getByAssignee(assignee) {
    const all = await db.cleaningPlans.toArray();
    return all.filter((p) => (assignee ? p.assignedTo === assignee : !p.assignedTo));
  },

  async getByZone(zone) {
    const all = await db.cleaningPlans.toArray();
    return all.filter((p) => p.zones?.includes?.(zone));
  },

  async getByRoutineType(routineType = "Standard") {
    const all = await db.cleaningPlans.toArray();
    return all.filter((p) => (p.routineType || "Standard") === routineType);
  },

  async activate(id, active = true) {
    return this.update(id, { active: !!active });
  },

  async duplicate(id, overrides = {}) {
    const p = await this.getById(id);
    if (!p) return null;
    const copy = normalizePlan({
      ...p,
      id: undefined,
      title: `${p.title} (copy)`,
      meta: { ...p.meta, template: p.meta?.template || null, createdAt: iso() },
      createdAt: iso(),
    });
    Object.assign(copy, overrides);
    await db.cleaningPlans.add(copy);
    tryEmitPlansUpdated();
    return copy.id;
  },

  async reorderTasks(planId, newOrderIds = []) {
    const p = await this.getById(planId);
    if (!p) return 0;
    const idToTask = new Map(p.tasks.map((t) => [t.id, t]));
    const reordered = newOrderIds.map((id) => idToTask.get(id)).filter(Boolean);
    const leftovers = p.tasks.filter((t) => !idToTask.has(t.id) || !newOrderIds.includes(t.id));
    return this.update(planId, { tasks: [...reordered, ...leftovers] });
  },

  /* --------------------------- Schedule & occurrences ---------------------- */
  computeOccurrences(plan, fromISO, toISO) {
    if (!plan?.schedule) return [];
    const rr = parseVeventOrRRule(plan.schedule);
    const from = new Date(fromISO || new Date());
    const to = new Date(toISO || new Date(from.getTime() + 7 * 86400000)); // +7 days
    return nextOccurrences(rr, from, to);
  },

  async getDuePlans({ fromISO = null, toISO = null } = {}) {
    const all = (await this.getAll()).filter((p) => p.active !== false);
    const from = fromISO ? new Date(fromISO) : new Date();
    const to = toISO ? new Date(toISO) : new Date(new Date().getTime() + 7 * 86400000);

    const out = [];
    for (const p of all) {
      const occ = this.computeOccurrences(p, from.toISOString(), to.toISOString());
      for (const d of occ) {
        out.push({
          planId: p.id,
          title: p.title,
          when: d.toISOString(),
          tasks: p.tasks,
          zones: p.zones,
          assignedTo: p.assignedTo,
          routineType: p.routineType || "Standard",
        });
      }
    }
    out.sort((a, b) => new Date(a.when) - new Date(b.when));
    return out;
  },

  nextRun(plan) {
    const occ = this.computeOccurrences(
      plan,
      new Date().toISOString(),
      new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString()
    );
    return occ[0] ? occ[0].toISOString() : null;
  },

  toCalendarEvents(planOrEvents) {
    if (Array.isArray(planOrEvents)) {
      return planOrEvents.flatMap((e) =>
        (e.tasks || []).map((t) => ({
          id: `${e.planId}:${t.id}:${e.when}`,
          title: `🧽 ${e.title} — ${t.name}`,
          start: e.when,
          end: iso(new Date(new Date(e.when).getTime() + (t.estMinutes || 10) * 60000)),
          metadata: {
            planId: e.planId,
            taskId: t.id,
            zone: t.zone || null,
            assignee: e.assignedTo || null,
            routineType: e.routineType || "Standard",
          },
        }))
      );
    }
    const p = planOrEvents;
    const occ = this.computeOccurrences(p, new Date().toISOString(), new Date(Date.now() + 7 * 86400000).toISOString());
    return (occ || []).flatMap((d) =>
      (p.tasks || []).map((t) => ({
        id: `${p.id}:${t.id}:${d.toISOString()}`,
        title: `🧽 ${p.title} — ${t.name}`,
        start: d.toISOString(),
        end: iso(new Date(d.getTime() + (t.estMinutes || 10) * 60000)),
        metadata: { planId: p.id, taskId: t.id, zone: t.zone || null, assignee: p.assignedTo || null, routineType: p.routineType || "Standard" },
      }))
    );
  },

  /* --------------------------- Completion & logs --------------------------- */
  async markTaskDone({ planId, taskId, dateISO = iso(), durationMin = null }) {
    const plan = await this.getById(planId);
    if (!plan) return 0;
    const task = (plan.tasks || []).find((t) => t.id === taskId);
    if (!task) return 0;

    const entry = {
      planId,
      taskId,
      dateISO,
      zone: task.zone || null,
      assignee: plan.assignedTo || null,
      durationMin: durationMin ?? task.estMinutes ?? 10,
    };
    await db.cleaningLogs.add(entry);
    return 1;
  },

  async getLogs({ planId = null, sinceISO = null, untilISO = null } = {}) {
    let coll = db.cleaningLogs.orderBy("dateISO");
    const all = await coll.toArray();
    return all.filter((r) => {
      if (planId && r.planId !== planId) return false;
      if (sinceISO && r.dateISO < sinceISO) return false;
      if (untilISO && r.dateISO > untilISO) return false;
      return true;
    });
  },

  async getStreaks(planId) {
    const logs = await this.getLogs({ planId });
    const dates = Array.from(new Set(logs.map((l) => l.dateISO.slice(0, 10)))).sort();
    let best = 0, cur = 0, prev = null;
    for (const d of dates) {
      if (!prev) cur = 1;
      else {
        const diff = (new Date(d) - new Date(prev)) / 86400000;
        cur = diff === 1 ? cur + 1 : 1;
      }
      best = Math.max(best, cur);
      prev = d;
    }
    return { current: cur, best };
  },

  async planStats(planId) {
    const p = await this.getById(planId);
    if (!p) return null;
    const logs = await this.getLogs({ planId });
    const totalTasks = (p.tasks || []).length;
    const completed = logs.length;
    const minutes = logs.reduce((s, l) => s + (l.durationMin || 0), 0);
    return { totalTasks, completed, minutes, lastDoneISO: logs.at(-1)?.dateISO || null };
  },

  /* --------------------------- Suggestions & narrations -------------------- */
  suggestionForTask(task) {
    const name = (task?.name || "").toLowerCase();
    if (/oven|stove|range/.test(name)) return "Run self-clean, then wipe with baking soda + vinegar paste.";
    if (/bath|toilet|shower/.test(name)) return "Use citric acid for hard water; squeegee glass after rinse.";
    if (/fridge|refrigerator/.test(name)) return "Pull drawers; sanitize with diluted hydrogen peroxide.";
    if (/floor|mop|vacuum/.test(name)) return "Add a dash of castile soap; finish with microfiber dry pass.";
    if (/declutter|closet|pantry/.test(name)) return "Set up 5-bin rule nearby; label, limit, and relocate.";
    return "Prep caddy: gloves, microfiber, brush, spray, bags.";
  },

  narrationFor(plan, task, whenISO) {
    const when = whenISO ? ` by ${new Date(whenISO).toLocaleString()}` : "";
    const z = task.zone ? ` in ${task.zone}` : "";
    return `Cleaning task: ${task.name}${z} for plan "${plan.title}"${when}.`;
  },

  toastFor(plan, task, whenISO) {
    const when = whenISO ? new Date(whenISO).toLocaleTimeString() : "now";
    return `🧽 ${task.name} — ${plan.title} • ${when}`;
  },

  /* --------------------------- Import / Export ----------------------------- */
  async exportPlans() {
    const plans = await this.getAll();
    return {
      exportedAt: iso(),
      count: plans.length,
      plans,
      version: 3,
    };
  },

  async importPlans(payload, { merge = true } = {}) {
    const list = Array.isArray(payload?.plans) ? payload.plans : [];
    if (!merge) await db.cleaningPlans.clear();
    for (const p of list) {
      await db.cleaningPlans.put(normalizePlan(p));
    }
    tryEmitPlansUpdated();
    return list.length;
  },

  /* --------------------------- Routine generator --------------------------- */
  /**
   * Generate and persist a plan from behavioral templates.
   * ctx: {
   *   routineType: "Standard" | "Deep",
   *   longCadence?: "monthly" | "quarterly" | "biannual" | "annual" | "custom",
   *   deepFocus?: {...}, // landingZones, rules, fiveBin, storagePolicy, morningTasks
   *   includePacks?: string[], // e.g. ["appliance:fridge-deep","bug:ants"]
   *   title?: string,
   *   assignedTo?: string
   * }
   */
  async generateRoutine(ctx = {}) {
    const routineType = ctx.routineType === "Deep" ? "Deep" : "Standard";
    const longCadence = ctx.longCadence || null;
    const deepFocus = ctx.deepFocus || null;

    // Build tasks via the shared data module (behavior-first)
    const rawTasks = getRoutineTemplates({
      routineType,
      longCadence,
      deepFocus,
      includePacks: Array.isArray(ctx.includePacks) ? ctx.includePacks : [],
      pets: ctx.pets || 0,
      familySize: ctx.familySize || 2,
      cleaningPrefs: ctx.cleaningPrefs || {},
    });

    const tasks = rawTasks.map(mapGeneratorTask);

    // Derive zones & default schedule
    const zones = Array.from(new Set(tasks.map((t) => t.zone).filter(Boolean)));
    const schedule = defaultScheduleFor({ routineType, longCadence });

    const plan = normalizePlan({
      title:
        ctx.title ||
        (routineType === "Deep" ? "Deep Clean Focus" : "Standard Cleaning Routine"),
      zones,
      tasks,
      assignedTo: ctx.assignedTo || null,
      routineType,
      longCadence,
      deepFocus,
      meta: {
        template: routineType === "Deep" ? "Deep Clean" : "Standard",
        createdAt: iso(),
        source: "generator:v3",
      },
      schedule,
      active: true,
    });

    await db.cleaningPlans.put(plan);
    tryEmitPlansUpdated();
    return plan;
  },
};

export default CleaningPlanManager;
