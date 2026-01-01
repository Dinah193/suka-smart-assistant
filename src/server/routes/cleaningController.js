// src/server/routes/cleaningController.js

import express from "express";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const router = express.Router();
const ajv = new Ajv({ allErrors: true, removeAdditional: "failing", strict: false });
addFormats(ajv);

/* ------------------------------ Optional imports ------------------------------ */
let CleaningLocation = null;
let CleaningPlan = null;
let SupplyInventory = null;
let WorkerTasks = null;
let ReminderManager = null;
let calendarService = null; // optional: ../services/calendarService.js

try { CleaningLocation = (await import("../../models/CleaningLocation.js")).default; } catch {}
try { CleaningPlan = (await import("../../models/CleaningPlan.js")).default; } catch {}
try { SupplyInventory = (await import("../../models/SupplyInventory.js")).default; } catch {}
try { WorkerTasks = (await import("../../managers/WorkerTasks.js")).default; } catch {}
try { ReminderManager = (await import("../../managers/ReminderManager.js")).default; } catch {}
try { calendarService = (await import("../services/calendarService.js")).default || await import("../services/calendarService.js"); } catch {}

/* ------------------------------ Local utils / state ------------------------------ */
const mem = {
  locations: new Map(), // id -> CleaningLocation-like POJO
  plans: new Map(),     // id -> CleaningPlan-like POJO
  completions: new Map()// key -> [{at,taskLabel,locId,planId}]
};

const uid = () =>
  (typeof crypto !== "undefined" && crypto.randomUUID)
    ? crypto.randomUUID()
    : `id-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

const DEFAULT_TZ = process.env.GENERIC_TIMEZONE || "America/Chicago";
const DAY = 86400000;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const toISO = (d) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

function parseBool(v, d = false) {
  if (typeof v === "boolean") return v;
  if (v == null) return d;
  const s = String(v).toLowerCase();
  return ["1","true","yes","y"].includes(s) ? true : ["0","false","no","n"].includes(s) ? false : d;
}
function inQuietHours(date, { start = 21, end = 7 } = {}) {
  const h = date.getHours();
  return start < end ? (h >= start && h < end) : (h >= start || h < end);
}
function isSabbath(date, { avoidSabbath = true, saturdayAsSabbath = false } = {}) {
  if (!avoidSabbath) return false;
  // Approximate (Saturday)
  return saturdayAsSabbath ? date.getDay() === 6 : date.getDay() === 6;
}
function nudgeToAllowed(date, { avoidSabbath = true, saturdayAsSabbath = false, quietHours = { start: 21, end: 7 }, defaultHour = 9 } = {}) {
  let d = new Date(date);
  let guard = 0;
  while ((isSabbath(d, { avoidSabbath, saturdayAsSabbath }) || inQuietHours(d, quietHours)) && guard < 14) {
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, defaultHour, 0, 0, 0);
    guard++;
  }
  return d;
}

/* ------------------------------ Validation ------------------------------ */
const locationSchema = {
  type: "object",
  required: ["name"],
  properties: {
    id: { type: "string" },
    name: { type: "string", minLength: 1 },
    roomType: { type: "string", default: "general" },
    tags: { type: "array", items: { type: "string" } },
    tasks: {
      type: "array",
      items: {
        type: "object",
        required: ["label"],
        properties: {
          label: { type: "string" },
          frequency: { type: "string" }, // "daily","weekly","monthly","rrule:..."
          lastCompleted: { type: "string" }
        },
        additionalProperties: true
      }
    },
    priority: { type: "integer", minimum: 1, maximum: 5, default: 1 },
    isDeepCleanArea: { type: "boolean", default: false },
    customNotes: { type: "string" },
    assignedTo: { type: "string" }
  },
  additionalProperties: true
};

const planSchema = {
  type: "object",
  required: ["name"],
  properties: {
    id: { type: "string" },
    name: { type: "string", minLength: 1 },
    description: { type: "string" },
    createdBy: { type: "string" },
    routine: { type: "object", additionalProperties: true }, // { Monday: [{name,time}], ... }
    deepCleanZones: { type: "array", items: { type: "string" } },
    supplyChecklist: { type: "array", items: { type: "string" } },
    toolChecklist: { type: "array", items: { type: "string" } },
    goals: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
    isActive: { type: "boolean", default: true }
  },
  additionalProperties: true
};

const assignSchema = {
  type: "object",
  required: ["taskId","task"],
  properties: {
    taskId: { type: "string" },
    task: {
      type: "object",
      required: ["name","task"],
      properties: {
        name: { type: "string" },
        task: { type: "string" },
        source: { type: "string" },
        requiredSkills: { type: "array", items: { type: "string" } },
        priorityScore: { type: "integer" },
        dueHint: { type: "string" },
        metadata: { type: "object", additionalProperties: true }
      },
      additionalProperties: true
    },
    role: { type: "string" },
    assignedTo: { type: "string" }
  },
  additionalProperties: false
};

const completeSchema = {
  type: "object",
  required: ["locationId","taskLabel"],
  properties: {
    locationId: { type: "string" },
    taskLabel: { type: "string" },
    planId: { type: "string" },
    usedSupplies: {
      type: "array",
      items: {
        type: "object",
        required: ["name","qty","unit"],
        properties: {
          name: { type: "string" },
          qty: { type: "number", minimum: 0 },
          unit: { type: "string" }
        },
        additionalProperties: false
      }
    },
    when: { type: "string" },
    notes: { type: "string" }
  },
  additionalProperties: false
};

const suggestSchema = {
  type: "object",
  properties: {
    after: { type: "string" },
    windowDays: { type: "integer", minimum: 1, maximum: 60, default: 14 },
    slots: { type: "integer", minimum: 1, maximum: 20, default: 3 },
    sabbathAware: { type: "boolean", default: true },
    saturdayAsSabbath: { type: "boolean", default: false },
    quietHours: {
      type: "object",
      properties: { start: { type: "integer", minimum: 0, maximum: 23 }, end: { type: "integer", minimum: 0, maximum: 23 } },
      additionalProperties: false
    },
    durationMinutes: { type: "integer", minimum: 5, maximum: 24*60, default: 45 },
    defaultHour: { type: "integer", minimum: 0, maximum: 23, default: 9 },
    roomType: { type: "string" },
    priority: { type: "integer", minimum: 1, maximum: 5 }
  },
  additionalProperties: false
};

const validateLocation = ajv.compile(locationSchema);
const validatePlan = ajv.compile(planSchema);
const validateAssign = ajv.compile(assignSchema);
const validateComplete = ajv.compile(completeSchema);
const validateSuggest = ajv.compile(suggestSchema);

const bad = (res, msg, code = 400, details = undefined) => res.status(code).json({ ok: false, error: msg, details });
const ok = (res, data, meta = {}) => res.json({ ok: true, data, meta });

/* ------------------------------ Health ------------------------------ */

router.get("/health", (_req, res) => ok(res, { tz: DEFAULT_TZ, models: { CleaningLocation: !!CleaningLocation, CleaningPlan: !!CleaningPlan } }));

/* ------------------------------ Locations CRUD ------------------------------ */

// GET /cleaning/locations?roomType=&q=
router.get("/locations", (req, res) => {
  const q = req.query.q ? String(req.query.q).toLowerCase() : null;
  const roomType = req.query.roomType ? String(req.query.roomType).toLowerCase() : null;
  const rows = Array.from(mem.locations.values()).filter((l) => {
    if (roomType && String(l.roomType || "").toLowerCase() !== roomType) return false;
    if (!q) return true;
    return [l.name, l.customNotes, ...(l.tags || [])].join(" ").toLowerCase().includes(q);
  });
  return ok(res, rows);
});

// POST /cleaning/locations
router.post("/locations", express.json(), (req, res) => {
  const body = req.body || {};
  if (!validateLocation(body)) {
    const msg = validateLocation.errors?.map(e => `${e.instancePath || "/"} ${e.message}`).join("; ");
    return bad(res, msg || "Invalid location payload", 422, validateLocation.errors);
  }
  const loc = CleaningLocation ? new CleaningLocation(body) : { ...body, id: body.id || `loc-${uid()}`, createdAt: new Date(), updatedAt: new Date() };
  mem.locations.set(loc.id, loc);
  return ok(res, loc);
});

// PATCH /cleaning/locations/:id
router.patch("/locations/:id", express.json(), (req, res) => {
  const id = req.params.id;
  const cur = mem.locations.get(id);
  if (!cur) return bad(res, "Location not found", 404);
  const merged = { ...cur, ...req.body, updatedAt: new Date() };
  mem.locations.set(id, merged);
  return ok(res, merged);
});

// DELETE /cleaning/locations/:id
router.delete("/locations/:id", (req, res) => {
  const okDel = mem.locations.delete(req.params.id);
  if (!okDel) return bad(res, "Location not found", 404);
  return ok(res, { id: req.params.id });
});

/* ------------------------------ Plans CRUD ------------------------------ */

// GET /cleaning/plans?active=true
router.get("/plans", (req, res) => {
  const active = req.query.active != null ? parseBool(req.query.active, true) : null;
  let rows = Array.from(mem.plans.values());
  if (active != null) rows = rows.filter((p) => !!p.isActive === active);
  return ok(res, rows);
});

// POST /cleaning/plans
router.post("/plans", express.json(), (req, res) => {
  const body = req.body || {};
  if (!validatePlan(body)) {
    const msg = validatePlan.errors?.map(e => `${e.instancePath || "/"} ${e.message}`).join("; ");
    return bad(res, msg || "Invalid plan payload", 422, validatePlan.errors);
  }
  const plan = CleaningPlan ? new CleaningPlan(body) : { ...body, id: body.id || `plan-${uid()}`, createdAt: new Date(), updatedAt: new Date() };
  mem.plans.set(plan.id, plan);
  return ok(res, plan);
});

// PATCH /cleaning/plans/:id
router.patch("/plans/:id", express.json(), (req, res) => {
  const id = req.params.id;
  const cur = mem.plans.get(id);
  if (!cur) return bad(res, "Plan not found", 404);
  const merged = { ...cur, ...req.body, updatedAt: new Date() };
  mem.plans.set(id, merged);
  return ok(res, merged);
});

// DELETE /cleaning/plans/:id
router.delete("/plans/:id", (req, res) => {
  const okDel = mem.plans.delete(req.params.id);
  if (!okDel) return bad(res, "Plan not found", 404);
  return ok(res, { id: req.params.id });
});

/* ------------------------------ Queue / Expansion ------------------------------ */

/**
 * GET /cleaning/queue
 * Combines:
 *  - Active plan routines (today)
 *  - Deep-clean rotation: any location with isDeepCleanArea=true (weekly shard by day)
 * Optional query:
 *  - sabbathAware=true&defaultHour=9
 */
router.get("/queue", (req, res) => {
  const sabbathAware = parseBool(req.query.sabbathAware, true);
  const saturdayAsSabbath = parseBool(req.query.saturdayAsSabbath, false);
  const quietHours = { start: Number(req.query.qhStart ?? 21), end: Number(req.query.qhEnd ?? 7) };
  const defaultHour = Number.isFinite(Number(req.query.defaultHour)) ? Number(req.query.defaultHour) : 9;

  const today = new Date(); today.setSeconds(0,0);
  const nudge = (d) => sabbathAware ? nudgeToAllowed(d, { avoidSabbath: true, saturdayAsSabbath, quietHours, defaultHour }) : d;

  const tasks = [];

  // From plans.routine (quick & generic)
  for (const plan of mem.plans.values()) {
    if (!plan.isActive) continue;
    const dayName = today.toLocaleDateString("en-US", { weekday: "long" });
    const entries = plan.routine?.[dayName] || [];
    for (const entry of entries) {
      const start = nudge(new Date(today.getFullYear(), today.getMonth(), today.getDate(), (entry.time ? Number(String(entry.time).split(":")[0]) : defaultHour), 0, 0, 0));
      tasks.push({
        id: `routine-${plan.id}-${entry.name}-${start.toISOString()}`,
        icon: "🧽",
        name: entry.name,
        task: entry.name,
        priority: "medium",
        recommendedRole: "cleaner",
        requiredSkills: ["cleaning","sanitation","organization"],
        source: "cleaning:plan",
        due: start,
        metadata: { planId: plan.id }
      });
    }
  }

  // Deep clean rotation: shard by weekday across deepCleanZones
  const deepZones = Array.from(mem.locations.values()).filter((l) => l.isDeepCleanArea);
  if (deepZones.length) {
    const weekday = today.getDay(); // 0..6
    const zone = deepZones[weekday % deepZones.length];
    if (zone) {
      const start = nudge(new Date(today.getFullYear(), today.getMonth(), today.getDate(), defaultHour, 0, 0, 0));
      tasks.push({
        id: `deep-${zone.id}-${start.toISOString()}`,
        icon: "🧹",
        name: `Deep clean: ${zone.name}`,
        task: `Deep clean ${zone.name}`,
        priority: "high",
        recommendedRole: "cleaner",
        requiredSkills: ["cleaning","sanitation","organization"],
        source: "cleaning:deep",
        due: start,
        metadata: { locationId: zone.id }
      });
    }
  }

  // Location-specific recurring tasks due (simple: if frequency daily or lastCompleted >= 1 interval)
  const dueFromLocations = [];
  for (const loc of mem.locations.values()) {
    for (const t of (loc.tasks || [])) {
      const label = t.label || "Task";
      const freq = String(t.frequency || "weekly").toLowerCase();
      const last = t.lastCompleted ? new Date(t.lastCompleted) : null;
      let due = new Date(today); due.setHours(defaultHour,0,0,0);
      const add = (days) => new Date((last || new Date(today.getTime() - DAY)).getTime() + days*DAY);
      if (freq.startsWith("daily")) due = add(1);
      else if (freq.startsWith("monthly")) { const tmp = last || new Date(today); tmp.setMonth((tmp.getMonth())+1); due = tmp; }
      else due = add(7); // weekly default

      due = nudge(due);
      if (due <= new Date(today.getTime() + DAY)) {
        dueFromLocations.push({
          id: `loc-${loc.id}-${label}-${due.toISOString()}`,
          icon: "🫧",
          name: `${label} @ ${loc.name}`,
          task: `${label} @ ${loc.name}`,
          priority: "medium",
          recommendedRole: "cleaner",
          requiredSkills: ["cleaning","sanitation","organization"],
          source: "cleaning:location",
          due,
          metadata: { locationId: loc.id, label }
        });
      }
    }
  }

  const all = [...tasks, ...dueFromLocations].sort((a,b) => a.due - b.due);
  return ok(res, all, { count: all.length });
});

/* ------------------------------ Assignments ------------------------------ */

// POST /cleaning/queue/assign
router.post("/queue/assign", express.json(), async (req, res) => {
  const body = req.body || {};
  if (!validateAssign(body)) {
    const msg = validateAssign.errors?.map(e => `${e.instancePath || "/"} ${e.message}`).join("; ");
    return bad(res, msg || "Invalid assignment payload", 422, validateAssign.errors);
  }
  if (WorkerTasks?.assignTaskToWorker) {
    try {
      const a = await WorkerTasks.assignTaskToWorker(body);
      return ok(res, a);
    } catch (e) {
      // fall through to stub
    }
  }
  const stub = {
    id: `task-${uid()}`,
    ...body,
    status: "pending",
    recommendedTools: [],
    createdAt: new Date().toISOString()
  };
  return ok(res, stub, { note: "WorkerTasks not available; returned local stub." });
});

/* ------------------------------ Completion ------------------------------ */

// POST /cleaning/tasks/complete
router.post("/tasks/complete", express.json(), async (req, res) => {
  const body = req.body || {};
  if (!validateComplete(body)) {
    const msg = validateComplete.errors?.map(e => `${e.instancePath || "/"} ${e.message}`).join("; ");
    return bad(res, msg || "Invalid completion payload", 422, validateComplete.errors);
  }
  const { locationId, taskLabel, planId = null, usedSupplies = [], when = new Date().toISOString(), notes = "" } = body;

  const loc = mem.locations.get(locationId);
  if (!loc) return bad(res, "Location not found", 404);

  // mark task as completed in location
  const t = (loc.tasks || []).find((x) => (x.label || "").toLowerCase() === taskLabel.toLowerCase());
  if (t) t.lastCompleted = toISO(when);
  loc.updatedAt = new Date(); mem.locations.set(loc.id, loc);

  // audit log
  const key = `${locationId}:${taskLabel}`;
  const arr = mem.completions.get(key) || [];
  arr.push({ at: toISO(when), taskLabel, locId: locationId, planId, notes });
  mem.completions.set(key, arr);

  // decrement supplies if model available
  const supplyEvents = [];
  if (SupplyInventory && Array.isArray(usedSupplies) && usedSupplies.length) {
    // In a real app, you'd look up by name/id and convert units. Here, emit stubs to act on elsewhere.
    for (const s of usedSupplies) {
      supplyEvents.push({ name: s.name, delta: -Math.abs(Number(s.qty || 0)), unit: s.unit });
    }
  }

  // optional reminder/cadence boost (gamification)
  if (ReminderManager && planId) {
    try {
      await ReminderManager.addReminder({
        label: `Next: ${taskLabel} @ ${loc.name}`,
        date: new Date(Date.now() + 7*DAY).toISOString(),
        message: `Auto-scheduled reminder for ${taskLabel} at ${loc.name}.`,
        tags: ["cleaning","routine"]
      });
    } catch {}
  }

  return ok(res, { location: loc, supplyEvents, completion: { key, count: arr.length } });
});

/* ------------------------------ Calendar bridge ------------------------------ */

// POST /cleaning/calendarize
// Body: { provider, calendarId, events: [{ title, start, end, location?, metadata? }], sabbathAware?, quietHours?, defaultHour? }
router.post("/calendarize", express.json(), async (req, res) => {
  if (!calendarService?.createEventsBatch && !calendarService?.createEvent) {
    return bad(res, "calendarService not available", 501);
  }
  const body = req.body || {};
  const provider = String(body.provider || "local");
  const calendarId = String(body.calendarId || "household");
  const sabbathAware = parseBool(body.sabbathAware, true);
  const saturdayAsSabbath = parseBool(body.saturdayAsSabbath, false);
  const quietHours = body.quietHours || { start: 21, end: 7 };
  const defaultHour = Number.isFinite(body.defaultHour) ? body.defaultHour : 9;

  const events = (body.events || []).map((e, i) => {
    const start = sabbathAware ? nudgeToAllowed(new Date(e.start), { avoidSabbath: true, saturdayAsSabbath, quietHours, defaultHour }) : new Date(e.start);
    const end = e.end ? new Date(e.end) : new Date(start.getTime() + 45*60_000);
    return {
      title: e.title || e.name || `Cleaning Task #${i+1}`,
      description: e.description || e.task || "",
      start: toISO(start),
      end: toISO(end),
      timezone: DEFAULT_TZ,
      allDay: false,
      location: e.location || "",
      reminders: [{ minutes: 10, method: "popup" }],
      metadata: { source: "cleaning", ...(e.metadata || {}) },
      externalId: e.externalId || `clean-${uid()}`
    };
  });

  let result;
  if (calendarService.createEventsBatch) {
    result = await calendarService.createEventsBatch({ provider, calendarId, events, upsert: true });
  } else {
    result = [];
    for (const ev of events) result.push(await calendarService.createEvent({ provider, calendarId, data: ev, upsert: true }));
  }
  return ok(res, { created: events.length, result });
});

/* ------------------------------ Suggestions ------------------------------ */

// POST /cleaning/schedule/suggest
router.post("/schedule/suggest", express.json(), (req, res) => {
  const body = req.body || {};
  if (!validateSuggest(body)) {
    const msg = validateSuggest.errors?.map(e => `${e.instancePath || "/"} ${e.message}`).join("; ");
    return bad(res, msg || "Invalid payload", 422, validateSuggest.errors);
  }
  const {
    after = new Date().toISOString(),
    windowDays = 14,
    slots = 3,
    sabbathAware = true,
    saturdayAsSabbath = false,
    quietHours,
    durationMinutes = 45,
    defaultHour = 9
  } = body;

  const out = [];
  let cursor = new Date(after);
  const end = new Date(new Date(after).getTime() + windowDays * DAY);

  while (cursor <= end && out.length < slots) {
    const base = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), defaultHour, 0, 0, 0);
    const pick = sabbathAware ? nudgeToAllowed(base, { avoidSabbath: true, saturdayAsSabbath, quietHours, defaultHour }) : base;
    if (pick >= new Date(after)) {
      out.push({ start: toISO(pick), end: toISO(new Date(pick.getTime() + clamp(durationMinutes, 5, 240) * 60_000)) });
    }
    cursor = new Date(cursor.getTime() + DAY);
  }

  return ok(res, out, { slots: out.length });
});

/* ------------------------------ Export ------------------------------ */

export default router;
