/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\features\recipes\contracts\recipeVariant.schema.js
//
// SSA • Recipe Variant (Persisted Adapted Recipe) Schema
// -----------------------------------------------------------------------------
// Purpose:
//   A RecipeVariant is the *persisted result* of adapting an imported/manual
//   recipe to a specific household's preferences and kitchen capabilities.
//   It is what SSA runs in SessionRunner, prints, shares, and stores in Dexie.
//
// Key ideas:
//   - Immutable-ish "adaptation snapshot": references the source recipe + records
//     what changed (tools, methods, temperatures, steps, ingredient forms).
//   - Deterministic + explainable: stores a full ChangeLog with reason codes.
//   - Forward-compatible: schemaVersion + stable ids.
//
// Relationship:
//   Recipe (raw or canonical)  -> RecipeAdapterService pipeline -> RecipeVariant
//
// Intended Dexie table (suggested):
//   db.recipeVariants (id, householdId, sourceRecipeId, title, updatedAt, tags)
//
// Expected usage:
//   import {
//     RECIPE_VARIANT_SCHEMA,
//     createDefaultRecipeVariant,
//     normalizeRecipeVariant,
//     validateRecipeVariant,
//     assertValidRecipeVariant,
//   } from "@/features/recipes/contracts/recipeVariant.schema";
//
// Notes:
//   - This is *not* the same as your base Recipe schema. This is the adapted,
//     household-ready version with resolved targets, equipment plan, and steps.
//   - Temperatures are stored in Fahrenheit (F) for determinism. UI can convert.
//   - Quantities are best stored with {value, unit} plus normalized base fields
//     if you already have SSA quantity normalization elsewhere.

const SCHEMA_ID = "ssa://schemas/recipes/recipe-variant.schema.json#v1";

const NOW_ISO = () => new Date().toISOString();

/* -------------------------------------------------------------------------- */
/* Enumerations                                                                */
/* -------------------------------------------------------------------------- */

const TEMP_UNITS = ["F", "C"];
const TIME_UNITS = ["sec", "min", "hr"];

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

const PROTEIN_CATEGORIES = [
  "beef",
  "lamb",
  "goat",
  "venison",
  "bison",
  "pork",
  "chicken",
  "turkey",
  "duck",
  "fish",
  "shellfish",
  "eggs",
  "mixed",
  "unknown",
];

const CUT_TAGS = [
  "whole",
  "ground",
  "steak",
  "chops",
  "roast",
  "ribs",
  "breast",
  "thigh",
  "wings",
  "drumsticks",
  "tenderloin",
  "shoulder",
  "leg",
  "loin",
  "belly",
  "fillet",
  "patty",
  "sausage",
  "mixed_cuts",
];

const CHANGE_TYPES = [
  "ingredient_substitution",
  "ingredient_form_change",
  "quantity_adjustment",
  "method_change",
  "tool_substitution",
  "equipment_requirement_added",
  "equipment_requirement_removed",
  "step_rewrite",
  "time_adjustment",
  "temperature_adjustment",
  "doneness_target_set",
  "safety_minimum_enforced",
  "unit_normalization",
  "note_added",
];

const CHANGE_REASON_CODES = [
  "missing_tool",
  "missing_appliance",
  "missing_heat_source",
  "household_preference",
  "doneness_preference",
  "safety_rule",
  "time_budget",
  "smoke_constraint",
  "noise_constraint",
  "dietary_constraint",
  "ingredient_unavailable",
  "simplification",
  "user_choice",
  "import_cleanup",
  "normalization",
  "other",
];

const STEP_KINDS = ["prep", "cook", "rest", "serve", "cleanup", "note"];

const DIFFICULTY = ["easy", "medium", "hard"];

const VARIANT_STATUS = ["draft", "ready", "archived"];

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function deepClone(obj) {
  return obj ? JSON.parse(JSON.stringify(obj)) : obj;
}

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function clampNumber(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return undefined;
  if (x < min) return min;
  if (x > max) return max;
  return x;
}

function clampInt(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return undefined;
  const y = Math.round(x);
  if (y < min) return min;
  if (y > max) return max;
  return y;
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

function cToF(c) {
  const x = Number(c);
  if (!Number.isFinite(x)) return undefined;
  return (x * 9) / 5 + 32;
}
function normalizeTempToF(value, unit) {
  if (value == null) return undefined;
  const x = Number(value);
  if (!Number.isFinite(x)) return undefined;
  return unit === "C" ? cToF(x) : x;
}

function normalizeTimeToSeconds(value, unit) {
  if (value == null) return undefined;
  const x = Number(value);
  if (!Number.isFinite(x)) return undefined;
  if (unit === "hr") return x * 3600;
  if (unit === "min") return x * 60;
  return x;
}

function safeId(prefix) {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

/* -------------------------------------------------------------------------- */
/* JSON Schema                                                                 */
/* -------------------------------------------------------------------------- */

const RECIPE_VARIANT_SCHEMA = {
  $id: SCHEMA_ID,
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "SSA Recipe Variant (Persisted Adapted Recipe)",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "id",
    "householdId",
    "status",
    "title",
    "source",
    "servings",
    "ingredients",
    "steps",
    "plan",
    "adaptation",
    "meta",
  ],
  properties: {
    schemaVersion: { type: "integer", const: 1 },

    id: { type: "string", minLength: 8, maxLength: 128 },

    householdId: { type: "string", minLength: 1, maxLength: 128 },

    userId: { type: ["string", "null"], default: null, maxLength: 128 },

    status: { type: "string", enum: VARIANT_STATUS, default: "draft" },

    title: { type: "string", minLength: 1, maxLength: 200 },

    subtitle: { type: "string", default: "", maxLength: 200 },

    description: { type: "string", default: "", maxLength: 4000 },

    tags: {
      type: "array",
      default: [],
      items: { type: "string", minLength: 1, maxLength: 64 },
      uniqueItems: true,
    },

    cuisine: {
      type: "object",
      additionalProperties: false,
      default: {},
      properties: {
        profileId: { type: ["string", "null"], default: null, maxLength: 128 },
        cuisineKey: { type: ["string", "null"], default: null, maxLength: 128 },
        region: { type: ["string", "null"], default: null, maxLength: 128 },
      },
    },

    difficulty: { type: "string", enum: DIFFICULTY, default: "medium" },

    servings: {
      type: "object",
      additionalProperties: false,
      required: ["count", "unit"],
      properties: {
        count: { type: "number", minimum: 0.25, maximum: 1000 },
        unit: { type: "string", default: "servings", maxLength: 32 },
      },
    },

    /**
     * Link to the source recipe + provenance
     */
    source: {
      type: "object",
      additionalProperties: false,
      required: ["sourceRecipeId", "sourceType", "sourceVersion", "importRef"],
      properties: {
        sourceRecipeId: { type: "string", minLength: 1, maxLength: 128 },
        sourceType: {
          type: "string",
          enum: ["manual", "imported", "catalog", "webclip", "ai_generated"],
          default: "imported",
        },
        sourceVersion: {
          type: "integer",
          minimum: 0,
          default: 0,
          description:
            "Incremented if the source recipe changes and variant is re-derived.",
        },
        importRef: {
          type: "object",
          additionalProperties: false,
          default: {},
          properties: {
            provider: {
              type: ["string", "null"],
              default: null,
              maxLength: 128,
            },
            url: { type: ["string", "null"], default: null, maxLength: 2048 },
            externalId: {
              type: ["string", "null"],
              default: null,
              maxLength: 256,
            },
            importedAt: {
              type: ["string", "null"],
              format: "date-time",
              default: null,
            },
          },
        },
      },
    },

    /**
     * Ingredients are adapted and normalized (as best as SSA can).
     * Keep freeform original lines for traceability.
     */
    ingredients: {
      type: "array",
      minItems: 0,
      items: { $ref: "#/$defs/Ingredient" },
      default: [],
    },

    /**
     * Steps are executable instructions, already adapted to household tools.
     */
    steps: {
      type: "array",
      minItems: 1,
      items: { $ref: "#/$defs/Step" },
    },

    /**
     * Execution plan: resolved method, equipment, timing, targets.
     * This is what SessionRunner uses to show targets + timers.
     */
    plan: {
      type: "object",
      additionalProperties: false,
      required: [
        "primaryMethod",
        "secondaryMethods",
        "equipment",
        "targets",
        "timing",
      ],
      properties: {
        primaryMethod: { type: "string", enum: COOK_METHODS },
        secondaryMethods: {
          type: "array",
          default: [],
          items: { type: "string", enum: COOK_METHODS },
          uniqueItems: true,
        },

        equipment: {
          type: "object",
          additionalProperties: false,
          required: ["required", "optional", "missingAtAdaptTime"],
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
            missingAtAdaptTime: {
              type: "array",
              items: { $ref: "#/$defs/EquipmentItem" },
              default: [],
              description:
                "If adaptation succeeded with substitutions, record what was missing.",
            },
          },
        },

        targets: {
          type: "object",
          additionalProperties: false,
          required: ["doneness", "temperatures"],
          properties: {
            doneness: { $ref: "#/$defs/DonenessTargets" },
            temperatures: { $ref: "#/$defs/TemperatureTargets" },
          },
        },

        timing: {
          type: "object",
          additionalProperties: false,
          required: ["activeSeconds", "totalSeconds", "restSeconds", "timers"],
          properties: {
            activeSeconds: {
              type: "integer",
              minimum: 0,
              maximum: 7 * 24 * 3600,
              default: 0,
            },
            totalSeconds: {
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
            timers: {
              type: "array",
              default: [],
              items: { $ref: "#/$defs/Timer" },
            },
          },
        },
      },
    },

    /**
     * What changed + why (audit trail).
     */
    adaptation: {
      type: "object",
      additionalProperties: false,
      required: [
        "adapterVersion",
        "inputs",
        "changes",
        "warnings",
        "summary",
        "quality",
      ],
      properties: {
        adapterVersion: {
          type: "string",
          minLength: 1,
          maxLength: 64,
          default: "1.0.0",
          description:
            "Version of RecipeAdapterService pipeline used to generate this variant.",
        },

        inputs: {
          type: "object",
          additionalProperties: false,
          required: ["donenessProfileId", "kitchenCapabilitiesId", "rulesets"],
          properties: {
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
            rulesets: {
              type: "array",
              default: [],
              items: { type: "string", minLength: 1, maxLength: 128 },
              description:
                "Any additional rule catalogs used (tool substitution, doneness targets, etc.).",
            },
          },
        },

        changes: {
          type: "array",
          default: [],
          items: { $ref: "#/$defs/Change" },
        },

        warnings: {
          type: "array",
          default: [],
          items: { $ref: "#/$defs/Warning" },
        },

        summary: {
          type: "object",
          additionalProperties: false,
          required: ["changeCount", "majorChanges", "humanReadable"],
          properties: {
            changeCount: {
              type: "integer",
              minimum: 0,
              maximum: 10000,
              default: 0,
            },
            majorChanges: {
              type: "array",
              default: [],
              items: { type: "string", minLength: 1, maxLength: 300 },
            },
            humanReadable: {
              type: "string",
              default: "",
              maxLength: 8000,
              description:
                "A concise explanation for the UI 'Cook Setup' screen.",
            },
          },
        },

        quality: {
          type: "object",
          additionalProperties: false,
          required: ["confidence", "needsUserReview", "flags"],
          properties: {
            confidence: {
              type: "number",
              minimum: 0,
              maximum: 1,
              default: 0.7,
            },
            needsUserReview: { type: "boolean", default: true },
            flags: {
              type: "array",
              default: [],
              items: {
                type: "string",
                enum: [
                  "missing_critical_equipment",
                  "ambiguous_doneness",
                  "unsafe_target_was_raised",
                  "unit_assumptions_made",
                  "time_estimates_low_confidence",
                  "ingredient_substitutions_made",
                  "method_substitution_made",
                ],
              },
              uniqueItems: true,
            },
          },
        },
      },
    },

    meta: {
      type: "object",
      additionalProperties: false,
      required: ["createdAt", "updatedAt", "source", "version", "hash"],
      properties: {
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
        source: {
          type: "string",
          default: "features/recipes/contracts/recipeVariant.schema",
        },
        version: {
          type: "integer",
          minimum: 0,
          default: 0,
          description:
            "Variant version increments when user edits/adapts again.",
        },
        hash: {
          type: "string",
          default: "",
          maxLength: 256,
          description:
            "Optional deterministic hash of variant content (for caching/sync).",
        },
      },
    },
  },

  $defs: {
    Quantity: {
      type: "object",
      additionalProperties: false,
      required: ["value", "unit"],
      properties: {
        value: { type: "number" },
        unit: { type: "string", minLength: 1, maxLength: 32 },
        // Optional normalized helpers (if SSA already uses base units elsewhere)
        normalizedValue: { type: ["number", "null"], default: null },
        normalizedUnit: {
          type: ["string", "null"],
          default: null,
          maxLength: 32,
        },
        approx: { type: "boolean", default: false },
      },
    },

    Ingredient: {
      type: "object",
      additionalProperties: false,
      required: ["id", "name", "quantity", "notes", "sourceLine", "tags"],
      properties: {
        id: { type: "string", minLength: 6, maxLength: 128 },
        name: { type: "string", minLength: 1, maxLength: 256 },
        quantity: {
          anyOf: [{ $ref: "#/$defs/Quantity" }, { type: "null" }],
          default: null,
        },
        notes: { type: "string", default: "", maxLength: 1000 },
        sourceLine: {
          type: "string",
          default: "",
          maxLength: 2000,
          description: "Original raw ingredient line for traceability.",
        },
        componentKey: {
          type: ["string", "null"],
          default: null,
          maxLength: 128,
          description:
            "SSA normalized component key (if mapped), e.g., components.keys.json.",
        },
        form: {
          type: ["string", "null"],
          default: null,
          maxLength: 64,
          description: "e.g., 'diced', 'minced', 'boneless', 'skin-on'.",
        },
        tags: {
          type: "array",
          default: [],
          items: { type: "string", minLength: 1, maxLength: 64 },
          uniqueItems: true,
        },
        allergens: {
          type: "array",
          default: [],
          items: { type: "string", minLength: 1, maxLength: 64 },
          uniqueItems: true,
        },
        substitutions: {
          type: "array",
          default: [],
          items: { $ref: "#/$defs/Substitution" },
        },
      },
    },

    Substitution: {
      type: "object",
      additionalProperties: false,
      required: ["type", "from", "to", "reason", "notes"],
      properties: {
        type: {
          type: "string",
          enum: ["ingredient", "tool", "method"],
          default: "ingredient",
        },
        from: { type: "string", minLength: 1, maxLength: 256 },
        to: { type: "string", minLength: 1, maxLength: 256 },
        reason: { type: "string", enum: CHANGE_REASON_CODES, default: "other" },
        notes: { type: "string", default: "", maxLength: 1000 },
      },
    },

    Step: {
      type: "object",
      additionalProperties: false,
      required: ["id", "order", "kind", "text", "timers", "targets", "notes"],
      properties: {
        id: { type: "string", minLength: 6, maxLength: 128 },
        order: { type: "integer", minimum: 1, maximum: 10000 },
        kind: { type: "string", enum: STEP_KINDS, default: "cook" },
        text: { type: "string", minLength: 1, maxLength: 8000 },

        timers: {
          type: "array",
          default: [],
          items: { $ref: "#/$defs/Timer" },
        },

        targets: {
          type: "object",
          additionalProperties: false,
          default: {},
          properties: {
            internalTempF: {
              type: ["number", "null"],
              minimum: 32,
              maximum: 450,
              default: null,
            },
            ovenTempF: {
              type: ["number", "null"],
              minimum: 150,
              maximum: 650,
              default: null,
            },
            donenessLabel: {
              type: ["string", "null"],
              default: null,
              maxLength: 64,
            },
          },
        },

        notes: { type: "string", default: "", maxLength: 2000 },

        // Optional structured parsing hints
        requires: {
          type: "object",
          additionalProperties: false,
          default: {},
          properties: {
            equipment: {
              type: "array",
              default: [],
              items: { $ref: "#/$defs/EquipmentItem" },
            },
            methods: {
              type: "array",
              default: [],
              items: { type: "string", enum: COOK_METHODS },
              uniqueItems: true,
            },
          },
        },
      },
    },

    EquipmentItem: {
      type: "object",
      additionalProperties: false,
      required: ["key", "label", "optional"],
      properties: {
        key: { type: "string", minLength: 1, maxLength: 128 },
        label: { type: "string", minLength: 1, maxLength: 256 },
        optional: { type: "boolean", default: false },
      },
    },

    Timer: {
      type: "object",
      additionalProperties: false,
      required: ["id", "label", "seconds", "kind", "stepId"],
      properties: {
        id: { type: "string", minLength: 6, maxLength: 128 },
        label: { type: "string", minLength: 1, maxLength: 256 },
        seconds: { type: "integer", minimum: 1, maximum: 7 * 24 * 3600 },
        kind: {
          type: "string",
          enum: ["prep", "cook", "rest", "reminder"],
          default: "cook",
        },
        stepId: { type: ["string", "null"], default: null, maxLength: 128 },
        startsAfterStepId: {
          type: ["string", "null"],
          default: null,
          maxLength: 128,
        },
      },
    },

    DonenessTargets: {
      type: "object",
      additionalProperties: false,
      required: [
        "proteinCategory",
        "cutTag",
        "targetInternalTempF",
        "toleranceF",
        "safetyMinimumF",
        "wasRaisedForSafety",
      ],
      properties: {
        proteinCategory: {
          type: "string",
          enum: PROTEIN_CATEGORIES,
          default: "unknown",
        },
        cutTag: { type: "string", enum: CUT_TAGS, default: "whole" },
        targetInternalTempF: { type: "number", minimum: 32, maximum: 450 },
        toleranceF: { type: "number", minimum: 0, maximum: 25, default: 3 },
        safetyMinimumF: {
          type: "number",
          minimum: 32,
          maximum: 450,
          default: 0,
        },
        wasRaisedForSafety: { type: "boolean", default: false },
        source: {
          type: "string",
          default: "",
          maxLength: 256,
          description: "e.g., 'method:grill', 'cut:ground', 'protein:chicken'.",
        },
      },
    },

    TemperatureTargets: {
      type: "object",
      additionalProperties: false,
      required: ["ovenTempF", "oilTempF", "waterTempF"],
      properties: {
        ovenTempF: {
          type: ["number", "null"],
          minimum: 150,
          maximum: 650,
          default: null,
        },
        oilTempF: {
          type: ["number", "null"],
          minimum: 200,
          maximum: 450,
          default: null,
        },
        waterTempF: {
          type: ["number", "null"],
          minimum: 32,
          maximum: 212,
          default: null,
        },
      },
    },

    Change: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "type",
        "reason",
        "at",
        "path",
        "before",
        "after",
        "notes",
      ],
      properties: {
        id: { type: "string", minLength: 6, maxLength: 128 },
        type: { type: "string", enum: CHANGE_TYPES },
        reason: { type: "string", enum: CHANGE_REASON_CODES },
        at: { type: "string", format: "date-time" },
        path: {
          type: "string",
          minLength: 1,
          maxLength: 512,
          description: "JSON pointer-ish path, e.g., '/steps/3/text'.",
        },
        before: {
          type: ["string", "number", "boolean", "null", "object", "array"],
          default: null,
        },
        after: {
          type: ["string", "number", "boolean", "null", "object", "array"],
          default: null,
        },
        notes: { type: "string", default: "", maxLength: 2000 },
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
        context: {
          type: "object",
          additionalProperties: true,
          default: {},
        },
      },
    },
  },
};

/* -------------------------------------------------------------------------- */
/* Defaults                                                                    */
/* -------------------------------------------------------------------------- */

function createDefaultRecipeVariant(args = {}) {
  const id =
    typeof args.id === "string" && args.id ? args.id : safeId("variant");
  const householdId =
    typeof args.householdId === "string" && args.householdId
      ? args.householdId
      : "household_default";

  const createdAt = NOW_ISO();

  return {
    schemaVersion: 1,
    id,
    householdId,
    userId: typeof args.userId === "string" ? args.userId : null,
    status: "draft",
    title:
      typeof args.title === "string" && args.title
        ? args.title
        : "Adapted Recipe",
    subtitle: "",
    description: "",
    tags: [],

    cuisine: { profileId: null, cuisineKey: null, region: null },
    difficulty: "medium",

    servings: { count: 4, unit: "servings" },

    source: {
      sourceRecipeId:
        typeof args.sourceRecipeId === "string"
          ? args.sourceRecipeId
          : "unknown",
      sourceType: "imported",
      sourceVersion: 0,
      importRef: {
        provider: null,
        url: null,
        externalId: null,
        importedAt: null,
      },
    },

    ingredients: [],

    steps: [
      {
        id: safeId("step"),
        order: 1,
        kind: "note",
        text: "Review and adjust this adapted recipe before cooking.",
        timers: [],
        targets: { internalTempF: null, ovenTempF: null, donenessLabel: null },
        notes: "",
        requires: { equipment: [], methods: [] },
      },
    ],

    plan: {
      primaryMethod: "bake",
      secondaryMethods: [],
      equipment: { required: [], optional: [], missingAtAdaptTime: [] },
      targets: {
        doneness: {
          proteinCategory: "unknown",
          cutTag: "whole",
          targetInternalTempF: 145,
          toleranceF: 3,
          safetyMinimumF: 0,
          wasRaisedForSafety: false,
          source: "fallback",
        },
        temperatures: {
          ovenTempF: null,
          oilTempF: null,
          waterTempF: null,
        },
      },
      timing: {
        activeSeconds: 0,
        totalSeconds: 0,
        restSeconds: 0,
        timers: [],
      },
    },

    adaptation: {
      adapterVersion: "1.0.0",
      inputs: {
        donenessProfileId: null,
        kitchenCapabilitiesId: null,
        rulesets: [],
      },
      changes: [],
      warnings: [],
      summary: {
        changeCount: 0,
        majorChanges: [],
        humanReadable: "",
      },
      quality: {
        confidence: 0.7,
        needsUserReview: true,
        flags: [],
      },
    },

    meta: {
      createdAt,
      updatedAt: createdAt,
      source: "features/recipes/contracts/recipeVariant.schema",
      version: 0,
      hash: "",
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Normalization                                                               */
/* -------------------------------------------------------------------------- */

function normalizeRecipeVariant(raw, opts = {}) {
  const { quiet = true } = opts;
  const base = isPlainObject(raw) ? deepClone(raw) : {};
  const out =
    isPlainObject(base) && base.schemaVersion === 1
      ? base
      : createDefaultRecipeVariant({
          id: base.id,
          householdId: base.householdId,
          userId: base.userId,
          title: base.title,
          sourceRecipeId: base?.source?.sourceRecipeId,
        });

  // Meta timestamps
  if (!out.meta) out.meta = {};
  if (!out.meta.createdAt) out.meta.createdAt = NOW_ISO();
  out.meta.updatedAt = NOW_ISO();
  out.meta.version = clampInt(out.meta.version ?? 0, 0, 1_000_000) ?? 0;
  if (typeof out.meta.hash !== "string") out.meta.hash = "";

  // Strings
  if (typeof out.title !== "string" || !out.title.trim())
    out.title = "Adapted Recipe";
  out.title = out.title.trim().slice(0, 200);

  if (typeof out.subtitle !== "string") out.subtitle = "";
  out.subtitle = out.subtitle.trim().slice(0, 200);

  if (typeof out.description !== "string") out.description = "";
  out.description = out.description.slice(0, 4000);

  out.tags = uniqStrings(out.tags).slice(0, 100);

  if (!VARIANT_STATUS.includes(out.status)) out.status = "draft";
  if (!DIFFICULTY.includes(out.difficulty)) out.difficulty = "medium";

  if (typeof out.householdId !== "string" || !out.householdId)
    out.householdId = "household_default";
  if (out.userId != null && typeof out.userId !== "string") out.userId = null;

  // Servings
  if (!out.servings || !isPlainObject(out.servings))
    out.servings = { count: 4, unit: "servings" };
  out.servings.count =
    round1(clampNumber(out.servings.count ?? 4, 0.25, 1000)) ?? 4;
  if (typeof out.servings.unit !== "string" || !out.servings.unit)
    out.servings.unit = "servings";
  out.servings.unit = out.servings.unit.slice(0, 32);

  // Source
  if (!out.source || !isPlainObject(out.source))
    out.source = createDefaultRecipeVariant().source;
  if (
    typeof out.source.sourceRecipeId !== "string" ||
    !out.source.sourceRecipeId
  )
    out.source.sourceRecipeId = "unknown";
  if (
    !["manual", "imported", "catalog", "webclip", "ai_generated"].includes(
      out.source.sourceType
    )
  ) {
    out.source.sourceType = "imported";
  }
  out.source.sourceVersion =
    clampInt(out.source.sourceVersion ?? 0, 0, 1_000_000) ?? 0;
  if (!out.source.importRef || !isPlainObject(out.source.importRef))
    out.source.importRef = {};
  normalizeNullableString(out.source.importRef, "provider", 128);
  normalizeNullableString(out.source.importRef, "url", 2048);
  normalizeNullableString(out.source.importRef, "externalId", 256);
  if (
    out.source.importRef.importedAt != null &&
    typeof out.source.importRef.importedAt !== "string"
  ) {
    out.source.importRef.importedAt = null;
  }

  // Cuisine
  if (!out.cuisine || !isPlainObject(out.cuisine))
    out.cuisine = { profileId: null, cuisineKey: null, region: null };
  normalizeNullableString(out.cuisine, "profileId", 128);
  normalizeNullableString(out.cuisine, "cuisineKey", 128);
  normalizeNullableString(out.cuisine, "region", 128);

  // Ingredients
  out.ingredients = Array.isArray(out.ingredients) ? out.ingredients : [];
  out.ingredients = out.ingredients
    .filter((x) => isPlainObject(x))
    .map((ing, idx) => normalizeIngredient(ing, idx));

  // Steps
  out.steps = Array.isArray(out.steps) ? out.steps : [];
  if (!out.steps.length) {
    out.steps = createDefaultRecipeVariant().steps;
  }
  out.steps = out.steps
    .filter((s) => isPlainObject(s))
    .map((s, idx) => normalizeStep(s, idx));

  // Ensure step order monotonic (1..n)
  out.steps.sort((a, b) => a.order - b.order);
  for (let i = 0; i < out.steps.length; i += 1) {
    out.steps[i].order = i + 1;
  }

  // Plan
  if (!out.plan || !isPlainObject(out.plan))
    out.plan = createDefaultRecipeVariant().plan;
  if (!COOK_METHODS.includes(out.plan.primaryMethod))
    out.plan.primaryMethod = "bake";
  out.plan.secondaryMethods = uniqStrings(out.plan.secondaryMethods).filter(
    (m) => COOK_METHODS.includes(m)
  );

  if (!out.plan.equipment || !isPlainObject(out.plan.equipment))
    out.plan.equipment = { required: [], optional: [], missingAtAdaptTime: [] };
  out.plan.equipment.required = normalizeEquipmentList(
    out.plan.equipment.required
  );
  out.plan.equipment.optional = normalizeEquipmentList(
    out.plan.equipment.optional
  );
  out.plan.equipment.missingAtAdaptTime = normalizeEquipmentList(
    out.plan.equipment.missingAtAdaptTime
  );

  if (!out.plan.targets || !isPlainObject(out.plan.targets))
    out.plan.targets = createDefaultRecipeVariant().plan.targets;
  if (!out.plan.targets.doneness || !isPlainObject(out.plan.targets.doneness))
    out.plan.targets.doneness =
      createDefaultRecipeVariant().plan.targets.doneness;
  out.plan.targets.doneness.proteinCategory = PROTEIN_CATEGORIES.includes(
    out.plan.targets.doneness.proteinCategory
  )
    ? out.plan.targets.doneness.proteinCategory
    : "unknown";
  out.plan.targets.doneness.cutTag = CUT_TAGS.includes(
    out.plan.targets.doneness.cutTag
  )
    ? out.plan.targets.doneness.cutTag
    : "whole";
  out.plan.targets.doneness.targetInternalTempF =
    round1(
      clampNumber(out.plan.targets.doneness.targetInternalTempF ?? 145, 32, 450)
    ) ?? 145;
  out.plan.targets.doneness.toleranceF =
    round1(clampNumber(out.plan.targets.doneness.toleranceF ?? 3, 0, 25)) ?? 3;
  out.plan.targets.doneness.safetyMinimumF =
    round1(
      clampNumber(out.plan.targets.doneness.safetyMinimumF ?? 0, 0, 450)
    ) ?? 0;
  out.plan.targets.doneness.wasRaisedForSafety =
    !!out.plan.targets.doneness.wasRaisedForSafety;
  if (typeof out.plan.targets.doneness.source !== "string")
    out.plan.targets.doneness.source = "";

  if (
    !out.plan.targets.temperatures ||
    !isPlainObject(out.plan.targets.temperatures)
  )
    out.plan.targets.temperatures =
      createDefaultRecipeVariant().plan.targets.temperatures;
  out.plan.targets.temperatures.ovenTempF = normalizeNullableTempF(
    out.plan.targets.temperatures.ovenTempF,
    150,
    650
  );
  out.plan.targets.temperatures.oilTempF = normalizeNullableTempF(
    out.plan.targets.temperatures.oilTempF,
    200,
    450
  );
  out.plan.targets.temperatures.waterTempF = normalizeNullableTempF(
    out.plan.targets.temperatures.waterTempF,
    32,
    212
  );

  if (!out.plan.timing || !isPlainObject(out.plan.timing))
    out.plan.timing = createDefaultRecipeVariant().plan.timing;
  out.plan.timing.activeSeconds =
    clampInt(out.plan.timing.activeSeconds ?? 0, 0, 7 * 24 * 3600) ?? 0;
  out.plan.timing.totalSeconds =
    clampInt(out.plan.timing.totalSeconds ?? 0, 0, 7 * 24 * 3600) ?? 0;
  out.plan.timing.restSeconds =
    clampInt(out.plan.timing.restSeconds ?? 0, 0, 4 * 3600) ?? 0;
  out.plan.timing.timers = Array.isArray(out.plan.timing.timers)
    ? out.plan.timing.timers
    : [];
  out.plan.timing.timers = out.plan.timing.timers
    .filter((t) => isPlainObject(t))
    .map((t) => normalizeTimer(t));

  // Adaptation
  if (!out.adaptation || !isPlainObject(out.adaptation))
    out.adaptation = createDefaultRecipeVariant().adaptation;
  if (
    typeof out.adaptation.adapterVersion !== "string" ||
    !out.adaptation.adapterVersion
  )
    out.adaptation.adapterVersion = "1.0.0";

  if (!out.adaptation.inputs || !isPlainObject(out.adaptation.inputs))
    out.adaptation.inputs = createDefaultRecipeVariant().adaptation.inputs;
  normalizeNullableString(out.adaptation.inputs, "donenessProfileId", 128);
  normalizeNullableString(out.adaptation.inputs, "kitchenCapabilitiesId", 128);
  out.adaptation.inputs.rulesets = uniqStrings(
    out.adaptation.inputs.rulesets
  ).slice(0, 50);

  out.adaptation.changes = Array.isArray(out.adaptation.changes)
    ? out.adaptation.changes
    : [];
  out.adaptation.changes = out.adaptation.changes
    .filter((c) => isPlainObject(c))
    .map((c) => normalizeChange(c));

  out.adaptation.warnings = Array.isArray(out.adaptation.warnings)
    ? out.adaptation.warnings
    : [];
  out.adaptation.warnings = out.adaptation.warnings
    .filter((w) => isPlainObject(w))
    .map((w) => normalizeWarning(w));

  if (!out.adaptation.summary || !isPlainObject(out.adaptation.summary))
    out.adaptation.summary = createDefaultRecipeVariant().adaptation.summary;
  out.adaptation.summary.changeCount =
    clampInt(
      out.adaptation.summary.changeCount ?? out.adaptation.changes.length,
      0,
      10000
    ) ?? out.adaptation.changes.length;
  out.adaptation.summary.majorChanges = uniqStrings(
    out.adaptation.summary.majorChanges
  ).slice(0, 50);
  if (typeof out.adaptation.summary.humanReadable !== "string")
    out.adaptation.summary.humanReadable = "";
  out.adaptation.summary.humanReadable =
    out.adaptation.summary.humanReadable.slice(0, 8000);

  if (!out.adaptation.quality || !isPlainObject(out.adaptation.quality))
    out.adaptation.quality = createDefaultRecipeVariant().adaptation.quality;
  out.adaptation.quality.confidence =
    clampNumber(out.adaptation.quality.confidence ?? 0.7, 0, 1) ?? 0.7;
  out.adaptation.quality.needsUserReview =
    !!out.adaptation.quality.needsUserReview;
  out.adaptation.quality.flags = uniqStrings(
    out.adaptation.quality.flags
  ).slice(0, 50);

  // Soft validate
  const vr = validateRecipeVariant(out);
  if (!vr.ok && !quiet) {
    console.warn(
      "[SSA][recipeVariant] normalize produced invalid variant:",
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

function normalizeNullableTempF(v, min, max) {
  if (v == null) return null;
  const x = round1(clampNumber(v, min, max));
  return x == null ? null : x;
}

function normalizeIngredient(ing, idx) {
  const out = deepClone(ing);
  out.id =
    typeof out.id === "string" && out.id ? out.id : safeId(`ing${idx + 1}`);
  out.name =
    typeof out.name === "string" && out.name.trim()
      ? out.name.trim().slice(0, 256)
      : "ingredient";
  out.notes = typeof out.notes === "string" ? out.notes.slice(0, 1000) : "";
  out.sourceLine =
    typeof out.sourceLine === "string" ? out.sourceLine.slice(0, 2000) : "";
  out.tags = uniqStrings(out.tags).slice(0, 50);
  out.allergens = uniqStrings(out.allergens).slice(0, 50);

  if (out.componentKey != null && typeof out.componentKey !== "string")
    out.componentKey = null;
  if (typeof out.componentKey === "string")
    out.componentKey = out.componentKey.slice(0, 128);

  if (out.form != null && typeof out.form !== "string") out.form = null;
  if (typeof out.form === "string") out.form = out.form.slice(0, 64);

  out.quantity = normalizeQuantity(out.quantity);

  out.substitutions = Array.isArray(out.substitutions) ? out.substitutions : [];
  out.substitutions = out.substitutions
    .filter((s) => isPlainObject(s))
    .map((s) => {
      const x = deepClone(s);
      x.type = ["ingredient", "tool", "method"].includes(x.type)
        ? x.type
        : "ingredient";
      x.from = typeof x.from === "string" ? x.from.slice(0, 256) : "";
      x.to = typeof x.to === "string" ? x.to.slice(0, 256) : "";
      x.reason = CHANGE_REASON_CODES.includes(x.reason) ? x.reason : "other";
      x.notes = typeof x.notes === "string" ? x.notes.slice(0, 1000) : "";
      return x;
    });

  return out;
}

function normalizeQuantity(q) {
  if (q == null) return null;
  if (!isPlainObject(q)) return null;
  const out = deepClone(q);
  out.value = clampNumber(out.value, -1e9, 1e9);
  if (out.value == null) return null;

  out.unit =
    typeof out.unit === "string" && out.unit.trim()
      ? out.unit.trim().slice(0, 32)
      : "unit";
  out.normalizedValue =
    out.normalizedValue == null
      ? null
      : clampNumber(out.normalizedValue, -1e12, 1e12);
  out.normalizedUnit =
    out.normalizedUnit == null
      ? null
      : typeof out.normalizedUnit === "string"
      ? out.normalizedUnit.trim().slice(0, 32)
      : null;
  out.approx = !!out.approx;

  return out;
}

function normalizeStep(step, idx) {
  const out = deepClone(step);
  out.id =
    typeof out.id === "string" && out.id ? out.id : safeId(`step${idx + 1}`);
  out.order = clampInt(out.order ?? idx + 1, 1, 10000) ?? idx + 1;
  out.kind = STEP_KINDS.includes(out.kind) ? out.kind : "cook";
  out.text =
    typeof out.text === "string" && out.text.trim()
      ? out.text.trim().slice(0, 8000)
      : "Step";
  out.notes = typeof out.notes === "string" ? out.notes.slice(0, 2000) : "";

  out.timers = Array.isArray(out.timers) ? out.timers : [];
  out.timers = out.timers
    .filter((t) => isPlainObject(t))
    .map((t) => normalizeTimer(t));

  if (!out.targets || !isPlainObject(out.targets)) out.targets = {};
  out.targets.internalTempF = normalizeNullableTempF(
    out.targets.internalTempF,
    32,
    450
  );
  out.targets.ovenTempF = normalizeNullableTempF(
    out.targets.ovenTempF,
    150,
    650
  );
  if (
    out.targets.donenessLabel != null &&
    typeof out.targets.donenessLabel !== "string"
  )
    out.targets.donenessLabel = null;
  if (typeof out.targets.donenessLabel === "string")
    out.targets.donenessLabel = out.targets.donenessLabel.slice(0, 64);

  if (!out.requires || !isPlainObject(out.requires)) out.requires = {};
  out.requires.methods = uniqStrings(out.requires.methods).filter((m) =>
    COOK_METHODS.includes(m)
  );
  out.requires.equipment = normalizeEquipmentList(out.requires.equipment);

  return out;
}

function normalizeEquipmentList(list) {
  const arr = Array.isArray(list) ? list : [];
  const out = [];
  const seen = new Set();
  for (const e of arr) {
    if (!isPlainObject(e)) continue;
    const key = typeof e.key === "string" ? e.key.trim().slice(0, 128) : "";
    const label =
      typeof e.label === "string" ? e.label.trim().slice(0, 256) : "";
    const optional = !!e.optional;
    if (!key || !label) continue;
    const sig = `${key}::${label}::${optional ? "1" : "0"}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push({ key, label, optional });
  }
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
  out.kind = ["prep", "cook", "rest", "reminder"].includes(out.kind)
    ? out.kind
    : "cook";
  if (out.stepId != null && typeof out.stepId !== "string") out.stepId = null;
  if (typeof out.stepId === "string") out.stepId = out.stepId.slice(0, 128);
  if (
    out.startsAfterStepId != null &&
    typeof out.startsAfterStepId !== "string"
  )
    out.startsAfterStepId = null;
  if (typeof out.startsAfterStepId === "string")
    out.startsAfterStepId = out.startsAfterStepId.slice(0, 128);
  return out;
}

function normalizeChange(c) {
  const out = deepClone(c);
  out.id = typeof out.id === "string" && out.id ? out.id : safeId("chg");
  out.type = CHANGE_TYPES.includes(out.type) ? out.type : "note_added";
  out.reason = CHANGE_REASON_CODES.includes(out.reason) ? out.reason : "other";
  out.at = typeof out.at === "string" && out.at ? out.at : NOW_ISO();
  out.path =
    typeof out.path === "string" && out.path ? out.path.slice(0, 512) : "/";

  if (typeof out.notes !== "string") out.notes = "";
  out.notes = out.notes.slice(0, 2000);

  // before/after can be any JSON-ish; leave as-is but ensure defined keys exist
  if (!("before" in out)) out.before = null;
  if (!("after" in out)) out.after = null;

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
 *      validateRecipeVariant(doc, { ajv })
 */
function validateRecipeVariant(doc, opts = {}) {
  const ajv = opts?.ajv;

  if (ajv && typeof ajv.compile === "function") {
    try {
      const validate = ajv.compile(RECIPE_VARIANT_SCHEMA);
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
      errors: [{ path: "", message: "RecipeVariant must be an object" }],
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
  if (!doc.source || typeof doc.source.sourceRecipeId !== "string")
    errors.push({
      path: "/source/sourceRecipeId",
      message: "source.sourceRecipeId required",
    });
  if (!Array.isArray(doc.steps) || !doc.steps.length)
    errors.push({ path: "/steps", message: "steps must be non-empty array" });
  if (!doc.plan || !COOK_METHODS.includes(doc.plan.primaryMethod))
    errors.push({
      path: "/plan/primaryMethod",
      message: "plan.primaryMethod must be valid method",
    });
  return { ok: errors.length === 0, errors };
}

function assertValidRecipeVariant(doc, opts = {}) {
  const r = validateRecipeVariant(doc, opts);
  if (!r.ok) {
    const msg =
      "[SSA][recipeVariant] Invalid RecipeVariant: " +
      r.errors.map((e) => `${e.path}: ${e.message}`).join("; ");
    const err = new Error(msg);
    err.name = "RecipeVariantValidationError";
    err.details = r.errors;
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/* Convenience: build timers from human units (optional helper)                */
/* -------------------------------------------------------------------------- */

/**
 * Build a timer object from {value, unit} like 10 min.
 */
function buildTimer({
  label,
  value,
  unit,
  kind = "cook",
  stepId = null,
  startsAfterStepId = null,
} = {}) {
  const seconds = normalizeTimeToSeconds(
    value,
    TIME_UNITS.includes(unit) ? unit : "min"
  );
  return normalizeTimer({
    id: safeId("timer"),
    label: typeof label === "string" && label.trim() ? label.trim() : "Timer",
    seconds: clampInt(seconds ?? 60, 1, 7 * 24 * 3600) ?? 60,
    kind,
    stepId,
    startsAfterStepId,
  });
}

/**
 * Convenience: set an internal target on a step (F), supporting C input too.
 */
function setStepInternalTemp(step, { value, unit = "F" } = {}) {
  const s = isPlainObject(step) ? step : null;
  if (!s) return step;
  if (!s.targets || !isPlainObject(s.targets)) s.targets = {};
  const tempF = normalizeTempToF(value, TEMP_UNITS.includes(unit) ? unit : "F");
  s.targets.internalTempF =
    tempF == null ? null : round1(clampNumber(tempF, 32, 450));
  return s;
}

/* -------------------------------------------------------------------------- */
/* Exports                                                                     */
/* -------------------------------------------------------------------------- */

export {
  // Schema
  RECIPE_VARIANT_SCHEMA,
  SCHEMA_ID,

  // Enums (for UI / engines)
  TEMP_UNITS,
  TIME_UNITS,
  COOK_METHODS,
  PROTEIN_CATEGORIES,
  CUT_TAGS,
  CHANGE_TYPES,
  CHANGE_REASON_CODES,
  STEP_KINDS,
  DIFFICULTY,
  VARIANT_STATUS,

  // Defaults + normalize + validate
  createDefaultRecipeVariant,
  normalizeRecipeVariant,
  validateRecipeVariant,
  assertValidRecipeVariant,

  // Small helpers
  buildTimer,
  setStepInternalTemp,
  normalizeTempToF,
  normalizeTimeToSeconds,
};

// ✅ FIX: provide default export so `export { default as recipeVariantSchema } ...` works.
export default RECIPE_VARIANT_SCHEMA;
