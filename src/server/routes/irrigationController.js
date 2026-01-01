// C:\Users\larho\suka-smart-assistant\src\server\routes\irrigationController.js
//
// Suka Smart Assistant — Irrigation Controller (enhanced)
//
// Purpose:
//   Provider-agnostic API used by n8n (Soil & Water Keeper), garden agents, or UI.
//   - Define/adjust programs, run zones, skip/delay, ingest telemetry
//   - Maintenance tasks to WorkerTasks, calendarization to calendarService
//   - Sabbath/quiet-hour aware helpers
//
// Endpoints (existing + new):
//   GET    /api/irrigation/health
//   GET    /api/irrigation/zones
//   POST   /api/irrigation/zones                 -> upsert 1..N zones
//   POST   /api/irrigation/schedule              -> create/update a program (per user)
//   GET    /api/irrigation/programs              -> list programs (best-effort)
//   POST   /api/irrigation/run-now               -> run one/many zones for duration   (idempotent)
//   POST   /api/irrigation/skip                  -> skip zone(s) until date or for N hours (idempotent)
//   POST   /api/irrigation/ingest                -> telemetry webhook (moisture/rain/temp) (rate-limited + idempotent)
//
//   NEW:
//   POST   /api/irrigation/schedule/suggest      -> suggest next allowed watering windows (Sabbath/quiet-aware)
//   POST   /api/irrigation/calendarize           -> create events for watering/maintenance runs
//   POST   /api/irrigation/maintenance/tasks     -> create WorkerTasks (leaks, filter-flush, winterize, etc.)
//   GET    /api/irrigation/zones/check           -> sanity check zone metadata (sensors, flow, names)
//   POST   /api/irrigation/programs/preview      -> expand rules into next N occurrences (best-effort)
//
// Notes:
//   - Delegates to src/server/services/irrigationService.js if present (any subset OK):
//       listZones, upsertZones, createOrUpdateSchedule, listPrograms, runNow, skip, ingestTelemetry
//   - Uses Ajv for payload validation; adds idempotency & small rate limiter.
//   - Timezone defaults to America/Chicago unless supplied.
//
// Install:  npm i ajv ajv-formats
//

import express from "express";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const router = express.Router();

const ajv = new Ajv({ allErrors: true, removeAdditional: "failing", strict: false });
addFormats(ajv);

const DEFAULT_TZ = process.env.GENERIC_TIMEZONE || "America/Chicago";

/* ------------------------------ Optional deps ------------------------------ */
let WorkerTasks = null;
let calendarService = null;

try { WorkerTasks = (await import("../../managers/WorkerTasks.js")).default; } catch {}
try {
  const mod = await import("../services/calendarService.js");
  calendarService = mod?.default || mod;
} catch {}

/* ------------------------------ Helpers & loaders ------------------------------ */

function badRequest(res, message, details) {
  return res.status(400).json({ ok: false, error: message, details });
}
function notImplemented(res, hint) {
  return res.status(501).json({
    ok: false,
    error: "irrigationService not available",
    hint: hint || "Create src/server/services/irrigationService.js exporting listZones/upsertZones/createOrUpdateSchedule/listPrograms/runNow/skip/ingestTelemetry",
  });
}
async function loadIrrigationService() {
  try {
    const mod = await import("../services/irrigationService.js");
    return mod?.default || mod;
  } catch {
    return null;
  }
}

const DAY = 86400000;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const toISO = (d) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

function parseBool(v, d = false) {
  if (typeof v === "boolean") return v;
  if (v == null) return d;
  const s = String(v).toLowerCase();
  return ["1", "true", "yes", "y"].includes(s) ? true : ["0", "false", "no", "n"].includes(s) ? false : d;
}
function inQuietHours(date, { start = 21, end = 7 } = {}) {
  const h = date.getHours();
  return start < end ? (h >= start && h < end) : (h >= start || h < end);
}
function isSabbath(date, { avoidSabbath = true, saturdayAsSabbath = false } = {}) {
  if (!avoidSabbath) return false;
  return saturdayAsSabbath ? date.getDay() === 6 : date.getDay() === 6; // Saturday
}
function nudgeToAllowed(date, { avoidSabbath = true, saturdayAsSabbath = false, quietHours = { start: 21, end: 7 }, defaultHour = 6 } = {}) {
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
function pruneIdem() {
  const t = now();
  for (const [k, v] of idem.entries()) if (v <= t) idem.delete(k);
}
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

// Tiny rate limiter for telemetry (per IP, 300 events/5m default)
const RATE_LIMIT = Number(process.env.IRR_TELEM_LIMIT || 300);
const RATE_WINDOW = 5 * 60 * 1000;
const buckets = new Map(); // ip -> { tokens, refillAt }
function limitTelemetry(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  const b = buckets.get(ip) || { tokens: RATE_LIMIT, refillAt: now() + RATE_WINDOW };
  const t = now();
  if (t >= b.refillAt) { b.tokens = RATE_LIMIT; b.refillAt = t + RATE_WINDOW; }
  if (b.tokens <= 0) return res.status(429).json({ ok: false, error: "Telemetry rate limit exceeded. Try later." });
  b.tokens -= 1; buckets.set(ip, b); next();
}

/* ------------------------------ Validation Schemas ------------------------------ */

const zoneSchema = {
  type: "object",
  required: ["zoneId", "name"],
  properties: {
    zoneId: { type: "string", minLength: 1 },
    name: { type: "string", minLength: 1 },
    location: { type: "string" },
    flowRateLpm: { type: "number", minimum: 0 },
    plantType: { type: "string" },
    emitterType: { type: "string" },
    moistureSensorId: { type: "string" },
    notes: { type: "string" }
  },
  additionalProperties: false,
};
const upsertZonesSchema = {
  type: "object",
  required: ["zones"],
  properties: { zones: { anyOf: [zoneSchema, { type: "array", items: zoneSchema, minItems: 1 }] } },
  additionalProperties: false,
};
const scheduleProgramSchema = {
  type: "object",
  required: ["userId", "program"],
  properties: {
    userId: { type: "string", minLength: 1 },
    program: {
      type: "object",
      required: ["name", "timezone", "rules"],
      properties: {
        name: { type: "string", minLength: 1 },
        timezone: { type: "string", default: DEFAULT_TZ },
        rules: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["time", "days", "zones"],
            properties: {
              time: { type: "string", minLength: 3 }, // "06:00"
              days: { type: "array", items: { type: "string", enum: ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"] }, minItems: 1 },
              zones: {
                type: "array", minItems: 1,
                items: {
                  type: "object",
                  required: ["zoneId", "durationSec"],
                  properties: {
                    zoneId: { type: "string", minLength: 1 },
                    durationSec: { type: "integer", minimum: 1 },
                    minMoisturePercent: { type: "number", minimum: 0, maximum: 100 },
                    skipIfRainMm: { type: "number", minimum: 0 }
                  },
                  additionalProperties: false
                }
              },
              startDate: { type: "string" }, endDate: { type: "string" }
            },
            additionalProperties: false
          }
        },
        enabled: { type: "boolean", default: true }
      },
      additionalProperties: false
    },
    upsert: { type: "boolean", default: true }
  },
  additionalProperties: false
};
const runNowSchema = {
  type: "object",
  required: ["userId", "zones"],
  properties: {
    userId: { type: "string", minLength: 1 },
    zones: {
      type: "array", minItems: 1,
      items: {
        type: "object",
        required: ["zoneId", "durationSec"],
        properties: { zoneId: { type: "string", minLength: 1 }, durationSec: { type: "integer", minimum: 1 } },
        additionalProperties: false
      }
    },
    reason: { type: "string" }
  },
  additionalProperties: false
};
const skipSchema = {
  type: "object",
  required: ["userId", "zones"],
  properties: {
    userId: { type: "string", minLength: 1 },
    zones: { anyOf: [{ type: "array", items: { type: "string" }, minItems: 1 }, { type: "string", minLength: 1 }] },
    until: { type: "string" }, hours: { type: "integer", minimum: 1 }, reason: { type: "string" }
  },
  additionalProperties: false
};
const ingestSchema = {
  type: "object",
  required: ["userId"],
  properties: {
    userId: { type: "string", minLength: 1 },
    source: { type: "string" },
    moisture: { type: "object", properties: { percent: { type: "number", minimum: 0, maximum: 100 }, sensorId: { type: "string" }, zoneId: { type: "string" } }, additionalProperties: true },
    rain: { type: "object", properties: { mmLast24h: { type: "number", minimum: 0 }, forecastMmNext24h: { type: "number", minimum: 0 } }, additionalProperties: true },
    temperatureC: { type: "number" },
    meta: { type: "object", additionalProperties: true }
  },
  additionalProperties: false
};
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
    defaultHour: { type: "integer", minimum: 0, maximum: 23, default: 6 },
    durationMinutes: { type: "integer", minimum: 5, maximum: 4*60, default: 30 }
  },
  additionalProperties: false
};
const calendarizeSchema = {
  type: "object",
  required: ["events"],
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
    defaultHour: { type: "integer", minimum: 0, maximum: 23, default: 6 },
    events: {
      type: "array", minItems: 1,
      items: {
        type: "object",
        required: ["title","start"],
        properties: { title: { type: "string" }, description: { type: "string" }, start: { type: "string" }, end: { type: "string" }, location: { type: "string" }, metadata: { type: "object", additionalProperties: true }, externalId: { type: "string" } },
        additionalProperties: true
      }
    }
  },
  additionalProperties: false
};
const maintTasksSchema = {
  type: "object",
  required: ["items"],
  properties: {
    items: {
      type: "array", minItems: 1,
      items: { type: "object", required: ["zoneId","label"], properties: { zoneId: { type: "string" }, label: { type: "string" }, notes: { type: "string" }, priority: { type: "integer", minimum: 1, maximum: 5 }, skills: { type: "array", items: { type: "string" } } }, additionalProperties: true }
    }
  },
  additionalProperties: false
};

const validateZones     = ajv.compile(upsertZonesSchema);
const validateProgram   = ajv.compile(scheduleProgramSchema);
const validateRunNow    = ajv.compile(runNowSchema);
const validateSkip      = ajv.compile(skipSchema);
const validateIngest    = ajv.compile(ingestSchema);
const validateSuggest   = ajv.compile(suggestSchema);
const validateCalendar  = ajv.compile(calendarizeSchema);
const validateMaint     = ajv.compile(maintTasksSchema);

/* ------------------------------ Routes ------------------------------ */

/** Health */
router.get("/health", async (_req, res) => {
  const svc = await loadIrrigationService();
  res.json({
    ok: true, tz: DEFAULT_TZ,
    services: {
      irrigationService: !!svc,
      listZones: !!svc?.listZones, upsertZones: !!svc?.upsertZones,
      createOrUpdateSchedule: !!svc?.createOrUpdateSchedule, listPrograms: !!svc?.listPrograms,
      runNow: !!svc?.runNow, skip: !!svc?.skip, ingestTelemetry: !!svc?.ingestTelemetry
    },
    optional: { WorkerTasks: !!WorkerTasks, calendarService: !!calendarService }
  });
});

/** List zones */
router.get("/zones", async (_req, res) => {
  const svc = await loadIrrigationService();
  if (!svc?.listZones) return notImplemented(res, "irrigationService.listZones() missing");
  try { return res.json({ ok: true, data: await svc.listZones() }); }
  catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
});

/** Upsert 1..N zones */
router.post("/zones", express.json(), async (req, res) => {
  const body = req.body || {};
  if (!validateZones(body)) {
    const msg = validateZones.errors?.map(e => `${e.instancePath || "/"} ${e.message}`).join("; ");
    return badRequest(res, msg || "Invalid payload", validateZones.errors);
  }
  const svc = await loadIrrigationService();
  if (!svc?.upsertZones) return notImplemented(res, "irrigationService.upsertZones() missing");
  try {
    const zones = Array.isArray(body.zones) ? body.zones : [body.zones];
    const result = await svc.upsertZones(zones);
    return res.json({ ok: true, result });
  } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
});

/** Create or update a schedule program */
router.post("/schedule", express.json(), async (req, res) => {
  const body = req.body || {};
  if (!validateProgram(body)) {
    const msg = validateProgram.errors?.map(e => `${e.instancePath || "/"} ${e.message}`).join("; ");
    return badRequest(res, msg || "Invalid payload", validateProgram.errors);
  }
  const svc = await loadIrrigationService();
  if (!svc?.createOrUpdateSchedule) return notImplemented(res, "irrigationService.createOrUpdateSchedule() missing");
  try {
    if (!body.program.timezone) body.program.timezone = DEFAULT_TZ;
    const result = await svc.createOrUpdateSchedule(body);
    return res.json({ ok: true, result });
  } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
});

/** List programs */
router.get("/programs", async (req, res) => {
  const userId = req.query.userId ? String(req.query.userId) : undefined;
  const svc = await loadIrrigationService();
  if (!svc?.listPrograms) return notImplemented(res, "irrigationService.listPrograms() missing");
  try { return res.json({ ok: true, data: await svc.listPrograms({ userId }) }); }
  catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
});

/** Run zones now (idempotent) */
router.post("/run-now", idempotencyGuard, express.json(), async (req, res) => {
  const body = req.body || {};
  if (!validateRunNow(body)) {
    const msg = validateRunNow.errors?.map(e => `${e.instancePath || "/"} ${e.message}`).join("; ");
    return badRequest(res, msg || "Invalid payload", validateRunNow.errors);
  }
  const svc = await loadIrrigationService();
  if (!svc?.runNow) return notImplemented(res, "irrigationService.runNow() missing");
  try { return res.json({ ok: true, result: await svc.runNow(body) }); }
  catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
});

/** Skip watering (idempotent) */
router.post("/skip", idempotencyGuard, express.json(), async (req, res) => {
  const body = req.body || {};
  if (!validateSkip(body)) {
    const msg = validateSkip.errors?.map(e => `${e.instancePath || "/"} ${e.message}`).join("; ");
    return badRequest(res, msg || "Invalid payload", validateSkip.errors);
  }
  const svc = await loadIrrigationService();
  if (!svc?.skip) return notImplemented(res, "irrigationService.skip() missing");
  try {
    const zones = Array.isArray(body.zones) ? body.zones : [body.zones];
    const result = await svc.skip({ ...body, zones });
    return res.json({ ok: true, result });
  } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
});

/** Telemetry ingest (rate-limited + idempotent) */
router.post("/ingest", idempotencyGuard, limitTelemetry, express.json(), async (req, res) => {
  const body = req.body || {};
  if (!validateIngest(body)) {
    const msg = validateIngest.errors?.map(e => `${e.instancePath || "/"} ${e.message}`).join("; ");
    return badRequest(res, msg || "Invalid payload", validateIngest.errors);
  }
  const svc = await loadIrrigationService();
  if (!svc?.ingestTelemetry) return notImplemented(res, "irrigationService.ingestTelemetry() missing");
  try {
    const result = await svc.ingestTelemetry(body);

    // Optional: generate maintenance tasks from telemetry anomalies (e.g., moisture too low/high)
    const maint = [];
    if (WorkerTasks?.assignTaskToWorker && body.moisture?.percent != null && body.moisture?.zoneId) {
      const pct = Number(body.moisture.percent);
      if (pct <= 5 || pct >= 95) {
        const label = pct <= 5 ? "Check dry zone" : "Check oversaturated zone";
        const t = {
          id: `irrigate-audit-${body.moisture.zoneId}-${Date.now()}`,
          name: `${label}: ${body.moisture.zoneId}`,
          task: `${label} ${body.moisture.zoneId} (reading ${pct}%). Inspect emitters/valves.`,
          source: "irrigation",
          requiredSkills: ["gardening","irrigation","troubleshooting"],
          priorityScore: 70,
          metadata: { zoneId: body.moisture.zoneId, reading: pct }
        };
        try { maint.push(await WorkerTasks.assignTaskToWorker({ taskId: t.id, task: t, role: "gardener" })); } catch {}
      }
    }

    return res.json({ ok: true, result, maintenanceTasks: maint });
  } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
});

/* ------------------------------ New helpers ------------------------------ */

/** Suggest next watering windows (Sabbath/quiet-hour aware) */
router.post("/schedule/suggest", express.json(), (req, res) => {
  const body = req.body || {};
  if (!validateSuggest(body)) {
    const msg = validateSuggest.errors?.map(e => `${e.instancePath || "/"} ${e.message}`).join("; ");
    return badRequest(res, msg || "Invalid payload", validateSuggest.errors);
  }
  const {
    after = new Date().toISOString(),
    windowDays = 7, slots = 3,
    sabbathAware = true, saturdayAsSabbath = false, quietHours, defaultHour = 6,
    durationMinutes = 30
  } = body;

  const picks = [];
  let cursor = new Date(after);
  const end = new Date(new Date(after).getTime() + windowDays * DAY);

  while (cursor <= end && picks.length < slots) {
    const base = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), defaultHour, 0, 0, 0);
    const pick = sabbathAware ? nudgeToAllowed(base, { avoidSabbath: true, saturdayAsSabbath, quietHours, defaultHour }) : base;
    if (pick >= new Date(after)) {
      picks.push({ start: toISO(pick), end: toISO(new Date(pick.getTime() + clamp(durationMinutes, 5, 240) * 60_000)) });
    }
    cursor = new Date(cursor.getTime() + DAY);
  }
  return res.json({ ok: true, data: picks, meta: { slots: picks.length } });
});

/** Calendarize watering or maintenance events */
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
  const defaultHour = Number.isFinite(body.defaultHour) ? body.defaultHour : 6;

  const events = (body.events || []).map((e, i) => {
    const start = sabbathAware ? nudgeToAllowed(new Date(e.start), { avoidSabbath: true, saturdayAsSabbath, quietHours, defaultHour }) : new Date(e.start);
    const end = e.end ? new Date(e.end) : new Date(start.getTime() + 30 * 60_000);
    return {
      title: e.title || `Irrigation Event #${i+1}`,
      description: e.description || "",
      start: toISO(start),
      end: toISO(end),
      timezone: DEFAULT_TZ,
      allDay: false,
      location: e.location || "",
      reminders: [{ minutes: 10, method: "popup" }],
      metadata: { source: "irrigation", ...(e.metadata || {}) },
      externalId: e.externalId || `irrig-${start.toISOString()}-${i}`
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

/** Create maintenance tasks (leaks, filter flush, winterize) */
router.post("/maintenance/tasks", express.json(), async (req, res) => {
  const body = req.body || {};
  if (!validateMaint(body)) {
    const msg = validateMaint.errors?.map(e => `${e.instancePath || "/"} ${e.message}`).join("; ");
    return badRequest(res, msg || "Invalid payload", validateMaint.errors);
  }
  if (!WorkerTasks?.assignTaskToWorker) return res.json({ ok: true, created: [], note: "WorkerTasks not available" });

  const created = [];
  for (const it of body.items) {
    const t = {
      id: `irrig-maint-${it.zoneId}-${Date.now()}`,
      name: it.label,
      task: it.notes ? `${it.label} — ${it.notes}` : it.label,
      source: "irrigation",
      requiredSkills: Array.isArray(it.skills) && it.skills.length ? it.skills : ["irrigation","maintenance","troubleshooting"],
      priorityScore: Number.isFinite(it.priority) ? it.priority * 20 : 60,
      metadata: { zoneId: it.zoneId }
    };
    try { created.push(await WorkerTasks.assignTaskToWorker({ taskId: t.id, task: t, role: "gardener" })); } catch {}
  }
  return res.json({ ok: true, created });
});

/** Zone sanity checks (sensor linkage, flow present, dup names) */
router.get("/zones/check", async (_req, res) => {
  const svc = await loadIrrigationService();
  if (!svc?.listZones) return notImplemented(res, "irrigationService.listZones() missing");
  try {
    const zones = await svc.listZones();
    const names = new Map(); const issues = [];
    for (const z of zones) {
      if (!z.flowRateLpm || z.flowRateLpm <= 0) issues.push({ zoneId: z.zoneId, type: "flowRate", msg: "Missing or zero flow rate" });
      if (!z.moistureSensorId) issues.push({ zoneId: z.zoneId, type: "sensor", msg: "No moisture sensor linked" });
      const key = (z.name || "").toLowerCase();
      if (names.has(key)) issues.push({ zoneId: z.zoneId, type: "duplicateName", msg: `Duplicate name with ${names.get(key)}` });
      else names.set(key, z.zoneId);
    }
    return res.json({ ok: true, zones: zones.length, issues });
  } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
});

/** Program preview (expand next N occurrences heuristically) */
router.post("/programs/preview", express.json(), async (req, res) => {
  const body = req.body || {};
  if (!validateProgram(body)) {
    const msg = validateProgram.errors?.map(e => `${e.instancePath || "/"} ${e.message}`).join("; ");
    return badRequest(res, msg || "Invalid payload", validateProgram.errors);
  }
  const { program } = body;
  const occurrences = [];
  const N = clamp(Number(req.query?.count || 10), 1, 100);
  const tz = program.timezone || DEFAULT_TZ;

  // naive: generate for next 30 days
  const start = new Date(); start.setSeconds(0,0);
  const end = new Date(start.getTime() + 30*DAY);
  const dayName = (d) => ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d.getDay()];

  for (let d = new Date(start); d <= end && occurrences.length < N; d = new Date(d.getTime() + DAY)) {
    const dn = dayName(d);
    for (const r of program.rules) {
      if (!r.days.includes(dn)) continue;
      const [hh, mm] = String(r.time).split(":").map(x => Number(x) || 0);
      const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm, 0, 0);
      // seasonal window
      if (r.startDate && at < new Date(r.startDate)) continue;
      if (r.endDate && at > new Date(r.endDate)) continue;
      occurrences.push({ at: toISO(at), zones: r.zones });
      if (occurrences.length >= N) break;
    }
  }
  return res.json({ ok: true, data: occurrences, meta: { tz, count: occurrences.length } });
});

export default router;

/* ---------------------------------------------------------------------------
Example irrigationService.js (same contract as before)

  // export async function listZones() { ... }
  // export async function upsertZones(zones) { ... }
  // export async function createOrUpdateSchedule({ userId, program }) { ... }
  // export async function listPrograms({ userId }) { ... }
  // export async function runNow({ userId, zones, reason }) { ... }
  // export async function skip({ userId, zones, until, hours, reason }) { ... }
  // export async function ingestTelemetry({ userId, moisture, rain, temperatureC, source, meta }) { ... }

--------------------------------------------------------------------------- */
