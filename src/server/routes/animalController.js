// src/server/routes/animalController.js

import { Router } from "express";

// --- Optional managers (use if present in your project) ---
let AnimalQueueManager = null;
let WorkerTasks = null;
let SupplyInventory = null;
let ReminderManager = null;

try { AnimalQueueManager = (await import("../../managers/AnimalQueueManager.js")).default; } catch {}
try { WorkerTasks = (await import("../../managers/WorkerTasks.js")).default; } catch {}
try { SupplyInventory = (await import("../../models/SupplyInventory.js")).default; } catch {}
try { ReminderManager = (await import("../../managers/ReminderManager.js")).default; } catch {}

// --- Fallback in-memory store (replace with real DB/ORM) ---
const mem = {
  animals: new Map(), // id -> animal
  logs: new Map(),    // animalId -> [{ id, type, at, data }]
  events: new Map(),  // animalId -> [{ id, type, at, meta }]
};
const uid = () =>
  (typeof crypto !== "undefined" && crypto.randomUUID)
    ? crypto.randomUUID()
    : `id-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

const router = Router();

/* --------------------------------- Helpers --------------------------------- */

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const pick = (obj, keys) =>
  keys.reduce((acc, k) => (obj[k] !== undefined ? ((acc[k] = obj[k]), acc) : acc), {});

const parseBool = (v, d = false) => {
  if (v === undefined || v === null) return d;
  if (typeof v === "boolean") return v;
  const s = String(v).toLowerCase();
  return ["1", "true", "yes", "y"].includes(s) ? true : ["0", "false", "no", "n"].includes(s) ? false : d;
};

function inQuietHours(date, { start = 21, end = 7 } = {}) {
  const h = date.getHours();
  return start < end ? (h >= start && h < end) : (h >= start || h < end);
}
function isSabbath(date, { avoidSabbath = true, saturdayAsSabbath = false } = {}) {
  if (!avoidSabbath) return false;
  // Approximate Hebrew Day 7 as Saturday-avoid here; upstream calendar can refine.
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

function ok(res, data, meta = {}) { return res.json({ ok: true, data, meta }); }
function bad(res, msg, code = 400) { return res.status(code).json({ ok: false, error: msg }); }

// Basic guards
function validateAnimal(body) {
  const errors = [];
  if (!body || typeof body !== "object") errors.push("Invalid payload.");
  if (!body.name || String(body.name).trim() === "") errors.push("Animal 'name' is required.");
  if (!body.species || String(body.species).trim() === "") errors.push("Animal 'species' is required.");
  if (body.sex && !["male", "female", "unknown"].includes(String(body.sex).toLowerCase()))
    errors.push("Field 'sex' must be male|female|unknown.");
  return errors;
}

function applyPatch(target, patch, allowed) {
  for (const k of allowed) if (patch[k] !== undefined) target[k] = patch[k];
  target.updatedAt = new Date().toISOString();
  return target;
}

/* ----------------------------- Fallback Store ------------------------------ */

const Store = {
  list({ page = 1, pageSize = 20, filters = {} }) {
    const all = Array.from(mem.animals.values());
    let rows = all;
    if (filters.species) rows = rows.filter(a => String(a.species).toLowerCase() === String(filters.species).toLowerCase());
    if (filters.status) rows = rows.filter(a => String(a.status || "active").toLowerCase() === String(filters.status).toLowerCase());
    if (filters.tag) rows = rows.filter(a => (a.tags || []).map(t => t.toLowerCase()).includes(String(filters.tag).toLowerCase()));
    if (filters.sex) rows = rows.filter(a => String(a.sex || "unknown").toLowerCase() === String(filters.sex).toLowerCase());

    rows.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const total = rows.length;
    const start = (page - 1) * pageSize;
    const slice = rows.slice(start, start + pageSize);
    return { rows: slice, total };
  },
  get(id) { return mem.animals.get(id) || null; },
  add(animal) { mem.animals.set(animal.id, animal); return animal; },
  update(id, patch) {
    const a = mem.animals.get(id);
    if (!a) return null;
    applyPatch(a, patch, [
      "name","species","breed","sex","dob","status","tags","location","notes",
      "milkingSchedule","feedingSchedule","butcherReadyOn","weightKg","idTag","imageUrl"
    ]);
    mem.animals.set(id, a);
    return a;
  },
  remove(id) { return mem.animals.delete(id); },

  addLog(animalId, log) {
    const list = mem.logs.get(animalId) || [];
    list.push(log);
    mem.logs.set(animalId, list);
    return log;
  },
  getLogs(animalId, { type = null } = {}) {
    const list = mem.logs.get(animalId) || [];
    return type ? list.filter(l => l.type === type) : list;
  },
  addEvent(animalId, evt) {
    const list = mem.events.get(animalId) || [];
    list.push(evt);
    mem.events.set(animalId, list);
    return evt;
  },
  getEvents(animalId) { return mem.events.get(animalId) || []; }
};

/* --------------------------------- Routes ---------------------------------- */

/**
 * GET /animals
 * Query: page, pageSize, species, status, tag, sex, q (search)
 */
router.get(
  "/animals",
  asyncHandler(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page || "1", 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize || "20", 10)));
    const filters = pick(req.query, ["species", "status", "tag", "sex"]);
    const { rows, total } = Store.list({ page, pageSize, filters });

    // lightweight search on name/idTag/breed
    const q = req.query.q ? String(req.query.q).toLowerCase() : null;
    const data = q
      ? rows.filter(a =>
          (a.name || "").toLowerCase().includes(q) ||
          (a.breed || "").toLowerCase().includes(q) ||
          (a.idTag || "").toLowerCase().includes(q))
      : rows;

    return ok(res, data, { page, pageSize, total });
  })
);

/**
 * POST /animals
 * Body: { name, species, breed?, sex?, dob?, tags?, location?, notes?, milkingSchedule?, feedingSchedule?, idTag?, imageUrl? }
 */
router.post(
  "/animals",
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const errors = validateAnimal(body);
    if (errors.length) return bad(res, errors.join(" | "), 422);

    const animal = {
      id: body.id || uid(),
      name: body.name,
      species: body.species, // e.g., "goat", "cow", "chicken"
      breed: body.breed || "",
      sex: (body.sex || "unknown").toLowerCase(),
      dob: body.dob || null,
      status: (body.status || "active").toLowerCase(), // active | sick | dry | culled | sold
      tags: Array.isArray(body.tags) ? body.tags : [],
      location: body.location || "",
      notes: body.notes || "",
      milkingSchedule: body.milkingSchedule || null,    // e.g., { times:["07:00","18:00"] }
      feedingSchedule: body.feedingSchedule || null,    // e.g., { times:["08:00"], ration:{ hayKg: 2 } }
      butcherReadyOn: body.butcherReadyOn || null,      // ISO
      weightKg: Number(body.weightKg || 0),
      idTag: body.idTag || "",
      imageUrl: body.imageUrl || "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    Store.add(animal);
    return ok(res, animal);
  })
);

/**
 * GET /animals/:id
 */
router.get(
  "/animals/:id",
  asyncHandler(async (req, res) => {
    const a = Store.get(req.params.id);
    if (!a) return bad(res, "Animal not found", 404);
    const logs = Store.getLogs(a.id);
    const events = Store.getEvents(a.id);
    return ok(res, { ...a, logsCount: logs.length, upcomingEvents: events.filter(e => new Date(e.at) >= new Date()) });
  })
);

/**
 * PATCH /animals/:id
 */
router.patch(
  "/animals/:id",
  asyncHandler(async (req, res) => {
    const a = Store.get(req.params.id);
    if (!a) return bad(res, "Animal not found", 404);
    const allowed = [
      "name","species","breed","sex","dob","status","tags","location","notes",
      "milkingSchedule","feedingSchedule","butcherReadyOn","weightKg","idTag","imageUrl"
    ];
    const patch = pick(req.body || {}, allowed);
    const updated = Store.update(a.id, patch);
    return ok(res, updated);
  })
);

/**
 * DELETE /animals/:id
 */
router.delete(
  "/animals/:id",
  asyncHandler(async (req, res) => {
    const okDel = Store.remove(req.params.id);
    if (!okDel) return bad(res, "Animal not found", 404);
    return ok(res, { id: req.params.id });
  })
);

/* ----------------------------- Logs & Health ------------------------------- */

/**
 * POST /animals/:id/logs
 * Body: { type: "health"|"feeding"|"milking"|"weight"|"vaccination"|"butcher"|"note", at?: ISO, data?: any }
 */
router.post(
  "/animals/:id/logs",
  asyncHandler(async (req, res) => {
    const a = Store.get(req.params.id);
    if (!a) return bad(res, "Animal not found", 404);
    const { type, at, data } = req.body || {};
    const allowed = ["health", "feeding", "milking", "weight", "vaccination", "butcher", "note"];
    if (!allowed.includes(type)) return bad(res, `Invalid log type. Allowed: ${allowed.join(", ")}`, 422);
    const row = {
      id: uid(),
      animalId: a.id,
      type,
      at: at ? new Date(at).toISOString() : new Date().toISOString(),
      data: data || {}
    };
    Store.addLog(a.id, row);

    // lightweight side-effects
    if (type === "milking" && data?.liters != null) {
      // Could aggregate daily milk yield per animal for dashboards
    }
    if (type === "weight" && data?.kg != null) {
      Store.update(a.id, { weightKg: Number(data.kg) });
    }

    return ok(res, row);
  })
);

/**
 * GET /animals/:id/logs?type=milking
 */
router.get(
  "/animals/:id/logs",
  asyncHandler(async (req, res) => {
    const a = Store.get(req.params.id);
    if (!a) return bad(res, "Animal not found", 404);
    const type = req.query.type ? String(req.query.type) : null;
    const rows = Store.getLogs(a.id, { type });
    return ok(res, rows);
  })
);

/* --------------------------- Breeding & Lifecycle --------------------------- */

/**
 * POST /animals/:id/breed
 * Body: { partnerId?: string, bredAt?: ISO, expectedDue?: ISO, notes? }
 */
router.post(
  "/animals/:id/breed",
  asyncHandler(async (req, res) => {
    const dam = Store.get(req.params.id);
    if (!dam) return bad(res, "Animal not found", 404);
    const { partnerId = null, bredAt = null, expectedDue = null, notes = "" } = req.body || {};
    const evt = {
      id: uid(),
      animalId: dam.id,
      type: "breeding",
      at: bredAt ? new Date(bredAt).toISOString() : new Date().toISOString(),
      meta: { partnerId, expectedDue: expectedDue ? new Date(expectedDue).toISOString() : null, notes }
    };
    Store.addEvent(dam.id, evt);

    // optional reminder for expected due date (if ReminderManager is available)
    if (ReminderManager && evt.meta.expectedDue) {
      await ReminderManager.addReminder({
        label: `Check ${dam.name} for kidding/calving`,
        date: evt.meta.expectedDue,
        message: `Breeding due window for ${dam.name}${partnerId ? ` (partner ${partnerId})` : ""}.`,
        tags: ["breeding","animal"]
      }).catch(() => {});
    }

    return ok(res, evt);
  })
);

/**
 * GET /animals/:id/events
 */
router.get(
  "/animals/:id/events",
  asyncHandler(async (req, res) => {
    const a = Store.get(req.params.id);
    if (!a) return bad(res, "Animal not found", 404);
    return ok(res, Store.getEvents(a.id));
  })
);

/* --------------------------------- Queue ----------------------------------- */

/**
 * GET /animals/queue
 * Returns animal task queue formatted for UI; falls back to naive queue if manager not present.
 */
router.get(
  "/animals/queue",
  asyncHandler(async (_req, res) => {
    if (AnimalQueueManager?.getQueueFormattedForUI) {
      const queue = await AnimalQueueManager.getQueueFormattedForUI();
      return ok(res, queue);
    }
    // Fallback: synthesize simple tasks based on schedules
    const rows = Array.from(mem.animals.values()).flatMap((a) => {
      const out = [];
      if (a.feedingSchedule?.times?.length) {
        out.push({
          id: `feed-${a.id}`,
          icon: "🐾",
          name: `Feed ${a.name}`,
          task: `Feed ${a.name} (${(a.feedingSchedule.times || []).join(", ")})`,
          priority: "medium",
          recommendedRole: "farm hand",
          requiredSkills: ["animal care", "feeding"],
          source: "animal"
        });
      }
      if (a.milkingSchedule?.times?.length && a.sex === "female" && a.status !== "dry") {
        out.push({
          id: `milk-${a.id}`,
          icon: "🥛",
          name: `Milk ${a.name}`,
          task: `Milk ${a.name} (${(a.milkingSchedule.times || []).join(", ")})`,
          priority: "high",
          recommendedRole: "milker",
          requiredSkills: ["milking", "sanitation"],
          source: "animal"
        });
      }
      if (a.butcherReadyOn) {
        out.push({
          id: `butcher-${a.id}`,
          icon: "🔪",
          name: `Butcher scheduling: ${a.name}`,
          task: `Schedule butchering for ${a.name}`,
          priority: "high",
          recommendedRole: "butcher",
          requiredSkills: ["butchering","safety","sanitation"],
          source: "animal"
        });
      }
      return out;
    });
    return ok(res, rows);
  })
);

/**
 * POST /animals/queue/assign
 * Body: { taskId, task (full object), assignedTo?, role? }
 * Bridges to WorkerTasks.assignTaskToWorker if present; otherwise returns a stub.
 */
router.post(
  "/animals/queue/assign",
  asyncHandler(async (req, res) => {
    const { taskId, task, assignedTo = null, role = null } = req.body || {};
    if (!taskId || !task) return bad(res, "taskId and task are required.", 422);

    if (WorkerTasks?.assignTaskToWorker) {
      const assignment = await WorkerTasks.assignTaskToWorker({ taskId, task, assignedTo, role }).catch(() => null);
      if (assignment) return ok(res, assignment);
    }
    // Fallback stub
    const assignment = {
      id: `task-${uid()}`,
      taskId,
      label: task.name,
      details: task.task,
      assignedTo,
      role,
      status: "pending",
      recommendedTools: [],
      createdAt: new Date().toISOString(),
      due: null,
      source: task.source || "animal"
    };
    return ok(res, assignment, { note: "WorkerTasks manager not available; returned local stub." });
  })
);

/* -------------------------- Bulk Actions & Scheduling ----------------------- */

/**
 * POST /animals/actions/feed
 * Body: { animalIds?: string[], at?: ISO, ration?: any, avoidSabbath?, saturdayAsSabbath?, quietHours? }
 * Creates feed tasks (and optional WorkerTask assignments).
 */
router.post(
  "/animals/actions/feed",
  asyncHandler(async (req, res) => {
    const { animalIds = [], at = null, ration = null } = req.body || {};
    const opts = {
      avoidSabbath: parseBool(req.body?.avoidSabbath, true),
      saturdayAsSabbath: parseBool(req.body?.saturdayAsSabbath, false),
      quietHours: req.body?.quietHours || { start: 21, end: 7 },
      defaultHour: 8
    };
    const when = nudgeToAllowed(at ? new Date(at) : new Date(), opts, 8);

    const targets = (animalIds.length ? animalIds : Array.from(mem.animals.keys())).map(id => Store.get(id)).filter(Boolean);
    if (!targets.length) return bad(res, "No animals selected or available.", 422);

    const tasks = targets.map((a) => ({
      id: `feed-${a.id}-${when.toISOString()}`,
      icon: "🐾",
      name: `Feed ${a.name}`,
      task: `Feed ${a.name}${ration ? ` (ration: ${JSON.stringify(ration)})` : ""}`,
      priority: "medium",
      recommendedRole: "farm hand",
      requiredSkills: ["animal care", "feeding"],
      source: "animal",
      due: when
    }));

    // Optionally push to WorkerTasks
    const assignments = [];
    for (const t of tasks) {
      if (WorkerTasks?.assignTaskToWorker) {
        const payload = {
          taskId: t.id,
          task: {
            id: t.id,
            name: t.name,
            task: t.task,
            source: "animal",
            requiredSkills: t.requiredSkills,
            priorityScore: 55,
            dueHint: t.due
          },
          role: "farm hand",
          assignedTo: null
        };
        const a = await WorkerTasks.assignTaskToWorker(payload).catch(() => null);
        if (a) assignments.push(a);
      }
    }

    return ok(res, { when, tasks, assignments }, { scheduled: tasks.length });
  })
);

/**
 * POST /animals/actions/milk
 * Body: { animalIds?: string[], at?: ISO, avoidSabbath?, saturdayAsSabbath?, quietHours? }
 */
router.post(
  "/animals/actions/milk",
  asyncHandler(async (req, res) => {
    const { animalIds = [], at = null } = req.body || {};
    const opts = {
      avoidSabbath: parseBool(req.body?.avoidSabbath, true),
      saturdayAsSabbath: parseBool(req.body?.saturdayAsSabbath, false),
      quietHours: req.body?.quietHours || { start: 21, end: 7 },
      defaultHour: 6
    };
    const when = nudgeToAllowed(at ? new Date(at) : new Date(), opts, 6);

    const targets = (animalIds.length ? animalIds : Array.from(mem.animals.keys()))
      .map(id => Store.get(id))
      .filter(a => a && a.sex === "female" && a.status !== "dry");

    if (!targets.length) return bad(res, "No eligible animals for milking.", 422);

    const tasks = targets.map((a) => ({
      id: `milk-${a.id}-${when.toISOString()}`,
      icon: "🥛",
      name: `Milk ${a.name}`,
      task: `Milk ${a.name}`,
      priority: "high",
      recommendedRole: "milker",
      requiredSkills: ["milking", "sanitation"],
      source: "animal",
      due: when
    }));

    const assignments = [];
    for (const t of tasks) {
      if (WorkerTasks?.assignTaskToWorker) {
        const payload = {
          taskId: t.id,
          task: {
            id: t.id,
            name: t.name,
            task: t.task,
            source: "animal",
            requiredSkills: t.requiredSkills,
            priorityScore: 70,
            dueHint: t.due
          },
          role: "milker",
          assignedTo: null
        };
        const a = await WorkerTasks.assignTaskToWorker(payload).catch(() => null);
        if (a) assignments.push(a);
      }
    }

    return ok(res, { when, tasks, assignments }, { scheduled: tasks.length });
  })
);

/**
 * POST /animals/actions/butcher
 * Body: { animalId: string, at?: ISO, createInventory?: boolean }
 * Schedules butchering task; optionally creates SupplyInventory lot rows (stub).
 */
router.post(
  "/animals/actions/butcher",
  asyncHandler(async (req, res) => {
    const { animalId, at = null, createInventory = true } = req.body || {};
    if (!animalId) return bad(res, "animalId is required.", 422);
    const a = Store.get(animalId);
    if (!a) return bad(res, "Animal not found", 404);

    const opts = {
      avoidSabbath: parseBool(req.body?.avoidSabbath, true),
      saturdayAsSabbath: parseBool(req.body?.saturdayAsSabbath, false),
      quietHours: req.body?.quietHours || { start: 21, end: 7 },
      defaultHour: 10
    };
    const when = nudgeToAllowed(at ? new Date(at) : new Date(), opts, 10);

    const task = {
      id: `butcher-${a.id}-${when.toISOString()}`,
      icon: "🔪",
      name: `Butcher ${a.name}`,
      task: `Process ${a.name} humanely and safely; log yields by cut.`,
      priority: "high",
      recommendedRole: "butcher",
      requiredSkills: ["butchering","safety","sanitation"],
      source: "animal",
      due: when
    };

    let assignment = null;
    if (WorkerTasks?.assignTaskToWorker) {
      assignment = await WorkerTasks.assignTaskToWorker({
        taskId: task.id,
        task: {
          id: task.id,
          name: task.name,
          task: task.task,
          source: "animal",
          requiredSkills: task.requiredSkills,
          priorityScore: 85,
          dueHint: task.due
        },
        role: "butcher",
        assignedTo: null
      }).catch(() => null);
    }

    // Optional: seed inventory entries for expected yields (stub; refine downstream)
    let inventoryStub = null;
    if (createInventory && SupplyInventory) {
      // Very rough example—actual yields should be captured post-process via logs
      const expectedKg = Math.max(0, (a.weightKg || 0) * 0.45); // carcass ~45%
      inventoryStub = {
        cuts: [
          new SupplyInventory({ name: "Beef Roast (est.)", category: "cooking", unit: "kg", quantity: expectedKg * 0.25, location: "freezer" }).toJSON(),
          new SupplyInventory({ name: "Ground Meat (est.)", category: "cooking", unit: "kg", quantity: expectedKg * 0.35, location: "freezer" }).toJSON(),
          new SupplyInventory({ name: "Bones (stock)", category: "cooking", unit: "kg", quantity: expectedKg * 0.10, location: "freezer" }).toJSON(),
          new SupplyInventory({ name: "Fat/Trim", category: "cooking", unit: "kg", quantity: expectedKg * 0.05, location: "freezer" }).toJSON()
        ]
      };
    }

    return ok(res, { when, task, assignment, inventoryStub });
  })
);

/* --------------------------------- Exports --------------------------------- */

export default router;
