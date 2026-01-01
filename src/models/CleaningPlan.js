// src/models/CleaningPlan.js

/**
 * CleaningPlan — dynamic, behavior-aware
 * -----------------------------------------------------------------------------
 * Adds:
 *  - routineType: "Standard" | "Deep"
 *  - longCadence: string | object | null
 *  - deepFocus: { landingZones, rules, fiveBin, storagePolicy, morningTasks[] }
 *  - Ingest from generated task arrays (compat with CleaningPlanManager)
 *  - Daily morning-outflow occurrences (when deepFocus provided)
 *  - Sabbath/quiet-hours guard, zone rotation, minutes/kcal, WorkerTasks payloads
 */

const DEFAULT_ROLE = "cleaner";
const DEFAULT_SKILLS = ["cleaning", "sanitation", "organization"];
const DAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

const uid = () =>
  (typeof crypto !== "undefined" && crypto.randomUUID)
    ? crypto.randomUUID()
    : `id-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

const toDate = (x) => {
  if (!x) return null;
  const d = x instanceof Date ? x : new Date(x);
  return isNaN(d.getTime()) ? null : d;
};

const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const addMonths = (d, n) => { const x = new Date(d); x.setMonth(x.getMonth() + n); return x; };

const kcalFromMinutes = (min) => Math.round(min * 4.8); // ~moderate household work
const nowISO = () => new Date().toISOString();

const estimateMinutesFromLabel = (label = "", deep = false) => {
  const s = label.toLowerCase();
  let min = deep ? 45 : 20;
  if (/bath(room)?|toilet|shower|tub/.test(s)) min += deep ? 20 : 10;
  if (/kitchen|stove|oven|fridge/.test(s)) min += deep ? 25 : 15;
  if (/floor|mop|vacuum|sweep/.test(s)) min += 10;
  if (/windows?/.test(s)) min += 10;
  if (/baseboards?/.test(s)) min += deep ? 15 : 10;
  if (/declutter|closet|pantry|drawers?/.test(s)) min += deep ? 20 : 10;
  return min;
};

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
  if (f === "quarterly") return { type: "monthly", interval: 3 };
  if (f === "seasonal" || f === "biannual") return { type: "monthly", interval: 6 };
  if (f === "annual" || f === "yearly") return { type: "monthly", interval: 12 };

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

function cadenceToFrequency(cadence) {
  // maps generator "cadence" strings into this model's frequency field
  const c = String(cadence || "").toLowerCase();
  if (!c) return "weekly";
  if (["daily","weekly","biweekly","monthly","quarterly","biannual","annual","seasonal"].includes(c)) return c;
  return "weekly";
}

function isSabbath(date, { avoidSabbath = true, saturdayAsSabbath = false } = {}) {
  if (!avoidSabbath) return false;
  return saturdayAsSabbath ? date.getDay() === 6 : date.getDay() === 6;
}

function inQuietHours(date, { quietHours = { start: 21, end: 7 } } = {}) {
  const h = date.getHours();
  const { start, end } = quietHours || { start: 21, end: 7 };
  if (start < end) return h >= start && h < end;
  return h >= start || h < end;
}

function nudgeToAllowed(date, opts, defaultHour = 9) {
  let d = new Date(date);
  let guard = 0;
  while ((isSabbath(d, opts) || inQuietHours(d, opts)) && guard < 14) {
    d = addDays(d, 1);
    d.setHours(defaultHour, 0, 0, 0);
    guard++;
  }
  return d;
}

function nextOccurrenceFrom(base, freqObj, opts, preferredHour = 9) {
  let next = new Date(base);
  const plan = parseFrequency(freqObj);

  switch (plan.type) {
    case "daily":   next = addDays(base, plan.interval); break;
    case "weekly":
      if (Array.isArray(plan.byDay) && plan.byDay.length) {
        let found = null;
        for (let step = 1; step <= 21; step++) {
          const c = addDays(base, step);
          const code = DAY_CODES[c.getDay()];
          const withinInterval = Math.floor(step / 7) % plan.interval === 0;
          if (plan.byDay.includes(code) && withinInterval) { found = c; break; }
        }
        next = found || addDays(base, 7 * plan.interval);
      } else {
        next = addDays(base, 7 * plan.interval);
      }
      break;
    case "monthly": next = addMonths(base, plan.interval); break;
    default:        next = addDays(base, 7);
  }

  if (next.getHours() === 0 && next.getMinutes() === 0) {
    next.setHours(preferredHour ?? 9, 0, 0, 0);
  }
  return nudgeToAllowed(next, opts, preferredHour ?? 9);
}

function scorePriority(planPriority, due) {
  const base =
    planPriority >= 5 ? 85 :
    planPriority === 4 ? 70 :
    planPriority === 3 ? 55 :
    planPriority === 2 ? 40 : 30;

  const now = Date.now();
  const dueMs = due ? new Date(due).getTime() : now + 2 * 24 * 3600e3;
  const deltaDays = Math.round((dueMs - now) / 86400000);
  let timeScore =
    deltaDays <= 0 ? 30 :
    deltaDays === 1 ? 20 :
    deltaDays <= 3 ? 10 : 0;

  return Math.max(10, Math.min(100, base + timeScore));
}

function rotateArray(arr = [], shiftBy = 1) {
  if (!arr.length) return arr;
  const n = ((shiftBy % arr.length) + arr.length) % arr.length;
  return arr.slice(n).concat(arr.slice(0, n));
}

class CleaningPlan {
  constructor({
    id,
    name,
    description = "",
    createdBy = null,

    // NEW: routine kind + cadence + deep focus
    routineType = "Standard",        // "Standard" | "Deep"
    longCadence = null,              // string | { [zone]: cadence } | null
    deepFocus = null,                // { landingZones, rules, fiveBin, storagePolicy, morningTasks[] }

    // Routine map
    routine = {},

    // Rotational deep-clean zones and cadence
    deepCleanZones = [],             // ordered
    deepCleanCadence = "biweekly",
    currentDeepCleanIndex = 0,

    // Inventory/tools linkage
    supplyChecklist = [],
    toolChecklist = [],

    // Gamification
    goals = [],
    notes = "",

    // Scheduling preferences
    defaultWorkHour = 9,
    avoidSabbath = true,
    saturdayAsSabbath = false,
    quietHours = { start: 21, end: 7 },

    // Priority
    priority = 3,

    // Lifecycle
    isActive = true,

    // Progress
    xp = 0,
    badges = [],

    // Audit
    createdAt = new Date(),
    updatedAt = new Date(),
    snapshots = []
  } = {}) {
    this.id = id || `plan-${uid()}`;
    this.name = name || (routineType === "Deep" ? "Deep Clean Routine" : "Standard Routine");
    this.description = description;
    this.createdBy = createdBy;

    this.routineType = routineType;
    this.longCadence = longCadence;
    this.deepFocus = deepFocus;

    this.routine = this._normalizeRoutine(routine);
    this.deepCleanZones = Array.isArray(deepCleanZones) ? deepCleanZones : [];
    this.deepCleanCadence = deepCleanCadence;
    this.currentDeepCleanIndex = currentDeepCleanIndex || 0;

    this.supplyChecklist = Array.isArray(supplyChecklist) ? supplyChecklist : [];
    this.toolChecklist = Array.isArray(toolChecklist) ? toolChecklist : [];

    this.goals = Array.isArray(goals) ? goals : [];
    this.notes = notes;

    this.defaultWorkHour = defaultWorkHour;
    this.avoidSabbath = avoidSabbath;
    this.saturdayAsSabbath = saturdayAsSabbath;
    this.quietHours = quietHours || { start: 21, end: 7 };

    this.priority = priority;
    this.isActive = isActive;

    this.xp = xp || 0;
    this.badges = Array.isArray(badges) ? badges : [];

    this.createdAt = toDate(createdAt) || new Date();
    this.updatedAt = toDate(updatedAt) || new Date();
    this.snapshots = Array.isArray(snapshots) ? snapshots : [];
  }

  /* ------------------------------- Normalize ------------------------------ */
  _normalizeRoutine(routine) {
    const result = {};
    const keys = Object.keys(routine || {});
    keys.forEach((k) => {
      const items = routine[k] || [];
      result[k] = items.map((it) => this._normalizeTask(it));
    });
    return result;
  }

  _normalizeTask(t) {
    const deep = !!t.deepClean || (Array.isArray(t.focus) && (t.focus.includes("detail") || t.focus.includes("declutter")));
    const label = t.label || t.title || t.name || "Task";
    const freq = t.frequency || cadenceToFrequency(t.cadence) || (deep ? "monthly" : "weekly");
    const minutes = t.estimatedMinutes ?? estimateMinutesFromLabel(label, deep);
    return {
      id: t.id || uid(),
      label,
      locationId: t.locationId || null,
      roomType: t.roomType || (t.zone || "general"),
      frequency: typeof freq === "string" ? freq : "weekly",
      preferredHour: typeof t.preferredHour === "number" ? t.preferredHour : undefined,
      estimatedMinutes: minutes,
      kcalEstimate: t.kcalEstimate ?? kcalFromMinutes(minutes),
      requiredSkills: Array.isArray(t.requiredSkills) && t.requiredSkills.length ? t.requiredSkills : DEFAULT_SKILLS,
      requiredTools: Array.isArray(t.requiredTools) ? t.requiredTools : (t.requires || []),
      requiredSupplies: Array.isArray(t.requiredSupplies) ? t.requiredSupplies : [],
      deepClean: deep,
      notes: t.notes || ""
    };
  }

  /* ------------------------------- Mutations ------------------------------ */
  setRoutineType(kind = "Standard") { this.routineType = kind === "Deep" ? "Deep" : "Standard"; this.updatedAt = new Date(); }
  setLongCadence(c) { this.longCadence = c || null; this.updatedAt = new Date(); }
  setDeepFocus(df) { this.deepFocus = df || null; this.updatedAt = new Date(); }

  addRoutineTask(dayCodeOrAll, task) {
    const key = this._normalizeDayKey(dayCodeOrAll);
    if (!this.routine[key]) this.routine[key] = [];
    this.routine[key].push(this._normalizeTask(task));
    this.updatedAt = new Date();
  }

  removeRoutineTask(dayCodeOrAll, taskId) {
    const key = this._normalizeDayKey(dayCodeOrAll);
    if (!this.routine[key]) return;
    this.routine[key] = this.routine[key].filter((t) => t.id !== taskId);
    this.updatedAt = new Date();
  }

  ingestTasks(tasks = [], { day = "All" } = {}) {
    // Takes an array of generator tasks (title, zone, cadence, focus, requires, supplies, deep flag)
    const key = this._normalizeDayKey(day);
    tasks.forEach((t) => this.addRoutineTask(key, t));
    this.updatedAt = new Date();
  }

  linkSupply(supplyId) {
    if (!this.supplyChecklist.includes(supplyId)) {
      this.supplyChecklist.push(supplyId);
      this.updatedAt = new Date();
    }
  }
  unlinkSupply(supplyId) { this.supplyChecklist = this.supplyChecklist.filter((s) => s !== supplyId); this.updatedAt = new Date(); }

  linkTool(toolId) {
    if (!this.toolChecklist.includes(toolId)) {
      this.toolChecklist.push(toolId);
      this.updatedAt = new Date();
    }
  }
  unlinkTool(toolId) { this.toolChecklist = this.toolChecklist.filter((t) => t !== toolId); this.updatedAt = new Date(); }

  toggleZone(zoneId) {
    const idx = this.deepCleanZones.indexOf(zoneId);
    if (idx === -1) this.deepCleanZones.push(zoneId);
    else this.deepCleanZones.splice(idx, 1);
    this.updatedAt = new Date();
  }

  rotateDeepCleanZones(shiftBy = 1) {
    this.deepCleanZones = rotateArray(this.deepCleanZones, shiftBy);
    this.currentDeepCleanIndex = 0;
    this.updatedAt = new Date();
  }

  setDeepCleanCadence(cadence) { this.deepCleanCadence = cadence; this.updatedAt = new Date(); }
  updateGoals(goalArray) { this.goals = Array.isArray(goalArray) ? goalArray : []; this.updatedAt = new Date(); }

  awardXP(amount, { reason = "" } = {}) {
    const val = Math.max(0, Number(amount) || 0);
    this.xp += val;
    this._snapshot(`XP +${val} ${reason ? `(${reason})` : ""}`);
    this.updatedAt = new Date();
  }

  addBadge(badge) {
    if (!this.badges.includes(badge)) {
      this.badges.push(badge);
      this._snapshot(`Badge earned: ${badge}`);
      this.updatedAt = new Date();
    }
  }

  archivePlan() { this.isActive = false; this._snapshot("Plan archived"); this.updatedAt = new Date(); }
  activatePlan() { this.isActive = true; this._snapshot("Plan activated"); this.updatedAt = new Date(); }

  clone({ nameSuffix = " (Copy)" } = {}) {
    return new CleaningPlan({
      ...this.toJSON(),
      id: undefined,
      name: `${this.name}${nameSuffix}`,
      createdAt: new Date(),
      updatedAt: new Date(),
      snapshots: []
    });
  }

  /* -------------------- Scheduling / Occurrence Expansion ------------------ */

  expandOccurrences({
    start = new Date(),
    end = addDays(new Date(), 14),
  } = {}) {
    const out = [];
    if (!this.isActive) return out;

    const opts = {
      avoidSabbath: this.avoidSabbath,
      saturdayAsSabbath: this.saturdayAsSabbath,
      quietHours: this.quietHours
    };

    // 1) Day-specific + "All"
    for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
      const code = DAY_CODES[d.getDay()];
      const tasksForDay = (this.routine[code] || []).concat(this._occurrencesFromAll(d));
      for (const task of tasksForDay) {
        const preferredHour = task.preferredHour ?? this.defaultWorkHour;
        const when = new Date(d);
        when.setHours(preferredHour, 0, 0, 0);
        const due = nudgeToAllowed(when, opts, preferredHour);
        if (this._isOccurrenceOnDate(task, d)) out.push(this._mkOccurrence(task, due));
      }

      // 1b) Morning Outflow (from deepFocus) — daily, early hour (7AM default)
      if (this.deepFocus?.morningTasks?.length) {
        const early = new Date(d);
        const outflowHour = Math.max(5, Math.min(11, (this.defaultWorkHour || 9) - 2)); // default 7AM
        early.setHours(outflowHour, 0, 0, 0);
        const outflowDue = nudgeToAllowed(early, opts, outflowHour);
        this.deepFocus.morningTasks.forEach((mt) => {
          // treat as daily reset; do not double-add if user already has a similar "All" task
          const occ = this._mkOccurrence(this._normalizeTask({
            ...mt,
            label: mt.title || mt.label,
            frequency: "daily",
            deepClean: false
          }), outflowDue);
          out.push(occ);
        });
      }
    }

    // 2) Deep-clean rotation (one zone per cadence window)
    const deep = this._deepCleanOccurrences({ start, end, opts });
    out.push(...deep);

    // Sort
    out.sort((a, b) => a.occurrenceAt - b.occurrenceAt);
    return out;
  }

  generateWorkerAssignmentsPayload({ start = new Date(), end = addDays(new Date(), 7) } = {}) {
    const occurrences = this.expandOccurrences({ start, end });
    return occurrences.map((occ) => {
      const priorityScore = scorePriority(this.priority, occ.occurrenceAt);
      return {
        taskId: occ.id,
        task: {
          id: occ.id,
          name: occ.label,
          task: `${occ.label}${occ.locationName ? ` @ ${occ.locationName}` : ""}`,
          source: "cleaning",
          requiredSkills: occ.requiredSkills,
          effort: { minutes: occ.estimatedMinutes, kcal: occ.kcalEstimate },
          priorityScore,
          dueHint: occ.occurrenceAt,
          metadata: { locationId: occ.locationId, roomType: occ.roomType, routineType: this.routineType }
        },
        role: DEFAULT_ROLE,
        due: occ.occurrenceAt
      };
    });
  }

  getTodayTasks(reference = new Date()) {
    const start = new Date(reference); start.setHours(0, 0, 0, 0);
    const end = new Date(reference);   end.setHours(23, 59, 59, 999);
    return this.expandOccurrences({ start, end });
  }

  summary(reference = new Date()) {
    const today = this.getTodayTasks(reference);
    const estMin = today.reduce((acc, t) => acc + (t.estimatedMinutes || 0), 0);
    const estKcal = today.reduce((acc, t) => acc + (t.kcalEstimate || 0), 0);
    return {
      id: this.id,
      name: this.name,
      isActive: this.isActive,
      routineType: this.routineType,
      longCadence: this.longCadence,
      priority: this.priority,
      deepCleanZones: this.deepCleanZones,
      deepCleanCadence: this.deepCleanCadence,
      todayCount: today.length,
      todayEstimatedMinutes: estMin,
      todayEstimatedKcal: estKcal,
      supplyChecklist: this.supplyChecklist,
      toolChecklist: this.toolChecklist,
      xp: this.xp,
      badges: this.badges
    };
  }

  /* -------------------------------- Internals ----------------------------- */
  _occurrencesFromAll(dateObj) {
    const items = this.routine["All"] || [];
    return items.filter((task) => this._isOccurrenceOnDate(task, dateObj));
  }

  _isOccurrenceOnDate(task, dateObj) {
    const plan = parseFrequency(task.frequency);
    if (plan.type === "daily") return true;

    if (plan.type === "weekly") {
      const code = DAY_CODES[dateObj.getDay()];
      if (Array.isArray(plan.byDay) && plan.byDay.length) {
        const weekParity = Math.floor((dateObj - startOfWeek(dateObj)) / (7 * 24 * 3600e3));
        return plan.byDay.includes(code) && (weekParity % plan.interval === 0);
      }
      return true;
    }

    if (plan.type === "monthly") return true;
    return true;
  }

  _deepCleanOccurrences({ start, end, opts }) {
    if (!this.deepCleanZones.length) return [];
    const out = [];

    const cadence = (String(this.deepCleanCadence || "biweekly")).toLowerCase();
    const windowDays = cadence === "weekly" ? 7
                    : cadence === "monthly" ? 30
                    : cadence === "quarterly" ? 90
                    : 14;

    let windowStart = new Date(start);
    windowStart.setHours(this.defaultWorkHour, 0, 0, 0);

    let index = this.currentDeepCleanIndex || 0;
    let guard = 0;
    while (windowStart <= end && guard < 24) {
      const zoneId = this.deepCleanZones[index % this.deepCleanZones.length];
      const when = nudgeToAllowed(new Date(windowStart), opts, this.defaultWorkHour);

      const minutes = this.routineType === "Deep" ? 105 : 90;
      out.push({
        id: `deep-${zoneId}-${when.toISOString()}`,
        label: "Deep clean rotation",
        occurrenceAt: when,
        locationId: zoneId,
        locationName: null,
        roomType: "general",
        estimatedMinutes: minutes,
        kcalEstimate: kcalFromMinutes(minutes),
        requiredSkills: DEFAULT_SKILLS,
        requiredTools: [],
        requiredSupplies: [],
        deepClean: true
      });

      windowStart = addDays(windowStart, windowDays);
      index++;
      guard++;
    }

    return out;
  }

  _mkOccurrence(task, due) {
    return {
      id: `occ-${task.id}-${due.toISOString()}`,
      label: task.label,
      occurrenceAt: due,
      locationId: task.locationId || null,
      locationName: null,
      roomType: task.roomType || "general",
      estimatedMinutes: task.estimatedMinutes,
      kcalEstimate: task.kcalEstimate,
      requiredSkills: task.requiredSkills,
      requiredTools: task.requiredTools,
      requiredSupplies: task.requiredSupplies,
      deepClean: !!task.deepClean
    };
  }

  _normalizeDayKey(key) {
    const k = String(key || "").trim();
    if (/^all$/i.test(k)) return "All";
    const code = k.slice(0, 2).toUpperCase();
    return DAY_CODES.includes(code) ? code : "All";
  }

  _snapshot(note) {
    this.snapshots.push({
      at: nowISO(),
      note,
      routineType: this.routineType,
      longCadence: this.longCadence,
      routine: this.routine,
      deepCleanZones: this.deepCleanZones,
      deepCleanCadence: this.deepCleanCadence,
      priority: this.priority,
      isActive: this.isActive,
    });
    if (this.snapshots.length > 50) this.snapshots.shift();
  }

  /* ------------------------------ Serialization --------------------------- */
  toJSON() {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      createdBy: this.createdBy,

      routineType: this.routineType,
      longCadence: this.longCadence,
      deepFocus: this.deepFocus,

      routine: this.routine,
      deepCleanZones: this.deepCleanZones,
      deepCleanCadence: this.deepCleanCadence,
      currentDeepCleanIndex: this.currentDeepCleanIndex,
      supplyChecklist: this.supplyChecklist,
      toolChecklist: this.toolChecklist,
      goals: this.goals,
      notes: this.notes,
      defaultWorkHour: this.defaultWorkHour,
      avoidSabbath: this.avoidSabbath,
      saturdayAsSabbath: this.saturdayAsSabbath,
      quietHours: this.quietHours,
      priority: this.priority,
      isActive: this.isActive,
      xp: this.xp,
      badges: this.badges,
      createdAt: this.createdAt ? new Date(this.createdAt).toISOString() : null,
      updatedAt: this.updatedAt ? new Date(this.updatedAt).toISOString() : null,
      snapshots: this.snapshots
    };
  }

  static from(obj = {}) {
    return new CleaningPlan({
      ...obj,
      createdAt: obj.createdAt ? new Date(obj.createdAt) : new Date(),
      updatedAt: obj.updatedAt ? new Date(obj.updatedAt) : new Date(),
    });
  }

  /**
   * Factory to adapt the generator output ({ routineType, longCadence, deepFocus, tasks[] })
   * into this model. Tasks land under "All" by default; user can refine later.
   */
  static fromGeneratedPlan(gen = {}) {
    const plan = new CleaningPlan({
      routineType: gen.routineType || "Standard",
      longCadence: gen.longCadence || null,
      deepFocus: gen.deepFocus || null,
      name: gen.title || (gen.routineType === "Deep" ? "Deep Clean Routine" : "Standard Routine"),
    });
    if (Array.isArray(gen.tasks) && gen.tasks.length) {
      plan.ingestTasks(gen.tasks, { day: "All" });
    }
    return plan;
  }
}

/** ---------- Helpers not exported ---------- */
function startOfWeek(d) {
  const x = new Date(d);
  const day = x.getDay(); // 0..6
  const diff = x.getDate() - day;
  x.setDate(diff);
  x.setHours(0, 0, 0, 0);
  return x;
}

export default CleaningPlan;
