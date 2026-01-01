// src/models/UserRoutine.js

import { v4 as uuidv4 } from "uuid";

/**
 * UserRoutine
 * -----------------------------------------------------------------------------
 * A personal routine template that:
 *  - Supports "Daily/Weekly/Monthly", "every 2 weeks", and light RRULE (BYDAY)
 *  - Respects Sabbath/quiet hours; can nudge occurrences to allowed windows
 *  - Tracks habit streaks + XP; emits planned occurrences for scheduling/agents
 *  - Adds task metadata (skills/role/effort/priority) for WorkerTasks matching
 *  - Bridges directly to WorkerTasks via generateWorkerAssignmentsPayload()
 *
 * Task shape (normalized):
 * {
 *   id: string,
 *   name: string,
 *   zone?: string,                   // e.g., CleaningLocation name or area hint
 *   estimatedMinutes?: number,
 *   kcalEstimate?: number,
 *   notes?: string,
 *   requiredSkills?: string[],       // e.g., ["cleaning","cooking","fitness"]
 *   role?: string,                   // e.g., "cleaner","cook","general"
 *   priority?: 1|2|3|4|5,            // affects sorting
 *   frequency?: "daily"|"weekly"|"biweekly"|"monthly"|"every 2 weeks"
 *            | "rrule:FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=1"
 *            | { type:"weekly", interval:1, byDay?:["MO","WE"] },
 *   preferredHour?: number,          // 0..23
 *   lastCompleted?: string|null      // ISO
 * }
 */

const DAY_CODES = ["SU","MO","TU","WE","TH","FR","SA"];

const kcalFromMinutes = (min) => Math.round((min || 0) * 4.8);
const nowISO = () => new Date().toISOString();

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function toDate(x) {
  if (!x) return null;
  const d = x instanceof Date ? x : new Date(x);
  return isNaN(d.getTime()) ? null : d;
}
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + (n || 0));
  return x;
}
function addMonths(d, n) {
  const x = new Date(d);
  x.setMonth(x.getMonth() + (n || 0));
  return x;
}

function parseFrequency(freq) {
  if (!freq) return { type: "weekly", interval: 1 };

  if (typeof freq === "object" && freq.type) {
    const type = String(freq.type).toLowerCase();
    const interval = Math.max(1, parseInt(freq.interval || 1, 10));
    const byDay = Array.isArray(freq.byDay) ? freq.byDay : undefined;
    return { type, interval, byDay };
  }

  const f = String(freq).trim().toLowerCase();
  if (f === "daily") return { type: "daily", interval: 1 };
  if (f === "weekly") return { type: "weekly", interval: 1 };
  if (f === "biweekly" || f === "every 2 weeks") return { type: "weekly", interval: 2 };
  if (f === "monthly") return { type: "monthly", interval: 1 };

  if (f.startsWith("rrule:")) {
    const map = {};
    f.slice(6).split(";").forEach(kv => {
      const [k, v] = kv.split("=");
      map[k.toUpperCase()] = v;
    });
    if ((map.FREQ || "").toUpperCase() === "WEEKLY") {
      const byDay = (map.BYDAY || "").split(",").filter(Boolean);
      const interval = parseInt(map.INTERVAL || "1", 10) || 1;
      return { type: "weekly", interval, byDay };
    }
  }

  const m = f.match(/every\s+(\d+)\s+(day|days|week|weeks|month|months)/i);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2].toLowerCase();
    if (unit.startsWith("day")) return { type: "daily", interval: n };
    if (unit.startsWith("week")) return { type: "weekly", interval: n };
    if (unit.startsWith("month")) return { type: "monthly", interval: n };
  }

  return { type: "weekly", interval: 1 };
}

function inQuietHours(date, { start = 21, end = 7 } = {}) {
  const h = date.getHours();
  return start < end ? (h >= start && h < end) : (h >= start || h < end);
}
function isSabbath(date, { avoidSabbath = false, saturdayAsSabbath = false } = {}) {
  if (!avoidSabbath) return false;
  // Approximate Hebrew Day 7 with Saturday-avoid here; upstream engine can refine.
  return saturdayAsSabbath ? date.getDay() === 6 : date.getDay() === 6;
}
function nudgeToAllowed(date, opts = {}, defaultHour = 9) {
  let d = new Date(date);
  let guard = 0;
  while ((isSabbath(d, opts) || inQuietHours(d, opts.quietHours)) && guard < 14) {
    d = addDays(d, 1);
    d.setHours(defaultHour, 0, 0, 0);
    guard++;
  }
  return d;
}

/** Kanban-ish scoring for sorting (higher → more urgent/important). */
function scorePriority(planPriority = 3, due) {
  const base = planPriority >= 5 ? 85 : planPriority === 4 ? 70 : planPriority === 3 ? 55 : planPriority === 2 ? 40 : 30;
  const now = Date.now();
  const dueMs = due ? new Date(due).getTime() : now + 2 * 24 * 3600e3;
  const deltaDays = Math.round((dueMs - now) / 86400000);
  const timeScore = deltaDays <= 0 ? 30 : deltaDays === 1 ? 20 : deltaDays <= 3 ? 10 : 0;
  return clamp(base + timeScore, 10, 100);
}

function estimateMinutes(name = "", zone = "") {
  const s = `${name} ${zone}`.toLowerCase();
  let min = 15;
  if (/cook|prep|bake|roast/.test(s)) min += 10;
  if (/clean|vacuum|mop|bath|toilet|kitchen/.test(s)) min += 10;
  if (/train|workout/.test(s)) min += 15;
  if (/garden|harvest|weed|plant/.test(s)) min += 10;
  return min;
}

export default class UserRoutine {
  constructor({
    id = uuidv4(),
    name = "",
    description = "",
    // Legacy fields (kept; mapped to flexible fields below)
    frequency = "Weekly",           // "Daily"|"Weekly"|"Monthly"|"Custom"
    days = [],                      // ["Monday","Wednesday"] (legacy UI)
    timeOfDay = "",                 // "08:00"
    tasks = [],                     // { name, zone, estimatedTime, notes }
    linkedPlanId = null,            // e.g., CleaningPlan/CookingPlan id
    isActive = true,

    // New preferences / scheduling
    defaultPriority = 3,            // 1..5 overall routine priority
    defaultHour = null,             // overrides timeOfDay hour if set
    avoidSabbath = true,
    saturdayAsSabbath = false,
    quietHours = { start: 21, end: 7 },

    // Habit/XP
    xp = 0,
    streak = 0,                     // consecutive on-time days completed
    reminders = [],                 // [{ id, label, advanceMinutes, tone?, channel? }]

    // Audit
    createdAt = Date.now(),
    updatedAt = Date.now(),
    snapshots = []
  } = {}) {
    this.id = id;
    this.name = name;
    this.description = description;

    // Back-compat fields
    this.frequency = frequency;
    this.days = Array.isArray(days) ? days : [];
    this.timeOfDay = timeOfDay;

    // Normalize tasks to rich shape
    this.tasks = Array.isArray(tasks) ? tasks.map((t) => this._normalizeTask(t)) : [];

    this.linkedPlanId = linkedPlanId;
    this.isActive = !!isActive;

    this.defaultPriority = clamp(Number(defaultPriority || 3), 1, 5);
    this.defaultHour = Number.isFinite(defaultHour) ? defaultHour : null;
    this.avoidSabbath = !!avoidSabbath;
    this.saturdayAsSabbath = !!saturdayAsSabbath;
    this.quietHours = quietHours || { start: 21, end: 7 };

    this.xp = Number(xp || 0);
    this.streak = Number(streak || 0);
    this.reminders = Array.isArray(reminders) ? reminders : [];

    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
    this.snapshots = Array.isArray(snapshots) ? snapshots : [];
  }

  /* ------------------------------ Normalization ------------------------------ */

  _normalizeTask(t) {
    const id = t.id || uuidv4();
    const name = t.name || t.label || "Task";
    const zone = t.zone || t.location || "";
    const minutes = Number.isFinite(t.estimatedMinutes) ? t.estimatedMinutes
      : Number.isFinite(t.estimatedTime) ? t.estimatedTime
      : estimateMinutes(name, zone);
    const role = t.role || this._inferRole(name, zone);
    const requiredSkills = Array.isArray(t.requiredSkills) && t.requiredSkills.length
      ? t.requiredSkills
      : this._skillsForRole(role);

    return {
      id,
      name,
      zone,
      estimatedMinutes: minutes,
      kcalEstimate: t.kcalEstimate != null ? t.kcalEstimate : kcalFromMinutes(minutes),
      notes: t.notes || "",
      requiredSkills,
      role,
      priority: clamp(Number(t.priority || this.defaultPriority), 1, 5),
      frequency: t.frequency || this._legacyToFrequency(),
      preferredHour: Number.isFinite(t.preferredHour) ? t.preferredHour : this._legacyHourHint(),
      lastCompleted: t.lastCompleted ? new Date(t.lastCompleted).toISOString() : null
    };
  }

  _inferRole(name = "", zone = "") {
    const s = `${name} ${zone}`.toLowerCase();
    if (/cook|bake|meal|recipe/.test(s)) return "cook";
    if (/clean|mop|vacuum|bath|toilet|kitchen|dust/.test(s)) return "cleaner";
    if (/garden|weed|harvest|plant/.test(s)) return "gardener";
    if (/feed|animal|barn/.test(s)) return "farm hand";
    if (/repair|fix|tool|maintain/.test(s)) return "handyperson";
    if (/train|workout|exercise/.test(s)) return "trainer";
    return "general";
    }
  _skillsForRole(role) {
    switch (role) {
      case "cook": return ["cooking","batching","sanitation"];
      case "cleaner": return ["cleaning","sanitation","organization"];
      case "gardener": return ["gardening","harvest","planting"];
      case "farm hand": return ["animal care","feeding","sanitation"];
      case "handyperson": return ["repair","tools","safety"];
      case "trainer": return ["fitness","mobility","strength"];
      default: return ["general labor"];
    }
  }

  _legacyToFrequency() {
    // Map legacy high-level frequency to normalized
    const f = String(this.frequency || "").toLowerCase();
    if (f === "daily") return "daily";
    if (f === "weekly") return "weekly";
    if (f === "monthly") return "monthly";
    return "weekly";
  }
  _legacyHourHint() {
    if (this.defaultHour != null) return this.defaultHour;
    if (!this.timeOfDay) return undefined;
    const [h] = String(this.timeOfDay).split(":").map(Number);
    return Number.isFinite(h) ? clamp(h, 0, 23) : undefined;
  }

  /* -------------------------------- Mutations -------------------------------- */

  addTask(task) {
    this.tasks.push(this._normalizeTask(task));
    this.updatedAt = Date.now();
  }

  removeTask(indexOrId) {
    if (typeof indexOrId === "number") this.tasks.splice(indexOrId, 1);
    else this.tasks = this.tasks.filter(t => t.id !== indexOrId);
    this.updatedAt = Date.now();
  }

  updateTask(indexOrId, updatedTask) {
    const idx = typeof indexOrId === "number" ? indexOrId : this.tasks.findIndex(t => t.id === indexOrId);
    if (idx < 0) return;
    const merged = { ...this.tasks[idx], ...updatedTask };
    this.tasks[idx] = this._normalizeTask(merged);
    this.updatedAt = Date.now();
  }

  addReminder({ label = "Reminder", advanceMinutes = 10, tone = null, channel = "system" } = {}) {
    this.reminders.push({ id: uuidv4(), label, advanceMinutes: Math.max(0, Number(advanceMinutes || 0)), tone, channel });
    this.updatedAt = Date.now();
  }

  awardXP(amount, { reason = "" } = {}) {
    const val = Math.max(0, Number(amount) || 0);
    this.xp += val;
    this._snapshot(`XP +${val} ${reason ? `(${reason})` : ""}`);
    this.updatedAt = Date.now();
  }

  markTaskCompleted(taskId, when = new Date()) {
    const i = this.tasks.findIndex(t => t.id === taskId);
    if (i < 0) return false;
    const prevDue = this.nextDueForTask(this.tasks[i]);
    this.tasks[i].lastCompleted = new Date(when).toISOString();

    // streak logic: if completed on/before due, increment; else reset
    if (prevDue && new Date(when).getTime() <= prevDue.getTime()) this.streak = (this.streak || 0) + 1;
    else this.streak = 0;

    this.updatedAt = Date.now();
    return true;
  }

  archive() { this.isActive = false; this.updatedAt = Date.now(); }
  activate() { this.isActive = true; this.updatedAt = Date.now(); }

  /* ------------------------------- Scheduling -------------------------------- */

  /** Compute next due for a given task, respecting Sabbath/quiet hours. */
  nextDueForTask(task) {
    const plan = parseFrequency(task.frequency);
    const base = task.lastCompleted ? new Date(task.lastCompleted) : new Date();
    let next = new Date(base);

    switch (plan.type) {
      case "daily": next = addDays(base, plan.interval); break;
      case "weekly":
        if (Array.isArray(plan.byDay) && plan.byDay.length) {
          let found = null;
          for (let step = 1; step <= 14; step++) {
            const c = addDays(base, step);
            const code = DAY_CODES[c.getDay()];
            const withinInterval = Math.floor(step / 7) % plan.interval === 0;
            if (plan.byDay.includes(code) && withinInterval) { found = c; break; }
          }
          next = found || addDays(base, 7 * plan.interval);
        } else next = addDays(base, 7 * plan.interval);
        break;
      case "monthly": next = addMonths(base, plan.interval); break;
      default: next = addDays(base, 7);
    }

    const hour = Number.isFinite(task.preferredHour) ? task.preferredHour
      : (this.defaultHour != null ? this.defaultHour : 9);
    next.setHours(hour, 0, 0, 0);

    return nudgeToAllowed(next, {
      avoidSabbath: this.avoidSabbath,
      saturdayAsSabbath: this.saturdayAsSabbath,
      quietHours: this.quietHours
    }, hour);
  }

  /** Expand planned occurrences within a window (default next 14 days). */
  expandOccurrences({ start = new Date(), end = addDays(new Date(), 14) } = {}) {
    if (!this.isActive) return [];
    const out = [];
    for (const t of this.tasks) {
      // seed from lastCompleted or just before start to generate forward
      const startSeed = t.lastCompleted ? new Date(t.lastCompleted) : addDays(start, -7);
      let cursor = this._advanceFrom(startSeed, t.frequency);
      let guard = 0;
      while (cursor && cursor <= end && guard < 60) {
        const placed = new Date(cursor);
        // apply preferred/default hour then nudge
        const hour = Number.isFinite(t.preferredHour) ? t.preferredHour : (this.defaultHour != null ? this.defaultHour : 9);
        placed.setHours(hour, 0, 0, 0);
        const when = nudgeToAllowed(placed, {
          avoidSabbath: this.avoidSabbath,
          saturdayAsSabbath: this.saturdayAsSabbath,
          quietHours: this.quietHours
        }, hour);

        if (when >= start) {
          out.push({
            id: `occ-${t.id}-${when.toISOString()}`,
            routineId: this.id,
            taskId: t.id,
            name: t.name,
            zone: t.zone,
            occurrenceAt: when,
            estimatedMinutes: t.estimatedMinutes,
            kcalEstimate: t.kcalEstimate,
            role: t.role,
            requiredSkills: t.requiredSkills,
            priorityScore: scorePriority(t.priority ?? this.defaultPriority, when),
          });
        }

        // move to next occurrence
        cursor = this._advanceFrom(when, t.frequency);
        guard++;
      }
    }
    return out.sort((a, b) => a.occurrenceAt - b.occurrenceAt);
  }

  _advanceFrom(date, freq) {
    const plan = parseFrequency(freq);
    switch (plan.type) {
      case "daily": return addDays(date, plan.interval);
      case "weekly": return addDays(date, 7 * plan.interval);
      case "monthly": return addMonths(date, plan.interval);
      default: return addDays(date, 7);
    }
  }

  /** Today-only helper (for dashboards). */
  getTodayTasks(reference = new Date()) {
    const start = new Date(reference); start.setHours(0,0,0,0);
    const end = new Date(reference);   end.setHours(23,59,59,999);
    return this.expandOccurrences({ start, end });
  }

  /* ------------------------- WorkerTasks Bridge ------------------------- */

  /**
   * Convert occurrences to WorkerTasks assignment payloads
   * (matching your assignTaskToWorker contract).
   */
  generateWorkerAssignmentsPayload({ start = new Date(), end = addDays(new Date(), 7) } = {}) {
    const occ = this.expandOccurrences({ start, end });
    return occ.map(o => ({
      taskId: o.taskId,
      task: {
        id: o.taskId,
        name: o.name,
        task: `${o.name}${o.zone ? ` @ ${o.zone}` : ""}`,
        source: "routine",
        requiredSkills: o.requiredSkills,
        effort: { minutes: o.estimatedMinutes, kcal: o.kcalEstimate },
        priorityScore: o.priorityScore,
        dueHint: o.occurrenceAt,
        metadata: { routineId: this.id, zone: o.zone }
      },
      role: this.tasks.find(t => t.id === o.taskId)?.role || "general",
      due: o.occurrenceAt
    }));
  }

  /* --------------------------------- Summary -------------------------------- */

  summary(reference = new Date()) {
    const today = this.getTodayTasks(reference);
    const estMin = today.reduce((a, t) => a + (t.estimatedMinutes || 0), 0);
    const estKcal = today.reduce((a, t) => a + (t.kcalEstimate || 0), 0);
    return {
      id: this.id,
      name: this.name,
      isActive: this.isActive,
      defaultPriority: this.defaultPriority,
      todayCount: today.length,
      todayEstimatedMinutes: estMin,
      todayEstimatedKcal: estKcal,
      xp: this.xp,
      streak: this.streak
    };
  }

  /* --------------------------------- Audit ---------------------------------- */

  _snapshot(note) {
    this.snapshots.push({
      at: nowISO(),
      note,
      state: {
        tasks: this.tasks,
        isActive: this.isActive,
        defaultPriority: this.defaultPriority
      }
    });
    if (this.snapshots.length > 50) this.snapshots.shift();
  }

  /* ----------------------------- Serialization ------------------------------ */

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      description: this.description,

      // legacy fields (kept)
      frequency: this.frequency,
      days: this.days,
      timeOfDay: this.timeOfDay,

      // normalized tasks
      tasks: this.tasks,

      linkedPlanId: this.linkedPlanId,
      isActive: this.isActive,

      defaultPriority: this.defaultPriority,
      defaultHour: this.defaultHour,
      avoidSabbath: this.avoidSabbath,
      saturdayAsSabbath: this.saturdayAsSabbath,
      quietHours: this.quietHours,

      xp: this.xp,
      streak: this.streak,
      reminders: this.reminders,

      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      snapshots: this.snapshots
    };
  }

  static fromJSON(json) {
    return new UserRoutine(json);
  }
}
