// C:\Users\larho\suka-smart-assistant\src\services\session\contracts.js
// Canonical Session/Step/Plan/Resource definitions (contracts) + validators
// -----------------------------------------------------------------------------
// ROLE IN PIPELINE
// imports → intelligence → automation → (optional) hub export
//                               └─ this module defines the canonical *shape*
//                                  for sessions and related objects used by:
//                                  • adapters (fromCooking/…)
//                                  • schedulers & calendars
//                                  • prereq/inventory checks
//                                  • analytics & hub mirroring
//
// What this module provides
// -------------------------
// • Lightweight JSON-Schema-like objects for documentation & runtime checks
// • Fast, dependency-free validators (validateSession/Step/Plan/Resource)
// • Normalizers that coerce common shapes into canonical form
// • Helpers for computing totals & verifying transitions
// • Emits a small bus signal when contracts load (discoverability)
//
// Canonical Payload Shape (on the eventBus)
// -----------------------------------------
// Every SSA event payload should be wrapped by the bus as:
//   { type, ts, source, data }  // with ISO timestamps
// This module only *emits* a "contracts/ready" signal at load. It does not
// change household data and therefore does NOT export to Hub.
// -----------------------------------------------------------------------------

/* --------------------------------- Imports --------------------------------- */
let eventBus, Events;
try {
  const eb = require("@/services/events/eventBus.js");
  eventBus = eb;
  Events = eb.Events || {};
} catch {
  try {
    const eb = require("@/services/events/eventBus.js");
    eventBus = eb;
    Events = eb.Events || {};
  } catch {
    eventBus = { emit: () => {} };
    Events = {};
  }
}

/* ------------------------------- JSON Schemas ------------------------------- */
/**
 * NOTE: These are concise, JSON-Schema-inspired objects for documentation and
 * simple runtime validation. They are NOT a full JSON Schema implementation.
 * Keep keys small and explicit. When adding new fields, prefer optional fields
 * in `meta` to reduce contract churn.
 */

export const ResourceSchema = {
  $id: "ssa.resource",
  title: "Resource (consumable/equipment/person/device reference)",
  type: "object",
  properties: {
    id: {
      type: "string",
      nullable: true,
      desc: "Internal id (inventory/device/person)",
    },
    sku: { type: "string", nullable: true, desc: "SKU or external code" },
    name: {
      type: "string",
      nullable: true,
      desc: "Human-label (display name)",
    },
    qty: { type: "number", nullable: true, desc: "Requested quantity" },
    unit: {
      type: "string",
      nullable: true,
      desc: "Unit of measure (kg, L, pkt, ea)",
    },
    deviceId: {
      type: "string",
      nullable: true,
      desc: "Concrete device id (for calendars)",
    },
    kind: {
      type: "string",
      nullable: true,
      desc: "Device kind / category (e.g., 'tiller')",
    },
    title: { type: "string", nullable: true, desc: "Equipment title override" },
    role: {
      type: "string",
      nullable: true,
      desc: "Required role (when person resource)",
    },
    count: {
      type: "number",
      nullable: true,
      desc: "How many people/devices of this role/kind",
    },
  },
  additionalProperties: false,
};

export const StepSchema = {
  $id: "ssa.session.step",
  title: "Session Step",
  type: "object",
  required: ["idx", "label"],
  properties: {
    idx: { type: "integer", minimum: 1, desc: "1-based index in session flow" },
    label: { type: "string", minLength: 1, desc: "Human step name" },
    estMin: { type: "number", nullable: true, desc: "Estimated minutes" },
    zone: { type: "string", nullable: true, desc: "House zone / area name" },
    bed: {
      type: "string",
      nullable: true,
      desc: "Garden bed/plot (garden domain)",
    },
    crop: { type: "string", nullable: true, desc: "Crop name (garden domain)" },
    notes: { type: "string", nullable: true, desc: "Freeform notes" },
  },
  additionalProperties: false,
};

export const PlanWindowSchema = {
  $id: "ssa.session.window",
  title: "Planning Window",
  type: "object",
  properties: {
    startISO: {
      type: "string",
      format: "date-time",
      nullable: true,
      desc: "Planned start (ISO8601)",
    },
    endISO: {
      type: "string",
      format: "date-time",
      nullable: true,
      desc: "Deadline/end (ISO8601)",
    },
  },
  additionalProperties: false,
};

export const SessionSchema = {
  $id: "ssa.session",
  title: "Scheduler Session Draft/Record",
  type: "object",
  required: ["id", "domain", "title", "durationMin"],
  properties: {
    id: { type: "string", minLength: 1 },
    domain: {
      type: "string",
      enum: [
        "cooking",
        "cleaning",
        "garden",
        "animals",
        "preservation",
        "storehouse",
        "general",
      ],
    },
    title: { type: "string", minLength: 1 },
    location: { type: "string", nullable: true },
    outdoor: { type: "boolean", nullable: true },
    noisy: { type: "boolean", nullable: true },
    durationMin: { type: "number", minimum: 1, maximum: 12 * 60 },
    flexibilityMin: { type: "number", minimum: 0, nullable: true },

    window: PlanWindowSchema,
    equipment: { type: "array", items: ResourceSchema, nullable: true },
    ingredients: { type: "array", items: ResourceSchema, nullable: true }, // consumables/items
    rolesNeeded: { type: "array", items: ResourceSchema, nullable: true }, // person/role resources
    steps: { type: "array", items: StepSchema, nullable: true },

    // Open extension bay to avoid breaking changes
    meta: {
      type: "object",
      nullable: true,
      properties: {
        tags: { type: "array", items: { type: "string" }, nullable: true },
        priority: {
          type: "string",
          enum: ["low", "normal", "high"],
          nullable: true,
        },
        hazards: { type: "array", items: { type: "string" }, nullable: true },
        planContext: { type: "object", nullable: true },
        plots: { type: "array", nullable: true },
        beds: { type: "array", nullable: true },
        crops: { type: "array", nullable: true },
        sourceUrl: { type: "string", nullable: true },
        recipeId: { type: "string", nullable: true },
        planId: { type: "string", nullable: true },
        batch: { type: "object", nullable: true },
        requiresCooling: { type: "boolean", nullable: true },
        requiresDeviceCooldown: { type: "boolean", nullable: true },
        weatherSensitive: { type: "boolean", nullable: true },
        quietSensitive: { type: "boolean", nullable: true },
      },
      additionalProperties: true,
    },
  },
  additionalProperties: false,
};

export const PlanSchema = {
  $id: "ssa.plan",
  title: "Scheduler Plan (approved session, possibly placed)",
  type: "object",
  required: ["session", "status"],
  properties: {
    session: SessionSchema,
    status: {
      type: "string",
      enum: [
        "draft",
        "approved",
        "scheduled",
        "executed",
        "completed",
        "discarded",
        "error",
      ],
    },
    holds: { type: "array", items: { type: "object" }, nullable: true }, // calendar holds (opaque here)
    errors: { type: "array", items: { type: "string" }, nullable: true },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time", nullable: true },
  },
  additionalProperties: false,
};

/* -------------------------------- Validators ------------------------------- */
/**
 * All validators return { ok:boolean, errors?:Array<string> }.
 * They are intentionally strict-but-helpful; unknown properties are rejected
 * except under `meta` where extensions are allowed.
 */

export function validateResource(r) {
  const errors = [];
  if (!isObject(r)) return fail(["resource: expected object"]);
  if (r.qty != null && !isFiniteNumber(r.qty))
    errors.push("resource.qty must be number");
  if (r.count != null && !isFiniteNumber(r.count))
    errors.push("resource.count must be number");
  for (const k of [
    "id",
    "sku",
    "name",
    "unit",
    "deviceId",
    "kind",
    "title",
    "role",
  ]) {
    if (r[k] != null && typeof r[k] !== "string")
      errors.push(`resource.${k} must be string`);
  }
  rejectUnknown(r, ResourceSchema, errors);
  return result(errors);
}

export function validateStep(s) {
  const errors = [];
  if (!isObject(s)) return fail(["step: expected object"]);
  if (!isInteger(s.idx) || s.idx < 1)
    errors.push("step.idx must be integer ≥1");
  if (!isNonEmptyString(s.label)) errors.push("step.label required");
  if (s.estMin != null && !isFiniteNumber(s.estMin))
    errors.push("step.estMin must be number");
  for (const k of ["zone", "bed", "crop", "notes"]) {
    if (s[k] != null && typeof s[k] !== "string")
      errors.push(`step.${k} must be string`);
  }
  rejectUnknown(s, StepSchema, errors);
  return result(errors);
}

export function validateWindow(w) {
  const errors = [];
  if (!isObject(w)) return fail(["window: expected object"]);
  if (w.startISO != null && !isISO(w.startISO))
    errors.push("window.startISO must be ISO datetime");
  if (w.endISO != null && !isISO(w.endISO))
    errors.push("window.endISO must be ISO datetime");
  rejectUnknown(w, PlanWindowSchema, errors);
  return result(errors);
}

export function validateSession(sess) {
  const errors = [];
  if (!isObject(sess)) return fail(["session: expected object"]);
  if (!isNonEmptyString(sess.id)) errors.push("session.id required (string)");
  if (!isNonEmptyString(sess.title))
    errors.push("session.title required (string)");
  if (!isNonEmptyString(sess.domain))
    errors.push("session.domain required (string)");
  if (!isFiniteNumber(sess.durationMin) || sess.durationMin <= 0)
    errors.push("session.durationMin must be > 0");

  if (sess.window) {
    const v = validateWindow(sess.window);
    if (!v.ok) errors.push(...prefix("session.window: ", v.errors));
  }
  if (sess.equipment) {
    if (!Array.isArray(sess.equipment))
      errors.push("session.equipment must be array");
    else
      for (let i = 0; i < sess.equipment.length; i++) {
        const v = validateResource(sess.equipment[i]);
        if (!v.ok)
          errors.push(...prefix(`session.equipment[${i}]: `, v.errors));
      }
  }
  if (sess.ingredients) {
    if (!Array.isArray(sess.ingredients))
      errors.push("session.ingredients must be array");
    else
      for (let i = 0; i < sess.ingredients.length; i++) {
        const v = validateResource(sess.ingredients[i]);
        if (!v.ok)
          errors.push(...prefix(`session.ingredients[${i}]: `, v.errors));
      }
  }
  if (sess.rolesNeeded) {
    if (!Array.isArray(sess.rolesNeeded))
      errors.push("session.rolesNeeded must be array");
    else
      for (let i = 0; i < sess.rolesNeeded.length; i++) {
        const v = validateResource(sess.rolesNeeded[i]);
        if (!v.ok)
          errors.push(...prefix(`session.rolesNeeded[${i}]: `, v.errors));
      }
  }
  if (sess.steps) {
    if (!Array.isArray(sess.steps)) errors.push("session.steps must be array");
    else
      for (let i = 0; i < sess.steps.length; i++) {
        const v = validateStep(sess.steps[i]);
        if (!v.ok) errors.push(...prefix(`session.steps[${i}]: `, v.errors));
      }
  }

  // Primitive types
  for (const k of ["location"]) {
    if (sess[k] != null && typeof sess[k] !== "string")
      errors.push(`session.${k} must be string`);
  }
  for (const k of ["outdoor", "noisy"]) {
    if (sess[k] != null && typeof sess[k] !== "boolean")
      errors.push(`session.${k} must be boolean`);
  }
  if (
    sess.flexibilityMin != null &&
    (!isFiniteNumber(sess.flexibilityMin) || sess.flexibilityMin < 0)
  ) {
    errors.push("session.flexibilityMin must be number ≥ 0");
  }

  // meta is extensible, but if present should be an object
  if (sess.meta != null && !isObject(sess.meta))
    errors.push("session.meta must be object");

  rejectUnknown(sess, SessionSchema, errors);
  return result(errors);
}

export function validatePlan(plan) {
  const errors = [];
  if (!isObject(plan)) return fail(["plan: expected object"]);
  const v = validateSession(plan.session);
  if (!v.ok) errors.push(...prefix("plan.session: ", v.errors));
  if (
    ![
      "draft",
      "approved",
      "scheduled",
      "executed",
      "completed",
      "discarded",
      "error",
    ].includes(plan.status)
  ) {
    errors.push("plan.status invalid");
  }
  if (!isISO(plan.createdAt))
    errors.push("plan.createdAt must be ISO datetime");
  if (plan.updatedAt != null && !isISO(plan.updatedAt))
    errors.push("plan.updatedAt must be ISO datetime");
  rejectUnknown(plan, PlanSchema, errors);
  return result(errors);
}

/* ---------------------------- Normalizer Helpers --------------------------- */
/**
 * Normalize a partial or adapter-specific draft into canonical Session.
 * Safe defaults: clamps duration, trims unknown props, sorts steps by idx.
 */
export function normalizeSessionDraft(x = {}) {
  const s = {
    id: String(x.id || genId()),
    domain: String(x.domain || "general"),
    title: String(x.title || "Household Session"),
    location: x.location || undefined,
    outdoor: !!x.outdoor,
    noisy: !!x.noisy,
    durationMin: clamp(toNum(x.durationMin) || 45, 5, 12 * 60),
    flexibilityMin: toNum(x.flexibilityMin),
    window: normalizeWindow(
      x.window || {
        startISO: firstISO(x.plannedStart),
        endISO: firstISO(x.deadline),
      }
    ),
    equipment: dedupArray(
      (x.equipment || []).map(normalizeResource),
      resourceKey
    ),
    ingredients: dedupArray(
      (x.ingredients || []).map(normalizeResource),
      resourceKey
    ),
    rolesNeeded: dedupArray(
      (x.rolesNeeded || []).map(normalizeResource),
      resourceKey
    ),
    steps: sortByIdx((x.steps || []).map(normalizeStep)),
    meta: isObject(x.meta) ? { ...x.meta } : undefined,
  };
  // Re-validate after normalization (optional)
  return s;
}

/**
 * Compute total estimated minutes by summing steps (fallback to durationMin).
 */
export function computeEstMinutes(session) {
  if (
    Array.isArray(session?.steps) &&
    session.steps.some((s) => isFiniteNumber(s?.estMin))
  ) {
    return session.steps.reduce(
      (acc, s) => acc + (isFiniteNumber(s?.estMin) ? s.estMin : 0),
      0
    );
  }
  return toNum(session?.durationMin) || 0;
}

/**
 * Ensure a legal status transition for a plan (throws on invalid).
 */
export function assertPlanTransition(from, to) {
  const order = [
    "draft",
    "approved",
    "scheduled",
    "executed",
    "completed",
    "discarded",
    "error",
  ];
  const a = order.indexOf(from),
    b = order.indexOf(to);
  if (a === -1 || b === -1) throw new Error(`unknown status: ${from} → ${to}`);
  // allow forward, allow error from any state, allow discarded from any ≤ scheduled
  if (to === "error") return true;
  if (to === "discarded") return true;
  if (b >= a) return true;
  throw new Error(`illegal plan transition: ${from} → ${to}`);
}

/* ---------------------------- Schema Registry I/O --------------------------- */
export const Schemas = {
  ResourceSchema,
  StepSchema,
  PlanWindowSchema,
  SessionSchema,
  PlanSchema,
};

/** Emit a one-time "contracts ready" signal for discovery */
(() => {
  try {
    eventBus.emit(
      "schema/contractsReady",
      {
        schemas: Object.keys(Schemas),
        version: CONTRACTS_VERSION,
      },
      { source: "session.contracts", sticky: true }
    );
  } catch {
    /* noop */
  }
})();

/* --------------------------------- Constants -------------------------------- */
export const CONTRACTS_VERSION = "1.0.0";

/* --------------------------------- Internals -------------------------------- */
function normalizeResource(r = {}) {
  const out = {
    id: strOrUndef(r.id),
    sku: strOrUndef(r.sku),
    name: strOrUndef(r.name),
    qty: toNum(r.qty),
    unit: strOrUndef(r.unit),
    deviceId: strOrUndef(r.deviceId),
    kind: strOrUndef(r.kind),
    title: strOrUndef(r.title),
    role: strOrUndef(r.role),
    count: toNum(r.count),
  };
  return pruneUndef(out);
}
function normalizeStep(s = {}) {
  const out = {
    idx: toInt(s.idx) || 1,
    label: String(s.label || `Step ${toInt(s.idx) || 1}`),
    estMin: toNum(s.estMin),
    zone: strOrUndef(s.zone),
    bed: strOrUndef(s.bed),
    crop: strOrUndef(s.crop),
    notes: strOrUndef(s.notes),
  };
  return pruneUndef(out);
}
function normalizeWindow(w) {
  if (!w) return undefined;
  const startISO = firstISO(w.startISO);
  const endISO = firstISO(w.endISO);
  if (!startISO && !endISO) return undefined;
  return { startISO, endISO };
}

/* ------------------------------- Small helpers ------------------------------ */
function result(errors) {
  return errors.length ? { ok: false, errors } : { ok: true };
}
function fail(errors) {
  return { ok: false, errors };
}
function prefix(p, arr) {
  return (arr || []).map((e) => p + e);
}

function isObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}
function isFiniteNumber(n) {
  return typeof n === "number" && Number.isFinite(n);
}
function isInteger(n) {
  return Number.isInteger(n);
}
function isNonEmptyString(s) {
  return typeof s === "string" && s.trim().length > 0;
}
function isISO(s) {
  return typeof s === "string" && !Number.isNaN(Date.parse(s));
}
function firstISO(...vals) {
  return vals.find(isISO);
}

function toNum(n) {
  return Number.isFinite(n) ? n : Number.isFinite(+n) ? +n : undefined;
}
function toInt(n) {
  const v = toNum(n);
  return Number.isInteger(v) ? v : undefined;
}
function clamp(n, lo, hi) {
  const x = Number.isFinite(n) ? n : lo;
  return Math.max(lo, Math.min(hi, x));
}
function strOrUndef(v) {
  return v != null ? String(v) : undefined;
}
function pruneUndef(o) {
  const out = {};
  for (const k in o) if (o[k] !== undefined) out[k] = o[k];
  return out;
}
function genId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function rejectUnknown(obj, schema, errors) {
  if (!isObject(obj) || !isObject(schema)) return;
  const allowed = new Set(Object.keys(schema.properties || {}));
  for (const k of Object.keys(obj)) {
    if (k === "meta") continue; // extension bay
    if (!allowed.has(k))
      errors.push(`${schema.$id || "object"}: unknown property "${k}"`);
  }
}

function resourceKey(r) {
  return r?.id || r?.deviceId || r?.sku || r?.name || r?.kind || r?.role || "";
}
function dedupArray(arr, keyFn) {
  const out = [];
  const seen = new Set();
  for (const it of arr) {
    if (!it) continue;
    const k = String(keyFn(it) || "");
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}
function sortByIdx(steps) {
  return (steps || [])
    .slice()
    .sort((a, b) => (toInt(a?.idx) || 0) - (toInt(b?.idx) || 0));
}

/* --------------------------------- Exports --------------------------------- */
export default {
  CONTRACTS_VERSION,
  Schemas,

  // Validators
  validateResource,
  validateStep,
  validateWindow,
  validateSession,
  validatePlan,

  // Normalizers & helpers
  normalizeSessionDraft,
  computeEstMinutes,
  assertPlanTransition,
};
