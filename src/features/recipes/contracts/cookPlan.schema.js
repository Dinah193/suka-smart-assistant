/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\features\recipes\contracts\cookPlan.schema.js
//
// SSA • Cook Plan Schema (Session-Ready Plan Output)
// -----------------------------------------------------------------------------
// Purpose:
//   CookPlan is the *session-ready* execution plan produced from a RecipeVariant
//   (or directly from a recipe + adaptation pipeline).
//
//   It is what SessionRunner consumes to:
//     - render a step timeline
//     - schedule timers
//     - show equipment checklists
//     - enforce doneness/safety targets
//     - provide a consistent "StepGraph-like" plan without requiring AI
//
// Relationship:
//   RecipeVariant -> CookPlan (compiled) -> SessionRunner (execution)
//
// Design goals:
//   - Deterministic, explainable, portable between devices
//   - Stores enough to execute offline
//   - Strong JSON Schema validation (AJV-ready) + normalize helpers
//   - Works for cooking, prep-only, no-cook, and mixed-method recipes
//
// Notes:
//   - Times are stored in seconds.
//   - Temperatures are stored in Fahrenheit for determinism.
//   - A CookPlan can reference a RecipeVariant by id, but also carries a minimal
//     snapshot (title, servings) so it remains usable if the variant changes.
//
// Expected usage:
//   import {
//     COOK_PLAN_SCHEMA,
//     createDefaultCookPlan,
//     normalizeCookPlan,
//     validateCookPlan,
//     assertValidCookPlan,
//     buildTimer,
//     estimatePlanTotals,
//   } from "@/features/recipes/contracts/cookPlan.schema";

const SCHEMA_ID = "ssa://schemas/recipes/cook-plan.schema.json#v1";
const NOW_ISO = () => new Date().toISOString();

/* -------------------------------------------------------------------------- */
/* Enumerations                                                                */
/* -------------------------------------------------------------------------- */

const PLAN_STATUS = ["draft", "ready", "running", "completed", "archived"];
const DIFFICULTY = ["easy", "medium", "hard"];

const COOK_METHODS = [
  "bake",
  "roast",
  "broil",
  "grill",
  "smoke",
  "pan_sear",
  "saute",
  "stir_fry",
  "deep_fry",
  "air_fry",
  "braise",
  "stew",
  "poach",
  "simmer",
  "boil",
  "pressure_cook",
  "slow_cook",
  "sous_vide",
  "microwave",
  "no_cook",
];

const STEP_KINDS = ["prep", "cook", "rest", "serve", "cleanup", "note"];

const TIMER_KINDS = ["prep", "cook", "rest", "reminder"];

const TARGET_KINDS = [
  "internal_temp_f",
  "oven_temp_f",
  "oil_temp_f",
  "water_temp_f",
  "doneness_label",
  "texture_note",
];

const TARGET_SEVERITY = ["info", "warn", "critical"];

const EQUIPMENT_CLASS = [
  "appliance",
  "cookware",
  "utensil",
  "container",
  "other",
];

const QUALITY_FLAGS = [
  "needs_user_review",
  "missing_critical_equipment",
  "ambiguous_doneness",
  "unsafe_target_was_raised",
  "unit_assumptions_made",
  "time_estimates_low_confidence",
  "ingredient_substitutions_made",
  "method_substitution_made",
];

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function deepClone(obj) {
  return obj ? JSON.parse(JSON.stringify(obj)) : obj;
}

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function clampInt(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return undefined;
  const y = Math.round(x);
  if (y < min) return min;
  if (y > max) return max;
  return y;
}

function clampNum(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return undefined;
  if (x < min) return min;
  if (x > max) return max;
  return x;
}

function round1(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return undefined;
  return Math.round(x * 10) / 10;
}

function uniqStrings(arr) {
  const out = [];
  const seen = new Set();
  for (const v of Array.isArray(arr) ? arr : []) {
    const s = typeof v === "string" ? v.trim() : "";
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function safeId(prefix) {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

/* -------------------------------------------------------------------------- */
/* JSON Schema                                                                 */
/* -------------------------------------------------------------------------- */

const COOK_PLAN_SCHEMA = {
  $id: SCHEMA_ID,
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "SSA Cook Plan (Session-Ready Plan Output)",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "id",
    "householdId",
    "status",
    "title",
    "refs",
    "summary",
    "equipment",
    "timeline",
    "targets",
    "timers",
    "checks",
    "quality",
    "meta",
  ],
  properties: {
    schemaVersion: { type: "integer", const: 1 },

    id: { type: "string", minLength: 8, maxLength: 128 },

    householdId: { type: "string", minLength: 1, maxLength: 128 },

    userId: { type: ["string", "null"], default: null, maxLength: 128 },

    status: { type: "string", enum: PLAN_STATUS, default: "draft" },

    title: { type: "string", minLength: 1, maxLength: 200 },

    subtitle: { type: "string", default: "", maxLength: 200 },

    tags: {
      type: "array",
      default: [],
      items: { type: "string", minLength: 1, maxLength: 64 },
      uniqueItems: true,
    },

    difficulty: { type: "string", enum: DIFFICULTY, default: "medium" },

    refs: {
      type: "object",
      additionalProperties: false,
      required: ["recipeVariantId", "sourceRecipeId", "adapterVersion"],
      properties: {
        recipeVariantId: {
          type: ["string", "null"],
          default: null,
          maxLength: 128,
        },
        sourceRecipeId: {
          type: ["string", "null"],
          default: null,
          maxLength: 128,
        },
        adapterVersion: { type: "string", default: "1.0.0", maxLength: 64 },
        donenessProfileId: {
          type: ["string", "null"],
          default: null,
          maxLength: 128,
        },
        kitchenCapabilitiesId: {
          type: ["string", "null"],
          default: null,
          maxLength: 128,
        },
      },
    },

    summary: {
      type: "object",
      additionalProperties: false,
      required: ["servings", "methods", "time", "notes"],
      properties: {
        servings: {
          type: "object",
          additionalProperties: false,
          required: ["count", "unit"],
          properties: {
            count: { type: "number", minimum: 0.25, maximum: 1000 },
            unit: { type: "string", default: "servings", maxLength: 32 },
          },
        },

        methods: {
          type: "object",
          additionalProperties: false,
          required: ["primary", "secondary"],
          properties: {
            primary: { type: "string", enum: COOK_METHODS },
            secondary: {
              type: "array",
              default: [],
              items: { type: "string", enum: COOK_METHODS },
              uniqueItems: true,
            },
          },
        },

        time: {
          type: "object",
          additionalProperties: false,
          required: [
            "activeSeconds",
            "restSeconds",
            "totalSeconds",
            "confidence",
          ],
          properties: {
            activeSeconds: {
              type: "integer",
              minimum: 0,
              maximum: 7 * 24 * 3600,
              default: 0,
            },
            restSeconds: {
              type: "integer",
              minimum: 0,
              maximum: 4 * 3600,
              default: 0,
            },
            totalSeconds: {
              type: "integer",
              minimum: 0,
              maximum: 7 * 24 * 3600,
              default: 0,
            },
            confidence: {
              type: "number",
              minimum: 0,
              maximum: 1,
              default: 0.7,
            },
          },
        },

        notes: { type: "string", default: "", maxLength: 8000 },
      },
    },

    equipment: {
      type: "object",
      additionalProperties: false,
      required: ["required", "optional", "missingAtCompileTime"],
      properties: {
        required: {
          type: "array",
          items: { $ref: "#/$defs/EquipmentItem" },
          default: [],
        },
        optional: {
          type: "array",
          items: { $ref: "#/$defs/EquipmentItem" },
          default: [],
        },
        missingAtCompileTime: {
          type: "array",
          items: { $ref: "#/$defs/EquipmentItem" },
          default: [],
          description:
            "If compiling under limited capabilities, record what was missing.",
        },
      },
    },

    /**
     * Timeline steps are the primary session-runner sequence.
     * Each step can reference targets and timers by id.
     */
    timeline: {
      type: "array",
      minItems: 1,
      items: { $ref: "#/$defs/PlanStep" },
    },

    /**
     * Targets are centralized so they can be reused across steps.
     * SessionRunner can display targets as badges and enforce critical ones.
     */
    targets: {
      type: "array",
      default: [],
      items: { $ref: "#/$defs/Target" },
    },

    /**
     * Timers are centralized so they can be started/restarted and referenced.
     */
    timers: {
      type: "array",
      default: [],
      items: { $ref: "#/$defs/Timer" },
    },

    /**
     * Checks are actionable items shown before/during the session:
     *  - thaw the meat, preheat, sanitize, etc.
     */
    checks: {
      type: "object",
      additionalProperties: false,
      required: ["preflight", "midflight", "postflight"],
      properties: {
        preflight: {
          type: "array",
          default: [],
          items: { $ref: "#/$defs/CheckItem" },
        },
        midflight: {
          type: "array",
          default: [],
          items: { $ref: "#/$defs/CheckItem" },
        },
        postflight: {
          type: "array",
          default: [],
          items: { $ref: "#/$defs/CheckItem" },
        },
      },
    },

    quality: {
      type: "object",
      additionalProperties: false,
      required: ["needsUserReview", "confidence", "flags", "warnings"],
      properties: {
        needsUserReview: { type: "boolean", default: true },
        confidence: { type: "number", minimum: 0, maximum: 1, default: 0.7 },
        flags: {
          type: "array",
          default: [],
          items: { type: "string", enum: QUALITY_FLAGS },
          uniqueItems: true,
        },
        warnings: {
          type: "array",
          default: [],
          items: { $ref: "#/$defs/Warning" },
        },
      },
    },

    meta: {
      type: "object",
      additionalProperties: false,
      required: ["createdAt", "updatedAt", "source", "version"],
      properties: {
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
        source: {
          type: "string",
          default: "features/recipes/contracts/cookPlan.schema",
        },
        version: { type: "integer", minimum: 0, default: 0 },
      },
    },
  },

  $defs: {
    EquipmentItem: {
      type: "object",
      additionalProperties: false,
      required: ["id", "class", "key", "label", "optional"],
      properties: {
        id: { type: "string", minLength: 6, maxLength: 128 },
        class: { type: "string", enum: EQUIPMENT_CLASS, default: "other" },
        key: { type: "string", minLength: 1, maxLength: 128 },
        label: { type: "string", minLength: 1, maxLength: 256 },
        optional: { type: "boolean", default: false },
        notes: { type: "string", default: "", maxLength: 1000 },
      },
    },

    PlanStep: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "order",
        "kind",
        "title",
        "text",
        "estimatedSeconds",
        "targets",
        "timers",
        "requires",
        "notes",
      ],
      properties: {
        id: { type: "string", minLength: 6, maxLength: 128 },
        order: { type: "integer", minimum: 1, maximum: 10000 },
        kind: { type: "string", enum: STEP_KINDS, default: "cook" },

        title: { type: "string", minLength: 1, maxLength: 200 },
        text: { type: "string", minLength: 1, maxLength: 8000 },

        estimatedSeconds: {
          type: "integer",
          minimum: 0,
          maximum: 7 * 24 * 3600,
          default: 0,
        },

        // References by id to centralized targets/timers
        targets: {
          type: "array",
          default: [],
          items: { type: "string", minLength: 6, maxLength: 128 },
        },
        timers: {
          type: "array",
          default: [],
          items: { type: "string", minLength: 6, maxLength: 128 },
        },

        requires: {
          type: "object",
          additionalProperties: false,
          required: ["equipmentIds", "methods"],
          properties: {
            equipmentIds: {
              type: "array",
              default: [],
              items: { type: "string", minLength: 6, maxLength: 128 },
            },
            methods: {
              type: "array",
              default: [],
              items: { type: "string", enum: COOK_METHODS },
              uniqueItems: true,
            },
          },
        },

        notes: { type: "string", default: "", maxLength: 2000 },

        // Optional: step can declare a "gate" (must confirm) before moving on
        gate: {
          type: "object",
          additionalProperties: false,
          default: {},
          properties: {
            required: { type: "boolean", default: false },
            prompt: { type: "string", default: "", maxLength: 500 },
          },
        },
      },
    },

    Target: {
      type: "object",
      additionalProperties: false,
      required: ["id", "kind", "label", "value", "unit", "severity", "source"],
      properties: {
        id: { type: "string", minLength: 6, maxLength: 128 },
        kind: { type: "string", enum: TARGET_KINDS },
        label: { type: "string", minLength: 1, maxLength: 200 },

        value: {
          type: ["number", "string"],
          description: "Number (temp) or label string (doneness).",
        },
        unit: { type: ["string", "null"], default: null, maxLength: 16 },

        // For temps; if kind is doneness_label, value is string and unit null
        severity: { type: "string", enum: TARGET_SEVERITY, default: "info" },

        // Provenance / explainability
        source: {
          type: "string",
          default: "",
          maxLength: 256,
          description:
            "e.g., DonenessTargets.catalog rule id, or 'user_override'.",
        },

        notes: { type: "string", default: "", maxLength: 1000 },
      },
    },

    Timer: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "label",
        "seconds",
        "kind",
        "stepId",
        "startsAfterStepId",
      ],
      properties: {
        id: { type: "string", minLength: 6, maxLength: 128 },
        label: { type: "string", minLength: 1, maxLength: 256 },
        seconds: { type: "integer", minimum: 1, maximum: 7 * 24 * 3600 },
        kind: { type: "string", enum: TIMER_KINDS, default: "cook" },
        stepId: { type: ["string", "null"], default: null, maxLength: 128 },
        startsAfterStepId: {
          type: ["string", "null"],
          default: null,
          maxLength: 128,
        },
        notes: { type: "string", default: "", maxLength: 1000 },
      },
    },

    CheckItem: {
      type: "object",
      additionalProperties: false,
      required: ["id", "label", "done", "severity", "notes"],
      properties: {
        id: { type: "string", minLength: 6, maxLength: 128 },
        label: { type: "string", minLength: 1, maxLength: 300 },
        done: { type: "boolean", default: false },
        severity: {
          type: "string",
          enum: ["info", "warn", "critical"],
          default: "info",
        },
        notes: { type: "string", default: "", maxLength: 1000 },
        // Optional linking for UI navigation (go to step)
        stepId: { type: ["string", "null"], default: null, maxLength: 128 },
      },
    },

    Warning: {
      type: "object",
      additionalProperties: false,
      required: ["code", "message", "severity", "context"],
      properties: {
        code: { type: "string", minLength: 1, maxLength: 128 },
        message: { type: "string", minLength: 1, maxLength: 2000 },
        severity: {
          type: "string",
          enum: ["info", "warn", "error"],
          default: "warn",
        },
        context: { type: "object", additionalProperties: true, default: {} },
      },
    },
  },
};

/* -------------------------------------------------------------------------- */
/* Defaults                                                                    */
/* -------------------------------------------------------------------------- */

function createDefaultCookPlan(args = {}) {
  const id =
    typeof args.id === "string" && args.id ? args.id : safeId("cookplan");
  const householdId =
    typeof args.householdId === "string" && args.householdId
      ? args.householdId
      : "household_default";
  const createdAt = NOW_ISO();

  const stepId = safeId("planstep");
  const timerId = safeId("timer");
  const targetId = safeId("target");

  return {
    schemaVersion: 1,
    id,
    householdId,
    userId: typeof args.userId === "string" ? args.userId : null,
    status: "draft",
    title:
      typeof args.title === "string" && args.title ? args.title : "Cook Plan",
    subtitle: "",
    tags: [],
    difficulty: "medium",

    refs: {
      recipeVariantId:
        typeof args.recipeVariantId === "string" ? args.recipeVariantId : null,
      sourceRecipeId:
        typeof args.sourceRecipeId === "string" ? args.sourceRecipeId : null,
      adapterVersion:
        typeof args.adapterVersion === "string" && args.adapterVersion
          ? args.adapterVersion
          : "1.0.0",
      donenessProfileId: null,
      kitchenCapabilitiesId: null,
    },

    summary: {
      servings: { count: 4, unit: "servings" },
      methods: { primary: "bake", secondary: [] },
      time: {
        activeSeconds: 0,
        restSeconds: 0,
        totalSeconds: 0,
        confidence: 0.7,
      },
      notes: "Review equipment and targets before starting.",
    },

    equipment: {
      required: [],
      optional: [],
      missingAtCompileTime: [],
    },

    targets: [
      {
        id: targetId,
        kind: "doneness_label",
        label: "Doneness",
        value: "target",
        unit: null,
        severity: "info",
        source: "fallback",
        notes: "",
      },
    ],

    timers: [
      {
        id: timerId,
        label: "Default timer",
        seconds: 60,
        kind: "reminder",
        stepId,
        startsAfterStepId: null,
        notes: "",
      },
    ],

    timeline: [
      {
        id: stepId,
        order: 1,
        kind: "note",
        title: "Preflight",
        text: "Confirm equipment, preheat if needed, and review targets.",
        estimatedSeconds: 0,
        targets: [targetId],
        timers: [timerId],
        requires: { equipmentIds: [], methods: ["bake"] },
        notes: "",
        gate: { required: false, prompt: "" },
      },
    ],

    checks: {
      preflight: [],
      midflight: [],
      postflight: [],
    },

    quality: {
      needsUserReview: true,
      confidence: 0.7,
      flags: ["needs_user_review"],
      warnings: [],
    },

    meta: {
      createdAt,
      updatedAt: createdAt,
      source: "features/recipes/contracts/cookPlan.schema",
      version: 0,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Normalization                                                               */
/* -------------------------------------------------------------------------- */

function normalizeCookPlan(raw, opts = {}) {
  const { quiet = true } = opts;
  const base = isPlainObject(raw) ? deepClone(raw) : {};
  const out =
    isPlainObject(base) && base.schemaVersion === 1
      ? base
      : createDefaultCookPlan({
          id: base.id,
          householdId: base.householdId,
          userId: base.userId,
          title: base.title,
          recipeVariantId: base?.refs?.recipeVariantId,
          sourceRecipeId: base?.refs?.sourceRecipeId,
          adapterVersion: base?.refs?.adapterVersion,
        });

  // Meta
  if (!out.meta) out.meta = {};
  if (!out.meta.createdAt) out.meta.createdAt = NOW_ISO();
  out.meta.updatedAt = NOW_ISO();
  out.meta.version = clampInt(out.meta.version ?? 0, 0, 1_000_000) ?? 0;
  if (typeof out.meta.source !== "string")
    out.meta.source = "features/recipes/contracts/cookPlan.schema";

  // Core strings
  if (typeof out.id !== "string" || out.id.length < 8)
    out.id = safeId("cookplan");
  if (typeof out.householdId !== "string" || !out.householdId)
    out.householdId = "household_default";
  if (out.userId != null && typeof out.userId !== "string") out.userId = null;

  if (!PLAN_STATUS.includes(out.status)) out.status = "draft";
  if (typeof out.title !== "string" || !out.title.trim())
    out.title = "Cook Plan";
  out.title = out.title.trim().slice(0, 200);
  if (typeof out.subtitle !== "string") out.subtitle = "";
  out.subtitle = out.subtitle.trim().slice(0, 200);

  out.tags = uniqStrings(out.tags).slice(0, 100);
  if (!DIFFICULTY.includes(out.difficulty)) out.difficulty = "medium";

  // Refs
  if (!out.refs || !isPlainObject(out.refs))
    out.refs = createDefaultCookPlan().refs;
  normalizeNullableString(out.refs, "recipeVariantId", 128);
  normalizeNullableString(out.refs, "sourceRecipeId", 128);
  if (typeof out.refs.adapterVersion !== "string" || !out.refs.adapterVersion)
    out.refs.adapterVersion = "1.0.0";
  out.refs.adapterVersion = out.refs.adapterVersion.slice(0, 64);
  normalizeNullableString(out.refs, "donenessProfileId", 128);
  normalizeNullableString(out.refs, "kitchenCapabilitiesId", 128);

  // Summary
  if (!out.summary || !isPlainObject(out.summary))
    out.summary = createDefaultCookPlan().summary;

  // servings
  if (!out.summary.servings || !isPlainObject(out.summary.servings))
    out.summary.servings = { count: 4, unit: "servings" };
  out.summary.servings.count =
    round1(clampNum(out.summary.servings.count ?? 4, 0.25, 1000)) ?? 4;
  if (
    typeof out.summary.servings.unit !== "string" ||
    !out.summary.servings.unit
  )
    out.summary.servings.unit = "servings";
  out.summary.servings.unit = out.summary.servings.unit.slice(0, 32);

  // methods
  if (!out.summary.methods || !isPlainObject(out.summary.methods))
    out.summary.methods = { primary: "bake", secondary: [] };
  if (!COOK_METHODS.includes(out.summary.methods.primary))
    out.summary.methods.primary = "bake";
  out.summary.methods.secondary = uniqStrings(
    out.summary.methods.secondary
  ).filter((m) => COOK_METHODS.includes(m));

  // time
  if (!out.summary.time || !isPlainObject(out.summary.time))
    out.summary.time = {
      activeSeconds: 0,
      restSeconds: 0,
      totalSeconds: 0,
      confidence: 0.7,
    };
  out.summary.time.activeSeconds =
    clampInt(out.summary.time.activeSeconds ?? 0, 0, 7 * 24 * 3600) ?? 0;
  out.summary.time.restSeconds =
    clampInt(out.summary.time.restSeconds ?? 0, 0, 4 * 3600) ?? 0;
  out.summary.time.totalSeconds =
    clampInt(out.summary.time.totalSeconds ?? 0, 0, 7 * 24 * 3600) ?? 0;
  out.summary.time.confidence =
    clampNum(out.summary.time.confidence ?? 0.7, 0, 1) ?? 0.7;

  if (typeof out.summary.notes !== "string") out.summary.notes = "";
  out.summary.notes = out.summary.notes.slice(0, 8000);

  // Equipment
  if (!out.equipment || !isPlainObject(out.equipment))
    out.equipment = createDefaultCookPlan().equipment;
  out.equipment.required = normalizeEquipmentList(out.equipment.required);
  out.equipment.optional = normalizeEquipmentList(out.equipment.optional);
  out.equipment.missingAtCompileTime = normalizeEquipmentList(
    out.equipment.missingAtCompileTime
  );

  // Targets
  out.targets = Array.isArray(out.targets) ? out.targets : [];
  out.targets = out.targets
    .filter((t) => isPlainObject(t))
    .map((t) => normalizeTarget(t));

  // Timers
  out.timers = Array.isArray(out.timers) ? out.timers : [];
  out.timers = out.timers
    .filter((t) => isPlainObject(t))
    .map((t) => normalizeTimer(t));

  // Timeline
  out.timeline = Array.isArray(out.timeline) ? out.timeline : [];
  if (!out.timeline.length) out.timeline = createDefaultCookPlan().timeline;
  out.timeline = out.timeline
    .filter((s) => isPlainObject(s))
    .map((s, idx) => normalizePlanStep(s, idx));

  // Ensure step order and stable mapping
  out.timeline.sort((a, b) => a.order - b.order);
  for (let i = 0; i < out.timeline.length; i += 1) {
    out.timeline[i].order = i + 1;
  }

  // Checks
  if (!out.checks || !isPlainObject(out.checks))
    out.checks = createDefaultCookPlan().checks;
  out.checks.preflight = normalizeCheckList(out.checks.preflight);
  out.checks.midflight = normalizeCheckList(out.checks.midflight);
  out.checks.postflight = normalizeCheckList(out.checks.postflight);

  // Quality
  if (!out.quality || !isPlainObject(out.quality))
    out.quality = createDefaultCookPlan().quality;
  out.quality.needsUserReview = !!out.quality.needsUserReview;
  out.quality.confidence =
    clampNum(
      out.quality.confidence ?? out.summary.time.confidence ?? 0.7,
      0,
      1
    ) ?? 0.7;
  out.quality.flags = uniqStrings(out.quality.flags).filter((f) =>
    QUALITY_FLAGS.includes(f)
  );
  out.quality.warnings = Array.isArray(out.quality.warnings)
    ? out.quality.warnings
    : [];
  out.quality.warnings = out.quality.warnings
    .filter((w) => isPlainObject(w))
    .map((w) => normalizeWarning(w));

  // Soft validate
  const vr = validateCookPlan(out);
  if (!vr.ok && !quiet) {
    console.warn(
      "[SSA][cookPlan] normalize produced invalid CookPlan:",
      vr.errors
    );
  }

  return out;
}

function normalizeNullableString(obj, key, maxLen) {
  if (!obj || !isPlainObject(obj)) return;
  const v = obj[key];
  if (v == null) {
    obj[key] = null;
    return;
  }
  if (typeof v !== "string") {
    obj[key] = null;
    return;
  }
  const s = v.trim();
  obj[key] = s ? s.slice(0, maxLen) : null;
}

function normalizeEquipmentList(list) {
  const arr = Array.isArray(list) ? list : [];
  const out = [];
  const seen = new Set();
  for (const e of arr) {
    if (!isPlainObject(e)) continue;
    const id = typeof e.id === "string" && e.id ? e.id : safeId("equip");
    const cls = EQUIPMENT_CLASS.includes(e.class) ? e.class : "other";
    const key = typeof e.key === "string" ? e.key.trim().slice(0, 128) : "";
    const label =
      typeof e.label === "string" ? e.label.trim().slice(0, 256) : "";
    const optional = !!e.optional;
    const notes = typeof e.notes === "string" ? e.notes.slice(0, 1000) : "";
    if (!key || !label) continue;
    const sig = `${cls}::${key}::${label}::${optional ? "1" : "0"}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push({ id, class: cls, key, label, optional, notes });
  }
  return out;
}

function normalizeTarget(t) {
  const out = deepClone(t);
  out.id = typeof out.id === "string" && out.id ? out.id : safeId("target");
  out.kind = TARGET_KINDS.includes(out.kind) ? out.kind : "doneness_label";
  out.label =
    typeof out.label === "string" && out.label.trim()
      ? out.label.trim().slice(0, 200)
      : "Target";

  if (out.kind === "doneness_label" || out.kind === "texture_note") {
    out.value =
      typeof out.value === "string" && out.value.trim()
        ? out.value.trim().slice(0, 200)
        : "target";
    out.unit = null;
  } else {
    // Temps
    out.value = round1(clampNum(out.value, 0, 10000));
    if (out.value == null) out.value = 0;
    out.unit =
      typeof out.unit === "string" && out.unit.trim()
        ? out.unit.trim().slice(0, 16)
        : "F";
  }

  out.severity = TARGET_SEVERITY.includes(out.severity) ? out.severity : "info";
  if (typeof out.source !== "string") out.source = "";
  out.source = out.source.slice(0, 256);
  if (typeof out.notes !== "string") out.notes = "";
  out.notes = out.notes.slice(0, 1000);

  return out;
}

function normalizeTimer(t) {
  const out = deepClone(t);
  out.id = typeof out.id === "string" && out.id ? out.id : safeId("timer");
  out.label =
    typeof out.label === "string" && out.label.trim()
      ? out.label.trim().slice(0, 256)
      : "Timer";
  out.seconds = clampInt(out.seconds ?? 60, 1, 7 * 24 * 3600) ?? 60;
  out.kind = TIMER_KINDS.includes(out.kind) ? out.kind : "cook";
  if (out.stepId != null && typeof out.stepId !== "string") out.stepId = null;
  if (typeof out.stepId === "string") out.stepId = out.stepId.slice(0, 128);
  if (
    out.startsAfterStepId != null &&
    typeof out.startsAfterStepId !== "string"
  )
    out.startsAfterStepId = null;
  if (typeof out.startsAfterStepId === "string")
    out.startsAfterStepId = out.startsAfterStepId.slice(0, 128);
  if (typeof out.notes !== "string") out.notes = "";
  out.notes = out.notes.slice(0, 1000);
  return out;
}

function normalizePlanStep(s, idx) {
  const out = deepClone(s);
  out.id = typeof out.id === "string" && out.id ? out.id : safeId("planstep");
  out.order = clampInt(out.order ?? idx + 1, 1, 10000) ?? idx + 1;
  out.kind = STEP_KINDS.includes(out.kind) ? out.kind : "cook";
  out.title =
    typeof out.title === "string" && out.title.trim()
      ? out.title.trim().slice(0, 200)
      : `Step ${idx + 1}`;
  out.text =
    typeof out.text === "string" && out.text.trim()
      ? out.text.trim().slice(0, 8000)
      : out.title;
  out.estimatedSeconds =
    clampInt(out.estimatedSeconds ?? 0, 0, 7 * 24 * 3600) ?? 0;

  out.targets = uniqStrings(out.targets).slice(0, 50);
  out.timers = uniqStrings(out.timers).slice(0, 50);

  if (!out.requires || !isPlainObject(out.requires))
    out.requires = { equipmentIds: [], methods: [] };
  out.requires.equipmentIds = uniqStrings(out.requires.equipmentIds).slice(
    0,
    100
  );
  out.requires.methods = uniqStrings(out.requires.methods).filter((m) =>
    COOK_METHODS.includes(m)
  );

  if (typeof out.notes !== "string") out.notes = "";
  out.notes = out.notes.slice(0, 2000);

  if (!out.gate || !isPlainObject(out.gate))
    out.gate = { required: false, prompt: "" };
  out.gate.required = !!out.gate.required;
  if (typeof out.gate.prompt !== "string") out.gate.prompt = "";
  out.gate.prompt = out.gate.prompt.slice(0, 500);

  return out;
}

function normalizeCheckList(list) {
  const arr = Array.isArray(list) ? list : [];
  const out = [];
  const seen = new Set();
  for (const c of arr) {
    if (!isPlainObject(c)) continue;
    const id = typeof c.id === "string" && c.id ? c.id : safeId("check");
    const label =
      typeof c.label === "string" && c.label.trim()
        ? c.label.trim().slice(0, 300)
        : "";
    if (!label) continue;
    const done = !!c.done;
    const severity = ["info", "warn", "critical"].includes(c.severity)
      ? c.severity
      : "info";
    const notes = typeof c.notes === "string" ? c.notes.slice(0, 1000) : "";
    const stepId =
      c.stepId == null
        ? null
        : typeof c.stepId === "string"
        ? c.stepId.slice(0, 128)
        : null;
    const sig = `${label}::${severity}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push({ id, label, done, severity, notes, stepId });
  }
  return out;
}

function normalizeWarning(w) {
  const out = deepClone(w);
  out.code =
    typeof out.code === "string" && out.code.trim()
      ? out.code.trim().slice(0, 128)
      : "warning";
  out.message =
    typeof out.message === "string" && out.message.trim()
      ? out.message.trim().slice(0, 2000)
      : "Warning";
  out.severity = ["info", "warn", "error"].includes(out.severity)
    ? out.severity
    : "warn";
  out.context = isPlainObject(out.context) ? out.context : {};
  return out;
}

/* -------------------------------------------------------------------------- */
/* Validation (AJV optional)                                                   */
/* -------------------------------------------------------------------------- */
/**
 * Browser-safe validation:
 *  - NO Node `require()` (Vite/Rollup build-safe)
 *  - If you want AJV validation, pass an Ajv instance:
 *      validateCookPlan(doc, { ajv })
 */
function validateCookPlan(doc, opts = {}) {
  const ajv = opts?.ajv;

  if (ajv && typeof ajv.compile === "function") {
    try {
      const validate = ajv.compile(COOK_PLAN_SCHEMA);
      const ok = !!validate(doc);
      const errors = (validate.errors || []).map((er) => ({
        path: er.instancePath || er.schemaPath || "",
        message: er.message || "invalid",
      }));
      return { ok, errors };
    } catch (e) {
      return lightweightValidate(doc);
    }
  }

  return lightweightValidate(doc);
}

function lightweightValidate(doc) {
  const errors = [];
  if (!isPlainObject(doc)) {
    return {
      ok: false,
      errors: [{ path: "", message: "CookPlan must be an object" }],
    };
  }
  if (doc.schemaVersion !== 1)
    errors.push({ path: "/schemaVersion", message: "schemaVersion must be 1" });
  if (typeof doc.id !== "string" || doc.id.length < 8)
    errors.push({ path: "/id", message: "id must be a string (minLength 8)" });
  if (typeof doc.householdId !== "string" || !doc.householdId)
    errors.push({ path: "/householdId", message: "householdId required" });
  if (typeof doc.title !== "string" || !doc.title)
    errors.push({ path: "/title", message: "title required" });
  if (!Array.isArray(doc.timeline) || !doc.timeline.length)
    errors.push({
      path: "/timeline",
      message: "timeline must be non-empty array",
    });
  return { ok: errors.length === 0, errors };
}

function assertValidCookPlan(doc, opts = {}) {
  const r = validateCookPlan(doc, opts);
  if (!r.ok) {
    const msg =
      "[SSA][cookPlan] Invalid CookPlan: " +
      r.errors.map((e) => `${e.path}: ${e.message}`).join("; ");
    const err = new Error(msg);
    err.name = "CookPlanValidationError";
    err.details = r.errors;
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/* Convenience helpers                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Build a timer object in a safe normalized way.
 */
function buildTimer({
  label,
  seconds,
  kind = "cook",
  stepId = null,
  startsAfterStepId = null,
  notes = "",
} = {}) {
  return normalizeTimer({
    id: safeId("timer"),
    label: typeof label === "string" && label.trim() ? label.trim() : "Timer",
    seconds: clampInt(seconds ?? 60, 1, 7 * 24 * 3600) ?? 60,
    kind,
    stepId,
    startsAfterStepId,
    notes,
  });
}

/**
 * Estimate totals from timeline + timers and write into plan.summary.time.
 * This is intentionally conservative: uses sum of step estimatedSeconds.
 */
function estimatePlanTotals(plan) {
  const p = isPlainObject(plan) ? plan : null;
  if (!p) return plan;

  const timeline = Array.isArray(p.timeline) ? p.timeline : [];
  const active = timeline.reduce(
    (sum, s) => sum + (Number(s.estimatedSeconds) || 0),
    0
  );

  // restSeconds can be inferred by counting rest steps
  const rest = timeline
    .filter((s) => s && s.kind === "rest")
    .reduce((sum, s) => sum + (Number(s.estimatedSeconds) || 0), 0);

  const total = active; // already includes rest if rest steps have estimatedSeconds
  if (!p.summary) p.summary = createDefaultCookPlan().summary;
  if (!p.summary.time) p.summary.time = createDefaultCookPlan().summary.time;

  p.summary.time.activeSeconds = clampInt(active, 0, 7 * 24 * 3600) ?? 0;
  p.summary.time.restSeconds = clampInt(rest, 0, 4 * 3600) ?? 0;
  p.summary.time.totalSeconds = clampInt(total, 0, 7 * 24 * 3600) ?? 0;

  return p;
}

/**
 * Validate references: make sure timeline step target/timer ids exist.
 * Returns a list of dangling references (does not mutate).
 */
function findDanglingRefs(plan) {
  const p = isPlainObject(plan) ? plan : null;
  if (!p) return { targets: [], timers: [], equipment: [] };

  const targetIds = new Set(
    (Array.isArray(p.targets) ? p.targets : []).map((t) => t.id).filter(Boolean)
  );
  const timerIds = new Set(
    (Array.isArray(p.timers) ? p.timers : []).map((t) => t.id).filter(Boolean)
  );
  const equipIds = new Set(
    [
      ...(Array.isArray(p.equipment?.required) ? p.equipment.required : []),
      ...(Array.isArray(p.equipment?.optional) ? p.equipment.optional : []),
      ...(Array.isArray(p.equipment?.missingAtCompileTime)
        ? p.equipment.missingAtCompileTime
        : []),
    ]
      .map((e) => e.id)
      .filter(Boolean)
  );

  const danglingTargets = [];
  const danglingTimers = [];
  const danglingEquip = [];

  for (const s of Array.isArray(p.timeline) ? p.timeline : []) {
    if (!s) continue;
    for (const tid of Array.isArray(s.targets) ? s.targets : []) {
      if (tid && !targetIds.has(tid))
        danglingTargets.push({ stepId: s.id, ref: tid });
    }
    for (const rid of Array.isArray(s.timers) ? s.timers : []) {
      if (rid && !timerIds.has(rid))
        danglingTimers.push({ stepId: s.id, ref: rid });
    }
    for (const eid of Array.isArray(s.requires?.equipmentIds)
      ? s.requires.equipmentIds
      : []) {
      if (eid && !equipIds.has(eid))
        danglingEquip.push({ stepId: s.id, ref: eid });
    }
  }

  return {
    targets: danglingTargets,
    timers: danglingTimers,
    equipment: danglingEquip,
  };
}

/* -------------------------------------------------------------------------- */
/* Exports                                                                     */
/* -------------------------------------------------------------------------- */

export {
  // Schema
  COOK_PLAN_SCHEMA,
  SCHEMA_ID,

  // Enums
  PLAN_STATUS,
  DIFFICULTY,
  COOK_METHODS,
  STEP_KINDS,
  TIMER_KINDS,
  TARGET_KINDS,
  TARGET_SEVERITY,
  EQUIPMENT_CLASS,
  QUALITY_FLAGS,

  // Defaults + normalize + validate
  createDefaultCookPlan,
  normalizeCookPlan,
  validateCookPlan,
  assertValidCookPlan,

  // Helpers
  buildTimer,
  estimatePlanTotals,
  findDanglingRefs,
};

// ✅ FIX: provide default export so `export { default as cookPlanSchema } ...` works.
export default COOK_PLAN_SCHEMA;
