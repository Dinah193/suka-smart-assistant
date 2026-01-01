// src/models/CleaningLocation.js

/**
 * CleaningLocation
 * -----------------------------------------------------------------------------
 * A smart, agent-friendly model for zones/rooms that:
 *  - Tracks routine & deep-clean tasks with recurrence rules and next-due math
 *  - Avoids Sabbath/quiet hours by default (configurable)
 *  - Estimates effort (minutes) and kcal to feed the Fitness & Defense panels
 *  - Links required tools & supplies for Inventory + Homemade Cleaners modules
 *  - Keeps a streak & audit trail; supports Kanban scoring and assignment
 *  - Serializes cleanly for Dexie or API transport
 *
 * Task shape:
 * {
 *   id: string,
 *   label: string,
 *   frequency: "daily" | "weekly" | "biweekly" | "monthly" | "quarterly" | "rrule:FREQ=WEEKLY;BYDAY=MO,TH" | "every 2 weeks",
 *   lastCompleted: Date|null,
 *   estimatedMinutes: number,          // default auto-estimated if missing
 *   kcalEstimate: number,              // derived from minutes
 *   deepClean: boolean,
 *   requiredSkills: string[],          // e.g., ["cleaning","sanitation","organization"]
 *   requiredTools: string[],           // tool names/ids (for matching)
 *   requiredSupplies: Array<{ item: string, qty?: number, unit?: string }>,
 *   notes?: string
 * }
 */

const DEFAULT_ROLE = "cleaner";

const DEFAULT_SKILLS = ["cleaning", "sanitation", "organization"];

const kcalFromMinutes = (min) => {
  // Simple, consistent estimate for household cleaning
  const kcalPerMin = 4.8; // moderate household activity ~3-4 MET → ~4.8 kcal/min for planning
  return Math.round(min * kcalPerMin);
};

const uid = () =>
  (typeof crypto !== "undefined" && crypto.randomUUID)
    ? crypto.randomUUID()
    : `id-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

/** Parse common frequencies into a plan {type, interval, byDay?} */
function parseFrequency(freq) {
  if (!freq) return { type: "weekly", interval: 1 };

  const f = String(freq).trim().toLowerCase();

  if (f === "daily") return { type: "daily", interval: 1 };
  if (f === "weekly") return { type: "weekly", interval: 1 };
  if (f === "biweekly" || f === "every 2 weeks") return { type: "weekly", interval: 2 };
  if (f === "monthly") return { type: "monthly", interval: 1 };
  if (f === "quarterly") return { type: "monthly", interval: 3 };

  if (f.startsWith("rrule:")) {
    // Very light RRULE support for WEEKLY BYDAY
    const rule = f.slice(6);
    const map = {};
    rule.split(";").forEach((kv) => {
      const [k, v] = kv.split("=");
      map[k.toUpperCase()] = v;
    });
    if ((map.FREQ || "").toUpperCase() === "WEEKLY") {
      const by = (map.BYDAY || "").split(",").filter(Boolean);
      const interval = parseInt(map.INTERVAL || "1", 10) || 1;
      return { type: "weekly", interval, byDay: by }; // e.g., ["MO","TH"]
    }
  }

  // Try "every N days/weeks/months"
  const m = f.match(/every\s+(\d+)\s+(day|days|week|weeks|month|months)/i);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2].toLowerCase();
    if (unit.startsWith("day")) return { type: "daily", interval: n };
    if (unit.startsWith("week")) return { type: "weekly", interval: n };
    if (unit.startsWith("month")) return { type: "monthly", interval: n };
  }

  // Fallback weekly
  return { type: "weekly", interval: 1 };
}

const DAY_CODES = ["SU","MO","TU","WE","TH","FR","SA"];

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function addMonths(d, n) {
  const x = new Date(d);
  x.setMonth(x.getMonth() + n);
  return x;
}

/** Returns true if date is (Hebrew) Sabbath per user rule; default avoid day 7 / Saturday */
function isSabbath(date, options) {
  const { avoidSabbath = true, sabbathDay = "hebrew-7", saturdayAsSabbath = false } = options || {};
  if (!avoidSabbath) return false;

  if (saturdayAsSabbath) {
    return date.getDay() === 6; // Saturday
  }

  // Default: Hebrew day 7 (maps practically to weekly seventh; we approximate with Saturday avoid)
  // Since your calendar engine handles true Hebrew mapping elsewhere, here we minimize disruption:
  return date.getDay() === 6; // avoid Saturday by default
}

function isWithinQuietHours(date, opts) {
  const { quietHours = { start: 21, end: 7 } } = opts || {};
  const h = date.getHours();
  if (quietHours.start < quietHours.end) {
    return h >= quietHours.start && h < quietHours.end;
  }
  // overnight (e.g., 21 → 7)
  return h >= quietHours.start || h < quietHours.end;
}

/** Move date forward to next allowed slot avoiding Sabbath & quiet hours */
function nudgeToAllowed(date, opts) {
  let d = new Date(date);
  let guard = 0;
  while ((isSabbath(d, opts) || isWithinQuietHours(d, opts)) && guard < 14) {
    d = addDays(d, 1);
    d.setHours(9, 0, 0, 0); // default morning
    guard++;
  }
  return d;
}

/** Compute next due date given lastCompleted and frequency */
function computeNextDue(lastCompleted, freq, opts) {
  const plan = parseFrequency(freq);
  const base = lastCompleted ? new Date(lastCompleted) : new Date();
  let next = new Date(base);

  switch (plan.type) {
    case "daily":
      next = addDays(base, plan.interval);
      break;
    case "weekly": {
      // If BYDAY provided, pick next matching weekday
      if (Array.isArray(plan.byDay) && plan.byDay.length) {
        const todayIdx = next.getDay(); // 0=Sun .. 6=Sat
        let soonest = null;
        for (let step = 1; step <= 14; step++) {
          const candidate = addDays(base, step);
          const code = DAY_CODES[candidate.getDay()];
          const withinInterval = Math.floor(step / 7) % plan.interval === 0;
          if (plan.byDay.includes(code) && withinInterval) {
            soonest = candidate;
            break;
          }
        }
        next = soonest || addDays(base, 7 * plan.interval);
      } else {
        next = addDays(base, 7 * plan.interval);
      }
      break;
    }
    case "monthly":
      next = addMonths(base, plan.interval);
      break;
    default:
      next = addDays(base, 7); // safe fallback weekly
  }

  // Place at default house-working time if time not set
  if (next.getHours() === 0 && next.getMinutes() === 0) {
    next.setHours(9, 0, 0, 0);
  }

  return nudgeToAllowed(next, opts);
}

/** Score urgency for Kanban sorting (higher = more urgent) */
function priorityScore(locationPriority, dueDate, deepClean) {
  const base =
    locationPriority >= 5 ? 85 :
    locationPriority === 4 ? 70 :
    locationPriority === 3 ? 55 :
    locationPriority === 2 ? 40 : 30;

  const now = Date.now();
  const dueMs = dueDate ? new Date(dueDate).getTime() : now + 3 * 24 * 3600e3;
  const deltaDays = Math.round((dueMs - now) / 86400000);

  let timeScore =
    deltaDays <= 0 ? 30 :
    deltaDays === 1 ? 20 :
    deltaDays <= 3 ? 10 : 0;

  if (deepClean) timeScore += 5; // encourage scheduling deep-cleans

  return Math.max(10, Math.min(100, base + timeScore));
}

/** Auto-estimate minutes if not provided (based on label + room size tags) */
function estimateMinutesForTask(lbl, tags = [], deep = false) {
  const s = (lbl || "").toLowerCase();
  let min = deep ? 45 : 20;

  if (/bath(room)?|toilet|shower|tub/.test(s)) min += deep ? 20 : 10;
  if (/kitchen|stove|oven|fridge/.test(s)) min += deep ? 25 : 15;
  if (/floor|mop|vacuum|sweep/.test(s)) min += 10;
  if (/windows?/.test(s)) min += 10;
  if (tags.includes("large")) min += 10;
  if (tags.includes("high-traffic")) min += 10;

  return min;
}

/** Safe date parse */
function toDate(x) {
  if (!x) return null;
  const d = (x instanceof Date) ? x : new Date(x);
  return isNaN(d.getTime()) ? null : d;
}

class CleaningLocation {
  constructor({
    id,
    name,
    roomType = "general",         // e.g., "kitchen","bathroom","bedroom","entry","laundry","office","hallway","living"
    tags = [],                    // e.g., ["high-traffic","large","tile","pets"]
    tasks = [],                   // see Task shape in header
    priority = 3,                 // 1(low) - 5(high)
    isDeepCleanArea = false,
    customNotes = "",
    assignedTo = null,            // workerId or household role
    areaSqft = null,              // optional area metric for effort planning
    floorType = null,             // e.g., "tile","wood","carpet","concrete"
    avoidSabbath = true,          // system default: true
    saturdayAsSabbath = false,    // user can flip in settings; default false as requested
    quietHours = { start: 21, end: 7 }, // 9pm-7am
    defaultWorkHour = 9,          // 9 AM default
    createdAt = new Date(),
    updatedAt = new Date(),
    streak = 0,                   // consecutive on-time cycles completed
    lastAuditLog = []             // history entries
  } = {}) {
    this.id = id || `loc-${uid()}`;
    this.name = name;
    this.roomType = roomType;
    this.tags = Array.isArray(tags) ? tags : [];
    this.tasks = (tasks || []).map((t) => this._normalizeTask(t));
    this.priority = priority;
    this.isDeepCleanArea = isDeepCleanArea;
    this.customNotes = customNotes;
    this.assignedTo = assignedTo;

    this.areaSqft = areaSqft;
    this.floorType = floorType;

    this.avoidSabbath = avoidSabbath;
    this.saturdayAsSabbath = saturdayAsSabbath;
    this.quietHours = quietHours;
    this.defaultWorkHour = defaultWorkHour;

    this.createdAt = toDate(createdAt) || new Date();
    this.updatedAt = toDate(updatedAt) || new Date();

    this.streak = streak || 0;
    this.lastAuditLog = Array.isArray(lastAuditLog) ? lastAuditLog : [];
  }

  /** Normalize/seed missing task fields */
  _normalizeTask(t) {
    const deep = !!t.deepClean;
    const estimatedMinutes = t.estimatedMinutes ?? estimateMinutesForTask(t.label, this.tags, deep);
    return {
      id: t.id || uid(),
      label: t.label || "Task",
      frequency: t.frequency || (deep ? "monthly" : "weekly"),
      lastCompleted: toDate(t.lastCompleted),
      estimatedMinutes,
      kcalEstimate: t.kcalEstimate ?? kcalFromMinutes(estimatedMinutes),
      deepClean: deep,
      requiredSkills: Array.isArray(t.requiredSkills) && t.requiredSkills.length ? t.requiredSkills : DEFAULT_SKILLS,
      requiredTools: Array.isArray(t.requiredTools) ? t.requiredTools : [],
      requiredSupplies: Array.isArray(t.requiredSupplies) ? t.requiredSupplies : [],
      notes: t.notes || ""
    };
  }

  /** Update arbitrary fields */
  update(fields = {}) {
    Object.entries(fields).forEach(([key, value]) => {
      if (key === "tasks" && Array.isArray(value)) {
        this.tasks = value.map((t) => this._normalizeTask(t));
      } else if (key in this) {
        this[key] = value;
      }
    });
    this.updatedAt = new Date();
  }

  /** Add a new task to the location */
  addTask(task) {
    this.tasks.push(this._normalizeTask(task));
    this.updatedAt = new Date();
  }

  /** Remove a task by id */
  removeTask(taskId) {
    this.tasks = this.tasks.filter((t) => t.id !== taskId);
    this.updatedAt = new Date();
  }

  /** Mark a task complete (by id or label) and update streak/audit */
  completeTask(identifier, { completedAt = new Date(), notes = "" } = {}) {
    const task = this._findTask(identifier);
    if (!task) return false;

    const prevDue = this.nextDueForTask(task);
    task.lastCompleted = toDate(completedAt) || new Date();

    // Update streak if done on/before due date
    if (prevDue && task.lastCompleted.getTime() <= prevDue.getTime()) {
      this.streak = (this.streak || 0) + 1;
    } else {
      this.streak = 0; // reset on late completion
    }

    this._audit(`Completed "${task.label}"`, { taskId: task.id, notes });
    this.updatedAt = new Date();
    return true;
  }

  /** Find task by id or label */
  _findTask(identifier) {
    if (!identifier) return null;
    return this.tasks.find((t) => t.id === identifier || t.label === identifier) || null;
  }

  /** Compute next due date for a task (respects Sabbath/quiet hours) */
  nextDueForTask(task) {
    const opts = {
      avoidSabbath: this.avoidSabbath,
      sabbathDay: this.saturdayAsSabbath ? "saturday" : "hebrew-7",
      saturdayAsSabbath: this.saturdayAsSabbath,
      quietHours: this.quietHours
    };
    const due = computeNextDue(task.lastCompleted, task.frequency, opts);
    // set default working hour if needed
    if (due && due.getHours() === 0 && due.getMinutes() === 0) {
      due.setHours(this.defaultWorkHour, 0, 0, 0);
    }
    return due;
  }

  /** List tasks enriched with due date and priority score for Kanban/UI */
  getPlannedTasks() {
    return this.tasks.map((t) => {
      const due = this.nextDueForTask(t);
      const score = priorityScore(this.priority, due, t.deepClean);
      return {
        ...t,
        locationId: this.id,
        locationName: this.name,
        roomType: this.roomType,
        tags: this.tags,
        due,
        priorityScore: score,
        recommendedRole: DEFAULT_ROLE,
      };
    }).sort((a, b) => b.priorityScore - a.priorityScore);
  }

  /** Return only tasks due by a certain date (default today) */
  getDueTasks(byDate = new Date()) {
    return this.getPlannedTasks().filter((t) => t.due && t.due.getTime() <= byDate.getTime());
  }

  /** Return overdue tasks */
  getOverdueTasks(reference = new Date()) {
    return this.getPlannedTasks().filter((t) => t.due && t.due.getTime() < reference.getTime());
  }

  /** Expand tasks into occurrences within a date range (for scheduler/agents) */
  expandOccurrences({ start = new Date(), end = addDays(new Date(), 14) } = {}) {
    const out = [];
    for (const t of this.tasks) {
      let cursor = this.nextDueForTask({ ...t, lastCompleted: t.lastCompleted || addDays(start, -7) });
      let guard = 0;
      while (cursor && cursor <= end && guard < 60) {
        if (cursor >= start) {
          out.push({
            ...t,
            occurrenceAt: new Date(cursor),
            locationId: this.id,
            locationName: this.name,
            priorityScore: priorityScore(this.priority, cursor, t.deepClean),
            recommendedRole: DEFAULT_ROLE,
          });
        }
        // step to next occurrence
        const plan = parseFrequency(t.frequency);
        switch (plan.type) {
          case "daily": cursor = addDays(cursor, plan.interval); break;
          case "weekly": cursor = addDays(cursor, 7 * plan.interval); break;
          case "monthly": cursor = addMonths(cursor, plan.interval); break;
          default: cursor = addDays(cursor, 7); break;
        }
        cursor = nudgeToAllowed(cursor, {
          avoidSabbath: this.avoidSabbath,
          saturdayAsSabbath: this.saturdayAsSabbath,
          quietHours: this.quietHours
        });
        guard++;
      }
    }
    // Sort soonest first
    return out.sort((a, b) => a.occurrenceAt - b.occurrenceAt);
  }

  /** Compute a lightweight summary for dashboards */
  summary() {
    const planned = this.getPlannedTasks();
    const next = planned[0]?.due || null;
    const overdue = planned.filter((t) => t.due && t.due < new Date()).length;

    const totalMin = planned.reduce((acc, t) => acc + (t.estimatedMinutes || 0), 0);
    const totalKcal = planned.reduce((acc, t) => acc + (t.kcalEstimate || 0), 0);

    return {
      id: this.id,
      name: this.name,
      roomType: this.roomType,
      tags: this.tags,
      priority: this.priority,
      isDeepCleanArea: this.isDeepCleanArea,
      nextDue: next,
      taskCount: this.tasks.length,
      overdueCount: overdue,
      estimatedSessionMinutes: totalMin,
      estimatedSessionKcal: totalKcal,
      assignedTo: this.assignedTo,
      streak: this.streak
    };
  }

  /** Audit helper */
  _audit(action, data = {}) {
    this.lastAuditLog.push({
      id: uid(),
      at: new Date().toISOString(),
      action,
      ...data
    });
    if (this.lastAuditLog.length > 200) {
      this.lastAuditLog.shift(); // keep size reasonable
    }
  }

  /** Serialize to plain object for Dexie/API */
  toJSON() {
    return {
      id: this.id,
      name: this.name,
      roomType: this.roomType,
      tags: this.tags,
      tasks: this.tasks.map((t) => ({
        ...t,
        lastCompleted: t.lastCompleted ? new Date(t.lastCompleted).toISOString() : null
      })),
      priority: this.priority,
      isDeepCleanArea: this.isDeepCleanArea,
      customNotes: this.customNotes,
      assignedTo: this.assignedTo,
      areaSqft: this.areaSqft,
      floorType: this.floorType,
      avoidSabbath: this.avoidSabbath,
      saturdayAsSabbath: this.saturdayAsSabbath,
      quietHours: this.quietHours,
      defaultWorkHour: this.defaultWorkHour,
      createdAt: this.createdAt ? new Date(this.createdAt).toISOString() : null,
      updatedAt: this.updatedAt ? new Date(this.updatedAt).toISOString() : null,
      streak: this.streak,
      lastAuditLog: this.lastAuditLog
    };
  }

  /** Rehydrate from plain object */
  static from(obj = {}) {
    return new CleaningLocation({
      ...obj,
      createdAt: obj.createdAt ? new Date(obj.createdAt) : new Date(),
      updatedAt: obj.updatedAt ? new Date(obj.updatedAt) : new Date(),
      tasks: (obj.tasks || []).map((t) => ({
        ...t,
        lastCompleted: t.lastCompleted ? new Date(t.lastCompleted) : null
      }))
    });
  }
}

export default CleaningLocation;
