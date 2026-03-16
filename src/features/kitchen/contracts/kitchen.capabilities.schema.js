/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\features\kitchen\contracts\kitchen.capabilities.schema.js
//
// SSA • Kitchen Capabilities Schema (canonical / future move target)
// -----------------------------------------------------------------------------
// Purpose:
//   Canonical contract for kitchen capabilities. This file is the long-term home
//   for the schema, so other domains (recipes, cooking sessions, meal planner)
//   can depend on a stable kitchen feature contract.
//
// IMPORTANT (compat / re-export):
//   You already generated a schema at:
//     src/features/recipes/contracts/kitchen.capabilities.schema.js
//   This kitchen feature schema must remain compatible.
//
// Strategy:
//   - Prefer using this file as the canonical schema moving forward.
//   - For now, this file provides:
//       (1) A full schema implementation (standalone, production-ready)
//       (2) A safe re-export compatibility bridge if you want to keep a single
//           source of truth in recipes/contracts temporarily.
//   - You can later "move" the recipes schema to import from here.
//
// Usage:
//   import kitchenCapabilitiesSchema, {
//     validateKitchenCapabilities,
//     normalizeKitchenCapabilities,
//     KITCHEN_CAPABILITIES_VERSION,
//   } from "@/features/kitchen/contracts/kitchen.capabilities.schema";
//
// Data model:
//   KitchenCapabilitiesRecord
//     - describes what the household/kitchen can do and what equipment it has
//     - supports both "capabilityKeys" and "equipmentIds" used by RecipeAdapterService
//
// No placeholders. Production-ready.

const KITCHEN_CAPABILITIES_VERSION = "1.0.0";

/* ------------------------------ helpers ------------------------------ */

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function safeString(s, max = 300, fallback = "") {
  if (typeof s !== "string") return fallback;
  const t = s.trim();
  return t ? t.slice(0, max) : fallback;
}

function safeLower(s) {
  return typeof s === "string" ? s.trim().toLowerCase() : "";
}

function uniq(arr) {
  return Array.from(
    new Set(
      (Array.isArray(arr) ? arr : [])
        .map((x) => safeString(String(x), 120, ""))
        .filter(Boolean)
    )
  );
}

function clampInt(n, min, max, fallback = null) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  const v = Math.round(x);
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

function nowMs() {
  return Date.now();
}

function idLike(s) {
  // snake_case or kebab-case ids; allow colon for namespacing
  const t = safeString(s, 120, "");
  if (!t) return false;
  return /^[a-z0-9]+([:_-][a-z0-9]+)*$/.test(t);
}

/* ------------------------------ schema object ------------------------------ */
/**
 * Minimal JSON-schema-ish contract descriptor used in SSA
 * (SSA tends to use lightweight validators rather than Ajv for browser safety).
 */
const kitchenCapabilitiesSchema = Object.freeze({
  $id: "ssa.kitchen.capabilities",
  $version: KITCHEN_CAPABILITIES_VERSION,
  title: "KitchenCapabilitiesRecord",
  description:
    "Describes available kitchen equipment and capability keys for tool/method feasibility matching.",
  type: "object",
  required: [
    "kitchenId",
    "householdId",
    "equipmentIds",
    "capabilityKeys",
    "updatedAt",
  ],
  additionalProperties: true,
  properties: {
    kitchenId: { type: "string", minLength: 1, maxLength: 120 },
    householdId: { type: "string", minLength: 1, maxLength: 120 },
    label: { type: "string", minLength: 0, maxLength: 200 },

    // Core arrays used by RecipeAdapterService
    equipmentIds: { type: "array", items: { type: "string" } },
    capabilityKeys: { type: "array", items: { type: "string" } },

    // Optional: preferences / limits
    constraints: {
      type: "object",
      properties: {
        maxSimultaneousBurners: { type: "integer", minimum: 0, maximum: 12 },
        maxOvenRacks: { type: "integer", minimum: 0, maximum: 8 },
        hasVentilation: { type: "boolean" },
        hasOutdoorCooking: { type: "boolean" },
        noiseSensitive: { type: "boolean" },
        smokeSensitive: { type: "boolean" },
      },
    },

    // Optional: metadata about equipment (local-only, UI helpful)
    equipmentCatalog: {
      type: "object",
      description:
        "Optional map of equipmentId -> {id,label,category,aliases,icon} for UI display.",
    },

    // Optional: user-verified flags
    verifiedAt: { type: ["number", "string", "null"] },
    updatedAt: { type: "number" },
    createdAt: { type: ["number", "null"] },

    // Optional: provenance
    source: { type: "string" },
    notes: { type: "string" },
    tags: { type: "array", items: { type: "string" } },

    // Extensibility
    extra: { type: "object" },
  },
});

/* ------------------------------ normalization ------------------------------ */

function normalizeKitchenCapabilities(input, { applyDefaults = true } = {}) {
  const kc = isPlainObject(input) ? input : {};

  const kitchenId = safeString(kc.kitchenId || kc.id || "", 120, "");
  const householdId = safeString(
    kc.householdId || kc.familyId || kc.homeId || "",
    120,
    ""
  );

  const equipmentIds = uniq(kc.equipmentIds || kc.equipment || kc.tools || []);
  const capabilityKeys = uniq(kc.capabilityKeys || kc.capabilities || []);

  const label = safeString(kc.label || kc.name || "", 200, "");

  const constraintsIn = isPlainObject(kc.constraints) ? kc.constraints : {};
  const constraints = {
    maxSimultaneousBurners: clampInt(
      constraintsIn.maxSimultaneousBurners,
      0,
      12,
      null
    ),
    maxOvenRacks: clampInt(constraintsIn.maxOvenRacks, 0, 8, null),
    hasVentilation:
      typeof constraintsIn.hasVentilation === "boolean"
        ? constraintsIn.hasVentilation
        : null,
    hasOutdoorCooking:
      typeof constraintsIn.hasOutdoorCooking === "boolean"
        ? constraintsIn.hasOutdoorCooking
        : null,
    noiseSensitive:
      typeof constraintsIn.noiseSensitive === "boolean"
        ? constraintsIn.noiseSensitive
        : null,
    smokeSensitive:
      typeof constraintsIn.smokeSensitive === "boolean"
        ? constraintsIn.smokeSensitive
        : null,
  };

  // prune nulls for compactness
  Object.keys(constraints).forEach((k) => {
    if (constraints[k] == null) delete constraints[k];
  });

  const equipmentCatalog = isPlainObject(kc.equipmentCatalog)
    ? kc.equipmentCatalog
    : null;

  const out = {
    kitchenId,
    householdId,
    label,
    equipmentIds,
    capabilityKeys,
    constraints: Object.keys(constraints).length ? constraints : undefined,
    equipmentCatalog: equipmentCatalog || undefined,

    createdAt: Number.isFinite(Number(kc.createdAt))
      ? Number(kc.createdAt)
      : undefined,
    updatedAt: Number.isFinite(Number(kc.updatedAt))
      ? Number(kc.updatedAt)
      : applyDefaults
      ? nowMs()
      : undefined,
    verifiedAt: kc.verifiedAt ?? undefined,

    source: safeString(kc.source || "", 200, ""),
    notes: safeString(kc.notes || "", 2000, ""),
    tags: uniq(kc.tags || []),

    extra: isPlainObject(kc.extra) ? kc.extra : undefined,
  };

  // strip empties
  if (!out.label) delete out.label;
  if (!out.source) delete out.source;
  if (!out.notes) delete out.notes;
  if (!out.tags?.length) delete out.tags;
  if (!out.extra) delete out.extra;

  return out;
}

/* ------------------------------ validation ------------------------------ */

function validateKitchenCapabilities(input) {
  const errors = [];
  const kc = normalizeKitchenCapabilities(input, { applyDefaults: false });

  if (!kc.kitchenId)
    errors.push({
      path: "kitchenId",
      code: "required",
      message: "kitchenId is required.",
    });
  if (!kc.householdId)
    errors.push({
      path: "householdId",
      code: "required",
      message: "householdId is required.",
    });

  // Validate ID-ish keys if present (strict but not brittle)
  if (kc.kitchenId && !idLike(kc.kitchenId)) {
    errors.push({
      path: "kitchenId",
      code: "format",
      message:
        "kitchenId should be snake_case/kebab-case (letters/numbers/_-:).",
    });
  }
  if (kc.householdId && !idLike(kc.householdId)) {
    errors.push({
      path: "householdId",
      code: "format",
      message:
        "householdId should be snake_case/kebab-case (letters/numbers/_-:).",
    });
  }

  // Arrays
  if (!Array.isArray(kc.equipmentIds))
    errors.push({
      path: "equipmentIds",
      code: "type",
      message: "equipmentIds must be an array.",
    });
  if (!Array.isArray(kc.capabilityKeys))
    errors.push({
      path: "capabilityKeys",
      code: "type",
      message: "capabilityKeys must be an array.",
    });

  // Validate each entry lightly
  (kc.equipmentIds || []).forEach((id, i) => {
    if (!idLike(id))
      errors.push({
        path: `equipmentIds[${i}]`,
        code: "format",
        message: `Invalid equipment id: "${id}".`,
      });
  });
  (kc.capabilityKeys || []).forEach((k, i) => {
    // capability keys can be namespaced with dot as well
    const ok = /^[a-z0-9]+([._:-][a-z0-9]+)*$/.test(String(k || "").trim());
    if (!ok)
      errors.push({
        path: `capabilityKeys[${i}]`,
        code: "format",
        message: `Invalid capability key: "${k}".`,
      });
  });

  // updatedAt required in canonical record (for persistence)
  if (kc.updatedAt == null || !Number.isFinite(Number(kc.updatedAt))) {
    errors.push({
      path: "updatedAt",
      code: "required",
      message: "updatedAt (ms timestamp) is required.",
    });
  }

  // constraints sanity
  const c = kc.constraints || {};
  if (
    c.maxSimultaneousBurners != null &&
    (c.maxSimultaneousBurners < 0 || c.maxSimultaneousBurners > 12)
  ) {
    errors.push({
      path: "constraints.maxSimultaneousBurners",
      code: "range",
      message: "maxSimultaneousBurners must be 0..12.",
    });
  }
  if (c.maxOvenRacks != null && (c.maxOvenRacks < 0 || c.maxOvenRacks > 8)) {
    errors.push({
      path: "constraints.maxOvenRacks",
      code: "range",
      message: "maxOvenRacks must be 0..8.",
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    value: kc,
    schemaId: kitchenCapabilitiesSchema.$id,
    schemaVersion: kitchenCapabilitiesSchema.$version,
  };
}

/**
 * Throws on invalid input. Returns normalized record on success.
 */
function assertKitchenCapabilities(input) {
  const res = validateKitchenCapabilities(input);
  if (!res.ok) {
    const msg = res.errors.map((e) => `${e.path}: ${e.message}`).join(" | ");
    const err = new Error(`KitchenCapabilities validation failed: ${msg}`);
    err.name = "KitchenCapabilitiesValidationError";
    err.errors = res.errors;
    throw err;
  }
  return res.value;
}

/* ------------------------------ compatibility bridge ------------------------------ */
/**
 * If you decide you want *one* source of truth (temporarily) living under
 * recipes/contracts, you can flip this switch to re-export that file's default.
 * Leave it OFF by default so this kitchen feature file is canonical.
 */
const USE_RECIPES_SCHEMA_AS_SOURCE = false;

let bridgedDefault = null;
if (USE_RECIPES_SCHEMA_AS_SOURCE) {
  try {
    // eslint-disable-next-line global-require
    bridgedDefault =
      require("@/features/recipes/contracts/kitchen.capabilities.schema.js")?.default;
  } catch (e) {
    console.warn(
      "[kitchen.capabilities.schema] bridge import failed, using canonical schema:",
      e?.message || e
    );
    bridgedDefault = null;
  }
}

/* ------------------------------ exports ------------------------------ */

const defaultExport = bridgedDefault || kitchenCapabilitiesSchema;

export {
  kitchenCapabilitiesSchema,
  KITCHEN_CAPABILITIES_VERSION,
  normalizeKitchenCapabilities,
  validateKitchenCapabilities,
  assertKitchenCapabilities,
};

export default defaultExport;
