// src/models/CookingPlan.js

/**
 * CookingPlan
 * -----------------------------------------------------------------------------
 * A smart, agent-friendly cooking/batch session model that:
 *  - Schedules feast-aware sessions (prep by sunset; avoid Sabbath by default)
 *  - Consolidates ingredients across recipes & reserves inventory
 *  - Links tools & staging checklists (labels/totes/station setup)
 *  - Builds a parallelizable prep timeline with multitimer events
 *  - Tracks macro targets & totals (protein/fat/carbs/kcal) for nutrition tie-ins
 *  - Estimates effort minutes + kcal for Fitness & Defense integration
 *  - Exports assignments directly for WorkerTasks (role: "cook")
 *
 * RecipeRef shape (in selectedRecipes):
 *   { id: string, title?: string, servings?: number, tags?: string[] }
 *
 * Ingredient item shape (ingredientList):
 *   { key: string, ingredient: string, quantity: number, unit: string, recipeId?: string }
 *
 * Prep step shape (prepSteps):
 *   {
 *     id: string, label: string, minutes: number,
 *     dependsOn?: string[],    // step ids
 *     station?: string,        // e.g., "Sink", "Range", "Table A"
 *     timer?: { name: string, minutes: number, autoStart?: boolean },
 *     notes?: string
 *   }
 */

const DEFAULT_ROLE = "cook";
const DEFAULT_SKILLS = ["cooking", "batching", "sanitation"];
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

const addMinutes = (d, m) => {
  const x = new Date(d);
  x.setMinutes(x.getMinutes() + (m || 0));
  return x;
};

const addDays = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + (n || 0));
  return x;
};

// Rough kcal estimate for session effort (activity ≈ standing/cooking 3–4 MET)
const kcalFromMinutes = (min) => Math.round((min || 0) * 4.5);

const nowISO = () => new Date().toISOString();

/** Sabbath & quiet-hours rules (approx; your calendar engine can refine later) */
function isSabbath(date, { avoidSabbath = true, saturdayAsSabbath = false } = {}) {
  if (!avoidSabbath) return false;
  // Approximate Hebrew Day 7 with Saturday-avoid by default;
  // you already compute true Hebrew day elsewhere in your calendar engine.
  return saturdayAsSabbath ? date.getDay() === 6 : date.getDay() === 6;
}
function inQuietHours(date, { start = 21, end = 7 } = {}) {
  const h = date.getHours();
  return start < end ? (h >= start && h < end) : (h >= start || h < end);
}
function nudgeToAllowed(date, { avoidSabbath, saturdayAsSabbath, quietHours }, defaultHour = 10) {
  let d = new Date(date);
  let guard = 0;
  while ((isSabbath(d, { avoidSabbath, saturdayAsSabbath }) || inQuietHours(d, quietHours)) && guard < 14) {
    d = addDays(d, 1);
    d.setHours(defaultHour, 0, 0, 0);
    guard++;
  }
  return d;
}

/** Simple topological sort for prep steps with dependsOn */
function topoSort(steps) {
  const map = new Map();
  steps.forEach(s => map.set(s.id, { ...s, deps: new Set(s.dependsOn || []) }));
  const out = [];
  const ready = [];
  for (const [id, node] of map) if (node.deps.size === 0) ready.push(id);

  while (ready.length) {
    const id = ready.shift();
    const node = map.get(id);
    if (!node) continue;
    out.push(node);
    map.delete(id);
    for (const [k, n] of map) {
      if (n.deps.has(id)) {
        n.deps.delete(id);
        if (n.deps.size === 0) ready.push(k);
      }
    }
  }
  // If cycles remain, append them in existing order
  for (const [, n] of map) out.push(n);
  return out;
}

/** Macro helpers */
function emptyMacros() {
  return { kcal: 0, protein: 0, fat: 0, carbs: 0, fiber: 0 };
}
function sumMacros(a, b) {
  return {
    kcal: (a.kcal || 0) + (b.kcal || 0),
    protein: (a.protein || 0) + (b.protein || 0),
    fat: (a.fat || 0) + (b.fat || 0),
    carbs: (a.carbs || 0) + (b.carbs || 0),
    fiber: (a.fiber || 0) + (b.fiber || 0),
  };
}

/** Ingredient consolidation key (case-insensitive by ingredient + unit) */
function ingKey(ingredient, unit) {
  return `${String(ingredient || "").trim().toLowerCase()}|${String(unit || "").trim().toLowerCase()}`;
}

/** Priority scoring for task export */
function scorePriority(isFeastSession, startAt) {
  let base = isFeastSession ? 80 : 60;
  const now = Date.now();
  const deltaDays = Math.round(((startAt ? new Date(startAt).getTime() : now) - now) / 86400000);
  let timeScore = 0;
  if (deltaDays <= 0) timeScore = 30;
  else if (deltaDays === 1) timeScore = 20;
  else if (deltaDays <= 3) timeScore = 10;
  return Math.max(10, Math.min(100, base + timeScore));
}

class CookingPlan {
  constructor({
    id,
    title,
    description = "",
    createdBy = null,

    // Feast/Sabbath logic
    isFeastSession = false,
    feastContext = {
      feastName: null,          // e.g., "Feast of Trumpets"
      hebrewDate: null,         // e.g., "Tishri 1"
      restrictCookingOnDay: true, // default: cook before, reheat/hold during; user-controllable
      prepBySunset: true,       // try to finish before sunset
      sunsetAt: null            // ISO string if pre-fetched (your calendar engine can supply)
    },

    // Scheduling
    plannedDate = null,         // desired session start
    defaultStartHour = 10,      // 10 AM default session start
    avoidSabbath = true,        // default: avoid Hebrew Day 7
    saturdayAsSabbath = false,  // users can toggle to Saturday explicitly
    quietHours = { start: 21, end: 7 },

    // Content
    selectedRecipes = [],       // [{ id, title?, servings?, tags? }]
    ingredientList = [],        // [{ key, ingredient, quantity, unit, recipeId? }]
    prepSteps = [],             // see shape above
    toolsNeeded = [],           // tool IDs or names
    stagingChecklist = [],      // e.g., ["Label printer ready","Totes A/B/C","Vacuum sealer bags"]
    supplyChecklist = [],       // pantry items to verify/lay out (ids or names)

    // Goals & notes
    goals = [],                 // [{ id, label, xp, badge? }]
    notes = "",
    isActive = true,

    // Nutrition (targets optional; totals auto-derived)
    macroTargets = null,        // { kcal, protein, fat, carbs, fiber }
    macroTotals = null,         // computed
    servingsPlanned = null,     // e.g., total meals produced

    // Progress & audit
    xp = 0,
    badges = [],
    createdAt = new Date(),
    updatedAt = new Date(),
    snapshots = []
  } = {}) {
    this.id = id || `cook-${uid()}`;
    this.title = title;
    this.description = description;
    this.createdBy = createdBy;

    this.isFeastSession = !!isFeastSession;
    this.feastContext = feastContext || {};
    this.plannedDate = toDate(plannedDate) || null;
    this.defaultStartHour = defaultStartHour;

    this.avoidSabbath = avoidSabbath;
    this.saturdayAsSabbath = saturdayAsSabbath;
    this.quietHours = quietHours || { start: 21, end: 7 };

    this.selectedRecipes = Array.isArray(selectedRecipes) ? selectedRecipes : [];
    this.ingredientList = Array.isArray(ingredientList) ? ingredientList : [];
    this.prepSteps = Array.isArray(prepSteps) ? prepSteps.map(s => this._normalizeStep(s)) : [];
    this.toolsNeeded = Array.isArray(toolsNeeded) ? toolsNeeded : [];
    this.stagingChecklist = Array.isArray(stagingChecklist) ? stagingChecklist : [];
    this.supplyChecklist = Array.isArray(supplyChecklist) ? supplyChecklist : [];

    this.goals = Array.isArray(goals) ? goals : [];
    this.notes = notes;
    this.isActive = isActive;

    this.macroTargets = macroTargets || null;
    this.macroTotals = macroTotals || emptyMacros();
    this.servingsPlanned = servingsPlanned || null;

    this.xp = xp || 0;
    this.badges = Array.isArray(badges) ? badges : [];

    this.createdAt = toDate(createdAt) || new Date();
    this.updatedAt = toDate(updatedAt) || new Date();
    this.snapshots = Array.isArray(snapshots) ? snapshots : [];
  }

  /* -------------------------- Normalizers & Mutations -------------------------- */

  _normalizeStep(s) {
    const id = s.id || `step-${uid()}`;
    const minutes = Math.max(1, Number(s.minutes || 5));
    return {
      id,
      label: s.label || "Prep step",
      minutes,
      dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn : [],
      station: s.station || null,
      timer: s.timer ? { name: s.timer.name || s.label, minutes: Math.max(1, Number(s.timer.minutes || minutes)), autoStart: !!s.timer.autoStart } : undefined,
      notes: s.notes || ""
    };
  }

  update(fields = {}) {
    Object.entries(fields).forEach(([k, v]) => {
      if (k === "prepSteps" && Array.isArray(v)) this.prepSteps = v.map(s => this._normalizeStep(s));
      else if (k in this) this[k] = v;
    });
    this.updatedAt = new Date();
  }

  addRecipe(recipeRef) {
    if (!recipeRef || !recipeRef.id) return;
    if (!this.selectedRecipes.find(r => r.id === recipeRef.id)) {
      this.selectedRecipes.push({ ...recipeRef });
      this.updatedAt = new Date();
    }
  }

  removeRecipe(recipeId) {
    this.selectedRecipes = this.selectedRecipes.filter(r => r.id !== recipeId);
    // also drop any ingredient rows tied to the recipe if present
    this.ingredientList = this.ingredientList.filter(i => i.recipeId !== recipeId);
    this.updatedAt = new Date();
  }

  addIngredient({ ingredient, quantity, unit, recipeId = null }) {
    if (!ingredient) return;
    const key = ingKey(ingredient, unit);
    this.ingredientList.push({ key, ingredient, quantity: Number(quantity || 0), unit: unit || "", recipeId });
    this.updatedAt = new Date();
  }

  addPrepStep(step) {
    this.prepSteps.push(this._normalizeStep(step));
    this.updatedAt = new Date();
  }

  linkTool(toolId) {
    if (!this.toolsNeeded.includes(toolId)) {
      this.toolsNeeded.push(toolId);
      this.updatedAt = new Date();
    }
  }

  addStagingItem(item) {
    if (!item) return;
    this.stagingChecklist.push(item);
    this.updatedAt = new Date();
  }

  linkSupply(supplyId) {
    if (!this.supplyChecklist.includes(supplyId)) {
      this.supplyChecklist.push(supplyId);
      this.updatedAt = new Date();
    }
  }

  updateGoals(goalArray) {
    this.goals = Array.isArray(goalArray) ? goalArray : [];
    this.updatedAt = new Date();
  }

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

  archive() {
    this.isActive = false;
    this._snapshot("Plan archived");
    this.updatedAt = new Date();
  }

  activate() {
    this.isActive = true;
    this._snapshot("Plan activated");
    this.updatedAt = new Date();
  }

  /* ------------------------------ Smart Builders ------------------------------ */

  /**
   * Consolidate ingredients across recipes.
   * If a pantry snapshot is provided, also compute reservations for low/inexact stock.
   * pantry: [{ key, name, quantity, unit, location?, minQty? }]
   */
  consolidateIngredients({ pantry = null } = {}) {
    const map = new Map();
    for (const row of (this.ingredientList || [])) {
      const k = row.key || ingKey(row.ingredient, row.unit);
      const prev = map.get(k) || { ingredient: row.ingredient, unit: row.unit, quantity: 0, key: k, sources: [] };
      prev.quantity += Number(row.quantity || 0);
      prev.sources.push(row.recipeId || null);
      map.set(k, prev);
    }
    const consolidated = Array.from(map.values());

    let reservations = [];
    if (Array.isArray(pantry)) {
      const byKey = new Map(pantry.map(p => [ingKey(p.name || p.ingredient || p.key, p.unit), p]));
      reservations = consolidated.map(item => {
        const stock = byKey.get(item.key);
        const currentQty = stock ? Number(stock.quantity || 0) : 0;
        const minQty = stock && stock.minQty != null ? Number(stock.minQty) : null;
        const reserve = Math.min(item.quantity, currentQty);
        const shortage = Math.max(0, item.quantity - currentQty);
        return {
          itemKey: item.key,
          ingredient: item.ingredient,
          unit: item.unit,
          requiredQty: item.quantity,
          currentQty,
          reserveQty: reserve,
          shortageQty: shortage,
          location: stock?.location || null,
          belowMin: minQty != null ? currentQty < minQty : false
        };
      });
    }

    return { items: consolidated, reservations };
  }

  /**
   * Build a prep timeline from steps (topological order), and partition into
   * parallel "tracks" (stations) with start/stop times, respecting dependencies.
   */
  buildPrepTimeline({ startAt = null } = {}) {
    let start = toDate(startAt) || this._defaultStartForSession();
    start = nudgeToAllowed(start, {
      avoidSabbath: this.isFeastSession ? true : this.avoidSabbath,
      saturdayAsSabbath: this.saturdayAsSabbath,
      quietHours: this.quietHours
    }, this.defaultStartHour);

    // If feast requires prep by sunset, cap end window
    const sunset = this.isFeastSession && this.feastContext?.prepBySunset && this.feastContext?.sunsetAt
      ? new Date(this.feastContext.sunsetAt)
      : null;

    const sorted = topoSort(this.prepSteps);
    const schedule = [];
    const stationEnd = new Map(); // station -> last end time

    const endOfWindow = (date) => (sunset && date > sunset) ? sunset : date;

    for (const step of sorted) {
      // Find earliest start that respects dependency end times
      let earliest = start;
      for (const depId of (step.dependsOn || [])) {
        const dep = schedule.find(s => s.id === depId);
        if (dep && dep.endAt > earliest) earliest = dep.endAt;
      }
      // Also respect station availability (simple greedy)
      if (step.station && stationEnd.has(step.station)) {
        const busyUntil = stationEnd.get(step.station);
        if (busyUntil > earliest) earliest = busyUntil;
      }

      let end = addMinutes(earliest, step.minutes);
      if (sunset && end > sunset) {
        // nudge earlier: for now, clamp to sunset; agent UI can warn that time overflows
        end = sunset;
      }

      const sched = {
        id: step.id,
        label: step.label,
        station: step.station || null,
        startAt: earliest,
        endAt: end,
        minutes: (end - earliest) / 60000,
        timer: step.timer ? { ...step.timer } : null,
        notes: step.notes || ""
      };
      schedule.push(sched);
      if (step.station) stationEnd.set(step.station, end);
    }

    // Multitimer events list
    const timers = schedule
      .filter(s => s.timer)
      .map(s => ({
        id: `tmr-${s.id}`,
        name: s.timer.name || s.label,
        minutes: s.timer.minutes,
        autoStart: !!s.timer.autoStart,
        startAt: s.startAt,
        endAt: addMinutes(s.startAt, s.timer.minutes)
      }));

    // Effort estimate (total minutes actually "hands-on" ~= sum of step minutes)
    const totalMinutes = schedule.reduce((acc, s) => acc + (s.minutes || 0), 0);
    const effort = { minutes: Math.round(totalMinutes), kcal: kcalFromMinutes(totalMinutes) };

    return { startAt: start, endAt: schedule.at(-1)?.endAt || start, schedule, timers, effort, sunsetCap: sunset || null };
  }

  /**
   * Calculate/refresh macro totals from provided recipe nutrition blocks.
   * recipesNutrition: { [recipeId]: { kcal, protein, fat, carbs, fiber } } per whole recipe *selected servings*.
   */
  computeMacroTotals(recipesNutrition = {}) {
    let totals = emptyMacros();
    for (const r of this.selectedRecipes) {
      const m = recipesNutrition[r.id];
      if (!m) continue;
      totals = sumMacros(totals, m);
    }
    this.macroTotals = totals;
    this.updatedAt = new Date();
    return totals;
  }

  /**
   * Reserve inventory for this session (shallow contract; your Inventory service
   * can implement actual persistence). Returns reservation records.
   * inventoryApi: { reserve(items:[{ key, qty, unit }], context:{ planId }) -> reservations[] }
   */
  async reserveInventory(inventoryApi, { pantrySnapshot = null } = {}) {
    if (!inventoryApi?.reserve) return [];
    const { items } = this.consolidateIngredients({ pantry: pantrySnapshot });
    const payload = items.map(it => ({ key: it.key, qty: it.quantity, unit: it.unit }));
    const reservations = await inventoryApi.reserve(payload, { planId: this.id });
    this._snapshot(`Reserved ${reservations.length} items`);
    return reservations;
  }

  /**
   * Generate WorkerTasks assignments payloads for scheduler pickup.
   * - One "cook" assignment for the session
   * - Optional subordinate tasks: "Stage stations", "Label & package", etc.
   */
  generateWorkerAssignmentsPayload({ startAt = null } = {}) {
    const plan = this.buildPrepTimeline({ startAt });
    const priorityScore = scorePriority(this.isFeastSession, plan.startAt);

    const main = {
      taskId: this.id,
      task: {
        id: this.id,
        name: this.title || "Batch Cooking Session",
        task: this._composeTaskLabel(plan),
        source: "cooking",
        requiredSkills: DEFAULT_SKILLS,
        effort: plan.effort,
        priorityScore,
        dueHint: plan.startAt,
        metadata: {
          feast: this.isFeastSession ? (this.feastContext?.feastName || true) : false,
          sunsetCap: plan.sunsetCap || null,
          toolsNeeded: this.toolsNeeded,
          stagingChecklist: this.stagingChecklist
        }
      },
      role: DEFAULT_ROLE,
      due: plan.startAt
    };

    const followUps = [
      {
        taskId: `${this.id}-stage`,
        task: {
          id: `${this.id}-stage`,
          name: "Stage stations",
          task: "Set up stations, sanitize surfaces, lay out tools & supplies.",
          source: "cooking",
          requiredSkills: DEFAULT_SKILLS,
          effort: { minutes: 20, kcal: kcalFromMinutes(20) },
          priorityScore: Math.max(50, priorityScore - 5),
          dueHint: addMinutes(plan.startAt, -30),
          metadata: { relatedPlanId: this.id }
        },
        role: DEFAULT_ROLE,
        due: addMinutes(plan.startAt, -30)
      },
      {
        taskId: `${this.id}-package`,
        task: {
          id: `${this.id}-package`,
          name: "Package & label meals",
          task: "Portion, label, and move to cold storage or holding.",
          source: "cooking",
          requiredSkills: DEFAULT_SKILLS,
          effort: { minutes: 25, kcal: kcalFromMinutes(25) },
          priorityScore: Math.max(50, priorityScore - 10),
          dueHint: plan.endAt,
          metadata: { relatedPlanId: this.id }
        },
        role: DEFAULT_ROLE,
        due: plan.endAt
      }
    ];

    return [main, ...followUps];
  }

  /* ------------------------------- Dashboards -------------------------------- */

  summary() {
    const timeline = this.buildPrepTimeline({});
    return {
      id: this.id,
      title: this.title,
      isActive: this.isActive,
      isFeastSession: this.isFeastSession,
      feastContext: this.feastContext,
      startAt: timeline.startAt,
      endAt: timeline.endAt,
      effort: timeline.effort,
      selectedRecipeCount: this.selectedRecipes.length,
      toolsNeeded: this.toolsNeeded.length,
      stagingItems: this.stagingChecklist.length,
      macroTotals: this.macroTotals,
      macroTargets: this.macroTargets,
      servingsPlanned: this.servingsPlanned
    };
  }

  /* -------------------------------- Internals -------------------------------- */

  _defaultStartForSession() {
    // If user set plannedDate, use that date at defaultStartHour
    const d = this.plannedDate ? new Date(this.plannedDate) : new Date();
    d.setHours(this.defaultStartHour, 0, 0, 0);

    // For feast sessions with "restrictCookingOnDay", try to schedule day BEFORE feast at default hour
    if (this.isFeastSession && this.feastContext?.restrictCookingOnDay) {
      const prior = addDays(d, -1);
      prior.setHours(this.defaultStartHour, 0, 0, 0);
      return prior;
    }
    return d;
  }

  _composeTaskLabel(plan) {
    const feastStr = this.isFeastSession
      ? ` (Feast prep${this.feastContext?.feastName ? `: ${this.feastContext.feastName}` : ""}${plan.sunsetCap ? ", finish by sunset" : ""})`
      : "";
    return `Batch cooking ${this.selectedRecipes.length} recipe(s)${feastStr}`;
  }

  _snapshot(note) {
    this.snapshots.push({
      at: nowISO(),
      note,
      state: {
        selectedRecipes: this.selectedRecipes,
        ingredientList: this.ingredientList,
        toolsNeeded: this.toolsNeeded,
        stagingChecklist: this.stagingChecklist,
        macroTotals: this.macroTotals
      }
    });
    if (this.snapshots.length > 50) this.snapshots.shift();
  }

  /* ----------------------------- Serialization ------------------------------- */

  toJSON() {
    return {
      id: this.id,
      title: this.title,
      description: this.description,
      createdBy: this.createdBy,

      isFeastSession: this.isFeastSession,
      feastContext: this.feastContext,

      plannedDate: this.plannedDate ? new Date(this.plannedDate).toISOString() : null,
      defaultStartHour: this.defaultStartHour,
      avoidSabbath: this.avoidSabbath,
      saturdayAsSabbath: this.saturdayAsSabbath,
      quietHours: this.quietHours,

      selectedRecipes: this.selectedRecipes,
      ingredientList: this.ingredientList,
      prepSteps: this.prepSteps,
      toolsNeeded: this.toolsNeeded,
      stagingChecklist: this.stagingChecklist,
      supplyChecklist: this.supplyChecklist,

      goals: this.goals,
      notes: this.notes,
      isActive: this.isActive,

      macroTargets: this.macroTargets,
      macroTotals: this.macroTotals,
      servingsPlanned: this.servingsPlanned,

      xp: this.xp,
      badges: this.badges,

      createdAt: this.createdAt ? new Date(this.createdAt).toISOString() : null,
      updatedAt: this.updatedAt ? new Date(this.updatedAt).toISOString() : null,
      snapshots: this.snapshots
    };
  }

  static from(obj = {}) {
    return new CookingPlan({
      ...obj,
      plannedDate: obj.plannedDate ? new Date(obj.plannedDate) : null,
      createdAt: obj.createdAt ? new Date(obj.createdAt) : new Date(),
      updatedAt: obj.updatedAt ? new Date(obj.updatedAt) : new Date(),
    });
  }
}

export default CookingPlan;
