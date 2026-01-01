// C:\Users\larho\suka-smart-assistant\src\server\routes\inventoryController.js
//
// Suka Smart Assistant — Inventory Controller (enhanced)
//
// Purpose:
//   Minimal, resilient HTTP API for inventory mutations from n8n workflows,
//   plus utilities for restock suggestions, unit conversion, and calendar/task bridges.
//
// Endpoints:
//   GET    /api/inventory/health
//   POST   /api/inventory/apply-delta          -> apply one or many deltas (consume/add/waste/preserve)
//   POST   /api/inventory/transfer             -> move stock between locations
//   POST   /api/inventory/batch                -> heterogeneous list of ops (delta/transfer)
//   GET    /api/inventory/items                -> lookup by sku or text (best-effort)
//   POST   /api/inventory/restock/check        -> returns low-stock alerts for given SKUs (if InventoryMonitor present)
//   POST   /api/inventory/restock/tasks        -> create WorkerTasks for low-stock items
//   POST   /api/inventory/restock/calendarize  -> make calendar events for restock runs (optional calendarService)
//   POST   /api/inventory/units/convert        -> best-effort unit conversion (or delegate if service provides)
//
// Notes:
//   - Delegates to src/server/services/inventoryService.js when available.
//     Optional functions (controller degrades gracefully):
//       applyDelta, applyDeltas, transfer, findItems, convertUnits
//   - Uses Ajv for payload validation.
//   - Adds Idempotency-Key handling to avoid duplicate delta application on retries.
//   - Optional Sabbath/quiet-hour nudging for calendarized restocks (consistent with project).
//
// Install: npm i ajv ajv-formats
//

import express from "express";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const router = express.Router();

const ajv = new Ajv({ allErrors: true, removeAdditional: "failing", strict: false });
addFormats(ajv);

/* -----------------------------------------------------------------------------
   Optional dynamic imports
----------------------------------------------------------------------------- */
let InventoryMonitor = null;
let WorkerTasks = null;
let calendarService = null;

try { InventoryMonitor = (await import("../../managers/InventoryMonitor.js")).default; } catch {}
try { WorkerTasks = (await import("../../managers/WorkerTasks.js")).default; } catch {}
try {
  // default or named export
  const mod = await import("../services/calendarService.js");
  calendarService = mod?.default || mod;
} catch {}

/* -----------------------------------------------------------------------------
   Helpers & Idempotency
----------------------------------------------------------------------------- */

function badRequest(res, message, details) {
  return res.status(400).json({ ok: false, error: message, details });
}

function notImplemented(res, hint) {
  return res.status(501).json({
    ok: false,
    error: "inventoryService not available",
    hint: hint || "Create src/server/services/inventoryService.js exporting applyDelta/applyDeltas/transfer/findItems/convertUnits",
  });
}

async function loadInventoryService() {
  try {
    const mod = await import("../services/inventoryService.js");
    return mod?.default || mod;
  } catch {
    return null;
  }
}

const idemCache = new Map(); // key -> expiresAt(ms)
const now = () => Date.now();
function pruneIdem() {
  const t = now();
  for (const [k, v] of idemCache.entries()) if (v <= t) idemCache.delete(k);
}
function idempotencyGuard(req, res, next) {
  pruneIdem();
  const key = req.header("Idempotency-Key") || req.header("idempotency-key");
  if (!key) return next();
  const exists = idemCache.get(key);
  if (exists && exists > now()) {
    return res.status(208).json({ ok: true, duplicate: true, note: "Duplicate request ignored (Idempotency-Key)." });
  }
  idemCache.set(key, now() + 10 * 60 * 1000); // 10 minutes
  return next();
}

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
  // Approximate: Saturday
  return saturdayAsSabbath ? date.getDay() === 6 : date.getDay() === 6;
}
function nudgeToAllowed(date, { avoidSabbath = true, saturdayAsSabbath = false, quietHours = { start: 21, end: 7 }, defaultHour = 10 } = {}) {
  let d = new Date(date);
  let guard = 0;
  while ((isSabbath(d, { avoidSabbath, saturdayAsSabbath }) || inQuietHours(d, quietHours)) && guard < 14) {
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, defaultHour, 0, 0, 0);
    guard++;
  }
  return d;
}

/* -----------------------------------------------------------------------------
   Schemas
----------------------------------------------------------------------------- */

const deltaSchema = {
  type: "object",
  required: ["userId", "sku", "qty", "unit"],
  properties: {
    userId: { type: "string", minLength: 1 },
    sku: { type: "string", minLength: 1 },
    name: { type: "string" }, // optional display name
    qty: { type: "number" },  // +add, -consume
    unit: { type: "string", minLength: 1 }, // "g","kg","ml","l","oz","lb","ct"
    reason: {
      type: "string",
      enum: ["consume", "add", "waste", "preserve", "adjustment", "transfer-out", "transfer-in"],
      default: "adjustment",
    },
    location: { type: "string" }, // "pantry","fridge","freezer","root-cellar","in-progress"
    meta: {
      type: "object",
      properties: {
        recipeId: { type: "string" },
        sessionId: { type: "string" },
        notes: { type: "string" },
        source: { type: "string" }, // e.g., "cooking.session.apply"
        tags: { type: "array", items: { type: "string" } }
      },
      additionalProperties: true
    },
  },
  additionalProperties: false,
};

const applyDeltaBodySchema = {
  type: "object",
  required: ["data"],
  properties: {
    data: {
      anyOf: [deltaSchema, { type: "array", items: deltaSchema, minItems: 1 }],
    },
  },
  additionalProperties: false,
};

const transferSchema = {
  type: "object",
  required: ["userId", "sku", "qty", "unit", "from", "to"],
  properties: {
    userId: { type: "string", minLength: 1 },
    sku: { type: "string", minLength: 1 },
    qty: { type: "number" },
    unit: { type: "string", minLength: 1 },
    from: { type: "string", minLength: 1 },
    to: { type: "string", minLength: 1 },
    meta: { type: "object", additionalProperties: true },
  },
  additionalProperties: false,
};

const batchSchema = {
  type: "object",
  required: ["ops"],
  properties: {
    // ops: [{ type: "delta"|"transfer", payload: {...} }]
    ops: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["type", "payload"],
        properties: {
          type: { type: "string", enum: ["delta", "transfer"] },
          payload: { oneOf: [deltaSchema, transferSchema] },
        },
        additionalProperties: false,
      },
    },
    stopOnError: { type: "boolean", default: true },
  },
  additionalProperties: false,
};

const findQuerySchema = {
  type: "object",
  properties: {
    userId: { type: "string", minLength: 1 },
    q: { type: "string" },
    sku: { type: "string" },
    limit: { type: "integer", minimum: 1, maximum: 100 },
  },
  additionalProperties: false,
};

const restockCheckSchema = {
  type: "object",
  required: ["skus"],
  properties: {
    skus: { type: "array", minItems: 1, items: { type: "string" } },
    includeSuggestions: { type: "boolean", default: true }
  },
  additionalProperties: false
};

const restockTasksSchema = {
  type: "object",
  required: ["items"],
  properties: {
    // items: [{ sku, name?, qtyNeeded?, location? }]
    items: {
      type: "array", minItems: 1, items: {
        type: "object",
        required: ["sku"],
        properties: {
          sku: { type: "string" },
          name: { type: "string" },
          qtyNeeded: { type: "number" },
          unit: { type: "string" },
          location: { type: "string" }
        },
        additionalProperties: true
      }
    }
  },
  additionalProperties: false
};

const calendarizeRestockSchema = {
  type: "object",
  properties: {
    provider: { type: "string", enum: ["google","outlook","local"], default: "local" },
    calendarId: { type: "string", default: "household" },
    sabbathAware: { type: "boolean", default: true },
    saturdayAsSabbath: { type: "boolean", default: false },
    quietHours: {
      type: "object",
      properties: { start: { type: "integer", minimum: 0, maximum: 23 }, end: { type: "integer", minimum: 0, maximum: 23 } },
      additionalProperties: false
    },
    defaultHour: { type: "integer", minimum: 0, maximum: 23, default: 10 },
    items: { type: "array", minItems: 1, items: { type: "object", additionalProperties: true } },
    when: { type: "string" }, // ISO preferred start
    durationMinutes: { type: "integer", minimum: 15, maximum: 6*60, default: 60 }
  },
  additionalProperties: false
};

const unitsConvertSchema = {
  type: "object",
  required: ["from","to","value"],
  properties: {
    from: { type: "string", minLength: 1 },
    to: { type: "string", minLength: 1 },
    value: { type: "number" },
    density: { type: "number" } // optional (for ml<->g conversions)
  },
  additionalProperties: false
};

const validateApplyDeltaBody = ajv.compile(applyDeltaBodySchema);
const validateTransfer        = ajv.compile(transferSchema);
const validateBatch           = ajv.compile(batchSchema);
const validateFindQuery       = ajv.compile(findQuerySchema);
const validateRestockCheck    = ajv.compile(restockCheckSchema);
const validateRestockTasks    = ajv.compile(restockTasksSchema);
const validateCalendarize     = ajv.compile(calendarizeRestockSchema);
const validateUnitsConvert    = ajv.compile(unitsConvertSchema);

/* -----------------------------------------------------------------------------
   Routes
----------------------------------------------------------------------------- */

/** Health */
router.get("/health", async (_req, res) => {
  const svc = await loadInventoryService();
  res.json({
    ok: true,
    tz: DEFAULT_TZ,
    services: {
      inventoryService: !!svc,
      applyDelta: !!svc?.applyDelta,
      applyDeltas: !!svc?.applyDeltas,
      transfer: !!svc?.transfer,
      findItems: !!svc?.findItems,
      convertUnits: !!svc?.convertUnits
    },
    optional: {
      InventoryMonitor: !!InventoryMonitor,
      WorkerTasks: !!WorkerTasks,
      calendarService: !!calendarService
    }
  });
});

/**
 * POST /api/inventory/apply-delta
 * Body: { data: Delta | Delta[] }
 * Adds Idempotency-Key support.
 */
router.post("/apply-delta", idempotencyGuard, express.json(), async (req, res) => {
  const body = req.body || {};
  if (!validateApplyDeltaBody(body)) {
    const msg = validateApplyDeltaBody.errors?.map(e => `${e.instancePath || "/"} ${e.message}`).join("; ");
    return badRequest(res, msg || "Invalid payload", validateApplyDeltaBody.errors);
  }

  const svc = await loadInventoryService();
  if (!svc) return notImplemented(res);

  try {
    const deltas = Array.isArray(body.data) ? body.data : [body.data];

    let result;
    if (typeof svc.applyDeltas === "function") {
      result = await svc.applyDeltas(deltas);
    } else if (typeof svc.applyDelta === "function") {
      const out = [];
      for (const d of deltas) out.push(await svc.applyDelta(d));
      result = out;
    } else {
      return notImplemented(res, "inventoryService.applyDelta/applyDeltas missing");
    }

    // Optional: inline low-inventory hints for affected SKUs (best-effort)
    let alerts = [];
    if (InventoryMonitor?.getLowInventoryAlerts) {
      try {
        const set = new Set(deltas.map(d => d.sku));
        const low = await InventoryMonitor.getLowInventoryAlerts();
        alerts = low.filter(a => set.has(a.sku) || set.has(a.name) || set.has(a.id));
      } catch {}
    }

    if (Array.isArray(body.data)) {
      return res.json({ ok: true, results: result, alerts });
    } else {
      return res.json({ ok: true, result: Array.isArray(result) ? result[0] : result, alerts });
    }
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/inventory/transfer
 */
router.post("/transfer", idempotencyGuard, express.json(), async (req, res) => {
  const body = req.body || {};
  if (!validateTransfer(body)) {
    const msg = validateTransfer.errors?.map(e => `${e.instancePath || "/"} ${e.message}`).join("; ");
    return badRequest(res, msg || "Invalid payload", validateTransfer.errors);
  }

  const svc = await loadInventoryService();
  if (!svc?.transfer) return notImplemented(res, "inventoryService.transfer missing");

  try {
    const result = await svc.transfer(body);
    return res.json({ ok: true, result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/inventory/batch
 */
router.post("/batch", idempotencyGuard, express.json(), async (req, res) => {
  const body = req.body || {};
  if (!validateBatch(body)) {
    const msg = validateBatch.errors?.map(e => `${e.instancePath || "/"} ${e.message}`).join("; ");
    return badRequest(res, msg || "Invalid payload", validateBatch.errors);
  }

  const svc = await loadInventoryService();
  if (!svc) return notImplemented(res);

  const results = [];
  for (const op of body.ops) {
    try {
      if (op.type === "delta") {
        if (svc.applyDeltas) {
          const r = await svc.applyDeltas([op.payload]);
          results.push({ ok: true, type: op.type, result: Array.isArray(r) ? r[0] : r });
        } else if (svc.applyDelta) {
          results.push({ ok: true, type: op.type, result: await svc.applyDelta(op.payload) });
        } else {
          throw new Error("inventoryService.applyDelta/applyDeltas missing");
        }
      } else if (op.type === "transfer") {
        if (!svc.transfer) throw new Error("inventoryService.transfer missing");
        results.push({ ok: true, type: op.type, result: await svc.transfer(op.payload) });
      } else {
        throw new Error(`Unknown op type: ${op.type}`);
      }
    } catch (err) {
      results.push({ ok: false, type: op.type, error: err.message });
      if (body.stopOnError !== false) {
        return res.status(207).json({ ok: false, results, note: "Stopped on first error (stopOnError=true)" });
      }
    }
  }

  return res.json({ ok: true, results });
});

/**
 * GET /api/inventory/items?userId=...&q=...&sku=...&limit=...
 */
router.get("/items", async (req, res) => {
  const query = {
    userId: req.query.userId ? String(req.query.userId) : undefined,
    q: req.query.q ? String(req.query.q) : undefined,
    sku: req.query.sku ? String(req.query.sku) : undefined,
    limit: req.query.limit ? Number(req.query.limit) : undefined,
  };

  if (!validateFindQuery(query)) {
    const msg = validateFindQuery.errors?.map(e => `${e.instancePath || "/"} ${e.message}`).join("; ");
    return badRequest(res, msg || "Invalid query", validateFindQuery.errors);
  }

  const svc = await loadInventoryService();
  if (!svc?.findItems) return notImplemented(res, "inventoryService.findItems missing");

  try {
    const data = await svc.findItems(query);
    return res.json({ ok: true, data });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/* -----------------------------------------------------------------------------
   Restock utilities (best-effort, graceful when optional services missing)
----------------------------------------------------------------------------- */

/**
 * POST /api/inventory/restock/check
 * Body: { skus: ["sku1","sku2",...], includeSuggestions?: true }
 * Uses InventoryMonitor if available; otherwise returns an empty list.
 */
router.post("/restock/check", express.json(), async (req, res) => {
  const body = req.body || {};
  if (!validateRestockCheck(body)) {
    const msg = validateRestockCheck.errors?.map(e => `${e.instancePath || "/"} ${e.message}`).join("; ");
    return badRequest(res, msg || "Invalid payload", validateRestockCheck.errors);
  }
  if (!InventoryMonitor?.getLowInventoryAlerts) {
    return res.json({ ok: true, alerts: [], note: "InventoryMonitor not available" });
  }
  try {
    const all = await InventoryMonitor.getLowInventoryAlerts();
    const set = new Set(body.skus);
    const alerts = all.filter(a => set.has(a.sku) || set.has(a.name) || set.has(a.id));
    return res.json({ ok: true, alerts });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/inventory/restock/tasks
 * Body: { items: [{ sku, name?, qtyNeeded?, unit?, location? }] }
 * Creates WorkerTasks assignments for restocking (if WorkerTasks present).
 */
router.post("/restock/tasks", express.json(), async (req, res) => {
  const body = req.body || {};
  if (!validateRestockTasks(body)) {
    const msg = validateRestockTasks.errors?.map(e => `${e.instancePath || "/"} ${e.message}`).join("; ");
    return badRequest(res, msg || "Invalid payload", validateRestockTasks.errors);
  }
  if (!WorkerTasks?.assignTaskToWorker) {
    return res.json({ ok: true, created: [], note: "WorkerTasks not available" });
  }

  const created = [];
  for (const it of body.items) {
    const task = {
      id: `restock-${it.sku}`,
      name: `Restock ${it.name || it.sku}`,
      task: `Restock ${it.name || it.sku}${it.qtyNeeded ? ` (need ~${it.qtyNeeded}${it.unit || ""})` : ""}${it.location ? ` to ${it.location}` : ""}.`,
      source: "inventory",
      requiredSkills: ["inventory","shopping","lifting"],
      priorityScore: 65,
      metadata: { sku: it.sku, location: it.location || "" }
    };
    try {
      const a = await WorkerTasks.assignTaskToWorker({ taskId: task.id, task, role: "stock keeper" });
      created.push(a);
    } catch {}
  }
  return res.json({ ok: true, created });
});

/**
 * POST /api/inventory/restock/calendarize
 * Body:
 *   {
 *     provider, calendarId, items: [{...}],
 *     when?, durationMinutes?, sabbathAware?, saturdayAsSabbath?, quietHours?, defaultHour?
 *   }
 */
router.post("/restock/calendarize", express.json(), async (req, res) => {
  if (!calendarService?.createEventsBatch && !calendarService?.createEvent) {
    return badRequest(res, "calendarService not available", 501);
  }
  const body = req.body || {};
  if (!validateCalendarize(body)) {
    const msg = validateCalendarize.errors?.map(e => `${e.instancePath || "/"} ${e.message}`).join("; ");
    return badRequest(res, msg || "Invalid payload", validateCalendarize.errors);
  }

  const provider = String(body.provider || "local");
  const calendarId = String(body.calendarId || "household");
  const sabbathAware = parseBool(body.sabbathAware, true);
  const saturdayAsSabbath = parseBool(body.saturdayAsSabbath, false);
  const quietHours = body.quietHours || { start: 21, end: 7 };
  const defaultHour = Number.isFinite(body.defaultHour) ? body.defaultHour : 10;

  const startBase = body.when ? new Date(body.when) : new Date();
  const start = sabbathAware ? nudgeToAllowed(startBase, { avoidSabbath: true, saturdayAsSabbath, quietHours, defaultHour }) : startBase;
  const end = new Date(start.getTime() + clamp(body.durationMinutes || 60, 15, 360) * 60_000);

  const list = (body.items || []).map(i => i.name || i.sku).join(", ");

  const ev = {
    title: "Household Restock Run",
    description: `Restock items: ${list}`,
    start: toISO(start),
    end: toISO(end),
    timezone: DEFAULT_TZ,
    allDay: false,
    location: "",
    reminders: [{ minutes: 10, method: "popup" }],
    metadata: { source: "inventory", tags: ["restock"] },
    externalId: `restock-${start.toISOString()}`
  };

  let result;
  if (calendarService.createEventsBatch) {
    result = await calendarService.createEventsBatch({ provider, calendarId, events: [ev], upsert: true });
  } else {
    result = [await calendarService.createEvent({ provider, calendarId, data: ev, upsert: true })];
  }
  return res.json({ ok: true, result });
});

/* -----------------------------------------------------------------------------
   Units conversion (best-effort): delegates to service if available
----------------------------------------------------------------------------- */

/**
 * POST /api/inventory/units/convert
 * Body: { from, to, value, density? }
 */
router.post("/units/convert", express.json(), async (req, res) => {
  const body = req.body || {};
  if (!validateUnitsConvert(body)) {
    const msg = validateUnitsConvert.errors?.map(e => `${e.instancePath || "/"} ${e.message}`).join("; ");
    return badRequest(res, msg || "Invalid payload", validateUnitsConvert.errors);
  }

  const svc = await loadInventoryService();

  // If the service provides convertUnits, use it
  if (svc?.convertUnits) {
    try {
      const out = await svc.convertUnits(body);
      return res.json({ ok: true, result: out });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  // Fallback: naive mass/volume/single conversions (limited)
  const { from, to, value, density } = body;
  const f = from.toLowerCase(), t = to.toLowerCase();
  let result = null;

  const mass = { g: 1, kg: 1000, oz: 28.3495, lb: 453.592 };
  const vol  = { ml: 1, l: 1000, floz: 29.5735, cup: 236.588, qt: 946.353, gal: 3785.41 };
  const countOk = (u) => ["ct","each","ea"].includes(u);

  if (mass[f] && mass[t]) result = value * (mass[f] / mass[t]);
  else if (vol[f] && vol[t]) result = value * (vol[f] / vol[t]);
  else if ((vol[f] && mass[t]) || (mass[f] && vol[t])) {
    // require density (g/ml)
    if (!density || density <= 0) return badRequest(res, "Density (g/ml) required for mass<->volume conversion");
    if (vol[f] && mass[t]) result = value * vol[f] * density / mass[t];
    else if (mass[f] && vol[t]) result = value * mass[f] / (density * vol[t]);
  } else if (countOk(f) && countOk(t)) result = value; // 1:1
  else return badRequest(res, `Unsupported conversion from '${from}' to '${to}'`);

  return res.json({ ok: true, result });
});

export default router;

/* -----------------------------------------------------------------------------
  Example inventoryService.js (contract hints)

  // export async function applyDelta({ userId, sku, qty, unit, reason, location, meta }) {
  //   return { sku, applied: qty, unit, location, balance: 12.3, threshold: 2, name: "Onion (yellow)" };
  // }

  // export async function applyDeltas(deltasArray) { return Promise.all(deltasArray.map(d => applyDelta(d))); }

  // export async function transfer({ userId, sku, qty, unit, from, to, meta }) {
  //   return { sku, moved: qty, unit, from, to };
  // }

  // export async function findItems({ userId, q, sku, limit = 20 }) {
  //   return [{ sku: "onion-yellow", name: "Onion (yellow)", qty: 3, unit: "ct", locations: ["pantry"], threshold: 2 }];
  // }

  // export async function convertUnits({ from, to, value, density }) { ... }
----------------------------------------------------------------------------- */
