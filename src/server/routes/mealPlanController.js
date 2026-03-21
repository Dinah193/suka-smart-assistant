// C:\Users\larho\suka-smart-assistant\src\server\routes\mealPlanController.js
//
// Suka Smart Assistant — Meal Plan Controller (enhanced)
//
// Endpoints:
//   GET    /api/mealplan/health
//   GET    /api/mealplan/state?userId=...
//   POST   /api/mealplan/generateOrRefill
//   POST   /api/mealplan/clearWeek
//   POST   /api/mealplan/lockSlot
//   POST   /api/mealplan/setSlot
//   POST   /api/mealplan/markCooked
//   --- New helpers ---
//   POST   /api/mealplan/suggest                 -> sabbath/quiet-aware time slots for meals/prep
//   POST   /api/mealplan/shoppingList            -> compute list from plan vs inventory
//   POST   /api/mealplan/calendarize             -> add meals/prep to calendar
//   POST   /api/mealplan/prepTasks               -> create WorkerTasks for prep/cleanup
//
// Deps (optional, graceful if missing):
//   src/server/services/mealPlanService.js
//   src/server/services/calendarService.js
//   src/server/services/inventoryService.js
//   src/managers/WorkerTasks.js
//
// Install: npm i ajv ajv-formats
//

import express from "express";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { authenticateRequest } = require("../middleware/realtime/authenticateRequest.js");
const {
  requireHouseholdAccessPolicy,
  requireCollaborationPolicy,
  requireEntitlementPolicy,
} = require("../middleware/accessPolicy.js");

const router = express.Router();
router.use(authenticateRequest);
router.use(requireHouseholdAccessPolicy());
router.use(requireCollaborationPolicy({ moduleKey: "meal-planning" }));
router.use(requireEntitlementPolicy({ feature: "planner.base" }));

const ajv = new Ajv({ allErrors: true, removeAdditional: "failing", strict: false });
addFormats(ajv);

const DEFAULT_TZ = process.env.GENERIC_TIMEZONE || "America/Chicago";

/* -----------------------------------------------------------------------------
   Dynamic loaders (graceful if missing)
----------------------------------------------------------------------------- */
async function loadMealPlanService() {
  try {
    const mod = await import("../services/mealPlanService.js");
    return mod?.default || mod;
  } catch { return null; }
}
let calendarService = null;
let inventoryService = null;
let WorkerTasks = null;

try {
  const mod = await import("../services/calendarService.js");
  calendarService = mod?.default || mod;
} catch {}
try {
  const mod2 = await import("../services/inventoryService.js");
  inventoryService = mod2?.default || mod2;
} catch {}
try { WorkerTasks = (await import("../../managers/WorkerTasks.js")).default; } catch {}

/* -----------------------------------------------------------------------------
   Helpers
----------------------------------------------------------------------------- */
function badRequest(res, message, details) {
  return res.status(400).json({ ok: false, error: message, details });
}
function notImplemented(res, hint) {
  return res.status(501).json({
    ok: false,
    error: "mealPlanService not available",
    hint: hint || "Create src/server/services/mealPlanService.js exporting getPlan/generateOrRefill/clearWeek/lockSlot/setSlot/markCooked",
  });
}
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
  return saturdayAsSabbath ? date.getDay() === 6 : date.getDay() === 6; // Saturday
}
function nudgeToAllowed(date, { avoidSabbath = true, saturdayAsSabbath = false, quietHours = { start: 21, end: 7 }, defaultHour = 17 } = {}) {
  let d = new Date(date);
  let guard = 0;
  while ((isSabbath(d, { avoidSabbath, saturdayAsSabbath }) || inQuietHours(d, quietHours)) && guard < 14) {
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, defaultHour, 0, 0, 0);
    guard++;
  }
  return d;
}

// Idempotency (10 min window)
const idem = new Map();
const now = () => Date.now();
function pruneIdem() { const t = now(); for (const [k,v] of idem.entries()) if (v <= t) idem.delete(k); }
function idempotencyGuard(req, res, next) {
  pruneIdem();
  const key = req.header("Idempotency-Key") || req.header("idempotency-key");
  if (!key) return next();
  const exists = idem.get(key);
  if (exists && exists > now()) {
    return res.status(208).json({ ok: true, duplicate: true, note: "Duplicate request ignored (Idempotency-Key)." });
  }
  idem.set(key, now() + 10 * 60 * 1000);
  return next();
}

/* -----------------------------------------------------------------------------
   Validation Schemas
----------------------------------------------------------------------------- */
const userOnlySchema = {
  type: "object", required: ["userId"],
  properties: { userId: { type: "string", minLength: 1 } },
  additionalProperties: false,
};
const generateSchema = {
  type: "object", required: ["userId"],
  properties: { userId: { type: "string", minLength: 1 }, force: { type: "boolean" } },
  additionalProperties: false,
};
const lockSlotSchema = {
  type: "object", required: ["userId","dateKey","meal","locked"],
  properties: {
    userId: { type: "string", minLength: 1 },
    dateKey: { type: "string", minLength: 8 }, // YYYY-MM-DD
    meal: { type: "string", minLength: 1 },
    locked: { type: "boolean" },
  },
  additionalProperties: false,
};
const setSlotSchema = {
  type: "object", required: ["userId","dateKey","meal"],
  properties: {
    userId: { type: "string", minLength: 1 },
    dateKey: { type: "string", minLength: 8 },
    meal: { type: "string", minLength: 1 },
    recipe: {
      anyOf: [
        { type: "null" },
        { type: "object", required: ["id","name"], properties: { id: { type: "string" }, name: { type: "string" }, proteinType: { type: "string" } }, additionalProperties: false }
      ]
    }
  },
  additionalProperties: false,
};
const markCookedSchema = {
  type: "object", required: ["userId","dateKey","meal"],
  properties: { userId: { type: "string", minLength: 1 }, dateKey: { type: "string", minLength: 8 }, meal: { type: "string", minLength: 1 } },
  additionalProperties: false,
};

// New helpers
const suggestSchema = {
  type: "object",
  properties: {
    after: { type: "string" },
    windowDays: { type: "integer", minimum: 1, maximum: 60, default: 7 },
    slots: { type: "integer", minimum: 1, maximum: 20, default: 3 },
    sabbathAware: { type: "boolean", default: true },
    saturdayAsSabbath: { type: "boolean", default: false },
    quietHours: {
      type: "object",
      properties: { start: { type: "integer", minimum: 0, maximum: 23 }, end: { type: "integer", minimum: 0, maximum: 23 } },
      additionalProperties: false
    },
    defaultHour: { type: "integer", minimum: 0, maximum: 23, default: 17 }, // 5pm dinner default
    durationMinutes: { type: "integer", minimum: 10, maximum: 240, default: 60 }
  },
  additionalProperties: false
};

const shoppingListSchema = {
  type: "object",
  required: ["userId"],
  properties: {
    userId: { type: "string", minLength: 1 },
    // optionally constrain to a date range within the week
    dateStart: { type: "string" }, // YYYY-MM-DD
    dateEnd: { type: "string" },
    includePantry: { type: "boolean", default: true },
    // optional overrides for servings
    servings: { type: "integer", minimum: 1, maximum: 24, default: 4 }
  },
  additionalProperties: false
};

const calendarizeSchema = {
  type: "object",
  required: ["userId","events"],
  properties: {
    userId: { type: "string", minLength: 1 },
    provider: { type: "string", enum: ["google","outlook","local"], default: "local" },
    calendarId: { type: "string", default: "household" },
    sabbathAware: { type: "boolean", default: true },
    saturdayAsSabbath: { type: "boolean", default: false },
    quietHours: {
      type: "object",
      properties: { start: { type: "integer", minimum: 0, maximum: 23 }, end: { type: "integer", minimum: 0, maximum: 23 } },
      additionalProperties: false
    },
    defaultHour: { type: "integer", minimum: 0, maximum: 23, default: 17 },
    events: {
      type: "array", minItems: 1,
      items: {
        type: "object",
        required: ["title","start"],
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          start: { type: "string" }, // ISO
          end: { type: "string" },   // ISO
          location: { type: "string" },
          metadata: { type: "object", additionalProperties: true },
          externalId: { type: "string" }
        },
        additionalProperties: true
      }
    }
  },
  additionalProperties: false
};

const prepTasksSchema = {
  type: "object",
  required: ["items"],
  properties: {
    // items: [{ dateKey, meal, label, notes?, skills?, priority? }]
    items: {
      type: "array", minItems: 1,
      items: {
        type: "object",
        required: ["dateKey","meal","label"],
        properties: {
          dateKey: { type: "string", minLength: 8 },
          meal: { type: "string", minLength: 1 },
          label: { type: "string", minLength: 1 },
          notes: { type: "string" },
          skills: { type: "array", items: { type: "string" } },
          priority: { type: "integer", minimum: 1, maximum: 5 }
        },
        additionalProperties: true
      }
    }
  },
  additionalProperties: false
};

const resolveRecipeSchema = {
  type: "object",
  required: ["recipe"],
  properties: {
    userId: { type: "string" },
    recipe: { type: "object" },
    rhythm: { type: "object" },
    override: { type: "object" },
    context: { type: "object" },
    resolveServerSide: { type: "boolean", default: true },
  },
  additionalProperties: true,
};

// compilers
const validateUserOnly  = ajv.compile(userOnlySchema);
const validateGenerate  = ajv.compile(generateSchema);
const validateLockSlot  = ajv.compile(lockSlotSchema);
const validateSetSlot   = ajv.compile(setSlotSchema);
const validateMarkCooked= ajv.compile(markCookedSchema);
const validateSuggest   = ajv.compile(suggestSchema);
const validateShopping  = ajv.compile(shoppingListSchema);
const validateCalendar  = ajv.compile(calendarizeSchema);
const validatePrepTasks = ajv.compile(prepTasksSchema);
const validateResolveRecipe = ajv.compile(resolveRecipeSchema);

/* -----------------------------------------------------------------------------
   Routes
----------------------------------------------------------------------------- */

/** Health */
router.get("/health", async (_req, res) => {
  const svc = await loadMealPlanService();
  res.json({
    ok: true,
    tz: DEFAULT_TZ,
    services: {
      mealPlanService: !!svc,
      getPlan: !!svc?.getPlan,
      generateOrRefill: !!svc?.generateOrRefill,
      clearWeek: !!svc?.clearWeek,
      lockSlot: !!svc?.lockSlot,
      setSlot: !!svc?.setSlot,
      markCooked: !!svc?.markCooked
    },
    optional: {
      calendarService: !!calendarService,
      inventoryService: !!inventoryService,
      WorkerTasks: !!WorkerTasks
    }
  });
});

/** State */
router.get("/state", async (req, res) => {
  const userId = req.query.userId ? String(req.query.userId) : "";
  if (!validateUserOnly({ userId })) {
    const msg = validateUserOnly.errors?.map(e => `${e.instancePath || "/"} ${e.message}`).join("; ");
    return badRequest(res, msg || "Missing/invalid userId", validateUserOnly.errors);
  }
  const svc = await loadMealPlanService();
  if (!svc?.getPlan) return notImplemented(res, "mealPlanService.getPlan() missing");
  try { return res.json({ ok: true, ...(await svc.getPlan({ userId })) }); }
  catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
});

/** Generate/refill */
router.post("/generateOrRefill", idempotencyGuard, express.json(), async (req, res) => {
  const body = req.body || {};
  if (!validateGenerate(body)) {
    const msg = validateGenerate.errors?.map(e => `${e.instancePath || "/"} ${e.message}`).join("; ");
    return badRequest(res, msg || "Invalid payload", validateGenerate.errors);
  }
  const svc = await loadMealPlanService();
  if (!svc?.generateOrRefill) return notImplemented(res, "mealPlanService.generateOrRefill() missing");
  try { return res.json({ ok: true, ...(await svc.generateOrRefill({ userId: body.userId, force: !!body.force })) }); }
  catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
});

/** Clear week */
router.post("/clearWeek", idempotencyGuard, express.json(), async (req, res) => {
  const body = req.body || {};
  if (!validateUserOnly(body)) {
    const msg = validateUserOnly.errors?.map(e => `${e.instancePath || "/"} ${e.message}`).join("; ");
    return badRequest(res, msg || "Invalid payload", validateUserOnly.errors);
  }
  const svc = await loadMealPlanService();
  if (!svc?.clearWeek) return notImplemented(res, "mealPlanService.clearWeek() missing");
  try { return res.json({ ok: true, ...(await svc.clearWeek({ userId: body.userId })) }); }
  catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
});

/** Lock slot */
router.post("/lockSlot", express.json(), async (req, res) => {
  const body = req.body || {};
  if (!validateLockSlot(body)) {
    const msg = validateLockSlot.errors?.map(e => `${e.instancePath || "/"} ${e.message}`).join("; ");
    return badRequest(res, msg || "Invalid payload", validateLockSlot.errors);
  }
  const svc = await loadMealPlanService();
  if (!svc?.lockSlot) return notImplemented(res, "mealPlanService.lockSlot() missing");
  try { return res.json({ ok: true, result: (await svc.lockSlot(body)) ?? true }); }
  catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
});

/** Set slot (recipe or null) */
router.post("/setSlot", idempotencyGuard, express.json(), async (req, res) => {
  const body = req.body || {};
  if (!validateSetSlot(body)) {
    const msg = validateSetSlot.errors?.map(e => `${e.instancePath || "/"} ${e.message}`).join("; ");
    return badRequest(res, msg || "Invalid payload", validateSetSlot.errors);
  }
  const svc = await loadMealPlanService();
  if (!svc?.setSlot) return notImplemented(res, "mealPlanService.setSlot() missing");
  try { return res.json({ ok: true, result: (await svc.setSlot(body)) ?? true }); }
  catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
});

/** Mark cooked */
router.post("/markCooked", idempotencyGuard, express.json(), async (req, res) => {
  const body = req.body || {};
  if (!validateMarkCooked(body)) {
    const msg = validateMarkCooked.errors?.map(e => `${e.instancePath || "/"} ${e.message}`).join("; ");
    return badRequest(res, msg || "Invalid payload", validateMarkCooked.errors);
  }
  const svc = await loadMealPlanService();
  if (!svc?.markCooked) return notImplemented(res, "mealPlanService.markCooked() missing");
  try { return res.json({ ok: true, result: (await svc.markCooked(body)) ?? true }); }
  catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
});

/* -----------------------------------------------------------------------------
   New helpers
----------------------------------------------------------------------------- */

/** Suggest meal/prep windows (Sabbath/quiet-hour aware) */
router.post("/suggest", express.json(), (req, res) => {
  const body = req.body || {};
  if (!validateSuggest(body)) {
    const msg = validateSuggest.errors?.map(e => `${e.instancePath || "/"} ${e.message}`).join("; ");
    return badRequest(res, msg || "Invalid payload", validateSuggest.errors);
  }
  const {
    after = new Date().toISOString(),
    windowDays = 7, slots = 3,
    sabbathAware = true, saturdayAsSabbath = false, quietHours,
    defaultHour = 17, durationMinutes = 60
  } = body;

  const suggestions = [];
  let cursor = new Date(after);
  const end = new Date(new Date(after).getTime() + windowDays * DAY);

  while (cursor <= end && suggestions.length < slots) {
    const base = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), defaultHour, 0, 0, 0);
    const pick = sabbathAware ? nudgeToAllowed(base, { avoidSabbath: true, saturdayAsSabbath, quietHours, defaultHour }) : base;
    if (pick >= new Date(after)) {
      suggestions.push({ start: toISO(pick), end: toISO(new Date(pick.getTime() + clamp(durationMinutes, 10, 240) * 60_000)) });
    }
    cursor = new Date(cursor.getTime() + DAY);
  }
  return res.json({ ok: true, suggestions, meta: { slots: suggestions.length } });
});

/** Compute shopping list from plan vs inventory (best-effort) */
router.post("/shoppingList", express.json(), async (req, res) => {
  const body = req.body || {};
  if (!validateShopping(body)) {
    const msg = validateShopping.errors?.map(e => `${e.instancePath || "/"} ${e.message}`).join("; ");
    return badRequest(res, msg || "Invalid payload", validateShopping.errors);
  }
  const svc = await loadMealPlanService();
  if (!svc?.getPlan) return notImplemented(res, "mealPlanService.getPlan() missing");

  try {
    const plan = await svc.getPlan({ userId: body.userId });
    // Expect plan.slots[YYYY-MM-DD][meal] -> { recipe:{ id, name }, ... }
    const dateStart = body.dateStart || plan.weekStart;
    const dateEnd = body.dateEnd || toISO(new Date(new Date(plan.weekStart).getTime() + 6*DAY)).slice(0,10);

    // Delegate to service if it has buildShoppingList
    if (typeof svc.buildShoppingList === "function") {
      const data = await svc.buildShoppingList({ userId: body.userId, dateStart, dateEnd, servings: body.servings, includePantry: body.includePantry !== false });
      return res.json({ ok: true, ...data });
    }

    // Fallback heuristic (no inventoryService detail): return recipe stubs
    const wanted = [];
    for (const [dateKey, meals] of Object.entries(plan.slots || {})) {
      if (dateKey < dateStart || dateKey > dateEnd) continue;
      for (const [meal, slot] of Object.entries(meals || {})) {
        if (slot?.recipe) wanted.push({ dateKey, meal, recipe: slot.recipe });
      }
    }

    // If inventoryService offers findItems, we could attempt matches for staple names here.
    // Keeping minimal fallback:
    return res.json({ ok: true, items: [], wanted, note: inventoryService ? "Inventory-aware computation available in inventoryService." : "Inventory service not wired; returning wanted recipes only." });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/** Calendarize meal & prep events */
router.post("/calendarize", express.json(), async (req, res) => {
  if (!calendarService?.createEventsBatch && !calendarService?.createEvent) {
    return badRequest(res, "calendarService not available", 501);
  }
  const body = req.body || {};
  if (!validateCalendar(body)) {
    const msg = validateCalendar.errors?.map(e => `${e.instancePath || "/"} ${e.message}`).join("; ");
    return badRequest(res, msg || "Invalid payload", validateCalendar.errors);
  }

  const provider = String(body.provider || "local");
  const calendarId = String(body.calendarId || "household");
  const sabbathAware = parseBool(body.sabbathAware, true);
  const saturdayAsSabbath = parseBool(body.saturdayAsSabbath, false);
  const quietHours = body.quietHours || { start: 21, end: 7 };
  const defaultHour = Number.isFinite(body.defaultHour) ? body.defaultHour : 17;

  const events = (body.events || []).map((e, i) => {
    const start = sabbathAware ? nudgeToAllowed(new Date(e.start), { avoidSabbath: true, saturdayAsSabbath, quietHours, defaultHour }) : new Date(e.start);
    const end = e.end ? new Date(e.end) : new Date(start.getTime() + 60*60_000);
    return {
      title: e.title || `Meal #${i+1}`,
      description: e.description || "",
      start: toISO(start),
      end: toISO(end),
      timezone: DEFAULT_TZ,
      allDay: false,
      location: e.location || "",
      reminders: [{ minutes: 15, method: "popup" }],
      metadata: { source: "mealplan", ...(e.metadata || {}) },
      externalId: e.externalId || `meal-${start.toISOString()}-${i}`
    };
  });

  try {
    let result;
    if (calendarService.createEventsBatch) {
      result = await calendarService.createEventsBatch({ provider, calendarId, events, upsert: true });
    } else {
      result = [];
      for (const ev of events) result.push(await calendarService.createEvent({ provider, calendarId, data: ev, upsert: true }));
    }
    return res.json({ ok: true, result });
  } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
});

/** Create prep/cleanup WorkerTasks */
router.post("/prepTasks", express.json(), async (req, res) => {
  const body = req.body || {};
  if (!validatePrepTasks(body)) {
    const msg = validatePrepTasks.errors?.map(e => `${e.instancePath || "/"} ${e.message}`).join("; ");
    return badRequest(res, msg || "Invalid payload", validatePrepTasks.errors);
  }
  if (!WorkerTasks?.assignTaskToWorker) {
    return res.json({ ok: true, created: [], note: "WorkerTasks not available" });
  }

  const created = [];
  for (const it of body.items) {
    const due = new Date(`${it.dateKey}T12:00:00`); // midday default; UI can adjust
    const task = {
      id: `mealprep-${it.dateKey}-${it.meal}-${Date.now()}`,
      name: it.label,
      task: it.notes ? `${it.label} — ${it.notes}` : it.label,
      source: "mealplan",
      requiredSkills: Array.isArray(it.skills) && it.skills.length ? it.skills : ["cooking","prep","cleanup"],
      priorityScore: Number.isFinite(it.priority) ? it.priority * 20 : 60,
      metadata: { dateKey: it.dateKey, meal: it.meal },
      dueHint: due
    };
    try {
      created.push(await WorkerTasks.assignTaskToWorker({ taskId: task.id, task, role: "cook" }));
    } catch {}
  }
  return res.json({ ok: true, created });
});

/** Optional server-side resolver for contract consistency */
router.post("/resolveRecipe", express.json(), async (req, res) => {
  const body = req.body || {};
  if (!validateResolveRecipe(body)) {
    const msg = validateResolveRecipe.errors
      ?.map((e) => `${e.instancePath || "/"} ${e.message}`)
      .join("; ");
    return badRequest(res, msg || "Invalid payload", validateResolveRecipe.errors);
  }

  const resolveServerSide = body.resolveServerSide !== false;
  if (!resolveServerSide) {
    return res.json({ ok: true, passthrough: true, recipe: body.recipe });
  }

  try {
    const resolverMod = await import("../../services/recipes/battleRhythmResolver.js");
    const applyBattleRhythm =
      resolverMod?.applyBattleRhythm || resolverMod?.default?.applyBattleRhythm;
    if (typeof applyBattleRhythm !== "function") {
      return res.status(501).json({ ok: false, error: "battle rhythm resolver unavailable" });
    }

    const resolved = await applyBattleRhythm(
      body.recipe,
      body.rhythm || {},
      body.override || {},
      body.context || {}
    );
    return res.json({ ok: true, resolved });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

export default router;

/* -----------------------------------------------------------------------------
  Example mealPlanService.js contract (unchanged)
  - getPlan({ userId })
  - generateOrRefill({ userId, force? })
  - clearWeek({ userId })
  - lockSlot({ userId, dateKey, meal, locked })
  - setSlot({ userId, dateKey, meal, recipe })
  - markCooked({ userId, dateKey, meal })
----------------------------------------------------------------------------- */
