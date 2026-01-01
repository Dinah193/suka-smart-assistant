// src/server/routes/gardenController.js

import express from "express";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const router = express.Router();
const ajv = new Ajv({ allErrors: true, removeAdditional: "failing", strict: false });
addFormats(ajv);

/* ------------------------------ Optional imports ------------------------------ */
let GardenQueueManager = null;
let WorkerTasks = null;
let SupplyInventory = null;
let ToolInventory = null;
let ReminderManager = null;
let calendarService = null;

try { GardenQueueManager = (await import("../../managers/GardenQueueManager.js")).default; } catch {}
try { WorkerTasks = (await import("../../managers/WorkerTasks.js")).default; } catch {}
try { SupplyInventory = (await import("../../models/SupplyInventory.js")).default; } catch {}
try { ToolInventory = (await import("../../models/ToolInventory.js")).default; } catch {}
try { ReminderManager = (await import("../../managers/ReminderManager.js")).default; } catch {}
try { calendarService = (await import("../services/calendarService.js")).default || await import("../services/calendarService.js"); } catch {}

/* --------------------------------- State --------------------------------- */
const mem = {
  beds: new Map(),      // id -> { id, name, sizeSqft, zone, soil, tags, notes, rotations[], sensors[] }
  crops: new Map(),     // id -> { id, bedId, variety, family, stage, sowDate, transplantDate, expectedHarvestStart, expectedHarvestEnd, notes, tags }
  plans: new Map(),     // id -> { id, name, season, tasks[], goals[], notes, isActive }
  logs: new Map(),      // bedId or cropId keyed logs
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

const bad = (res, msg, code = 400, details) => res.status(code).json({ ok: false, error: msg, details });
const ok  = (res, data, meta = {}) => res.json({ ok: true, data, meta });

/* -------------------------------- Validation ------------------------------- */
const bedSchema = {
  type: "object",
  required: ["name"],
  properties: {
    id: { type: "string" },
    name: { type: "string", minLength: 1 },
    sizeSqft: { type: "number", minimum: 0 },
    zone: { type: "string" }, // e.g., "north garden", "greenhouse"
    soil: { type: "string" }, // e.g., "loam", "clay", "amended"
    tags: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
    rotations: { type: "array", items: { type: "string" } }, // e.g., ["brassica","legume","fruiting"]
    sensors: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, type: { type: "string" }, label: { type: "string" } },
        additionalProperties: true
      }
    }
  },
  additionalProperties: true
};

const cropSchema = {
  type: "object",
  required: ["bedId","variety"],
  properties: {
    id: { type: "string" },
    bedId: { type: "string" },
    variety: { type: "string", minLength: 1 }, // "Roma Tomato"
    family: { type: "string" }, // "Solanaceae"
    stage: { type: "string", enum: ["seed","seedling","transplanted","growing","flowering","harvest","ended"], default: "seed" },
    sowDate: { type: "string" },
    transplantDate: { type: "string" },
    expectedHarvestStart: { type: "string" },
    expectedHarvestEnd: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    notes: { type: "string" }
  },
  additionalProperties: true
};

const planSchema = {
  type: "object",
  required: ["name"],
  properties: {
    id: { type: "string" },
    name: { type: "string", minLength: 1 },
    season: { type: "string" }, // "Spring 2026"
    tasks: {
      type: "array",
      items: {
        type: "object",
        required: ["label"],
        properties: {
          label: { type: "string" },
          bedId: { type: "string" },
          frequency: { type: "string" }, // "weekly","biweekly","rrule:..."
          preferredHour: { type: "integer", minimum: 0, maximum: 23 },
          lastCompleted: { type: "string" },
          requiredSkills: { type: "array", items: { type: "string" } },
          role: { type: "string" }, // "gardener"
          priority: { type: "integer", minimum: 1, maximum: 5 }
        },
        additionalProperties: true
      }
    },
    goals: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
    isActive: { type: "boolean", default: true }
  },
  additionalProperties: true
};

const logSchema = {
  type: "object",
  required: ["type","refId"],
  properties: {
    type: { type: "string", enum: ["planting","harvest","pest","disease","fertilize","irrigation","note"] },
    refId: { type: "string" }, // bedId or cropId
    at: { type: "string" },
    data: { type: "object", additionalProperties: true },
    notes: { type: "string" }
  },
  additionalProperties: false
};

const queueAssignSchema = {
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
    zone: { type: "string" },
    priority: { type: "integer", minimum: 1, maximum: 5 }
  },
  additionalProperties: false
};

const validateBed   = ajv.compile(bedSchema);
const validateCrop  = ajv.compile(cropSchema);
const validatePlan  = ajv.compile(planSchema);
const validateLog   = ajv.compile(logSchema);
const validateAssign = ajv.compile(queueAssignSchema);
const validateSuggest = ajv.compile(suggestSchema);

/* ---------------------------------- Health ---------------------------------- */

router.get("/health", (_req, res) => ok(res, {
  tz: DEFAULT_TZ,
  managers: { GardenQueueManager: !!GardenQueueManager, WorkerTasks: !!WorkerTasks },
  models: { SupplyInventory: !!SupplyInventory, ToolInventory: !!ToolInventory }
}));

/* ---------------------------------- Beds ------------------------------------ */

// GET /garden/beds?q=&zone=
router.get("/beds", (req, res) => {
  const q = req.query.q ? String(req.query.q).toLowerCase() : null;
  const zone = req.query.zone ? String(req.query.zone).toLowerCase() : null;
  const rows = Array.from(mem.beds.values()).filter(b => {
    if (zone && String(b.zone || "").toLowerCase() !== zone) return false;
    if (!q) return true;
    return [b.name, b.notes, b.soil, ...(b.tags || [])].join(" ").toLowerCase().includes(q);
  });
  return ok(res, rows);
});

// POST /garden/beds
router.post("/beds", express.json(), (req, res) => {
  const body = req.body || {};
  if (!validateBed(body)) {
    const msg = validateBed.errors?.map(e => `${e.instancePath || "/"} ${e.message}`).join("; ");
    return bad(res, msg || "Invalid bed payload", 422, validateBed.errors);
  }
  const bed = { ...body, id: body.id || `bed-${uid()}`, createdAt: new Date(), updatedAt: new Date() };
  mem.beds.set(bed.id, bed);
  return ok(res, bed);
});

// PATCH /garden/beds/:id
router.patch("/beds/:id", express.json(), (req, res) => {
  const cur = mem.beds.get(req.params.id);
  if (!cur) return bad(res, "Bed not found", 404);
  const merged = { ...cur, ...req.body, updatedAt: new Date() };
  mem.beds.set(merged.id, merged);
  return ok(res, merged);
});

// DELETE /garden/beds/:id
router.delete("/beds/:id", (req, res) => {
  const okDel = mem.beds.delete(req.params.id);
  if (!okDel) return bad(res, "Bed not found", 404);
  return ok(res, { id: req.params.id });
});

/* ---------------------------------- Crops ----------------------------------- */

// GET /garden/crops?bedId=&stage=&q=
router.get("/crops", (req, res) => {
  const bedId = req.query.bedId ? String(req.query.bedId) : null;
  const stage = req.query.stage ? String(req.query.stage).toLowerCase() : null;
  const q = req.query.q ? String(req.query.q).toLowerCase() : null;

  let rows = Array.from(mem.crops.values());
  if (bedId) rows = rows.filter(c => c.bedId === bedId);
  if (stage) rows = rows.filter(c => String(c.stage || "").toLowerCase() === stage);
  if (q) rows = rows.filter(c => [c.variety, c.family, c.notes, ...(c.tags || [])].join(" ").toLowerCase().includes(q));

  return ok(res, rows);
});

// POST /garden/crops
router.post("/crops", express.json(), (req, res) => {
  const body = req.body || {};
  if (!validateCrop(body)) {
    const msg = validateCrop.errors?.map(e => `${e.instancePath || "/"} ${e.message}`).join("; ");
    return bad(res, msg || "Invalid crop payload", 422, validateCrop.errors);
  }
  if (!mem.beds.has(body.bedId)) return bad(res, "bedId not found", 404);
  const crop = { ...body, id: body.id || `crop-${uid()}`, createdAt: new Date(), updatedAt: new Date() };
  mem.crops.set(crop.id, crop);
  return ok(res, crop);
});

// PATCH /garden/crops/:id
router.patch("/crops/:id", express.json(), (req, res) => {
  const cur = mem.crops.get(req.params.id);
  if (!cur) return bad(res, "Crop not found", 404);
  const merged = { ...cur, ...req.body, updatedAt: new Date() };
  mem.crops.set(merged.id, merged);
  return ok(res, merged);
});

// DELETE /garden/crops/:id
router.delete("/crops/:id", (req, res) => {
  const okDel = mem.crops.delete(req.params.id);
  if (!okDel) return bad(res, "Crop not found", 404);
  return ok(res, { id: req.params.id });
});

/* ---------------------------------- Plans ----------------------------------- */

// GET /garden/plans?active=true
router.get("/plans", (req, res) => {
  const active = req.query.active != null ? parseBool(req.query.active, true) : null;
  let rows = Array.from(mem.plans.values());
  if (active != null) rows = rows.filter(p => !!p.isActive === active);
  return ok(res, rows);
});

// POST /garden/plans
router.post("/plans", express.json(), (req, res) => {
  const body = req.body || {};
  if (!validatePlan(body)) {
    const msg = validatePlan.errors?.map(e => `${e.instancePath || "/"} ${e.message}`).join("; ");
    return bad(res, msg || "Invalid plan payload", 422, validatePlan.errors);
  }
  const plan = { ...body, id: body.id || `gplan-${uid()}`, createdAt: new Date(), updatedAt: new Date() };
  mem.plans.set(plan.id, plan);
  return ok(res, plan);
});

// PATCH /garden/plans/:id
router.patch("/plans/:id", express.json(), (req, res) => {
  const cur = mem.plans.get(req.params.id);
  if (!cur) return bad(res, "Plan not found", 404);
  const merged = { ...cur, ...req.body, updatedAt: new Date() };
  mem.plans.set(merged.id, merged);
  return ok(res, merged);
});

// DELETE /garden/plans/:id
router.delete("/plans/:id", (req, res) => {
  const okDel = mem.plans.delete(req.params.id);
  if (!okDel) return bad(res, "Plan not found", 404);
  return ok(res, { id: req.params.id });
});

/* ---------------------------------- Logs ------------------------------------ */

// POST /garden/logs
router.post("/logs", express.json(), (req, res) => {
  const body = req.body || {};
  if (!validateLog(body)) {
    const msg = validateLog.errors?.map(e => `${e.instancePath || "/"} ${e.message}`).join("; ");
    return bad(res, msg || "Invalid log payload", 422, validateLog.errors);
  }
  const key = body.refId;
  const arr = mem.logs.get(key) || [];
  const row = { id: `log-${uid()}`, type: body.type, refId: key, at: body.at ? toISO(body.at) : toISO(new Date()), data: body.data || {}, notes: body.notes || "" };
  arr.push(row);
  mem.logs.set(key, arr);

  // Side-effects: simple state updates
  if (body.type === "harvest" && body.data?.weightKg != null) {
    // could update crop stage or yield aggregates; leaving as-is for now
  }
  if (body.type === "irrigation" && body.data?.minutes != null) {
    // future: sensor/moisture feedback
  }

  return ok(res, row);
});

// GET /garden/logs/:refId?type=
router.get("/logs/:refId", (req, res) => {
  const list = mem.logs.get(req.params.refId) || [];
  const filtered = req.query.type ? list.filter(l => l.type === String(req.query.type)) : list;
  return ok(res, filtered);
});

/* ---------------------------------- Queue ----------------------------------- */

// GET /garden/queue
router.get("/queue", async (_req, res) => {
  if (GardenQueueManager?.getQueueFormattedForUI) {
    try {
      const q = await GardenQueueManager.getQueueFormattedForUI();
      return ok(res, q);
    } catch {
      // fall through to synthetic
    }
  }
  // Synthetic queue from plans and crops
  const tasks = [];
  const now = new Date();
  const defaultHour = 9;

  // Plan tasks (simple weekly/biweekly heuristic)
  for (const plan of mem.plans.values()) {
    if (!plan.isActive) continue;
    for (const t of (plan.tasks || [])) {
      const label = t.label || "Task";
      const role = t.role || "gardener";
      const reqSkills = t.requiredSkills || ["gardening","harvest","planting"];
      const priority = t.priority || 3;

      // naive due check
      const last = t.lastCompleted ? new Date(t.lastCompleted) : null;
      let due = new Date(now.getFullYear(), now.getMonth(), now.getDate(), t.preferredHour ?? defaultHour, 0, 0, 0);
      const f = String(t.frequency || "weekly").toLowerCase();
      if (f.startsWith("biweekly")) due = new Date((last || new Date(now.getTime() - 14*DAY)).getTime() + 14*DAY);
      else if (f.startsWith("weekly")) due = new Date((last || new Date(now.getTime() - 7*DAY)).getTime() + 7*DAY);
      else due = new Date((last || new Date(now.getTime() - 7*DAY)).getTime() + 7*DAY);

      tasks.push({
        id: `plan-${plan.id}-${label}-${due.toISOString()}`,
        icon: "🌱",
        name: label,
        task: label,
        priority: priority >= 4 ? "high" : "medium",
        recommendedRole: role,
        requiredSkills: reqSkills,
        source: "garden:plan",
        due,
        metadata: { planId: plan.id, bedId: t.bedId || null }
      });
    }
  }

  // Crop-driven tasks (sow, transplant, harvest windows)
  for (const crop of mem.crops.values()) {
    if (crop.expectedHarvestStart) {
      const start = new Date(crop.expectedHarvestStart);
      const end = crop.expectedHarvestEnd ? new Date(crop.expectedHarvestEnd) : new Date(start.getTime() + 21*DAY);
      const next = new Date(Math.max(now.getTime(), start.getTime()));
      const due = new Date(next.getFullYear(), next.getMonth(), next.getDate(), 8, 0, 0, 0);
      tasks.push({
        id: `harvest-${crop.id}-${due.toISOString()}`,
        icon: "🧺",
        name: `Harvest ${crop.variety}`,
        task: `Harvest ${crop.variety} in bed ${crop.bedId}`,
        priority: "high",
        recommendedRole: "gardener",
        requiredSkills: ["harvest","gardening"],
        source: "garden:crop",
        due,
        metadata: { cropId: crop.id, window: { start, end } }
      });
    }
    if (crop.stage === "seed" && crop.sowDate) {
      const due = new Date(new Date(crop.sowDate).getTime() + 10*DAY);
      tasks.push({
        id: `thin-${crop.id}-${due.toISOString()}`,
        icon: "✂️",
        name: `Thin seedlings: ${crop.variety}`,
        task: `Thin seedlings in bed ${crop.bedId}`,
        priority: "medium",
        recommendedRole: "gardener",
        requiredSkills: ["planting","gardening"],
        source: "garden:crop",
        due,
        metadata: { cropId: crop.id }
      });
    }
  }

  tasks.sort((a,b) => a.due - b.due);
  return ok(res, tasks, { count: tasks.length });
});

/* -------------------------------- Assignments ------------------------------- */

// POST /garden/queue/assign
router.post("/queue/assign", express.json(), async (req, res) => {
  const body = req.body || {};
  if (!validateAssign(body)) {
    const msg = validateAssign.errors?.map(e => `${e.instancePath || "/"} ${e.message}`).join("; ");
    return bad(res, msg || "Invalid assignment payload", 422, validateAssign.errors);
  }
  if (WorkerTasks?.assignTaskToWorker) {
    try { return ok(res, await WorkerTasks.assignTaskToWorker(body)); }
    catch { /* fall-through */ }
  }
  return ok(res, {
    id: `task-${uid()}`,
    ...body,
    status: "pending",
    recommendedTools: [],
    createdAt: new Date().toISOString()
  }, { note: "WorkerTasks not available; local stub returned." });
});

/* --------------------------------- Actions ---------------------------------- */

// POST /garden/actions/plant
// Body: { bedId, variety, family?, at?, useSeeds?: [{name, qty, unit}], sabbathAware?, quietHours?, defaultHour? }
router.post("/actions/plant", express.json(), async (req, res) => {
  const { bedId, variety, family = "", at = null, useSeeds = [] } = req.body || {};
  if (!bedId || !variety) return bad(res, "bedId and variety are required.", 422);
  const bed = mem.beds.get(bedId); if (!bed) return bad(res, "Bed not found", 404);

  const opts = {
    avoidSabbath: parseBool(req.body?.sabbathAware, true),
    saturdayAsSabbath: parseBool(req.body?.saturdayAsSabbath, false),
    quietHours: req.body?.quietHours || { start: 21, end: 7 },
    defaultHour: Number.isFinite(req.body?.defaultHour) ? req.body.defaultHour : 9
  };
  const when = nudgeToAllowed(at ? new Date(at) : new Date(), opts, opts.defaultHour);

  // Create crop
  const crop = {
    id: `crop-${uid()}`,
    bedId,
    variety,
    family,
    stage: "seed",
    sowDate: toISO(when),
    createdAt: new Date(), updatedAt: new Date()
  };
  mem.crops.set(crop.id, crop);

  // Optional: decrement seed inventory (stubs)
  const inventoryOps = [];
  if (SupplyInventory && Array.isArray(useSeeds)) {
    for (const s of useSeeds) inventoryOps.push({ name: s.name, delta: -Math.abs(Number(s.qty || 0)), unit: s.unit || "seeds" });
  }

  // Optional: create planting task via WorkerTasks
  let assignment = null;
  if (WorkerTasks?.assignTaskToWorker) {
    assignment = await WorkerTasks.assignTaskToWorker({
      taskId: `plant-${crop.id}`,
      task: {
        id: `plant-${crop.id}`,
        name: `Plant ${variety}`,
        task: `Sow ${variety} in ${bed.name}`,
        source: "garden",
        requiredSkills: ["planting","gardening"],
        priorityScore: 60,
        dueHint: when,
        metadata: { bedId }
      },
      role: "gardener"
    }).catch(() => null);
  }

  return ok(res, { crop, when, inventoryOps, assignment });
});

// POST /garden/actions/harvest
// Body: { cropId, at?, yieldKg?, createInventory?: true }
router.post("/actions/harvest", express.json(), async (req, res) => {
  const { cropId, at = null, yieldKg = null, createInventory = true } = req.body || {};
  if (!cropId) return bad(res, "cropId is required.", 422);
  const crop = mem.crops.get(cropId); if (!crop) return bad(res, "Crop not found", 404);

  const when = at ? new Date(at) : new Date();
  const log = { id: `log-${uid()}`, type: "harvest", refId: cropId, at: toISO(when), data: { weightKg: yieldKg }, notes: "" };
  const arr = mem.logs.get(cropId) || []; arr.push(log); mem.logs.set(cropId, arr);

  // optional inventory: create produce items (stub)
  let inventoryStub = null;
  if (createInventory && SupplyInventory && yieldKg != null) {
    inventoryStub = [
      new SupplyInventory({ name: `${crop.variety} (fresh)`, category: "cooking", unit: "kg", quantity: Math.max(0, Number(yieldKg)), location: "pantry" }).toJSON()
    ];
  }

  // Optional mark crop stage
  crop.stage = "harvest"; crop.updatedAt = new Date(); mem.crops.set(crop.id, crop);

  return ok(res, { crop, log, inventoryStub });
});

// POST /garden/actions/irrigate
// Body: { bedIds?: [], minutes?: number, at?, sabbathAware?, quietHours?, defaultHour? }
router.post("/actions/irrigate", express.json(), async (req, res) => {
  const bedIds = Array.isArray(req.body?.bedIds) && req.body.bedIds.length ? req.body.bedIds : Array.from(mem.beds.keys());
  if (!bedIds.length) return bad(res, "No beds found to irrigate.", 422);

  const minutes = clamp(Number(req.body?.minutes || 30), 5, 180);
  const opts = {
    avoidSabbath: parseBool(req.body?.sabbathAware, true),
    saturdayAsSabbath: parseBool(req.body?.saturdayAsSabbath, false),
    quietHours: req.body?.quietHours || { start: 21, end: 7 },
    defaultHour: Number.isFinite(req.body?.defaultHour) ? req.body.defaultHour : 6
  };
  const when = nudgeToAllowed(req.body?.at ? new Date(req.body.at) : new Date(), opts, opts.defaultHour);

  const tasks = bedIds.map((id) => {
    const bed = mem.beds.get(id); if (!bed) return null;
    return {
      id: `irrigate-${id}-${when.toISOString()}`,
      icon: "💧",
      name: `Irrigate ${bed.name}`,
      task: `Run irrigation for ${minutes} minutes`,
      priority: "medium",
      recommendedRole: "gardener",
      requiredSkills: ["gardening","irrigation"],
      source: "garden",
      due: when,
      metadata: { bedId: id, minutes }
    };
  }).filter(Boolean);

  // Create WorkerTasks
  const assignments = [];
  if (WorkerTasks?.assignTaskToWorker) {
    for (const t of tasks) {
      const a = await WorkerTasks.assignTaskToWorker({
        taskId: t.id,
        task: {
          id: t.id, name: t.name, task: t.task, source: "garden",
          requiredSkills: t.requiredSkills, priorityScore: 55, dueHint: t.due, metadata: t.metadata
        },
        role: "gardener"
      }).catch(() => null);
      if (a) assignments.push(a);
    }
  }

  return ok(res, { when, minutes, tasks, assignments }, { scheduled: tasks.length });
});

/* ------------------------------- Calendar bridge ----------------------------- */

// POST /garden/calendarize
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
      title: e.title || e.name || `Garden Task #${i+1}`,
      description: e.description || e.task || "",
      start: toISO(start),
      end: toISO(end),
      timezone: DEFAULT_TZ,
      allDay: false,
      location: e.location || "",
      reminders: [{ minutes: 10, method: "popup" }],
      metadata: { source: "garden", ...(e.metadata || {}) },
      externalId: e.externalId || `garden-${uid()}`
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

/* -------------------------------- Suggestions -------------------------------- */

// POST /garden/schedule/suggest
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

  const suggestions = [];
  let cursor = new Date(after);
  const end = new Date(new Date(after).getTime() + windowDays * DAY);

  while (cursor <= end && suggestions.length < slots) {
    const base = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), defaultHour, 0, 0, 0);
    const pick = sabbathAware ? nudgeToAllowed(base, { avoidSabbath: true, saturdayAsSabbath, quietHours, defaultHour }) : base;
    if (pick >= new Date(after)) {
      suggestions.push({ start: toISO(pick), end: toISO(new Date(pick.getTime() + clamp(durationMinutes, 5, 240) * 60_000)) });
    }
    cursor = new Date(cursor.getTime() + DAY);
  }

  return ok(res, suggestions, { slots: suggestions.length });
});

export default router;
